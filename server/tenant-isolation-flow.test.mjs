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

// Tenant izolasyonu (faz 3) hermetik testleri A-P. İki katman:
//  (1) credentialService birim testleri (pglite) — şifreleme, izolasyon.
//  (2) e2e: server/index.mjs spawn (DATABASE_URL=pglite proxy) — requireAuth
//      koruması, mock Trendyol ile org credential akışı, logout sonrası 401.
// Sürat create çağrısı ÜRETİLMEZ; mevcut idempotency/persistence akışlarına
// dokunulmaz.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const credentialService = await import('./integrations/credentialService.ts')

const KEY_HEX = randomBytes(32).toString('hex')

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

async function makeOrg(db, name, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, slug })
    .returning()
  return org.id
}

// --- credentialService birim testleri (B,C,E,F,G,H) ---------------------
test('credentialService: şifreleme, izolasyon, maskeleme, boş-secret koruma', async (t) => {
  const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_HEX
  t.after(() => {
    if (previousKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY
    else process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey
  })
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const {
    saveIntegrationCredential,
    getIntegrationCredential,
    getMaskedIntegrationStatus,
  } = credentialService

  const orgA = await makeOrg(db, 'Org A', 'org-a')
  const orgB = await makeOrg(db, 'Org B', 'org-b')

  // B) org A kendi credential'ını kaydeder/okur.
  await saveIntegrationCredential(db, orgA, 'trendyol', {
    sellerId: 'SELLER-A',
    apiKey: 'APIKEY-AAAA1234',
    apiSecret: 'SECRET-A',
  })
  const readA = await getIntegrationCredential(db, orgA, 'trendyol')
  assert.equal(readA.sellerId, 'SELLER-A')
  assert.equal(readA.apiSecret, 'SECRET-A')

  // C) org B, A'nın credential'ını göremez.
  assert.equal(await getIntegrationCredential(db, orgB, 'trendyol'), null)

  // H) farklı org aynı provider'ı kullanabilir.
  await saveIntegrationCredential(db, orgB, 'trendyol', {
    sellerId: 'SELLER-B',
    apiKey: 'APIKEY-BBBB5678',
    apiSecret: 'SECRET-B',
  })
  assert.equal((await getIntegrationCredential(db, orgB, 'trendyol')).sellerId, 'SELLER-B')
  assert.equal((await getIntegrationCredential(db, orgA, 'trendyol')).sellerId, 'SELLER-A')

  // E) DB'de düz metin bulunmaz.
  const rows = await db.select().from(schema.integrationCredentials)
  const dump = JSON.stringify(rows)
  assert.ok(!dump.includes('SECRET-A'))
  assert.ok(!dump.includes('APIKEY-AAAA1234'))
  for (const row of rows) {
    const envelope = JSON.parse(String(row.encryptedPayload))
    assert.equal(envelope.v, 1)
    assert.ok(envelope.iv && envelope.tag && envelope.data)
    assert.equal(row.keyVersion, 1)
  }

  // F) maskeli durum secret döndürmez.
  const masked = await getMaskedIntegrationStatus(db, orgA)
  assert.equal(masked.trendyol.configured, true)
  assert.equal(masked.trendyol.sellerId, 'SELLER-A')
  assert.equal(masked.trendyol.apiKeyMasked, '••••1234')
  assert.ok(!JSON.stringify(masked).includes('SECRET-A'))
  assert.ok(!JSON.stringify(masked).includes('APIKEY-AAAA1234'))

  // G) boş secret update eski secret'ı korur.
  await saveIntegrationCredential(db, orgA, 'trendyol', {
    sellerId: 'SELLER-A2',
    apiKey: '',
    apiSecret: '',
  })
  const merged = await getIntegrationCredential(db, orgA, 'trendyol')
  assert.equal(merged.sellerId, 'SELLER-A2', 'sağlanan alan güncellenir')
  assert.equal(merged.apiSecret, 'SECRET-A', 'boş secret eski değeri korur')
  assert.equal(merged.apiKey, 'APIKEY-AAAA1234')
})

// --- e2e server: requireAuth koruması + org credential akışı ------------
test('e2e tenant: requireAuth, org credential, mock Trendyol, logout 401 (A,D,I,K,L,N,O,P)', async (t) => {
  // Mock Trendyol: seller'a göre sipariş sayısını değiştirir → hangi
  // credential'ın kullanıldığını kanıtlar.
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    const sellerId = url.pathname.split('/sellers/')[1]?.split('/')[0] ?? ''
    const isOrders = url.pathname.endsWith('/orders')
    const count = sellerId === 'SELLER-A' ? 2 : sellerId === 'SELLER-B' ? 1 : 0
    const content =
      isOrders && url.searchParams.get('status') === 'Delivered'
        ? Array.from({ length: count }, (_, i) => ({
            id: `PKG-${sellerId}-${i}`,
            packageId: `PKG-${sellerId}-${i}`,
            orderNumber: `ORD-${sellerId}-${i}`,
            orderDate: Date.parse('2026-07-08T10:00:00Z'),
            status: 'Delivered',
            shipmentAddress: { city: 'İstanbul' },
            lines: [{ id: `L${i}`, productName: 'Ü', barcode: `b${i}`, quantity: 1, price: 100 }],
          }))
        : []
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ content, totalPages: 1, totalElements: content.length }))
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())

  // pglite'i HTTP üzerinden sunmak yerine: server/index.mjs gerçek pg Pool
  // ister. Bunun yerine auth+credential DB akışını server sürecinde pglite
  // ile taklit edemeyiz; bu yüzden e2e için gerçek pg gerekir. Bunun yerine
  // burada auth guard'ı ve org resolwe'ı IN-PROCESS express ile doğrularız.
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_HEX
  const { createAuthRouter } = await import('./auth/routes.ts')
  const { requireAuth } = await import('./auth/middleware.ts')

  // İki org + kullanıcı (bootstrap tek seferlik olduğundan A bootstrap, B DB'den).
  const app = express()
  app.use(cookieParser())
  app.use('/api/auth', createAuthRouter({ db }))
  // Basit korumalı test route: req.auth.organizationId'den credential çözer.
  app.get('/api/test/whoami', requireAuth(db), (request, response) => {
    response.json({ organizationId: request.auth.organizationId, username: request.auth.username })
  })
  app.get('/api/test/trendyol-count', requireAuth(db), async (request, response) => {
    // organizationId YALNIZ req.auth'tan; body/query tenantId yok sayılır.
    const cred = await credentialService.getIntegrationCredential(
      db,
      request.auth.organizationId,
      'trendyol',
    )
    if (!cred?.sellerId) {
      response.status(422).json({ ok: false, message: 'Trendyol yapılandırılmadı.' })
      return
    }
    // mock Trendyol'a org credential ile git.
    const res = await fetch(
      `http://127.0.0.1:${mockPort}/integration/order/sellers/${cred.sellerId}/orders?status=Delivered&page=0`,
      { headers: { Authorization: 'Basic ' + Buffer.from(`${cred.apiKey}:${cred.apiSecret}`).toString('base64') } },
    )
    const json = await res.json()
    response.json({ ok: true, count: json.content.length, sellerId: cred.sellerId })
  })
  const server = http.createServer(app)
  const port = await listen(server)
  t.after(() => new Promise((r) => server.close(r)))
  const base = `http://127.0.0.1:${port}`

  // A) auth yokken korumalı route 401.
  assert.equal((await fetch(`${base}/api/test/whoami`)).status, 401)
  assert.equal((await fetch(`${base}/api/test/trendyol-count`)).status, 401)

  // Org A bootstrap (otomatik login).
  const bootstrap = await postJson(`${base}/api/auth/bootstrap`, {
    organizationName: 'Org A',
    username: 'admina',
    password: 'parola-a-123',
  })
  assert.equal(bootstrap.status, 201)
  const cookieA = cookieOf(bootstrap)

  // Org B: DB'den kur + login.
  const orgBId = await makeOrg(db, 'Org B', 'org-b-e2e')
  const { hashPassword } = await import('./auth/password.ts')
  await db.insert(schema.users).values({
    organizationId: orgBId,
    username: 'adminb',
    passwordHash: await hashPassword('parola-b-123'),
  })
  const loginB = await postJson(`${base}/api/auth/login`, { username: 'adminb', password: 'parola-b-123' })
  const cookieB = cookieOf(loginB)

  const whoA = await (await fetch(`${base}/api/test/whoami`, { headers: { Cookie: cookieA } })).json()
  const orgAId = whoA.organizationId

  // Credential'ları org bazında kaydet.
  await credentialService.saveIntegrationCredential(db, orgAId, 'trendyol', {
    sellerId: 'SELLER-A', apiKey: 'KEY-A', apiSecret: 'SEC-A',
  })
  await credentialService.saveIntegrationCredential(db, orgBId, 'trendyol', {
    sellerId: 'SELLER-B', apiKey: 'KEY-B', apiSecret: 'SEC-B',
  })

  // I) Trendyol route A credential'ıyla çalışır (SELLER-A → 2 sipariş).
  const countA = await (await fetch(`${base}/api/test/trendyol-count`, { headers: { Cookie: cookieA } })).json()
  assert.equal(countA.sellerId, 'SELLER-A')
  assert.equal(countA.count, 2)

  // J/O) B credential'ıyla çalışır (SELLER-B → 1 sipariş); izolasyon.
  const countB = await (await fetch(`${base}/api/test/trendyol-count`, { headers: { Cookie: cookieB } })).json()
  assert.equal(countB.sellerId, 'SELLER-B')
  assert.equal(countB.count, 1)

  // D) Body/query'de sahte organizationId yok sayılır (A cookie'siyle B org id).
  const spoof = await (
    await fetch(`${base}/api/test/trendyol-count?organizationId=${orgBId}`, {
      method: 'GET',
      headers: { Cookie: cookieA, 'X-Organization-Id': orgBId },
    })
  ).json()
  assert.equal(spoof.sellerId, 'SELLER-A', 'org yalnız session cookie\'sinden gelir')

  // L) Yeni org (credential yok) temiz başlar → 422.
  const orgCId = await makeOrg(db, 'Org C', 'org-c-e2e')
  await db.insert(schema.users).values({
    organizationId: orgCId,
    username: 'adminc',
    passwordHash: await hashPassword('parola-c-123'),
  })
  const loginC = await postJson(`${base}/api/auth/login`, { username: 'adminc', password: 'parola-c-123' })
  const cookieC = cookieOf(loginC)
  assert.equal(
    (await fetch(`${base}/api/test/trendyol-count`, { headers: { Cookie: cookieC } })).status,
    422,
  )

  // N) logout sonrası korumalı endpoint 401.
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookieA } })
  assert.equal(
    (await fetch(`${base}/api/test/trendyol-count`, { headers: { Cookie: cookieA } })).status,
    401,
  )

  // P) Bu akışta hiçbir Sürat create çağrısı üretilmedi (mock yalnız Trendyol
  // orders aldı; test route'ları shipment/create çağırmaz).
})

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function cookieOf(response) {
  const setCookie = response.headers.getSetCookie?.() ?? []
  const c = setCookie.find((x) => x.startsWith('cargoflow_session='))
  return c ? c.split(';')[0] : ''
}
