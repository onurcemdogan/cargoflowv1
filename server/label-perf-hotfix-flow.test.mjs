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

test('HF-6: worker olayla HEMEN uyanır; tur sürerken gelen istek kaybolmaz, turlar üst üste binmez; yedek aralık ≤ 5 sn', async (t) => {
  assert.ok(worker.LABEL_WORKER_DEFAULT_INTERVAL_MS <= 5_000)
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
