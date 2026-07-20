// Platform admin oturumları — organization session'larından TAMAMEN AYRI.
// Ayrı cookie (cargoflow_admin_session), ayrı tablo (platform_admin_sessions).
// Cookie'ye ham token; DB'de yalnız SHA-256 tokenHash. Organization
// cargoflow_session cookie'si admin erişimi SAĞLAMAZ (bu modül onu okumaz).
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { platformAdmins, platformAdminSessions } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AdminDb = any

export const DEFAULT_ADMIN_SESSION_COOKIE = 'cargoflow_admin_session'

export function adminSessionCookieName(): string {
  return (
    String(process.env.CARGOFLOW_ADMIN_SESSION_COOKIE ?? '').trim() ||
    DEFAULT_ADMIN_SESSION_COOKIE
  )
}

export function adminSessionDurationMs(): number {
  const days = Number(process.env.ADMIN_SESSION_DAYS ?? 1)
  const safeDays = Number.isFinite(days) && days > 0 ? days : 1
  return safeDays * 24 * 60 * 60 * 1000
}

export function hashAdminSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface CreatedAdminSession {
  token: string
  expiresAt: Date
}

export async function createAdminSession(
  db: AdminDb,
  adminId: string,
): Promise<CreatedAdminSession> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + adminSessionDurationMs())
  await db
    .insert(platformAdminSessions)
    .values({ adminId, tokenHash: hashAdminSessionToken(token), expiresAt })
    .returning()
  return { token, expiresAt }
}

export interface ActiveAdminContext {
  sessionId: string
  adminId: string
  username: string
}

// Geçerli (expired/revoked olmayan) admin session + aktif admin.
export async function findActiveAdminSession(
  db: AdminDb,
  token: string,
): Promise<ActiveAdminContext | null> {
  if (!token) return null
  const tokenHash = hashAdminSessionToken(token)
  const rows = await db
    .select({
      sessionId: platformAdminSessions.id,
      expiresAt: platformAdminSessions.expiresAt,
      adminId: platformAdmins.id,
      username: platformAdmins.username,
      adminStatus: platformAdmins.status,
    })
    .from(platformAdminSessions)
    .innerJoin(
      platformAdmins,
      eq(platformAdminSessions.adminId, platformAdmins.id),
    )
    .where(
      and(
        eq(platformAdminSessions.tokenHash, tokenHash),
        isNull(platformAdminSessions.revokedAt),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const expiresAt = new Date(String(row.expiresAt))
  if (!(expiresAt.getTime() > Date.now())) return null
  if (String(row.adminStatus) !== 'active') return null
  return {
    sessionId: String(row.sessionId),
    adminId: String(row.adminId),
    username: String(row.username),
  }
}

export async function revokeAdminSessionByToken(
  db: AdminDb,
  token: string,
): Promise<void> {
  await db
    .update(platformAdminSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(platformAdminSessions.tokenHash, hashAdminSessionToken(token)),
        isNull(platformAdminSessions.revokedAt),
      ),
    )
}

// Bir admin'in TÜM aktif oturumlarını sonlandırır (parola reset sonrası).
export async function revokeAllAdminSessions(
  db: AdminDb,
  adminId: string,
): Promise<void> {
  await db
    .update(platformAdminSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(platformAdminSessions.adminId, adminId),
        isNull(platformAdminSessions.revokedAt),
      ),
    )
}

export async function touchAdminSession(
  db: AdminDb,
  sessionId: string,
): Promise<void> {
  await db
    .update(platformAdminSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(platformAdminSessions.id, sessionId))
}
