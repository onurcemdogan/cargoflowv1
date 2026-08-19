// SÜRAT CREATE DEBUG İZİ — ŞEMA v2. SAF, AĞSIZ, YAN ETKİSİZ.
//
// BU İZ OPERASYONEL VERİ DEĞİLDİR. Gönderi/operasyon/sipariş kayıtlarının
// yerine GEÇMEZ ve onları değiştirmez; yalnız TEK bir create denemesini
// açıklar.
//
// EN ÖNEMLİ AYRIM — BEKLENEN vs TELDE GİDEN:
//   `expectedSuratWhoPays` bir TEŞHİS değeridir.
//   `wireWhoPaysPresent` seçilen sözleşmenin GERÇEKTEN gönderdiğidir.
// İkisi ayrı tutulmazsa "beklediğimiz" ile "gönderdiğimiz" karışır ve
// hata ayıklama yanlış yöne gider.
//
// GİZLİLİK: kimlik/şifre DEĞERLERİ, alıcı adı/adres/telefon/e-posta ASLA
// taşınmaz. Kimlikler maskeli, uzun metinler yalnız varlık/uzunluk/hash.
import type {
  BillingPartyV2,
  CodContext,
  SuratCredentialContext,
} from './suratRoutingModel.ts'

export const SURAT_TRACE_SCHEMA_VERSION = 2 as const

/**
 * SAKLAMA SINIRI — İKİSİNDEN HANGİSİ ÖNCE DOLARSA.
 * Teşhis verisi sınırsız birikmemelidir; operasyonel veri DEĞİLDİR.
 */
export const TRACE_RETENTION_DAYS = 7
export const TRACE_RETENTION_MAX_PER_TENANT = 200

export type TraceFieldStatus = 'OK' | 'WARNING' | 'ERROR'

export interface SuratCreateTrace {
  schemaVersion: typeof SURAT_TRACE_SCHEMA_VERSION
  traceId: string
  createdAt: string

  identity: {
    organizationId: string
    marketplaceAccountId: string | null
    orderId: string
    packageIdMasked: string
  }
  billing: {
    rawWhoPaysPresent: boolean
    rawWhoPaysNormalized: string | null
    billingParty: BillingPartyV2
    billingEvidence: string
    expectedSuratWhoPays: string | null
  }
  payment: { odemeTipi: string; odemeTipiMeaning: string }
  cod: CodContext
  credentialRouting: {
    credentialRole: string
    credentialSource: string
    maskedCredential: string
    reason: string
    resolved: boolean
  }
  serviceRouting: {
    serviceMode: string
    serviceType: string
    operation: string
    baseHost: string
    path: string
  }
  request: {
    /** Alan ADI → dolu mu. DEĞER taşımaz. */
    requestFieldPresence: Record<string, boolean>
    /** Faturalama açısından anlamlı ve PII olmayan değerler. */
    requestSemanticSnapshot: Record<string, unknown>
    wireWhoPaysPresent: boolean
    wireWhoPaysValue: string | null
    wireWhoPaysReason: string
  }
  response: {
    httpStatus: number | null
    businessCode: string | null
    businessMessage: string | null
    trackingPresent: boolean
    barcodePresent: boolean
    zplPresent: boolean
    zplLength: number | null
    zplSha256: string | null
  }
  verification: { carrierRegistrationConfirmed: boolean }
  finalResult: {
    errorCategory: string | null
    finalClassification: string
  }
}

/** `CF-…` — kullanıcıya verilebilecek, sır içermeyen korelasyon kimliği. */
export function buildTraceId(seed: string): string {
  const token = String(seed ?? '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(-10)
  return `CF-${token || 'UNKNOWN'}`
}

const mask = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  return raw.length <= 4 ? '****' : `****${raw.slice(-4)}`
}

/**
 * TELDE GİDEN `WhoPays` — SÖZLEŞMEDEN TÜRETİLİR, UYDURULMAZ.
 *
 * Kanonik `GonderiModel` `WhoPays` alanını İÇERMEZ; bu yüzden beklenti 3
 * olsa bile telde alan GİTMEZ ve sebebi açıkça yazılır. Bu, "eksik" değil
 * sözleşmenin kendisidir.
 */
export function describeWireWhoPays(params: {
  contractFields: readonly string[]
  requestBody?: Record<string, unknown>
}): { wireWhoPaysPresent: boolean; wireWhoPaysValue: string | null; wireWhoPaysReason: string } {
  const supported = params.contractFields.includes('WhoPays')
  if (!supported) {
    return {
      wireWhoPaysPresent: false,
      wireWhoPaysValue: null,
      wireWhoPaysReason: 'CONTRACT_HAS_NO_WHO_PAYS_FIELD',
    }
  }
  const body = params.requestBody ?? {}
  const present = Object.prototype.hasOwnProperty.call(body, 'WhoPays')
  return {
    wireWhoPaysPresent: present,
    wireWhoPaysValue: present ? String(body.WhoPays ?? '') : null,
    wireWhoPaysReason: present ? 'SENT' : 'CONTRACT_SUPPORTS_BUT_NOT_SENT',
  }
}

/** İstek gövdesinden PII taşımayan alan varlığı haritası. */
export const TRACE_REQUEST_FIELDS = [
  'KullaniciAdi',
  'Sifre',
  'OdemeTipi',
  'Pazaryerimi',
  'EntegrasyonFirmasi',
  'OzelKargoTakipNo',
  'WhoPays',
  'KimOder',
  'KapidanOdemeTahsilatTipi',
  'KapidanOdemeTutari',
  'ReferansNo',
  'WebSiparisKodu',
  'SatisKodu',
] as const

/** Değeri güvenle gösterilebilen alanlar (PII/sır DEĞİL). */
export const TRACE_SAFE_VALUE_FIELDS = [
  'OdemeTipi',
  'Pazaryerimi',
  'EntegrasyonFirmasi',
  'KapidanOdemeTahsilatTipi',
] as const

export function buildRequestTrace(body: Record<string, unknown> = {}): {
  requestFieldPresence: Record<string, boolean>
  requestSemanticSnapshot: Record<string, unknown>
} {
  const requestFieldPresence: Record<string, boolean> = {}
  for (const field of TRACE_REQUEST_FIELDS) {
    requestFieldPresence[field] =
      Object.prototype.hasOwnProperty.call(body, field) &&
      String(body[field] ?? '').trim() !== ''
  }
  const requestSemanticSnapshot: Record<string, unknown> = {}
  for (const field of TRACE_SAFE_VALUE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      requestSemanticSnapshot[field] = body[field]
    }
  }
  // Pazaryeri kimliği MASKELİ; tam numara teşhiste gerekmez.
  if (Object.prototype.hasOwnProperty.call(body, 'OzelKargoTakipNo')) {
    requestSemanticSnapshot.OzelKargoTakipNoMasked = mask(body.OzelKargoTakipNo)
  }
  return { requestFieldPresence, requestSemanticSnapshot }
}

/**
 * KULLANICIYA GÖSTERİLECEK MESAJ — kısa, sırsız, korelasyonlu.
 *
 * "Barkod oluşturulamadı" tek başına teşhis edilemez; kod ve iz kimliği
 * verilir ki operatör doğru izi açabilsin.
 */
export function buildUserFacingError(params: {
  traceId: string
  businessCode?: string | null
}): string {
  const code = String(params.businessCode ?? '').trim()
  return code
    ? `Sürat barkod oluşturma başarısız. Kod: ${code}. Detay için Debug Trace: ${params.traceId}`
    : `Sürat barkod oluşturma başarısız. Detay için Debug Trace: ${params.traceId}`
}

/** Alanın operatöre nasıl gösterileceği (OK/WARNING/ERROR). */
export function traceFieldStatus(params: {
  billingParty: BillingPartyV2
  credential: SuratCredentialContext
  preflightValid: boolean
}): Record<string, TraceFieldStatus> {
  return {
    billing: params.billingParty === 'UNKNOWN' ? 'ERROR' : 'OK',
    credential: params.credential.resolved ? 'OK' : 'ERROR',
    marketplace: params.preflightValid ? 'OK' : 'ERROR',
    // Gerçek taraf hâlâ okunamıyor: başarı DEĞİL, uyarı.
    carrierResult: 'WARNING',
  }
}

/**
 * ESKİ ŞEMA AYIKLAMA — v1 izleri v2 ekranında GÖSTERİLMEZ.
 * Karışık şema, yanlış alan okumaya ve yanlış teşhise yol açar.
 */
export function selectCurrentSchemaTraces<T extends { schemaVersion?: unknown }>(
  traces: readonly T[],
): T[] {
  return traces.filter(
    (trace) => Number(trace.schemaVersion) === SURAT_TRACE_SCHEMA_VERSION,
  )
}

/** Saklama sınırı — gün VE adet; hangisi önce dolarsa. */
export function applyTraceRetention<T extends { createdAt?: unknown }>(
  traces: readonly T[],
  now: string,
): T[] {
  const cutoff = Date.parse(now) - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return traces
    .filter((trace) => {
      const stamp = Date.parse(String(trace.createdAt ?? ''))
      return Number.isFinite(stamp) ? stamp >= cutoff : false
    })
    .slice(-TRACE_RETENTION_MAX_PER_TENANT)
}

/* ═══ FAZ C — DENEME YAŞAM DÖNGÜSÜ VE DEĞİŞMEZ ANLIK GÖRÜNTÜ ══════════ */

// Tek deneme = tek correlationId. Aşamalar bu kimlik altında SIRALANIR;
// böylece "hangi istek hangi yanıtla eşleşti" sorusu birleştirme (join)
// tahminine değil, taşınan kimliğe dayanır.
export const TRACE_LIFECYCLE_STAGES = [
  'PRE_FLIGHT',
  'ROUTING',
  'REQUEST_READY',
  // NİHAİ gövdeden alınan GERÇEK tel anlık görüntüsü. `REQUEST_READY` karar
  // anındaki niyettir; bu ise SERİLEŞTİRİLECEK olanın kendisidir.
  'ACTUAL_WIRE_READY',
  'CARRIER_CALL_STARTED',
  'CARRIER_CALL',
  'CARRIER_RESPONSE',
  'VERIFICATION',
  'FINAL',
] as const

/**
 * ALTERNATİF (DIŞLAYICI) AŞAMALAR — mutlu yol dizisine AİT DEĞİLDİR.
 *
 * `WIRE_BLOCKED` ağa ÇIKILMADIĞINDA yazılır ve `CARRIER_CALL*` ile aynı
 * denemede BULUNAMAZ. Mutlu yol listesine konulsaydı "sağlıklı create tüm
 * aşamaları üretir" değişmezi ANLAMSIZLAŞIRDI: hiçbir başarılı çağrı
 * bloklanmış olamaz.
 */
export const TRACE_ALTERNATE_STAGES = ['WIRE_BLOCKED'] as const

/** Kabul edilen TÜM aşama adları (doğrulama için). */
export const TRACE_ALL_STAGES = [
  ...TRACE_LIFECYCLE_STAGES,
  ...TRACE_ALTERNATE_STAGES,
] as const

export const TRACE_SECTIONS = [
  'IDENTITY',
  'BILLING',
  'PAYMENT',
  'COD',
  'CREDENTIAL_ROUTING',
  'SERVICE_ROUTING',
  'REQUEST',
  'RESPONSE',
  'VERIFICATION',
  'FINAL_RESULT',
] as const

const TRACE_SECRET_HINTS = [
  'password', 'sifre', 'secret', 'token', 'apikey', 'apisecret',
  'authorization', 'webpassword',
]

// `credentialRole` / `credentialSource` gibi alanlar SIR DEĞİLDİR; teşhis
// için gereken yönlendirme kararıdır. Yalnız ham kimlik değerleri maskelenir.
//
// ═══ ÖLÇÜLEN KUSUR ═══════════════════════════════════════════════════════
// `sifrePresent` bir BOOLEAN'dır ve parolayı TAŞIMAZ; ama adı `sifre`
// içerdiği için `«REDACTED»` yazılıyordu. Sonuç: gerçek tel anlık
// görüntüsünde parolanın VAR olup olmadığı okunamıyordu — yani gizlilik
// kazancı SIFIR, teşhis kaybı GERÇEK.
//
// Aşağıdaki son ekler YAPISAL OLARAK sır taşıyamaz:
//   *Present     → boolean (yalnız varlık)
//   *Fingerprint → tek yönlü/maskeli kimlik
//   *Length      → sayı
//   *Type        → tip adı
const TRACE_SAFE_SUFFIXES = [
  'role', 'source', 'policy', 'reason', 'resolved',
  'present', 'fingerprint', 'length', 'type',
]

/**
 * Sırları ayıklar. `maskedAccount`/`maskedCari` gibi zaten maskeli alanlar
 * korunur — bunlar sır değil, teşhis için gereken kimliktir.
 */
export function redactTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTraceValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      const lowered = key.toLowerCase()
      const isSecret = TRACE_SECRET_HINTS.some((hint) => lowered.includes(hint))
      const isSafe = lowered.includes('masked')
        || TRACE_SAFE_SUFFIXES.some((suffix) => lowered.endsWith(suffix))
      out[key] = isSecret && !isSafe
        ? '«REDACTED»'
        : redactTraceValue(inner)
    }
    return out
  }
  return value
}

/** Derin dondurma — anlık görüntü sonradan DEĞİŞTİRİLEMEZ. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

export interface SuratTraceAttempt {
  traceId: string
  schemaVersion: number
  createdAt: string
  stages: ReadonlyArray<{
    stage: (typeof TRACE_ALL_STAGES)[number]
    at: string
    section: (typeof TRACE_SECTIONS)[number] | null
    data: unknown
  }>
}

/**
 * Deneme açar. Dönen nesne DONDURULMUŞTUR: sonradan config değişse bile
 * geçmiş deneme kendini yeniden yorumlamaz — karar ANINDA saklanır.
 */
export function createTraceAttempt(params: {
  traceId: string
  createdAt: string
}): SuratTraceAttempt {
  return deepFreeze({
    traceId: params.traceId,
    schemaVersion: SURAT_TRACE_SCHEMA_VERSION,
    createdAt: params.createdAt,
    stages: [],
  })
}

/**
 * Aşama ekler ve YENİ bir değişmez deneme döndürür; girdi denemesi
 * DEĞİŞMEZ. Böylece iki deneme aynı nesneyi paylaşıp birbirine karışamaz.
 */
export function appendTraceStage(
  attempt: SuratTraceAttempt,
  entry: {
    stage: (typeof TRACE_LIFECYCLE_STAGES)[number]
    at: string
    section?: (typeof TRACE_SECTIONS)[number] | null
    data?: unknown
  },
): SuratTraceAttempt {
  return deepFreeze({
    ...attempt,
    stages: [
      ...attempt.stages,
      {
        stage: entry.stage,
        at: entry.at,
        section: entry.section ?? null,
        // Sırlar denemeye HİÇ girmez — sonradan temizlemeye güvenilmez.
        data: redactTraceValue(entry.data ?? null),
      },
    ],
  })
}

/** Yaşam döngüsü tamamlandı mı — PRE_FLIGHT ile başlayıp FINAL ile biter. */
export function isTraceLifecycleComplete(attempt: SuratTraceAttempt): boolean {
  const seen = attempt.stages.map((entry) => entry.stage)
  return seen[0] === 'PRE_FLIGHT' && seen[seen.length - 1] === 'FINAL'
}
