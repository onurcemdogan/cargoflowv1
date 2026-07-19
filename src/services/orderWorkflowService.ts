import type { LabelProvider } from '../providers/labels/LabelProvider'
import type { MarketplaceProvider } from '../providers/marketplace/MarketplaceProvider'
import type { PrintProvider, PrintResult } from '../providers/printing/PrintProvider'
import type { ShippingProvider } from '../providers/shipping/ShippingProvider'
import type {
  CargoOrder,
  CargoProduct,
  BulkActionDebug,
  IntegrationConfig,
  IntegrationTestResult,
  LabelTemplate,
  MarketplaceStatus,
  PrinterSettings,
  Shipment,
  SuratLabelMappingConfig,
  WorkflowResult,
} from '../types/cargoflow'
import {
  canCreateShipment,
  canDownloadZpl,
  canGenerateLabel,
  canMarkHandedToCargo,
  isLegacyPreRegistration,
  isOrderOperationallyActive,
  isSuratBarcodeFailed,
  migrateSuspiciousPrintedState,
  migrateUnconfirmedSerendipState,
  normalizeVerifiedOrtakBarkodState,
  operationStatusFromMarketplaceStatus,
  withDerivedOperationStatus,
} from '../utils/orderStatus'
import { loadFromStorage, saveToStorage } from '../utils/storage'
import { verifySuratShipment } from '../utils/suratVerification'
import {
  isPreassignedAwaitingAcceptance,
  resolveSuratPrintEligibility,
} from '../utils/suratPrintEligibility'
import { applyProductImageResolution } from '../utils/productImage'
import { mapSuratCarrierStatus } from '../utils/shipmentStatus'
import { buildDesiDebug, resolveNormalizedDesi } from '../utils/desi'
import { calculateOrderDesi } from '../utils/orderDesi'
import type { AuditLogService } from './auditLogService'
import { apiDebugService } from './apiDebugService'

const ORDERS_KEY = 'cargoFlow_orders_v3'
const PRODUCTS_KEY = 'cargoFlow_products_v3'
const ACTIVE_MARKETPLACE_ACCOUNT_KEY = 'cargoFlow_active_marketplace_account_v2'
const LEGACY_ACTIVE_MARKETPLACE_ACCOUNT_KEYS = [
  'cargoFlow_active_marketplace_account_v1',
]
const MAX_PERSISTED_ORDER_CACHE = 120

function normalizeCarrierIdentifier(value: unknown): string {
  return String(value ?? '').replace(/[^0-9A-Za-z]/g, '')
}

function normalizeMarketplaceAccountScope(
  value: string | number | undefined,
): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9_-]/g, '_')
}

function scopedStorageKey(baseKey: string, accountScope: string): string {
  return accountScope ? `${baseKey}:${accountScope}` : baseKey
}

function prepareMarketplaceAccountCaches(activeScope: string): void {
  if (
    typeof window === 'undefined' ||
    typeof window.localStorage?.key !== 'function'
  ) {
    return
  }
  const activeKeys = new Set([
    scopedStorageKey(ORDERS_KEY, activeScope),
    scopedStorageKey(PRODUCTS_KEY, activeScope),
  ])
  const previousScope =
    window.localStorage.getItem(ACTIVE_MARKETPLACE_ACCOUNT_KEY) ?? ''
  const marketplaceAccountChanged = previousScope !== activeScope
  const removableKeys: string[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (
      key &&
      (key === ORDERS_KEY ||
        key.startsWith(`${ORDERS_KEY}:`) ||
        key === PRODUCTS_KEY ||
        key.startsWith(`${PRODUCTS_KEY}:`)) &&
      (marketplaceAccountChanged || !activeKeys.has(key))
    ) {
      removableKeys.push(key)
    }
  }
  removableKeys.forEach((key) => window.localStorage.removeItem(key))
  LEGACY_ACTIVE_MARKETPLACE_ACCOUNT_KEYS.forEach((key) =>
    window.localStorage.removeItem(key),
  )
  window.localStorage.setItem(ACTIVE_MARKETPLACE_ACCOUNT_KEY, activeScope)
}

function buildPersistedOrderCache(orders: CargoOrder[]): CargoOrder[] {
  const byNewest = [...orders].sort((left, right) => {
    const leftTime = new Date(left.orderDate || left.createdAt || 0).getTime()
    const rightTime = new Date(right.orderDate || right.createdAt || 0).getTime()
    return (Number.isNaN(rightTime) ? 0 : rightTime) -
      (Number.isNaN(leftTime) ? 0 : leftTime)
  })
  const active = byNewest.filter((order) => isOrderOperationallyActive(order))
  const activeIds = new Set(active.map((order) => order.id))
  const recentClosed = byNewest
    .filter((order) => !activeIds.has(order.id))
    .slice(0, Math.max(0, MAX_PERSISTED_ORDER_CACHE - active.length))
  return [...active, ...recentClosed]
}

function selectedOrders(orders: CargoOrder[], selectedIds: string[]): CargoOrder[] {
  const selected = new Set(selectedIds)
  return orders.filter((order) => selected.has(order.id))
}

function replaceOrder(
  orders: CargoOrder[],
  updatedOrder: CargoOrder,
): CargoOrder[] {
  return orders.map((order) =>
    order.id === updatedOrder.id ? updatedOrder : order,
  )
}

function resolveShipmentForLabel(order: CargoOrder): Shipment | undefined {
  return order.shipment
}

function buildBulkActionDebug(
  actionType: string,
  orders: CargoOrder[],
  processedOrderNumbers: string[],
  failedOrderNumbers: string[],
  skippedOrderNumbers: string[],
  skippedReasons: string[] = [],
): BulkActionDebug {
  const verifications = orders.map((order) => ({
    order,
    verification: verifySuratShipment(order),
  }))
  const labelsWithBarcodeRaw = verifications.filter(
    ({ verification }) => Boolean(verification.barcodeRaw),
  ).length
  const printedCount = orders.filter(
    (order) => order.labelStatus === 'PRINTED',
  ).length

  return {
    actionType,
    selectedCount: orders.length,
    readyCount: verifications.filter(
      ({ verification }) =>
        verification.verifiedShipment && Boolean(verification.barcodeRaw),
    ).length,
    missingBarcodeCount: orders.length - labelsWithBarcodeRaw,
    printedCount,
    reprintCount: orders.filter(
      (order) => (order.label?.printCount ?? 0) > 1,
    ).length,
    errorCount: failedOrderNumbers.length,
    labelsWithBarcodeRaw,
    labelsWithoutBarcodeRaw: orders.length - labelsWithBarcodeRaw,
    processedOrderNumbers,
    failedOrderNumbers,
    skippedOrderNumbers,
    skippedReasons,
  }
}

export class OrderWorkflowService {
  private readonly marketplaceProvider: MarketplaceProvider
  private readonly shippingProvider: ShippingProvider
  private readonly labelProvider: LabelProvider
  private readonly printProvider: PrintProvider
  private readonly auditLogService: AuditLogService
  private marketplaceAccountScope = ''

  constructor(
    marketplaceProvider: MarketplaceProvider,
    shippingProvider: ShippingProvider,
    labelProvider: LabelProvider,
    printProvider: PrintProvider,
    auditLogService: AuditLogService,
  ) {
    this.marketplaceProvider = marketplaceProvider
    this.shippingProvider = shippingProvider
    this.labelProvider = labelProvider
    this.printProvider = printProvider
    this.auditLogService = auditLogService
  }

  setMarketplaceAccount(sellerId: string | number | undefined): boolean {
    const nextScope = normalizeMarketplaceAccountScope(sellerId)
    const changed = nextScope !== this.marketplaceAccountScope
    this.marketplaceAccountScope = nextScope
    if (changed && nextScope) {
      prepareMarketplaceAccountCaches(nextScope)
    }
    return changed
  }

  private ordersStorageKey(): string {
    return scopedStorageKey(ORDERS_KEY, this.marketplaceAccountScope)
  }

  private productsStorageKey(): string {
    return scopedStorageKey(PRODUCTS_KEY, this.marketplaceAccountScope)
  }

  // Operational state için SON savunma hattı: hangi akış yazarsa yazsın
  // (senkron merge, görsel zenginleştirme, bayat in-memory snapshot),
  // storage'daki mevcut shipment/etiket/desi izi, shipment'sız bir kopya
  // tarafından ASLA silinemez. Reconciled liste geri döner ki UI'ya giden
  // in-memory kopya da storage ile aynı operasyonel state'i taşısın.
  private persistOrders(orders: CargoOrder[]): CargoOrder[] {
    const storedOrders = loadFromStorage<CargoOrder[]>(
      this.ordersStorageKey(),
      [],
    )
    const reconciled = preserveOperationalStateFromStore(orders, storedOrders)
    saveToStorage(
      this.ordersStorageKey(),
      buildPersistedOrderCache(reconciled),
    )
    return reconciled
  }

  loadOrders(): CargoOrder[] {
    const orders = loadFromStorage<CargoOrder[]>(this.ordersStorageKey(), [])
    return enrichStoredOrders(orders)
  }

  enrichOrderImages(
    orders: CargoOrder[],
    products: CargoProduct[],
  ): CargoOrder[] {
    const enriched = enrichOrdersWithProductImages(orders, products)
    return this.persistOrders(enriched)
  }

  loadProducts(): CargoProduct[] {
    const products = loadFromStorage<CargoProduct[]>(this.productsStorageKey(), [])
    return enrichStoredProducts(products)
  }

  updateOrderDesi(
    orders: CargoOrder[],
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ): CargoOrder[] {
    const normalizedDesi =
      desi != null && Number.isFinite(desi) && desi > 0
        ? Math.round(desi * 100) / 100
        : null
    const nextOrders = orders.map((order) =>
      order.id === orderId
        ? {
            ...order,
            desi: normalizedDesi,
            desiSource: normalizedDesi == null ? null : desiSource,
            shipment: order.shipment
              ? {
                  ...order.shipment,
                  desi: normalizedDesi,
                  desiSource:
                    normalizedDesi == null ? null : desiSource,
                }
              : order.shipment,
          }
        : order,
    )
    this.persistOrders(nextOrders)
    return nextOrders
  }

  async testTrendyolConnection(
    config: IntegrationConfig,
  ): Promise<IntegrationTestResult> {
    const result = await this.marketplaceProvider.testConnection(config.trendyol)
    this.auditLogService.append({
      action: 'Bağlantı test edildi',
      level: result.ok ? 'success' : 'warning',
      details: `Trendyol: ${result.message}`,
    })
    return result
  }

  async testSuratConnection(
    config: IntegrationConfig,
  ): Promise<IntegrationTestResult> {
    const startedAt = performance.now()
    try {
      const response = await fetch('/api/integrations/surat/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: config.surat }),
      })
      const result = (await response.json()) as IntegrationTestResult
      apiDebugService.append({
        provider: 'Sürat',
        operation: 'Bağlantı Testi',
        endpoint: 'CariKoduveSifre',
        requestUrl: '/api/integrations/surat/test',
        requestBody: {
          CariKod: config.surat.kullaniciAdi,
          FirmaId: config.surat.firmaId,
          ortam: config.surat.ortam,
        },
        responseStatus: response.status,
        responseBody: result.rawPreview ?? result,
        status: result.ok ? 'SUCCESS' : 'ERROR',
        durationMs: Math.round(performance.now() - startedAt),
        fields: {
          CariKod: config.surat.kullaniciAdi,
          FirmaId: config.surat.firmaId,
        },
        errorMessage: result.ok ? undefined : result.message,
      })
      this.auditLogService.append({
        action: 'Bağlantı test edildi',
        level: result.ok ? 'success' : 'warning',
        details: `Sürat Kargo: ${result.message}`,
      })
      return result
    } catch (error) {
      apiDebugService.append({
        provider: 'Sürat',
        operation: 'Bağlantı Testi',
        endpoint: 'CariKoduveSifre',
        requestUrl: '/api/integrations/surat/test',
        responseStatus: 0,
        responseBody: error instanceof Error ? error.message : 'Ağ hatası',
        status: 'ERROR',
        durationMs: Math.round(performance.now() - startedAt),
        fields: {
          CariKod: config.surat.kullaniciAdi,
          FirmaId: config.surat.firmaId,
        },
        errorMessage: error instanceof Error ? error.message : 'Ağ hatası',
      })
      const result: IntegrationTestResult = {
        provider: 'surat-kargo',
        ok: false,
        source: 'real',
        message:
          error instanceof Error
            ? `API proxy erişilemedi. Sürat gerçek bağlantı testi yapılamadı: ${error.message}`
            : 'API proxy erişilemedi. Sürat gerçek bağlantı testi yapılamadı.',
        checkedAt: new Date().toISOString(),
      }
      this.auditLogService.append({
        action: 'Bağlantı test edildi',
        level: 'warning',
        details: `Sürat Kargo: ${result.message}`,
      })
      return result
    }
  }

  async fetchOrders(
    config: IntegrationConfig,
    options: {
      statuses?: MarketplaceStatus[]
      startDate?: Date
      endDate?: Date
    } = {},
  ): Promise<{ orders: CargoOrder[]; result: WorkflowResult }> {
    this.setMarketplaceAccount(config.trendyol.sellerId)
    const response = await this.marketplaceProvider.fetchOrders({
      credentials: config.trendyol,
      size: 200,
      statuses: options.statuses,
      startDate: options.startDate,
      endDate: options.endDate,
    })
    const syncBatchAt = new Date().toISOString()
    let nextOrders = mergeOrdersWithLocalState(
      response.orders.map((order) =>
        markOrderAsSeenInSyncBatch(withDerivedOperationStatus(order), syncBatchAt),
      ),
      this.loadOrders(),
    )
    if (response.debug) {
      console.log('Trendyol order normalization debug', response.debug)
    }
    // Reconciled liste hem storage'a hem UI'ya gider (desi/shipment izi
    // in-memory kopyada da korunur).
    nextOrders = this.persistOrders(nextOrders)
    this.auditLogService.append({
      action: 'Siparişler çekildi',
      level: 'success',
      details:
        nextOrders.length > 0
          ? `${response.orders.length} sipariş senkronize edildi; kalıcı operasyon listesinde ${nextOrders.length} sipariş var.`
          : 'Veri bulunamadı. Kaynak: Gerçek API.',
    })

    return {
      orders: nextOrders,
      result: {
        level: response.orders.length > 0 ? 'success' : 'warning',
        source: response.source,
        message: `${response.orders.length} sipariş/paket senkronize edildi. Kalıcı operasyon listesi: ${nextOrders.length}. ${response.message}`,
        debug: response.debug,
      },
    }
  }

  async fetchProducts(
    config: IntegrationConfig,
  ): Promise<{ products: CargoProduct[]; result: WorkflowResult }> {
    this.setMarketplaceAccount(config.trendyol.sellerId)
    const response = await this.marketplaceProvider.fetchProducts(config.trendyol)
    const nextProducts = mergeProductsWithCache(
      response.products,
      this.loadProducts(),
    )
    saveToStorage(this.productsStorageKey(), nextProducts)
    this.auditLogService.append({
      action: 'Ürünler çekildi',
      level: response.products.length > 0 ? 'success' : 'warning',
      details:
        nextProducts.length > 0
          ? `${nextProducts.length} ürün yüklendi. Kaynak: Gerçek API.`
          : 'Veri bulunamadı. Kaynak: Gerçek API.',
    })

    return {
      products: nextProducts,
      result: {
        level:
          response.products.length > 0 ? 'success' : 'warning',
        source: response.source,
        message: `${nextProducts.length} ürün yüklendi. ${response.message}`,
      },
    }
  }

  async createShipments(
    orders: CargoOrder[],
    selectedIds: string[],
    config: IntegrationConfig,
  ): Promise<{ orders: CargoOrder[]; result: WorkflowResult }> {
    if (selectedIds.length === 0) {
      return this.fail(orders, 'Gönderi oluşturmak için sipariş seçmelisin.')
    }

    let nextOrders = orders
    let successCount = 0
    let failedBarcodeCount = 0
    let skippedCount = 0
    const createdShipments: string[] = []
    const processedOrderNumbers: string[] = []
    const failedOrderNumbers: string[] = []
    const skippedOrderNumbers: string[] = []
    const skippedReasons: string[] = []

    // İkinci savunma katmanı: seçilen order geçici olarak shipment'sız
    // görünse bile storage'daki aynı paket kaydında operasyonel shipment
    // varsa yeni carrier create BAŞLATILMAZ (ana koruma persistOrders
    // reconcile'ıdır; bu katman bayat UI kopyalarına karşı emniyettir).
    const storedWithShipment = this.loadOrders().filter(
      (stored) => stored.shipment,
    )

    for (const order of selectedOrders(orders, selectedIds)) {
      if (!order.shipment) {
        const storedCounterpart = findMatchingOperationalOrder(
          order,
          storedWithShipment,
        )
        if (storedCounterpart?.shipment) {
          const reason =
            'Önceki gönderi kaydı inceleniyor; yeni gönderi oluşturulamaz.'
          skippedCount += 1
          skippedOrderNumbers.push(order.orderNumber)
          skippedReasons.push(`${order.orderNumber}: ${reason}`)
          this.auditLogService.append({
            action: 'Gönderi oluşturuldu',
            level: 'warning',
            details: `${reason} (paket ${order.packageId ?? order.shipmentPackageId ?? '-'} için kalıcı kayıt bulundu)`,
            orderNumber: order.orderNumber,
          })
          // Kalıcı kayıttaki shipment görünen listeye geri bağlanır.
          nextOrders = replaceOrder(nextOrders, {
            ...order,
            shipment: storedCounterpart.shipment,
            labelStatus: storedCounterpart.labelStatus,
            printEnabled: storedCounterpart.printEnabled,
            status:
              storedCounterpart.status && storedCounterpart.status !== 'Yeni'
                ? storedCounterpart.status
                : order.status,
            operationStatus:
              storedCounterpart.operationStatus ?? order.operationStatus,
          })
          continue
        }
      }
      if (!canCreateShipment(order)) {
        const reason = shipmentCreationBlockedReason(order)
        skippedCount += 1
        skippedOrderNumbers.push(order.orderNumber)
        skippedReasons.push(`${order.orderNumber}: ${reason}`)
        nextOrders = this.skipOrder(
          nextOrders,
          order,
          reason,
        )
        continue
      }

      if (
        order.shipment &&
        order.shipment.dispatchRegistrationConfirmed === true &&
        !isLegacyPreRegistration(order) &&
        !isSuratBarcodeFailed(order) &&
        verifySuratShipment(order).verifiedShipment &&
        Boolean(verifySuratShipment(order).barcodeRaw)
      ) {
        const reason =
          'Bu sipariş için doğrulanmış Sürat ortak barkodu zaten oluşturulmuş.'
        skippedCount += 1
        skippedOrderNumbers.push(order.orderNumber)
        skippedReasons.push(`${order.orderNumber}: ${reason}`)
        this.auditLogService.append({
          action: 'Gönderi oluşturuldu',
          level: 'warning',
          details: reason,
          orderNumber: order.orderNumber,
        })
        continue
      }

      // Desi tek sözleşmeden hesaplanır: manuel toplam koli desisi varsa o,
      // yoksa sum(adet × satır birim desisi). Eksik desi sessizce
      // varsayılmaz; tenant varsayılanı da yoksa create ENGELLENİR.
      const normalizedDesi = resolveNormalizedDesi(order)
      const desiCalc = calculateOrderDesi(
        order,
        this.loadProducts(),
        config.desi,
      )
      if (desiCalc.finalDesi == null) {
        const missingList = desiCalc.missingLines
          .map((line) => line.productName || line.sku || line.barcode)
          .filter(Boolean)
        const reason = `Gönderi oluşturulamadı: ${
          desiCalc.blockedReason ?? 'desi bilgisi eksik.'
        }${missingList.length > 0 ? ` Eksik ürünler: ${missingList.join(', ')}` : ''}`
        skippedCount += 1
        skippedOrderNumbers.push(order.orderNumber)
        skippedReasons.push(`${order.orderNumber}: ${reason}`)
        nextOrders = this.skipOrder(
          nextOrders,
          order,
          reason,
        )
        continue
      }
      const normalizedOrder: CargoOrder = {
        ...order,
        desi: desiCalc.finalDesi,
        desiSource: desiCalc.finalDesiSource,
        weightKg: normalizedDesi.weightKg,
        // Adet=1 sözleşmesi: sipariş tek koli; ürün adedi koli sayısı değildir.
        packageCount: desiCalc.parcelCount,
      }

      try {
        let shipment = await this.shippingProvider.createShipment({
          order: normalizedOrder,
          config,
        })
        const preassignedAwaiting = Boolean(
          shipment.printEnabled === true &&
            (shipment.lifecycleStatus === 'LABEL_READY_AWAITING_ACCEPTANCE' ||
              shipment.candidateVerificationStatus ===
                'PREASSIGNED_AWAITING_ACCEPTANCE'),
        )
        // Idempotency-blocked cevapta yeni create yapılmaz; mevcut hazır
        // etiketin ZPL'i ve create logu korunur.
        if (
          preassignedAwaiting &&
          !shipment.barcodeRaw &&
          order.shipment?.barcodeRaw
        ) {
          shipment = {
            ...shipment,
            barcodeRaw: order.shipment.barcodeRaw,
            zplSource: order.shipment.zplSource ?? shipment.zplSource,
            zplAnalysis: shipment.zplAnalysis ?? order.shipment.zplAnalysis,
            suratCreateLog:
              shipment.suratCreateLog ?? order.shipment.suratCreateLog,
            rawSuratCreateResponse:
              shipment.rawSuratCreateResponse ??
              order.shipment.rawSuratCreateResponse,
            technicalZplReceived: true,
          }
        }
        const verification = verifySuratShipment(normalizedOrder, shipment)
        const liveBarcodeReady =
          shipment.dispatchRegistrationConfirmed === true &&
          verification.verifiedShipment &&
          verification.operationalBarcodeVerified &&
          Boolean(verification.barcode)
        const technicalZplOnly =
          verification.technicalZplReceived && !liveBarcodeReady
        const trackingMissing =
          technicalZplOnly &&
          (!verification.tNo || !verification.finalSuratBarcode)
        const legacyPreRegistration =
          shipment.serviceMode === 'PRE_REGISTRATION_REST'
        const barcodeFailed =
          shipment.lifecycleStatus === 'SURAT_BARCODE_FAILED'
        const dispatchRejected =
          shipment.lifecycleStatus === 'SURAT_DISPATCH_REJECTED' ||
          shipment.errorCategory === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
        const createUncertain =
          shipment.lifecycleStatus === 'SURAT_CREATE_UNCERTAIN' ||
          shipment.errorCategory === 'SURAT_TRACKING_CONFIRMATION_MISSING'
        const labelCreatedNotRegistered =
          shipment.lifecycleStatus === 'LABEL_CREATED_NOT_REGISTERED' ||
          shipment.errorCategory === 'SURAT_LABEL_CREATED_NOT_REGISTERED'
        const createOperationStatus =
          liveBarcodeReady || preassignedAwaiting
            ? 'LABEL_READY'
            : labelCreatedNotRegistered
              ? 'LABEL_CREATED_NOT_REGISTERED'
            : createUncertain
              ? 'SURAT_TRACKING_MISSING'
            : dispatchRejected
              ? 'SURAT_DISPATCH_REJECTED'
            : barcodeFailed
              ? 'SURAT_BARCODE_FAILED'
            : trackingMissing
              ? 'SURAT_TRACKING_MISSING'
            : technicalZplOnly
              ? 'ZPL_NOT_OPERATIONALLY_VERIFIED'
            : shipment.lifecycleStatus === 'SURAT_CREATED_NO_TRACKING'
            ? 'SURAT_CREATED_NO_TRACKING'
            : 'SHIPMENT_CREATED'
        const labelReadyState = liveBarcodeReady || preassignedAwaiting
        const preassignedDiagnostic =
          'Etiket yazdırılabilir; Serendip kaydı fiziksel tesellümden sonra doğrulanacaktır.'
        const responseOrder: CargoOrder = {
          ...normalizedOrder,
          shipment: {
            ...shipment,
            verifiedShipment: verification.verifiedShipment,
            verificationStage: verification.verificationStage,
            technicalZplReceived: verification.technicalZplReceived,
            operationalBarcodeVerified:
              verification.operationalBarcodeVerified,
            finalSuratBarcode: verification.finalSuratBarcode,
            internalWebBarcode: verification.internalWebBarcode,
            zplAnalysis: verification.zplAnalysis,
            verificationMatchReason: verification.matchReason,
            trendyolCargoTrackingNumber: verification.trendyolCargoTrackingNumber,
            suratKargoTakipNo: verification.suratKargoTakipNo,
            extractedKargoTakipNo: verification.extractedKargoTakipNo,
            suratTakipUrl: verification.suratTakipUrl,
            labelStatus: liveBarcodeReady ? 'READY' : shipment.labelStatus,
            shipmentStatus: liveBarcodeReady
              ? 'VERIFIED'
              : dispatchRejected
                ? 'FAILED'
                : 'PENDING',
            suratVerificationStatus: liveBarcodeReady
              ? 'VERIFIED'
              : dispatchRejected
                ? 'FAILED'
                : 'PENDING',
            zplReady: verification.technicalZplReceived,
            printEnabled: labelReadyState,
            matchStatus: liveBarcodeReady,
            statusComputedFrom: liveBarcodeReady
              ? 'ORTAK_BARKOD_SUCCESS'
              : labelCreatedNotRegistered
                ? 'SURAT_LABEL_NOT_REGISTERED'
              : dispatchRejected
                ? 'SURAT_REJECTED'
              : 'SURAT_RESPONSE',
            previousStatus: order.operationStatus,
            newStatus: createOperationStatus,
            previousErrorCleared: labelReadyState
              ? Boolean(order.error || order.errorMessage)
              : false,
            tabBucket: labelReadyState
              ? 'ETIKET_BASILACAKLAR'
              : labelCreatedNotRegistered
                ? 'SORUNLU_GONDERILER'
              : createUncertain
                ? 'SORUNLU_GONDERILER'
              : dispatchRejected
                ? 'DURUM_UYGUN_DEGIL'
              : trackingMissing
                ? 'SORUNLU_GONDERILER'
                : 'BARKOD_BEKLEYENLER',
            zplSource: verification.zplSource,
            diagnosticMessage: liveBarcodeReady
              ? undefined
              : preassignedAwaiting
                ? preassignedDiagnostic
                : shipment.diagnosticMessage,
            noTrackingReason: labelReadyState
              ? undefined
              : shipment.noTrackingReason,
            labelBlockedReason: labelReadyState
              ? undefined
              : shipment.labelBlockedReason,
            zplDisabledReason: labelReadyState
              ? undefined
              : shipment.zplDisabledReason,
            desi: desiCalc.finalDesi,
            desiSource: desiCalc.finalDesiSource,
            weightKg: normalizedDesi.weightKg,
            packageCount: desiCalc.parcelCount,
            apiRequestDesi: desiCalc.finalDesi,
          },
          label: order.label,
          labelStatus: labelReadyState
            ? 'READY'
            : dispatchRejected
            ? 'BLOCKED'
            : createUncertain
            ? 'BLOCKED'
            : barcodeFailed
            ? 'BLOCKED'
            : technicalZplOnly
              ? 'BLOCKED'
              : order.labelStatus,
          status: labelReadyState
            ? 'Etiket Hazır'
            : dispatchRejected
            ? 'Hata'
            : createUncertain
            ? 'Hata'
            : barcodeFailed
            ? 'Hata'
            : trackingMissing
              ? 'Takip no/T.No Alınamadı'
            : legacyPreRegistration
              ? 'Ön Kayıt Yapıldı'
              : 'Kargo Oluşturuldu',
          operationStatus: createOperationStatus,
          errorMessage: labelReadyState
            ? undefined
            : dispatchRejected
            ? shipment.diagnosticMessage || verification.matchReason
            : createUncertain
            ? shipment.noTrackingReason ||
              shipment.diagnosticMessage ||
              'Sürat aday kodlar döndürdü ancak Serendip kaydı doğrulanamadı. Etiket basılamaz.'
            : barcodeFailed
            ? shipment.diagnosticMessage
            : trackingMissing
              ? 'SÃ¼rat teknik cevap dÃ¶ndÃ¼rdÃ¼ ancak takip no / T.No / operasyonel barkod dÃ¶nmedi. Bu nedenle gÃ¶nderi baÅŸarÄ±lÄ± sayÄ±lmadÄ± ve etiket basÄ±lamaz.'
            : technicalZplOnly
              ? verification.matchReason
              : undefined,
          error: labelReadyState ? undefined : order.error,
          noTrackingReason: labelReadyState
            ? undefined
            : shipment.noTrackingReason ?? order.noTrackingReason,
          labelBlockedReason: labelReadyState
            ? undefined
            : shipment.labelBlockedReason ?? order.labelBlockedReason,
          zplDisabledReason: labelReadyState
            ? undefined
            : shipment.zplDisabledReason ?? order.zplDisabledReason,
          shipmentStatus: liveBarcodeReady
            ? 'VERIFIED'
            : dispatchRejected
              ? 'FAILED'
              : 'PENDING',
          suratVerificationStatus: liveBarcodeReady
            ? 'VERIFIED'
            : dispatchRejected
              ? 'FAILED'
              : 'PENDING',
          zplReady: verification.technicalZplReceived,
          printEnabled: labelReadyState,
          matchStatus: liveBarcodeReady,
          matchReason: verification.matchReason || (liveBarcodeReady
            ? 'OrtakBarkodOlustur KargoTakipNo + Barcode doğrulandı'
            : 'Sürat gönderi kaydı ve barkod doğrulandı'),
        }
        const updatedOrder = liveBarcodeReady
          ? normalizeVerifiedOrtakBarkodState(responseOrder)
          : responseOrder
        nextOrders = replaceOrder(nextOrders, updatedOrder)
        processedOrderNumbers.push(order.orderNumber)
        if (barcodeFailed || dispatchRejected || createUncertain) {
          failedBarcodeCount += 1
          failedOrderNumbers.push(order.orderNumber)
        } else {
          successCount += 1
        }
        createdShipments.push(
          `${order.orderNumber}: ${
            shipment.diagnosticMessage ||
            `reference ${shipment.shipmentCode}, shipment ${shipment.id}`
          }`,
        )
        this.auditLogService.append({
          action: 'Gönderi oluşturuldu',
          level: liveBarcodeReady
            ? 'success'
            : legacyPreRegistration ||
                createUncertain ||
                barcodeFailed ||
                technicalZplOnly ||
                dispatchRejected
              ? 'warning'
              : 'success',
          details: preassignedAwaiting
            ? `Etiket hazır — fiziksel Sürat kabulü bekleniyor. T.No ${shipment.tNo || shipment.trackingNumber}, Barkod ${shipment.barkodNo || shipment.barcode}.`
            : dispatchRejected
            ? shipment.diagnosticMessage ||
              'Trendyol/Sürat paket statüsünü reddetti.'
            : createUncertain
            ? shipment.noTrackingReason ||
              'Sürat aday kodlar döndürdü ancak Serendip kaydı doğrulanamadı.'
            : barcodeFailed
            ? shipment.diagnosticMessage ||
              'OrtakBarkodOlustur KargoTakipNo/Barcode döndürmedi.'
            : technicalZplOnly
              ? `Teknik ZPL alındı ancak operasyonel barkod doğrulanamadı: ${verification.matchReason}`
            : shipment.trackingNumber
            ? liveBarcodeReady
              ? `Sürat etiketi hazır: Barkod ${verification.barcode}.`
              : `Sürat create response takip no içeriyor: ${shipment.trackingNumber}; canlı ZPL için Barcode bekleniyor.`
            : `Sürat kaydı oluşturuldu fakat takip/barkod no boş. ${shipment.diagnosticMessage || 'Takip sorgusu gerekli.'}`,
          orderNumber: order.orderNumber,
        })
        apiDebugService.append({
          provider: 'Sürat',
          operation: 'Desi Çözümleme',
          endpoint: config.surat.createShipmentPath,
          requestUrl: '/api/shipments/surat/create',
          responseStatus: 200,
          responseBody: {
            desiSource: desiCalc.finalDesiSource,
            finalNormalizedDesi: desiCalc.finalDesi,
            calculatedTotalDesi: desiCalc.calculatedTotalDesi,
            manualTotalDesi: desiCalc.manualTotalDesi,
            parcelCount: desiCalc.parcelCount,
            lineBreakdown: desiCalc.lines.map((line) => ({
              lineId: line.lineId,
              quantity: line.quantity,
              unitDesi: line.unitDesi,
              unitDesiSource: line.unitDesiSource,
              lineTotalDesi: line.lineTotalDesi,
              excludedReason: line.excludedReason,
            })),
          },
          status: 'SUCCESS',
          durationMs: 0,
          orderNumber: order.orderNumber,
          shipmentId: shipment.id,
          fields: {
            ...buildDesiDebug(
              normalizedOrder,
              {
                ...normalizedDesi,
                desi: desiCalc.finalDesi,
                desiSource: desiCalc.finalDesiSource,
                apiRequestDesi: desiCalc.finalDesi,
                apiResponseDesi:
                  shipment.apiResponseDesi ??
                  normalizedDesi.apiResponseDesi,
              },
            ),
          },
        })
      } catch (error) {
        failedBarcodeCount += 1
        failedOrderNumbers.push(order.orderNumber)
        const errorMessage = normalizeSuratCreateErrorMessage(error)
        nextOrders = replaceOrder(nextOrders, {
          ...order,
          status: 'Hata',
          operationStatus: 'ERROR',
          errorMessage,
        })
        this.auditLogService.append({
          action: 'Hata oluştu',
          level: 'error',
          details: `Sürat gönderisi oluşturulamadı: ${errorMessage}`,
          orderNumber: order.orderNumber,
        })
      }
    }

    this.persistOrders(nextOrders)

    return {
      orders: nextOrders,
      result: {
        level:
          failedBarcodeCount > 0
            ? 'warning'
            : successCount > 0
              ? 'success'
              : 'warning',
        message:
          failedBarcodeCount > 0
            ? `${failedBarcodeCount} siparişte Sürat gönderisi oluşturuldu gibi döndü ancak geçerli takip/barkod kodu alınamadı. Etiket basılamaz.`
            : buildShipmentCreationResultMessage({
                successCount,
                skippedCount,
                skippedReasons,
                createdShipments,
              }),
        bulkActionDebug: buildBulkActionDebug(
          'CREATE_COMMON_BARCODE',
          selectedOrders(nextOrders, selectedIds),
          processedOrderNumbers,
          failedOrderNumbers,
          skippedOrderNumbers,
          skippedReasons,
        ),
      },
    }
  }

  async generateLabels(
    orders: CargoOrder[],
    selectedIds: string[],
    template: LabelTemplate,
    mappingConfig: SuratLabelMappingConfig = {},
  ): Promise<{ orders: CargoOrder[]; result: WorkflowResult }> {
    if (selectedIds.length === 0) {
      return this.fail(orders, 'Barkod oluşturmak için sipariş seçmelisin.')
    }

    let nextOrders = orders
    let successCount = 0

    for (const order of selectedOrders(orders, selectedIds)) {
      if (!canGenerateLabel(order)) {
        nextOrders = this.skipOrder(
          nextOrders,
          order,
          'Canlı ZPL için serviceMode=ORTAK_BARKOD_SOAP ve doğrulanmış KargoTakipNo + Barcode gerekir.',
        )
        continue
      }

      const shipment = resolveShipmentForLabel(order)
      const verification = verifySuratShipment(order, shipment)
      if (!shipment || !verification.verifiedShipment) {
        nextOrders = this.skipOrder(
          nextOrders,
          order,
          'Etiket için OrtakBarkodOlustur response KargoTakipNo + Barcode dönmüş ve referans eşleşmiş olmalı.',
        )
        continue
      }

      const label = await this.labelProvider.generateSingle({
        order,
        shipment,
        template,
        mappingConfig,
      })
      apiDebugService.append({
        provider: 'Sürat',
        operation: 'Etiket Desi Çözümleme',
        endpoint: '/local/zpl/generate',
        requestUrl: '/local/zpl/generate',
        responseStatus: 200,
        responseBody: label.desiDebug,
        status: 'SUCCESS',
        durationMs: 0,
        orderNumber: order.orderNumber,
        shipmentId: shipment.id,
        fields: label.desiDebug ? { ...label.desiDebug } : undefined,
      })
      nextOrders = replaceOrder(nextOrders, {
        ...order,
        shipment: {
          ...(order.shipment ?? shipment),
          labelStatus: 'GENERATED',
        },
        label,
        labelStatus: 'GENERATED',
        status: 'Etiket Hazır',
        operationStatus: 'LABEL_READY',
        errorMessage: undefined,
      })
      successCount += 1
      this.auditLogService.append({
        action: 'Etiket oluşturuldu',
        level: 'success',
        details:
          `${label.desi?.toFixed(2)} desi ile 10x10 ZPL üretildi: ${label.barcodeValue}${
            label.desiMismatchWarning
              ? ` · ${label.desiMismatchWarning}`
              : ''
          }`,
        orderNumber: order.orderNumber,
      })
    }

    this.persistOrders(nextOrders)

    return {
      orders: nextOrders,
      result: {
        level: successCount > 0 ? 'success' : 'warning',
        message:
          successCount > 0
            ? `${successCount} sipariş için 10x10 ZPL barkod etiketi oluşturuldu.`
            : 'Etiket oluşturulamadı. Seçili siparişlerde gönderi yok.',
      },
    }
  }

  async prepareZplDownload(
    orders: CargoOrder[],
    selectedIds: string[],
    _config: IntegrationConfig,
    printerSettings: PrinterSettings,
    template: LabelTemplate,
    mappingConfig: SuratLabelMappingConfig = {},
  ): Promise<{
    orders: CargoOrder[]
    result: WorkflowResult
    printResult?: PrintResult
  }> {
    if (selectedIds.length === 0) {
      return {
        ...(await this.fail(
          orders,
          'ZPL indirmek için en az bir sipariş seçmelisin.',
        )),
        printResult: undefined,
      }
    }

    const selectedDownloadOrders = selectedOrders(orders, selectedIds)
    const blockedOrders = selectedDownloadOrders.filter((order) => !canDownloadZpl(order))

    for (const order of blockedOrders) {
      this.auditLogService.append({
        action: 'Hata oluştu',
        level: 'warning',
        details:
          'Canlı ZPL indirmek için doğrulanmış Ortak Barkod ve BarcodeRaw gerekir.',
        orderNumber: order.orderNumber,
      })
    }

    const printableOrders: CargoOrder[] = []
    const desiMismatchOrders: string[] = []
    for (const order of selectedDownloadOrders.filter(canDownloadZpl)) {
      const shipment = resolveShipmentForLabel(order)
      if (!shipment) continue
      const verification = verifySuratShipment(order, shipment)
      if (
        verification.technicalZplReceived &&
        !verification.operationalBarcodeVerified &&
        verification.barcodeRaw
      ) {
        printableOrders.push({
          ...order,
          label: {
            id: `technical-zpl-${order.id}`,
            labelType: 'zpl',
            barcodeFormat: 'Code128',
            barcodeValue:
              verification.internalWebBarcode ||
              verification.finalSuratBarcode ||
              '',
            templateId: template.id,
            zplContent: verification.barcodeRaw,
            zplSource: 'surat.ortakBarkod.BarcodeRaw',
            createdAt: new Date().toISOString(),
          },
        })
        continue
      }
      const label = await this.labelProvider.generateSingle({
        order,
        shipment,
        template,
        mappingConfig,
      })
      if (label.desiMismatchWarning) {
        desiMismatchOrders.push(order.orderNumber)
      }
      printableOrders.push({ ...order, label })
    }

    if (printableOrders.length === 0) {
      return {
        orders,
        result: {
          level: 'error',
          message: 'ZPL indirilecek etiket bulunamadı.',
        },
        printResult: undefined,
      }
    }

    const printResult = await this.printProvider.print({
      orders: printableOrders,
      printerSettings,
      action: 'download',
    })

    for (const order of printableOrders) {
      this.auditLogService.append({
        action: 'ZPL indirildi',
        level: 'success',
        details: `${printResult.fileName} indirildi. Etiket baskı durumu değiştirilmedi.`,
        orderNumber: order.orderNumber,
      })
    }

    return {
      orders,
      result: {
        level: desiMismatchOrders.length > 0 ? 'warning' : 'success',
        message: `${printableOrders.length} etiket için tek ZPL dosyası hazır.${
          blockedOrders.length > 0
            ? ` ${blockedOrders.length} etiket BarcodeRaw eksik olduğu için dahil edilmedi.`
            : ''
        }${
          desiMismatchOrders.length > 0
            ? ` ${desiMismatchOrders.join(', ')} için API’den dönen etiket desisi CargoFlow önizlemesinden farklıydı; indirilen ZPL normalize edilen desiyle üretildi.`
            : ''
        }`,
        bulkActionDebug: buildBulkActionDebug(
          'DOWNLOAD_ZPL',
          selectedDownloadOrders,
          printableOrders.map((order) => order.orderNumber),
          [],
          blockedOrders.map((order) => order.orderNumber),
        ),
      },
      printResult,
    }
  }

  async printLabels(
    orders: CargoOrder[],
    selectedIds: string[],
    printerSettings: PrinterSettings,
    template: LabelTemplate,
    mappingConfig: SuratLabelMappingConfig = {},
    options: {
      confirmedAt: string
      printedBy?: string
      includePreviouslyPrinted?: boolean
    },
  ): Promise<{
    orders: CargoOrder[]
    result: WorkflowResult
    printResult?: PrintResult
  }> {
    const requestedAt = new Date().toISOString()
    const printedBy = options.printedBy || 'local user'
    const selected = selectedOrders(orders, selectedIds)
    const skippedWithReasons: Array<{ orderNumber: string; reason: string }> =
      []
    const candidates = selected.filter((order) => {
      const eligibility = resolveSuratPrintEligibility(order)
      const alreadyPrinted =
        order.labelStatus === 'PRINTED' && Boolean(order.label?.printedAt)
      if (!eligibility.canPrint) {
        skippedWithReasons.push({
          orderNumber: order.orderNumber,
          reason: eligibility.reason,
        })
        return false
      }
      if (alreadyPrinted && !options.includePreviouslyPrinted) {
        skippedWithReasons.push({
          orderNumber: order.orderNumber,
          reason: 'Daha önce basılmış; tekrar baskı onayı verilmedi.',
        })
        return false
      }
      return true
    })
    const skippedSummary =
      skippedWithReasons.length > 0
        ? ` ${skippedWithReasons.length} sipariş atlandı: ${skippedWithReasons
            .map((item) => `${item.orderNumber} (${item.reason})`)
            .join('; ')}`
        : ''

    if (candidates.length === 0) {
      return {
        orders,
        result: {
          level: 'warning',
          message: `Yazdırılabilir etiket bulunamadı.${
            skippedSummary ||
            ' Önce Sürat gönderisi oluşturulmalı veya etiket hazır olmalı.'
          }`,
          bulkActionDebug: buildBulkActionDebug(
            'PRINT_LABELS',
            selected,
            [],
            [],
            selected.map((order) => order.orderNumber),
          ),
        },
      }
    }

    const printableOrders: CargoOrder[] = []
    for (const order of candidates) {
      const shipment = resolveShipmentForLabel(order)
      if (!shipment) continue
      const label = await this.labelProvider.generateSingle({
        order,
        shipment,
        template,
        mappingConfig,
      })
      printableOrders.push({
        ...order,
        label: {
          ...label,
          printedAt: order.label?.printedAt,
          printedBy: order.label?.printedBy,
          lastPrintedAt: order.label?.lastPrintedAt,
          lastPrintedBy: order.label?.lastPrintedBy,
          printJobId: order.label?.printJobId,
          lastPrintJobId: order.label?.lastPrintJobId,
          printSource: order.label?.printSource,
          printCount: order.label?.printCount,
          printHistory: order.label?.printHistory,
          printDebug: order.label?.printDebug,
        },
      })
    }

    const printResult = await this.printProvider.print({
      orders: printableOrders,
      printerSettings,
      action: 'print',
      requestedAt,
      confirmedAt: options.confirmedAt,
      labelTemplate: template,
      mappingConfig,
    })

    const successfulOrderNumbers = new Set(
      printResult.jobs?.filter((job) => job.ok).map((job) => job.orderNumber) ??
        (printResult.ok
          ? printableOrders.map((order) => order.orderNumber)
          : []),
    )
    const failedPrintableOrders = printableOrders.filter(
      (order) => !successfulOrderNumbers.has(order.orderNumber),
    )
    const successfulPrintableOrders = printableOrders.filter((order) =>
      successfulOrderNumbers.has(order.orderNumber),
    )

    if (failedPrintableOrders.length > 0) {
      for (const order of failedPrintableOrders) {
        const verification = verifySuratShipment(order)
        const failedJob = printResult.jobs?.find(
          (job) => job.orderNumber === order.orderNumber,
        )
        apiDebugService.append({
          provider: 'Sürat',
          operation: 'Zebra Yazdır',
          endpoint: '/api/printing/zebra/raw',
          requestUrl: '/api/printing/zebra/raw',
          responseStatus: 0,
          responseBody: printResult,
          status: 'ERROR',
          durationMs: 0,
          orderNumber: order.orderNumber,
          fields: {
            printRequestedAt: requestedAt,
            printConfirmedAt: options.confirmedAt,
            printProvider: printResult.provider,
            printerName: printResult.printerName,
            printResult,
            browserPrintDebug: printResult.browserPrintDebug,
            printError:
              failedJob?.errorMessage || printResult.errorMessage,
            zplSource: order.label?.zplSource ?? 'generated',
            zplLength: verification.barcodeRaw.length,
            labelStatusBefore: order.labelStatus,
            labelStatusAfter: order.labelStatus,
            isReprint: order.labelStatus === 'PRINTED',
            printCountBefore: order.label?.printCount ?? 0,
            printCountAfter: order.label?.printCount ?? 0,
            orderNumber: order.orderNumber,
            KargoTakipNo: verification.kargoTakipNo,
            Barcode: verification.barcode,
          },
          errorMessage:
            failedJob?.errorMessage ||
            printResult.errorMessage ||
            'Etiket Zebra yazıcıya gönderilemedi.',
          errorSource: 'Frontend',
        })
      }
      if (successfulPrintableOrders.length === 0) {
        return {
          orders,
          result: {
            level: 'error',
            message: `Etiket Zebra yazıcıya gönderilemedi. Etiket durumu değiştirilmedi. ${
              printResult.errorMessage ?? ''
            }`.trim(),
            bulkActionDebug: buildBulkActionDebug(
              'PRINT_LABELS',
              selected,
              [],
              failedPrintableOrders.map((order) => order.orderNumber),
              selected
                .filter(
                  (order) =>
                    !printableOrders.some(
                      (printable) => printable.id === order.id,
                    ),
                )
                .map((order) => order.orderNumber),
            ),
          },
          printResult,
        }
      }
    }

    const completedAt = new Date().toISOString()
    let nextOrders = orders
    for (const printableOrder of successfulPrintableOrders) {
      const currentOrder =
        nextOrders.find((order) => order.id === printableOrder.id) ??
        printableOrder
      const isReprint =
        currentOrder.labelStatus === 'PRINTED' &&
        Boolean(currentOrder.label?.printedAt)
      const countBefore = currentOrder.label?.printCount ?? 0
      const printCount = countBefore + 1
      const job =
        printResult.jobs?.find(
          (item) => item.orderNumber === currentOrder.orderNumber,
        ) ?? printResult.jobs?.[0]
      const printJobId = job?.printJobId ?? printResult.printJobId
      const history = [
        ...(currentOrder.label?.printHistory ?? []),
        {
          type: isReprint ? ('REPRINT' as const) : ('PRINT' as const),
          printedAt: completedAt,
          printedBy,
          printJobId,
          printerName: printerSettings.printerName,
          zplSource: printableOrder.label?.zplSource ?? 'generated',
          reason: isReprint
            ? 'User confirmed reprint'
            : 'User confirmed print',
        },
      ]
      const firstPrintedAt =
        currentOrder.label?.printedAt || completedAt
      const firstPrintedBy =
        currentOrder.label?.printedBy || printedBy
      const label = {
        ...printableOrder.label!,
        printedAt: firstPrintedAt,
        printedBy: firstPrintedBy,
        lastPrintedAt: completedAt,
        lastPrintedBy: printedBy,
        printJobId: currentOrder.label?.printJobId || printJobId,
        lastPrintJobId: printJobId,
        printSource: printableOrder.label?.zplSource ?? 'generated',
        printCount,
        printHistory: history,
        printDebug: {
          printRequestedAt: requestedAt,
          printConfirmedAt: options.confirmedAt,
          printProvider: printResult.provider,
          printerName: printerSettings.printerName,
          printJobId,
          printResult,
          browserPrintDebug: printResult.browserPrintDebug,
          zplSource: printableOrder.label?.zplSource ?? 'generated',
          zplLength: printableOrder.label!.zplContent.length,
          labelStatusBefore: currentOrder.labelStatus,
          labelStatusAfter: 'PRINTED' as const,
          isReprint,
          printCountBefore: countBefore,
          printCountAfter: printCount,
          printedAt: firstPrintedAt,
          lastPrintedAt: completedAt,
          printHistory: history,
        },
      }
      nextOrders = replaceOrder(nextOrders, {
        ...currentOrder,
        status: 'Etiket Basıldı',
        operationStatus: 'LABEL_PRINTED',
        labelStatus: 'PRINTED',
        shipment: currentOrder.shipment
          ? { ...currentOrder.shipment, labelStatus: 'PRINTED' }
          : currentOrder.shipment,
        label,
        errorMessage: undefined,
      })
      apiDebugService.append({
        provider: 'Sürat',
        operation: isReprint ? 'Zebra Tekrar Yazdır' : 'Zebra Yazdır',
        endpoint: '/api/printing/zebra/raw',
        requestUrl: '/api/printing/zebra/raw',
        responseStatus: 200,
        responseBody: printResult,
        status: 'SUCCESS',
        durationMs: 0,
        orderNumber: currentOrder.orderNumber,
        shipmentId: currentOrder.shipment?.id,
        fields: label.printDebug,
      })
      this.auditLogService.append({
        action: 'Etiket basıldı',
        level: 'success',
        details: isReprint
          ? `Etiket tekrar basıldı. Toplam baskı: ${printCount}.`
          : 'Etiket Zebra yazıcıya başarıyla gönderildi.',
        orderNumber: currentOrder.orderNumber,
      })
    }
    this.persistOrders(nextOrders)
    return {
      orders: nextOrders,
      result: {
        level:
          failedPrintableOrders.length > 0 || skippedWithReasons.length > 0
            ? 'warning'
            : 'success',
        message: `${
          failedPrintableOrders.length > 0
            ? `${successfulPrintableOrders.length} etiket yazdırıldı, ${failedPrintableOrders.length} etiket gönderilemedi. Başarısız etiketlerin durumu değiştirilmedi.`
            : successfulPrintableOrders.some(
                  (order) => order.labelStatus === 'PRINTED',
                )
              ? `${successfulPrintableOrders.length} etiket tekrar basıldı.`
              : `${successfulPrintableOrders.length} etiket yazdırıldı.`
        }${skippedSummary}`,
        bulkActionDebug: buildBulkActionDebug(
          'PRINT_LABELS',
          selected,
          successfulPrintableOrders.map((order) => order.orderNumber),
          failedPrintableOrders.map((order) => order.orderNumber),
          selected
            .filter(
              (order) =>
                !printableOrders.some(
                  (printable) => printable.id === order.id,
                ),
            )
            .map((order) => order.orderNumber),
        ),
      },
      printResult,
    }
  }

  async trackShipments(
    orders: CargoOrder[],
    selectedIds: string[],
    config: IntegrationConfig,
  ): Promise<{ orders: CargoOrder[]; result: WorkflowResult }> {
    if (selectedIds.length === 0) {
      return this.fail(orders, 'Takip sorgusu için sipariş seçmelisin.')
    }

    let nextOrders = orders
    let successCount = 0
    let verifiedCount = 0

    for (const order of selectedOrders(orders, selectedIds)) {
      const shipment = resolveShipmentForLabel(order)
      if (!shipment) {
        nextOrders = this.markError(
          nextOrders,
          order,
          'Takip sorgusu için önce Sürat gönderisi oluşturulmalı.',
        )
        continue
      }

      try {
        const { data } = await this.shippingProvider.trackShipment({
          order,
          shipment,
          config,
        })

        const trackingCandidates = [
          {
            value: data.tracking?.KargoTakipNo || data.suratTrackingLog?.KargoTakipNo,
            source: 'surat.tracking.KargoTakipNo',
          },
          {
            value:
              data.tracking?.extractedKargoTakipNo ||
              data.tracking?.TakipUrlTrackingNo ||
              data.suratTrackingLog?.extractedKargoTakipNo ||
              data.suratTrackingLog?.TakipUrlTrackingNo,
            source:
              data.tracking?.TakipUrlTrackingSource ||
              data.suratTrackingLog?.TakipUrlTrackingSource ||
              'surat.track.TakipUrl.query.kargotakipno',
          },
          {
            value: data.tracking?.TakipNo || data.suratTrackingLog?.TakipNo,
            source: 'surat.tracking.TakipNo',
          },
          {
            value: data.tracking?.TNo || data.suratTrackingLog?.TNo,
            source: 'surat.tracking.TNo',
          },
        ]
        const officialTrackingSelection = trackingCandidates.find((candidate) =>
          String(candidate.value ?? '').trim(),
        )
        const officialTrackingNumber = String(
          officialTrackingSelection?.value ?? '',
        ).trim()
        const trackingBarcode = String(
          data.tracking?.BarkodNo ||
            data.suratTrackingLog?.BarkodNo ||
            data.tracking?.Barkod ||
            data.suratTrackingLog?.Barkod ||
            '',
        ).trim()
        const updatedShipment: Shipment = {
          ...shipment,
          trackingNumber: officialTrackingNumber || shipment.trackingNumber,
          kargoTakipNo:
            officialTrackingNumber ||
            shipment.kargoTakipNo ||
            shipment.trackingNumber,
          barcode: trackingBarcode || shipment.barcode,
          trackingUrl:
            data.tracking?.TakipUrl ||
            data.suratTrackingLog?.TakipUrl ||
            shipment.trackingUrl ||
            (officialTrackingNumber
              ? `https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=${officialTrackingNumber}`
              : ''),
          barcodeValue:
            trackingBarcode ||
            shipment.barcode ||
            officialTrackingNumber ||
            shipment.barcodeValue,
          barcodeSource: trackingBarcode
            ? 'surat.tracking.Barkod'
            : shipment.barcodeSource ||
              officialTrackingSelection?.source,
          rawResponse: {
            shipment: shipment.rawResponse,
            tracking: data.tracking ?? data.rawResponse,
            suratTrackingLog: data.suratTrackingLog,
          },
          suratCreateLog: shipment.suratCreateLog,
          suratTrackingLog: data.suratTrackingLog
            ? {
                ...data.suratTrackingLog,
                trackingAttempts: data.trackingAttempts,
              }
            : data.suratTrackingLog,
          rawSuratTrackingResponse:
            data.suratTrackingLog?.rawResponse ?? data.rawResponse,
        }
        const gonderilerCount = Number(
          data.gonderilerLength ??
            data.suratTrackingLog?.gonderilerLength ??
            data.suratTrackingLog?.Gonderiler?.length ??
            0,
        )
        const labelCreatedNotRegistered =
          data.verificationPersistence?.verificationStatus ===
          'LABEL_CREATED_NOT_REGISTERED'
        const carrierStatus =
          gonderilerCount > 0
            ? mapSuratCarrierStatus(
                data.suratTrackingLog?.KargonunDurumuSayi,
              )
            : undefined
        if (carrierStatus) {
          updatedShipment.carrierStatusKey = carrierStatus.key
          updatedShipment.carrierStatusLabel = carrierStatus.label
          updatedShipment.carrierStatusSource = 'suratTracking'
          updatedShipment.carrierStatusCode = String(
            data.suratTrackingLog?.KargonunDurumuSayi ?? '',
          )
          updatedShipment.carrierStatusUpdatedAt =
            data.suratTrackingLog?.createdAt ?? new Date().toISOString()
          updatedShipment.statusSource = 'suratTracking'
          if (carrierStatus.delivered) {
            updatedShipment.deliveredAt =
              data.suratTrackingLog?.SonHareketTarihi || undefined
          } else if (carrierStatus.shipped) {
            updatedShipment.shippedAt =
              data.suratTrackingLog?.SonHareketTarihi || undefined
          }
        }
        const expectedTrackingNumber = String(
          shipment.tNo ||
            shipment.kargoTakipNo ||
            shipment.codeMapping?.tNoValue ||
            shipment.zplAnalysis?.acceptedTNo ||
            '',
        ).trim()
        const expectedBarcodeNumber = String(
          shipment.barkodNo ||
            shipment.barcode ||
            shipment.codeMapping?.barcodeValue ||
            shipment.zplAnalysis?.acceptedFinalBarcode ||
            '',
        ).trim()
        const trackingNumberMatches = Boolean(
          expectedTrackingNumber &&
            officialTrackingNumber &&
            normalizeCarrierIdentifier(expectedTrackingNumber) ===
              normalizeCarrierIdentifier(officialTrackingNumber),
        )
        const barcodeNumberMatches = Boolean(
          expectedBarcodeNumber &&
            trackingBarcode &&
            normalizeCarrierIdentifier(expectedBarcodeNumber) ===
              normalizeCarrierIdentifier(trackingBarcode),
        )
        updatedShipment.serdendipVerified = Boolean(
          gonderilerCount > 0 &&
            trackingNumberMatches &&
            barcodeNumberMatches,
        )
        const baseVerification = verifySuratShipment(order, updatedShipment)
        const verification = updatedShipment.serdendipVerified
          ? baseVerification
          : {
              ...baseVerification,
              verifiedShipment: false,
              matchReason:
                gonderilerCount === 0
                  ? 'Serendip henüz gönderi kaydı döndürmedi.'
                  : !trackingNumberMatches
                    ? 'Serendip KargoTakipNo ile ZPL T.No eşleşmedi.'
                    : 'Serendip BarkodNo ile ZPL ana barkodu eşleşmedi.',
            }
        const transferredButNoBarcode =
          data.trackingState === 'SURAT_TRANSFERRED_BUT_NO_BARCODE' ||
          data.suratTrackingLog?.trackingState ===
            'SURAT_TRANSFERRED_BUT_NO_BARCODE'
        updatedShipment.lifecycleStatus =
          labelCreatedNotRegistered
            ? 'LABEL_CREATED_NOT_REGISTERED'
            : gonderilerCount === 0
            ? transferredButNoBarcode
              ? 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
              : shipment.lifecycleStatus
            : verification.verifiedShipment
              ? 'TRACKING_CONFIRMED'
              : transferredButNoBarcode
                ? 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
                : 'SHIPMENT_CREATED'
        updatedShipment.diagnosticMessage = verification.verifiedShipment
          ? undefined
          : labelCreatedNotRegistered
            ? 'Etiket oluşturuldu ancak doğru WebSiparisKodu ile Serendip gönderi kaydı açılmadı.'
          : transferredButNoBarcode
            ? 'Sürat gönderi verisini aldı; kargo kabulü bekleniyor. Serendip hareket kaydı oluşana kadar doğrulama beklemede kalır.'
            : verification.matchReason
        if (verification.verifiedShipment) verifiedCount += 1
        const nextOperationStatus =
          labelCreatedNotRegistered
            ? 'LABEL_CREATED_NOT_REGISTERED'
            : gonderilerCount === 0
            ? transferredButNoBarcode &&
              ![
                'LABEL_PRINTED',
                'SHIPPED',
                'HANDED_TO_CARGO',
                'DELIVERED',
                'RETURNING',
                'DELIVERED_SPECIAL',
              ].includes(order.operationStatus)
              ? 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
              : order.operationStatus
            : carrierStatus?.operationStatus ??
              (verification.verifiedShipment
                ? 'TRACKING_CONFIRMED'
                : transferredButNoBarcode
                  ? 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
                  : 'SHIPMENT_CREATED')
        nextOrders = replaceOrder(nextOrders, {
          ...order,
          status:
            nextOperationStatus === 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
              ? 'Takip no/T.No Alınamadı'
              : order.status,
          shipment: {
            ...updatedShipment,
            candidateVerificationStatus: labelCreatedNotRegistered
              ? 'LABEL_CREATED_NOT_REGISTERED'
              : updatedShipment.candidateVerificationStatus,
            verificationStage: labelCreatedNotRegistered
              ? 'label_created_not_registered'
              : updatedShipment.verificationStage,
            errorCategory: labelCreatedNotRegistered
              ? 'SURAT_LABEL_CREATED_NOT_REGISTERED'
              : updatedShipment.errorCategory,
            printEnabled: labelCreatedNotRegistered
              ? false
              : updatedShipment.printEnabled,
            verifiedShipment: verification.verifiedShipment,
            verificationMatchReason: verification.matchReason,
            trendyolCargoTrackingNumber: verification.trendyolCargoTrackingNumber,
            suratKargoTakipNo: verification.suratKargoTakipNo,
            extractedKargoTakipNo: verification.extractedKargoTakipNo,
            suratTakipUrl: verification.suratTakipUrl,
          },
          operationStatus: nextOperationStatus,
          errorMessage: verification.verifiedShipment
            ? undefined
            : updatedShipment.diagnosticMessage,
        })
        successCount += 1
        this.auditLogService.append({
          action: 'Takip sorgulandı',
          level: verification.verifiedShipment ? 'success' : 'warning',
          details: verification.verifiedShipment
            ? `Sürat takip sorgusu doğrulandı: ${officialTrackingNumber}`
            : updatedShipment.diagnosticMessage || verification.matchReason,
          orderNumber: order.orderNumber,
        })
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Bilinmeyen takip hatası'
        nextOrders = replaceOrder(nextOrders, {
          ...order,
          status: 'Hata',
          operationStatus: 'ERROR',
          errorMessage,
        })
        this.auditLogService.append({
          action: 'Hata oluştu',
          level: 'error',
          details: `Sürat takip sorgusu başarısız: ${errorMessage}`,
          orderNumber: order.orderNumber,
        })
      }
    }

    this.persistOrders(nextOrders)

    return {
      orders: nextOrders,
      result: {
        level:
          successCount > 0 && verifiedCount === successCount
            ? 'success'
            : 'warning',
        message: `${successCount} gönderi için Sürat takip sorgusu yapıldı. ${verifiedCount} gönderi doğrulandı.`,
      },
    }
  }

  markSelectedPrinted(
    orders: CargoOrder[],
    selectedIds: string[],
  ): { orders: CargoOrder[]; result: WorkflowResult } {
    void selectedIds
    return {
      orders,
      result: {
        level: 'warning',
        message:
          'Etiket durumu manuel değiştirilemez. Yazdırma onayı ve başarılı Zebra sonucu gereklidir.',
      },
    }
  }

  markSelectedHandedToCargo(
    orders: CargoOrder[],
    selectedIds: string[],
  ): { orders: CargoOrder[]; result: WorkflowResult } {
    if (selectedIds.length === 0) {
      return this.fail(orders, 'Kargoya verildi yapmak için sipariş seçmelisin.')
    }

    let nextOrders = orders
    let successCount = 0

    for (const order of selectedOrders(orders, selectedIds)) {
      if (!canMarkHandedToCargo(order)) {
        nextOrders = this.skipOrder(
          nextOrders,
          order,
          'Bu sipariş kargoya verildi yapmak için uygun değil.',
        )
        continue
      }

      nextOrders = replaceOrder(nextOrders, {
        ...order,
        operationStatus: 'HANDED_TO_CARGO',
      })
      successCount += 1
      this.auditLogService.append({
        action: 'Kargoya verildi',
        level: 'success',
        details: 'Sipariş manuel olarak kargoya verildi işaretlendi.',
        orderNumber: order.orderNumber,
      })
    }

    this.persistOrders(nextOrders)

    return {
      orders: nextOrders,
      result: {
        level: successCount > 0 ? 'success' : 'warning',
        message: `${successCount} sipariş kargoya verildi yapıldı.`,
      },
    }
  }

  private markError(
    orders: CargoOrder[],
    order: CargoOrder,
    errorMessage: string,
  ): CargoOrder[] {
    this.auditLogService.append({
      action: 'Hata oluştu',
      level: 'error',
      details: errorMessage,
      orderNumber: order.orderNumber,
    })

    return replaceOrder(orders, {
      ...order,
      status: 'Hata',
      operationStatus: 'ERROR',
      errorMessage,
    })
  }

  private skipOrder(
    orders: CargoOrder[],
    order: CargoOrder,
    message: string,
  ): CargoOrder[] {
    this.auditLogService.append({
      action: 'Hata oluştu',
      level: 'warning',
      details: message,
      orderNumber: order.orderNumber,
    })

    return orders
  }

  private fail(
    orders: CargoOrder[],
    message: string,
  ): { orders: CargoOrder[]; result: WorkflowResult } {
    this.auditLogService.append({
      action: 'Hata oluştu',
      level: 'warning',
      details: message,
    })

    return {
      orders,
      result: {
        level: 'warning',
        message,
      },
    }
  }
}

function shipmentCreationBlockedReason(order: CargoOrder): string {
  const verification = verifySuratShipment(order)
  if (
    order.marketplace === 'Trendyol' &&
    !String(order.cargoTrackingNumber ?? '').trim()
  ) {
    return 'Trendyol cargoTrackingNumber bulunamadı. Sürat pazaryeri gönderisi oluşturulamaz.'
  }
  if (verification.verifiedShipment && verification.barcodeRaw) {
    return 'Bu sipariş için doğrulanmış Sürat ortak barkodu zaten oluşturulmuş.'
  }
  if (
    isPreassignedAwaitingAcceptance(order.shipment) &&
    resolveSuratPrintEligibility(order).canPrint
  ) {
    return 'Mevcut etiket kullanılıyor; yeni create yapılmadı. Etiket ön-atanmış kodlarla yazdırılabilir.'
  }
  if (
    order.operationStatus === 'SURAT_DISPATCH_REJECTED' ||
    order.shipment?.lifecycleStatus === 'SURAT_DISPATCH_REJECTED' ||
    order.shipment?.errorCategory === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
  ) {
    return 'Trendyol/Sürat bu paketin mevcut statüsünde gönderi oluşturulmasına izin vermiyor. Trendyol statüsünü kontrol edin.'
  }
  if (!isOrderOperationallyActive(order)) {
    return `Siparişin pazaryeri durumu (${order.marketplaceStatus || '-'}) aktif gönderi oluşturmaya uygun değil.`
  }
  if (
    order.labelStatus === 'PRINTED' &&
    Boolean(order.label?.printedAt)
  ) {
    return 'Bu siparişin etiketi daha önce basılmış. Yeniden işlem için Yazdır / Tekrar Yazdır akışını kullanın.'
  }
  if (order.shipment) {
    return 'Siparişte tamamlanmamış bir Sürat kaydı var. Önce Seçilenleri Yenile / Doğrula işlemini çalıştırın.'
  }
  return 'Siparişin operasyon durumu Sürat gönderisi oluşturmaya uygun değil.'
}

function buildShipmentCreationResultMessage({
  successCount,
  skippedCount,
  skippedReasons,
  createdShipments,
}: {
  successCount: number
  skippedCount: number
  skippedReasons: string[]
  createdShipments: string[]
}): string {
  const uniqueReasons = [...new Set(skippedReasons)]
  const skippedSummary =
    uniqueReasons.length > 0
      ? uniqueReasons.slice(0, 3).join(' | ') +
        (uniqueReasons.length > 3
          ? ` | +${uniqueReasons.length - 3} sipariş daha`
          : '')
      : ''

  if (successCount === 0 && skippedCount > 0) {
    return skippedSummary || `${skippedCount} sipariş işleme uygun olmadığı için atlandı.`
  }
  if (successCount > 0 && skippedCount > 0) {
    return `${successCount} Sürat gönderisi oluşturuldu, ${skippedCount} sipariş atlandı. ${skippedSummary}`
  }
  return `Sürat gönderi akışı tamamlandı. ${createdShipments.join(' | ')}`
}

// Merge kimliği VARYANT seviyesindedir. Aynı varyant için birden fazla alan
// bulunduğunda yalnızca en güçlü alanı kullan; daha zayıf ve ortak bir alanı
// aynı kayda eklemek farklı renk/beden kayıtlarını yine birleştirebilir.
// Varyant kimliği olmayan eski kayıtlar için üst ürün geri dönüş anahtarıdır.
function productVariantMergeKeys(product: CargoProduct): string[] {
  if (product.barcode) return [`bc:${String(product.barcode).trim()}`]
  if (product.productCode) return [`pc:${String(product.productCode).trim()}`]
  if (product.productContentId) {
    return [`content:${String(product.productContentId).trim()}`]
  }
  return product.externalProductId
    ? [`ext:${String(product.externalProductId).trim()}`]
    : []
}

export function mergeProductsWithCache(
  freshProducts: CargoProduct[],
  cachedProducts: CargoProduct[],
): CargoProduct[] {
  const result = [...cachedProducts]
  const indexByKey = new Map<string, number>()
  const registerKeys = (product: CargoProduct, index: number) => {
    for (const key of productVariantMergeKeys(product)) {
      if (!indexByKey.has(key)) indexByKey.set(key, index)
    }
  }
  result.forEach(registerKeys)
  for (const fresh of freshProducts) {
    const index =
      productVariantMergeKeys(fresh)
        .map((key) => indexByKey.get(key))
        .find((value) => value != null) ?? -1
    if (index < 0) {
      result.push(fresh)
      registerKeys(fresh, result.length - 1)
      continue
    }
    const cached = result[index]
    result[index] = {
      ...cached,
      ...fresh,
      imageUrl: fresh.imageUrl || cached.imageUrl,
      productImageUrl: fresh.productImageUrl || cached.productImageUrl,
      images:
        fresh.images && fresh.images.length > 0
          ? fresh.images
          : cached.images,
    }
    registerKeys(result[index], index)
  }
  return result
}

function normalizeSuratCreateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Bilinmeyen hata'
  const normalized = message.toLocaleLowerCase('tr-TR')

  if (
    normalized.includes('entegrasyon koduna ait kargo bulunamamıştır') ||
    (normalized.includes('hata kodu') && normalized.includes('1001'))
  ) {
    return (
      'Sürat create isteği Trendyol/pazaryeri akışına yönlendirildi ancak entegrasyon koduna ait kargo bulunamadı. ' +
      'packageId, Pazaryerimi, EntegrasyonFirmasi ve Sürat sözleşme/yetki eşleşmesini kontrol edin. ' +
      `Sürat ham mesajı: ${message}`
    )
  }

  return message
}

function enrichStoredProducts(products: CargoProduct[]): CargoProduct[] {
  return products.filter((product) => isValidStoredProduct(product))
}

function isValidStoredProduct(product: CargoProduct): boolean {
  if (!product || typeof product !== 'object') return false
  if ('shipmentAddress' in product || 'customerName' in product) return false
  return Boolean(
    product.externalProductId ||
      product.barcode ||
      product.stockCode ||
      product.sku ||
      product.productName,
  )
}

function enrichStoredOrders(orders: CargoOrder[]): CargoOrder[] {
  const normalized = orders
    .filter((order) => isValidStoredOrder(order))
    .map(removeLegacyTrendyolShipment)
    .map(normalizeLegacyPreRegistrationStatus)
    .map(migrateUnconfirmedSerendipState)
    .map(migrateSuspiciousPrintedState)
    .map(normalizeVerifiedOrtakBarkodState)
    .map((order) => withDerivedOperationStatus(order))
  return archiveStoredOrdersMissingLatestSync(normalized)
}

function normalizeLegacyPreRegistrationStatus(order: CargoOrder): CargoOrder {
  if (!isLegacyPreRegistration(order)) return order
  return {
    ...order,
    status: 'Ön Kayıt Yapıldı',
    operationStatus: 'SURAT_CREATED_NO_TRACKING',
    labelStatus: undefined,
  }
}

function isValidStoredOrder(order: CargoOrder): boolean {
  if (!order.orderNumber || !Array.isArray(order.items)) return false
  if (order.packageId || order.shipmentPackageId) return true
  return Boolean(
    order.customerName &&
      order.customerName !== 'Trendyol Müşterisi' &&
      (order.address || order.city || order.district),
  )
}

// Merge kuralı (persist katmanı): yazılacak order'da shipment YOKSA ama
// storage'daki aynı paket kaydında operasyonel shipment VARSA, marketplace
// alanları (müşteri/adres/items/durum/tarih/fiyat) yeni kopyadan alınır,
// operasyonel alanlar (shipment, etiket geçmişi, doğrulama durumu, desi
// override) storage'dan KORUNUR. Yazılacak kopya kendi shipment'ını
// taşıyorsa (create/track akışları) o daha yenidir ve aynen yazılır.
// Kimlik: packageId/shipmentPackageId String() ile normalize edilir
// ("4009094498" === 4009094498); farklı packageId'ler birleştirilmez.
// Operasyonel kimlik eşleyici: tenant zaten storage anahtarında; burada
// öncelik packageId/shipmentPackageId'dir (String() normalize —
// "4009094498" === 4009094498). Yalnız İKİ TARAF da packageId taşımıyorsa
// orderNumber'a düşülür; externalOrderId/id gibi zayıf kimliklerle iki
// farklı paket ASLA birleştirilmez.
function findMatchingOperationalOrder(
  order: CargoOrder,
  storedOrders: CargoOrder[],
): CargoOrder | undefined {
  const packageKeys = [order.packageId, order.shipmentPackageId]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  if (packageKeys.length > 0) {
    return storedOrders.find((stored) =>
      [stored.packageId, stored.shipmentPackageId]
        .map((value) => String(value ?? '').trim())
        .some((value) => value && packageKeys.includes(value)),
    )
  }
  const orderNumber = String(order.orderNumber ?? '').trim()
  if (!orderNumber) return undefined
  return storedOrders.find(
    (stored) =>
      !String(stored.packageId ?? '').trim() &&
      !String(stored.shipmentPackageId ?? '').trim() &&
      String(stored.orderNumber ?? '').trim() === orderNumber,
  )
}

export function preserveOperationalStateFromStore(
  nextOrders: CargoOrder[],
  storedOrders: CargoOrder[],
): CargoOrder[] {
  if (storedOrders.length === 0) return nextOrders
  const storedWithShipment = storedOrders.filter((order) => order?.shipment)
  if (storedWithShipment.length === 0) return nextOrders
  return nextOrders.map((order) => {
    const stored = findMatchingOperationalOrder(order, storedWithShipment)
    if (!stored?.shipment) return order
    // Desi override her durumda korunur (yeni kopyada yoksa).
    const desiPreserved =
      order.desi == null && stored.desi != null
        ? { desi: stored.desi, desiSource: stored.desiSource }
        : {}
    if (order.shipment) {
      return { ...order, ...desiPreserved }
    }
    return {
      ...order,
      ...desiPreserved,
      shipment: stored.shipment,
      label: order.label ?? stored.label,
      labelStatus: order.labelStatus ?? stored.labelStatus,
      shipmentStatus: stored.shipmentStatus,
      suratVerificationStatus: stored.suratVerificationStatus,
      zplReady: stored.zplReady,
      printEnabled: stored.printEnabled,
      matchStatus: stored.matchStatus,
      matchReason: stored.matchReason,
      noTrackingReason: stored.noTrackingReason,
      labelBlockedReason: stored.labelBlockedReason,
      zplDisabledReason: stored.zplDisabledReason,
      printMigrationNote: stored.printMigrationNote,
      status:
        stored.status && stored.status !== 'Yeni' ? stored.status : order.status,
      operationStatus: stored.operationStatus ?? order.operationStatus,
    }
  })
}

function mergeOrdersWithLocalState(
  freshOrders: CargoOrder[],
  cachedOrders: CargoOrder[],
): CargoOrder[] {
  const normalizedCached = cachedOrders.map(removeLegacyTrendyolShipment)
  const cachedMaps = buildOrderMergeMaps(normalizedCached)
  const consumedCachedIds = new Set<string>()
  const mergedFresh = deduplicateOrders(freshOrders).map((order) => {
    const cached = findMatchingOrder(order, cachedMaps)
    if (!cached) return withDerivedOperationStatus(order)
    consumedCachedIds.add(cached.id)
    const shouldRecoverFromCachedError =
      !cached.shipment && shouldClearCachedCarrierError(order, cached)

    return withDerivedOperationStatus(
      normalizeVerifiedOrtakBarkodState(
        migrateSuspiciousPrintedState(
          migrateUnconfirmedSerendipState(
            normalizeLegacyPreRegistrationStatus({
        ...order,
        items: mergeOrderItems(order.items, cached.items),
        shipment: cached.shipment,
        label: cached.label,
        labelStatus: cached.labelStatus,
        shipmentStatus: cached.shipmentStatus,
        suratVerificationStatus: cached.suratVerificationStatus,
        zplReady: cached.zplReady,
        printEnabled: cached.printEnabled,
        matchStatus: cached.matchStatus,
        matchReason: cached.matchReason,
        error: cached.error,
        errorMessage: shouldRecoverFromCachedError
          ? undefined
          : cached.errorMessage,
        noTrackingReason: cached.noTrackingReason,
        labelBlockedReason: cached.labelBlockedReason,
        zplDisabledReason: cached.zplDisabledReason,
        printMigrationNote: cached.printMigrationNote,
        status:
          shouldRecoverFromCachedError || cached.status === 'Yeni'
            ? order.status
            : cached.status,
        operationStatus: shouldRecoverFromCachedError
          ? order.operationStatus
          : cached.operationStatus ?? order.operationStatus,
            }),
          ),
        ),
      ),
    )
  })

  const archivedAt = new Date().toISOString()
  const retainedCached = normalizedCached
    .filter((order) => !consumedCachedIds.has(order.id))
    .map((order) =>
      shouldArchiveStaleCachedOrder(order)
        ? archiveStaleCachedOrder(order, archivedAt)
        : order,
    )
  return deduplicateOrders([...mergedFresh, ...retainedCached])
}

function shouldArchiveStaleCachedOrder(order: CargoOrder): boolean {
  if (order.archived || order.archivedAt) return false
  if (order.marketplace !== 'Trendyol') return false
  if (hasClosedMarketplaceStatus(order)) return false
  if (!hasActiveOrStuckLocalStatus(order)) {
    return false
  }
  const hasVerifiedCarrierCode = Boolean(
    order.shipment?.verifiedShipment ||
      order.shipment?.operationalBarcodeVerified ||
      order.shipment?.trackingNumber ||
      order.shipment?.kargoTakipNo ||
      order.shipment?.barcode ||
      order.shipment?.barkodNo,
  )
  if (hasVerifiedCarrierCode) return false
  const staleSyncTime = new Date(
    order.lastMarketplaceSyncedAt || order.createdAt || order.orderDate || 0,
  ).getTime()
  if (Number.isNaN(staleSyncTime)) return true
  return Date.now() - staleSyncTime > 1000 * 60 * 60
}

function hasClosedMarketplaceStatus(order: CargoOrder): boolean {
  const token = normalizeStaleStatusToken(order.marketplaceStatus)
  return [
    'shipped',
    'delivered',
    'atcollectionpoint',
    'cancelled',
    'returned',
    'undelivered',
    'unsupplied',
    'kargoyaverildi',
    'teslimedildi',
    'iptal',
    'iade',
    'teslimedilemedi',
    'tedarikedilemedi',
  ].includes(token)
}

function hasActiveOrStuckLocalStatus(order: CargoOrder): boolean {
  const tokens = [
    order.marketplaceStatus,
    order.status,
    order.operationStatus,
    order.shipmentStatus,
    order.suratVerificationStatus,
    order.labelStatus,
  ].map(normalizeStaleStatusToken)
  return tokens.some((token) =>
    [
      'created',
      'picking',
      'invoiced',
      'new',
      'yeni',
      'siparisolustu',
      'hazirlaniyor',
      'shipmentpending',
      'shipmentcreated',
      'suratcreatednotracking',
      'suratverificationpending',
      'surattrackingmissing',
      'suratbarcodefailed',
      'suratdispatchrejected',
      'kargoolusturuldu',
      'suratdogrulamabekliyor',
      'barkodbekliyor',
      'hata',
      'hatali',
      'error',
    ].includes(token),
  )
}

function normalizeStaleStatusToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]/g, '')
}

function archiveStaleCachedOrder(
  order: CargoOrder,
  archivedAt: string,
): CargoOrder {
  return withDerivedOperationStatus({
    ...order,
    archived: true,
    archivedAt,
    archivedReason: 'not_seen_in_latest_marketplace_sync',
    status: 'Arşiv',
    noTrackingReason: undefined,
    labelBlockedReason: undefined,
    zplDisabledReason: undefined,
  })
}

function archiveStoredOrdersMissingLatestSync(
  orders: CargoOrder[],
): CargoOrder[] {
  const latestSyncBatchId = resolveLatestStoredSyncBatchId(orders)
  if (!latestSyncBatchId) return orders
  const archivedAt = new Date().toISOString()
  return orders.map((order) => {
    if (order.lastMarketplaceSyncBatchId === latestSyncBatchId) return order
    return shouldArchiveStaleCachedOrder(order)
      ? archiveStaleCachedOrder(order, archivedAt)
      : order
  })
}

function resolveLatestStoredSyncBatchId(orders: CargoOrder[]): string {
  return orders
    .map((order) => String(order.lastMarketplaceSyncBatchId ?? '').trim())
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] ?? ''
}

function markOrderAsSeenInSyncBatch(
  order: CargoOrder,
  syncBatchAt: string,
): CargoOrder {
  return {
    ...order,
    lastMarketplaceSyncedAt: syncBatchAt,
    lastMarketplaceSyncBatchId: syncBatchAt,
  }
}

function mergeOrderItems(
  freshItems: CargoOrder['items'],
  cachedItems: CargoOrder['items'],
): CargoOrder['items'] {
  return freshItems.map((item) => {
    const cached = findMatchingOrderItem(item, cachedItems)
    const freshImage = item.imageUrl || item.productImageUrl
    const cachedImage = cached?.imageUrl || cached?.productImageUrl
    return {
      ...item,
      imageUrl: freshImage || cachedImage,
      productImageUrl: freshImage || cachedImage,
      imageSource: freshImage
        ? item.imageSource
        : cached?.imageSource || item.imageSource,
      imageResolvedFrom: freshImage
        ? item.imageResolvedFrom || 'orderLine'
        : cachedImage
          ? cached?.imageResolvedFrom || 'productCache'
          : item.imageResolvedFrom || cached?.imageResolvedFrom || 'none',
      imageLoadError: item.imageLoadError ?? cached?.imageLoadError,
      matchedProductId: item.matchedProductId || cached?.matchedProductId,
      matchedBy: item.matchedBy || cached?.matchedBy,
    }
  })
}

function enrichOrdersWithProductImages(
  orders: CargoOrder[],
  products: CargoProduct[],
): CargoOrder[] {
  return orders.map((order) => ({
    ...order,
    items: order.items.map((item) =>
      applyProductImageResolution(item, products),
    ),
  }))
}

function findMatchingOrderItem(
  item: CargoOrder['items'][number],
  candidates: CargoOrder['items'],
): CargoOrder['items'][number] | undefined {
  return candidates.find(
    (candidate) =>
      (item.productContentId &&
        candidate.productContentId === item.productContentId) ||
      (item.productMainId && candidate.productMainId === item.productMainId) ||
      (item.barcode && candidate.barcode === item.barcode) ||
      (item.merchantSku && candidate.merchantSku === item.merchantSku) ||
      (item.sku && candidate.sku === item.sku) ||
      (item.stockCode && candidate.stockCode === item.stockCode) ||
      (item.productCode && candidate.productCode === item.productCode),
  )
}

function removeLegacyTrendyolShipment(order: CargoOrder): CargoOrder {
  const shipment = order.shipment
  if (!shipment) return order

  const isLegacySyntheticShipment =
    !shipment.suratCreateLog &&
    (shipment.barcodeSource?.includes('trendyol') ||
      String(
        (shipment.rawResponse as { source?: string } | undefined)?.source ?? '',
      ) === 'trendyol_order')

  if (!isLegacySyntheticShipment) return order

  return {
    ...order,
    shipment: undefined,
    label: undefined,
    status: 'Yeni',
    operationStatus: operationStatusFromMarketplaceStatus(order.marketplaceStatus),
    errorMessage: undefined,
  }
}

function buildOrderMergeMaps(orders: CargoOrder[]) {
  return {
    packageId: new Map(
      orders
        .filter((order) => order.packageId)
        .map((order) => [String(order.packageId), order]),
    ),
    shipmentPackageId: new Map(
      orders
        .filter((order) => order.shipmentPackageId)
        .map((order) => [String(order.shipmentPackageId), order]),
    ),
    orderNumber: new Map(
      orders
        .filter((order) => order.orderNumber)
        .map((order) => [String(order.orderNumber), order]),
    ),
    orderId: new Map(
      orders.flatMap((order) =>
        [order.externalOrderId, order.id]
          .filter(Boolean)
          .map((value) => [String(value), order] as const),
      ),
    ),
  }
}

function findMatchingOrder(
  order: CargoOrder,
  maps: ReturnType<typeof buildOrderMergeMaps>,
): CargoOrder | undefined {
  return (
    (order.packageId
      ? maps.packageId.get(String(order.packageId))
      : undefined) ||
    (order.shipmentPackageId
      ? maps.shipmentPackageId.get(String(order.shipmentPackageId))
      : undefined) ||
    maps.orderNumber.get(String(order.orderNumber)) ||
    maps.orderId.get(String(order.externalOrderId || order.id))
  )
}

function deduplicateOrders(orders: CargoOrder[]): CargoOrder[] {
  const maps = buildOrderMergeMaps([])
  const result: CargoOrder[] = []
  for (const order of orders) {
    if (findMatchingOrder(order, maps)) continue
    result.push(order)
    if (order.packageId) maps.packageId.set(String(order.packageId), order)
    if (order.shipmentPackageId) {
      maps.shipmentPackageId.set(String(order.shipmentPackageId), order)
    }
    maps.orderNumber.set(String(order.orderNumber), order)
    if (order.externalOrderId) {
      maps.orderId.set(String(order.externalOrderId), order)
    }
    maps.orderId.set(String(order.id), order)
  }
  return result
}

function shouldClearCachedCarrierError(
  freshOrder: CargoOrder,
  cachedOrder: CargoOrder,
): boolean {
  if (!freshOrder.cargoTrackingNumber) return false
  if (cachedOrder.status !== 'Hata' && cachedOrder.operationStatus !== 'ERROR') {
    return false
  }

  const message = String(cachedOrder.errorMessage ?? '').toLocaleLowerCase(
    'tr-TR',
  )
  if (!message) return true

  return [
    '1001',
    'kargo',
    'gönderi',
    'gonderi',
    'shipment',
    'surat',
    'sürat',
    'takip',
  ].some((keyword) => message.includes(keyword))
}
