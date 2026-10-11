// TEK ortak e-posta politikası: ön yüz (UX) ve sunucu (esas) aynı kuralı
// kullanır. Normalleştirme yalnız trim + küçük harf; sağlayıcıya özel
// yeniden yazım (nokta/artı kaldırma) YAPILMAZ.
export function normalizeEmail(value: string): string {
  return String(value ?? '').trim().toLowerCase()
}

export function isPlausibleEmail(normalized: string): boolean {
  if (normalized.length < 3 || normalized.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
}
