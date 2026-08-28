import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// ═══ BAYAT `PREPARING` KURTARMA ═════════════════════════════════════════
//
// ÜRETİM OLAYI (paket 4111289850): kanarya betiği `sleep 90` sonrası PM2'yi
// KOŞULSUZ yeniden başlattı. Worker işi 22:40:09'da talep etti, süreç
// 22:40:46'da öldü — işe yalnız ~37 saniye kaldı. Geriye:
//     label_jobs: PREPARING, locked_by=918459@bd98248, attempt_count=1
//     shipment_operations: pending, create_call_count=1,
//                          carrier_create_called=false, completed_at=NULL
//     shipments: 0 satır
//
// `create_call_count` AĞDAN ÖNCE artar; taşıyıcı çağrısının kanıtı DEĞİLDİR.
// Otoriter kanıt `carrier_create_called`'dır ve `false`'tur.
//
// Bu dosya VITE KULLANMAZ: üretim çözücüsüyle (`node`) çalışır.
// GERÇEK TAŞIYICI ÇAĞRISI YOKTUR.

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

const TARGET = '4111289850'
const DEAD_WORKER = '918459@bd98248'
const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000)

async function seed(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()
  const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
  await defaults.saveShipmentDefaults(db, org.id, {
    defaultUnitDesi: 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  const credentials = await import('./integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })
  const encryption = await import('./orders/orderEncryption.ts')
  await db.insert(schema.orders).values({
    organizationId: org.id, marketplace: 'Trendyol', packageId: TARGET,
    orderNumber: `ORD-${TARGET}`,
    orderDate: new Date('2026-08-28T00:00:00.000Z'),
    cargoTrackingNumber: '7281289850', operationStatus: 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Picking',
    cargoProviderName: 'Surat Kargo',
    firstSeenAt: new Date('2026-08-28T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload({
      orderNumber: `ORD-${TARGET}`, id: TARGET,
    }),
  })
  // ÜRETİMDEKİ TAM ŞEKİL: PREPARING + ölü worker kilidi.
  await db.insert(schema.labelJobs).values({
    organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
    packageId: TARGET, jobType: 'LABEL_PREPARE',
    status: options.jobStatus ?? 'PREPARING',
    attemptCount: 1,
    lockedAt: options.lockedAt ?? HOUR_AGO,
    lockedBy: DEAD_WORKER,
  })
  // Ağdan ÖNCE ölmüş rezervasyon.
  if (options.operation !== null) {
    await db.insert(schema.shipmentOperations).values({
      organizationId: org.id, marketplace: 'Trendyol', packageId: TARGET,
      orderNumber: `ORD-${TARGET}`, provider: 'surat',
      operationType: 'OrtakBarkodOlustur',
      idempotencyKey: options.idempotencyKey ?? `idem-${TARGET}`,
      status: 'pending', createCallCount: 1,
      carrierCreateCalled: options.carrierCreateCalled ?? false,
    })
  }
  if (options.extra) await options.extra(db, org.id)
  return org.id
}

async function targetJob(db) {
  const rows = await db.select().from(schema.labelJobs)
  return rows.find((row) => row.packageId === TARGET)
}

/* ═══ STALE-1 ════════════════════════════════════════════════════════ */

test('STALE-1: olu PREPARING + carrierCalled=false → SAFE_STALE_PRE_NETWORK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await import('./shipments/staleJobRecovery.ts')
  const organizationId = await seed(db)

  const report = await recovery.inspectStaleJobs(db, { organizationId })
  assert.equal(report.preparingTotal, 1)
  const candidate = report.candidates[0]
  assert.equal(candidate.packageId, TARGET)
  assert.equal(candidate.carrierCreateCalled, false)
  // Sayac 1 ama bu TASIYICI CAGRISI DEGILDIR.
  assert.equal(candidate.createCallCount, 1)
  assert.equal(candidate.carrierArtifactExists, false)
  assert.equal(candidate.currentResolvedDesi, 2)
  assert.equal(candidate.currentEligibility, true)
  assert.equal(candidate.verdict, 'SAFE_STALE_PRE_NETWORK')
  assert.equal(candidate.safeToRecover, true)
  assert.equal(candidate.targetStatus, 'QUEUED')
  // SALT OKUNUR.
  assert.equal(report.dbWrites, 0)
  assert.equal(report.carrierCalls, 0)
  assert.equal((await targetJob(db)).status, 'PREPARING')
})

/* ═══ STALE-2 ════════════════════════════════════════════════════════ */

test('STALE-2: olu PREPARING + carrierCalled=true → NETWORK_UNCERTAIN, TEKRAR YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await import('./shipments/staleJobRecovery.ts')
  const organizationId = await seed(db, { carrierCreateCalled: true })

  const report = await recovery.inspectStaleJobs(db, { organizationId })
  const candidate = report.candidates[0]
  assert.equal(candidate.carrierCreateCalled, true)
  assert.equal(candidate.verdict, 'NETWORK_UNCERTAIN')
  assert.equal(candidate.safeToRecover, false)

  // Acikca istense BILE kuyruga ALINMAZ.
  const result = await recovery.recoverStaleJobs(db, {
    organizationId, packageIds: [TARGET],
  })
  assert.equal(result.recovered, 0)
  assert.equal(result.carrierCalls, 0)
  assert.equal((await targetJob(db)).status, 'PREPARING')
})

/* ═══ STALE-3 ════════════════════════════════════════════════════════ */

test('STALE-3: PREPARING + tasiyici artefakti → READY uzlastirmasi, create YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await import('./shipments/staleJobRecovery.ts')
  const organizationId = await seed(db, {
    extra: async (database, orgId) => {
      await database.insert(schema.shipments).values({
        organizationId: orgId, marketplace: 'Trendyol', packageId: TARGET,
        provider: 'surat', trackingNumber: '7281000001',
        source: 'local_create', status: 'created',
      })
    },
  })

  const report = await recovery.inspectStaleJobs(db, { organizationId })
  const candidate = report.candidates[0]
  assert.equal(candidate.verdict, 'ALREADY_READY')
  assert.equal(candidate.targetStatus, 'READY')

  const result = await recovery.recoverStaleJobs(db, {
    organizationId, packageIds: [TARGET],
  })
  assert.equal(result.recovered, 1)
  assert.equal(result.carrierCalls, 0)
  const job = await targetJob(db)
  assert.equal(job.status, 'READY')
  // Kuyruga ALINMADI → ikinci create IMKANSIZ.
  assert.notEqual(job.status, 'QUEUED')
})

/* ═══ STALE-4 / 5 / 6 / 7 ════════════════════════════════════════════ */

test('STALE-4/5/6/7: kurtarma is kimligini, sayaci korur; kilidi temizler; create 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await import('./shipments/staleJobRecovery.ts')
  const organizationId = await seed(db)
  const before = await targetJob(db)
  const beforeCount = (await db.select().from(schema.labelJobs)).length

  const result = await recovery.recoverStaleJobs(db, {
    organizationId, packageIds: [TARGET],
  })
  assert.equal(result.recovered, 1)
  // STALE-7: tasiyici cagrisi SIFIR.
  assert.equal(result.carrierCalls, 0)

  const after = await targetJob(db)
  // STALE-4: AYNI is kimligi, mukerrer satir YOK.
  assert.equal(after.id, before.id)
  assert.equal((await db.select().from(schema.labelJobs)).length, beforeCount)
  // STALE-5: attempt_count KORUNUR (sifirlanmaz/azaltilmaz).
  assert.equal(after.attemptCount, 1)
  // STALE-6: bayat kilit TEMIZLENDI.
  assert.equal(after.lockedAt, null)
  assert.equal(after.lockedBy, null)
  assert.equal(after.status, 'QUEUED')
})

/* ═══ STALE-8 / STALE-9 ══════════════════════════════════════════════ */

test('STALE-8/9: agdan once olmus rezervasyon MUKERRER operasyon URETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const recovery = await import('./shipments/staleJobRecovery.ts')
  const organizationId = await seed(db)
  const beforeOps = await db.select().from(schema.shipmentOperations)
  assert.equal(beforeOps.length, 1)

  await recovery.recoverStaleJobs(db, { organizationId, packageIds: [TARGET] })

  // STALE-8: kurtarma YENI operasyon EKLEMEZ.
  const afterOps = await db.select().from(schema.shipmentOperations)
  assert.equal(afterOps.length, 1)
  assert.equal(afterOps[0].idempotencyKey, beforeOps[0].idempotencyKey)
  assert.equal(afterOps[0].carrierCreateCalled, false)

  // STALE-9: create yolu AYNI anahtari yeniden acar; ikinci MANTIKSAL
  // operasyon dogmaz ve gercek ag cagrisi EN FAZLA BIR olur.
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const at = source.indexOf("if (existing && ['IN_PROGRESS', 'UNKNOWN'].includes(existing.status))")
  assert.ok(at > 0, 'idempotency dali bulunamadi')
  const branch = source.slice(at, at + 2400)
  // UNKNOWN (ag GECILDI, sonuc belirsiz) KOSULSUZ blokedir.
  assert.match(
    branch,
    /existing\.status === 'UNKNOWN' \|\| existing\.carrierCreateCalled === true/,
  )
  // Kanit varsa davranis AYNEN korunur: BLOKE.
  assert.match(branch, /\{\s*\n\s*return buildSuratIdempotencyBlockedResponse/)
  // Yeniden acma YALNIZ agdan once olmus IN_PROGRESS icin.
  assert.match(branch, /STALE_PRE_NETWORK_RESERVATION_REOPENED/)
  // Yeni idempotency anahtari URETILMEZ.
  assert.ok(!/idempotencyKey\s*=\s*`/.test(branch))
})

/* ═══ STALE-10 / STALE-11 ════════════════════════════════════════════ */

test('STALE-10/11: SIGTERM yeni talebi durdurur ve calisani bosaltir', async (t) => {
  const worker = await import('./shipments/labelJobWorker.ts')
  t.after(() => worker.stopLabelJobScheduler())

  const env = { LABEL_WORKER_ENABLED: 'true' }
  let cycles = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })

  const started = worker.startLabelJobScheduler({
    intervalMs: 5_000,
    env,
    runCycle: async () => { cycles += 1; await gate },
  })
  assert.equal(started, true)
  assert.equal(worker.isDraining(), false)

  // Bir tur baslat.
  await new Promise((resolve) => setTimeout(resolve, 5_200))
  assert.equal(cycles, 1)

  // STALE-10: bosaltma basladi → YENI tur ACILMAZ.
  const drainPromise = worker.drainLabelJobScheduler(3_000)
  assert.equal(worker.isDraining(), true)
  assert.equal(
    worker.startLabelJobScheduler({ intervalMs: 5_000, env, runCycle: async () => {} }),
    false,
    'bosaltma sirasinda zamanlayici yeniden kuruldu',
  )

  // STALE-11: calisan tur BEKLENIR ve bitince drained=true.
  release()
  const result = await drainPromise
  assert.equal(result.hadActiveCycle, true)
  assert.equal(result.drained, true)
  assert.equal(cycles, 1, 'bosaltma sirasinda IKINCI tur acildi')
})

test('STALE-11b: sure dolarsa zorla beklenmez ama kanit kalicidir', async (t) => {
  const worker = await import('./shipments/labelJobWorker.ts')
  t.after(() => worker.stopLabelJobScheduler())
  worker.stopLabelJobScheduler()

  let release
  const gate = new Promise((resolve) => { release = resolve })
  worker.startLabelJobScheduler({
    intervalMs: 5_000,
    env: { LABEL_WORKER_ENABLED: 'true' },
    runCycle: async () => { await gate },
  })
  await new Promise((resolve) => setTimeout(resolve, 5_200))

  const result = await worker.drainLabelJobScheduler(200)
  assert.equal(result.hadActiveCycle, true)
  // Sure doldu: surec ZORLA bekletilmez.
  assert.equal(result.drained, false)
  release()
})

/* ═══ STALE-12 ═══════════════════════════════════════════════════════ */

test('STALE-12: kanarya gozlemcisi AKTIF PREPARING isi ASLA oldurmez', async () => {
  const observer = readFileSync(
    join(here, 'shipments', 'canaryObserverCli.ts'), 'utf8',
  )
  // Kosulsuz uyku + yeniden baslatma YASAK.
  // (Anti-desen YORUMDA anlatilabilir; YURUTULEBILIR satirda OLAMAZ.)
  const NEWLINE = String.fromCharCode(10)
  const executable = observer
    .split(NEWLINE)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join(NEWLINE)
  assert.ok(!/pm2\s+restart/i.test(executable), 'gozlemci PM2 yeniden baslatiyor')
  assert.ok(
    !/execSync|spawnSync|child_process/.test(executable),
    'gozlemci surec oldurebiliyor',
  )
  // Terminal duruma bakar.
  assert.match(observer, /TERMINAL = \['READY', 'BLOCKED', 'UNKNOWN_AFTER_NETWORK'\]/)
  // Zaman asiminda PREPARING ise ACIKCA uyarir ve DOKUNMAZ.
  assert.match(observer, /ACTIVE_JOB_AT_TIMEOUT/)
  assert.match(observer, /Sureci YENIDEN BASLATMA/)
  // Salt okunur.
  assert.ok(!/\.update\(|\.insert\(|\.delete\(/.test(observer))
})

/* ═══ ZAMAN TEK BAŞINA İZİN DEĞİLDİR ═════════════════════════════════ */

test('STALE-LOCK: releaseStaleLocks SUREYE degil KANITA bakar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const queue = await import('./shipments/labelJobQueue.ts')

  // Tasiyiciya GIDILMIS ve kilit COK ESKI: kuyruga DONMEMELI.
  const organizationId = await seed(db, { carrierCreateCalled: true })
  const released = await queue.releaseStaleLocks(db, { olderThanMs: 1_000 })
  assert.equal(released, 0, 'ag gecilmis is kuyruga geri alindi')
  const job = await targetJob(db)
  assert.equal(job.status, 'UNKNOWN_AFTER_NETWORK')
  assert.notEqual(job.status, 'QUEUED')
})

test('STALE-LOCK-2: agdan once olmus bayat kilit kuyruga DONER', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const queue = await import('./shipments/labelJobQueue.ts')
  const organizationId = await seed(db)

  const released = await queue.releaseStaleLocks(db, { olderThanMs: 1_000 })
  assert.equal(released, 1)
  const job = await targetJob(db)
  assert.equal(job.status, 'QUEUED')
  assert.equal(job.lockedBy, null)
  // Tarihsel kanit KORUNUR.
  assert.equal(job.attemptCount, 1)
  assert.ok(organizationId)
})

test('STALE-LOCK-3: kilit HALA canliysa DOKUNULMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const queue = await import('./shipments/labelJobQueue.ts')
  await seed(db, { lockedAt: new Date() })

  const released = await queue.releaseStaleLocks(db, { olderThanMs: 10 * 60 * 1000 })
  assert.equal(released, 0)
  assert.equal((await targetJob(db)).status, 'PREPARING')
})

/* ═══ REG ════════════════════════════════════════════════════════════ */

test('STALE-REG: CLI komutlari duz `node` ile calisir ve suitede KAYITLI', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const script of [
    'auto-label:stale:inspect',
    'auto-label:stale:recover',
    'auto-label:canary:observe',
  ]) {
    assert.ok(pkg.scripts[script], `${script} KAYITLI DEGIL`)
    assert.match(pkg.scripts[script], /^node /, `${script} duz node ile calismali`)
  }
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/stale-preparing-recovery-flow.test.mjs'))
  // Bu dosya uretim cozucusuyle calisir.
  const self = readFileSync(join(here, 'stale-preparing-recovery-flow.test.mjs'), 'utf8')
  const importsVite = self
    .split('\n')
    .some((line) => /^\s*import\s/.test(line) && /vite/.test(line))
  assert.equal(importsVite, false)
  assert.ok(and && eq)
})
