import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// ═══ OTOMATİK ETİKET — TAM KABUL PAKETİ ═════════════════════════════════
//
// Bu dosya alt sistemin BÜTÜNÜNÜ ölçer: kalıcı Trendyol paketinden
// üreticiye, kuyruğa, talebe, hazırlığa, operasyon rezervasyonuna, taşıyıcı
// sınırına ve READY'ye kadar.
//
// VITE KULLANILMAZ: üretim `node server/index.mjs` ile çalışır ve daha önce
// tam olarak bu fark yüzünden beş paket bloke oldu.
//
// GERÇEK TAŞIYICI ÇAĞRISI YOKTUR: sınır enjekte edilir ve SAYILIR.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')

function migrationStatements() {
  const dir = join(root, 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
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

const ACTIVATED_AT = new Date('2026-08-20T00:00:00.000Z')

async function makeTenant(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()
  if (options.desi !== null) {
    const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
    await defaults.saveShipmentDefaults(db, org.id, {
      defaultUnitDesi: options.desi ?? 2,
      multiplyByItemQuantity: options.multiply ?? false,
      labelPrintTemplate: 'cargoflow_html',
    })
  }
  if (options.credentials !== null) {
    const credentials = await import('./integrations/credentialService.ts')
    await credentials.saveIntegrationCredential(db, org.id, 'surat', {
      liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
    })
  }
  return org.id
}

async function seedPackage(db, organizationId, packageId, options = {}) {
  const encryption = await import('./orders/orderEncryption.ts')
  const raw = { orderNumber: `ORD-${packageId}`, id: packageId }
  if (options.whoPays !== undefined) raw.whoPays = options.whoPays
  const [order] = await db.insert(schema.orders).values({
    organizationId, marketplace: 'Trendyol', packageId,
    orderNumber: `ORD-${packageId}`,
    orderDate: options.orderDate ?? new Date('2026-08-25T00:00:00.000Z'),
    cargoTrackingNumber: `7281${packageId.slice(-6)}`,
    operationStatus: 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Picking',
    cargoProviderName: options.cargoProviderName ?? 'Surat Kargo',
    firstSeenAt: options.firstSeenAt ?? new Date('2026-08-25T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload(raw),
  }).returning()
  if (options.lines) {
    const lines = options.lines.map((line, index) => ({
      organizationId, orderId: order.id,
      externalLineId: `${packageId}-${index}`,
      productName: line.productName ?? 'Urun',
      quantity: line.quantity ?? 1,
      rawPayloadEncrypted: encryption.encryptOrderPayload(line),
    }))
    await db.insert(schema.orderLines).values(lines)
  }
  if (options.job !== null) {
    await db.insert(schema.labelJobs).values({
      organizationId, marketplace: 'Trendyol', carrier: 'surat',
      packageId, jobType: 'LABEL_PREPARE',
      status: options.jobStatus ?? 'QUEUED',
      attemptCount: options.attemptCount ?? 0,
      lastErrorCode: options.lastErrorCode ?? null,
      lockedAt: options.lockedAt ?? null,
      lockedBy: options.lockedBy ?? null,
    })
  }
  return order.id
}

/** Üretim worker'ının sözleşmesi — taşıyıcı sınırı ENJEKTE. */
function makeWorkerRunLabel(db, organizationId, carrier) {
  return async (job) => {
    const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
    const prepared = await prepareLabelJob(db, {
      organizationId, packageId: job.packageId, marketplace: job.marketplace,
    })
    if (!prepared.ok) {
      return {
        labelReady: false, networkCrossed: false, blocked: true,
        errorCode: prepared.blockerCode,
        errorSummary: prepared.errorSummary, carrierCalls: 0,
      }
    }
    return carrier(prepared, job)
  }
}

async function runCycle(db, organizationId, carrier) {
  const worker = await import('./shipments/labelJobWorker.ts')
  return worker.runLabelJobCycle({
    db, workerId: `acceptance-${randomBytes(3).toString('hex')}`,
    runLabel: makeWorkerRunLabel(db, organizationId, carrier),
  })
}

async function jobs(db) {
  const rows = await db.select().from(schema.labelJobs)
  return Object.fromEntries(rows.map((row) => [row.packageId, row]))
}

const SUCCESS = () => ({ labelReady: true, networkCrossed: true, carrierCalls: 1 })

/* ═══ AL-01 / AL-03 / AL-06 / AL-20 ══════════════════════════════════ */

test('AL-01/03/06/20: Picking + desi 2 → BirimDesi 2, WhoPays 3, TEK create, READY', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000001')
  const seen = []

  await runCycle(db, organizationId, (prepared) => {
    seen.push(prepared)
    return SUCCESS()
  })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].resolvedDesi, 2)
  assert.equal(seen[0].suratBirimDesi, 2)
  assert.equal(Number(seen[0].order.desi), 2)
  assert.equal(seen[0].billingParty, 'TRENDYOL_PAYS')
  assert.equal(seen[0].expectedWhoPays, 3)
  assert.equal(seen[0].credentialRole, 'PRIMARY_MARKETPLACE')
  const after = await jobs(db)
  assert.equal(after['4111000001'].status, 'READY')
  assert.equal(after['4111000001'].attemptCount, 1)
})

/* ═══ AL-02 / AL-25 ══════════════════════════════════════════════════ */

test('AL-02/25: Created → BLOCKED, KESIN kod, create 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000002', {
    marketplaceStatus: 'Created',
  })
  let calls = 0

  await runCycle(db, organizationId, () => { calls += 1; return SUCCESS() })

  assert.equal(calls, 0)
  const after = await jobs(db)
  assert.equal(after['4111000002'].status, 'BLOCKED')
  assert.equal(
    after['4111000002'].lastErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  )
  // Desi hatasi DEGIL; kimlik cumlesi DE degil.
  assert.notEqual(after['4111000002'].lastErrorCode, 'SURAT_PREFLIGHT_DESI_MISSING')
  assert.ok(!/kimlik doğrulaması/i.test(after['4111000002'].lastErrorSummary ?? ''))
})

/* ═══ AL-04 — çarpan davranışı ═══════════════════════════════════════ */

test('AL-04: multiplyByItemQuantity davranisi degismedi', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await import('./shipments/resolveShipmentDesi.ts')

  const single = await makeTenant(db, { multiply: false })
  const off = await resolver.resolveShipmentDesi({
    db, organizationId: single,
    order: { packageId: 'X', items: [{ id: 'a', quantity: 3 }] },
  })
  const multi = await makeTenant(db, { multiply: true })
  const on = await resolver.resolveShipmentDesi({
    db, organizationId: multi,
    order: { packageId: 'X', items: [{ id: 'a', quantity: 3 }] },
  })
  // Carpan ACIKKEN adet dikkate alinir; KAPALIYKEN alinmaz.
  assert.ok(on.desi > off.desi, `carpan etkisiz: ${on.desi} vs ${off.desi}`)
})

/* ═══ AL-05 — satıcı öder ════════════════════════════════════════════ */

test('AL-05: whoPays=1 → SELLER_PAYS / 1, semantik DEGISMEDI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000005', { whoPays: 1 })
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')

  const prepared = await prepareLabelJob(db, {
    organizationId, packageId: '4111000005', marketplace: 'Trendyol',
  })
  assert.equal(prepared.billingParty, 'SELLER_PAYS')
  assert.equal(prepared.expectedWhoPays, 1)
  assert.equal(prepared.credentialRole, 'SELLER_PAYS')
})

/* ═══ AL-07 / AL-24 ══════════════════════════════════════════════════ */

test('AL-07/24: kimlik ve sifreleme anahtari eksikliginde KESIN hata, create 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const noCredentials = await makeTenant(db, { credentials: null })
  await seedPackage(db, noCredentials, '4111000007')
  let calls = 0
  await runCycle(db, noCredentials, () => { calls += 1; return SUCCESS() })
  assert.equal(calls, 0)
  const after = await jobs(db)
  assert.equal(after['4111000007'].status, 'BLOCKED')
  assert.equal(after['4111000007'].lastErrorCode, 'SURAT_CREDENTIAL_CONFIG_INVALID')
  assert.match(after['4111000007'].lastErrorSummary, /kimlik yapılandırması/i)

  // Sifreleme anahtari yoksa: KESIN kod, sir SIZMAZ.
  const orderKey = process.env.ORDER_DATA_ENCRYPTION_KEY
  const credentialKey = process.env.CREDENTIAL_ENCRYPTION_KEY
  t.after(() => {
    process.env.ORDER_DATA_ENCRYPTION_KEY = orderKey
    process.env.CREDENTIAL_ENCRYPTION_KEY = credentialKey
  })
  delete process.env.ORDER_DATA_ENCRYPTION_KEY
  delete process.env.CREDENTIAL_ENCRYPTION_KEY
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  const prepared = await prepareLabelJob(db, {
    organizationId: noCredentials, packageId: '4111000007',
  })
  assert.equal(prepared.blockerCode, 'SURAT_PREFLIGHT_ENCRYPTION_KEY_MISSING')
  assert.ok(!String(prepared.failureDetail).includes(orderKey))
  assert.ok(!String(prepared.failureDetail).includes(credentialKey))
})

/* ═══ AL-09 / AL-19 — üretici tekrarı ════════════════════════════════ */

test('AL-09/19: tekrarlanan uretici olayi IKINCI mantiksal is YARATMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const producer = await import('./shipments/autoLabelProducer.ts')
  await producer.activateAutoLabel(db, organizationId, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })
  await seedPackage(db, organizationId, '4111000009', {
    job: null,
    firstSeenAt: new Date('2026-08-26T00:00:00.000Z'),
    orderDate: new Date('2026-08-26T00:00:00.000Z'),
  })

  // Ayni akis olayini UC KEZ isle.
  for (let index = 0; index < 3; index += 1) {
    await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  }
  const rows = await db.select().from(schema.labelJobs)
  assert.equal(rows.length, 1, 'mukerrer mantiksal is olustu')
  assert.equal(rows[0].packageId, '4111000009')
})

/* ═══ AL-10 — eşzamanlı talep yarışı ═════════════════════════════════ */

test('AL-10: eszamanli iki worker AYNI isi IKI KEZ TALEP EDEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000010')
  const queue = await import('./shipments/labelJobQueue.ts')

  const [first, second] = await Promise.all([
    queue.claimLabelJobs(db, { workerId: 'worker-a', limit: 10 }),
    queue.claimLabelJobs(db, { workerId: 'worker-b', limit: 10 }),
  ])
  const claimed = [...first, ...second]
  assert.equal(claimed.length, 1, 'ayni is IKI KEZ talep edildi')
  // Sayac TAM OLARAK BIR artti.
  const after = await jobs(db)
  assert.equal(after['4111000010'].attemptCount, 1)
  assert.equal(after['4111000010'].status, 'PREPARING')
})

/* ═══ AL-12 / AL-18 / AL-30 ══════════════════════════════════════════ */

test('AL-12/18/30: agdan once bayat PREPARING guvenle kurtarilir; sure IZIN DEGIL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000012', {
    jobStatus: 'PREPARING', attemptCount: 1,
    lockedAt: new Date(Date.now() - 3600_000), lockedBy: 'dead@worker',
  })
  await db.insert(schema.shipmentOperations).values({
    organizationId, marketplace: 'Trendyol', packageId: '4111000012',
    orderNumber: 'ORD-4111000012', provider: 'surat',
    operationType: 'OrtakBarkodOlustur', idempotencyKey: 'idem-4111000012',
    status: 'pending', createCallCount: 1, carrierCreateCalled: false,
  })

  const recovery = await import('./shipments/staleJobRecovery.ts')
  const report = await recovery.inspectStaleJobs(db, { organizationId })
  assert.equal(report.candidates[0].verdict, 'SAFE_STALE_PRE_NETWORK')
  const result = await recovery.recoverStaleJobs(db, {
    organizationId, packageIds: ['4111000012'],
  })
  assert.equal(result.recovered, 1)
  assert.equal(result.carrierCalls, 0)

  const after = await jobs(db)
  assert.equal(after['4111000012'].status, 'QUEUED')
  assert.equal(after['4111000012'].attemptCount, 1)
  // AYNI mantiksal operasyon; ikinci operasyon YOK.
  const operations = await db.select().from(schema.shipmentOperations)
  assert.equal(operations.length, 1)
  assert.equal(operations[0].idempotencyKey, 'idem-4111000012')
})

/* ═══ AL-13 / AL-17 ══════════════════════════════════════════════════ */

test('AL-13/17: UNKNOWN_AFTER_NETWORK HICBIR giristen YENIDEN CREATE ETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000013', {
    jobStatus: 'UNKNOWN_AFTER_NETWORK', attemptCount: 2,
  })
  let calls = 0

  // 1) Genel worker: talep dahi ETMEZ.
  await runCycle(db, organizationId, () => { calls += 1; return SUCCESS() })
  // 2) Tek is calistirici.
  const runner = await import('./shipments/singleLabelJobRunner.ts')
  for (const options of [{}, { allowQueuedCanary: true }]) {
    const report = await runner.runSingleLabelJob(db, {
      organizationId, packageId: '4111000013', workerId: 'test', ...options,
      runLabel: async () => { calls += 1; return SUCCESS() },
    })
    assert.equal(report.gatesPassed, false)
  }
  // 3) Bloke kurtarma.
  const blocked = await import('./shipments/blockedJobRecovery.ts')
  const blockedResult = await blocked.reactivateBlockedJobs(db, {
    organizationId, packageIds: ['4111000013'],
  })
  assert.equal(blockedResult.reactivated, 0)
  // 4) Bayat kurtarma.
  const stale = await import('./shipments/staleJobRecovery.ts')
  const staleResult = await stale.recoverStaleJobs(db, {
    organizationId, packageIds: ['4111000013'],
  })
  assert.equal(staleResult.recovered, 0)
  // 5) Aday secici: aday DEGIL.
  const selector = await import('./shipments/canaryCandidateSelector.ts')
  const candidates = await selector.selectCanaryCandidates(db, { organizationId })
  assert.ok(!candidates.candidates.some((c) => c.packageId === '4111000013'))

  assert.equal(calls, 0, 'UNKNOWN pakette tasiyiciya CIKILDI')
  const after = await jobs(db)
  assert.equal(after['4111000013'].status, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(after['4111000013'].attemptCount, 2)
})

/* ═══ AL-15 / AL-16 ══════════════════════════════════════════════════ */

test('AL-15/16: artefakt VARSA uzlastirilir ve ASLA yeniden create edilmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000015', {
    jobStatus: 'PREPARING', attemptCount: 1,
    lockedAt: new Date(Date.now() - 3600_000), lockedBy: 'dead@worker',
  })
  await db.insert(schema.shipments).values({
    organizationId, marketplace: 'Trendyol', packageId: '4111000015',
    provider: 'surat', trackingNumber: '7281000015',
    source: 'local_create', status: 'created',
  })

  const recovery = await import('./shipments/staleJobRecovery.ts')
  const result = await recovery.recoverStaleJobs(db, {
    organizationId, packageIds: ['4111000015'],
  })
  assert.equal(result.recovered, 1)
  assert.equal(result.carrierCalls, 0)
  const after = await jobs(db)
  assert.equal(after['4111000015'].status, 'READY')

  // READY is bir daha TALEP EDILMEZ.
  let calls = 0
  await runCycle(db, organizationId, () => { calls += 1; return SUCCESS() })
  assert.equal(calls, 0)

  // Hazirlik da artefakti gorup create'i KAPATIR.
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  const prepared = await prepareLabelJob(db, {
    organizationId, packageId: '4111000015',
  })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.blockerCode, 'SURAT_PREFLIGHT_CARRIER_ARTIFACT_EXISTS')
})

/* ═══ AL-26 — aktivasyon sınırı ══════════════════════════════════════ */

test('AL-26: aktivasyon sinirindan ONCEKI paketler otomatik SIRAYA GIRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const producer = await import('./shipments/autoLabelProducer.ts')

  // Sinir YOKKEN hicbir sey taranmaz.
  await seedPackage(db, organizationId, '4111000026', {
    job: null,
    firstSeenAt: new Date('2026-08-10T00:00:00.000Z'),
    orderDate: new Date('2026-08-10T00:00:00.000Z'),
  })
  const before = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(before.enqueued, 0)

  await producer.activateAutoLabel(db, organizationId, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })
  // Sinirdan ONCE goruldu → HALA sıraya girmez.
  const afterActivation = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(afterActivation.enqueued, 0)
  assert.equal((await db.select().from(schema.labelJobs)).length, 0)

  // Sinirdan SONRA goruldu → sıraya girer.
  await seedPackage(db, organizationId, '4111000027', {
    job: null,
    firstSeenAt: new Date('2026-08-26T00:00:00.000Z'),
    orderDate: new Date('2026-08-26T00:00:00.000Z'),
  })
  const fresh = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(fresh.enqueued, 1)
})

/* ═══ AL-31 — Created → Picking operasyonel çıkmaz ═══════════════════ */

test('AL-31: Created iken BLOKE paket Picking e gecince SIKISMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const producer = await import('./shipments/autoLabelProducer.ts')
  await producer.activateAutoLabel(db, organizationId, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })
  await seedPackage(db, organizationId, '4111000031', {
    marketplaceStatus: 'Created',
    firstSeenAt: new Date('2026-08-26T00:00:00.000Z'),
    orderDate: new Date('2026-08-26T00:00:00.000Z'),
  })

  // Worker Created paketi BLOKE eder.
  await runCycle(db, organizationId, () => SUCCESS())
  let after = await jobs(db)
  assert.equal(after['4111000031'].status, 'BLOCKED')
  assert.equal(after['4111000031'].lastErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')

  // Paket Trendyol'da Picking'e gecti.
  await db.update(schema.orders)
    .set({ marketplaceStatus: 'Picking' })
    .where(and(
      eq(schema.orders.organizationId, organizationId),
      eq(schema.orders.packageId, '4111000031'),
    ))

  // URETICI CIKMAZI ACAR — YENI is YARATMADAN.
  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.enqueued, 1)
  assert.equal((await db.select().from(schema.labelJobs)).length, 1)
  after = await jobs(db)
  assert.equal(after['4111000031'].status, 'QUEUED')

  // Ve artik basariyla islenir.
  const seen = []
  await runCycle(db, organizationId, (prepared) => { seen.push(prepared); return SUCCESS() })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].resolvedDesi, 2)
  after = await jobs(db)
  assert.equal(after['4111000031'].status, 'READY')
})

test('AL-31b: bagimlilik canlandirmasi READY/UNKNOWN satirlara DOKUNMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const queue = await import('./shipments/labelJobQueue.ts')
  for (const [packageId, status] of [
    ['4111000032', 'READY'],
    ['4111000033', 'UNKNOWN_AFTER_NETWORK'],
    ['4111000034', 'PREPARING'],
  ]) {
    await seedPackage(db, organizationId, packageId, {
      jobStatus: status, lastErrorCode: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
    })
    const revived = await queue.reactivateDependencyBlockedJob(db, {
      organizationId, marketplace: 'Trendyol', carrier: 'surat', packageId,
    })
    assert.equal(revived, false, `${status} satiri canlandirildi`)
  }
  const after = await jobs(db)
  assert.equal(after['4111000032'].status, 'READY')
  assert.equal(after['4111000033'].status, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(after['4111000034'].status, 'PREPARING')
})

/* ═══ AL-23 — üretim ESM grafı ═══════════════════════════════════════ */

test('AL-23: URETIM ithalat grafinin TAMAMI Node ile cozulur', async () => {
  const { auditProductionImportGraph } = await import(
    './testing/productionImportGraph.mjs'
  )
  const result = auditProductionImportGraph(join(here, 'index.mjs'))
  assert.ok(result.visited.length > 80, `graf cok kucuk: ${result.visited.length}`)
  assert.deepEqual(
    result.violations.map((v) => `${v.reason} ${v.specifier}`), [],
    'Node cozemeyecek import(lar) var',
  )
})

/* ═══ AL-27 — catch-up güvenliği ═════════════════════════════════════ */

test('AL-27: catch-up GUVENSIZ paketleri SECMEZ ve tasiyiciyi CAGIRMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const producer = await import('./shipments/autoLabelProducer.ts')
  await producer.activateAutoLabel(db, organizationId, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })
  const catchup = await import('./shipments/autoLabelCatchup.ts')

  for (const [packageId, status] of [
    ['4111000041', 'Delivered'], ['4111000042', 'Cancelled'],
    ['4111000043', 'Shipped'], ['4111000044', 'Returned'],
  ]) {
    await seedPackage(db, organizationId, packageId, {
      job: null, marketplaceStatus: status,
      firstSeenAt: new Date('2026-08-10T00:00:00.000Z'),
      orderDate: new Date('2026-08-10T00:00:00.000Z'),
    })
  }
  const report = await catchup.inspectCatchupCandidates(db, {
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
  })
  assert.equal(report.eligible, 0, 'terminal statuler aday secildi')
  assert.equal(report.carrierCalls ?? 0, 0)
})

/* ═══ AL-28 — parite ═════════════════════════════════════════════════ */

test('AL-28: secici / on kontrol / run-once / worker AYNI hazirligi turetir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4111000051')
  await seedPackage(db, organizationId, '4111000052', {
    marketplaceStatus: 'Created',
  })

  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  const { preflightLabelJob } = await import('./shipments/labelJobPreflight.ts')
  const selector = await import('./shipments/canaryCandidateSelector.ts')
  const report = await selector.selectCanaryCandidates(db, { organizationId })

  for (const packageId of ['4111000051', '4111000052']) {
    const prepared = await prepareLabelJob(db, {
      organizationId, packageId, marketplace: 'Trendyol',
    })
    const preflight = await preflightLabelJob(db, { organizationId, packageId })
    const candidate = report.candidates.find((c) => c.packageId === packageId)
    assert.equal(preflight.resolvedDesi, prepared.resolvedDesi, packageId)
    assert.equal(preflight.preflightValid, prepared.ok, packageId)
    assert.equal(preflight.eligibleForCreate, prepared.eligibleForCreate, packageId)
    assert.equal(candidate.resolvedDesi, prepared.resolvedDesi, packageId)
    assert.equal(candidate.wouldCallCarrier, prepared.ok, packageId)
  }
})

/* ═══ AL-32 — özellik/değişmez testleri ══════════════════════════════ */

test('AL-32: DEGISMEZLER — sinif fonksiyonu uzerinde ozellik testi', async () => {
  const { classifyStalePreparing } = await import(
    './shipments/stalePreparingClassifier.ts'
  )
  const booleans = [false, true]
  let checked = 0
  for (const carrierCreateCalled of booleans) {
    for (const carrierArtifactExists of booleans) {
      for (const readyLabelExists of booleans) {
        for (const preparationValid of booleans) {
          for (const lockAgeMs of [0, 3600_000]) {
            const verdict = classifyStalePreparing({
              status: 'PREPARING', lockedAt: new Date(), lockAgeMs,
              staleAfterMs: 600_000, carrierCreateCalled, createCallCount: 7,
              carrierArtifactExists, readyLabelExists,
              unknownAfterNetworkEvidence: false, preparationValid,
            })
            checked += 1
            // DEGISMEZ 1: tasiyiciya gidilmisse ve artefakt yoksa,
            // hicbir yol KUYRUGA donmez.
            if (carrierCreateCalled && !carrierArtifactExists && !readyLabelExists) {
              assert.notEqual(verdict.targetStatus, 'QUEUED')
              assert.equal(verdict.safeToRecover, false)
            }
            // DEGISMEZ 2: artefakt varsa sonuc create DEGIL, uzlastirmadir.
            if (carrierArtifactExists || readyLabelExists) {
              assert.equal(verdict.targetStatus, 'READY')
            }
            // DEGISMEZ 3: kuyruga donus YALNIZ kanit yokken VE hazirlik
            // gecerliyken VE kilit bayatken olur.
            if (verdict.targetStatus === 'QUEUED') {
              assert.equal(carrierCreateCalled, false)
              assert.equal(preparationValid, true)
              assert.ok(lockAgeMs >= 600_000)
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 32)
})

/* ═══ AL-33 — operatör araçları güvenliği ════════════════════════════ */

test('AL-33: HICBIR operator araci merkezi guvenlik kapilarini ATLAMAZ', async () => {
  const tools = [
    'canaryCandidateSelector.ts', 'canaryCandidateCli.ts',
    'singleLabelJobRunner.ts', 'singleLabelJobRunnerCli.ts',
    'blockedJobRecovery.ts', 'blockedJobRecoveryCli.ts',
    'staleJobRecovery.ts', 'staleJobRecoveryCli.ts',
    'canaryObserverCli.ts', 'workerBootstrapPreflightCli.ts',
    'legacyRetryQuarantine.ts', 'autoLabelCatchup.ts',
  ]
  for (const tool of tools) {
    const source = readFileSync(join(here, 'shipments', tool), 'utf8')
    // Hicbir arac dogrudan Surat agina cikmaz.
    assert.ok(
      !/await fetch\(/.test(source),
      `${tool} DOGRUDAN ag cagrisi yapiyor`,
    )
    // Hicbir arac genel talep sorgusunu kullanmaz.
    assert.ok(
      !/\bclaimLabelJobs\s*\(/.test(source),
      `${tool} toplu talep sorgusunu kullaniyor`,
    )
  }
})

test('REG: kabul paketi uretim cozucusunde ve suitede KAYITLI', async () => {
  const self = readFileSync(join(here, 'auto-label-acceptance-flow.test.mjs'), 'utf8')
  const importsVite = self
    .split(String.fromCharCode(10))
    .some((line) => /^\s*import\s/.test(line) && /vite/.test(line))
  assert.equal(importsVite, false)
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/auto-label-acceptance-flow.test.mjs'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts['test:auto-label:acceptance'])
})

/* ═══ AL-34 — ortam pariteti ═════════════════════════════════════════ */

test('AL-34: operator araclari sunucuyla AYNI ortami cozer', async () => {
  const tools = [
    'workerBootstrapPreflightCli.ts', 'staleJobRecoveryCli.ts',
    'blockedJobRecoveryCli.ts', 'canaryCandidateCli.ts',
    'canaryObserverCli.ts', 'singleLabelJobRunnerCli.ts',
    'legacyRetryQuarantineCli.ts', 'autoLabelCatchupCli.ts',
  ]
  for (const tool of tools) {
    const source = readFileSync(join(here, 'shipments', tool), 'utf8')
    assert.match(
      source, /loadRepositoryEnv\(\)/,
      `${tool} sunucunun .env dosyasini YUKLEMIYOR — yanlis "MISSING" raporlar`,
    )
  }
  // Sunucu da AYNI uygulamayi kullanir; ikinci kopya YOK.
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(server, /sharedLoadLocalEnvFile\(path\)/)
  assert.match(server, /from '\.\/runtime\/localEnv\.ts'/)

  // Tanimli deger EZILMEZ: surec yoneticisi dosyadan ONCELIKLIDIR.
  const loader = readFileSync(join(here, 'runtime', 'localEnv.ts'), 'utf8')
  assert.match(loader, /process\.env\[key\] != null\) continue/)
})

/* ═══ AL-35 — sanitizasyon ═══════════════════════════════════════════ */

test('AL-35: teshis metinleri SIR SIZDIRMAZ', async () => {
  const { sanitizeDiagnostic } = await import('./shipments/labelJobPreparation.ts')
  const secrets = [
    randomBytes(32).toString('hex'),
    randomBytes(32).toString('base64'),
  ]
  for (const secret of secrets) {
    const dirty =
      `connect postgres://cf:${secret}@10.1.2.3:5432/db `
      + `password=${secret} apikey=${secret} token=${secret} key=${secret}`
    const clean = sanitizeDiagnostic(dirty)
    assert.ok(!clean.includes(secret), 'SIR SIZDI')
    assert.ok(!clean.includes('10.1.2.3'), 'baglanti dizesi SIZDI')
  }
})
