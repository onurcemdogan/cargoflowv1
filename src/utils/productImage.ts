import type { CargoProduct, OrderItem } from '../types/cargoflow'

export type ProductImageMatchKey =
  | 'orderLine'
  | 'productContentId'
  | 'productMainId'
  | 'barcode'
  | 'merchantSku'
  | 'sku'
  | 'stockCode'
  | 'productCode'
  | 'variantBarcode'
  | 'modelVariant'
  | 'nameVariant'
  | 'none'

export type ProductMatchFailureReason =
  | 'CACHE_NOT_SYNCED'
  | 'IDENTIFIER_MISMATCH'
  | 'PRODUCT_FOUND_NO_IMAGE'
  | 'AMBIGUOUS_MATCH'
  | ''

export interface ProductImageResolution {
  url: string
  imageResolvedFrom: 'orderLine' | 'productCache' | 'none'
  imageSource: string
  matchedProduct?: CargoProduct
  matchedProductId?: string
  matchedBy: ProductImageMatchKey
}

export function resolveProductImage(
  item: OrderItem,
  products: CargoProduct[] = [],
): ProductImageResolution {
  const rawLineImage = firstImage([
    ['line.productImageUrl', readPath(item.rawLine, ['productImageUrl'])],
    ['line.imageUrl', readPath(item.rawLine, ['imageUrl'])],
    ['line.productImage', readPath(item.rawLine, ['productImage'])],
    ['line.image', readPath(item.rawLine, ['image'])],
    ['line.thumbnail', readPath(item.rawLine, ['thumbnail'])],
    ['line.productMainImage', readPath(item.rawLine, ['productMainImage'])],
    [
      'line.productContentImage',
      readPath(item.rawLine, ['productContentImage']),
    ],
    ['line.images[0]', readPath(item.rawLine, ['images', '0'])],
    ['line.product.images[0]', readPath(item.rawLine, ['product', 'images', '0'])],
    ['line.product.image', readPath(item.rawLine, ['product', 'image'])],
    ['line.product.mainImage', readPath(item.rawLine, ['product', 'mainImage'])],
    ['line.product.media[0]', readPath(item.rawLine, ['product', 'media', '0'])],
  ])
  const normalizedItemImage = firstImage([
    ['line.productImageUrl', item.productImageUrl],
    ['line.imageUrl', item.imageUrl],
  ])
  const directImage = rawLineImage.url ? rawLineImage : normalizedItemImage
  if (directImage.url) {
    const productMatch = findProductMatch(item, products)
    const persistedProduct =
      products.find((product) => product.id === item.matchedProductId) ||
      productMatch.product
    const persistedProductImage = persistedProduct
      ? firstImage([
          ['product.images[0]', persistedProduct.images?.[0]],
          ['product.imageUrl', persistedProduct.imageUrl],
          ['product.productImageUrl', persistedProduct.productImageUrl],
          ['product.mainImage', readPath(persistedProduct, ['mainImage'])],
          ['product.thumbnail', readPath(persistedProduct, ['thumbnail'])],
          ['product.media[0]', readPath(persistedProduct, ['media', '0'])],
          ['product.pictures[0]', readPath(persistedProduct, ['pictures', '0'])],
          ['product.image', readPath(persistedProduct, ['image'])],
        ])
      : { url: '', source: 'none' }
    const inferredProductCache = Boolean(
      !rawLineImage.url &&
        persistedProduct &&
        persistedProductImage.url === directImage.url,
    )
    const resolvedFrom =
      item.imageResolvedFrom === 'productCache' || inferredProductCache
        ? 'productCache'
        : 'orderLine'
    return {
      url: directImage.url,
      imageResolvedFrom: resolvedFrom,
      imageSource:
        resolvedFrom === 'productCache'
          ? item.imageSource?.startsWith('product.')
            ? item.imageSource
            : persistedProductImage.source
          : rawLineImage.url
            ? rawLineImage.source
            : directImage.source,
      matchedProduct:
        resolvedFrom === 'productCache' ? persistedProduct : undefined,
      matchedProductId:
        resolvedFrom === 'productCache'
          ? item.matchedProductId || persistedProduct?.id
          : undefined,
      matchedBy:
        resolvedFrom === 'productCache'
          ? item.matchedBy && item.matchedBy !== 'orderLine'
            ? item.matchedBy
            : productMatch.matchedBy
          : 'orderLine',
    }
  }

  const match = findProductMatch(item, products)
  if (!match.product) {
    return {
      url: '',
      imageResolvedFrom: 'none',
      imageSource: 'none',
      matchedBy: 'none',
    }
  }

  const productImage = firstImage([
    ['product.images[0]', match.product.images?.[0]],
    ['product.images[0].url', readPath(match.product, ['images', '0', 'url'])],
    ['product.imageUrl', match.product.imageUrl],
    ['product.productImageUrl', match.product.productImageUrl],
    ['product.mainImage', readPath(match.product, ['mainImage'])],
    ['product.thumbnail', readPath(match.product, ['thumbnail'])],
    ['product.media[0]', readPath(match.product, ['media', '0'])],
    ['product.pictures[0]', readPath(match.product, ['pictures', '0'])],
    ['product.image', readPath(match.product, ['image'])],
  ])

  return {
    url: productImage.url,
    imageResolvedFrom: productImage.url ? 'productCache' : 'none',
    imageSource: productImage.url ? productImage.source : 'none',
    matchedProduct: match.product,
    matchedProductId: match.product.id,
    matchedBy: match.matchedBy,
  }
}

export function applyProductImageResolution(
  item: OrderItem,
  products: CargoProduct[],
): OrderItem {
  const resolution = resolveProductImage(item, products)
  return {
    ...item,
    imageUrl: resolution.url || undefined,
    productImageUrl: resolution.url || undefined,
    imageSource: resolution.imageSource,
    imageResolvedFrom: resolution.imageResolvedFrom,
    imageLoadError: resolution.url ? false : item.imageLoadError,
    matchedProductId: resolution.matchedProductId,
    matchedBy: resolution.matchedBy,
    desi: item.desi ?? resolution.matchedProduct?.desi ?? null,
    weightKg:
      item.weightKg ??
      resolution.matchedProduct?.weightKg ??
      resolution.matchedProduct?.kg ??
      null,
    lengthCm:
      item.lengthCm ?? resolution.matchedProduct?.lengthCm ?? null,
    widthCm:
      item.widthCm ?? resolution.matchedProduct?.widthCm ?? null,
    heightCm:
      item.heightCm ?? resolution.matchedProduct?.heightCm ?? null,
  }
}

// Kimlik normalizasyonu: trim + lowercase + boşluk temizliği; -, _ ve /
// ayraçları tek forma indirilir (649688-5 == 649688_5 == 649688/5, ama
// 649688-5 != 649688-6). Baştaki sıfırlar KORUNUR; harfli barkodlara
// dokunulmaz. Placeholder değerler ('merchantSku', 'sku', '-', 'null' vb.)
// kimlik SAYILMAZ.
const IDENTIFIER_PLACEHOLDERS = new Set([
  'merchantsku',
  'sku',
  'barcode',
  'barkod',
  'stockcode',
  'undefined',
  'null',
  'none',
  'yok',
  '-',
  '_',
  '/',
  '0',
])

export function normalizeProductIdentifier(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, '')
    .replace(/[-_/]+/g, '-')
  if (!normalized || IDENTIFIER_PLACEHOLDERS.has(normalized)) return ''
  return normalized
}

interface ProductCacheIndex {
  byIdentifier: Map<string, CargoProduct[]>
  byModel: Map<string, CargoProduct[]>
  byBaseName: Map<string, CargoProduct[]>
}

// Index bir kez kurulur (products dizisi referansına göre memoize); her
// satırda 4000+ ürün taranmaz.
const productCacheIndexes = new WeakMap<CargoProduct[], ProductCacheIndex>()

function getProductCacheIndex(products: CargoProduct[]): ProductCacheIndex {
  const cached = productCacheIndexes.get(products)
  if (cached) return cached
  const byIdentifier = new Map<string, CargoProduct[]>()
  const byModel = new Map<string, CargoProduct[]>()
  const byBaseName = new Map<string, CargoProduct[]>()
  const push = (map: Map<string, CargoProduct[]>, key: string, product: CargoProduct) => {
    if (!key) return
    const list = map.get(key)
    if (list) {
      if (!list.includes(product)) list.push(product)
    } else {
      map.set(key, [product])
    }
  }
  for (const product of products) {
    const record = product as CargoProduct & Record<string, unknown>
    const identifierValues: unknown[] = [
      product.barcode,
      product.sku,
      product.stockCode,
      product.productCode,
      product.productContentId,
      product.externalProductId,
      record.variantSku,
      record.variantBarcode,
    ]
    // Varyant dizileri de indexlenir (variants/items/stockItems/barcodes).
    for (const arrayKey of ['variants', 'items', 'stockItems', 'barcodes']) {
      const entries = record[arrayKey]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (typeof entry === 'string') {
          identifierValues.push(entry)
          continue
        }
        if (entry && typeof entry === 'object') {
          const variant = entry as Record<string, unknown>
          identifierValues.push(
            variant.barcode,
            variant.sku,
            variant.stockCode,
            variant.merchantSku,
          )
        }
      }
    }
    for (const value of identifierValues) {
      push(byIdentifier, normalizeProductIdentifier(value), product)
    }
    push(byModel, normalizeProductIdentifier(product.productMainId), product)
    push(byBaseName, normalizeProductBaseName(product.productName), product)
  }
  const index = { byIdentifier, byModel, byBaseName }
  productCacheIndexes.set(products, index)
  return index
}

// "Önü Drapeli Loş Tesettür Takım 6496, 42" → "önü drapeli loş tesettür takım 6496"
function normalizeProductBaseName(value: unknown): string {
  const base = String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/,\s*\d{1,3}\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return base.length >= 8 ? base : ''
}

function variantConflicts(
  item: OrderItem,
  product: CargoProduct,
): boolean {
  const itemColor = normalizeProductIdentifier(item.color)
  const productColor = normalizeProductIdentifier(product.color)
  return Boolean(itemColor && productColor && itemColor !== productColor)
}

function pickModelVariant(
  item: OrderItem,
  candidates: CargoProduct[],
): CargoProduct | undefined {
  const nonConflicting = candidates.filter(
    (product) => !variantConflicts(item, product),
  )
  if (nonConflicting.length === 0) return undefined
  const itemSize = normalizeProductIdentifier(item.size)
  const sizeMatch = itemSize
    ? nonConflicting.find(
        (product) =>
          normalizeProductIdentifier(product.size) === itemSize,
      )
    : undefined
  // Aynı model içinde beden farkı kabul edilebilir; farklı modeller arasında
  // asla seçim yapılmaz (çağıran taraf model tekilliğini garanti eder).
  return sizeMatch ?? nonConflicting[0]
}

export interface ProductCacheMatchResult {
  product?: CargoProduct
  matchedBy: ProductImageMatchKey
  failureReason: ProductMatchFailureReason
}

// Tek eşleştirme sözleşmesi. Öncelik:
// 1-5) normalize edilmiş barcode/merchantSku/sku/stockCode/varyant kimlikleri
//      (hepsi aynı index üzerinden exact match)
// 6) productMainId (model) + renk çelişmez + beden tercihli
// 7) base ürün adı + renk/beden (yalnız model tekilse) — son çare
// Belirsizlikte (birden fazla FARKLI model) eşleşme YAPILMAZ.
export function resolveProductCacheMatch(
  item: OrderItem,
  products: CargoProduct[],
): ProductCacheMatchResult {
  if (products.length === 0) {
    return { matchedBy: 'none', failureReason: 'CACHE_NOT_SYNCED' }
  }
  const index = getProductCacheIndex(products)
  const identifierAttempts: Array<
    [ProductImageMatchKey, string]
  > = [
    ['barcode', normalizeProductIdentifier(item.barcode)],
    ['merchantSku', normalizeProductIdentifier(item.merchantSku)],
    ['sku', normalizeProductIdentifier(item.sku)],
    ['stockCode', normalizeProductIdentifier(item.stockCode)],
    ['productCode', normalizeProductIdentifier(item.productCode)],
    ['variantBarcode', normalizeProductIdentifier(item.productContentId)],
  ]
  for (const [matchedBy, key] of identifierAttempts) {
    if (!key) continue
    const candidates = index.byIdentifier.get(key)
    if (!candidates || candidates.length === 0) continue
    const models = new Set(
      candidates.map((product) =>
        normalizeProductIdentifier(product.productMainId),
      ),
    )
    if (candidates.length > 1 && models.size > 1) {
      return { matchedBy: 'none', failureReason: 'AMBIGUOUS_MATCH' }
    }
    const product = pickModelVariant(item, candidates)
    if (product) return { product, matchedBy, failureReason: '' }
  }

  const modelKey = normalizeProductIdentifier(
    item.productMainId || extractModelCodeFromName(item.productName),
  )
  if (modelKey) {
    const candidates = index.byModel.get(modelKey)
    if (candidates && candidates.length > 0) {
      const product = pickModelVariant(item, candidates)
      if (product) {
        return { product, matchedBy: 'modelVariant', failureReason: '' }
      }
    }
  }

  const baseName = normalizeProductBaseName(item.productName)
  if (baseName) {
    const candidates = index.byBaseName.get(baseName)
    if (candidates && candidates.length > 0) {
      const models = new Set(
        candidates.map((product) =>
          normalizeProductIdentifier(product.productMainId),
        ),
      )
      if (models.size > 1) {
        return { matchedBy: 'none', failureReason: 'AMBIGUOUS_MATCH' }
      }
      const product = pickModelVariant(item, candidates)
      if (product) {
        return { product, matchedBy: 'nameVariant', failureReason: '' }
      }
    }
  }

  return { matchedBy: 'none', failureReason: 'IDENTIFIER_MISMATCH' }
}

// "…Takım 6496, 42" → "6496" (isimden model kodu; yalnız 4+ haneli son
// bağımsız sayı bloğu).
function extractModelCodeFromName(value: unknown): string {
  const text = String(value ?? '')
  const withoutSize = text.replace(/,\s*\d{1,3}\s*$/u, '')
  const matches = withoutSize.match(/\b\d{4,}\b/g)
  return matches?.at(-1) ?? ''
}

function findProductMatch(
  item: OrderItem,
  products: CargoProduct[],
): { product?: CargoProduct; matchedBy: ProductImageMatchKey } {
  const match = resolveProductCacheMatch(item, products)
  return { product: match.product, matchedBy: match.matchedBy }
}

function firstImage(
  candidates: Array<[string, unknown]>,
): { url: string; source: string } {
  for (const [source, value] of candidates) {
    const url = normalizeImageValue(value)
    if (url) return { url, source }
  }
  return { url: '', source: 'none' }
}

// Tek URL normalizasyon sözleşmesi:
// - baş/son boşluk ve HTML entity'leri temizlenir (&amp; → &)
// - protokolsüz `//cdn...` → `https://cdn...`
// - `http://` → `https://` (mixed-content engelini aşan tek seçenek)
// - yalnız https: ve data:image/ kabul edilir; javascript: vb. reddedilir
export function normalizeProductImageUrl(value: unknown): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  const decoded = trimmed
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
  let normalized = decoded.startsWith('//') ? `https:${decoded}` : decoded
  if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, 'https://')
  }
  return /^(https:\/\/|data:image\/)/i.test(normalized) ? normalized : ''
}

function normalizeImageValue(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : readFirstString(value, [
          ['url'],
          ['imageUrl'],
          ['productImageUrl'],
          ['original'],
        ])
  return normalizeProductImageUrl(raw)
}

// Sıralı, normalize edilmiş ve TEKİL görsel aday listesi. onError fallback
// zinciri ve tüm görünümler (liste/drawer/dashboard) bu tek kaynağı kullanır.
export function resolveProductImageCandidates(
  item: OrderItem,
  products: CargoProduct[] = [],
): Array<{ url: string; source: string }> {
  const match = findProductMatch(item, products)
  const persistedProduct =
    products.find((product) => product.id === item.matchedProductId) ||
    match.product
  const rawCandidates: Array<[string, unknown]> = [
    ['line.productImageUrl', readPath(item.rawLine, ['productImageUrl'])],
    ['line.imageUrl', readPath(item.rawLine, ['imageUrl'])],
    ['line.productImage', readPath(item.rawLine, ['productImage'])],
    ['line.image', readPath(item.rawLine, ['image'])],
    ['line.thumbnail', readPath(item.rawLine, ['thumbnail'])],
    ['line.productMainImage', readPath(item.rawLine, ['productMainImage'])],
    [
      'line.productContentImage',
      readPath(item.rawLine, ['productContentImage']),
    ],
    ['line.images[0]', readPath(item.rawLine, ['images', '0'])],
    [
      'line.product.images[0]',
      readPath(item.rawLine, ['product', 'images', '0']),
    ],
    ['line.product.image', readPath(item.rawLine, ['product', 'image'])],
    [
      'line.product.mainImage',
      readPath(item.rawLine, ['product', 'mainImage']),
    ],
    ['line.product.media[0]', readPath(item.rawLine, ['product', 'media', '0'])],
    ['item.productImageUrl', item.productImageUrl],
    ['item.imageUrl', item.imageUrl],
    ...(persistedProduct
      ? ([
          ['product.images[0]', persistedProduct.images?.[0]],
          [
            'product.images[0].url',
            readPath(persistedProduct, ['images', '0', 'url']),
          ],
          ['product.imageUrl', persistedProduct.imageUrl],
          ['product.productImageUrl', persistedProduct.productImageUrl],
          ['product.mainImage', readPath(persistedProduct, ['mainImage'])],
          ['product.thumbnail', readPath(persistedProduct, ['thumbnail'])],
          ['product.media[0]', readPath(persistedProduct, ['media', '0'])],
          [
            'product.pictures[0]',
            readPath(persistedProduct, ['pictures', '0']),
          ],
          ['product.image', readPath(persistedProduct, ['image'])],
        ] as Array<[string, unknown]>)
      : []),
  ]
  const seen = new Set<string>()
  const unique: Array<{ url: string; source: string }> = []
  for (const [source, value] of rawCandidates) {
    const url = normalizeImageValue(value)
    if (!url || seen.has(url)) continue
    seen.add(url)
    unique.push({ url, source })
  }
  return unique
}

function readFirstString(value: unknown, paths: string[][]): string {
  for (const path of paths) {
    const found = readPath(value, path)
    if (typeof found === 'string' && found.trim()) return found.trim()
  }
  return ''
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)]
      continue
    }
    if (!current || typeof current !== 'object') return undefined
    const entry = Object.entries(current).find(
      ([key]) =>
        key.toLocaleLowerCase('tr-TR') ===
        segment.toLocaleLowerCase('tr-TR'),
    )
    if (!entry) return undefined
    current = entry[1]
  }
  return current
}

