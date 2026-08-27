// SÜRAT ETİKET TAŞIMASI — TEK OTORİTE (SAF KARAR, YAN ETKİ YOK).
//
// ═══ NEDEN AYRI MODÜL ════════════════════════════════════════════════════
//
// Denetçi (`surat:billing:inspect`) kayıtlı servis modunu okuyup
// `SURAT_CANONICAL_API` + `api02/api/OrtakBarkodOlustur` yazıyordu; GERÇEK
// üretim create'i ise SOAP `OrtakBarkodOlustur` çağırıyordu (CF-4108176742).
// Denetçi doğru faturayı, YANLIŞ taşımayı raporluyordu.
//
// Kök neden: taşıma kararı `index.mjs` içinde SATIR İÇİNDEYDİ ve denetçinin
// okuyabileceği bir yer yoktu. Karar artık BURADA; hem create yolu hem
// denetçi AYNI fonksiyonu çağırır. Paralel bir kopya YOKTUR — kopya olsaydı
// yine ayrışır ve denetim yine yalan söylerdi.
//
// AĞ ÇAĞRISI YOK · DB YOK · YAN ETKİ YOK.

/** Kanıtlanmış SOAP etiket ucu (CF-4108176742 · 016 · gerçek ZPL). */
export const SURAT_SOAP_LABEL_HOST = 'webservices.suratkargo.com.tr/services.asmx'
export const SURAT_SOAP_LABEL_OPERATION = 'OrtakBarkodOlustur'
export const SURAT_SOAP_LABEL_SERVICE_TYPE = 'OrtakBarkodOlusturSoap'
export const SURAT_SOAP_LABEL_SERVICE_MODE = 'ORTAK_BARKOD_SOAP'

/** Kanonik Web API ucu — pazaryeri OLMAYAN akışlar için. */
export const SURAT_CANONICAL_LABEL_HOST = 'api02.suratkargo.com.tr'
export const SURAT_CANONICAL_LABEL_PATH = '/api/OrtakBarkodOlustur'

/**
 * Kanıtlanmış SOAP taşımasının seçildiği pazaryeri.
 *
 * YALNIZ Trendyol: üretim kanıtı (2026-07-16 gerçek ZPL, 2026-08-26
 * CF-4108176742) yalnız bu akış içindir. Diğer pazaryerleri kanonik REST'te
 * KALIR — onlar için bu değişikliği destekleyen kanıt YOKTUR.
 */
export const SURAT_SOAP_LABEL_MARKETPLACES = ['trendyol'] as const

export type SuratLabelTransport = 'SOAP' | 'CANONICAL_REST'

export interface SuratLabelTransportDecision {
  /** Kiracının SAKLADIĞI mod — değiştirilmez, yalnız raporlanır. */
  configuredServiceMode: string
  transport: SuratLabelTransport
  /** Çalışma zamanında GERÇEKTEN kullanılan mod. */
  effectiveServiceMode: string
  effectiveHost: string
  effectiveOperation: string
  effectiveServiceType: string
  /** Kayıtlı mod ile fiilî taşıma farklı mı? (görünürlük — sessizlik YOK) */
  differsFromConfigured: boolean
  reason: string
}

const normalize = (value: unknown): string =>
  String(value ?? '').trim().toLocaleLowerCase('tr-TR')

/**
 * Etiket taşıması kararı — SAF.
 *
 * Bu bir GERİ DÜŞÜŞ DEĞİLDİR: karar pazaryeri kimliğine göre HERHANGİ bir
 * taşıyıcı çağrısından ÖNCE verilir ve önceki bir denemenin sonucunu
 * OKUMAZ (girdi olarak da almaz).
 */
export function resolveSuratLabelTransport(params: {
  configuredServiceMode?: unknown
  marketplace?: unknown
}): SuratLabelTransportDecision {
  const configuredServiceMode = String(params.configuredServiceMode ?? '').trim()
  const marketplace = normalize(params.marketplace)
  const soapEligibleMarketplace =
    (SURAT_SOAP_LABEL_MARKETPLACES as readonly string[]).includes(marketplace)
  const canonicalConfigured = configuredServiceMode === 'SURAT_CANONICAL_API'

  if (canonicalConfigured && soapEligibleMarketplace) {
    return {
      configuredServiceMode,
      transport: 'SOAP',
      effectiveServiceMode: SURAT_SOAP_LABEL_SERVICE_MODE,
      effectiveHost: SURAT_SOAP_LABEL_HOST,
      effectiveOperation: SURAT_SOAP_LABEL_OPERATION,
      effectiveServiceType: SURAT_SOAP_LABEL_SERVICE_TYPE,
      differsFromConfigured: true,
      reason: 'PROVEN_SOAP_LABEL_FOR_TRENDYOL_MARKETPLACE',
    }
  }

  if (canonicalConfigured) {
    return {
      configuredServiceMode,
      transport: 'CANONICAL_REST',
      effectiveServiceMode: configuredServiceMode,
      effectiveHost: SURAT_CANONICAL_LABEL_HOST,
      effectiveOperation: SURAT_SOAP_LABEL_OPERATION,
      effectiveServiceType: 'SuratCanonicalWebApi',
      differsFromConfigured: false,
      reason: marketplace
        ? `MARKETPLACE_NOT_SOAP_ELIGIBLE:${marketplace}`
        : 'MARKETPLACE_ABSENT',
    }
  }

  // Kiracı BAŞKA bir modu açıkça seçtiyse o seçim onundur; burada EZİLMEZ.
  return {
    configuredServiceMode,
    transport: 'SOAP',
    effectiveServiceMode: configuredServiceMode,
    effectiveHost: SURAT_SOAP_LABEL_HOST,
    effectiveOperation: SURAT_SOAP_LABEL_OPERATION,
    effectiveServiceType: SURAT_SOAP_LABEL_SERVICE_TYPE,
    differsFromConfigured: false,
    reason: `CONFIGURED_MODE_KEPT:${configuredServiceMode || 'UNSET'}`,
  }
}

/** `index.mjs` create dalının kullandığı kısayol — AYNI karar. */
export function usesProvenSoapLabelTransport(params: {
  configuredServiceMode?: unknown
  marketplace?: unknown
}): boolean {
  const decision = resolveSuratLabelTransport(params)
  return decision.transport === 'SOAP'
    && decision.reason === 'PROVEN_SOAP_LABEL_FOR_TRENDYOL_MARKETPLACE'
}
