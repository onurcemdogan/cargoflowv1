// TEK ortak parola politikası: frontend doğrulaması (UX) ve backend
// doğrulaması (esas) aynı sabiti kullanır; kopuk değerler oluşmaz.
export const MIN_PASSWORD_LENGTH = 6

export function isPasswordLongEnough(password: string): boolean {
  return String(password ?? '').length >= MIN_PASSWORD_LENGTH
}

export const PASSWORD_TOO_SHORT_MESSAGE = `Parola en az ${MIN_PASSWORD_LENGTH} karakter olmalıdır.`
