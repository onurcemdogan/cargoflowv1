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
  | 'none'

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

function findProductMatch(
  item: OrderItem,
  products: CargoProduct[],
): { product?: CargoProduct; matchedBy: ProductImageMatchKey } {
  const candidates: Array<{
    key: Exclude<ProductImageMatchKey, 'orderLine' | 'none'>
    itemValue: string
    productValues: (product: CargoProduct) => unknown[]
  }> = [
    {
      key: 'productContentId',
      itemValue: normalizeKey(item.productContentId),
      productValues: (product) => [
        product.productContentId,
        product.externalProductId,
      ],
    },
    {
      key: 'productMainId',
      itemValue: normalizeKey(item.productMainId),
      productValues: (product) => [product.productMainId],
    },
    {
      key: 'barcode',
      itemValue: normalizeKey(item.barcode),
      productValues: (product) => [product.barcode],
    },
    {
      key: 'merchantSku',
      itemValue: normalizeKey(item.merchantSku),
      productValues: (product) => [product.sku, product.stockCode],
    },
    {
      key: 'sku',
      itemValue: normalizeKey(item.sku),
      productValues: (product) => [product.sku, product.stockCode],
    },
    {
      key: 'stockCode',
      itemValue: normalizeKey(item.stockCode),
      productValues: (product) => [product.stockCode, product.sku],
    },
    {
      key: 'productCode',
      itemValue: normalizeKey(item.productCode),
      productValues: (product) => [
        product.productCode,
        product.externalProductId,
      ],
    },
  ]

  for (const candidate of candidates) {
    if (!candidate.itemValue) continue
    const product = products.find((entry) =>
      candidate
        .productValues(entry)
        .map(normalizeKey)
        .includes(candidate.itemValue),
    )
    if (product) return { product, matchedBy: candidate.key }
  }
  return { matchedBy: 'none' }
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
  const trimmed = String(raw ?? '').trim()
  const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  return /^(https?:\/\/|data:image\/)/i.test(normalized) ? normalized : ''
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

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('tr-TR')
}
