// Normalized Trendyol ürünü (düz varyant listesi) ↔ DB satır eşlemesi.
// products (ana kayıt) + product_variants ayrımı: her düz CargoProduct bir
// varyanttır; okuma sırasında varyant başına bir CargoProduct reconstruct edilir
// (4293 varyant koruması). Raw payload şifreli; başlık/barkod/SKU/görsel açık.
import {
  decryptProductPayload,
  encryptProductPayload,
} from './productEncryption.ts'

function str(value: unknown): string {
  return String(value ?? '').trim()
}
function num(value: unknown): string | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed !== 0 ? String(parsed) : null
}
function optionalDate(value: unknown): Date | null {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? new Date(time) : null
}
function boolOrNull(value: unknown): boolean | null {
  if (value == null || value === '') return null
  if (typeof value === 'boolean') return value
  const text = String(value).toLowerCase()
  if (['approved', 'active', 'onsale', 'true', '1'].includes(text)) return true
  if (['rejected', 'passive', 'archived', 'false', '0'].includes(text)) return false
  return null
}

// Düz ürünün ana ürün kimliği (varyantların gruplandığı anahtar).
export function productKeyOf(product: Record<string, unknown>): string {
  return (
    str(product.externalProductId) ||
    str(product.productMainId) ||
    str(product.productCode) ||
    str(product.productContentId) ||
    str(product.id)
  )
}

// Düz ürünün varyant kimliği (ana ürün altında benzersiz).
export function variantKeyOf(product: Record<string, unknown>): string {
  return (
    str(product.externalVariantId) ||
    str(product.barcode) ||
    str(product.sku) ||
    str(product.id)
  )
}

// Ana ürün INSERT değerleri (ilk görülme).
export function toProductInsertValues(
  organizationId: string,
  product: Record<string, unknown>,
): Record<string, unknown> {
  return {
    organizationId,
    marketplace: str(product.marketplace) || 'Trendyol',
    externalProductId: productKeyOf(product),
    title: str(product.productName) || 'Ürün',
    brand: str(product.brand) || null,
    categoryName: str(product.category) || null,
    productMainId: str(product.productMainId) || null,
    approved: boolOrNull(product.productStatus ?? product.approved),
    archived: false,
    marketplaceCreatedAt: optionalDate(product.createdAt),
    marketplaceLastModifiedAt: optionalDate(product.updatedAt),
    rawPayloadEncrypted: encryptProductPayload(product.rawProduct ?? product),
  }
}

// Conflict UPDATE: YALNIZ marketplace kaynaklı alanlar güncellenir. first_seen_at,
// created_at KORUNUR. Tekrar görülen ürün arşivden çıkar (archived=false).
export function productMarketplaceUpdateSet(
  product: Record<string, unknown>,
): Record<string, unknown> {
  return {
    title: str(product.productName) || 'Ürün',
    brand: str(product.brand) || null,
    categoryName: str(product.category) || null,
    productMainId: str(product.productMainId) || null,
    approved: boolOrNull(product.productStatus ?? product.approved),
    archived: false,
    marketplaceLastModifiedAt: optionalDate(product.updatedAt),
    rawPayloadEncrypted: encryptProductPayload(product.rawProduct ?? product),
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }
}

// Varyant INSERT değerleri.
export function toVariantInsertValues(
  organizationId: string,
  productId: string,
  product: Record<string, unknown>,
): Record<string, unknown> {
  const images = Array.isArray(product.images) ? product.images : []
  const primaryImage =
    str(product.imageUrl) || str(product.productImageUrl) || str(images[0]) || null
  return {
    organizationId,
    productId,
    externalVariantId: variantKeyOf(product),
    merchantSku: str(product.sku ?? product.merchantSku) || null,
    barcode: str(product.barcode) || null,
    stockCode: str(product.stockCode) || null,
    color: str(product.color) || null,
    size: str(product.size) || null,
    attributes: product.variantAttributes ?? null,
    imageUrls: images.length > 0 ? images : null,
    primaryImageUrl: primaryImage,
    quantity: Number.isFinite(Number(product.stock))
      ? Math.trunc(Number(product.stock))
      : null,
    salePrice: num(product.price ?? product.salePrice),
    listPrice: num(product.listPrice),
    approved: boolOrNull(product.productStatus ?? product.approved),
    archived: false,
    marketplaceLastModifiedAt: optionalDate(product.updatedAt),
    rawPayloadEncrypted: encryptProductPayload(product.rawProduct ?? product),
  }
}

// Varyant conflict UPDATE seti (marketplace kaynaklı alanlar).
export function variantUpdateSet(
  product: Record<string, unknown>,
): Record<string, unknown> {
  const values = toVariantInsertValues('', '', product)
  return {
    merchantSku: values.merchantSku,
    barcode: values.barcode,
    stockCode: values.stockCode,
    color: values.color,
    size: values.size,
    attributes: values.attributes,
    imageUrls: values.imageUrls,
    primaryImageUrl: values.primaryImageUrl,
    quantity: values.quantity,
    salePrice: values.salePrice,
    listPrice: values.listPrice,
    approved: values.approved,
    archived: false,
    marketplaceLastModifiedAt: values.marketplaceLastModifiedAt,
    rawPayloadEncrypted: values.rawPayloadEncrypted,
    updatedAt: new Date(),
  }
}

// DB satırları → düz CargoProduct view-model. Şifreli raw payload çözülüp DB
// kolonlarıyla overlay edilir; böylece görsel resolver'ın kullandığı
// productContentId/productCode/images gibi alanlar BİRE BİR korunur.
export function rowToProduct(
  productRow: Record<string, unknown>,
  variantRow: Record<string, unknown>,
): Record<string, unknown> {
  const raw =
    (decryptProductPayload(
      variantRow.rawPayloadEncrypted as string | null,
    ) as Record<string, unknown> | null) ??
    (decryptProductPayload(
      productRow.rawPayloadEncrypted as string | null,
    ) as Record<string, unknown> | null) ??
    {}
  const images = Array.isArray(variantRow.imageUrls)
    ? (variantRow.imageUrls as string[])
    : Array.isArray(raw.images)
      ? (raw.images as string[])
      : []
  const primaryImage =
    str(variantRow.primaryImageUrl) || str(raw.imageUrl) || str(images[0])
  return {
    ...raw,
    id: str(variantRow.id),
    marketplace: str(productRow.marketplace) || 'Trendyol',
    externalProductId: str(productRow.externalProductId) || str(raw.externalProductId),
    externalVariantId: str(variantRow.externalVariantId) || str(raw.externalVariantId),
    productMainId: str(productRow.productMainId) || str(raw.productMainId),
    productContentId: str(raw.productContentId) || str(productRow.externalProductId),
    productCode: str(raw.productCode) || str(productRow.externalProductId),
    productName: str(productRow.title) || str(raw.productName) || 'Ürün',
    brand: str(productRow.brand) || str(raw.brand) || undefined,
    category: str(productRow.categoryName) || str(raw.category) || undefined,
    sku: str(variantRow.merchantSku) || str(raw.sku),
    stockCode: str(variantRow.stockCode) || str(raw.stockCode) || undefined,
    barcode: str(variantRow.barcode) || str(raw.barcode),
    color: str(variantRow.color) || str(raw.color) || undefined,
    size: str(variantRow.size) || str(raw.size) || undefined,
    variantAttributes: (variantRow.attributes ?? raw.variantAttributes ?? []) as unknown,
    images,
    imageUrl: primaryImage,
    productImageUrl: primaryImage,
    stock: Number(variantRow.quantity ?? raw.stock ?? 0),
    price: Number(variantRow.salePrice ?? raw.price ?? 0),
    productStatus: str(raw.productStatus) || undefined,
    archived: Boolean(variantRow.archived),
    source: 'real',
    createdAt: str(raw.createdAt) || undefined,
    updatedAt:
      variantRow.updatedAt instanceof Date
        ? variantRow.updatedAt.toISOString()
        : str(raw.updatedAt) || new Date(0).toISOString(),
  }
}
