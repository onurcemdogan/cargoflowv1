// TEK KULLANIMLIK AUTH TOKEN DEPOSU (e-posta doğrulama, şifre sıfırlama).
//
//   · Ham token yalnız çağırana döner (e-posta bağlantısı için); DB'de
//     SHA-256 hash saklanır.
//   · Yeni token verilince aynı amaçlı açık token'lar kapatılır: yalnız EN
//     SON bağlantı çalışır.
//   · Tüketim TEK atomik UPDATE'tir (`consumed_at IS NULL AND expires_at >
//     now`): aynı token'ı eşzamanlı iki istek kullanamaz.
import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { authTokens } from '../db/schema.ts'

export type AuthTokenPurpose = 'email_verification' | 'password_reset'

export const AUTH_TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 30 * 60 * 1000,
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function issueAuthToken(
  db: Db,
  userId: string,
  purpose: AuthTokenPurpose,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db
    .update(authTokens)
    .set({ consumedAt: now })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.consumedAt)))
  await db.insert(authTokens).values({
    userId,
    purpose,
    tokenHash: hashAuthToken(token),
    expiresAt: new Date(now.getTime() + AUTH_TOKEN_TTL_MS[purpose]),
    // Bekleme süresi/hız sınırı aynı saatle karşılaştırılır.
    createdAt: now,
  })
  return token
}

/** Geçerliyse token'ı tüketir ve sahibini döndürür; değilse null. */
export async function consumeAuthToken(
  db: Db,
  token: unknown,
  purpose: AuthTokenPurpose,
  now: Date = new Date(),
): Promise<string | null> {
  const raw = String(token ?? '').trim()
  if (!raw || raw.length > 200) return null
  const rows = await db
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, hashAuthToken(raw)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning({ userId: authTokens.userId })
  return rows[0] ? String(rows[0].userId) : null
}

/** Bu amaçla verilen son token'ın zamanı (yeniden gönderim bekleme süresi). */
export async function lastAuthTokenIssuedAt(
  db: Db,
  userId: string,
  purpose: AuthTokenPurpose,
): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: authTokens.createdAt })
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose)))
    .orderBy(desc(authTokens.createdAt))
    .limit(1)
  return rows[0] ? new Date(String(rows[0].createdAt)) : null
}

/** Pencere içindeki token sayısı (e-posta başına hız sınırı). */
export async function countAuthTokensSince(
  db: Db,
  userId: string,
  purpose: AuthTokenPurpose,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), gt(authTokens.createdAt, since)))
  return Number(rows[0]?.count ?? 0)
}
