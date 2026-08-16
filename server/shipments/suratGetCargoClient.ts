// SÜRAT MARKETPLACE getCargo — SALT OKUNUR SORGULAMA.
//
// BU İSTEMCİ GÖNDERİ OLUŞTURMAZ. Yalnız GET yapar; create yolu
// (`/api/OrtakBarkodOlustur`) bu modülde YASAKTIR ve testle kilitlidir.
//
// ENDPOINT UYDURULMAZ: repoda getCargo için kanıtlanmış bir yol yoktu
// (forensic audit). Bu yüzden temel URL ve yol ÇAĞIRAN tarafından açıkça
// verilir; yapılandırılmamışsa istemci `null` döner ve HİÇBİR ağ çağrısı
// yapmaz. Tahmini bir adrese istek atmak sessiz yanlış sonuç üretirdi.
//
// GİZLİLİK: yanıttan yalnız operasyonel payer alanları alınır. Müşteri adı,
// adres, telefon, e-posta ve kimlik bilgisi ne okunur ne loglanır.
import { normalizeSuratWhoPays, type BillingParty } from './suratBillingParty.ts'

export const SURAT_GET_CARGO_TIMEOUT_MS = 15_000

/** Create yolu bu istemcide ASLA kullanılmaz. */
export const FORBIDDEN_MUTATION_PATHS = [
  '/api/OrtakBarkodOlustur',
  '/api/GonderiyiKargoyaGonder',
] as const

export interface SuratGetCargoConfig {
  /** Ör. `https://<marketplace-host>` — tenant yapılandırmasından gelir. */
  baseUrl?: unknown
  /** Ör. `/api/getCargo` — vendor sözleşmesinden gelir. */
  path?: unknown
  /** Salt okunur sorgulama kimliği (değer LOGLANMAZ). */
  apiKey?: unknown
}

export interface SuratCargoBillingRecord {
  parcelUniqueId: string
  whoPays: string | null
  billingParty: BillingParty
  senderCode: string | null
  approved: boolean | null
  creationDate: string | null
}

export type SuratGetCargoOutcome =
  | { status: 'NOT_CONFIGURED'; record: null; reason: string }
  | { status: 'OK'; record: SuratCargoBillingRecord; reason: null }
  | { status: 'FAILED'; record: null; reason: string }

const text = (value: unknown): string => String(value ?? '').trim()

/** Yapılandırma tam mı — eksikse AĞA ÇIKILMAZ. */
export function isGetCargoConfigured(config: SuratGetCargoConfig = {}): boolean {
  return Boolean(text(config.baseUrl) && text(config.path))
}

/** Yanıttan YALNIZ operasyonel payer alanlarını süzer (beyaz liste). */
export function parseSuratCargoBillingRecord(
  payload: unknown,
  fallbackParcelId = '',
): SuratCargoBillingRecord {
  const body = (payload ?? {}) as Record<string, unknown>
  // Vendor yanıtı sarmalayabilir; bilinmeyen alanlar KIRMAZ.
  const cargo = ((body.cargo ?? body.data ?? body.result ?? body) ??
    {}) as Record<string, unknown>
  const whoPaysRaw = cargo.whoPays ?? cargo.WhoPays ?? null
  const whoPays = whoPaysRaw === null ? null : text(whoPaysRaw) || null
  const approvedRaw = cargo.approved ?? cargo.Approved
  return {
    parcelUniqueId:
      text(cargo.parcelUniqueId ?? cargo.ParcelUniqueId) || text(fallbackParcelId),
    whoPays,
    billingParty: whoPays === null ? 'UNKNOWN' : normalizeSuratWhoPays(whoPays),
    senderCode: text(cargo.senderCode ?? cargo.SenderCode) || null,
    approved: typeof approvedRaw === 'boolean' ? approvedRaw : null,
    creationDate: text(cargo.creationDate ?? cargo.CreationDate) || null,
  }
}

/**
 * Tek gönderinin faturalama kaydını SALT OKUNUR getirir.
 *
 * Yapılandırma yoksa ağ çağrısı YAPILMAZ (`NOT_CONFIGURED`). Hata durumunda
 * çağıranın akışını DÜŞÜRMEZ; gözlem katmanı üretimi etkilemez.
 */
export async function getSuratCargoByParcelUniqueId(params: {
  parcelUniqueId: string
  config?: SuratGetCargoConfig
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<SuratGetCargoOutcome> {
  const parcelUniqueId = text(params.parcelUniqueId)
  if (!parcelUniqueId) {
    return { status: 'FAILED', record: null, reason: 'PARCEL_ID_REQUIRED' }
  }
  const config = params.config ?? {}
  if (!isGetCargoConfigured(config)) {
    // TAHMİNİ ADRESE İSTEK YOK.
    return {
      status: 'NOT_CONFIGURED',
      record: null,
      reason: 'SURAT_GET_CARGO_NOT_CONFIGURED',
    }
  }

  const base = text(config.baseUrl).replace(/\/+$/, '')
  const path = text(config.path)
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
  for (const forbidden of FORBIDDEN_MUTATION_PATHS) {
    if (url.includes(forbidden)) {
      return { status: 'FAILED', record: null, reason: 'MUTATION_PATH_REFUSED' }
    }
  }

  const target = new URL(url)
  target.searchParams.set('parcelUniqueId', parcelUniqueId)

  const fetchImpl = params.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? SURAT_GET_CARGO_TIMEOUT_MS,
  )
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const apiKey = text(config.apiKey)
    // Kimlik başlığı gönderilir ama DEĞERİ hiçbir yerde loglanmaz.
    if (apiKey) headers['X-Api-Key'] = apiKey
    const response = await fetchImpl(target.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        status: 'FAILED',
        record: null,
        reason: `HTTP_${response.status}`,
      }
    }
    const payload = await response.json().catch(() => null)
    return {
      status: 'OK',
      record: parseSuratCargoBillingRecord(payload, parcelUniqueId),
      reason: null,
    }
  } catch (error) {
    return {
      status: 'FAILED',
      record: null,
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'TIMEOUT'
          : 'REQUEST_FAILED',
    }
  } finally {
    clearTimeout(timer)
  }
}
