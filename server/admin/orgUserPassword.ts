// Organization kullanıcısı parola sıfırlama çekirdeği (CLI + test edilebilir).
// Login akışının kullandığı AYNI hashPassword (argon2id) ile yazar; böylece
// verifyPassword biçim uyumsuzluğu OLUŞMAZ. Sıfırlama sonrası kullanıcının aktif
// oturumları revoke edilir. Düz parola/hash ASLA loglanmaz/döndürülmez.
// Auth/tenant kuralları DEĞİŞMEZ: yalnız users.password_hash güncellenir.
import { eq } from 'drizzle-orm'
import { users } from '../db/schema.ts'
import { isPasswordLongEnough } from '../../src/auth/passwordPolicy.ts'
import { hashPassword } from '../auth/password.ts'
import { revokeUserSessions, updateUserPasswordHash } from './adminRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface OrgUserPasswordResetResult {
  username: string
  userId: string
  organizationId: string
  userStatus: string
  // Yalnız UZUNLUK raporlanır (hash'in kendisi DEĞİL) — bozuk/kesik hash teşhisi
  // için güvenli gösterge. Geçerli argon2id hash 97 karakterdir.
  previousHashLength: number
  newHashLength: number
  revokedSessions: number
}

export async function resetOrganizationUserPassword(
  db: Db,
  usernameRaw: string,
  password: string,
): Promise<OrgUserPasswordResetResult> {
  // Login ile aynı normalizasyon (küçük harf, trim).
  const username = String(usernameRaw ?? '').trim().toLowerCase()
  if (!username) throw new Error('username zorunludur.')
  if (!isPasswordLongEnough(password)) {
    throw new Error('Parola çok kısa (minimum parola kuralını sağlamıyor).')
  }
  const rows = await db
    .select({
      id: users.id,
      organizationId: users.organizationId,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1)
  if (rows.length === 0) {
    throw new Error(`'${username}' kullanıcı adlı organization kullanıcısı bulunamadı.`)
  }
  const user = rows[0]
  const previousHashLength = String(user.passwordHash ?? '').length
  const passwordHash = await hashPassword(password)
  await updateUserPasswordHash(db, String(user.id), passwordHash)
  // Güvenlik: parola değişince eski oturumlar geçersizleşir.
  const revokedSessions = await revokeUserSessions(db, String(user.id))
  return {
    username,
    userId: String(user.id),
    organizationId: String(user.organizationId),
    userStatus: String(user.status),
    previousHashLength,
    newHashLength: passwordHash.length,
    revokedSessions,
  }
}
