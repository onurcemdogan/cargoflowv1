// SİPARİŞ ÇALIŞMA ALANI SORGUSU — TEK, İZOMORFİK PROJEKSİYON.
//
// ═══ NEDEN BU MODÜL VAR ══════════════════════════════════════════════════
// Siparişler ekranı bugüne kadar TÜM sipariş tablosunu tarayıcıya indirip
// (100'erlik sayfalarla ~100 HTTP turu) filtrelemeyi, sıralamayı, gruplamayı
// ve sayfalamayı React içinde yapıyordu. 25k siparişte bu davranış ÇÖKÜYOR
// (MAX_ORDER_PAGES) ve 10k'da onlarca MB JSON taşıyordu.
//
// Çözüm "filtreleri SQL'e çevirmek" DEĞİLDİR: görünür liste; sekme
// sınıflandırıcıları, Sürat doğrulama durumu, ürün-ailesi gruplaması ve
// Türkçe (tr-TR, numeric) karşılaştırma ile belirlenir. Bunların SQL
// karşılığı AYNI SONUCU VERMEZ ve cevapları sessizce değiştirirdi.
//
// Bu modül bu yüzden PROJEKSİYONU tek bir saf fonksiyona toplar. AYNI
// fonksiyon hem tarayıcıda (legacy/localStorage modu) hem sunucuda
// (`GET /api/orders/workspace`) çalışır. Böylece sunucu tarafı sayfalama
// cevapları DEĞİŞTİREMEZ: parite İNŞA GEREĞİ sağlanır, testle de kanıtlanır.
//
// SAF: ağ yok, DOM yok, DB yok; "şimdi" çağrıyla verilir.

import type {
  CargoFilter,
  CargoOrder,
  MarketplaceName,
  OrderStatusFilter,
} from '../types/cargoflow.ts'
import {
  buildVisibleOrders,
  classifyOrderForTabs,
  orderMatchesQuickTab,
} from './orderClassification.ts'
import { buildOrderCountSummary, type OrderCountSummary } from './orderCounts.ts'
import {
  groupOrdersBySameProductFamily,
  type SameProductFilter,
  type SameProductGroupHeader,
} from './orderProductFamily.ts'
import type { OrdersActionFilter } from './ordersNavigation.ts'
import type { OperationTabFilter, QuickTab } from './ordersTabs.ts'
import {
  paginateOrders,
  sortOrdersForWorkspace,
  type OrdersSortDirection,
  type OrdersSortKey,
} from './ordersWorkspace.ts'

/**
 * Görünür ana sekmeler — TEK KAYNAK.
 *
 * Sekme sayaçları hem istemci hem sunucu tarafında bu listeden türer; iki
 * yerde ayrı ayrı tanımlanırsa sayaç ile liste birbirinden KAYAR.
 */
export const ORDERS_QUICK_TABS: ReadonlyArray<{ key: QuickTab; label: string }> = [
  { key: 'newOrders', label: 'Yeni Siparişler' },
  { key: 'labelStage', label: 'Etiket Hazır' },
  { key: 'handedToCargo', label: 'Kargoya Verildi' },
  { key: 'delivered', label: 'Teslim Edildi' },
  { key: 'cancelReturn', label: 'İptal / İade' },
  { key: 'all', label: 'Tümü' },
]

/** Sunucuya gidebilecek EN BÜYÜK sayfa boyutu — `/api/orders` sözleşmesiyle aynı. */
export const ORDERS_WORKSPACE_MAX_PAGE_SIZE = 100

export interface OrdersWorkspaceDateFilter {
  preset: string
  /** Epoch ms. Sonsuz sınırlar `undefined` ile taşınır (JSON'da Infinity yok). */
  startTime?: number
  endTime?: number
  timezone?: string
}

export interface OrdersWorkspaceQuery {
  tab: QuickTab
  operationTab: OperationTabFilter
  marketplace: 'all' | MarketplaceName | string
  status: OrderStatusFilter
  cargo: CargoFilter
  city: string
  district: string
  multiProduct: 'all' | 'single' | 'multi'
  sameProduct: SameProductFilter
  action: OrdersActionFilter
  date: OrdersWorkspaceDateFilter
  search: string
  customerQuery: string
  productQuery: string
  orderNumberQuery: string
  cargoSlipQuery: string
  sortKey: OrdersSortKey
  sortDirection: OrdersSortDirection
  page: number
  pageSize: number
}

export interface OrdersWorkspaceResult {
  /** YALNIZ istenen sayfa. Tam koleksiyon HİÇBİR ZAMAN dönmez. */
  items: CargoOrder[]
  page: number
  pageSize: number
  pageCount: number
  totalItems: number
  startIndex: number
  endIndex: number
  tabCounts: Record<QuickTab, number>
  cityOptions: string[]
  districtOptions: string[]
  listedCounts: OrderCountSummary
  /** Ürün ailesi başlıkları — YALNIZ bu sayfadaki siparişler için. */
  groupHeaders: Record<string, SameProductGroupHeader> | null
}

export const ORDERS_WORKSPACE_DEFAULT_QUERY: OrdersWorkspaceQuery = {
  tab: 'newOrders',
  operationTab: 'all',
  marketplace: 'all',
  status: 'all',
  cargo: 'all',
  city: 'all',
  district: 'all',
  multiProduct: 'all',
  sameProduct: 'all',
  action: 'all',
  date: { preset: 'all' },
  search: '',
  customerQuery: '',
  productQuery: '',
  orderNumberQuery: '',
  cargoSlipQuery: '',
  sortKey: 'orderDate',
  sortDirection: 'desc',
  page: 1,
  pageSize: 25,
}

function toClassificationDateFilter(date: OrdersWorkspaceDateFilter) {
  return {
    preset: date.preset,
    // JSON Infinity taşıyamaz: eksik sınır SINIRSIZ demektir. `all` dışındaki
    // preset'lerde istemci gerçek epoch sınırlarını GÖNDERİR; sunucu kendi
    // saat dilimine göre YENİDEN HESAPLAMAZ (aksi halde "Bugün" iki tarafta
    // farklı gün olabilirdi).
    startTime: date.startTime ?? Number.NEGATIVE_INFINITY,
    endTime: date.endTime ?? Number.POSITIVE_INFINITY,
    timezone: date.timezone,
  }
}

/**
 * Sekme sayaçları — TEK GEÇİŞ.
 *
 * DİKKAT: `operationTab` ve `sameProduct` sayaçlara UYGULANMAZ — ana sekme
 * sayaçları aşama toplamını gösterir; teknik alt-filtre yalnız görünür
 * listeyi daraltır. Bu davranış mevcut ekranla BİREBİR aynıdır.
 *
 * ═══ NEDEN TEK GEÇİŞ ═════════════════════════════════════════════════════
 * Önceki biçim tüm filtre hattını HER SEKME için baştan çalıştırıyordu (altı
 * kez). ÖLÇÜLDÜ (gerçek Postgres, 10.000 sipariş): tek bir sayfa isteği
 * ~500 ms saf Node projeksiyonu harcıyordu ve bunun çoğu bu tekrardı.
 *
 * ═══ NEDEN SONUÇ AYNI ════════════════════════════════════════════════════
 * `selectedTab`, `buildVisibleOrders` içinde TEK bir yerde kullanılır ve
 * SİPARİŞ BAŞINA bir yüklemdir (`orderMatchesQuickTab`). Diğer tüm aşamalar
 * da sipariş başına yüklemdir; küme-bağımlı tek aşama `sameProduct`tır ve
 * sayaç yolunda UYGULANMAZ. Yüklemlerin kesişimi sıraya bağlı olmadığından
 * "önce diğer filtreler, sonra sekmeye göre böl" ile "her sekme için baştan
 * filtrele" AYNI kümeleri verir.
 *
 * Bu denklik `orders-workspace-parity-flow` (WS-19) ile KİLİTLİDİR: naif
 * (sekme başına yeniden filtreleyen) hesapla birebir karşılaştırılır.
 */
function buildTabCounts(
  orders: CargoOrder[],
  query: OrdersWorkspaceQuery,
  now: Date,
): Record<QuickTab, number> {
  const base = buildVisibleOrders({
    persistentOrders: orders,
    // Sekme filtresi UYGULANMAZ; bölme aşağıda yapılır.
    selectedTab: 'all',
    marketplaceFilter: query.marketplace,
    operationStatusFilter: query.status,
    cargoFilter: query.cargo,
    cityFilter: query.city,
    districtFilter: query.district,
    multiProductFilter: query.multiProduct,
    actionFilter: query.action,
    dateFilter: toClassificationDateFilter(query.date),
    searchQuery: query.search,
    customerQuery: query.customerQuery,
    productQuery: query.productQuery,
    orderNumberQuery: query.orderNumberQuery,
    cargoSlipQuery: query.cargoSlipQuery,
    now,
    // Projeksiyon `debug.exclusions` OKUMAZ; tanı kayıtlarını üretmek
    // 25.000 siparişte ölçülen saf israftır. Görünür liste DEĞİŞMEZ.
    collectExclusions: false,
  }).visibleOrders

  const counts = {} as Record<QuickTab, number>
  for (const tab of ORDERS_QUICK_TABS) {
    counts[tab.key] = tab.key === 'all' ? base.length : 0
  }
  for (const order of base) {
    const state = classifyOrderForTabs(order)
    for (const tab of ORDERS_QUICK_TABS) {
      if (tab.key === 'all') continue
      if (orderMatchesQuickTab(state, tab.key)) counts[tab.key] += 1
    }
  }
  return counts
}

export function buildOrdersCityOptions(orders: CargoOrder[]): string[] {
  return Array.from(
    new Set(orders.map((order) => String(order.city || '').trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right, 'tr-TR'))
}

export function buildOrdersDistrictOptions(
  orders: CargoOrder[],
  city: string,
): string[] {
  return Array.from(
    new Set(
      orders
        .filter((order) => city === 'all' || String(order.city || '') === city)
        .map((order) => String(order.district || '').trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right, 'tr-TR'))
}

/**
 * TEK projeksiyon: filtrele → sırala → (ürün ailesi) grupla → sayfala.
 *
 * Adım SIRASI mevcut ekranla aynıdır ve DEĞİŞTİRİLEMEZ: gruplama
 * sayfalamadan ÖNCE yapılır, aksi halde bir aile sayfa sınırında bölünür.
 */
export function buildOrdersWorkspaceResult(
  orders: CargoOrder[],
  query: OrdersWorkspaceQuery,
  now: Date = new Date(),
): OrdersWorkspaceResult {
  const filtered = buildVisibleOrders({
    persistentOrders: orders,
    selectedTab: query.tab,
    marketplaceFilter: query.marketplace,
    operationStatusFilter: query.status,
    cargoFilter: query.cargo,
    cityFilter: query.city,
    districtFilter: query.district,
    multiProductFilter: query.multiProduct,
    sameProductFilter: query.sameProduct,
    actionFilter: query.action,
    operationTabFilter: query.operationTab,
    dateFilter: toClassificationDateFilter(query.date),
    searchQuery: query.search,
    customerQuery: query.customerQuery,
    productQuery: query.productQuery,
    orderNumberQuery: query.orderNumberQuery,
    cargoSlipQuery: query.cargoSlipQuery,
    now,
    // Projeksiyon `debug.exclusions` OKUMAZ; tanı kayıtlarını üretmek
    // 25.000 siparişte ölçülen saf israftır. Görünür liste DEĞİŞMEZ.
    collectExclusions: false,
  }).visibleOrders

  const sorted = sortOrdersForWorkspace(filtered, query.sortKey, query.sortDirection)
  const grouping =
    query.sameProduct === 'all' ? null : groupOrdersBySameProductFamily(sorted)
  const display = grouping?.orders ?? sorted
  const pagination = paginateOrders(display, query.page, query.pageSize)

  let groupHeaders: Record<string, SameProductGroupHeader> | null = null
  if (grouping) {
    groupHeaders = {}
    for (const order of pagination.items) {
      const header = grouping.headerByOrderId.get(order.id)
      if (header) groupHeaders[order.id] = header
    }
  }

  return {
    items: pagination.items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    pageCount: pagination.pageCount,
    totalItems: pagination.totalItems,
    startIndex: pagination.startIndex,
    endIndex: pagination.endIndex,
    tabCounts: buildTabCounts(orders, query, now),
    cityOptions: buildOrdersCityOptions(orders),
    districtOptions: buildOrdersDistrictOptions(orders, query.city),
    listedCounts: buildOrderCountSummary(filtered),
    groupHeaders,
  }
}
