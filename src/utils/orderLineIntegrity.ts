// Sipariş satır bütünlüğü TANI yardımcısı (SAF). order_line duplication
// hatasını YALNIZ tespit eder ve DEV/diagnostic metadata üretir; üretim UI'ında
// sessizce quantity düzeltmesi veya client-side dedupe YAPMAZ. Asıl çözüm
// persistence katmanındadır (canonical externalLineId + reconcile-delete).
//
// Bozuk invariant: aynı canonical satır anahtarı birden çok kez var VE
// sum(lineTotal) sipariş totalAmount'ından AŞIRI yüksek. Bu, cross-path
// (normal sync vs backfill) duplicate satırın işaretidir.

interface IntegrityItem {
  id?: unknown
  orderLineId?: unknown
  productContentId?: unknown
  productMainId?: unknown
  productCode?: unknown
  merchantSku?: unknown
  sku?: unknown
  stockCode?: unknown
  barcode?: unknown
  price?: unknown
  quantity?: unknown
}
interface IntegrityOrder {
  items?: IntegrityItem[]
  totalAmount?: unknown
  totalPrice?: unknown
}

const TY_LINE_PREFIX = 'ty_line_'
function str(value: unknown): string {
  return String(value ?? '').trim()
}
function stripLinePrefix(id: string): string {
  return id.startsWith(TY_LINE_PREFIX) ? id.slice(TY_LINE_PREFIX.length) : id
}

// Frontend canonical satır anahtarı (server canonicalLineKey ile AYNI mantık):
// gerçek provider id (ty_line_ soyulmuş) → yoksa içerik (barcode-only DEĞİL).
export function canonicalItemKey(item: IntegrityItem, index: number): string {
  const providerId = stripLinePrefix(str(item.id) || str(item.orderLineId))
  if (providerId) return providerId
  return [
    str(item.productContentId ?? item.productMainId ?? item.productCode),
    str(item.merchantSku ?? item.sku ?? item.stockCode),
    str(item.barcode),
    str(item.price),
    String(index),
  ].join('|')
}

export interface OrderLineIntegrity {
  // Kanıtlanmış duplicate şüphesi (DEV/diagnostic; UI davranışını değiştirmez).
  suspectedDuplicate: boolean
  duplicateKeyCount: number
  lineTotalSum: number
  orderTotal: number
  // sum(lineTotal) / totalAmount (1'e yakınsa sağlıklı; ≫1 şüpheli).
  ratio: number
}

// sum(lineTotal) totalAmount'ı bu oranın üstünde aşarsa "aşırı yüksek" sayılır
// (yuvarlama/indirim toleransının belirgin üstü).
const EXCESS_RATIO = 1.5

export function detectOrderLineDuplication(order: IntegrityOrder): OrderLineIntegrity {
  const items = Array.isArray(order.items) ? order.items : []
  const keyCounts = new Map<string, number>()
  let lineTotalSum = 0
  items.forEach((item, index) => {
    const price = Number(item.price)
    const quantity = Math.max(0, Number(item.quantity) || 0)
    if (Number.isFinite(price)) lineTotalSum += price * quantity
    const key = canonicalItemKey(item, index)
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
  })
  let duplicateKeyCount = 0
  for (const count of keyCounts.values()) if (count > 1) duplicateKeyCount += 1

  const orderTotalRaw = Number(order.totalAmount ?? order.totalPrice)
  const orderTotal = Number.isFinite(orderTotalRaw) && orderTotalRaw > 0 ? orderTotalRaw : 0
  const ratio = orderTotal > 0 ? lineTotalSum / orderTotal : 0
  const suspectedDuplicate =
    duplicateKeyCount > 0 && orderTotal > 0 && ratio > EXCESS_RATIO
  return {
    suspectedDuplicate,
    duplicateKeyCount,
    lineTotalSum: Math.round(lineTotalSum * 100) / 100,
    orderTotal,
    ratio: Math.round(ratio * 1000) / 1000,
  }
}
