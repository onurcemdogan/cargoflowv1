// /api/auth router'ı: bootstrap, login, logout, me. organizationId yalnız
// session'dan türetilir; body/query/header'daki organizationId yok sayılır.
// DATABASE_URL yoksa tüm auth endpoint'leri açıklayıcı 503 döner; mevcut
// yerel kullanım davranışı değişmez.
import cookieParser from 'cookie-parser'
import express, { type Response, type Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { and, eq, sql } from 'drizzle-orm'
import { organizations, users } from '../db/schema.ts'
import {
  isPasswordLongEnough,
  PASSWORD_TOO_SHORT_MESSAGE,
} from '../../src/auth/passwordPolicy.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { type AuthedRequest } from './middleware.ts'
import { normalizeEmail } from '../../src/auth/emailPolicy.ts'
import { resolveEmailProvider } from '../email/emailProvider.ts'
import { resolveTurnstileVerifier } from './turnstile.ts'
import { registerSelfServiceRoutes, type SelfServiceOptions } from './selfService.ts'
import {
  addOrganizationMember,
  createWorkspaceForUser,
  resolveSessionOrganization,
} from './workspaces.ts'
import { isAuthBypassEnabled, resolveBypassContext } from './devBypass.ts'
import { isCookieSecure } from './cookieOptions.ts'
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
  /** Test enjeksiyonu; verilmeyen alanlar ortamdan çözülür. */
  selfService?: Partial<SelfServiceOptions>
}

// Self-service yapılandırması ORTAMDAN gelir. Production'da signup yalnız
// PUBLIC_SIGNUP_ENABLED=true + e-posta sağlayıcısı + Turnstile + APP_BASE_URL
// birlikte tanımlıysa açılır; biri eksikse kapalı kalır (fail-closed).
function resolveSelfServiceOptions(overrides: Partial<SelfServiceOptions> = {}): SelfServiceOptions {
  const production = process.env.NODE_ENV === 'production'
  const flag = String(process.env.PUBLIC_SIGNUP_ENABLED ?? '').trim().toLowerCase()
  const appBaseUrl =
    String(process.env.APP_BASE_URL ?? '').trim() || (production ? '' : 'http://localhost:5173')
  return {
    emailProvider: overrides.emailProvider ?? resolveEmailProvider(),
    turnstile: overrides.turnstile ?? resolveTurnstileVerifier(),
    appBaseUrl: overrides.appBaseUrl ?? appBaseUrl,
    signupFlag: overrides.signupFlag ?? (production ? flag === 'true' : flag !== 'false'),
    ...(overrides.rateLimit ? { rateLimit: overrides.rateLimit } : {}),
    ...(overrides.resendCooldownMs !== undefined ? { resendCooldownMs: overrides.resendCooldownMs } : {}),
    ...(overrides.perEmailHourlyLimit !== undefined ? { perEmailHourlyLimit: overrides.perEmailHourlyLimit } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  }
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
    secure: isCookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: sessionDurationMs(),
  })
}

function clearSessionCookie(response: Response): void {
  response.clearCookie(sessionCookieName(), {
    httpOnly: true,
    secure: isCookieSecure(),
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
    // Production'da public self-bootstrap KAPALIDIR: organization hesapları
    // platform yöneticisi tarafından oluşturulur. ALLOW_PUBLIC_BOOTSTRAP=true
    // açıkça verilmedikçe production'da 403. (Mevcut zero-org guard ayrıca
    // geçerlidir.) Test/geliştirme ortamı (NODE_ENV!=production) etkilenmez.
    if (
      process.env.NODE_ENV === 'production' &&
      String(process.env.ALLOW_PUBLIC_BOOTSTRAP ?? '').toLowerCase() !== 'true'
    ) {
      response.status(403).json({
        ok: false,
        message: 'Public kurulum devre dışı. Hesabınız platform yöneticisi tarafından oluşturulur.',
      })
      return
    }
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
    // Ortak politika: frontend ile aynı sabit (src/auth/passwordPolicy.ts).
    if (!isPasswordLongEnough(password)) {
      response.status(400).json({
        ok: false,
        message: PASSWORD_TOO_SHORT_MESSAGE,
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
        await addOrganizationMember(tx, String(organization.id), String(user.id), 'owner')
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
    // Tek alan iki kimliği kabul eder: '@' içeriyorsa e-posta, değilse
    // (yönetici açılışlı hesapların) kullanıcı adı.
    const byEmail = username.includes('@')
    const rows = await (
      (
        db.select({
          userId: users.id,
          organizationId: users.organizationId,
          passwordHash: users.passwordHash,
          userStatus: users.status,
          email: users.email,
          emailVerifiedAt: users.emailVerifiedAt,
          displayName: users.username,
        }) as unknown as SelectChain
      ).from(users).where as (condition: unknown) => {
        limit: (count: number) => Promise<Record<string, unknown>[]>
      }
    )(
      byEmail
        ? and(eq(users.emailNormalized, normalizeEmail(username)))
        : and(eq(users.username, username)),
    )
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
    // E-postayla kaydolmuş ama doğrulamamış hesap OTURUM AÇAMAZ; böylece
    // entegrasyon bilgisi ekleyemez ve gönderi üretemez. (Yalnız doğru şifre
    // sahibine söylenir.)
    if (user.email != null && user.emailVerifiedAt == null) {
      response.status(403).json({
        ok: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'E-posta adresiniz henüz doğrulanmadı. Gelen kutunuzdaki bağlantıyı açın.',
      })
      return
    }
    // Çalışma alanı ÜYELİKTEN çözülür (birincil firma üyelikle doğrulanır).
    const sessionOrganizationId = await resolveSessionOrganization(
      db,
      String(user.userId),
      user.organizationId == null ? null : String(user.organizationId),
    )
    const session = await createSession(db, String(user.userId), sessionOrganizationId)
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, String(user.userId)))
    setSessionCookie(response, session.token)
    response.json({
      ok: true,
      username: user.displayName == null ? String(user.email ?? username) : String(user.displayName),
    })
  })

  // POST /api/auth/workspace — doğrulanmış, henüz çalışma alanı olmayan
  // kullanıcı firmasını oluşturur ve owner olur. Kiracı uçlarına giden yol
  // budur; organizationId istemciden ALINMAZ.
  router.post('/workspace', limiter, async (request, response) => {
    const db = dbOf(request as AuthedRequest)
    const token = String((request as AuthedRequest).cookies?.[sessionCookieName()] ?? '').trim()
    const context = token ? await findActiveSession(db, token).catch(() => null) : null
    if (!context) {
      response.status(401).json({ ok: false, message: 'Oturum gerekli.' })
      return
    }
    if (context.organizationId) {
      response.status(409).json({ ok: false, code: 'WORKSPACE_EXISTS', message: 'Çalışma alanınız zaten var.' })
      return
    }
    const result = await createWorkspaceForUser(db, {
      userId: context.userId,
      sessionToken: token,
      name: (request.body as Record<string, unknown> | undefined)?.name,
    })
    if (!result.ok) {
      response.status(result.code === 'INVALID_NAME' ? 400 : 409).json({
        ok: false,
        code: result.code,
        message:
          result.code === 'INVALID_NAME'
            ? 'Firma adı 2–120 karakter olmalıdır.'
            : 'Çalışma alanınız zaten var.',
      })
      return
    }
    response.status(201).json({
      ok: true,
      organization: { id: result.organizationId, name: result.name, slug: result.slug },
    })
  })

  registerSelfServiceRoutes(
    router,
    (request) => dbOf(request as AuthedRequest),
    resolveSelfServiceOptions(options.selfService),
  )

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
    // TEST modu (varsayılan KAPALI): oturum yokken de demo organization
    // döndürülür ki frontend giriş ekranını atlayıp dashboard'a geçsin.
    if (isAuthBypassEnabled()) {
      const context = await resolveBypassContext(db)
      response.json({
        authenticated: true,
        bypass: true,
        user: {
          username: context.username,
          organization: {
            id: context.organizationId,
            name: context.organizationName,
            slug: context.organizationSlug,
          },
        },
      })
      return
    }
    next()
  })
  // Workspace'i olmayan kullanıcı da kendini görebilir (`organization: null`,
  // `needsWorkspace: true`); kiracı uçları bu oturumu yine REDDEDER.
  router.get('/me', async (request, response) => {
    const db = dbOf(request as AuthedRequest)
    const token = String(
      (request as AuthedRequest).cookies?.[sessionCookieName()] ?? '',
    ).trim()
    const context = token ? await findActiveSession(db, token).catch(() => null) : null
    if (!context) {
      response.status(401).json({ ok: false, message: 'Oturum gerekli.' })
      return
    }
    response.json({
      authenticated: true,
      needsWorkspace: context.organizationId == null,
      user: {
        username: context.username,
        email: context.email,
        organization: context.organizationId
          ? {
              id: context.organizationId,
              name: context.organizationName,
              slug: context.organizationSlug,
            }
          : null,
      },
    })
  })

  return router
}
