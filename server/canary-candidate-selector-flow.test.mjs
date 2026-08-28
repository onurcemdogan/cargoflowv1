import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ KANARYA ADAYI SEÇİCİ + AÇIK KUYRUK KANARYASI ═══════════════════════
//
// Worker kapalıyken kuyrukta işler birikti. Global worker'ı açmak hepsini
// birden taşıyıcıya göndermek olurdu. Önce TEK paketle kanıt alınır — ama
// hangi paketin güvenli olduğu TAHMİNLE seçilemez.
//
// Bu dosya şunları sabitler:
//   • Seçici SALT OKUNUR: yazım, ağ ve taşıyıcı çağrısı YOK.
//   • Aday olabilmek için HER kapı açık olmalı.
//   • `--allow-queued-canary` VERİLMEDİKÇE QUEUED iş İŞLENMEZ.
//   • Bayrakla bile YALNIZ istenen tek satır, `attempt_count=0` iken alınır.
//   • Diğer QUEUED satırlar DOKUNULMAZ.
//   • UNKNOWN_AFTER_NETWORK paket (4110109345) HİÇBİR ŞEKİLDE açılmaz.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
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

/** Üretimdeki UNKNOWN paket — ASLA açılmaz. */
const UNKNOWN_PACKAGE = '4110109345'
const QUEUED = ['4110346669', '4110352749', '4110388725']

async function seedOrder(db, organizationId, packageId, options = {}) {
  const encryption = await load('/server/orders/orderEncryption.ts')
  await db.insert(schema.orders).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId,
    orderNumber: `ORD-${packageId}`,
    orderDate: new Date('2026-08-25T00:00:00.000Z'),
    cargoTrackingNumber: `7280${packageId.slice(-6)}`,
    operationStatus: 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Picking',
    cargoProviderName: options.cargoProviderName ?? 'Surat Kargo',
    firstSeenAt: new Date('2026-08-25T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload({
      orderNumber: `ORD-${packageId}`, id: packageId,
    }),
  })
}

async function seed(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()
  const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
  await defaults.saveShipmentDefaults(db, org.id, {
    defaultUnitDesi: 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  const credentials = await load('/server/integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })

  // Üretimdeki UNKNOWN satır — dokunulmaz olmalı.
  await seedOrder(db, org.id, UNKNOWN_PACKAGE)
  await db.insert(schema.labelJobs).values({
    organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
    packageId: UNKNOWN_PACKAGE, jobType: 'LABEL_PREPARE',
    status: 'UNKNOWN_AFTER_NETWORK', attemptCount: 26,
    lastErrorCode: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  })

  for (const packageId of QUEUED) {
    await seedOrder(db, org.id, packageId, options[packageId] ?? {})
    await db.insert(schema.labelJobs).values({
      organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
      packageId, jobType: 'LABEL_PREPARE', status: 'QUEUED', attemptCount: 0,
    })
  }
  if (options.extra) await options.extra(db, org.id)
  return org.id
}

/* ═══ CANDIDATES-1 ═══════════════════════════════════════════════════ */

test('CANDIDATES-1: SALT OKUNUR — yazim, ag, tasiyici cagrisi YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const selector = await load('/server/shipments/canaryCandidateSelector.ts')
  const organizationId = await seed(db)
  const before = await db.select().from(schema.labelJobs)

  const report = await selector.selectCanaryCandidates(db, { organizationId })

  assert.equal(report.networkCalls, 0)
  assert.equal(report.dbWrites, 0)
  assert.equal(report.carrierCalls, 0)
  const after = await db.select().from(schema.labelJobs)
  assert.deepEqual(
    after.map((row) => [row.packageId, row.status, row.attemptCount]).sort(),
    before.map((row) => [row.packageId, row.status, row.attemptCount]).sort(),
  )
  assert.equal((await db.select().from(schema.shipments)).length, 0)
})

/* ═══ CANDIDATES-2 ═══════════════════════════════════════════════════ */

test('CANDIDATES-2: YALNIZ QUEUED isler aday; UNKNOWN paket LISTEDE YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const selector = await load('/server/shipments/canaryCandidateSelector.ts')
  const organizationId = await seed(db)

  const report = await selector.selectCanaryCandidates(db, { organizationId })
  assert.equal(report.queuedTotal, 3)
  assert.equal(report.safeCount, 3)
  assert.deepEqual(
    report.candidates.map((candidate) => candidate.packageId).sort(),
    [...QUEUED].sort(),
  )
  // UNKNOWN paket aday DEĞİLDİR.
  assert.ok(!report.candidates.some((c) => c.packageId === UNKNOWN_PACKAGE))

  for (const candidate of report.candidates) {
    assert.equal(candidate.safeCanary, true, candidate.blockers.join(','))
    assert.equal(candidate.attemptCount, 0)
    assert.equal(candidate.resolvedDesi, 2)
    assert.equal(candidate.suratBirimDesi, 2)
    assert.equal(candidate.billingParty, 'TRENDYOL_PAYS')
    assert.equal(candidate.expectedWhoPays, 3)
    assert.equal(candidate.credentialRole, 'PRIMARY_MARKETPLACE')
    assert.equal(candidate.credentialResolved, true)
    assert.equal(candidate.wouldCallCarrier, true)
  }
  // DETERMİNİSTİK SIRA.
  const safe = report.candidates.filter((c) => c.safeCanary)
  assert.deepEqual(
    safe.map((c) => c.packageId),
    [...safe.map((c) => c.packageId)].sort((a, b) => a.localeCompare(b)),
  )
})

/* ═══ CANDIDATES-3 ═══════════════════════════════════════════════════ */

test('CANDIDATES-3: uygun olmayan statu ADAY DEGIL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const selector = await load('/server/shipments/canaryCandidateSelector.ts')
  const organizationId = await seed(db, {
    [QUEUED[0]]: { marketplaceStatus: 'Created' },
    [QUEUED[1]]: { marketplaceStatus: 'Cancelled' },
  })

  const report = await selector.selectCanaryCandidates(db, { organizationId })
  const byPackage = Object.fromEntries(
    report.candidates.map((candidate) => [candidate.packageId, candidate]),
  )
  assert.equal(byPackage[QUEUED[0]].safeCanary, false)
  assert.equal(byPackage[QUEUED[1]].safeCanary, false)
  assert.equal(byPackage[QUEUED[2]].safeCanary, true)
  assert.equal(report.safeCount, 1)
  for (const packageId of [QUEUED[0], QUEUED[1]]) {
    assert.ok(
      byPackage[packageId].blockers.includes('TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'),
      byPackage[packageId].blockers.join(','),
    )
  }
})

/* ═══ CANDIDATES-4 ═══════════════════════════════════════════════════ */

test('CANDIDATES-4: artefakt / kayitli cagri / mukerrer → ADAY DEGIL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const selector = await load('/server/shipments/canaryCandidateSelector.ts')
  const organizationId = await seed(db, {
    extra: async (database, orgId) => {
      await database.insert(schema.shipments).values({
        organizationId: orgId, marketplace: 'Trendyol', packageId: QUEUED[0],
        provider: 'surat', trackingNumber: '7280000001',
        source: 'local_create', status: 'created',
      })
      await database.insert(schema.shipmentOperations).values({
        organizationId: orgId, marketplace: 'Trendyol', packageId: QUEUED[1],
        orderNumber: `ORD-${QUEUED[1]}`, provider: 'surat',
        operationType: 'create',
        idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
        status: 'failed', createCallCount: 1, carrierCreateCalled: true,
      })
      // Mükerrer iş satırı (farklı jobType ile aynı paket).
      await database.insert(schema.labelJobs).values({
        organizationId: orgId, marketplace: 'Trendyol', carrier: 'surat',
        packageId: QUEUED[2], jobType: 'LABEL_REPRINT',
        status: 'BLOCKED', attemptCount: 0,
      })
    },
  })

  const report = await selector.selectCanaryCandidates(db, { organizationId })
  const byPackage = Object.fromEntries(
    report.candidates.map((candidate) => [candidate.packageId, candidate]),
  )
  assert.equal(byPackage[QUEUED[0]].carrierArtifactExists, true)
  assert.equal(byPackage[QUEUED[0]].safeCanary, false)
  assert.equal(byPackage[QUEUED[1]].carrierCallRecorded, true)
  assert.equal(byPackage[QUEUED[1]].safeCanary, false)
  assert.equal(byPackage[QUEUED[2]].duplicateJob, true)
  assert.equal(byPackage[QUEUED[2]].safeCanary, false)
  assert.equal(report.safeCount, 0)
})

/* ═══ QUEUED-CANARY-1 ════════════════════════════════════════════════ */

test('QUEUED-CANARY-1: bayrak YOKSA QUEUED is REDDEDILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const calls = { count: 0 }

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: QUEUED[0], workerId: 'test',
    runLabel: async () => {
      calls.count += 1
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(report.gatesPassed, false)
  assert.equal(calls.count, 0)
  assert.ok(
    report.blockers.some((blocker) => blocker.includes('IS_DURUMU_UYGUN_DEGIL')),
    report.blockers.join(','),
  )
  const rows = await db.select().from(schema.labelJobs)
  for (const packageId of QUEUED) {
    const row = rows.find((entry) => entry.packageId === packageId)
    assert.equal(row.status, 'QUEUED')
    assert.equal(row.attemptCount, 0)
  }
})

/* ═══ QUEUED-CANARY-2 ════════════════════════════════════════════════ */

test('QUEUED-CANARY-2: bayrakla YALNIZ hedef satir alinir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const seen = []

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: QUEUED[0], workerId: 'test',
    expectedDesi: 2, allowQueuedCanary: true,
    runLabel: async (job) => {
      seen.push(job.packageId)
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })

  assert.equal(report.gatesPassed, true, report.blockers.join(','))
  assert.deepEqual(seen, [QUEUED[0]])
  assert.equal(report.statusBefore, 'QUEUED')
  assert.equal(report.statusAfter, 'READY')
  assert.equal(report.attemptCountBefore, 0)
  assert.equal(report.attemptCountAfter, 1)
  assert.equal(report.totalCarrierCalls, 1)
  assert.equal(report.otherQueuedJobsTouched, 0)

  const rows = await db.select().from(schema.labelJobs)
  // Diğer iki kuyruk işi DOKUNULMADI.
  for (const packageId of QUEUED.slice(1)) {
    const row = rows.find((entry) => entry.packageId === packageId)
    assert.equal(row.status, 'QUEUED', packageId)
    assert.equal(row.attemptCount, 0, packageId)
  }
  // UNKNOWN satır DOKUNULMADI.
  const unknown = rows.find((entry) => entry.packageId === UNKNOWN_PACKAGE)
  assert.equal(unknown.status, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(unknown.attemptCount, 26)
})

/* ═══ QUEUED-CANARY-3 ════════════════════════════════════════════════ */

test('QUEUED-CANARY-3: DENENMIS QUEUED satir bayrakla bile ALINMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  // YALNIZ hedef satirin sayacini artir.
  const { eq } = await import('drizzle-orm')
  const rows = await db.select().from(schema.labelJobs)
  const target = rows.find((row) => row.packageId === QUEUED[0])
  await db
    .update(schema.labelJobs)
    .set({ attemptCount: 1 })
    .where(eq(schema.labelJobs.id, target.id))
  const calls = { count: 0 }

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: QUEUED[0], workerId: 'test',
    allowQueuedCanary: true,
    runLabel: async () => {
      calls.count += 1
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(report.gatesPassed, false)
  assert.equal(calls.count, 0)
  assert.ok(
    report.blockers.some((blocker) => blocker.includes('KUYRUK_KANARYASI_DENENMIS')),
    report.blockers.join(','),
  )
})

/* ═══ UNKNOWN-SAFETY ═════════════════════════════════════════════════ */

test('UNKNOWN-SAFETY: 4110109345 bayrakla bile ACILMAZ ve DOKUNULMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const calls = { count: 0 }

  for (const options of [{}, { allowQueuedCanary: true }]) {
    const report = await runner.runSingleLabelJob(db, {
      organizationId, packageId: UNKNOWN_PACKAGE, workerId: 'test',
      ...options,
      runLabel: async () => {
        calls.count += 1
        return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
      },
    })
    assert.equal(report.gatesPassed, false)
    assert.equal(report.totalCarrierCalls, 0)
    assert.equal(report.carrierCallStarted, false)
    assert.ok(
      report.blockers.some((blocker) =>
        blocker.includes('IS_DURUMU_UYGUN_DEGIL(UNKNOWN_AFTER_NETWORK)')),
      report.blockers.join(','),
    )
  }
  assert.equal(calls.count, 0, 'UNKNOWN pakette tasiyiciya CIKILDI')

  const rows = await db.select().from(schema.labelJobs)
  const unknown = rows.find((row) => row.packageId === UNKNOWN_PACKAGE)
  assert.equal(unknown.status, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(unknown.attemptCount, 26, 'attempt_count DEGISTI')
})

/* ═══ TOPLU TALEP KULLANILMAZ ════════════════════════════════════════ */

test('QUEUED-CANARY-REG: kuyruk kanaryasi da toplu sorgu KULLANMAZ', async () => {
  const source = readFileSync(
    join(here, 'shipments', 'singleLabelJobRunner.ts'), 'utf8',
  )
  assert.ok(!/\bclaimLabelJobs\s*\(/.test(source))
  // Gercek bir SQL LIMIT'i olmamali (yorum metnindeki kelime sayilmaz).
  assert.ok(!/LIMIT \$\{/.test(source), 'SQL LIMIT sorgusu EKLENMIS')
  assert.ok(!/\.limit\(/.test(source), 'limit() cagrisi EKLENMIS')
  // Kuyruk talebi TAM koşullu olmalıdır.
  assert.match(source, /AND j\.status = 'QUEUED'\s*\n\s*AND j\.attempt_count = 0/)

  const selector = readFileSync(
    join(here, 'shipments', 'canaryCandidateSelector.ts'), 'utf8',
  )
  assert.ok(!/\bclaimLabelJobs\s*\(/.test(selector))
  // Seçici hiçbir şey YAZMAZ.
  assert.ok(!/\.update\(|\.insert\(|\.delete\(/.test(selector))
})
