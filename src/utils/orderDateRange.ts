import type { CargoOrder } from '../types/cargoflow'

export const ORDERS_TIME_ZONE = 'Europe/Istanbul'

export type OrdersDatePreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'last3'
  | 'last7'
  | 'last30'
  | 'custom'

export interface OrdersDateRange {
  startDate?: Date
  endDate?: Date
  startTime: number
  endTime: number
  timezone: string
}

export function buildOrdersDateRange(
  preset: OrdersDatePreset,
  customStartDate = '',
  customEndDate = '',
  now = new Date(),
  timezone = ORDERS_TIME_ZONE,
): OrdersDateRange {
  if (preset === 'all') {
    return {
      startDate: undefined,
      endDate: undefined,
      startTime: Number.NEGATIVE_INFINITY,
      endTime: Number.POSITIVE_INFINITY,
      timezone,
    }
  }

  const today = dateKeyInTimeZone(now, timezone)
  let startKey = today
  let endKey = today

  if (preset === 'yesterday') {
    startKey = shiftDateKey(today, -1)
    endKey = startKey
  } else if (preset === 'custom' && customStartDate && customEndDate) {
    startKey = customStartDate
    endKey = customEndDate
  } else if (preset !== 'today') {
    const dayCount = preset === 'last3' ? 3 : preset === 'last30' ? 30 : 7
    startKey = shiftDateKey(today, -(dayCount - 1))
  }

  const startTime = zonedDateTimeToEpoch(startKey, timezone, 0, 0, 0, 0)
  const endTime = zonedDateTimeToEpoch(endKey, timezone, 23, 59, 59, 999)
  return {
    startDate: new Date(startTime),
    endDate: new Date(endTime),
    startTime,
    endTime,
    timezone,
  }
}

export function isOrderWithinDateRange(
  order: Pick<CargoOrder, 'orderDate' | 'createdAt'>,
  range: Pick<OrdersDateRange, 'startTime' | 'endTime'>,
  timezone = ORDERS_TIME_ZONE,
): boolean {
  const orderTime = parseMarketplaceDate(
    order.orderDate || order.createdAt,
    timezone,
  )
  return (
    Number.isFinite(orderTime) &&
    orderTime >= range.startTime &&
    orderTime <= range.endTime
  )
}

export function dateKeyInTimeZone(
  value: Date,
  timezone = ORDERS_TIME_ZONE,
): string {
  const parts = zonedParts(value, timezone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

export function parseMarketplaceDate(
  value: unknown,
  timezone = ORDERS_TIME_ZONE,
): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return new Date(value).getTime()
  const text = String(value ?? '').trim()
  if (!text) return Number.NaN

  const localMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  )
  if (localMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0', ms = '0'] =
      localMatch
    return zonedDateTimeToEpoch(
      `${year}-${month}-${day}`,
      timezone,
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms.padEnd(3, '0')),
    )
  }

  const parsed = new Date(text).getTime()
  return Number.isNaN(parsed) ? Number.NaN : parsed
}

function zonedDateTimeToEpoch(
  dateKey: string,
  timezone: string,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  let candidate = targetUtc

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timezone)
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      millisecond,
    )
    const correction = targetUtc - actualAsUtc
    candidate += correction
    if (correction === 0) break
  }

  return candidate
}

function zonedParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

function shiftDateKey(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}-${pad(
    shifted.getUTCMonth() + 1,
  )}-${pad(shifted.getUTCDate())}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
