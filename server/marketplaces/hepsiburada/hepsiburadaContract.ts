// HEPSIBURADA — SÖZLEŞME KATMANI (saf karar; ağ/DB YOK).
//
// KAYNAK: Hepsiburada Developer Portal (resmî genel dokümantasyon),
// doğrulama tarihi 2026-08-19. Aşağıdaki HER kural o kaynaktan gelir;
// buraya kaynakta OLMAYAN hiçbir alan/kural eklenmez.
//
// KAPSAM SINIRI — ÖNEMLİ: resmî dokümantasyon bu denetimde uç nokta YOLLARINI
// (path) kanıtlanmış biçimde vermedi. Bu yüzden yol BURADA UYDURULMAZ;
// yapılandırmadan gelir ve verilmezse çağrı KURULMAZ (fail-closed). Host
// kuralı, kimlik doğrulama, sayfalama ve pencere kuralları kanıtlıdır ve
// uygulanmıştır.

/** Resmî kural: `-sit` içeren host SIT/test ortamıdır. */
export const HEPSIBURADA_SIT_MARKER = '-sit'

/**
 * `-sit` kaldırma kuralının uygulanabileceği DOĞRULANMIŞ host ekleri.
 *
 * Kural yalnız Hepsiburada'nın KENDİ hostlarında geçerlidir. Bunu genel bir
 * dize işlemi yapmak, ilgisiz bir host'ta sessizce "üretim" üretirdi.
 */
export const HEPSIBURADA_VERIFIED_HOST_SUFFIXES = [
  '.hepsiburada.com',
  '.hepsiburada.com.tr',
] as const

export type HepsiburadaEnvironment = 'SIT' | 'PRODUCTION'

export interface HepsiburadaHostResolution {
  ok: boolean
  host: string | null
  environment: HepsiburadaEnvironment | null
  errorCode:
    | 'HB_HOST_NOT_VERIFIED'
    | 'HB_HOST_EMPTY'
    | 'HB_PRODUCTION_HOST_NOT_DERIVABLE'
    | null
  reason: string | null
}

const isVerifiedHepsiburadaHost = (host: string): boolean =>
  HEPSIBURADA_VERIFIED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))

/**
 * Ortam çözümü.
 *
 * Resmî kural: dokümante URL'lerde `-sit` SIT/test'i gösterir; üretim URL'si
 * `-sit` KALDIRILARAK elde edilir ve ÜRETİM kullanıcı/parolası gerektirir.
 *
 * Bu dönüşüm YALNIZ doğrulanmış Hepsiburada hostlarında uygulanır. Test
 * host'undan üretim host'u türetmek başka hiçbir sağlayıcı için YAPILMAZ
 * (bkz. Aras: üretim host'u dışarıdan yapılandırılır).
 */
export function resolveHepsiburadaHost(params: {
  host?: string | null
  environment?: HepsiburadaEnvironment
}): HepsiburadaHostResolution {
  const host = String(params.host ?? '').trim().toLowerCase()
  if (!host) {
    return {
      ok: false, host: null, environment: null,
      errorCode: 'HB_HOST_EMPTY',
      reason: 'Hepsiburada host bilgisi verilmedi.',
    }
  }
  if (!isVerifiedHepsiburadaHost(host)) {
    return {
      ok: false, host: null, environment: null,
      errorCode: 'HB_HOST_NOT_VERIFIED',
      reason:
        'Host doğrulanmış Hepsiburada alan adı değil; `-sit` dönüşümü UYGULANMAZ.',
    }
  }
  const isSit = host.includes(HEPSIBURADA_SIT_MARKER)
  const target = params.environment ?? (isSit ? 'SIT' : 'PRODUCTION')

  if (target === 'SIT') {
    return {
      ok: true,
      host,
      environment: isSit ? 'SIT' : 'PRODUCTION',
      errorCode: null,
      reason: null,
    }
  }
  // Üretim istendi.
  if (!isSit) {
    return { ok: true, host, environment: 'PRODUCTION', errorCode: null, reason: null }
  }
  const productionHost = host.split(HEPSIBURADA_SIT_MARKER).join('')
  if (!productionHost || !isVerifiedHepsiburadaHost(productionHost)) {
    return {
      ok: false, host: null, environment: null,
      errorCode: 'HB_PRODUCTION_HOST_NOT_DERIVABLE',
      reason: '`-sit` kaldırıldığında geçerli bir Hepsiburada host oluşmadı.',
    }
  }
  return {
    ok: true, host: productionHost, environment: 'PRODUCTION',
    errorCode: null, reason: null,
  }
}

// ═══ KİMLİK DOĞRULAMA ═════════════════════════════════════════════════════

export interface HepsiburadaCredentials {
  merchantId?: string | null
  username?: string | null
  password?: string | null
}

export interface HepsiburadaAuthResolution {
  ok: boolean
  headers: Record<string, string>
  errorCode: 'HB_CREDENTIALS_INCOMPLETE' | null
  /** Denetim için — SIR İÇERMEZ. */
  maskedUsername: string | null
}

const maskTail = (value: string): string =>
  value.length <= 3 ? '***' : `***${value.slice(-3)}`

/**
 * Resmî sözleşme: sipariş entegrasyonu HTTP Basic Auth kullanır.
 *
 * SIR SIZDIRMAZ: dönen nesne yalnız hazır header taşır; parola hiçbir yerde
 * loglanmaz ve maskeli alan yalnız kullanıcı adının son 3 hanesini gösterir.
 * Üretim ortamı ÜRETİM kullanıcı/parolası ister — bu modül ortamı seçmez,
 * yalnız verilen kimliği kodlar.
 */
export function buildHepsiburadaAuth(
  credentials: HepsiburadaCredentials,
): HepsiburadaAuthResolution {
  const username = String(credentials.username ?? '').trim()
  const password = String(credentials.password ?? '')
  const merchantId = String(credentials.merchantId ?? '').trim()
  if (!username || !password || !merchantId) {
    return {
      ok: false,
      headers: {},
      errorCode: 'HB_CREDENTIALS_INCOMPLETE',
      maskedUsername: username ? maskTail(username) : null,
    }
  }
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return {
    ok: true,
    headers: {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
    },
    errorCode: null,
    maskedUsername: maskTail(username),
  }
}

// ═══ ORAN SINIRI (RATE LIMIT) ═════════════════════════════════════════════
//
// Resmî uyarı: farklı Hepsiburada API aileleri FARKLI limitler yayımlar.
// Bu yüzden TEK global limit sabitlenmez; politika aile bazında tutulur ve
// yanıt başlıkları okunur.

export const HEPSIBURADA_RATE_HEADERS = {
  remaining: 'x-ratelimit-remaining',
  limit: 'x-ratelimit-limit',
  reset: 'x-ratelimit-reset',
} as const

/** API ailesi — limitler aile başına yapılandırılır, tahmin EDİLMEZ. */
export type HepsiburadaApiFamily = 'ORDERS' | 'PACKAGES' | 'LABELS'

export interface HepsiburadaRateState {
  family: HepsiburadaApiFamily
  rateLimited: boolean
  remaining: number | null
  limit: number | null
  resetSeconds: number | null
  retryAfterMs: number | null
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const headerLookup = (
  headers: Record<string, unknown> | undefined,
  name: string,
): unknown => {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

/**
 * Yanıttan oran-sınırı durumunu okur.
 *
 * `429` tek başına yeterli sinyal DEĞİLDİR: başlıklar varsa bekleme süresi
 * ONLARDAN türetilir. Başlık yoksa `retryAfterMs` null kalır ve çağıran
 * kendi sınırlı backoff'unu uygular — burada süre UYDURULMAZ.
 */
export function readHepsiburadaRateState(params: {
  family: HepsiburadaApiFamily
  statusCode?: number | null
  headers?: Record<string, unknown>
}): HepsiburadaRateState {
  const remaining = numberOrNull(
    headerLookup(params.headers, HEPSIBURADA_RATE_HEADERS.remaining),
  )
  const limit = numberOrNull(
    headerLookup(params.headers, HEPSIBURADA_RATE_HEADERS.limit),
  )
  const resetSeconds = numberOrNull(
    headerLookup(params.headers, HEPSIBURADA_RATE_HEADERS.reset),
  )
  return {
    family: params.family,
    rateLimited: Number(params.statusCode) === 429,
    remaining,
    limit,
    resetSeconds,
    retryAfterMs:
      resetSeconds !== null && resetSeconds >= 0
        ? Math.min(resetSeconds * 1000, 60_000)
        : null,
  }
}

// ═══ UÇ NOKTA YOLU — YAPILANDIRMADAN, UYDURULMAZ ══════════════════════════

export interface HepsiburadaEndpointResolution {
  ok: boolean
  url: string | null
  errorCode: 'HB_ENDPOINT_PATH_UNVERIFIED' | null
  reason: string | null
}

/**
 * Uç nokta URL'si kurar.
 *
 * `path` YAPILANDIRMADAN gelir. Bu denetimde resmî yol kanıtı elde
 * EDİLEMEDİĞİ için burada varsayılan bir yol TANIMLANMAZ: yol verilmezse
 * istek KURULMAZ. Yanlış bir yola istek atmak, sessizce 404 alıp "sipariş
 * yok" sanmaya yol açardı.
 */
export function buildHepsiburadaUrl(params: {
  host?: string | null
  environment?: HepsiburadaEnvironment
  path?: string | null
  query?: Record<string, string | number | undefined>
}): HepsiburadaEndpointResolution {
  const hostResolution = resolveHepsiburadaHost({
    host: params.host,
    environment: params.environment,
  })
  if (!hostResolution.ok) {
    return {
      ok: false, url: null,
      errorCode: 'HB_ENDPOINT_PATH_UNVERIFIED',
      reason: hostResolution.reason,
    }
  }
  const path = String(params.path ?? '').trim()
  if (!path) {
    return {
      ok: false, url: null,
      errorCode: 'HB_ENDPOINT_PATH_UNVERIFIED',
      reason:
        'Hepsiburada uç nokta yolu yapılandırılmadı; resmî yol kanıtı olmadan '
        + 'yol üretilmez.',
    }
  }
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const suffix = search.toString()
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return {
    ok: true,
    url: `https://${hostResolution.host}${normalizedPath}${suffix ? `?${suffix}` : ''}`,
    errorCode: null,
    reason: null,
  }
}
