import type { CargoOrder } from '../types/cargoflow'

// Dashboard SATIŞ analitiği için read-only veri kaynağı. Operational
// ordersState'ten TAMAMEN bağımsızdır: persistOrders çağırmaz, storage'a
// yazmaz, Sürat/shipment akışlarına dokunmaz. Basit kapsayan-aralık
// memory cache'i kullanır: istenen aralık cache kapsamındaysa ağa
// çıkılmaz; değilse mevcut kapsamla birleştirilmiş TEK aralık çekilir.
export interface DashboardAnalyticsResult {
  orders: CargoOrder[]
  totalElements: number
  fetchedCount: number
  packageCount: number
  rangeStart: Date
  rangeEnd: Date
}

interface AnalyticsCache {
  startMs: number
  endMs: number
  result: DashboardAnalyticsResult
}

let cache: AnalyticsCache | null = null
let inFlight: Promise<DashboardAnalyticsResult> | null = null
let inFlightKey = ''

export function resetDashboardAnalyticsCache(): void {
  cache = null
  inFlight = null
  inFlightKey = ''
}

export async function fetchDashboardAnalyticsOrders(
  startDate: Date,
  endDate: Date,
): Promise<DashboardAnalyticsResult> {
  const startMs = startDate.getTime()
  const endMs = endDate.getTime()
  if (cache && cache.startMs <= startMs && cache.endMs >= endMs) {
    return cache.result
  }
  // Kapsam genişletme: mevcut cache ile birleşik tek aralık çekilir ki
  // dönem değişimlerinde tekrar tekrar dar aralıklar istenmesin.
  const unionStart = cache ? Math.min(cache.startMs, startMs) : startMs
  const unionEnd = cache ? Math.max(cache.endMs, endMs) : endMs
  const key = `${unionStart}|${unionEnd}`
  if (inFlight && inFlightKey === key) return inFlight
  inFlightKey = key
  inFlight = requestAnalytics(unionStart, unionEnd)
    .then((result) => {
      cache = { startMs: unionStart, endMs: unionEnd, result }
      return result
    })
    .finally(() => {
      inFlight = null
      inFlightKey = ''
    })
  return inFlight
}

async function requestAnalytics(
  startMs: number,
  endMs: number,
): Promise<DashboardAnalyticsResult> {
  const params = new URLSearchParams({
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
  })
  const response = await fetch(`/api/analytics/orders?${params}`, {
    headers: {
      'X-CargoFlow-Client-Host':
        typeof window !== 'undefined' ? window.location?.hostname ?? '' : '',
    },
  })
  const payload = await response.json()
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      String(payload?.message ?? 'Satış analitiği verisi alınamadı.'),
    )
  }
  return {
    orders: Array.isArray(payload.orders) ? payload.orders : [],
    totalElements: Number(payload.totalElements ?? 0),
    fetchedCount: Number(payload.fetchedCount ?? 0),
    packageCount: Number(payload.packageCount ?? 0),
    rangeStart: new Date(String(payload.startDate)),
    rangeEnd: new Date(String(payload.endDate)),
  }
}
