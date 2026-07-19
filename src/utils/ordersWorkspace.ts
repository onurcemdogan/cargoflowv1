import type { CargoOrder } from '../types/cargoflow'

export type OrdersSortKey =
  | 'orderDate'
  | 'orderNumber'
  | 'customerName'
  | 'status'
  | 'cargo'

export type OrdersSortDirection = 'asc' | 'desc'

export function sortOrdersForWorkspace(
  orders: CargoOrder[],
  sortKey: OrdersSortKey,
  direction: OrdersSortDirection,
): CargoOrder[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...orders].sort((left, right) => {
    if (sortKey === 'orderDate') {
      const leftTime = validTime(left.orderDate || left.createdAt)
      const rightTime = validTime(right.orderDate || right.createdAt)
      return (leftTime - rightTime) * multiplier
    }
    const leftValue = sortableValue(left, sortKey)
    const rightValue = sortableValue(right, sortKey)
    return leftValue.localeCompare(rightValue, 'tr-TR', {
      numeric: true,
      sensitivity: 'base',
    }) * multiplier
  })
}

export function paginateOrders<T>(
  items: T[],
  requestedPage: number,
  pageSize: number,
) {
  const safePageSize = Math.max(1, Math.floor(pageSize) || 1)
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize))
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount)
  const startIndex = (page - 1) * safePageSize
  return {
    items: items.slice(startIndex, startIndex + safePageSize),
    page,
    pageCount,
    pageSize: safePageSize,
    startIndex,
    endIndex: Math.min(items.length, startIndex + safePageSize),
    totalItems: items.length,
  }
}

export function visiblePageNumbers(page: number, pageCount: number): number[] {
  if (pageCount <= 5) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }
  return Array.from(
    new Set([1, page - 1, page, page + 1, pageCount]),
  ).filter((value) => value >= 1 && value <= pageCount)
}

function sortableValue(order: CargoOrder, key: OrdersSortKey): string {
  if (key === 'orderNumber') return order.orderNumber
  if (key === 'customerName') return order.customerName
  if (key === 'status') return order.operationStatus || order.status
  if (key === 'cargo') return order.cargoProviderName || ''
  return ''
}

function validTime(value?: string): number {
  const time = new Date(value || '').getTime()
  return Number.isNaN(time) ? 0 : time
}
