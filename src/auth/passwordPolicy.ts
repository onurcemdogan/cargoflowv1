// TEK ortak parola politikası: frontend doğrulaması (UX) ve backend
// doğrulaması (esas) aynı sabiti kullanır; kopuk değerler oluşmaz.
export const MIN_PASSWORD_LENGTH = 6

export function isPasswordLongEnough(password: string): boolean {
  return String(password ?? '').length >= MIN_PASSWORD_LENGTH
}

export const PASSWORD_TOO_SHORT_MESSAGE = `Parola en az ${MIN_PASSWORD_LENGTH} karakter olmalıdır.`

// Herkese açık kayıt ve şifre sıfırlama için daha güçlü alt sınır. Mevcut
// (yönetici açılışlı) hesap akışı ve bootstrap yukarıdaki sınırı korur.
export const SELF_SERVICE_MIN_PASSWORD_LENGTH = 10

export function isSelfServicePasswordAcceptable(password: string): boolean {
  return String(password ?? '').length >= SELF_SERVICE_MIN_PASSWORD_LENGTH
}

export const SELF_SERVICE_PASSWORD_MESSAGE = `Şifre en az ${SELF_SERVICE_MIN_PASSWORD_LENGTH} karakter olmalıdır.`
