// KANONİK SUNUCU TARAFI FİLTRE PROJEKSİYONU.
//
// AMAÇ: OrdersPage'in 10 istemci-tarafı filtresini sunucuya taşırken
// semantiği BİREBİR korumak.
//
// TASARIM KARARI (audit sonucu): filtreler SQL'e ÇEVRİLMEZ. Audit kanıtladı ki
// 10 filtrenin 6'sı SQL'de ifade EDİLEMEZ:
//   · cargoSlipQuery    → 13 alanın tamamı ŞİFRELİ carrier/operation payload'da
//   · orderNumberQuery  → 2 alanı payload'da (SQL ön-eleme FALSE NEGATIVE üretir)
//   · cargo='hatalı'    → classifyOrderForTabs().hasError türevi
//   · actionFilter      → capability helper'ları + adres/desi
//   · operationTab      → kanonik sekme sınıflandırıcısı
//   · sameProductFilter → NİHAİ sonuç kümesi üzerinde tekrar tespiti
// Ayrıca marketplace/city/district `normalizedToken` (aksan+noktalama silen)
// eşitliği kullanır; SQL `=` bunun eşdeğeri DEĞİLDİR.
//
// Bu yüzden istemcinin kullandığı KANONİK `buildVisibleOrders` fonksiyonu
// AYNEN sunucuda çalıştırılır. Kural ikinci kez yazılmadığı için parite
// İNŞA GEREĞİDİR; testler bunu ayrıca doğrular.
//
// SQL YALNIZ kapsam için kullanılır (organizationId + aktif hesap). Bunlar
// false-negative üretemez çünkü zaten zorunlu tenant kapsamıdır.
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'
import { rowToOrder } from './orderMapper.ts'
import {
  attachShipmentFromLoaded,
  listOrders,
} from './orderPersistenceService.ts'
import { buildOrderWhere, resolvePageSize } from './orderRepository.ts'
import { findShipmentsByPackageIds } from '../shipments/shipmentRepository.ts'
import { findLatestOperationsByPackageIds } from '../shipments/shipmentOperationRepository.ts'
import { SURAT_PERSISTENCE_PROVIDER } from '../shipments/suratProvider.ts'
import { buildVisibleOrders } from '../../src/utils/orderClassification.ts'
import { applyExternalProcessingState } from '../../src/utils/externalProcessing.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** OrdersPage'in gönderdiği TÜM filtreler (10 yeni + mevcutlar). */
export interface OrderListFilters {
  // Kanonik sekme + teknik işlem durumu
  tab?: string
  operationTab?: string
  // Mevcut SQL-uyumlu alanlar (kapsam için değil, kanonik tarafta uygulanır)
  status?: string
  marketplace?: string
  cargo?: string
  city?: string
  district?: string
  // Tarih
  datePreset?: string
  startTime?: number
  endTime?: number
  timezone?: string
  // Arama kutuları
  search?: string
  customerQuery?: string
  productQuery?: string
  orderNumberQuery?: string
  cargoSlipQuery?: string
  // Ürün grupları
  multiProduct?: string
  sameProduct?: string
  // Aksiyon
  action?: string
  // Sayfalama / sıralama
  page?: number | string
  pageSize?: number | string
  sort?: 'orderDateDesc' | 'orderDateAsc'
}

/** Ölçüm/şeffaflık alanları — maliyeti gizlemeden raporlamak için. */
export interface ProjectionInstrumentation {
  candidateRowsBeforeCanonical: number
  shipmentBulkQueries: number
  operationBulkQueries: number
  payloadRowsLoaded: number
  payloadRowsDecrypted: number
  queriesPerRequest: number
  canonicalDurationMs: number
  paginationDurationMs: number
}

export interface FilteredProjection {
  orderIds: string[]
  /** Filtrelenmiş SIRALI view-model'ler (sayfa dilimi buradan alınır). */
  visibleOrders: Record<string, unknown>[]
  total: number
  instrumentation: ProjectionInstrumentation
}

/**
 * FİLTRE BAĞIMLILIK PLANI.
 *
 * Her filtrenin GERÇEKTEN neye ihtiyaç duyduğu. Amaç: pasif bir filtre için
 * ihtimale binaen payload yüklememek/çözmemek.
 *
 *   needsOrderLines        → sipariş satırları gerekir
 *   needsShipment          → gönderi kaydı (ŞİFRE ÇÖZME) gerekir
 *   needsShipmentOperation → operasyon kaydı (ŞİFRE ÇÖZME) gerekir
 *   needsFullCandidateSet  → SQL'de ifade edilemez → tüm aday küme değerlenir
 */
export const FILTER_DEPENDENCY_PLAN = {
  tab: { needsOrderLines: false, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  operationTab: { needsOrderLines: false, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  status: { needsOrderLines: false, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  cargo: { needsOrderLines: false, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  action: { needsOrderLines: false, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  cargoSlipQuery: { needsOrderLines: false, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  orderNumberQuery: { needsOrderLines: false, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  search: { needsOrderLines: true, needsShipment: true, needsShipmentOperation: true, needsDecrypt: true, needsFullCandidateSet: true },
  // Ürün tarafı: gönderi/operasyon GEREKMEZ.
  productQuery: { needsOrderLines: true, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
  multiProduct: { needsOrderLines: true, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
  // NİHAİ sonuç kümesi üzerinde çalışır.
  sameProduct: { needsOrderLines: true, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
  // Düz kolonlar; yine de normalizedToken eşitliği SQL '=' değildir.
  marketplace: { needsOrderLines: false, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
  customerQuery: { needsOrderLines: false, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
  city: { needsOrderLines: false, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
  district: { needsOrderLines: false, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
  datePreset: { needsOrderLines: false, needsShipment: false, needsShipmentOperation: false, needsDecrypt: false, needsFullCandidateSet: true },
} as const

export type FilterKey = keyof typeof FILTER_DEPENDENCY_PLAN

/** `all`/boş → filtre YOK (frontend `isAllFilter` semantiğiyle uyumlu). */
function isActiveValue(value: unknown): boolean {
  const token = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
  return token !== '' && token !== 'all' && token !== 'tumu' && token !== 'tumtarihler'
}

export interface ExecutionPlan {
  mode: 'fast' | 'canonical'
  activeFilters: FilterKey[]
  needsOrderLines: boolean
  needsShipment: boolean
  needsShipmentOperation: boolean
  needsDecrypt: boolean
}

/**
 * ÇALIŞMA YOLU PLANI.
 *
 * HIZLI YOL KOŞULU: kanonik değerlendirme gerektiren HİÇBİR filtre aktif
 * değil. O zaman istek düz SQL LIMIT/OFFSET ile karşılanır ve 15k/50k/100k
 * aday ASLA belleğe alınmaz.
 *
 * Aksi hâlde kanonik projeksiyon; fakat gönderi/operasyon yüklemesi YALNIZ
 * aktif filtrelerin ihtiyacına göre yapılır (pasif filtre için ihtimale
 * binaen decrypt YOK).
 */
export function planExecution(filters: OrderListFilters): ExecutionPlan {
  const candidates: Array<[FilterKey, unknown]> = [
    ['tab', filters.tab],
    ['operationTab', filters.operationTab],
    ['status', filters.status],
    ['cargo', filters.cargo],
    ['action', filters.action],
    ['cargoSlipQuery', filters.cargoSlipQuery],
    ['orderNumberQuery', filters.orderNumberQuery],
    ['search', filters.search],
    ['productQuery', filters.productQuery],
    ['multiProduct', filters.multiProduct],
    ['sameProduct', filters.sameProduct],
    ['marketplace', filters.marketplace],
    ['customerQuery', filters.customerQuery],
    ['city', filters.city],
    ['district', filters.district],
    ['datePreset', filters.datePreset],
  ]
  const activeFilters = candidates
    .filter(([, value]) => isActiveValue(value))
    .map(([key]) => key)
  const plan: ExecutionPlan = {
    mode: activeFilters.length === 0 ? 'fast' : 'canonical',
    activeFilters,
    needsOrderLines: false,
    needsShipment: false,
    needsShipmentOperation: false,
    needsDecrypt: false,
  }
  for (const key of activeFilters) {
    const need = FILTER_DEPENDENCY_PLAN[key]
    plan.needsOrderLines ||= need.needsOrderLines
    plan.needsShipment ||= need.needsShipment
    plan.needsShipmentOperation ||= need.needsShipmentOperation
    plan.needsDecrypt ||= need.needsDecrypt
  }
  return plan
}

function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Aday kümeyi TAM view-model olarak kurar.
 *
 * N+1 YOK: sipariş satırları TEK sorguda (orders üzerinden join ile — kimlik
 * listesi bind edilmez, böylece 65.535 parametre tavanına takılmaz), gönderi
 * ve operasyon kayıtları pazaryeri başına TEK toplu sorguda gelir.
 *
 * ŞİFRE ÇÖZME: `rowToOrder` sipariş payload'ını, `findShipmentsByPackageIds`
 * gönderi payload'ını çözer. Bu filtreler (cargoSlipQuery, orderNumberQuery'nin
 * payload kolu, cargo='hatalı', actionFilter, operationTab) için ZORUNLUDUR —
 * "decrypt yok" iddiası bu yollarda KULLANILAMAZ.
 */
async function buildCandidateViews(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string | null | undefined,
  sort: 'orderDateDesc' | 'orderDateAsc',
  externalProcessing: { entries?: Record<string, unknown> } | null | undefined,
  plan: ExecutionPlan,
  // İSTEĞE BAĞLI ÖN-ELEME: projeksiyon SQL'i aday kümesini daralttıysa yalnız
  // o kimlikler yüklenir. Kanonik karar DEĞİŞMEZ; sadece daha az satır okunur.
  candidateOrderIds?: readonly string[] | null,
): Promise<{
  views: Record<string, unknown>[]
  instrumentation: ProjectionInstrumentation
}> {
  const instrumentation: ProjectionInstrumentation = {
    candidateRowsBeforeCanonical: 0,
    shipmentBulkQueries: 0,
    operationBulkQueries: 0,
    payloadRowsLoaded: 0,
    payloadRowsDecrypted: 0,
    queriesPerRequest: 0,
    canonicalDurationMs: 0,
    paginationDurationMs: 0,
  }
  // Kapsam SQL'i: YALNIZ organizasyon + aktif hesap. Filtre koşulu EKLENMEZ
  // (bkz. dosya başı: SQL ön-eleme false-negative üretirdi).
  const scopeWhere = buildOrderWhere(organizationId, {}, marketplaceAccountId)
  const where = candidateOrderIds
    ? and(scopeWhere, inArray(orders.id, [...candidateOrderIds]))
    : scopeWhere
  if (candidateOrderIds && candidateOrderIds.length === 0) {
    return { views: [], instrumentation }
  }
  const orderBy =
    sort === 'orderDateAsc'
      ? [asc(orders.orderDate), asc(orders.id)]
      : [desc(orders.orderDate), desc(orders.id)]

  const orderRows = (await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(...orderBy)) as Record<string, unknown>[]
  instrumentation.queriesPerRequest += 1
  instrumentation.candidateRowsBeforeCanonical = orderRows.length
  if (orderRows.length === 0) return { views: [], instrumentation }

  // Sipariş satırları TEK sorguda. Kimlik listesi BIND EDİLMEZ: aynı kapsam
  // alt-sorgu olarak verilir → 65.535 parametre tavanı sorunu OLUŞMAZ.
  const scopedOrderIds = db.select({ id: orders.id }).from(orders).where(where)
  const lineRows = (plan.needsOrderLines
    ? await db
    .select()
    .from(orderLines)
    .where(
      and(
        eq(orderLines.organizationId, organizationId),
        inArray(orderLines.orderId, scopedOrderIds),
      ),
    )
    : []) as Record<string, unknown>[]
  if (plan.needsOrderLines) instrumentation.queriesPerRequest += 1
  const linesByOrder = new Map<string, Record<string, unknown>[]>()
  for (const line of lineRows) {
    const key = String(line.orderId)
    if (!linesByOrder.has(key)) linesByOrder.set(key, [])
    linesByOrder.get(key)!.push(line)
  }

  // Gönderi + operasyon: pazaryeri başına TEK toplu sorgu (N+1 YOK).
  const byMarketplace = new Map<string, string[]>()
  for (const row of orderRows) {
    const packageId = String(row.packageId ?? '')
    if (!packageId) continue
    const marketplace = String(row.marketplace ?? '')
    if (!byMarketplace.has(marketplace)) byMarketplace.set(marketplace, [])
    byMarketplace.get(marketplace)!.push(packageId)
  }
  const shipmentsByKey = new Map<string, Record<string, unknown>>()
  // ŞİFRE ÇÖZME YALNIZ GEREKİYORSA: pasif bir filtre için ihtimale binaen
  // carrier payload yüklenmez/çözülmez (bkz. FILTER_DEPENDENCY_PLAN).
  for (const [marketplace, packageIds] of plan.needsShipment
    ? byMarketplace
    : new Map<string, string[]>()) {
    const loaded = await findShipmentsByPackageIds(
      db,
      organizationId,
      marketplace,
      packageIds,
      SURAT_PERSISTENCE_PROVIDER,
    )
    instrumentation.shipmentBulkQueries += 1
    instrumentation.queriesPerRequest += 1
    for (const [packageId, shipment] of loaded) {
      shipmentsByKey.set(`${marketplace}::${packageId}`, shipment)
      instrumentation.payloadRowsLoaded += 1
      instrumentation.payloadRowsDecrypted += 1
    }
  }
  const localCreatePackageIds: string[] = []
  for (const shipment of shipmentsByKey.values()) {
    if (shipment.source === 'local_create') {
      localCreatePackageIds.push(String(shipment.packageId))
    }
  }
  const operationsByPackage = plan.needsShipmentOperation
    ? await findLatestOperationsByPackageIds(db, organizationId, localCreatePackageIds)
    : new Map<string, Record<string, unknown>>()
  if (plan.needsShipmentOperation) {
    instrumentation.operationBulkQueries += 1
    instrumentation.queriesPerRequest += 1
    instrumentation.payloadRowsDecrypted += operationsByPackage.size
  }

  let views = orderRows.map((row) => {
    const base = rowToOrder(row, linesByOrder.get(String(row.id)) ?? [])
    const packageId = String(row.packageId ?? '')
    const shipment = shipmentsByKey.get(
      `${String(row.marketplace ?? '')}::${packageId}`,
    )
    if (!shipment) return base
    const operation =
      shipment.source === 'local_create'
        ? operationsByPackage.get(packageId)
        : null
    return attachShipmentFromLoaded(base, shipment, operation)
  })
  // YEREL harici-işlem arşivi istemcideki AYNI saf yardımcıyla damgalanır.
  if (externalProcessing) {
    views = applyExternalProcessingState(
      views as never,
      externalProcessing as never,
    ) as never
  }
  return { views, instrumentation }
}

/**
 * KANONİK FİLTRE + SIRALAMA + SAYFALAMA.
 *
 * SIRA (frontend `buildVisibleOrders` sırasının AYNISI — o fonksiyon
 * çağrıldığı için sıra otomatik korunur):
 *   geçersiz kayıt → paket dedupe → harici-işlem → sekme → işlem durumu →
 *   pazaryeri → statü → kargo → şehir → ilçe → çoklu ürün → aksiyon →
 *   tarih → arama(+müşteri/ürün/sipariş no/kargo fişi) → AYNI ÜRÜN (EN SON)
 * Ardından sıralama, EN SON sayfalama.
 *
 * SAYFALAMA FİLTREDEN SONRADIR: `total` gerçek filtrelenmiş sonuç kümesidir.
 */
export async function loadFilteredProjection(
  db: Db,
  organizationId: string,
  filters: OrderListFilters = {},
  marketplaceAccountId?: string | null,
  externalProcessing?: { entries?: Record<string, unknown> } | null,
  candidateOrderIds?: readonly string[] | null,
): Promise<FilteredProjection> {
  const sort = filters.sort === 'orderDateAsc' ? 'orderDateAsc' : 'orderDateDesc'
  const plan = planExecution(filters)
  const { views, instrumentation } = await buildCandidateViews(
    db,
    organizationId,
    marketplaceAccountId,
    sort,
    externalProcessing,
    plan,
    candidateOrderIds,
  )

  const canonicalStart = now()
  // KANONİK FİLTRE — istemcinin kullandığı fonksiyonun TA KENDİSİ.
  const result = buildVisibleOrders({
    persistentOrders: views as never,
    selectedTab: (filters.tab ?? 'all') as never,
    marketplaceFilter: filters.marketplace ?? 'all',
    operationStatusFilter: filters.status ?? 'all',
    cargoFilter: filters.cargo ?? 'all',
    cityFilter: filters.city ?? 'all',
    districtFilter: filters.district ?? 'all',
    multiProductFilter: (filters.multiProduct ?? 'all') as never,
    sameProductFilter: (filters.sameProduct ?? 'all') as never,
    actionFilter: (filters.action ?? 'all') as never,
    operationTabFilter: (filters.operationTab ?? 'all') as never,
    dateFilter: {
      preset: filters.datePreset ?? 'all',
      startTime: filters.startTime,
      endTime: filters.endTime,
      timezone: filters.timezone,
    },
    searchQuery: filters.search ?? '',
    customerQuery: filters.customerQuery ?? '',
    productQuery: filters.productQuery ?? '',
    orderNumberQuery: filters.orderNumberQuery ?? '',
    cargoSlipQuery: filters.cargoSlipQuery ?? '',
  })
  instrumentation.canonicalDurationMs = round(now() - canonicalStart)

  const visibleOrders = result.visibleOrders as unknown as Record<
    string,
    unknown
  >[]
  const orderIds = visibleOrders.map((order) => String(order.id))
  return {
    orderIds,
    visibleOrders,
    total: orderIds.length,
    instrumentation,
  }
}

/** Kimlik dilimi — SIRA korunur (kanonik sıralama otoritedir). */
export function sliceIds(
  orderIds: string[],
  page: number,
  pageSize: number,
): string[] {
  const start = Math.max(0, (page - 1) * pageSize)
  return orderIds.slice(start, start + pageSize)
}

/**
 * FİLTRELENMİŞ SAYFA — istemciye YALNIZ sayfa kadar sipariş döner.
 *
 * `total` filtrelenmiş GERÇEK sonuç kümesidir; "25 satır getir sonra filtrele"
 * YAPILMAZ.
 */
export async function listFilteredOrdersPage(
  db: Db,
  organizationId: string,
  filters: OrderListFilters = {},
  marketplaceAccountId?: string | null,
  externalProcessing?: { entries?: Record<string, unknown> } | null,
): Promise<{
  orders: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
  instrumentation: ProjectionInstrumentation
}> {
  const pageSize = resolvePageSize(filters.pageSize)
  const page = Math.max(1, Math.trunc(Number(filters.page ?? 1)) || 1)
  const projection = await loadFilteredProjection(
    db,
    organizationId,
    filters,
    marketplaceAccountId,
    externalProcessing,
  )
  // Aday görünümler kanonik filtre sırasında ZATEN kuruldu; sayfa için EK
  // SORGU YAPILMAZ. Sayfalama en sonda, filtrelenmiş küme üzerinde.
  const paginationStart = now()
  const pageOrders = projection.visibleOrders.slice(
    Math.max(0, (page - 1) * pageSize),
    Math.max(0, (page - 1) * pageSize) + pageSize,
  )
  projection.instrumentation.paginationDurationMs = round(now() - paginationStart)
  return {
    orders: pageOrders,
    total: projection.total,
    page,
    pageSize,
    instrumentation: projection.instrumentation,
  }
}

/**
 * İSTEK SEVİYESİ YÖNLENDİRİCİ — HIZLI YOL / KANONİK YOL.
 *
 * HIZLI YOL (aktif filtre YOK): düz SQL LIMIT/OFFSET + sayfa seviyesi toplu
 * gönderi/operasyon birleştirme. 15k/50k/100k aday BELLEĞE ALINMAZ.
 * KANONİK YOL (en az bir filtre aktif): tüm aday küme kanonik
 * `buildVisibleOrders` ile değerlenir, sonra sayfalanır.
 *
 * Sayfa satırlarının GÖRÜNÜMÜ her iki yolda AYNIDIR: kanonik yolda gönderi
 * yüklenmediyse (aktif filtre gerektirmiyorsa) sayfa için AYRICA toplu
 * birleştirme yapılır — böylece istemciye giden alanlar değişmez.
 */
export async function listOrdersForRequest(
  db: Db,
  organizationId: string,
  filters: OrderListFilters = {},
  marketplaceAccountId?: string | null,
  externalProcessing?: { entries?: Record<string, unknown> } | null,
): Promise<{
  orders: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
  plan: ExecutionPlan
  instrumentation?: ProjectionInstrumentation
}> {
  const plan = planExecution(filters)
  if (plan.mode === 'fast') {
    const result = await listOrders(
      db,
      organizationId,
      {
        page: Number(filters.page ?? 1) || 1,
        pageSize: Number(filters.pageSize ?? 0) || undefined,
        sort: filters.sort === 'orderDateAsc' ? 'orderDateAsc' : 'orderDateDesc',
      },
      marketplaceAccountId,
    )
    return { ...result, plan }
  }
  const result = await listFilteredOrdersPage(
    db,
    organizationId,
    filters,
    marketplaceAccountId,
    externalProcessing,
  )
  // Gönderi aday değerlendirmesinde GEREKMEDİYSE sayfa için burada eklenir.
  if (!plan.needsShipment && result.orders.length > 0) {
    result.orders = await attachShipmentsForRows(
      db,
      organizationId,
      result.orders,
    )
    result.instrumentation.shipmentBulkQueries += 1
    result.instrumentation.operationBulkQueries += 1
    result.instrumentation.queriesPerRequest += 2
  }
  return { ...result, plan }
}

/** Sayfa satırları için toplu gönderi/operasyon birleştirme (N+1 YOK). */
async function attachShipmentsForRows(
  db: Db,
  organizationId: string,
  pageOrders: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const byMarketplace = new Map<string, string[]>()
  for (const order of pageOrders) {
    const packageId = String(order.packageId ?? '')
    if (!packageId) continue
    const marketplace = String(order.marketplace ?? '')
    if (!byMarketplace.has(marketplace)) byMarketplace.set(marketplace, [])
    byMarketplace.get(marketplace)!.push(packageId)
  }
  const shipmentsByKey = new Map<string, Record<string, unknown>>()
  for (const [marketplace, packageIds] of byMarketplace) {
    const loaded = await findShipmentsByPackageIds(
      db,
      organizationId,
      marketplace,
      packageIds,
      SURAT_PERSISTENCE_PROVIDER,
    )
    for (const [packageId, shipment] of loaded) {
      shipmentsByKey.set(`${marketplace}::${packageId}`, shipment)
    }
  }
  const localCreatePackageIds: string[] = []
  for (const shipment of shipmentsByKey.values()) {
    if (shipment.source === 'local_create') {
      localCreatePackageIds.push(String(shipment.packageId))
    }
  }
  const operationsByPackage = await findLatestOperationsByPackageIds(
    db,
    organizationId,
    localCreatePackageIds,
  )
  return pageOrders.map((order) => {
    const packageId = String(order.packageId ?? '')
    if (!packageId) return order
    const shipment = shipmentsByKey.get(
      `${String(order.marketplace ?? '')}::${packageId}`,
    )
    if (!shipment) return order
    const operation =
      shipment.source === 'local_create'
        ? operationsByPackage.get(packageId)
        : null
    return attachShipmentFromLoaded(order, shipment, operation)
  })
}
