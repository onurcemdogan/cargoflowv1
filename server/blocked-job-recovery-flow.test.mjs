import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ BLOKE İŞ KURTARMA ══════════════════════════════════════════════════
//
// Parite kusuru yüzünden AĞDAN ÖNCE bloke olmuş satırlar var. Bağımlılık
// sağlandığında güvenle açılabilirler — ama seçim KANITA dayanır:
//   • taşıyıcı çağrısı kaydı YOK,
//   • artefakt YOK,
//   • bloklayıcı kod ağ-öncesi olduğunu KANITLIYOR,
//   • ve GÜNCEL paylaşılan hazırlık GEÇERLİ.
//
// `UNKNOWN_AFTER_NETWORK` ve `READY` ASLA açılmaz. Yeni iz olmaması bir
// KANIT DEĞİLDİR ve retry izni sayılmaz.

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

/** Üretimde parite kusuruyla bloke olan üç paket. */
const RECOVERABLE = ['4110388725', '4110561448', '4110667628']
/** Taşıyıcıya gidilmiş olabilecek paket — ASLA açılmaz. */
const UNKNOWN_PACKAGE = '4110109345'

async function seedOrder(db, organizationId, packageId, marketplaceStatus) {
  const encryption = await load('/server/orders/orderEncryption.ts')
  await db.insert(schema.orders).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId,
    orderNumber: `ORD-${packageId}`,
    orderDate: new Date('2026-08-27T00:00:00.000Z'),
    cargoTrackingNumber: `7280${packageId.slice(-6)}`,
    operationStatus: 'NEW',
    marketplaceStatus,
    cargoProviderName: 'Surat Kargo',
    firstSeenAt: new Date('2026-08-27T00:00:00.000Z'),
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
    defaultUnitDesi: options.desi ?? 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  const credentials = await load('/server/integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })

  for (const packageId of RECOVERABLE) {
    await seedOrder(db, org.id, packageId, 'Picking')
    await db.insert(schema.labelJobs).values({
      organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
      packageId, jobType: 'LABEL_PREPARE', status: 'BLOCKED', attemptCount: 1,
      lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
    })
  }
  // Taşıyıcıya gidilmiş paket — DOKUNULMAZ.
  await seedOrder(db, org.id, UNKNOWN_PACKAGE, 'Picking')
  await db.insert(schema.labelJobs).values({
    organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
    packageId: UNKNOWN_PACKAGE, jobType: 'LABEL_PREPARE',
    status: 'UNKNOWN_AFTER_NETWORK', attemptCount: 26,
    lastErrorCode: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  })
  if (options.extra) await options.extra(db, org.id)
  return org.id
}

/* ═══ RECOVERY-1 ═════════════════════════════════════════════════════ */

test('RECOVERY-1: inceleme SALT OKUNUR ve UNKNOWN satiri LISTELEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await load('/server/shipments/blockedJobRecovery.ts')
  const organizationId = await seed(db)
  const before = await db.select().from(schema.labelJobs)

  const report = await recovery.inspectBlockedJobs(db, { organizationId })

  assert.equal(report.networkCalls, 0)
  assert.equal(report.dbWrites, 0)
  assert.equal(report.carrierCalls, 0)
  assert.equal(report.blockedTotal, RECOVERABLE.length)
  // UNKNOWN_AFTER_NETWORK satiri LISTEDE YOK.
  assert.ok(!report.candidates.some((c) => c.packageId === UNKNOWN_PACKAGE))

  const after = await db.select().from(schema.labelJobs)
  assert.deepEqual(
    after.map((r) => [r.packageId, r.status, r.attemptCount]).sort(),
    before.map((r) => [r.packageId, r.status, r.attemptCount]).sort(),
  )
})

/* ═══ RECOVERY-2 ═════════════════════════════════════════════════════ */

test('RECOVERY-2: bagimlilik saglandiginda SAFE, saglanmadiginda DEGIL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await load('/server/shipments/blockedJobRecovery.ts')
  const organizationId = await seed(db)

  const report = await recovery.inspectBlockedJobs(db, { organizationId })
  assert.equal(report.safeCount, RECOVERABLE.length)
  for (const candidate of report.candidates) {
    assert.equal(candidate.safeToReactivate, true, candidate.reason)
    assert.equal(candidate.currentResolvedDesi, 2)
    assert.equal(candidate.currentEligibility, true)
    assert.equal(candidate.carrierCalled, false)
    assert.equal(candidate.artifact, false)
    // Tarihsel kanit KORUNUR.
    assert.equal(candidate.attemptCount, 1)
  }
})

test('RECOVERY-2b: bagimlilik HALA eksikse ACILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await load('/server/shipments/blockedJobRecovery.ts')
  // Kiracida desi ayari YOK → guncel hazirlik GECERSIZ.
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'NoDesi', slug: `nd-${randomBytes(4).toString('hex')}` })
    .returning()
  await seedOrder(db, org.id, RECOVERABLE[0], 'Picking')
  await db.insert(schema.labelJobs).values({
    organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
    packageId: RECOVERABLE[0], jobType: 'LABEL_PREPARE',
    status: 'BLOCKED', attemptCount: 1,
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  })

  const report = await recovery.inspectBlockedJobs(db, { organizationId: org.id })
  assert.equal(report.safeCount, 0)
  assert.equal(report.candidates[0].safeToReactivate, false)
  assert.match(report.candidates[0].reason, /Bağımlılık hâlâ sağlanmıyor/)
})

/* ═══ RECOVERY-3 ═════════════════════════════════════════════════════ */

test('RECOVERY-3: tasiyici cagrisi kanitli satir ACILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await load('/server/shipments/blockedJobRecovery.ts')
  const organizationId = await seed(db, {
    extra: async (database, orgId) => {
      await database.insert(schema.shipmentOperations).values({
        organizationId: orgId, marketplace: 'Trendyol',
        packageId: RECOVERABLE[0], orderNumber: `ORD-${RECOVERABLE[0]}`,
        provider: 'surat', operationType: 'create',
        idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
        status: 'failed', createCallCount: 1, carrierCreateCalled: true,
      })
    },
  })

  const report = await recovery.inspectBlockedJobs(db, { organizationId })
  const blocked = report.candidates.find((c) => c.packageId === RECOVERABLE[0])
  assert.equal(blocked.carrierCalled, true)
  assert.equal(blocked.safeToReactivate, false)
  assert.match(blocked.reason, /taşıyıcı çağrısı/)

  // Toplu acma denense bile o satir DOKUNULMAZ.
  const result = await recovery.reactivateBlockedJobs(db, {
    organizationId, packageIds: RECOVERABLE,
  })
  assert.equal(result.reactivated, RECOVERABLE.length - 1)
  const rows = await db.select().from(schema.labelJobs)
  const untouched = rows.find((r) => r.packageId === RECOVERABLE[0])
  assert.equal(untouched.status, 'BLOCKED')
  assert.equal(untouched.attemptCount, 1)
})

/* ═══ RECOVERY-4 ═════════════════════════════════════════════════════ */

test('RECOVERY-4: acma AYNI satiri kuyruga alir, MUKERRER YARATMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await load('/server/shipments/blockedJobRecovery.ts')
  const organizationId = await seed(db)
  const before = await db.select().from(schema.labelJobs)
  const beforeIds = Object.fromEntries(before.map((r) => [r.packageId, r.id]))

  const result = await recovery.reactivateBlockedJobs(db, {
    organizationId, packageIds: [RECOVERABLE[0]],
  })
  assert.equal(result.reactivated, 1)
  assert.equal(result.carrierCalls, 0)

  const after = await db.select().from(schema.labelJobs)
  // YENI SATIR YOK.
  assert.equal(after.length, before.length)
  const target = after.find((r) => r.packageId === RECOVERABLE[0])
  assert.equal(target.status, 'QUEUED')
  assert.equal(target.id, beforeIds[RECOVERABLE[0]])
  // attempt_count TARIHSEL KANIT olarak KORUNUR.
  assert.equal(target.attemptCount, 1)
  // Istenmeyen paketler DOKUNULMADI.
  for (const packageId of RECOVERABLE.slice(1)) {
    assert.equal(after.find((r) => r.packageId === packageId).status, 'BLOCKED')
  }
  // UNKNOWN satiri DOKUNULMADI.
  const unknown = after.find((r) => r.packageId === UNKNOWN_PACKAGE)
  assert.equal(unknown.status, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(unknown.attemptCount, 26)
})

/* ═══ RECOVERY-5 ═════════════════════════════════════════════════════ */

test('RECOVERY-5: paket verilmezse HICBIR SATIR acilmaz (toplu acma YOK)', async () => {
  const cli = readFileSync(
    join(here, 'shipments', 'blockedJobRecoveryCli.ts'), 'utf8',
  )
  assert.match(cli, /reactivate && packageIds\.length === 0/)
  assert.match(cli, /EN AZ BIR --package/)

  const source = readFileSync(
    join(here, 'shipments', 'blockedJobRecovery.ts'), 'utf8',
  )
  // Yalniz BLOCKED sorgulanir; UNKNOWN/READY hic okunmaz.
  assert.match(source, /eq\(labelJobs\.status, 'BLOCKED'\)/)
  assert.ok(!/UNKNOWN_AFTER_NETWORK'\)/.test(source))
  // Guncelleme kosulu satirin ICINDEDIR.
  assert.match(source, /eq\(labelJobs\.status, 'BLOCKED'\),\s*\n\s*\),\s*\n\s*\)\s*\n\s*\.returning/)

  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/blocked-job-recovery-flow.test.mjs'))
})
