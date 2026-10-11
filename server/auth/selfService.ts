// SELF-SERVICE AUTH UÇLARI (PHASE2-A).
//
//   GET  /config               → signup açık mı + Turnstile site anahtarı
//   POST /signup               → e-posta + şifre + Turnstile → doğrulama e-postası
//   POST /verify-email         → tek kullanımlık token → e-posta doğrulandı
//   POST /resend-verification  → bekleme süreli yeniden gönderim
//   POST /forgot-password      → sıfırlama e-postası
//   POST /reset-password       → token + yeni şifre → tüm oturumlar kapanır
//
// BOOTSTRAP'TAN TAMAMEN AYRIDIR: `/bootstrap` production'da kapalı kalır.
//
// HESAP VARLIĞI SIZDIRILMAZ: signup / yeniden gönderim / şifremi unuttum
// her durumda AYNI yanıtı döner. Kayıtlı e-postayla yeniden kayıt denenirse
// hesap sahibine bilgi e-postası gider; ekranda fark görünmez.
//
// KÖTÜYE KULLANIM: IP hız sınırı (express-rate-limit), e-posta başına token
// sınırı, yeniden gönderim bekleme süresi ve Turnstile. Turnstile geçmezse
// kullanıcı OLUŞTURULMAZ.
//
// Token doğrulaması GET ile DEĞİL POST ile yapılır: e-posta istemcilerinin
// bağlantı önizleyicileri tek kullanımlık token'ı tüketemez.
import type { Request, Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { and, eq, isNull } from 'drizzle-orm'
import { users } from '../db/schema.ts'
import {
  isSelfServicePasswordAcceptable,
  SELF_SERVICE_PASSWORD_MESSAGE,
} from '../../src/auth/passwordPolicy.ts'
import { normalizeEmail, isPlausibleEmail } from '../../src/auth/emailPolicy.ts'
import type { EmailProvider, TransactionalEmail } from '../email/emailProvider.ts'
import {
  existingAccountNotice,
  passwordChangedNotice,
  passwordResetEmail,
  verificationEmail,
} from '../email/authEmails.ts'
import type { TurnstileVerifier } from './turnstile.ts'
import {
  consumeAuthToken,
  countAuthTokensSince,
  issueAuthToken,
  lastAuthTokenIssuedAt,
  type AuthTokenPurpose,
} from './authTokens.ts'
import { hashPassword } from './password.ts'
import { revokeAllUserSessions } from './session.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface SelfServiceOptions {
  emailProvider: EmailProvider
  turnstile: TurnstileVerifier
  /** E-posta bağlantılarının kökü; isteğin Host başlığından TÜRETİLMEZ. */
  appBaseUrl: string
  /** Production'da açıkça açılmadıkça signup KAPALI. */
  signupFlag: boolean
  rateLimit?: { windowMs?: number; limit?: number }
  /** Yeniden gönderim bekleme süresi (varsayılan 60 sn). */
  resendCooldownMs?: number
  /** E-posta + amaç başına saatlik en fazla token (varsayılan 5). */
  perEmailHourlyLimit?: number
  now?: () => Date
}

export const SIGNUP_ACCEPTED_MESSAGE =
  'Kaydınızı aldık. Hesabınızı etkinleştirmek için e-posta adresinize gönderilen bağlantıyı açın.'
export const RESEND_ACCEPTED_MESSAGE =
  'Bu e-postaya bağlı doğrulanmamış bir hesap varsa yeni bağlantı gönderildi.'
export const FORGOT_ACCEPTED_MESSAGE =
  'Bu e-postaya bağlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi.'
const INVALID_LINK_MESSAGE =
  'Bağlantı geçersiz ya da süresi dolmuş. Yeni bir bağlantı isteyin.'
const CAPTCHA_FAILED_MESSAGE = 'Güvenlik doğrulaması tamamlanamadı. Sayfayı yenileyip tekrar deneyin.'

export function isPasswordResetAvailable(options: SelfServiceOptions): boolean {
  return options.emailProvider.isConfigured() && options.turnstile.isConfigured() && Boolean(options.appBaseUrl)
}

export function isSignupAvailable(options: SelfServiceOptions): boolean {
  return (
    options.signupFlag &&
    options.emailProvider.isConfigured() &&
    options.turnstile.isConfigured() &&
    Boolean(options.appBaseUrl)
  )
}

function link(options: SelfServiceOptions, path: string, token?: string): string {
  const base = options.appBaseUrl.replace(/\/+$/, '')
  return token ? `${base}${path}?token=${encodeURIComponent(token)}` : `${base}${path}`
}

function body(request: Request): Record<string, unknown> {
  return (request.body as Record<string, unknown> | undefined) ?? {}
}

async function findUserByEmail(db: Db, emailNormalized: string): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      status: users.status,
    })
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Token üretip e-postayı gönderir. Bekleme süresi veya saatlik sınır
 * aşıldıysa SESSİZCE gönderilmez (yanıt değişmez → sayım sızmaz).
 */
async function issueAndSend(
  db: Db,
  options: SelfServiceOptions,
  userId: string,
  purpose: AuthTokenPurpose,
  build: (token: string) => TransactionalEmail,
): Promise<'sent' | 'throttled' | 'failed'> {
  const now = options.now?.() ?? new Date()
  const last = await lastAuthTokenIssuedAt(db, userId, purpose)
  if (last && now.getTime() - last.getTime() < (options.resendCooldownMs ?? 60_000)) return 'throttled'
  const recent = await countAuthTokensSince(db, userId, purpose, new Date(now.getTime() - 60 * 60 * 1000))
  if (recent >= (options.perEmailHourlyLimit ?? 5)) return 'throttled'
  const token = await issueAuthToken(db, userId, purpose, now)
  const result = await options.emailProvider.send(build(token))
  return result.ok ? 'sent' : 'failed'
}

export function registerSelfServiceRoutes(
  router: Router,
  resolveDb: (request: Request) => Db,
  options: SelfServiceOptions,
): void {
  const limiter = rateLimit({
    windowMs: options.rateLimit?.windowMs ?? 15 * 60 * 1000,
    limit: options.rateLimit?.limit ?? 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { ok: false, message: 'Çok fazla deneme yapıldı. Lütfen daha sonra tekrar deneyin.' },
  })
  const unavailable = (response: Response) =>
    response.status(503).json({ ok: false, code: 'SIGNUP_UNAVAILABLE', message: 'Yeni hesap oluşturma şu anda kapalı.' })

  router.get('/config', (_request, response) => {
    response.json({
      signupEnabled: isSignupAvailable(options),
      passwordResetEnabled: isPasswordResetAvailable(options),
      turnstileSiteKey: options.turnstile.siteKey(),
    })
  })

  router.post('/signup', limiter, async (request, response) => {
    if (!isSignupAvailable(options)) return unavailable(response)
    const db = resolveDb(request)
    const input = body(request)
    const email = String(input.email ?? '').trim()
    const emailNormalized = normalizeEmail(email)
    const password = String(input.password ?? '')
    if (!isPlausibleEmail(emailNormalized)) {
      response.status(400).json({ ok: false, message: 'Geçerli bir e-posta adresi girin.' })
      return
    }
    if (!isSelfServicePasswordAcceptable(password)) {
      response.status(400).json({ ok: false, message: SELF_SERVICE_PASSWORD_MESSAGE })
      return
    }
    // Turnstile, kullanıcı OLUŞTURULMADAN önce ve her durumda çalışır.
    const captcha = await options.turnstile.verify(input.turnstileToken, request.ip)
    if (!captcha.ok) {
      response.status(400).json({ ok: false, code: 'CAPTCHA_FAILED', message: CAPTCHA_FAILED_MESSAGE })
      return
    }
    const accepted = () => response.status(202).json({ ok: true, message: SIGNUP_ACCEPTED_MESSAGE })
    // Hash, hesap kontrolünden ÖNCE: kayıtlı/kayıtsız e-posta yanıt
    // süresinden ayırt edilemesin.
    const passwordHash = await hashPassword(password)

    const existing = await findUserByEmail(db, emailNormalized)
    if (existing) {
      if (existing.emailVerifiedAt == null) {
        await issueAndSend(db, options, String(existing.id), 'email_verification', (token) =>
          verificationEmail(String(existing.email ?? email), link(options, '/app/verify-email', token)),
        )
      } else {
        await options.emailProvider.send(
          existingAccountNotice(String(existing.email ?? email), link(options, '/app'), link(options, '/app/forgot-password')),
        )
      }
      accepted()
      return
    }

    let userId: string
    try {
      const [created] = await db
        .insert(users)
        .values({ email, emailNormalized, passwordHash })
        .returning({ id: users.id })
      userId = String(created.id)
    } catch {
      // Eşzamanlı aynı e-posta: tekil indeks yakaladı; yanıt AYNI kalır.
      accepted()
      return
    }
    await issueAndSend(db, options, userId, 'email_verification', (token) =>
      verificationEmail(email, link(options, '/app/verify-email', token)),
    )
    accepted()
  })

  router.post('/verify-email', limiter, async (request, response) => {
    const db = resolveDb(request)
    const now = options.now?.() ?? new Date()
    const userId = await consumeAuthToken(db, body(request).token, 'email_verification', now)
    if (!userId) {
      response.status(400).json({ ok: false, code: 'INVALID_OR_EXPIRED_LINK', message: INVALID_LINK_MESSAGE })
      return
    }
    await db
      .update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
    response.json({ ok: true, message: 'E-posta adresiniz doğrulandı. Şimdi giriş yapabilirsiniz.' })
  })

  router.post('/resend-verification', limiter, async (request, response) => {
    if (!isSignupAvailable(options)) return unavailable(response)
    const db = resolveDb(request)
    const input = body(request)
    const captcha = await options.turnstile.verify(input.turnstileToken, request.ip)
    if (!captcha.ok) {
      response.status(400).json({ ok: false, code: 'CAPTCHA_FAILED', message: CAPTCHA_FAILED_MESSAGE })
      return
    }
    const emailNormalized = normalizeEmail(String(input.email ?? ''))
    if (isPlausibleEmail(emailNormalized)) {
      const user = await findUserByEmail(db, emailNormalized)
      if (user && user.emailVerifiedAt == null && String(user.status) === 'active') {
        await issueAndSend(db, options, String(user.id), 'email_verification', (token) =>
          verificationEmail(String(user.email), link(options, '/app/verify-email', token)),
        )
      }
    }
    response.status(202).json({ ok: true, message: RESEND_ACCEPTED_MESSAGE })
  })

  router.post('/forgot-password', limiter, async (request, response) => {
    if (!isPasswordResetAvailable(options)) {
      response.status(503).json({ ok: false, code: 'RESET_UNAVAILABLE', message: 'Şifre sıfırlama şu anda kullanılamıyor.' })
      return
    }
    const db = resolveDb(request)
    const input = body(request)
    const captcha = await options.turnstile.verify(input.turnstileToken, request.ip)
    if (!captcha.ok) {
      response.status(400).json({ ok: false, code: 'CAPTCHA_FAILED', message: CAPTCHA_FAILED_MESSAGE })
      return
    }
    const emailNormalized = normalizeEmail(String(input.email ?? ''))
    if (isPlausibleEmail(emailNormalized)) {
      const user = await findUserByEmail(db, emailNormalized)
      if (user && String(user.status) === 'active') {
        await issueAndSend(db, options, String(user.id), 'password_reset', (token) =>
          passwordResetEmail(String(user.email), link(options, '/app/reset-password', token)),
        )
      }
    }
    response.status(202).json({ ok: true, message: FORGOT_ACCEPTED_MESSAGE })
  })

  router.post('/reset-password', limiter, async (request, response) => {
    const db = resolveDb(request)
    const input = body(request)
    const password = String(input.password ?? '')
    if (!isSelfServicePasswordAcceptable(password)) {
      response.status(400).json({ ok: false, message: SELF_SERVICE_PASSWORD_MESSAGE })
      return
    }
    const now = options.now?.() ?? new Date()
    const userId = await consumeAuthToken(db, input.token, 'password_reset', now)
    if (!userId) {
      response.status(400).json({ ok: false, code: 'INVALID_OR_EXPIRED_LINK', message: INVALID_LINK_MESSAGE })
      return
    }
    const passwordHash = await hashPassword(password)
    const rows = await db
      .update(users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(users.id, userId))
      .returning({ email: users.email, emailVerifiedAt: users.emailVerifiedAt })
    // Sıfırlama bağlantısını açmak e-posta sahipliğini kanıtlar.
    if (rows[0] && rows[0].emailVerifiedAt == null) {
      await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, userId))
    }
    await revokeAllUserSessions(db, userId)
    if (rows[0]?.email) {
      await options.emailProvider.send(passwordChangedNotice(String(rows[0].email), link(options, '/app/forgot-password')))
    }
    response.json({ ok: true, message: 'Şifreniz güncellendi. Yeni şifrenizle giriş yapın.' })
  })
}
