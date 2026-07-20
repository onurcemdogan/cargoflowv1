// Auth modu ürün kataloğu persistence servisi. Sync sonucu organization bazında
// PostgreSQL'e yazar; okuma sırasında düz CargoProduct listesini (4293 varyant
// koruması) reconstruct eder. Partial sync ürün SİLMEZ/ARŞİVLEMEZ.
import { randomUUID } from 'node:crypto'
import {
  archiveMissingProducts,
  countProducts,
  findProductById,
  findProducts,
  findVariantByBarcode,
  findVariantByMerchantSku,
  upsertMarketplaceProducts,
  type ProductFilters,
} from './productRepository.ts'
import { rowToProduct } from './productMapper.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface ProductSyncPersistResult {
  complete: boolean
  fetchedProductCount: number
  fetchedVariantCount: number
  insertedProducts: number
  updatedProducts: number
  insertedVariants: number
  updatedVariants: number
  failedCount: number
  archivedCount: number
  syncBatchId: string
}

// Başarılı ve TAM sync (complete=true) reconcile uygular (arşivleme). Partial/
// başarısız sync yalnız gördüğü ürünleri upsert eder; SİLME/ARŞİVLEME yok.
export async function persistProductSyncResult(
  db: Db,
  organizationId: string,
  flatProducts: Record<string, unknown>[],
  options: { complete: boolean },
): Promise<ProductSyncPersistResult> {
  const result = await upsertMarketplaceProducts(db, organizationId, flatProducts)
  let archivedCount = 0
  if (options.complete) {
    archivedCount = await archiveMissingProducts(db, organizationId, result.productKeys)
  }
  return {
    complete: options.complete,
    fetchedProductCount: result.productKeys.length,
    fetchedVariantCount: flatProducts.length,
    insertedProducts: result.insertedProducts,
    updatedProducts: result.updatedProducts,
    insertedVariants: result.insertedVariants,
    updatedVariants: result.updatedVariants,
    failedCount: result.failed,
    archivedCount,
    syncBatchId: randomUUID(),
  }
}

export async function listProducts(
  db: Db,
  organizationId: string,
  filters: ProductFilters = {},
): Promise<{
  products: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}> {
  const { rows, total, page, pageSize } = await findProducts(
    db,
    organizationId,
    filters,
  )
  return {
    products: rows.map((row) => rowToProduct(row.product, row.variant)),
    total,
    page,
    pageSize,
  }
}

export async function getProduct(
  db: Db,
  organizationId: string,
  variantId: string,
): Promise<Record<string, unknown> | null> {
  const found = await findProductById(db, organizationId, variantId)
  if (!found) return null
  return rowToProduct(found.product, found.variant)
}

// Sipariş satırı eşlemesi için org-scoped barcode → CargoProduct.
export async function resolveVariantByBarcode(
  db: Db,
  organizationId: string,
  barcode: string,
): Promise<Record<string, unknown> | null> {
  const found = await findVariantByBarcode(db, organizationId, barcode)
  if (!found) return null
  return rowToProduct(found.product, found.variant)
}

// Sipariş satırı eşlemesi için org-scoped merchantSku → CargoProduct.
export async function resolveVariantByMerchantSku(
  db: Db,
  organizationId: string,
  merchantSku: string,
): Promise<Record<string, unknown> | null> {
  const found = await findVariantByMerchantSku(db, organizationId, merchantSku)
  if (!found) return null
  return rowToProduct(found.product, found.variant)
}

export { countProducts }
