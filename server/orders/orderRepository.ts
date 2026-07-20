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
  lte,
  or,
  sql,
} from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'
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

function buildWhere(organizationId: string, filters: OrderFilters) {
  const clauses = [eq(orders.organizationId, organizationId)]
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
): Promise<{
  orderRows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}> {
  const pageSize = resolvePageSize(filters.pageSize)
  const page = Math.max(1, Math.trunc(Number(filters.page ?? 1)) || 1)
  const where = buildWhere(organizationId, filters)
  const orderBy =
    filters.sort === 'orderDateAsc' ? asc(orders.orderDate) : desc(orders.orderDate)
  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(orderBy)
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
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.organizationId, organizationId), eq(orders.id, orderId)))
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

// Satırları upsert eder (unique org+order+externalLineId → duplicate olmaz).
export async function replaceOrUpsertOrderLines(
  db: Db,
  organizationId: string,
  orderId: string,
  order: Record<string, unknown>,
): Promise<void> {
  const values = toLineInsertValues(organizationId, orderId, order)
  for (const line of values) {
    await db
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
}

// Marketplace siparişlerini organization için upsert eder. operation_status/
// archived_at gibi operasyonel alanlar EZİLMEZ (marketplaceUpdateSet).
export async function upsertMarketplaceOrders(
  db: Db,
  organizationId: string,
  normalizedOrders: Record<string, unknown>[],
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
  const existingRows =
    packageIds.length > 0
      ? await db
          .select({ packageId: orders.packageId })
          .from(orders)
          .where(
            and(
              eq(orders.organizationId, organizationId),
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
      const insertValues = toOrderInsertValues(organizationId, order)
      const [row] = await db
        .insert(orders)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [orders.organizationId, orders.marketplace, orders.packageId],
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
export async function archiveMissingOrders(
  db: Db,
  organizationId: string,
  freshPackageIds: string[],
): Promise<number> {
  const rows = await db
    .select({ id: orders.id, packageId: orders.packageId })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        sql`${orders.archivedAt} is null`,
      ),
    )
  const fresh = new Set(freshPackageIds)
  const missing = rows.filter((row: { packageId: string }) => !fresh.has(row.packageId))
  let archived = 0
  for (const row of missing) {
    await db
      .update(orders)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(orders.organizationId, organizationId), eq(orders.id, row.id)))
    archived += 1
  }
  return archived
}
