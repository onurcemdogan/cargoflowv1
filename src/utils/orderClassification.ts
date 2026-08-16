import type { CargoOrder } from '../types/cargoflow.ts'
import type { QuickTab } from './ordersTabs.ts'
import {
  canCreateShipment,
  canMarkPrinted,
  hasCarrierTracking,
} from './orderStatus.ts'
import type { OrdersActionFilter } from './ordersNavigation.ts'
import { resolveOrderStatus } from './shipmentStatus.ts'
import {
  isPreassignedAwaitingAcceptance,
  resolveSuratPrintEligibility,
} from './suratPrintEligibility.ts'
import { verifySuratShipment } from './suratVerification.ts'
import { isExternallyProcessed } from './externalProcessing.ts'
import {
  buildRepeatedProductOrderIds,
  type SameProductFilter,
} from './orderProductFamily.ts'
import {
  buildOrderCountSummary,
  dedupeOrdersByPackageIdentity,
  orderPackageIdentity,
} from './orderCounts.ts'
import {
  buildOrdersDateRange,
  isOrderWithinDateRange,
  ORDERS_TIME_ZONE,
} from './orderDateRange.ts'

export interface OrderTabClassification {
  isOpenOperation: boolean
  isBarcodeWaiting: boolean
  isShipmentCreateRequired: boolean
  isSuratVerificationWaiting: boolean
  isLabelReady: boolean
  isLabelPrinted: boolean
  isReadyForCargo: boolean
  isHandedToCargo: boolean
  isDelivered: boolean
  isCanceledOrReturned: boolean
  isArchived: boolean
  // YEREL, manuel arşiv (harici programda işlendi). Pazaryeri/provider
  // durumundan tamamen ayrıdır.
  isExternallyProcessed: boolean
  hasError: boolean
  operationStatusLabel: string
}

export interface VisibleOrdersDateFilter {
  preset: string
  startTime?: number
  endTime?: number
  timezone?: string
}

export interface BuildVisibleOrdersInput {
  persistentOrders: CargoOrder[]
  selectedTab: QuickTab
  marketplaceFilter: string
  operationStatusFilter: string
  cargoFilter: string
  cityFilter?: string
  districtFilter?: string
  multiProductFilter?: 'all' | 'single' | 'multi'
  // "Aynı Ürün Siparişi": ürün AİLESİ (beden bağımsız) bazında, DISTINCT
  // LOGICAL ORDER sayısına göre. 'repeated' → aynı üründen 2+ sipariş,
  // 'unique' → hiçbir ürünü başka siparişle eşleşmeyenler.
  sameProductFilter?: SameProductFilter
  actionFilter?: OrdersActionFilter
  // "İşlem Durumu" filtresi: teknik yaşam-döngüsü durumlarına (barkod bekliyor,
  // kargo oluşturulacak, doğrulama bekliyor, etiket basılacak/basıldı, arşiv)
  // mevcut classifier'larla erişim. 'all' veya tanımsız → filtre uygulanmaz.
  operationTabFilter?: QuickTab | 'all'
  dateFilter: VisibleOrdersDateFilter
  searchQuery: string
  customerQuery?: string
  productQuery?: string
  orderNumberQuery?: string
  cargoSlipQuery?: string
  now?: Date
}

export interface VisibleOrderExclusion {
  orderNumber: string
  packageId: string
  lineId: string
  excludedAtStage: string
  exclusionReason: string
}

export interface VisibleOrdersDebug {
  initialCount: number
  apiRawCount?: number
  normalizedCount?: number
  afterInvalidRecordFilterCount: number
  afterPackageDedupCount: number
  persistedCount: number
  latestSyncBatchId?: string
  latestSyncAt?: string
  latestSyncCount: number
  afterSelectedTabCount: number
  afterExternalProcessingFilter: number
  afterTabFilter: number
  afterOperationTabFilter: number
  afterMarketplaceFilter: number
  afterOperationStatusFilter: number
  afterCargoFilter: number
  afterCityFilter: number
  afterDistrictFilter: number
  afterMultiProductFilter: number
  afterSameProductFilter: number
  afterActionFilter: number
  afterDateFilter: number
  afterSearch: number
  visibleCount: number
  uniquePackageCount: number
  uniqueOrderNumberCount: number
  lineCount: number
  quantityTotal: number
  exclusions: VisibleOrderExclusion[]
}

export interface VisibleOrdersResult {
  visibleOrders: CargoOrder[]
  debug: VisibleOrdersDebug
}

export function classifyOrderForTabs(
  order: CargoOrder,
): OrderTabClassification {
  const record = order as CargoOrder & Record<string, unknown>
  const shipment = order.shipment as
    | (NonNullable<CargoOrder['shipment']> & Record<string, unknown>)
    | undefined
  const verification = verifySuratShipment(order)
  const operationStatus = normalizedToken(order.operationStatus)
  // Canonical (DB'de kalıcı) operasyon durumu — pazaryeri status'ünden AYRI.
  // Etiket başarıyla oluşturulduğunda backend orders.operationStatus'ü LABEL_READY
  // (basıldığında LABEL_PRINTED) yapar. Bu KANITLI durum, kısmen persistlenen
  // shipment payload'ından bağımsız olarak siparişin "Etiket Hazır/Basıldı"
  // grubuna girmesini sağlar; sayfa yenilenince (DB re-read) korunur.
  const canonicalLabelReady = operationStatus === 'labelready'
  const canonicalLabelPrinted = operationStatus === 'labelprinted'
  const marketplaceStatus = String(order.marketplaceStatus ?? '').trim()
  const marketplaceDelivered = marketplaceStatus === 'Delivered'
  const marketplaceHandedToCargo = ['Shipped', 'AtCollectionPoint'].includes(
    marketplaceStatus,
  )
  const marketplaceCanceledOrReturned = [
    'Cancelled',
    'Returned',
    'UnDelivered',
    'UnSupplied',
  ].includes(marketplaceStatus)
  const resolvedStatus = resolveOrderStatus(order)
  // Persist edilmiş taşıyıcı zaman damgaları GÜÇLÜ kanıttır: yalnız eski tarih,
  // 727 referansı, packageId veya kargo firma adı DEĞİL. shippedAt/deliveredAt
  // (ve handedToCargoAt) → gerçek "Kargoya Verildi / Teslim".
  const shipmentShippedAt = firstString(
    readString(shipment, 'shippedAt'),
    readString(shipment, 'handedToCargoAt'),
  )
  const shipmentDeliveredAt = readString(shipment, 'deliveredAt')
  // Canonical (DB'de kalıcı) forward operationStatus da güçlü kanıttır: pazaryeri
  // status'ü operationStatus'ü körlemesine ezmez; birlikte kullanılır.
  const canonicalDelivered = ['delivered', 'deliveredspecial'].includes(
    operationStatus,
  )
  const canonicalShipped = ['shipped', 'handedtocargo'].includes(operationStatus)
  const canonicalReturning = operationStatus === 'returning'
  const isCanceledOrReturned = Boolean(
    resolvedStatus.canceledOrReturned ||
      marketplaceCanceledOrReturned ||
      canonicalReturning,
  )
  const isDelivered = Boolean(
    resolvedStatus.delivered ||
      marketplaceDelivered ||
      shipmentDeliveredAt ||
      canonicalDelivered,
  )
  const isHandedToCargo = Boolean(
    resolvedStatus.shipped ||
      marketplaceHandedToCargo ||
      shipmentShippedAt ||
      canonicalShipped,
  )
  const isArchived = Boolean(
    readBoolean(record, 'archived') ||
      readBoolean(record, 'isArchived') ||
      readString(record, 'archivedAt'),
  )
  const explicitlyClosed = Boolean(
    readBoolean(record, 'closed') ||
      readBoolean(record, 'completed') ||
      readString(record, 'closedAt') ||
      readString(record, 'completedAt'),
  )
  const labelStatus = normalizedToken(order.labelStatus)
  const isLabelPrinted = Boolean(
    canonicalLabelPrinted ||
      ((shipment?.dispatchRegistrationConfirmed === true ||
        isPreassignedAwaitingAcceptance(order.shipment)) &&
        labelStatus === 'printed' &&
        order.label?.printedAt),
  )
  const dispatchRegistrationConfirmed =
    shipment?.dispatchRegistrationConfirmed === true
  const verifiedShipment = Boolean(
    dispatchRegistrationConfirmed && verification.verifiedShipment,
  )
  // LABEL_READY_AWAITING_ACCEPTANCE: ön-atanmış kodlarla etiket hazır;
  // fiziksel tesellüm bekleniyor. Barkod Bekleyen DEĞİLDİR, Etiket Hazır
  // grubundadır, Kargoya Verilen değildir (bölüm 5 lifecycle sözleşmesi).
  const preassignedReady = Boolean(
    isPreassignedAwaitingAcceptance(order.shipment) &&
      resolveSuratPrintEligibility(order).canPrint,
  )
  const printableShipment = verifiedShipment || preassignedReady
  const barcodeRaw = String(
    verification.barcodeRaw || shipment?.barcodeRaw || '',
  ).trim()
  const printableBarcode = String(
    verification.barcode ||
      verification.finalSuratBarcode ||
      shipment?.barcode ||
      shipment?.barcodeValue ||
      '',
  ).trim()
  const printError = firstString(
    readString(order.label?.printDebug, 'printError'),
    readString(record, 'printError'),
  )
  const wrongServiceCalled = Boolean(
    readBoolean(shipment, 'wrongServiceCalled') ||
      findNestedBoolean(shipment, 'wrongServiceCalled'),
  )
  const providerResponseError = firstString(
    findNestedString(shipment, 'errorMessage'),
    findNestedBoolean(shipment, 'isError') ? 'provider-error' : '',
  )
  const noTrackingReason = firstString(
    order.noTrackingReason,
    shipment?.noTrackingReason,
  )
  const hasError = Boolean(
    !isCanceledOrReturned &&
      (operationStatus === 'error' ||
        operationStatus.includes('dispatchrejected') ||
        operationStatus.includes('barcodefailed') ||
        printError ||
        (verifiedShipment && !printableBarcode) ||
        wrongServiceCalled ||
        // Ön-atanmış hazır etiketin "fiziksel kabul bekleniyor" bilgi metni
        // hata değildir; sayaçlara hata olarak sızmaz.
        (!preassignedReady && noTrackingReason) ||
        (!preassignedReady && providerResponseError)),
  )
  const processClosed = Boolean(
    isCanceledOrReturned ||
      isDelivered ||
      isArchived ||
      isHandedToCargo ||
      explicitlyClosed,
  )
  const isOpenOperation = !processClosed
  const isBarcodeWaiting = Boolean(
    isOpenOperation &&
      // Canonical etiket-hazır/basıldı durumu "barkod bekliyor" DEĞİLDİR (aksi
      // hâlde hem bu sekmede hem Etiket Hazır'da çift sayılırdı).
      !canonicalLabelReady &&
      !canonicalLabelPrinted &&
      !printableShipment &&
      (!dispatchRegistrationConfirmed || !barcodeRaw) &&
      !isLabelPrinted,
  )
  const isShipmentCreateRequired = Boolean(
    isBarcodeWaiting &&
      (!order.shipment ||
        !dispatchRegistrationConfirmed ||
        ['new', 'shipmentpending', 'suratbarcodefailed'].includes(
          operationStatus,
        )),
  )
  // NOT: canonical LABEL_READY doğrulama-bekleyen dışında BIRAKILMAZ; ön-atanmış
  // (preassigned-awaiting-acceptance) sipariş hem Etiket Hazır hem fiziksel Sürat
  // kabul doğrulaması bekleyen olarak sayılır (mevcut lifecycle sözleşmesi).
  const isSuratVerificationWaiting = Boolean(
    isOpenOperation &&
      order.shipment &&
      !verifiedShipment &&
      !isLabelPrinted,
  )
  const isLabelReady = Boolean(
    isOpenOperation &&
      !isLabelPrinted &&
      // Canonical LABEL_READY (DB'de kalıcı, backend-doğrulamalı) tek başına
      // yeterlidir: kısmi persistlenen shipment payload'ından printableShipment
      // türetilemese bile sipariş Etiket Hazır grubundadır. Aksi hâlde eski
      // (türetilmiş) yol: doğrulanmış/ön-atanmış gönderi + barkod + label durumu.
      (canonicalLabelReady ||
        (printableShipment &&
          printableBarcode &&
          (['ready', 'generated'].includes(labelStatus) ||
            ['labelready', 'trackingconfirmed'].includes(operationStatus)))),
  )
  const isReadyForCargo = Boolean(
    isOpenOperation && printableShipment && printableBarcode,
  )

  return {
    isOpenOperation,
    isBarcodeWaiting,
    isShipmentCreateRequired,
    isSuratVerificationWaiting,
    isLabelReady,
    isLabelPrinted,
    isReadyForCargo,
    isHandedToCargo,
    isDelivered,
    isCanceledOrReturned,
    isArchived,
    isExternallyProcessed: isExternallyProcessed(order),
    hasError,
    // Statü etiketi de TEK canonical aşama helper'ından türetilir; böylece
    // recentOperations statüsü ile Operation Flow sayaçları aynı kaynaktan gelir.
    operationStatusLabel: dashboardOperationStageLabel(
      resolveDashboardOperationStage({
        isOpenOperation,
        isBarcodeWaiting,
        isLabelReady,
        isLabelPrinted,
        isHandedToCargo,
        isDelivered,
        isCanceledOrReturned,
        isArchived,
        hasError,
      }),
    ),
  }
}

export function orderMatchesQuickTab(
  classification: OrderTabClassification,
  tab: QuickTab,
): boolean {
  switch (tab) {
    case 'currentSync':
    case 'today':
      return true
    // Yeni Siparişler: aktif açık ama henüz etiket hazır/basılı olmayanlar
    // (barkod bekleyen, kargo oluşturulacak, doğrulama bekleyen ve diğer
    // açık siparişlerin birleşimi). Mevcut bayrakların türevi; yeni kural yok.
    case 'newOrders':
      return (
        classification.isOpenOperation &&
        !classification.isLabelReady &&
        !classification.isLabelPrinted
      )
    // Etiket Hazır sekmesi: hazır + basılmış kayıtların birleşimi.
    case 'labelStage':
      return classification.isLabelReady || classification.isLabelPrinted
    case 'open':
      return classification.isOpenOperation
    case 'barcodePending':
      return classification.isBarcodeWaiting
    case 'shipmentPending':
      return classification.isShipmentCreateRequired
    case 'suratVerificationPending':
      return classification.isSuratVerificationWaiting
    case 'labelReady':
      return classification.isLabelReady
    case 'labelPrinted':
      return classification.isLabelPrinted
    case 'handedToCargo':
      return classification.isHandedToCargo
    case 'delivered':
      return classification.isDelivered
    case 'cancelReturn':
      return classification.isCanceledOrReturned
    case 'archive':
      return classification.isArchived
    case 'externallyProcessed':
      return classification.isExternallyProcessed
    case 'all':
    default:
      return true
  }
}

export function orderMatchesDashboardAction(
  order: CargoOrder,
  actionFilter: OrdersActionFilter,
): boolean {
  if (actionFilter === 'all') return true
  const state = classifyOrderForTabs(order)
  if (actionFilter === 'createEligible') return canCreateShipment(order)
  if (actionFilter === 'printEligible') {
    return Boolean(
      !state.isLabelPrinted &&
        canMarkPrinted(order) &&
        (order.label?.printHistory?.length ?? 0) === 0,
    )
  }
  if (!state.isOpenOperation) return false
  const missingAddress =
    !String(order.address || '').trim() || !String(order.city || '').trim()
  const missingDesi = !(Number(order.desi ?? order.shipment?.desi) > 0)
  return state.hasError || missingAddress || missingDesi
}

export function buildVisibleOrders({
  persistentOrders,
  selectedTab,
  marketplaceFilter,
  operationStatusFilter,
  cargoFilter,
  cityFilter = 'all',
  districtFilter = 'all',
  multiProductFilter = 'all',
  sameProductFilter = 'all',
  actionFilter = 'all',
  operationTabFilter = 'all',
  dateFilter,
  searchQuery,
  customerQuery = '',
  productQuery = '',
  orderNumberQuery = '',
  cargoSlipQuery = '',
  now = new Date(),
}: BuildVisibleOrdersInput): VisibleOrdersResult {
  const exclusions: VisibleOrderExclusion[] = []
  let current = persistentOrders.filter((order) => {
    const valid = Boolean(order && (order.id || order.orderNumber))
    if (!valid) {
      exclusions.push(
        toExclusion(order, 'invalidRecord', 'Sipariş kimliği bulunamadı.'),
      )
    }
    return valid
  })
  const afterInvalidRecordFilterCount = current.length
  const beforePackageDedup = current
  current = dedupeOrdersByPackageIdentity(current)
  recordRemovedOrders(
    beforePackageDedup,
    current,
    exclusions,
    'packageDedup',
    'Aynı marketplace paket kimliği yinelendi.',
  )
  const afterPackageDedupCount = current.length
  const latestSyncAt = resolveLatestMarketplaceSyncAt(current)
  const latestSyncBatchId = resolveLatestMarketplaceSyncBatchId(current)
  const debug: VisibleOrdersDebug = {
    initialCount: persistentOrders.length,
    afterInvalidRecordFilterCount,
    afterPackageDedupCount,
    persistedCount: persistentOrders.length,
    latestSyncBatchId,
    latestSyncAt,
    latestSyncCount: latestSyncBatchId
      ? current.filter(
          (order) => order.lastMarketplaceSyncBatchId === latestSyncBatchId,
        ).length
      : 0,
    afterSelectedTabCount: 0,
    afterExternalProcessingFilter: 0,
    afterTabFilter: 0,
    afterOperationTabFilter: 0,
    afterMarketplaceFilter: 0,
    afterOperationStatusFilter: 0,
    afterCargoFilter: 0,
    afterCityFilter: 0,
    afterDistrictFilter: 0,
    afterMultiProductFilter: 0,
    afterSameProductFilter: 0,
    afterActionFilter: 0,
    afterDateFilter: 0,
    afterSearch: 0,
    visibleCount: 0,
    uniquePackageCount: 0,
    uniqueOrderNumberCount: 0,
    lineCount: 0,
    quantityTotal: 0,
    exclusions,
  }

  // HARİCİ SİSTEMDE İŞLENDİ: kullanıcının MANUEL işaretlediği siparişler
  // aktif operasyon görünümünden ve SAYAÇLARDAN çıkar. Veritabanından
  // SİLİNMEZ; yalnız "Harici Sistemde İşlendi" filtresiyle görünür ve geri
  // alınabilir. Otomatik kural YOKTUR.
  if (operationTabFilter !== 'externallyProcessed') {
    current = applyOrderFilter(
      current,
      (order) => !isExternallyProcessed(order),
      exclusions,
      'externalProcessingFilter',
      'Sipariş harici sistemde işlendi olarak işaretlendi.',
    )
  }
  debug.afterExternalProcessingFilter = current.length

  if (selectedTab === 'currentSync') {
    current = applyOrderFilter(
      current,
      (order) =>
        Boolean(
          latestSyncBatchId &&
            order.lastMarketplaceSyncBatchId === latestSyncBatchId,
        ),
      exclusions,
      'selectedTab',
      'Son başarılı senkron batch kaydında bulunmuyor.',
    )
  } else if (selectedTab === 'today') {
    const todayRange = buildOrdersDateRange(
      'today',
      '',
      '',
      now,
      dateFilter.timezone || ORDERS_TIME_ZONE,
    )
    current = applyOrderFilter(
      current,
      (order) =>
        isOrderWithinDateRange(
          order,
          todayRange,
          dateFilter.timezone || ORDERS_TIME_ZONE,
        ),
      exclusions,
      'selectedTab',
      'Sipariş tarihi bugün (Europe/Istanbul) değil.',
    )
  } else if (selectedTab !== 'all') {
    current = applyOrderFilter(
      current,
      (order) =>
        orderMatchesQuickTab(classifyOrderForTabs(order), selectedTab),
      exclusions,
      'selectedTab',
      `Sipariş ${selectedTab} sekmesi kapsamına girmiyor.`,
    )
  }
  debug.afterTabFilter = current.length
  debug.afterSelectedTabCount = current.length

  // "İşlem Durumu" teknik filtresi: mevcut classifier ile ek daraltma.
  if (operationTabFilter && operationTabFilter !== 'all') {
    current = applyOrderFilter(
      current,
      (order) =>
        orderMatchesQuickTab(
          classifyOrderForTabs(order),
          operationTabFilter as QuickTab,
        ),
      exclusions,
      'operationTabFilter',
      `Sipariş ${operationTabFilter} işlem durumu kapsamına girmiyor.`,
    )
  }
  debug.afterOperationTabFilter = current.length

  const beforeMarketplaceFilter = current
  if (!isAllFilter(marketplaceFilter)) {
    current = current.filter(
      (order) =>
        normalizedToken(order.marketplace) ===
        normalizedToken(marketplaceFilter),
    )
  }
  recordRemovedOrders(
    beforeMarketplaceFilter,
    current,
    exclusions,
    'marketplaceFilter',
    'Pazaryeri seçili filtreyle eşleşmiyor.',
  )
  debug.afterMarketplaceFilter = current.length

  const beforeOperationStatusFilter = current
  if (!isAllFilter(operationStatusFilter)) {
    const expectedStatus = normalizedToken(operationStatusFilter)
    current = current.filter((order) =>
      [
        order.status,
        order.marketplaceStatus,
        order.operationStatus,
        order.labelStatus,
      ]
        .map(normalizedToken)
        .includes(expectedStatus),
    )
  }
  recordRemovedOrders(
    beforeOperationStatusFilter,
    current,
    exclusions,
    'statusFilter',
    'Sipariş durumu seçili statüyle eşleşmiyor.',
  )
  debug.afterOperationStatusFilter = current.length

  const beforeCargoFilter = current
  if (!isAllFilter(cargoFilter)) {
    const cargoToken = normalizedToken(cargoFilter)
    current = current.filter((order) => {
      if (cargoToken.includes('surat')) {
        return Boolean(order.shipment || hasCarrierTracking(order))
      }
      if (cargoToken.includes('bekliyor')) {
        return !hasCarrierTracking(order)
      }
      if (cargoToken.includes('hatal')) {
        return classifyOrderForTabs(order).hasError
      }
      return normalizedToken(order.cargoProviderName).includes(cargoToken)
    })
  }
  recordRemovedOrders(
    beforeCargoFilter,
    current,
    exclusions,
    'cargoFilter',
    'Kargo kaydı seçili filtreyle eşleşmiyor.',
  )
  debug.afterCargoFilter = current.length

  const beforeCityFilter = current
  if (!isAllFilter(cityFilter)) {
    const expectedCity = normalizedToken(cityFilter)
    current = current.filter(
      (order) => normalizedToken(order.city) === expectedCity,
    )
  }
  recordRemovedOrders(
    beforeCityFilter,
    current,
    exclusions,
    'cityFilter',
    'Teslimat ili seçili filtreyle eşleşmiyor.',
  )
  debug.afterCityFilter = current.length

  const beforeDistrictFilter = current
  if (!isAllFilter(districtFilter)) {
    const expectedDistrict = normalizedToken(districtFilter)
    current = current.filter(
      (order) => normalizedToken(order.district) === expectedDistrict,
    )
  }
  recordRemovedOrders(
    beforeDistrictFilter,
    current,
    exclusions,
    'districtFilter',
    'Teslimat ilçesi seçili filtreyle eşleşmiyor.',
  )
  debug.afterDistrictFilter = current.length

  const beforeMultiProductFilter = current
  if (multiProductFilter !== 'all') {
    current = current.filter((order) =>
      multiProductFilter === 'multi'
        ? order.items.length > 1
        : order.items.length <= 1,
    )
  }
  recordRemovedOrders(
    beforeMultiProductFilter,
    current,
    exclusions,
    'multiProductFilter',
    'Paket kalem sayısı seçili çoklu ürün filtresiyle eşleşmiyor.',
  )
  debug.afterMultiProductFilter = current.length

  const beforeActionFilter = current
  if (actionFilter !== 'all') {
    current = current.filter((order) =>
      orderMatchesDashboardAction(order, actionFilter),
    )
  }
  recordRemovedOrders(
    beforeActionFilter,
    current,
    exclusions,
    'actionFilter',
    'Sipariş seçili aksiyon filtresi kapsamında değil.',
  )
  debug.afterActionFilter = current.length

  if (!isAllFilter(dateFilter.preset)) {
    const startTime = dateFilter.startTime ?? Number.NEGATIVE_INFINITY
    const endTime = dateFilter.endTime ?? Number.POSITIVE_INFINITY
    current = applyOrderFilter(
      current,
      (order) =>
        isOrderWithinDateRange(
          order,
          { startTime, endTime },
          dateFilter.timezone || ORDERS_TIME_ZONE,
        ),
      exclusions,
      'dateFilter',
      'Sipariş tarihi seçili Europe/Istanbul aralığında değil.',
    )
  }
  debug.afterDateFilter = current.length

  const beforeSearch = current
  const query = searchQuery.trim().toLocaleLowerCase('tr-TR')
  if (query) {
    current = current.filter((order) =>
      [
        order.orderNumber,
        order.externalOrderId,
        // Kullanıcıya görünen Trendyol referansı (727...) ile de arama yapılabilsin;
        // canonical orderNumber (114...) araması korunur.
        order.cargoTrackingNumber,
        order.shipment?.ozelKargoTakipNo,
        order.shipment?.trendyolCargoTrackingNumber,
        order.customerName,
        order.customerPhone,
        order.customerEmail,
        order.city,
        order.district,
        ...order.items.flatMap((item) => [
          item.productName,
          item.sku,
          item.merchantSku,
          item.stockCode,
          item.barcode,
        ]),
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('tr-TR')
        .includes(query),
    )
  }

  current = filterByWorkspaceQuery(current, customerQuery, (order) => [
    order.customerName,
    order.customerPhone,
    order.customerEmail,
  ])
  current = filterByWorkspaceQuery(current, productQuery, (order) =>
    order.items.flatMap((item) => [
      item.productName,
      item.sku,
      item.merchantSku,
      item.stockCode,
      item.barcode,
    ]),
  )
  current = filterByWorkspaceQuery(current, orderNumberQuery, (order) => [
    order.orderNumber,
    order.externalOrderId,
    order.cargoTrackingNumber,
    order.shipment?.ozelKargoTakipNo,
    order.shipment?.trendyolCargoTrackingNumber,
  ])
  current = filterByWorkspaceQuery(current, cargoSlipQuery, (order) => {
    const verification = verifySuratShipment(order)
    return [
      order.cargoTrackingNumber,
      order.shipment?.shipmentCode,
      order.shipment?.trackingNumber,
      order.shipment?.kargoTakipNo,
      order.shipment?.tNo,
      order.shipment?.barcode,
      order.shipment?.barkodNo,
      order.shipment?.barcodeValue,
      order.shipment?.gonderiNo,
      order.shipment?.waybillNo,
      order.shipment?.irsaliyeNo,
      order.shipment?.cargoKey,
      verification.trackingNumber,
      verification.officialBarcodeValue,
    ]
  })
  recordRemovedOrders(
    beforeSearch,
    current,
    exclusions,
    'searchFilter',
    'Sipariş arama alanlarıyla eşleşmiyor.',
  )
  debug.afterSearch = current.length

  // "AYNI ÜRÜN SİPARİŞİ" EN SON UYGULANIR.
  //
  // SCOPE SÖZLEŞMESİ (deterministik): tekrar hesabı, diğer TÜM filtrelerden
  // (sekme + işlem durumu + pazaryeri + statü + kargo + şehir/ilçe + çoklu
  // ürün + aksiyon + tarih + arama) geçmiş NİHAİ küme üzerinde yapılır.
  // Böylece sayım teslim edilmiş/iptal eski kayıtlarla ŞİŞMEZ ve "Yeni
  // Siparişler" sekmesinde yalnız o sekmenin siparişleri karşılaştırılır.
  const beforeSameProductFilter = current
  if (sameProductFilter !== 'all') {
    const repeatedOrderIds = buildRepeatedProductOrderIds(current)
    current = current.filter((order) => {
      const orderId = String(order.id || order.orderNumber || '')
      const repeated = repeatedOrderIds.has(orderId)
      return sameProductFilter === 'repeated' ? repeated : !repeated
    })
  }
  recordRemovedOrders(
    beforeSameProductFilter,
    current,
    exclusions,
    'sameProductFilter',
    'Sipariş seçili aynı-ürün filtresiyle eşleşmiyor.',
  )
  debug.afterSameProductFilter = current.length

  const summary = buildOrderCountSummary(current)
  debug.visibleCount = summary.packageCount
  debug.uniquePackageCount = summary.packageCount
  debug.uniqueOrderNumberCount = summary.orderCount
  debug.lineCount = summary.lineCount
  debug.quantityTotal = summary.quantityTotal

  return { visibleOrders: current, debug }
}

function applyOrderFilter(
  orders: CargoOrder[],
  predicate: (order: CargoOrder) => boolean,
  exclusions: VisibleOrderExclusion[],
  stage: string,
  reason: string,
): CargoOrder[] {
  return orders.filter((order) => {
    const included = predicate(order)
    if (!included) exclusions.push(toExclusion(order, stage, reason))
    return included
  })
}

function recordRemovedOrders(
  before: CargoOrder[],
  after: CargoOrder[],
  exclusions: VisibleOrderExclusion[],
  stage: string,
  reason: string,
): void {
  const retained = new Map<string, number>()
  after.forEach((order) => {
    const identity = orderPackageIdentity(order)
    retained.set(identity, (retained.get(identity) ?? 0) + 1)
  })
  before.forEach((order) => {
    const identity = orderPackageIdentity(order)
    const remaining = retained.get(identity) ?? 0
    if (remaining > 0) {
      retained.set(identity, remaining - 1)
    } else {
      exclusions.push(toExclusion(order, stage, reason))
    }
  })
}

function toExclusion(
  order: CargoOrder | undefined,
  stage: string,
  reason: string,
): VisibleOrderExclusion {
  return {
    orderNumber: String(order?.orderNumber ?? ''),
    packageId: String(order?.packageId ?? order?.shipmentPackageId ?? ''),
    lineId: String(order?.items?.[0]?.id ?? ''),
    excludedAtStage: stage,
    exclusionReason: reason,
  }
}

function filterByWorkspaceQuery(
  orders: CargoOrder[],
  query: string,
  selectValues: (order: CargoOrder) => unknown[],
): CargoOrder[] {
  const token = normalizedSearch(query)
  if (!token) return orders
  return orders.filter((order) =>
    selectValues(order)
      .filter(Boolean)
      .map(normalizedSearch)
      .some((value) => value.includes(token)),
  )
}

export function normalizedSearch(value: unknown): string {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

// Dashboard operasyon aşaması: TEK, karşılıklı-dışlayan kova. Hem Operation Flow
// sayaçları, hem "Son Operasyonlar" statüsü, hem dashboard özeti BU tek helper'dan
// beslenir (ayrı status türetmesi YOK). Böylece bir sipariş yalnız bir kovada
// sayılır (Açık Operasyon + Etiket Basıldı çift sayımı olmaz) ve recentOperations
// ile sayaçlar her zaman tutarlıdır.
export type DashboardOperationStage =
  | 'open'
  | 'barcodeWaiting'
  | 'labelReady'
  | 'labelPrinted'
  | 'handedToCargo'
  | 'delivered'
  | 'canceledOrReturned'
  | 'archived'
  | 'error'
  | 'unknown'

const DASHBOARD_OPERATION_STAGE_LABELS: Record<
  DashboardOperationStage,
  string
> = {
  canceledOrReturned: 'İptal / İade',
  delivered: 'Teslim Edildi',
  handedToCargo: 'Kargoya Verildi',
  labelPrinted: 'Etiket Basıldı',
  labelReady: 'Etiket Hazır',
  archived: 'Arşiv',
  error: 'Kontrol Gerekli',
  barcodeWaiting: 'Barkod Bekliyor',
  open: 'Açık Operasyon',
  unknown: 'Bilinmiyor',
}

// Öncelik CANONICAL: gerçek terminal lifecycle (iptal/iade, teslim, kargoya
// verildi) en üstte; ardından canonical etiket durumu (LABEL_PRINTED/LABEL_READY).
// Canonical etiket durumu "Arşiv" UI SUNUMUNU ve pazaryeri ara durumlarını
// ("Hazırlanıyor") EZMEZ: yani LABEL_PRINTED asla Açık Operasyon/Arşiv sayılmaz,
// LABEL_READY asla Açık Operasyon/Barkod Bekliyor sayılmaz.
export function resolveDashboardOperationStage(
  state: Pick<
    OrderTabClassification,
    | 'isOpenOperation'
    | 'isBarcodeWaiting'
    | 'isLabelReady'
    | 'isLabelPrinted'
    | 'isHandedToCargo'
    | 'isDelivered'
    | 'isCanceledOrReturned'
    | 'isArchived'
    | 'hasError'
  >,
): DashboardOperationStage {
  if (state.isCanceledOrReturned) return 'canceledOrReturned'
  if (state.isDelivered) return 'delivered'
  if (state.isHandedToCargo) return 'handedToCargo'
  if (state.isLabelPrinted) return 'labelPrinted'
  if (state.isLabelReady) return 'labelReady'
  // Arşiv YALNIZ gerçek pasif kanıtla (explicit archived / archivedAt). Yaşa
  // dayalı otomatik arşiv KALDIRILDI.
  if (state.isArchived) return 'archived'
  if (state.hasError) return 'error'
  if (state.isBarcodeWaiting) return 'barcodeWaiting'
  if (state.isOpenOperation) return 'open'
  return 'unknown'
}

// ═══ TOPLAMA UYGUNLUĞU (PICKING ELIGIBILITY) ══════════════════════════════
//
// "Toplanacak Ürünler" = HENÜZ BASKIYA GÖNDERİLMEMİŞ AKTİF siparişlerin
// toplanması gereken ürünleri. Kanonik TEK-KOVA aşama helper'ı yeniden
// kullanılır; YENİ bir durum sistemi üretilmez.
//
// DAHİL   : open (yeni/hazırlanan) · barcodeWaiting · labelReady · error
// HARİÇ   : labelPrinted (Baskıya Gönderildi) · handedToCargo · delivered ·
//           canceledOrReturned · archived · unknown (kapatılmış)
//
// SEÇİLMİŞ ≠ BASILMIŞ: toplu baskıda seçilmek siparişi listeden DÜŞÜRMEZ.
// Yalnız başarılı LABEL_PRINTED geçişi düşürür; atlanan/başarısız sipariş
// (LABEL_PRINTED almadığı için) listede KALIR.
//
// 'error' bilerek dahildir: baskı sorunu yaşamış ama basılmamış sipariş hâlâ
// depodan toplanmalıdır.
const PICKING_ELIGIBLE_STAGES = new Set<DashboardOperationStage>([
  'open',
  'barcodeWaiting',
  'labelReady',
  'error',
])

export function resolvePickingStage(order: CargoOrder): DashboardOperationStage {
  return resolveDashboardOperationStage(classifyOrderForTabs(order))
}

export function isPickingEligible(order: CargoOrder): boolean {
  return PICKING_ELIGIBLE_STAGES.has(resolvePickingStage(order))
}

export function dashboardOperationStageLabel(
  stage: DashboardOperationStage,
): string {
  return DASHBOARD_OPERATION_STAGE_LABELS[stage]
}

// Sipariş → tek canonical operasyon aşaması (+ Türkçe etiket). Dashboard'daki
// tüm operasyon sayımları ve statü gösterimleri buradan geçmelidir.
export function classifyDashboardOperationStage(order: CargoOrder): {
  stage: DashboardOperationStage
  label: string
} {
  const stage = resolveDashboardOperationStage(classifyOrderForTabs(order))
  return { stage, label: DASHBOARD_OPERATION_STAGE_LABELS[stage] }
}

// Canonical sipariş statüsü enum'u (mevcut enum isimleriyle uyumlu). Tek
// mutually-exclusive kova; aşama → enum eşlemesi.
export type CanonicalOrderStatus =
  | 'BARCODE_WAITING'
  | 'OPEN'
  | 'LABEL_READY'
  | 'LABEL_PRINTED'
  | 'HANDED_TO_CARGO'
  | 'DELIVERED'
  | 'CANCELLED_OR_RETURNED'
  | 'ARCHIVED'
  | 'CONTROL_REQUIRED'
  | 'UNKNOWN'

const STAGE_TO_CANONICAL_STATUS: Record<
  DashboardOperationStage,
  CanonicalOrderStatus
> = {
  barcodeWaiting: 'BARCODE_WAITING',
  open: 'OPEN',
  labelReady: 'LABEL_READY',
  labelPrinted: 'LABEL_PRINTED',
  handedToCargo: 'HANDED_TO_CARGO',
  delivered: 'DELIVERED',
  canceledOrReturned: 'CANCELLED_OR_RETURNED',
  archived: 'ARCHIVED',
  error: 'CONTROL_REQUIRED',
  unknown: 'UNKNOWN',
}

// MERKEZİ canonical sipariş statüsü — TEK KAYNAK. Siparişler tablo rozeti,
// Tümü/Yeni Siparişler/Etiket Hazır/Kargoya Verildi/Teslim/İptal-İade/Arşiv
// sekmeleri, sipariş detay drawer'ı, Dashboard Operasyon Akışı ve Son
// Operasyonlar bu helper'dan beslenir; aynı sipariş her ekranda aynı canonical
// statüyü gösterir. Öncelik (yüksekten düşüğe): iptal/iade → teslim → kargoya
// verildi → etiket basıldı → etiket hazır → (explicit) arşiv → kontrol gerekli
// → barkod bekliyor → açık/yeni. Pazaryeri statüsü operationStatus'ü körlemesine
// EZMEZ; yalnız GÜÇLÜ kanıt (canonical durum / persist edilmiş taşıyıcı zaman
// damgası / yazdırılabilir etiket / gerçek arşiv) canonical statüyü belirler.
// Yaş TEK BAŞINA statü değiştirmez.
export function classifyCanonicalOrderStatus(order: CargoOrder): {
  stage: DashboardOperationStage
  status: CanonicalOrderStatus
  label: string
} {
  const stage = resolveDashboardOperationStage(classifyOrderForTabs(order))
  return {
    stage,
    status: STAGE_TO_CANONICAL_STATUS[stage],
    label: DASHBOARD_OPERATION_STAGE_LABELS[stage],
  }
}

function isAllFilter(value?: string): boolean {
  return ['all', 'tumu', 'tumtarihler', ''].includes(normalizedToken(value))
}

export function normalizedToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  return String((value as Record<string, unknown>)[key] ?? '').trim()
}

function readBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>)[key] === true
}

function findNestedString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    return value.map((item) => findNestedString(item, key)).find(Boolean) ?? ''
  }
  const record = value as Record<string, unknown>
  if (record[key] != null && typeof record[key] !== 'object') {
    return String(record[key]).trim()
  }
  return (
    Object.values(record)
      .map((item) => findNestedString(item, key))
      .find(Boolean) ?? ''
  )
}

function findNestedBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item) => findNestedBoolean(item, key))
  }
  const record = value as Record<string, unknown>
  if (record[key] != null) return record[key] === true
  return Object.values(record).some((item) => findNestedBoolean(item, key))
}

function firstString(...values: Array<string | undefined>): string {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? ''
}

function resolveLatestMarketplaceSyncAt(orders: CargoOrder[]): string | undefined {
  const dated = orders
    .map((order) => String(order.lastMarketplaceSyncedAt ?? '').trim())
    .filter(Boolean)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((item) => !Number.isNaN(item.time))
    .sort((a, b) => b.time - a.time)

  return dated[0]?.value
}

function resolveLatestMarketplaceSyncBatchId(
  orders: CargoOrder[],
): string | undefined {
  return orders
    .map((order) => String(order.lastMarketplaceSyncBatchId ?? '').trim())
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0]
}
