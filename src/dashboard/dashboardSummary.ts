import type {
  ApiDebugLog,
  CargoOrder,
  CargoProduct,
  IntegrationConfig,
  PrinterSettings,
} from '../types/cargoflow.ts'
import {
  isActiveMarketplaceStatus,
  isCancelledOrReturnedStatus,
} from '../utils/orderStatus.ts'
import { classifyOrderForTabs } from '../utils/orderClassification.ts'
import { resolveProductImageCandidates } from '../utils/productImage.ts'
import { resolveOrderStatus } from '../utils/shipmentStatus.ts'
import {
  isPreassignedAwaitingAcceptance,
  resolveSuratPrintEligibility,
} from '../utils/suratPrintEligibility.ts'
import { verifySuratShipment } from '../utils/suratVerification.ts'
import {
  carrierProviderRegistry,
  marketplaceProviderRegistry,
  resolveCarrierProvider,
  resolveMarketplaceProvider,
} from './providerRegistry.ts'
import {
  resolveSuratConfigured,
  resolveTrendyolConfigured,
} from '../utils/integrationConfigured.ts'
import type { MaskedIntegrationStatus } from '../services/integrationConfigService.ts'

// 'needs_check': credential kayıtlı (configured) ama son gerçek bağlantı testi
// başarılı değil/yok → "bağlantı kontrol edilmeli" (kayıt kaybı DEĞİL).
export type ProviderHealthStatus =
  | 'connected'
  | 'needs_check'
  | 'error'
  | 'not_configured'
export type DashboardPeriod = 'today' | 'last7' | 'month' | 'all'

export interface DashboardProviderHealth {
  providerKey: string
  providerName: string
  status: ProviderHealthStatus
  // configured: gerekli credential'lar güvenli şekilde kayıtlı (maskeli metadata).
  // connected: son gerçek bağlantı testi/sync başarılı. İkisi AYRI semantiktir;
  // kayıtlı credential otomatik connected üretmez.
  configured: boolean
  connected: boolean
  lastSyncAt?: string
  errorCount: number
  detail: string
}

export interface DashboardActionItem {
  key: string
  title: string
  description: string
  count: number
  target:
    | 'barcodePending'
    | 'labelReady'
    | 'labelPrinted'
    | 'cancelReturn'
    | 'all'
    | 'integrations'
}

export interface DashboardRecentOrder {
  id: string
  orderNumber: string
  marketplaceProviderKey: string
  marketplaceProviderName: string
  customerName: string
  productSummary: string
  productImageUrl: string
  productImageCandidates: string[]
  imageResolvedFrom?: string
  status: string
  statusSource: string
  carrierProviderKey: string
  carrierProviderName: string
  trackingNumber: string
  barcode: string
  trendyolCargoTrackingNumber: string
  barcodeRaw: string
  labelStatus?: string
  printedAt?: string
  createdAt: string
}

export interface DashboardProviderBreakdown {
  marketplaceProviderKey: string
  marketplaceProviderName: string
  orderCount: number
  errorCount: number
  carrierProviderKey: string
  carrierProviderName: string
  shipmentCount: number
  labelReadyCount: number
}

export interface DashboardSummary {
  openOperations: number
  todayOrders: number
  monthlyOrders: number
  allOrders: number
  totalOrders: number
  barcodeWaiting: number
  labelReady: number
  labelPrinted: number
  errors: number
  canceledOrReturned: number
  selectedPeriod: DashboardPeriod
  flowSteps: Array<{ key: string; label: string; count: number }>
  actionItems: DashboardActionItem[]
  recentOrders: DashboardRecentOrder[]
  marketplaceHealth: DashboardProviderHealth[]
  carrierHealth: DashboardProviderHealth[]
  printerHealth: {
    status: ProviderHealthStatus
    name: string
    detail: string
  }
  subscriptionSummary: {
    available: boolean
    label: string
  }
  providerBreakdown: DashboardProviderBreakdown[]
  lastSyncAt?: string
}

interface BuildDashboardSummaryInput {
  orders: CargoOrder[]
  products?: CargoProduct[]
  shipments?: unknown[]
  labels?: unknown[]
  marketplaceIntegrations: DashboardProviderHealth[]
  carrierIntegrations: DashboardProviderHealth[]
  printerSettings: PrinterSettings
  subscription?: { status?: string; planName?: string }
  selectedPeriod?: DashboardPeriod
}

export function buildDashboardSummary({
  orders,
  products = [],
  marketplaceIntegrations,
  carrierIntegrations,
  printerSettings,
  subscription,
  selectedPeriod = 'today',
}: BuildDashboardSummaryInput): DashboardSummary {
  const now = new Date()
  // Sayaçlar paket seviyesinde tekildir: aynı Trendyol paketi birden fazla
  // satırdan gelirse bir kez sayılır (packageId → shipmentPackageId →
  // marketplace+orderNumber → id anahtar sırası).
  const uniqueOrders = dedupeOrdersByPackage(orders)
  const normalized = uniqueOrders.map((order) =>
    normalizeOrder(order, products),
  )
  const classified = uniqueOrders.map((order) => ({
    order,
    state: classifyOrderForTabs(order),
  }))
  const todayOrders = normalized.filter((item) =>
    isSameLocalDate(item.createdAt, now),
  )
  const monthlyOrders = normalized.filter((item) =>
    isSameLocalMonth(item.createdAt, now),
  )
  const openOperations = classified.filter(
    ({ state }) => state.isOpenOperation,
  )
  const barcodeWaiting = classified.filter(
    ({ state }) => state.isBarcodeWaiting,
  )
  const labelReady = classified.filter(({ state }) => state.isLabelReady)
  const labelPrinted = classified.filter(
    ({ order, state }) =>
      state.isLabelPrinted &&
      Boolean(order.label?.printedAt) &&
      isWithinPeriod(order.label?.printedAt || '', selectedPeriod, now),
  )
  const errors = classified.filter(({ state }) => state.hasError)
  const canceled = classified.filter(
    ({ order, state }) =>
      state.isCanceledOrReturned &&
      isWithinPeriod(order.orderDate || order.createdAt, selectedPeriod, now),
  )
  const handedToCargo = classified.filter(
    ({ state }) => state.isHandedToCargo || state.isDelivered,
  )
  const barcodeErrors = normalized.filter(
    (item) =>
      !item.canceled &&
      !item.archived &&
      !item.closed &&
      (item.operationStatus.includes('BARCODE_FAILED') ||
        item.wrongServiceCalled ||
        Boolean(item.providerResponseError)),
  )
  const missingRaw = normalized.filter(
    (item) =>
      !item.canceled &&
      !item.archived &&
      !item.closed &&
      item.verifiedShipment &&
      !item.barcodeRaw,
  )
  const printErrors = normalized.filter((item) => Boolean(item.printError))
  const reprinted = normalized.filter((item) => item.printCount > 1)
  const connectionErrors =
    marketplaceIntegrations.filter((item) => item.status === 'error').length +
    carrierIntegrations.filter((item) => item.status === 'error').length

  const actionItems: DashboardActionItem[] = [
    {
      key: 'barcode-waiting',
      title: 'Barkod oluşturulmamış siparişler',
      description: 'Kargo barkodu oluşturulması gereken aktif siparişler.',
      count: barcodeWaiting.length,
      target: 'barcodePending',
    },
    {
      key: 'barcode-errors',
      title: 'Kargo barkod hatası',
      description: providerNames(barcodeErrors, 'carrier'),
      count: barcodeErrors.length,
      target: 'all',
    },
    {
      key: 'raw-missing',
      title: 'ZPL verisi eksik',
      description: 'Gönderisi doğrulanmış ancak barcodeRaw verisi bulunmuyor.',
      count: missingRaw.length,
      target: 'all',
    },
    {
      key: 'ready-not-printed',
      title: 'Etiket hazır, baskı bekliyor',
      description: 'Zebra baskısına hazır etiketler.',
      count: labelReady.length,
      target: 'labelReady',
    },
    {
      key: 'print-errors',
      title: 'Yazdırma hatası',
      description: 'Yazıcıya gönderilemeyen ve durumu değiştirilmeyen etiketler.',
      count: printErrors.length,
      target: 'labelReady',
    },
    {
      key: 'reprinted',
      title: 'Tekrar basılmış etiketler',
      description: 'Mükerrer kullanım açısından kontrol edilmesi gereken baskılar.',
      count: reprinted.length,
      target: 'labelPrinted',
    },
    {
      key: 'provider-errors',
      title: 'Bağlantı hatası olan sağlayıcılar',
      description: 'Entegrasyon ayarları veya son bağlantı sonucunu kontrol edin.',
      count: connectionErrors,
      target: 'integrations',
    },
  ]

  return {
    openOperations: openOperations.length,
    todayOrders: todayOrders.length,
    monthlyOrders: monthlyOrders.length,
    allOrders: normalized.length,
    totalOrders: normalized.length,
    barcodeWaiting: barcodeWaiting.length,
    labelReady: labelReady.length,
    labelPrinted: labelPrinted.length,
    errors: errors.length,
    canceledOrReturned: canceled.length,
    selectedPeriod,
    flowSteps: [
      {
        key: 'received',
        label: 'Açık Operasyon',
        count: openOperations.length,
      },
      { key: 'barcode', label: 'Barkod Bekliyor', count: barcodeWaiting.length },
      { key: 'ready', label: 'Etiket Hazır', count: labelReady.length },
      { key: 'printed', label: 'Etiket Basıldı', count: labelPrinted.length },
      { key: 'cargo', label: 'Kargoya Verildi', count: handedToCargo.length },
    ],
    actionItems,
    recentOrders: normalized
      .filter((item) => isWithinPeriod(item.createdAt, selectedPeriod, now))
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      )
      .slice(0, 10),
    marketplaceHealth: marketplaceIntegrations.filter(
      (provider) => provider.status !== 'not_configured' || provider.providerKey === 'trendyol',
    ),
    carrierHealth: carrierIntegrations.filter(
      (provider) => provider.status !== 'not_configured' || provider.providerKey === 'surat',
    ),
    printerHealth: {
      status:
        printerSettings.mode !== 'download' && printerSettings.printerName
          ? 'connected'
          : 'not_configured',
      name: printerSettings.printerName || 'Zebra Yazıcı',
      detail:
        printerSettings.mode === 'local-agent'
          ? 'Windows RAW baskı'
          : printerSettings.mode === 'browser-print'
            ? 'Chrome temiz etiket önizlemesi · 100×150 mm'
            : 'ZPL indirme modu',
    },
    subscriptionSummary: {
      available: Boolean(subscription?.status || subscription?.planName),
      label:
        subscription?.planName ||
        subscription?.status ||
        'Abonelik bilgisi mevcut değil',
    },
    providerBreakdown: buildProviderBreakdown(normalized),
    lastSyncAt: marketplaceIntegrations
      .map((item) => item.lastSyncAt)
      .filter(Boolean)
      .sort()
      .at(-1),
  }
}

// configured (kayıtlı) + son test/sync kanıtından status türetir. Kayıtlı
// credential OTOMATİK connected üretmez: connected için son gerçek bir başarılı
// test/sync kanıtı (hata olmayan debug log veya Trendyol için lastSyncedAt) gerekir.
function resolveProviderHealthStatus(
  configured: boolean,
  lastLogStatus: string | undefined,
  hasSuccessSignal: boolean,
): ProviderHealthStatus {
  if (!configured) return 'not_configured'
  if (lastLogStatus === 'ERROR') return 'error'
  if (hasSuccessSignal) return 'connected'
  return 'needs_check'
}

/**
 * SAĞLAYICI SAYAÇLARI — tam sipariş kümesinden türer.
 *
 * `buildDashboardProviderHealth` iki yerde sipariş sayar: pazaryeri başına
 * "N kalıcı sipariş" metni ve taşıyıcı başına doğrulanmış gönderi sayısı
 * (bağlantı sağlık sinyali). Tarayıcı artık tam listeye sahip olmadığından
 * bu sayılar SUNUCUDA, aynı çözümleyicilerle hesaplanır ve buraya verilir.
 * Verilmezse (legacy mod) eskisi gibi yerel listeden hesaplanır.
 */
export interface DashboardProviderCounts {
  marketplaceOrderCounts: Record<string, number>
  carrierVerifiedShipmentCounts: Record<string, number>
}

export function buildDashboardProviderCounts(
  orders: CargoOrder[],
): DashboardProviderCounts {
  const marketplaceOrderCounts: Record<string, number> = {}
  const carrierVerifiedShipmentCounts: Record<string, number> = {}
  for (const provider of Object.values(marketplaceProviderRegistry)) {
    marketplaceOrderCounts[provider.providerKey] = orders.filter(
      (order) =>
        resolveMarketplaceProvider(order.marketplace).providerKey ===
        provider.providerKey,
    ).length
  }
  for (const provider of Object.values(carrierProviderRegistry)) {
    carrierVerifiedShipmentCounts[provider.providerKey] = orders.filter(
      (order) =>
        Boolean(order.shipment?.verifiedShipment) &&
        resolveCarrierProvider(
          order.shipment?.provider || order.cargoProviderName,
        ).providerKey === provider.providerKey,
    ).length
  }
  return { marketplaceOrderCounts, carrierVerifiedShipmentCounts }
}

export function buildDashboardProviderHealth({
  config,
  maskedStatus,
  apiDebugLogs,
  orders,
  providerCounts,
  lastSyncedAt,
}: {
  config: IntegrationConfig
  maskedStatus?: MaskedIntegrationStatus | null
  apiDebugLogs: ApiDebugLog[]
  orders: CargoOrder[]
  /** Sunucuda tam küme üzerinden hesaplanmış sayaçlar (varsa ÖNCELİKLİ). */
  providerCounts?: DashboardProviderCounts
  lastSyncedAt?: string
}): {
  marketplaceIntegrations: DashboardProviderHealth[]
  carrierIntegrations: DashboardProviderHealth[]
} {
  const marketplace = Object.values(marketplaceProviderRegistry).map((provider) => {
    // configured: MERKEZİ helper (maskeli metadata öncelikli; ham secret'a bakmaz).
    const configured =
      provider.providerKey === 'trendyol'
        ? resolveTrendyolConfigured(maskedStatus, config)
        : false
    const logs = apiDebugLogs.filter(
      (log) =>
        resolveMarketplaceProvider(log.provider).providerKey ===
        provider.providerKey,
    )
    const last = logs[0]
    // KALICI (login/hydrate) sync sağlığı: son başarılı sync connected üretir,
    // son 'failed' sync gerçek hata üretir. Böylece ilk yüklemede (client debug
    // log yokken) kayıtlı+başarılı-sync hesap YANLIŞ "kontrol edilmeli" uyarısı
    // ALMAZ; kayıtlı ama hiç test/sync yoksa nötr (needs_check) kalır.
    const trendyolMasked =
      provider.providerKey === 'trendyol' ? maskedStatus?.trendyol : undefined
    const persistedSyncSuccess = Boolean(trendyolMasked?.lastSuccessfulSyncAt)
    const persistedSyncFailed = trendyolMasked?.lastSyncStatus === 'failed'
    const hasSuccessSignal =
      Boolean(last && last.status !== 'ERROR') ||
      (provider.providerKey === 'trendyol' && Boolean(lastSyncedAt)) ||
      persistedSyncSuccess
    // Client debug log statüsü en güncel kanıttır; yoksa kalıcı 'failed' sync
    // gerçek hata sinyali olarak kullanılır.
    const effectiveLastLogStatus =
      last?.status ?? (persistedSyncFailed ? 'ERROR' : undefined)
    const status = resolveProviderHealthStatus(
      configured,
      effectiveLastLogStatus,
      hasSuccessSignal,
    )
    return {
      providerKey: provider.providerKey,
      providerName: provider.providerName,
      status,
      configured,
      connected: status === 'connected',
      lastSyncAt:
        provider.providerKey === 'trendyol'
          ? lastSyncedAt || last?.timestamp
          : last?.timestamp,
      errorCount: logs.filter((log) => log.status === 'ERROR').length,
      detail: configured
        ? `${
            providerCounts?.marketplaceOrderCounts[provider.providerKey] ??
            orders.filter(
              (order) =>
                resolveMarketplaceProvider(order.marketplace).providerKey ===
                provider.providerKey,
            ).length
          } kalıcı sipariş`
        : 'Ayarlanmadı',
    }
  })

  const carrier = Object.values(carrierProviderRegistry).map((provider) => {
    // Sürat configured: KullanıcıAdı/CariKod + (Şifre veya WebPassword). FirmaId
    // ZORUNLU DEĞİL. Merkezî helper (maskeli metadata öncelikli).
    const configured =
      provider.providerKey === 'surat'
        ? resolveSuratConfigured(maskedStatus, config)
        : false
    const logs = apiDebugLogs.filter(
      (log) =>
        resolveCarrierProvider(log.provider).providerKey ===
        provider.providerKey,
    )
    const last = logs[0]
    const shipmentCount =
      providerCounts?.carrierVerifiedShipmentCounts[provider.providerKey] ??
      orders.filter(
        (order) =>
          Boolean(order.shipment?.verifiedShipment) &&
          resolveCarrierProvider(
            order.shipment?.provider || order.cargoProviderName,
          ).providerKey === provider.providerKey,
      ).length
    const hasSuccessSignal =
      Boolean(last && last.status !== 'ERROR') || shipmentCount > 0
    const status = resolveProviderHealthStatus(
      configured,
      last?.status,
      hasSuccessSignal,
    )
    return {
      providerKey: provider.providerKey,
      providerName: provider.providerName,
      status,
      configured,
      connected: status === 'connected',
      lastSyncAt: last?.timestamp,
      errorCount: logs.filter((log) => log.status === 'ERROR').length,
      detail: configured
        ? `${shipmentCount} doğrulanmış gönderi`
        : 'Ayarlanmadı',
    }
  })

  return {
    marketplaceIntegrations: marketplace,
    carrierIntegrations: carrier,
  }
}

function dedupeOrdersByPackage(orders: CargoOrder[]): CargoOrder[] {
  const seen = new Set<string>()
  const unique: CargoOrder[] = []
  for (const order of orders) {
    const key =
      String(order.packageId ?? '').trim() ||
      String(order.shipmentPackageId ?? '').trim() ||
      `${String(order.marketplace ?? '').trim()}::${String(
        order.orderNumber ?? '',
      ).trim()}` ||
      String(order.id ?? '')
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    unique.push(order)
  }
  return unique
}

function normalizeOrder(
  order: CargoOrder,
  products: CargoProduct[] = [],
): DashboardRecentOrder & {
  verifiedShipment: boolean
  preassignedReady: boolean
  operationStatus: string
  canceled: boolean
  hasError: boolean
  printError: string
  printCount: number
  wrongServiceCalled: boolean
  providerResponseError: string
  marketplaceStatus: string
  operationallyActive: boolean
  archived: boolean
  closed: boolean
} {
  const marketplace = resolveMarketplaceProvider(
    readString(order, 'marketplaceProviderKey') || order.marketplace,
  )
  const carrier = resolveCarrierProvider(
    readString(order.shipment, 'carrierProviderKey') ||
      order.shipment?.provider ||
      order.cargoProviderName,
  )
  const shipment = order.shipment
  const verification = verifySuratShipment(order, shipment)
  const verifiedShipment = verification.verifiedShipment
  const preassignedReady = Boolean(
    isPreassignedAwaitingAcceptance(shipment) &&
      resolveSuratPrintEligibility(order, shipment).canPrint,
  )
  const trackingNumber = verification.trackingNumber
  const barcode = verification.barcode
  const barcodeRaw = readString(shipment, 'barcodeRaw')
  const printError = first(
    readString(order.label?.printDebug, 'printError'),
    readString(order, 'printError'),
  )
  const wrongServiceCalled = Boolean(
    readBoolean(shipment, 'wrongServiceCalled') ||
      findNestedBoolean(shipment, 'wrongServiceCalled'),
  )
  const providerResponseError = first(
    findNestedString(shipment, 'errorMessage'),
    findNestedBoolean(shipment, 'isError') ? 'Provider response error' : '',
  )
  const noTrackingReason = first(
    order.noTrackingReason,
    shipment?.noTrackingReason,
  )
  const canceled = isCancelledOrReturnedStatus(order.marketplaceStatus)
  const archived = Boolean(
    readBoolean(order, 'archived') ||
      readBoolean(order, 'isArchived') ||
      readString(order, 'archivedAt'),
  )
  const closed = Boolean(
    ['HANDED_TO_CARGO', 'DELIVERED'].includes(order.operationStatus) ||
      ['Shipped', 'Delivered', 'AtCollectionPoint'].includes(
        order.marketplaceStatus,
      ) ||
      readBoolean(order, 'closed') ||
      readBoolean(order, 'completed') ||
      readString(order, 'closedAt') ||
      readString(order, 'completedAt'),
  )
  const hasError = Boolean(
    !canceled &&
      (order.operationStatus.includes('BARCODE_FAILED') ||
        (order.operationStatus === 'ERROR' && order.status === 'Hata') ||
        printError ||
        (verifiedShipment && !barcode) ||
        wrongServiceCalled ||
        // Ön-atanmış hazır etiketin bilgi metinleri hata sayılmaz.
        (!preassignedReady && noTrackingReason) ||
        (!preassignedReady && providerResponseError)),
  )
  const resolvedStatus = resolveOrderStatus(order)

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    marketplaceProviderKey: marketplace.providerKey,
    marketplaceProviderName:
      readString(order, 'marketplaceProviderName') || marketplace.providerName,
    customerName: order.customerName,
    productSummary:
      order.items
        .slice(0, 2)
        .map((item) => `${item.quantity || 1}x ${item.productName}`)
        .join(', ') || 'Ürün bilgisi yok',
    productImageUrl:
      order.items[0]?.productImageUrl || order.items[0]?.imageUrl || '',
    // Trendyol sipariş satırları görsel alanı taşımıyor (canlı doğrulama:
    // 123/123 siparişte rawLine görsel alanları boş); görseller ürün
    // cache eşleşmesinden gelir — bu yüzden products buraya da iletilir.
    productImageCandidates: order.items[0]
      ? resolveProductImageCandidates(order.items[0], products).map(
          (candidate) => candidate.url,
        )
      : [],
    imageResolvedFrom: order.items[0]?.imageResolvedFrom,
    status: dashboardStatus(
      order,
      verifiedShipment || preassignedReady,
      barcode,
    ),
    statusSource: resolvedStatus.sourceLabel,
    carrierProviderKey: carrier.providerKey,
    carrierProviderName:
      readString(shipment, 'carrierProviderName') ||
      order.cargoProviderName ||
      carrier.providerName,
    trackingNumber,
    barcode,
    trendyolCargoTrackingNumber: String(order.cargoTrackingNumber ?? '').trim(),
    barcodeRaw,
    labelStatus: order.labelStatus,
    printedAt: order.label?.printedAt,
    createdAt: order.orderDate || order.createdAt,
    verifiedShipment,
    preassignedReady,
    operationStatus: order.operationStatus,
    canceled,
    hasError,
    printError,
    printCount: order.label?.printCount ?? 0,
    wrongServiceCalled,
    providerResponseError,
    marketplaceStatus: order.marketplaceStatus,
    operationallyActive: isActiveMarketplaceStatus(order.marketplaceStatus),
    archived,
    closed,
  }
}

function buildProviderBreakdown(
  orders: ReturnType<typeof normalizeOrder>[],
): DashboardProviderBreakdown[] {
  const pairKeys = Array.from(
    new Set(
      orders.map(
        (order) =>
          `${order.marketplaceProviderKey}::${order.carrierProviderKey}`,
      ),
    ),
  )
  return pairKeys.map((pairKey) => {
    const [marketplaceKey, carrierKey] = pairKey.split('::')
    const matchingOrders = orders.filter(
      (order) =>
        order.marketplaceProviderKey === marketplaceKey &&
        order.carrierProviderKey === carrierKey,
    )
    return {
      marketplaceProviderKey: marketplaceKey,
      marketplaceProviderName:
        matchingOrders[0]?.marketplaceProviderName || 'Bilinmeyen Pazaryeri',
      orderCount: matchingOrders.length,
      errorCount: matchingOrders.filter((order) => order.hasError).length,
      carrierProviderKey: carrierKey,
      carrierProviderName:
        matchingOrders[0]?.carrierProviderName || 'Bilinmeyen Kargo',
      shipmentCount: matchingOrders.filter((order) => order.trackingNumber).length,
      labelReadyCount: matchingOrders.filter(
        (order) =>
          (order.verifiedShipment || order.preassignedReady) &&
          Boolean(order.barcode) &&
          order.labelStatus === 'READY',
      ).length,
    }
  })
}

function dashboardStatus(
  order: CargoOrder,
  verifiedShipment: boolean,
  printableBarcode: string,
): string {
  const resolvedStatus = resolveOrderStatus(order)
  if (resolvedStatus.statusSource !== 'localOperation') {
    return resolvedStatus.label
  }
  if (order.labelStatus === 'PRINTED' && order.label?.printedAt) {
    return 'Etiket Basıldı'
  }
  if (verifiedShipment && printableBarcode && order.labelStatus === 'READY') {
    return 'Etiket Hazır'
  }
  if (order.operationStatus === 'ERROR') return 'Hata'
  if (!verifiedShipment) return 'Barkod Bekliyor'
  return order.status
}

function providerNames(
  orders: ReturnType<typeof normalizeOrder>[],
  type: 'marketplace' | 'carrier',
): string {
  const names = Array.from(
    new Set(
      orders.map((order) =>
        type === 'carrier'
          ? order.carrierProviderName
          : order.marketplaceProviderName,
      ),
    ),
  ).filter(Boolean)
  return names.length > 0
    ? `${names.join(', ')} sağlayıcı kayıtlarını kontrol edin.`
    : 'Kargo sağlayıcısı yanıtını kontrol edin.'
}

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  return String((value as Record<string, unknown>)[key] ?? '').trim()
}

function readBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  return Boolean((value as Record<string, unknown>)[key])
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
  if (record[key] != null) return Boolean(record[key])
  return Object.values(record).some((item) => findNestedBoolean(item, key))
}

function first(...values: Array<string | undefined>): string {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? ''
}

function isSameLocalDate(value: string, reference: Date): boolean {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  )
}

function isSameLocalMonth(value: string, reference: Date): boolean {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth()
  )
}

function isWithinPeriod(
  value: string,
  period: DashboardPeriod,
  reference: Date,
): boolean {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  if (period === 'all') return true
  if (period === 'today') return isSameLocalDate(value, reference)
  if (period === 'month') return isSameLocalMonth(value, reference)

  const start = new Date(reference)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - 6)
  return date.getTime() >= start.getTime() && date.getTime() <= reference.getTime()
}
