// Organization bazlı ürün kataloğu repository'si. TÜM fonksiyonlarda
// organizationId ZORUNLU ilk parametredir; organization filtresi olmayan genel
// ürün lookup YOKTUR. Düz varyant listesi products⋈product_variants join'iyle
// reconstruct edilir (4293 varyant koruması).
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { products, productVariants } from '../db/schema.ts'
import {
  productKeyOf,
  productMarketplaceUpdateSet,
  toProductInsertValues,
  toVariantInsertValues,
  variantKeyOf,
  variantUpdateSet,
} from './productMapper.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface ProductFilters {
  search?: string
  barcode?: string
  merchantSku?: string
  archived?: boolean
  page?: number
  pageSize?: number
  sort?: 'titleAsc' | 'titleDesc' | 'recent'
}

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

export function resolvePageSize(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

function buildWhere(organizationId: string, filters: ProductFilters) {
  const clauses = [eq(productVariants.organizationId, organizationId)]
  if (typeof filters.archived === 'boolean') {
    clauses.push(eq(productVariants.archived, filters.archived))
  }
  if (filters.barcode) clauses.push(eq(productVariants.barcode, filters.barcode))
  if (filters.merchantSku) {
    clauses.push(eq(productVariants.merchantSku, filters.merchantSku))
  }
  if (filters.search) {
    const term = `%${filters.search}%`
    const searchClause = or(
      ilike(products.title, term),
      ilike(productVariants.barcode, term),
      ilike(productVariants.merchantSku, term),
      ilike(productVariants.stockCode, term),
    )
    if (searchClause) clauses.push(searchClause)
  }
  return and(...clauses)
}

export async function findProducts(
  db: Db,
  organizationId: string,
  filters: ProductFilters = {},
): Promise<{
  rows: { product: Record<string, unknown>; variant: Record<string, unknown> }[]
  total: number
  page: number
  pageSize: number
}> {
  const pageSize = resolvePageSize(filters.pageSize)
  const page = Math.max(1, Math.trunc(Number(filters.page ?? 1)) || 1)
  const where = buildWhere(organizationId, filters)
  const orderBy =
    filters.sort === 'titleDesc'
      ? desc(products.title)
      : filters.sort === 'recent'
        ? desc(productVariants.updatedAt)
        : asc(products.title)
  const rows = await db
    .select({ variant: productVariants, product: products })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.organizationId, productVariants.organizationId),
      ),
    )
    .where(where)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
  const totalRows = await db
    .select({ value: sql`count(*)::int` })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.organizationId, productVariants.organizationId),
      ),
    )
    .where(where)
  return {
    rows: rows.map((row: { variant: Record<string, unknown>; product: Record<string, unknown> }) => ({
      variant: row.variant,
      product: row.product,
    })),
    total: Number(totalRows[0]?.value ?? 0),
    page,
    pageSize,
  }
}

// Tekil ürün: düz view-model id'si VARYANT id'sidir. Varyant + ana ürünü
// org-scoped döndürür (çapraz org null).
export async function findProductById(
  db: Db,
  organizationId: string,
  variantId: string,
): Promise<{ product: Record<string, unknown>; variant: Record<string, unknown> } | null> {
  const rows = await db
    .select({ variant: productVariants, product: products })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.organizationId, productVariants.organizationId),
      ),
    )
    .where(
      and(
        eq(productVariants.organizationId, organizationId),
        eq(productVariants.id, variantId),
      ),
    )
    .limit(1)
  return rows[0] ? { product: rows[0].product, variant: rows[0].variant } : null
}

export async function findVariantByBarcode(
  db: Db,
  organizationId: string,
  barcode: string,
): Promise<{ product: Record<string, unknown>; variant: Record<string, unknown> } | null> {
  if (!barcode) return null
  const rows = await db
    .select({ variant: productVariants, product: products })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.organizationId, productVariants.organizationId),
      ),
    )
    .where(
      and(
        eq(productVariants.organizationId, organizationId),
        eq(productVariants.barcode, barcode),
      ),
    )
    .limit(1)
  return rows[0] ? { product: rows[0].product, variant: rows[0].variant } : null
}

export async function findVariantByMerchantSku(
  db: Db,
  organizationId: string,
  merchantSku: string,
): Promise<{ product: Record<string, unknown>; variant: Record<string, unknown> } | null> {
  if (!merchantSku) return null
  const rows = await db
    .select({ variant: productVariants, product: products })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.id, productVariants.productId),
        eq(products.organizationId, productVariants.organizationId),
      ),
    )
    .where(
      and(
        eq(productVariants.organizationId, organizationId),
        eq(productVariants.merchantSku, merchantSku),
      ),
    )
    .limit(1)
  return rows[0] ? { product: rows[0].product, variant: rows[0].variant } : null
}

export async function countProducts(
  db: Db,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({ value: sql`count(*)::int` })
    .from(productVariants)
    .where(eq(productVariants.organizationId, organizationId))
  return Number(rows[0]?.value ?? 0)
}

// Bir ana ürünün varyantlarını upsert eder (unique org+product+externalVariantId
// → duplicate olmaz). existingVariantKeys ile insert/update ayrımı sayılır.
export async function replaceOrUpsertVariants(
  db: Db,
  organizationId: string,
  productId: string,
  variantProducts: Record<string, unknown>[],
  existingVariantKeys: Set<string> = new Set(),
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0
  let updated = 0
  for (const variant of variantProducts) {
    const key = `${productId}|${variantKeyOf(variant)}`
    const values = toVariantInsertValues(organizationId, productId, variant)
    await db
      .insert(productVariants)
      .values(values)
      .onConflictDoUpdate({
        target: [
          productVariants.organizationId,
          productVariants.productId,
          productVariants.externalVariantId,
        ],
        set: variantUpdateSet(variant),
      })
    if (existingVariantKeys.has(key)) updated += 1
    else inserted += 1
  }
  return { inserted, updated }
}

// Düz ürün listesini ana ürün + varyant olarak organization için upsert eder.
// first_seen/created_at KORUNUR (marketplaceUpdateSet). Insert/update ayrımı
// önceden çekilen mevcut anahtarlarla sayılır.
export async function upsertMarketplaceProducts(
  db: Db,
  organizationId: string,
  flatProducts: Record<string, unknown>[],
): Promise<{
  insertedProducts: number
  updatedProducts: number
  insertedVariants: number
  updatedVariants: number
  failed: number
  productKeys: string[]
}> {
  const marketplace = 'Trendyol'
  // Ana ürün bazında grupla (varyantlar tek ana ürün altında toplanır).
  const groups = new Map<string, Record<string, unknown>[]>()
  let failed = 0
  for (const product of flatProducts) {
    const key = productKeyOf(product)
    if (!key) {
      failed += 1
      continue
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(product)
  }
  const productKeys = [...groups.keys()]

  // Mevcut ana ürünleri (key → id) ve varyant anahtarlarını önceden çek.
  const existingProductRows =
    productKeys.length > 0
      ? await db
          .select({ id: products.id, externalProductId: products.externalProductId })
          .from(products)
          .where(
            and(
              eq(products.organizationId, organizationId),
              eq(products.marketplace, marketplace),
              inArray(products.externalProductId, productKeys),
            ),
          )
      : []
  const existingProductIds = new Set(
    existingProductRows.map((row: { externalProductId: string }) => row.externalProductId),
  )
  const existingProductIdList = existingProductRows.map(
    (row: { id: string }) => row.id,
  )
  const existingVariantKeys = new Set<string>()
  if (existingProductIdList.length > 0) {
    const variantRows = await db
      .select({
        productId: productVariants.productId,
        externalVariantId: productVariants.externalVariantId,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.organizationId, organizationId),
          inArray(productVariants.productId, existingProductIdList),
        ),
      )
    for (const row of variantRows) {
      existingVariantKeys.add(`${row.productId}|${row.externalVariantId}`)
    }
  }

  let insertedProducts = 0
  let updatedProducts = 0
  let insertedVariants = 0
  let updatedVariants = 0
  for (const [key, variants] of groups) {
    try {
      const insertValues = toProductInsertValues(organizationId, variants[0])
      const [row] = await db
        .insert(products)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [
            products.organizationId,
            products.marketplace,
            products.externalProductId,
          ],
          set: productMarketplaceUpdateSet(variants[0]),
        })
        .returning({ id: products.id })
      if (existingProductIds.has(key)) updatedProducts += 1
      else insertedProducts += 1
      const variantResult = await replaceOrUpsertVariants(
        db,
        organizationId,
        String(row.id),
        variants,
        existingVariantKeys,
      )
      insertedVariants += variantResult.inserted
      updatedVariants += variantResult.updated
    } catch {
      failed += 1
    }
  }
  return {
    insertedProducts,
    updatedProducts,
    insertedVariants,
    updatedVariants,
    failed,
    productKeys,
  }
}

// YALNIZ kanıtlı tam sync'te: fresh sette OLMAYAN, henüz arşivlenmemiş ürün ve
// varyantları arşivler (SİLMEZ). Partial sync'te ÇAĞRILMAZ.
export async function archiveMissingProducts(
  db: Db,
  organizationId: string,
  freshProductKeys: string[],
): Promise<number> {
  const rows = await db
    .select({ id: products.id, externalProductId: products.externalProductId })
    .from(products)
    .where(
      and(
        eq(products.organizationId, organizationId),
        eq(products.archived, false),
      ),
    )
  const fresh = new Set(freshProductKeys)
  const missing = rows.filter(
    (row: { externalProductId: string }) => !fresh.has(row.externalProductId),
  )
  let archived = 0
  for (const row of missing) {
    await db
      .update(products)
      .set({ archived: true, updatedAt: new Date() })
      .where(
        and(eq(products.organizationId, organizationId), eq(products.id, row.id)),
      )
    await db
      .update(productVariants)
      .set({ archived: true, updatedAt: new Date() })
      .where(
        and(
          eq(productVariants.organizationId, organizationId),
          eq(productVariants.productId, row.id),
        ),
      )
    archived += 1
  }
  return archived
}
