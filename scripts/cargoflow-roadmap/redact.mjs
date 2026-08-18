// Sır maskeleme — rapor/stdout'a asla ham kimlik bilgisi düşmez.

/** Değeri maskelenecek anahtar adları (küçük harfe indirgenmiş arama). */
export const SECRET_KEY_HINTS = [
  'password', 'sifre', 'şifre', 'secret', 'apikey', 'apisecret',
  'authorization', 'credential', 'token', 'webpassword',
]

const MASK = '«REDACTED»'

/**
 * Serbest metin içindeki `anahtar=değer` / `"anahtar":"değer"` çiftlerini maskeler.
 * Maskelenmiş hesap kodları (maskedAccount) korunur — sır değildir.
 */
export function redactText(input) {
  let text = String(input ?? '')
  for (const hint of SECRET_KEY_HINTS) {
    // "sifre":"..."  ·  sifre=...  ·  sifre: ...
    text = text.replace(
      new RegExp(`("?${hint}"?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;}]+)`, 'gi'),
      (_m, head) => `${head}${MASK}`,
    )
  }
  return text
}

/** Nesneleri derinlemesine maskeler; anahtar adı ipucu içeriyorsa değeri gider. */
export function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      const lowered = key.toLowerCase()
      const isSecret = SECRET_KEY_HINTS.some((hint) => lowered.includes(hint))
      // maskedAccount gibi zaten maskeli alanlar korunur.
      out[key] = isSecret && !lowered.includes('masked') ? MASK : redactValue(inner)
    }
    return out
  }
  if (typeof value === 'string') return redactText(value)
  return value
}
