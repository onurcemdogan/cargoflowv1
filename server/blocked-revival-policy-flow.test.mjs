import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// ═══ BLOKE SATIR CANLANDIRMA SÖZLEŞMESİ ═════════════════════════════════
//
// ÜRETİM OLAYI (commit 41c44ab, worker KAPALI): dağıtım/üretici etkinliği
// sonrası ESKİ bloke satırlar toplu hâlde QUEUED'e çekildi:
//     4110043440 attempt=37 status=Shipped   → QUEUED
//     4110126395 attempt=20 status=Shipped   → QUEUED
//     4110143271 attempt=16 status=Shipped   → QUEUED
//     4110188925 attempt=8  status=Shipped   → QUEUED
//     4111338022 / 4111412351 / 4111508763 (Created) → QUEUED
// Hepsinin paylaşılan ön kontrolü `PREFLIGHT_VALID=false` diyordu.
//
// ═══ KÖK NEDEN ═══════════════════════════════════════════════════════════
// Üretici uygunluğu `resolveSuratCreateEligibility` ile ölçüyordu; o
// fonksiyon `marketplaceStatus` alanını HİÇ OKUMAZ (repoda 0 geçiş). Yani
// pazaryeri yaşam döngüsü kapısı YOKTU ve canlandırma koşulu fiilen
// "satır var + paket yeniden görüldü" idi — "BLOKE'ye yol açan bağımlılık
// çözüldü mü?" DEĞİL.
//
// Taşıyıcı çağrısı sıfır kalsa bile bu, deterministik hata kararlılığını ve
// tekrar-döngüsü-yok değişmezini İHLAL EDER.
//
// Bu dosya VITE KULLANMAZ. GERÇEK TAŞIYICI ÇAĞRISI YOKTUR.

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

const ACTIVATED_AT = new Date('2026-08-01T00:00:00.000Z')

async function makeTenant(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()
  if (options.desi !== null) {
    const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
    await defaults.saveShipmentDefaults(db, org.id, {
      defaultUnitDesi: options.desi ?? 2, multiplyByItemQuantity: false,
      labelPrintTemplate: 'cargoflow_html',
    })
  }
  if (options.credentials !== null) {
    const credentials = await import('./integrations/credentialService.ts')
    await credentials.saveIntegrationCredential(db, org.id, 'surat', {
      liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
    })
  }
  const producer = await import('./shipments/autoLabelProducer.ts')
  await producer.activateAutoLabel(db, org.id, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })
  return org.id
}

async function seedBlocked(db, organizationId, packageId, options = {}) {
  const encryption = await import('./orders/orderEncryption.ts')
  await db.insert(schema.orders).values({
    organizationId, marketplace: 'Trendyol', packageId,
    orderNumber: `ORD-${packageId}`,
    orderDate: new Date('2026-08-20T00:00:00.000Z'),
    cargoTrackingNumber: `7281${packageId.slice(-6)}`,
    operationStatus: 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Created',
    cargoProviderName: 'Surat Kargo',
    firstSeenAt: new Date('2026-08-20T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload({
      orderNumber: `ORD-${packageId}`, id: packageId,
    }),
  })
  await db.insert(schema.labelJobs).values({
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId, jobType: 'LABEL_PREPARE',
    status: options.jobStatus ?? 'BLOCKED',
    attemptCount: options.attemptCount ?? 1,
    lastErrorCode: options.lastErrorCode ?? 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  })
}

async function runProducer(db, organizationId, times = 1) {
  const producer = await import('./shipments/autoLabelProducer.ts')
  let last
  for (let index = 0; index < times; index += 1) {
    last = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  }
  return last
}

async function job(db, packageId) {
  const rows = await db.select().from(schema.labelJobs)
  return rows.find((row) => row.packageId === packageId)
}

/* ═══ AL-66 / AL-73 / AL-80 ══════════════════════════════════════════ */

test('AL-66/73/80: Created BLOKE + 100 tekrar olay → BLOKE kalir, sayac SABIT', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedBlocked(db, organizationId, '4111338022', {
    marketplaceStatus: 'Created', attemptCount: 1,
  })
  const before = await job(db, '4111338022')

  await runProducer(db, organizationId, 100)

  const after = await job(db, '4111338022')
  assert.equal(after.status, 'BLOCKED', 'Created paket UYANDIRILDI')
  assert.equal(after.attemptCount, 1, 'attempt_count DEGISTI')
  assert.equal(after.id, before.id)
  // Durum degismediginde YAZIM da olmaz: churn YOK.
  assert.equal(
    after.updatedAt.getTime(), before.updatedAt.getTime(),
    'durum degismeden updated_at degisti (churn)',
  )
  assert.equal((await db.select().from(schema.labelJobs)).length, 1)
})

/* ═══ AL-67 / AL-82 — üretimdeki TAM şekil ═══════════════════════════ */

test('AL-67/82: Shipped BLOKE (attempt=37) Stream olayiyla ASLA canlanmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  // Uretimde gozlenen TAM sekil.
  for (const [packageId, attempt] of [
    ['4110043440', 37], ['4110126395', 20],
    ['4110143271', 16], ['4110188925', 8],
  ]) {
    await seedBlocked(db, organizationId, packageId, {
      marketplaceStatus: 'Shipped', attemptCount: attempt,
    })
  }

  await runProducer(db, organizationId, 25)

  for (const [packageId, attempt] of [
    ['4110043440', 37], ['4110126395', 20],
    ['4110143271', 16], ['4110188925', 8],
  ]) {
    const row = await job(db, packageId)
    assert.equal(row.status, 'BLOCKED', `${packageId} Shipped iken canlandirildi`)
    assert.equal(row.attemptCount, attempt, `${packageId} sayaci degisti`)
  }
})

/* ═══ AL-68 / AL-69 / AL-70 ══════════════════════════════════════════ */

test('AL-68/69/70: Delivered / Returned / Cancelled ASLA QUEUED olmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  for (const [packageId, status] of [
    ['4111000068', 'Delivered'],
    ['4111000069', 'Returned'],
    ['4111000070', 'Cancelled'],
    ['4111000071', 'UnDelivered'],
    ['4111000072', 'UnSupplied'],
  ]) {
    await seedBlocked(db, organizationId, packageId, { marketplaceStatus: status })
  }

  await runProducer(db, organizationId, 10)

  for (const packageId of [
    '4111000068', '4111000069', '4111000070', '4111000071', '4111000072',
  ]) {
    const row = await job(db, packageId)
    assert.equal(row.status, 'BLOCKED', `${packageId} terminal statuden canlandirildi`)
  }
})

/* ═══ AL-71 / AL-72 / AL-83 ══════════════════════════════════════════ */

test('AL-71/72/83: Created → Picking BIR KEZ canlanir, tekrar olaylar CHURN URETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedBlocked(db, organizationId, '4111412351', {
    marketplaceStatus: 'Created', attemptCount: 1,
  })
  const before = await job(db, '4111412351')

  // Created iken tekrar tekrar gorulse bile BLOKE kalir.
  await runProducer(db, organizationId, 5)
  assert.equal((await job(db, '4111412351')).status, 'BLOCKED')

  // Paket Picking'e gecti — BAGIMLILIK COZULDU.
  await db.update(schema.orders)
    .set({ marketplaceStatus: 'Picking' })
    .where(and(
      eq(schema.orders.organizationId, organizationId),
      eq(schema.orders.packageId, '4111412351'),
    ))

  await runProducer(db, organizationId, 1)
  const revived = await job(db, '4111412351')
  assert.equal(revived.status, 'QUEUED')
  assert.equal(revived.id, before.id, 'YENI is satiri yaratildi')
  assert.equal(revived.attemptCount, 1, 'canlandirma sayaci degistirdi')
  assert.equal((await db.select().from(schema.labelJobs)).length, 1)

  // Tekrarlanan Picking olaylari IKINCI gecis URETMEZ.
  const afterFirst = await job(db, '4111412351')
  await runProducer(db, organizationId, 10)
  const afterRepeat = await job(db, '4111412351')
  assert.equal(afterRepeat.status, 'QUEUED')
  assert.equal(afterRepeat.attemptCount, 1)
  assert.equal(
    afterRepeat.updatedAt.getTime(), afterFirst.updatedAt.getTime(),
    'tekrarlanan olay churn uretti',
  )
})

test('AL-71b: Picking → Shipped, worker talep etmeden ONCE → create YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedBlocked(db, organizationId, '4111000090', {
    marketplaceStatus: 'Picking', jobStatus: 'QUEUED', attemptCount: 0,
  })
  // Worker talep etmeden once paket Shipped oldu.
  await db.update(schema.orders)
    .set({ marketplaceStatus: 'Shipped' })
    .where(and(
      eq(schema.orders.organizationId, organizationId),
      eq(schema.orders.packageId, '4111000090'),
    ))

  const worker = await import('./shipments/labelJobWorker.ts')
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  let calls = 0
  await worker.runLabelJobCycle({
    db, workerId: 'terminal-test',
    runLabel: async (claimed) => {
      const prepared = await prepareLabelJob(db, {
        organizationId, packageId: claimed.packageId,
        marketplace: claimed.marketplace,
      })
      if (!prepared.ok) {
        return {
          labelReady: false, networkCrossed: false, blocked: true,
          errorCode: prepared.blockerCode,
          errorSummary: prepared.errorSummary, carrierCalls: 0,
        }
      }
      calls += 1
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(calls, 0, 'Shipped pakette tasiyiciya CIKILDI')
  const row = await job(db, '4111000090')
  assert.equal(row.status, 'BLOCKED')
  assert.equal(row.lastErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
})

/* ═══ AL-74 / AL-75 / AL-76 ══════════════════════════════════════════ */

test('AL-74/75/76: desi ve kimlik bagimliligi COZULMEDEN canlanmaz, COZULUNCE canlanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  // Desi ayari YOK, kimlik YOK.
  const organizationId = await makeTenant(db, { desi: null, credentials: null })
  await seedBlocked(db, organizationId, '4111000074', {
    marketplaceStatus: 'Picking',
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  })

  // Bagimlilik COZULMEDI → tekrarlanan olaylar CANLANDIRMAZ.
  await runProducer(db, organizationId, 20)
  assert.equal((await job(db, '4111000074')).status, 'BLOCKED')
  assert.equal((await job(db, '4111000074')).attemptCount, 1)

  // Desi ayarlandi ama KIMLIK hala yok → HALA canlanmaz.
  const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
  await defaults.saveShipmentDefaults(db, organizationId, {
    defaultUnitDesi: 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  await runProducer(db, organizationId, 5)
  assert.equal(
    (await job(db, '4111000074')).status, 'BLOCKED',
    'kimlik eksikken canlandirildi',
  )

  // Kimlik de eklendi → TAM hazirlik gecerli → canlanir.
  const credentials = await import('./integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, organizationId, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })
  await runProducer(db, organizationId, 1)
  assert.equal((await job(db, '4111000074')).status, 'QUEUED')
})

test('AL-76b: ayar kaydi tetikli canlandirma da GUNCEL hazirliga sorar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { credentials: null })
  // Shipped paket, desi hatasiyla bloke.
  await seedBlocked(db, organizationId, '4111000077', {
    marketplaceStatus: 'Shipped',
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  })
  const queue = await import('./shipments/labelJobQueue.ts')

  const revived = await queue.reactivateBlockedLabelJobs(db, {
    organizationId, errorCodes: ['SURAT_PREFLIGHT_DESI_MISSING'],
  })
  assert.equal(revived, 0, 'Shipped paket ayar kaydiyla canlandirildi')
  assert.equal((await job(db, '4111000077')).status, 'BLOCKED')
})

/* ═══ AL-77 / AL-78 / AL-79 ══════════════════════════════════════════ */

test('AL-77/78/79: UNKNOWN, READY ve tasiyici-cagrilmis ASLA canlandirilmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedBlocked(db, organizationId, '4111000077', {
    marketplaceStatus: 'Picking', jobStatus: 'UNKNOWN_AFTER_NETWORK',
  })
  await seedBlocked(db, organizationId, '4111000078', {
    marketplaceStatus: 'Picking', jobStatus: 'READY',
  })
  await seedBlocked(db, organizationId, '4111000079', {
    marketplaceStatus: 'Picking',
  })
  await db.insert(schema.shipmentOperations).values({
    organizationId, marketplace: 'Trendyol', packageId: '4111000079',
    orderNumber: 'ORD-4111000079', provider: 'surat',
    operationType: 'OrtakBarkodOlustur',
    idempotencyKey: 'idem-4111000079', status: 'pending',
    createCallCount: 1, carrierCreateCalled: true,
  })

  await runProducer(db, organizationId, 10)
  const queue = await import('./shipments/labelJobQueue.ts')
  for (const packageId of ['4111000077', '4111000078', '4111000079']) {
    await queue.reactivateDependencyBlockedJob(db, {
      organizationId, marketplace: 'Trendyol', carrier: 'surat', packageId,
    })
  }

  assert.equal((await job(db, '4111000077')).status, 'UNKNOWN_AFTER_NETWORK')
  assert.equal((await job(db, '4111000078')).status, 'READY')
  assert.equal(
    (await job(db, '4111000079')).status, 'BLOCKED',
    'tasiyiciya gidilmis paket canlandirildi',
  )
})

/* ═══ AL-81 — eşzamanlı kaynaklar ════════════════════════════════════ */

test('AL-81: eszamanli senkron kaynaklari TEK gecis uretir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedBlocked(db, organizationId, '4111000081', {
    marketplaceStatus: 'Picking', attemptCount: 3,
  })
  const queue = await import('./shipments/labelJobQueue.ts')

  // Uc kaynak AYNI ANDA ayni bloke satiri gorur.
  const results = await Promise.all([
    queue.reactivateDependencyBlockedJob(db, {
      organizationId, marketplace: 'Trendyol', carrier: 'surat',
      packageId: '4111000081',
    }),
    queue.reactivateDependencyBlockedJob(db, {
      organizationId, marketplace: 'Trendyol', carrier: 'surat',
      packageId: '4111000081',
    }),
    queue.reactivateDependencyBlockedJob(db, {
      organizationId, marketplace: 'Trendyol', carrier: 'surat',
      packageId: '4111000081',
    }),
  ])
  assert.equal(
    results.filter(Boolean).length, 1,
    'ayni satir icin BIRDEN FAZLA gecis raporlandi',
  )
  const row = await job(db, '4111000081')
  assert.equal(row.status, 'QUEUED')
  // Uretici canlandirmasi sayaca DOKUNMAZ.
  assert.equal(row.attemptCount, 3)
  assert.equal((await db.select().from(schema.labelJobs)).length, 1)
})

/* ═══ CANLANDIRMA İNCELEYİCİSİ ═══════════════════════════════════════ */

test('REVIVAL-INSPECT: salt okunur ve her satir icin GEREKCE verir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedBlocked(db, organizationId, '4110043440', {
    marketplaceStatus: 'Shipped', attemptCount: 37,
  })
  await seedBlocked(db, organizationId, '4111412351', {
    marketplaceStatus: 'Created', attemptCount: 1,
  })
  await seedBlocked(db, organizationId, '4111000099', {
    marketplaceStatus: 'Picking', attemptCount: 1,
  })
  const inspector = await import('./shipments/revivalInspector.ts')
  const before = await db.select().from(schema.labelJobs)

  const report = await inspector.inspectRevivalCandidates(db, { organizationId })

  assert.equal(report.blockedTotal, 3)
  assert.equal(report.networkCalls, 0)
  assert.equal(report.dbWrites, 0)
  assert.equal(report.carrierCalls, 0)
  const byPackage = Object.fromEntries(
    report.candidates.map((candidate) => [candidate.packageId, candidate]),
  )
  assert.equal(byPackage['4110043440'].marketplaceLifecycle, 'TERMINAL')
  assert.equal(byPackage['4110043440'].safeToRevive, false)
  assert.equal(byPackage['4111412351'].marketplaceLifecycle, 'NOT_YET')
  assert.equal(byPackage['4111412351'].safeToRevive, false)
  assert.equal(byPackage['4111000099'].marketplaceLifecycle, 'ELIGIBLE')
  assert.equal(byPackage['4111000099'].safeToRevive, true)
  for (const candidate of report.candidates) {
    assert.ok(candidate.revivalReason.length > 10, 'gerekce YOK')
  }

  // SALT OKUNUR.
  const after = await db.select().from(schema.labelJobs)
  assert.deepEqual(
    after.map((r) => [r.packageId, r.status, r.attemptCount]).sort(),
    before.map((r) => [r.packageId, r.status, r.attemptCount]).sort(),
  )
})

/* ═══ KAYNAK DENETİMİ ════════════════════════════════════════════════ */

test('REVIVAL-REG: her QUEUED gecisi GEREKCELIDIR, genel "retry" YOK', async () => {
  // Uretici artik PAYLASILAN yasam dongusu kapisini kullanir.
  const producer = readFileSync(
    join(here, 'shipments', 'autoLabelProducer.ts'), 'utf8',
  )
  assert.match(producer, /classifyMarketplaceLifecycle\(row\)/)
  assert.match(producer, /lifecycle\.lifecycle !== 'ELIGIBLE'/)
  // Canlandirma GUNCEL hazirliga sorar.
  assert.match(producer, /if \(!prepared\.ok\) \{/)
  assert.match(producer, /DEPENDENCY_STILL_BLOCKED/)

  // Ayar tetikli canlandirma da AYNI ilkelden gecer; toplu kosulsuz
  // UPDATE KALMADI.
  const queue = readFileSync(join(here, 'shipments', 'labelJobQueue.ts'), 'utf8')
  const at = queue.indexOf('export async function reactivateBlockedLabelJobs')
  const body = queue.slice(at, at + 2600)
  assert.match(body, /prepareLabelJob\(db, \{/)
  assert.match(body, /reactivateDependencyBlockedJob\(db, \{/)
  assert.ok(!/\.update\(labelJobs\)/.test(body), 'toplu kosulsuz UPDATE geri geldi')

  // Canlandirma ilkeli KENDI BASINA tasiyici kaniti sorar.
  const primitive = queue.slice(
    queue.indexOf('export async function reactivateDependencyBlockedJob'),
    queue.indexOf('export async function reactivateBlockedLabelJobs'),
  )
  assert.match(primitive, /carrierCreateCalled === true/)
  assert.match(primitive, /artifacts\.length > 0/)

  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/blocked-revival-policy-flow.test.mjs'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(pkg.scripts['auto-label:revival:inspect'], /^node /)
})
