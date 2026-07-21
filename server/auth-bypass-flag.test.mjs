import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// CARGOFLOW_AUTH_BYPASS test modu: VARSAYILAN KAPALI olmalı; açıkken istekler
// gerçek bir organization'a bağlanmalı (tenant izolasyonu korunur).

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const { requireAuth } = await import('./auth/middleware.ts')
const { createAuthRouter } = await import('./auth/routes.ts')
const { isAuthBypassEnabled, resetBypassCache } = await import('./auth/devBypass.ts')

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
function buildApp(db) {
  const app = express()
  app.use(cookieParser())
  app.use('/api/auth', createAuthRouter({ db }))
  app.get('/api/test/whoami', requireAuth(db), (request, response) => {
    response.json({ ok: true, organizationId: request.auth.organizationId })
  })
  return app
}

test('bypass VARSAYILAN KAPALI: env yokken auth normal çalışır (401)', async (t) => {
  delete process.env.CARGOFLOW_AUTH_BYPASS
  resetBypassCache()
  t.after(() => resetBypassCache())
  assert.equal(isAuthBypassEnabled(), false, 'env yokken bypass kapalı')

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const server = http.createServer(buildApp(db))
  const port = await listen(server)
  t.after(() => server.close())

  // Oturumsuz istek → 401 (auth aynen korunuyor).
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/test/whoami`)).status, 401)
  // /me de authenticated dönmez.
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/me`)).status, 401)
})

test("bypass yalnız 'true' değeriyle açılır (yanlış değerler kapalı sayılır)", (t) => {
  t.after(() => {
    delete process.env.CARGOFLOW_AUTH_BYPASS
    resetBypassCache()
  })
  for (const value of ['false', '1', 'yes', 'TRUE ', '']) {
    process.env.CARGOFLOW_AUTH_BYPASS = value
    const expected = value.trim().toLowerCase() === 'true'
    assert.equal(isAuthBypassEnabled(), expected, `değer="${value}"`)
  }
})

test('bypass AÇIK: oturumsuz istek gerçek organization\'a bağlanır', async (t) => {
  process.env.CARGOFLOW_AUTH_BYPASS = 'true'
  resetBypassCache()
  t.after(() => {
    delete process.env.CARGOFLOW_AUTH_BYPASS
    resetBypassCache()
  })

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const server = http.createServer(buildApp(db))
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`

  // Oturum YOK ama bypass açık → 200 + gerçek organizationId.
  const who = await fetch(`${base}/api/test/whoami`)
  assert.equal(who.status, 200)
  const body = await who.json()
  assert.match(
    String(body.organizationId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'gerçek uuid organization (tenant scope korunur)',
  )

  // Demo organization + kullanıcı + onboarding kaydı DB'de oluştu.
  const orgs = await db.select().from(schema.organizations)
  assert.equal(orgs.length, 1)
  const settings = await db.select().from(schema.organizationSettings)
  assert.equal(settings[0].onboardingCompleted, true, 'doğrudan dashboard açılır')

  // /me authenticated döner → frontend giriş ekranını atlar.
  const me = await fetch(`${base}/api/auth/me`)
  assert.equal(me.status, 200)
  const mePayload = await me.json()
  assert.equal(mePayload.authenticated, true)
  assert.equal(mePayload.bypass, true)
  assert.equal(mePayload.user.organization.id, body.organizationId)
  // Secret/hash dönmez.
  assert.ok(!/passwordHash|argon2/i.test(JSON.stringify(mePayload)))

  // Mevcut organization varsa YENİSİ oluşturulmaz (aynı org'a bağlanır).
  resetBypassCache()
  const who2 = await fetch(`${base}/api/test/whoami`)
  assert.equal((await who2.json()).organizationId, body.organizationId)
  assert.equal((await db.select().from(schema.organizations)).length, 1)
})

test('auth kodu SİLİNMEDİ: requireAuth/session/tenant mantığı yerinde', () => {
  const middleware = readFileSync(join(here, 'auth', 'middleware.ts'), 'utf8')
  // Normal oturum çözümü hâlâ mevcut.
  assert.match(middleware, /findActiveSession/)
  assert.match(middleware, /resolveAuth\(db, request\)/)
  assert.match(middleware, /401/)
  // Bypass koşullu; koşulsuz next() yok.
  assert.match(middleware, /if \(isAuthBypassEnabled\(\)\)/)
})
