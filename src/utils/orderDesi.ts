import type {
  CargoOrder,
  CargoProduct,
  OrderItem,
  TenantDesiConfig,
} from '../types/cargoflow'
import { resolveProductCacheMatch } from './productImage'

// Satır bazlı birim desi kaynak öncelikleri (yukarıdan aşağıya):
// order_line → product_variant → product_cache → merchant_mapping
// → category_default → tenant_default. Hiçbiri yoksa satır "eksik" sayılır
// ve toplam HESAPLANMAZ (sessiz yanlış hesap yerine engelleme).
export type LineDesiSource =
  | 'order_line'
  | 'product_variant'
  | 'product_cache'
  | 'merchant_mapping'
  | 'category_default'
  | 'tenant_default'

export type LineDesiExclusion = 'duplicate_line' | 'cancelled_line'

export interface LineDesiBreakdown {
  lineId: string
  productName: string
  sku: string
  barcode: string
  quantity: number
  unitDesi: number | null
  unitDesiSource: LineDesiSource | null
  lineTotalDesi: number | null
  excludedReason: LineDesiExclusion | null
}

export type FinalDesiSource = 'manual_total' | 'product_lines'

export interface OrderDesiCalculation {
  lines: LineDesiBreakdown[]
  countedLines: LineDesiBreakdown[]
  missingLines: LineDesiBreakdown[]
  calculatedTotalDesi: number | null
  manualTotalDesi: number | null
  finalDesi: number | null
  finalDesiSource: FinalDesiSource | null
  // Adet=1 sözleşmesi: sipariş TEK koli olarak gönderilir; ürün sayısı
  // koli sayısı DEĞİLDİR. BirimDesi bu tek kolinin toplam desisidir.
  parcelCount: number
  blockedReason: string | null
}

export const DEFAULT_TENANT_DESI_CONFIG: TenantDesiConfig = {
  defaultUnitDesi: null,
  categoryDefaults: {},
  productOverrides: {},
  variantOverrides: {},
}

export function normalizeTenantDesiConfig(
  value?: Partial<TenantDesiConfig> | null,
): TenantDesiConfig {
  return {
    defaultUnitDesi: positiveNumber(value?.defaultUnitDesi),
    categoryDefaults: normalizeOverrideMap(value?.categoryDefaults),
    productOverrides: normalizeOverrideMap(value?.productOverrides),
    variantOverrides: normalizeOverrideMap(value?.variantOverrides),
  }
}

export function resolveLineUnitDesi(
  item: OrderItem,
  products: CargoProduct[],
  desiConfig: TenantDesiConfig,
): { unitDesi: number | null; unitDesiSource: LineDesiSource | null } {
  const lineDesi = firstNumber(
    positiveNumber(item.desi),
    positiveNumber(readDeep(item.rawLine, ['dimensionalWeight'])),
    positiveNumber(readDeep(item.rawLine, ['desi'])),
  )
  if (lineDesi != null) {
    return { unitDesi: lineDesi, unitDesiSource: 'order_line' }
  }

  const match = resolveProductCacheMatch(item, products)
  const productDesi = positiveNumber(match.product?.desi)
  if (productDesi != null) {
    const variantLevel =
      match.matchedBy === 'barcode' || match.matchedBy === 'variantBarcode'
    return {
      unitDesi: productDesi,
      unitDesiSource: variantLevel ? 'product_variant' : 'product_cache',
    }
  }

  const variantOverride = readOverride(desiConfig.variantOverrides, [
    item.barcode,
    match.product?.barcode,
  ])
  const productOverride = readOverride(desiConfig.productOverrides, [
    item.merchantSku,
    item.sku,
    item.stockCode,
    item.productCode,
    item.productMainId,
    match.product?.sku,
    match.product?.stockCode,
    match.product?.productCode,
    match.product?.productMainId,
  ])
  const mappingDesi = firstNumber(variantOverride, productOverride)
  if (mappingDesi != null) {
    return { unitDesi: mappingDesi, unitDesiSource: 'merchant_mapping' }
  }

  const categoryDesi = readOverride(desiConfig.categoryDefaults, [
    match.product?.category,
    readDeep(item.rawLine, ['categoryName']),
  ])
  if (categoryDesi != null) {
    return { unitDesi: categoryDesi, unitDesiSource: 'category_default' }
  }

  if (desiConfig.defaultUnitDesi != null) {
    return {
      unitDesi: desiConfig.defaultUnitDesi,
      unitDesiSource: 'tenant_default',
    }
  }

  return { unitDesi: null, unitDesiSource: null }
}

// Tek hesap sözleşmesi:
// calculatedTotalDesi = sum(line.quantity × resolveLineUnitDesi(line))
// Manuel "Toplam koli desisi" girildiyse (manual/manual_total) toplam
// AYNEN kullanılır, quantity ile tekrar ÇARPILMAZ.
export function calculateOrderDesi(
  order: CargoOrder,
  products: CargoProduct[],
  desiConfig?: Partial<TenantDesiConfig> | null,
): OrderDesiCalculation {
  const config = normalizeTenantDesiConfig(desiConfig)
  const seenLineIds = new Set<string>()
  const lines: LineDesiBreakdown[] = (order.items ?? []).map((item, index) => {
    const lineId = String(item.id ?? `line-${index}`)
    const quantity = Math.max(0, Math.round(Number(item.quantity) || 0))
    let excludedReason: LineDesiExclusion | null = null
    if (seenLineIds.has(lineId)) {
      // Aynı lineId iki kez gelirse ikinci kopya toplama katılmaz.
      excludedReason = 'duplicate_line'
    } else {
      seenLineIds.add(lineId)
      if (quantity <= 0 || isCancelledLine(item)) {
        excludedReason = 'cancelled_line'
      }
    }
    const resolved =
      excludedReason == null
        ? resolveLineUnitDesi(item, products, config)
        : { unitDesi: null, unitDesiSource: null }
    const lineTotalDesi =
      excludedReason == null && resolved.unitDesi != null
        ? round2(quantity * resolved.unitDesi)
        : null
    return {
      lineId,
      productName: item.productName || '',
      sku: item.merchantSku || item.sku || '',
      barcode: item.barcode || '',
      quantity,
      unitDesi: resolved.unitDesi,
      unitDesiSource: resolved.unitDesiSource,
      lineTotalDesi,
      excludedReason,
    }
  })

  const countedLines = lines.filter((line) => line.excludedReason == null)
  const missingLines = countedLines.filter((line) => line.unitDesi == null)
  const calculatedTotalDesi =
    countedLines.length > 0 && missingLines.length === 0
      ? round2(
          countedLines.reduce(
            (total, line) => total + (line.lineTotalDesi ?? 0),
            0,
          ),
        )
      : null

  const manualSource =
    order.desiSource ?? order.shipment?.desiSource ?? null
  const manualTotalDesi =
    manualSource === 'manual' || manualSource === 'manual_total'
      ? firstNumber(
          positiveNumber(order.desi),
          positiveNumber(order.shipment?.desi),
        )
      : null

  let finalDesi: number | null = null
  let finalDesiSource: FinalDesiSource | null = null
  let blockedReason: string | null = null
  if (manualTotalDesi != null) {
    finalDesi = manualTotalDesi
    finalDesiSource = 'manual_total'
  } else if (calculatedTotalDesi != null) {
    finalDesi = calculatedTotalDesi
    finalDesiSource = 'product_lines'
  } else if (countedLines.length === 0) {
    blockedReason =
      'Desi hesaplanamadı: siparişte geçerli (iptal edilmemiş) ürün satırı yok.'
  } else {
    blockedReason = `${missingLines.length} ürünün desi bilgisi eksik.`
  }

  return {
    lines,
    countedLines,
    missingLines,
    calculatedTotalDesi,
    manualTotalDesi,
    finalDesi,
    finalDesiSource,
    parcelCount: 1,
    blockedReason,
  }
}

export function describeLineDesiSource(
  source: LineDesiSource | null,
): string {
  switch (source) {
    case 'order_line':
      return 'Sipariş satırı'
    case 'product_variant':
      return 'Ürün varyantı'
    case 'product_cache':
      return 'Ürün kataloğu'
    case 'merchant_mapping':
      return 'Satıcı eşlemesi'
    case 'category_default':
      return 'Kategori varsayılanı'
    case 'tenant_default':
      return 'Tenant varsayılanı'
    default:
      return 'Eksik'
  }
}

function isCancelledLine(item: OrderItem): boolean {
  const status = String(
    readDeep(item.rawLine, ['orderLineItemStatusName']) ??
      readDeep(item.rawLine, ['status']) ??
      '',
  ).toLocaleLowerCase('tr-TR')
  return status.includes('cancel') || status.includes('iptal')
}

function readOverride(
  map: Record<string, number>,
  keys: Array<unknown>,
): number | null {
  for (const key of keys) {
    const normalized = normalizeOverrideKey(key)
    if (!normalized) continue
    const value = positiveNumber(map[normalized])
    if (value != null) return value
  }
  return null
}

function normalizeOverrideMap(
  value?: Record<string, unknown> | null,
): Record<string, number> {
  const result: Record<string, number> = {}
  if (!value || typeof value !== 'object') return result
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = normalizeOverrideKey(key)
    const parsed = positiveNumber(raw)
    if (normalizedKey && parsed != null) {
      result[normalizedKey] = parsed
    }
  }
  return result
}

function normalizeOverrideKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'string') {
    value = value.trim().replace(',', '.')
  }
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? round2(number) : null
}

function firstNumber(...values: Array<number | null>): number | null {
  return values.find((value) => value != null) ?? null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function readDeep(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readDeep(item, keys)
      if (found != null && found !== '') return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const [key, item] of Object.entries(record)) {
    if (
      keys.some(
        (candidate) =>
          candidate.toLocaleLowerCase('tr-TR') ===
          key.toLocaleLowerCase('tr-TR'),
      )
    ) {
      return item
    }
    const nested = readDeep(item, keys)
    if (nested != null && nested !== '') return nested
  }
  return undefined
}
