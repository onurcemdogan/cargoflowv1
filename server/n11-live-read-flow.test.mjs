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

// ═══ N11-LIVE-001 — HESAP KAPSAMLI YALNIZ-OKUMA BAĞLAYICI ═════════════════
//
// GERÇEK AĞ YOK, GERÇEK KİMLİK YOK: taşıma enjekte edilir. Fixture'lar resmî
// "Sipariş Listeleme Servisi" yanıt örneğinin ŞEKLİNDEN türetildi
// (developer.n11.com, 2026-10-13): `content` zarfı, epoch ms tarihler,
// `shipmentPackageStatus`, `packageHistories`, `sellerId`. Yazma kapısı
// varsayılan yayın aşamasıdır (`internal_test` → kanonik yazım KAPALI);
// kanonik kalıcılaştırma yolu testte açık kapı ENJEKTE edilerek sınanır.

const here = dirname(fileURLToPath(import.meta.url))
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const contract = await import('./marketplaces/n11/n11Contract.ts')
const source = await import('./marketplaces/n11/n11OrderSource.ts')
const config = await import('./connectors/n11/n11Config.ts')
const client = await import('./connectors/n11/n11Client.ts')
const sync = await import('./connectors/n11/n11OrderSync.ts')
const persistence = await import('./connectors/n11/n11Persistence.ts')
const connection = await import('./connectors/n11/n11ConnectionService.ts')
const health = await import('./connectors/n11/n11Health.ts')
const handlers = await import('./connectors/n11/n11HttpHandlers.ts')
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
async function makeOrg(db, slug = `n11-${randomBytes(4).toString('hex')}`) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const APP_KEY = 'n11-app-key-ABC123'
const APP_SECRET = 'n11-S3cret-XYZ789'
const ALLOW = () => ({ decision: 'ALLOWED', stage: 'pilot', reasonCode: 'TEST_INJECTED' })
const noSleep = { sleep: async () => {} }

/** Resmî yanıt örneği şeklinde paket (tarihler epoch ms SAYI). */
function pkg(i, over = {}) {
  const modified = NOW - (i % 20) * HOUR - 60_000
  return {
    id: String(112999455244000 + i),
    orderNumber: String(203872347000 + i),
    customerfullName: 'N11 müşteri',
    cargoSenderNumber: `TRK${7000 + i}`,
    cargoTrackingNumber: `BC${9000 + i}`,
    cargoTrackingLink: `https://tracking.example.invalid/${i}`,
    shipmentCompanyId: 342,
    cargoProviderName: 'MNG Kargo',
    shippingAddress: { city: 'İstanbul', district: 'Sarıyer', fullName: 'N11 müşteri' },
    billingAddress: { city: 'İstanbul' },
    lines: [{ orderLineId: 415490000 + i, productName: `Ürün ${i}`, stockCode: `SKU-${i}`, barcode: `869000${i}`, quantity: 1, orderItemLineItemStatusName: 'Created', sender: 'SELLER' }],
    lastModifiedDate: modified,
    packageHistories: [{ createdDate: modified - 5_000, status: 'Created' }],
    shipmentPackageStatus: 'Created',
    sellerId: 9876543,
    ...over,
  }
}

/**
 * Sahte n11: statü + `lastModifiedDate` penceresine (ASC) ve `sender`e göre
 * süzer, page/size ile dilimler, resmî zarfı döndürür. Resmî varsayılan
 * modellenir: `sender` yoksa YALNIZ SELLER kayıtları döner. `onCall`, yanıt
 * hesaplanmadan ÖNCE veri kümesini değiştirebilir (okuma sırasında değişen
 * sağlayıcı). Her çağrının totalPages'i ve döndürdüğü kimlikler kaydedilir.
 */
function fakeTransport(dataset, behaviour = {}) {
  const calls = []
  const transport = async (request) => {
    const url = new URL(request.url)
    const call = {
      url: request.url,
      host: url.hostname,
      path: url.pathname,
      page: Number(url.searchParams.get('page')),
      size: Number(url.searchParams.get('size')),
      status: url.searchParams.get('status'),
      sender: url.searchParams.get('sender'),
      startDate: Number(url.searchParams.get('startDate')),
      endDate: Number(url.searchParams.get('endDate')),
      orderByField: url.searchParams.get('orderByField'),
      orderByDirection: url.searchParams.get('orderByDirection'),
      headers: request.headers,
    }
    calls.push(call)
    behaviour.onCall?.(call, calls.length, dataset)
    const scripted = behaviour.respond?.(call, calls.length)
    if (scripted) return scripted
    const requestedSender = String(call.sender ?? 'SELLER').toUpperCase()
    const matching = dataset
      .filter((row) => {
        if (typeof row !== 'object' || row === null) return call.status === 'Created'
        const status = row.shipmentPackageStatus ?? 'Created'
        const modified = Number(row.lastModifiedDate ?? NOW - HOUR)
        const rowSender = String(row.lines?.[0]?.sender ?? 'SELLER').toUpperCase()
        // Sınır anlamı resmî olarak kanıtsız: varsayılan [start, end); `exclusive`
        // modu (start, end) — en kötü durumu modeller.
        const inWindow = behaviour.boundary === 'exclusive'
          ? modified > call.startDate && modified < call.endDate
          : modified >= call.startDate && modified < call.endDate
        return status === call.status && inWindow && (requestedSender === 'ALL' || rowSender === requestedSender)
      })
      .sort((a, b) => Number(a?.lastModifiedDate ?? 0) - Number(b?.lastModifiedDate ?? 0))
    const content = matching.slice(call.page * call.size, call.page * call.size + call.size)
    const totalPages = behaviour.totalPages ?? Math.ceil(matching.length / call.size)
    call.totalPages = totalPages
    call.contentIds = content.map((row) => row?.id ?? null)
    return {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ pageCount: content.length, totalPages, page: call.page, size: call.size, content }),
    }
  }
  return { transport, calls }
}

/** Doğrudan senkron (seçeneklerle); yazıcı partileri kaydedilir. */
async function runSync(db, org, accountId, fake, { params = {}, options = {}, batches = [] } = {}) {
  const loaded = await connection.loadN11Account(db, { organizationId: org, marketplaceAccountId: accountId })
  return sync.syncN11OrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: accountId, config: loaded.config,
    fromMs: NOW - DAY, upperBoundMs: NOW, liveWriteGate: ALLOW,
    persistCanonical: (orders) => {
      batches.push(orders.map((order) => order.packageId))
      return persistence.persistN11Orders(db, { organizationId: org, marketplaceAccountId: accountId, orders })
    },
    ...params,
  }, { transport: fake.transport, ...noSleep, ...options })
}

async function connectAccount(db, org, over = {}) {
  const result = await connection.connectN11Account(db, { organizationId: org, appKey: APP_KEY, appSecret: APP_SECRET, ...over })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  return result.marketplaceAccountId
}

async function syncWith(db, org, accountId, fake, extra = {}) {
  return handlers.handleN11Sync({
    db, organizationId: org, body: { marketplaceAccountId: accountId },
    clientOptions: { transport: fake.transport, ...noSleep }, now: () => NOW, ...extra,
  })
}

const view = async (db, org, accountId) =>
  (await connection.listN11Accounts(db, org)).find((entry) => entry.marketplaceAccountId === accountId)

const cfg = { appKey: APP_KEY, appSecret: APP_SECRET, boundSellerId: null }
const pageQuery = (over = {}) => ({ status: 'Created', page: 0, size: 10, startMs: NOW - DAY, endMs: NOW, ...over })

/* ═══ A. KİMLİK ═══════════════════════════════════════════════════════════ */

test('N11-CRED-1: appkey/appsecret BAŞLIK; Authorization YOK; sır URL\'de YOK; eksik kimlik → ağ 0', async () => {
  const fake = fakeTransport([pkg(1)])
  const page = await client.fetchN11Page(cfg, pageQuery(), { transport: fake.transport, ...noSleep })
  assert.equal(page.ok, true)
  const [call] = fake.calls
  assert.equal(call.headers.appkey, APP_KEY)
  assert.equal(call.headers.appsecret, APP_SECRET)
  assert.equal('Authorization' in call.headers || 'authorization' in call.headers, false)
  assert.doesNotMatch(call.url, new RegExp(`${APP_KEY}|${APP_SECRET}`))

  for (const bad of [{ ...cfg, appSecret: '' }, { ...cfg, appKey: '' }]) {
    const none = fakeTransport([pkg(1)])
    const result = await client.fetchN11Page(bad, pageQuery(), { transport: none.transport, ...noSleep })
    assert.equal(result.ok, false)
    assert.equal(result.errorClass, 'CREDENTIALS_MISSING')
    assert.equal(result.networkCalls, 0)
    assert.equal(none.calls.length, 0)
  }
})

test('N11-CRED-2: kimlik ŞİFRELİ; hesap kimliği appKey parmak izi; yanıt/liste/log sır İÇERMEZ; düzenleme kuralları', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const logged = []
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  for (const level of Object.keys(original)) console[level] = (...args) => logged.push(args.map(String).join(' '))
  t.after(() => Object.assign(console, original))

  const connect = await handlers.handleN11Connect({ db, organizationId: org, body: { appKey: APP_KEY, appSecret: APP_SECRET } })
  assert.equal(connect.status, 200)
  const accountId = connect.body.marketplaceAccountId
  const [account] = await db.select().from(schema.marketplaceAccounts).where(eq(schema.marketplaceAccounts.id, accountId))
  assert.equal(account.marketplace, 'n11')
  assert.equal(account.providerAccountId, config.n11AccountFingerprint(APP_KEY))
  assert.notEqual(account.providerAccountId, APP_KEY)
  assert.doesNotMatch(JSON.stringify(account), new RegExp(`${APP_KEY}|${APP_SECRET}`))
  const credentialRows = await db.select().from(schema.connectorCredentials)
  assert.equal(credentialRows.length, 1)
  assert.doesNotMatch(JSON.stringify(credentialRows), new RegExp(`${APP_KEY}|${APP_SECRET}`), 'şifreli saklanır')

  const list = await handlers.handleN11ListAccounts({ db, organizationId: org })
  const text = JSON.stringify(list.body)
  assert.doesNotMatch(text, new RegExp(`${APP_KEY}|${APP_SECRET}`))
  assert.equal(list.body.accounts[0].config.hasAppSecret, true)
  assert.equal(list.body.accounts[0].config.appKeyMasked, '•••123')
  assert.equal(list.body.liveVerified, false)
  assert.equal(list.body.marketplaceWritesEnabled, false)

  // Düzenleme: boş sır KORUNUR; farklı appKey REDDEDİLİR; aynı appKey AYNI hesap.
  assert.equal((await connection.connectN11Account(db, { organizationId: org, marketplaceAccountId: accountId, appKey: '', appSecret: '' })).ok, true)
  assert.equal((await connection.loadN11Account(db, { organizationId: org, marketplaceAccountId: accountId })).config.appSecret, APP_SECRET)
  const changed = await handlers.handleN11Connect({ db, organizationId: org, body: { marketplaceAccountId: accountId, appKey: 'another-key', appSecret: 'x' } })
  assert.equal(changed.status, 400)
  assert.deepEqual(changed.body.errors, ['N11_APP_KEY_CHANGED'])
  assert.equal((await connection.connectN11Account(db, { organizationId: org, appKey: APP_KEY, appSecret: '' })).marketplaceAccountId, accountId)
  const invalid = await handlers.handleN11Connect({ db, organizationId: org, body: { appKey: 'has space', appSecret: APP_SECRET } })
  assert.equal(invalid.status, 400)
  assert.doesNotMatch(JSON.stringify(invalid.body), new RegExp(APP_SECRET))

  // Okuma + hata yolları da sır SIZDIRMAZ.
  await syncWith(db, org, accountId, fakeTransport([pkg(1)]), { liveWriteGate: ALLOW })
  const denied = await syncWith(db, org, accountId, fakeTransport([], { respond: () => ({ status: 401, headers: {}, bodyText: '{}' }) }))
  assert.doesNotMatch(JSON.stringify(denied.body), new RegExp(`${APP_KEY}|${APP_SECRET}`))
  assert.doesNotMatch(logged.join('\n'), new RegExp(`${APP_KEY}|${APP_SECRET}`), 'loglarda sır YOK')
})

/* ═══ B. HTTP ═════════════════════════════════════════════════════════════ */

test('N11-HTTP-1: yalnız kanıtlı host + yol + GET; resmî sorgu parametreleri; yazma ucu KULLANILMAZ', async () => {
  const fake = fakeTransport([pkg(1)])
  await client.fetchN11Page(cfg, pageQuery({ size: 500, status: 'Picking' }), { transport: fake.transport, ...noSleep })
  const [call] = fake.calls
  assert.equal(call.host, 'api.n11.com')
  assert.equal(call.path, '/rest/delivery/v1/shipmentPackages')
  assert.equal(call.size, 100, 'size ≤ 100')
  assert.equal(call.status, 'Picking')
  assert.equal(call.orderByField, 'true')
  assert.equal(call.orderByDirection, 'ASC')
  assert.equal(call.sender, 'ALL', 'n11 depo siparişleri dışlanmaz')
  assert.equal(call.startDate, NOW - DAY, 'epoch ms')
  assert.equal(client.isVerifiedN11Url('https://api.n11.com/rest/delivery/v1/shipmentPackages?page=0'), true)
  for (const bad of [
    'http://api.n11.com/rest/delivery/v1/shipmentPackages',
    'https://api.n11.com.evil.io/rest/delivery/v1/shipmentPackages',
    'https://user:pw@api.n11.com/rest/delivery/v1/shipmentPackages',
    'https://api.n11.com:8443/rest/delivery/v1/shipmentPackages',
    'https://api.n11.com/rest/order/v1/update',
  ]) assert.equal(client.isVerifiedN11Url(bad), false, bad)

  // Yorumlar ayıklanır: yalnız ÇALIŞAN kod taranır.
  const dir = join(here, 'connectors/n11')
  const code = readdirSync(dir)
    .map((file) => readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
    .join('\n')
  assert.match(code, /method: 'GET'/)
  assert.doesNotMatch(code, /method:\s*'(POST|PUT|PATCH|DELETE)'/)
  assert.doesNotMatch(code, /N11_ORDER_UPDATE_URL|order\/v1\/update/, 'güncelleme ucu bağlayıcıda YOK')
})

test('N11-HTTP-2: yönlendirme REDDEDİLİR; 401/403 tekrar YOK; 404 ve 4xx reddedilir', async () => {
  for (const [status, code, errorClass] of [
    [302, 'N11_REDIRECT_REFUSED', 'REQUEST_REJECTED'],
    [401, 'N11_HTTP_401', 'AUTH_ERROR'],
    [403, 'N11_HTTP_403', 'AUTH_ERROR'],
    [404, 'N11_HTTP_404', 'REQUEST_REJECTED'],
    [400, 'N11_HTTP_400', 'REQUEST_REJECTED'],
  ]) {
    const fake = fakeTransport([], { respond: () => ({ status, headers: { location: 'https://evil.example/' }, bodyText: '' }) })
    const page = await client.fetchN11Page(cfg, pageQuery(), { transport: fake.transport, retryDelaysMs: [1, 1], ...noSleep })
    assert.equal(page.ok, false)
    assert.equal(page.errorClass, errorClass, String(status))
    assert.equal(page.reasonCode, code)
    assert.equal(fake.calls.length, 1, `${status} tekrar edilmez`)
  }
})

test('N11-HTTP-3: 429 SINIRLI (Retry-After tavanlı), 5xx ve ağ hatası SINIRLI tekrar', async () => {
  const sleeps = []
  const limited = fakeTransport([], { respond: () => ({ status: 429, headers: { 'retry-after': '7' }, bodyText: '' }) })
  const rate = await client.fetchN11Page(cfg, pageQuery(), {
    transport: limited.transport, retryDelaysMs: [100, 200], sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(rate.errorClass, 'RATE_LIMITED')
  assert.equal(limited.calls.length, 3, '1 + 2 tekrar')
  assert.deepEqual(sleeps, [7000, 7000])
  const capped = []
  await client.fetchN11Page(cfg, pageQuery(), {
    transport: fakeTransport([], { respond: () => ({ status: 429, headers: { 'retry-after': '3600' }, bodyText: '' }) }).transport,
    retryDelaysMs: [100], maxRateWaitMs: 5_000, sleep: async (ms) => { capped.push(ms) },
  })
  assert.deepEqual(capped, [5_000], 'bekleme TAVANLI')

  const down = fakeTransport([], { respond: () => ({ status: 503, headers: {}, bodyText: '' }) })
  const unavailable = await client.fetchN11Page(cfg, pageQuery(), { transport: down.transport, retryDelaysMs: [1, 1], ...noSleep })
  assert.equal(unavailable.errorClass, 'PROVIDER_UNAVAILABLE')
  assert.equal(down.calls.length, 3)

  let networkCalls = 0
  const network = await client.fetchN11Page(cfg, pageQuery(), {
    transport: async () => { networkCalls += 1; throw new client.N11TransportError('NETWORK') },
    retryDelaysMs: [1, 1], ...noSleep,
  })
  assert.equal(network.reasonCode, 'N11_NETWORK_ERROR')
  assert.equal(networkCalls, 3)
})

test('N11-HTTP-4: üretim taşıması zaman aşımında TIMEOUT verir ve zamanlayıcıyı temizler', async (t) => {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }))
  const { port } = server.address()
  const started = Date.now()
  await assert.rejects(
    client.fetchN11Transport({ url: `http://127.0.0.1:${port}/x`, headers: {}, timeoutMs: 150 }),
    (error) => error instanceof client.N11TransportError && error.kind === 'TIMEOUT',
  )
  assert.ok(Date.now() - started < 5_000)
})

test('N11-HTTP-5: zarf yalnız resmî biçim (`content` + `totalPages`); belirsiz biçim YAZILMAZ', async () => {
  for (const bodyText of [
    'not json',
    JSON.stringify([pkg(1)]),
    JSON.stringify({ items: [pkg(1)], totalPages: 1 }),
    JSON.stringify({ data: { content: [pkg(1)], totalPages: 1 } }),
    JSON.stringify({ content: [pkg(1)] }),
    JSON.stringify({ content: { 0: pkg(1) }, totalPages: 1 }),
  ]) {
    const page = await client.fetchN11Page(cfg, pageQuery(), {
      transport: async () => ({ status: 200, headers: {}, bodyText }), ...noSleep,
    })
    assert.equal(page.ok, false, bodyText.slice(0, 40))
    assert.equal(page.errorClass, 'RESPONSE_SHAPE_UNVERIFIED')
  }
})

/* ═══ C. GÖNDERİCİ + UYARLANIR ARALIK BÖLME ═══════════════════════════════ */

test('N11-SENDER-1: her okuma isteği sender=ALL taşır; SELLER ve n11 depo kayıtları birlikte gelir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const depot = pkg(2, { lines: [{ ...pkg(2).lines[0], sender: 'N11' }] })
  const fake = fakeTransport([pkg(1), depot])
  const result = await runSync(db, org, accountId, fake)
  assert.ok(fake.calls.length >= contract.N11_PACKAGE_STATUSES.length)
  for (const call of fake.calls) assert.equal(call.sender, 'ALL', 'her istek sender=ALL')
  assert.equal(result.normalizedCount, 2, 'n11 depo kaydı SESSİZCE dışlanmaz')
  assert.equal(result.checkpointAdvanced, true)
  const packages = (await db.select().from(schema.orders)).map((row) => row.packageId).sort()
  assert.deepEqual(packages, [pkg(1).id, depot.id].sort())

  // Test Et de aynı resmî gönderici kapsamını kullanır.
  const probe = fakeTransport([pkg(1), depot])
  await handlers.handleN11Test({ db, organizationId: org, body: { marketplaceAccountId: accountId }, clientOptions: { transport: probe.transport, ...noSleep }, now: () => NOW })
  assert.deepEqual(probe.calls.map((call) => call.sender), ['ALL'])
})

test('N11-SPLIT-1: çok sayfalı aralık YAZILMADAN bölünür; tüm kayıtlar temsil edilir; tek sayfalık aralık bölünmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const dataset = Array.from({ length: 9 }, (_, i) => pkg(i))
  const fake = fakeTransport(dataset)
  const batches = []
  const result = await runSync(db, org, accountId, fake, { options: { pageSize: 2 }, batches })
  for (const call of fake.calls) assert.equal(call.page, 0, 'YALNIZ page 0 — sayfa yürütme YOK')
  assert.ok(result.splitCount > 0, 'çok sayfalı aralık bölündü')
  // Yazılan her parti, totalPages ≤ 1 olan TEK bir yanıtın tamamıdır; çok
  // sayfalı (geniş) yanıtların içeriği yazıcıya ULAŞMAZ.
  const singlePage = fake.calls.filter((call) => call.totalPages <= 1).map((call) => JSON.stringify([...call.contentIds].sort()))
  assert.ok(batches.length > 0)
  for (const batch of batches) {
    assert.ok(batch.length <= 2)
    assert.ok(singlePage.includes(JSON.stringify([...batch].sort())), `parti tek-sayfa yanıttan: ${batch}`)
  }
  for (const call of fake.calls) assert.ok(call.endDate - call.startDate <= contract.N11_WINDOW_MS, 'istek ≤ 15 gün')
  assert.deepEqual((await db.select().from(schema.orders)).map((row) => row.packageId).sort(), dataset.map((row) => row.id).sort())
  assert.equal(result.duplicateRemovedCount, 0)
  assert.equal(result.checkpointAdvanced, true)

  // Tek sayfalık aralık: statü başına TEK istek, bölme yok.
  const { pglite: pglite2, db: db2 } = await makeDb()
  t.after(() => pglite2.close())
  const org2 = await makeOrg(db2)
  const account2 = await connectAccount(db2, org2)
  const small = fakeTransport([pkg(1), pkg(2), pkg(3)])
  const simple = await runSync(db2, org2, account2, small)
  assert.equal(small.calls.length, contract.N11_PACKAGE_STATUSES.length)
  assert.equal(simple.splitCount, 0)
  assert.equal(simple.normalizedCount, 3)
  assert.equal(simple.checkpointAdvanced, true)
})

test('N11-SPLIT-2: okuma sırasında değişen veri kümesi — sayfa kaymasıyla kaybolacak kayıt YAKALANIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const start = NOW - DAY
  const A = pkg(101, { lastModifiedDate: start + 1 * HOUR })
  const B = pkg(102, { lastModifiedDate: start + 2 * HOUR })
  const C = pkg(103, { lastModifiedDate: start + 20 * HOUR })
  // İlk yanıttan SONRA A değişir: yeni lastModifiedDate koşunun üst sınırının
  // ötesine geçer → A sabit aralıktan çıkar, sonraki kayıtlar bir sıra geri
  // kayar. Eski page 0/1 yürütmesi C'yi hiç görmeden pencereyi tamam sayardı.
  const fake = fakeTransport([A, B, C], {
    onCall: (_call, n) => {
      if (n === 2) A.lastModifiedDate = NOW + 5 * 60_000
    },
  })
  const first = await runSync(db, org, accountId, fake, { options: { pageSize: 2 } })
  const afterFirst = (await db.select().from(schema.orders)).map((row) => row.packageId).sort()
  assert.deepEqual(afterFirst, [B.id, C.id].sort(), 'kaymış kayıt C YAKALANDI')
  assert.equal(first.checkpointAdvanced, true, 'pencere kanıtlanmış biçimde tam')
  assert.equal(first.checkpointMs, NOW)

  // A'nın YENİ hâli imleçten sonraki pencerededir: sonraki koşu onu okur.
  const later = NOW + 10 * 60_000
  const second = await runSync(db, org, accountId, fakeTransport([A, B, C]), {
    params: { fromMs: first.checkpointMs, upperBoundMs: later },
    options: { pageSize: 2 },
  })
  assert.equal(second.checkpointAdvanced, true)
  assert.deepEqual((await db.select().from(schema.orders)).map((row) => row.packageId).sort(), [A.id, B.id, C.id].sort())
})

test('N11-SPLIT-3: bölünemeyen yoğun aralık ve istek bütçesi → PARTIAL, imleç İLERLEMEZ, sayfa yürütmeye DÜŞÜLMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const sameInstant = NOW - HOUR
  const dense = [201, 202, 203].map((i) => pkg(i, { lastModifiedDate: sameInstant }))
  const fake = fakeTransport(dense)
  const result = await runSync(db, org, accountId, fake, { options: { pageSize: 2, minSplitIntervalMs: 1_000 } })
  assert.equal(result.outcome, 'PARTIAL')
  assert.equal(result.reasonCode, 'N11_DENSE_WINDOW_UNSPLITTABLE')
  assert.equal(result.checkpointAdvanced, false)
  for (const call of fake.calls) assert.equal(call.page, 0, 'güvensiz sayfa yürütme YOK')
  assert.ok(fake.calls.length < 80, 'bölme SINIRLI')
  assert.equal((await db.select().from(schema.orders)).length, 0, 'çok sayfalı yanıt yazılmadı')
  let current = await view(db, org, accountId)
  assert.equal(current.health.state, 'PARTIAL')
  assert.equal(current.health.reasonCode, 'N11_DENSE_WINDOW_UNSPLITTABLE')
  assert.equal(current.health.lastSuccessfulSyncAt, null)

  const budget = await runSync(db, org, accountId, fakeTransport(Array.from({ length: 9 }, (_, i) => pkg(i))), {
    options: { pageSize: 2, maxRequestsPerRun: 3 },
  })
  assert.equal(budget.outcome, 'PARTIAL')
  assert.equal(budget.reasonCode, 'N11_REQUEST_BUDGET_EXHAUSTED')
  assert.equal(budget.checkpointAdvanced, false)
  current = await view(db, org, accountId)
  assert.equal(current.health.lastSuccessfulSyncAt, null)
})

test('N11-SPLIT-4: sınır anlamı kanıtsız — iki ucu da HARİÇ tutan sağlayıcıda tam sınırdaki kayıt KAYBOLMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const fromMs = NOW - 20 * DAY
  const plan = sync.planN11Windows({ fromMs, upperBoundMs: NOW })
  assert.equal(plan.windows.length, 2)
  const boundary = plan.windows[0].endMs
  const onBoundary = pkg(301, { lastModifiedDate: boundary })
  const fake = fakeTransport([pkg(1), onBoundary], { boundary: 'exclusive' })
  const result = await runSync(db, org, accountId, fake, { params: { fromMs } })
  assert.equal(result.windowsDurable, 2)
  const packages = (await db.select().from(schema.orders)).map((row) => row.packageId)
  assert.ok(packages.includes(onBoundary.id), 'pencere sınırındaki kayıt yakalandı (1 ms örtüşme)')
  assert.equal(packages.length, 2)
})

/* ═══ D. PENCERE / İMLEÇ ═══════════════════════════════════════════════════ */

test('N11-WIN-1: ≤ 15 günlük boşluksuz pencereler, EN ESKİ önce; ileri kırpma YOK; moreRemaining dürüst', async (t) => {
  const plan = sync.planN11Windows({ fromMs: NOW - 40 * DAY, upperBoundMs: NOW })
  assert.equal(plan.windows.length, 3)
  assert.equal(plan.windows[0].startMs, NOW - 40 * DAY, 'eski aralık ATLANMAZ')
  assert.equal(plan.windows.at(-1).endMs, NOW)
  for (const w of plan.windows) assert.ok(w.endMs - w.startMs <= contract.N11_WINDOW_MS)
  for (let i = 1; i < plan.windows.length; i += 1) assert.equal(plan.windows[i].startMs, plan.windows[i - 1].endMs)
  assert.equal(plan.moreRemaining, false)
  const capped = sync.planN11Windows({ fromMs: NOW - 40 * DAY, upperBoundMs: NOW, maxWindows: 2 })
  assert.equal(capped.windows.length, 2)
  assert.equal(capped.moreRemaining, true)
  assert.equal(sync.planN11Windows({ fromMs: null, upperBoundMs: NOW }).windows[0].startMs, NOW - contract.N11_WINDOW_MS)
  assert.equal(sync.planN11Windows({ fromMs: NOW, upperBoundMs: NOW }).windows.length, 0)

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const loaded = await connection.loadN11Account(db, { organizationId: org, marketplaceAccountId: accountId })
  const old = [pkg(1, { lastModifiedDate: NOW - 38 * DAY }), pkg(2, { lastModifiedDate: NOW - 20 * DAY }), pkg(3)]
  const fake = fakeTransport(old)
  const run = await sync.syncN11OrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: accountId, config: loaded.config,
    fromMs: NOW - 40 * DAY, upperBoundMs: NOW, liveWriteGate: ALLOW, maxWindows: 2,
    persistCanonical: (orders) => persistence.persistN11Orders(db, { organizationId: org, marketplaceAccountId: accountId, orders }),
  }, { transport: fake.transport, ...noSleep })
  for (const call of fake.calls) assert.ok(call.endDate - call.startDate <= contract.N11_WINDOW_MS)
  // İstekler aralık başından 1 ms önce başlar (kanıtsız sınır anlamına karşı örtüşme).
  assert.equal(Math.min(...fake.calls.map((call) => call.startDate)), NOW - 40 * DAY - sync.N11_BOUNDARY_OVERLAP_MS)
  assert.equal(run.windowsDurable, 2)
  assert.equal(run.checkpointMs, capped.windows[1].endMs, 'imleç ikinci pencere sonunda')
  assert.ok(Math.abs(run.checkpointMs - (NOW - 10 * DAY)) <= 2)
  assert.equal(run.moreRemaining, true)
  assert.equal(Date.parse((await view(db, org, accountId)).health.lastSuccessfulSyncAt), capped.windows[1].endMs)
  assert.equal((await db.select().from(schema.orders)).length, 2, 'eski iki sipariş yazıldı')
})

/* ═══ E. ANLAM ════════════════════════════════════════════════════════════ */

test('N11-SEM-1: cargoSenderNumber TAKİP, cargoTrackingNumber BARKOD; id ≠ orderNumber; bilinmeyen taşıyıcı null; ham statü; epoch tarihler', () => {
  const order = source.normalizeN11Order(pkg(1))
  assert.equal(order.marketplaceTrackingNumber, 'TRK7001')
  assert.equal(order.marketplaceBarcode, 'BC9001')
  assert.equal(order.packageId, '112999455244001')
  assert.equal(order.orderNumber, '203872347001')
  assert.notEqual(order.packageId, order.orderNumber)
  assert.equal(order.marketplaceCarrier, 'mng')
  assert.equal(order.rawMarketplaceStatus, 'Created')
  assert.equal(order.lastModifiedDate, new Date(pkg(1).lastModifiedDate).toISOString(), 'epoch ms → ISO')
  assert.equal(order.orderDate, new Date(pkg(1).packageHistories[0].createdDate).toISOString(), 'Created geçmişi')
  assert.equal(order.items[0].merchantSku, 'SKU-1')
  assert.equal(order.items[0].productBarcode, '8690001')

  const unknown = source.normalizeN11Order(pkg(2, { cargoProviderName: 'Bilinmeyen Taşıyıcı', shipmentCompanyId: 39, shipmentPackageStatus: 'Awaiting' }))
  assert.equal(unknown.marketplaceCarrier, null, 'shipmentCompanyId taşıyıcı TÜRETMEZ; Sürat varsayılanı YOK')
  assert.equal(unknown.rawCarrierName, 'Bilinmeyen Taşıyıcı')
  assert.equal(unknown.shipmentCompanyId, '39')
  assert.equal(unknown.rawMarketplaceStatus, 'Awaiting')
  assert.equal(unknown.operationStatus, null)

  // Sipariş tarihi UYDURULMAZ: Created yoksa lastModifiedDate KULLANILMAZ.
  const noCreated = source.normalizeN11Order(pkg(3, { packageHistories: [{ createdDate: NOW, status: 'Shipped' }] }))
  assert.equal(noCreated.orderDate, '')
  assert.notEqual(noCreated.lastModifiedDate, '')
})

/* ═══ F. NORMALİZASYON KAYBI GÖRÜNÜR ═══════════════════════════════════════ */

test('N11-NORM-1: kimliksiz / nesne olmayan kayıt SAYILIR; tekrar kayıp DEĞİL; null id sipariş no ile TEKİLLEŞTİRİLMEZ', () => {
  const keyless = pkg(9, { id: null, orderNumber: null })
  const nullIdA = pkg(5, { id: null, orderNumber: 'ORD-SAME' })
  const nullIdB = pkg(6, { id: null, orderNumber: 'ORD-SAME' })
  const result = source.normalizeN11Orders([pkg(1), pkg(1), keyless, 'garbage', null, nullIdA, nullIdB])
  assert.equal(result.duplicateRemovedCount, 1)
  assert.equal(result.invalidIdentityCount, 3)
  assert.equal(result.orders.length, 3, 'iki ayrı paketsiz kayıt GİZLENMEZ')
})

test('N11-NORM-2: kimliksiz kayıt imleci DURDURUR; saf tekrar DURDURMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const keyless = pkg(9, { id: null, orderNumber: null })
  const mixed = await syncWith(db, org, accountId, fakeTransport([pkg(1), keyless]), { liveWriteGate: ALLOW })
  assert.equal(mixed.body.invalidIdentity, 1)
  assert.equal(mixed.body.persisted.persisted, 1, 'geçerli kayıt yine yazılır')
  assert.equal(mixed.body.checkpointAdvanced, false)
  assert.equal(mixed.body.durabilityReasonCode, 'N11_RECORD_IDENTITY_MISSING')
  assert.equal(mixed.body.healthState, 'PARTIAL')
  assert.equal((await view(db, org, accountId)).health.lastSuccessfulSyncAt, null)

  const dupOnly = await syncWith(db, org, accountId, fakeTransport([pkg(1), pkg(1), pkg(2)]), { liveWriteGate: ALLOW })
  assert.equal(dupOnly.body.duplicates, 1)
  assert.equal(dupOnly.body.checkpointAdvanced, true)
  assert.equal(dupOnly.body.durabilityReasonCode, null)
})

/* ═══ G. KALICILAŞTIRMA ═══════════════════════════════════════════════════ */

test('N11-PERSIST-1: hesap kapsamlı; takip = cargoSenderNumber; barkod takipte YOK; tekrar idempotent; NULL hesap YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const dataset = [pkg(1), pkg(2)]
  const first = await syncWith(db, org, accountId, fakeTransport(dataset), { liveWriteGate: ALLOW })
  assert.equal(first.body.canonicalWrite, 'ALLOWED')
  assert.equal(first.body.persisted.persisted, 2)
  assert.equal(first.body.checkpointAdvanced, true)
  const rows = await db.select().from(schema.orders)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.marketplace, 'N11')
    assert.equal(row.marketplaceAccountId, accountId)
    assert.match(row.cargoTrackingNumber, /^TRK/, 'takip = cargoSenderNumber')
    assert.equal(row.cargoSenderNumber, null, 'n11 barkodu kanonik cargoSenderNumber kolonuna GİRMEZ')
    assert.notEqual(row.packageId, row.orderNumber)
    assert.equal(row.operationStatus, null, 'karşılama akışına GİRMEZ')
    assert.equal(row.orderDate.toISOString(), source.normalizeN11Order(dataset.find((p) => p.id === row.packageId)).orderDate)
  }
  assert.doesNotMatch(JSON.stringify(rows.map((row) => [row.cargoTrackingNumber, row.cargoTrackingLink])), /BC9/)
  const lines = await db.select().from(schema.orderLines)
  assert.equal(lines.length, 2)
  const again = await syncWith(db, org, accountId, fakeTransport(dataset), { liveWriteGate: ALLOW, now: () => NOW + HOUR })
  assert.equal(again.body.persisted.persisted, 0, 'imleçten sonra yeni hareket yok')
  const rerun = await persistence.persistN11Orders(db, { organizationId: org, marketplaceAccountId: accountId, orders: source.normalizeN11Orders(dataset).orders })
  assert.equal(rerun.inserted, 0)
  assert.equal(rerun.updated, 2)
  assert.equal((await db.select().from(schema.orders)).length, 2)
  assert.equal((await db.select().from(schema.orderLines)).length, 2)
  assert.equal((await db.select().from(schema.orders).where(isNull(schema.orders.marketplaceAccountId))).length, 0)
  await assert.rejects(persistence.persistN11Orders(db, { organizationId: org, marketplaceAccountId: '', orders: [] }), /account_scope_required/)
  const persistenceSource = readFileSync(join(here, 'connectors/n11/n11Persistence.ts'), 'utf8')
  assert.match(persistenceSource, /complete: false/)
  assert.match(persistenceSource, /requireMarketplaceAccount: true/)
  assert.doesNotMatch(persistenceSource, /complete: true/)
})

test('N11-PERSIST-2: yazılamaz (null id / Created yok), atlanan, başarısız ve sayım açığı imleci DURDURUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const nullId = await syncWith(db, org, accountId, fakeTransport([pkg(1), pkg(2, { id: null })]), { liveWriteGate: ALLOW })
  assert.equal(nullId.body.checkpointAdvanced, false)
  assert.equal(nullId.body.durabilityReasonCode, 'N11_RECORD_NOT_PERSISTABLE')
  assert.deepEqual(nullId.body.unpersistable, { NO_PACKAGE_ID: 1, NO_ORDER_DATE: 0 })
  const noDate = await syncWith(db, org, accountId, fakeTransport([pkg(3, { packageHistories: [] })]), { liveWriteGate: ALLOW })
  assert.equal(noDate.body.durabilityReasonCode, 'N11_RECORD_NOT_PERSISTABLE')
  assert.deepEqual(noDate.body.unpersistable, { NO_PACKAGE_ID: 0, NO_ORDER_DATE: 1 })

  const loaded = await connection.loadN11Account(db, { organizationId: org, marketplaceAccountId: accountId })
  const run = (persistCanonical) => sync.syncN11OrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: accountId, config: loaded.config,
    fromMs: NOW - DAY, upperBoundMs: NOW, liveWriteGate: ALLOW, persistCanonical,
  }, { transport: fakeTransport([pkg(1), pkg(2)]).transport, ...noSleep })
  const skipped = await run(async () => ({ persisted: 2, inserted: 2, updated: 0, failed: 0, skipped: { NO_ORDER_DATE: 1 } }))
  assert.equal(skipped.durabilityReasonCode, 'N11_PERSIST_SKIPPED')
  const failed = await run(async () => ({ persisted: 1, inserted: 1, updated: 0, failed: 1, skipped: {} }))
  assert.equal(failed.durabilityReasonCode, 'N11_PERSIST_INCOMPLETE')
  const short = await run(async () => ({ persisted: 1, inserted: 1, updated: 0, failed: 0, skipped: {} }))
  assert.equal(short.durabilityReasonCode, 'N11_PERSIST_INCOMPLETE', 'sayım kanıtı')
  const noProof = await run(async () => undefined)
  assert.equal(noProof.checkpointAdvanced, false)
  for (const result of [skipped, failed, short, noProof]) assert.equal(result.checkpointAdvanced, false)
  assert.equal((await view(db, org, accountId)).health.lastSuccessfulSyncAt, null)
  const clean = await run(async (orders) => ({ persisted: orders.length, inserted: orders.length, updated: 0, failed: 0, skipped: {} }))
  assert.equal(clean.checkpointAdvanced, true)
})

test('N11-PERSIST-3: kısmi okuma mevcut siparişleri ARŞİVLEMEZ, imleç ARTIK İLERLEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const big = Array.from({ length: 30 }, (_, i) => pkg(i))
  await syncWith(db, org, accountId, fakeTransport(big), { liveWriteGate: ALLOW })
  assert.equal((await db.select().from(schema.orders)).length, 30)
  const before = (await view(db, org, accountId)).health.lastSuccessfulSyncAt
  const flaky = fakeTransport(big, { respond: (call) => (call.status === 'Picking' ? { status: 503, headers: {}, bodyText: '' } : null) })
  const partial = await syncWith(db, org, accountId, flaky, { liveWriteGate: ALLOW, now: () => NOW + 2 * HOUR })
  assert.equal(partial.body.outcome, 'PARTIAL')
  assert.equal(partial.body.checkpointAdvanced, false)
  assert.equal(partial.body.healthState, 'PARTIAL')
  const after = await db.select().from(schema.orders)
  assert.equal(after.length, 30)
  assert.equal(after.filter((row) => row.archivedAt !== null).length, 0)
  assert.equal((await view(db, org, accountId)).health.lastSuccessfulSyncAt, before)
})

/* ═══ H. YAYIN KAPISI ═════════════════════════════════════════════════════ */

test('N11-GATE-1: gerçek yayın internal_test → okuma çalışır, kanonik tablolar BOŞ, imleç İLERLEMEZ, sağlık dürüst', async (t) => {
  assert.equal(catalog.resolveRolloutStage('n11'), 'internal_test')
  assert.equal(gate.canPersistCanonicalOrders('n11').decision, 'BLOCKED_BY_ROLLOUT')
  assert.ok(catalog.HEALTH_SUPPORTED_PROVIDERS.includes('n11'))
  const descriptor = catalog.buildProviderCatalog().get('n11')
  assert.equal(descriptor.capabilities.find((c) => c.capability === 'orders.read').stage, 'internal_test')
  assert.equal(descriptor.capabilities.find((c) => c.capability === 'orders.status.write').supported, false)
  assert.equal(descriptor.capabilities.some((c) => c.capability === 'orders.webhook'), false, 'webhook UYDURULMAZ')

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  const result = await syncWith(db, org, accountId, fakeTransport([pkg(1), pkg(2)]))
  assert.equal(result.body.outcome, 'SUCCESS')
  assert.equal(result.body.canonicalWrite, 'BLOCKED_BY_ROLLOUT')
  assert.equal(result.body.fetched, 2)
  assert.equal(result.body.checkpointAdvanced, false)
  assert.equal(result.body.moreRemaining, true, 'yedek aralık dürüstçe KALIR')
  assert.match(result.body.note, /İç test/)
  for (const table of [schema.orders, schema.orderLines, schema.shipments, schema.labelJobs]) {
    assert.equal((await db.select().from(table)).length, 0, 'canlı iş tablosu BOŞ')
  }
  assert.equal(result.body.healthState, 'OK')
  assert.match(result.body.healthLabel, /iç test: kayıtlar sisteme yazılmadı, imleç ilerlemedi/)
  const health1 = (await view(db, org, accountId)).health
  assert.equal(health1.lastSuccessfulSyncAt, null)
  assert.equal(health1.reasonCode, 'N11_CANONICAL_WRITE_BLOCKED')

  // Kapı açılınca ilk koşu İLK geriye bakıştan okur ve yazar.
  const later = NOW + 3 * HOUR
  const allowed = fakeTransport([pkg(1), pkg(2)])
  const opened = await syncWith(db, org, accountId, allowed, { liveWriteGate: ALLOW, now: () => later })
  assert.equal(Math.min(...allowed.calls.map((call) => call.startDate)), later - sync.N11_INITIAL_LOOKBACK_MS - sync.N11_BOUNDARY_OVERLAP_MS)
  assert.equal(opened.body.checkpointAdvanced, true)
  assert.equal((await db.select().from(schema.orders)).length, 2)
})

/* ═══ I. KİRACI / HESAP / SATICI İZOLASYONU ════════════════════════════════ */

test('N11-ISO-1: yabancı kiracı hesabı 404 ve n11 çağrısı 0; kardeş hesap izolasyonu', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const a1 = await connectAccount(db, orgA)
  const a2 = await connectAccount(db, orgA, { appKey: 'second-key-777' })
  const b1 = await connectAccount(db, orgB)
  assert.notEqual(a1, b1, 'aynı appKey farklı kiracıda AYRI hesap')
  const fake = fakeTransport([pkg(1)])
  for (const handler of [handlers.handleN11Sync, handlers.handleN11Test, handlers.handleN11Disconnect]) {
    const result = await handler({ db, organizationId: orgB, body: { marketplaceAccountId: a1 }, clientOptions: { transport: fake.transport, ...noSleep }, now: () => NOW })
    assert.equal(result.status, 404)
    assert.equal(result.body.code, 'N11_ACCOUNT_NOT_FOUND')
  }
  assert.equal(fake.calls.length, 0, 'yabancı hesapta n11 çağrısı 0')
  assert.equal((await connection.connectN11Account(db, { organizationId: orgB, marketplaceAccountId: a1, appSecret: 'x' })).ok, false)
  assert.equal((await view(db, orgA, a1)).isActive, true)

  await syncWith(db, orgA, a1, fakeTransport([pkg(1)]), { liveWriteGate: ALLOW })
  await syncWith(db, orgA, a2, fakeTransport([pkg(50, { sellerId: 111 })]), { liveWriteGate: ALLOW })
  const rows = await db.select().from(schema.orders)
  assert.deepEqual(rows.map((row) => row.marketplaceAccountId).sort(), [a1, a2].sort())
  assert.equal((await view(db, orgA, a1)).config.sellerId, '9876543')
  assert.equal((await view(db, orgA, a2)).config.sellerId, '111')
  assert.equal((await connection.listN11Accounts(db, orgB)).length, 1)
})

test('N11-ISO-2: satıcı bağlanır; farklı satıcı yazılmaz; aynı satıcı ikinci hesapta ÇAKIŞMA', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  await syncWith(db, org, accountId, fakeTransport([pkg(1)]), { liveWriteGate: ALLOW })
  assert.equal((await view(db, org, accountId)).config.sellerId, '9876543')
  // İkinci koşu imleçten (NOW) başlar; yabancı satıcı paketi o pencerede.
  const foreign = await syncWith(db, org, accountId, fakeTransport([pkg(2, { sellerId: 555, lastModifiedDate: NOW + 30 * 60_000 })]), { liveWriteGate: ALLOW, now: () => NOW + HOUR })
  assert.equal(foreign.body.sellerMismatch, 1)
  assert.equal(foreign.body.durabilityReasonCode, 'N11_SELLER_MISMATCH')
  assert.equal(foreign.body.checkpointAdvanced, false)
  assert.equal((await db.select().from(schema.orders)).length, 1, 'yabancı satıcı kaydı YAZILMAZ')

  const second = await connectAccount(db, org, { appKey: 'same-seller-other-key' })
  const dup = await syncWith(db, org, second, fakeTransport([pkg(3)]), { liveWriteGate: ALLOW })
  assert.equal(dup.body.durabilityReasonCode, 'N11_SELLER_ALREADY_CONNECTED')
  assert.equal(dup.body.checkpointAdvanced, false)
  assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.marketplaceAccountId, second))).length, 0, 'mükerrer YAZILMAZ')
  assert.equal((await view(db, org, second)).config.sellerId, null, 'çakışan satıcı BAĞLANMAZ')
})

/* ═══ TEK UÇUŞ + SAĞLIK ═══════════════════════════════════════════════════ */

test('N11-FLIGHT-1: aynı hesapta eşzamanlı işlem REDDEDİLİR; uçuş hata dahil HER yolda düşer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const accountId = await connectAccount(db, org)
  let release
  const gateOpen = new Promise((resolve) => { release = resolve })
  const slow = { transport: async (request) => { await gateOpen; return fakeTransport([pkg(1)]).transport(request) } }
  const first = handlers.handleN11Sync({ db, organizationId: org, body: { marketplaceAccountId: accountId }, clientOptions: { ...slow, ...noSleep }, now: () => NOW })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = await handlers.handleN11Test({ db, organizationId: org, body: { marketplaceAccountId: accountId }, clientOptions: { ...slow, ...noSleep }, now: () => NOW })
  assert.equal(second.status, 409)
  assert.equal(second.body.code, 'N11_SYNC_IN_PROGRESS')
  release()
  assert.equal((await first).status, 200)
  assert.equal(handlers.n11InFlightCount(), 0)
  await assert.rejects(syncWith(db, org, accountId, fakeTransport([pkg(1)]), { liveWriteGate: () => { throw new Error('boom') } }))
  assert.equal(handlers.n11InFlightCount(), 0, 'hata yolunda da bırakıldı')
})

test('N11-HEALTH-1: kararlı durum sözlüğü', () => {
  const resolve = (syncState, over = {}) => health.resolveN11Health({ credentialsComplete: true, syncState, ...over }).state
  assert.equal(resolve(null), 'NEVER_RUN')
  assert.equal(resolve({ lastSyncStatus: 'success' }), 'OK')
  assert.equal(resolve({ lastSyncStatus: 'partial', lastErrorCode: 'N11_CANONICAL_WRITE_BLOCKED' }), 'OK')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'N11_HTTP_401' }), 'AUTH_ERROR')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'N11_HTTP_429' }), 'RATE_LIMITED')
  assert.equal(resolve({ lastSyncStatus: 'partial', lastErrorCode: 'N11_HTTP_429' }), 'RATE_LIMITED')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'N11_RESPONSE_SHAPE_UNVERIFIED' }), 'RESPONSE_SHAPE_UNVERIFIED')
  assert.equal(resolve({ lastSyncStatus: 'failed', lastErrorCode: 'N11_HTTP_503' }), 'PROVIDER_UNAVAILABLE')
  assert.equal(resolve({ lastSyncStatus: 'partial', lastErrorCode: 'N11_RECORD_IDENTITY_MISSING' }), 'PARTIAL')
  assert.equal(resolve(null, { credentialsComplete: false }), 'AUTH_ERROR')
  assert.deepEqual([...health.N11_HEALTH_STATES].sort(), ['AUTH_ERROR', 'NEVER_RUN', 'OK', 'PARTIAL', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'RESPONSE_SHAPE_UNVERIFIED'])
})

test('N11-DURABLE-1: saf imleç kararı — her eksiklik kendi kararlı koduyla durdurur', () => {
  const base = {
    windowCompleted: true, sellerConflict: false, sellerMismatchCount: 0, invalidIdentityCount: 0, unpersistableCount: 0,
    gateAllowed: true, hasPersister: true, expectedCanonical: 2,
    persist: { persisted: 2, failed: 0, skippedTotal: 0, resultMissing: false },
  }
  const decide = (over) => sync.resolveN11CheckpointDurability({ ...base, ...over })
  assert.deepEqual(decide({}), { durable: true, reasonCode: null })
  assert.equal(decide({ windowCompleted: false }).reasonCode, 'N11_PERSIST_INCOMPLETE')
  assert.equal(decide({ sellerConflict: true }).reasonCode, 'N11_SELLER_ALREADY_CONNECTED')
  assert.equal(decide({ sellerMismatchCount: 1 }).reasonCode, 'N11_SELLER_MISMATCH')
  assert.equal(decide({ invalidIdentityCount: 1, expectedCanonical: 0, persist: null }).reasonCode, 'N11_RECORD_IDENTITY_MISSING', 'yalnız kimliksiz kayıt BOŞ pencere değildir')
  assert.equal(decide({ unpersistableCount: 1 }).reasonCode, 'N11_RECORD_NOT_PERSISTABLE')
  assert.equal(decide({ gateAllowed: false }).reasonCode, 'N11_CANONICAL_WRITE_BLOCKED')
  assert.equal(decide({ hasPersister: false, persist: null }).reasonCode, 'N11_CANONICAL_WRITE_BLOCKED')
  assert.equal(decide({ persist: null }).reasonCode, 'N11_PERSIST_INCOMPLETE')
  assert.equal(decide({ persist: { ...base.persist, resultMissing: true } }).reasonCode, 'N11_PERSIST_INCOMPLETE')
  assert.equal(decide({ persist: { ...base.persist, skippedTotal: 1 } }).reasonCode, 'N11_PERSIST_SKIPPED')
  assert.equal(decide({ persist: { ...base.persist, failed: 1 } }).reasonCode, 'N11_PERSIST_INCOMPLETE')
  assert.equal(decide({ persist: { ...base.persist, persisted: 1 } }).reasonCode, 'N11_PERSIST_INCOMPLETE')
  assert.deepEqual(decide({ expectedCanonical: 0, persist: null }), { durable: true, reasonCode: null }, 'gerçekten boş pencere')
})

/* ═══ K. ROTALAR + GÜVENLİK ═══════════════════════════════════════════════ */

test('N11-SAFETY-1: rotalar AÇIK ve tenant auth arkasında; zamanlayıcı/Sürat/etiket/yazma YOK', () => {
  const dir = join(here, 'connectors/n11')
  const sources = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n')
  assert.doesNotMatch(sources, /surat|createSuratShipment|labelJob|requestLabelJobCycle|enqueueAutoLabel/i)
  assert.doesNotMatch(sources, /setInterval\(/, 'otomatik zamanlayıcı YOK')
  assert.doesNotMatch(sources, /complete: true/)
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(index, /'\/api\/integrations\/n11',/)
  assert.doesNotMatch(index, /startN11[A-Za-z]*OnBoot/)
  const routes = [...index.matchAll(/^app\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm)]
    .map((match) => ({ route: `${match[1].toUpperCase()} ${match[2]}`, index: match.index }))
  const n11Routes = routes
    .map((entry, i) => ({ ...entry, body: index.slice(entry.index, routes[i + 1]?.index ?? index.length) }))
    .filter((entry) => entry.route.includes('/api/integrations/n11'))
  assert.deepEqual(n11Routes.map((entry) => entry.route), [
    'GET /api/integrations/n11/accounts',
    'POST /api/integrations/n11/accounts',
    'POST /api/integrations/n11/accounts/disconnect',
    'POST /api/integrations/n11/accounts/test',
    'POST /api/integrations/n11/accounts/sync',
  ])
  for (const entry of n11Routes) assert.match(entry.body, /requireOnboardingContext\(/, entry.route)
})
