import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// ═══ ETİKET İŞ KUYRUĞU + WORKER — GERÇEK POSTGRES (PGlite) ═══════════════
//
// Taşıyıcı etiketi GERİ ALINAMAZ. Bu paket, "aynı paket için iki gönderi"
// senaryosunun YAPISAL OLARAK imkânsız olduğunu gerçek veritabanı kısıtları
// üzerinde kanıtlar. Sürat çağrısı ENJEKTE EDİLİR — gerçek taşıyıcı YOK.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const QUEUE = await import('./shipments/labelJobQueue.ts')
const WORKER = await import('./shipments/labelJobWorker.ts')

/** Migration dosyalarını sırayla uygular. */
function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const out = []
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) out.push(trimmed)
    }
  }
  return out
}

async function makeDb(t) {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  for (const statement of migrationStatements()) {
    try { await pglite.exec(statement) } catch { /* mevcut nesne */ }
  }
  const db = drizzle(pglite, { schema })
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'Queue Tenant', slug: `queue-${Date.now()}` }).returning()
  return { db, organizationId: org.id }
}

const scope = (organizationId, packageId) => ({
  organizationId, marketplace: 'Trendyol', carrier: 'Surat', packageId,
})

/* ═══ AUTO-1 — TEKİLLİK VERİTABANINDA ══════════════════════════════ */

test('QUEUE-1: ayni paket ON KEZ kesfedilse de TEK is satiri', async (t) => {
  const { db, organizationId } = await makeDb(t)
  const results = []
  for (let i = 0; i < 10; i += 1) {
    results.push(await QUEUE.enqueueLabelJob(db, scope(organizationId, 'PKG-1')))
  }
  assert.equal(results.filter((r) => r.enqueued).length, 1, 'birden fazla is olustu')
  assert.equal(results.filter((r) => !r.enqueued).length, 9)
  const stats = await QUEUE.labelJobStats(db, organizationId)
  assert.equal(stats.QUEUED, 1)
})

test('QUEUE-1b: es zamanli enqueue yarisinda da TEK satir', async (t) => {
  const { db, organizationId } = await makeDb(t)
  // Webhook ve stream AYNI ANDA kesfetti.
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      QUEUE.enqueueLabelJob(db, scope(organizationId, 'PKG-RACE'))),
  )
  assert.equal(results.filter((r) => r.enqueued).length, 1)
})

/* ═══ ATOMİK TALEP ═════════════════════════════════════════════════ */

test('QUEUE-2: iki worker AYNI isi TALEP EDEMEZ', async (t) => {
  const { db, organizationId } = await makeDb(t)
  for (let i = 0; i < 6; i += 1) {
    await QUEUE.enqueueLabelJob(db, scope(organizationId, `PKG-${i}`))
  }
  // Iki worker es zamanli talep eder.
  const [a, b] = await Promise.all([
    QUEUE.claimLabelJobs(db, { workerId: 'w-a', limit: 6 }),
    QUEUE.claimLabelJobs(db, { workerId: 'w-b', limit: 6 }),
  ])
  const ids = [...a, ...b].map((job) => job.id)
  assert.equal(new Set(ids).size, ids.length, 'ayni is iki worker tarafindan alindi')
  assert.equal(ids.length, 6, 'is kayboldu')
  // Talep edilen isler bir daha TALEP EDILMEZ.
  const again = await QUEUE.claimLabelJobs(db, { workerId: 'w-c', limit: 6 })
  assert.equal(again.length, 0)
})

/* ═══ AUTO-7 — AĞ SONRASI BELİRSİZLİK ══════════════════════════════ */

test('WORKER-1: ag gecildi + belirsiz → UNKNOWN_AFTER_NETWORK, tekrar YOK', async (t) => {
  const { db, organizationId } = await makeDb(t)
  await QUEUE.enqueueLabelJob(db, scope(organizationId, 'PKG-U'))
  let calls = 0
  const report = await WORKER.runLabelJobCycle({
    db, workerId: 'w1',
    runLabel: async () => {
      calls += 1
      return { labelReady: false, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(report.unknownAfterNetwork, 1)
  assert.equal(calls, 1)
  // Ikinci tur bu isi ALMAZ — otomatik ikinci create YOK.
  const second = await WORKER.runLabelJobCycle({
    db, workerId: 'w1',
    runLabel: async () => { calls += 1; return { labelReady: true, networkCrossed: true } },
  })
  assert.equal(second.claimed, 0, 'belirsiz is yeniden talep edildi')
  assert.equal(calls, 1, 'IKINCI CREATE YAPILDI')
})

test('WORKER-1b: worker istisnasi da IKINCI CREATE ACMAZ', async (t) => {
  const { db, organizationId } = await makeDb(t)
  await QUEUE.enqueueLabelJob(db, scope(organizationId, 'PKG-X'))
  let calls = 0
  await WORKER.runLabelJobCycle({
    db, workerId: 'w1',
    runLabel: async () => { calls += 1; throw new Error('boom') },
  })
  const second = await WORKER.runLabelJobCycle({
    db, workerId: 'w1',
    runLabel: async () => { calls += 1; return { labelReady: true, networkCrossed: true } },
  })
  assert.equal(second.claimed, 0)
  assert.equal(calls, 1)
})

test('WORKER-2: ag GECILMEDIYSE guvenle tekrar edilebilir', async (t) => {
  const { db, organizationId } = await makeDb(t)
  await QUEUE.enqueueLabelJob(db, scope(organizationId, 'PKG-R'))
  const report = await WORKER.runLabelJobCycle({
    db, workerId: 'w1',
    runLabel: async () => ({
      labelReady: false, networkCrossed: false, carrierCalls: 0,
      errorCode: 'TEMPORARY',
    }),
  })
  assert.equal(report.failedSafeToRetry, 1)
  assert.equal(report.carrierCalls, 0)
})

/* ═══ MUTLU YOL + SAYAÇLAR ═════════════════════════════════════════ */

test('WORKER-3: basarili is READY olur ve bir daha ALINMAZ', async (t) => {
  const { db, organizationId } = await makeDb(t)
  await QUEUE.enqueueLabelJob(db, scope(organizationId, 'PKG-OK'))
  const report = await WORKER.runLabelJobCycle({
    db, workerId: 'w1',
    runLabel: async () => ({ labelReady: true, networkCrossed: true, carrierCalls: 1 }),
  })
  assert.equal(report.ready, 1)
  assert.equal(report.carrierCalls, 1, 'paket basina TEK tasiyici cagrisi')
  const stats = await QUEUE.labelJobStats(db, organizationId)
  assert.equal(stats.READY, 1)
  const again = await WORKER.runLabelJobCycle({
    db, workerId: 'w1', runLabel: async () => ({ labelReady: true, networkCrossed: true }),
  })
  assert.equal(again.claimed, 0)
})

/* ═══ STRES — 500 PAKET, MÜKERRER KEŞİF ════════════════════════════ */

test('WORKER-STRESS: 500 paket · mukerrer kesif · paket basina <=1 create', async (t) => {
  const { db, organizationId } = await makeDb(t)
  const TOTAL = 500
  // Uc ayri mutabakat gecisi AYNI paketleri yeniden kesfeder.
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < TOTAL; i += 1) {
      await QUEUE.enqueueLabelJob(db, scope(organizationId, `PKG-${i}`))
    }
  }
  const queued = await QUEUE.labelJobStats(db, organizationId)
  assert.equal(queued.QUEUED, TOTAL, 'mukerrer kesif fazladan is yaratti')

  const createsByPackage = new Map()
  let maxConcurrent = 0
  let claimedTotal = 0
  for (let round = 0; round < 40; round += 1) {
    const report = await WORKER.runLabelJobCycle({
      db, workerId: `w-${round}`, batchSize: 50, concurrency: 2,
      runLabel: async (job) => {
        createsByPackage.set(
          job.packageId, (createsByPackage.get(job.packageId) ?? 0) + 1,
        )
        return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
      },
    })
    claimedTotal += report.claimed
    maxConcurrent = Math.max(maxConcurrent, report.maxConcurrentObserved)
    if (report.claimed === 0) break
  }

  assert.equal(claimedTotal, TOTAL, 'is kaybi/fazlasi')
  assert.equal(createsByPackage.size, TOTAL)
  for (const [packageId, count] of createsByPackage) {
    assert.equal(count, 1, `${packageId} icin ${count} create yapildi`)
  }
  // Sinirli eszamanlilik — binlerce es zamanli create YOK.
  assert.ok(maxConcurrent > 0, 'is hic calismadi')
  assert.ok(maxConcurrent <= 4, `eszamanlilik siniri asildi: ${maxConcurrent}`)
  const stats = await QUEUE.labelJobStats(db, organizationId)
  assert.equal(stats.READY, TOTAL)
})

/* ═══ ÇÖKME SONRASI ════════════════════════════════════════════════ */

test('WORKER-4: cokmus worker kilidi serbest kalir, is KAYBOLMAZ', async (t) => {
  const { db, organizationId } = await makeDb(t)
  await QUEUE.enqueueLabelJob(db, scope(organizationId, 'PKG-C'))
  // Worker isi aldi ve COKTU (tamamlamadi).
  const claimed = await QUEUE.claimLabelJobs(db, { workerId: 'dead', limit: 5 })
  assert.equal(claimed.length, 1)
  assert.equal((await QUEUE.claimLabelJobs(db, { workerId: 'w2', limit: 5 })).length, 0)
  // TAZE kilit serbest BIRAKILMAZ: calisan bir worker'in isi elinden
  // alinirsa AYNI paket icin ikinci create riski dogar.
  assert.equal(
    await QUEUE.releaseStaleLocks(db, { olderThanMs: 10 * 60 * 1000 }), 0,
    'taze kilit serbest birakildi',
  )
  // Kilidi gecmise tasi: worker COKTU.
  await db.execute(
    sql`UPDATE label_jobs SET locked_at = now() - interval '30 minutes'`,
  )
  const released = await QUEUE.releaseStaleLocks(db, { olderThanMs: 10 * 60 * 1000 })
  assert.equal(released, 1)
  assert.equal((await QUEUE.claimLabelJobs(db, { workerId: 'w2', limit: 5 })).length, 1)
})

/* ═══ ZAMANLAYICI VARSAYILAN KAPALI ════════════════════════════════ */

test('WORKER-5: zamanlayici varsayilan KAPALI', () => {
  assert.equal(WORKER.isLabelWorkerEnabled({}), false)
  assert.equal(WORKER.isLabelWorkerEnabled({ LABEL_WORKER_ENABLED: 'false' }), false)
  assert.equal(WORKER.isLabelWorkerEnabled({ LABEL_WORKER_ENABLED: '0' }), false)
  assert.equal(WORKER.isLabelWorkerEnabled({ LABEL_WORKER_ENABLED: 'true' }), true)
  // Kapaliyken kurulmaz → arka planda taşıyıcı mutasyonu OLMAZ.
  assert.equal(
    WORKER.startLabelJobScheduler({ runCycle: async () => {}, env: {} }), false,
  )
  WORKER.stopLabelJobScheduler()
})

test('WORKER-NO-SECOND-IMPL: worker KENDI Surat istemcisini KURMAZ', () => {
  const source = readFileSync(join(here, 'shipments', 'labelJobWorker.ts'), 'utf8')
  for (const forbidden of [
    'fetch(', 'OrtakBarkodOlustur', 'suratkargo', 'KullaniciAdi', 'whoPays',
  ]) {
    assert.equal(source.includes(forbidden), false, `worker sinirini asiyor: ${forbidden}`)
  }
})

test('QUEUE-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})
