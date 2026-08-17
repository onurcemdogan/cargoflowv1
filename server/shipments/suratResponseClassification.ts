// FAZ B — TAŞIYICI YANIT SINIFLANDIRMASI.
//
// TEMEL KURAL: HTTP 200 "gönderi oluştu" DEMEK DEĞİLDİR. Sürat, taşıma
// katmanında başarılı yanıt döndürüp iş katmanında başarısızlık bildirebilir.
// Bu yüzden taşıma başarısı (`httpSuccess`) ile iş sonucu (`businessCode`)
// ayrı tutulur ve nihai sınıf İKİSİNDEN + üretilen artefaktlardan çıkarılır.
//
// Aynı iş kodu farklı artefakt bileşimiyle FARKLI sonuç demektir:
//   016 + barkod + takip no  → kayıt doğrulandı
//   016 + barkod, takip yok  → doğrulama eksik (aynı sınıf DEĞİL)

/** Doğrulamanın hangi aşamada kaldığı. */
export const VERIFICATION_STAGES = [
  'NOT_STARTED',
  'CARRIER_RESPONDED',
  'ARTIFACTS_PARTIAL',
  'ARTIFACTS_COMPLETE',
] as const

/** Nihai sınıflar. Terminal olan/olmayan ayrımı `isTerminal` ile taşınır. */
export const FINAL_CLASSIFICATIONS = [
  // Taşıyıcı kaydı doğrulandı: iş kodu başarı + barkod + takip numarası.
  'CREATED_CONFIRMED',
  // İş kodu başarı ama artefakt eksik — kayıt oluşmuş olabilir, DOĞRULANMADI.
  'CREATED_VERIFICATION_INCOMPLETE',
  // 039: sipariş kaydedildi, barkod üretilemedi. TAM BAŞARI DEĞİLDİR.
  'SAVED_BARCODE_FAILED',
  // Taşıyıcı "tekrar dene" diyor (038 gibi). Körlemesine değil, denetimli.
  'RETRYABLE_CARRIER_BUSY',
  // İş kuralı reddi — tekrar denemek aynı sonucu verir.
  'REJECTED_BUSINESS_RULE',
  // Taşıma katmanı hatası; iş sonucu BİLİNMİYOR.
  'TRANSPORT_FAILED',
  'UNKNOWN',
] as const

export interface SuratResponseClassification {
  httpSuccess: boolean
  businessCode: string | null
  businessMessage: string | null
  trackingPresent: boolean
  barcodePresent: boolean
  zplPresent: boolean
  carrierRegistrationConfirmed: boolean
  verificationStage: (typeof VERIFICATION_STAGES)[number]
  finalClassification: (typeof FINAL_CLASSIFICATIONS)[number]
  /** Terminal ise otomatik yeniden deneme YAPILMAMALIDIR. */
  isTerminal: boolean
  /** Yalnız bu doğruysa denetimli yeniden deneme düşünülebilir. */
  retryAllowed: boolean
}

const nonEmpty = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : value != null

const text = (value: unknown): string | null => {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Tek sınıflandırma noktası.
 *
 * `codeCategory`, mevcut Sürat kod tablosundan gelir (BARCODE_SUCCESS /
 * PARTIAL / ERROR / RETRY / TRENDYOL_PROXY). Kod tablosu burada YENİDEN
 * YAZILMAZ — tek kaynak korunur, bu katman yalnız yorumlar.
 */
export function classifySuratCreateResponse(input: {
  httpSuccess?: boolean
  businessCode?: unknown
  businessMessage?: unknown
  codeCategory?: unknown
  trackingNumber?: unknown
  barcode?: unknown
  zpl?: unknown
}): SuratResponseClassification {
  const httpSuccess = input.httpSuccess === true
  const businessCode = text(input.businessCode)
  const businessMessage = text(input.businessMessage)
  const category = text(input.codeCategory)

  const trackingPresent = nonEmpty(input.trackingNumber)
  const barcodePresent = nonEmpty(input.barcode)
  const zplPresent = nonEmpty(input.zpl)

  const base = {
    httpSuccess, businessCode, businessMessage,
    trackingPresent, barcodePresent, zplPresent,
  }

  // Taşıma katmanı düştüyse iş sonucu hakkında HİÇBİR ŞEY bilmiyoruz.
  if (!httpSuccess) {
    return { ...base, carrierRegistrationConfirmed: false,
      verificationStage: 'NOT_STARTED',
      finalClassification: 'TRANSPORT_FAILED',
      // Sonuç bilinmediği için terminal DEĞİL; ama kör tekrar da yok.
      isTerminal: false, retryAllowed: false }
  }

  // 200 geldi ama iş kodu yoksa başarı VARSAYILMAZ.
  if (!businessCode) {
    return { ...base, carrierRegistrationConfirmed: false,
      verificationStage: 'CARRIER_RESPONDED',
      finalClassification: 'UNKNOWN', isTerminal: false, retryAllowed: false }
  }

  if (category === 'RETRY') {
    return { ...base, carrierRegistrationConfirmed: false,
      verificationStage: 'CARRIER_RESPONDED',
      finalClassification: 'RETRYABLE_CARRIER_BUSY',
      isTerminal: false, retryAllowed: true }
  }

  // PARTIAL: sipariş taşıyıcıda kaydedildi ama barkod üretilemedi.
  // Kayıt OLUŞTUĞU için kör tekrar mükerrer gönderi riski taşır.
  if (category === 'PARTIAL') {
    return { ...base,
      // Kayıt taşıyıcıda OLUŞTU; eksik olan yalnız barkod artefaktı.
      carrierRegistrationConfirmed: true,
      verificationStage: 'ARTIFACTS_PARTIAL',
      finalClassification: 'SAVED_BARCODE_FAILED',
      isTerminal: false, retryAllowed: false }
  }

  if (category === 'BARCODE_SUCCESS') {
    // Artefaktların TAMAMI yoksa "onaylandı" DEMEYİZ.
    const complete = trackingPresent && barcodePresent
    return { ...base, carrierRegistrationConfirmed: complete,
      verificationStage: complete ? 'ARTIFACTS_COMPLETE' : 'ARTIFACTS_PARTIAL',
      finalClassification: complete
        ? 'CREATED_CONFIRMED' : 'CREATED_VERIFICATION_INCOMPLETE',
      isTerminal: complete, retryAllowed: false }
  }

  if (category === 'ERROR' || category === 'TRENDYOL_PROXY') {
    return { ...base, carrierRegistrationConfirmed: false,
      verificationStage: 'CARRIER_RESPONDED',
      finalClassification: 'REJECTED_BUSINESS_RULE',
      isTerminal: true, retryAllowed: false }
  }

  return { ...base, carrierRegistrationConfirmed: false,
    verificationStage: 'CARRIER_RESPONDED',
    finalClassification: 'UNKNOWN', isTerminal: false, retryAllowed: false }
}

/**
 * Kullanıcıya gösterilecek KISA ve İZLENEBİLİR hata.
 * Taşıyıcının iş mesajı kaybolmaz; trace üzerinden erişilebilir kalır.
 */
export function buildClassificationUserMessage(
  classification: SuratResponseClassification, traceId: string,
): string {
  if (classification.finalClassification === 'CREATED_CONFIRMED') {
    return 'Sürat barkodu oluşturuldu.'
  }
  const code = classification.businessCode
    ? ` Kod: ${classification.businessCode}.` : ''
  return `Sürat barkod oluşturma tamamlanamadı.${code} Debug Trace: ${traceId}`
}
