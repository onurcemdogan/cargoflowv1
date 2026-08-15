// SÜRAT WEB API — KANONİK ALAN ÇEKİRDEĞİ (SAF; AĞ YOK, DB YOK).
//
// SOURCE OF TRUTH: Sürat Kargo Web API OpenAPI 3.0.0 sözleşmesi,
// `POST /api/OrtakBarkodOlustur` uçunun request gövdesi:
//     { KullaniciAdi: string, Sifre: string, Gonderi: GonderiModel }
// AYNI `$ref` `/api/GonderiyiKargoyaGonder` tarafından da kullanılır — Sürat
// entegrasyon ekibinin "request yapısı birebir aynıdır" beyanı bu şekilde
// doğrulanmıştır.
//
// BU DOSYA:
//   · HTTP ÇAĞRISI YAPMAZ, host bilmez (api01/api02 kararı Ünite 2'dedir)
//   · üretim create akışına BAĞLI DEĞİLDİR (wiring Ünite 3'tedir)
//   · legacy SOAP builder'larından serileştirme semantiği TAŞIMAZ
//   · scratchpad'e veya herhangi bir çalışma dosyasına BAĞIMLI DEĞİLDİR
//
// FİYAT: CargoFlow ücret GÖNDERMEZ. Sözleşmeli tarife Sürat tarafında
// cari/sözleşme bağlamından çözülür. Bu dosyada fiyat/tarife alanı YOKTUR.

/** Swagger `GonderiModel` — alan adları ve tipleri contract ile birebir. */
export interface SuratGonderiModel {
  KisiKurum?: string
  SahisBirim?: string
  AliciAdresi?: string
  Il?: string
  Ilce?: string
  TelefonEv?: string
  TelefonIs?: string
  TelefonCep?: string
  Email?: string
  AliciKodu?: string
  KargoTuru: number
  OdemeTipi: number
  IrsaliyeSeriNo?: string
  IrsaliyeSiraNo?: string
  ReferansNo?: string
  OzelKargoTakipNo?: string
  Adet: number
  BirimDesi?: string
  BirimKg?: string
  KargoIcerigi?: string
  KapidanOdemeTahsilatTipi: number
  KapidanOdemeTutari?: string
  EkHizmetler?: string
  TasimaSekli: number
  TeslimSekli: number
  SevkAdresi?: string
  GonderiSekli?: number | null
  TeslimSubeKodu?: string
  Pazaryerimi: number
  EntegrasyonFirmasi?: string
  Iademi: boolean
}

/** Swagger `OrtakBarkodOlusturParam` kökü. */
export interface SuratOrtakBarkodRequest {
  KullaniciAdi: string
  Sifre: string
  Gonderi: SuratGonderiModel
}

/**
 * Contract'ta BULUNMAYAN ve bu builder'ın ASLA üretmeyeceği alanlar.
 * Legacy SOAP gövdesinden JSON'a taşınma riski testle kilitlenir.
 */
export const FORBIDDEN_CANONICAL_FIELDS = [
  'WebSiparisKodu',
  'SatisKodu',
  'MarketplaceIntegrationCode',
  'EntegrasyonSozlesme',
  'EntegrasyonMusteri',
  'WhoPays',
  'KimOder',
  'CariKodu',
  'GonderenCariKodu',
  'Price',
  'Tarife',
  'TarifeId',
  'Discount',
  'ContractPrice',
] as const

/** Swagger `GonderiModel` alan kümesi — sıra contract'taki sırayla aynıdır. */
export const CANONICAL_GONDERI_FIELDS = [
  'KisiKurum',
  'SahisBirim',
  'AliciAdresi',
  'Il',
  'Ilce',
  'TelefonEv',
  'TelefonIs',
  'TelefonCep',
  'Email',
  'AliciKodu',
  'KargoTuru',
  'OdemeTipi',
  'IrsaliyeSeriNo',
  'IrsaliyeSiraNo',
  'ReferansNo',
  'OzelKargoTakipNo',
  'Adet',
  'BirimDesi',
  'BirimKg',
  'KargoIcerigi',
  'KapidanOdemeTahsilatTipi',
  'KapidanOdemeTutari',
  'EkHizmetler',
  'TasimaSekli',
  'TeslimSekli',
  'SevkAdresi',
  'GonderiSekli',
  'TeslimSubeKodu',
  'Pazaryerimi',
  'EntegrasyonFirmasi',
  'Iademi',
] as const

// ═══ PAZARYERI BAĞLAMI ════════════════════════════════════════════════════

export type SuratMarketplaceKey =
  | 'TRENDYOL'
  | 'HEPSIBURADA'
  | 'IDEFIX'
  | 'PAZARAMA'
  | 'OWN_PLATFORM'

/**
 * Pazaryeri kayıt tablosu.
 *
 * `entegrasyonFirmasi` Sürat'in beklediği METİNDİR — tahmin edilmez, vendor
 * talimatından alınır. `trackingSource`, CargoFlow sipariş modelinde kargo
 * numarasının GERÇEKTEN bulunduğu alandır; `null` ise CargoFlow'da o
 * pazaryeri için doğrulanmış bir kaynak HENÜZ YOKTUR ve resolver açıkça
 * `UNRESOLVED_MARKETPLACE_TRACKING_SOURCE` döner (uydurma alan üretilmez).
 */
export const SURAT_MARKETPLACE_REGISTRY: Record<
  Exclude<SuratMarketplaceKey, 'OWN_PLATFORM'>,
  { entegrasyonFirmasi: string; trackingSource: string | null }
> = {
  // CargoFlow'da doğrulanmış tek kaynak: order.cargoTrackingNumber (727…).
  TRENDYOL: { entegrasyonFirmasi: 'Trendyol', trackingSource: 'cargoTrackingNumber' },
  // Aşağıdakiler için CargoFlow sipariş modelinde henüz kaynak alan YOK.
  // Sürat metni vendor talimatından; kaynak alan eklenince trackingSource dolar.
  HEPSIBURADA: { entegrasyonFirmasi: 'Hepsiburada', trackingSource: null },
  IDEFIX: { entegrasyonFirmasi: 'İdefix', trackingSource: null },
  PAZARAMA: { entegrasyonFirmasi: 'Pazarama', trackingSource: null },
}

export interface SuratMarketplaceContext {
  isMarketplace: boolean
  marketplace: SuratMarketplaceKey
  pazaryerimi: number
  entegrasyonFirmasi: string
  ozelKargoTakipNo: string
  /** Değerin okunduğu sipariş alanı — denetlenebilirlik için. */
  trackingSource: string | null
  /** Çözülemediyse sebep (fail-closed; sessiz fallback YOK). */
  unresolvedReason?: 'UNRESOLVED_MARKETPLACE_TRACKING_SOURCE'
}

function normalizeMarketplaceKey(value: unknown): SuratMarketplaceKey | null {
  const token = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
  if (!token) return null
  if (token === 'trendyol') return 'TRENDYOL'
  if (token === 'hepsiburada') return 'HEPSIBURADA'
  if (token === 'idefix') return 'IDEFIX'
  if (token === 'pazarama') return 'PAZARAMA'
  return null
}

/**
 * Sipariş → Sürat pazaryeri faturalama bağlamı. SAF fonksiyon.
 *
 * KRİTİK: `ozelKargoTakipNo` YALNIZ gerçek pazaryeri kargo numarası
 * kaynağından okunur. `orderNumber`, `packageId` veya `ReferansNo`'ya
 * fallback YOKTUR — bunlar Sürat'in borçlandırma sınıflandırmasını bozar.
 *
 * Pazaryeri dışı gönderide `ozelKargoTakipNo` DIŞARIDAN verilir
 * (`options.ownPlatformReference`); burada yeni üretici yazılmaz.
 */
export function resolveSuratMarketplaceContext(
  order: Record<string, unknown> = {},
  options: { ownPlatformReference?: string } = {},
): SuratMarketplaceContext {
  const key = normalizeMarketplaceKey(order.marketplace)
  if (!key) {
    return {
      isMarketplace: false,
      marketplace: 'OWN_PLATFORM',
      pazaryerimi: 0,
      entegrasyonFirmasi: '',
      ozelKargoTakipNo: String(options.ownPlatformReference ?? '').trim(),
      trackingSource: options.ownPlatformReference ? 'ownPlatformReference' : null,
    }
  }
  // `key` burada OWN_PLATFORM olamaz (yukarıdaki dal onu döndürdü).
  const entry =
    SURAT_MARKETPLACE_REGISTRY[key as Exclude<SuratMarketplaceKey, 'OWN_PLATFORM'>]
  if (!entry.trackingSource) {
    return {
      isMarketplace: true,
      marketplace: key,
      pazaryerimi: 1,
      entegrasyonFirmasi: entry.entegrasyonFirmasi,
      ozelKargoTakipNo: '',
      trackingSource: null,
      unresolvedReason: 'UNRESOLVED_MARKETPLACE_TRACKING_SOURCE',
    }
  }
  const raw = (order as Record<string, unknown>)[entry.trackingSource]
  return {
    isMarketplace: true,
    marketplace: key,
    pazaryerimi: 1,
    entegrasyonFirmasi: entry.entegrasyonFirmasi,
    ozelKargoTakipNo: String(raw ?? '').trim(),
    trackingSource: entry.trackingSource,
  }
}

// ═══ FATURALAMA BAĞLAMI DOĞRULAMASI ═══════════════════════════════════════

export type SuratBillingContextErrorCode =
  | 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID'
  | 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING'

export interface SuratBillingValidation {
  valid: boolean
  errorCode?: SuratBillingContextErrorCode
  reason?: string
}

/**
 * Sürat'in doğru cariye borçlandırma yapabilmesi için ZORUNLU bağlam.
 *
 * FİYAT HESAPLAMAZ. Yalnız vendor'ın "bu üçlü doğru olmalı" dediği
 * (OzelKargoTakipNo · Pazaryerimi · EntegrasyonFirmasi) bütünlüğünü kontrol
 * eder. Geçersizse gönderi OLUŞTURULMAMALIDIR (fail-closed).
 */
export function validateSuratBillingContext(
  context: SuratMarketplaceContext,
): SuratBillingValidation {
  if (context.unresolvedReason) {
    return {
      valid: false,
      errorCode: 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING',
      reason: `${context.marketplace}: pazaryeri kargo numarası kaynağı tanımlı değil.`,
    }
  }
  if (context.isMarketplace) {
    if (context.pazaryerimi !== 1) {
      return {
        valid: false,
        errorCode: 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID',
        reason: 'Pazaryeri gönderisinde Pazaryerimi 1 olmalıdır.',
      }
    }
    if (!context.entegrasyonFirmasi) {
      return {
        valid: false,
        errorCode: 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID',
        reason: 'EntegrasyonFirmasi boş olamaz.',
      }
    }
    if (!context.ozelKargoTakipNo) {
      return {
        valid: false,
        errorCode: 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING',
        reason: 'Pazaryeri kargo numarası (OzelKargoTakipNo) eksik.',
      }
    }
    return { valid: true }
  }
  // Kendi platform gönderisi.
  if (context.pazaryerimi !== 0 || context.entegrasyonFirmasi !== '') {
    return {
      valid: false,
      errorCode: 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID',
      reason: 'Pazaryeri dışı gönderide Pazaryerimi 0 ve EntegrasyonFirmasi "" olmalıdır.',
    }
  }
  if (!context.ozelKargoTakipNo) {
    return {
      valid: false,
      errorCode: 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING',
      reason: 'Pazaryeri dışı gönderi için tekil referans verilmedi.',
    }
  }
  return { valid: true }
}

// ═══ GÖNDERİ MODELİ ═══════════════════════════════════════════════════════

/**
 * MEVCUT iş varsayılanları. Ünite 1'de DEĞİŞTİRİLMEZ; bugünkü üretim
 * değerleriyle aynıdır. Bunların anlaşmalı fiyatın sebebi olduğu
 * VARSAYILMAZ — canary sonrası ayrıca incelenecektir.
 */
export const SURAT_SERVICE_DEFAULTS = {
  KargoTuru: 3,
  OdemeTipi: 1,
  TasimaSekli: 1,
  TeslimSekli: 1,
  KapidanOdemeTahsilatTipi: 0,
  GonderiSekli: 0,
  Iademi: false,
} as const

export interface CanonicalShipmentInput {
  order: Record<string, unknown>
  context: SuratMarketplaceContext
  /** Sipariş referansı (Sürat `ReferansNo`). */
  referansNo?: string
  adet?: number
  birimDesi?: string | number
  birimKg?: string | number
  kargoIcerigi?: string
}

const str = (value: unknown): string => String(value ?? '').trim()

/** Tanımsız/boş alanları ATLAR (§16: gereksiz null doldurma YOK). */
function assignOptional(
  target: Record<string, unknown>,
  key: string,
  value: string,
): void {
  if (value !== '') target[key] = value
}

/**
 * Kanonik `GonderiModel` üretir. Contract dışı alan ÜRETMEZ.
 * Legacy XML/SOAP serileştirme semantiği BURADA YOKTUR — bu bir JSON
 * gövdesidir; kaçış/etiket yardımcıları taşınmaz.
 */
export function buildSuratCanonicalGonderiModel(
  input: CanonicalShipmentInput,
): SuratGonderiModel {
  const { order, context } = input
  const model: Record<string, unknown> = {}

  assignOptional(model, 'KisiKurum', str(order.customerName))
  assignOptional(model, 'SahisBirim', str(order.sahisBirim))
  assignOptional(model, 'AliciAdresi', str(order.address))
  assignOptional(model, 'Il', str(order.city))
  assignOptional(model, 'Ilce', str(order.district))
  assignOptional(model, 'TelefonEv', str(order.customerHomePhone))
  assignOptional(model, 'TelefonIs', str(order.customerWorkPhone))
  assignOptional(model, 'TelefonCep', str(order.customerPhone))
  assignOptional(model, 'Email', str(order.customerEmail))
  assignOptional(model, 'AliciKodu', str(order.aliciKodu))

  model.KargoTuru = SURAT_SERVICE_DEFAULTS.KargoTuru
  model.OdemeTipi = SURAT_SERVICE_DEFAULTS.OdemeTipi

  assignOptional(model, 'IrsaliyeSeriNo', str(order.irsaliyeSeriNo))
  assignOptional(model, 'IrsaliyeSiraNo', str(order.irsaliyeSiraNo))
  assignOptional(model, 'ReferansNo', str(input.referansNo))
  // FATURALAMA ÜÇLÜSÜ — bağlamdan gelir, siparişten körlemesine okunmaz.
  assignOptional(model, 'OzelKargoTakipNo', context.ozelKargoTakipNo)

  model.Adet = Number(input.adet ?? 1) || 1
  assignOptional(model, 'BirimDesi', str(input.birimDesi))
  assignOptional(model, 'BirimKg', str(input.birimKg))
  assignOptional(model, 'KargoIcerigi', str(input.kargoIcerigi))

  model.KapidanOdemeTahsilatTipi =
    SURAT_SERVICE_DEFAULTS.KapidanOdemeTahsilatTipi
  assignOptional(model, 'KapidanOdemeTutari', str(order.kapidanOdemeTutari))
  assignOptional(model, 'EkHizmetler', str(order.ekHizmetler))

  model.TasimaSekli = SURAT_SERVICE_DEFAULTS.TasimaSekli
  model.TeslimSekli = SURAT_SERVICE_DEFAULTS.TeslimSekli

  assignOptional(model, 'SevkAdresi', str(order.customerName))
  model.GonderiSekli = SURAT_SERVICE_DEFAULTS.GonderiSekli
  assignOptional(model, 'TeslimSubeKodu', str(order.teslimSubeKodu))

  // Sayı olarak gönderilir ("1" DEĞİL) — Swagger tipi integer.
  model.Pazaryerimi = context.pazaryerimi
  // Kendi platform gönderisinde BOŞ STRİNG semantiktir; atlanmaz.
  model.EntegrasyonFirmasi = context.entegrasyonFirmasi
  model.Iademi = SURAT_SERVICE_DEFAULTS.Iademi

  return model as unknown as SuratGonderiModel
}

/**
 * Kök istek gövdesi (`OrtakBarkodOlusturParam`).
 * Credential ÇÖZÜMÜ BURADA YAPILMAZ — çağıran tenant hesabından getirir
 * (Ünite 2). Bu fonksiyon yalnız verilen değerleri şekle sokar.
 */
export function buildSuratOrtakBarkodRequest(params: {
  credentials: { kullaniciAdi: string; sifre: string }
  shipment: CanonicalShipmentInput
}): SuratOrtakBarkodRequest {
  const kullaniciAdi = str(params.credentials?.kullaniciAdi)
  const sifre = str(params.credentials?.sifre)
  return {
    KullaniciAdi: kullaniciAdi,
    Sifre: sifre,
    Gonderi: buildSuratCanonicalGonderiModel(params.shipment),
  }
}
