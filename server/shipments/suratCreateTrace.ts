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
