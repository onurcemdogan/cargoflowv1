// /api/platform-admin router'ı: login/logout/me + organization/kullanıcı
// yönetimi. Yetki YALNIZ admin session cookie'sinden (requirePlatformAdmin).
// Organization cargoflow_session cookie'si admin erişimi SAĞLAMAZ. DATABASE_URL
// yoksa tüm uçlar 503. Public admin bootstrap YOK (ilk admin CLI ile).
import cookieParser from 'cookie-parser'
import express, { type Response, type Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { eq } from 'drizzle-orm'
import { platformAdmins } from '../db/schema.ts'
import {
  isPasswordLongEnough,
  PASSWORD_TOO_SHORT_MESSAGE,
} from '../../src/auth/passwordPolicy.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import {
  adminSessionCookieName,
  adminSessionDurationMs,
  createAdminSession,
  revokeAdminSessionByToken,
} from './adminSession.ts'
import { requirePlatformAdmin, type AdminRequest } from './adminMiddleware.ts'
import { isCookieSecure } from '../auth/cookieOptions.ts'
import { recordAdminAudit } from './adminAuditLog.ts'
import {
  createOrganizationWithUser,
  findUserByUsername,
  getDashboardSummary,
  getUserById,
  listOrganizations,
  revokeOrganizationSessions,
  revokeUserSessions,
  setOrganizationStatus,
  setUserStatus,
  updateUserPasswordHash,
} from './adminRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AdminDb = any

export interface AdminRouterOptions {
  db?: AdminDb
  rateLimit?: { windowMs?: number; limit?: number }
}

const ADMIN_LOGIN_FAIL = 'Yönetici kullanıcı adı veya şifre hatalı'

function normalizeUsername(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function setAdminCookie(response: Response, token: string): void {
  response.cookie(adminSessionCookieName(), token, {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: adminSessionDurationMs(),
  })
}

function clearAdminCookie(response: Response): void {
  response.clearCookie(adminSessionCookieName(), {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: 'lax',
    path: '/',
  })
}

// Durum değiştiren istekler için hafif same-origin kontrolü (SameSite=Lax'a
// ek CSRF savunması). Origin/Referer varsa Host ile aynı olmalı.
function isSameOrigin(request: AdminRequest): boolean {
  const origin = request.get('origin') || request.get('referer')
  if (!origin) return true // native/curl istekleri: SameSite cookie zaten korur
  try {
    const host = request.get('host')
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function createPlatformAdminRouter(options: AdminRouterOptions = {}): Router {
  const router = express.Router()
  router.use(cookieParser())
  router.use(express.json())

  const resolveDb = async (): Promise<AdminDb | null> => {
    if (options.db) return options.db
    const client = await import('../db/client.ts')
    if (!client.isDatabaseConfigured()) return null
    return client.getDb()
  }

  router.use(async (request, response, next) => {
    const db = await resolveDb().catch(() => null)
    if (!db) {
      response.status(503).json({
        ok: false,
        message:
          'PostgreSQL yapılandırılmadı (DATABASE_URL yok); platform admin devre dışı.',
      })
      return
    }
    ;(request as AdminRequest & { adminDb?: AdminDb }).adminDb = db
    next()
  })

  const dbOf = (request: AdminRequest): AdminDb =>
    (request as AdminRequest & { adminDb?: AdminDb }).adminDb as AdminDb

  const limiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 15 * 60 * 1000,
    limit: options.rateLimit?.limit ?? 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { ok: false, message: 'Çok fazla deneme yapıldı. Daha sonra tekrar deneyin.' },
  })

  // POST /login — genel hata; kullanıcı var/yok sızdırılmaz.
  router.post('/login', limiter, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    const username = normalizeUsername((request.body as any)?.username)
    const password = String((request.body as any)?.password ?? '')
    const fail = () => response.status(401).json({ ok: false, message: ADMIN_LOGIN_FAIL })
    if (!username || !password) return fail()
    const rows = await db
      .select({
        id: platformAdmins.id,
        passwordHash: platformAdmins.passwordHash,
        status: platformAdmins.status,
      })
      .from(platformAdmins)
      .where(eq(platformAdmins.username, username))
      .limit(1)
    const admin = rows[0]
    if (!admin || String(admin.status) !== 'active') {
      // Zamanlama farkını azaltmak için yine de doğrulama maliyeti işlet.
      await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        password,
      )
      return fail()
    }
    const valid = await verifyPassword(String(admin.passwordHash), password)
    if (!valid) return fail()
    const session = await createAdminSession(db, String(admin.id))
    await db
      .update(platformAdmins)
      .set({ lastLoginAt: new Date() })
      .where(eq(platformAdmins.id, String(admin.id)))
    setAdminCookie(response, session.token)
    response.json({ ok: true, username })
  })

  // POST /logout — idempotent.
  router.post('/logout', async (request, response) => {
    const db = dbOf(request as AdminRequest)
    const token = String(
      (request as AdminRequest).cookies?.[adminSessionCookieName()] ?? '',
    ).trim()
    if (token) await revokeAdminSessionByToken(db, token).catch(() => undefined)
    clearAdminCookie(response)
    response.json({ ok: true })
  })

  // GET /me — geçerli admin oturumu; hash/token DÖNMEZ.
  router.get('/me', async (request, response, next) => {
    const db = dbOf(request as AdminRequest)
    return requirePlatformAdmin(db)(request as AdminRequest, response, next)
  })
  router.get('/me', async (request, response) => {
    const admin = (request as AdminRequest).platformAdmin
    response.json({ authenticated: true, admin: { username: admin?.username } })
  })

  // --- Korumalı yönetim uçları (requirePlatformAdmin) ---
  const guard = (request: AdminRequest, response: Response, next: express.NextFunction) => {
    const db = dbOf(request)
    return requirePlatformAdmin(db)(request, response, next)
  }
  const requireSameOrigin = (
    request: AdminRequest,
    response: Response,
    next: express.NextFunction,
  ) => {
    if (!isSameOrigin(request)) {
      response.status(403).json({ ok: false, message: 'Origin doğrulanamadı.' })
      return
    }
    next()
  }

  router.get('/summary', guard, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    try {
      response.json({ ok: true, summary: await getDashboardSummary(db) })
    } catch {
      response.status(500).json({ ok: false, message: 'Özet alınamadı.' })
    }
  })

  router.get('/organizations', guard, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    try {
      const query = request.query ?? {}
      const result = await listOrganizations(db, {
        search: query.search ? String(query.search) : undefined,
        page: query.page,
        pageSize: query.pageSize,
      })
      response.json({ ok: true, ...result })
    } catch {
      response.status(500).json({ ok: false, message: 'Organizasyonlar listelenemedi.' })
    }
  })

  router.post('/organizations', guard, requireSameOrigin, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    const admin = (request as AdminRequest).platformAdmin
    const organizationName = String((request.body as any)?.organizationName ?? '').trim()
    const username = normalizeUsername((request.body as any)?.username)
    const password = String((request.body as any)?.password ?? '')
    if (!organizationName || !username || !password) {
      response.status(400).json({
        ok: false,
        message: 'organizationName, username ve password zorunludur.',
      })
      return
    }
    if (!isPasswordLongEnough(password)) {
      response.status(400).json({ ok: false, message: PASSWORD_TOO_SHORT_MESSAGE })
      return
    }
    const existing = await findUserByUsername(db, username)
    if (existing) {
      response.status(409).json({ ok: false, message: 'Bu kullanıcı adı zaten kullanımda.' })
      return
    }
    try {
      const passwordHash = await hashPassword(password)
      const created = await createOrganizationWithUser(db, {
        organizationName,
        username,
        passwordHash,
      })
      await recordAdminAudit(db, {
        adminId: admin?.adminId ?? null,
        action: 'organization_created',
        targetOrganizationId: created.organizationId,
        targetUserId: created.userId,
        metadata: { organizationName },
      })
      // Parola/hash RESPONSE'a DÖNMEZ; kullanıcı otomatik login OLMAZ.
      response.status(201).json({
        ok: true,
        organizationId: created.organizationId,
        userId: created.userId,
        username,
      })
    } catch {
      response.status(500).json({ ok: false, message: 'Organizasyon oluşturulamadı.' })
    }
  })

  router.patch('/organizations/:id/status', guard, requireSameOrigin, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    const admin = (request as AdminRequest).platformAdmin
    const organizationId = String(request.params.id)
    const status = String((request.body as any)?.status ?? '').toUpperCase()
    if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
      response.status(400).json({ ok: false, message: 'status ACTIVE veya SUSPENDED olmalı.' })
      return
    }
    try {
      const dbStatus = status === 'ACTIVE' ? 'active' : 'suspended'
      const updated = await setOrganizationStatus(db, organizationId, dbStatus)
      if (!updated) {
        response.status(404).json({ ok: false, message: 'Organizasyon bulunamadı.' })
        return
      }
      let revoked = 0
      if (status === 'SUSPENDED') {
        // Suspend: kullanıcı session'ları revoke; VERİ SİLİNMEZ.
        revoked = await revokeOrganizationSessions(db, organizationId)
      }
      await recordAdminAudit(db, {
        adminId: admin?.adminId ?? null,
        action: status === 'SUSPENDED' ? 'organization_suspended' : 'organization_activated',
        targetOrganizationId: organizationId,
        metadata: { status: dbStatus, revokedSessions: revoked },
      })
      response.json({ ok: true, status: dbStatus, revokedSessions: revoked })
    } catch {
      response.status(500).json({ ok: false, message: 'Durum güncellenemedi.' })
    }
  })

  router.patch('/users/:id/status', guard, requireSameOrigin, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    const admin = (request as AdminRequest).platformAdmin
    const userId = String(request.params.id)
    const status = String((request.body as any)?.status ?? '').toUpperCase()
    if (status !== 'ACTIVE' && status !== 'DISABLED') {
      response.status(400).json({ ok: false, message: 'status ACTIVE veya DISABLED olmalı.' })
      return
    }
    try {
      const dbStatus = status === 'ACTIVE' ? 'active' : 'disabled'
      const updated = await setUserStatus(db, userId, dbStatus)
      if (!updated) {
        response.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' })
        return
      }
      let revoked = 0
      if (status === 'DISABLED') {
        revoked = await revokeUserSessions(db, userId)
      }
      await recordAdminAudit(db, {
        adminId: admin?.adminId ?? null,
        action: status === 'DISABLED' ? 'user_disabled' : 'user_enabled',
        targetOrganizationId: updated.organizationId,
        targetUserId: userId,
        metadata: { status: dbStatus, revokedSessions: revoked },
      })
      response.json({ ok: true, status: dbStatus, revokedSessions: revoked })
    } catch {
      response.status(500).json({ ok: false, message: 'Durum güncellenemedi.' })
    }
  })

  router.post('/users/:id/reset-password', guard, requireSameOrigin, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    const admin = (request as AdminRequest).platformAdmin
    const userId = String(request.params.id)
    const password = String((request.body as any)?.password ?? '')
    if (!isPasswordLongEnough(password)) {
      response.status(400).json({ ok: false, message: PASSWORD_TOO_SHORT_MESSAGE })
      return
    }
    const target = await getUserById(db, userId)
    if (!target) {
      response.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' })
      return
    }
    try {
      const passwordHash = await hashPassword(password)
      await updateUserPasswordHash(db, userId, passwordHash)
      // Parola reset sonrası mevcut session'lar ZORUNLU revoke edilir.
      const revoked = await revokeUserSessions(db, userId)
      await recordAdminAudit(db, {
        adminId: admin?.adminId ?? null,
        action: 'password_reset',
        targetOrganizationId: target.organizationId,
        targetUserId: userId,
        metadata: { revokedSessions: revoked },
      })
      // Parola/hash RESPONSE'a DÖNMEZ.
      response.json({ ok: true, revokedSessions: revoked })
    } catch {
      response.status(500).json({ ok: false, message: 'Parola sıfırlanamadı.' })
    }
  })

  router.post('/users/:id/revoke-sessions', guard, requireSameOrigin, async (request, response) => {
    const db = dbOf(request as AdminRequest)
    const admin = (request as AdminRequest).platformAdmin
    const userId = String(request.params.id)
    const target = await getUserById(db, userId)
    if (!target) {
      response.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' })
      return
    }
    try {
      const revoked = await revokeUserSessions(db, userId)
      await recordAdminAudit(db, {
        adminId: admin?.adminId ?? null,
        action: 'sessions_revoked',
        targetOrganizationId: target.organizationId,
        targetUserId: userId,
        metadata: { revokedSessions: revoked },
      })
      response.json({ ok: true, revokedSessions: revoked })
    } catch {
      response.status(500).json({ ok: false, message: 'Oturumlar sonlandırılamadı.' })
    }
  })

  return router
}
