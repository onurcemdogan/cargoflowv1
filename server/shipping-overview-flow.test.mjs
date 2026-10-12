import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// KARGO OPERASYONLARI + GÖNDERİLER — salt okunur görünümler (gerçek migration,
// pglite). Sayılar DB'den gelir; taşıyıcıya çağrı/yazım/create YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
const schema = await import('./db/schema.ts')
const overview = await import('./shipments/shippingOverviewService.ts')
const producer = await import('./shipments/autoLabelProducer.ts')

const DIR = join(here, '..', 'drizzle')
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
async function makeDb() {
  const pglite = new PGlite()
  for (const file of FILES) {
    for (const s of readFileSync(join(DIR, file), 'utf8').split('--> statement-breakpoint')) if (s.trim()) await pglite.exec(s)
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

// 12 Ekim 2026 12:00 TSİ.
const NOW = new Date('2026-10-12T09:00:00.000Z')
const TODAY_TR_0130 = new Date('2026-10-11T22:30:00.000Z') // 12 Ekim 01:30 TSİ → BUGÜN
const YESTERDAY = new Date('2026-10-10T12:00:00.000Z')

async function makeOrg(db, slug) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

async function order(db, organizationId, packageId, over = {}) {
  const [row] = await db.insert(schema.orders).values({
    organizationId, marketplace: 'Trendyol', packageId, orderNumber: `ON-${packageId}`,
    orderDate: YESTERDAY, operationStatus: 'NEW', marketplaceStatus: 'Picking',
    customerFirstName: 'Ayşe', customerLastName: 'Yılmaz', customerPhone: '05551112233',
    ...over,
  }).returning()
  return row.id
}

const job = (db, organizationId, packageId, status, over = {}) =>
  db.insert(schema.labelJobs).values({ organizationId, marketplace: 'Trendyol', carrier: 'surat', packageId, status, ...over })

const shipment = (db, organizationId, packageId, over = {}) =>
  db.insert(schema.shipments).values({
    organizationId, marketplace: 'Trendyol', packageId, provider: 'surat', source: 'local_create', status: 'created',
    trackingNumber: `T-${packageId}`, createdAt: YESTERDAY, ...over,
  })

const operation = (db, organizationId, packageId, status, over = {}) =>
  db.insert(schema.shipmentOperations).values({
    organizationId, marketplace: 'Trendyol', packageId, provider: 'surat', operationType: 'CREATE',
    idempotencyKey: `SURAT:${organizationId}:${packageId}:CREATE`, status, ...over,
  })

async function seedPipeline(db, organizationId) {
  for (const id of ['Q1', 'Q2', 'Q3']) { await order(db, organizationId, id); await job(db, organizationId, id, 'QUEUED') }
  await order(db, organizationId, 'R1'); await job(db, organizationId, 'R1', 'FAILED_SAFE_TO_RETRY')
  await order(db, organizationId, 'P1'); await job(db, organizationId, 'P1', 'PREPARING')
  await order(db, organizationId, 'B1'); await job(db, organizationId, 'B1', 'BLOCKED', { lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING' })
  await order(db, organizationId, 'U1'); await job(db, organizationId, 'U1', 'UNKNOWN_AFTER_NETWORK', { lastErrorCode: 'LABEL_WORKER_EXCEPTION' })
  // Etiketi hazır (worker READY + canonical LABEL_READY) — biri BUGÜN oluşturuldu.
  await order(db, organizationId, 'L1', { operationStatus: 'LABEL_READY' })
  await job(db, organizationId, 'L1', 'READY', { createdAt: new Date(NOW.getTime() - 120_000), updatedAt: new Date(NOW.getTime() - 60_000) })
  await shipment(db, organizationId, 'L1', { createdAt: TODAY_TR_0130 })
  await operation(db, organizationId, 'L1', 'succeeded', { carrierCreateCalled: true, updatedAt: new Date(NOW.getTime() - 60_000) })
  // Bugün kargoya verildi.
  await order(db, organizationId, 'H1', { operationStatus: 'HANDED_TO_CARGO', lastOperationalActivityAt: TODAY_TR_0130 })
  await shipment(db, organizationId, 'H1')
  await operation(db, organizationId, 'H1', 'succeeded', { carrierCreateCalled: true })
  // 4238186037 vakası: ağ geçildi, sonuç belirsiz, gönderi yok.
  await order(db, organizationId, '4238186037')
  await operation(db, organizationId, '4238186037', 'pending', { carrierCreateCalled: true, createCallCount: 1 })
  // Taşıyıcı reddetti.
  await order(db, organizationId, 'F1')
  await operation(db, organizationId, 'F1', 'failed', { carrierCreateCalled: true, errorCode: 'SURAT_REJECTED' })
  // Doğrulanamayan gönderi (kanonik durum).
  await order(db, organizationId, 'V1', { operationStatus: 'LABEL_CREATED_UNVERIFIED' })
}

test('PIPE-1: özet ve arka plan hazırlama sayıları gerçek DB satırlarından gelir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'pipe1')
  await producer.activateAutoLabel(db, org, { marketplaces: ['trendyol'], carriers: ['surat'], now: '2026-10-01T00:00:00.000Z' })
  await seedPipeline(db, org)
  const other = await makeOrg(db, 'baska')
  await order(db, other, 'X1'); await job(db, other, 'X1', 'QUEUED')

  const pipeline = await overview.loadShippingPipeline(db, { organizationId: org, now: NOW, env: { LABEL_WORKER_ENABLED: 'true' } })
  assert.deepEqual(pipeline.summary, { queued: 4, preparing: 1, labelReady: 1, needsAttention: 5, createdToday: 1, handedToday: 1 })
  assert.deepEqual(pipeline.worker.counts, { QUEUED: 3, PREPARING: 1, READY: 1, BLOCKED: 1, UNKNOWN_AFTER_NETWORK: 1, FAILED_SAFE_TO_RETRY: 1 })
  assert.equal(pipeline.worker.backgroundEnabled, true)
  assert.equal(pipeline.worker.workspaceEnabled, true)
  assert.equal(pipeline.worker.averagePrepSeconds, 60)
  assert.equal(pipeline.worker.sampleSize, 1)
  assert.equal(pipeline.worker.lastPreparedAt, new Date(NOW.getTime() - 60_000).toISOString())

  const off = await overview.loadShippingPipeline(db, { organizationId: org, now: NOW, env: {} })
  assert.equal(off.worker.backgroundEnabled, false)
})

test('PIPE-2: kontrol gerekenler gerçek durumlarla ve güvenli sebeple listelenir; kişisel veri yok; kiracıya özel', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'pipe2')
  await seedPipeline(db, org)
  const other = await makeOrg(db, 'baska2')
  await order(db, other, 'Z1'); await job(db, other, 'Z1', 'BLOCKED')

  const { attention } = await overview.loadShippingPipeline(db, { organizationId: org, now: NOW })
  const byPackage = Object.fromEntries(attention.map((row) => [row.packageId, row]))
  assert.deepEqual(Object.keys(byPackage).sort(), ['4238186037', 'B1', 'F1', 'U1', 'V1'])
  assert.equal(byPackage.B1.kind, 'BLOCKED')
  assert.equal(byPackage.B1.reason, 'Desi bilgisi eksik.')
  assert.equal(byPackage.U1.kind, 'UNKNOWN_AFTER_NETWORK')
  assert.match(byPackage.U1.reason, /yeniden denenmez/)
  assert.equal(byPackage['4238186037'].kind, 'OPERATION_UNCERTAIN')
  assert.match(byPackage['4238186037'].reason, /Mutabakat gerekli/)
  assert.equal(byPackage.F1.kind, 'OPERATION_FAILED')
  assert.equal(byPackage.V1.kind, 'UNVERIFIED')
  assert.equal(byPackage.B1.orderNumber, 'ON-B1')
  assert.ok(byPackage.B1.orderId)
  const dump = JSON.stringify(attention)
  assert.ok(!/Ayşe|Yılmaz|0555/.test(dump), 'kişisel veri sızmamalı')
  assert.ok(!dump.includes('Z1'), 'başka kiracı görünmemeli')
})

test('PIPE-3: son işlemler aşaması doğru; yalnız oluşturulmuş + etiketli gönderide yeniden yazdırma var', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'pipe3')
  await seedPipeline(db, org)
  const { recent } = await overview.loadShippingPipeline(db, { organizationId: org, now: NOW })
  const byPackage = Object.fromEntries(recent.map((row) => [row.packageId, row]))
  assert.equal(byPackage.L1.stage, 'Gönderi oluşturuldu')
  assert.equal(byPackage.L1.labelState, 'ready')
  assert.equal(byPackage.L1.trackingNumber, 'T-L1')
  assert.equal(byPackage.L1.canReprint, true)
  assert.equal(byPackage['4238186037'].stage, 'Sonuç kesinleşmedi')
  assert.equal(byPackage['4238186037'].canReprint, false)
  assert.equal(byPackage.F1.stage, 'Taşıyıcı reddetti')
  assert.equal(byPackage.F1.canReprint, false)
  assert.equal(byPackage.L1.carrier, 'Sürat Kargo')
})

test('LEDGER-1: gönderi defteri — sekmeler, sayaçlar, filtreler, sayfalama, ödeyen ve kargo hesabı', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ledger')
  const [carrier] = await db.insert(schema.carrierAccounts).values({
    organizationId: org, provider: 'surat', displayName: 'Sürat Ana Hesap', credentialRef: 'integration_credentials:surat',
  }).returning()
  await order(db, org, 'S-READY', { operationStatus: 'LABEL_READY' })
  await shipment(db, org, 'S-READY', { payerType: 'MARKETPLACE_PAYS', carrierAccountId: carrier.id, createdAt: TODAY_TR_0130 })
  await order(db, org, 'S-PRINTED', { operationStatus: 'LABEL_PRINTED' })
  await shipment(db, org, 'S-PRINTED', { payerType: 'SELLER_PAYS' })
  await order(db, org, 'S-SHIPPED', { operationStatus: 'HANDED_TO_CARGO', marketplaceStatus: 'Shipped', lastOperationalActivityAt: TODAY_TR_0130 })
  await shipment(db, org, 'S-SHIPPED')
  await order(db, org, 'S-DELIVERED', { operationStatus: 'DELIVERED', marketplaceStatus: 'Delivered' })
  await shipment(db, org, 'S-DELIVERED')
  await order(db, org, 'S-UNKNOWN', { operationStatus: 'LABEL_READY' })
  await shipment(db, org, 'S-UNKNOWN')
  await operation(db, org, 'S-UNKNOWN', 'pending', { carrierCreateCalled: true })
  const other = await makeOrg(db, 'ledger-other')
  await order(db, other, 'S-OTHER'); await shipment(db, other, 'S-OTHER')

  const all = await overview.listShipmentLedger(db, { organizationId: org })
  assert.equal(all.total, 5)
  assert.deepEqual(all.counts, { all: 5, label_ready: 2, in_transit: 1, delivered: 1, attention: 1 })
  assert.ok(all.rows.every((row) => row.packageId !== 'S-OTHER'))
  const byPackage = Object.fromEntries(all.rows.map((row) => [row.packageId, row]))
  assert.equal(byPackage['S-READY'].payer, 'Pazaryeri öder')
  assert.equal(byPackage['S-READY'].carrierAccount, 'Sürat Ana Hesap')
  assert.equal(byPackage['S-READY'].canReprint, true)
  assert.equal(byPackage['S-PRINTED'].labelState, 'printed')
  assert.equal(byPackage['S-SHIPPED'].lifecycleLabel, 'Kargoda')
  assert.equal(byPackage['S-SHIPPED'].lastActivityAt, TODAY_TR_0130.toISOString())
  // Belirsiz create: kontrol gerekli ve yeniden yazdırma/aksiyon YOK.
  assert.equal(byPackage['S-UNKNOWN'].lifecycle, 'attention')
  assert.equal(byPackage['S-UNKNOWN'].canReprint, false)

  assert.deepEqual((await overview.listShipmentLedger(db, { organizationId: org, filters: { tab: 'in_transit' } })).rows.map((r) => r.packageId), ['S-SHIPPED'])
  assert.deepEqual((await overview.listShipmentLedger(db, { organizationId: org, filters: { search: 't-s-deliv' } })).rows.map((r) => r.packageId), ['S-DELIVERED'])
  assert.deepEqual((await overview.listShipmentLedger(db, { organizationId: org, filters: { from: '2026-10-12', to: '2026-10-12' } })).rows.map((r) => r.packageId), ['S-READY'])
  // Basılmış = LABEL_PRINTED + kargoya verilmiş + teslim edilmiş.
  assert.equal((await overview.listShipmentLedger(db, { organizationId: org, filters: { labelState: 'printed' } })).total, 3)
  const page2 = await overview.listShipmentLedger(db, { organizationId: org, filters: { pageSize: 2, page: 3 } })
  assert.equal(page2.rows.length, 1)
  assert.equal(page2.total, 5)
  assert.ok(!/Ayşe|Yılmaz|0555/.test(JSON.stringify(all)))
})

test('SHIP-API: uçlar kiracı kapsamlı, salt okunur; create/taşıyıcı çağrısı içermez', () => {
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const paths = index.slice(index.indexOf('const TENANT_AUTH_PATHS'), index.indexOf(']', index.indexOf('const TENANT_AUTH_PATHS')))
  for (const route of ['/api/shipping/pipeline', '/api/shipping/shipments']) {
    assert.match(paths, new RegExp(`'${route.replace(/\//g, '\\/')}'`))
    const start = index.indexOf(`app.get('${route}'`)
    assert.ok(start > 0, route)
    const block = index.slice(start, index.indexOf('\n})', start))
    assert.match(block, /requireOnboardingContext/)
    assert.equal(/createSurat|callSuratSoap|fetchTrendyol|\.insert\(|\.update\(/.test(block), false)
  }
  const service = readFileSync(join(here, 'shipments', 'shippingOverviewService.ts'), 'utf8')
  assert.equal(/INSERT |UPDATE |DELETE |\.insert\(|\.update\(|\.delete\(/.test(service), false, 'servis yazım yapmaz')
})
