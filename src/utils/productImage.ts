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
  | 'modelColorSize'
  | 'nameVariant'
  | 'normalizedNameColorSize'
  | 'parentModel'
  | 'none'

export type ProductMatchFailureReason =
  | 'CACHE_NOT_SYNCED'
  | 'PRODUCT_NOT_IN_CACHE'
  | 'IDENTIFIER_MISMATCH'
  | 'VARIANT_NOT_IN_CACHE'
  | 'PRODUCT_FOUND_NO_IMAGE'
  | 'PARENT_PRODUCT_FOUND'
  | 'PARENT_PRODUCT_IMAGE_USED'
  | 'AMBIGUOUS_MATCH'
  | 'AMBIGUOUS_PARENT_MATCH'
  | 'MULTIPLE_NAME_MATCHES'
  | 'COLOR_CONFLICT'
  | 'SIZE_CONFLICT'
  | ''

export interface ProductImageResolution {
  url: string
  imageResolvedFrom: 'orderLine' | 'productCache' | 'parentProductCache' | 'none'
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
          ? // Bayat 'none' değeri yeni çözümlemeyi maskelemesin: cache
            // yenilendikten sonra matchedBy güncel eşleşmeden gelir.
            item.matchedBy &&
            item.matchedBy !== 'orderLine' &&
            item.matchedBy !== 'none'
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
    imageResolvedFrom: productImage.url
      ? match.matchedBy === 'parentModel'
        ? 'parentProductCache'
        : 'productCache'
      : 'none',
    imageSource: productImage.url ? productImage.source : 'none',
    matchedProduct: match.product,
    matchedProductId: match.product.id,
    matchedBy: match.matchedBy,
  }
}

// Görsel çözülemeyen satırlar için tanı sözleşmesi: normalize kimlikler,
// çıkarılan model/beden, exact eşleşme sayıları ve nihai ret nedeni.
export interface ProductMatchDebug {
  normalizedBarcode: string
  normalizedSku: string
  normalizedStockCode: string
  normalizedMerchantSku: string
  normalizedProductName: string
  extractedModelCode: string
  extractedColor: string
  extractedSize: string
  exactBarcodeMatches: number
  exactSkuMatches: number
  exactStockCodeMatches: number
  modelTokenMatches: number
  parentModelMatches: number
  normalizedNameMatches: number
  colorMatches: number
  sizeMatches: number
  candidateProductIds: string[]
  rejectionReasons: string[]
  matchedBy: ProductImageMatchKey
  matchedProductId: string
  finalFailureReason: ProductMatchFailureReason
}

export function buildProductMatchDebug(
  item: OrderItem,
  products: CargoProduct[],
): ProductMatchDebug {
  const match = resolveProductCacheMatch(item, products)
  const nameParts = parseProductNameParts(item.productName)
  const normalizedBarcode = normalizeProductIdentifier(item.barcode)
  const normalizedSku = normalizeProductIdentifier(item.sku)
  const normalizedStockCode = normalizeProductIdentifier(item.stockCode)
  const normalizedMerchantSku = normalizeProductIdentifier(item.merchantSku)
  const extractedModelCode = normalizeProductIdentifier(
    item.productMainId || extractModelCodeFromName(item.productName),
  )
  const extractedSize = normalizeProductIdentifier(item.size) || nameParts.size
  const itemColor = normalizeTrText(item.color) || nameParts.color
  const barcodeMatches = products.filter(
    (product) =>
      normalizedBarcode &&
      normalizeProductIdentifier(product.barcode) === normalizedBarcode,
  )
  const skuMatches = products.filter(
    (product) =>
      normalizedSku &&
      normalizeProductIdentifier(product.sku) === normalizedSku,
  )
  const stockCodeMatches = products.filter(
    (product) =>
      normalizedStockCode &&
      normalizeProductIdentifier(product.stockCode) === normalizedStockCode,
  )
  const parentMatches = products.filter(
    (product) =>
      extractedModelCode &&
      normalizeProductIdentifier(product.productMainId) === extractedModelCode,
  )
  const nameMatches = products.filter(
    (product) =>
      nameParts.baseName &&
      parseProductNameParts(product.productName).baseName ===
        nameParts.baseName,
  )
  const colorMatches = parentMatches.filter((product) =>
    colorsCompatible(itemColor, product.color),
  )
  const sizeMatches = parentMatches.filter(
    (product) =>
      extractedSize &&
      normalizeProductIdentifier(product.size) === extractedSize,
  )
  const rejectionReasons: string[] = []
  if (products.length === 0) rejectionReasons.push('CACHE_NOT_SYNCED')
  if (normalizedBarcode && barcodeMatches.length === 0) {
    rejectionReasons.push('exact barcode cache-de yok')
  }
  if (normalizedStockCode && stockCodeMatches.length === 0) {
    rejectionReasons.push('exact stockCode cache-de yok')
  }
  if (normalizedSku && skuMatches.length === 0) {
    rejectionReasons.push('exact sku cache-de yok')
  }
  if (normalizedMerchantSku && !extractedSize) {
    rejectionReasons.push('merchantSku tek başına yeterli değil (beden yok)')
  }
  if (extractedModelCode && parentMatches.length === 0) {
    rejectionReasons.push('parent model cache-de yok')
  }
  if (parentMatches.length > 0 && colorMatches.length === 0) {
    rejectionReasons.push('COLOR_CONFLICT (parent adaylarında uyumlu renk yok)')
  }
  const matchedImageMissing = Boolean(
    match.product &&
      !normalizeProductImageUrl(
        match.product.productImageUrl ??
          match.product.imageUrl ??
          match.product.images?.[0],
      ),
  )
  return {
    normalizedBarcode,
    normalizedSku,
    normalizedStockCode,
    normalizedMerchantSku,
    normalizedProductName: nameParts.baseName,
    extractedModelCode,
    extractedColor: itemColor,
    extractedSize,
    exactBarcodeMatches: barcodeMatches.length,
    exactSkuMatches: skuMatches.length,
    exactStockCodeMatches: stockCodeMatches.length,
    modelTokenMatches: parentMatches.length,
    parentModelMatches: parentMatches.length,
    normalizedNameMatches: nameMatches.length,
    colorMatches: colorMatches.length,
    sizeMatches: sizeMatches.length,
    candidateProductIds: [
      ...barcodeMatches,
      ...stockCodeMatches,
      ...skuMatches,
      ...parentMatches,
    ]
      .map((product) => product.id)
      .filter((id, index, list) => list.indexOf(id) === index)
      .slice(0, 8),
    rejectionReasons,
    matchedBy: match.matchedBy,
    matchedProductId: match.product?.id ?? '',
    finalFailureReason: matchedImageMissing
      ? 'PRODUCT_FOUND_NO_IMAGE'
      : match.failureReason,
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

// Türkçe metin normalizasyonu: küçük harf (tr), aksan katlama (ş→s, ı→i,
// ç→c, ğ→g, ö→o, ü→u), noktalama temizliği, tek boşluk. İsim/renk
// karşılaştırmaları bu tek sözleşmeyi kullanır.
export function normalizeTrText(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[ışçğöüâîû]/g, (char) =>
      ({
        ı: 'i', ş: 's', ç: 'c', ğ: 'g', ö: 'o', ü: 'u',
        â: 'a', î: 'i', û: 'u',
      })[char] ?? char,
    )
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Sık kullanılan Trendyol renk adları (normalize edilmiş; uzun ad önce
// aranır ki 'zumrut yesil' 'yesil'den önce yakalansın).
const KNOWN_COLOR_TOKENS = [
  'zumrut yesil', 'acik mavi', 'koyu yesil', 'koyu mavi', 'acik pembe',
  'siyah', 'beyaz', 'lacivert', 'bordo', 'yesil', 'kirmizi', 'mavi',
  'bej', 'ekru', 'vizon', 'pudra', 'gri', 'haki', 'mor', 'lila',
  'pembe', 'sax', 'tas', 'camel', 'kahverengi', 'kahve', 'turuncu',
  'sari', 'fusya', 'murdum', 'antrasit', 'krem', 'gumus', 'altin',
  'indigo', 'petrol', 'somon', 'mint', 'turkuaz',
]

export interface ParsedProductName {
  baseName: string
  modelToken: string
  color: string
  size: string
}

// "Büyük İspanyol Kol ... Zümrüt Yeşil zeyna-gfb44, 38" →
// { baseName:'buyuk ispanyol kol ...', modelToken:'zeyna-gfb44',
//   color:'zumrut yesil', size:'38' }
export function parseProductNameParts(value: unknown): ParsedProductName {
  const raw = String(value ?? '').trim()
  const sizeMatch = raw.match(/,\s*(\d{1,3})\s*$/u)
  const size = sizeMatch?.[1] ?? ''
  const withoutSize = raw.replace(/,\s*\d{1,3}\s*$/u, '').trim()
  const modelToken = extractModelCodeFromName(withoutSize)
  let normalized = normalizeTrText(withoutSize)
  if (modelToken) {
    const normalizedToken = normalizeTrText(modelToken)
    if (normalized.endsWith(normalizedToken)) {
      normalized = normalized
        .slice(0, normalized.length - normalizedToken.length)
        .trim()
    }
  }
  let color = ''
  for (const token of KNOWN_COLOR_TOKENS) {
    if (normalized === token || normalized.endsWith(` ${token}`)) {
      color = token
      normalized = normalized
        .slice(0, normalized.length - token.length)
        .trim()
      break
    }
  }
  return {
    baseName: normalized.length >= 8 ? normalized : '',
    modelToken: normalizeProductIdentifier(modelToken),
    color,
    size: normalizeProductIdentifier(size),
  }
}

// TR-fold normalize edilmiş base ad ("Önü Drapeli ... 6496, 42" →
// 'onu drapeli los tesettur takim'); renk/beden/model eki ayrılır.
function normalizeProductBaseName(value: unknown): string {
  return parseProductNameParts(value).baseName
}

// Renk uyumluluğu: normalize sonrası eşitlik VEYA kapsama ("zumrut yesil"
// ⊇ "yesil" uyumludur; "lacivert" vs "yesil" çelişkidir). Pazaryeri renk
// adlarının katalogdan farklı ayrıntıda yazılabildiği canlı vakadan
// (Zümrüt Yeşil vs Yeşil, newzeyna13) türetildi.
export function colorsCompatible(left: unknown, right: unknown): boolean {
  const a = normalizeTrText(left)
  const b = normalizeTrText(right)
  if (!a || !b) return true
  if (a === b) return true
  const aWords = a.split(' ')
  const bWords = b.split(' ')
  return (
    aWords.includes(b) ||
    bWords.includes(a) ||
    a.endsWith(` ${b}`) ||
    b.endsWith(` ${a}`)
  )
}

function variantConflicts(
  item: OrderItem,
  product: CargoProduct,
): boolean {
  return !colorsCompatible(item.color, product.color)
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
// 1-5) normalize edilmiş barcode/sku/stockCode/varyant kimlikleri (exact);
//      merchantSku TEK BAŞINA yeterli değildir — aynı merchantSku birden
//      çok varyantı temsil edebildiğinden beden teyidi de gerekir.
// 6) productMainId/model token (isimden çıkarılan) + renk çelişmez +
//    beden eşleşirse varyant (modelVariant); beden yoksa parent ürünün
//    görseli (parentModel) — ürün görseli çoğunlukla model bazlıdır.
// 7) base ürün adı — yalnız model tekilse; belirsizlikte eşleşme YAPILMAZ.
export function resolveProductCacheMatch(
  item: OrderItem,
  products: CargoProduct[],
): ProductCacheMatchResult {
  if (products.length === 0) {
    return { matchedBy: 'none', failureReason: 'CACHE_NOT_SYNCED' }
  }
  const index = getProductCacheIndex(products)
  // Öncelik (spec): barcode → stockCode → sku → (merchantSku yalnız beden
  // teyidiyle) → productCode → variantBarcode.
  const identifierAttempts: Array<
    [ProductImageMatchKey, string]
  > = [
    ['barcode', normalizeProductIdentifier(item.barcode)],
    ['stockCode', normalizeProductIdentifier(item.stockCode)],
    ['sku', normalizeProductIdentifier(item.sku)],
    ['merchantSku', normalizeProductIdentifier(item.merchantSku)],
    ['productCode', normalizeProductIdentifier(item.productCode)],
    ['variantBarcode', normalizeProductIdentifier(item.productContentId)],
  ]
  const hasAnyIdentifier = identifierAttempts.some(([, key]) => key)
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
    // merchantSku birden çok varyantı temsil edebilir: item beden bilgisi
    // taşıyorsa bedeni birebir tutan varyant şarttır; yoksa bu aşama
    // atlanır ve model/parent aşaması karar verir.
    if (matchedBy === 'merchantSku') {
      const itemSize = normalizeProductIdentifier(item.size)
      if (itemSize) {
        const sizeExact = candidates.find(
          (product) =>
            !variantConflicts(item, product) &&
            normalizeProductIdentifier(product.size) === itemSize,
        )
        if (sizeExact) {
          return { product: sizeExact, matchedBy, failureReason: '' }
        }
        continue
      }
      continue
    }
    // Varyant-tekil kimlik (barcode/stockCode/sku) TEK aday veriyorsa
    // eşleşme kesindir: pazaryeri renk adı katalogdan farklı yazılmış
    // olabilir (canlı vaka: 'Zümrüt Yeşil' vs 'Yeşil', newzeyna13); renk
    // adı kimlik eşleşmesini BOZAMAZ.
    if (
      candidates.length === 1 &&
      ['barcode', 'stockCode', 'sku'].includes(matchedBy)
    ) {
      return { product: candidates[0], matchedBy, failureReason: '' }
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
      const nonConflicting = candidates.filter(
        (product) => !variantConflicts(item, product),
      )
      if (nonConflicting.length === 0) {
        // Parent model bulundu ama renk çelişiyor: yanlış renk görseli
        // GÖSTERİLMEZ (Lacivert görsel Zümrüt ürüne kullanılmaz).
        return { matchedBy: 'none', failureReason: 'COLOR_CONFLICT' }
      }
      const itemSize = normalizeProductIdentifier(item.size)
      const sizeMatch = itemSize
        ? nonConflicting.find(
            (product) =>
              normalizeProductIdentifier(product.size) === itemSize,
          )
        : undefined
      if (sizeMatch) {
        return {
          product: sizeMatch,
          matchedBy: 'modelColorSize',
          failureReason: '',
        }
      }
      // Beden farkı parent görseli için engel değildir; görsel model
      // bazlıdır. Kaynak açıkça parentModel olarak işaretlenir.
      return {
        product: nonConflicting[0],
        matchedBy: 'parentModel',
        failureReason: 'PARENT_PRODUCT_IMAGE_USED',
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
        // Aynı isim birden fazla FARKLI modelde: yanlış görsel seçmek
        // yerine placeholder.
        return { matchedBy: 'none', failureReason: 'MULTIPLE_NAME_MATCHES' }
      }
      const nonConflicting = candidates.filter(
        (product) => !variantConflicts(item, product),
      )
      if (nonConflicting.length === 0) {
        return { matchedBy: 'none', failureReason: 'COLOR_CONFLICT' }
      }
      const itemSize = normalizeProductIdentifier(item.size)
      const sizeMatch = itemSize
        ? nonConflicting.find(
            (product) =>
              normalizeProductIdentifier(product.size) === itemSize,
          )
        : undefined
      if (sizeMatch) {
        return {
          product: sizeMatch,
          matchedBy: 'normalizedNameColorSize',
          failureReason: '',
        }
      }
      return {
        product: nonConflicting[0],
        matchedBy: 'parentModel',
        failureReason: 'PARENT_PRODUCT_IMAGE_USED',
      }
    }
  }

  return {
    matchedBy: 'none',
    failureReason: hasAnyIdentifier
      ? 'VARIANT_NOT_IN_CACHE'
      : 'IDENTIFIER_MISMATCH',
  }
}

// İsimden model token'ı: sondaki beden eki atıldıktan sonra rakam içeren
// son bağımsız token model kodu sayılır ("… Takım 6496, 42" → "6496",
// "… Elbise ttzeyna44, 38" → "ttzeyna44", "… zeynafb090-3" → "zeynafb090-3").
// Model token varsa fuzzy isim eşleşmesinden ÖNCE kullanılır.
export function extractModelCodeFromName(value: unknown): string {
  const text = String(value ?? '')
  const withoutSize = text.replace(/,\s*\d{1,3}\s*$/u, '').trim()
  const tokens = withoutSize.split(/\s+/)
  const lastToken = (tokens.at(-1) ?? '').replace(/[.,;:]+$/u, '')
  if (
    lastToken.length >= 4 &&
    /\d/.test(lastToken) &&
    /^[\p{L}\d_/-]+$/u.test(lastToken)
  ) {
    return lastToken
  }
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

