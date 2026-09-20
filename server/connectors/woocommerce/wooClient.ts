// WOOCOMMERCE REST İSTEMCİSİ — wc/v3, YALNIZ OKUMA.
//
// Kaynak: providers/woocommerce/contracts/wc-v3.json.
//
// ═══ KİMLİK DOĞRULAMA — SIR ASLA URL'DE DEĞİL ════════════════════════════
//
// Sözleşme HTTPS için HTTP Basic tanımlar (kullanıcı=consumer_key,
// parola=consumer_secret) ve sunucu Authorization başlığını düşürürse
// sorgu dizesi YEDEĞİNDEN söz eder.
//
// CargoFlow bu YEDEĞİ KULLANMAZ. Sorgu dizesindeki `consumer_secret`
// erişim loglarına, proxy loglarına, tarayıcı/komut geçmişine ve Referer
// başlığına SIZAR — ve sır döndürülemez. Basic çalışmazsa GÜVENLİ bir
// AUTH/CONFIG hatası bildirilir.
//
// ═══ ORAN SINIRI UYDURULMAZ ══════════════════════════════════════════════
//
// Paket: resmî sabit limit YAYIMLANMAMIŞ (barındırmaya bağlı). Bu yüzden
// sahte bir sayısal limit KODLANMAZ; muhafazakâr eşzamanlılık ve sınırlı
// geri çekilme uygulanır.
import { inspectStoreUrlSyntax, assertStoreUrlAllowed, type DnsResolver } from '../storeUrlPolicy.ts'

/** Çağırana dönen KARARLI sınıflar — ham WordPress/PHP metni ASLA. */
export const WOO_ERROR_CLASSES = [
  'OK',
  'AUTH',
  'PERMISSION',
  'NOT_FOUND_OR_CONFIG',
  'RATE_LIMIT',
  'PROVIDER',
  'NETWORK',
  'MALFORMED_RESPONSE',
  'STORE_URL_REJECTED',
] as const
export type WooErrorClass = (typeof WOO_ERROR_CLASSES)[number]

export interface WooTransportResponse {
  status: number
  headers: Record<string, string>
  bodyText: string
}

/**
 * Taşıma katmanı ENJEKTE edilir.
 *
 * Kabul hermetiktir: testler kontrollü yerel sunucu/sahte taşıma kullanır.
 * Üretimde varsayılan `fetch` tabanlı taşıma kullanılır.
 */
export type WooTransport = (request: {
  url: string
  method: 'GET'
  headers: Record<string, string>
}) => Promise<WooTransportResponse>

export interface WooCredentials {
  storeUrl: string
  consumerKey: string
  consumerSecret: string
}

export interface WooClientOptions {
  transport: WooTransport
  resolver?: DnsResolver
  /** Sınırlı geri çekilme gecikmeleri (ms). Uzunluk = ÜST SINIR. */
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
}

export interface WooReadResult {
  ok: boolean
  errorClass: WooErrorClass
  status: number | null
  /** Ayrıştırılmış gövde (yalnız JSON ise). */
  data: unknown
  headers: Record<string, string>
  /** Operatöre gösterilebilir KARARLI metin — sağlayıcı metni değil. */
  message: string
}

const SAFE_MESSAGES: Record<WooErrorClass, string> = {
  OK: 'Bağlantı doğrulandı.',
  AUTH: 'Anahtar/sır kabul edilmedi. WooCommerce REST anahtarlarını kontrol edin.',
  PERMISSION: 'Anahtarın yetkisi yetersiz. Okuma (read) izni gerekir.',
  NOT_FOUND_OR_CONFIG:
    'REST ucu bulunamadı. WooCommerce REST API ve kalıcı bağlantılar (permalink) açık olmalı.',
  RATE_LIMIT: 'Mağaza şu anda istek sınırladı. Daha sonra tekrar deneyin.',
  PROVIDER: 'Mağaza sunucusu hata döndürdü.',
  NETWORK: 'Mağazaya ulaşılamadı.',
  MALFORMED_RESPONSE: 'Mağaza JSON olmayan bir yanıt döndürdü.',
  STORE_URL_REJECTED: 'Mağaza adresi güvenlik politikasına uymuyor.',
}

export function safeMessageFor(errorClass: WooErrorClass): string {
  return SAFE_MESSAGES[errorClass]
}

/** HTTP durumundan KARARLI sınıf. */
export function classifyWooStatus(status: number): WooErrorClass {
  if (status >= 200 && status <= 299) return 'OK'
  if (status === 401) return 'AUTH'
  if (status === 403) return 'PERMISSION'
  if (status === 404) return 'NOT_FOUND_OR_CONFIG'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500 && status <= 599) return 'PROVIDER'
  return 'PROVIDER'
}

/** Basic başlığı — sır YALNIZ başlıkta. */
export function buildBasicAuthHeader(consumerKey: string, consumerSecret: string): string {
  const raw = `${consumerKey}:${consumerSecret}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

/** `{storeUrl}/wp-json/wc/v3` — sözleşmedeki taban yol. */
export function buildWooBasePath(normalizedStoreUrl: string): string {
  return `${normalizedStoreUrl.replace(/\/+$/, '')}/wp-json/wc/v3`
}

export const WOO_MAX_PER_PAGE = 100
export const WOO_DEFAULT_PER_PAGE = 50

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = String(value)
  }
  return out
}

const DEFAULT_RETRY_DELAYS = [250, 750]

/** Yalnız GEÇİCİ sınıflar tekrar denenir; kalıcı 4xx ASLA. */
function isTransient(errorClass: WooErrorClass): boolean {
  return errorClass === 'RATE_LIMIT' || errorClass === 'PROVIDER' || errorClass === 'NETWORK'
}

/**
 * Tek GET — SSRF kapısı + sınırlı yeniden deneme.
 *
 * Her istek (yeniden denemeler dâhil) politika kapısından geçer; yönlendirme
 * varsa taşıma katmanı hedefi yeniden doğrulatır (`followRedirect`).
 */
export async function wooGet(
  credentials: WooCredentials,
  path: string,
  query: Record<string, string | number | undefined>,
  options: WooClientOptions,
): Promise<WooReadResult> {
  const decision = await assertStoreUrlAllowed(credentials.storeUrl, {
    ...(options.resolver ? { resolver: options.resolver } : {}),
  })
  if (!decision.ok) {
    return {
      ok: false,
      errorClass: 'STORE_URL_REJECTED',
      status: null,
      data: null,
      headers: {},
      message: `${SAFE_MESSAGES.STORE_URL_REJECTED} (${decision.rejection})`,
    }
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const base = buildWooBasePath(decision.normalizedUrl)
  const url = `${base}${path}${params.toString() ? `?${params}` : ''}`

  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  let last: WooReadResult | null = null
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    let response: WooTransportResponse | null = null
    let networkError = false
    try {
      response = await options.transport({
        url,
        method: 'GET',
        headers: {
          // SIR YALNIZ BURADA — sorgu dizesinde ASLA.
          Authorization: buildBasicAuthHeader(
            credentials.consumerKey,
            credentials.consumerSecret,
          ),
          Accept: 'application/json',
          'User-Agent': 'CargoFlow',
        },
      })
    } catch {
      networkError = true
    }

    if (networkError || !response) {
      last = {
        ok: false,
        errorClass: 'NETWORK',
        status: null,
        data: null,
        headers: {},
        message: SAFE_MESSAGES.NETWORK,
      }
    } else {
      const headers = normalizeHeaders(response.headers)
      const errorClass = classifyWooStatus(response.status)
      let data: unknown = null
      let parsed = true
      const bodyText = String(response.bodyText ?? '')
      if (bodyText.trim() !== '') {
        try {
          data = JSON.parse(bodyText)
        } catch {
          parsed = false
        }
      }
      if (errorClass === 'OK' && !parsed) {
        last = {
          ok: false,
          errorClass: 'MALFORMED_RESPONSE',
          status: response.status,
          data: null,
          headers,
          message: SAFE_MESSAGES.MALFORMED_RESPONSE,
        }
      } else {
        last = {
          ok: errorClass === 'OK',
          errorClass,
          status: response.status,
          data,
          headers,
          message: SAFE_MESSAGES[errorClass],
        }
      }
    }

    if (last.ok || !isTransient(last.errorClass) || attempt === delays.length) {
      return last
    }
    await sleep(delays[attempt] as number)
  }
  return last as WooReadResult
}

/**
 * GÜVENLİ BAĞLANTI TESTİ — en küçük yük, MUTASYON YOK.
 *
 * Sözleşmenin doğruladığı liste ucundan tek kayıt istenir. Başarı, YALNIZ O
 * ANDAKİ kimliklerin geçerli olduğunu kanıtlar; gelecekteki geçerliliği
 * kanıtlamaz.
 */
export async function testWooConnection(
  credentials: WooCredentials,
  options: WooClientOptions,
): Promise<WooReadResult> {
  return wooGet(credentials, '/orders', { page: 1, per_page: 1 }, options)
}

export interface WooOrdersPageQuery {
  page?: number
  perPage?: number
  after?: string
  before?: string
  status?: string
  order?: 'asc' | 'desc'
  orderby?: string
}

export const WOO_FETCH_OUTCOMES = ['SUCCESS', 'PARTIAL', 'FAILED'] as const
export type WooFetchOutcome = (typeof WOO_FETCH_OUTCOMES)[number]

export interface WooOrdersFetchResult {
  outcome: WooFetchOutcome
  /** Ham sağlayıcı sipariş nesneleri (normalleştirme AYRI katman). */
  rawOrders: unknown[]
  pagesFetched: number
  /** X-WP-TotalPages (varsa). */
  totalPages: number | null
  /** X-WP-Total (varsa). */
  totalCount: number | null
  errorClass: WooErrorClass | null
  message: string | null
}

/**
 * SAYFA GEZİNMESİ — deterministik.
 *
 * · `page` 1'den başlar (sözleşme: page-number stili)
 * · `X-WP-TotalPages` varsa ona UYULUR
 * · başlık yoksa BOŞ sayfa güvenli durma koşuludur
 * · güvenlik üst sınırına çarparsa sonuç SESSİZCE kesilmez → PARTIAL
 * · herhangi bir sayfa düşerse → PARTIAL (o ana kadarki veri taşınır)
 */
export async function fetchWooOrders(
  credentials: WooCredentials,
  query: WooOrdersPageQuery,
  options: WooClientOptions & { maxPages?: number },
): Promise<WooOrdersFetchResult> {
  const perPage = Math.min(
    Math.max(Number(query.perPage ?? WOO_DEFAULT_PER_PAGE), 1),
    WOO_MAX_PER_PAGE,
  )
  const maxPages = Math.max(Number(options.maxPages ?? 50), 1)
  const startPage = Math.max(Number(query.page ?? 1), 1)

  const rawOrders: unknown[] = []
  let totalPages: number | null = null
  let totalCount: number | null = null
  let pagesFetched = 0

  for (let page = startPage; page < startPage + maxPages; page += 1) {
    const result = await wooGet(
      credentials,
      '/orders',
      {
        page,
        per_page: perPage,
        after: query.after,
        before: query.before,
        status: query.status,
        order: query.order,
        orderby: query.orderby,
      },
      options,
    )

    if (!result.ok) {
      return {
        // İLK sayfa bile alınamadıysa FAILED; kısmi veri varsa PARTIAL.
        outcome: pagesFetched === 0 ? 'FAILED' : 'PARTIAL',
        rawOrders,
        pagesFetched,
        totalPages,
        totalCount,
        errorClass: result.errorClass,
        message: result.message,
      }
    }

    pagesFetched += 1
    const totalPagesHeader = Number(result.headers['x-wp-totalpages'])
    if (Number.isFinite(totalPagesHeader) && totalPagesHeader > 0) {
      totalPages = totalPagesHeader
    }
    const totalHeader = Number(result.headers['x-wp-total'])
    if (Number.isFinite(totalHeader) && totalHeader >= 0) totalCount = totalHeader

    const content = Array.isArray(result.data) ? result.data : []
    rawOrders.push(...content)

    // Durma koşulları — SESSİZ KESİNTİ YOK.
    if (totalPages !== null && page >= totalPages) {
      return {
        outcome: 'SUCCESS',
        rawOrders,
        pagesFetched,
        totalPages,
        totalCount,
        errorClass: null,
        message: null,
      }
    }
    if (content.length === 0) {
      return {
        outcome: 'SUCCESS',
        rawOrders,
        pagesFetched,
        totalPages,
        totalCount,
        errorClass: null,
        message: null,
      }
    }
    if (totalPages === null && content.length < perPage) {
      return {
        outcome: 'SUCCESS',
        rawOrders,
        pagesFetched,
        totalPages,
        totalCount,
        errorClass: null,
        message: null,
      }
    }
  }

  // Güvenlik üst sınırına çarpıldı: veri EKSİK olabilir → AÇIKÇA bildirilir.
  return {
    outcome: 'PARTIAL',
    rawOrders,
    pagesFetched,
    totalPages,
    totalCount,
    errorClass: null,
    message: 'Sayfa üst sınırına ulaşıldı; çekim EKSİK olabilir.',
  }
}

/**
 * Üretim taşıma katmanı — yönlendirme KAPALI.
 *
 * `redirect: 'manual'`: bir mağaza herkese açık adresten özel hedefe
 * yönlendirerek SSRF kapısını atlayamaz. Yönlendirme görülürse istek
 * başarısız sayılır (hedef ayrıca doğrulanmadıkça izlenmez).
 */
export const fetchWooTransport: WooTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    redirect: 'manual',
  })
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return {
    status: response.status,
    headers,
    bodyText: await response.text(),
  }
}

/**
 * Yönlendirme hedefi doğrulaması.
 *
 * Yönlendirme İZLENECEKSE hedef AYNI kapıdan geçmelidir. Bu fonksiyon
 * `Location` başlığını politikaya sokar; özel hedef REDDEDİLİR.
 */
export async function validateRedirectTarget(
  location: unknown,
  options: { resolver?: DnsResolver } = {},
): Promise<{ allowed: boolean; rejection: string | null }> {
  const syntax = inspectStoreUrlSyntax(location)
  if (!syntax.ok) return { allowed: false, rejection: syntax.rejection }
  const full = await assertStoreUrlAllowed(location, {
    ...(options.resolver ? { resolver: options.resolver } : {}),
  })
  return full.ok
    ? { allowed: true, rejection: null }
    : { allowed: false, rejection: full.rejection }
}
