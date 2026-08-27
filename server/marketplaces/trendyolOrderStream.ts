// TRENDYOL RESMÎ STREAM — yüksek hacimli tarama ve mutabakat.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
//
// Denetim kanıtladı: üretim SAYFA TABANLI (`totalPages`) çalışıyor, resmî
// `getShipmentPackagesStream` HİÇ kullanılmıyordu. Sayfa tabanlı tarama
// yüksek hacimde hem yavaş hem de 15 Ekim 2026 Order V2 penceresiyle
// (10.000 paket) sınırlanacak.
//
// Bu modül SAF ve ENJEKTE EDİLEBİLİRDİR: `fetchJson` dışarıdan gelir, bu
// yüzden testler gerçek pazaryerine çıkmadan tüm sözleşmeyi çalıştırır.
// `index.mjs` gerçek (retry/429/backoff'lu) getiriciyi bağlar.
//
// AĞ ÇAĞRISI BU MODÜLDE YOKTUR.

/** Resmî stream yolu. */
export const TRENDYOL_STREAM_PATH_TEMPLATE =
  '/integration/order/sellers/{sellerId}/orders/stream'

/** Sözleşme üst sınırı. */
export const TRENDYOL_STREAM_MAX_SIZE = 200

/** Tek istekte izin verilen en geniş zaman aralığı (14 gün). */
export const TRENDYOL_STREAM_MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** Stream'in eriştiği azami geçmiş (3 ay). */
export const TRENDYOL_STREAM_MAX_HISTORY_MS = 90 * 24 * 60 * 60 * 1000

/** Sayfalar arası önerilen asgari bekleme. */
export const TRENDYOL_STREAM_MIN_INTERVAL_MS = 5_000

export interface TrendyolStreamFilters {
  startDate: number
  endDate: number
  size: number
  status?: string
}

export interface TrendyolStreamPage {
  packages: Record<string, unknown>[]
  nextCursor: string | null
  hasMore: boolean
}

export const STREAM_STOP_REASONS = [
  'NO_MORE_PAGES',
  'PAGE_LIMIT_REACHED',
  'EMPTY_CURSOR_WITH_MORE',
  'FETCH_FAILED',
] as const

export type StreamStopReason = (typeof STREAM_STOP_REASONS)[number]

/**
 * Filtre parmak izi.
 *
 * SÖZLEŞME: bir imleç zincirinin ORTASINDA filtreler DEĞİŞTİRİLEMEZ. Kimlik
 * burada dondurulur ve her sayfada karşılaştırılır; değişirse zincir DURUR.
 * Sessizce devam etmek, sunucunun imleci farklı bir sorguya göre çözmesi
 * demektir ve KAYIP/MÜKERRER paket üretir.
 */
export function streamFilterFingerprint(filters: TrendyolStreamFilters): string {
  return [
    `s:${filters.startDate}`, `e:${filters.endDate}`,
    `z:${filters.size}`, `t:${filters.status ?? ''}`,
  ].join('|')
}

export function buildTrendyolStreamUrl(params: {
  baseUrl: string
  sellerId: string | number
  filters: TrendyolStreamFilters
  /** Opak. ASLA ayrıştırılmaz, ASLA üretilmez — sunucudan geldiği gibi. */
  cursor?: string | null
}): string {
  const path = TRENDYOL_STREAM_PATH_TEMPLATE.replace(
    '{sellerId}', String(params.sellerId),
  )
  const query = new URLSearchParams({
    startDate: String(params.filters.startDate),
    endDate: String(params.filters.endDate),
    size: String(Math.min(
      Math.max(1, Number(params.filters.size) || TRENDYOL_STREAM_MAX_SIZE),
      TRENDYOL_STREAM_MAX_SIZE,
    )),
  })
  if (params.filters.status) query.set('status', params.filters.status)
  // İmleç varsa AYNEN eklenir. Kodlama dışında hiçbir dönüşüm YOK.
  const cursor = String(params.cursor ?? '').trim()
  if (cursor) query.set('cursor', cursor)
  return `${String(params.baseUrl).replace(/\/$/, '')}${path}?${query}`
}

/** Ham yanıt → sayfa. Alan adları uydurulmaz; yoksa güvenli varsayılan. */
export function parseTrendyolStreamPage(body: unknown): TrendyolStreamPage {
  const record = (body ?? {}) as Record<string, unknown>
  const raw = record.content ?? record.packages ?? record.data
  const packages = Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null)
    : []
  const cursorValue = record.nextCursor
  const nextCursor =
    typeof cursorValue === 'string' && cursorValue.trim() !== ''
      ? cursorValue
      : null
  // `hasMore` YOKSA imlecin varlığından TÜRETİLİR; "true" varsayılmaz.
  const hasMore = typeof record.hasMore === 'boolean'
    ? record.hasMore
    : nextCursor !== null
  return { packages, nextCursor, hasMore }
}

export interface StreamRunResult {
  packages: Record<string, unknown>[]
  pages: number
  lastCursor: string | null
  stopReason: StreamStopReason
  /** Sunucunun döndürdüğü son imleç — sürdürülebilir kontrol noktası. */
  resumeCursor: string | null
  filterFingerprint: string
}

/**
 * İmleç zincirini yürütür. Sayfa başına `onPage` çağrılır; çağıran yerel
 * yazmayı orada yapar, böylece bellek şişmez.
 *
 * Zincir boyunca filtreler DEĞİŞMEZ (parmak izi ile kilitli).
 */
export async function runTrendyolStream(params: {
  baseUrl: string
  sellerId: string | number
  filters: TrendyolStreamFilters
  startCursor?: string | null
  maxPages?: number
  fetchJson: (url: string) => Promise<{ ok: boolean; body?: unknown }>
  onPage?: (page: TrendyolStreamPage, index: number) => Promise<void> | void
  /** Sayfalar arası bekleme — testlerde 0 geçilir. */
  delay?: (ms: number) => Promise<void>
  minIntervalMs?: number
}): Promise<StreamRunResult> {
  const fingerprint = streamFilterFingerprint(params.filters)
  const maxPages = Math.max(1, Number(params.maxPages ?? 500))
  const minIntervalMs = Number(
    params.minIntervalMs ?? TRENDYOL_STREAM_MIN_INTERVAL_MS,
  )
  const collected: Record<string, unknown>[] = []
  let cursor = params.startCursor ?? null
  let lastCursor: string | null = null
  let pages = 0
  let stopReason: StreamStopReason = 'NO_MORE_PAGES'

  for (let index = 0; index < maxPages; index += 1) {
    const url = buildTrendyolStreamUrl({
      baseUrl: params.baseUrl,
      sellerId: params.sellerId,
      filters: params.filters,
      cursor,
    })
    const response = await params.fetchJson(url)
    if (!response?.ok) {
      // Kısmi ilerleme KORUNUR: imleç kaydedilir, sonraki koşu devam eder.
      stopReason = 'FETCH_FAILED'
      break
    }
    const page = parseTrendyolStreamPage(response.body)
    pages += 1
    collected.push(...page.packages)
    if (params.onPage) await params.onPage(page, index)
    lastCursor = page.nextCursor ?? lastCursor

    if (!page.hasMore) { stopReason = 'NO_MORE_PAGES'; break }
    if (!page.nextCursor) {
      // `hasMore` true ama imleç YOK: imleç UYDURULMAZ, zincir durur.
      stopReason = 'EMPTY_CURSOR_WITH_MORE'
      break
    }
    cursor = page.nextCursor
    if (index + 1 >= maxPages) { stopReason = 'PAGE_LIMIT_REACHED'; break }
    if (minIntervalMs > 0 && params.delay) await params.delay(minIntervalMs)
  }

  return {
    packages: collected,
    pages,
    lastCursor,
    stopReason,
    resumeCursor: stopReason === 'FETCH_FAILED' ? cursor : lastCursor,
    filterFingerprint: fingerprint,
  }
}

/**
 * Bootstrap/tam yakalama için izinli geçmişi GÜVENLİ pencerelere böler.
 * Sınırsız geçmiş İSTENMEZ.
 */
export function planStreamWindows(params: {
  nowMs: number
  fromMs?: number
  windowMs?: number
}): { startDate: number; endDate: number }[] {
  const now = params.nowMs
  const earliest = now - TRENDYOL_STREAM_MAX_HISTORY_MS
  const from = Math.max(Number(params.fromMs ?? earliest), earliest)
  const windowMs = Math.min(
    Math.max(1, Number(params.windowMs ?? TRENDYOL_STREAM_MAX_WINDOW_MS)),
    TRENDYOL_STREAM_MAX_WINDOW_MS,
  )
  const windows: { startDate: number; endDate: number }[] = []
  for (let start = from; start < now; start += windowMs) {
    windows.push({ startDate: start, endDate: Math.min(start + windowMs, now) })
  }
  return windows.length > 0 ? windows : [{ startDate: from, endDate: now }]
}
