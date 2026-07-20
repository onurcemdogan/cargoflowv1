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

// Platform admin paneli (faz 8) hermetik testleri A-P. Gerçek PostgreSQL motoru
// (pglite) + gerçek express router'ları. Organization auth cookie'si admin
// erişimi SAĞLAMAZ; admin cookie'si organization erişimi sağlamaz. Sürat create
// çağrısı ÜRETİLMEZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const { createPlatformAdminRouter } = await import('./admin/adminRoutes.ts')
const { createAuthRouter } = await import('./auth/routes.ts')
const { createPlatformAdmin } = await import('./admin/platformAdminAccount.ts')
const { requireAuth } = await import('./auth/middleware.ts')
const products = await import('./products/productPersistenceService.ts')

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

test('platform admin A-P: izolasyon, yönetim, audit, Sürat create=0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())

  const app = express()
  app.use(cookieParser())
  app.use('/api/auth', createAuthRouter({ db }))
  app.use('/api/platform-admin', createPlatformAdminRouter({ db }))
  // Organization tarafı doğrulaması için test whoami.
  app.get('/api/test/whoami', requireAuth(db), (request, response) => {
    response.json({ ok: true, organizationId: request.auth.organizationId })
  })
  const server = http.createServer(app)
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`

  // A) Platform admin CLI çekirdeği ile oluşturulur (public endpoint YOK).
  await createPlatformAdmin(db, 'root', 'rootpass1')
  const adminRow = await db.select().from(schema.platformAdmins)
  assert.equal(adminRow.length, 1)
  assert.equal(adminRow[0].username, 'root')
  assert.ok(String(adminRow[0].passwordHash).startsWith('$argon2id$'))

  // O) Public admin bootstrap YOK: böyle bir route 404.
  assert.equal(
    (await fetch(`${base}/api/platform-admin/bootstrap`, { method: 'POST' })).status,
    404,
  )

  // D) Yanlış admin login → 401 genel hata.
  const badLogin = await fetch(`${base}/api/platform-admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'yanlis' }),
  })
  assert.equal(badLogin.status, 401)
  assert.match((await badLogin.json()).message, /Yönetici kullanıcı adı veya şifre hatalı/)

  // C) Admin login başarılı → admin cookie set edilir.
  const loginRes = await fetch(`${base}/api/platform-admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'rootpass1' }),
  })
  assert.equal(loginRes.status, 200)
  const adminCookie = cookieFrom(loginRes, 'cargoflow_admin_session')
  assert.ok(adminCookie, 'admin cookie set edildi')
  assert.ok(adminCookie.startsWith('cargoflow_admin_session='))

  // B/N) Admin cookie olmadan yönetim uçları 401.
  assert.equal(
    (await fetch(`${base}/api/platform-admin/organizations`)).status,
    401,
  )

  // E) Admin yeni organization + kullanıcı oluşturur.
  const createRes = await fetch(`${base}/api/platform-admin/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      organizationName: 'Beta Ticaret',
      username: 'betauser',
      password: 'betapass1',
    }),
  })
  assert.equal(createRes.status, 201)
  const created = await createRes.json()
  assert.ok(created.organizationId && created.userId)
  // Parola/hash RESPONSE'a dönmez.
  assert.equal(created.password, undefined)
  assert.equal(created.passwordHash, undefined)

  // F) Yeni organization onboarding false + boş başlar.
  const settings = await db
    .select()
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, created.organizationId))
  assert.equal(settings[0].onboardingCompleted, false)
  assert.equal((await db.select().from(schema.products)).length, 0)
  assert.equal((await db.select().from(schema.orders)).length, 0)

  // N) Organization kullanıcısı login olur; org cookie admin erişimi SAĞLAMAZ.
  const orgLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'betauser', password: 'betapass1' }),
  })
  assert.equal(orgLogin.status, 200)
  const orgCookie = cookieFrom(orgLogin, 'cargoflow_session')
  assert.ok(orgCookie)
  // B) org cookie ile admin endpoint → 401.
  assert.equal(
    (
      await fetch(`${base}/api/platform-admin/organizations`, {
        headers: { Cookie: orgCookie },
      })
    ).status,
    401,
  )
  // N) admin cookie ile organization whoami → 401 (karışmaz).
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: adminCookie } })).status,
    401,
  )
  // Org cookie whoami çalışır.
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: orgCookie } })).status,
    200,
  )

  // K) Admin organizasyon listesinde hash/secret YOK.
  const listRes = await fetch(`${base}/api/platform-admin/organizations`, {
    headers: { Cookie: adminCookie },
  })
  const listBody = await listRes.json()
  const listDump = JSON.stringify(listBody)
  assert.ok(!/passwordHash|encryptedPayload|password|apiSecret|sifre/i.test(listDump), 'listede secret yok')
  const betaRow = listBody.organizations.find((o) => o.organizationId === created.organizationId)
  assert.equal(betaRow.onboardingCompleted, false)
  assert.equal(betaRow.orderCount, 0)
  assert.equal(betaRow.productCount, 0)
  assert.equal(betaRow.activeSessionCount, 1, 'aktif org session sayısı')

  // J) Parola reset eski org session'larını revoke eder.
  const resetRes = await fetch(
    `${base}/api/platform-admin/users/${created.userId}/reset-password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ password: 'yenipass1' }),
    },
  )
  assert.equal(resetRes.status, 200)
  const resetBody = await resetRes.json()
  assert.ok(resetBody.revokedSessions >= 1)
  assert.equal(resetBody.password, undefined)
  // Eski org session artık geçersiz.
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: orgCookie } })).status,
    401,
    'reset sonrası eski session geçersiz',
  )
  // Yeni parola ile login olur.
  const reLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'betauser', password: 'yenipass1' }),
  })
  assert.equal(reLogin.status, 200)
  const orgCookie2 = cookieFrom(reLogin, 'cargoflow_session')

  // I) User disable → aktif session revoke, whoami 401.
  const disableRes = await fetch(
    `${base}/api/platform-admin/users/${created.userId}/status`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'DISABLED' }),
    },
  )
  assert.equal(disableRes.status, 200)
  assert.ok((await disableRes.json()).revokedSessions >= 1)
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: orgCookie2 } })).status,
    401,
    'disable sonrası session geçersiz',
  )
  // Disabled kullanıcı login OLAMAZ.
  assert.equal(
    (
      await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'betauser', password: 'yenipass1' }),
      })
    ).status,
    401,
  )
  // Tekrar aktifleştir + login.
  await fetch(`${base}/api/platform-admin/users/${created.userId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ status: 'ACTIVE' }),
  })
  const orgLogin3 = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'betauser', password: 'yenipass1' }),
  })
  const orgCookie3 = cookieFrom(orgLogin3, 'cargoflow_session')

  // G/H) Organization suspend → session'lar revoke, whoami 401, login etkisiz.
  const suspendRes = await fetch(
    `${base}/api/platform-admin/organizations/${created.organizationId}/status`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'SUSPENDED' }),
    },
  )
  assert.equal(suspendRes.status, 200)
  assert.ok((await suspendRes.json()).revokedSessions >= 1)
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: orgCookie3 } })).status,
    401,
    'suspend sonrası session geçersiz',
  )
  // H) Suspended org kullanıcısı yeni login yapsa bile oturum aktif SAYILMAZ.
  const suspendedLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'betauser', password: 'yenipass1' }),
  })
  const suspendedCookie = cookieFrom(suspendedLogin, 'cargoflow_session')
  if (suspendedCookie) {
    assert.equal(
      (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: suspendedCookie } })).status,
      401,
      'suspended org oturumu erişemez',
    )
  }
  // Veri SİLİNMEZ: org + user hâlâ DB'de.
  assert.equal((await db.select().from(schema.organizations)).length, 1)
  assert.equal((await db.select().from(schema.users)).length, 1)

  // M) Başka organization verisi karışmaz: ikinci org oluştur, ürün ekle,
  // sayaçlar org bazında ayrı.
  const org2Res = await fetch(`${base}/api/platform-admin/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ organizationName: 'Gama', username: 'gamauser', password: 'gamapass1' }),
  })
  const org2 = await org2Res.json()
  await products.persistProductSyncResult(
    db,
    org2.organizationId,
    [{ marketplace: 'Trendyol', externalProductId: 'GP-1', externalVariantId: 'GV-1', productName: 'X', sku: 'S', barcode: 'B', stock: 1, price: 1, images: [], updatedAt: '2026-07-10T00:00:00Z' }],
    { complete: true },
  )
  const list2 = await (
    await fetch(`${base}/api/platform-admin/organizations`, { headers: { Cookie: adminCookie } })
  ).json()
  const gama = list2.organizations.find((o) => o.organizationId === org2.organizationId)
  const beta = list2.organizations.find((o) => o.organizationId === created.organizationId)
  assert.equal(gama.productCount, 1)
  assert.equal(beta.productCount, 0, 'Gama ürünü Beta sayacına karışmaz')

  // L) Audit loglar oluştu: create/suspend/disable/password_reset kayıtları var.
  const audits = await db.select().from(schema.platformAdminAuditLogs)
  const actions = new Set(audits.map((a) => String(a.action)))
  for (const expected of ['organization_created', 'organization_suspended', 'user_disabled', 'user_enabled', 'password_reset']) {
    assert.ok(actions.has(expected), `audit: ${expected}`)
  }
  // Audit'te secret/parola YOK.
  assert.ok(!/rootpass1|betapass1|yenipass1|gamapass1|passwordHash/.test(JSON.stringify(audits)))

  // P) Tüm admin akışları boyunca Sürat create ÇAĞRILMADI.
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 0)
  assert.equal((await db.select().from(schema.shipments)).length, 0)
})
