// N11 — SÖZLEŞME KATMANI (saf karar; ağ/DB YOK).
//
// KAYNAK: n11 Mağaza Destek Merkezi (resmî genel dokümantasyon),
// doğrulama 2026-08-19.
//
// Kanıtlı sözleşme:
//   · GET https://api.n11.com/rest/delivery/v1/shipmentPackages
//   · Authorization şeması YOK; kimlik `appkey` + `appsecret` BAŞLIKLARIYLA
//   · servis limiti: dakikada 1000 istek
//   · sayfalama: `page` 0'dan başlar, `size` en çok 100, `totalPages` kullanılır
//   · pencere: yalnız startDate → sonraki 15 gün; yalnız endDate → önceki
//     15 gün; aşırı geniş aralık SON 15 günlük pencereye indirgenebilir
//   · statü TEK değer alır (çok statü → ÇOK İSTEK)

/** Resmî uç nokta — kanıtlı. */
export const N11_SHIPMENT_PACKAGES_URL =
  'https://api.n11.com/rest/delivery/v1/shipmentPackages'

/**
 * Resmî sipariş güncelleme ucu.
 *
 * TANIMLIDIR ama KULLANILMAZ: pazaryeri yazmaları kapalıdır
 * (`marketplaceWritesEnabled=false`). Hiçbir test ve hiçbir arka plan süreci
 * bu adrese istek ATMAZ.
 */
export const N11_ORDER_UPDATE_URL = 'https://api.n11.com/rest/order/v1/update'

/** Resmî servis limiti. */
export const N11_RATE_LIMIT_PER_MINUTE = 1000

/** Resmî sayfa boyutu tavanı. */
export const N11_MAX_PAGE_SIZE = 100

/** Resmî: sayfa numarası 0'dan başlar. */
export const N11_FIRST_PAGE = 0

/** Resmî pencere genişliği (gün). */
export const N11_WINDOW_DAYS = 15
export const N11_WINDOW_MS = N11_WINDOW_DAYS * 24 * 60 * 60 * 1000

/** Resmî REST statü kümesi. Trendyol statü dizeleri BURAYA KARIŞMAZ. */
export const N11_PACKAGE_STATUSES = [
  'Created',
  'Picking',
  'Shipped',
  'Cancelled',
  'Delivered',
  'Unpacked',
  'UnSupplied',
] as const

export type N11PackageStatus = (typeof N11_PACKAGE_STATUSES)[number]

export interface N11Credentials {
  appKey?: string | null
  appSecret?: string | null
}

export interface N11AuthResolution {
  ok: boolean
  headers: Record<string, string>
  errorCode: 'N11_CREDENTIALS_INCOMPLETE' | null
  maskedAppKey: string | null
}

const maskTail = (value: string): string =>
  value.length <= 3 ? '***' : `***${value.slice(-3)}`

/**
 * Kimlik BAŞLIKLARI kurar.
 *
 * Resmî sözleşmede `Authorization` YOKTUR; kimlik `appkey`/`appsecret`
 * başlıklarıyla taşınır. Bunlar SORGU PARAMETRESİNE KONMAZ — URL'ler proxy,
 * erişim kaydı ve tarayıcı geçmişinde saklanır; sır oraya sızmamalıdır.
 * Değerler loglanmaz; maskeli alan yalnız denetim içindir.
 */
export function buildN11AuthHeaders(
  credentials: N11Credentials,
): N11AuthResolution {
  const appKey = String(credentials.appKey ?? '').trim()
  const appSecret = String(credentials.appSecret ?? '').trim()
  if (!appKey || !appSecret) {
    return {
      ok: false,
      headers: {},
      errorCode: 'N11_CREDENTIALS_INCOMPLETE',
      maskedAppKey: appKey ? maskTail(appKey) : null,
    }
  }
  return {
    ok: true,
    headers: { appkey: appKey, appsecret: appSecret, Accept: 'application/json' },
    errorCode: null,
    maskedAppKey: maskTail(appKey),
  }
}

// ═══ PENCERE POLİTİKASI ═══════════════════════════════════════════════════

export interface N11WindowResolution {
  ok: boolean
  startMs: number
  endMs: number
  clamped: boolean
  /** Resmî davranışın hangi dalına düşüldüğü — denetlenebilirlik için. */
  mode: 'START_ONLY' | 'END_ONLY' | 'BOUNDED' | 'CLAMPED_TO_LAST_WINDOW'
  errorCode: 'N11_WINDOW_INVALID' | null
}

/**
 * Pencereyi resmî 15 günlük kurala göre SINIRLAR.
 *
 * Sunucunun geniş aralığı onurlandıracağı VARSAYILMAZ: resmî davranış aşırı
 * aralığı SON 15 güne indirmektir. Bunu istemci tarafında AÇIKÇA yapmak,
 * "istediğim aralık geldi" sanısını ve ondan doğan sessiz veri boşluğunu
 * engeller.
 */
export function resolveN11Window(params: {
  startMs?: number | null
  endMs?: number | null
  nowMs: number
}): N11WindowResolution {
  const nowMs = params.nowMs
  const hasStart = Number.isFinite(Number(params.startMs))
  const hasEnd = Number.isFinite(Number(params.endMs))
  const startMs = Number(params.startMs)
  const endMs = Number(params.endMs)

  if (hasStart && !hasEnd) {
    // Resmî: yalnız startDate → startDate'ten SONRAKİ 15 gün.
    return {
      ok: true, startMs, endMs: startMs + N11_WINDOW_MS,
      clamped: false, mode: 'START_ONLY', errorCode: null,
    }
  }
  if (!hasStart && hasEnd) {
    // Resmî: yalnız endDate → endDate'ten ÖNCEKİ 15 gün.
    return {
      ok: true, startMs: endMs - N11_WINDOW_MS, endMs,
      clamped: false, mode: 'END_ONLY', errorCode: null,
    }
  }
  if (!hasStart && !hasEnd) {
    return {
      ok: true, startMs: nowMs - N11_WINDOW_MS, endMs: nowMs,
      clamped: false, mode: 'END_ONLY', errorCode: null,
    }
  }
  if (endMs < startMs) {
    return {
      ok: false, startMs, endMs, clamped: false,
      mode: 'BOUNDED', errorCode: 'N11_WINDOW_INVALID',
    }
  }
  if (endMs - startMs > N11_WINDOW_MS) {
    // Resmî davranış: aşırı aralık SON pencereye indirgenir. Aynısını
    // AÇIKÇA yapıyoruz ki atlanan aralık çağırana görünür olsun.
    return {
      ok: true, startMs: endMs - N11_WINDOW_MS, endMs,
      clamped: true, mode: 'CLAMPED_TO_LAST_WINDOW', errorCode: null,
    }
  }
  return { ok: true, startMs, endMs, clamped: false, mode: 'BOUNDED', errorCode: null }
}

// ═══ SAYFALAMA ════════════════════════════════════════════════════════════

export interface N11PageRequest {
  page: number
  size: number
  orderByField?: string
  orderByDirection?: string
  status?: N11PackageStatus
}

/**
 * Sayfa isteği kurar.
 *
 * `page` 0 tabanlıdır (Hepsiburada `offset` tabanlıdır — iki sağlayıcı
 * KARIŞTIRILMAZ). `size` 100'e kelepçelenir.
 *
 * Artımlı senkron için `orderByField=true` ile `lastModifiedDate` sıralaması
 * ve ileri yönlü güvenli gezinme için `ASC` kullanılır.
 */
export function buildN11PageRequest(params: {
  page?: number
  size?: number
  status?: N11PackageStatus
  incremental?: boolean
}): N11PageRequest {
  const page = Math.max(N11_FIRST_PAGE, Math.trunc(Number(params.page ?? N11_FIRST_PAGE)) || 0)
  const rawSize = Math.trunc(Number(params.size ?? N11_MAX_PAGE_SIZE)) || 0
  const size = Math.min(Math.max(1, rawSize), N11_MAX_PAGE_SIZE)
  const request: N11PageRequest = { page, size }
  if (params.status) request.status = params.status
  if (params.incremental) {
    request.orderByField = 'true'
    request.orderByDirection = 'ASC'
  }
  return request
}

/**
 * Sonraki sayfa var mı?
 *
 * Resmî yönlendirme: `totalPages` kullanılır ve BOŞ içerik sonlandırıcı
 * sayılabilir. İkisi birlikte uygulanır — yalnız `totalPages`e güvenmek,
 * alan hiç gelmediğinde sonsuz döngü riskidir.
 */
export function hasNextN11Page(params: {
  page: number
  totalPages?: number | null
  returnedCount?: number | null
}): boolean {
  if (Number(params.returnedCount ?? 0) <= 0) return false
  const totalPages = Number(params.totalPages)
  if (Number.isFinite(totalPages) && totalPages > 0) {
    return Number(params.page) + 1 < totalPages
  }
  return false
}

/**
 * ÇOK STATÜ = ÇOK İSTEK.
 *
 * Resmî sözleşmede statü TEK değer alır. Virgülle birleştirmek sessizce
 * yanlış/boş sonuç verirdi; bu yüzden istekler AYRIŞTIRILIR.
 */
export function planN11StatusRequests(
  statuses: readonly string[] | undefined,
): N11PackageStatus[] {
  const list = Array.isArray(statuses) ? statuses : []
  const known = list.filter((status): status is N11PackageStatus =>
    (N11_PACKAGE_STATUSES as readonly string[]).includes(status),
  )
  return [...new Set(known)]
}
