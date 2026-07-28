// Dashboard SATIŞ mutabakatı için READ-ONLY yerel PostgreSQL tanılaması.
// organizationId + marketplaceAccountId + tarih aralığı kapsamında hesap-scoped
// metrikler döner. HİÇBİR yazma yapmaz, provider'a ÇIKMAZ. İstemciden gelen
// marketplaceAccountId yetki kanıtı olarak KULLANILMAZ (çağıran org + aktif
// hesabı backend'de çözer ve buraya geçer). Ham order/PII/ZPL/credential
// DÖNDÜRMEZ; yalnız güvenli sayı/tutar aggregate'i.
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface ReconcileScope {
  organizationId: string
  marketplaceAccountId: string | null
  startMs: number
  endMs: number
}

export interface BucketRow {
  key: string
  count: number
  amount: number
}
export interface DayBucketRow {
  day: string
  count: number
  amount: number
}

export interface OrderReconciliationReport {
  organizationId: string
  marketplaceAccountId: string | null
  startDate: string
  endDate: string
  orderCount: number
  distinctPackageIds: number
  distinctOrderNumbers: number
  orderLineCount: number
  lineQuantityTotal: number
  totalAmount: number
  minOrderDate: string | null
  maxOrderDate: string | null
  minMarketplaceLastModifiedAt: string | null
  maxMarketplaceLastModifiedAt: string | null
  archivedCount: number
  nullAccountCountOrgWide: number
  byMarketplaceStatus: BucketRow[]
  byOperationStatus: BucketRow[]
  byDay: DayBucketRow[]
  duplicatePackageIdCount: number
  ordersWithoutLines: number
}

function accountScope(marketplaceAccountId: string | null) {
  return marketplaceAccountId == null
    ? isNull(orders.marketplaceAccountId)
    : eq(orders.marketplaceAccountId, marketplaceAccountId)
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
function iso(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

// (org, account, orderDate ∈ [start,end]) kapsamında hesap-scoped mutabakat.
// Arşivli/aktif AYRIMI YAPMAZ (analitikle aynı: tüm statüler dahil). Provider'a
// çıkmaz; yalnız yerel orders/order_lines okunur.
export async function reconcileLocalOrders(
  db: Db,
  scope: ReconcileScope,
): Promise<OrderReconciliationReport> {
  const start = new Date(scope.startMs)
  const end = new Date(scope.endMs)
  const where = and(
    eq(orders.organizationId, scope.organizationId),
    accountScope(scope.marketplaceAccountId),
    gte(orders.orderDate, start),
    lte(orders.orderDate, end),
  )

  const [summary] = await db
    .select({
      orderCount: sql<number>`count(*)::int`,
      distinctPackageIds: sql<number>`count(distinct ${orders.packageId})::int`,
      distinctOrderNumbers: sql<number>`count(distinct ${orders.orderNumber})::int`,
      totalAmount: sql<number>`coalesce(sum(${orders.totalAmount}), 0)::float8`,
      minOrderDate: sql`min(${orders.orderDate})`,
      maxOrderDate: sql`max(${orders.orderDate})`,
      minLastMod: sql`min(${orders.marketplaceLastModifiedAt})`,
      maxLastMod: sql`max(${orders.marketplaceLastModifiedAt})`,
      archivedCount: sql<number>`count(*) filter (where ${orders.archivedAt} is not null)::int`,
    })
    .from(orders)
    .where(where)

  // Satır (order_lines) SATIR SAYISI + toplam quantity — kapsamdaki siparişlerin
  // satırları. lineCount = KALEM (order line adedi); qty = ürün adedi (quantity).
  const [lineAgg] = await db
    .select({
      lineCount: sql<number>`count(*)::int`,
      qty: sql<number>`coalesce(sum(${orderLines.quantity}), 0)::int`,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .where(where)

  // Org geneli NULL-hesap sipariş sayısı (backfill/quarantine göstergesi).
  const [nullAcc] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, scope.organizationId),
        isNull(orders.marketplaceAccountId),
      ),
    )

  const statusRows = await db
    .select({
      key: sql<string>`coalesce(${orders.marketplaceStatus}, '(null)')`,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${orders.totalAmount}), 0)::float8`,
    })
    .from(orders)
    .where(where)
    .groupBy(orders.marketplaceStatus)

  const opRows = await db
    .select({
      key: sql<string>`coalesce(${orders.operationStatus}, '(null)')`,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${orders.totalAmount}), 0)::float8`,
    })
    .from(orders)
    .where(where)
    .groupBy(orders.operationStatus)

  const dayRows = await db
    .select({
      day: sql<string>`to_char(${orders.orderDate} at time zone 'UTC', 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${orders.totalAmount}), 0)::float8`,
    })
    .from(orders)
    .where(where)
    .groupBy(sql`to_char(${orders.orderDate} at time zone 'UTC', 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${orders.orderDate} at time zone 'UTC', 'YYYY-MM-DD')`)

  // Aynı hesap kapsamında AYNI packageId'ye sahip >1 kayıt (duplicate göstergesi).
  const dupRows = await db
    .select({ packageId: orders.packageId, c: sql<number>`count(*)::int` })
    .from(orders)
    .where(where)
    .groupBy(orders.packageId)
    .having(sql`count(*) > 1`)

  // Satırı (order_lines) OLMAYAN sipariş sayısı.
  const [noLines] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        where,
        sql`not exists (select 1 from ${orderLines} ol where ol.order_id = ${orders.id})`,
      ),
    )

  return {
    organizationId: scope.organizationId,
    marketplaceAccountId: scope.marketplaceAccountId,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    orderCount: num(summary?.orderCount),
    distinctPackageIds: num(summary?.distinctPackageIds),
    distinctOrderNumbers: num(summary?.distinctOrderNumbers),
    orderLineCount: num(lineAgg?.lineCount),
    lineQuantityTotal: num(lineAgg?.qty),
    totalAmount: num(summary?.totalAmount),
    minOrderDate: iso(summary?.minOrderDate),
    maxOrderDate: iso(summary?.maxOrderDate),
    minMarketplaceLastModifiedAt: iso(summary?.minLastMod),
    maxMarketplaceLastModifiedAt: iso(summary?.maxLastMod),
    archivedCount: num(summary?.archivedCount),
    nullAccountCountOrgWide: num(nullAcc?.value),
    byMarketplaceStatus: statusRows.map((r: BucketRow) => ({
      key: String(r.key),
      count: num(r.count),
      amount: num(r.amount),
    })),
    byOperationStatus: opRows.map((r: BucketRow) => ({
      key: String(r.key),
      count: num(r.count),
      amount: num(r.amount),
    })),
    byDay: dayRows.map((r: DayBucketRow) => ({
      day: String(r.day),
      count: num(r.count),
      amount: num(r.amount),
    })),
    duplicatePackageIdCount: dupRows.length,
    ordersWithoutLines: num(noLines?.value),
  }
}

// Provider (Trendyol) özeti ile yerel özeti karşılaştırır. Ham ID/PII SIZDIRMAZ;
// yalnız güvenli sayı farkları + eksik ID sayısı + statü/gün bucket farkları.
export interface ProviderSummary {
  packageIds: Set<string>
  orderCount: number
  lineQuantityTotal: number
  grossAmount: number
  byStatus: Map<string, { count: number; amount: number }>
  byDay: Map<string, { count: number; amount: number }>
}

export interface ReconciliationDiff {
  providerPackageCount: number
  localPackageCount: number
  missingInLocalCount: number
  extraInLocalCount: number
  orderCountDiff: number
  lineQuantityDiff: number
  grossAmountDiff: number
  missingByStatus: BucketRow[]
}

export function diffProviderVsLocal(
  provider: ProviderSummary,
  localPackageIds: Set<string>,
  localReport: OrderReconciliationReport,
  providerLocalMissingStatusFn?: (packageId: string) => string,
): ReconciliationDiff {
  const missing: string[] = []
  for (const id of provider.packageIds) if (!localPackageIds.has(id)) missing.push(id)
  let extra = 0
  for (const id of localPackageIds) if (!provider.packageIds.has(id)) extra += 1

  const missingByStatus = new Map<string, number>()
  if (providerLocalMissingStatusFn) {
    for (const id of missing) {
      const bucket = providerLocalMissingStatusFn(id) || '(unknown)'
      missingByStatus.set(bucket, (missingByStatus.get(bucket) ?? 0) + 1)
    }
  }

  return {
    providerPackageCount: provider.packageIds.size,
    localPackageCount: localPackageIds.size,
    missingInLocalCount: missing.length,
    extraInLocalCount: extra,
    orderCountDiff: provider.orderCount - localReport.orderCount,
    lineQuantityDiff: provider.lineQuantityTotal - localReport.lineQuantityTotal,
    grossAmountDiff: provider.grossAmount - localReport.totalAmount,
    missingByStatus: [...missingByStatus.entries()].map(([key, count]) => ({
      key,
      count,
      amount: 0,
    })),
  }
}
