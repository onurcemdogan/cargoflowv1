// WOOCOMMERCE SİPARİŞ NORMALLEŞTİRME — SÖZLEŞMEYE SADIK.
//
// Kaynak: providers/woocommerce/contracts/wc-v3.json (kabul edilmiş paket).
// Genel "Woo bilgisi" ile DOLDURULMAZ; paket neyi doğruladıysa o.
//
// ═══ ZAMAN — TRENDYOL KUSURU TEKRARLANMAZ ════════════════════════════════
//
// Paket: `date_created_gmt` / `date_modified_gmt` OFSETSİZ yazılır AMA
// GMT'dir → `Z` eklenerek mutlak ana çevrilir. `date_created` SİTE YEREL
// saatidir ve kanonik an olarak KULLANILMAZ.
//
// Trendyol'da tam olarak bu sınıf hata üretildi: sağlayıcı anı bir kez daha
// +03'e çevrildi ve sipariş saati 3 saat ileri göründü. Burada dönüşüm TEK
// SEFER ve TEK YERDE yapılır. Türkiye ofseti UYGULANMAZ.
//
// ═══ PARA — ONDALIK DİZGİ KORUNUR ════════════════════════════════════════
//
// Paket: `total` ondalık DİZGİDİR. Adaptörde `Number()`a çevirmek ikili
// kayan noktada sessiz yuvarlama üretir ("119.99" → 119.98999...). Sağlayıcı
// gerçeği dizge olarak TAŞINIR; sunum katmanı sonra çevirebilir.
//
// ═══ KİMLİK — ASLA DEĞİŞKEN ALAN ═════════════════════════════════════════
//
// sipariş  : id            (number/name DEĞİL)
// insan ref: number        (yalnız görüntü)
// satır    : line_items[].id
// ürün     : product_id
// varyant  : variation_id
import { assertIdentityFieldIsStable } from '../canonicalIdentity.ts'

/** Paketin doğruladığı ham statüler — anlam YÜKLENMEZ. */
export const WOO_ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
  'trash',
] as const
export type WooOrderStatus = (typeof WOO_ORDER_STATUSES)[number]

/**
 * KANONİK STATÜ EŞLEMESİ — KASITLI OLARAK BOŞ.
 *
 * `completed` "taşıyıcı teslim etti" DEMEK DEĞİLDİR: Woo'da mağaza sahibi
 * siparişi tamamlanmış işaretler, bu kargo olayı değildir. `refunded` da
 * fiziksel iade demek değildir (para iadesi ≠ ürün geri döndü).
 *
 * CargoFlow'da bu anlamlar operasyonel karar üretir; yanlış eşleme yanlış
 * kargo/iade işlemi doğurur. Bu yüzden kanonik eşleme `null` bırakılır ve
 * HAM statü görünür kalır. Eşleme, semantiği KANITLANDIĞINDA eklenir.
 */
export function canonicalStatusForWooStatus(rawStatus: string): null {
  // Parametre KASITLI olarak okunmaz: imza, semantik kanıtlandığında eşleme
  // eklenecek yeri işaret eder. Şu an HER ham statü için `null` döner.
  void rawStatus
  return null
}

export const WOO_NORMALIZATION_REJECTIONS = [
  'MISSING_ORDER_ID',
  'MISSING_CREATED_GMT',
  'MALFORMED_CREATED_GMT',
  'MALFORMED_MODIFIED_GMT',
] as const
export type WooNormalizationRejection =
  (typeof WOO_NORMALIZATION_REJECTIONS)[number]

/** Veri kalitesi bayrakları — EKSİK VERİ UYDURULMAZ, GÖRÜNÜR KILINIR. */
export const WOO_DATA_QUALITY_FLAGS = [
  'PHONE_MISSING',
  'SHIPPING_ADDRESS_MISSING',
  'SHIPPING_NAME_MISSING',
] as const
export type WooDataQualityFlag = (typeof WOO_DATA_QUALITY_FLAGS)[number]

export interface WooNormalizedLine {
  externalLineId: string
  productId: string
  variantId: string | null
  name: string
  sku: string
  quantity: number
  /** Ondalık DİZGİ — sağlayıcı gerçeği. */
  totalDecimal: string
  priceDecimal: string
}

export interface WooNormalizedOrder {
  marketplace: 'WooCommerce'
  externalOrderId: string
  packageId: string
  orderNumber: string
  rawStatus: string
  canonicalStatus: null
  /** Mutlak an (ISO, UTC) — `date_created_gmt` + Z. */
  orderDate: string
  /** Mutlak an (ISO, UTC) — `date_modified_gmt` + Z; yoksa null. */
  marketplaceLastModifiedAt: string | null
  currency: string
  /** Ondalık DİZGİ. */
  totalDecimal: string
  customerName: string
  customerEmail: string
  customerPhone: string
  shippingAddress: Record<string, unknown>
  city: string
  district: string
  /** Woo ÇEKİRDEĞİNDE takip sözleşmesi YOKTUR. */
  marketplaceTrackingNumber: null
  marketplaceCarrier: null
  dataQualityFlags: WooDataQualityFlag[]
  lines: WooNormalizedLine[]
  rawOrder: Record<string, unknown>
}

export interface WooNormalizationSuccess {
  ok: true
  order: WooNormalizedOrder
}
export interface WooNormalizationFailure {
  ok: false
  rejection: WooNormalizationRejection
  /** Tanı için kararlı kimlik (varsa) — PII DEĞİL. */
  externalOrderId: string | null
}
export type WooNormalizationResult =
  | WooNormalizationSuccess
  | WooNormalizationFailure

/**
 * GMT alanını MUTLAK ANA çevirir — TAM BİR KEZ.
 *
 * Woo GMT alanı `2026-09-18T10:20:30` biçimindedir (ofset YOK) ama değer
 * GMT'dir. `new Date(...)` bu dizgeyi ortam saat dilimine göre yorumlardı →
 * sunucu Europe/Istanbul ise 3 saat KAYARDI. Bu yüzden `Z` AÇIKÇA eklenir.
 *
 * Zaten ofset taşıyan bir değer gelirse (sözleşme dışı ama savunmacı) ikinci
 * kez `Z` EKLENMEZ.
 */
export function wooGmtToInstant(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  const candidate = hasZone ? text : `${text}Z`
  const ms = Date.parse(candidate)
  // BOZUK TARİH SESSİZCE EPOCH OLMAZ: null döner, çağıran reddeder.
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Para: ondalık dizgi KORUNUR; sayıya çevrilmez. */
function decimalString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function normalizeLines(raw: unknown): WooNormalizedLine[] {
  if (!Array.isArray(raw)) return []
  const lines: WooNormalizedLine[] = []
  for (const item of raw) {
    const record = (item ?? {}) as Record<string, unknown>
    const lineId = text(record.id)
    // Satır kimliği YOKSA satır UYDURULMAZ — atlanır ve sayım düşer.
    if (lineId === '') continue
    const variationId = text(record.variation_id)
    lines.push({
      externalLineId: lineId,
      productId: text(record.product_id),
      // Woo'da 0 "varyant yok" demektir; sahte varyant üretilmez.
      variantId: variationId === '' || variationId === '0' ? null : variationId,
      name: text(record.name),
      sku: text(record.sku),
      quantity: Number(record.quantity ?? 0),
      totalDecimal: decimalString(record.total),
      priceDecimal: decimalString(record.price),
    })
  }
  return lines
}

/**
 * TEK Woo siparişini normalleştirir.
 *
 * Zorunlu alan eksik/bozuksa SESSİZ VARSAYILAN ÜRETİLMEZ; açık ret döner ve
 * çağıran karantinaya alır.
 */
export function normalizeWooOrder(rawOrder: unknown): WooNormalizationResult {
  const record = (rawOrder ?? {}) as Record<string, unknown>

  // Kimlik alanı seçimi denetlenir: 'name'/'title' gibi değişken alan
  // kimlik olarak seçilirse burada DERHAL patlar.
  assertIdentityFieldIsStable('id')

  const externalOrderId = text(record.id)
  if (externalOrderId === '' || externalOrderId === '0') {
    return { ok: false, rejection: 'MISSING_ORDER_ID', externalOrderId: null }
  }

  // ═══ KANONİK AN YALNIZ GMT ALANINDAN ═══════════════════════════════
  // `date_created` (site yerel) BURADA HİÇ OKUNMAZ.
  const createdRaw = record.date_created_gmt
  if (text(createdRaw) === '') {
    return { ok: false, rejection: 'MISSING_CREATED_GMT', externalOrderId }
  }
  const orderDate = wooGmtToInstant(createdRaw)
  if (orderDate === null) {
    return { ok: false, rejection: 'MALFORMED_CREATED_GMT', externalOrderId }
  }

  let marketplaceLastModifiedAt: string | null = null
  if (text(record.date_modified_gmt) !== '') {
    marketplaceLastModifiedAt = wooGmtToInstant(record.date_modified_gmt)
    if (marketplaceLastModifiedAt === null) {
      return { ok: false, rejection: 'MALFORMED_MODIFIED_GMT', externalOrderId }
    }
  }

  const billing = (record.billing ?? {}) as Record<string, unknown>
  const shipping = (record.shipping ?? {}) as Record<string, unknown>

  // ═══ TELEFON — SÖZLEŞME GERÇEĞİ ════════════════════════════════════
  // Paket açıkça söyler: `shipping` bloğunda TELEFON YOKTUR. `shipping.phone`
  // UYDURULMAZ; sözleşmenin doğruladığı `billing.phone` kullanılır.
  const customerPhone = text(billing.phone)

  const shippingName = `${text(shipping.first_name)} ${text(shipping.last_name)}`.trim()
  const billingName = `${text(billing.first_name)} ${text(billing.last_name)}`.trim()
  const shippingAddress1 = text(shipping.address_1)

  const dataQualityFlags: WooDataQualityFlag[] = []
  if (customerPhone === '') dataQualityFlags.push('PHONE_MISSING')
  if (shippingAddress1 === '') dataQualityFlags.push('SHIPPING_ADDRESS_MISSING')
  if (shippingName === '') dataQualityFlags.push('SHIPPING_NAME_MISSING')

  return {
    ok: true,
    order: {
      marketplace: 'WooCommerce',
      externalOrderId,
      // Woo ÇEKİRDEĞİNDE "gönderi paketi" kavramı YOKTUR; kararlı sipariş
      // id'si paket anahtarı olarak kullanılır. Sahte paket semantiği
      // ÜRETİLMEZ.
      packageId: externalOrderId,
      // `number` İNSAN REFERANSIDIR; kimlik DEĞİLDİR.
      orderNumber: text(record.number) || externalOrderId,
      rawStatus: text(record.status),
      canonicalStatus: canonicalStatusForWooStatus(text(record.status)),
      orderDate,
      marketplaceLastModifiedAt,
      currency: text(record.currency),
      totalDecimal: decimalString(record.total),
      customerName: shippingName || billingName,
      customerEmail: text(billing.email),
      customerPhone,
      shippingAddress: shipping,
      city: text(shipping.city),
      district: text(shipping.state),
      // Çekirdek Woo'da takip alanı YOK; eklenti alanı OKUNMAZ, meta_data'dan
      // TAHMİN EDİLMEZ.
      marketplaceTrackingNumber: null,
      marketplaceCarrier: null,
      dataQualityFlags,
      lines: normalizeLines(record.line_items),
      rawOrder: record,
    },
  }
}

export interface WooBatchNormalization {
  orders: WooNormalizedOrder[]
  rejected: WooNormalizationFailure[]
  duplicateRemovedCount: number
}

/**
 * Sayfa/parti normalleştirme + KARARLI KİMLİKLE tekilleştirme.
 *
 * Aynı `id` iki sayfada görünürse (sayfalama sırasında sipariş eklenmesi
 * kaymaya yol açar) TEK kayıt kalır. Görüntü numarası aynı ama id farklıysa
 * AYRI siparişlerdir ve İKİSİ DE korunur.
 */
export function normalizeWooOrders(rawOrders: unknown): WooBatchNormalization {
  const list = Array.isArray(rawOrders) ? rawOrders : []
  const byId = new Map<string, WooNormalizedOrder>()
  const rejected: WooNormalizationFailure[] = []
  let duplicateRemovedCount = 0

  for (const raw of list) {
    const result = normalizeWooOrder(raw)
    if (!result.ok) {
      rejected.push(result)
      continue
    }
    if (byId.has(result.order.externalOrderId)) {
      duplicateRemovedCount += 1
      // Aynı id tekrar geldiyse SON görülen kazanır (daha yeni sayfa).
      byId.set(result.order.externalOrderId, result.order)
      continue
    }
    byId.set(result.order.externalOrderId, result.order)
  }

  return {
    orders: [...byId.values()],
    rejected,
    duplicateRemovedCount,
  }
}
