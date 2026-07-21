// Platform admin hesap işlemleri (CLI çekirdeği; test edilebilir). Düz parola
// veya hash ASLA loglanmaz/döndürülmez. İlk admin yalnız buradan (CLI) oluşur;
// public HTTP endpoint YOKTUR. Oluşturma otomatik session AÇMAZ.
import { eq } from 'drizzle-orm'
import { platformAdmins } from '../db/schema.ts'
import { isPasswordLongEnough } from '../../src/auth/passwordPolicy.ts'
import { hashPassword } from '../auth/password.ts'
import { revokeAllAdminSessions } from './adminSession.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function normalizeUsername(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

// Yeni platform admin oluşturur. Aynı username varsa hata; parola politikası
// (ortak sabit) uygulanır; argon2id hash saklanır; session OLUŞTURMAZ.
export async function createPlatformAdmin(
  db: Db,
  usernameRaw: string,
  password: string,
): Promise<{ adminId: string; username: string }> {
  const username = normalizeUsername(usernameRaw)
  if (!username) throw new Error('username zorunludur.')
  if (!isPasswordLongEnough(password)) {
    throw new Error('Parola çok kısa (minimum parola kuralını sağlamıyor).')
  }
  const existing = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.username, username))
    .limit(1)
  if (existing.length > 0) {
    throw new Error(`'${username}' kullanıcı adlı platform admin zaten var.`)
  }
  const passwordHash = await hashPassword(password)
  const [admin] = await db
    .insert(platformAdmins)
    .values({ username, passwordHash, status: 'active' })
    .returning({ id: platformAdmins.id })
  return { adminId: String(admin.id), username }
}

// Mevcut admin parolasını günceller (argon2id) ve TÜM admin session'larını
// revoke eder. Admin yoksa hata.
// Oluşturma/sıfırlama sonrası DOĞRULAMA: kaydın gerçekten yazıldığını ve
// hash'in geçerli uzunlukta olduğunu raporlar. Hash'in KENDİSİ dönmez.
// (Geçerli argon2id hash = 97 karakter.)
export async function describePlatformAdmin(
  db: Db,
  usernameRaw: string,
): Promise<{ username: string; status: string; hashLength: number } | null> {
  const username = normalizeUsername(usernameRaw)
  const rows = await db
    .select({
      username: platformAdmins.username,
      status: platformAdmins.status,
      passwordHash: platformAdmins.passwordHash,
    })
    .from(platformAdmins)
    .where(eq(platformAdmins.username, username))
    .limit(1)
  if (rows.length === 0) return null
  return {
    username: String(rows[0].username),
    status: String(rows[0].status),
    hashLength: String(rows[0].passwordHash ?? '').length,
  }
}

export async function resetPlatformAdminPassword(
  db: Db,
  usernameRaw: string,
  password: string,
): Promise<{ adminId: string; username: string }> {
  const username = normalizeUsername(usernameRaw)
  if (!username) throw new Error('username zorunludur.')
  if (!isPasswordLongEnough(password)) {
    throw new Error('Parola çok kısa (minimum parola kuralını sağlamıyor).')
  }
  const rows = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.username, username))
    .limit(1)
  if (rows.length === 0) {
    throw new Error(`'${username}' kullanıcı adlı platform admin bulunamadı.`)
  }
  const adminId = String(rows[0].id)
  const passwordHash = await hashPassword(password)
  await db
    .update(platformAdmins)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(platformAdmins.id, adminId))
  await revokeAllAdminSessions(db, adminId)
  return { adminId, username }
}
