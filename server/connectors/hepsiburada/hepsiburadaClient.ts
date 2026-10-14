// HEPSIBURADA OKUMA İSTEMCİSİ — yalnız GET, yalnız doğrulanmış host.
//
// ═══ GÜVENLİK SINIRLARI ══════════════════════════════════════════════════
//
//   · YAZMA YOK: bu modül yalnız GET kurar; pazaryeri mutasyonu YOKTUR.
//   · Host: `resolveHepsiburadaHost` doğrulanmış alan adı ister; nihai URL
//     yine de doğrulanır (savunma derinliği). Yönlendirme İZLENMEZ.
//   · Yol: YAPILANDIRMADAN; yoksa istek KURULMAZ (ağ çağrısı 0).
//   · Kimlik eksikse istek KURULMAZ (ağ çağrısı 0).
//   · Zaman aşımı: AbortController + clearTimeout `finally`de (sızıntı yok).
//   · Tekrar: yalnız güvenli GET için, SINIRLI. 429'da bekleme süresi
//     X-RateLimit-Reset başlığından türetilir; başlık yoksa sabit sınırlı
//     geri çekilme — süre uydurulmaz, üst sınırlıdır.
//   · 404 "sipariş yok" SAYILMAZ: yanlış yapılandırılmış yol demektir.
//   · Gövde/başlık/kimlik LOGLANMAZ; hata sınıfı kararlı ve sırsızdır.
import {
  buildHepsiburadaAuth,
  buildHepsiburadaUrl,
  HEPSIBURADA_VERIFIED_HOST_SUFFIXES,
  readHepsiburadaRateState,
  type HepsiburadaApiFamily,
  type HepsiburadaRateState,
} from '../../marketplaces/hepsiburada/hepsiburadaContract.ts'
import { buildHepsiburadaPageRequest } from '../../marketplaces/hepsiburada/hepsiburadaOrderSource.ts'
import {
  resolveEndpointPath,
  type HepsiburadaConnectorConfig,
  type HepsiburadaFamily,
} from './hepsiburadaConfig.ts'

export const HEPSIBURADA_ERROR_CLASSES = [
  'CREDENTIALS_MISSING',
  'ENDPOINT_CONFIG_REQUIRED',
  'AUTH_ERROR',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'REQUEST_REJECTED',
  'RESPONSE_SHAPE_UNVERIFIED',
] as const
export type HepsiburadaErrorClass = (typeof HEPSIBURADA_ERROR_CLASSES)[number]

export const HEPSIBURADA_REQUEST_TIMEOUT_MS = 15_000
/** Geçici hatalar için geri çekilmeler; uzunluk = tekrar ÜST SINIRI. */
export const HEPSIBURADA_DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000] as const
/** 429 bekleme tavanı (başlık daha uzun dese bile). */
export const HEPSIBURADA_MAX_RATE_WAIT_MS = 30_000

export interface HepsiburadaTransportRequest {
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

export interface HepsiburadaTransportResponse {
  status: number
  headers: Record<string, string>
  bodyText: string
}

/** Taşıma ENJEKTE edilir: testler hermetiktir (gerçek ağ yok). */
export type HepsiburadaTransport = (request: HepsiburadaTransportRequest) => Promise<HepsiburadaTransportResponse>

export class HepsiburadaTransportError extends Error {
  readonly kind: 'NETWORK' | 'TIMEOUT'
  constructor(kind: 'NETWORK' | 'TIMEOUT') {
    super(kind === 'TIMEOUT' ? 'Hepsiburada zaman aşımı' : 'Hepsiburada ağ hatası')
    this.kind = kind
  }
}

/**
 * Üretim taşıması: GET, yönlendirme izlenmez, süre sınırlı. Zamanlayıcı
 * her yolda `finally`de temizlenir; sinyal dinleyicisi askıda kalmaz.
 */
export const fetchHepsiburadaTransport: HepsiburadaTransport = async (request) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs))
  try {
    let response: Response
    try {
      response = await fetch(request.url, {
        method: 'GET',
        headers: request.headers,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      throw new HepsiburadaTransportError(name === 'AbortError' || name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK')
    }
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    let bodyText: string
    try {
      bodyText = await response.text()
    } catch {
      throw new HepsiburadaTransportError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK')
    }
    return { status: response.status, headers, bodyText }
  } finally {
    clearTimeout(timer)
  }
}

export interface HepsiburadaClientOptions {
  transport: HepsiburadaTransport
  timeoutMs?: number
  retryDelaysMs?: readonly number[]
  maxRateWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface HepsiburadaPageQuery {
  family: HepsiburadaFamily
  offset: number
  limit: number
  startMs: number
  endMs: number
}

export type HepsiburadaPageResult =
  | {
      ok: true
      rows: Record<string, unknown>[]
      httpStatus: number
      rateState: HepsiburadaRateState | null
      networkCalls: number
    }
  | {
      ok: false
      errorClass: HepsiburadaErrorClass
      reasonCode: string
      httpStatus: number | null
      rateState: HepsiburadaRateState | null
      networkCalls: number
    }

const API_FAMILY: Record<HepsiburadaFamily, HepsiburadaApiFamily> = {
  ORDERS: 'ORDERS',
  PACKAGES: 'PACKAGES',
}

function isVerifiedRequestUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    const host = parsed.hostname.toLowerCase()
    return HEPSIBURADA_VERIFIED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  } catch {
    return false
  }
}

/**
 * Yanıt gövdesinden kayıt listesi.
 *
 * Zarf resmî olarak KANITLANMADI: yalnız (a) üst düzey dizi ya da (b)
 * YAPILANDIRILMIŞ liste alanı kabul edilir. Belirsizse null → çağıran
 * `RESPONSE_SHAPE_UNVERIFIED` döner ve HİÇBİR şey yazılmaz.
 */
export function extractHepsiburadaRows(
  body: unknown,
  listField: string | null,
): Record<string, unknown>[] | null {
  const pickObjects = (list: unknown[]): Record<string, unknown>[] | null =>
    list.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))
      ? list as Record<string, unknown>[] : null
  if (Array.isArray(body)) return pickObjects(body)
  if (body && typeof body === 'object' && listField) {
    const value = (body as Record<string, unknown>)[listField]
    if (Array.isArray(value)) return pickObjects(value)
  }
  return null
}

function classifyStatus(status: number): { errorClass: HepsiburadaErrorClass; reasonCode: string; retryable: boolean } | null {
  if (status >= 200 && status <= 299) return null
  if (status === 401 || status === 403) return { errorClass: 'AUTH_ERROR', reasonCode: `HB_HTTP_${status}`, retryable: false }
  if (status === 404) return { errorClass: 'ENDPOINT_CONFIG_REQUIRED', reasonCode: 'HB_ENDPOINT_NOT_FOUND', retryable: false }
  if (status === 429) return { errorClass: 'RATE_LIMITED', reasonCode: 'HB_HTTP_429', retryable: true }
  if (status >= 500) return { errorClass: 'PROVIDER_UNAVAILABLE', reasonCode: `HB_HTTP_${status}`, retryable: true }
  if (status >= 300 && status <= 399) return { errorClass: 'REQUEST_REJECTED', reasonCode: 'HB_REDIRECT_REFUSED', retryable: false }
  return { errorClass: 'REQUEST_REJECTED', reasonCode: `HB_HTTP_${status}`, retryable: false }
}

/**
 * TEK sayfa okur (offset/limit + begindate/enddate).
 *
 * Ön koşullar ağdan ÖNCE kontrol edilir: yol yoksa ya da kimlik eksikse
 * `networkCalls: 0` ile döner.
 */
export async function fetchHepsiburadaPage(
  config: HepsiburadaConnectorConfig,
  query: HepsiburadaPageQuery,
  options: HepsiburadaClientOptions,
): Promise<HepsiburadaPageResult> {
  const path = resolveEndpointPath(config, query.family)
  if (!path) {
    return { ok: false, errorClass: 'ENDPOINT_CONFIG_REQUIRED', reasonCode: 'HB_ENDPOINT_PATH_UNVERIFIED', httpStatus: null, rateState: null, networkCalls: 0 }
  }
  const auth = buildHepsiburadaAuth(config)
  if (!auth.ok) {
    return { ok: false, errorClass: 'CREDENTIALS_MISSING', reasonCode: 'HB_CREDENTIALS_INCOMPLETE', httpStatus: null, rateState: null, networkCalls: 0 }
  }
  const page = buildHepsiburadaPageRequest({
    offset: query.offset,
    limit: query.limit,
    startMs: query.startMs,
    endMs: query.endMs,
  })
  const built = buildHepsiburadaUrl({
    host: config.host,
    environment: config.environment,
    path,
    query: { offset: page.offset, limit: page.limit, begindate: page.begindate, enddate: page.enddate },
  })
  if (!built.ok || !built.url || !isVerifiedRequestUrl(built.url)) {
    return { ok: false, errorClass: 'ENDPOINT_CONFIG_REQUIRED', reasonCode: built.errorCode ?? 'HB_HOST_NOT_VERIFIED', httpStatus: null, rateState: null, networkCalls: 0 }
  }

  const delays = options.retryDelaysMs ?? HEPSIBURADA_DEFAULT_RETRY_DELAYS_MS
  const maxRateWaitMs = options.maxRateWaitMs ?? HEPSIBURADA_MAX_RATE_WAIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.timeoutMs ?? HEPSIBURADA_REQUEST_TIMEOUT_MS
  let networkCalls = 0

  for (let attempt = 0; ; attempt += 1) {
    let response: HepsiburadaTransportResponse | null = null
    let transportFailure: 'NETWORK' | 'TIMEOUT' | null = null
    networkCalls += 1
    try {
      response = await options.transport({ url: built.url, headers: { ...auth.headers }, timeoutMs })
    } catch (error) {
      transportFailure = error instanceof HepsiburadaTransportError ? error.kind : 'NETWORK'
    }

    const rateState = response
      ? readHepsiburadaRateState({ family: API_FAMILY[query.family], statusCode: response.status, headers: response.headers })
      : null
    const canRetry = attempt < delays.length

    if (transportFailure) {
      if (canRetry) {
        await sleep(delays[attempt])
        continue
      }
      return {
        ok: false, errorClass: 'PROVIDER_UNAVAILABLE',
        reasonCode: transportFailure === 'TIMEOUT' ? 'HB_TIMEOUT' : 'HB_NETWORK_ERROR',
        httpStatus: null, rateState: null, networkCalls,
      }
    }

    const res = response as HepsiburadaTransportResponse
    const failure = classifyStatus(res.status)
    if (!failure) {
      let body: unknown
      try {
        body = JSON.parse(res.bodyText)
      } catch {
        return { ok: false, errorClass: 'RESPONSE_SHAPE_UNVERIFIED', reasonCode: 'HB_RESPONSE_NOT_JSON', httpStatus: res.status, rateState, networkCalls }
      }
      const rows = extractHepsiburadaRows(body, config.listField)
      if (rows === null) {
        return { ok: false, errorClass: 'RESPONSE_SHAPE_UNVERIFIED', reasonCode: 'HB_RESPONSE_SHAPE_UNVERIFIED', httpStatus: res.status, rateState, networkCalls }
      }
      return { ok: true, rows, httpStatus: res.status, rateState, networkCalls }
    }

    if (failure.retryable && canRetry) {
      // 429: bekleme başlıktan; yoksa sınırlı sabit geri çekilme. Tavanlı.
      const wait = failure.errorClass === 'RATE_LIMITED' && rateState?.retryAfterMs != null
        ? rateState.retryAfterMs
        : delays[attempt]
      await sleep(Math.min(Math.max(0, wait), maxRateWaitMs))
      continue
    }
    return { ok: false, errorClass: failure.errorClass, reasonCode: failure.reasonCode, httpStatus: res.status, rateState, networkCalls }
  }
}

/** Kullanıcıya gidecek SIRSIZ Türkçe ileti. */
export const HEPSIBURADA_ERROR_COPY_TR: Record<HepsiburadaErrorClass, string> = {
  CREDENTIALS_MISSING: 'Hepsiburada kimlik bilgileri eksik.',
  ENDPOINT_CONFIG_REQUIRED:
    'Hepsiburada uç nokta yolu yapılandırılmadı veya doğrulanamadı. Resmî yol bilgisi olmadan istek gönderilmez.',
  AUTH_ERROR: 'Hepsiburada kimlik bilgileri reddedildi.',
  RATE_LIMITED: 'Hepsiburada istek sınırına ulaşıldı; daha sonra yeniden deneyin.',
  PROVIDER_UNAVAILABLE: 'Hepsiburada şu anda yanıt vermiyor.',
  REQUEST_REJECTED: 'Hepsiburada isteği reddetti; uç nokta yapılandırmasını kontrol edin.',
  RESPONSE_SHAPE_UNVERIFIED:
    'Hepsiburada yanıtının liste biçimi doğrulanamadı; liste alanını yapılandırın. Hiçbir sipariş yazılmadı.',
}
