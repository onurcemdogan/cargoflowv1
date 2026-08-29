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
} from '../../src/dashboard/dashboardViewModel.ts'
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
