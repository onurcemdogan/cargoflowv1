// N11 OKUMA İSTEMCİSİ — yalnız GET, yalnız kanıtlı host + uç nokta.
//
// ═══ GÜVENLİK SINIRLARI ══════════════════════════════════════════════════
//
//   · YAZMA YOK: yalnız GET kurulur; `N11_ORDER_UPDATE_URL` bu modülde
//     KULLANILMAZ. Pazaryeri mutasyonu YOKTUR.
//   · Host + yol SABİT: `https://api.n11.com/rest/delivery/v1/shipmentPackages`
//     (resmî). Nihai URL yine de doğrulanır; yönlendirme İZLENMEZ.
//   · Kimlik `appkey`/`appsecret` BAŞLIKLARIYLA; `Authorization` YOK; sorgu
//     dizesine sır GİRMEZ. Kimlik eksikse istek KURULMAZ (ağ çağrısı 0).
//   · Zaman aşımı: AbortController + clearTimeout `finally`de.
//   · Tekrar: yalnız güvenli GET için, SINIRLI. 429'da standart `Retry-After`
//     (saniye) varsa o, yoksa sabit geri çekilme — her durumda TAVANLI.
//   · Yanıt zarfı resmî: `content` dizisi + `totalPages`. Farklı biçim →
//     `RESPONSE_SHAPE_UNVERIFIED`; keyfi iç içe dizi AYRIŞTIRILMAZ.
//   · Gövde/başlık/kimlik LOGLANMAZ; hata sınıfı kararlı ve sırsızdır.
import {
  buildN11AuthHeaders,
  buildN11PageRequest,
  N11_LIST_FIELD,
  N11_MAX_PAGE_SIZE,
  N11_SHIPMENT_PACKAGES_URL,
  type N11PackageStatus,
} from '../../marketplaces/n11/n11Contract.ts'
import type { N11ConnectorConfig } from './n11Config.ts'

export const N11_ERROR_CLASSES = [
  'CREDENTIALS_MISSING',
  'AUTH_ERROR',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'REQUEST_REJECTED',
  'RESPONSE_SHAPE_UNVERIFIED',
] as const
export type N11ErrorClass = (typeof N11_ERROR_CLASSES)[number]

export const N11_REQUEST_TIMEOUT_MS = 15_000
/** Geçici hatalar için geri çekilmeler; uzunluk = tekrar ÜST SINIRI. */
export const N11_DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000] as const
/** 429 bekleme tavanı (resmî limit dakikada 1000 istek). */
export const N11_MAX_RATE_WAIT_MS = 60_000

const VERIFIED_URL = new URL(N11_SHIPMENT_PACKAGES_URL)

export interface N11TransportRequest {
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

export interface N11TransportResponse {
  status: number
  headers: Record<string, string>
  bodyText: string
}

/** Taşıma ENJEKTE edilir: testler hermetiktir (gerçek ağ yok). */
export type N11Transport = (request: N11TransportRequest) => Promise<N11TransportResponse>

export class N11TransportError extends Error {
  readonly kind: 'NETWORK' | 'TIMEOUT'
  constructor(kind: 'NETWORK' | 'TIMEOUT') {
    super(kind === 'TIMEOUT' ? 'n11 zaman aşımı' : 'n11 ağ hatası')
    this.kind = kind
  }
}

/** Üretim taşıması: GET, yönlendirme izlenmez, süre sınırlı, zamanlayıcı her yolda temizlenir. */
export const fetchN11Transport: N11Transport = async (request) => {
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
      throw new N11TransportError(name === 'AbortError' || name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK')
    }
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    let bodyText: string
    try {
      bodyText = await response.text()
    } catch {
      throw new N11TransportError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK')
    }
    return { status: response.status, headers, bodyText }
  } finally {
    clearTimeout(timer)
  }
}

export interface N11ClientOptions {
  transport: N11Transport
  timeoutMs?: number
  retryDelaysMs?: readonly number[]
  maxRateWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface N11PageQuery {
  status: N11PackageStatus
  page: number
  size: number
  startMs: number
  endMs: number
}

export type N11PageResult =
  | {
      ok: true
      /** `content` içindeki ham girdiler (nesne olmayanlar dahil — sayılmak için). */
      entries: unknown[]
      totalPages: number
      httpStatus: number
      networkCalls: number
    }
  | {
      ok: false
      errorClass: N11ErrorClass
      reasonCode: string
      httpStatus: number | null
      networkCalls: number
    }

/** İstek URL'i — sabit host/yol + resmî sorgu parametreleri. */
export function buildN11RequestUrl(query: N11PageQuery): string {
  const request = buildN11PageRequest({ page: query.page, size: query.size, status: query.status, incremental: true })
  const url = new URL(N11_SHIPMENT_PACKAGES_URL)
  url.searchParams.set('startDate', String(Math.trunc(query.startMs)))
  url.searchParams.set('endDate', String(Math.trunc(query.endMs)))
  url.searchParams.set('page', String(request.page))
  url.searchParams.set('size', String(request.size))
  url.searchParams.set('status', String(request.status))
  url.searchParams.set('orderByField', String(request.orderByField))
  url.searchParams.set('orderByDirection', String(request.orderByDirection))
  return url.toString()
}

/** Nihai URL kanıtlı host + yol mu? (savunma derinliği) */
export function isVerifiedN11Url(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === VERIFIED_URL.hostname &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === VERIFIED_URL.pathname
    )
  } catch {
    return false
  }
}

/**
 * Resmî zarf: nesne + `content` dizisi + sayısal `totalPages`. Başka her biçim
 * null (→ RESPONSE_SHAPE_UNVERIFIED). `totalPages` yoksa da null: alan yokken
 * tek sayfa varsaymak sonraki sayfaları SESSİZCE atlardı.
 */
export function extractN11Page(body: unknown): { entries: unknown[]; totalPages: number } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const envelope = body as Record<string, unknown>
  const content = envelope[N11_LIST_FIELD]
  const totalPages = envelope.totalPages
  if (!Array.isArray(content)) return null
  if (typeof totalPages !== 'number' || !Number.isInteger(totalPages) || totalPages < 0) return null
  return { entries: content, totalPages }
}

function classifyStatus(status: number): { errorClass: N11ErrorClass; reasonCode: string; retryable: boolean } | null {
  if (status >= 200 && status <= 299) return null
  if (status === 401 || status === 403) return { errorClass: 'AUTH_ERROR', reasonCode: `N11_HTTP_${status}`, retryable: false }
  if (status === 429) return { errorClass: 'RATE_LIMITED', reasonCode: 'N11_HTTP_429', retryable: true }
  if (status >= 500) return { errorClass: 'PROVIDER_UNAVAILABLE', reasonCode: `N11_HTTP_${status}`, retryable: true }
  if (status >= 300 && status <= 399) return { errorClass: 'REQUEST_REJECTED', reasonCode: 'N11_REDIRECT_REFUSED', retryable: false }
  return { errorClass: 'REQUEST_REJECTED', reasonCode: `N11_HTTP_${status}`, retryable: false }
}

/** Standart `Retry-After` (yalnız saniye biçimi); yoksa/geçersizse null. */
function retryAfterMs(headers: Record<string, string>): number | null {
  const raw = String(headers['retry-after'] ?? '').trim()
  if (!/^\d{1,5}$/.test(raw)) return null
  return Number(raw) * 1000
}

/**
 * TEK sayfa okur (page/size + startDate/endDate + TEK statü).
 *
 * Kimlik eksikse `networkCalls: 0` ile döner; URL kanıtlı değilse istek KURULMAZ.
 */
export async function fetchN11Page(
  config: Pick<N11ConnectorConfig, 'appKey' | 'appSecret'>,
  query: N11PageQuery,
  options: N11ClientOptions,
): Promise<N11PageResult> {
  const auth = buildN11AuthHeaders({ appKey: config.appKey, appSecret: config.appSecret })
  if (!auth.ok) {
    return { ok: false, errorClass: 'CREDENTIALS_MISSING', reasonCode: 'N11_CREDENTIALS_INCOMPLETE', httpStatus: null, networkCalls: 0 }
  }
  const url = buildN11RequestUrl({ ...query, size: Math.min(N11_MAX_PAGE_SIZE, Math.max(1, query.size)) })
  if (!isVerifiedN11Url(url)) {
    return { ok: false, errorClass: 'REQUEST_REJECTED', reasonCode: 'N11_URL_NOT_VERIFIED', httpStatus: null, networkCalls: 0 }
  }

  const delays = options.retryDelaysMs ?? N11_DEFAULT_RETRY_DELAYS_MS
  const maxRateWaitMs = options.maxRateWaitMs ?? N11_MAX_RATE_WAIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.timeoutMs ?? N11_REQUEST_TIMEOUT_MS
  let networkCalls = 0

  for (let attempt = 0; ; attempt += 1) {
    let response: N11TransportResponse | null = null
    let transportFailure: 'NETWORK' | 'TIMEOUT' | null = null
    networkCalls += 1
    try {
      response = await options.transport({ url, headers: { ...auth.headers }, timeoutMs })
    } catch (error) {
      transportFailure = error instanceof N11TransportError ? error.kind : 'NETWORK'
    }
    const canRetry = attempt < delays.length

    if (transportFailure) {
      if (canRetry) {
        await sleep(delays[attempt])
        continue
      }
      return {
        ok: false, errorClass: 'PROVIDER_UNAVAILABLE',
        reasonCode: transportFailure === 'TIMEOUT' ? 'N11_TIMEOUT' : 'N11_NETWORK_ERROR',
        httpStatus: null, networkCalls,
      }
    }

    const res = response as N11TransportResponse
    const failure = classifyStatus(res.status)
    if (!failure) {
      let body: unknown
      try {
        body = JSON.parse(res.bodyText)
      } catch {
        return { ok: false, errorClass: 'RESPONSE_SHAPE_UNVERIFIED', reasonCode: 'N11_RESPONSE_NOT_JSON', httpStatus: res.status, networkCalls }
      }
      const page = extractN11Page(body)
      if (page === null) {
        return { ok: false, errorClass: 'RESPONSE_SHAPE_UNVERIFIED', reasonCode: 'N11_RESPONSE_SHAPE_UNVERIFIED', httpStatus: res.status, networkCalls }
      }
      return { ok: true, entries: page.entries, totalPages: page.totalPages, httpStatus: res.status, networkCalls }
    }

    if (failure.retryable && canRetry) {
      const headerWait = failure.errorClass === 'RATE_LIMITED' ? retryAfterMs(res.headers) : null
      await sleep(Math.min(Math.max(0, headerWait ?? delays[attempt]), maxRateWaitMs))
      continue
    }
    return { ok: false, errorClass: failure.errorClass, reasonCode: failure.reasonCode, httpStatus: res.status, networkCalls }
  }
}

/** Kullanıcıya gidecek SIRSIZ Türkçe ileti. */
export const N11_ERROR_COPY_TR: Record<N11ErrorClass, string> = {
  CREDENTIALS_MISSING: 'n11 API bilgileri eksik.',
  AUTH_ERROR: 'n11 API bilgileri reddedildi.',
  RATE_LIMITED: 'n11 istek sınırına ulaşıldı; daha sonra yeniden deneyin.',
  PROVIDER_UNAVAILABLE: 'n11 şu anda yanıt vermiyor.',
  REQUEST_REJECTED: 'n11 isteği reddetti.',
  RESPONSE_SHAPE_UNVERIFIED: 'n11 yanıtının biçimi resmî sözleşmeyle eşleşmedi; hiçbir sipariş yazılmadı.',
}
