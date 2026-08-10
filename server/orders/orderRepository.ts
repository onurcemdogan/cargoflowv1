// Organization bazlı sipariş repository'si. TÜM fonksiyonlarda organizationId
// ZORUNLU ilk parametredir; organization filtresi olmayan genel lookup YOKTUR.
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { orderLines, orders, shipments } from '../db/schema.ts'
import {
  marketplaceUpdateSet,
  toLineInsertValues,
  toOrderInsertValues,
} from './orderMapper.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface OrderFilters {
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
  includeArchived?: boolean
}

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

export function resolvePageSize(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

// Pazaryeri hesabı kapsamı. `undefined` → filtre YOK (legacy servis çağrıları);
// `null` → yalnız hesapsız (legacy) kayıtlar; `string` → yalnız o hesabın
// kayıtları. Endpoint her zaman aktif hesabı (string|null) açıkça geçer.
function accountClause(marketplaceAccountId: string | null | undefined) {
  if (marketplaceAccountId === undefined) return null
  return marketplaceAccountId === null
    ? isNull(orders.marketplaceAccountId)
    : eq(orders.marketplaceAccountId, marketplaceAccountId)
}

function buildWhere(
  organizationId: string,
  filters: OrderFilters,
  marketplaceAccountId?: string | null,
) {
  const clauses = [eq(orders.organizationId, organizationId)]
  const scope = accountClause(marketplaceAccountId)
  if (scope) clauses.push(scope)
  if (filters.status) clauses.push(eq(orders.marketplaceStatus, filters.status))
  if (filters.operationStatus) {
    clauses.push(eq(orders.operationStatus, filters.operationStatus))
  }
  if (filters.city) clauses.push(eq(orders.shippingCity, filters.city))
  if (filters.district) clauses.push(eq(orders.shippingDistrict, filters.district))
  if (filters.startDate) {
    const start = new Date(filters.startDate)
    if (!Number.isNaN(start.getTime())) clauses.push(gte(orders.orderDate, start))
  }
  if (filters.endDate) {
    const end = new Date(filters.endDate)
    if (!Number.isNaN(end.getTime())) clauses.push(lte(orders.orderDate, end))
  }
  if (filters.search) {
    const term = `%${filters.search}%`
    const searchClause = or(
      ilike(orders.orderNumber, term),
      ilike(orders.customerFirstName, term),
      ilike(orders.customerLastName, term),
      ilike(orders.shippingCity, term),
    )
    if (searchClause) clauses.push(searchClause)
  }
  return and(...clauses)
}

export async function findOrders(
  db: Db,
  organizationId: string,
  filters: OrderFilters = {},
  marketplaceAccountId?: string | null,
): Promise<{
  orderRows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}> {
  const pageSize = resolvePageSize(filters.pageSize)
  const page = Math.max(1, Math.trunc(Number(filters.page ?? 1)) || 1)
  const where = buildWhere(organizationId, filters, marketplaceAccountId)
  // Sayfalama icin DETERMINISTIK siralama: yalniz orderDate ile ayni
  // timestamp'li kayitlarin sirasi belirsizdir ve sayfalar arasinda kayit
  // kaymasi/tekrari olusabilir. Ikincil anahtar (id) yalniz ESITLIK
  // durumunu cozer; kullanicinin gordugu tarih sirasi DEGISMEZ.
  const orderBy =
    filters.sort === 'orderDateAsc'
      ? [asc(orders.orderDate), asc(orders.id)]
      : [desc(orders.orderDate), desc(orders.id)]
  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
  const totalRows = await db
    .select({ value: sql`count(*)::int` })
    .from(orders)
    .where(where)
  return {
    orderRows: rows,
    total: Number(totalRows[0]?.value ?? 0),
    page,
    pageSize,
  }
}

// Dashboard SATIŞ analitiği için: bir tarih aralığındaki (orderDate) TÜM
// hesap-kapsamlı siparişleri CAP'SİZ döner (sayfalama YOK). Analitik dönemsel
// satış hesabı olduğundan arşivli/aktif ayrımı yapmaz (Cancelled/Returned dahil
// tüm statüler; client viewModel statüye göre sınıflandırır). Provider'a ÇIKMAZ.
export async function findOrdersInRange(
  db: Db,
  organizationId: string,
  range: { startMs: number; endMs: number },
  marketplaceAccountId?: string | null,
): Promise<Record<string, unknown>[]> {
  const scope = accountClause(marketplaceAccountId)
  return db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        ...(scope ? [scope] : []),
        gte(orders.orderDate, new Date(range.startMs)),
        lte(orders.orderDate, new Date(range.endMs)),
      ),
    )
    .orderBy(desc(orders.orderDate))
}

export async function findLinesForOrders(
  db: Db,
  organizationId: string,
  orderIds: string[],
): Promise<Record<string, unknown>[]> {
  if (orderIds.length === 0) return []
  return db
    .select()
    .from(orderLines)
    .where(
      and(
        eq(orderLines.organizationId, organizationId),
        inArray(orderLines.orderId, orderIds),
      ),
    )
}

export async function findOrderById(
  db: Db,
  organizationId: string,
  orderId: string,
  marketplaceAccountId?: string | null,
): Promise<Record<string, unknown> | null> {
  const scope = accountClause(marketplaceAccountId)
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        eq(orders.id, orderId),
        ...(scope ? [scope] : []),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

export async function findOrderByPackageId(
  db: Db,
  organizationId: string,
  marketplace: string,
  packageId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        eq(orders.marketplace, marketplace),
        eq(orders.packageId, packageId),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

export async function countOrdersByOrganization(
  db: Db,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({ value: sql`count(*)::int` })
    .from(orders)
    .where(eq(orders.organizationId, organizationId))
  return Number(rows[0]?.value ?? 0)
}

// Satırları IDEMPOTENT reconcile eder: canonical externalLineId ile upsert +
// provider sonucunda ARTIK OLMAYAN eski satırları (bu sipariş kapsamında) kaldır.
// Tek transaction; org+order-scoped. Böylece aynı siparişin ikinci sync/backfill'i
// (farklı yol/fallback id olsa bile) DUPLICATE üretmez ve eski/aykırı satırlar
// temizlenir. GÜVENLİK: sipariş satırsız gelirse (items boş) MEVCUT satırlar
// KORUNUR (geçici boş fetch yanlışlıkla satır silmesin); yalnız ≥1 canonical
// satır varken stale silinir.
export async function replaceOrUpsertOrderLines(
  db: Db,
  organizationId: string,
  orderId: string,
  order: Record<string, unknown>,
): Promise<void> {
  const values = toLineInsertValues(organizationId, orderId, order)
  const keepIds = values.map((line) => String(line.externalLineId))
  await db.transaction(async (tx: Db) => {
    for (const line of values) {
      await tx
        .insert(orderLines)
        .values(line)
        .onConflictDoUpdate({
          target: [
            orderLines.organizationId,
            orderLines.orderId,
            orderLines.externalLineId,
          ],
          set: {
            productId: line.productId,
            merchantSku: line.merchantSku,
            barcode: line.barcode,
            productName: line.productName,
            variantAttributes: line.variantAttributes,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            discountTotal: line.discountTotal,
            lineStatus: line.lineStatus,
            imageUrl: line.imageUrl,
            rawPayloadEncrypted: line.rawPayloadEncrypted,
            updatedAt: new Date(),
          },
        })
    }
    // Reconcile: yalnız canonical set BOŞ DEĞİLKEN, kümede olmayan (eski/aykırı
    // fallback id'li) satırları bu sipariş kapsamında sil.
    if (keepIds.length > 0) {
      await tx
        .delete(orderLines)
        .where(
          and(
            eq(orderLines.organizationId, organizationId),
            eq(orderLines.orderId, orderId),
            notInArray(orderLines.externalLineId, keepIds),
          ),
        )
    }
  })
}

// Marketplace siparişlerini organization için upsert eder. operation_status/
// archived_at gibi operasyonel alanlar EZİLMEZ (marketplaceUpdateSet).
export async function upsertMarketplaceOrders(
  db: Db,
  organizationId: string,
  normalizedOrders: Record<string, unknown>[],
  marketplaceAccountId: string | null = null,
): Promise<{
  persisted: number
  inserted: number
  updated: number
  failed: number
  packageIds: string[]
}> {
  const packageIds = normalizedOrders
    .map((order) => String(order.packageId ?? order.shipmentPackageId ?? '').trim())
    .filter(Boolean)
  // Var/yok ayrımı AKTİF HESAP kapsamında yapılır (aynı packageId başka hesapta
  // olsa da bu hesap için "yeni" sayılabilir).
  const accountScope =
    marketplaceAccountId == null
      ? isNull(orders.marketplaceAccountId)
      : eq(orders.marketplaceAccountId, marketplaceAccountId)
  const existingRows =
    packageIds.length > 0
      ? await db
          .select({ packageId: orders.packageId })
          .from(orders)
          .where(
            and(
              eq(orders.organizationId, organizationId),
              accountScope,
              inArray(orders.packageId, packageIds),
            ),
          )
      : []
  const existing = new Set(existingRows.map((row: { packageId: string }) => row.packageId))

  let inserted = 0
  let updated = 0
  let failed = 0
  for (const order of normalizedOrders) {
    const packageId = String(order.packageId ?? order.shipmentPackageId ?? '').trim()
    if (!packageId) {
      failed += 1
      continue
    }
    try {
      const insertValues = toOrderInsertValues(organizationId, order, marketplaceAccountId)
      const [row] = await db
        .insert(orders)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [
            orders.organizationId,
            orders.marketplace,
            orders.marketplaceAccountId,
            orders.packageId,
          ],
          set: marketplaceUpdateSet(order),
        })
        .returning({ id: orders.id })
      if (existing.has(packageId)) updated += 1
      else inserted += 1
      await replaceOrUpsertOrderLines(db, organizationId, String(row.id), order)
    } catch {
      failed += 1
    }
  }
  return {
    persisted: inserted + updated,
    inserted,
    updated,
    failed,
    packageIds,
  }
}

// YALNIZ kanıtlı tam sync'te: fresh sette OLMAYAN, henüz arşivlenmemiş
// siparişleri arşivler (SİLMEZ). Partial sync'te ÇAĞRILMAZ.
// GÜÇLÜ operasyon kanıtı taşıyan canonical operationStatus değerleri: bu
// kayıtlar reconcile'de ARŞİVLENMEZ (canonical statüleri korunur, geriye
// düşürülmez). Etiket-hazır/basıldı/kargoda/teslim/iade.
const STRONG_OPERATION_STATUSES = new Set([
  'LABEL_READY',
  'LABEL_PRINTED',
  'SHIPPED',
  'HANDED_TO_CARGO',
  'DELIVERED',
  'DELIVERED_SPECIAL',
  'RETURNING',
  'TRACKING_ACTIVE',
])
// Terminal/forward pazaryeri statüsü de güçlü kanıttır.
const TERMINAL_MARKETPLACE_STATUSES = new Set([
  'Shipped',
  'Delivered',
  'AtCollectionPoint',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
])

// TAM BAŞARILI (complete) sync sonrası reconciliation. Provider'ın güncel aktif
// paket kimliklerinde (freshPackageIds) BULUNMAYAN kayıtlardan YALNIZ güçlü
// operasyon kanıtı OLMAYANLAR arşivlenir. GÜÇLÜ kanıt = canonical operationStatus
// (LABEL_READY/PRINTED/SHIPPED/HANDED_TO_CARGO/DELIVERED/…), terminal pazaryeri
// statüsü VEYA persist edilmiş bir shipment. Bu kayıtlar KORUNUR (silinmez,
// canonical statüsü değişmez). Yalnız NEW/BARCODE_WAITING + etiketsiz + shipmentsız
// bayat aktif kayıtlar aktif kuyruktan çıkarılır. Yaş/727/packageId/kargo firması
// TEK BAŞINA arşiv sebebi DEĞİLDİR. (complete=false ise bu fonksiyon çağrılmaz.)
export interface SyncWindow {
  startMs: number
  endMs: number
}

export async function archiveMissingOrders(
  db: Db,
  organizationId: string,
  freshPackageIds: string[],
  window?: SyncWindow,
  marketplaceAccountId: string | null = null,
): Promise<number> {
  // KAPSAM: reconcile YALNIZ aynı marketplaceAccountId kayıtlarını değerlendirir.
  // Hesap B'nin COMPLETE sync'i hesap A kayıtlarına ASLA dokunmaz. accountId
  // null → legacy/hesapsız kapsam (eski davranış).
  const accountScope =
    marketplaceAccountId == null
      ? isNull(orders.marketplaceAccountId)
      : eq(orders.marketplaceAccountId, marketplaceAccountId)
  const rows = await db
    .select({
      id: orders.id,
      packageId: orders.packageId,
      operationStatus: orders.operationStatus,
      marketplaceStatus: orders.marketplaceStatus,
      orderDate: orders.orderDate,
      marketplaceLastModifiedAt: orders.marketplaceLastModifiedAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        accountScope,
        sql`${orders.archivedAt} is null`,
      ),
    )
  const fresh = new Set(freshPackageIds)
  // Persist edilmiş shipment taşıyan paketler (güçlü kanıt) — arşivlenmez.
  const shipmentRows = await db
    .select({ packageId: shipments.packageId })
    .from(shipments)
    .where(eq(shipments.organizationId, organizationId))
  const withShipment = new Set(
    shipmentRows.map((row: { packageId: string }) => String(row.packageId)),
  )
  // KAPSAM (SCOPE) SÖZLEŞMESİ: reconciliation YALNIZ mevcut sync'in tarih
  // penceresine giren kayıtları değerlendirir. Trendyol packageLastModifiedDate
  // ile filtreler; DB'de marketplaceLastModifiedAt (yoksa orderDate) çapası
  // kullanılır. Pencere DIŞINDAKİ kayıtlar current-active set'te yok diye
  // arşivlenmez (fetch onları hiç kapsamadı). window verilmezse (eski çağrı)
  // eski davranış korunur.
  const inSyncWindow = (row: {
    orderDate: Date | string | null
    marketplaceLastModifiedAt: Date | string | null
  }): boolean => {
    if (!window) return true
    const anchor =
      row.marketplaceLastModifiedAt ?? row.orderDate ?? null
    if (anchor == null) return false
    const ms = anchor instanceof Date ? anchor.getTime() : Date.parse(String(anchor))
    if (!Number.isFinite(ms)) return false
    return ms >= window.startMs && ms <= window.endMs
  }
  let archived = 0
  for (const row of rows) {
    if (fresh.has(row.packageId)) continue
    // Sync kapsamı dışındaki kayıt (fetch görmedi) → DOKUNMA.
    if (!inSyncWindow(row)) continue
    const op = String(row.operationStatus ?? '').toUpperCase()
    const marketplace = String(row.marketplaceStatus ?? '').trim()
    const hasStrongEvidence =
      STRONG_OPERATION_STATUSES.has(op) ||
      TERMINAL_MARKETPLACE_STATUSES.has(marketplace) ||
      withShipment.has(String(row.packageId))
    if (hasStrongEvidence) continue
    await db
      .update(orders)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(orders.organizationId, organizationId), eq(orders.id, row.id)))
    archived += 1
  }
  return archived
}

// Canonical "Etiket Hazır" operasyon durumu. Pazaryeri (marketplace) status'ünden
// AYRI bir alandır (orders.operationStatus); re-sync bunu KORUR (marketplaceUpdateSet
// operationStatus'e dokunmaz).
export const LABEL_READY_OPERATION_STATUS = 'LABEL_READY'

// Etiket-hazır veya daha ileri (basıldı/kargoda/teslim) durumlar: bunlardan
// LABEL_READY'ye GERİ dönülmez (no-regress). Idempotency: zaten LABEL_READY ise
// tekrar yazmaz (updated=false).
const LABEL_READY_NON_REGRESS_STATES = [
  'LABEL_READY',
  'LABEL_PRINTED',
  'SHIPPED',
  'HANDED_TO_CARGO',
  'DELIVERED',
  'DELIVERED_SPECIAL',
  'RETURNING',
]

// Sipariş operasyon durumunu ATOMİK olarak canonical LABEL_READY'ye geçirir.
// Tenant-scoped (organizationId filtresi). Tek koşullu UPDATE: yalnız kayıt yoksa/
// etiket-öncesi bir durumdaysa yazar; zaten LABEL_READY veya daha ileri durumda ise
// DEĞİŞTİRMEZ (idempotent + no-regress). marketplaceStatus'e DOKUNMAZ.
export async function markOrderLabelReady(
  db: Db,
  organizationId: string,
  orderId: string,
): Promise<{ found: boolean; updated: boolean; operationStatus: string | null }> {
  const updated = await db
    .update(orders)
    .set({
      operationStatus: LABEL_READY_OPERATION_STATUS,
      // RETENTION SAATİ: gerçek operasyon geçişi.
      lastOperationalActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orders.organizationId, organizationId),
        eq(orders.id, orderId),
        or(
          isNull(orders.operationStatus),
          notInArray(orders.operationStatus, LABEL_READY_NON_REGRESS_STATES),
        ),
      ),
    )
    .returning({ id: orders.id })
  if (updated.length > 0) {
    return { found: true, updated: true, operationStatus: LABEL_READY_OPERATION_STATUS }
  }
  // UPDATE eşleşmedi: ya kayıt yok (tenant dışı/silinmiş) ya da zaten non-regress
  // bir durumda (idempotent). Ayırt etmek için org-scoped tekil okuma yapılır.
  const existing = await db
    .select({ operationStatus: orders.operationStatus })
    .from(orders)
    .where(and(eq(orders.organizationId, organizationId), eq(orders.id, orderId)))
    .limit(1)
  if (existing.length === 0) {
    return { found: false, updated: false, operationStatus: null }
  }
  return {
    found: true,
    updated: false,
    operationStatus: existing[0].operationStatus ?? null,
  }
}

// Canonical "Etiket Basıldı" operasyon durumu. NOT: Tarayıcı, fiziksel yazıcının
// gerçekten kağıt bastığını kesin doğrulayamaz; LABEL_PRINTED, kullanıcının
// yazdırma aksiyonunu başarıyla BAŞLATTIĞINI ifade eder (mevcut sistemdeki anlam).
export const LABEL_PRINTED_OPERATION_STATUS = 'LABEL_PRINTED'

// LABEL_PRINTED'e YALNIZ LABEL_READY'den geçilir (yazdırılabilir persist edilmiş
// etiket şartı). Zaten LABEL_PRINTED veya daha ileri (kargoda/teslim) statüler
// idempotent kabul edilir; bunlardan GERİ dönülmez (no-regress).
const LABEL_PRINTED_FORWARD_STATES = [
  'LABEL_PRINTED',
  'SHIPPED',
  'HANDED_TO_CARGO',
  'DELIVERED',
  'DELIVERED_SPECIAL',
  'RETURNING',
]

// Sipariş operasyon durumunu ATOMİK olarak LABEL_READY → LABEL_PRINTED geçirir.
// Tenant-scoped. Tek koşullu UPDATE: yalnız operationStatus=LABEL_READY iken yazar.
// - Zaten LABEL_PRINTED / ileri statü → idempotent (updated=false, ok, regress yok).
// - Henüz yazdırılabilir etiket yok (LABEL_READY değil) → reason='label_required'.
// marketplaceStatus'e DOKUNMAZ; yeni shipment/barkod OLUŞTURMAZ.
export async function markOrderLabelPrinted(
  db: Db,
  organizationId: string,
  orderId: string,
): Promise<{
  found: boolean
  updated: boolean
  operationStatus: string | null
  reason?: 'label_required'
}> {
  const updated = await db
    .update(orders)
    .set({
      operationStatus: LABEL_PRINTED_OPERATION_STATUS,
      // RETENTION SAATİ: gerçek operasyon geçişi.
      lastOperationalActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orders.organizationId, organizationId),
        eq(orders.id, orderId),
        eq(orders.operationStatus, LABEL_READY_OPERATION_STATUS),
      ),
    )
    .returning({ id: orders.id })
  if (updated.length > 0) {
    return {
      found: true,
      updated: true,
      operationStatus: LABEL_PRINTED_OPERATION_STATUS,
    }
  }
  // UPDATE eşleşmedi: kayıt yok / zaten printed-ileri / henüz label-öncesi.
  const existing = await db
    .select({ operationStatus: orders.operationStatus })
    .from(orders)
    .where(and(eq(orders.organizationId, organizationId), eq(orders.id, orderId)))
    .limit(1)
  if (existing.length === 0) {
    return { found: false, updated: false, operationStatus: null }
  }
  const current = existing[0].operationStatus ?? null
  // Zaten basılmış veya ileri statü → idempotent başarı (no-regress).
  if (LABEL_PRINTED_FORWARD_STATES.includes(String(current))) {
    return { found: true, updated: false, operationStatus: current }
  }
  // Yazdırılabilir persist edilmiş etiket (LABEL_READY) yok.
  return {
    found: true,
    updated: false,
    operationStatus: current,
    reason: 'label_required',
  }
}
