import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, isNull } from 'drizzle-orm'

// ═══ HEPSIBURADA-LIVE-001 — HESAP KAPSAMLI YALNIZ-OKUMA BAĞLAYICI ═════════
//
// GERÇEK AĞ YOK, GERÇEK KİMLİK YOK: taşıma enjekte edilir. Yazma kapısı
// varsayılan yayın aşamasıdır (`internal_test` → kanonik yazım KAPALI);
// kanonik kalıcılaştırma yolu testte açık kapı ENJEKTE edilerek sınanır.

const here = dirname(fileURLToPath(import.meta.url))
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const config = await import('./connectors/hepsiburada/hepsiburadaConfig.ts')
const client = await import('./connectors/hepsiburada/hepsiburadaClient.ts')
const sync = await import('./connectors/hepsiburada/hepsiburadaOrderSync.ts')
const persistence = await import('./connectors/hepsiburada/hepsiburadaPersistence.ts')
const connection = await import('./connectors/hepsiburada/hepsiburadaConnectionService.ts')
const health = await import('./connectors/hepsiburada/hepsiburadaHealth.ts')
const handlers = await import('./connectors/hepsiburada/hepsiburadaHttpHandlers.ts')
const catalog = await import('./connectors/providerCatalog.ts')
const gate = await import('./connectors/liveWriteGate.ts')

const DIR = join(here, '..', 'drizzle')
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.sql')).sort()
async function makeDb() {
  const pglite = new PGlite()
  for (const file of FILES) {
    for (const statement of readFileSync(join(DIR, file), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await pglite.exec(statement)
    }
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, slug = `hb-${randomBytes(4).toString('hex')}`) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)
const HOUR = 3_600_000
const SECRET = 'S3cret-Parola!'
const ALLOW = () => ({ decision: 'ALLOWED', stage: 'pilot', reasonCode: 'TEST_INJECTED' })

const baseInput = (over = {}) => ({
  merchantId: 'm-1001',
  username: 'cargoflow-api-user',
  password: SECRET,
  host: 'oms-external-sit.hepsiburada.com',
  packagesPath: '/packages/merchantid/{merchantId}',
  ...over,
})

function pkg(i, over = {}) {
  return {
    orderNumber: `HB-ORD-${1000 + i}`,
    orderId: `oid-${i}`,
    packageNumber: `PKG-${5000 + i}`,
    merchantId: 'm-1001',
    status: 'Packed',
    cargoCompany: 'HepsiJet',
    barcode: `BC${9000 + i}`,
    trackingInfoCode: `TRK${7000 + i}`,
    trackingInfoUrl: `https://tracking.example.invalid/${i}`,
    orderDate: new Date(NOW - (i % 20) * HOUR).toISOString(),
    shippingAddress: { name: 'Ayşe Yılmaz', city: 'İstanbul', district: 'Kadıköy' },
    items: [{ lineItemId: `li-${i}`, merchantSku: `SKU-${i % 7}`, sku: `HBV-${i}`, productName: `Ürün ${i}`, quantity: 1 }],
    ...over,
  }
}

/** Time-aware provider fixture; unknown dates remain visible for durability tests. */
function fakeTransport(dataset, behaviour = {}) {
  const calls = []
  const transport = async (request) => {
    const url = new URL(request.url)
    const call = {
      url: request.url,
      host: url.hostname,
      path: url.pathname,
      offset: Number(url.searchParams.get('offset')),
      limit: Number(url.searchParams.get('limit')),
      begindate: url.searchParams.get('begindate'),
      enddate: url.searchParams.get('enddate'),
      authorization: request.headers.Authorization,
    }
    calls.push(call)
    const scripted = behaviour.respond?.(call, calls.length)
    if (scripted) return scripted
    const rows = dataset.filter((row) => {
      const time = Date.parse(row.orderDate)
      return !Number.isFinite(time) || (time >= Date.parse(call.begindate) && time <= Date.parse(call.enddate))
    }).slice(call.offset, call.offset + call.limit)
    return { status: 200, headers: {}, bodyText: JSON.stringify(behaviour.envelope ? { [behaviour.envelope]: rows } : rows) }
  }
  return { transport, calls }
}

const noSleep = { sleep: async () => {} }

async function connectAccount(db, org, over = {}) {
  const result = await connection.connectHepsiburadaAccount(db, { organizationId: org, ...baseInput(over) })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  return result.marketplaceAccountId
}

/* ═══ KİMLİK + YAPILANDIRMA ═══════════════════════════════════════════ */

test('HB-CFG-1: host yalnız doğrulanmış Hepsiburada alan adı; yol göreli ve uydurulmaz', () => {
  assert.equal(config.validateHepsiburadaConfig(baseInput({ host: 'evil.example.com' })).ok, false)
  assert.deepEqual(config.validateHepsiburadaConfig(baseInput({ host: 'hepsiburada.com.evil.io' })).errors, ['HB_HOST_NOT_VERIFIED'])
  for (const bad of ['https://x.hepsiburada.com/p', '/a/../b', '//x', '/p?x=1', '/p/{other}']) {
    assert.equal(config.validateHepsiburadaConfig(baseInput({ packagesPath: bad })).ok, false, bad)
  }
  const ok = config.validateHepsiburadaConfig(baseInput())
  assert.equal(ok.ok, true)
  assert.equal(ok.config.environment, 'SIT')
  assert.equal(config.resolveEndpointPath(ok.config, 'PACKAGES'), '/packages/merchantid/m-1001')
  // Yol yoksa okuma ailesi YOK (uydurma varsayılan yol yok).
  assert.equal(config.resolveReadFamily({ ordersPath: null, packagesPath: null }), null)
})

test('HB-CRED-1: kimlik şifreli saklanır; liste/yanıt/hata PAROLA içermez; boş parola kayıtlıyı korur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const raw = await pglite.query('select encrypted_payload from connector_credentials')
  assert.equal(raw.rows.length, 1)
  assert.equal(raw.rows[0].encrypted_payload.includes(SECRET), false, 'parola düz metin değil')
  assert.equal(raw.rows[0].encrypted_payload.includes('cargoflow-api-user'), false)

  const list = await handlers.handleHepsiburadaListAccounts({ db, organizationId: org })
  const dump = JSON.stringify(list.body)
  assert.equal(dump.includes(SECRET), false)
  assert.equal(dump.includes('cargoflow-api-user'), false, 'kullanıcı adı maskeli')
  assert.equal(list.body.accounts[0].config.hasPassword, true)
  assert.equal(list.body.liveVerified, false)

  // Boş parola ile güncelleme kayıtlı parolayı KORUR.
  await connection.connectHepsiburadaAccount(db, { organizationId: org, ...baseInput({ password: '', ordersPath: '/orders/merchantid/{merchantId}' }) })
  const loaded = await connection.loadHepsiburadaAccount(db, { organizationId: org, marketplaceAccountId: accountId })
  assert.equal(loaded.config.password, SECRET)
  assert.equal(loaded.config.ordersPath, '/orders/merchantid/{merchantId}')

  // Hata yanıtı da sır taşımaz.
  const bad = await handlers.handleHepsiburadaConnect({ db, organizationId: org, body: baseInput({ host: 'x.example.com' }) })
  assert.equal(bad.status, 400)
  assert.equal(JSON.stringify(bad.body).includes(SECRET), false)
})

/* ═══ FAIL-CLOSED: AĞ ÇAĞRISI 0 ════════════════════════════════════════ */

test('HB-NET-0a: uç nokta yolu yoksa test ve senkron AĞA ÇIKMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org, { packagesPath: '', ordersPath: '' })
  const fake = fakeTransport([pkg(1)])
  for (const handler of [handlers.handleHepsiburadaTest, handlers.handleHepsiburadaSync]) {
    const result = await handler({ db, organizationId: org, body: { marketplaceAccountId: accountId }, clientOptions: { transport: fake.transport, ...noSleep }, now: () => NOW })
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'HB_ENDPOINT_CONFIG_REQUIRED')
    assert.equal(result.body.networkCalls, 0)
  }
  assert.equal(fake.calls.length, 0)
  const list = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(list[0].health.state, 'ENDPOINT_CONFIG_REQUIRED')
  // Senkron çekirdeği doğrudan çağrılsa da istek KURULMAZ ve durum kaydedilir.
  const loaded = await connection.loadHepsiburadaAccount(db, { organizationId: org, marketplaceAccountId: accountId })
  const run = await sync.syncHepsiburadaOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: accountId, config: loaded.config, fromMs: null, upperBoundMs: NOW,
  }, { transport: fake.transport, ...noSleep })
  assert.equal(run.outcome, 'FAILED')
  assert.equal(run.errorClass, 'ENDPOINT_CONFIG_REQUIRED')
  assert.equal(run.networkCalls, 0)
  assert.equal(fake.calls.length, 0)
})

test('HB-NET-0b: kimlik eksik/ayrılmış hesapta ağ çağrısı 0', async (t) => {
  const fake = fakeTransport([pkg(1)])
  const incomplete = { ...config.validateHepsiburadaConfig(baseInput()).config, password: '' }
  const page = await client.fetchHepsiburadaPage(incomplete, { family: 'PACKAGES', offset: 0, limit: 10, startMs: NOW - HOUR, endMs: NOW }, { transport: fake.transport })
  assert.equal(page.ok, false)
  assert.equal(page.errorClass, 'CREDENTIALS_MISSING')
  assert.equal(page.networkCalls, 0)

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  await connection.disconnectHepsiburadaAccount(db, { organizationId: org, marketplaceAccountId: accountId })
  const result = await handlers.handleHepsiburadaSync({ db, organizationId: org, body: { marketplaceAccountId: accountId }, clientOptions: { transport: fake.transport, ...noSleep }, now: () => NOW })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'HB_CREDENTIALS_MISSING')
  assert.equal(fake.calls.length, 0)
})

/* ═══ SAYFALAMA + PENCERE ══════════════════════════════════════════════ */

test('HB-PAGE-1: full pages split; every request uses offset zero; request budget is bounded', async () => {
  const cfg = config.validateHepsiburadaConfig(baseInput()).config
  const dataset = Array.from({ length: 250 }, (_, i) => pkg(i, { orderDate: new Date(NOW - HOUR + i * 10_000).toISOString() }))
  const fake = fakeTransport(dataset)
  const done = await sync.fetchAllHepsiburadaRecords(cfg, 'PACKAGES', [{ startMs: NOW - HOUR, endMs: NOW }], { transport: fake.transport, pageLimit: 100 })
  assert.equal(done.outcome, 'SUCCESS')
  assert.ok(fake.calls.length > 3)
  assert.ok(fake.calls.every((c) => c.offset === 0 && c.limit === 100))
  assert.equal(done.rawRecords.length, 250)

  // Sunucu sonsuza kadar dolu sayfa dönerse: tavan, sonsuz döngü YOK.
  const endless = fakeTransport([], { respond: (call) => ({ status: 200, headers: {}, bodyText: JSON.stringify(Array.from({ length: call.limit }, (_, i) => pkg(call.offset + i))) }) })
  const capped = await sync.fetchAllHepsiburadaRecords(cfg, 'PACKAGES', [{ startMs: NOW - HOUR, endMs: NOW }], { transport: endless.transport, pageLimit: 10, maxRequestsPerRun: 4 })
  assert.equal(capped.outcome, 'PARTIAL')
  assert.equal(capped.reasonCode, 'HB_REQUEST_BUDGET_EXHAUSTED')
  assert.equal(endless.calls.length, 4)
  // Sayfa boyutu sözleşme tavanını AŞAMAZ.
  const big = fakeTransport([])
  await sync.fetchAllHepsiburadaRecords(cfg, 'PACKAGES', [{ startMs: NOW - HOUR, endMs: NOW }], { transport: big.transport, pageLimit: 5000 })
  assert.equal(big.calls[0].limit, 100)
})

test('HB-WIN-1: paket penceresi ≤ 24 saat; koşu başına dilim tavanı; imleç tamamlanan dilim sonuna', async (t) => {
  const plan = sync.planHepsiburadaWindows({ family: 'PACKAGES', fromMs: NOW - 10 * 24 * HOUR, upperBoundMs: NOW })
  assert.equal(plan.windows.length, sync.HEPSIBURADA_MAX_WINDOWS_PER_RUN)
  assert.equal(plan.moreRemaining, true)
  for (const w of plan.windows) assert.ok(w.endMs - w.startMs <= 24 * HOUR)
  for (let i = 1; i < plan.windows.length; i += 1) assert.equal(plan.windows[i].startMs, plan.windows[i - 1].endMs, 'boşluksuz ardışık')

  // SİPARİŞ ailesi: imleç 20 gün geride → başlangıç İLERİ KIRPILMAZ (kırpma
  // aradaki siparişleri kalıcı atlardı); ≤ 7 günlük boşluksuz dilimler.
  const orders = sync.planHepsiburadaWindows({ family: 'ORDERS', fromMs: NOW - 20 * 24 * HOUR, upperBoundMs: NOW })
  assert.equal(orders.windows[0].startMs, NOW - 20 * 24 * HOUR, 'en eski veri atlanmaz')
  assert.equal(orders.windows.at(-1).endMs, NOW)
  assert.equal(orders.windows.length, 3)
  for (const w of orders.windows) assert.ok(w.endMs - w.startMs <= 7 * 24 * HOUR)
  for (let i = 1; i < orders.windows.length; i += 1) assert.equal(orders.windows[i].startMs, orders.windows[i - 1].endMs)

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const loaded = await connection.loadHepsiburadaAccount(db, { organizationId: org, marketplaceAccountId: accountId })
  const fake = fakeTransport([pkg(1)])
  const run = await sync.syncHepsiburadaOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: accountId, config: loaded.config,
    fromMs: NOW - 3 * 24 * HOUR - 2 * HOUR, upperBoundMs: NOW, liveWriteGate: ALLOW,
    persistCanonical: (orders) => persistence.persistHepsiburadaOrders(db, { organizationId: org, marketplaceAccountId: accountId, orders }),
  }, { transport: fake.transport, ...noSleep })
  assert.equal(run.outcome, 'SUCCESS')
  for (const call of fake.calls) {
    const span = Date.parse(call.enddate) - Date.parse(call.begindate)
    assert.ok(span > 0 && span <= 24 * HOUR, `istek penceresi ${span / HOUR} saat`)
  }
  assert.equal(fake.calls.length, 4, '3 gün 2 saat → 4 dilim')
  assert.equal(run.checkpointMs, NOW)
})

/* ═══ ORAN SINIRI + HATA SINIFLARI ═════════════════════════════════════ */

test('HB-RATE-1: 429 → bekleme X-RateLimit-Reset başlığından (tavanlı), tekrar SINIRLI, sonra RATE_LIMITED', async () => {
  const cfg = config.validateHepsiburadaConfig(baseInput()).config
  const sleeps = []
  const limited = fakeTransport([], { respond: () => ({ status: 429, headers: { 'x-ratelimit-reset': '7', 'x-ratelimit-remaining': '0' }, bodyText: '{}' }) })
  const page = await client.fetchHepsiburadaPage(cfg, { family: 'PACKAGES', offset: 0, limit: 10, startMs: NOW - HOUR, endMs: NOW }, {
    transport: limited.transport, retryDelaysMs: [100, 200], sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(page.ok, false)
  assert.equal(page.errorClass, 'RATE_LIMITED')
  assert.equal(limited.calls.length, 3, '1 + 2 tekrar')
  assert.deepEqual(sleeps, [7000, 7000])
  assert.equal(page.rateState.remaining, 0)

  // Başlık çok uzun bekleme isterse tavan uygulanır; başlık yoksa sabit geri çekilme.
  const capped = []
  await client.fetchHepsiburadaPage(cfg, { family: 'PACKAGES', offset: 0, limit: 10, startMs: NOW - HOUR, endMs: NOW }, {
    transport: fakeTransport([], { respond: () => ({ status: 429, headers: { 'x-ratelimit-reset': '600' }, bodyText: '{}' }) }).transport,
    retryDelaysMs: [100], maxRateWaitMs: 5_000, sleep: async (ms) => { capped.push(ms) },
  })
  assert.deepEqual(capped, [5000])
  const noHeader = []
  await client.fetchHepsiburadaPage(cfg, { family: 'PACKAGES', offset: 0, limit: 10, startMs: NOW - HOUR, endMs: NOW }, {
    transport: fakeTransport([], { respond: () => ({ status: 429, headers: {}, bodyText: '{}' }) }).transport,
    retryDelaysMs: [150], sleep: async (ms) => { noHeader.push(ms) },
  })
  assert.deepEqual(noHeader, [150])

  // 429 sonra başarı: tekrar düzelir.
  let n = 0
  const recovering = fakeTransport([pkg(1)], { respond: () => (n++ === 0 ? { status: 429, headers: { 'x-ratelimit-reset': '1' }, bodyText: '{}' } : null) })
  const ok = await client.fetchHepsiburadaPage(cfg, { family: 'PACKAGES', offset: 0, limit: 10, startMs: NOW - HOUR, endMs: NOW }, { transport: recovering.transport, ...noSleep })
  assert.equal(ok.ok, true)
  assert.equal(ok.networkCalls, 2)
})

test('HB-ERR-1: 401/403 tekrar EDİLMEZ; 404 "sipariş yok" SAYILMAZ; zarf belirsizse YAZILMAZ', async () => {
  const cfg = config.validateHepsiburadaConfig(baseInput()).config
  const q = { family: 'PACKAGES', offset: 0, limit: 10, startMs: NOW - HOUR, endMs: NOW }
  for (const [status, errorClass] of [[401, 'AUTH_ERROR'], [403, 'AUTH_ERROR'], [404, 'ENDPOINT_CONFIG_REQUIRED']]) {
    const fake = fakeTransport([], { respond: () => ({ status, headers: {}, bodyText: '{}' }) })
    const page = await client.fetchHepsiburadaPage(cfg, q, { transport: fake.transport, ...noSleep })
    assert.equal(page.errorClass, errorClass, String(status))
    assert.equal(fake.calls.length, 1, `${status} tekrar edilmez`)
  }
  const objectBody = fakeTransport([pkg(1)], { envelope: 'items' })
  const unverified = await client.fetchHepsiburadaPage(cfg, q, { transport: objectBody.transport, ...noSleep })
  assert.equal(unverified.errorClass, 'RESPONSE_SHAPE_UNVERIFIED', 'liste alanı yapılandırılmadan nesne zarfı TAHMİN edilmez')
  const configured = await client.fetchHepsiburadaPage({ ...cfg, listField: 'items' }, q, { transport: objectBody.transport, ...noSleep })
  assert.equal(configured.ok, true)
  assert.equal(configured.rows.length, 1)
  // 5xx/ağ hatası sınırlı tekrar → PROVIDER_UNAVAILABLE.
  const down = fakeTransport([], { respond: () => ({ status: 503, headers: {}, bodyText: '' }) })
  const page = await client.fetchHepsiburadaPage(cfg, q, { transport: down.transport, retryDelaysMs: [1, 1], ...noSleep })
  assert.equal(page.errorClass, 'PROVIDER_UNAVAILABLE')
  assert.equal(down.calls.length, 3)
})

test('HB-HOST-1: istek yalnız doğrulanmış host + https + Basic auth; yazma metodu YOK', async () => {
  const cfg = config.validateHepsiburadaConfig(baseInput()).config
  const fake = fakeTransport([pkg(1)])
  await client.fetchHepsiburadaPage(cfg, { family: 'PACKAGES', offset: 0, limit: 10, startMs: NOW - HOUR, endMs: NOW }, { transport: fake.transport })
  assert.equal(fake.calls[0].host, 'oms-external-sit.hepsiburada.com')
  assert.ok(fake.calls[0].url.startsWith('https://'))
  assert.match(fake.calls[0].authorization, /^Basic /)
  // Kaynak: istemcide GET dışında metod yok.
  const source = readFileSync(join(here, 'connectors/hepsiburada/hepsiburadaClient.ts'), 'utf8')
  assert.match(source, /method: 'GET'/)
  assert.doesNotMatch(source, /method: '(POST|PUT|PATCH|DELETE)'/)
  // Uydurma host'a (doğrulanmamış) istek KURULMAZ.
  const rogue = fakeTransport([])
  const page = await client.fetchHepsiburadaPage({ ...cfg, host: 'api.example.com' }, { family: 'PACKAGES', offset: 0, limit: 1, startMs: NOW - HOUR, endMs: NOW }, { transport: rogue.transport })
  assert.equal(page.ok, false)
  assert.equal(rogue.calls.length, 0)
})

test('HB-ABORT-1: üretim taşıması zaman aşımında TIMEOUT verir ve zamanlayıcıyı temizler', async (t) => {
  const server = createServer(() => { /* yanıt vermez */ })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections?.(); server.close() })
  const { port } = server.address()
  const started = Date.now()
  await assert.rejects(
    client.fetchHepsiburadaTransport({ url: `http://127.0.0.1:${port}/x`, headers: {}, timeoutMs: 150 }),
    (error) => error instanceof client.HepsiburadaTransportError && error.kind === 'TIMEOUT',
  )
  assert.ok(Date.now() - started < 5_000)
  const source = readFileSync(join(here, 'connectors/hepsiburada/hepsiburadaClient.ts'), 'utf8')
  assert.match(source, /new AbortController\(\)/)
  assert.match(source, /finally \{\s*clearTimeout\(timer\)/)
})

/* ═══ KALICILAŞTIRMA (kanonik, hesap kapsamlı) ═════════════════════════ */

async function syncWith(db, org, accountId, fake, extra = {}) {
  return handlers.handleHepsiburadaSync({
    db, organizationId: org, body: { marketplaceAccountId: accountId },
    clientOptions: { transport: fake.transport, ...noSleep }, now: () => NOW, ...extra,
  })
}

test('HB-GATE-1: internal_test → okuma çalışır ama kanonik sipariş YAZILMAZ (dürüst iç test)', async (t) => {
  assert.equal(catalog.resolveRolloutStage('hepsiburada'), 'internal_test')
  assert.equal(gate.canPersistCanonicalOrders('hepsiburada').decision, 'BLOCKED_BY_ROLLOUT')
  assert.ok(catalog.HEALTH_SUPPORTED_PROVIDERS.includes('hepsiburada'))
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const result = await syncWith(db, org, accountId, fakeTransport([pkg(1), pkg(2)]))
  assert.equal(result.body.outcome, 'SUCCESS')
  assert.equal(result.body.canonicalWrite, 'BLOCKED_BY_ACCOUNT')
  assert.equal(result.body.ordersReadReasonCode, 'ACCOUNT_NOT_VERIFIED')
  assert.equal(result.body.fetched, 2)
  assert.match(result.body.note, /Hesap doğrulanmadı/)
  for (const table of [schema.orders, schema.orderLines, schema.shipments, schema.labelJobs]) {
    assert.equal((await db.select().from(table)).length, 0, 'canlı iş tablosu BOŞ')
  }
  assert.equal(result.body.healthState, 'OK')
  assert.match(result.body.healthLabel, /hesap doğrulanmadı: kayıtlar sisteme yazılmadı/)

  // İMLEÇ: yazılmamış okuma imleci İLERLETMEZ (aksi halde aşama açılınca bu
  // pencereler bir daha istenmezdi).
  const [view] = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(view.health.lastSuccessfulSyncAt, null)
  assert.equal(view.health.state, 'OK')
  assert.equal(view.health.reasonCode, 'HB_CANONICAL_WRITE_BLOCKED')

  // Aşama açıldığında ilk koşu İLK geriye bakıştan okur ve yazar.
  const later = NOW + 3 * HOUR
  const allowed = fakeTransport([pkg(1), pkg(2)])
  const opened = await syncWith(db, org, accountId, allowed, { liveWriteGate: ALLOW, now: () => later })
  assert.equal(opened.body.canonicalWrite, 'ALLOWED')
  assert.equal(Date.parse(allowed.calls[0].begindate), later - sync.HEPSIBURADA_INITIAL_LOOKBACK_MS - sync.HEPSIBURADA_BOUNDARY_OVERLAP_MS, 'initial lookback plus boundary overlap, no test cursor')
  assert.equal((await db.select().from(schema.orders)).length, 2)
  const [afterOpen] = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(Date.parse(afterOpen.health.lastSuccessfulSyncAt), later)
  assert.equal(afterOpen.health.reasonCode, null)
})

test('HB-CURSOR-1: kanonik yazım eksik kalırsa veya yazıcı yoksa imleç İLERLEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const loaded = await connection.loadHepsiburadaAccount(db, { organizationId: org, marketplaceAccountId: accountId })
  const run = (extra) => sync.syncHepsiburadaOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: accountId, config: loaded.config,
    fromMs: NOW - 2 * HOUR, upperBoundMs: NOW, liveWriteGate: ALLOW, ...extra,
  }, { transport: fakeTransport([pkg(1), pkg(2)]).transport, ...noSleep })

  const failedRow = await run({ persistCanonical: async () => ({ persisted: 1, inserted: 1, updated: 0, failed: 1, skipped: {} }) })
  assert.equal(failedRow.outcome, 'SUCCESS', 'okuma tamamdı')
  assert.equal(failedRow.checkpointAdvanced, false)
  let [view] = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(view.health.state, 'PARTIAL')
  assert.equal(view.health.reasonCode, 'HB_PERSIST_INCOMPLETE')
  assert.equal(view.health.lastSuccessfulSyncAt, null)

  // Sayım kanıtı: hata/atlama yok ama yazılan < beklenen → imleç durur.
  const shortCount = await run({ persistCanonical: async () => ({ persisted: 1, inserted: 1, updated: 0, failed: 0, skipped: {} }) })
  assert.equal(shortCount.checkpointAdvanced, false)
  assert.equal(shortCount.durabilityReasonCode, 'HB_PERSIST_INCOMPLETE')
  // Yazıcı sonuç döndürmezse kanıt YOK → imleç durur.
  const noProof = await run({ persistCanonical: async () => undefined })
  assert.equal(noProof.checkpointAdvanced, false)

  const noWriter = await run({})
  assert.equal(noWriter.checkpointAdvanced, false)
  ;[view] = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(view.health.reasonCode, 'HB_CANONICAL_WRITE_BLOCKED')
  assert.equal(view.health.lastSuccessfulSyncAt, null)

  const clean = await run({ persistCanonical: async (orders) => ({ persisted: orders.length, inserted: orders.length, updated: 0, failed: 0, skipped: {} }) })
  assert.equal(clean.checkpointAdvanced, true)
  ;[view] = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(Date.parse(view.health.lastSuccessfulSyncAt), NOW)
  assert.equal(view.health.state, 'OK')
})

test('HB-DURABLE-A: normalizasyon kimliksiz kaydı SAYAR; tekrar kayıp DEĞİLDİR; saf karar matrisi', async () => {
  const { normalizeHepsiburadaOrders } = await import('./marketplaces/hepsiburada/hepsiburadaOrderSource.ts')
  const keyless = pkg(9, { packageNumber: '', orderId: '', orderNumber: '' })
  const result = normalizeHepsiburadaOrders([pkg(1), pkg(1), keyless, pkg(2)])
  assert.equal(result.orders.length, 2)
  assert.equal(result.duplicateRemovedCount, 1)
  assert.equal(result.invalidIdentityCount, 1)

  // Her eksiklik kendi kararlı koduyla imleci durdurur.
  const persisted2 = { persisted: 2, inserted: 2, updated: 0, failed: 0, skipped: { NO_PACKAGE_NUMBER: 0, NO_ORDER_DATE: 0 } }
  const base = {
    completedThroughMs: NOW, merchantMismatchCount: 0, invalidIdentityCount: 0, gateAllowed: true,
    hasPersister: true, expectedCanonical: 2, persistResult: persisted2,
  }
  const decide = (over) => sync.resolveCheckpointDurability({ ...base, ...over })
  assert.deepEqual(decide({}), { durable: true, reasonCode: null })
  assert.equal(decide({ completedThroughMs: null }).reasonCode, 'HB_PERSIST_INCOMPLETE')
  assert.equal(decide({ merchantMismatchCount: 1 }).reasonCode, 'HB_MERCHANT_MISMATCH')
  assert.equal(decide({ invalidIdentityCount: 1 }).reasonCode, 'HB_RECORD_IDENTITY_MISSING')
  assert.equal(
    decide({ invalidIdentityCount: 1, expectedCanonical: 0, persistResult: null }).reasonCode,
    'HB_RECORD_IDENTITY_MISSING',
    'yalnız kimliksiz kayıt dönen yanıt BOŞ pencere sayılmaz',
  )
  assert.equal(decide({ gateAllowed: false }).reasonCode, 'HB_CANONICAL_WRITE_BLOCKED')
  assert.equal(decide({ hasPersister: false, persistResult: null }).reasonCode, 'HB_CANONICAL_WRITE_BLOCKED')
  assert.equal(decide({ persistResult: null }).reasonCode, 'HB_PERSIST_INCOMPLETE')
  assert.equal(decide({ persistResult: { ...persisted2, skipped: { NO_PACKAGE_NUMBER: 0, NO_ORDER_DATE: 1 } } }).reasonCode, 'HB_PERSIST_SKIPPED')
  assert.equal(decide({ persistResult: { ...persisted2, failed: 1 } }).reasonCode, 'HB_PERSIST_INCOMPLETE')
  assert.equal(decide({ persistResult: { ...persisted2, persisted: 1 } }).reasonCode, 'HB_PERSIST_INCOMPLETE', 'sayım kanıtı')
  assert.deepEqual(decide({ expectedCanonical: 0, persistResult: null }), { durable: true, reasonCode: null }, 'gerçekten boş pencere')
})

test('HB-DURABLE-B: kararlı kimliği olmayan kayıt dönen yanıt imleci İLERLETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const keyless = pkg(9, { packageNumber: '', orderId: '', orderNumber: '' })
  const mixed = await syncWith(db, org, accountId, fakeTransport([pkg(1), keyless]), { liveWriteGate: ALLOW })
  assert.equal(mixed.body.outcome, 'SUCCESS')
  // The time-aware provider returns each fixture only in its matching interval.
  assert.equal(mixed.body.fetched, 2)
  assert.equal(mixed.body.invalidIdentity, 1)
  assert.equal(mixed.body.persisted.persisted, 1, 'geçerli kayıt yine yazılır')
  assert.equal(mixed.body.checkpointAdvanced, false)
  assert.equal(mixed.body.durabilityReasonCode, 'HB_RECORD_IDENTITY_MISSING')
  let [view] = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(view.health.state, 'PARTIAL')
  assert.equal(view.health.reasonCode, 'HB_RECORD_IDENTITY_MISSING')
  assert.equal(view.health.lastSuccessfulSyncAt, null)

  // Yalnız kimliksiz kayıt dönen yanıt "boş pencere" SAYILMAZ.
  const onlyKeyless = await syncWith(db, org, accountId, fakeTransport([keyless]), { liveWriteGate: ALLOW })
  assert.equal(onlyKeyless.body.checkpointAdvanced, false)
  ;[view] = await connection.listHepsiburadaAccounts(db, org)
  assert.equal(view.health.lastSuccessfulSyncAt, null)
})

test('HB-DURABLE-C: saf tekrarlar (sayfa içi + sayfalar arası) imleci TEK BAŞINA durdurmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const inPage = await syncWith(db, org, accountId, fakeTransport([pkg(1), pkg(1), pkg(2)]), { liveWriteGate: ALLOW })
  assert.equal(inPage.body.persisted.persisted, 2)
  assert.equal(inPage.body.checkpointAdvanced, true)
  assert.equal(inPage.body.durabilityReasonCode, null)

  // Boundary overlap repeats package 2 in adjacent complete leaves.
  const loaded = await connection.loadHepsiburadaAccount(db, { organizationId: org, marketplaceAccountId: accountId })
  const later = NOW + HOUR
  const crossPage = await sync.syncHepsiburadaOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: accountId, config: loaded.config,
    fromMs: NOW, upperBoundMs: later, liveWriteGate: ALLOW,
    persistCanonical: (orders) => persistence.persistHepsiburadaOrders(db, { organizationId: org, marketplaceAccountId: accountId, orders }),
  }, { transport: fakeTransport([pkg(1, { orderDate: new Date(NOW + 1000).toISOString() }), pkg(2, { orderDate: new Date(NOW + HOUR / 2).toISOString() }), pkg(3, { orderDate: new Date(later - 1000).toISOString() })]).transport, pageLimit: 3, ...noSleep })
  assert.equal(crossPage.pagesFetched, 3)
  assert.equal(crossPage.normalizedCount, 3)
  assert.equal(crossPage.checkpointAdvanced, true)
  assert.equal(Date.parse((await connection.listHepsiburadaAccounts(db, org))[0].health.lastSuccessfulSyncAt), later)
  assert.equal((await db.select().from(schema.orders)).length, 3)
})

test('HB-DURABLE-D: tamamen geçerli ve yazılmış veri kümesi ile gerçekten boş pencere imleci İLERLETİR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const valid = await syncWith(db, org, accountId, fakeTransport([pkg(1), pkg(2), pkg(3)]), { liveWriteGate: ALLOW })
  assert.equal(valid.body.persisted.persisted, 3)
  assert.deepEqual(valid.body.persisted.skipped, { NO_PACKAGE_NUMBER: 0, NO_ORDER_DATE: 0 })
  assert.equal(valid.body.checkpointAdvanced, true)
  assert.equal(valid.body.healthState, 'OK')
  assert.equal(Date.parse((await connection.listHepsiburadaAccounts(db, org))[0].health.lastSuccessfulSyncAt), NOW)

  const later = NOW + 2 * HOUR
  const empty = await syncWith(db, org, accountId, fakeTransport([]), { liveWriteGate: ALLOW, now: () => later })
  assert.equal(empty.body.fetched, 0)
  assert.equal(empty.body.checkpointAdvanced, true, 'gerçekten boş başarılı pencere ilerletebilir')
  assert.equal(Date.parse((await connection.listHepsiburadaAccounts(db, org))[0].health.lastSuccessfulSyncAt), later)
})

test('HB-PERSIST-1: kanonik yazım hesap kapsamlı; orderNumber ≠ packageNumber; barkod takip DEĞİL; tekrar idempotent', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const dataset = [pkg(1), pkg(2), pkg(2), pkg(3, { packageNumber: '' }), pkg(4, { orderDate: '' })]
  const first = await syncWith(db, org, accountId, fakeTransport(dataset), { liveWriteGate: ALLOW })
  assert.equal(first.body.canonicalWrite, 'ALLOWED')
  assert.equal(first.body.persisted.persisted, 2)
  assert.deepEqual(first.body.persisted.skipped, { NO_PACKAGE_NUMBER: 1, NO_ORDER_DATE: 1 })
  // (A) Atlanan kayıt (paket no / tarih yok) kanonik depoda YOK → imleç DURUR;
  // geçerli kayıtlar yine yazılır (complete:false, idempotent).
  assert.equal(first.body.checkpointAdvanced, false)
  assert.equal(first.body.durabilityReasonCode, 'HB_PERSIST_SKIPPED')
  assert.equal(first.body.healthState, 'PARTIAL')
  assert.match(first.body.message, /eksiksiz yazılamadı/)
  assert.equal((await connection.listHepsiburadaAccounts(db, org))[0].health.lastSuccessfulSyncAt, null)
  const rows = await db.select().from(schema.orders)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.marketplace, 'Hepsiburada')
    assert.equal(row.marketplaceAccountId, accountId)
    assert.notEqual(row.orderNumber, row.packageId)
    assert.match(row.packageId, /^PKG-/)
    assert.match(row.orderNumber, /^HB-ORD-/)
    assert.match(row.cargoTrackingNumber, /^TRK/, 'takip = trackingInfoCode')
    assert.doesNotMatch(String(row.cargoTrackingNumber), /^BC/, 'barkod takip alanına YAZILMAZ')
  }
  const linesBefore = (await db.select().from(schema.orderLines)).length
  // Aynı veri tekrar → satır/kalem sayısı DEĞİŞMEZ.
  const again = await syncWith(db, org, accountId, fakeTransport(dataset), { liveWriteGate: ALLOW })
  assert.equal(again.body.persisted.inserted, 0)
  assert.equal((await db.select().from(schema.orders)).length, 2)
  assert.equal((await db.select().from(schema.orderLines)).length, linesBefore)
  assert.equal(linesBefore, 2)
  assert.equal(again.body.checkpointAdvanced, false, 'tekrar koşu da atlanan kaydı yazamaz → imleç durur')
  assert.equal((await connection.listHepsiburadaAccounts(db, org))[0].health.lastSuccessfulSyncAt, null)
})

test('HB-PERSIST-2: NULL marketplaceAccountId ile yazım İMKÂNSIZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const { normalizeHepsiburadaOrders } = await import('./marketplaces/hepsiburada/hepsiburadaOrderSource.ts')
  const orders = normalizeHepsiburadaOrders([pkg(1)]).orders
  await assert.rejects(persistence.persistHepsiburadaOrders(db, { organizationId: org, marketplaceAccountId: '', orders }), /account_scope_required/)
  await assert.rejects(persistence.persistHepsiburadaOrders(db, { organizationId: org, marketplaceAccountId: null, orders }), /account_scope_required/)
  const accountId = await connectAccount(db, org)
  await syncWith(db, org, accountId, fakeTransport([pkg(1), pkg(2)]), { liveWriteGate: ALLOW })
  assert.equal((await db.select().from(schema.orders).where(isNull(schema.orders.marketplaceAccountId))).length, 0)
  // Kaynak: kalıcılaştırma `complete:false` + hesap zorunlu.
  const source = readFileSync(join(here, 'connectors/hepsiburada/hepsiburadaPersistence.ts'), 'utf8')
  assert.match(source, /complete: false/)
  assert.match(source, /requireMarketplaceAccount: true/)
  assert.doesNotMatch(source, /complete: true/)
})

test('HB-PARTIAL-1: kısmi okuma mevcut siparişleri ARŞİVLEMEZ ve imleci İLERLETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const big = Array.from({ length: 150 }, (_, i) => pkg(i))
  await syncWith(db, org, accountId, fakeTransport(big), { liveWriteGate: ALLOW })
  const before = await db.select().from(schema.orders)
  assert.equal(before.length, 150)
  const stateBefore = (await connection.listHepsiburadaAccounts(db, org))[0].health.lastSuccessfulSyncAt

  // A completed first interval followed by a provider failure cannot checkpoint.
  const flaky = fakeTransport(big.slice(0, 120), { respond: (_call, index) => (index >= 2 ? { status: 503, headers: {}, bodyText: '' } : null) })
  const partial = await syncWith(db, org, accountId, flaky, { liveWriteGate: ALLOW, now: () => NOW + 26 * HOUR })
  assert.equal(partial.body.outcome, 'PARTIAL')
  assert.equal(partial.body.healthState, 'PARTIAL')
  const after = await db.select().from(schema.orders)
  assert.equal(after.length, 150)
  assert.equal(after.filter((row) => row.archivedAt !== null).length, 0, 'hiçbir sipariş arşivlenmedi')
  const stateAfter = (await connection.listHepsiburadaAccounts(db, org))[0].health.lastSuccessfulSyncAt
  assert.equal(stateAfter, stateBefore, 'imleç ilerlemedi')
})

test('HB-ISO-1: kiracı ve hesap izolasyonu — yabancı hesap okunamaz/yazılamaz; satırlar kendi hesabına', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const a1 = await connectAccount(db, orgA)
  const a2 = await connectAccount(db, orgA, { merchantId: 'm-2002' })
  const b1 = await connectAccount(db, orgB)
  assert.notEqual(a1, b1, 'aynı merchantId farklı kiracıda AYRI hesap')
  const fake = fakeTransport([pkg(1)])
  // B kiracısı A'nın hesabını kullanamaz.
  for (const handler of [handlers.handleHepsiburadaSync, handlers.handleHepsiburadaTest, handlers.handleHepsiburadaDisconnect]) {
    const result = await handler({ db, organizationId: orgB, body: { marketplaceAccountId: a1 }, clientOptions: { transport: fake.transport, ...noSleep }, now: () => NOW })
    assert.equal(result.status, 404)
  }
  assert.equal(fake.calls.length, 0)
  assert.equal((await connection.listHepsiburadaAccounts(db, orgB)).length, 1)

  // A'nın iki satıcısı: kayıtlar kendi hesabına; satıcısı uyuşmayan kayıt YAZILMAZ.
  await syncWith(db, orgA, a1, fakeTransport([pkg(1), pkg(2, { merchantId: 'm-9999' })]), { liveWriteGate: ALLOW })
  await syncWith(db, orgA, a2, fakeTransport([pkg(10, { merchantId: 'm-2002' })]), { liveWriteGate: ALLOW })
  const rowsA1 = await db.select().from(schema.orders).where(eq(schema.orders.marketplaceAccountId, a1))
  const rowsA2 = await db.select().from(schema.orders).where(eq(schema.orders.marketplaceAccountId, a2))
  assert.deepEqual(rowsA1.map((r) => r.packageId), ['PKG-5001'])
  assert.deepEqual(rowsA2.map((r) => r.packageId), ['PKG-5010'])
  assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.organizationId, orgB))).length, 0)
})

test('HB-FLIGHT-1: aynı hesapta eşzamanlı senkron REDDEDİLİR; uçuş hata dahil HER yolda düşer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  let release
  const gateOpen = new Promise((resolve) => { release = resolve })
  const slow = { transport: async (request) => { await gateOpen; return fakeTransport([pkg(1)]).transport(request) } }
  const first = syncWith(db, org, accountId, slow)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const second = await syncWith(db, org, accountId, fakeTransport([pkg(1)]))
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'HB_SYNC_IN_PROGRESS')
  release()
  assert.equal((await first).status, 200)
  assert.equal(handlers.hepsiburadaInFlightCount(), 0)
  // Taşıma fırlatırsa (ağ hatası sınıfı) da uçuş düşer.
  const throwing = { transport: async () => { throw new Error('boom') } }
  await syncWith(db, org, accountId, throwing)
  assert.equal(handlers.hepsiburadaInFlightCount(), 0)
  // İşleyici GERÇEKTEN istisna fırlatırsa da uçuş düşer (finally).
  await assert.rejects(syncWith(db, org, accountId, fakeTransport([pkg(1)]), { liveWriteGate: () => { throw new Error('gate exploded') } }), /gate exploded/)
  assert.equal(handlers.hepsiburadaInFlightCount(), 0)
  assert.equal((await syncWith(db, org, accountId, fakeTransport([pkg(1)]))).status, 200)
})

test('HB-HEALTH-1: yedi durum kararlı sözlükle ayrışır', () => {
  const resolve = (syncState, over = {}) => health.resolveHepsiburadaHealth({ hasEndpointPath: true, credentialsComplete: true, syncState, ...over }).state
  assert.equal(resolve(null), 'NEVER_RUN')
  assert.equal(resolve({ lastSyncStatus: 'success' }), 'OK')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'HB_HTTP_401' }), 'AUTH_ERROR')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'HB_HTTP_429' }), 'RATE_LIMITED')
  assert.equal(resolve({ lastSyncStatus: 'partial', lastErrorCode: 'HB_HTTP_429' }), 'RATE_LIMITED')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'HB_ENDPOINT_NOT_FOUND' }), 'ENDPOINT_CONFIG_REQUIRED')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'HB_HTTP_503' }), 'PROVIDER_UNAVAILABLE')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'HB_TIMEOUT' }), 'PROVIDER_UNAVAILABLE')
  assert.equal(resolve({ lastSyncStatus: 'partial', lastErrorCode: 'HB_HTTP_503' }), 'PARTIAL')
  // İç test: okuma başarılı, yazım kapalı → okuma sağlığı OK (imleç durur).
  assert.equal(resolve({ lastSyncStatus: 'partial', lastErrorCode: 'HB_CANONICAL_WRITE_BLOCKED' }), 'OK')
  assert.equal(resolve({ lastSyncStatus: 'partial', lastErrorCode: 'HB_PERSIST_INCOMPLETE' }), 'PARTIAL')
  assert.equal(resolve(null, { hasEndpointPath: false }), 'ENDPOINT_CONFIG_REQUIRED')
  assert.deepEqual([...health.HEPSIBURADA_HEALTH_STATES].sort(), ['AUTH_ERROR', 'ENDPOINT_CONFIG_REQUIRED', 'NEVER_RUN', 'OK', 'PARTIAL', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED'])
})

test('HB-SAFETY-1: Sürat/taşıyıcı/etiket akışına bağlanmaz; zamanlayıcı yok; pazaryeri yazması yok', () => {
  const dir = join(here, 'connectors/hepsiburada')
  const sources = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n')
  assert.doesNotMatch(sources, /surat|createSuratShipment|labelJob|requestLabelJobCycle|enqueueAutoLabel/i)
  assert.doesNotMatch(sources, /setInterval\(/, 'otomatik zamanlayıcı YOK')
  assert.doesNotMatch(sources, /complete: true/)
  // Etiket yeteneği değişmedi: ortak barkod yalnız HepsiJet + Aras.
  const capability = readFileSync(join(here, 'marketplaces/hepsiburada/hepsiburadaLabelCapability.ts'), 'utf8')
  assert.match(capability, /HEPSIBURADA_MUTUAL_BARCODE_CARRIERS = \['hepsijet', 'aras'\] as const/)
  // index.mjs: uçlar tenant auth arkasında, otomatik başlatma YOK.
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(index, /'\/api\/integrations\/hepsiburada',/)
  assert.doesNotMatch(index, /startHepsiburada[A-Za-z]*OnBoot/)
  // Rotalar AÇIK: `tenant-auth-coverage-flow` taraması her birini org kapsamlı
  // görmeli (döngüyle/ortak çözücüyle tanımlanırsa tarama onları kaçırır).
  const routes = [...index.matchAll(/^app\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm)]
    .map((match) => ({ route: `${match[1].toUpperCase()} ${match[2]}`, index: match.index }))
  const hbRoutes = routes
    .map((entry, i) => ({ ...entry, body: index.slice(entry.index, routes[i + 1]?.index ?? index.length) }))
    .filter((entry) => entry.route.includes('/api/integrations/hepsiburada'))
  assert.deepEqual(hbRoutes.map((entry) => entry.route), [
    'GET /api/integrations/hepsiburada/accounts',
    'POST /api/integrations/hepsiburada/accounts',
    'POST /api/integrations/hepsiburada/accounts/disconnect',
    'POST /api/integrations/hepsiburada/accounts/test',
    'POST /api/integrations/hepsiburada/accounts/sync',
  ])
  for (const entry of hbRoutes) assert.match(entry.body, /requireOnboardingContext\(/, entry.route)
})
