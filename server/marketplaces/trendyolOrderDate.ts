// TRENDYOL ZAMAN DAMGASI SÖZLEŞMESİ — SAĞLAYICIYA ÖZEL SINIR.
//
// ═══ RESMÎ SÖZLEŞME ══════════════════════════════════════════════════════
//
// developers.trendyol.com — v3.0 "Get Shipment Packages" (güncel, v2 uç
// noktası: `/integration/order/sellers/{sellerId}/v2/orders`):
//
//   "The orderDate is in timestamp (milliseconds) format GMT +3,
//    while createdDate is in GMT format."
//
// Yani `orderDate` SIRADAN BİR UTC EPOCH DEĞİLDİR: sayı, İstanbul DUVAR
// SAATİ sanki UTC'ymiş gibi kodlanmıştır. `createdDate` ise düz GMT'dir.
// İki alan AYNI dönüşümden geçirilemez.
//
// ═══ ÖLÇÜLEN ÜRETİM KUSURU ═══════════════════════════════════════════════
//
// CargoFlow `orderDate`'i düz UTC epoch sayıyor, sonra etiket formatlayıcısı
// onu Europe/Istanbul'a çeviriyordu. Sonuç: +03 İKİ KEZ uygulanıyordu.
//
//   ham orderDate            1789418160000
//   new Date(raw).toISO()    2026-09-14T20:36:00.000Z
//   Trendyol duvar saati     14.09.2026 20:36   ← DOĞRU olan
//   eski etiket çıktısı      14.09.2026 23:36   ← ÜRETİMDE GÖRÜLEN
//
// ═══ NEDEN BURADA, NEDEN FORMATLAYICIDA DEĞİL ════════════════════════════
//
// `formatLabelOrderDateTime` SAĞLAYICIDAN BAĞIMSIZDIR ve sözleşmesi
// "gerçek UTC anı → Europe/Istanbul duvar saati"dir. Oraya −3 saat koymak,
// Trendyol'un tuhaflığını Hepsiburada'ya, n11'e ve gelecekteki her kaynağa
// BULAŞTIRIRDI. Düzeltme, tuhaflığın DOĞDUĞU yerde — sağlayıcı
// normalizasyon sınırında — yapılır; kanonik `orders.order_date` bundan
// sonra GERÇEK MUTLAK ANDIR ve aşağı akış olduğu gibi kalır.
//
// ═══ KAPSAM ══════════════════════════════════════════════════════════════
//
// Bu dönüşüm YALNIZ `orderDate` içindir. Belgelenmemiş alanlara (
// `lastModifiedDate`, `agreedDeliveryDate`, `estimatedDelivery*`,
// `originShipmentDate`, `packageHistories[].createdDate`) UYGULANMAZ:
// resmî doküman onların saat dilimini BELİRTMEZ ve belirtilmemiş bir şeyi
// varsaymak, düzelttiğimiz kusurun aynısını üretmek olurdu.

/**
 * Trendyol `orderDate` alanının UTC'ye göre ofseti (dakika).
 *
 * SABİT +03: Türkiye 2016'dan beri kalıcı GMT+3 kullanır (yaz saati YOK),
 * ve sözleşme zaten "GMT +3" demektedir — yani değer, gözlem tarihindeki
 * yerel kurallara göre DEĞİL, sabit ofsete göre kodlanır.
 */
export const TRENDYOL_ORDER_DATE_OFFSET_MINUTES = 180

/** Resmî dokümanda saat dilimi AÇIKÇA belirtilen alanlar. */
export const TRENDYOL_TIMESTAMP_CONTRACT = {
  /** GMT+3 epoch ms — düzeltme GEREKİR. */
  orderDate: 'GMT+3',
  /** Düz GMT — düzeltme UYGULANMAZ. */
  createdDate: 'GMT',
} as const

/** `Z` ya da `±HH:MM` taşıyan, yani MUTLAK olan dizgi. */
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i

function fromEpochMs(ms: number, offsetMinutes: number): string {
  return new Date(ms - offsetMinutes * 60_000).toISOString()
}

/**
 * Trendyol `orderDate` → GERÇEK mutlak an (ISO 8601, UTC).
 *
 * Girdi biçimleri:
 *
 *   · SAYI (sözleşmenin belgelediği biçim) → GMT+3 epoch kabul edilir ve
 *     −3 saat uygulanır. Asıl düzeltme budur.
 *   · AÇIK OFSETLİ dizgi (`...Z`, `...+03:00`) → ZATEN mutlaktır, DOKUNULMAZ.
 *     Ofseti olan bir değere ayrıca −3 uygulamak yeni bir çift dönüşüm olurdu.
 *   · OFSETSİZ (naive) dizgi → sağlayıcı sözleşmesi gereği İstanbul duvar
 *     saati sayılır. SUNUCUNUN YEREL SAATİ KULLANILMAZ: `new Date('...')`
 *     naive dizgiyi sunucu yerelinde çözer ve sonuç makineye göre DEĞİŞİRDİ.
 *   · Boş/çözülemeyen → boş dizgi (çağıranın mevcut sözleşmesi).
 */
export function normalizeTrendyolOrderDate(value: unknown): string {
  if (value == null || value === '') return ''

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? fromEpochMs(value, TRENDYOL_ORDER_DATE_OFFSET_MINUTES)
      : ''
  }

  const text = String(value).trim()
  if (text === '') return ''

  // Salt sayısal dizgi = epoch ms (bazı yollar sayıyı dizgi taşır).
  if (/^-?\d+$/.test(text)) {
    const ms = Number(text)
    return Number.isFinite(ms)
      ? fromEpochMs(ms, TRENDYOL_ORDER_DATE_OFFSET_MINUTES)
      : ''
  }

  if (EXPLICIT_OFFSET.test(text)) {
    const ms = Date.parse(text)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
  }

  // Naive dizgi: İstanbul duvar saati olarak yorumlanır. `Date.parse` ile
  // `Z` eklenmiş hâli UTC olarak çözülür, ardından ofset düşülür — böylece
  // sonuç SUNUCU SAAT DİLİMİNDEN BAĞIMSIZDIR.
  const asUtc = Date.parse(`${text.replace(' ', 'T')}Z`)
  return Number.isFinite(asUtc)
    ? fromEpochMs(asUtc, TRENDYOL_ORDER_DATE_OFFSET_MINUTES)
    : ''
}

/**
 * Trendyol'un DÜZ GMT alanları (ör. `createdDate`) → mutlak an.
 *
 * Kaydırma UYGULANMAZ. Bu fonksiyon, `orderDate` düzeltmesinin bu alanlara
 * SIZMADIĞINI sözleşme düzeyinde görünür kılar; iki alanın anlamı resmî
 * dokümanda FARKLIDIR ve bu fark testlerle sabitlenir.
 */
export function normalizeTrendyolGmtTimestamp(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : ''
  }
  const text = String(value).trim()
  if (text === '') return ''
  if (/^-?\d+$/.test(text)) {
    const ms = Number(text)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
  }
  const ms = Date.parse(EXPLICIT_OFFSET.test(text) ? text : `${text.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}
