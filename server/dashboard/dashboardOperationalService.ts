// DASHBOARD OPERASYON ANLIK GÖRÜNTÜSÜ — sunucu tarafı.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
// Dashboard'ın operasyon sayaçları, aksiyon listesi, toplama listesi ve son
// operasyonları TÜM tenant siparişlerini ister (dönemle daraltılmaz). Bu
// yüzden tarayıcı açılışta sipariş tablosunun TAMAMINI indiriyordu.
//
// ═══ NEDEN CEVAPLAR DEĞİŞMEZ ═════════════════════════════════════════════
// Burada hiçbir metrik SQL'de YENİDEN YAZILMADI. Sunucu, istemcinin
// kullandığı AYNI `buildDashboardViewModel` fonksiyonunu tam sipariş kümesi
// ve tam ürün kataloğuyla çağırır; yalnız operasyon alanlarını döndürür.
// Yani gönderilen değer, tarayıcının hesaplayacağının BİREBİR aynısıdır.
//
// Sipariş kümesi `ordersWorkspaceService` cache'iyle PAYLAŞILIR: Siparişler
// ekranı zaten ısıttıysa Dashboard için ikinci bir tam okuma YAPILMAZ.
//
// SALT OKUNUR: satır yazmaz, pazaryeri/taşıyıcı çağrısı YAPMAZ.

import {
  buildDashboardViewModel,
  extractDashboardOperationalSnapshot,
  type DashboardOperationalSnapshot,
  type DashboardPeriodSelection,
  type DashboardViewModel,
} from '../../src/dashboard/dashboardViewModel.ts'
import { sanitizeAnalyticsOrders } from '../cache/analyticsCache.ts'
import { listOrdersForAnalytics } from '../orders/orderPersistenceService.ts'
import {
  buildDashboardProviderCounts,
  type DashboardProviderCounts,
} from '../../src/dashboard/dashboardSummary.ts'
import { listAllProducts } from '../products/productPersistenceService.ts'
import {
  loadWorkspaceOrders,
  projectClientDerivedOrders,
} from '../orders/ordersWorkspaceService.ts'
import { getExternalProcessing } from '../orders/externalProcessingRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

interface ProductCacheEntry {
  key: string
  products: Record<string, unknown>[]
}

let productCache: ProductCacheEntry | null = null

/** Test/tanı: ürün cache'ini boşaltır. */
export function resetDashboardProductCache(): void {
  productCache = null
}

async function loadProducts(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string | null | undefined,
  revision: string,
): Promise<Record<string, unknown>[]> {
  // Ürün kataloğu sipariş revizyonuyla birlikte tazelenir. Katalog sipariş
  // tablosundan daha yavaş değişir; ayrı bir damga eklemek yerine sipariş
  // revizyonuna bağlamak, BAYAT görsel riskini sipariş yazımı sıklığıyla
  // sınırlar (görsel eşleşmesi kritik doğruluk değil, sunum kalitesidir).
  const key = `${organizationId}|${marketplaceAccountId ?? 'legacy-null'}|${revision}`
  if (productCache && productCache.key === key) return productCache.products
  const products = await listAllProducts(db, organizationId, marketplaceAccountId)
  productCache = { key, products }
  return products
}

export interface DashboardOperationalResult {
  snapshot: DashboardOperationalSnapshot
  /**
   * Sağlayıcı sağlık kartlarının sipariş sayaçları. Bunlar da tam küme
   * ister: kısmi havuzdan hesaplanırsa "N kalıcı sipariş" YANLIŞ görünür
   * ve taşıyıcı bağlantı durumu haksız yere "bağlı değil"e düşebilir.
   */
  providerCounts: DashboardProviderCounts
  scannedOrders: number
  scannedProducts: number
  cacheHit: boolean
}

export interface DashboardViewModelResult {
  viewModel: DashboardViewModel
  providerCounts: DashboardProviderCounts
  scannedOrders: number
  scannedProducts: number
  scannedAnalyticsOrders: number
  cacheHit: boolean
}

/**
 * TAM DASHBOARD GÖRÜNÜM MODELİ — SUNUCUDA.
 *
 * ═══ NEDEN İKİ GEÇİŞ ═════════════════════════════════════════════════════
 * Satış analitiğinin çekileceği ARALIK, görünüm modelinin kendisinden
 * türer (seçili dönem + karşılaştırma + dönem kartlarının birleşimi).
 * Tarayıcı bunu iki render'da yapıyordu: önce modeli kurup aralığı öğren,
 * sonra veriyi çekip modeli yeniden kur. Sunucu AYNI iki adımı tek istekte
 * yapar — sonuç birebir aynıdır, ama satır dizisi tarayıcıya İNMEZ.
 *
 * ═══ NEDEN ÖNEMLİ ════════════════════════════════════════════════════════
 * ÖLÇÜLDÜ (gerçek tarayıcı, 260 sipariş): `/api/analytics/orders` yanıtı
 * 269,4 kB idi ve satır başına ~1,0 kB taşıyordu; 10.000 siparişlik bir
 * dönemde bu ~10 MB demektir. Kartların sayıları zaten SQL toplamalarından
 * geliyordu; tarayıcıya inen satırlar YALNIZ ikincil grafikler içindi.
 *
 * ═══ İADE (CLAIMS) SEMANTİĞİ DEĞİŞMEZ ════════════════════════════════════
 * Auth modunda kesin claim muhasebesi yerel DB'de YOKTUR; `/api/analytics/
 * claims` bu modda her zaman boş liste ve `source: "unavailable"` döner.
 * Burada da AYNI değerler geçilir (`analyticsClaims: []`,
 * `claimsAvailable: false`) → iade metriği yine YALNIZ Returned sipariş
 * statüsünden türer. Finansal anlam DEĞİŞMEZ.
 */
export async function buildDashboardViewModelSnapshot(
  db: Db,
  organizationId: string,
  selectedPeriod: DashboardPeriodSelection,
  marketplaceAccountId?: string | null,
  options: { latestSyncAt?: string; now?: Date } = {},
): Promise<DashboardViewModelResult> {
  const now = options.now ?? new Date()
  const load = await loadWorkspaceOrders(db, organizationId, marketplaceAccountId)
  const externalProcessing = await getExternalProcessing(db, organizationId)
  const orders = projectClientDerivedOrders(load.orders, externalProcessing)
  const products = await loadProducts(
    db,
    organizationId,
    marketplaceAccountId,
    load.revision,
  )

  // 1. GEÇİŞ: analitik olmadan model → hangi aralık gerekiyor?
  const draft = buildDashboardViewModel({
    orders: orders as never,
    products: products as never,
    selectedPeriod,
    latestSyncAt: options.latestSyncAt,
    now,
  })
  const ranges = [
    draft.period,
    draft.comparisonPeriod,
    ...draft.salesPeriodCards.map((card) => card.range),
  ]
  const startMs = Math.min(...ranges.map((range) => range.start.getTime()))
  const endMs = Math.max(...ranges.map((range) => range.end.getTime()))

  // 2. GEÇİŞ: dönemsel satış verisiyle NİHAİ model.
  //
  // `sanitizeAnalyticsOrders` AYNI şekilde uygulanır: tarayıcı da bu
  // uçtan sanitize edilmiş satırlar alıyordu; farklı girdi farklı sonuç
  // demek olurdu.
  const analyticsOrders = sanitizeAnalyticsOrders(
    await listOrdersForAnalytics(
      db,
      organizationId,
      { startMs, endMs },
      marketplaceAccountId,
    ),
  )
  const viewModel = buildDashboardViewModel({
    orders: orders as never,
    analyticsOrders: analyticsOrders as never,
    // Auth modunda kesin claim kaynağı YOK; istemcinin gördüğüyle AYNI.
    analyticsClaims: [],
    claimsAvailable: false,
    products: products as never,
    selectedPeriod,
    latestSyncAt: options.latestSyncAt,
    now,
  })

  return {
    viewModel,
    providerCounts: buildDashboardProviderCounts(orders as never),
    scannedOrders: orders.length,
    scannedProducts: products.length,
    scannedAnalyticsOrders: analyticsOrders.length,
    cacheHit: load.cacheHit,
  }
}

export async function buildDashboardOperationalSnapshot(
  db: Db,
  organizationId: string,
  selectedPeriod: DashboardPeriodSelection,
  marketplaceAccountId?: string | null,
  now: Date = new Date(),
): Promise<DashboardOperationalResult> {
  const load = await loadWorkspaceOrders(db, organizationId, marketplaceAccountId)
  const externalProcessing = await getExternalProcessing(db, organizationId)
  const orders = projectClientDerivedOrders(load.orders, externalProcessing)
  const products = await loadProducts(
    db,
    organizationId,
    marketplaceAccountId,
    load.revision,
  )
  const viewModel = buildDashboardViewModel({
    orders: orders as never,
    products: products as never,
    selectedPeriod,
    now,
  })
  return {
    snapshot: extractDashboardOperationalSnapshot(viewModel),
    providerCounts: buildDashboardProviderCounts(orders as never),
    scannedOrders: orders.length,
    scannedProducts: products.length,
    cacheHit: load.cacheHit,
  }
}
