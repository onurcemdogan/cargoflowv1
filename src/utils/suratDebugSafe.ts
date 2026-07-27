// Debug Merkezi PII/secret sanitizasyonu.
//
// KRİTİK güvenlik: Sürat "Ortak Barkod Oluştur" akışının ham SOAP isteği müşteri
// ADI, AÇIK ADRES, TELEFON ve E-POSTA içerir; ham yanıt ise tam ZPL (Code128 +
// gönderici/adres metni) taşır. Bu ham gövdeler client debug store'una (apiDebug)
// YAZILMAMALIDIR. Debug yalnız GÜVENLİ METADATA görmelidir: uzunluk/varlık
// bayrakları ve iş sonucu — kimlik/kredensiyal/PII değil.
//
// Not: server tarafı zaten <Sifre> maskeler (redactSuratRawRequest); bu helper
// istemci debug yüzeyinde raw request/response + tam ZPL + müşteri PII'yi tamamen
// dışarıda bırakır (savunmada derinlik).

function textLength(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

// Güvenli istek özeti: ham SOAP YERİNE yalnız PII olmayan alanlar (sipariş/koli
// no, pazaryeri entegrasyon referansları, servis tipi). Müşteri adı/adres/tel/
// e-posta ASLA yer almaz.
export interface SuratDebugRequestMeta {
  orderNumber?: string | null
  packageId?: string | null
  satisKodu?: string | null
  webSiparisKodu?: string | null
  ozelKargoTakipNo?: string | null
  marketplaceIntegrationCode?: string | null
  referansNo?: string | null
  serviceType?: string | null
}

export function buildSuratSafeRequestBody(
  meta: SuratDebugRequestMeta,
): Record<string, unknown> {
  return {
    note: 'Ham SOAP isteği güvenlik için gizlendi (müşteri PII içerir).',
    orderNumber: meta.orderNumber ?? null,
    packageId: meta.packageId ?? null,
    SatisKodu: meta.satisKodu ?? null,
    WebSiparisKodu: meta.webSiparisKodu ?? null,
    OzelKargoTakipNo: meta.ozelKargoTakipNo ?? null,
    MarketplaceIntegrationCode: meta.marketplaceIntegrationCode ?? null,
    ReferansNo: meta.referansNo ?? null,
    serviceType: meta.serviceType ?? null,
  }
}

// Güvenli yanıt özeti: ham SOAP/JSON gövdesi ve tam ZPL YERİNE yalnız güvenli
// metadata. responseLength/zplLength ham içeriği ifşa etmeden varlığını gösterir.
export interface SuratDebugResponseMeta {
  responseStatus?: number
  isError?: boolean
  labelCreationOk?: boolean
  carrierAcceptanceConfirmed?: boolean
  businessResult?: string
  trackingPresent?: boolean
  barcodePresent?: boolean
  zpl?: unknown
  lifecycleStatus?: string | null
  verificationStage?: string | null
}

// Ham/PII taşıyan iç içe alanlardan (parsedResponse, dispatchRegistration vb.)
// bilinen ağır/hassas anahtarları çıkarır: tam ZPL, ham SOAP istek/yanıt ve
// müşteri PII alanları. Debug'da yalnız güvenli skalarlar kalır.
const SENSITIVE_DEBUG_KEYS = new Set([
  'BarcodeRaw',
  'barcodeRaw',
  'technicalZpl',
  'zpl',
  'zplContent',
  'rawRequest',
  'rawResponse',
  'requestBody',
  'responseBody',
  'AliciAdi',
  'aliciAdi',
  'customerName',
  'AliciAdresi',
  'address',
  'openAddress',
  'AliciTelefon',
  'phone',
  'telefon',
  'email',
  'eposta',
  'ePosta',
])

export function stripSuratSensitiveFields(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripSuratSensitiveFields)
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_DEBUG_KEYS.has(key)) {
      // Varlığını göster, içeriğini gizle.
      out[`${key}Present`] = val != null && val !== ''
      continue
    }
    out[key] =
      val && typeof val === 'object' ? stripSuratSensitiveFields(val) : val
  }
  return out
}

export function summarizeSuratRawResponse(
  raw: unknown,
  meta: SuratDebugResponseMeta,
): Record<string, unknown> {
  const zplLength = textLength(meta.zpl)
  return {
    note: 'Ham yanıt/ZPL güvenlik için gizlendi (PII/etiket içeriği).',
    responseReceived: raw != null,
    responseStatus: meta.responseStatus ?? null,
    responseLength: textLength(raw),
    isError: meta.isError ?? null,
    labelCreationOk: meta.labelCreationOk ?? null,
    carrierAcceptanceConfirmed: meta.carrierAcceptanceConfirmed ?? null,
    businessResult: meta.businessResult ?? null,
    trackingPresent: meta.trackingPresent ?? null,
    barcodePresent: meta.barcodePresent ?? null,
    zplPresent: zplLength > 0,
    zplLength,
    lifecycleStatus: meta.lifecycleStatus ?? null,
    verificationStage: meta.verificationStage ?? null,
  }
}
