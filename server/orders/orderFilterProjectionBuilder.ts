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

export interface OrderFilterProjectionInput {
  organizationId: string
  orderId: string
  marketplace?: unknown
  operationStatus?: unknown
  marketplaceStatus?: unknown
  shippingCity?: unknown
  shippingDistrict?: unknown
  orderDate?: unknown
  /** Müşteri arama kaynakları (kanonik filtre ile AYNI üçlü). */
  customerName?: unknown
  customerPhone?: unknown
  customerEmail?: unknown
  /** Sipariş no arama kaynakları (kanonik filtre ile AYNI beşli). */
  orderNumber?: unknown
  externalOrderId?: unknown
  cargoTrackingNumber?: unknown
  ozelKargoTakipNo?: unknown
  trendyolCargoTrackingNumber?: unknown
  /** Kargo fişi arama kaynakları — çağıran ÇÖZÜLMÜŞ değerleri verir. */
  cargoSlipValues?: unknown[]
}

export interface OrderFilterProjectionRow {
  organizationId: string
  orderId: string
  marketplaceToken: string
  operationStatusToken: string
  marketplaceStatus: string
  shippingCityToken: string
  shippingDistrictToken: string
  customerSearchToken: string
  orderNumberSearchToken: string
  cargoSlipSearchToken: string
  orderDate: string | null
  projectionVersion: number
}

/**
 * Tek siparişin kanonik filtre projeksiyonunu üretir.
 *
 * Eşitlik alanları `normalizedToken`, arama alanları `normalizedSearch`
 * kullanır — kanonik filtre hangisini kullanıyorsa O.
 *
 * GİZLİ VERİ TAŞINMAZ: parola/credential/token ve ham şifreli payload bu
 * çıktıya GİRMEZ. `customerSearchToken` arama için gereken müşteri
 * alanlarını içerir (ARANABİLİR PII) — bu alanlar zaten `orders`
 * tablosunda düz kolonlardır, yeni bir hassasiyet sınıfı oluşmaz.
 */
export function buildOrderFilterProjection(
  input: OrderFilterProjectionInput,
): OrderFilterProjectionRow {
  return {
    organizationId: String(input.organizationId),
    orderId: String(input.orderId),
    // Eşitlik → normalizedToken (kanonik filtreyle AYNI)
    marketplaceToken: normalizedToken(input.marketplace),
    operationStatusToken: normalizedToken(input.operationStatus),
    // marketplaceStatus kanonik tarafta EXACT karşılaştırılır; normalize
    // EDİLMEZ, ham değer korunur.
    marketplaceStatus: String(input.marketplaceStatus ?? '').trim(),
    shippingCityToken: normalizedToken(input.shippingCity),
    shippingDistrictToken: normalizedToken(input.shippingDistrict),
    // Contains araması → normalizedSearch + güvenli ayırıcı
    customerSearchToken: buildSearchToken([
      input.customerName,
      input.customerPhone,
      input.customerEmail,
    ]),
    orderNumberSearchToken: buildSearchToken([
      input.orderNumber,
      input.externalOrderId,
      input.cargoTrackingNumber,
      input.ozelKargoTakipNo,
      input.trendyolCargoTrackingNumber,
    ]),
    cargoSlipSearchToken: buildSearchToken(input.cargoSlipValues ?? []),
    orderDate: input.orderDate ? String(input.orderDate) : null,
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
