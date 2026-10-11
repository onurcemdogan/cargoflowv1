// PostgreSQL tabanlı opak session'lar. Cookie'ye HAM token yazılır; DB'de
// yalnız SHA-256 tokenHash saklanır (ham token asla DB'ye/loga girmez).
// db parametresi dependency-injection ile gelir (hermetik testlerde pglite).
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { organizations, sessions, users } from '../db/schema.ts'

// Şema tipleriyle uyumlu minimal drizzle arayüzü (node-postgres veya pglite).
// Erasable-syntax kısıtı nedeniyle geniş generic yerine yapısal tip kullanılır.
export interface AuthDb {
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => {
      returning: () => Promise<Record<string, unknown>[]>
    }
  }
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => Promise<unknown>
    }
  }
  select: (fields?: Record<string, unknown>) => unknown
}

export const DEFAULT_SESSION_COOKIE = 'cargoflow_session'

export function sessionCookieName(): string {
  return (
    String(process.env.CARGOFLOW_SESSION_COOKIE ?? '').trim() ||
    DEFAULT_SESSION_COOKIE
  )
}

export function sessionDurationMs(): number {
  const days = Number(process.env.AUTH_SESSION_DAYS ?? 7)
  const safeDays = Number.isFinite(days) && days > 0 ? days : 7
  return safeDays * 24 * 60 * 60 * 1000
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface CreatedSession {
  token: string
  expiresAt: Date
}

// `organizationId` null: workspace'i henüz olmayan (doğrulanmış) kullanıcı.
export async function createSession(
  db: AuthDb,
  userId: string,
  organizationId: string | null,
): Promise<CreatedSession> {
  // En az 32 byte rastgele opak token; imza gerekmez (DB hash kontrolü var).
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionDurationMs())
  await db
    .insert(sessions)
    .values({
      userId,
      organizationId,
      tokenHash: hashSessionToken(token),
      expiresAt,
    })
    .returning()
  return { token, expiresAt }
}

export interface ActiveSessionContext {
  sessionId: string
  userId: string
  /** null → workspace yok; kiracı uçları bu oturumu REDDEDER. */
  organizationId: string | null
  /** Gösterim adı: kullanıcı adı, yoksa e-posta. */
  username: string
  email: string | null
  organizationName: string | null
  organizationSlug: string | null
}

// Geçerli (expired/revoked olmayan) session + aktif user + (varsa) aktif
// organization. Organizasyonlu oturumun kuralları DEĞİŞMEDİ: organizasyon
// pasifse oturum geçersizdir.
export async function findActiveSession(
  db: AuthDb,
  token: string,
): Promise<ActiveSessionContext | null> {
  const tokenHash = hashSessionToken(token)
  const query = db.select({
    sessionId: sessions.id,
    expiresAt: sessions.expiresAt,
    userId: users.id,
    username: users.username,
    email: users.email,
    userStatus: users.status,
    organizationId: organizations.id,
    organizationName: organizations.name,
    organizationSlug: organizations.slug,
    organizationStatus: organizations.status,
  }) as {
    from: (table: unknown) => {
      innerJoin: (
        table: unknown,
        condition: unknown,
      ) => {
        leftJoin: (
          table: unknown,
          condition: unknown,
        ) => {
          where: (condition: unknown) => {
            limit: (count: number) => Promise<Record<string, unknown>[]>
          }
        }
      }
    }
  }
  const rows = await query
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(organizations, eq(sessions.organizationId, organizations.id))
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const expiresAt = new Date(String(row.expiresAt))
  if (!(expiresAt.getTime() > Date.now())) return null
  if (String(row.userStatus) !== 'active') return null
  const hasOrganization = row.organizationId != null
  if (hasOrganization && String(row.organizationStatus) !== 'active') return null
  const email = row.email == null ? null : String(row.email)
  return {
    sessionId: String(row.sessionId),
    userId: String(row.userId),
    organizationId: hasOrganization ? String(row.organizationId) : null,
    username: row.username == null ? (email ?? '') : String(row.username),
    email,
    organizationName: hasOrganization ? String(row.organizationName) : null,
    organizationSlug: hasOrganization ? String(row.organizationSlug) : null,
  }
}

export async function revokeSessionByToken(
  db: AuthDb,
  token: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        isNull(sessions.revokedAt),
      ),
    )
}

/** Kullanıcının TÜM açık oturumlarını kapatır (şifre sıfırlama sonrası). */
export async function revokeAllUserSessions(
  db: AuthDb,
  userId: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
}

export async function touchSession(
  db: AuthDb,
  sessionId: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, sessionId))
}
