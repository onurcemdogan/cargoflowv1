import type { ServerPrintContract } from '../utils/persistedLabel'
import type { LabelPrintTemplate } from '../utils/labelPrintTemplateRouting'

/**
 * Sunucu baskı özetini KAPALI SÖZLÜKLE normalize eder.
 *
 * Bilinmeyen/eksik değer GÜVENLİ tarafa düşer (basılamaz). İstemci burada
 * karar ÜRETMEZ; yalnız sunucunun kararını tipli hale getirir.
 *
 * Sunucu özeti hiç yoksa (eski yanıt biçimi) taşıyıcı ZPL'in varlığından
 * tek sayfalık sözleşme türetilir — bu, kalıcı artefaktı olmayan ESKİ
 * kayıtların mevcut reprint davranışını korur.
 */
function normalizeServerPrintContract(
  raw: Record<string, unknown> | null | undefined,
  zpl: string | null,
  desi: number | null,
): ServerPrintContract | null {
  if (!raw || typeof raw !== 'object') {
    if (!zpl) return null
    return {
      carrierPrintReady: true,
      printArtifactStatus: 'ready',
      productDetailStatus: 'none',
      zpl,
      desi,
      supplementalLabels: [],
    }
  }
  const artifactStatus =
    raw.printArtifactStatus === 'ready' ||
    raw.printArtifactStatus === 'fallback_carrier'
      ? raw.printArtifactStatus
      : 'failed'
  const detailStatus =
    raw.productDetailStatus === 'ready' || raw.productDetailStatus === 'none'
      ? raw.productDetailStatus
      : 'failed'
  // Taşıyıcı kapısı: SUNUCUNUN bayrağı. `carrierPrintReady` eski yanıtlarda
  // yoksa `printReady`ye düşülür; ikisi de yoksa BASILAMAZ.
  const carrierPrintReady =
    raw.carrierPrintReady === true ||
    (raw.carrierPrintReady === undefined && raw.printReady === true)
  const supplementalLabels = Array.isArray(raw.supplementalLabels)
    ? (raw.supplementalLabels as Array<Record<string, unknown>>)
        .map((entry) => ({
          page: Number(entry?.page ?? 0),
          totalPages: Number(entry?.totalPages ?? 0),
          zpl: typeof entry?.zpl === 'string' ? entry.zpl : '',
          ...(typeof entry?.sha256 === 'string' ? { sha256: entry.sha256 } : {}),
        }))
        .filter((entry) => entry.zpl.trim().length > 0)
    : []
  return {
    carrierPrintReady,
    printArtifactStatus: artifactStatus,
    productDetailStatus: detailStatus,
    ...(typeof raw.productDetailFailureReason === 'string'
      ? { productDetailFailureReason: raw.productDetailFailureReason }
      : {}),
    zpl,
    desi,
    supplementalLabels,
  }
}
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
  ProductCatalogCacheEnvelope,
  ProductCatalogCacheMetadata,
  Shipment,
  SuratLabelMappingConfig,
  TenantDesiConfig,
  TrendyolProductSyncDebug,
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
import {
  applyExternalProcessingState,
  describeExternalProcessingOutcome,
  externalProcessingKeys,
  type ExternalProcessingState,
} from '../utils/externalProcessing'
import {
  buildRevisionMismatch,
  FRONTEND_BUILD_REVISION,
} from '../utils/buildRevision'
import type { AuditLogService } from './auditLogService'
import { apiDebugService } from './apiDebugService'
import { dedupeOrdersByPackageIdentity } from '../utils/orderCounts'
import type {
  OrdersWorkspaceQuery,
  OrdersWorkspaceResult,
} from '../utils/ordersWorkspaceQuery'
import type { LabelDocument } from '../labels/labelDocument'
import {
  resolveTotalPages,
  validateOrderPageMeta,
  validatePaginationSnapshot,
} from '../utils/orderPagination'

// /api/orders sozlesmesi: istek {page,pageSize}, yanit
// {ok,orders,total,page,pageSize}. totalPages DONDURULMEZ; ceil(total/
// pageSize) ile turetilir. Backend MAX_PAGE_SIZE = 100'dur; daha buyuk
// istek sessizce 100'e kirpilir, bu yuzden tam olarak 100 kullanilir.
const ORDERS_LOAD_PAGE_SIZE = 100
// Sonsuz sayfalama korumasi: asilirsa ACIK hata verilir (sessiz kirpma YOK).
const MAX_ORDER_PAGES = 200
// Sunucuyu bogmayan kontrollu escszamanlilik (urun katalogu ile ayni).
const ORDERS_LOAD_CONCURRENCY = 4
import {
  loadPersistedProductCatalog,
  savePersistedProductCatalog,
} from '../utils/productCatalogStorage'
import {
  orderPackageIdentityCandidates,
  orderNumberIdentity,
} from '../utils/orderCounts'

const ORDERS_KEY = 'cargoFlow_orders_v3'
const PRODUCTS_KEY = 'cargoFlow_products_v4'
const LEGACY_PRODUCTS_KEYS = ['cargoFlow_products_v3']
const PRODUCT_CACHE_SCHEMA_VERSION = 4
const MIN_COMPLETE_CATALOG_RATIO = 0.99
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
        key.startsWith(`${PRODUCTS_KEY}:`) ||
        LEGACY_PRODUCTS_KEYS.some(
          (legacyKey) => key === legacyKey || key.startsWith(`${legacyKey}:`),
        )) &&
      (marketplaceAccountChanged || !activeKeys.has(key))
    ) {
      removableKeys.push(key)
    }
  }
  removableKeys.forEach((key) => window.localStorage.removeItem(key))
  LEGACY_ACTIVE_MARKETPLACE_ACCOUNT_KEYS.forEach((key) =>
    window.localStorage.removeItem(key),
  )
  LEGACY_PRODUCTS_KEYS.forEach((key) => {
    window.localStorage.removeItem(key)
    window.localStorage.removeItem(scopedStorageKey(key, activeScope))
  })
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
  // AUTH modu: siparişlerin kaynak-of-truth'ı sunucudaki PostgreSQL'dir.
  // Frontend PII'yi localStorage'a YAZMAZ; oturum boyunca yalnız in-memory
  // snapshot tutar ve yenilemede sunucudan tekrar yükler. Legacy modda bu
  // bayrak kapalıdır ve tüm localStorage akışı DEĞİŞMEDEN çalışır.
  private authMode = false
  private authOrdersCache: CargoOrder[] = []
  // YEREL harici-islem arsivi (organization settings JSONB'sinden gelir).
  private externalProcessingState: ExternalProcessingState = { entries: {} }
  // Escszamanli siparis yuklemelerinde son yazan kazanir (stale yanit ezmesin).
  private ordersLoadGeneration = 0
  // Calisma alani istegi nesli — bayat yanit yeni sonucu EZEMEZ.
  private ordersWorkspaceGeneration = 0
  // Kanonik havuz: gorulen siparisler id -> kayit. Secim cozumu ve siparis
  // detayi buradan yapilir; sayfa degisimi secimi KAYBETTIRMEZ.
  private canonicalOrderPool = new Map<string, CargoOrder>()
  // Ucustaki calisma alani istekleri (sorgu dizesi -> promise).
  private workspaceInFlight = new Map<
    string,
    Promise<{
      workspace?: OrdersWorkspaceResult
      externalProcessing?: ExternalProcessingState
    }>
  >()

  private authOrdersMeta: { total: number; page: number; pageSize: number } = {
    total: 0,
    page: 1,
    pageSize: 25,
  }
  // Auth modda ürün kataloğu kaynak-of-truth sunucudur; IndexedDB/localStorage
  // source-of-truth DEĞİLDİR. Oturum boyunca yalnız in-memory cache tutulur.
  private authProductsCache: CargoProduct[] = []
  private readonly productCatalogMemory = new Map<
    string,
    ProductCatalogCacheEnvelope
  >()
  // Hesap nesli (generation): her aktif hesap değişiminde artar. Geç gelen
  // (stale) bir hesap isteğinin sonucunun yanlış hesabın UI state'ine yazılmasını
  // önlemek için çağıran, isteği başlatmadan önce bu değeri okur ve sonuç
  // geldiğinde hâlâ eşit mi diye kontrol eder (race-condition koruması).
  private marketplaceAccountGeneration = 0
  // Account-scoped KISA ÖMÜRLÜ (SWR) in-memory önbellek: yalnız AKTİF hesap için;
  // hesap değişince tamamen atılır. Raw order/ZPL/PII localStorage'a YAZILMAZ —
  // yalnız oturum-içi bellek. Bounded (LRU) + TTL. Yeniden mount/navigasyonda
  // önce taze cache gösterilir, arkada DB'den revalidate edilir.
  private readonly accountScopedOrdersCache = new Map<
    string,
    { at: number; generation: number; orders: CargoOrder[] }
  >()
  private static readonly ORDERS_CACHE_TTL_MS = 30_000
  private static readonly ORDERS_CACHE_MAX_ENTRIES = 8

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

  // Ayarlar → "Varsayılan Gönderi Desisi". Kullanıcı sipariş bazında desi
  // GİRMEZ; yeni etiketlerin desisi bu konfigürasyondan (adet çarpanıyla)
  // hesaplanır. App entegrasyon ayarları yüklendiğinde/değiştiğinde çağırır.
  private tenantDesiConfig?: TenantDesiConfig

  setDesiConfig(config?: TenantDesiConfig): void {
    this.tenantDesiConfig = config
  }

  // Auth modu integrationConfigService tespitinden (auth/me + integration
  // response mode sözleşmesi) gelir; frontend organizationId'sinden TÜRETİLMEZ.
  setAuthMode(value: boolean): void {
    this.authMode = value
  }

  isAuthMode(): boolean {
    return this.authMode
  }

  getAuthOrdersMeta(): { total: number; page: number; pageSize: number } {
    return this.authOrdersMeta
  }

  // Auth modda sunucudan (GET /api/orders) org-scoped, server-side sayfalı
  // liste yükler ve in-memory snapshot'ı günceller. Organization req.auth'tan
  // çözülür; frontend'ten org parametresi GÖNDERİLMEZ.
  // HARİCİ SİSTEMDE İŞLENDİ — YEREL, MANUEL, GERİ ALINABİLİR.
  //
  // Provider veya marketplace çağrısı YAPMAZ. Tracking numarası, barkod,
  // labelStatus, printCount ve ZPL DEĞİŞMEZ; yeni gönderi oluşturulmaz ve
  // "Kargoya Verildi" işlemi tetiklenmez. Yalnız organization settings
  // JSONB'sindeki yerel arşiv güncellenir ve aktif görünüm etkilenir.
  //
  // Seçim GERÇEK snapshot'tan gelir: canonical paket kimliği kullanılır, bu
  // yüzden sayfa/filtre değişimi yanlış siparişi işaretleyemez.
  async setExternalProcessing(
    orders: CargoOrder[],
    processed: boolean,
  ): Promise<{ orders: CargoOrder[]; result: WorkflowResult }> {
    const keys = externalProcessingKeys(orders)
    if (keys.length === 0) {
      return {
        orders: this.authOrdersCache,
        result: { level: 'warning', message: 'Seçili sipariş bulunamadı.' },
      }
    }
    try {
      const response = await fetch('/api/orders/external-processing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orderKeys: keys, processed }),
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        changed?: number
        unchanged?: number
        invalid?: number
        message?: string
        externalProcessing?: ExternalProcessingState
      } | null
      if (!response.ok || !payload?.ok) {
        throw new Error(
          payload?.message ?? 'Harici işlem durumu güncellenemedi.',
        )
      }
      this.externalProcessingState = payload.externalProcessing ?? {
        entries: {},
      }
      const nextOrders = applyExternalProcessingState(
        this.authOrdersCache,
        this.externalProcessingState,
      )
      this.authOrdersCache = nextOrders
      const changed = Number(payload.changed ?? 0)
      const unchanged = Number(payload.unchanged ?? 0)
      const failed = Number(payload.invalid ?? 0)
      const message = describeExternalProcessingOutcome(
        { requested: keys.length, changed, unchanged, failed },
        processed,
      )
      // AUDIT: yalnız güvenli sayaç ve zaman damgası. Müşteri adı, adres,
      // telefon, ZPL veya credential YAZILMAZ.
      this.auditLogService.append({
        action: processed
          ? 'external_processing_marked'
          : 'external_processing_restored',
        level: failed > 0 ? 'warning' : 'success',
        details: `${keys.length} sipariş kimliği işlendi; ${changed} değişti, ${unchanged} zaten bu durumdaydı.`,
      })
      return {
        orders: nextOrders,
        result: {
          level: failed > 0 ? 'warning' : 'success',
          message,
        },
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Harici işlem durumu güncellenemedi.'
      this.auditLogService.append({
        action: 'Hata oluştu',
        level: 'error',
        details: message,
      })
      return {
        orders: this.authOrdersCache,
        result: { level: 'error', message },
      }
    }
  }

  /**
   * TAM KOLEKSIYON YUKLEYICISI — KULLANIM DISI (UI YOLUNDA CAGRILMAZ).
   *
   * ═══ NEDEN DURUYOR ══════════════════════════════════════════════════
   * Bu metod TUM siparis tablosunu 100'erlik sayfalarla indirir. 10k
   * siparişte ~100 HTTP turu, 20k ustunde ise `MAX_ORDER_PAGES` ile ACIK
   * hata uretir. Bu nedenle HICBIR UI yolundan cagrilmaz; yerini sunucu
   * tarafi `fetchOrdersWorkspace()` almistir.
   *
   * SILINMEDI cunku `/api/orders` sayfalama SOZLESMESININ (sayfa
   * metadata'sinin dogrulanmasi, kismi basari yasagi, sayfalar arasi
   * tekillestirme) calisan referans uygulamasidir ve
   * `orders-pagination-flow` paketi bu sozlesmeyi bu metod uzerinden
   * kilitler.
   *
   * MUHAFIZ: `App.tsx` bu metodu cagirirsa RES-7b ve PERF-9 testleri
   * KIRILIR. Yeni bir tam-koleksiyon yolu sessizce geri gelemez.
   */
  async loadOrdersFromServer(
    filters: {
      status?: string
      operationStatus?: string
      search?: string
      startDate?: string
      endDate?: string
      city?: string
      district?: string
      page?: number
      pageSize?: number
      sort?: 'orderDateDesc' | 'orderDateAsc'
    } = {},
  ): Promise<CargoOrder[]> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) {
      if (value != null && String(value).trim() !== '') {
        params.set(key, String(value))
      }
    }
    const query = params.toString()
    const startedAt =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    // Bu yukleme icin nesil damgasi: escszamanli ("Simdi Yenile" + ilk acilis +
    // yeniden dogrulama) cagrilarda YAVAS olan ESKI istek, hizli biten YENI
    // istegin sonucunu EZMEZ. Yalniz en guncel nesil cache'e yazar.
    this.ordersLoadGeneration += 1
    const generation = this.ordersLoadGeneration

    // 1) Ilk sayfa: toplam kayit sayisini ve gercek sayfa boyutunu verir.
    const first = await this.fetchOrdersPage(query, 1, ORDERS_LOAD_PAGE_SIZE)
    const effectivePageSize =
      first.pageSize > 0 ? first.pageSize : ORDERS_LOAD_PAGE_SIZE
    const total = first.total

    // 2) Sayfa sayisi TURETILIR: /api/orders totalPages DONDURMEZ; sozlesme
    //    {orders,total,page,pageSize}. Tutarsiz metadata SESSIZCE basari
    //    sayilmaz.
    const totalPages = resolveTotalPages(total, effectivePageSize)
    // Ilk sayfanin metadata'si da dogrulanir (yanlis page/pageSize sessizce
    // kabul edilmez).
    validateOrderPageMeta(
      {
        orderCount: first.orders.length,
        total: first.total,
        page: first.page,
        pageSize: first.pageSize,
      },
      { page: 1, pageSize: effectivePageSize, expectedTotal: total, totalPages },
    )
    if (totalPages > MAX_ORDER_PAGES) {
      throw new Error(
        'Siparisler yuklenemedi: sayfa sayisi guvenlik sinirini asti ' +
          `(${totalPages} > ${MAX_ORDER_PAGES}). Lutfen tarih/durum filtresi ` +
          'uygulayin.',
      )
    }

    // 3) Kalan sayfalar KONTROLLU escszamanlilikla. Herhangi bir sayfa
    //    basarisiz olursa Promise.all reddeder ve HICBIR kismi sonuc state'e
    //    veya cache'e YAZILMAZ (kismi basari yasak).
    const collected: CargoOrder[][] = [first.orders]
    for (let start = 2; start <= totalPages; start += ORDERS_LOAD_CONCURRENCY) {
      const pageNumbers: number[] = []
      for (
        let page = start;
        page < start + ORDERS_LOAD_CONCURRENCY && page <= totalPages;
        page += 1
      ) {
        pageNumbers.push(page)
      }
      const batch = await Promise.all(
        pageNumbers.map((page) =>
          this.fetchOrdersPage(query, page, effectivePageSize),
        ),
      )
      for (const [index, result] of batch.entries()) {
        // Her sayfanin page/pageSize/total/kayit sayisi dogrulanir. Tutarsizlik
        // (yanlis sayfa, degisen total, beklenmeyen kayit sayisi) SESSIZCE
        // basari sayilmaz.
        validateOrderPageMeta(
          {
            orderCount: result.orders.length,
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
          },
          {
            page: pageNumbers[index],
            pageSize: effectivePageSize,
            expectedTotal: total,
            totalPages,
          },
        )
        collected.push(result.orders)
      }
    }

    // 4) Sayfalar arasi canonical tekillestirme (ayni paket iki sayfada
    //    gorunebilir; or. sayfalar arasinda yeni kayit eklenmisse). Backend
    //    siralamasi (orderDateDesc) KORUNUR: ilk gorulen kayit kalir.
    const collectedRows = collected.flat()
    const orders = dedupeOrdersByPackageIdentity(collectedRows)
    // Toplanan satir sayisi total ile eslesmeli ve dedupe HICBIR kaydi
    // dusurmemelidir (endpoint kapsaminda paket kimligi tekildir). Aksi hal
    // sayfalar arasinda pencerenin kaydigini gosterir.
    validatePaginationSnapshot({
      collectedRowCount: collectedRows.length,
      distinctCount: orders.length,
      expectedTotal: total,
    })

    // 5) Yalniz EN GUNCEL nesil cache/meta yazar (stale yanit ezmesin).
    if (generation === this.ordersLoadGeneration) {
      this.authOrdersCache = orders
      this.authOrdersMeta = {
        total: Number(total ?? orders.length),
        page: 1,
        pageSize: effectivePageSize,
      }
      // Yalniz filtresiz (varsayilan) liste SWR cache'ine yazilir; filtreli
      // sorgular onbelleklenmez (kombinasyon patlamasini onler).
      if (query === '') this.writeOrdersCache('default', orders)
    }
    // Guvenli timing metadata (yalniz DEV): ham org/account id, PII, raw order,
    // ZPL, credential veya secret LOGLANMAZ - yalniz sure/sayi/varlik bayragi.
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      console.debug('PERF_ORDERS_LOAD', {
        route: 'orders',
        marketplaceAccountScopePresent: this.marketplaceAccountScope !== '',
        totalDurationMs: Math.round(now - startedAt),
        cacheHit: false,
        itemCount: orders.length,
        pageCount: totalPages,
        stale: generation !== this.ordersLoadGeneration,
        filtered: query !== '',
      })
    }
    return orders
  }

  /**
   * SUNUCU TARAFI CALISMA ALANI SAYFASI — Siparisler ekraninin tek yolu.
   *
   * ═══ NEDEN ═════════════════════════════════════════════════════════════
   * `loadOrdersFromServer()` TUM tabloyu ~100 HTTP turuyla indiriyordu ve
   * 20k'nin uzerinde ACIKCA hata veriyordu. Bu metod YALNIZ istenen sayfayi,
   * sekme sayaclarini ve filtre seceneklerini ceker; tam koleksiyon
   * tarayiciya INMEZ.
   *
   * ═══ BAYAT YANIT KORUMASI ══════════════════════════════════════════════
   * Her istek bir nesil damgasi alir. Hizli yazilan bir filtre dizisinde
   * ONCE baslayip SONRA biten istek, daha yeni istegin sonucunu EZEMEZ:
   * `stale` bayragiyla doner ve cagiran onu ATAR.
   */
  async fetchOrdersWorkspace(
    query: OrdersWorkspaceQuery,
  ): Promise<{ workspace: OrdersWorkspaceResult; stale: boolean }> {
    this.ordersWorkspaceGeneration += 1
    const generation = this.ordersWorkspaceGeneration
    const params = new URLSearchParams()
    params.set('tab', query.tab)
    params.set('operationTab', query.operationTab)
    params.set('marketplace', String(query.marketplace))
    params.set('status', String(query.status))
    params.set('cargo', String(query.cargo))
    params.set('city', query.city)
    params.set('district', query.district)
    params.set('multiProduct', query.multiProduct)
    params.set('sameProduct', query.sameProduct)
    params.set('action', query.action)
    params.set('datePreset', query.date.preset)
    if (Number.isFinite(query.date.startTime)) {
      params.set('startTime', String(query.date.startTime))
    }
    if (Number.isFinite(query.date.endTime)) {
      params.set('endTime', String(query.date.endTime))
    }
    if (query.date.timezone) params.set('timezone', query.date.timezone)
    if (query.search) params.set('search', query.search)
    if (query.customerQuery) params.set('customerQuery', query.customerQuery)
    if (query.productQuery) params.set('productQuery', query.productQuery)
    if (query.orderNumberQuery) {
      params.set('orderNumberQuery', query.orderNumberQuery)
    }
    if (query.cargoSlipQuery) params.set('cargoSlipQuery', query.cargoSlipQuery)
    params.set('sortKey', query.sortKey)
    params.set('sortDirection', query.sortDirection)
    params.set('page', String(query.page))
    params.set('pageSize', String(query.pageSize))

    // ISTEK TEKILLESTIRME: AYNI sorgu zaten ucustaysa ikinci bir ag cagrisi
    // ACILMAZ. React StrictMode'un cift efekt calistirmasi ve sekmeye hizli
    // gidip gelme, ayni sayfayi iki kez indirmeye yol aciyordu.
    const key = params.toString()
    const inFlight = this.workspaceInFlight.get(key)
    const request = inFlight
      ? inFlight
      : fetch(`/api/orders/workspace?${key}`, { credentials: 'include' })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(
                `Siparisler yuklenemedi (HTTP ${response.status}).`,
              )
            }
            return (await response.json()) as {
              workspace?: OrdersWorkspaceResult
              externalProcessing?: ExternalProcessingState
            }
          })
          .finally(() => {
            this.workspaceInFlight.delete(key)
          })
    if (!inFlight) this.workspaceInFlight.set(key, request)
    const payload = await request
    if (payload.externalProcessing) {
      this.externalProcessingState = payload.externalProcessing
    }
    const workspace = payload.workspace
    if (!workspace || !Array.isArray(workspace.items)) {
      throw new Error('Siparisler yuklenemedi: gecersiz calisma alani yaniti.')
    }
    // Sayfadaki kayitlar KANONIK havuza yazilir: baska sayfada secilen bir
    // siparis, sayfa degisse bile toplu islemde COZULEBILIR kalir.
    for (const order of workspace.items) {
      this.canonicalOrderPool.set(String(order.id), order)
    }
    return {
      workspace,
      stale: generation !== this.ordersWorkspaceGeneration,
    }
  }

  /**
   * KALICI KAYIT SAYISI — tek sayfa, tek istek.
   *
   * Yalnizca sayi gerektiginde tum tabloyu indirmek israftir; `/api/orders`
   * zaten `total` doner. pageSize=1 ile agirlik neredeyse sifirdir.
   */
  private async fetchOrdersTotal(): Promise<number> {
    const response = await fetch('/api/orders?page=1&pageSize=1', {
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`Siparis sayisi okunamadi (HTTP ${response.status}).`)
    }
    const payload = (await response.json()) as { total?: number }
    return Number(payload.total ?? 0)
  }

  /** Bu oturumda GORULEN tum siparisler (ziyaret edilen sayfalarin birlesimi). */
  getCanonicalOrderPool(): CargoOrder[] {
    return [...this.canonicalOrderPool.values()]
  }

  /** Hesap degisiminde havuz TAMAMEN bosaltilir (capraz hesap sizintisi YOK). */
  resetCanonicalOrderPool(): void {
    this.canonicalOrderPool.clear()
  }

  // TEK sayfa ceker. Hesap/organization kapsami BACKEND'de cozulur; istemci
  // marketplaceAccountId GONDERMEZ (guvenilmez kabul edilir).
  private async fetchOrdersPage(
    query: string,
    page: number,
    pageSize: number,
  ): Promise<{
    orders: CargoOrder[]
    total: number
    page: number
    pageSize: number
  }> {
    const params = new URLSearchParams(query)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    const response = await fetch(`/api/orders?${params.toString()}`, {
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(
        `Siparisler yuklenemedi (sayfa ${page}, HTTP ${response.status}).`,
      )
    }
    const payload = (await response.json()) as {
      orders?: CargoOrder[]
      total?: number
      page?: number
      pageSize?: number
      externalProcessing?: ExternalProcessingState
    }
    const mapped = Array.isArray(payload.orders)
      ? payload.orders.map((order) => withDerivedOperationStatus(order))
      : []
    // YEREL harici-islem arsivi siparise DAMGALANIR. Siparisin hicbir
    // pazaryeri/provider alani degistirilmez; yalniz gorunum bayragi eklenir.
    if (payload.externalProcessing) {
      this.externalProcessingState = payload.externalProcessing
    }
    const orders = applyExternalProcessingState(
      mapped,
      this.externalProcessingState,
    )
    return {
      orders,
      total: Number(payload.total ?? orders.length),
      page: Number(payload.page ?? page),
      pageSize: Number(payload.pageSize ?? orders.length),
    }
  }

  // REPRINT için KAYITLI etiket artifact'ini (ham ZPL) tenant-scoped uçtan
  // (GET /api/orders/:id/label) getirir. Org yalnız oturumdan (req.auth) çözülür;
  // frontend org göndermez. Provider'a ÇIKMAZ, yeni shipment/barkod OLUŞTURMAZ,
  // desi doğrulaması YAPMAZ. `hasPrintableLabel=true` fakat ham ZPL yoksa zpl=null
  // döner (çağıran kontrollü hata gösterir). Legacy modda uç yoktur → null.
  async fetchPersistedLabel(orderId: string): Promise<{
    hasPrintableLabel: boolean
    zpl: string | null
    source: string | null
    desi: number | null
    /**
     * SUNUCUNUN BASILABİLİRLİK SÖZLEŞMESİ.
     *
     * Baskıya gidecek baytlara ve basılıp basılamayacağına SUNUCU karar
     * verir; istemci bu sözleşmeyi UYGULAR (bkz. applyServerPrintContract).
     * Alanlar KAPALI SÖZLÜKTEN okunur; bilinmeyen değer güvenli tarafa
     * (basılamaz) düşer.
     */
    print: ServerPrintContract | null
  } | null> {
    if (!this.authMode) return null
    const response = await fetch(
      `/api/orders/${encodeURIComponent(orderId)}/label`,
      { credentials: 'include' },
    )
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      hasPrintableLabel?: boolean
      zpl?: string | null
      source?: string | null
      desi?: number | null
      print?: Record<string, unknown> | null
      message?: string
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(String(payload?.message ?? 'Kayıtlı etiket alınamadı.'))
    }
    const desiNum = Number(payload.desi)
    const zpl =
      typeof payload.zpl === 'string' && payload.zpl.trim() ? payload.zpl : null
    const desi = Number.isFinite(desiNum) && desiNum > 0 ? desiNum : null
    return {
      hasPrintableLabel: payload.hasPrintableLabel === true,
      zpl,
      source: payload.source ?? null,
      desi,
      print: normalizeServerPrintContract(payload.print, zpl, desi),
    }
  }

  // Tek ürün sayfası çeker (GET /api/products; server-side pagination, org+aktif
  // hesap kapsamı backend'de). Ham payload localStorage'a YAZILMAZ.
  private async fetchProductsPage(
    page: number,
    pageSize: number,
  ): Promise<{ products: CargoProduct[]; total: number }> {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    const response = await fetch(`/api/products?${params.toString()}`, {
      credentials: 'include',
    })
    if (!response.ok) {
      throw new Error(`Ürünler yüklenemedi (${response.status}).`)
    }
    const payload = (await response.json()) as {
      products?: CargoProduct[]
      total?: number
    }
    const products = Array.isArray(payload.products) ? payload.products : []
    return { products, total: Number(payload.total ?? products.length) }
  }

  // Auth modda sunucudan (GET /api/products) org+aktif-hesap kapsamlı TÜM katalog
  // varyantlarını yükler (resolver/görsel eşleme tam katalog ister). Eski davranış
  // ~60 SERİ istek yapıyordu (sayfa sayfa, her biri öncekini bekliyor) → yavaş.
  // Yeni: ilk sayfayla toplam öğrenilir, kalan sayfalar SINIRLI EŞZAMANLILIKLA
  // (BOUNDED, en fazla 4 paralel) çekilir — sınırsız paralel DEĞİL. Server-side
  // pagination korunur; katalog tam yüklendiğinden görsel eşleme değişmez.
  // İptal/nesil kontrolü ÇAĞIRANDADIR (App mount/account-switch stale sonucu
  // generation ile discard eder; ham payload storage'a yazılmaz).
  async loadProductsFromServer(): Promise<CargoProduct[]> {
    const pageSize = 100
    const CONCURRENCY = 4
    const MAX_PAGES = 1000 // güvenlik: sonsuz döngü koruması
    const first = await this.fetchProductsPage(1, pageSize)
    const total = first.total
    const all: CargoProduct[] = [...first.products]
    const totalPages = Math.min(
      MAX_PAGES,
      Math.max(1, Math.ceil(total / pageSize)),
    )
    // Kalan sayfalar bounded paralel batch'ler halinde.
    for (let start = 2; start <= totalPages; start += CONCURRENCY) {
      const pages: number[] = []
      for (let p = start; p < start + CONCURRENCY && p <= totalPages; p += 1) {
        pages.push(p)
      }
      const batches = await Promise.all(
        pages.map((p) => this.fetchProductsPage(p, pageSize).then((r) => r.products)),
      )
      for (const products of batches) all.push(...products)
      // Beklenenden erken biterse (boş sayfa) dur.
      if (batches.some((products) => products.length === 0)) break
    }
    this.authProductsCache = all
    return all
  }

  setMarketplaceAccount(sellerId: string | number | undefined): boolean {
    const nextScope = normalizeMarketplaceAccountScope(sellerId)
    const changed = nextScope !== this.marketplaceAccountScope
    this.marketplaceAccountScope = nextScope
    if (changed) {
      // Hesap değişti: ESKİ hesabın oturum-içi (in-memory) auth snapshot'ları
      // yeni hesap sunucudan hydrate edilene kadar ekranda KALMAMALI. Storage
      // zaten hesap-kapsamlı anahtar kullanır; auth modda kaynak-of-truth
      // sunucu olduğundan in-memory cache'i de temizleriz (çapraz-hesap sızıntı
      // önlenir).
      this.authOrdersCache = []
      this.authProductsCache = []
      // Nesli artır: bu andan önce başlamış (eski hesap) istekler geç gelirse
      // çağıran tarafından DISCARD edilir. Account-scoped SWR cache tamamen atılır
      // (eski hesap cache'i yeni hesapta ASLA kullanılmaz).
      this.marketplaceAccountGeneration += 1
      this.accountScopedOrdersCache.clear()
      if (nextScope) prepareMarketplaceAccountCaches(nextScope)
    }
    return changed
  }

  // Race-condition koruması: çağıran, bir hesaba özgü isteği başlatmadan önce bu
  // değeri okur; sonuç geldiğinde hâlâ eşitse uygular, değilse (hesap değişmiş)
  // sonucu atar.
  getMarketplaceAccountGeneration(): number {
    return this.marketplaceAccountGeneration
  }

  // Account-scoped SWR: taze (< TTL) cache varsa döner (stale-while-revalidate
  // için anında gösterim), yoksa null. Yalnız aktif hesap nesli için geçerlidir.
  peekCachedOrders(cacheKey = 'default'): CargoOrder[] | null {
    const entry = this.accountScopedOrdersCache.get(cacheKey)
    if (!entry) return null
    if (entry.generation !== this.marketplaceAccountGeneration) return null
    if (Date.now() - entry.at > OrderWorkflowService.ORDERS_CACHE_TTL_MS) return null
    return entry.orders
  }

  private writeOrdersCache(cacheKey: string, orders: CargoOrder[]): void {
    // Bounded LRU: en eski girdiyi düşür.
    if (
      this.accountScopedOrdersCache.size >= OrderWorkflowService.ORDERS_CACHE_MAX_ENTRIES &&
      !this.accountScopedOrdersCache.has(cacheKey)
    ) {
      const oldest = this.accountScopedOrdersCache.keys().next().value
      if (oldest !== undefined) this.accountScopedOrdersCache.delete(oldest)
    }
    this.accountScopedOrdersCache.set(cacheKey, {
      at: Date.now(),
      generation: this.marketplaceAccountGeneration,
      orders,
    })
  }

  // Aktif hesap orders cache'ini geçersizleştir (COMPLETE sync sonrası çağrılır).
  invalidateOrdersCache(): void {
    this.accountScopedOrdersCache.clear()
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
    // Auth modda kaynak-of-truth sunucudur: PII localStorage'a YAZILMAZ,
    // 120 cap uygulanmaz. Yalnız oturum içi in-memory snapshot güncellenir.
    if (this.authMode) {
      this.authOrdersCache = orders
      return orders
    }
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
    // Auth modda localStorage okunmaz; son sunucu snapshot'ı döner.
    if (this.authMode) {
      return this.authOrdersCache
    }
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

  loadProductCatalog(): {
    products: CargoProduct[]
    metadata?: ProductCatalogCacheMetadata
  } {
    // Auth modda IndexedDB/localStorage source-of-truth DEĞİLDİR; son sunucu
    // snapshot'ı (memory cache) döner.
    if (this.authMode) {
      return { products: this.authProductsCache }
    }
    const inMemory = this.productCatalogMemory.get(this.productsStorageKey())
    if (inMemory && isValidProductCatalogCache(inMemory)) {
      return {
        products: enrichStoredProducts(inMemory.products),
        metadata: inMemory.metadata,
      }
    }
    const stored = loadFromStorage<unknown>(this.productsStorageKey(), null)
    if (!isValidProductCatalogCache(stored)) {
      return { products: [] }
    }
    const products = enrichStoredProducts(stored.products)
    if (products.length !== stored.metadata.actualCount) {
      return { products: [] }
    }
    return { products, metadata: stored.metadata }
  }

  async hydrateProductCatalog(): Promise<{
    products: CargoProduct[]
    metadata?: ProductCatalogCacheMetadata
  }> {
    // Auth modda katalog sunucudan yüklenir (IndexedDB'den değil); eski
    // IndexedDB/localStorage kataloğu otomatik import EDİLMEZ/SİLİNMEZ.
    if (this.authMode) {
      const products = await this.loadProductsFromServer().catch(() => [])
      return { products }
    }
    const key = this.productsStorageKey()
    const persisted = await loadPersistedProductCatalog(key).catch(() => null)
    if (isValidProductCatalogCache(persisted)) {
      this.productCatalogMemory.set(key, persisted)
      return {
        products: enrichStoredProducts(persisted.products),
        metadata: persisted.metadata,
      }
    }
    const localCatalog = this.loadProductCatalog()
    if (localCatalog.metadata) {
      const envelope = {
        products: localCatalog.products,
        metadata: localCatalog.metadata,
      }
      this.productCatalogMemory.set(key, envelope)
      await savePersistedProductCatalog(key, envelope).catch(() => undefined)
      window.localStorage.removeItem(key)
    }
    return localCatalog
  }

  loadProducts(): CargoProduct[] {
    return this.loadProductCatalog().products
  }

  private async saveCompleteProductCatalog(
    products: CargoProduct[],
    metadata: ProductCatalogCacheMetadata,
  ): Promise<void> {
    const key = this.productsStorageKey()
    const persistedProducts = products.map(compactProductForCache)
    const persistedEnvelope: ProductCatalogCacheEnvelope = {
      metadata,
      products: persistedProducts,
    }
    await savePersistedProductCatalog(key, persistedEnvelope)
    this.productCatalogMemory.set(key, { metadata, products })
    window.localStorage.removeItem(key)
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
    if (this.authMode) {
      return this.fetchOrdersAuthMode(options)
    }
    this.setMarketplaceAccount(config.trendyol.sellerId)
    const response = await this.marketplaceProvider.fetchOrders({
      credentials: config.trendyol,
      size: 200,
      statuses: options.statuses,
      startDate: options.startDate,
      endDate: options.endDate,
    })
    if (response.complete === false) {
      const existingOrders = this.loadOrders()
      this.auditLogService.append({
        action: 'Siparişler çekildi',
        level: 'warning',
        details: `${response.message} Mevcut tam operasyon listesi korunuyor.`,
      })
      return {
        orders: existingOrders,
        result: {
          level: 'warning',
          source: response.source,
          message: `${response.message} Kısmi/başarısız sonuç kaydedilmedi; mevcut ${existingOrders.length} paket korundu.`,
          debug: response.debug,
        },
      }
    }
    const syncBatchAt = new Date().toISOString()
    let nextOrders = mergeOrdersWithLocalState(
      response.orders.map((order) =>
        markOrderAsSeenInSyncBatch(withDerivedOperationStatus(order), syncBatchAt),
      ),
      this.loadOrders(),
    )
    // TANI LOGU YALNIZ GELISTIRMEDE.
    //
    // Bu satir legacy (tek-tenant) sync yolundadir ve normalizasyon
    // ayrintilarini yazar. Uretim konsoluna siparis ayrintisi dokmek, ayni
    // dosyadaki PERF_ORDERS_LOAD izinin DEV kapisiyla da CELISIYORDU.
    if (
      response.debug &&
      typeof import.meta !== 'undefined' &&
      import.meta.env?.DEV
    ) {
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

  // AUTH modu sipariş çekme: sunucudaki Sürat/Trendyol sync'i tetikler (org
  // credential DB'den enjekte edilir; frontend credential GÖNDERMEZ), sonra
  // kaynak-of-truth PostgreSQL'den yeniden yükler. KISMİ/başarısız sync
  // mevcut siparişleri SİLMEZ; sunucu reconcile yalnız tam sync'te arşivler.
  private async fetchOrdersAuthMode(
    options: {
      statuses?: MarketplaceStatus[]
      startDate?: Date
      endDate?: Date
    } = {},
  ): Promise<{ orders: CargoOrder[]; result: WorkflowResult }> {
    const query: Record<string, unknown> = {}
    if (options.statuses && options.statuses.length > 0) {
      query.statuses = options.statuses
    }
    if (options.startDate) query.startDate = options.startDate.getTime()
    if (options.endDate) query.endDate = options.endDate.getTime()

    let syncPayload: {
      ok?: boolean
      code?: string
      complete?: boolean
      partial?: boolean
      syncStatus?: string
      successfulStatuses?: string[]
      failedStatuses?: Array<{ status?: string; httpStatus?: number | null; retryable?: boolean }>
      message?: string
      insertedCount?: number
      updatedCount?: number
      persistedCount?: number
      failedCount?: number
    } = {}
    let syncOk = false
    // 409: aynı org için başka bir sync zaten çalışıyor (backend org kilidi).
    // Veri kaybı yok; mevcut liste korunur, bilgilendirici mesaj gösterilir.
    let syncInProgress = false
    try {
      const response = await fetch('/api/orders/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query }),
      })
      syncPayload = (await response.json().catch(() => ({}))) as typeof syncPayload
      syncOk = response.ok && syncPayload.ok === true
      syncInProgress = response.status === 409 || syncPayload.code === 'sync_in_progress'
    } catch (error) {
      syncPayload = {
        ok: false,
        message:
          error instanceof Error ? error.message : 'Sunucu senkronu erişilemedi.',
      }
    }

    // ═══ SYNC SONRASI TAM LİSTE İNDİRİLMEZ ══════════════════════════════
    //
    // Eskiden burada `loadOrdersFromServer()` çağrılır ve TÜM sipariş tablosu
    // 100'erlik sayfalarla tarayıcıya indirilirdi. Kullanıcı "Şimdi Yenile"ye
    // her bastığında ~100 HTTP turu oluşuyor, 20k üstünde ise sync başarılı
    // olsa bile ekran AÇIK hata veriyordu.
    //
    // Mesajlarda gösterilen tek şey KALICI KAYIT SAYISIDIR; onu öğrenmek için
    // tek bir sayfa (pageSize=1) yeterlidir. Görünür liste zaten sunucu
    // tarafı çalışma alanı sorgusuyla tazelenir.
    const total = await this
      .fetchOrdersTotal()
      .catch(() => this.authOrdersCache.length)
    // Geriye dönük sözleşme: `orders` alanı korunur. Auth modunda çağıran
    // (App) bu diziyi KULLANMAZ; çalışma alanı sayfasını yeniden çeker.
    const orders = this.authOrdersCache

    if (syncInProgress) {
      // Zaten çalışan sync veri silmez; kullanıcıya beklemesini bildir.
      this.auditLogService.append({
        action: 'Siparişler çekildi',
        level: 'info',
        details: `Senkronizasyon zaten sürüyor; ${total} sipariş kayıtlı.`,
      })
      return {
        orders,
        result: {
          level: 'info',
          source: 'real',
          message: `Bu hesap için bir senkronizasyon zaten çalışıyor. Kayıtlı ${total} sipariş korunuyor; tamamlanınca "Yenile" ile listeyi güncelleyin.`,
        },
      }
    }

    if (!syncOk) {
      // KISMİ (HTTP 207) senkron: bazı statüler başarılı, bazıları başarısız.
      // Tarayıcıda 502 OLUŞMAZ (2xx). Başarılı statülerin içeriği tazelendi,
      // hiçbir kayıt silinmedi/arşivlenmedi. Kullanıcıya hangi statülerin
      // başarısız olduğunu (ve yeniden denenebilir mi) bildir.
      const partial = syncPayload.partial === true || syncPayload.syncStatus === 'PARTIAL'
      const successfulStatuses = syncPayload.successfulStatuses ?? []
      const failedStatuses = syncPayload.failedStatuses ?? []
      const failedLabel = failedStatuses
        .map((entry) => {
          const retry = entry.retryable ? ' — yeniden denenebilir' : ''
          return `${entry.status ?? 'bilinmeyen'}${retry}`
        })
        .join(', ')
      const statusSummary = partial
        ? ` Başarılı statüler: ${successfulStatuses.join(', ') || '—'}. Başarısız statüler: ${failedLabel || '—'}.`
        : ''
      this.auditLogService.append({
        action: 'Siparişler çekildi',
        level: 'warning',
        details: `${syncPayload.message ?? 'Senkron tamamlanamadı.'}${statusSummary} Kayıtlı ${total} sipariş korunuyor.`,
      })
      return {
        orders,
        result: {
          level: 'warning',
          source: 'real',
          message: `${
            partial ? 'Senkron kısmi kaldı.' : syncPayload.message ?? 'Senkron tamamlanamadı.'
          }${statusSummary} Sunucu kaydı silinmedi; ${total} sipariş korundu.`,
        },
      }
    }

    this.auditLogService.append({
      action: 'Siparişler çekildi',
      level: 'success',
      details: `Sunucu senkronu tamamlandı: ${syncPayload.insertedCount ?? 0} yeni, ${syncPayload.updatedCount ?? 0} güncellendi. Toplam ${total} sipariş.`,
    })
    return {
      orders,
      result: {
        level: total > 0 ? 'success' : 'warning',
        source: 'real',
        message: `Sunucu senkronu tamamlandı (${syncPayload.persistedCount ?? 0} kaydedildi, ${syncPayload.failedCount ?? 0} başarısız). Kalıcı operasyon listesi: ${total}.`,
      },
    }
  }

  // AUTH modu ürün çekme: sunucudaki Trendyol ürün sync'ini tetikler (org
  // credential DB'den enjekte edilir; frontend credential GÖNDERMEZ), sonra
  // kaynak-of-truth PostgreSQL'den TÜM kataloğu yeniden yükler. Raw payload
  // IndexedDB/localStorage'a YAZILMAZ. KISMİ/başarısız sync katalogu SİLMEZ.
  private async fetchProductsAuthMode(): Promise<{
    products: CargoProduct[]
    result: WorkflowResult
  }> {
    let syncPayload: {
      ok?: boolean
      complete?: boolean
      message?: string
      insertedProducts?: number
      updatedProducts?: number
      insertedVariants?: number
      updatedVariants?: number
      fetchedVariantCount?: number
    } = {}
    let syncOk = false
    try {
      const response = await fetch('/api/products/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      })
      syncPayload = (await response.json().catch(() => ({}))) as typeof syncPayload
      syncOk = response.ok && syncPayload.ok === true
    } catch (error) {
      syncPayload = {
        ok: false,
        message:
          error instanceof Error ? error.message : 'Sunucu ürün senkronu erişilemedi.',
      }
    }

    const products = await this.loadProductsFromServer().catch(
      () => this.authProductsCache,
    )

    if (!syncOk) {
      this.auditLogService.append({
        action: 'Ürünler çekildi',
        level: 'warning',
        details: `${syncPayload.message ?? 'Ürün senkronu tamamlanamadı.'} Mevcut ${products.length} ürün korunuyor.`,
      })
      return {
        products,
        result: {
          level: 'error',
          source: 'real',
          message: `${syncPayload.message ?? 'Ürün senkronu tamamlanamadı.'} Kısmi/başarısız sonuç sunucu kataloğunu değiştirmedi; ${products.length} ürün korundu.`,
        },
      }
    }

    this.auditLogService.append({
      action: 'Ürünler çekildi',
      level: 'success',
      details: `Sunucu ürün senkronu tamamlandı: ${syncPayload.insertedProducts ?? 0} yeni ürün, ${syncPayload.insertedVariants ?? 0} yeni varyant. Toplam ${products.length} varyant.`,
    })
    return {
      products,
      result: {
        level: products.length > 0 ? 'success' : 'warning',
        source: 'real',
        message: `Sunucu ürün senkronu tamamlandı (${syncPayload.fetchedVariantCount ?? products.length} varyant işlendi). Katalog: ${products.length}.`,
      },
    }
  }

  async fetchProducts(
    config: IntegrationConfig,
  ): Promise<{ products: CargoProduct[]; result: WorkflowResult }> {
    if (this.authMode) {
      return this.fetchProductsAuthMode()
    }
    this.setMarketplaceAccount(config.trendyol.sellerId)
    const cachedCatalog = this.loadProductCatalog()
    const response = await this.marketplaceProvider.fetchProducts(config.trendyol)
    const expectedTotal = Number(
      response.debug?.expectedTotal ?? response.products.length,
    )
    const dedupedProducts = dedupeProductsByVariantIdentity(response.products)
    const nextProducts = mergeProductsWithCache(
      dedupedProducts,
      cachedCatalog.products,
    )
    const completenessRatio =
      expectedTotal > 0
        ? nextProducts.length / expectedTotal
        : nextProducts.length === 0
          ? 1
          : 0
    const complete =
      response.debug?.status === 'COMPLETE' &&
      completenessRatio >= MIN_COMPLETE_CATALOG_RATIO
    const now = new Date().toISOString()
    const catalogRevision = buildProductCatalogRevision(nextProducts, now)
    const debug: TrendyolProductSyncDebug = {
      expectedTotal,
      fetchedCount: Number(
        response.debug?.fetchedCount ?? response.products.length,
      ),
      rawApiRecordsCount: Number(
        response.debug?.rawApiRecordsCount ?? response.products.length,
      ),
      normalizedProductsCount: response.products.length,
      afterDedupCount: dedupedProducts.length,
      afterMergeCount: nextProducts.length,
      persistedProductsCount: complete
        ? nextProducts.length
        : cachedCatalog.products.length,
      productsStoreCount: complete
        ? nextProducts.length
        : cachedCatalog.products.length,
      fetchedPages: Number(response.debug?.fetchedPages ?? 0),
      expectedPages: Number(response.debug?.expectedPages ?? 0),
      failedPages: response.debug?.failedPages ?? [],
      requestedPageSize: Number(response.debug?.requestedPageSize ?? 200),
      responsePageSize: Number(response.debug?.responsePageSize ?? 200),
      uniqueBarcodeCount: countUniqueProductsByField(
        nextProducts,
        'barcode',
      ),
      uniqueProductContentIdCount: countUniqueProductsByField(
        nextProducts,
        'productContentId',
      ),
      uniqueProductMainIdCount: countUniqueProductsByField(
        nextProducts,
        'productMainId',
      ),
      uniqueExternalVariantIdCount: countUniqueProductsByField(
        nextProducts,
        'externalVariantId',
      ),
      uniqueVariantCount: new Set(
        nextProducts.map(productVariantIdentity).filter(Boolean),
      ).size,
      completenessRatio: Math.min(completenessRatio, 1),
      status: complete ? 'COMPLETE' : response.debug?.status ?? 'FAILED',
      pages: response.debug?.pages,
      targetTraces: [
        ...(response.debug?.targetTraces ?? []),
        ...traceClientCatalogTargets('client-merged', nextProducts),
      ],
      cachePreserved: !complete && cachedCatalog.products.length > 0,
      rejectionReason: complete
        ? undefined
        : response.debug?.rejectionReason ??
          `Katalog tamlık oranı ${(completenessRatio * 100).toFixed(2)}%; tam cache eşiği %99.`,
      lastSuccessfulFullSyncAt: complete
        ? now
        : cachedCatalog.metadata?.lastSuccessfulFullSyncAt,
      schemaVersion: PRODUCT_CACHE_SCHEMA_VERSION,
      catalogRevision: complete
        ? catalogRevision
        : cachedCatalog.metadata?.catalogRevision,
      backendBuildRevision: response.debug?.backendBuildRevision,
      frontendBuildRevision: FRONTEND_BUILD_REVISION,
      revisionMismatch: buildRevisionMismatch(
        FRONTEND_BUILD_REVISION,
        response.debug?.backendBuildRevision,
      ),
    }

    if (complete) {
      await this.saveCompleteProductCatalog(nextProducts, {
        schemaVersion: PRODUCT_CACHE_SCHEMA_VERSION,
        catalogRevision,
        syncStatus: 'COMPLETE',
        expectedTotal,
        actualCount: nextProducts.length,
        completenessRatio: Math.min(completenessRatio, 1),
        lastSuccessfulFullSyncAt: now,
        backendBuildRevision: response.debug?.backendBuildRevision,
        frontendBuildRevision: FRONTEND_BUILD_REVISION,
      })
    }
    const visibleProducts = complete ? nextProducts : cachedCatalog.products
    this.auditLogService.append({
      action: 'Ürünler çekildi',
      level: complete ? 'success' : 'warning',
      details:
        complete
          ? `${nextProducts.length}/${expectedTotal} ürün varyantı tam katalog olarak yüklendi. Kaynak: Gerçek API.`
          : `${response.products.length}/${expectedTotal} ürün alındı; kısmi katalog kaydedilmedi${cachedCatalog.products.length > 0 ? `, ${cachedCatalog.products.length} kayıtlı tam katalog korundu` : ''}.`,
    })

    return {
      products: visibleProducts,
      result: {
        level: complete ? 'success' : 'error',
        source: response.source,
        message: complete
          ? `${nextProducts.length}/${expectedTotal} ürün varyantı tam katalog olarak yüklendi. ${response.message}`
          : `${response.message} Kısmi sonuç ana ürün kataloğunu değiştirmedi.`,
        productSyncDebug: debug,
      },
    }
  }

  // Etiket-hazır canonical durumunu (LABEL_READY) DB'ye KALICI yazar. Backend
  // siparişin gerçek Sürat gönderisi olduğunu doğrular ve operationStatus'ü atomik
  // günceller; yeni shipment/barkod OLUŞTURMAZ (idempotency korunur, duplicate
  // barkod riski yoktur). Legacy modda no-op (localStorage zaten persistOrders ile
  // yazılır). Başarısızlıkta hata FIRLATIR → çağıran optimistic başarıyı geri alır.
  async persistLabelReady(orderId: string): Promise<void> {
    if (!this.authMode) return
    const id = String(orderId ?? '').trim()
    if (!id) return
    const response = await fetch(
      `/api/orders/${encodeURIComponent(id)}/label-ready`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      },
    )
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      message?: string
    }
    if (!response.ok || payload?.ok !== true) {
      throw new Error(
        String(payload?.message ?? 'Etiket durumu sunucuya kaydedilemedi.'),
      )
    }
  }

  // Kullanıcı Yazdır/Tekrar Yazdır aksiyonunu başarıyla başlattığında canonical
  // LABEL_PRINTED durumunu DB'ye KALICI yazar (idempotent + no-regress). Yeni
  // shipment/barkod OLUŞTURMAZ; Sürat create servisini ÇAĞIRMAZ. Legacy modda
  // no-op (localStorage zaten persistOrders ile yazılır). Backend LABEL_READY
  // değilse 409 döner; bu durumda sessiz geçilir (yazdırma zaten yapılmıştır,
  // durum eski akıştaki gibi optimistic in-memory korunur).
  async persistLabelPrinted(orderId: string): Promise<void> {
    if (!this.authMode) return
    const id = String(orderId ?? '').trim()
    if (!id) return
    const response = await fetch(
      `/api/orders/${encodeURIComponent(id)}/label-printed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      },
    )
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      message?: string
    }
    if (!response.ok || payload?.ok !== true) {
      throw new Error(
        String(payload?.message ?? 'Etiket baskı durumu sunucuya kaydedilemedi.'),
      )
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
        // MERKEZİ KURAL: yazdırılabilir ZPL/etiket varsa (printEnabled/zplReady)
        // etiket hazırdır — Sürat T.No/barkod parse edilmese bile. Fiziksel Sürat
        // kabulü (SDP) CargoFlow tarafından beklenmez, LABEL_READY'i engellemez.
        const preassignedAwaiting = Boolean(
          shipment.printEnabled === true &&
            (shipment.lifecycleStatus === 'LABEL_READY_AWAITING_ACCEPTANCE' ||
              shipment.candidateVerificationStatus ===
                'PREASSIGNED_AWAITING_ACCEPTANCE' ||
              shipment.zplReady === true ||
              Boolean(shipment.barcodeRaw)),
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
          'Etiket başarıyla oluşturuldu ve yazdırmaya hazır.'
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
          level: liveBarcodeReady || preassignedAwaiting
            ? 'success'
            : legacyPreRegistration ||
                createUncertain ||
                barcodeFailed ||
                technicalZplOnly ||
                dispatchRejected
              ? 'warning'
              : 'success',
          details: preassignedAwaiting
            ? `Etiket başarıyla oluşturuldu ve yazdırmaya hazır.${
                shipment.tNo || shipment.trackingNumber
                  ? ` T.No ${shipment.tNo || shipment.trackingNumber}`
                  : ''
              }${
                shipment.barkodNo || shipment.barcode
                  ? `, Barkod ${shipment.barkodNo || shipment.barcode}`
                  : ''
              }.`
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

    // AUTH modu: "Etiket Hazır" canonical durumunu DB'ye KALICI yaz. persistOrders
    // yalnız in-memory snapshot günceller; sayfa yenilenince (DB re-read) korunması
    // için backend'e yazılmalı. Durum backend tarafından doğrulanır (yalnız local
    // state değişimi başarı sayılmaz). Persist başarısızsa optimistic "Etiket Hazır"
    // GERİ ALINIR ve gerçek hata yüzeye çıkar.
    if (this.authMode) {
      // Etiket-hazır adayları: create bu tur LABEL_READY yaptı VEYA (tekrar deneme)
      // mevcut doğrulanmış/ön-atanmış printable gönderi zaten var. markLabelReady
      // yeni shipment/barkod OLUŞTURMAZ; retry mevcut gönderi üzerinden yalnız
      // canonical durumu onarır (idempotent + no-regress). Böylece persist
      // hatasından sonra tekrar deneme, provider create'i YENİDEN tetiklemeden
      // state repair yapabilir. Zaten basılmış/kargoda/teslim (printed-or-beyond)
      // siparişlere DOKUNULMAZ.
      const printedOrBeyond = new Set([
        'LABEL_PRINTED',
        'SHIPPED',
        'HANDED_TO_CARGO',
        'DELIVERED',
        'DELIVERED_SPECIAL',
        'RETURNING',
      ])
      const repairTargets = nextOrders.filter(
        (candidate) =>
          selectedIds.includes(candidate.id) &&
          !printedOrBeyond.has(String(candidate.operationStatus)) &&
          (candidate.operationStatus === 'LABEL_READY' ||
            resolveSuratPrintEligibility(candidate).canPrint),
      )
      for (const target of repairTargets) {
        const wasFreshReady = target.operationStatus === 'LABEL_READY'
        try {
          await this.persistLabelReady(target.id)
          // Persist DB tarafından doğrulandı: retry-repair'de yerel durumu da
          // canonical LABEL_READY'ye getir (önceki 'Hata'/UNVERIFIED'dan).
          if (!wasFreshReady) {
            nextOrders = replaceOrder(nextOrders, {
              ...target,
              status: 'Etiket Hazır',
              operationStatus: 'LABEL_READY',
              printEnabled: true,
              errorMessage: undefined,
            })
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : 'Etiket durumu sunucuya kaydedilemedi.'
          // Yalnız local state değişimi başarı sayılmaz: persist başarısızsa
          // optimistic "Etiket Hazır" GERİ ALINIR ve gerçek hata gösterilir.
          nextOrders = replaceOrder(nextOrders, {
            ...target,
            status: 'Hata',
            operationStatus: 'LABEL_CREATED_UNVERIFIED',
            printEnabled: false,
            errorMessage: `Etiket hazır durumu kaydedilemedi: ${message}`,
          })
          if (wasFreshReady) {
            successCount = Math.max(0, successCount - 1)
          }
          failedBarcodeCount += 1
          if (!failedOrderNumbers.includes(target.orderNumber)) {
            failedOrderNumbers.push(target.orderNumber)
          }
          this.auditLogService.append({
            action: 'Gönderi oluşturuldu',
            level: 'error',
            details: `${target.orderNumber}: etiket hazır durumu DB'ye yazılamadı; durum korunmadı. ${message}`,
            orderNumber: target.orderNumber,
          })
        }
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
            ? `${failedBarcodeCount} siparişte Sürat etiketi oluşturulamadı (yazdırılabilir ZPL alınamadı veya gönderi reddedildi). Etiket basılamaz.`
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
        desiConfig: this.tenantDesiConfig,
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
        desiConfig: this.tenantDesiConfig,
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
      // Kiracinin YAYINLADIGI yerlesim belgesi (CargoFlow HTML etiketi).
      labelDocument?: LabelDocument
      // Bu çalışmada kullanılacak şablon; karar UI'daki TEK çözümleyiciden
      // (resolveLabelPrintTemplateDecision) gelir.
      labelPrintTemplate?: LabelPrintTemplate
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
    // ŞABLON KARARI, ŞABLONA ÖZEL İÇERİK KOŞULLARINDAN ÖNCE VERİLİR.
    //
    // KÖK NEDEN (canlı, READY Sürat siparişi + "Resmî Sürat Şablonuyla Yazdır"):
    // aşağıdaki iki adım CargoFlow HTML/ZPL yoluna AİT ön koşullardır ve
    // şablondan bağımsız uygulanıyordu:
    //   (1) resolveSuratPrintEligibility — istemcideki ham ZPL / canonical HTML
    //       alan tamlığını arar,
    //   (2) labelProvider.generateSingle — CargoFlow etiketini ÜRETİR (ham ZPL
    //       bulunmayan kayıtta FIRLATIR).
    // Resmî Sürat modunda baskı içeriği sunucudaki KAYITLI printZpl'den PNG
    // olarak gelir; bu iki koşulun hiçbiri gerekmez. Uygulandıklarında sipariş
    // /api/labels/render/surat HİÇ çağrılmadan eleniyordu.
    const officialSuratTemplate =
      options.labelPrintTemplate === 'surat_official_zpl'
    const candidates = selected.filter((order) => {
      const alreadyPrinted =
        order.labelStatus === 'PRINTED' && Boolean(order.label?.printedAt)
      if (!officialSuratTemplate) {
        const eligibility = resolveSuratPrintEligibility(order)
        if (!eligibility.canPrint) {
          skippedWithReasons.push({
            orderNumber: order.orderNumber,
            reason: eligibility.reason,
          })
          return false
        }
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
      if (officialSuratTemplate) {
        // Resmî modda CargoFlow HTML/ZPL etiketi ÜRETİLMEZ. Baskı geçmişi ve
        // printCount sözleşmesi için taşıyıcı bir etiket kaydı gerekir; kayıt
        // varsa AYNEN korunur, yoksa ham ZPL TAŞIMAYAN boş bir taşıyıcı
        // kullanılır (istemciye ham ZPL inmez).
        printableOrders.push({
          ...order,
          label: order.label ?? {
            id: `surat-official-${order.id}`,
            labelType: 'zpl',
            barcodeFormat: 'Code128',
            barcodeValue: '',
            templateId: template?.id ?? '',
            zplContent: '',
            createdAt: requestedAt,
          },
        })
        continue
      }
      const shipment = resolveShipmentForLabel(order)
      if (!shipment) continue
      const label = await this.labelProvider.generateSingle({
        order,
        shipment,
        template,
        mappingConfig,
        desiConfig: this.tenantDesiConfig,
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
      labelPrintTemplate: options.labelPrintTemplate,
      // Kiracinin YAYINLADIGI yerlesim belgesi (varsa).
      labelDocument: options.labelDocument,
      // Etiket renk/beden tamamlama icin organizasyon kapsamli katalog.
      products: this.loadProducts(),
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
        // KOK NEDEN (canli debug): bu tani kaydi HER basari-sizlikta
        // "/api/printing/zebra/raw" ve "Zebra Yazdir" olarak yaziliyordu.
        // Tarayici baskisinda HICBIR HTTP cagrisi yapilmadigi halde debug
        // bandinda gercek bir Zebra istegi varmis gibi gorunuyordu.
        // Artik kayit GERCEK saglayiciya gore etiketlenir.
        const isZebraPath = printerSettings.mode === 'local-agent'
        apiDebugService.append({
          provider: 'Sürat',
          operation: isZebraPath ? 'Zebra Yazdır' : 'Tarayıcı Baskısı',
          endpoint: isZebraPath
            ? '/api/printing/zebra/raw'
            : 'browser-print (HTTP çağrısı yok)',
          requestUrl: isZebraPath
            ? '/api/printing/zebra/raw'
            : 'browser-print (HTTP çağrısı yok)',
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
            'Etiket yazdırılamadı.',
          errorSource: 'Frontend',
        })
      }
      if (successfulPrintableOrders.length === 0) {
        return {
          orders,
          result: {
            level: 'error',
            // PROVIDER-BAGIMSIZ baslik + TEK sebep (tekrar yok).
            message: `Etiket yazdırılamadı. Etiket durumu değiştirilmedi. ${
              printResult.jobs?.find((job) => job.ok !== true)?.errorMessage ??
              printResult.errorMessage ??
              ''
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
          ? `Etiket tekrar baskıya gönderildi. Toplam baskı: ${printCount}.`
          : 'Etiket baskıya gönderildi.',
        orderNumber: currentOrder.orderNumber,
      })
    }
    this.persistOrders(nextOrders)
    // Auth modda canonical LABEL_PRINTED durumunu DB'ye KALICI yaz (idempotent +
    // no-regress; yeni shipment/barkod OLUŞMAZ, provider ÇAĞRILMAZ). Sayfa
    // yenilemesinde "Etiket Basıldı" korunur. Persistence hatası baskıyı geçersiz
    // KILMAZ (baskı zaten yapıldı); optimistic in-memory durum korunur.
    if (this.authMode) {
      for (const printedOrder of successfulPrintableOrders) {
        try {
          await this.persistLabelPrinted(printedOrder.id)
        } catch {
          // yut: baskı başarılı; DB persistence en fazla bir sonraki senkronda düzelir.
        }
      }
    }
    return {
      orders: nextOrders,
      result: {
        level:
          failedPrintableOrders.length > 0 || skippedWithReasons.length > 0
            ? 'warning'
            : 'success',
        message: `${
          failedPrintableOrders.length > 0
            ? `${successfulPrintableOrders.length} etiket baskıya gönderildi, ${failedPrintableOrders.length} etiket gönderilemedi. Başarısız etiketlerin durumu değiştirilmedi.`
            : successfulPrintableOrders.some(
                  (order) => order.labelStatus === 'PRINTED',
                )
              ? `${successfulPrintableOrders.length} etiket tekrar baskıya gönderildi.`
              : `${successfulPrintableOrders.length} etiket baskıya gönderildi.`
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

function normalizedProductIdentityValue(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('tr-TR')
}

export function productVariantIdentity(product: CargoProduct): string {
  const barcode = normalizedProductIdentityValue(product.barcode)
  const externalVariantId = normalizedProductIdentityValue(
    product.externalVariantId,
  )
  if (barcode && externalVariantId) {
    return `bc:${barcode}|ext:${externalVariantId}`
  }
  if (externalVariantId) return `ext:${externalVariantId}`
  if (barcode) return `bc:${barcode}`
  const productCode = normalizedProductIdentityValue(product.productCode)
  const color = normalizedProductIdentityValue(product.color)
  const size = normalizedProductIdentityValue(product.size)
  if (productCode || color || size) {
    return `variant:${productCode}|${color}|${size}`
  }
  const contentId = normalizedProductIdentityValue(product.productContentId)
  if (contentId) return `content:${contentId}`
  const externalProductId = normalizedProductIdentityValue(
    product.externalProductId,
  )
  return externalProductId ? `product:${externalProductId}` : ''
}

export function dedupeProductsByVariantIdentity(
  products: CargoProduct[],
): CargoProduct[] {
  const result: CargoProduct[] = []
  const indexByIdentity = new Map<string, number>()
  for (const product of products) {
    const identity = productVariantIdentity(product) || `row:${result.length}`
    const index = indexByIdentity.get(identity)
    if (index == null) {
      indexByIdentity.set(identity, result.length)
      result.push(product)
      continue
    }
    const existing = result[index]
    result[index] = {
      ...existing,
      ...product,
      imageUrl: product.imageUrl || existing.imageUrl,
      productImageUrl: product.productImageUrl || existing.productImageUrl,
      images:
        product.images && product.images.length > 0
          ? product.images
          : existing.images,
    }
  }
  return result
}

export function mergeProductsWithCache(
  freshProducts: CargoProduct[],
  cachedProducts: CargoProduct[],
): CargoProduct[] {
  const cachedByIdentity = new Map(
    cachedProducts
      .map((product) => [productVariantIdentity(product), product] as const)
      .filter(([identity]) => Boolean(identity)),
  )
  return dedupeProductsByVariantIdentity(freshProducts).map((fresh) => {
    const cached = cachedByIdentity.get(productVariantIdentity(fresh))
    if (!cached) return fresh
    return {
      ...cached,
      ...fresh,
      imageUrl: fresh.imageUrl || cached.imageUrl,
      productImageUrl: fresh.productImageUrl || cached.productImageUrl,
      images:
        fresh.images && fresh.images.length > 0
          ? fresh.images
          : cached.images,
    }
  })
}

function countUniqueProductsByField(
  products: CargoProduct[],
  field: keyof CargoProduct,
): number {
  return new Set(
    products
      .map((product) => normalizedProductIdentityValue(product[field]))
      .filter(Boolean),
  ).size
}

function traceClientCatalogTargets(
  stage: string,
  products: CargoProduct[],
): NonNullable<TrendyolProductSyncDebug['targetTraces']> {
  return ['kkkıasdasdasd14', 'SCUBA-SEC0115', 'eftal56879-2'].map(
    (query) => {
      const normalizedQuery = normalizedProductIdentityValue(query)
      const matches = products.filter((product) =>
        [
          product.barcode,
          product.sku,
          product.stockCode,
          product.productCode,
          product.productMainId,
          product.productName,
        ].some((value) =>
          normalizedProductIdentityValue(value).includes(normalizedQuery),
        ),
      )
      const product = matches[0]
      return {
        stage,
        query,
        found: matches.length > 0,
        recordCount: matches.length,
        barcode: product?.barcode,
        productMainId: product?.productMainId,
        productCode: product?.productCode,
        color: product?.color,
        size: product?.size,
        imageCandidates: product?.images ??
          (product?.imageUrl ? [product.imageUrl] : []),
      }
    },
  )
}

function buildProductCatalogRevision(
  products: CargoProduct[],
  syncedAt: string,
): string {
  return `${syncedAt}:${products.length}:${new Set(
    products.map(productVariantIdentity).filter(Boolean),
  ).size}`
}

function compactProductForCache(product: CargoProduct): CargoProduct {
  const primaryImage =
    product.imageUrl || product.productImageUrl || product.images?.[0] || ''
  return {
    ...product,
    imageUrl: primaryImage,
    productImageUrl: primaryImage,
    images: primaryImage ? [primaryImage] : [],
  }
}

export function isValidProductCatalogCache(
  value: unknown,
): value is ProductCatalogCacheEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const envelope = value as Partial<ProductCatalogCacheEnvelope>
  const metadata = envelope.metadata
  if (!metadata || !Array.isArray(envelope.products)) return false
  return Boolean(
    metadata.schemaVersion === PRODUCT_CACHE_SCHEMA_VERSION &&
      metadata.syncStatus === 'COMPLETE' &&
      metadata.completenessRatio >= MIN_COMPLETE_CATALOG_RATIO &&
      metadata.actualCount === envelope.products.length &&
      metadata.expectedTotal > 0,
  )
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
  const maps = {
    package: new Map<string, CargoOrder>(),
    orderNumberWithoutPackage: new Map<string, CargoOrder>(),
    weakIdWithoutPackage: new Map<string, CargoOrder>(),
  }
  orders.forEach((order) => addOrderToMergeMaps(order, maps))
  return maps
}

function findMatchingOrder(
  order: CargoOrder,
  maps: ReturnType<typeof buildOrderMergeMaps>,
): CargoOrder | undefined {
  const packageCandidates = orderPackageIdentityCandidates(order)
  if (packageCandidates.length > 0) {
    for (const candidate of packageCandidates) {
      const match = maps.package.get(candidate)
      if (match) return match
    }
    // Paket kimliği bulunan kayıtlar orderNumber/externalOrderId ile asla
    // birleştirilmez. Aynı sipariş numarası birden fazla pakete bölünebilir.
    return undefined
  }

  const orderNumber = String(order.orderNumber ?? '').trim()
  if (orderNumber) {
    return maps.orderNumberWithoutPackage.get(orderNumberIdentity(order))
  }

  return maps.weakIdWithoutPackage.get(weakOrderIdentity(order))
}

function deduplicateOrders(orders: CargoOrder[]): CargoOrder[] {
  const maps = buildOrderMergeMaps([])
  const result: CargoOrder[] = []
  for (const order of orders) {
    if (findMatchingOrder(order, maps)) continue
    result.push(order)
    addOrderToMergeMaps(order, maps)
  }
  return result
}

function addOrderToMergeMaps(
  order: CargoOrder,
  maps: ReturnType<typeof buildOrderMergeMaps>,
): void {
  const packageCandidates = orderPackageIdentityCandidates(order)
  if (packageCandidates.length > 0) {
    packageCandidates.forEach((candidate) => maps.package.set(candidate, order))
    return
  }

  if (String(order.orderNumber ?? '').trim()) {
    maps.orderNumberWithoutPackage.set(orderNumberIdentity(order), order)
    return
  }

  maps.weakIdWithoutPackage.set(weakOrderIdentity(order), order)
}

function weakOrderIdentity(order: CargoOrder): string {
  const marketplace = String(order.marketplace ?? '').trim().toLocaleLowerCase('tr-TR')
  const value = String(order.externalOrderId || order.id || '').trim().toLocaleLowerCase('tr-TR')
  return `${marketplace}:record:${value}`
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
