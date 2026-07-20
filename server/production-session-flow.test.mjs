import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// Production organization login/session regresyon testleri A-I. Kök neden:
// ana Express app'te cookie-parser kayıtlı olmadığında tenantAuth (requireAuth)
// request.cookies'i okuyamaz ve geçerli cargoflow_session cookie'sine rağmen
// 401 döner. Bu test ana-app wiring'ini (cookieParser + requireAuth korumalı
// onboarding endpoint) birebir yeniden kurar ve index.mjs'in cookieParser'ı
// kaydettiğini kaynak seviyesinde de doğrular. Sürat create çağrısı ÜRETİLMEZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const { createAuthRouter } = await import('./auth/routes.ts')
const { createPlatformAdminRouter } = await import('./admin/adminRoutes.ts')
const { requireAuth } = await import('./auth/middleware.ts')
const { createPlatformAdmin } = await import('./admin/platformAdminAccount.ts')
const { createSession } = await import('./auth/session.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}
function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
}
function cookieFrom(response, name) {
  const setCookie = response.headers.getSetCookie?.() ?? []
  const c = setCookie.find((x) => x.startsWith(`${name}=`))
  return c ? c.split(';')[0] : null
}
function rawSetCookie(response, name) {
  const setCookie = response.headers.getSetCookie?.() ?? []
  return setCookie.find((x) => x.startsWith(`${name}=`)) ?? ''
}

// Production ana-app wiring: cookieParser + auth router + admin router +
// tenantAuth-korumalı onboarding endpoint (requireAuth ana app üzerinde).
function buildApp(db) {
  const app = express()
  app.use(cookieParser()) // ← DÜZELTME: ana app cookie'leri parse eder
  app.use('/api/auth', createAuthRouter({ db }))
  app.use('/api/platform-admin', createPlatformAdminRouter({ db }))
  // onboarding/status gibi endpoint'ler ana app'te requireAuth ile korunur.
  app.get('/api/onboarding/status', requireAuth(db), (request, response) => {
    response.json({ ok: true, completed: false, organizationId: request.auth.organizationId })
  })
  return app
}

async function makeOrgUser(db, name, slug, username) {
  const [org] = await db.insert(schema.organizations).values({ name, slug, status: 'active' }).returning()
  // argon2 hash yerine gerçek login için password.ts kullan.
  const { hashPassword } = await import('./auth/password.ts')
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, username, passwordHash: await hashPassword('sifre123'), status: 'active' })
    .returning()
  return { organizationId: org.id, userId: user.id }
}

test('production session A-I: cookie parse, login→me→onboarding, izolasyon', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const app = buildApp(db)
  const server = http.createServer(app)
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`

  const { organizationId } = await makeOrgUser(db, 'Alfa', 'alfa', 'alfauser')

  // A) Login → Set-Cookie → /api/auth/me → 200.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alfauser', password: 'sifre123' }),
  })
  assert.equal(login.status, 200)
  const orgCookie = cookieFrom(login, 'cargoflow_session')
  assert.ok(orgCookie, 'cargoflow_session cookie set edildi')
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: orgCookie } })
  assert.equal(me.status, 200)

  // B) AYNI cookie ile /api/onboarding/status (ana app, requireAuth) → 200.
  // (Regresyon: cookieParser olmadan bu 401 dönerdi.)
  const status = await fetch(`${base}/api/onboarding/status`, { headers: { Cookie: orgCookie } })
  assert.equal(status.status, 200, 'onboarding status geçerli cookie ile 200 döner')
  const statusBody = await status.json()
  assert.equal(statusBody.organizationId, organizationId)

  // Cookie olmadan onboarding status → 401.
  assert.equal((await fetch(`${base}/api/onboarding/status`)).status, 401)

  // C) Yeniden başlatma sonrası session geçerli kalır (yeni db örneği).
  const db2 = drizzle(pglite, { schema })
  const app2 = buildApp(db2)
  const server2 = http.createServer(app2)
  const port2 = await listen(server2)
  t.after(() => server2.close())
  assert.equal(
    (await fetch(`http://127.0.0.1:${port2}/api/onboarding/status`, { headers: { Cookie: orgCookie } })).status,
    200,
    'restart sonrası aynı cookie geçerli',
  )

  // D/E) Admin cookie organization auth sağlamaz; org cookie admin auth sağlamaz.
  await createPlatformAdmin(db, 'root', 'rootpass1')
  const adminLogin = await fetch(`${base}/api/platform-admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'rootpass1' }),
  })
  const adminCookie = cookieFrom(adminLogin, 'cargoflow_admin_session')
  assert.ok(adminCookie)
  // D) admin cookie ile organization onboarding → 401.
  assert.equal(
    (await fetch(`${base}/api/onboarding/status`, { headers: { Cookie: adminCookie } })).status,
    401,
    'admin cookie organization auth sağlamaz',
  )
  // E) org cookie ile admin endpoint → 401.
  assert.equal(
    (await fetch(`${base}/api/platform-admin/organizations`, { headers: { Cookie: orgCookie } })).status,
    401,
    'org cookie admin auth sağlamaz',
  )

  // F) Expired ve revoked session → 401.
  const expiredOrg = await makeOrgUser(db, 'Beta', 'beta', 'betauser')
  const expiredSession = await createSession(db, expiredOrg.userId, expiredOrg.organizationId)
  // expiresAt'i geçmişe çek.
  await db
    .update(schema.sessions)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.sessions.tokenHash, (await import('./auth/session.ts')).hashSessionToken(expiredSession.token)))
  assert.equal(
    (await fetch(`${base}/api/onboarding/status`, { headers: { Cookie: `cargoflow_session=${expiredSession.token}` } })).status,
    401,
    'expired session 401',
  )
  const revokedSession = await createSession(db, expiredOrg.userId, expiredOrg.organizationId)
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.tokenHash, (await import('./auth/session.ts')).hashSessionToken(revokedSession.token)))
  assert.equal(
    (await fetch(`${base}/api/onboarding/status`, { headers: { Cookie: `cargoflow_session=${revokedSession.token}` } })).status,
    401,
    'revoked session 401',
  )

  // G) ACTIVE user + ACTIVE org başarılı (A/B ile kanıtlandı; disabled user 401).
  await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, expiredOrg.userId))
  const activeSession = await createSession(db, expiredOrg.userId, expiredOrg.organizationId)
  assert.equal(
    (await fetch(`${base}/api/onboarding/status`, { headers: { Cookie: `cargoflow_session=${activeSession.token}` } })).status,
    401,
    'disabled user session 401',
  )

  // I) Session akışları boyunca Sürat create ÇAĞRILMADI.
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 0)
  assert.equal((await db.select().from(schema.shipments)).length, 0)
})

// H) Production'da Secure + SameSite=Lax cookie set edilir (same-origin HTTPS).
test('production Secure/SameSite cookie (H)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  await makeOrgUser(db, 'Gama', 'gama', 'gamauser')
  const app = buildApp(db)
  const server = http.createServer(app)
  const port = await listen(server)
  t.after(() => server.close())

  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  t.after(() => {
    if (prev === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prev
  })
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'gamauser', password: 'sifre123' }),
  })
  const raw = rawSetCookie(login, 'cargoflow_session')
  assert.match(raw, /HttpOnly/i, 'HttpOnly')
  assert.match(raw, /Secure/i, 'production Secure')
  assert.match(raw, /SameSite=Lax/i, 'SameSite=Lax')
})

// Kaynak-seviyesi regresyon guard'ı: index.mjs ana app'te cookie-parser'ı
// kaydeder (tenantAuth request.cookies'e bağımlıdır).
test('regression: index.mjs ana app cookieParser kaydeder', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(source, /import\s+cookieParser\s+from\s+['"]cookie-parser['"]/)
  assert.match(source, /app\.use\(cookieParser\(\)\)/)
})
