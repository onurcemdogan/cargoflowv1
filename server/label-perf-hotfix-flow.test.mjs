import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// HOTFIX-LABEL-PERF — otomatik etiket zinciri (sunucu).
//
// Üretimde: worker + akış senkronu açık, kiracı otomatik etiketi açık,
// buna rağmen QUEUED=0 / PREPARING=0 ve kullanıcı tek siparişte Sürat
// create'ini ön planda bekliyordu. Kök nedenler:
//   1) Üretici penceresi EN ESKİDEN başlayıp 200 adayla sınırlıydı ve
//      işlenmiş paketleri dışlamıyordu → yeni siparişlere sıra gelmiyordu.
//   2) Elle "Şimdi Yenile" senkronu üreticiyi HİÇ çağırmıyordu.
//   3) Worker'ın tek tetiği 60 sn aralıktı.
// Bu dosya düzeltmeleri ve güvenlik sınırlarını kilitler.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const producer = await import('./shipments/autoLabelProducer.ts')
const worker = await import('./shipments/labelJobWorker.ts')

const DIR = join(root, 'drizzle')
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.sql')).sort()
const statementsOf = (file) =>
  readFileSync(join(DIR, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)

async function makeDb({ until } = {}) {
  const pglite = new PGlite()
  for (const file of FILES) {
    if (until && file >= until) break
    for (const statement of statementsOf(file)) await pglite.exec(statement)
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

const ACTIVATED_AT = new Date('2026-08-20T00:00:00.000Z')
const OLD_SEEN = new Date('2026-09-01T00:00:00.000Z')
const FRESH_SEEN = new Date('2026-10-12T09:00:00.000Z')

async function makeTenant(db) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `hf-${randomBytes(4).toString('hex')}` })
    .returning()
  const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
  await defaults.saveShipmentDefaults(db, org.id, {
    defaultUnitDesi: 2, multiplyByItemQuantity: false, labelPrintTemplate: 'cargoflow_html',
  })
  const credentials = await import('./integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })
  await producer.activateAutoLabel(db, org.id, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT.toISOString(),
  })
  return org.id
}

async function seedPackage(db, organizationId, packageId, options = {}) {
  const encryption = await import('./orders/orderEncryption.ts')
  const [order] = await db.insert(schema.orders).values({
    organizationId, marketplace: 'Trendyol', packageId,
    orderNumber: `ORD-${packageId}`,
    orderDate: options.firstSeenAt ?? FRESH_SEEN,
    cargoTrackingNumber: `7281${packageId.replace(/\D/g, '').slice(-6).padStart(6, '0')}`,
    operationStatus: 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Picking',
    cargoProviderName: 'Surat Kargo',
    firstSeenAt: options.firstSeenAt ?? FRESH_SEEN,
    rawPayloadEncrypted: encryption.encryptOrderPayload({ orderNumber: `ORD-${packageId}`, id: packageId }),
  }).returning()
  return order.id
}

const jobsOf = (db, organizationId) =>
  db.select().from(schema.labelJobs).where(eq(schema.labelJobs.organizationId, organizationId))

async function setFloor(db, organizationId, floorIso) {
  const rows = await db.select().from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, organizationId))
  const settings = rows[0].settingsJson
  await db.update(schema.organizationSettings)
    .set({ settingsJson: { ...settings, autoLabel: { ...settings.autoLabel, producerFloorAt: floorIso } } })
    .where(eq(schema.organizationSettings.organizationId, organizationId))
}

test('HF-1: 200+ işlenmiş/bloke eski aday pencereyi TIKAMAZ — yeni sipariş kuyruğa girer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  // Sınırdan SONRA görülmüş 230 eski paket: kargoya verilmiş (terminal).
  // Eski üretici bunları en eskiden 200'er 200'er inceliyor ve yeniye
  // HİÇ ulaşmıyordu.
  for (let index = 0; index < 230; index += 1) {
    await seedPackage(db, organizationId, `OLD-${String(index).padStart(4, '0')}`, {
      firstSeenAt: new Date(OLD_SEEN.getTime() + index * 1000),
      marketplaceStatus: 'Shipped',
    })
  }
  await seedPackage(db, organizationId, 'NEW-0001')

  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.enqueued, 1, `blocked=${JSON.stringify(report.blocked)}`)
  // Terminal paketler SQL'de elenir ama gözlem sayacı KORUNUR.
  assert.equal(report.blocked.MARKETPLACE_LIFECYCLE_TERMINAL, 230)
  assert.equal(report.examined, 1)
  const jobs = await jobsOf(db, organizationId)
  assert.deepEqual(jobs.map((job) => job.packageId), ['NEW-0001'])
})

test('HF-2: üretici alt sınırı — dağıtımdan ÖNCE görülen uygun 1086 aday otomatik İŞLENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  // Aktivasyon sınırından sonra görülmüş, UYGUN ama hiç incelenmemiş birikim.
  for (let index = 0; index < 12; index += 1) {
    await seedPackage(db, organizationId, `BACKLOG-${index}`, {
      firstSeenAt: new Date(OLD_SEEN.getTime() + index * 1000),
    })
  }
  await setFloor(db, organizationId, '2026-10-12T08:00:00.000Z')
  await seedPackage(db, organizationId, 'AFTER-FLOOR-1')

  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.enqueued, 1)
  const jobs = await jobsOf(db, organizationId)
  assert.deepEqual(jobs.map((job) => job.packageId), ['AFTER-FLOOR-1'], 'birikim kuyruğa ALINMAMALI')
})

test('HF-3: migration 0020 alt sınırı yalnız otomatik etiketi AÇIK kiracıya yazar; idempotent; yıkıcı değil', async (t) => {
  const migration = FILES.find((file) => file.startsWith('0020_'))
  assert.ok(migration, '0020 migration mevcut')
  const { pglite, db } = await makeDb({ until: migration })
  t.after(() => pglite.close())
  const enabledOrg = await makeTenant(db)
  const [disabled] = await db.insert(schema.organizations).values({ name: 'Kapali', slug: 'kapali-hf' }).returning()
  await db.insert(schema.organizationSettings).values({
    organizationId: disabled.id, settingsJson: { autoLabel: { enabled: false, activatedAt: ACTIVATED_AT.toISOString() }, other: 1 },
  })
  const before = (await pglite.query(`select settings_json from organization_settings where organization_id = $1`, [enabledOrg])).rows[0].settings_json

  for (const statement of statementsOf(migration)) await pglite.exec(statement)
  const after = (await pglite.query(`select organization_id, settings_json from organization_settings`)).rows
  const enabled = after.find((row) => row.organization_id === enabledOrg).settings_json
  const off = after.find((row) => row.organization_id === disabled.id).settings_json
  assert.match(enabled.autoLabel.producerFloorAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  // Başka hiçbir alan DEĞİŞMEZ.
  const { producerFloorAt, ...rest } = enabled.autoLabel
  assert.ok(producerFloorAt)
  assert.deepEqual(rest, before.autoLabel)
  assert.deepEqual(Object.keys(enabled).sort(), Object.keys(before).sort())
  assert.equal('producerFloorAt' in off.autoLabel, false, 'kapalı kiracıya yazılmaz')
  assert.equal(off.other, 1)

  // İkinci uygulama damgayı DEĞİŞTİRMEZ.
  for (const statement of statementsOf(migration)) await pglite.exec(statement)
  const again = (await pglite.query(`select settings_json from organization_settings where organization_id = $1`, [enabledOrg])).rows[0].settings_json
  assert.equal(again.autoLabel.producerFloorAt, producerFloorAt)
})

test('HF-4: ağ sınırını geçmiş belirsiz işlem (4238186037 vakası) otomatik create\'e DÖNÜŞMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, '4238186037')
  // Gönderi YOK, iz YOK, işlem hâlâ pending ama taşıyıcıya çıkılmış.
  await pglite.query(
    `INSERT INTO shipment_operations (organization_id, marketplace, package_id, provider, operation_type, idempotency_key, status, carrier_create_called, create_call_count)
     VALUES ($1, 'Trendyol', '4238186037', 'surat', 'CREATE', $2, 'pending', true, 1)`,
    [organizationId, `SURAT:${organizationId}:4238186037:CREATE`],
  )
  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.enqueued, 0)
  assert.equal(report.blocked.CARRIER_NETWORK_CROSSED, 1)
  assert.equal((await jobsOf(db, organizationId)).length, 0)
})

test('HF-5: yeni sipariş → üretici → worker → READY (taşıyıcı çağrısı tam 1); eşzamanlılık ≤ 2', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  for (let index = 0; index < 5; index += 1) await seedPackage(db, organizationId, `NEW-${index}`)
  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.enqueued, 5)

  let calls = 0
  const cycle = await worker.runLabelJobCycle({
    db,
    workerId: 'hf-5',
    runLabel: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(calls, 5, 'iş başına TEK create')
  assert.equal(cycle.ready, 5)
  assert.ok(cycle.maxConcurrentObserved <= 2, `eşzamanlılık ${cycle.maxConcurrentObserved}`)
  const jobs = await jobsOf(db, organizationId)
  assert.ok(jobs.every((job) => job.status === 'READY'))

  // Tekrar üretici + worker: READY paket için İKİNCİ iş / create YOK.
  const again = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(again.enqueued, 0)
  const second = await worker.runLabelJobCycle({
    db, workerId: 'hf-5b', runLabel: async () => { calls += 1; return { labelReady: true, networkCrossed: true, carrierCalls: 1 } },
  })
  assert.equal(second.claimed, 0)
  assert.equal(calls, 5)
})

// SÖZLEŞME DEĞİŞTİ (bellek hotfix'i, 2026-10-13): yedek yoklama 5 sn → 60 sn.
// Gecikmenin asıl mekanizması olay tetiğidir; yedek yalnız kurtarmadır.
test('HF-6: worker olayla HEMEN uyanır; tur sürerken gelen istek kaybolmaz, turlar üst üste binmez; yedek aralık 60 sn', async (t) => {
  assert.equal(worker.LABEL_WORKER_DEFAULT_INTERVAL_MS, 60_000)
  worker.stopLabelJobScheduler()
  t.after(() => worker.stopLabelJobScheduler())
  // Bayrak kapalıyken uyandırma HİÇBİR ŞEY yapmaz (taşıyıcı çağrısı yok).
  assert.equal(worker.requestLabelJobCycle(), false)

  let running = 0
  let maxRunning = 0
  let runs = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const started = worker.startLabelJobScheduler({
    env: { LABEL_WORKER_ENABLED: 'true' },
    intervalMs: 60_000,
    runCycle: async () => {
      runs += 1
      running += 1
      maxRunning = Math.max(maxRunning, running)
      if (runs === 1) await gate
      running -= 1
    },
  })
  assert.equal(started, true)
  const t0 = Date.now()
  assert.equal(worker.requestLabelJobCycle(), true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runs, 1, 'aralık beklenmeden çalıştı')
  assert.ok(Date.now() - t0 < 1_000)
  // Tur sürerken iki istek → tur bitince TEK ek tur.
  worker.requestLabelJobCycle()
  worker.requestLabelJobCycle()
  release()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(runs, 2)
  assert.equal(maxRunning, 1, 'turlar üst üste binmez')
})

test('HF-7: çalışma zamanı bağlantısı — elle senkron üreticiyi besler (yanıtı bekletmeden), üretici worker\'ı uyandırır', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const manual = source.slice(source.indexOf("app.post('/api/orders/sync'"), source.indexOf('\n})', source.indexOf("app.post('/api/orders/sync'")))
  assert.match(manual, /void enqueueAutoLabelAfterSync\(context\.db, context\.organizationId\)/)
  const feed = source.slice(source.indexOf('async function enqueueAutoLabelAfterSync'), source.indexOf('async function syncTrendyolOrdersForOrganization'))
  assert.match(feed, /requestLabelJobCycle\(\)/)
  // Worker HÂLÂ elle butonla AYNI kanonik create yolunu kullanır.
  const boot = source.slice(source.indexOf('async function startLabelJobWorkerOnBoot'), source.indexOf('async function startTrendyolStreamSyncOnBoot'))
  assert.match(boot, /runLabel: runLabelJobViaCreateHandler/)
})

// ═══ MEM: BELLEK KAÇAĞI HOTFIX'İ — WORKER YOKLAMASI ═══════════════════════

function captureSetInterval() {
  const calls = []
  const original = globalThis.setInterval
  globalThis.setInterval = (fn, delay, ...rest) => {
    calls.push(delay)
    return original(fn, delay, ...rest)
  }
  return { calls, restore: () => { globalThis.setInterval = original } }
}

test('MEM-5: üretici kuyruğa aldığında worker 60 sn yedeği beklemeden HEMEN uyanır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  worker.stopLabelJobScheduler()
  t.after(() => worker.stopLabelJobScheduler())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, 'WAKE-1')

  let calls = 0
  let resolveRan
  const ran = new Promise((resolve) => { resolveRan = resolve })
  // Aralık VERİLMEZ → üretim varsayılanı (60 sn); tek tetik olaydır.
  const started = worker.startLabelJobScheduler({
    env: { LABEL_WORKER_ENABLED: 'true' },
    runCycle: async () => {
      const report = await worker.runLabelJobCycle({
        db,
        workerId: 'mem-5',
        runLabel: async () => { calls += 1; return { labelReady: true, networkCrossed: true, carrierCalls: 1 } },
      })
      if (report.claimed > 0) resolveRan()
      return report
    },
  })
  assert.equal(started, true)
  const t0 = Date.now()
  // index.mjs `enqueueAutoLabelAfterSync` ile AYNI sıra: kuyruğa al → uyandır.
  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.enqueued, 1)
  assert.equal(worker.requestLabelJobCycle(), true)
  await Promise.race([ran, new Promise((_, reject) => setTimeout(() => reject(new Error('worker uyanmadı')), 5_000))])
  assert.ok(Date.now() - t0 < 5_000, 'yedek aralığı beklenmedi')
  assert.equal(calls, 1)

  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const feed = source.slice(source.indexOf('async function enqueueAutoLabelAfterSync'), source.indexOf('async function syncTrendyolOrdersForOrganization'))
  assert.ok(
    feed.indexOf('enqueueEligibleAutoLabelJobs(db, organizationId)') < feed.indexOf('worker.requestLabelJobCycle()'),
    'uyandırma kuyruğa almadan SONRA',
  )
})

// SÖZLEŞME DEĞİŞTİ (ikinci bellek hotfix'i, 2026-10-13): yedek yoklama artık
// VARSAYILAN KAPALI; yalnız LABEL_WORKER_POLL_ENABLED ile 60 sn kurulur.
test('MEM-6: worker yedek yoklaması varsayılan KAPALI, açıkça açılınca 60 sn; açılışta tek kurtarma turu', async (t) => {
  worker.stopLabelJobScheduler()
  const spy = captureSetInterval()
  t.after(() => { spy.restore(); worker.stopLabelJobScheduler() })
  let runs = 0
  assert.equal(worker.startLabelJobScheduler({
    env: { LABEL_WORKER_ENABLED: 'true' },
    runCycle: async () => { runs += 1 },
  }), true)
  assert.deepEqual(spy.calls, [], 'yoklama bayrağı yokken zamanlayıcı KURULMAZ')
  worker.stopLabelJobScheduler()
  const started = worker.startLabelJobScheduler({
    env: { LABEL_WORKER_ENABLED: 'true', LABEL_WORKER_POLL_ENABLED: 'true' },
    runCycle: async () => { runs += 1 },
  })
  assert.equal(started, true)
  assert.deepEqual(spy.calls, [60_000])
  // Yedek tik 60 sn'den önce gelmez: kısa beklemede hiçbir tur koşmaz.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(runs, 0)

  // Bayrak kapalıyken zamanlayıcı da uyandırma da YOK.
  worker.stopLabelJobScheduler()
  assert.equal(worker.startLabelJobScheduler({ env: {}, runCycle: async () => { runs += 1 } }), false)
  assert.equal(worker.requestLabelJobCycle(), false)

  // Açılış: zamanlayıcı kurulduysa TEK kurtarma turu hemen istenir; aralık
  // üretimde verilmez (varsayılan 60 sn).
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const boot = source.slice(source.indexOf('async function startLabelJobWorkerOnBoot'), source.indexOf('async function startTrendyolStreamSyncOnBoot'))
  assert.doesNotMatch(boot, /intervalMs/)
  assert.equal(boot.match(/requestLabelJobCycle\(\)/g)?.length, 1)
  assert.match(boot, /if \(started\) \{[\s\S]*worker\.requestLabelJobCycle\(\)/)
})

// ═══ POLL: İKİNCİ BELLEK HOTFIX'İ — YEDEK YOKLAMA VARSAYILAN KAPALI ══════
//
// ÜRETİM İZOLASYON KANITI (master b1cfb0a): paket mutabakatı kapalıyken
// worker KAPALI → stabil; worker AÇIK → ~602 → ~867 MB ve PM2 restart
// (PREPARING yok, UNKNOWN 25'te sabit). Heap snapshot yok; şüpheli 60 sn'lik
// tam worker turu. Worker artık olay güdümlü; yoklama yalnız açık bayrakla.

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

test('POLL-1: worker açık + LABEL_WORKER_POLL_ENABLED tanımsız/kapalı → zamanlayıcı KURULMAZ, olay tetiği etkin', async (t) => {
  worker.stopLabelJobScheduler()
  const spy = captureSetInterval()
  t.after(() => { spy.restore(); worker.stopLabelJobScheduler() })
  for (const poll of [undefined, '', 'false', 'FALSE', '0', 'yes', 'off', 'on']) {
    const env = { LABEL_WORKER_ENABLED: 'true' }
    if (poll !== undefined) env.LABEL_WORKER_POLL_ENABLED = poll
    assert.equal(worker.startLabelJobScheduler({ env, runCycle: async () => {} }), true)
    assert.equal(worker.isLabelJobSchedulerActive(), true, `poll=${poll}: worker etkin`)
    assert.equal(worker.isLabelWorkerPollActive(), false, `poll=${poll}: yoklama kapalı`)
    worker.stopLabelJobScheduler()
  }
  assert.deepEqual(spy.calls, [], 'hiçbir 60 sn zamanlayıcı kurulmamalı')
  assert.equal(worker.isLabelWorkerPollEnabled({}), false)
})

test('POLL-2: LABEL_WORKER_POLL_ENABLED=true/TRUE/1 → 60 sn yedek yoklama kurulur', async (t) => {
  worker.stopLabelJobScheduler()
  const spy = captureSetInterval()
  t.after(() => { spy.restore(); worker.stopLabelJobScheduler() })
  for (const poll of ['true', 'TRUE', '1']) {
    assert.equal(worker.startLabelJobScheduler({
      env: { LABEL_WORKER_ENABLED: 'true', LABEL_WORKER_POLL_ENABLED: poll },
      runCycle: async () => {},
    }), true)
    assert.equal(worker.isLabelWorkerPollActive(), true, `poll=${poll}`)
    worker.stopLabelJobScheduler()
    assert.equal(worker.isLabelWorkerPollActive(), false)
  }
  assert.deepEqual(spy.calls, [60_000, 60_000, 60_000])
  // Worker bayrağıyla AYNI anlam.
  for (const value of ['true', 'TRUE', '1', '', 'false', '0', 'yes', 'off']) {
    assert.equal(
      worker.isLabelWorkerPollEnabled({ LABEL_WORKER_POLL_ENABLED: value }),
      worker.isLabelWorkerEnabled({ LABEL_WORKER_ENABLED: value }),
      `'${value}'`,
    )
  }
})

test('POLL-3: yoklama kapalıyken requestLabelJobCycle() turu HEMEN çalıştırır', async (t) => {
  worker.stopLabelJobScheduler()
  t.after(() => worker.stopLabelJobScheduler())
  let runs = 0
  worker.startLabelJobScheduler({ env: { LABEL_WORKER_ENABLED: 'true' }, runCycle: async () => { runs += 1 } })
  assert.equal(worker.isLabelWorkerPollActive(), false)
  assert.equal(runs, 0, 'başlatma tek başına tur açmaz')
  assert.equal(worker.requestLabelJobCycle(), true)
  await tick()
  assert.equal(runs, 1)
})

test('POLL-4: yoklama kapalıyken tur sürerken gelen uyandırma kaybolmaz; tur bitince TEK kez yeniden koşar', async (t) => {
  worker.stopLabelJobScheduler()
  t.after(() => worker.stopLabelJobScheduler())
  let runs = 0
  let running = 0
  let maxRunning = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  worker.startLabelJobScheduler({
    env: { LABEL_WORKER_ENABLED: 'true' },
    runCycle: async () => {
      runs += 1
      running += 1
      maxRunning = Math.max(maxRunning, running)
      if (runs === 1) await gate
      running -= 1
    },
  })
  assert.equal(worker.isLabelWorkerPollActive(), false)
  worker.requestLabelJobCycle()
  await tick()
  assert.equal(runs, 1)
  // Tur sürerken üç uyandırma → tur bitince YALNIZ bir ek tur.
  assert.equal(worker.requestLabelJobCycle(), true)
  worker.requestLabelJobCycle()
  worker.requestLabelJobCycle()
  release()
  await tick(40)
  assert.equal(runs, 2)
  assert.equal(maxRunning, 1, 'turlar üst üste binmez')
  await tick(40)
  assert.equal(runs, 2, 'zamanlayıcı yokken kendiliğinden tur açılmaz')
})

test('POLL-5: açılış TEK kurtarma turu çağırır; sonrasında kendiliğinden tur yok', async (t) => {
  worker.stopLabelJobScheduler()
  t.after(() => worker.stopLabelJobScheduler())
  // index.mjs `startLabelJobWorkerOnBoot` sırası: kur → başladıysa tek uyandırma.
  let runs = 0
  const started = worker.startLabelJobScheduler({ env: { LABEL_WORKER_ENABLED: 'true' }, runCycle: async () => { runs += 1 } })
  if (started) worker.requestLabelJobCycle()
  await tick(60)
  assert.equal(runs, 1)

  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const boot = source.slice(source.indexOf('async function startLabelJobWorkerOnBoot'), source.indexOf('async function startTrendyolStreamSyncOnBoot'))
  assert.equal(boot.match(/requestLabelJobCycle\(\)/g)?.length, 1, 'açılışta tek kurtarma turu')
  assert.doesNotMatch(boot, /intervalMs|LABEL_WORKER_POLL_ENABLED\s*[:=]/, 'açılış yoklamayı kendisi açmaz')
  assert.match(boot, /isLabelWorkerPollActive\(\)/, 'günlük yoklama durumunu yazar')
})

test('POLL-6: worker kapalı / durdurulmuş / boşaltılıyorken uyandırma HİÇBİR ŞEY yapmaz', async (t) => {
  worker.stopLabelJobScheduler()
  t.after(() => worker.stopLabelJobScheduler())
  let runs = 0
  const runCycle = async () => { runs += 1 }
  // LABEL_WORKER_ENABLED kapalı → kurulmaz, uyandırma yok.
  for (const value of [undefined, '', 'false', '0']) {
    const env = value === undefined ? {} : { LABEL_WORKER_ENABLED: value }
    assert.equal(worker.startLabelJobScheduler({ env: { ...env, LABEL_WORKER_POLL_ENABLED: 'true' }, runCycle }), false)
    assert.equal(worker.isLabelJobSchedulerActive(), false)
    assert.equal(worker.requestLabelJobCycle(), false)
  }
  // Durdurulmuş worker uyanmaz.
  worker.startLabelJobScheduler({ env: { LABEL_WORKER_ENABLED: 'true' }, runCycle })
  worker.stopLabelJobScheduler()
  assert.equal(worker.requestLabelJobCycle(), false)
  // Boşaltılan worker uyanmaz ve yeniden kurulmaz.
  worker.startLabelJobScheduler({ env: { LABEL_WORKER_ENABLED: 'true' }, runCycle })
  const drained = await worker.drainLabelJobScheduler(100)
  assert.equal(drained.drained, true)
  assert.equal(worker.isLabelJobSchedulerActive(), false)
  assert.equal(worker.requestLabelJobCycle(), false)
  assert.equal(worker.startLabelJobScheduler({ env: { LABEL_WORKER_ENABLED: 'true' }, runCycle }), false)
  await tick()
  assert.equal(runs, 0, 'hiçbir tur koşmamalı')
})

test('POLL-7: UNKNOWN_AFTER_NETWORK — yoklama kapalı worker\'a tekrarlı uyandırma ikinci create ÜRETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  worker.stopLabelJobScheduler()
  t.after(() => worker.stopLabelJobScheduler())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, 'UNK-POLL')

  let calls = 0
  let cycles = 0
  worker.startLabelJobScheduler({
    env: { LABEL_WORKER_ENABLED: 'true' },
    runCycle: async () => {
      cycles += 1
      return worker.runLabelJobCycle({
        db,
        workerId: `poll-7-${cycles}`,
        // Ağa çıkıldı, sonuç belirsiz.
        runLabel: async () => { calls += 1; return { labelReady: false, networkCrossed: true, carrierCalls: 1 } },
      })
    },
  })
  assert.equal(worker.isLabelWorkerPollActive(), false)
  const waitIdle = async (target) => {
    for (let i = 0; i < 200 && cycles < target; i += 1) await tick(10)
    await tick(30)
  }
  assert.equal((await producer.enqueueEligibleAutoLabelJobs(db, organizationId)).enqueued, 1)
  worker.requestLabelJobCycle()
  await waitIdle(1)
  assert.equal(calls, 1)
  assert.deepEqual((await jobsOf(db, organizationId)).map((job) => job.status), ['UNKNOWN_AFTER_NETWORK'])

  for (let round = 2; round <= 4; round += 1) {
    assert.equal((await producer.enqueueEligibleAutoLabelJobs(db, organizationId)).enqueued, 0)
    worker.requestLabelJobCycle()
    await waitIdle(round)
  }
  assert.ok(cycles >= 4, `uyandırmalar tur açtı (${cycles})`)
  assert.equal(calls, 1, 'ikinci create YOK')
  assert.deepEqual((await jobsOf(db, organizationId)).map((job) => job.status), ['UNKNOWN_AFTER_NETWORK'])
})

test('MEM-7: UNKNOWN_AFTER_NETWORK işi bir daha ASLA create\'e gitmez (worker turu, uyandırma, üretici tekrarı)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, 'UNK-1')
  assert.equal((await producer.enqueueEligibleAutoLabelJobs(db, organizationId)).enqueued, 1)

  let calls = 0
  // Ağa çıkıldı, sonuç belirsiz.
  const runLabel = async () => { calls += 1; return { labelReady: false, networkCrossed: true, carrierCalls: 1 } }
  const first = await worker.runLabelJobCycle({ db, workerId: 'mem-7a', runLabel })
  assert.equal(first.unknownAfterNetwork, 1)
  assert.equal(calls, 1)
  assert.deepEqual((await jobsOf(db, organizationId)).map((job) => job.status), ['UNKNOWN_AFTER_NETWORK'])

  // Tekrarlı tetikler: üretici yeniden besler, worker defalarca uyanır.
  for (let round = 0; round < 3; round += 1) {
    const again = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
    assert.equal(again.enqueued, 0, 'belirsiz paket yeniden kuyruğa girmez')
    const cycle = await worker.runLabelJobCycle({ db, workerId: `mem-7-${round}`, runLabel })
    assert.equal(cycle.claimed, 0, 'belirsiz iş tekrar talep edilmez')
  }
  assert.equal(calls, 1, 'ikinci create YOK')
  assert.deepEqual((await jobsOf(db, organizationId)).map((job) => job.status), ['UNKNOWN_AFTER_NETWORK'])
})
