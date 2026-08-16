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
    orderDate: input.orderDate ?? null,
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
 * Kanonik arama sorgusunu SQL `LIKE` desenine çevirir.
 * `%` ve `_` kaçırılır; eşleşme semantiği `includes` ile aynıdır.
 */
export function buildSearchLikePattern(query: unknown): string | null {
  const token = normalizedSearch(query)
  if (!token) return null
  const escaped = token.replace(/[\\%_]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}
