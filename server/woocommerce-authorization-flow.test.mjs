import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// PHASE2-F — WOOCOMMERCE BAĞLANTI SİHİRBAZI (resmî /wc-auth/v1/authorize).
//
// Hermetik: pglite + gerçek migration, sahte DNS ve sahte mağaza taşıması.
// Adımlar: mağaza adresi → bağlan → yetkilendirme → geri çağrı → izin
// kontrolü → örnek okuma doğrulaması → sağlık.

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const auth = await import('./connectors/woocommerce/wooAuthorization.ts')
const woo = await import('./connectors/woocommerce/wooConnectionService.ts')
const status = await import('./connectors/integrationStatus.ts')

const DIR = join(here, '..', 'drizzle')
const FILES = readdirSync(DIR).filter((file) => file.endsWith('.sql')).sort()
const BASE = 'https://app.cargoflow.test'
const STORE = 'https://shop.example.com'
const NOW = new Date('2026-10-12T10:00:00.000Z')
const publicResolver = async () => [{ address: '93.184.216.34' }]
const KEY = 'ck_0123456789abcdef0123456789abcdef01234567'
const SECRET = 'cs_fedcba9876543210fedcba9876543210fedcba98'

async function makeDb() {
  const pglite = new PGlite()
  for (const file of FILES) {
    for (const statement of readFileSync(join(DIR, file), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await pglite.exec(statement)
    }
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db, slug) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

function storeTransport(status = 200) {
  const requests = []
  const transport = async (request) => {
    requests.push(request)
    return { status, headers: { 'content-type': 'application/json' }, bodyText: status === 200 ? '[]' : '{"code":"woocommerce_rest_cannot_view"}' }
  }
  return { requests, options: { transport, resolver: publicResolver, retryDelaysMs: [], sleep: async () => {} } }
}

async function start(db, organizationId, over = {}) {
  return auth.startWooAuthorization(db, {
    organizationId,
    userId: null,
    storeUrl: STORE,
    appBaseUrl: BASE,
    resolver: publicResolver,
    now: NOW,
    ...over,
  })
}

/** Başlatma sonucundan geri çağrı yolundaki kimlik + belirteç. */
function callbackParts(authorizeUrl) {
  const url = new URL(authorizeUrl)
  const callback = new URL(url.searchParams.get('callback_url'))
  const [, , , , id, token] = callback.pathname.split('/')
  return { id, token, url, callback }
}

const callbackBody = (id, over = {}) => ({
  key_id: 7,
  user_id: id,
  consumer_key: KEY,
  consumer_secret: SECRET,
  key_permissions: 'read',
  ...over,
})

test('WA-1: sihirbaz yalnız HTTPS uygulama adresiyle açılır (WooCommerce geri çağrıyı SSL ister)', async (t) => {
  assert.equal(auth.resolveWooAuthBaseUrl(undefined), null)
  assert.equal(auth.resolveWooAuthBaseUrl('http://localhost:5173'), null)
  assert.equal(auth.resolveWooAuthBaseUrl('https://app.example.com/'), 'https://app.example.com')
  assert.equal(auth.resolveWooAuthBaseUrl('not a url'), null)

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wa1')
  const unavailable = await start(db, org, { appBaseUrl: null })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.outcome, 'WIZARD_UNAVAILABLE')
  const rejected = await start(db, org, { storeUrl: 'http://shop.example.com' })
  assert.equal(rejected.outcome, 'STORE_URL_REJECTED')
  const privateHost = await start(db, org, { resolver: async () => [{ address: '10.0.0.5' }] })
  assert.equal(privateHost.outcome, 'STORE_URL_REJECTED')
  assert.equal((await db.select().from(schema.connectorAuthorizations)).length, 0)
})

test('WA-2: yetkilendirme adresi resmî uç ve parametrelerle kurulur; belirteç düz metin SAKLANMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wa2')
  const started = await start(db, org)
  assert.equal(started.ok, true)
  const { id, token, url, callback } = callbackParts(started.authorizeUrl)
  assert.equal(`${url.origin}${url.pathname}`, `${STORE}/wc-auth/v1/authorize`)
  assert.equal(url.searchParams.get('app_name'), 'CargoFlow')
  assert.equal(url.searchParams.get('scope'), 'read')
  assert.equal(url.searchParams.get('user_id'), started.authorizationId)
  assert.equal(url.searchParams.get('return_url'), `${BASE}/?woo_auth=${started.authorizationId}`)
  assert.equal(callback.protocol, 'https:')
  assert.equal(callback.pathname.startsWith('/api/webhooks/woocommerce-auth/'), true)
  assert.equal(id, started.authorizationId)
  const dump = JSON.stringify(await pglite.query('select * from connector_authorizations'))
  assert.ok(!dump.includes(token), 'geri çağrı belirteci düz metin saklanmamalı')
  const [row] = (await pglite.query('select status, store_url, requested_scope from connector_authorizations')).rows
  assert.deepEqual(row, { status: 'pending', store_url: STORE, requested_scope: 'read' })
})

test('WA-3: geri çağrı — belirteç, eşleşme, izin ve tek kullanım; 200 yalnız şifreli saklamada', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wa3')
  const receive = (id, token, body, now = NOW) => auth.receiveWooAuthCallback(db, { authorizationId: id, token, body, now })

  const a = callbackParts((await start(db, org)).authorizeUrl)
  // Yanlış belirteç: hiçbir şey değişmez.
  assert.equal((await receive(a.id, 'x'.repeat(43), callbackBody(a.id))).httpStatus, 404)
  // Başka isteğin kimliği gövdede: eşleşme hatası (2xx YOK → Woo anahtarı siler).
  const mismatch = await receive(a.id, a.token, callbackBody('00000000-0000-0000-0000-000000000000'))
  assert.deepEqual([mismatch.httpStatus, mismatch.body.outcome], [400, 'CALLBACK_MISMATCH'])

  const b = callbackParts((await start(db, org)).authorizeUrl)
  const noRead = await receive(b.id, b.token, callbackBody(b.id, { key_permissions: 'write' }))
  assert.deepEqual([noRead.httpStatus, noRead.body.outcome], [400, 'PERMISSION'])

  const c = callbackParts((await start(db, org)).authorizeUrl)
  const ok = await receive(c.id, c.token, callbackBody(c.id))
  assert.deepEqual([ok.httpStatus, ok.body], [200, { ok: true, outcome: 'RECEIVED' }])
  // Tekrar (replay) kabul edilmez.
  assert.equal((await receive(c.id, c.token, callbackBody(c.id))).httpStatus, 409)
  const dump = JSON.stringify((await pglite.query('select * from connector_authorizations')).rows)
  assert.ok(!dump.includes(KEY) && !dump.includes(SECRET), 'anahtarlar düz metin saklanmamalı')
  assert.ok(!JSON.stringify(ok).includes('cs_'), 'yanıt sır taşımamalı')

  const d = callbackParts((await start(db, org)).authorizeUrl)
  const late = await receive(d.id, d.token, callbackBody(d.id), new Date(NOW.getTime() + auth.WOO_AUTH_TTL_MS + 1))
  assert.deepEqual([late.httpStatus, late.body.outcome], [410, 'EXPIRED'])
})

test('WA-4: dönüş — örnek okuma doğrulaması, kalıcı doğrulama, sağlık; ikinci tamamlama yeniden doğrulamaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wa4')
  const other = await makeOrg(db, 'wa4-other')
  const started = await start(db, org)
  const { id, token } = callbackParts(started.authorizeUrl)
  const store = storeTransport(200)

  const waiting = await auth.completeWooAuthorization(db, { organizationId: org, authorizationId: id, options: store.options, now: NOW })
  assert.deepEqual([waiting.outcome, waiting.step], ['WAITING_FOR_CALLBACK', 'callback'])

  await auth.receiveWooAuthCallback(db, { authorizationId: id, token, body: callbackBody(id), now: NOW })
  // Başka çalışma alanı bu isteği GÖREMEZ.
  const foreign = await auth.completeWooAuthorization(db, { organizationId: other, authorizationId: id, options: store.options, now: NOW })
  assert.equal(foreign.outcome, 'NOT_FOUND')
  assert.equal(store.requests.length, 0)

  const done = await auth.completeWooAuthorization(db, { organizationId: org, authorizationId: id, options: store.options, now: NOW })
  assert.deepEqual([done.outcome, done.step, done.grantedScope], ['CONNECTED', 'health', 'read'])
  assert.equal(store.requests.length, 1, 'örnek okuma tam bir kez yapılır')
  assert.match(store.requests[0].url, /\/wp-json\/wc\/v3\/orders\?/)

  const stores = await woo.listWooStores(db, org)
  assert.equal(stores.length, 1)
  assert.equal(stores[0].verificationStatus, 'verified')
  assert.equal(stores[0].consumerKeyMasked, `••••${KEY.slice(-4)}`)
  assert.ok(!JSON.stringify(stores).includes(SECRET))
  const [row] = (await pglite.query('select status, encrypted_credentials, marketplace_account_id from connector_authorizations')).rows
  assert.equal(row.status, 'connected')
  assert.equal(row.encrypted_credentials, null, 'bekleyen anahtar doğrulama sonrası silinir')
  assert.equal(row.marketplace_account_id, stores[0].marketplaceAccountId)

  const again = await auth.completeWooAuthorization(db, { organizationId: org, authorizationId: id, options: store.options, now: NOW })
  assert.equal(again.outcome, 'CONNECTED')
  assert.equal(store.requests.length, 1, 'ikinci tamamlama mağazaya yeniden gitmez')

  // Pano: WooCommerce bağlı + doğrulanmış AMA hâlâ iç test (Canlı DEĞİL).
  const board = await status.loadIntegrationStatusBoard(db, { organizationId: org, nowMs: NOW.getTime() })
  const entry = board.find((item) => item.providerKey === 'woocommerce')
  assert.equal(entry.availability, 'internal_test')
  assert.equal(entry.health.state, 'verified')
})

test('WA-5: okuma reddedilirse hiçbir şey kalıcılaşmaz; reddedilen onay ve süre aşımı açıkça söylenir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wa5')
  const store = storeTransport(401)
  const a = callbackParts((await start(db, org)).authorizeUrl)
  await auth.receiveWooAuthCallback(db, { authorizationId: a.id, token: a.token, body: callbackBody(a.id), now: NOW })
  const failed = await auth.completeWooAuthorization(db, { organizationId: org, authorizationId: a.id, options: store.options, now: NOW })
  assert.deepEqual([failed.outcome, failed.step, failed.errorClass], ['FAILED', 'verification', 'AUTH'])
  assert.equal((await woo.listWooStores(db, org)).length, 0)
  const [row] = (await pglite.query('select encrypted_credentials from connector_authorizations where id = $1', [a.id])).rows
  assert.equal(row.encrypted_credentials, null)

  const b = callbackParts((await start(db, org)).authorizeUrl)
  const denied = await auth.completeWooAuthorization(db, { organizationId: org, authorizationId: b.id, denied: true, options: store.options, now: NOW })
  assert.deepEqual([denied.outcome, denied.errorClass, denied.message], ['FAILED', 'DENIED', 'Mağazada erişim onaylanmadı.'])

  const c = callbackParts((await start(db, org)).authorizeUrl)
  const expired = await auth.completeWooAuthorization(db, {
    organizationId: org, authorizationId: c.id, options: store.options, now: new Date(NOW.getTime() + auth.WOO_AUTH_TTL_MS + 1),
  })
  assert.equal(expired.outcome, 'EXPIRED')
  // Yalnız ilk (reddedilen) okuma mağazaya gitti; onaysız/süresi dolmuş istek gitmez.
  assert.equal(store.requests.length, 1)
})

test('WA-6: elle anahtar (gelişmiş) yolu da doğrulamayı kalıcı yazar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wa6')
  const store = storeTransport(200)
  const result = await woo.connectWooStore(db, { organizationId: org, storeUrl: STORE, consumerKey: KEY, consumerSecret: SECRET }, store.options)
  assert.equal(result.outcome, 'CONNECTED')
  const [view] = await woo.listWooStores(db, org)
  assert.equal(view.verificationStatus, 'verified')
  assert.ok(view.lastVerifiedAt)
})

test('WA-7: uçlar — geri çağrı oturumsuz ve JSON gövdeli; başlat/tamamla kiracı kapsamlı', () => {
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const callback = index.slice(index.indexOf("app.post('/api/webhooks/woocommerce-auth/"), index.indexOf('\n})', index.indexOf("app.post('/api/webhooks/woocommerce-auth/")))
  assert.match(callback, /receiveWooAuthCallback/)
  assert.equal(callback.includes('requireOnboardingContext'), false)
  for (const route of ["app.post('/api/integrations/woocommerce/authorizations'", "app.post('/api/integrations/woocommerce/authorizations/:authorizationId/complete'"]) {
    const start = index.indexOf(route)
    assert.ok(start > 0, route)
    const block = index.slice(start, index.indexOf('\n})', start))
    assert.match(block, /requireOnboardingContext/)
    assert.match(block, /organizationId: context\.organizationId/)
  }
  // Ham gövde ayrıştırıcısı yalnız imzalı webhook yolundadır; geri çağrı
  // yolu bu öneke DÜŞMEZ (Express ön eki segment sınırında eşleştirir).
  assert.match(index, /app\.use\('\/api\/webhooks\/woocommerce', express\.raw/)
})
