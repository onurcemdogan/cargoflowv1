// KANONİK FİLTRE PROJEKSİYONU — SAF ÜRETİCİ (write-time).
//
// AMAÇ: okuma yolunda 10.000 kaydı JS'te normalize etmek yerine, kanonik
// token'ları YAZMA anında bir kez üretip relational olarak saklamak.
//
// EN ÖNEMLİ KURAL: normalizasyon SQL'de YENİDEN YAZILMAZ. Tek doğruluk
// kaynağı üretimdeki `normalizedToken` / `normalizedSearch` fonksiyonlarıdır;
// bu modül onları AYNEN çağırır. Böylece SQL eşitliği/LIKE'ı kanonik JS
// davranışıyla birebir olur.
//
// Bu modül SAFTIR: ağ yok, DB yok, decrypt yok, process.env yok. Girdi
// ÇÖZÜLMÜŞ kanonik sipariş görünümüdür (şifreli alanlar çağıran tarafından
// zaten çözülmüş olarak verilir).
import {
  normalizedSearch,
  normalizedToken,
} from '../../src/utils/orderClassification.ts'

/** Normalizasyon sözleşmesi sürümü. Değişirse projeksiyon yeniden kurulur. */
export const ORDER_FILTER_PROJECTION_VERSION = 1

/**
 * ARAMA ALANI AYIRICISI — U+0301 (birleştirici tiz vurgu).
 *
 * `normalizedSearch` U+0300–U+036F aralığındaki birleştirici işaretlerin
 * TAMAMINI siler. Dolayısıyla ne bir alan değeri ne de kullanıcı sorgusu
 * normalize edildikten sonra bu karakteri İÇEREBİLİR. Bu yüzden birleşik
 * blob üzerinde `includes`/`LIKE` yapmak, alanları tek tek aramakla BİREBİR
 * aynı sonucu verir: hiçbir eşleşme alan sınırını aşamaz.
 */
export const SEARCH_FIELD_SEPARATOR = '́'

/**
 * Tarihi güvenli biçimde `Date`'e çevirir.
 *
 * Üretim yolları drizzle satırı verdiği için zaten `Date` gelir; ama geri
 * doldurma/onarım gibi ham SQL kullanan çağıranlarda metin gelebilir. Sessizce
 * bozuk bir değer YAZMAK yerine burada tek noktada normalize edilir.
 */
function toProjectionDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const parsed = new Date(value as string | number)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Alanları ayrı ayrı normalize edip güvenli ayırıcıyla birleştirir. */
export function buildSearchToken(values: unknown[]): string {
  return values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => normalizedSearch(value))
    .filter((value) => value !== '')
    .join(SEARCH_FIELD_SEPARATOR)
}

/** ORDER yaşam döngüsünün sahip olduğu projeksiyon parçası. */
export interface OrderProjectionFragmentInput {
  marketplace?: unknown
  operationStatus?: unknown
  marketplaceStatus?: unknown
  shippingCity?: unknown
  shippingDistrict?: unknown
  orderDate?: unknown
  customerName?: unknown
  customerPhone?: unknown
  customerEmail?: unknown
  orderNumber?: unknown
  externalOrderId?: unknown
  cargoTrackingNumber?: unknown
}

/** SHIPMENT yaşam döngüsünün sahip olduğu parça (yazma anında ÇÖZÜLMÜŞ). */
export interface ShipmentProjectionFragmentInput {
  ozelKargoTakipNo?: unknown
  trendyolCargoTrackingNumber?: unknown
  /** shipment-owned kargo fişi kaynakları (trackingNumber, barcode, gonderiNo…). */
  cargoSlipShipmentValues?: unknown[]
}

/** OPERATION yaşam döngüsünün sahip olduğu parça (create sonucu ÇÖZÜLMÜŞ). */
export interface OperationProjectionFragmentInput {
  /** create/verification sonucu T.No, barkod, doğrulama tanımlayıcıları. */
  cargoSlipOperationValues?: unknown[]
}

/**
 * ORDER parçası. `orders` ilişkisel kolonlarından türer; shipment/operation
 * kaynaklarına DOKUNMAZ (o kolonlar SET edilmez).
 */
export function buildOrderProjectionFragment(
  input: OrderProjectionFragmentInput,
) {
  return {
    marketplaceToken: normalizedToken(input.marketplace),
    operationStatusToken: normalizedToken(input.operationStatus),
    // Kanonik filtre bunu EXACT karşılaştırır; normalize EDİLMEZ.
    marketplaceStatus: String(input.marketplaceStatus ?? '').trim(),
    shippingCityToken: normalizedToken(input.shippingCity),
    shippingDistrictToken: normalizedToken(input.shippingDistrict),
    customerSearchToken: buildSearchToken([
      input.customerName,
      input.customerPhone,
      input.customerEmail,
    ]),
    orderNumberOrderToken: buildSearchToken([
      input.orderNumber,
      input.externalOrderId,
      input.cargoTrackingNumber,
    ]),
    cargoSlipOrderToken: buildSearchToken([input.cargoTrackingNumber]),
    orderDate: toProjectionDate(input.orderDate),
    projectionVersion: ORDER_FILTER_PROJECTION_VERSION,
  }
}

/** SHIPMENT parçası — yalnız shipment-owned kolonlar. */
export function buildShipmentProjectionFragment(
  input: ShipmentProjectionFragmentInput,
) {
  return {
    orderNumberShipmentToken: buildSearchToken([
      input.ozelKargoTakipNo,
      input.trendyolCargoTrackingNumber,
    ]),
    cargoSlipShipmentToken: buildSearchToken(
      input.cargoSlipShipmentValues ?? [],
    ),
    projectionVersion: ORDER_FILTER_PROJECTION_VERSION,
  }
}

/** OPERATION parçası — yalnız operation-owned kolon. */
export function buildOperationProjectionFragment(
  input: OperationProjectionFragmentInput,
) {
  return {
    cargoSlipOperationToken: buildSearchToken(
      input.cargoSlipOperationValues ?? [],
    ),
    projectionVersion: ORDER_FILTER_PROJECTION_VERSION,
  }
}

/**
 * KAYNAK SAHİPLİK HARİTASI — SHIPMENT.
 *
 * "Kargo fişi hangi alanlardan gelir" sorusunun TEK yanıtı. Hem canlı yazım
 * hem geri doldurma AYNI listeyi kullanır; iki kopya tutulsaydı zamanla
 * kayarlardı. Değerler çağıran tarafından ÇÖZÜLMÜŞ gelir.
 */
export function shipmentFragmentInput(
  record: {
    trackingNumber?: unknown
    barcode?: unknown
  },
  payload: Record<string, unknown> = {},
): ShipmentProjectionFragmentInput {
  return {
    ozelKargoTakipNo: payload.ozelKargoTakipNo,
    trendyolCargoTrackingNumber: payload.trendyolCargoTrackingNumber,
    cargoSlipShipmentValues: [
      record.trackingNumber,
      record.barcode,
      payload.shipmentCode,
      payload.trackingNumber,
      payload.kargoTakipNo,
      payload.tNo,
      payload.barkodNo,
      payload.barcodeValue,
      payload.gonderiNo,
      payload.waybillNo,
      payload.irsaliyeNo,
      payload.cargoKey,
    ],
  }
}

/** KAYNAK SAHİPLİK HARİTASI — OPERATION (create/doğrulama sonucu). */
export function operationFragmentInput(
  columns: { trackingNumber?: unknown },
  payload: Record<string, unknown> = {},
): OperationProjectionFragmentInput {
  return {
    cargoSlipOperationValues: [
      columns.trackingNumber,
      payload.carrierTrackingNumber,
      payload.carrierBarcodeNumber,
      payload.candidateTrackingNumber,
      payload.candidateBarcodeNumber,
      payload.ozelKargoTakipNo,
    ],
  }
}

/**
 * Kanonik arama sorgusunu SQL `LIKE` desenine çevirir.
 * `%` ve `_` kaçırılır; eşleşme semantiği `includes` ile aynıdır.
 */
export function buildSearchLikePattern(query: unknown): string | null {
  const token = normalizedSearch(query)
  if (!token) return null
  const escaped = token.replace(/[\\%_]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}
