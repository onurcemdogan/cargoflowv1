// ETİKETTEKİ SİPARİŞ TARİH-SAATİ — TEK BİÇİMLENDİRİCİ (SAF).
//
// ═══ HANGİ ZAMAN? (forensic) ═════════════════════════════════════════════
// Etikete basılan zaman, PAZARYERİNDE SİPARİŞİN OLUŞTUĞU andır. Baskı anı
// DEĞİL, CargoFlow'un siparişi ilk gördüğü an DEĞİL.
//
// Kanonik zincir depoda şöyle kurulmuştur:
//
//   1. Pazaryeri ham alanı     `item.orderDate`   → epoch MİLİSANİYE (sayı)
//   2. `toIsoDate` (index.mjs) → `new Date(ms).toISOString()`
//                              → UTC ANI, offset-aware (`...Z`)
//   3. Kalıcı kolon            `orders.order_date timestamp WITH TIME ZONE`
//                              (`server/db/schema.ts`, NOT NULL)
//   4. Geri okuma              `orderMapper` → aynı ISO
//
// ═══ KULLANILMAYACAK ALANLAR ═════════════════════════════════════════════
//   · `orders.first_seen_at`  → `.defaultNow()`; CargoFlow'un paketi İLK
//     GÖRDÜĞÜ an, yani SENKRON zamanı. Sipariş zamanı DEĞİLDİR.
//   · `orders.last_seen_at`   → aynı sınıf.
//   · Baskı anı / `new Date()` → etiket ne zaman basılırsa o değişirdi;
//     aynı siparişin iki kopyası FARKLI zaman gösterirdi.
//   · Tarayıcının yazdırma üstbilgisindeki tarih → o Chrome'un kendi
//     kabuğudur, etiketin içeriği DEĞİLDİR.
//
// `orders` tablosunda pazaryeri sipariş zamanını taşıyan BAŞKA kolon
// yoktur; bu yüzden kaynak tektir ve seçim belirsiz değildir.
//
// ═══ ZAMAN DİLİMİ — ÇİFT DÖNÜŞÜM YOK ═════════════════════════════════════
// Kaynak zaten offset-aware bir ANDIR (UTC). Bu yüzden "önce yerelleştir
// sonra kaydır" YAPILMAZ: an, TEK adımda Europe/Istanbul duvar saatine
// çevrilir. Ofset bilgisi taşımayan (naive) bir dizgi gelirse ne olduğu
// BİLİNMEDİĞİ için alan çizilmez — uydurma saat basmaktansa boş bırakmak
// doğrudur.

/** Etiket ve dökümde kullanılan biçim. */
export const LABEL_ORDER_DATETIME_PATTERN = 'DD.MM.YYYY HH:mm'

/** Operasyonun çalıştığı zaman dilimi. */
export const LABEL_ORDER_TIMEZONE = 'Europe/Istanbul'

/**
 * Kaynak değer, ZAMAN DİLİMİ BİLGİSİ TAŞIYAN bir an mı?
 *
 * Kabul edilenler:
 *   · `Date` örneği              (mutlak an)
 *   · epoch milisaniye (sayı)    (mutlak an)
 *   · `Z` veya `±HH:MM` ile biten ISO dizgisi
 *
 * Reddedilen: `2026-09-12 21:28` gibi NAIVE dizgi. Hangi dilimde olduğu
 * bilinmeden çevrilirse saat sessizce kayar.
 */
export function isOffsetAwareInstant(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime())
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text) return false
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) return false
  return Number.isFinite(Date.parse(text))
}

function toInstant(value: unknown): Date | null {
  if (!isOffsetAwareInstant(value)) return null
  const date =
    value instanceof Date
      ? value
      : new Date(typeof value === 'number' ? value : String(value))
  return Number.isFinite(date.getTime()) ? date : null
}

/**
 * `DD.MM.YYYY HH:mm` — Europe/Istanbul duvar saati.
 *
 * Çözülemeyen/naive değer için BOŞ dize döner; çağıran alanı çizmez.
 */
export function formatLabelOrderDateTime(
  value: unknown,
  timeZone: string = LABEL_ORDER_TIMEZONE,
): string {
  const instant = toInstant(value)
  if (!instant) return ''
  try {
    // TEK dönüşüm: mutlak an → hedef dilimin duvar saati.
    const parts = new Intl.DateTimeFormat('tr-TR', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(instant)
    const pick = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? ''
    const day = pick('day')
    const month = pick('month')
    const year = pick('year')
    const hour = pick('hour')
    const minute = pick('minute')
    if (!day || !month || !year || !hour || !minute) return ''
    // `hour12: false` bazı ortamlarda gece yarısını `24` verir; duvar saati
    // gösteriminde bu `00` olmalıdır.
    const normalizedHour = hour === '24' ? '00' : hour
    return `${day}.${month}.${year} ${normalizedHour}:${minute}`
  } catch {
    // Zaman dilimi verisi yoksa UYDURMA saat basılmaz.
    return ''
  }
}
