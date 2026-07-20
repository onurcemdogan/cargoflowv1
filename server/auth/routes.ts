// /api/auth router'ı: bootstrap, login, logout, me. organizationId yalnız
// session'dan türetilir; body/query/header'daki organizationId yok sayılır.
// DATABASE_URL yoksa tüm auth endpoint'leri açıklayıcı 503 döner; mevcut
// yerel kullanım davranışı değişmez.
import cookieParser from 'cookie-parser'
import express, { type Response, type Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { and, eq, sql } from 'drizzle-orm'
import { organizations, users } from '../db/schema.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { requireAuth, type AuthedRequest } from './middleware.ts'
import {
  createSession,
  findActiveSession,
  revokeSessionByToken,
  sessionCookieName,
  sessionDurationMs,
  type AuthDb,
} from './session.ts'

// Bootstrap yarışını tekilleştiren advisory-lock anahtarı (keyfi sabit).
const BOOTSTRAP_LOCK_KEY = 815115

export interface AuthRouterOptions {
  // Test enjeksiyonu: pglite-drizzle örneği. Verilmezse runtime'da
  // server/db/client.ts üzerinden gerçek Pool kullanılır.
  db?: AuthDb
  rateLimit?: { windowMs?: number; limit?: number }
}

type TransactionalDb = AuthDb & {
  transaction: (fn: (tx: AuthDb) => Promise<void>) => Promise<void>
  execute?: (query: unknown) => Promise<unknown>
}

interface SelectChain {
  from: (table: unknown) => {
    where?: (condition: unknown) => { limit: (count: number) => Promise<Record<string, unknown>[]> }
    innerJoin?: (
      table: unknown,
      condition: unknown,
    ) => {
      where: (condition: unknown) => { limit: (count: number) => Promise<Record<string, unknown>[]> }
    }
    limit?: (count: number) => Promise<Record<string, unknown>[]>
  }
}

function normalizeUsername(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

function slugify(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[çÇ]/g, 'c')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[ıİiI]/g, 'i')
    .replace(/[öÖ]/g, 'o')
    .replace(/[şŞ]/g, 's')
    .replace(/[üÜ]/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'org'
}

function setSessionCookie(
  response: Response,
  token: string,
): void {
  response.cookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: sessionDurationMs(),
  })
}

function clearSessionCookie(response: Response): void {
  response.clearCookie(sessionCookieName(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  })
}

export function createAuthRouter(options: AuthRouterOptions = {}): Router {
  const router = express.Router()
  router.use(cookieParser())
  router.use(express.json())

  const resolveDb = async (): Promise<TransactionalDb | null> => {
    if (options.db) return options.db as TransactionalDb
    const client = await import('../db/client.ts')
    if (!client.isDatabaseConfigured()) return null
    return client.getDb() as unknown as TransactionalDb
  }

  // DATABASE_URL yoksa tüm auth uçları kontrollü 503 döner.
  router.use(async (request, response, next) => {
    const db = await resolveDb().catch(() => null)
    if (!db) {
      response.status(503).json({
        ok: false,
        message:
          'PostgreSQL yapılandırılmadı (DATABASE_URL yok); auth devre dışı. ' +
          'Yerel kullanım mevcut akışla devam eder.',
      })
      return
    }
    ;(request as AuthedRequest & { authDb?: TransactionalDb }).authDb = db
    next()
  })

  const dbOf = (request: AuthedRequest): TransactionalDb =>
    (request as AuthedRequest & { authDb?: TransactionalDb })
      .authDb as TransactionalDb

  // Rate limit: yalnız bootstrap/login. Başarılı istekler sayaca yazılmaz.
  // `trust proxy` körlemesine açılmaz; proxy arkasında gerçek IP için
  // ileride bilinçli trust-proxy yapılandırması gerekir (XFF doğrulaması
  // bu nedenle kapalı tutulur, spoof edilebilir header'a güvenilmez).
  const limiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 15 * 60 * 1000,
    limit: options.rateLimit?.limit ?? 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: {
      ok: false,
      message: 'Çok fazla deneme yapıldı. Lütfen daha sonra tekrar deneyin.',
    },
  })

  // POST /api/auth/bootstrap — yalnız sistemde hiç organization yokken.
  router.post('/bootstrap', limiter, async (request, response) => {
    const db = dbOf(request as AuthedRequest)
    const organizationName = String(
      (request.body as Record<string, unknown> | undefined)?.organizationName ??
        '',
    ).trim()
    const username = normalizeUsername(
      (request.body as Record<string, unknown> | undefined)?.username,
    )
    const password = String(
      (request.body as Record<string, unknown> | undefined)?.password ?? '',
    )
    if (!organizationName || !username || !password) {
      response.status(400).json({
        ok: false,
        message: 'organizationName, username ve password zorunludur.',
      })
      return
    }
    if (password.length < 12) {
      response.status(400).json({
        ok: false,
        message: 'Parola en az 12 karakter olmalıdır.',
      })
      return
    }

    const passwordHash = await hashPassword(password)
    let created: { organizationId: string; userId: string } | null = null
    let conflict = false
    try {
      await db.transaction(async (tx) => {
        // Aynı anda iki bootstrap: advisory xact lock yalnız birini geçirir;
        // kilidi alan ikinci istek yeniden sayım görür ve 409'a düşer.
        const txExec = tx as TransactionalDb
        if (txExec.execute) {
          await txExec.execute(
            sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`,
          )
        }
        const existing = await (
          (tx.select({ id: organizations.id }) as unknown as SelectChain).from(
            organizations,
          ).limit as (count: number) => Promise<Record<string, unknown>[]>
        )(1)
        if (existing.length > 0) {
          conflict = true
          return
        }
        // Güvenli, unique slug (kilit altında kontrol edilir).
        const baseSlug = slugify(organizationName)
        let slug = baseSlug
        for (let suffix = 2; suffix < 50; suffix += 1) {
          const clash = await (
            (tx.select({ id: organizations.id }) as unknown as SelectChain)
              .from(organizations)
              .where as (condition: unknown) => {
              limit: (count: number) => Promise<Record<string, unknown>[]>
            }
          )(eq(organizations.slug, slug)).limit(1)
          if (clash.length === 0) break
          slug = `${baseSlug}-${suffix}`
        }
        const [organization] = await tx
          .insert(organizations)
          .values({ name: organizationName, slug })
          .returning()
        const [user] = await tx
          .insert(users)
          .values({
            organizationId: String(organization.id),
            username,
            passwordHash,
          })
          .returning()
        created = {
          organizationId: String(organization.id),
          userId: String(user.id),
        }
      })
    } catch {
      response.status(409).json({
        ok: false,
        message: 'Bootstrap tamamlanamadı; sistem zaten kurulmuş olabilir.',
      })
      return
    }
    if (conflict || !created) {
      response.status(409).json({
        ok: false,
        message: 'Sistem zaten kurulmuş; bootstrap yalnız bir kez çalışır.',
      })
      return
    }
    // Başarılı bootstrap otomatik login yapar.
    const resolved = created as { organizationId: string; userId: string }
    const session = await createSession(
      db,
      resolved.userId,
      resolved.organizationId,
    )
    setSessionCookie(response, session.token)
    response.status(201).json({ ok: true, username })
  })

  // POST /api/auth/login
  router.post('/login', limiter, async (request, response) => {
    const db = dbOf(request as AuthedRequest)
    const username = normalizeUsername(
      (request.body as Record<string, unknown> | undefined)?.username,
    )
    const password = String(
      (request.body as Record<string, unknown> | undefined)?.password ?? '',
    )
    // Genel hata: kullanıcı var/yok bilgisi sızdırılmaz.
    const genericFail = () =>
      response
        .status(401)
        .json({ ok: false, message: 'Kullanıcı adı veya şifre hatalı' })
    if (!username || !password) {
      genericFail()
      return
    }
    const rows = await (
      (
        db.select({
          userId: users.id,
          organizationId: users.organizationId,
          passwordHash: users.passwordHash,
          userStatus: users.status,
        }) as unknown as SelectChain
      ).from(users).where as (condition: unknown) => {
        limit: (count: number) => Promise<Record<string, unknown>[]>
      }
    )(and(eq(users.username, username)))
      .limit(1)
    const user = rows[0]
    if (!user || String(user.userStatus) !== 'active') {
      // Zamanlama farkını azaltmak için yine de bir doğrulama maliyeti işlet.
      await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        password,
      )
      genericFail()
      return
    }
    const valid = await verifyPassword(String(user.passwordHash), password)
    if (!valid) {
      genericFail()
      return
    }
    const session = await createSession(
      db,
      String(user.userId),
      String(user.organizationId),
    )
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, String(user.userId)))
    setSessionCookie(response, session.token)
    response.json({ ok: true, username })
  })

  // POST /api/auth/logout — idempotent; cookie aynı özelliklerle temizlenir.
  router.post('/logout', async (request, response) => {
    const db = dbOf(request as AuthedRequest)
    const token = String(
      (request as AuthedRequest).cookies?.[sessionCookieName()] ?? '',
    ).trim()
    if (token) {
      await revokeSessionByToken(db, token).catch(() => undefined)
    }
    clearSessionCookie(response)
    response.json({ ok: true })
  })

  // GET /api/auth/me — hash/token/credential DÖNDÜRMEZ.
  router.get('/me', async (request, response, next) => {
    const db = dbOf(request as AuthedRequest)
    return requireAuth(db)(request as AuthedRequest, response, next)
  })
  router.get('/me', async (request, response) => {
    const db = dbOf(request as AuthedRequest)
    const token = String(
      (request as AuthedRequest).authSessionToken ?? '',
    )
    const context = await findActiveSession(db, token)
    if (!context) {
      response.status(401).json({ ok: false, message: 'Oturum gerekli.' })
      return
    }
    response.json({
      authenticated: true,
      user: {
        username: context.username,
        organization: {
          id: context.organizationId,
          name: context.organizationName,
          slug: context.organizationSlug,
        },
      },
    })
  })

  return router
}
