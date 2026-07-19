import type { CargoOrder } from '../types/cargoflow'

export interface OrderCountSummary {
  packageCount: number
  orderCount: number
  lineCount: number
  quantityTotal: number
}

export function orderPackageIdentity(order: CargoOrder): string {
  const marketplace = normalizedIdentityPart(order.marketplace || 'unknown')
  const packageId = firstIdentity(order.packageId, order.shipmentPackageId)
  if (packageId) return `${marketplace}:package:${packageId}`

  const orderNumber = normalizedIdentityPart(order.orderNumber)
  if (orderNumber) return `${marketplace}:order:${orderNumber}`

  return `${marketplace}:record:${normalizedIdentityPart(
    order.externalOrderId || order.id,
  )}`
}

export function orderPackageIdentityCandidates(order: CargoOrder): string[] {
  const marketplace = normalizedIdentityPart(order.marketplace || 'unknown')
  return Array.from(
    new Set(
      [order.packageId, order.shipmentPackageId]
        .map(normalizedIdentityPart)
        .filter(Boolean)
        .map((value) => `${marketplace}:package:${value}`),
    ),
  )
}

export function orderNumberIdentity(order: CargoOrder): string {
  const marketplace = normalizedIdentityPart(order.marketplace || 'unknown')
  const orderNumber = normalizedIdentityPart(order.orderNumber)
  return orderNumber
    ? `${marketplace}:order:${orderNumber}`
    : orderPackageIdentity(order)
}

export function hasMarketplacePackageIdentity(order: CargoOrder): boolean {
  return orderPackageIdentityCandidates(order).length > 0
}

export function dedupeOrdersByPackageIdentity(
  orders: CargoOrder[],
): CargoOrder[] {
  const seen = new Set<string>()
  return orders.filter((order) => {
    const identity = orderPackageIdentity(order)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function buildOrderCountSummary(
  orders: CargoOrder[],
): OrderCountSummary {
  const packageIds = new Set<string>()
  const orderIds = new Set<string>()
  const lineIds = new Set<string>()
  let quantityTotal = 0

  orders.forEach((order) => {
    const packageIdentity = orderPackageIdentity(order)
    packageIds.add(packageIdentity)
    orderIds.add(orderNumberIdentity(order))

    order.items.forEach((item, index) => {
      const itemRecord = item as typeof item & Record<string, unknown>
      const lineIdentity = firstIdentity(
        item.id,
        itemRecord.lineId,
        itemRecord.orderLineId,
        itemRecord.lineItemId,
      )
      const fallbackIdentity = firstIdentity(
        item.barcode,
        item.merchantSku,
        item.sku,
        item.stockCode,
      )
      const key = `${packageIdentity}:line:${
        lineIdentity || `${fallbackIdentity || 'index'}:${index}`
      }`
      if (lineIds.has(key)) return
      lineIds.add(key)
      quantityTotal += finiteQuantity(item.quantity)
    })
  })

  return {
    packageCount: packageIds.size,
    orderCount: orderIds.size,
    lineCount: lineIds.size,
    quantityTotal,
  }
}

function firstIdentity(...values: unknown[]): string {
  return values.map(normalizedIdentityPart).find(Boolean) ?? ''
}

function normalizedIdentityPart(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('tr-TR')
}

function finiteQuantity(value: unknown): number {
  const quantity = Number(value ?? 0)
  return Number.isFinite(quantity) ? quantity : 0
}
