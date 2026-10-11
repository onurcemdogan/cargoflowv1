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

// PHASE2-B — ÇALIŞMA ALANI + ÜYELİK (hermetik: pglite + gerçek migration +
// gerçek express/HTTP). Kayıt → doğrulama → giriş → çalışma alanı → kiracı.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const { createAuthRouter } = await import('./auth/routes.ts')
const { requireAuth } = await import('./auth/middleware.ts')
const { createMemoryEmailProvider } = await import('./email/memoryEmailProvider.ts')
const { hashPassword } = await import('./auth/password.ts')
const workspaces = await import('./auth/workspaces.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const statements = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    statements.push(...readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean))
  }
  return statements
}

async function startApp(t) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  t.after(() => pglite.close())
  const email = createMemoryEmailProvider()
  const app = express()
  app.use(
    '/api/auth',
    createAuthRouter({
      db,
      rateLimit: { windowMs: 60_000, limit: 1000 },
      selfService: {
        emailProvider: email,
        turnstile: { isConfigured: () => true, siteKey: () => null, verify: async () => ({ ok: true, skipped: true }) },
        appBaseUrl: 'https://panel.example.test',
        signupFlag: true,
        rateLimit: { windowMs: 60_000, limit: 1000 },
      },
    }),
  )
  app.get('/api/tenant-probe', cookieParser(), requireAuth(db), (request, response) => {
    response.json({ ok: true, organizationId: request.auth.organizationId })
  })
  const server = http.createServer(app)
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { base: `http://127.0.0.1:${port}`, db, pglite, email }
}

async function post(base, path, body, cookie) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  })
}

function cookieOf(response) {
  const c = (response.headers.getSetCookie?.() ?? []).find((v) => v.startsWith('cargoflow_session='))
  return c ? c.split(';')[0] : ''
}

async function verifiedSession(app, email = 'sahip@ornek.com') {
  await post(app.base, '/api/auth/signup', { email, password: 'cok-guclu-sifre-1', turnstileToken: 'x' })
  const mail = app.email.sent.at(-1)
  const token = decodeURIComponent(mail.text.match(/token=([A-Za-z0-9_%-]+)/)[1])
  assert.equal((await post(app.base, '/api/auth/verify-email', { token })).status, 200)
  const login = await post(app.base, '/api/auth/login', { username: email, password: 'cok-guclu-sifre-1' })
  assert.equal(login.status, 200)
  return cookieOf(login)
}

const me = async (app, cookie) => (await fetch(`${app.base}/api/auth/me`, { headers: { Cookie: cookie } })).json()

test('WS-1: kayıt → doğrulama → giriş → çalışma alanı → kiracı erişimi; kullanıcı owner olur', async (t) => {
  const app = await startApp(t)
  const cookie = await verifiedSession(app)
  assert.equal((await fetch(`${app.base}/api/tenant-probe`, { headers: { Cookie: cookie } })).status, 403)

  const created = await post(app.base, '/api/auth/workspace', { name: '  Ada   Moda  ' }, cookie)
  assert.equal(created.status, 201)
  const body = await created.json()
  assert.equal(body.organization.name, 'Ada Moda')
  assert.equal(body.organization.slug, 'ada-moda')

  const profile = await me(app, cookie)
  assert.equal(profile.needsWorkspace, false)
  assert.equal(profile.user.organization.id, body.organization.id)
  const probe = await fetch(`${app.base}/api/tenant-probe`, { headers: { Cookie: cookie } })
  assert.equal(probe.status, 200)
  assert.equal((await probe.json()).organizationId, body.organization.id)

  const user = (await app.pglite.query(`select id, organization_id from users where email_normalized = 'sahip@ornek.com'`)).rows[0]
  assert.equal(user.organization_id, body.organization.id)
  const members = (await app.pglite.query('select * from organization_members')).rows
  assert.deepEqual(members.map((m) => [m.organization_id, m.user_id, m.role]), [[body.organization.id, user.id, 'owner']])
  const settings = (await app.pglite.query('select onboarding_completed from organization_settings where organization_id = $1', [body.organization.id])).rows
  assert.deepEqual(settings, [{ onboarding_completed: false }])

  // Yeni giriş aynı çalışma alanını seçer.
  const again = cookieOf(await post(app.base, '/api/auth/login', { username: 'sahip@ornek.com', password: 'cok-guclu-sifre-1' }))
  assert.equal((await me(app, again)).user.organization.id, body.organization.id)
})

test('WS-2: ikinci çalışma alanı açılamaz; eşzamanlı istekte TEK firma oluşur', async (t) => {
  const app = await startApp(t)
  const cookie = await verifiedSession(app)
  const results = await Promise.all([
    post(app.base, '/api/auth/workspace', { name: 'Bir' }, cookie),
    post(app.base, '/api/auth/workspace', { name: 'İki' }, cookie),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
  assert.equal((await app.pglite.query('select count(*)::int as n from organizations')).rows[0].n, 1)
  assert.equal((await app.pglite.query('select count(*)::int as n from organization_members')).rows[0].n, 1)
  const third = await post(app.base, '/api/auth/workspace', { name: 'Üç' }, cookie)
  assert.equal(third.status, 409)
  assert.equal((await third.json()).code, 'WORKSPACE_EXISTS')
})

test('WS-3: geçersiz ad ve oturumsuz istek reddedilir; firma OLUŞMAZ', async (t) => {
  const app = await startApp(t)
  assert.equal((await post(app.base, '/api/auth/workspace', { name: 'Firma' })).status, 401)
  const cookie = await verifiedSession(app)
  for (const name of ['', ' a ', 'x'.repeat(121)]) {
    const response = await post(app.base, '/api/auth/workspace', { name }, cookie)
    assert.equal(response.status, 400)
  }
  assert.equal((await app.pglite.query('select count(*)::int as n from organizations')).rows[0].n, 0)
})

test('WS-4: üyelik satırı olmayan ESKİ hesap girişte owner olur; ikinci firma açamaz', async (t) => {
  const app = await startApp(t)
  const [org] = await app.db.insert(schema.organizations).values({ name: 'Eski Firma', slug: 'eski-firma' }).returning()
  await app.db.insert(schema.users).values({ organizationId: org.id, username: 'eskikullanici', passwordHash: await hashPassword('eski-parola-123') })
  const login = await post(app.base, '/api/auth/login', { username: 'eskikullanici', password: 'eski-parola-123' })
  assert.equal(login.status, 200)
  const cookie = cookieOf(login)
  assert.equal((await me(app, cookie)).user.organization.id, org.id)
  const members = (await app.pglite.query('select role from organization_members')).rows
  assert.deepEqual(members, [{ role: 'owner' }])
  assert.equal((await post(app.base, '/api/auth/workspace', { name: 'Yeni' }, cookie)).status, 409)
})

test('WS-5: işletme profili doğrulama ve tamlık; rol sorgusu', async (t) => {
  const app = await startApp(t)
  assert.equal(workspaces.isOrganizationProfileComplete({ name: 'Ada', contactPhone: '0212 555 00 00', addressLine: 'Cad. 1', city: 'İstanbul', district: 'Kadıköy' }), true)
  assert.equal(workspaces.isOrganizationProfileComplete({ name: 'Ada', contactPhone: '0212', addressLine: 'Cad. 1', city: 'İstanbul', district: 'Kadıköy' }), false)
  assert.equal(workspaces.isOrganizationProfileComplete({ name: 'Ada', contactPhone: '0212 555 00 00', addressLine: '  ', city: 'İstanbul', district: 'Kadıköy' }), false)
  assert.equal(workspaces.isOrganizationProfileComplete(null), false)

  const invalidPhone = workspaces.validateOrganizationProfile({ name: 'Ada', contactPhone: 'telefon<script>' })
  assert.equal(invalidPhone.ok, false)
  assert.equal(invalidPhone.field, 'contactPhone')
  assert.equal(workspaces.validateOrganizationProfile({ name: 'A' }).ok, false)
  const valid = workspaces.validateOrganizationProfile({ name: ' Ada  Moda ', contactPhone: '+90 212 555 00 00', addressLine: ' Cad. 1 ', city: 'İstanbul', district: '' })
  assert.deepEqual(valid, { ok: true, profile: { name: 'Ada Moda', contactPhone: '+90 212 555 00 00', addressLine: 'Cad. 1', city: 'İstanbul', district: null } })

  const cookie = await verifiedSession(app)
  const { organization } = await (await post(app.base, '/api/auth/workspace', { name: 'Ada Moda' }, cookie)).json()
  const user = (await app.pglite.query('select id from users')).rows[0]
  assert.equal(await workspaces.findMembershipRole(app.db, organization.id, user.id), 'owner')
  await workspaces.updateOrganizationProfile(app.db, organization.id, valid.profile)
  const stored = await workspaces.getOrganizationProfile(app.db, organization.id)
  assert.equal(stored.contactPhone, '+90 212 555 00 00')
  assert.equal(workspaces.isOrganizationProfileComplete(stored), false, 'ilçe eksik')
})
