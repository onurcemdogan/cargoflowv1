// ARAS — NORMALİZE SAĞLAYICI HATALARI (PHASE2-F).
//
// Operatöre/ön yüze ham SOAP hatası, `ResultMessage` metni ya da uç nokta
// ASLA gitmez; yalnız kararlı sınıf + sade Türkçe metin. Ham kod yalnız
// sunucu tarafı işlem kanıtında (shipment_operations) kalır.
//
// KİMLİK HATASI SINIFI YOKTUR: Aras `ResultCode` değerlerinin resmî anlam
// tablosu elde değil. "Şifre yanlış" ile "veri reddedildi"yi ayırmak TAHMİN
// olurdu; bu yüzden ret `REJECTED` olarak kalır ve hesap "doğrulandı"
// sayılmaz.

export const ARAS_PROVIDER_ERROR_CLASSES = [
  'PROVIDER_UNAVAILABLE',
  'MALFORMED_RESPONSE',
  'CONFIGURATION',
  'VALIDATION',
  'CONTRACT_UNVERIFIED',
  'PREFLIGHT_BLOCKED',
  'IN_FLIGHT',
  'OUTCOME_UNKNOWN',
  'REJECTED',
  'LIVE_WRITE_BLOCKED',
  'UNKNOWN',
] as const
export type ArasProviderErrorClass = (typeof ARAS_PROVIDER_ERROR_CLASSES)[number]

export interface ArasProviderError {
  errorClass: ArasProviderErrorClass
  message: string
}

const BY_CODE: Record<string, ArasProviderErrorClass> = {
  ARAS_TRANSPORT_TIMEOUT: 'PROVIDER_UNAVAILABLE',
  ARAS_TRANSPORT_HTTP_ERROR: 'PROVIDER_UNAVAILABLE',
  ARAS_TRANSPORT_UNKNOWN: 'PROVIDER_UNAVAILABLE',
  ARAS_TRANSPORT_NOT_SENT: 'PROVIDER_UNAVAILABLE',
  ARAS_MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  ARAS_SET_ORDER_RESULT_MISSING: 'MALFORMED_RESPONSE',
  ARAS_ENDPOINT_UNRESOLVED: 'CONFIGURATION',
  ARAS_PRODUCTION_ENDPOINT_UNVERIFIED: 'CONFIGURATION',
  ARAS_CREDENTIALS_INCOMPLETE: 'CONFIGURATION',
  ARAS_UNKNOWN_FIELD: 'VALIDATION',
  ARAS_INTEGRATION_CODE_REQUIRED: 'VALIDATION',
  ARAS_COD_AMOUNT_INVALID: 'VALIDATION',
  ARAS_VERIFICATION_ENVELOPE_INVALID: 'VALIDATION',
  ARAS_LABEL_ENVELOPE_INVALID: 'VALIDATION',
  ARAS_LABEL_PRECONDITION_NOT_MET: 'VALIDATION',
  ARAS_CREATE_BUILD_FAILED: 'VALIDATION',
  ARAS_COD_VALUE_TABLE_UNVERIFIED: 'CONTRACT_UNVERIFIED',
  ARAS_PAYER_MAPPING_UNVERIFIED: 'CONTRACT_UNVERIFIED',
  ARAS_PAYER_FIELD_NOT_ALLOWED: 'CONTRACT_UNVERIFIED',
  ARAS_PREFLIGHT_BLOCKED: 'PREFLIGHT_BLOCKED',
  ARAS_CREATE_IN_FLIGHT: 'IN_FLIGHT',
  ARAS_CREATE_OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  ARAS_REPLAY_ARTIFACT_MISSING: 'OUTCOME_UNKNOWN',
  ARAS_SET_ORDER_REJECTED: 'REJECTED',
  ARAS_LIVE_WRITE_BLOCKED: 'LIVE_WRITE_BLOCKED',
}

const MESSAGES: Record<ArasProviderErrorClass, string> = {
  PROVIDER_UNAVAILABLE: 'Aras servisine ulaşılamadı. Daha sonra tekrar deneyin.',
  MALFORMED_RESPONSE: 'Aras servisi anlaşılamayan bir yanıt döndürdü; gönderi kaydı varsayılmadı.',
  CONFIGURATION: 'Aras bağlantı ayarları eksik (kullanıcı adı/şifre veya uç nokta).',
  VALIDATION: 'Gönderi bilgileri Aras için eksik veya geçersiz.',
  CONTRACT_UNVERIFIED: 'Ödeyen/tahsilat kodlarının Aras karşılığı doğrulanmadı; gönderi oluşturulmadı.',
  PREFLIGHT_BLOCKED: 'Kontrol gerekli — gönderi ön kontrolü tamamlanmadı; gönderi oluşturulmadı.',
  IN_FLIGHT: 'Bu sipariş için gönderi isteği zaten işleniyor.',
  OUTCOME_UNKNOWN: 'Aras yanıtı kesinleşmedi; mükerrer gönderi olmaması için yeniden gönderilmedi.',
  REJECTED: 'Aras gönderi isteğini kabul etmedi.',
  LIVE_WRITE_BLOCKED: 'Aras Kargo iç testte; canlı gönderi kapalı.',
  UNKNOWN: 'Aras işlemi tamamlanamadı.',
}

export function normalizeArasError(code: string | null | undefined): ArasProviderError | null {
  const key = String(code ?? '').trim()
  if (!key) return null
  const errorClass = BY_CODE[key] ?? 'UNKNOWN'
  return { errorClass, message: MESSAGES[errorClass] }
}
