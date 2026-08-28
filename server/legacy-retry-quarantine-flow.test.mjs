import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ ESKİ ÇALIŞMA ZAMANI KALINTILARININ KARANTİNASI ═════════════════════
//
// Üretimde 5 adet `FAILED_SAFE_TO_RETRY` satırı, eski deterministik retry
// hatasından kalmıştır (attempt_count 8…37). `claimLabelJobs` bu durumu
// TALEP EDER, yani worker açıldığında UYANIRLAR.
//
// KANIT SINIRI (koddan ölçüldü): `surat_trace_attempts` (org, trace_id)
// üzerinde UNIQUE ve yazım `onConflictDoNothing`; `traceId` ise paketten
// TÜRETİLİR (`CF-SOAP-<packageId>`). Bu yüzden paket başına YALNIZ İLK
// deneme saklanır — 37 denemenin 36'sı iz BIRAKMAZ.
//
// Bu nedenle "her tarihsel deneme ağdan önceydi" iddiası iz deposundan
// KANITLANAMAZ. Kullanılan otoriter ve MUTASYONSUZ kaynak
// `shipment_operations.carrier_create_called`'dır: herhangi bir deneme
// taşıyıcıya ulaşsaydı bu alan true olurdu.
//
// TAŞIYICI ÇAĞRISI YOKTUR.

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

/** Üretimdeki beş kalıntı satır (attempt_count dahil). */
const LEGACY_ROWS = [
  { packageId: '4110043440', attemptCount: 37 },
  { packageId: '4110109345', attemptCount: 25 },
  { packageId: '4110126395', attemptCount: 20 },
  { packageId: '4110143271', attemptCount: 16 },
  { packageId: '4110188925', attemptCount: 8 },
]

async function seed(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()

  for (const row of LEGACY_ROWS) {
    await db.insert(schema.labelJobs).values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      carrier: 'surat',
      packageId: row.packageId,
      jobType: 'LABEL_PREPARE',
      status: 'FAILED_SAFE_TO_RETRY',
      attemptCount: row.attemptCount,
      // Eski YANLIŞ sınıflandırma: taşıma denenmediği hâlde taşıma hatası.
      lastErrorCode: 'SURAT_SOAP_TRANSPORT_FAILED',
      lastErrorSummary:
        'Sürat kimlik doğrulaması tamamlanamadı; taşıyıcıya çağrı YAPILMADI.',
    })
  }
  if (options.extra) await options.extra(db, org.id)
  return org.id
}

/* ═══ LEGACY-1 ═══════════════════════════════════════════════════════ */

test('LEGACY-1: kanitlanmis eski desi kalintisi → BLOCKED', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const organizationId = await seed(db)

  const inspected = await legacy.inspectLegacyRetryJobs(db, { organizationId })
  assert.equal(inspected.totalFailedSafeToRetry, 5)
  assert.equal(inspected.provenLegacy, 5)
  // SALT-OKUNUR.
  assert.equal(inspected.dbWrites, 0)
  assert.equal(inspected.networkCalls, 0)
  assert.equal(inspected.carrierCalls, 0)
  // İnceleme HİÇBİR satırı değiştirmedi.
  const stillRetry = await db.select().from(schema.labelJobs)
  assert.ok(stillRetry.every((job) => job.status === 'FAILED_SAFE_TO_RETRY'))

  const result = await legacy.quarantineLegacyRetryJobs(db, { organizationId })
  assert.equal(result.quarantined, 5)
  assert.equal(result.carrierCalls, 0)
  const after = await db.select().from(schema.labelJobs)
  assert.ok(after.every((job) => job.status === 'BLOCKED'))
  // KESİN kod yazıldı; eski yanlış taşıma etiketi düzeltildi.
  assert.ok(after.every((job) => job.lastErrorCode === legacy.LEGACY_DESI_ERROR_CODE))
})

/* ═══ LEGACY-2 ═══════════════════════════════════════════════════════ */

test('LEGACY-2: attempt_count KORUNUR (tarihsel kanit)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const organizationId = await seed(db)
  await legacy.quarantineLegacyRetryJobs(db, { organizationId })

  const rows = await db.select().from(schema.labelJobs)
  const byPackage = Object.fromEntries(rows.map((r) => [r.packageId, r.attemptCount]))
  for (const row of LEGACY_ROWS) {
    assert.equal(byPackage[row.packageId], row.attemptCount, row.packageId)
  }
})

/* ═══ LEGACY-3 / LEGACY-4 ════════════════════════════════════════════ */

test('LEGACY-3/4: UNKNOWN_AFTER_NETWORK ve READY DOKUNULMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const organizationId = await seed(db, {
    extra: async (database, orgId) => {
      for (const [packageId, status] of [
        ['UNK-1', 'UNKNOWN_AFTER_NETWORK'],
        ['RDY-1', 'READY'],
        ['PRE-1', 'PREPARING'],
        ['QUE-1', 'QUEUED'],
      ]) {
        await database.insert(schema.labelJobs).values({
          organizationId: orgId, marketplace: 'Trendyol', carrier: 'surat',
          packageId, jobType: 'LABEL_PREPARE', status, attemptCount: 3,
          lastErrorCode: 'SURAT_SOAP_TRANSPORT_FAILED',
        })
      }
    },
  })

  await legacy.quarantineLegacyRetryJobs(db, { organizationId })
  const rows = await db.select().from(schema.labelJobs)
  const byPackage = Object.fromEntries(rows.map((r) => [r.packageId, r.status]))
  assert.equal(byPackage['UNK-1'], 'UNKNOWN_AFTER_NETWORK')
  assert.equal(byPackage['RDY-1'], 'READY')
  assert.equal(byPackage['PRE-1'], 'PREPARING')
  assert.equal(byPackage['QUE-1'], 'QUEUED')
})

/* ═══ LEGACY-5 ═══════════════════════════════════════════════════════ */

test('LEGACY-5: KANITLANMAMIS gecmis otomatik yeniden etkinlestirilmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const organizationId = await seed(db, {
    extra: async (database, orgId) => {
      // 4110043440 icin TASIYICI CAGRISI kaydi var → kanit YOK, dokunma.
      await database.insert(schema.shipmentOperations).values({
        organizationId: orgId, marketplace: 'Trendyol', packageId: '4110043440',
        orderNumber: 'ORD-1', provider: 'surat', operationType: 'create',
        idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
        status: 'failed', createCallCount: 1, carrierCreateCalled: true,
      })
    },
  })

  const inspected = await legacy.inspectLegacyRetryJobs(db, { organizationId })
  const unproven = inspected.candidates.find((c) => c.packageId === '4110043440')
  assert.equal(unproven.verdict, 'HISTORY_UNPROVEN')
  assert.equal(unproven.carrierCreateCalled, true)
  assert.equal(inspected.historyUnproven, 1)
  assert.equal(inspected.provenLegacy, 4)

  const result = await legacy.quarantineLegacyRetryJobs(db, { organizationId })
  assert.equal(result.quarantined, 4)
  // BELIRSIZLIK create izni DEGILDIR: satir OLDUGU GIBI kalir.
  const rows = await db.select().from(schema.labelJobs)
  const target = rows.find((r) => r.packageId === '4110043440')
  assert.equal(target.status, 'FAILED_SAFE_TO_RETRY')
  assert.equal(target.attemptCount, 37)
})

/* ═══ LEGACY-6 / LEGACY-7 / LEGACY-8 ═════════════════════════════════ */

test('LEGACY-6/7/8: tek paket yeniden etkinlestirme — TEK satir, mukerrer YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
  const mapper = await load('/server/orders/orderMapper.ts')
  const organizationId = await seed(db)
  await legacy.quarantineLegacyRetryJobs(db, { organizationId })

  // Kiracı ayarı ve sipariş: 4110109345.
  await defaults.saveShipmentDefaults(db, organizationId, {
    defaultUnitDesi: 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  await db.insert(schema.orders).values({
    ...mapper.toOrderInsertValues(organizationId, {
      marketplace: 'Trendyol', packageId: '4110109345',
      orderNumber: '11545965908', marketplaceStatus: 'Created',
      cargoTrackingNumber: '7279999999',
      orderDate: new Date('2026-08-28T00:00:00.000Z').toISOString(),
      totalAmount: '100.00', rawOrder: { status: 'Created' },
    }),
    operationStatus: 'NEW',
  })

  const before = await db.select().from(schema.labelJobs)
  const check = await legacy.inspectSingleJobReactivation(db, {
    organizationId, packageId: '4110109345',
  })
  assert.equal(check.safeToReactivate, true, check.blockers.join(','))
  assert.equal(check.resolverDesi, 2)
  assert.equal(check.tenantDesiValue, 2)
  assert.equal(check.multiplyByItemQuantity, false)
  assert.equal(check.carrierCallRecorded, false)
  assert.equal(check.duplicateJobs, 0)

  const result = await legacy.reactivateSingleJob(db, {
    organizationId, packageId: '4110109345',
  })
  assert.equal(result.reactivated, true)
  assert.equal(result.carrierCalls, 0)

  const after = await db.select().from(schema.labelJobs)
  // LEGACY-7: MUKERRER SATIR YOK.
  assert.equal(after.length, before.length)
  // LEGACY-6: YALNIZ hedef satir degisti.
  const target = after.find((r) => r.packageId === '4110109345')
  assert.equal(target.status, 'QUEUED')
  assert.equal(target.id, before.find((r) => r.packageId === '4110109345').id)
  assert.equal(target.attemptCount, 25, 'attempt_count sifirlandi')
  for (const row of after.filter((r) => r.packageId !== '4110109345')) {
    assert.equal(row.status, 'BLOCKED', row.packageId)
  }
})

/* ═══ LEGACY-9 ═══════════════════════════════════════════════════════ */

test('LEGACY-9: desi cozulemiyorsa SAFE_TO_REACTIVATE = NO', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const mapper = await load('/server/orders/orderMapper.ts')
  const organizationId = await seed(db)
  await legacy.quarantineLegacyRetryJobs(db, { organizationId })

  // Siparis VAR ama kiraci desi ayari YOK.
  await db.insert(schema.orders).values({
    ...mapper.toOrderInsertValues(organizationId, {
      marketplace: 'Trendyol', packageId: '4110109345',
      orderNumber: '11545965908', marketplaceStatus: 'Created',
      cargoTrackingNumber: '7279999999',
      orderDate: new Date('2026-08-28T00:00:00.000Z').toISOString(),
      totalAmount: '100.00', rawOrder: { status: 'Created' },
    }),
    operationStatus: 'NEW',
  })

  const check = await legacy.inspectSingleJobReactivation(db, {
    organizationId, packageId: '4110109345',
  })
  assert.equal(check.safeToReactivate, false)
  assert.ok(check.blockers.includes('DESI_COZULEMIYOR'))

  // Mutasyon komutu da HICBIR SEY yazmaz.
  const result = await legacy.reactivateSingleJob(db, {
    organizationId, packageId: '4110109345',
  })
  assert.equal(result.reactivated, false)
  const rows = await db.select().from(schema.labelJobs)
  assert.equal(rows.find((r) => r.packageId === '4110109345').status, 'BLOCKED')
})

/* ═══ LEGACY-10 ══════════════════════════════════════════════════════ */

test('LEGACY-10: WhoPays / transport / SOAP sozlesmesi DEGISMEDI', async () => {
  const routing = await load('/server/shipments/suratRoutingModel.ts')
  assert.equal(routing.resolveBillingPartyV2({}).billingParty, 'TRENDYOL_PAYS')
  assert.equal(
    routing.resolveBillingPartyV2({ whoPays: 1 }).billingParty, 'SELLER_PAYS',
  )
  const transport = readFileSync(
    join(here, 'shipments', 'suratLabelTransportRoute.ts'), 'utf8',
  )
  assert.match(transport, /OrtakBarkodOlustur/)
  assert.match(transport, /webservices\.suratkargo\.com\.tr\/services\.asmx/)

  // Karantina araci TASIYICIYA CIKMAZ ve worker CALISTIRMAZ.
  const source = readFileSync(
    join(here, 'shipments', 'legacyRetryQuarantine.ts'), 'utf8',
  )
  for (const forbidden of [
    'OrtakBarkodOlustur', 'services.asmx', 'fetch(',
    'runLabelJobCycle', 'createSuratShipment', 'whoPays',
  ]) {
    assert.ok(!source.includes(forbidden), `karantinada ${forbidden}`)
  }
})

/* ═══ CLAIM MANTIGI ══════════════════════════════════════════════════ */

test('LEGACY-11: claimLabelJobs sorgusu DEGISTIRILMEDI', async () => {
  const queue = readFileSync(
    join(here, 'shipments', 'labelJobQueue.ts'), 'utf8',
  )
  // Genel davranis korunur: gercekten gecici hatalar hala talep edilir.
  assert.match(queue, /c\.status IN \('QUEUED', 'FAILED_SAFE_TO_RETRY'\)/)
})

test('LEGACY-12: iz deposu paket basina TEK deneme saklar (kanit siniri)', async () => {
  const repo = readFileSync(
    join(here, 'shipments', 'suratTraceRepository.ts'), 'utf8',
  )
  // Yazim catismada SESSIZCE atlar → ikinci deneme iz BIRAKMAZ.
  assert.match(repo, /onConflictDoNothing/)
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  // traceId paketten TURETILIR → tum denemeler AYNI anahtara duser.
  assert.match(server, /CF-SOAP-\$\{String\(order\?\.packageId/)
  const schemaSource = readFileSync(join(here, 'db', 'schema.ts'), 'utf8')
  assert.match(schemaSource, /surat_trace_attempts_org_trace_unique/)
})

test('LEGACY-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})
