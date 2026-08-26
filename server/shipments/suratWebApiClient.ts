// SÜRAT WEB API — CANLI (PRODUCTION) İSTEMCİ.
//
// SOURCE OF TRUTH:
//   1) Sürat entegrasyon ekibinin müşteriye verdiği CANLI entegrasyon talimatı
//   2) Sürat Kargo Web API OpenAPI 3.0.0 sözleşmesi
//
// CANLI UÇ:  POST https://api02.suratkargo.com.tr/api/OrtakBarkodOlustur
//
// PRODUCTION-FIRST: bu modül YALNIZ canlı davranışı hedefler. Test/prova
// kavramı, sandbox host'u, örnek credential veya örnek kargo numarası
// İÇERMEZ. Testler bu davranışı DOĞRULAR; davranışı testler şekillendirmez.
//
// FALLBACK YOKTUR (bilinçli tasarım):
//   · canlı host başarısız → başka host DENENMEZ
//   · canonical API başarısız → legacy SOAP'a DÜŞÜLMEZ
//   · tenant credential yok → env/global/paylaşılan hesap KULLANILMAZ
// Yanlış cariye borçlandırmaktansa görünür şekilde hata verilir.
import {
  captureActualWire,
  type ActualWireCapture,
} from './suratActualWireCapture.ts'
import type {
  SuratGonderiModel,
  SuratOrtakBarkodRequest,
} from './suratCanonicalGonderiModel.ts'

/**
 * Vendor tarafından bu müşteri için CANLI olarak bildirilen Web API tabanı.
 * Sınıflandırma: VENDOR_CONFIRMED_LIVE.
 *
 * NOT: repodaki eski `api01=live / api02=test` eşlemesi legacy SOAP/REST
 * yollarına aittir ve canonical Web API için GEÇERLİ DEĞİLDİR
 * (INTERNAL_LEGACY_ASSUMPTION). Bu sabit onunla karıştırılmamalıdır.
 */
export const SURAT_CANONICAL_LIVE_API_BASE_URL =
  'https://api02.suratkargo.com.tr'

/** Canonical create yolu (OpenAPI sözleşmesinden). */
export const SURAT_CANONICAL_CREATE_PATH = '/api/OrtakBarkodOlustur'

/**
 * PAZARYERI gönderisi için ayrı yol.
 *
 * ═══ NEDEN ═══════════════════════════════════════════════════════════════
 *
 * api02'nin CANLI OpenAPI 3 sözleşmesi (`docs/contracts/` altında işlenmiş
 * hâli) `/api/PazaryeriGonderi` ile `/api/OrtakBarkodOlustur` için AYNI istek
 * modelini (`OrtakBarkodOlusturParam`) ve AYNI yanıt modelini (`ResultMesaj`)
 * tanımlar. Yani yol dışında hiçbir şey değişmez: gövde de, ayrıştırıcı da,
 * baskı hattı da aynen kalır.
 *
 * ÜRETİM KANITI: `Pazaryerimi=1` + `EntegrasyonFirmasi=Trendyol` taşıyan bir
 * gönderi GENEL uca gönderildiğinde taşıyıcı kendi sonuç kurucusunda
 * `System.InvalidCastException: String → KargoBarkod`
 * (`OrtakBarkodController:1836`) veriyor (CF-4104179900). `ResultMesaj.Barcode`
 * sözleşmede tipsiz dizidir ve sunucu tarafında `KargoBarkod` taşır — hata
 * oraya bir MESAJ konmaya çalışıldığında oluşur.
 *
 * SINIFLANDIRMA: SUPPORTED (PROVEN DEĞİL). Sözleşmede hiçbir ucun açıklaması
 * yoktur; ayrım ad ve şekle dayanır. Tek kontrollü canlı canary bunu
 * kesinleştirecek.
 */
export const SURAT_MARKETPLACE_CREATE_PATH = '/api/PazaryeriGonderi'

/**
 * Yol, GÖNDERİNİN KENDİSİNDEN türetilir — çağıranın ayrı bir bayrağından
 * DEĞİL. Böylece `Pazaryerimi=1` olan bir gönderinin genel uca gitmesi
 * YAPISAL OLARAK imkânsızdır; iki alan birbirinden ayrılamaz.
 */
export function resolveSuratCanonicalCreatePath(
  gonderi: Pick<SuratGonderiModel, 'Pazaryerimi'> | null | undefined,
): string {
  return Number(gonderi?.Pazaryerimi) === 1
    ? SURAT_MARKETPLACE_CREATE_PATH
    : SURAT_CANONICAL_CREATE_PATH
}

/** İzde/loglarda görünen operasyon adı — seçilen yolla TUTARLI. */
export function resolveSuratCanonicalOperationName(
  gonderi: Pick<SuratGonderiModel, 'Pazaryerimi'> | null | undefined,
): string {
  return resolveSuratCanonicalCreatePath(gonderi)
    .replace('/api/', '')
}

/**
 * SSRF/yanlış hedef koruması: canonical istemci YALNIZ vendor tarafından
 * doğrulanmış canlı host'a istek atabilir. Yeni host eklemek AÇIK bir kod
 * değişikliği gerektirir; yapılandırmadan rastgele URL kabul edilmez.
 */
export const SURAT_CANONICAL_ALLOWED_HOSTS = ['api02.suratkargo.com.tr'] as const

/** Taşıyıcı HTTP zaman aşımı (ms) — açıkça tanımlıdır. */
export const SURAT_CANONICAL_TIMEOUT_MS = 30_000

export type SuratCanonicalErrorCode =
  | 'SURAT_ACCOUNT_NOT_CONFIGURED'
  | 'SURAT_CUSTOMER_CODE_MISSING'
  | 'SURAT_SHIPPING_CREDENTIAL_MISSING'
  | 'SURAT_CANONICAL_HOST_NOT_ALLOWED'
  | 'SURAT_CANONICAL_CREATE_FAILED'
  | 'SURAT_CANONICAL_VENDOR_ERROR'
  | 'SURAT_COMMON_BARCODE_MISSING'
  | 'SURAT_CANONICAL_TIMEOUT'

export class SuratCanonicalError extends Error {
  readonly code: SuratCanonicalErrorCode
  /** Zaman aşımı gibi durumlarda gönderi OLUŞMUŞ OLABİLİR → kör retry YASAK. */
  readonly outcome: 'not_sent' | 'unknown' | 'rejected'
  constructor(
    code: SuratCanonicalErrorCode,
    message: string,
    outcome: 'not_sent' | 'unknown' | 'rejected' = 'not_sent',
  ) {
    super(message)
    this.name = 'SuratCanonicalError'
    this.code = code
    this.outcome = outcome
  }
}

// ═══ TENANT CREDENTIAL ÇÖZÜMÜ ═════════════════════════════════════════════

export interface SuratProductionCredentials {
  kullaniciAdi: string
  sifre: string
}

/** Loglanabilir parmak izi — düz metin credential ASLA dışarı verilmez. */
export function fingerprintAccount(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return '(yok)'
  return `****${text.slice(-4)}`
}

/**
 * TENANT ÜRETİM CREDENTIAL'I — TEK KAYNAK.
 *
 * Kaynak zinciri: kimliği doğrulanmış tenant → tenant Sürat entegrasyonu →
 * tenant Sürat taşıyıcı hesabı. BAŞKA HİÇBİR KAYNAK KABUL EDİLMEZ:
 * env değişkeni yok, global/paylaşılan hesap yok, başka tenant'ın hesabı yok.
 *
 * Eksikse fail-closed — ağ isteği YAPILMAZ.
 */
export function resolveTenantSuratProductionCredentials(
  account: {
    kullaniciAdi?: unknown
    sifre?: unknown
    isActive?: boolean
  } | null | undefined,
): SuratProductionCredentials {
  if (!account) {
    throw new SuratCanonicalError(
      'SURAT_ACCOUNT_NOT_CONFIGURED',
      'Tenant için Sürat taşıyıcı hesabı tanımlı değil.',
    )
  }
  if (account.isActive === false) {
    throw new SuratCanonicalError(
      'SURAT_ACCOUNT_NOT_CONFIGURED',
      'Tenant Sürat hesabı pasif.',
    )
  }
  const kullaniciAdi = String(account.kullaniciAdi ?? '').trim()
  if (!kullaniciAdi) {
    throw new SuratCanonicalError(
      'SURAT_CUSTOMER_CODE_MISSING',
      'Tenant Sürat müşteri/cari kodu tanımlı değil.',
    )
  }
  const sifre = String(account.sifre ?? '').trim()
  if (!sifre) {
    throw new SuratCanonicalError(
      'SURAT_SHIPPING_CREDENTIAL_MISSING',
      'Tenant Sürat gönderim şifresi tanımlı değil.',
    )
  }
  return { kullaniciAdi, sifre }
}

// ═══ YANIT AYRIŞTIRMA ═════════════════════════════════════════════════════

/** OpenAPI `ResultMesaj`. */
export interface SuratResultMesaj {
  isError?: boolean
  Message?: string | null
  KargoTakipNo?: string | null
  Barcode?: unknown[] | null
  BarcodeNo?: string[] | null
  Value?: unknown
}

export interface SuratCanonicalCreateResult {
  /** GERÇEKTEN çağrılan yol — izde kurgulanmaz, buradan taşınır. */
  createPath?: string
  trackingNo: string
  barcode: unknown[]
  barcodeNo: string[]
  vendorMessage: string
  rawVendorStatus: { isError: boolean }
}

/**
 * `ResultMesaj` → kanonik sonuç. SAF fonksiyon.
 *
 * Etiket ARTIFACT SEÇİMİ burada YAPILMAZ: `Barcode`/`BarcodeNo` içeriğinin
 * hangi öğesinin yazdırılabilir etiket olduğu vendor örnekleriyle
 * doğrulanmadan varsayılmaz (Ünite 3).
 */
export function parseSuratOrtakBarkodResponse(
  payload: SuratResultMesaj | null | undefined,
): SuratCanonicalCreateResult {
  const body = payload ?? {}
  const vendorMessage = String(body.Message ?? '').trim()
  if (body.isError === true) {
    throw new SuratCanonicalError(
      'SURAT_CANONICAL_VENDOR_ERROR',
      vendorMessage || 'Sürat isteği hata ile döndü.',
      'rejected',
    )
  }
  const trackingNo = String(body.KargoTakipNo ?? '').trim()
  const barcode = Array.isArray(body.Barcode) ? body.Barcode : []
  const barcodeNo = Array.isArray(body.BarcodeNo)
    ? body.BarcodeNo.map((value) => String(value ?? '').trim()).filter(Boolean)
    : []
  // Bu operasyonun ASIL amacı ortak barkod döndürmektir; yoksa başarı sayılmaz.
  if (barcode.length === 0 && barcodeNo.length === 0) {
    throw new SuratCanonicalError(
      'SURAT_COMMON_BARCODE_MISSING',
      'Sürat yanıtında kullanılabilir ortak barkod bulunamadı.',
      'unknown',
    )
  }
  return {
    trackingNo,
    barcode,
    barcodeNo,
    vendorMessage,
    rawVendorStatus: { isError: false },
  }
}

// ═══ CANLI İSTEK ══════════════════════════════════════════════════════════

type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

function assertAllowedHost(baseUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new SuratCanonicalError(
      'SURAT_CANONICAL_HOST_NOT_ALLOWED',
      'Geçersiz Sürat Web API adresi.',
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new SuratCanonicalError(
      'SURAT_CANONICAL_HOST_NOT_ALLOWED',
      'Sürat Web API yalnız HTTPS üzerinden çağrılır.',
    )
  }
  if (!SURAT_CANONICAL_ALLOWED_HOSTS.includes(parsed.hostname as never)) {
    throw new SuratCanonicalError(
      'SURAT_CANONICAL_HOST_NOT_ALLOWED',
      'Sürat Web API host izin listesinde değil.',
    )
  }
  return parsed
}

export interface CreateOrtakBarkodParams {
  credentials: SuratProductionCredentials
  gonderi: SuratGonderiModel
  /** Enjekte edilebilir taşıma (testte sahte, üretimde global fetch). */
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Yalnız izin listesindeki host'lar kabul edilir. */
  baseUrl?: string
  /**
   * GERÇEK TEL ANLIK GÖRÜNTÜSÜ — ağ çağrısından HEMEN ÖNCE, NİHAİ gövdeden.
   *
   * Bu geri çağrı, "telde ne gitti?" sorusunun kurgusuz yanıtıdır. Girdi,
   * `JSON.stringify` ile serileştirilecek OLAN nesnenin ta kendisidir.
   * Sır/PII yakalayıcının içinde elenir.
   */
  onWireReady?: (capture: ActualWireCapture) => void
}

/**
 * CANLI ortak barkod gönderi oluşturma.
 *
 * Kimlik doğrulama GÖVDEDEDİR (`KullaniciAdi`/`Sifre`) — OpenAPI sözleşmesi
 * hiçbir securityScheme tanımlamadığı için Basic/Bearer/API-Key
 * UYDURULMAZ.
 */
export async function createOrtakBarkodShipment(
  params: CreateOrtakBarkodParams,
): Promise<SuratCanonicalCreateResult> {
  const baseUrl = params.baseUrl ?? SURAT_CANONICAL_LIVE_API_BASE_URL
  assertAllowedHost(baseUrl)
  // Pazaryeri gönderisi pazaryeri ucuna gider; diğerleri genel uca.
  const endpoint = `${baseUrl}${resolveSuratCanonicalCreatePath(params.gonderi)}`
  const request: SuratOrtakBarkodRequest = {
    KullaniciAdi: params.credentials.kullaniciAdi,
    Sifre: params.credentials.sifre,
    Gonderi: params.gonderi,
  }
  // ═══ ACTUAL_WIRE — NİHAİ GÖVDEDEN, AĞDAN HEMEN ÖNCE ═══════════════════
  // `request` yukarıda kuruldu ve aşağıda AYNEN serileştirilecek. Anlık
  // görüntü ondan alınır; sipariş/gönderi/eski kayıt KURGULANMAZ.
  if (params.onWireReady) {
    try {
      params.onWireReady(
        captureActualWire(request as unknown as Record<string, unknown>),
      )
    } catch {
      // Gözlemlenebilirlik create sonucunu ASLA etkilemez.
    }
  }
  const doFetch = params.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const controller = new AbortController()
  const timeoutMs = params.timeoutMs ?? SURAT_CANONICAL_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError'
    // Zaman aşımında gönderi OLUŞMUŞ OLABİLİR → sonuç BİLİNMEZ, kör retry YOK.
    throw new SuratCanonicalError(
      aborted ? 'SURAT_CANONICAL_TIMEOUT' : 'SURAT_CANONICAL_CREATE_FAILED',
      aborted
        ? 'Sürat Web API zaman aşımına uğradı.'
        : 'Sürat Web API çağrısı başarısız.',
      'unknown',
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new SuratCanonicalError(
      'SURAT_CANONICAL_CREATE_FAILED',
      `Sürat Web API HTTP ${response.status}.`,
      'unknown',
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new SuratCanonicalError(
      'SURAT_CANONICAL_CREATE_FAILED',
      'Sürat Web API yanıtı çözümlenemedi.',
      'unknown',
    )
  }
  return {
    ...parseSuratOrtakBarkodResponse(payload as SuratResultMesaj),
    // İz GERÇEKTEN çağrılan yolu taşır; sabitten yeniden türetilmez.
    createPath: resolveSuratCanonicalCreatePath(params.gonderi),
  }
}

/** Sır içermeyen log bağlamı (parola/gövde/tam takip no ASLA yazılmaz). */
export function buildSuratCanonicalLogContext(params: {
  organizationId: string
  marketplace?: string
  /** Seçilen operasyon; verilmezse genel uç adı yazılır. */
  operation?: string
  credentials: SuratProductionCredentials
}): Record<string, string> {
  return {
    tenantId: params.organizationId,
    adapter: 'SURAT_WEB_API',
    operation: params.operation ?? 'OrtakBarkodOlustur',
    host: new URL(SURAT_CANONICAL_LIVE_API_BASE_URL).hostname,
    marketplace: String(params.marketplace ?? ''),
    carrierAccountFingerprint: fingerprintAccount(params.credentials.kullaniciAdi),
  }
}
