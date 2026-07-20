import type { CargoOrder } from '../types/cargoflow'
import type { AnalyticsClaim } from '../dashboard/analyticsClaims'

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

export interface DashboardClaimsResult {
  claims: AnalyticsClaim[]
  uniqueClaimCount: number
  affectedPackageCount: number
  amountBasis: string
  rangeStart: Date
  rangeEnd: Date
}

interface AnalyticsCache {
  startMs: number
  endMs: number
  result: DashboardAnalyticsResult
}

interface ClaimsCache {
  startMs: number
  endMs: number
  result: DashboardClaimsResult
}

let cache: AnalyticsCache | null = null
let inFlight: Promise<DashboardAnalyticsResult> | null = null
let inFlightKey = ''

let claimsCache: ClaimsCache | null = null
let claimsInFlight: Promise<DashboardClaimsResult> | null = null
let claimsInFlightKey = ''

export function resetDashboardAnalyticsCache(): void {
  cache = null
  inFlight = null
  inFlightKey = ''
  claimsCache = null
  claimsInFlight = null
  claimsInFlightKey = ''
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

// İade (claims) verisi: orders ile AYNI kapsayan-aralık cache mantığı.
// Bağımsızdır; claims hatası orders'ı ve operasyon panelini etkilemez.
export async function fetchDashboardAnalyticsClaims(
  startDate: Date,
  endDate: Date,
): Promise<DashboardClaimsResult> {
  const startMs = startDate.getTime()
  const endMs = endDate.getTime()
  if (
    claimsCache &&
    claimsCache.startMs <= startMs &&
    claimsCache.endMs >= endMs
  ) {
    return claimsCache.result
  }
  const unionStart = claimsCache ? Math.min(claimsCache.startMs, startMs) : startMs
  const unionEnd = claimsCache ? Math.max(claimsCache.endMs, endMs) : endMs
  const key = `${unionStart}|${unionEnd}`
  if (claimsInFlight && claimsInFlightKey === key) return claimsInFlight
  claimsInFlightKey = key
  claimsInFlight = requestClaims(unionStart, unionEnd)
    .then((result) => {
      claimsCache = { startMs: unionStart, endMs: unionEnd, result }
      return result
    })
    .finally(() => {
      claimsInFlight = null
      claimsInFlightKey = ''
    })
  return claimsInFlight
}

async function requestClaims(
  startMs: number,
  endMs: number,
): Promise<DashboardClaimsResult> {
  const params = new URLSearchParams({
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
  })
  const response = await fetch(`/api/analytics/claims?${params}`, {
    headers: {
      'X-CargoFlow-Client-Host':
        typeof window !== 'undefined' ? window.location?.hostname ?? '' : '',
    },
  })
  const payload = await response.json()
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      String(payload?.message ?? 'İade analitiği verisi alınamadı.'),
    )
  }
  return {
    claims: Array.isArray(payload.claims) ? payload.claims : [],
    uniqueClaimCount: Number(payload.uniqueClaimCount ?? 0),
    affectedPackageCount: Number(payload.affectedPackageCount ?? 0),
    amountBasis: String(payload.amountBasis ?? ''),
    rangeStart: new Date(String(payload.startDate)),
    rangeEnd: new Date(String(payload.endDate)),
  }
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
