// SINIRLI DİZE HAFIZASI — saf normalleştiricileri hızlandırır.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
// Ürün kimliği, ürün ailesi anahtarı ve beden adı gibi alanlar bir ICU
// çağrısıyla (`toLocaleLowerCase('tr-TR')`) ve birkaç düzenli ifadeyle
// normalleştirilir. Bu fonksiyonlar sipariş satırı başına, her istekte
// yeniden çağrılır. GERÇEK POSTGRES ÖLÇÜMÜ (25.000 sipariş, gösterge paneli):
// tek başına `normalizeProductIdentifier` CPU'nun %30'unu yiyordu.
//
// Girdi alanı DAR: aynı SKU, aynı ürün adı, aynı beden binlerce kez tekrar
// eder. Bu yüzden dize → dize eşlemesi önbelleğe alınır.
//
// ═══ NEDEN GÜVENLİ ═══════════════════════════════════════════════════════
// Sarılan fonksiyon SAF olmalıdır: aynı dize her zaman aynı sonucu verir.
// Bu durumda önbellek sonucu DEĞİŞTİREMEZ; yalnız tekrar hesabı önler.
//
// ═══ NEDEN SINIRLI ═══════════════════════════════════════════════════════
// Sınırsız bir Map, uzun ömürlü sunucu sürecinde sessizce büyürdü. Sınıra
// ulaşıldığında önbellek TAMAMEN boşaltılır: en kötü durumda bir sonraki
// çağrı yeniden hesaplar — yanlış sonuç ÜRETİLEMEZ.

/** Varsayılan üst sınır: tipik kataloglarda ulaşılmayacak kadar geniş. */
export const DEFAULT_STRING_MEMO_LIMIT = 50_000

export function createStringMemo(
  compute: (raw: string) => string,
  limit: number = DEFAULT_STRING_MEMO_LIMIT,
): (value: unknown) => string {
  const cache = new Map<string, string>()
  return (value: unknown): string => {
    const raw = String(value ?? '')
    const cached = cache.get(raw)
    if (cached !== undefined) return cached
    const result = compute(raw)
    if (cache.size >= limit) cache.clear()
    cache.set(raw, result)
    return result
  }
}
