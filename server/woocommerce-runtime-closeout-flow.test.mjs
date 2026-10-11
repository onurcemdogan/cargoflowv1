// WOOCOMMERCE-001 ÇALIŞMA ZAMANI KAPANIŞI — KABUL PAKETİ.
//
// ═══ NEDEN BU PAKET VAR ══════════════════════════════════════════════════
//
// Üç eksik ÖLÇÜLDÜ ve yamadan ÖNCE yeniden üretildi:
//
//   1) SAĞLIK UCU hesap kapsamlı kimlik varlığını BAĞLAMIYORDU. Ölçüm TERS
//      çıktı: kimliği DURAN mağaza "kurulmadı", kimliği SİLİNEN mağaza
//      (geçmiş senkron kanıtıyla) "bağlı" görünüyordu.
//   2) DAYANIKLI GELEN KUTUSUNUN TÜKETİCİSİ YOKTU: kabul edilen teslim
//      `RECEIVED` olarak sonsuza kadar duruyordu.
//   3) WOO DISCONNECT SAĞLAYICI KAPSAMSIZDI: aynı organizasyonun TRENDYOL
//      hesap id'si verildiğinde o hesabı PASİFLEŞTİRİYORDU.
//
// ═══ GERÇEK UÇ YOLU ══════════════════════════════════════════════════════
//
// Bu paket depo yardımcılarını TEK BAŞINA test ETMEZ. Üretim uç davranışı
// (durum kodu eşlemesi dahil) artık modüllerdedir ve BURADA GERÇEK bir HTTP
// sunucusuna bağlanıp GERÇEK isteklerle sürülür — `express.raw` üretimdeki
// gibi JSON ayrıştırıcıdan ÖNCE bağlanır.
//
// KAPSAM DIŞI (dürüstlük): kiracı oturum/auth ara katmanı burada
// ÇALIŞTIRILMAZ; kiracı kimliği test kancasından verilir. Kanıtlanan şey
// UÇ DAVRANIŞIDIR, oturum doğrulaması değil. `index.mjs`in bu modüllere
// DEVRETTİĞİ kaynak taramasıyla ayrıca kilitlenir.
//
// HERMETİK: gerçek bir WooCommerce mağazasına İSTEK ATILMAZ; taşıma ve ad
// çözümleyici enjekte edilir, veritabanı GERÇEK Postgres'tir (PGlite).
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const healthService = await import('./connectors/integrationHealthService.ts')
const wooHandlers = await import('./connectors/woocommerce/wooHttpHandlers.ts')
const wooConnection = await import('./connectors/woocommerce/wooConnectionService.ts')
const wooWorker = await import('./connectors/woocommerce/wooWebhookWorker.ts')
const wooClient = await import('./connectors/woocommerce/wooClient.ts')
const inbox = await import('./connectors/webhookInbox.ts')
const credentialStore = await import('./connectors/connectorCredentialStore.ts')
const accountsRepo = await import('./integrations/marketplaceAccountRepository.ts')
const onboarding = await import('./onboarding/onboardingRepository.ts')
const liveGate = await import('./connectors/liveWriteGate.ts')

/**
 * Kaynak taramadan ÖNCE yorumları siler.
 *
 * SATIR yorumları ÖNCE silinir: bir satır yorumundaki `/*` dizisi blok-yorum
 * silicisini yanlış yerden başlatıp import bloğunu YUTAR.
 */
function stripComments(source) {
  return source
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

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

async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

/** Herkese açık adrese çözen sahte DNS. */
const publicResolver = async () => [{ address: '93.184.216.34' }]

const okResponse = (body, headers = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  bodyText: JSON.stringify(body),
})

/** Sağlayıcıya HİÇ gitmeyen taşıma. */
function makeTransport(response) {
  return async () => response
}

/** GERÇEK bağlantı servisi ile mağaza bağlar (kimlik KALICILAŞIR). */
async function connectStore(db, organizationId, storeUrl, secrets = {}) {
  const result = await wooConnection.connectWooStore(
    db,
    {
      organizationId,
      storeUrl,
      consumerKey: secrets.consumerKey ?? 'ck_live_abcd1234',
      consumerSecret: secrets.consumerSecret ?? 'cs_live_zzzz9999',
      webhookSecret: secrets.webhookSecret ?? 'wh-secret',
    },
    {
      transport: makeTransport(
        okResponse([], { 'x-wp-total': '0', 'x-wp-totalpages': '1' }),
      ),
      resolver: publicResolver,
    },
  )
  assert.equal(result.outcome, 'CONNECTED', 'mağaza bağlanmalıydı')
  return result.account.id
}

const wooOrderFixture = (overrides = {}) => ({
  id: 5150,
  number: 'WC-5150',
  status: 'processing',
  date_created: '2026-09-18T13:20:30',
  date_created_gmt: '2026-09-18T10:20:30',
  date_modified_gmt: '2026-09-19T08:00:00',
  currency: 'TRY',
  total: '119.90',
  billing: {
    first_name: 'Ayşe',
    last_name: 'Yılmaz',
    email: 'a@example.com',
    phone: '05551112233',
    address_1: 'Örnek Sk. 1',
    city: 'İstanbul',
    country: 'TR',
  },
  shipping: {
    first_name: 'Ayşe',
    last_name: 'Yılmaz',
    address_1: 'Örnek Sk. 1',
    city: 'İstanbul',
    country: 'TR',
  },
  line_items: [
    { id: 1, product_id: 77, variation_id: 0, name: 'Ürün', quantity: 1, total: '119.90' },
  ],
  ...overrides,
})

function signedDelivery(secret, body, { topic = 'order.updated', deliveryId = 'D-1' } = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-wc-webhook-topic': topic,
      'x-wc-webhook-delivery-id': deliveryId,
      'x-wc-webhook-signature': createHmac('sha256', secret).update(raw).digest('base64'),
    },
  }
}

/**
 * GERÇEK HTTP YÜZEYİ.
 *
 * Üretimdeki bağlama SIRASI korunur: ham gövde ara katmanı JSON
 * ayrıştırıcıdan ÖNCE gelir — aksi halde imza baytları KAYBOLURDU.
 */
async function startApi(db) {
  const app = express()
  app.use('/api/webhooks/woocommerce', express.raw({ type: '*/*', limit: '5mb' }))
  app.use(express.json())

  app.get('/api/integrations/health', async (request, response) => {
    const result = await healthService.handleIntegrationHealthRequest({
      db,
      organizationId: String(request.header('x-test-organization') ?? ''),
    })
    response.status(result.httpStatus).json(result.body)
  })

  app.post(
    '/api/webhooks/woocommerce/:organizationId/:marketplaceAccountId',
    async (request, response) => {
      try {
        const result = await wooHandlers.handleWooWebhookDelivery({
          db,
          organizationId: request.params.organizationId,
          marketplaceAccountId: request.params.marketplaceAccountId,
          rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          headers: request.headers,
        })
        response.status(result.httpStatus).json(result.body)
      } catch {
        // Üretimdeki ile aynı: BAŞARI İDDİA EDİLMEZ.
        response.status(503).json({ ok: false, outcome: 'NOT_DURABLE' })
      }
    },
  )

  app.post('/api/integrations/woocommerce/stores/disconnect', async (request, response) => {
    const result = await wooHandlers.handleWooDisconnect({
      db,
      organizationId: String(request.header('x-test-organization') ?? ''),
      marketplaceAccountId: String(request.body?.marketplaceAccountId ?? ''),
    })
    response.status(result.httpStatus).json(result.body)
  })

  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base, close: () => new Promise((resolve) => server.close(resolve)) }
}

const healthOf = (payload, accountId) =>
  payload.integrations.find((entry) => entry.marketplaceAccountId === accountId)

/* ═══════════════════════════════════════════════════════════════════════
   1) SAĞLIK UCU — HESAP KAPSAMLI KİMLİK GERÇEĞİ
   ═══════════════════════════════════════════════════════════════════════ */

test('WOO-CLOSE-H1: GERÇEK sağlık ucu Woo hesabını ve kimlik varlığını bildirir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-h1')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')

  const api = await startApi(db)
  t.after(() => api.close())
  const payload = await (
    await fetch(`${api.base}/api/integrations/health`, {
      headers: { 'x-test-organization': org },
    })
  ).json()

  assert.equal(payload.ok, true)
  const entry = healthOf(payload, accountId)
  assert.ok(entry, 'GERÇEK hesap kimliği sağlık yanıtında olmalı')
  assert.equal(entry.providerKey, 'woocommerce')
  assert.equal(entry.connectionScope, 'account')
  // Kimlik VARLIĞI uca ULAŞTI: yoksa bağlantı NOT_CONFIGURED olurdu.
  assert.equal(entry.connection, 'CONNECTED')
  assert.ok(
    !entry.attentionReasonCodes.includes('CREDENTIALS_ABSENT'),
    'kimliği duran mağaza "kaldırılmış" gösterilemez',
  )
  // AYIRT EDİCİ: `CREDENTIALS_NOT_PROVEN` YALNIZ varlık PRESENT iken üretilir.
  // Bağlantı kurulmasaydı bu kod HİÇ görünmezdi.
  assert.ok(
    entry.attentionReasonCodes.includes('CREDENTIALS_NOT_PROVEN'),
    'varlık PRESENT olarak çözümleyiciye ulaşmalı',
  )
  // Kimlik VAR ama henüz KANITLANMADI: varlık ≠ geçerlilik (001B semantiği).
  const entries = await healthService.loadIntegrationHealthForOrganization(db, {
    organizationId: org,
    nowMs: Date.now(),
  })
  const resolved = entries.find((item) => item.marketplaceAccountId === accountId)
  assert.equal(resolved.credentials, 'UNKNOWN')
  assert.equal(resolved.sync, 'NEVER_RUN')
})

test('WOO-CLOSE-H2: iki mağaza — A PRESENT, B ABSENT; KARDEŞ SIZINTISI YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-h2')
  const accountA = await connectStore(db, org, 'https://shop-a.example.com')
  const accountB = await connectStore(db, org, 'https://shop-b.example.com')

  // B'nin kimliği KALDIRILDI (hesap ve iş verisi DURUYOR).
  await credentialStore.deleteConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: accountB,
    providerKey: 'woocommerce',
  })

  const api = await startApi(db)
  t.after(() => api.close())
  const payload = await (
    await fetch(`${api.base}/api/integrations/health`, {
      headers: { 'x-test-organization': org },
    })
  ).json()

  const a = healthOf(payload, accountA)
  const b = healthOf(payload, accountB)
  assert.ok(a && b, 'iki mağaza da AYRI kayıt üretmeli')
  assert.equal(a.connection, 'CONNECTED')
  assert.ok(!a.attentionReasonCodes.includes('CREDENTIALS_ABSENT'))
  // B: kardeşinin kimliği duruyor diye "bağlı" GÖRÜNEMEZ.
  assert.equal(b.connection, 'NOT_CONFIGURED')
  assert.ok(b.attentionReasonCodes.includes('CREDENTIALS_ABSENT'))
  assert.notEqual(a.connectionKey, b.connectionKey)
})

test('WOO-CLOSE-H3: GEÇMİŞ başarılı senkron, SİLİNMİŞ kimliği DİRİLTMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-h3')
  const accountB = await connectStore(db, org, 'https://shop-b.example.com')

  // B GEÇMİŞTE başarıyla senkron etti.
  await onboarding.recordSyncState(db, org, {
    provider: 'woocommerce',
    resource: 'orders',
    status: 'success',
    marketplaceAccountId: accountB,
    fetchedCount: 12,
  })
  // ...sonra kimliği KALDIRILDI.
  await credentialStore.deleteConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: accountB,
    providerKey: 'woocommerce',
  })

  const api = await startApi(db)
  t.after(() => api.close())
  const payload = await (
    await fetch(`${api.base}/api/integrations/health`, {
      headers: { 'x-test-organization': org },
    })
  ).json()
  const entry = healthOf(payload, accountB)
  // AÇIK YOKLUK, GEÇMİŞ KANITI EZER.
  assert.equal(entry.connection, 'NOT_CONFIGURED')
  assert.ok(entry.attentionReasonCodes.includes('CREDENTIALS_ABSENT'))

  const entries = await healthService.loadIntegrationHealthForOrganization(db, {
    organizationId: org,
    nowMs: Date.now(),
  })
  const resolved = entries.find((item) => item.marketplaceAccountId === accountB)
  assert.notEqual(resolved.credentials, 'VALID', 'silinmiş kimlik GEÇERLİ sayılamaz')
})

test('WOO-CLOSE-WIRE-1: ÜRÜN UCU varlık haritasını KENDİ kurmaz', () => {
  const source = stripComments(readFileSync(join(here, 'index.mjs'), 'utf8'))
  assert.ok(
    source.includes('handleIntegrationHealthRequest'),
    'sağlık ucu servise DEVRETMELİ',
  )
  // İKİNCİ GERÇEK YOK: uç kendi varlık haritasını kurarsa depo testleri
  // yeşilken ürün yine yalan söyleyebilir.
  assert.ok(
    !source.includes('credentialsPresenceByProvider'),
    'uç KENDİ kimlik varlığı haritasını kurmamalı',
  )
  assert.ok(
    !source.includes('credentialsPresenceByConnection'),
    'uç KENDİ bağlantı varlığı haritasını kurmamalı',
  )
})

test('WOO-CLOSE-WIRE-2: varlık için SIR ÇÖZÜLMEZ', () => {
  const source = stripComments(
    readFileSync(join(here, 'connectors', 'integrationHealthService.ts'), 'utf8'),
  )
  assert.ok(
    !source.includes('decryptCredentialPayload'),
    'varlık sorusu için AES zarfı AÇILMAMALI',
  )
  assert.ok(source.includes('listAccountsWithCredential'))
})

/* ═══════════════════════════════════════════════════════════════════════
   2) DAYANIKLI GELEN KUTUSU — ÇALIŞMA ZAMANI TÜKETİCİSİ
   ═══════════════════════════════════════════════════════════════════════ */

async function acceptDelivery(api, org, accountId, delivery) {
  return fetch(`${api.base}/api/webhooks/woocommerce/${org}/${accountId}`, {
    method: 'POST',
    headers: delivery.headers,
    body: delivery.raw,
  })
}

test('WOO-CLOSE-W1: 2xx ÖNCESİ dayanıklı RECEIVED satırı vardır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w1')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  const delivery = signedDelivery('wh-secret', wooOrderFixture())
  const response = await acceptDelivery(api, org, accountId, delivery)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).outcome, 'ACCEPTED')

  const rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'RECEIVED')
  assert.equal(rows[0].deliveryId, 'D-1')
  assert.ok(rows[0].verifiedAt instanceof Date)

  // SIRA KANITI: kalıcı yazım DÜŞERSE 2xx DÖNMEZ.
  const failingDb = {
    ...db,
    insert: () => {
      throw new Error('kalıcı yazım düştü')
    },
  }
  const failingApi = await startApi(failingDb)
  t.after(() => failingApi.close())
  const second = signedDelivery('wh-secret', wooOrderFixture(), { deliveryId: 'D-2' })
  const failed = await acceptDelivery(failingApi, org, accountId, second)
  assert.ok(failed.status >= 500, 'yazılamayan teslime BAŞARI DENMEZ')
})

test('WOO-CLOSE-W2: çalışma zamanı tüketicisi KALICI satırı okur ve işler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w2')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  await acceptDelivery(api, org, accountId, signedDelivery('wh-secret', wooOrderFixture()))

  const report = await wooWorker.runWooInboxCycle(db)
  assert.equal(report.due, 1)
  assert.equal(report.claimed, 1)
  assert.equal(report.processed, 1)

  const rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].status, 'PROCESSED')
  assert.equal(rows[0].attemptCount, 1, 'tek işleme denemesi sayacı TEK artırmalı')
  assert.ok(rows[0].processedAt instanceof Date)
})

test('WOO-CLOSE-W3: YENİDEN BAŞLATMA — önceden yazılmış RECEIVED satırı bulunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w3')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')

  // "Önceki süreç" teslimi kabul etti ve öldü: bellekte HİÇBİR şey yok.
  const raw = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')
  const accepted = await inbox.acceptVerifiedDelivery(db, {
    organizationId: org,
    marketplaceAccountId: accountId,
    providerKey: 'woocommerce',
    deliveryId: 'D-RESTART',
    topic: 'order.updated',
    rawBody: raw,
  })
  assert.equal(accepted.durable, true)
  assert.equal(accepted.record.status, 'RECEIVED')

  // YENİ süreç: yalnız veritabanına bakar.
  const report = await wooWorker.runWooInboxCycle(db)
  assert.equal(report.processed, 1)
  const rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].status, 'PROCESSED')
})

test('WOO-CLOSE-W4: RETRYABLE kayıt GERİ ÇEKİLMEYLE tekrar denenir, sayaç ilerler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w4')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  // İmzası GEÇERLİ ama gövdesi BOZUK: kabul edilir, işleme düşer.
  const broken = Buffer.from('{ bu json degil', 'utf8')
  await acceptDelivery(api, org, accountId, signedDelivery('wh-secret', broken))

  const t0 = Date.now()
  const first = await wooWorker.runWooInboxCycle(db, { nowMs: t0 })
  assert.equal(first.retryable, 1)
  let rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].status, 'RETRYABLE')
  assert.equal(rows[0].attemptCount, 1)
  assert.equal(rows[0].errorCode, 'MALFORMED_JSON')

  // SIKI DÖNGÜ YOK: geri çekilme dolmadan kayıt SEÇİLMEZ.
  const tooSoon = await wooWorker.runWooInboxCycle(db, { nowMs: t0 + 1_000 })
  assert.equal(tooSoon.due, 0)
  rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].attemptCount, 1, 'geri çekilme sırasında sayaç İLERLEMEZ')

  // Süre dolunca İÇERİDE tekrar denenir (sağlayıcıdan yeni teslim GEREKMEZ).
  const later = await wooWorker.runWooInboxCycle(db, {
    nowMs: t0 + inbox.DEFAULT_INBOX_RETRY_POLICY.retryBaseMs + 1_000,
  })
  assert.equal(later.claimed, 1)
  rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].attemptCount, 2)
})

test('WOO-CLOSE-BACKOFF-1: tekrar bütçesi SINIRLIDIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-backoff')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const raw = Buffer.from('{ bozuk', 'utf8')
  const accepted = await inbox.acceptVerifiedDelivery(db, {
    organizationId: org,
    marketplaceAccountId: accountId,
    providerKey: 'woocommerce',
    deliveryId: 'D-BUDGET',
    topic: 'order.updated',
    rawBody: raw,
  })

  const policy = inbox.DEFAULT_INBOX_RETRY_POLICY
  let now = Date.now()
  for (let i = 0; i < policy.maxAttempts; i += 1) {
    const report = await wooWorker.runWooInboxCycle(db, { nowMs: now })
    assert.equal(report.claimed, 1, `deneme ${i + 1} çalışmalıydı`)
    now += policy.retryCapMs + 1_000
  }
  const rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].attemptCount, policy.maxAttempts)
  // BÜTÇE BİTTİ: kayıt DURUR ama bir daha SEÇİLMEZ (sonsuz döngü yok).
  const exhausted = await wooWorker.runWooInboxCycle(db, { nowMs: now })
  assert.equal(exhausted.due, 0)
  assert.equal(accepted.record.deliveryId, 'D-BUDGET')
  // Geri çekilme ÜSTEL ve TAVANLI.
  assert.equal(inbox.nextRetryDelayMs(1), policy.retryBaseMs)
  assert.equal(inbox.nextRetryDelayMs(2), policy.retryBaseMs * 2)
  assert.equal(inbox.nextRetryDelayMs(99), policy.retryCapMs)
})

test('WOO-CLOSE-W5: TEKRAR EDEN teslim İKİNCİ KEZ İŞLENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w5')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  const delivery = signedDelivery('wh-secret', wooOrderFixture())
  const first = await acceptDelivery(api, org, accountId, delivery)
  const second = await acceptDelivery(api, org, accountId, delivery)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal((await second.json()).outcome, 'DUPLICATE')

  const rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows.length, 1, 'aynı teslim İKİNCİ SATIR AÇMAZ')

  const cycle1 = await wooWorker.runWooInboxCycle(db)
  assert.equal(cycle1.processed, 1)
  const cycle2 = await wooWorker.runWooInboxCycle(db)
  assert.equal(cycle2.due, 0, 'işlenmiş teslim YENİDEN seçilmez')
  assert.equal(cycle2.processed, 0)
  const after = await inbox.listInbox(db, { organizationId: org })
  assert.equal(after[0].attemptCount, 1, 'tek işleme yürütmesi')
})

test('WOO-CLOSE-CLAIM-1: SAHİPLENME atomiktir — iki tüketici aynı satırı işleyemez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-claim')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const accepted = await inbox.acceptVerifiedDelivery(db, {
    organizationId: org,
    marketplaceAccountId: accountId,
    providerKey: 'woocommerce',
    deliveryId: 'D-CLAIM',
    topic: 'order.updated',
    rawBody: Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8'),
  })
  const claim = {
    organizationId: org,
    inboxId: accepted.record.id,
    expectedStatus: 'RECEIVED',
    expectedAttemptCount: 0,
  }
  const won = await inbox.claimInboxDelivery(db, claim)
  const lost = await inbox.claimInboxDelivery(db, claim)
  assert.ok(won, 'ilk tüketici sahiplenmeli')
  assert.equal(lost, null, 'ikinci tüketici AYNI satırı sahiplenememeli')

  // KİRACI SINIRI: başka org aynı satırı sahiplenemez.
  const otherOrg = await makeOrg(db, 'close-claim-other')
  const foreign = await inbox.claimInboxDelivery(db, {
    ...claim,
    organizationId: otherOrg,
    expectedAttemptCount: 1,
  })
  assert.equal(foreign, null)
})

test('WOO-CLOSE-W6: internal_test — NORMALLEŞTİRİLİR ama KANONİK YAZIM YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w6')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  await acceptDelivery(api, org, accountId, signedDelivery('wh-secret', wooOrderFixture()))

  let persistCalls = 0
  const report = await wooWorker.runWooInboxCycle(db, {
    // Kapı AÇIK OLSAYDI çağrılacak yazıcı; kapı KAPALI olduğu için ÇAĞRILMAZ.
    persistCanonical: async () => {
      persistCalls += 1
    },
  })
  assert.equal(report.processed, 1, 'teslim işlenir')
  assert.equal(report.canonicalPersisted, 0, 'kanonik yazım OLMAZ')
  assert.equal(persistCalls, 0, 'kanonik yazıcı HİÇ çağrılmaz')

  // KAPI SAĞLAYICI ADINA DEĞİL AŞAMAYA bakar.
  const gate = liveGate.canPersistCanonicalOrders('woocommerce')
  assert.notEqual(gate.decision, 'ALLOWED')

  // Sipariş tablosuna HİÇBİR ŞEY yazılmadı.
  const orders = await db.select().from(schema.orders)
  assert.equal(orders.length, 0)
})

test('WOO-CLOSE-W7: DESTEKLENMEYEN konu IGNORED kalır ve TEKRAR TEKRAR işlenmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w7')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  const delivery = signedDelivery('wh-secret', { id: 9 }, {
    topic: 'product.updated',
    deliveryId: 'D-TOPIC',
  })
  const response = await acceptDelivery(api, org, accountId, delivery)
  assert.equal(response.status, 200)

  let rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].status, 'IGNORED')

  for (const nowMs of [Date.now(), Date.now() + 86_400_000]) {
    const report = await wooWorker.runWooInboxCycle(db, { nowMs })
    assert.equal(report.due, 0, 'IGNORED kayıt ASLA seçilmez')
  }
  rows = await inbox.listInbox(db, { organizationId: org })
  assert.equal(rows[0].attemptCount, 0)
})

test('WOO-CLOSE-W8: BOZUK bir kayıt KARDEŞLERİ durdurmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w8')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')

  const broken = await inbox.acceptVerifiedDelivery(db, {
    organizationId: org,
    marketplaceAccountId: accountId,
    providerKey: 'woocommerce',
    deliveryId: 'D-BROKEN',
    topic: 'order.updated',
    rawBody: Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8'),
  })
  await inbox.acceptVerifiedDelivery(db, {
    organizationId: org,
    marketplaceAccountId: accountId,
    providerKey: 'woocommerce',
    deliveryId: 'D-OK',
    topic: 'order.updated',
    rawBody: Buffer.from(JSON.stringify(wooOrderFixture({ id: 5151 })), 'utf8'),
  })

  // Şifreli yük BOZULDU: çözme PATLAR.
  await db
    .update(schema.connectorWebhookInbox)
    .set({ encryptedPayload: 'bu-cozulemez' })
    .where(eq(schema.connectorWebhookInbox.id, broken.record.id))

  const report = await wooWorker.runWooInboxCycle(db)
  assert.equal(report.due, 2)
  assert.equal(report.processed, 1, 'sağlam kardeş İŞLENİR')
  assert.equal(report.failed + report.retryable, 1, 'bozuk kayıt kendi başına düşer')

  const rows = await inbox.listInbox(db, { organizationId: org })
  const okRow = rows.find((row) => row.deliveryId === 'D-OK')
  const brokenRow = rows.find((row) => row.deliveryId === 'D-BROKEN')
  assert.equal(okRow.status, 'PROCESSED')
  assert.notEqual(brokenRow.status, 'PROCESSED')
})

test('WOO-CLOSE-W9: tüketici SAĞLAYICININ YENİDEN GÖNDERMESİNE bağlı DEĞİL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-w9')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')

  const api = await startApi(db)
  const fixture = wooOrderFixture({ id: 6001, number: 'WC-6001' })
  const accepted = await acceptDelivery(api, org, accountId, signedDelivery('wh-secret', fixture))
  assert.equal(accepted.status, 200)
  // ACK VERİLDİ → sağlayıcı bu teslimi BİR DAHA GÖNDERMEZ. HTTP yüzeyini
  // tamamen kapatıyoruz: geriye YALNIZ diskteki şifreli yük kalıyor.
  await api.close()

  const report = await wooWorker.runWooInboxCycle(db)
  assert.equal(report.processed, 1)

  // Baytlar BİREBİR korunmuş: yeniden serileştirme olsaydı imza tutmazdı.
  const rows = await inbox.listInbox(db, { organizationId: org })
  const restored = await inbox.readInboxRawBody(db, {
    organizationId: org,
    inboxId: rows[0].id,
  })
  assert.deepEqual(restored, Buffer.from(JSON.stringify(fixture), 'utf8'))

  // KAYNAK KANITI: tüketici HTTP isteğine BAKMAZ.
  const source = stripComments(
    readFileSync(join(here, 'connectors', 'woocommerce', 'wooWebhookWorker.ts'), 'utf8'),
  )
  assert.ok(source.includes('readInboxRawBody'), 'gövde DİSKTEN okunmalı')
  assert.ok(!/\brequest\b/.test(source), 'tüketici HTTP isteğine dokunmamalı')
  assert.ok(!/\bfetch\s*\(/.test(source), 'tüketici sağlayıcıya ÇAĞRI YAPMAZ')
})

test('WOO-CLOSE-WIRE-3: tüketici ÜRETİME BAĞLI ve VARSAYILAN KAPALI', async () => {
  const source = stripComments(readFileSync(join(here, 'index.mjs'), 'utf8'))
  assert.ok(
    source.includes('wooWebhookWorker.ts'),
    'index.mjs tüketiciyi YÜKLEMELİ',
  )
  assert.ok(source.includes('startWooInboxScheduler'), 'boot tüketiciyi KURMALI')
  assert.ok(source.includes('runWooInboxCycle'), 'boot GERÇEK turu bağlamalı')

  // TANIMLANMIŞ OLMAK YETMEZ — ÇAĞRILMIŞ olmalı.
  //
  // (Bu test ilk yazımında ZAYIFTI: yalnız adın kaynakta geçmesine bakıyordu.
  // Boot çağrısını silen mutasyon SAĞ KALDI, çünkü ad fonksiyon TANIMINDA
  // hâlâ geçiyordu. Artık ÇAĞRI YERİ denetleniyor.)
  const listenAt = source.indexOf('app.listen(port, host')
  assert.ok(listenAt > 0, 'dinleyici bloğu bulunmalı')
  const listenBlock = source.slice(listenAt, source.indexOf('\n})', listenAt))
  assert.ok(
    listenBlock.includes('startWooInboxWorkerOnBoot()'),
    'tüketici BOOT sırasında ÇAĞRILMALI',
  )
  const signalAt = source.indexOf("for (const signal of ['SIGTERM', 'SIGINT'])")
  assert.ok(signalAt > 0, 'kapanış bloğu bulunmalı')
  assert.ok(
    source.slice(signalAt).includes('drainWooInboxScheduler'),
    'kapanışta ZARİFÇE boşaltılmalı',
  )
  // Üretimde kanonik yazıcı ENJEKTE EDİLMEZ: sessiz canlı davranış YOK.
  assert.ok(!source.includes('persistCanonical'))

  // VARSAYILAN KAPALI (depo deseni).
  assert.equal(wooWorker.isWooInboxWorkerEnabled({}), false)
  assert.equal(wooWorker.isWooInboxWorkerEnabled({ WOO_WEBHOOK_WORKER_ENABLED: 'x' }), false)
  assert.equal(wooWorker.isWooInboxWorkerEnabled({ WOO_WEBHOOK_WORKER_ENABLED: 'true' }), true)
  assert.equal(wooWorker.isWooInboxWorkerEnabled({ WOO_WEBHOOK_WORKER_ENABLED: '1' }), true)

  wooWorker.resetWooInboxSchedulerForTest()
  let cycles = 0
  const startedOff = wooWorker.startWooInboxScheduler({
    runCycle: async () => {
      cycles += 1
    },
    env: {},
  })
  assert.equal(startedOff, false, 'bayrak kapalıyken zamanlayıcı KURULMAZ')
  assert.equal(wooWorker.isWooInboxSchedulerActive(), false)
  assert.equal(cycles, 0, 'bayrak kapalıyken TEK tur bile çalışmaz')

  const startedOn = wooWorker.startWooInboxScheduler({
    runCycle: async () => {
      cycles += 1
    },
    env: { WOO_WEBHOOK_WORKER_ENABLED: '1' },
  })
  assert.equal(startedOn, true)
  assert.equal(wooWorker.isWooInboxSchedulerActive(), true)
  const drained = await wooWorker.drainWooInboxScheduler(50)
  assert.equal(drained.drained, true)
  assert.equal(wooWorker.isWooInboxSchedulerActive(), false, 'boşaltma YENİ tur açmaz')
  wooWorker.resetWooInboxSchedulerForTest()

  // ÖRTÜŞME YASAĞI kaynakta kilitli.
  const workerSource = stripComments(
    readFileSync(join(here, 'connectors', 'woocommerce', 'wooWebhookWorker.ts'), 'utf8'),
  )
  assert.ok(workerSource.includes('if (cycleRunning || draining) return'))
})

/* ═══════════════════════════════════════════════════════════════════════
   3) DISCONNECT — SAĞLAYICI KAPSAMI
   ═══════════════════════════════════════════════════════════════════════ */

async function disconnect(api, org, marketplaceAccountId) {
  return fetch(`${api.base}/api/integrations/woocommerce/stores/disconnect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-organization': org },
    body: JSON.stringify({ marketplaceAccountId }),
  })
}

const accountRow = async (db, id) =>
  (await db.select().from(schema.marketplaceAccounts).where(eq(schema.marketplaceAccounts.id, id)))[0]

test('WOO-CLOSE-D1: Woo mağazası ayrılır — kimlik silinir, hesap pasifleşir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-d1')
  const accountId = await connectStore(db, org, 'https://shop-a.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  const response = await disconnect(api, org, accountId)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).outcome, 'DISCONNECTED')

  const credential = await credentialStore.getConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: accountId,
    providerKey: 'woocommerce',
  })
  assert.equal(credential, null)
  assert.equal((await accountRow(db, accountId)).isActive, false)
})

test('WOO-CLOSE-D2: A ayrılır, B ETKİLENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-d2')
  const accountA = await connectStore(db, org, 'https://shop-a.example.com')
  const accountB = await connectStore(db, org, 'https://shop-b.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  assert.equal((await disconnect(api, org, accountA)).status, 200)

  assert.equal((await accountRow(db, accountB)).isActive, true, 'kardeş mağaza AKTİF kalmalı')
  const credentialB = await credentialStore.getConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: accountB,
    providerKey: 'woocommerce',
  })
  assert.ok(credentialB, 'kardeş mağazanın kimliği DURMALI')
})

test('WOO-CLOSE-D3: AYNI ORG TRENDYOL hesabı Woo disconnect ile KAPATILAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'close-d3')
  const wooAccount = await connectStore(db, org, 'https://shop-a.example.com')
  const trendyol = await accountsRepo.ensureAccount(db, org, 'trendyol', '277221')
  await db
    .update(schema.marketplaceAccounts)
    .set({ isActive: true })
    .where(eq(schema.marketplaceAccounts.id, trendyol.id))
  await db
    .insert(schema.integrationCredentials)
    .values({ organizationId: org, provider: 'trendyol', encryptedPayload: 'enc-trendyol' })

  const api = await startApi(db)
  t.after(() => api.close())
  const response = await disconnect(api, org, trendyol.id)
  assert.equal(response.status, 404, 'sağlayıcı uyuşmazlığı REDDEDİLMELİ')
  assert.equal((await response.json()).outcome, 'NOT_FOUND')

  // HİÇBİR MUTASYON OLMADI.
  assert.equal((await accountRow(db, trendyol.id)).isActive, true, 'Trendyol AKTİF kalmalı')
  const trendyolCredentials = await db
    .select()
    .from(schema.integrationCredentials)
    .where(
      and(
        eq(schema.integrationCredentials.organizationId, org),
        eq(schema.integrationCredentials.provider, 'trendyol'),
      ),
    )
  assert.equal(trendyolCredentials.length, 1, 'Trendyol kimliği DOKUNULMAMIŞ olmalı')
  assert.equal(trendyolCredentials[0].encryptedPayload, 'enc-trendyol')
  // Woo mağazası ETKİLENMEDİ.
  assert.equal((await accountRow(db, wooAccount)).isActive, true)
})

test('WOO-CLOSE-D4: BAŞKA KİRACININ hesabı REDDEDİLİR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'close-d4-a')
  const orgB = await makeOrg(db, 'close-d4-b')
  const foreign = await connectStore(db, orgB, 'https://shop-b.example.com')
  const api = await startApi(db)
  t.after(() => api.close())

  const response = await disconnect(api, orgA, foreign)
  assert.equal(response.status, 404)
  assert.equal((await accountRow(db, foreign)).isActive, true, 'yabancı hesap DEĞİŞMEMELİ')
  const credential = await credentialStore.getConnectorCredential(db, {
    organizationId: orgB,
    marketplaceAccountId: foreign,
    providerKey: 'woocommerce',
  })
  assert.ok(credential, 'yabancı kiracının kimliği SİLİNMEMELİ')
})

test('WOO-CLOSE-WIRE-4: disconnect ucu SERVİSE devreder ve SAĞLAYICI yüklemi taşır', () => {
  const server = stripComments(readFileSync(join(here, 'index.mjs'), 'utf8'))
  const disconnectRoute = server.slice(
    server.indexOf("/api/integrations/woocommerce/stores/disconnect"),
  )
  assert.ok(
    disconnectRoute.includes('handleWooDisconnect'),
    'uç SERVİSE devretmeli',
  )
  const service = stripComments(
    readFileSync(join(here, 'connectors', 'woocommerce', 'wooConnectionService.ts'), 'utf8'),
  )
  const body = service.slice(service.indexOf('export async function disconnectWooStore'))
  assert.ok(
    body.includes('eq(marketplaceAccounts.marketplace, WOO_PROVIDER_KEY)'),
    'disconnect SAĞLAYICI yüklemi TAŞIMALI',
  )
  // Sahiplik MUTASYONDAN ÖNCE kanıtlanır.
  assert.ok(
    body.indexOf('WOO_PROVIDER_KEY') < body.indexOf('deleteConnectorCredential'),
    'sahiplik kanıtı silmeden ÖNCE gelmeli',
  )
})

test('WOO-CLOSE-REG: kapanış paketi tam pakete KAYITLI', () => {
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  assert.ok(
    files.includes('server/woocommerce-runtime-closeout-flow.test.mjs'),
    'kapanış paketi suratSuiteFiles.json içinde KAYITLI olmalı',
  )
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.ok(
    String(pkg.scripts['test:woocommerce']).includes(
      'woocommerce-runtime-closeout-flow.test.mjs',
    ),
    'test:woocommerce kapanış paketini de çalıştırmalı',
  )
  // Sözleşme paketi hâlâ takip ediliyor (önceki bilet BOZULMADI).
  assert.equal(typeof wooClient.fetchWooOrders, 'function')
})
