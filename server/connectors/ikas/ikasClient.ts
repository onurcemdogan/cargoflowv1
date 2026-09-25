// IKAS ADMIN API İSTEMCİSİ — OAUTH2 client_credentials + GraphQL, YALNIZ OKUMA.
//
// Kaynak: providers/ikas/contracts/admin-v1.json (v2).
//
// ═══ SIR YÖNETİMİ ════════════════════════════════════════════════════════
//
//   · client_id + client_secret UZUN ÖMÜRLÜ kimliktir → şifreli
//     `connector_credentials` içinde durur (bu dosya kalıcılaştırmaz).
//   · access_token GEÇİCİDİR → YALNIZ süreç belleğinde önbelleklenir,
//     ASLA kalıcılaştırılmaz. Ömür YANITTAKİ `expires_in` alanından okunur
//     (sözleşme: 14400 sn) ve güvenlik payı düşülür.
//   · Sır, belirteç ve Authorization başlığı ASLA loglanmaz ve sorgu
//     dizesine KONMAZ (belirteç isteği form gövdesiyle gider).
//
// ═══ GRAPHQL'DE HTTP 200 BAŞARI DEĞİLDİR ═════════════════════════════════
//
// Her yanıtta `errors[]` denetlenir; boş değilse sağlayıcı hatasıdır.
// Kimliği doğrulanmış GraphQL isteği 401 alırsa belirteç BİR KEZ yenilenir
// ve istek BİR KEZ tekrarlanır — sonsuz yenileme döngüsü YOK.
import { createHash } from 'node:crypto'
import { IKAS_GRAPHQL_URL, isAllowedIkasRequestUrl } from './ikasStoreName.ts'

/** Çağırana dönen KARARLI sınıflar — ham GraphQL/sağlayıcı metni ASLA. */
export const IKAS_ERROR_CLASSES = [
  'STORE_NAME_INVALID',
  'AUTH_FAILED',
  'TOKEN_RESPONSE_INVALID',
  'GRAPHQL_AUTH_FAILED',
  'GRAPHQL_ERROR',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'PROVIDER_RESPONSE_INVALID',
  'PARTIAL_PAGINATION',
  'MERCHANT_MISMATCH',
  'REQUEST_TARGET_REJECTED',
] as const
export type IkasErrorClass = (typeof IKAS_ERROR_CLASSES)[number]

const SAFE_MESSAGES: Record<IkasErrorClass, string> = {
  STORE_NAME_INVALID: 'ikas mağaza adı geçersiz. Yalnız mağaza adını girin (örn. magazam).',
  AUTH_FAILED: 'Client ID / Client Secret kabul edilmedi.',
  TOKEN_RESPONSE_INVALID: 'ikas erişim belirteci yanıtı beklenen biçimde değil.',
  GRAPHQL_AUTH_FAILED: 'ikas erişim belirteci kabul edilmedi.',
  GRAPHQL_ERROR: 'ikas isteği hata döndürdü.',
  PERMISSION_DENIED: 'Uygulamanın yetkisi yetersiz. Sipariş okuma izni gerekir.',
  RATE_LIMITED: 'ikas şu anda istek sınırladı. Daha sonra tekrar deneyin.',
  NETWORK_ERROR: 'ikas sunucusuna ulaşılamadı.',
  TIMEOUT: 'ikas isteği zaman aşımına uğradı.',
  PROVIDER_ERROR: 'ikas sunucusu hata döndürdü.',
  PROVIDER_RESPONSE_INVALID: 'ikas yanıtı beklenen biçimde değil.',
  PARTIAL_PAGINATION: 'Sipariş sayfalaması tamamlanamadı.',
  MERCHANT_MISMATCH: 'ikas yanıtı bağlı mağazayla eşleşmiyor.',
  REQUEST_TARGET_REJECTED: 'İstek hedefi izin verilen ikas adresi değil.',
}

export function ikasSafeMessage(errorClass: IkasErrorClass): string {
  return SAFE_MESSAGES[errorClass]
}

export interface IkasCredentials {
  storeName: string
  tokenUrl: string
  clientId: string
  clientSecret: string
}

export interface IkasTransportRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

export interface IkasTransportResponse {
  status: number
  bodyText: string
}

/** Taşıma ENJEKTE edilir: kabul hermetiktir (sahte taşıma). */
export type IkasTransport = (request: IkasTransportRequest) => Promise<IkasTransportResponse>

export class IkasTransportError extends Error {
  readonly kind: 'NETWORK' | 'TIMEOUT'
  constructor(kind: 'NETWORK' | 'TIMEOUT') {
    super(kind === 'TIMEOUT' ? 'ikas zaman aşımı' : 'ikas ağ hatası')
    this.kind = kind
  }
}

export const IKAS_REQUEST_TIMEOUT_MS = 15_000

/**
 * Üretim taşıması: yönlendirme İZLENMEZ (host kaçışı yok), süre sınırlı.
 * Gövde/başlık LOGLANMAZ.
 */
export const fetchIkasTransport: IkasTransport = async (request) => {
  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(IKAS_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    throw new IkasTransportError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK')
  }
  return { status: response.status, bodyText: await response.text() }
}

/** Belirteç önbelleği — YALNIZ bellek. Anahtar sır İÇERMEZ (özet). */
export class IkasTokenCache {
  readonly #entries = new Map<string, { token: string; expiresAtMs: number }>()

  static keyFor(credentials: IkasCredentials): string {
    const digest = createHash('sha256')
      .update(`${credentials.storeName}\u0000${credentials.clientId}\u0000${credentials.clientSecret}`)
      .digest('hex')
    return `${credentials.storeName}::${digest}`
  }

  get(key: string, nowMs: number): string | null {
    const entry = this.#entries.get(key)
    if (!entry || entry.expiresAtMs <= nowMs) return null
    return entry.token
  }

  set(key: string, token: string, expiresAtMs: number): void {
    this.#entries.set(key, { token, expiresAtMs })
  }

  invalidate(key: string): void {
    this.#entries.delete(key)
  }

  get size(): number {
    return this.#entries.size
  }
}

/** Süreç geneli varsayılan önbellek (kalıcı DEĞİL). */
export const defaultIkasTokenCache = new IkasTokenCache()

/** Belirteç süresinden düşülen güvenlik payı. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000

export interface IkasClientOptions {
  transport: IkasTransport
  tokenCache?: IkasTokenCache
  now?: () => number
  /** Geçici hatalar (429/5xx/ağ) için SINIRLI geri çekilme; uzunluk = ÜST SINIR. */
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
}

export type IkasResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorClass: IkasErrorClass; httpStatus: number | null }

function classifyHttp(status: number): IkasErrorClass | null {
  if (status >= 200 && status <= 299) return null
  if (status === 401) return 'AUTH_FAILED'
  if (status === 403) return 'PERMISSION_DENIED'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 300 && status <= 399) return 'REQUEST_TARGET_REJECTED'
  return 'PROVIDER_ERROR'
}

const RETRYABLE: ReadonlySet<IkasErrorClass> = new Set([
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
])

async function send(
  request: IkasTransportRequest,
  options: IkasClientOptions,
  nonRetryableHttpStatuses: readonly number[] = [],
): Promise<{ ok: true; response: IkasTransportResponse } | { ok: false; errorClass: IkasErrorClass }> {
  // Savunma derinliği: yalnız izinli iki hedef.
  if (!isAllowedIkasRequestUrl(request.url)) {
    return { ok: false, errorClass: 'REQUEST_TARGET_REJECTED' }
  }
  const delays = options.retryDelaysMs ?? [500, 1500]
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt += 1) {
    let outcome: { ok: true; response: IkasTransportResponse } | { ok: false; errorClass: IkasErrorClass }
    try {
      const response = await options.transport(request)
      const httpClass = classifyHttp(response.status)
      outcome =
        httpClass && RETRYABLE.has(httpClass) && !nonRetryableHttpStatuses.includes(response.status)
          ? { ok: false, errorClass: httpClass }
          : { ok: true, response }
    } catch (error) {
      outcome = {
        ok: false,
        errorClass:
          error instanceof IkasTransportError && error.kind === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR',
      }
    }
    if (outcome.ok || attempt >= delays.length) return outcome
    await sleep(delays[attempt])
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** OAuth2 client_credentials — form gövdesi; sır ASLA sorgu dizesinde değil. */
export async function requestIkasToken(
  credentials: IkasCredentials,
  options: IkasClientOptions,
): Promise<IkasResult<{ accessToken: string; expiresInSec: number }>> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  }).toString()
  const sent = await send(
    {
      url: credentials.tokenUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    },
    options,
    [400], // Return OAuth credential rejection to the token-specific mapping without retrying.
  )
  if (!sent.ok) return { ok: false, errorClass: sent.errorClass, httpStatus: null }
  const status = sent.response.status
  const httpClass = classifyHttp(status)
  if (httpClass) {
    // 400/401 → kimlik reddi (client_credentials yanlış).
    return {
      ok: false,
      errorClass: status === 400 || status === 401 ? 'AUTH_FAILED' : httpClass,
      httpStatus: status,
    }
  }
  const payload = parseJson(sent.response.bodyText) as Record<string, unknown> | undefined
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : ''
  const expiresInSec = Number(payload?.expires_in)
  if (accessToken === '' || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    return { ok: false, errorClass: 'TOKEN_RESPONSE_INVALID', httpStatus: status }
  }
  return { ok: true, data: { accessToken, expiresInSec } }
}

async function obtainToken(
  credentials: IkasCredentials,
  options: IkasClientOptions,
  forceRefresh: boolean,
): Promise<IkasResult<string>> {
  const cache = options.tokenCache ?? defaultIkasTokenCache
  const now = options.now ?? Date.now
  const key = IkasTokenCache.keyFor(credentials)
  if (!forceRefresh) {
    const cached = cache.get(key, now())
    if (cached) return { ok: true, data: cached }
  } else {
    cache.invalidate(key)
  }
  const token = await requestIkasToken(credentials, options)
  if (!token.ok) return token
  const lifetimeMs = token.data.expiresInSec * 1000
  // Güvenlik payı: süre çok kısaysa önbelleklenmez (her istek yeniler).
  const expiresAtMs = now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS)
  if (expiresAtMs > now()) cache.set(key, token.data.accessToken, expiresAtMs)
  return { ok: true, data: token.data.accessToken }
}

interface GraphqlError {
  message?: unknown
  extensions?: { code?: unknown }
}

/** `errors[]` → KARARLI sınıf (ham metin DIŞARI ÇIKMAZ). */
export function classifyGraphqlErrors(errors: GraphqlError[]): IkasErrorClass {
  const codes = errors.map((error) => String(error?.extensions?.code ?? '').toUpperCase())
  if (codes.some((code) => code === 'UNAUTHENTICATED')) return 'GRAPHQL_AUTH_FAILED'
  if (codes.some((code) => code === 'FORBIDDEN')) return 'PERMISSION_DENIED'
  return 'GRAPHQL_ERROR'
}

/**
 * Kimliği doğrulanmış GraphQL isteği.
 *
 * 401 → belirteç BİR KEZ yenilenir, istek BİR KEZ tekrarlanır. İkinci 401
 * durur (döngü YOK). `errors[]` boş değilse HTTP 200 olsa bile BAŞARISIZ.
 */
export async function ikasGraphql<T>(
  credentials: IkasCredentials,
  query: string,
  variables: Record<string, unknown>,
  options: IkasClientOptions,
): Promise<IkasResult<T>> {
  for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
    const token = await obtainToken(credentials, options, authAttempt > 0)
    if (!token.ok) return token
    const sent = await send(
      {
        url: IKAS_GRAPHQL_URL,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token.data}`,
        },
        body: JSON.stringify({ query, variables }),
      },
      options,
    )
    if (!sent.ok) return { ok: false, errorClass: sent.errorClass, httpStatus: null }
    const status = sent.response.status
    if (status === 401) {
      if (authAttempt === 0) continue // BİR KEZ yenile + tekrar dene
      return { ok: false, errorClass: 'GRAPHQL_AUTH_FAILED', httpStatus: status }
    }
    const httpClass = classifyHttp(status)
    if (httpClass) return { ok: false, errorClass: httpClass, httpStatus: status }
    const payload = parseJson(sent.response.bodyText) as
      | { data?: unknown; errors?: unknown }
      | undefined
    if (!payload || typeof payload !== 'object') {
      return { ok: false, errorClass: 'PROVIDER_RESPONSE_INVALID', httpStatus: status }
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      return {
        ok: false,
        errorClass: classifyGraphqlErrors(payload.errors as GraphqlError[]),
        httpStatus: status,
      }
    }
    if (payload.data === undefined || payload.data === null) {
      return { ok: false, errorClass: 'PROVIDER_RESPONSE_INVALID', httpStatus: status }
    }
    return { ok: true, data: payload.data as T }
  }
  return { ok: false, errorClass: 'GRAPHQL_AUTH_FAILED', httpStatus: 401 }
}

/* ─── SORGULAR — yalnız normalleştirmenin İHTİYAÇ duyduğu alanlar ─────── */

export const GET_MERCHANT_QUERY = `query CargoFlowMerchant {
  getMerchant { id storeName }
}`

/**
 * Sipariş okuma. `updatedAt` Order TİPİNDE belgelenmediği için SEÇİLMEZ;
 * yalnız FİLTRE argümanıdır. `sort` sözdizimi belgelenmediği için
 * KULLANILMAZ. Kişisel alanlar yalnız normalleştirmenin gerektirdiği kadar.
 */
export const LIST_ORDER_QUERY = `query CargoFlowListOrder($pagination: PaginationInput, $updatedAt: DateFilterInput) {
  listOrder(pagination: $pagination, updatedAt: $updatedAt) {
    hasNext
    page
    limit
    data {
      id
      merchantId
      orderNumber
      status
      orderPackageStatus
      orderedAt
      currencyCode
      totalFinalPrice
      customer { id fullName firstName lastName phone }
      shippingAddress {
        firstName lastName addressLine1 addressLine2 phone postalCode
        city { name } district { name }
      }
      orderLineItems {
        id quantity price finalPrice status
        options { name values { name value } }
        variant { id sku barcodeList name }
      }
      orderPackages {
        id orderPackageNumber orderLineItemIds orderPackageFulfillStatus
        trackingInfo { trackingNumber cargoCompany trackingLink }
      }
    }
  }
}`

export const IKAS_MAX_PAGE_LIMIT = 200

export interface IkasMerchant {
  id: string
  storeName: string | null
}

export async function fetchIkasMerchant(
  credentials: IkasCredentials,
  options: IkasClientOptions,
): Promise<IkasResult<IkasMerchant>> {
  const result = await ikasGraphql<{ getMerchant?: { id?: unknown; storeName?: unknown } }>(
    credentials,
    GET_MERCHANT_QUERY,
    {},
    options,
  )
  if (!result.ok) return result
  const id = String(result.data?.getMerchant?.id ?? '').trim()
  if (id === '') return { ok: false, errorClass: 'PROVIDER_RESPONSE_INVALID', httpStatus: 200 }
  const storeName = String(result.data?.getMerchant?.storeName ?? '').trim()
  return { ok: true, data: { id, storeName: storeName === '' ? null : storeName } }
}

export interface IkasOrderPage {
  data: Record<string, unknown>[]
  hasNext: boolean
  page: number
}

/** Tek sayfa sipariş — sayfa meta verisi DOĞRULANIR. */
export async function fetchIkasOrderPage(
  credentials: IkasCredentials,
  /** `updatedAt` değerleri Timestamp'tır: epoch MİLİSANİYE tam sayı. */
  params: { page: number; limit: number; updatedAt?: { gte?: number; lte?: number } },
  options: IkasClientOptions,
): Promise<IkasResult<IkasOrderPage>> {
  const limit = Math.min(IKAS_MAX_PAGE_LIMIT, Math.max(1, Math.trunc(params.limit)))
  const result = await ikasGraphql<{ listOrder?: Record<string, unknown> }>(
    credentials,
    LIST_ORDER_QUERY,
    {
      pagination: { page: params.page, limit },
      ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
    },
    options,
  )
  if (!result.ok) return result
  const list = result.data?.listOrder
  if (
    !list ||
    !Array.isArray(list.data) ||
    typeof list.hasNext !== 'boolean' ||
    !Number.isInteger(list.page)
  ) {
    return { ok: false, errorClass: 'PROVIDER_RESPONSE_INVALID', httpStatus: 200 }
  }
  return {
    ok: true,
    data: {
      data: list.data as Record<string, unknown>[],
      hasNext: list.hasNext,
      page: list.page as number,
    },
  }
}
