import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import http from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// PHASE2-A — SELF-SERVICE AUTH (hermetik): gerçek PostgreSQL motoru (pglite),
// gerçek migration'lar, gerçek express + HTTP. E-posta bellek adaptörüne,
// Turnstile sahte doğrulayıcıya gider; ağa çıkılmaz.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const { createAuthRouter } = await import('./auth/routes.ts')
const { requireAuth } = await import('./auth/middleware.ts')
const { createMemoryEmailProvider } = await import('./email/memoryEmailProvider.ts')
const { createResendEmailProvider, RESEND_SEND_URL } = await import('./email/resendEmailProvider.ts')
const { resolveEmailProvider } = await import('./email/emailProvider.ts')
const { createTurnstileVerifier, TURNSTILE_SITEVERIFY_URL } = await import('./auth/turnstile.ts')
const { hashAuthToken } = await import('./auth/authTokens.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const statements = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    statements.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return statements
}

async function createTestDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}

/** Sahte Turnstile: 'gecerli' token geçer, diğerleri reddedilir. */
function fakeTurnstile({ configured = true } = {}) {
  const calls = []
  return {
    calls,
    isConfigured: () => configured,
    siteKey: () => (configured ? 'site-key-public' : null),
    async verify(token, ip) {
      calls.push({ token, ip })
      if (!configured) return { ok: false, reason: 'NOT_CONFIGURED' }
      if (!token) return { ok: false, reason: 'MISSING_TOKEN' }
      return token === 'gecerli' ? { ok: true, skipped: false } : { ok: false, reason: 'REJECTED' }
    },
  }
}

async function startApp(t, overrides = {}) {
  const { pglite, db } = await createTestDb()
  t.after(() => pglite.close())
  const email = overrides.emailProvider ?? createMemoryEmailProvider()
  const turnstile = overrides.turnstile ?? fakeTurnstile()
  let clock = overrides.startAt ?? new Date('2026-10-12T09:00:00.000Z')
  const app = express()
  app.use(
    '/api/auth',
    createAuthRouter({
      db,
      rateLimit: { windowMs: 60_000, limit: 1000 },
      selfService: {
        emailProvider: email,
        turnstile,
        appBaseUrl: 'https://panel.example.test',
        signupFlag: overrides.signupFlag ?? true,
        rateLimit: { windowMs: 60_000, limit: 1000 },
        now: () => clock,
      },
    }),
  )
  // Kiracı ucu temsili: organizationId'ye dayanan HER uç requireAuth'tan geçer.
  app.get('/api/tenant-probe', cookieParser(), requireAuth(db), (request, response) => {
    response.json({ ok: true, organizationId: request.auth.organizationId })
  })
  const server = http.createServer(app)
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    pglite,
    email,
    turnstile,
    advance(ms) {
      clock = new Date(clock.getTime() + ms)
    },
  }
}

async function post(base, path, body, cookie) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  })
}

function cookieOf(response) {
  const sessionCookie = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('cargoflow_session='))
  return sessionCookie ? sessionCookie.split(';')[0] : ''
}

function tokenFrom(email) {
  const match = email.text.match(/token=([A-Za-z0-9_%-]+)/)
  assert.ok(match, 'e-postada token bağlantısı yok')
  return decodeURIComponent(match[1])
}

async function userCount(pglite) {
  return (await pglite.query('select count(*)::int as n from users')).rows[0].n
}

const SIGNUP = { email: '  Ada@Ornek.COM ', password: 'cok-guclu-sifre-1', turnstileToken: 'gecerli' }

test('SS-1: config signup durumunu ve YALNIZ herkese açık site anahtarını döndürür', async (t) => {
  const on = await startApp(t)
  const config = await (await fetch(`${on.base}/api/auth/config`)).json()
  assert.deepEqual(config, { signupEnabled: true, passwordResetEnabled: true, turnstileSiteKey: 'site-key-public' })

  const off = await startApp(t, { signupFlag: false })
  assert.equal((await (await fetch(`${off.base}/api/auth/config`)).json()).signupEnabled, false)
  const blocked = await post(off.base, '/api/auth/signup', SIGNUP)
  assert.equal(blocked.status, 503)
  assert.equal(await userCount(off.pglite), 0)

  // Turnstile yapılandırılmamışsa signup KAPALI (fail-closed).
  const noCaptcha = await startApp(t, { turnstile: fakeTurnstile({ configured: false }) })
  assert.equal((await post(noCaptcha.base, '/api/auth/signup', SIGNUP)).status, 503)
  assert.equal(await userCount(noCaptcha.pglite), 0)
})

test('SS-2/3: Turnstile geçmezse kullanıcı OLUŞMAZ; geçerse doğrulanmamış, workspace\'siz hesap + hash\'li token', async (t) => {
  const app = await startApp(t)
  for (const token of [undefined, '', 'sahte']) {
    const response = await post(app.base, '/api/auth/signup', { ...SIGNUP, turnstileToken: token })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'CAPTCHA_FAILED')
  }
  assert.equal(await userCount(app.pglite), 0, 'captcha başarısızken kullanıcı oluşmamalı')
  assert.equal(app.email.sent.length, 0)

  const response = await post(app.base, '/api/auth/signup', SIGNUP)
  assert.equal(response.status, 202)
  const user = (await app.pglite.query('select * from users')).rows[0]
  assert.equal(user.email, 'Ada@Ornek.COM')
  assert.equal(user.email_normalized, 'ada@ornek.com')
  assert.equal(user.email_verified_at, null)
  assert.equal(user.organization_id, null)
  assert.equal(user.username, null)
  assert.ok(!user.password_hash.includes('cok-guclu'))

  assert.equal(app.email.sent.length, 1)
  const mail = app.email.sent[0]
  assert.equal(mail.kind, 'email_verification')
  assert.ok(mail.text.startsWith('E-posta adresinizi doğrulayın'))
  assert.match(mail.text, /https:\/\/panel\.example\.test\/app\/verify-email\?token=/)
  const raw = tokenFrom(mail)
  const tokens = (await app.pglite.query('select * from auth_tokens')).rows
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].token_hash, hashAuthToken(raw))
  const dump = JSON.stringify((await app.pglite.query('select * from auth_tokens')).rows)
  assert.ok(!dump.includes(raw), 'ham token DB\'de olmamalı')
})

test('SS-4/5/6: doğrulanmamış hesap giriş YAPAMAZ; token tek kullanımlık; workspace yokken kiracı uçları REDDEDER', async (t) => {
  const app = await startApp(t)
  await post(app.base, '/api/auth/signup', SIGNUP)
  const raw = tokenFrom(app.email.sent[0])

  const early = await post(app.base, '/api/auth/login', { username: 'ada@ornek.com', password: SIGNUP.password })
  assert.equal(early.status, 403)
  assert.equal((await early.json()).code, 'EMAIL_NOT_VERIFIED')
  assert.equal(cookieOf(early), '', 'doğrulanmamış hesaba oturum verilmemeli')

  // Yanlış şifre doğrulama durumunu SIZDIRMAZ.
  const wrong = await post(app.base, '/api/auth/login', { username: 'ada@ornek.com', password: 'yanlis-sifre-123' })
  assert.equal(wrong.status, 401)

  const verified = await post(app.base, '/api/auth/verify-email', { token: raw })
  assert.equal(verified.status, 200)
  const reuse = await post(app.base, '/api/auth/verify-email', { token: raw })
  assert.equal(reuse.status, 400)
  assert.equal((await reuse.json()).code, 'INVALID_OR_EXPIRED_LINK')

  const login = await post(app.base, '/api/auth/login', { username: ' ADA@ornek.com ', password: SIGNUP.password })
  assert.equal(login.status, 200)
  const cookie = cookieOf(login)
  assert.ok(cookie)

  const me = await (await fetch(`${app.base}/api/auth/me`, { headers: { Cookie: cookie } })).json()
  assert.equal(me.authenticated, true)
  assert.equal(me.needsWorkspace, true)
  assert.equal(me.user.organization, null)
  assert.equal(me.user.email, 'Ada@Ornek.COM')

  const probe = await fetch(`${app.base}/api/tenant-probe`, { headers: { Cookie: cookie } })
  assert.equal(probe.status, 403)
  assert.equal((await probe.json()).code, 'WORKSPACE_REQUIRED')
})

test('SS-5b: süresi dolmuş doğrulama bağlantısı reddedilir', async (t) => {
  const app = await startApp(t)
  await post(app.base, '/api/auth/signup', SIGNUP)
  const raw = tokenFrom(app.email.sent[0])
  app.advance(24 * 60 * 60 * 1000 + 1000)
  assert.equal((await post(app.base, '/api/auth/verify-email', { token: raw })).status, 400)
  const user = (await app.pglite.query('select email_verified_at from users')).rows[0]
  assert.equal(user.email_verified_at, null)
})

test('SS-7: kayıtlı e-postayla yeniden kayıt AYNI yanıtı alır; ikinci hesap OLUŞMAZ; sahibine bildirim gider', async (t) => {
  const app = await startApp(t)
  const first = await post(app.base, '/api/auth/signup', SIGNUP)
  await post(app.base, '/api/auth/verify-email', { token: tokenFrom(app.email.sent[0]) })
  const firstBody = await first.json()

  const again = await post(app.base, '/api/auth/signup', { ...SIGNUP, email: 'ada@ornek.com', password: 'baska-bir-sifre-9' })
  assert.equal(again.status, first.status)
  assert.deepEqual(await again.json(), firstBody)
  assert.equal(await userCount(app.pglite), 1)
  const notice = app.email.sent.at(-1)
  assert.equal(notice.kind, 'security_notice')
  assert.match(notice.text, /zaten bir hesabınız var/)
  // Mevcut şifre DEĞİŞMEDİ.
  assert.equal((await post(app.base, '/api/auth/login', { username: 'ada@ornek.com', password: 'baska-bir-sifre-9' })).status, 401)
})

test('SS-8: yeniden gönderim bekleme süresi ve eski bağlantının geçersizleşmesi', async (t) => {
  const app = await startApp(t)
  await post(app.base, '/api/auth/signup', SIGNUP)
  const firstToken = tokenFrom(app.email.sent[0])

  const tooSoon = await post(app.base, '/api/auth/resend-verification', { email: 'ada@ornek.com', turnstileToken: 'gecerli' })
  assert.equal(tooSoon.status, 202)
  assert.equal(app.email.sent.length, 1, 'bekleme süresinde yeni e-posta gitmemeli')

  app.advance(61_000)
  await post(app.base, '/api/auth/resend-verification', { email: 'ada@ornek.com', turnstileToken: 'gecerli' })
  assert.equal(app.email.sent.length, 2)
  const secondToken = tokenFrom(app.email.sent[1])
  assert.equal((await post(app.base, '/api/auth/verify-email', { token: firstToken })).status, 400, 'eski bağlantı geçersiz olmalı')
  assert.equal((await post(app.base, '/api/auth/verify-email', { token: secondToken })).status, 200)

  // Bilinmeyen e-posta AYNI yanıtı alır, e-posta gitmez.
  const unknown = await post(app.base, '/api/auth/resend-verification', { email: 'yok@ornek.com', turnstileToken: 'gecerli' })
  assert.equal(unknown.status, 202)
  assert.equal(app.email.sent.length, 2)

  // Captcha'sız yeniden gönderim reddedilir.
  assert.equal((await post(app.base, '/api/auth/resend-verification', { email: 'ada@ornek.com' })).status, 400)
})

test('SS-11: e-posta başına saatlik token sınırı', async (t) => {
  const app = await startApp(t)
  await post(app.base, '/api/auth/signup', SIGNUP)
  for (let i = 0; i < 8; i += 1) {
    app.advance(61_000)
    await post(app.base, '/api/auth/resend-verification', { email: 'ada@ornek.com', turnstileToken: 'gecerli' })
  }
  assert.equal(app.email.sent.length, 5, 'saatte en fazla 5 doğrulama e-postası')
})

test('SS-9: şifremi unuttum → sıfırla: genel yanıt, tek kullanım, tüm oturumlar kapanır, bildirim gider', async (t) => {
  const app = await startApp(t)
  await post(app.base, '/api/auth/signup', SIGNUP)
  await post(app.base, '/api/auth/verify-email', { token: tokenFrom(app.email.sent[0]) })
  const session = cookieOf(await post(app.base, '/api/auth/login', { username: 'ada@ornek.com', password: SIGNUP.password }))
  assert.ok(session)

  const unknown = await post(app.base, '/api/auth/forgot-password', { email: 'yok@ornek.com', turnstileToken: 'gecerli' })
  const known = await post(app.base, '/api/auth/forgot-password', { email: 'Ada@ornek.com', turnstileToken: 'gecerli' })
  assert.equal(unknown.status, 202)
  assert.deepEqual(await unknown.json(), await known.json())
  assert.equal((await post(app.base, '/api/auth/forgot-password', { email: 'ada@ornek.com' })).status, 400, 'captcha zorunlu')

  const resetMail = app.email.sent.at(-1)
  assert.equal(resetMail.kind, 'password_reset')
  const raw = tokenFrom(resetMail)

  const weak = await post(app.base, '/api/auth/reset-password', { token: raw, password: 'kisa' })
  assert.equal(weak.status, 400)
  const reset = await post(app.base, '/api/auth/reset-password', { token: raw, password: 'yepyeni-sifre-42' })
  assert.equal(reset.status, 200)
  assert.equal((await post(app.base, '/api/auth/reset-password', { token: raw, password: 'baska-sifre-4242' })).status, 400)

  assert.equal((await fetch(`${app.base}/api/auth/me`, { headers: { Cookie: session } })).status, 401, 'eski oturum kapanmalı')
  assert.equal((await post(app.base, '/api/auth/login', { username: 'ada@ornek.com', password: SIGNUP.password })).status, 401)
  assert.equal((await post(app.base, '/api/auth/login', { username: 'ada@ornek.com', password: 'yepyeni-sifre-42' })).status, 200)
  assert.equal(app.email.sent.at(-1).kind, 'security_notice')
  assert.match(app.email.sent.at(-1).text, /Şifreniz değiştirildi/)
})

test('SS-9b: süresi dolmuş sıfırlama bağlantısı (30 dk) reddedilir', async (t) => {
  const app = await startApp(t)
  await post(app.base, '/api/auth/signup', SIGNUP)
  await post(app.base, '/api/auth/forgot-password', { email: 'ada@ornek.com', turnstileToken: 'gecerli' })
  const raw = tokenFrom(app.email.sent.at(-1))
  app.advance(31 * 60 * 1000)
  assert.equal((await post(app.base, '/api/auth/reset-password', { token: raw, password: 'yepyeni-sifre-42' })).status, 400)
})

test('SS-10: yönetici açılışlı kullanıcı adı girişi ve organizasyonlu oturum DEĞİŞMEDİ', async (t) => {
  const app = await startApp(t)
  const boot = await post(app.base, '/api/auth/bootstrap', {
    organizationName: 'Zeyna Moda',
    username: 'zeynaadmin',
    password: 'cok-gizli-parola-1',
  })
  assert.equal(boot.status, 201)
  const login = await post(app.base, '/api/auth/login', { username: 'zeynaadmin', password: 'cok-gizli-parola-1' })
  assert.equal(login.status, 200)
  const cookie = cookieOf(login)
  const me = await (await fetch(`${app.base}/api/auth/me`, { headers: { Cookie: cookie } })).json()
  assert.equal(me.needsWorkspace, false)
  assert.equal(me.user.username, 'zeynaadmin')
  assert.equal(me.user.organization.name, 'Zeyna Moda')
  const probe = await fetch(`${app.base}/api/tenant-probe`, { headers: { Cookie: cookie } })
  assert.equal(probe.status, 200)
  assert.equal((await probe.json()).organizationId, me.user.organization.id)
})

test('SS-12: e-posta gönderimi başarısız olsa da yanıt aynı; kullanıcı yeniden gönderim isteyebilir', async (t) => {
  const email = createMemoryEmailProvider()
  const app = await startApp(t, { emailProvider: email })
  email.failNext()
  const response = await post(app.base, '/api/auth/signup', SIGNUP)
  assert.equal(response.status, 202)
  assert.equal(email.sent.length, 0)
  app.advance(61_000)
  await post(app.base, '/api/auth/resend-verification', { email: 'ada@ornek.com', turnstileToken: 'gecerli' })
  assert.equal(email.sent.length, 1)
})

test('RESEND-1..4: resmî sözleşme — URL, Bearer, gövde, Idempotency-Key; anahtar sonuca SIZMAZ', async () => {
  const calls = []
  const ok = createResendEmailProvider({
    apiKey: 're_test_GIZLI',
    from: 'CargoFlow <no-reply@example.test>',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
    },
  })
  const result = await ok.send({ to: 'a@b.test', subject: 'Konu', text: 'metin', html: '<p>x</p>', kind: 'email_verification', idempotencyKey: 'idem-1' })
  assert.deepEqual(result, { ok: true, providerMessageId: 'msg-1' })
  assert.equal(calls[0].url, RESEND_SEND_URL)
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_GIZLI')
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'idem-1')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: 'CargoFlow <no-reply@example.test>', to: ['a@b.test'], subject: 'Konu', html: '<p>x</p>', text: 'metin',
  })

  const statuses = [[401, 'EMAIL_AUTH_FAILED'], [429, 'EMAIL_RATE_LIMITED'], [500, 'EMAIL_PROVIDER_UNAVAILABLE'], [422, 'EMAIL_REJECTED']]
  for (const [status, code] of statuses) {
    const provider = createResendEmailProvider({
      apiKey: 're_test_GIZLI', from: 'x@y.test',
      fetchImpl: async () => new Response(JSON.stringify({ message: 're_test_GIZLI geçersiz' }), { status }),
    })
    const failed = await provider.send({ to: 'a@b.test', subject: 's', text: 't', html: 'h', kind: 'security_notice' })
    assert.deepEqual(failed, { ok: false, errorCode: code })
    assert.ok(!JSON.stringify(failed).includes('GIZLI'))
  }
  const missing = createResendEmailProvider({ apiKey: '', from: '' })
  assert.equal(missing.isConfigured(), false)
  assert.deepEqual(await missing.send({ to: 'a@b.test', subject: 's', text: 't', html: 'h', kind: 'security_notice' }), { ok: false, errorCode: 'EMAIL_NOT_CONFIGURED' })
})

test('EMAIL-ENV: production test adaptörünü SEÇMEZ; anahtarsız Resend yapılandırılmamış sayılır', () => {
  assert.equal(resolveEmailProvider({ NODE_ENV: 'production', EMAIL_PROVIDER: 'memory' }).isConfigured(), false)
  assert.equal(resolveEmailProvider({ NODE_ENV: 'production', EMAIL_PROVIDER: 'outbox', EMAIL_OUTBOX_DIR: 'x' }).isConfigured(), false)
  assert.equal(resolveEmailProvider({ NODE_ENV: 'production' }).isConfigured(), false)
  assert.equal(resolveEmailProvider({ NODE_ENV: 'production', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.test' }).name, 'resend')
  assert.equal(resolveEmailProvider({ NODE_ENV: 'development' }).name, 'memory')
})

test('TURNSTILE-1..5: resmî siteverify sözleşmesi; her hata fail-closed', async () => {
  const calls = []
  const verifier = createTurnstileVerifier({
    secret: 'GIZLI-SECRET', siteKey: 'site', production: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ success: JSON.parse(init.body).response === 'iyi' }), { status: 200 })
    },
  })
  assert.deepEqual(await verifier.verify('iyi', '203.0.113.5'), { ok: true, skipped: false })
  assert.equal(calls[0].url, TURNSTILE_SITEVERIFY_URL)
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.deepEqual(calls[0].body, { secret: 'GIZLI-SECRET', response: 'iyi', remoteip: '203.0.113.5' })
  assert.deepEqual(await verifier.verify('kotu'), { ok: false, reason: 'REJECTED' })
  assert.deepEqual(await verifier.verify(''), { ok: false, reason: 'MISSING_TOKEN' })
  assert.equal(verifier.siteKey(), 'site')

  const down = createTurnstileVerifier({ secret: 's', siteKey: 'k', production: true, fetchImpl: async () => { throw new Error('ağ') } })
  assert.deepEqual(await down.verify('iyi'), { ok: false, reason: 'UNAVAILABLE' })
  const fiveHundred = createTurnstileVerifier({ secret: 's', siteKey: 'k', production: true, fetchImpl: async () => new Response('x', { status: 500 }) })
  assert.deepEqual(await fiveHundred.verify('iyi'), { ok: false, reason: 'UNAVAILABLE' })

  const prodNoSecret = createTurnstileVerifier({ secret: '', siteKey: '', production: true })
  assert.equal(prodNoSecret.isConfigured(), false)
  assert.deepEqual(await prodNoSecret.verify('iyi'), { ok: false, reason: 'NOT_CONFIGURED' })

  const devNoSecret = createTurnstileVerifier({ secret: '', siteKey: '', production: false })
  assert.equal(devNoSecret.isConfigured(), true)
  assert.deepEqual(await devNoSecret.verify(undefined), { ok: true, skipped: true })
  assert.equal(devNoSecret.siteKey(), null)
})
