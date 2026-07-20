// Tek seferlik, AÇIKÇA çağrılan legacy ürün kataloğu import'u: dışa aktarılmış
// katalog JSON'u (cargoFlow_products_v4 / cargoflow-catalog-v1) → organization
// bazlı products + product_variants. Server başlangıcında ÇALIŞMAZ.
// organizationId açık arg ile ZORUNLUDUR. Export dosyası DEĞİŞTİRİLMEZ/silinmez.
// Duplicate'ler güvenli upsert edilir (mevcut kayıt korunur). Raw payload
// loglanmaz.
import { readFile } from 'node:fs/promises'
import { upsertMarketplaceProducts } from './productRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface ProductImportSummary {
  read: number
  insertedProducts: number
  updatedProducts: number
  insertedVariants: number
  updatedVariants: number
  failed: number
  dryRun: boolean
}

// Export dosyasından düz ürün dizisini çözer. Kabul edilen biçimler:
//  - CargoProduct[] (ham dizi)
//  - { products: CargoProduct[] } (katalog envelope)
//  - { "<sellerId>": { products: [...] } | CargoProduct[] } (scope haritası)
export function extractLegacyProducts(
  parsed: unknown,
  sellerId?: string,
): Record<string, unknown>[] {
  const isProduct = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object'
  const asProducts = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) return value.filter(isProduct)
    if (isProduct(value) && Array.isArray((value as Record<string, unknown>).products)) {
      return ((value as Record<string, unknown>).products as unknown[]).filter(isProduct)
    }
    return []
  }

  if (Array.isArray(parsed)) return parsed.filter(isProduct)
  if (!isProduct(parsed)) return []

  const direct = asProducts(parsed)
  if (direct.length > 0) return direct

  // Scope haritası: değerleri dizi veya {products:[...]} olan anahtarlar.
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([, value]) =>
      Array.isArray(value) ||
      (isProduct(value) && Array.isArray((value as Record<string, unknown>).products)),
  )
  if (entries.length === 0) return []
  const selected = sellerId
    ? entries.filter(([key]) =>
        key.toLowerCase().includes(String(sellerId).toLowerCase()),
      )
    : entries
  const source = selected.length > 0 ? selected : sellerId ? [] : entries
  return source.flatMap(([, value]) => asProducts(value))
}

export async function importLegacyProducts(
  db: Db,
  organizationId: string,
  options: { dryRun?: boolean; storePath: string; sellerId?: string },
): Promise<ProductImportSummary> {
  const dryRun = options.dryRun !== false // varsayılan güvenli: dry-run
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(options.storePath, 'utf8'))
  } catch {
    return {
      read: 0,
      insertedProducts: 0,
      updatedProducts: 0,
      insertedVariants: 0,
      updatedVariants: 0,
      failed: 0,
      dryRun,
    }
  }
  const records = extractLegacyProducts(parsed, options.sellerId)
  if (dryRun) {
    return {
      read: records.length,
      insertedProducts: 0,
      updatedProducts: 0,
      insertedVariants: 0,
      updatedVariants: 0,
      failed: 0,
      dryRun,
    }
  }
  const result = await upsertMarketplaceProducts(db, organizationId, records)
  return {
    read: records.length,
    insertedProducts: result.insertedProducts,
    updatedProducts: result.updatedProducts,
    insertedVariants: result.insertedVariants,
    updatedVariants: result.updatedVariants,
    failed: result.failed,
    dryRun,
  }
}
