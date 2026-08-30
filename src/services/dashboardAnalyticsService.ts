import type { CargoOrder } from '../types/cargoflow'
import type { AnalyticsClaim } from '../dashboard/analyticsClaims'
import {
  extractDashboardOperationalSnapshot,
  reviveDashboardViewModel,
  type DashboardOperationalSnapshot,
  type DashboardPeriodSelection,
  type DashboardViewModel,
} from '../dashboard/dashboardViewModel'
import type { DashboardProviderCounts } from '../dashboard/dashboardSummary'

export interface DashboardOperationalResult {
  /** TAM görünüm modeli (satış dahil) — sunucuda hesaplanmıştır. */
  viewModel: DashboardViewModel
  /** Operasyon alanları; geriye dönük kullanım için ayrıca sunulur. */
  snapshot: DashboardOperationalSnapshot
  providerCounts?: DashboardProviderCounts
}

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
  // İade veri kaynağı: "unavailable" (auth: provider çağrılmadı, kesin claim
  // muhasebesi yok) veya gerçek kaynak (legacy). Dashboard buna göre
  // claimsAvailable belirler.
  source: string
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

// OPERASYON ANLIK GÖRÜNTÜSÜ — istek tekilleştirme (dedupe).
//
// Aynı dönem için eşzamanlı iki istek TEK ağ çağrısına indirgenir; sayfa
// geçişlerinde (Panoya dön → Siparişler → Panoya dön) API fırtınası olmaz.
let operationalInFlight: Promise<DashboardOperationalResult> | null = null
let operationalInFlightKey = ''
let operationalCache: { key: string; result: DashboardOperationalResult } | null =
  null

export function resetDashboardAnalyticsCache(): void {
  cache = null
  inFlight = null
  inFlightKey = ''
  claimsCache = null
  claimsInFlight = null
  claimsInFlightKey = ''
  operationalInFlight = null
  operationalInFlightKey = ''
  operationalCache = null
}

function operationalKey(period: DashboardPeriodSelection): string {
  return [period.key, period.startDate ?? '', period.endDate ?? ''].join('|')
}

/**
 * SUNUCUDA hesaplanmış operasyon anlık görüntüsü.
 *
 * Bu çağrı, eski mimarinin TÜM sipariş tablosunu indirmesinin YERİNE geçer.
 * Değerler tarayıcının hesaplayacağının birebir aynısıdır (aynı fonksiyon,
 * sunucuda çalışır); parite `dashboard-operational-parity-flow` ile
 * kanıtlanır.
 */
export async function fetchDashboardOperationalSnapshot(
  period: DashboardPeriodSelection,
  options: { refresh?: boolean; latestSyncAt?: string } = {},
): Promise<DashboardOperationalResult> {
  const key = `${operationalKey(period)}|${options.latestSyncAt ?? ''}`
  if (!options.refresh && operationalCache && operationalCache.key === key) {
    return operationalCache.result
  }
  if (operationalInFlight && operationalInFlightKey === key && !options.refresh) {
    return operationalInFlight
  }
  const params = new URLSearchParams({ periodKey: period.key })
  if (period.startDate) params.set('periodStartDate', period.startDate)
  if (period.endDate) params.set('periodEndDate', period.endDate)
  // Son senkron damgası istemcinin oturum durumundan gelir; sunucu bunu
  // bilemez. Geçilmezse model kendi türetimine düşer ve iki taraf AYRIŞIR.
  if (options.latestSyncAt) params.set('latestSyncAt', options.latestSyncAt)
  operationalInFlightKey = key
  operationalInFlight = fetch(`/api/dashboard/operational?${params}`, {
    credentials: 'include',
  })
    .then(async (response) => {
      const payload = await response.json()
      if (!response.ok || payload?.ok === false) {
        throw new Error(
          String(payload?.message ?? 'Operasyon özeti yüklenemedi.'),
        )
      }
      if (!payload?.viewModel) {
        throw new Error('Operasyon özeti yüklenemedi.')
      }
      const viewModel = reviveDashboardViewModel(payload.viewModel)
      const result: DashboardOperationalResult = {
        viewModel,
        snapshot: extractDashboardOperationalSnapshot(viewModel),
        providerCounts: payload.providerCounts as
          | DashboardProviderCounts
          | undefined,
      }
      operationalCache = { key, result }
      return result
    })
    .finally(() => {
      operationalInFlight = null
      operationalInFlightKey = ''
    })
  return operationalInFlight
}

export async function fetchDashboardAnalyticsOrders(
  startDate: Date,
  endDate: Date,
  options: { refresh?: boolean } = {},
): Promise<DashboardAnalyticsResult> {
  const startMs = startDate.getTime()
  const endMs = endDate.getTime()
  const refresh = options.refresh === true
  // Yenile DIŞINDA: kapsayan aralık cache'teyse ağa çıkma (sayfa geçişi/mount
  // yeniden hesaplatmaz). Yenile'de hem bu frontend cache'i hem backend cache'i
  // (refresh=true) bypass edilir.
  if (!refresh && cache && cache.startMs <= startMs && cache.endMs >= endMs) {
    return cache.result
  }
  // Kapsam genişletme: mevcut cache ile birleşik tek aralık çekilir ki
  // dönem değişimlerinde tekrar tekrar dar aralıklar istenmesin.
  const unionStart = cache ? Math.min(cache.startMs, startMs) : startMs
  const unionEnd = cache ? Math.max(cache.endMs, endMs) : endMs
  const key = `${refresh ? 'refresh:' : ''}${unionStart}|${unionEnd}`
  if (inFlight && inFlightKey === key) return inFlight
  inFlightKey = key
  inFlight = requestAnalytics(unionStart, unionEnd, refresh)
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
  options: { refresh?: boolean } = {},
): Promise<DashboardClaimsResult> {
  const startMs = startDate.getTime()
  const endMs = endDate.getTime()
  const refresh = options.refresh === true
  if (
    !refresh &&
    claimsCache &&
    claimsCache.startMs <= startMs &&
    claimsCache.endMs >= endMs
  ) {
    return claimsCache.result
  }
  const unionStart = claimsCache ? Math.min(claimsCache.startMs, startMs) : startMs
  const unionEnd = claimsCache ? Math.max(claimsCache.endMs, endMs) : endMs
  const key = `${refresh ? 'refresh:' : ''}${unionStart}|${unionEnd}`
  if (claimsInFlight && claimsInFlightKey === key) return claimsInFlight
  claimsInFlightKey = key
  claimsInFlight = requestClaims(unionStart, unionEnd, refresh)
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
  refresh = false,
): Promise<DashboardClaimsResult> {
  const params = new URLSearchParams({
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
  })
  if (refresh) params.set('refresh', 'true')
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
    // "unavailable": auth modunda kesin claim muhasebesi yok (provider
    // çağrılmadı). Dashboard bu durumda iadeyi Returned sipariş statüsünden
    // türetir (claimsAvailable=false). Verilmezse gerçek claim kaynağı sayılır.
    source: String(payload.source ?? 'persisted_claims'),
    rangeStart: new Date(String(payload.startDate)),
    rangeEnd: new Date(String(payload.endDate)),
  }
}

async function requestAnalytics(
  startMs: number,
  endMs: number,
  refresh = false,
): Promise<DashboardAnalyticsResult> {
  const params = new URLSearchParams({
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
  })
  if (refresh) params.set('refresh', 'true')
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
