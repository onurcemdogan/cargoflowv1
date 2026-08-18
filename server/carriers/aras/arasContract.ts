// ARAS KARGO — SÖZLEŞME KATMANI (saf karar; ağ YOK).
//
// KAYNAK: Aras Kargo resmî GENEL TEST web servisi, doğrulama 2026-08-19:
//   customerservicestest.araskargo.com.tr/arascargoservice/arascargoservice.asmx
//
// ═══ ÜRETİM HOST'U TÜRETİLMEZ ════════════════════════════════════════════
//
// Hepsiburada'da `-sit` → üretim dönüşümü RESMÎ olarak belgelenmiştir ve o
// yüzden uygulanır. Aras'ta BÖYLE BİR KURAL YOKTUR: test host'undan üretim
// host'u türetmek TAHMİN olurdu. Üretim adresi DIŞARIDAN yapılandırılır;
// yapılandırılmadıysa üretim çağrısı KURULMAZ (fail-closed).

/** Resmî genel TEST uç noktası — kanıtlı. */
export const ARAS_TEST_ENDPOINT =
  'https://customerservicestest.araskargo.com.tr/arascargoservice/arascargoservice.asmx'

export const ARAS_ENVIRONMENTS = ['TEST', 'PRODUCTION'] as const
export type ArasEnvironment = (typeof ARAS_ENVIRONMENTS)[number]

export interface ArasEndpointResolution {
  ok: boolean
  url: string | null
  environment: ArasEnvironment | null
  errorCode: 'ARAS_PRODUCTION_ENDPOINT_UNVERIFIED' | null
  reason: string | null
}

/**
 * Uç nokta çözer.
 *
 * TEST: kanıtlı sabit adres.
 * PRODUCTION: YALNIZ açıkça yapılandırılmışsa. Test adresinden türetme YOK.
 */
export function resolveArasEndpoint(params: {
  environment?: ArasEnvironment
  productionUrl?: string | null
}): ArasEndpointResolution {
  const environment = params.environment ?? 'TEST'
  if (environment === 'TEST') {
    return {
      ok: true, url: ARAS_TEST_ENDPOINT, environment: 'TEST',
      errorCode: null, reason: null,
    }
  }
  const productionUrl = String(params.productionUrl ?? '').trim()
  if (!productionUrl) {
    return {
      ok: false, url: null, environment: null,
      errorCode: 'ARAS_PRODUCTION_ENDPOINT_UNVERIFIED',
      reason:
        'Aras üretim adresi yapılandırılmadı. Test adresinden ÜRETİLMEZ — '
        + 'resmî bir dönüşüm kuralı yoktur.',
    }
  }
  return {
    ok: true, url: productionUrl, environment: 'PRODUCTION',
    errorCode: null, reason: null,
  }
}

// ═══ SetOrder ALANLARI — RESMÎ SÖZLEŞMEDEN ═══════════════════════════════
//
// Bu liste sözleşmede GÖRÜLEN alanlardır. Buraya alan EKLENMEZ; sözleşmede
// olmayan bir alanı telde göndermek uydurmadır.

export const ARAS_SET_ORDER_FIELDS = [
  'UserName', 'Password', 'TradingWaybillNumber', 'InvoiceNumber',
  'ReceiverName', 'ReceiverAddress', 'ReceiverPhone1', 'ReceiverPhone2',
  'ReceiverPhone3', 'ReceiverCityName', 'ReceiverTownName',
  'VolumetricWeight', 'Weight', 'PieceCount',
  'SpecialField1', 'SpecialField2', 'SpecialField3',
  'CodAmount', 'CodCollectionType', 'CodBillingType',
  'IntegrationCode', 'Description', 'TaxNumber', 'TtDocumentId', 'TaxOffice',
  'PrivilegeOrder', 'Country', 'CountryCode', 'CityCode', 'TownCode',
  'ReceiverDistrictName', 'ReceiverQuarterName', 'ReceiverAvenueName',
  'ReceiverStreetName', 'PayorTypeCode', 'IsWorldWide', 'IsCod', 'UnitID',
  'PieceDetails', 'SenderAccountAddressId',
] as const

export type ArasSetOrderField = (typeof ARAS_SET_ORDER_FIELDS)[number]

/** SetOrder yanıtının sipariş başına alanları — resmî. */
export const ARAS_SET_ORDER_RESULT_FIELDS = [
  'ResultCode', 'ResultMessage', 'InvoiceKey', 'OrgReceiverCustId',
] as const

// ═══ COD / ÖDEYEN — DEĞER TABLOSU DOĞRULANMADI ═══════════════════════════
//
// Sözleşme bu ALANLARIN VAR OLDUĞUNU kanıtlar. Alanın varlığı, alabileceği
// SAYISAL DEĞERLERİ kanıtlamaz. `CodCollectionType`, `CodBillingType` ve
// `PayorTypeCode` için resmî değer tablosu elde YOKTUR.
//
// Bu yüzden değer UYDURULMAZ: bilinen/bilinmeyen sarmalayıcısı kullanılır ve
// desteklenmeyen mod FAIL-CLOSED olur. Yanlış COD kodu, tahsilatın yanlış
// tarafa yazılması demektir — geri alınamaz finansal hata.

export interface ArasKnownValue<T> {
  known: boolean
  value: T | null
  raw: unknown
}

export const arasUnknownValue = <T>(raw: unknown): ArasKnownValue<T> => ({
  known: false, value: null, raw,
})

export const arasKnownValue = <T>(value: T, raw: unknown = value): ArasKnownValue<T> => ({
  known: true, value, raw,
})

export interface ArasCodResolution {
  ok: boolean
  isCod: boolean
  codAmount: number | null
  codCollectionType: ArasKnownValue<number>
  codBillingType: ArasKnownValue<number>
  errorCode: 'ARAS_COD_VALUE_TABLE_UNVERIFIED' | 'ARAS_COD_AMOUNT_INVALID' | null
  reason: string | null
}

/**
 * COD bağlamını çözer.
 *
 * COD OLMAYAN gönderi: tamamen desteklenir — gerekli alanlar sözleşmeden
 * ispatlanabilir.
 *
 * COD gönderi: resmî değer tablosu doğrulanana kadar FAIL-CLOSED. Çağıran
 * açıkça doğrulanmış değerler enjekte ederse (`verifiedCollectionType`
 * /`verifiedBillingType`) o zaman geçer — ama bu değerler BURADA türetilmez.
 */
export function resolveArasCod(params: {
  isCod?: boolean
  codAmount?: unknown
  verifiedCollectionType?: number | null
  verifiedBillingType?: number | null
}): ArasCodResolution {
  const isCod = params.isCod === true
  if (!isCod) {
    return {
      ok: true, isCod: false, codAmount: null,
      codCollectionType: arasUnknownValue(null),
      codBillingType: arasUnknownValue(null),
      errorCode: null, reason: null,
    }
  }
  const amount = Number(params.codAmount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false, isCod: true, codAmount: null,
      codCollectionType: arasUnknownValue(params.verifiedCollectionType),
      codBillingType: arasUnknownValue(params.verifiedBillingType),
      errorCode: 'ARAS_COD_AMOUNT_INVALID',
      reason: 'COD gönderisinde tahsil edilecek tutar geçerli değil.',
    }
  }
  const collection = params.verifiedCollectionType
  const billing = params.verifiedBillingType
  if (!Number.isFinite(Number(collection)) || !Number.isFinite(Number(billing))) {
    return {
      ok: false, isCod: true, codAmount: amount,
      codCollectionType: arasUnknownValue(collection),
      codBillingType: arasUnknownValue(billing),
      errorCode: 'ARAS_COD_VALUE_TABLE_UNVERIFIED',
      reason:
        'COD tahsilat/faturalama kodlarının resmî değer tablosu doğrulanmadı; '
        + 'değer UYDURULMAZ ve COD gönderi oluşturulmaz.',
    }
  }
  return {
    ok: true, isCod: true, codAmount: amount,
    codCollectionType: arasKnownValue(Number(collection)),
    codBillingType: arasKnownValue(Number(billing)),
    errorCode: null, reason: null,
  }
}

// ═══ SONUÇ SINIFLANDIRMASI ═══════════════════════════════════════════════

export interface ArasSetOrderResult {
  ok: boolean
  resultCode: string
  resultMessage: string
  invoiceKey: string
  orgReceiverCustId: string
  errorCode: 'ARAS_SET_ORDER_REJECTED' | 'ARAS_SET_ORDER_RESULT_MISSING' | null
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/**
 * SetOrder sonucunu sınıflandırır.
 *
 * `ResultCode` DOKÜMANTE EDİLMİŞ bir anlam tablosuna sahip DEĞİLDİR; bu yüzden
 * "hangi kod ne demek" UYDURULMAZ. Yalnız kanıtlanabilir olan uygulanır:
 * sonuç bloğu YOKSA başarı sayılmaz ve `ResultCode` "0" DIŞINDA bir değerse
 * başarı VARSAYILMAZ. Ham kod/mesaj HER DURUMDA korunur.
 */
export function classifyArasSetOrderResult(
  raw: Record<string, unknown> | null | undefined,
): ArasSetOrderResult {
  if (!raw) {
    return {
      ok: false, resultCode: '', resultMessage: '', invoiceKey: '',
      orgReceiverCustId: '',
      errorCode: 'ARAS_SET_ORDER_RESULT_MISSING',
    }
  }
  const resultCode = str(raw.ResultCode)
  const result: ArasSetOrderResult = {
    ok: false,
    resultCode,
    resultMessage: str(raw.ResultMessage),
    invoiceKey: str(raw.InvoiceKey),
    orgReceiverCustId: str(raw.OrgReceiverCustId),
    errorCode: null,
  }
  if (!resultCode) {
    return { ...result, errorCode: 'ARAS_SET_ORDER_RESULT_MISSING' }
  }
  if (resultCode !== '0') {
    return { ...result, errorCode: 'ARAS_SET_ORDER_REJECTED' }
  }
  return { ...result, ok: true }
}
