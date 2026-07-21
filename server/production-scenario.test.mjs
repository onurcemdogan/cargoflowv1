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

// ÜRETİM SENARYOSU (1-14): boş veritabanından başlayıp gerçek sunucuda
// izlenecek akışın AYNISI tek sırada çalıştırılır. Sürat create çağrısı YOK.
// Secret/parola loglanmaz; yalnız hash UZUNLUĞU doğrulanır.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
// Bypass KAPALI olmalı: üretim senaryosu gerçek auth ile doğrulanır.
delete process.env.CARGOFLOW_AUTH_BYPASS

const { createAuthRouter } = await import('./auth/routes.ts')
const { createPlatformAdminRouter } = await import('./admin/adminRoutes.ts')
const { requireAuth } = await import('./auth/middleware.ts')
const {
  createPlatformAdmin,
  describePlatformAdmin,
  resetPlatformAdminPassword,
} = await import('./admin/platformAdminAccount.ts')
const { resetOrganizationUserPassword } = await import('./admin/orgUserPassword.ts')
const orders = await import('./orders/orderPersistenceService.ts')
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

test('ÜRETİM SENARYOSU 1-14: boş DB → admin → organizasyon → kullanıcı → giriş', async (t) => {
  // ---- 1) BOŞ VERİTABANINDA MIGRATION ÇALIŞIR ----------------------------
  const pglite = new PGlite() // tamamen boş veritabanı
  t.after(() => pglite.close())
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })

  const tables = await pglite.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  )
  const tableNames = tables.rows.map((r) => r.table_name)
  for (const required of [
    'organizations',
    'users',
    'sessions',
    'platform_admins',
    'platform_admin_sessions',
    'platform_admin_audit_logs',
    'organization_settings',
    'orders',
    'products',
    'shipments',
    'shipment_operations',
  ]) {
    assert.ok(tableNames.includes(required), `migration tablosu: ${required}`)
  }
  // Boş başlangıç.
  assert.equal((await db.select().from(schema.platformAdmins)).length, 0)
  assert.equal((await db.select().from(schema.organizations)).length, 0)

  const app = express()
  app.use(cookieParser())
  app.use('/api/auth', createAuthRouter({ db }))
  app.use('/api/platform-admin', createPlatformAdminRouter({ db }))
  app.get('/api/test/whoami', requireAuth(db), (request, response) => {
    response.json({ ok: true, organizationId: request.auth.organizationId })
  })
  const server = http.createServer(app)
  const port = await listen(server)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`

  const adminLogin = (username, password) =>
    fetch(`${base}/api/platform-admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  const userLogin = (username, password) =>
    fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })

  // ---- 2) İLK PLATFORM ADMIN GÜVENLİ CLI İLE OLUŞTURULUR -----------------
  const created = await createPlatformAdmin(db, 'admin', 'AdminParola1')
  assert.equal(created.username, 'admin')
  const adminRecord = await describePlatformAdmin(db, 'admin')
  assert.equal(adminRecord.status, 'active')
  assert.equal(adminRecord.hashLength, 97)

  // ---- 3) PLATFORM ADMIN DOĞRU PAROLAYLA GİRER ---------------------------
  const adminOk = await adminLogin('admin', 'AdminParola1')
  assert.equal(adminOk.status, 200)
  let adminCookie = cookieFrom(adminOk, 'cargoflow_admin_session')
  assert.ok(adminCookie, 'admin session cookie')

  // ---- 4) YANLIŞ PAROLA 401 ---------------------------------------------
  const adminBad = await adminLogin('admin', 'YanlisParola')
  assert.equal(adminBad.status, 401)
  assert.match((await adminBad.json()).message, /Yönetici kullanıcı adı veya şifre hatalı/)

  // ---- 5) AYNI ADMIN TEKRAR OLUŞTURULAMAZ (AÇIK HATA) --------------------
  await assert.rejects(
    () => createPlatformAdmin(db, 'admin', 'BaskaParola1'),
    /zaten var/,
  )
  assert.equal((await db.select().from(schema.platformAdmins)).length, 1)

  // ---- 6) PLATFORM ADMIN YENİ ORGANİZASYON OLUŞTURUR ---------------------
  const createOrg = (organizationName, username, password) =>
    fetch(`${base}/api/platform-admin/organizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ organizationName, username, password }),
    })
  const orgRes = await createOrg('Alfa Lojistik', 'alfauser', 'AlfaParola1')
  assert.equal(orgRes.status, 201)
  const alfa = await orgRes.json()
  assert.ok(alfa.organizationId && alfa.userId)
  // Parola/hash response'a DÖNMEZ.
  assert.equal(alfa.password, undefined)
  assert.equal(alfa.passwordHash, undefined)

  // ---- 7) ORGANİZASYONA AKTİF KULLANICI OLUŞTURULUR ----------------------
  const alfaUser = (
    await db.select().from(schema.users).where(eq(schema.users.id, alfa.userId))
  )[0]
  assert.equal(alfaUser.status, 'active')
  assert.equal(String(alfaUser.organizationId), alfa.organizationId)
  const alfaOrg = (
    await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, alfa.organizationId))
  )[0]
  assert.equal(alfaOrg.status, 'active')
  // Yeni organizasyon boş + onboarding tamamlanmamış başlar.
  const settings = (
    await db
      .select()
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, alfa.organizationId))
  )[0]
  assert.equal(settings.onboardingCompleted, false)

  // ---- 8) YENİ KULLANICI DOĞRU PAROLAYLA GİRER ---------------------------
  const userOk = await userLogin('alfauser', 'AlfaParola1')
  assert.equal(userOk.status, 200)
  let userCookie = cookieFrom(userOk, 'cargoflow_session')
  assert.ok(userCookie)
  const whoami = await fetch(`${base}/api/test/whoami`, { headers: { Cookie: userCookie } })
  assert.equal(whoami.status, 200)
  assert.equal((await whoami.json()).organizationId, alfa.organizationId)
  // Yanlış parola 401.
  assert.equal((await userLogin('alfauser', 'YanlisParola')).status, 401)

  // ---- 9) KULLANICI PAROLA SIFIRLAMA: yeni çalışır, eski çalışmaz --------
  const reset = await resetOrganizationUserPassword(db, 'alfauser', 'YeniAlfa1')
  assert.equal(reset.previousHashLength, 97)
  assert.equal(reset.newHashLength, 97)
  assert.ok(reset.revokedSessions >= 1, 'sıfırlama eski oturumları revoke eder')
  assert.equal((await userLogin('alfauser', 'AlfaParola1')).status, 401, 'eski parola çalışmaz')
  const userOk2 = await userLogin('alfauser', 'YeniAlfa1')
  assert.equal(userOk2.status, 200, 'yeni parola çalışır')
  // Sıfırlama öncesi cookie geçersiz.
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: userCookie } })).status,
    401,
  )
  userCookie = cookieFrom(userOk2, 'cargoflow_session')

  // ---- 10) PLATFORM ADMIN PAROLA SIFIRLAMA -------------------------------
  await resetPlatformAdminPassword(db, 'admin', 'YeniAdmin1')
  assert.equal((await adminLogin('admin', 'AdminParola1')).status, 401, 'eski admin parolası çalışmaz')
  const adminOk2 = await adminLogin('admin', 'YeniAdmin1')
  assert.equal(adminOk2.status, 200, 'yeni admin parolası çalışır')
  // Eski admin cookie revoke edildi.
  assert.equal(
    (await fetch(`${base}/api/platform-admin/organizations`, { headers: { Cookie: adminCookie } }))
      .status,
    401,
  )
  adminCookie = cookieFrom(adminOk2, 'cargoflow_admin_session')

  // ---- 11) TÜM HASH'LER TAM VE GEÇERLİ ARGON2ID --------------------------
  const allUsers = await db.select().from(schema.users)
  const allAdmins = await db.select().from(schema.platformAdmins)
  for (const row of [...allUsers, ...allAdmins]) {
    const hash = String(row.passwordHash)
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/, 'argon2id parametreleri')
    assert.equal(hash.length, 97, 'hash 97 karakter (tam)')
    assert.equal(hash.split('$').length, 6, 'hash yapısı bozulmamış')
  }

  // ---- 12) KAYITLAR VERİTABANINDA GERÇEKTEN OLUŞUR (ham SQL) -------------
  const dbName = await pglite.query('SELECT current_database() AS database')
  assert.ok(String(dbName.rows[0].database).length > 0, 'bağlı veritabanı adı okunur')
  const rawUsers = await pglite.query(
    'SELECT username, status, length(password_hash) AS hash_length FROM users',
  )
  assert.equal(rawUsers.rows.length, 1)
  assert.equal(rawUsers.rows[0].username, 'alfauser')
  assert.equal(rawUsers.rows[0].status, 'active')
  assert.equal(Number(rawUsers.rows[0].hash_length), 97)
  const rawAdmins = await pglite.query(
    'SELECT username, status, length(password_hash) AS hash_length FROM platform_admins',
  )
  assert.equal(rawAdmins.rows.length, 1)
  assert.equal(rawAdmins.rows[0].username, 'admin')
  assert.equal(rawAdmins.rows[0].status, 'active')
  assert.equal(Number(rawAdmins.rows[0].hash_length), 97)

  // ---- 13) SESSION REVOKE DOĞRU ÇALIŞIR ----------------------------------
  // Aktif oturum var; admin panelinden oturumları kapat.
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: userCookie } })).status,
    200,
  )
  const revoke = await fetch(
    `${base}/api/platform-admin/users/${alfa.userId}/revoke-sessions`,
    { method: 'POST', headers: { Cookie: adminCookie } },
  )
  assert.equal(revoke.status, 200)
  assert.ok((await revoke.json()).revokedSessions >= 1)
  assert.equal(
    (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: userCookie } })).status,
    401,
    'revoke sonrası oturum geçersiz',
  )
  // DB'de revoked_at dolu.
  const sessionRows = await pglite.query(
    'SELECT revoked_at FROM sessions WHERE user_id = $1',
    [alfa.userId],
  )
  assert.ok(sessionRows.rows.every((r) => r.revoked_at !== null))

  // ---- 14) TENANT ISOLATION BOZULMAZ -------------------------------------
  const org2Res = await createOrg('Beta Ticaret', 'betauser', 'BetaParola1')
  assert.equal(org2Res.status, 201)
  const beta = await org2Res.json()

  // Alfa'ya sipariş + ürün yaz; Beta'ya hiçbir şey yazma.
  await orders.persistSyncResult(
    db,
    alfa.organizationId,
    [
      {
        marketplace: 'Trendyol',
        packageId: 'PKG-ALFA-1',
        orderNumber: 'ORD-ALFA-1',
        orderDate: '2026-07-10T00:00:00Z',
        items: [],
      },
    ],
    { complete: true },
  )
  await products.persistProductSyncResult(
    db,
    alfa.organizationId,
    [
      {
        marketplace: 'Trendyol',
        externalProductId: 'P-ALFA',
        externalVariantId: 'V-ALFA',
        productName: 'Alfa Ürün',
        sku: 'SKU-ALFA',
        barcode: 'BRC-ALFA',
        stock: 1,
        price: 10,
        images: [],
        updatedAt: '2026-07-10T00:00:00Z',
      },
    ],
    { complete: true },
  )

  // Alfa kendi verisini görür.
  assert.equal((await orders.listOrders(db, alfa.organizationId, {})).total, 1)
  assert.equal((await products.listProducts(db, alfa.organizationId, {})).total, 1)
  // Beta HİÇBİR şey görmez.
  assert.equal((await orders.listOrders(db, beta.organizationId, {})).total, 0)
  assert.equal((await products.listProducts(db, beta.organizationId, {})).total, 0)
  // Çapraz org tekil erişim engellenir.
  const alfaOrder = (await orders.listOrders(db, alfa.organizationId, {})).orders[0]
  assert.ok(await orders.getOrder(db, alfa.organizationId, alfaOrder.id))
  assert.equal(
    await orders.getOrder(db, beta.organizationId, alfaOrder.id),
    null,
    'başka organizasyonun siparişi görünmez',
  )
  // Barkod lookup org-scoped.
  assert.ok(await products.resolveVariantByBarcode(db, alfa.organizationId, 'BRC-ALFA'))
  assert.equal(
    await products.resolveVariantByBarcode(db, beta.organizationId, 'BRC-ALFA'),
    null,
  )
  // Beta kullanıcısı giriş yapar ve YALNIZ kendi org'unu görür.
  const betaLogin = await userLogin('betauser', 'BetaParola1')
  assert.equal(betaLogin.status, 200)
  const betaCookie = cookieFrom(betaLogin, 'cargoflow_session')
  const betaWho = await fetch(`${base}/api/test/whoami`, { headers: { Cookie: betaCookie } })
  assert.equal((await betaWho.json()).organizationId, beta.organizationId)
  assert.notEqual(beta.organizationId, alfa.organizationId)

  // Sürat create çağrısı ÜRETİLMEDİ.
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 0)
  assert.equal((await db.select().from(schema.shipments)).length, 0)
})
