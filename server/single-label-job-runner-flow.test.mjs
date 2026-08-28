import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ KONTROLLÜ ÜRETİM KANARYASI — TEK İŞ, TEK CREATE ════════════════════
//
// Worker KAPALIYKEN üç meşru iş sıraya girdi (4110346669, 4110352749,
// 4110388725; hepsi QUEUED, attempt_count=0). Kanarya YALNIZ 4110109345'i
// işlemelidir; genel `claimLabelJobs` toplu sorgusu bu iş için YANLIŞ
// araçtır — o sorgu QUEUED olan HER satırı uyandırırdı.
//
// Bu dosya şunları sabitler:
//   • Yalnız hedef paket işlenir; diğer satırlar DOKUNULMAZ.
//   • Mükerrer iş satırı İMKÂNSIZ; mevcut iş kimliği KORUNUR.
//   • Kapı kapalıysa taşıyıcı çağrısı SIFIR.
//   • Başarılı yolda TAM OLARAK BİR create.
//   • Ağ belirsizliği → UNKNOWN_AFTER_NETWORK, TEKRAR YOK.
//   • Deterministik ağ-öncesi ret → BLOCKED, TEKRAR YOK.
//   • Desi 2 → BirimDesi 2; WhoPays semantiği DEĞİŞMEZ.
//   • `attempt_count` TAM OLARAK BİR kez artar.
//
// GERÇEK TAŞIYICI ÇAĞRISI YOKTUR: `runLabel` enjekte edilir.

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

const TARGET = '4110109345'
const ORDER_NUMBER = '11545965908'
/** Worker kapalıyken sıraya giren ÜÇ ilgisiz iş. */
const UNRELATED = ['4110346669', '4110352749', '4110388725']

async function seed(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()

  if (options.desi !== null) {
    const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
    await defaults.saveShipmentDefaults(db, org.id, {
      defaultUnitDesi: options.desi ?? 2,
      multiplyByItemQuantity: false,
      labelPrintTemplate: 'cargoflow_html',
    })
  }

  const credentials = await load('/server/integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER',
    liveSifre: 'CF-TEST-PASS',
  })

  const encryption = await load('/server/orders/orderEncryption.ts')
  const raw = { orderNumber: ORDER_NUMBER, id: TARGET }
  if (options.whoPays !== undefined) raw.whoPays = options.whoPays
  await db.insert(schema.orders).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: TARGET,
    orderNumber: ORDER_NUMBER,
    orderDate: new Date('2026-08-20T00:00:00.000Z'),
    cargoTrackingNumber: '7279999999',
    operationStatus: 'NEW',
    firstSeenAt: new Date('2026-08-20T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload(raw),
  })

  // Hedef: KARANTİNAYA ALINMIŞ eski satır, tarihsel deneme sayacıyla.
  await db.insert(schema.labelJobs).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    carrier: 'surat',
    packageId: TARGET,
    jobType: 'LABEL_PREPARE',
    status: options.targetStatus ?? 'BLOCKED',
    attemptCount: 25,
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  })
  for (const packageId of UNRELATED) {
    await db.insert(schema.labelJobs).values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      carrier: 'surat',
      packageId,
      jobType: 'LABEL_PREPARE',
      status: 'QUEUED',
      attemptCount: 0,
    })
  }
  if (options.extra) await options.extra(db, org.id)
  return org.id
}

/** Taşıyıcı çağrısını SAYAN sahte çalıştırıcı — gerçek ağ YOK. */
function fakeRunner(outcome, calls = { count: 0, jobs: [] }) {
  return {
    calls,
    runLabel: async (job) => {
      calls.count += 1
      calls.jobs.push(job.packageId)
      return typeof outcome === 'function' ? outcome(job) : outcome
    },
  }
}

const SUCCESS = {
  labelReady: true, networkCrossed: true, blocked: false,
  errorCode: null, carrierCalls: 1,
}

async function jobsByPackage(db) {
  const rows = await db.select().from(schema.labelJobs)
  return Object.fromEntries(rows.map((row) => [row.packageId, row]))
}

/* ═══ RUNONCE-1 / RUNONCE-2 ══════════════════════════════════════════ */

test('RUNONCE-1/2: YALNIZ hedef paket islenir, ilgisiz QUEUED isler DOKUNULMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const fake = fakeRunner(SUCCESS)

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })

  assert.equal(report.gatesPassed, true, report.blockers.join(','))
  // Taşıyıcıya YALNIZ hedef paket için gidildi.
  assert.deepEqual(fake.calls.jobs, [TARGET])
  assert.equal(report.otherQueuedJobsTouched, 0)

  const after = await jobsByPackage(db)
  for (const packageId of UNRELATED) {
    assert.equal(after[packageId].status, 'QUEUED', packageId)
    assert.equal(after[packageId].attemptCount, 0, packageId)
  }
})

/* ═══ RUNONCE-3 / RUNONCE-11 ═════════════════════════════════════════ */

test('RUNONCE-3/11: mukerrer is IMKANSIZ, mevcut is kimligi KORUNUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const before = await jobsByPackage(db)
  const beforeCount = Object.keys(before).length

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test',
    runLabel: fakeRunner(SUCCESS).runLabel,
  })

  const after = await db.select().from(schema.labelJobs)
  // YENİ SATIR YARATILMADI.
  assert.equal(after.length, beforeCount)
  // AYNI iş kimliği.
  assert.equal(report.jobId, before[TARGET].id)
  assert.equal(
    after.find((row) => row.packageId === TARGET).id, before[TARGET].id,
  )
})

/* ═══ RUNONCE-4 ══════════════════════════════════════════════════════ */

test('RUNONCE-4: on kontrol kapisi kapaliysa TASIYICI CAGRISI SIFIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  // Kiracıda desi ayarı YOK → desi çözülemez → kapı kapalı.
  const organizationId = await seed(db, { desi: null })
  const fake = fakeRunner(SUCCESS)

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })

  assert.equal(report.gatesPassed, false)
  assert.equal(fake.calls.count, 0, 'kapi kapaliyken tasiyiciya CIKILDI')
  assert.equal(report.totalCarrierCalls, 0)
  assert.equal(report.carrierCallStarted, false)

  // TALEP BİLE EDİLMEDİ: durum ve sayaç DEĞİŞMEDİ.
  const after = await jobsByPackage(db)
  assert.equal(after[TARGET].status, 'BLOCKED')
  assert.equal(after[TARGET].attemptCount, 25)
})

test('RUNONCE-4b: QUEUED is bu komutla ISLENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const fake = fakeRunner(SUCCESS)

  // İlgisiz QUEUED paket AÇIKÇA verilse bile kapı kapalıdır.
  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: UNRELATED[0], workerId: 'test',
    runLabel: fake.runLabel,
  })
  assert.equal(report.gatesPassed, false)
  assert.equal(fake.calls.count, 0)
  assert.ok(
    report.blockers.some((blocker) => blocker.includes('IS_DURUMU_UYGUN_DEGIL')),
    report.blockers.join(','),
  )
  const after = await jobsByPackage(db)
  assert.equal(after[UNRELATED[0]].status, 'QUEUED')
  assert.equal(after[UNRELATED[0]].attemptCount, 0)
})

/* ═══ RUNONCE-5 / RUNONCE-10 ═════════════════════════════════════════ */

test('RUNONCE-5/10: basarili yol = TAM OLARAK BIR create, sayac BIR artar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const fake = fakeRunner(SUCCESS)

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })

  assert.equal(fake.calls.count, 1, 'taşıyıcı BIR KEZDEN fazla cagrildi')
  assert.equal(report.totalCarrierCalls, 1)
  assert.equal(report.statusBefore, 'BLOCKED')
  assert.equal(report.statusAfter, 'READY')
  assert.equal(report.businessResult, 'READY')
  // TAM OLARAK BİR artış — tarihsel sayaç korunarak.
  assert.equal(report.attemptCountBefore, 25)
  assert.equal(report.attemptCountAfter, 26)
  const after = await jobsByPackage(db)
  assert.equal(after[TARGET].attemptCount, 26)
  assert.equal(after[TARGET].status, 'READY')
})

/* ═══ RUNONCE-6 ══════════════════════════════════════════════════════ */

test('RUNONCE-6: ag belirsizligi → UNKNOWN_AFTER_NETWORK, TEKRAR YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const fake = fakeRunner({
    labelReady: false, networkCrossed: true, blocked: false,
    errorCode: 'SURAT_SOAP_TRANSPORT_FAILED', carrierCalls: 1,
  })

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })

  assert.equal(fake.calls.count, 1)
  assert.equal(report.statusAfter, 'UNKNOWN_AFTER_NETWORK')
  // İkinci create MÜKERRER gönderi olurdu: satır TEKRAR TALEP EDİLEMEZ.
  const after = await jobsByPackage(db)
  assert.equal(after[TARGET].status, 'UNKNOWN_AFTER_NETWORK')

  const second = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })
  assert.equal(second.gatesPassed, false)
  assert.equal(fake.calls.count, 1, 'IKINCI create yapildi')
  assert.equal(after[TARGET].attemptCount, 26)
})

/* ═══ RUNONCE-7 ══════════════════════════════════════════════════════ */

test('RUNONCE-7: deterministik ag-oncesi ret → BLOCKED, TEKRAR YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const fake = fakeRunner({
    labelReady: false, networkCrossed: false, blocked: false,
    errorCode: 'SURAT_PREFLIGHT_DESI_MISSING', carrierCalls: 0,
  })

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })

  assert.equal(report.statusAfter, 'BLOCKED')
  assert.equal(report.totalCarrierCalls, 0)
  const after = await jobsByPackage(db)
  assert.equal(after[TARGET].status, 'BLOCKED')
  // KENDİ KENDİNE UYANAN satır BIRAKILMAZ.
  assert.notEqual(after[TARGET].status, 'FAILED_SAFE_TO_RETRY')
})

test('RUNONCE-7b: belirsiz ag-oncesi ret de FAILED_SAFE_TO_RETRY BIRAKMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)
  const fake = fakeRunner({
    labelReady: false, networkCrossed: false, blocked: false,
    errorCode: 'GECICI_BILINMEYEN', carrierCalls: 0,
  })

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })
  // Politika `FAILED_SAFE_TO_RETRY` derdi; kanarya bunu BLOCKED'a çevirir.
  assert.equal(report.statusAfter, 'BLOCKED')
  const after = await jobsByPackage(db)
  assert.equal(after[TARGET].status, 'BLOCKED')
})

/* ═══ RUNONCE-8 / RUNONCE-9 ══════════════════════════════════════════ */

test('RUNONCE-8/9: Desi 2 → BirimDesi 2 ve WhoPays semantigi DEGISMEDI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db)

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test',
    runLabel: fakeRunner(SUCCESS).runLabel,
    // Beklenen desi AÇIKÇA doğrulanır.
    expectedDesi: 2,
  })

  assert.equal(report.gatesPassed, true, report.blockers.join(','))
  assert.equal(report.tenantDesi, 2)
  assert.equal(report.resolvedDesi, 2)
  assert.equal(report.suratBirimDesi, 2)
  // whoPays alanı YOK → pazaryeri öder → 3 / PRIMARY_MARKETPLACE.
  assert.equal(report.billingParty, 'TRENDYOL_PAYS')
  assert.equal(report.expectedSuratWhoPays, 3)
  assert.equal(report.credentialRole, 'PRIMARY_MARKETPLACE')
})

test('RUNONCE-8b: beklenen desi tutmuyorsa TASIYICIYA CIKILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db, { desi: 3 })
  const fake = fakeRunner(SUCCESS)

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test',
    runLabel: fake.runLabel, expectedDesi: 2,
  })
  assert.equal(report.gatesPassed, false)
  assert.equal(fake.calls.count, 0)
  assert.ok(
    report.blockers.some((blocker) => blocker.includes('DESI_BEKLENENDEN_FARKLI')),
    report.blockers.join(','),
  )
})

test('RUNONCE-9b: SELLER_PAYS siparisi kanarya KAPSAMI DISINDA', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db, { whoPays: 1 })
  const fake = fakeRunner(SUCCESS)

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })
  assert.equal(report.gatesPassed, false)
  assert.equal(fake.calls.count, 0)
  assert.equal(report.billingParty, 'SELLER_PAYS')
  assert.ok(
    report.blockers.some((blocker) => blocker.includes('KANARYA_KAPSAMI_DISI')),
    report.blockers.join(','),
  )
})

/* ═══ TAŞIYICI ARTEFAKTI ═════════════════════════════════════════════ */

test('RUNONCE-GATE: kayitli tasiyici cagrisi varsa IKINCI create YAPILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db, {
    extra: async (database, orgId) => {
      await database.insert(schema.shipmentOperations).values({
        organizationId: orgId, marketplace: 'Trendyol', packageId: TARGET,
        orderNumber: ORDER_NUMBER, provider: 'surat', operationType: 'create',
        idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
        status: 'failed', createCallCount: 1, carrierCreateCalled: true,
      })
    },
  })
  const fake = fakeRunner(SUCCESS)

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test', runLabel: fake.runLabel,
  })
  assert.equal(report.gatesPassed, false)
  assert.equal(fake.calls.count, 0)
  assert.ok(report.blockers.includes('TASIYICI_CAGRISI_KAYITLI'))
})

/* ═══ GENEL TALEP SORGUSU KULLANILMAZ ════════════════════════════════ */

test('RUNONCE-REG: tek is calistirici genel claimLabelJobs KULLANMAZ', async () => {
  const source = readFileSync(
    join(here, 'shipments', 'singleLabelJobRunner.ts'), 'utf8',
  )
  assert.ok(
    !/\bclaimLabelJobs\s*\(/.test(source),
    'toplu talep sorgusu kanarya yolunda KULLANILMIS',
  )
  // Talep TEK satiri kimligiyle hedefler.
  assert.match(source, /WHERE j\.id = /)

  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/single-label-job-runner-flow.test.mjs'))
})

/* ═══ İÇE AKTARMA KORUMASI ═══════════════════════════════════════════ */

test('RUNONCE-BOOT: CLI icin ice aktarma HTTP dinleyicisi ACMAZ', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Kanarya create orkestrasyonunu ICE AKTARIR; dinleyici acilmamalidir.
  assert.match(source, /CF_IMPORT_ONLY/)
  assert.match(source, /if \(!listenSuppressed\) app\.listen\(/)
  // Kosul "aksi belirtilmedikce dinle" olmalidir: varsayilan DEGISMEZ.
  assert.match(source, /listenSuppressed =\s*String\(process\.env\.CF_IMPORT_ONLY/)
  // Paylasilan calistirma yolu disa aktarilmis olmalidir.
  assert.match(source, /export \{ runLabelJobViaCreateHandler \}/)

  // CLI bayragi ICE AKTARMADAN ONCE kurmalidir.
  const cli = readFileSync(
    join(here, 'shipments', 'singleLabelJobRunnerCli.ts'), 'utf8',
  )
  const flagAt = cli.indexOf("process.env.CF_IMPORT_ONLY = '1'")
  const importAt = cli.indexOf("import('../index.mjs'")
  assert.ok(flagAt > 0 && importAt > flagAt, 'bayrak ice aktarmadan SONRA kurulmus')
})
