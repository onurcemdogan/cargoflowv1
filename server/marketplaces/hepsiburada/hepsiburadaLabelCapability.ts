// HEPSIBURADA — ORTAK (MUTUAL) BARKOD YETENEĞİ (saf karar; ağ/DB YOK).
//
// KAYNAK: Hepsiburada Developer Portal ortak barkod dokümanı, 2026-08-19.
// Kanıtlı: desteklenen taşıyıcılar HepsiJet ve Aras; çıktı biçimleri
// zpl · base64zpl · pdf · png · jpg; iş kodları 101 · 102 · 400 · 500.
//
// ═══ MİMARİ AYRIM — KARIŞTIRILMASI YASAK ═════════════════════════════════
//
// Hepsiburada + Aras kombinasyonunda etiket İKİ FARKLI yoldan gelebilir:
//
//   A) MARKETPLACE_MANAGED_LABEL — Hepsiburada ortak barkodu.
//      Etiketi PAZARYERI üretir; taşıyıcı API'sine BİZ gitmeyiz.
//   B) DIRECT_CARRIER_LABEL — Aras taşıyıcı API'si (SetOrder/GetBarcode).
//      Gönderiyi BİZ açarız.
//
// Bu ikisi arasında SESSİZ geçiş YOKTUR: hangi yolun kullanılacağı sipariş/
// hesap yapılandırmasından AÇIKÇA gelir ve kanıtlı desteklenmiyorsa istek
// KURULMAZ. Aksi hâlde aynı fiziksel gönderi için iki kayıt doğabilir.
//
// Bu yetenek SÜRAT create mantığından GEÇMEZ; Hepsiburada paket akışına aittir.

export const MARKETPLACE_LABEL_STRATEGIES = [
  'MARKETPLACE_MANAGED_LABEL',
  'DIRECT_CARRIER_LABEL',
] as const

export type MarketplaceLabelStrategy = (typeof MARKETPLACE_LABEL_STRATEGIES)[number]

/** Resmî: ortak barkod ŞU AN bu taşıyıcıları destekliyor. */
export const HEPSIBURADA_MUTUAL_BARCODE_CARRIERS = ['hepsijet', 'aras'] as const

/** Resmî: dokümante çıktı biçimleri. */
export const HEPSIBURADA_MUTUAL_BARCODE_FORMATS = [
  'zpl', 'base64zpl', 'pdf', 'png', 'jpg',
] as const

export type HepsiburadaBarcodeFormat =
  (typeof HEPSIBURADA_MUTUAL_BARCODE_FORMATS)[number]

/**
 * Resmî iş kodları. HTTP 200 TEK BAŞINA başarı DEĞİLDİR — gövdedeki iş kodu
 * okunmadan hiçbir yanıt başarı sayılmaz.
 */
export const HEPSIBURADA_BARCODE_BUSINESS_CODES = {
  CARRIER_NO_BARCODE: 101,
  MERCHANT_NOT_ACTIVE: 102,
  CARRIER_NO_MUTUAL_BARCODE: 400,
  INTERNAL_ERROR: 500,
} as const

export interface MarketplaceLabelCapability {
  capability: 'HEPSIBURADA_MUTUAL_BARCODE'
  strategy: MarketplaceLabelStrategy
  supportedCarrier: boolean
  outputFormat: HepsiburadaBarcodeFormat | null
  businessCode: number | null
  labelPresent: boolean
  barcodePresent: boolean
  artifactPresent: boolean
  ok: boolean
  errorCode: string | null
  reason: string | null
}

const base = (): MarketplaceLabelCapability => ({
  capability: 'HEPSIBURADA_MUTUAL_BARCODE',
  strategy: 'MARKETPLACE_MANAGED_LABEL',
  supportedCarrier: false,
  outputFormat: null,
  businessCode: null,
  labelPresent: false,
  barcodePresent: false,
  artifactPresent: false,
  ok: false,
  errorCode: null,
  reason: null,
})

export const isHepsiburadaMutualBarcodeCarrier = (carrier: unknown): boolean =>
  (HEPSIBURADA_MUTUAL_BARCODE_CARRIERS as readonly string[]).includes(
    String(carrier ?? '').trim().toLowerCase(),
  )

/**
 * İstek KURULABİLİR Mİ? — çağrı ÖNCESİ kapı.
 *
 * Desteklenmeyen taşıyıcı için ortak barkod istemek, kesin reddedilecek bir
 * çağrı harcamaktır. Strateji açıkça `MARKETPLACE_MANAGED_LABEL` değilse bu
 * yetenek HİÇ değerlendirilmez (doğrudan taşıyıcı yolu ayrıdır).
 */
export function evaluateHepsiburadaLabelCapability(params: {
  strategy?: MarketplaceLabelStrategy | null
  carrier?: unknown
  outputFormat?: string | null
}): MarketplaceLabelCapability {
  const result = base()
  const strategy = params.strategy ?? null
  if (strategy !== 'MARKETPLACE_MANAGED_LABEL') {
    return {
      ...result,
      strategy: strategy ?? 'DIRECT_CARRIER_LABEL',
      errorCode: 'HB_LABEL_STRATEGY_NOT_MARKETPLACE_MANAGED',
      reason:
        'Ortak barkod YALNIZ pazaryeri yönetimli etiket stratejisinde kullanılır; '
        + 'doğrudan taşıyıcı yolu bu yetenekten GEÇMEZ.',
    }
  }
  result.supportedCarrier = isHepsiburadaMutualBarcodeCarrier(params.carrier)
  if (!result.supportedCarrier) {
    return {
      ...result,
      errorCode: 'HB_MUTUAL_BARCODE_CARRIER_UNSUPPORTED',
      reason: 'Ortak barkod bu taşıyıcı için dokümante edilmemiş.',
    }
  }
  const format = String(params.outputFormat ?? '').trim().toLowerCase()
  if (!(HEPSIBURADA_MUTUAL_BARCODE_FORMATS as readonly string[]).includes(format)) {
    return {
      ...result,
      errorCode: 'HB_MUTUAL_BARCODE_FORMAT_UNSUPPORTED',
      reason: 'Çıktı biçimi dokümante edilen kümede değil.',
    }
  }
  return {
    ...result,
    outputFormat: format as HepsiburadaBarcodeFormat,
    ok: true,
  }
}

const nonEmpty = (value: unknown): boolean => String(value ?? '').trim().length > 0

/**
 * YANIT SINIFLANDIRMASI — fail-closed.
 *
 * HTTP 200 + iş kodu 101/102/400/500 BAŞARI DEĞİLDİR. Ayrıca iş kodu temiz
 * olsa bile gerçek bir artefakt (etiket/barkod) YOKSA başarı sayılmaz:
 * "kod 0 döndü" ile "elimde basılabilir etiket var" AYNI ŞEY DEĞİLDİR.
 */
export function classifyHepsiburadaBarcodeResponse(params: {
  capability: MarketplaceLabelCapability
  statusCode?: number | null
  businessCode?: number | null
  label?: unknown
  barcode?: unknown
}): MarketplaceLabelCapability {
  const capability = { ...params.capability }
  if (!capability.ok) return capability

  const businessCode =
    params.businessCode === null || params.businessCode === undefined
      ? null
      : Number(params.businessCode)
  capability.businessCode = businessCode
  capability.labelPresent = nonEmpty(params.label)
  capability.barcodePresent = nonEmpty(params.barcode)
  capability.artifactPresent = capability.labelPresent || capability.barcodePresent

  const statusCode = Number(params.statusCode)
  if (Number.isFinite(statusCode) && statusCode >= 400) {
    return {
      ...capability, ok: false,
      errorCode: 'HB_MUTUAL_BARCODE_HTTP_ERROR',
      reason: `Taşıyıcı/pazaryeri HTTP ${statusCode} döndü.`,
    }
  }

  const known: Record<number, { code: string; reason: string }> = {
    [HEPSIBURADA_BARCODE_BUSINESS_CODES.CARRIER_NO_BARCODE]: {
      code: 'HB_MUTUAL_BARCODE_CARRIER_NO_BARCODE',
      reason: 'Taşıyıcı barkod üretemedi (101).',
    },
    [HEPSIBURADA_BARCODE_BUSINESS_CODES.MERCHANT_NOT_ACTIVE]: {
      code: 'HB_MUTUAL_BARCODE_MERCHANT_NOT_ACTIVE',
      reason: 'Satıcı için ortak barkod aktif değil (102).',
    },
    [HEPSIBURADA_BARCODE_BUSINESS_CODES.CARRIER_NO_MUTUAL_BARCODE]: {
      code: 'HB_MUTUAL_BARCODE_CARRIER_UNSUPPORTED',
      reason: 'Taşıyıcı ortak barkod sağlamıyor (400).',
    },
    [HEPSIBURADA_BARCODE_BUSINESS_CODES.INTERNAL_ERROR]: {
      code: 'HB_MUTUAL_BARCODE_INTERNAL_ERROR',
      reason: 'Ortak barkod servisinde iç hata (500); yedek akış gerekir.',
    },
  }
  if (businessCode !== null && known[businessCode]) {
    return {
      ...capability, ok: false,
      errorCode: known[businessCode].code,
      reason: known[businessCode].reason,
    }
  }
  if (!capability.artifactPresent) {
    return {
      ...capability, ok: false,
      errorCode: 'HB_MUTUAL_BARCODE_ARTIFACT_MISSING',
      reason: 'Yanıt hata bildirmedi ama basılabilir bir artefakt taşımıyor.',
    }
  }
  return { ...capability, ok: true, errorCode: null, reason: null }
}
