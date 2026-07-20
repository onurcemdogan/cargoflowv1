// Parola hashleme: Argon2id. Düz parola asla loglanmaz/saklanmaz; bu modül
// yalnız hash üretir ve doğrular.
import argon2 from 'argon2'

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (OWASP önerisi)
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    // Bozuk/eski hash biçimi doğrulama hatası olarak ele alınır; detay
    // sızdırılmaz.
    return false
  }
}
