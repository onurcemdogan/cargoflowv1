// SÜRAT KANONİK SONUÇ CAST HATASI — SINIFLANDIRMA ve KURTARMA (saf karar).
//
// Ağ/DB YOK. Bu katman "ne yapılmalı" sorusunu yanıtlar; çağıran uygular.
//
// ═══ GÖZLENEN ÜRETİM HATASI ══════════════════════════════════════════════
//
//   System.InvalidCastException: Unable to cast object of type 'System.String'
//   to type 'KargoBarkod'
//   at SK_WebService.Api.Controllers.OrtakBarkodController
//      .OrtakBarkodOlusturSonuc(...) line 1836
//
// KRİTİK OKUMA: yığın izi SONUÇ KURUCUSUNU gösterir
// (`OrtakBarkodOlusturSonuc`), isteğin doğrulanmasını DEĞİL. Yani hata
// gönderinin KAYDEDİLMESİNDEN SONRA da oluşmuş OLABİLİR. "Exception aldık,
// demek ki gönderi oluşmadı" çıkarımı KANITSIZDIR ve tehlikelidir: ikinci bir
// create, ikinci bir fiziksel gönderi demektir.
//
// Bu yüzden sınıflandırma SALT OKUNUR doğrulamaya dayanır.

export const SURAT_CAST_CLASSIFICATIONS = [
  'RECOVERED_AFTER_CANONICAL_RESULT_ERROR',
  'SAVED_BARCODE_FAILED',
  'CANONICAL_RESULT_CAST_FAILED_NO_CONFIRMED_CREATE',
  'INSUFFICIENT_EVIDENCE',
] as const

export type SuratCastClassification = (typeof SURAT_CAST_CLASSIFICATIONS)[number]

/** Taşıyıcı istisnasının kanonik sonuç kurucusunda olduğunun imzası. */
export const CANONICAL_RESULT_CAST_SIGNATURE = {
  exceptionType: 'System.InvalidCastException',
  fromType: 'System.String',
  toType: 'KargoBarkod',
  controllerMethod: 'OrtakBarkodOlusturSonuc',
} as const

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/**
 * Yanıt gövdesi/hata metni bu BELİRLİ cast hatası mı?
 *
 * Genel bir "exception" eşleşmesi YETMEZ: fallback uygunluğu bu imzaya
 * bağlıdır ve geniş eşleşme, alakasız bir hatayı fallback'e sokardı.
 */
export function isCanonicalResultCastError(raw: unknown): boolean {
  const text = str(raw)
  if (!text) return false
  return (
    text.includes(CANONICAL_RESULT_CAST_SIGNATURE.exceptionType) &&
    text.includes(CANONICAL_RESULT_CAST_SIGNATURE.toType) &&
    text.includes(CANONICAL_RESULT_CAST_SIGNATURE.controllerMethod)
  )
}

export interface CastVerificationEvidence {
  /** Salt okunur doğrulama TAMAMLANDI mı? Yarım kalan kanıt DEĞİLDİR. */
  lookupCompleted: boolean
  /** Taşıyıcıda gönderi/sipariş bulundu mu? Bilinmiyorsa null. */
  shipmentFound: boolean | null
  trackingNumber?: unknown
  barcode?: unknown
  zpl?: unknown
}

export interface CastClassificationResult {
  classification: SuratCastClassification
  /** İkinci bir fiziksel create YAPILABİLİR mi? DAİMA false değilse gerekçeli. */
  mayCreateAgain: boolean
  trackingRecovered: boolean
  barcodeRecovered: boolean
  zplRecovered: boolean
  /** Kullanıcıya gösterilecek DÜRÜST ifade. */
  userMessage: string
  reason: string
}

const present = (value: unknown): boolean => str(value).length > 0

/**
 * Cast hatası sonrası SALT OKUNUR kanıtı sınıflandırır.
 *
 * ÜÇ SONUÇ + bir "kanıt yetersiz". Hiçbirinde OTOMATİK ikinci create YOKTUR:
 * `mayCreateAgain` yalnız gönderinin BULUNMADIĞI kanıtlandığında true olur ve
 * o durumda bile çağıran açık yetkilendirme ister.
 */
export function classifyCanonicalCastOutcome(
  evidence: CastVerificationEvidence,
): CastClassificationResult {
  const base = {
    trackingRecovered: present(evidence?.trackingNumber),
    barcodeRecovered: present(evidence?.barcode),
    zplRecovered: present(evidence?.zpl),
  }

  if (!evidence?.lookupCompleted) {
    return {
      ...base,
      classification: 'INSUFFICIENT_EVIDENCE',
      mayCreateAgain: false,
      userMessage:
        'Sürat sonucu doğrulanamadı. Gönderinin oluşup oluşmadığı BİLİNMİYOR; '
        + 'yeni gönderi oluşturulmadı.',
      reason: 'Salt okunur doğrulama tamamlanmadı.',
    }
  }

  if (evidence.shipmentFound === true) {
    // Gönderi VAR. İkinci create HER HÂLÜKÂRDA yasaktır.
    const hasLabel = base.barcodeRecovered || base.zplRecovered
    if (hasLabel) {
      return {
        ...base,
        classification: 'RECOVERED_AFTER_CANONICAL_RESULT_ERROR',
        mayCreateAgain: false,
        userMessage:
          'Sürat gönderisi oluşmuş ve etiket bilgileri kurtarıldı. '
          + 'Yeni gönderi oluşturulmadı.',
        reason:
          'Sonuç kurucusu hata verdi ama gönderi kayıtlı ve etiket erişilebilir.',
      }
    }
    return {
      ...base,
      classification: 'SAVED_BARCODE_FAILED',
      mayCreateAgain: false,
      // DÜRÜST İFADE: "etiket oluşturuldu" ya da "barkod bekliyor" DEMEZ.
      userMessage: 'Sürat gönderiyi kaydetti ancak barkod üretmedi.',
      reason: 'Gönderi kayıtlı; barkod/etiket kanıtı YOK.',
    }
  }

  if (evidence.shipmentFound === false) {
    return {
      ...base,
      classification: 'CANONICAL_RESULT_CAST_FAILED_NO_CONFIRMED_CREATE',
      // Gönderi bulunamadı: ikinci deneme DEĞERLENDİRİLEBİLİR ama otomatik
      // DEĞİL — yetkilendirme kapısı ayrıdır.
      mayCreateAgain: true,
      userMessage:
        'Sürat tarafında doğrulanmış bir gönderi bulunamadı. '
        + 'Kontrollü tekrar için onay gerekir.',
      reason: 'Sınırlı salt okunur doğrulama gönderi bulamadı.',
    }
  }

  return {
    ...base,
    classification: 'INSUFFICIENT_EVIDENCE',
    mayCreateAgain: false,
    userMessage:
      'Sürat sonucu kesinleşmedi; yeni gönderi oluşturulmadı.',
    reason: 'Doğrulama gönderi varlığını bildirmedi.',
  }
}

// ═══ FALLBACK UYGUNLUK — DRY-RUN DENETÇİSİ ═══════════════════════════════
//
// VARSAYILAN KAPALI. Kanonik çağrı başarısız oldu diye HEMEN legacy yola
// geçmek YASAKTIR: kanonik yol istisnadan ÖNCE gönderiyi kaydetmiş olabilir
// ve bu, ikinci fiziksel gönderi demektir.

export interface FallbackEligibilityInput {
  canonicalCastError?: boolean
  verificationCompleted?: boolean
  shipmentConfirmed?: boolean | null
  barcodeConfirmed?: boolean | null
  requestFingerprintMatches?: boolean
  financialFingerprintMatches?: boolean
  credentialFingerprintMatches?: boolean
  carrierCreateCallCount?: number
  explicitAuthorization?: boolean
}

export interface FallbackEligibilityResult {
  eligible: boolean
  /** Karşılanmayan koşullar — hepsi listelenir, ilkinde durulmaz. */
  failedConditions: string[]
  /** Bu denetçi ASLA çağrı yapmaz. */
  dryRun: true
}

/** Otomatik fallback KAPALI — sabit, yapılandırma ile açılmaz. */
export const LEGACY_FALLBACK_DEFAULT_ENABLED = false

/**
 * Fallback uygunluğunu DEĞERLENDİRİR — ÇAĞRI YAPMAZ.
 *
 * Dokuz koşulun HEPSİ sağlanmadıkça uygun değildir. Özellikle
 * `carrierCreateCallCount === 1`: birden fazla fiziksel deneme varsa
 * fallback, üçüncü bir gönderi riskidir.
 */
export function inspectLegacyFallbackEligibility(
  input: FallbackEligibilityInput,
): FallbackEligibilityResult {
  const failed: string[] = []
  if (input.canonicalCastError !== true) failed.push('CANONICAL_CAST_ERROR_NOT_PROVEN')
  if (input.verificationCompleted !== true) failed.push('VERIFICATION_NOT_COMPLETED')
  if (input.shipmentConfirmed !== false) failed.push('SHIPMENT_NOT_PROVEN_ABSENT')
  if (input.barcodeConfirmed !== false) failed.push('BARCODE_NOT_PROVEN_ABSENT')
  if (input.requestFingerprintMatches !== true) failed.push('REQUEST_FINGERPRINT_MISMATCH')
  if (input.financialFingerprintMatches !== true) failed.push('FINANCIAL_FINGERPRINT_MISMATCH')
  if (input.credentialFingerprintMatches !== true) failed.push('CREDENTIAL_FINGERPRINT_MISMATCH')
  if (Number(input.carrierCreateCallCount) !== 1) failed.push('CARRIER_CREATE_COUNT_NOT_ONE')
  if (input.explicitAuthorization !== true) failed.push('EXPLICIT_AUTHORIZATION_MISSING')
  return { eligible: failed.length === 0, failedConditions: failed, dryRun: true }
}
