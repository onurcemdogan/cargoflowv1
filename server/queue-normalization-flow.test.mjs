import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// ═══ KUYRUK NORMALİZASYONU — ÜRETİMDEKİ 13 SATIRIN TAM ŞEKLİ ════════════
//
// ADLİ SONUÇ: bu satırlar MEVCUT üretici tarafından yaratılmadı.
//   • 4111722658 created_at = 2026-08-29 01:48:57 +03
//   • diğer 12 satır updated_at = 2026-08-29 01:34:04 +03
//   • mevcut süreç (5f366f8) 09:50:03 +03'te başladı
// Yani ESKİ koddan kalan durum kirliliğidir.
//
// Bu dosya iki ayrı şeyi ölçer:
//   1. Tek seferlik normalizasyon aracı kirli satırları doğru taşıyor mu?
//   2. MEVCUT üretici aynı şekilleri ARTIK üretmiyor mu? (karışıklık
//      bir daha yaşanmasın diye ayrı ayrı kanıtlanır.)
//
// VITE KULLANILMAZ. GERÇEK TAŞIYICI ÇAĞRISI YOKTUR.

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
  const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
  await defaults.saveShipmentDefaults(db, org.id, {
    defaultUnitDesi: options.desi ?? 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  const credentials = await import('./integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })
  const producer = await import('./shipments/autoLabelProducer.ts')
  await producer.activateAutoLabel(db, org.id, {
    marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
  })
  return org.id
}

async function seedQueued(db, organizationId, packageId, options = {}) {
  const encryption = await import('./orders/orderEncryption.ts')
  await db.insert(schema.orders).values({
    organizationId, marketplace: 'Trendyol', packageId,
    orderNumber: `ORD-${packageId}`,
    orderDate: new Date('2026-08-20T00:00:00.000Z'),
    cargoTrackingNumber: `7281${packageId.slice(-6)}`,
    operationStatus: 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Picking',
    cargoProviderName: 'Surat Kargo',
    firstSeenAt: new Date('2026-08-20T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload({
      orderNumber: `ORD-${packageId}`, id: packageId,
    }),
  })
  const [job] = await db.insert(schema.labelJobs).values({
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId, jobType: 'LABEL_PREPARE',
    status: options.jobStatus ?? 'QUEUED',
    attemptCount: options.attemptCount ?? 0,
    lastErrorCode: options.lastErrorCode ?? null,
  }).returning()
  return job
}

async function jobsByPackage(db) {
  const rows = await db.select().from(schema.labelJobs)
  return Object.fromEntries(rows.map((row) => [row.packageId, row]))
}

/** Üretimde gözlenen 13 satırın TAM şekli. */
const PRODUCTION_SHAPES = [
  // Kategori A — terminal / şu an uygun değil
  { packageId: '4110043440', marketplaceStatus: 'Shipped', attemptCount: 37 },
  { packageId: '4110126395', marketplaceStatus: 'Shipped', attemptCount: 20 },
  { packageId: '4110143271', marketplaceStatus: 'Shipped', attemptCount: 16 },
  { packageId: '4110188925', marketplaceStatus: 'Shipped', attemptCount: 8 },
  { packageId: '4111338022', marketplaceStatus: 'Created', attemptCount: 1 },
  { packageId: '4111412351', marketplaceStatus: 'Created', attemptCount: 1 },
  { packageId: '4111508763', marketplaceStatus: 'Created', attemptCount: 1 },
  { packageId: '4111722658', marketplaceStatus: 'Cancelled', attemptCount: 0 },
  // Kategori B — Picking, hazırlık geçerli, tarihsel desi blokçusu
  {
    packageId: '4110352749', marketplaceStatus: 'Picking', attemptCount: 1,
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  },
  {
    packageId: '4110388725', marketplaceStatus: 'Picking', attemptCount: 1,
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  },
  {
    packageId: '4110522157', marketplaceStatus: 'Picking', attemptCount: 1,
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  },
  {
    packageId: '4110561448', marketplaceStatus: 'Picking', attemptCount: 1,
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  },
  {
    packageId: '4110667628', marketplaceStatus: 'Picking', attemptCount: 1,
    lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
  },
]

async function seedProductionShapes(db, organizationId) {
  const seeded = {}
  for (const shape of PRODUCTION_SHAPES) {
    seeded[shape.packageId] = await seedQueued(
      db, organizationId, shape.packageId, shape,
    )
  }
  return seeded
}

/* ═══ NORMALIZE-1 / 2 / 3 / 4 ════════════════════════════════════════ */

test('NORMALIZE-1/2/3/4: 13 uretim satiri DOGRU siniflandirilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedProductionShapes(db, organizationId)
  const normalizer = await import('./shipments/queueNormalizer.ts')

  const report = await normalizer.inspectQueueNormalization(db, { organizationId })
  assert.equal(report.queuedTotal, 13)
  assert.equal(report.safeCount, 13)
  // SALT OKUNUR.
  assert.equal(report.networkCalls, 0)
  assert.equal(report.dbWrites, 0)
  assert.equal(report.carrierCalls, 0)

  const byPackage = Object.fromEntries(
    report.candidates.map((candidate) => [candidate.packageId, candidate]),
  )

  // NORMALIZE-1 — Shipped (terminal)
  for (const packageId of ['4110043440', '4110126395', '4110143271', '4110188925']) {
    const candidate = byPackage[packageId]
    assert.equal(candidate.marketplaceLifecycle, 'TERMINAL', packageId)
    assert.equal(candidate.verdict, 'NORMALIZE_TO_BLOCKED_INELIGIBLE', packageId)
    assert.equal(candidate.targetState, 'BLOCKED', packageId)
    assert.equal(candidate.targetErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
    assert.equal(candidate.safeToNormalize, true, packageId)
  }
  // NORMALIZE-2 — Created (henüz değil)
  for (const packageId of ['4111338022', '4111412351', '4111508763']) {
    const candidate = byPackage[packageId]
    assert.equal(candidate.marketplaceLifecycle, 'NOT_YET', packageId)
    assert.equal(candidate.targetErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
    assert.equal(candidate.safeToNormalize, true, packageId)
  }
  // NORMALIZE-3 — Cancelled (terminal)
  assert.equal(byPackage['4111722658'].marketplaceLifecycle, 'TERMINAL')
  assert.equal(byPackage['4111722658'].verdict, 'NORMALIZE_TO_BLOCKED_INELIGIBLE')
  assert.equal(byPackage['4111722658'].targetState, 'BLOCKED')

  // NORMALIZE-4 — Picking, hazırlık GEÇERLİ, tarihsel satır
  for (const packageId of [
    '4110352749', '4110388725', '4110522157', '4110561448', '4110667628',
  ]) {
    const candidate = byPackage[packageId]
    assert.equal(candidate.marketplaceLifecycle, 'ELIGIBLE', packageId)
    assert.equal(candidate.currentPreflightValid, true, packageId)
    assert.equal(candidate.currentDesi, 2, packageId)
    assert.equal(candidate.currentCredentialResolved, true, packageId)
    assert.equal(candidate.queueOrigin, 'HISTORICAL_POLLUTION', packageId)
    assert.equal(candidate.verdict, 'NORMALIZE_TO_BLOCKED_HISTORICAL', packageId)
    assert.equal(candidate.targetState, 'BLOCKED', packageId)
    // TARIHSEL blokcu KORUNUR → canlandirma araci bunlari TANIYABILIR.
    assert.equal(candidate.targetErrorCode, 'SURAT_PREFLIGHT_DESI_MISSING')
  }
})

/* ═══ NORMALIZE-5 / 6 / 11 ═══════════════════════════════════════════ */

test('NORMALIZE-5/6/11: uygulama kimligi ve sayaci KORUR, tasiyici cagrisi 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const seeded = await seedProductionShapes(db, organizationId)
  const normalizer = await import('./shipments/queueNormalizer.ts')
  const beforeCount = (await db.select().from(schema.labelJobs)).length
  const beforeOps = (await db.select().from(schema.shipmentOperations)).length

  const result = await normalizer.applyQueueNormalization(db, { organizationId })

  assert.equal(result.normalized, 13)
  assert.equal(result.carrierCalls, 0)
  assert.equal(result.networkCalls, 0)

  const after = await jobsByPackage(db)
  for (const shape of PRODUCTION_SHAPES) {
    const row = after[shape.packageId]
    assert.equal(row.status, 'BLOCKED', shape.packageId)
    // NORMALIZE-6 — AYNI is kimligi.
    assert.equal(row.id, seeded[shape.packageId].id, shape.packageId)
    // NORMALIZE-5 — attempt_count KORUNUR.
    assert.equal(row.attemptCount, shape.attemptCount, shape.packageId)
    // created_at KORUNUR.
    assert.equal(
      row.createdAt.getTime(), seeded[shape.packageId].createdAt.getTime(),
      shape.packageId,
    )
  }
  // Yeni is / operasyon YARATILMADI.
  assert.equal((await db.select().from(schema.labelJobs)).length, beforeCount)
  assert.equal((await db.select().from(schema.shipmentOperations)).length, beforeOps)
  assert.equal((await db.select().from(schema.shipments)).length, 0)
})

/* ═══ NORMALIZE-7 / 8 / 9 ════════════════════════════════════════════ */

test('NORMALIZE-7/8/9: tasiyici cagrisi / UNKNOWN / artefakt REDDEDILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)

  // 7 — tasiyiciya gidilmis
  await seedQueued(db, organizationId, '4111000007', { attemptCount: 1 })
  await db.insert(schema.shipmentOperations).values({
    organizationId, marketplace: 'Trendyol', packageId: '4111000007',
    orderNumber: 'ORD-4111000007', provider: 'surat',
    operationType: 'OrtakBarkodOlustur', idempotencyKey: 'idem-7',
    status: 'pending', createCallCount: 1, carrierCreateCalled: true,
  })
  // 8 — UNKNOWN kaniti (ayni paket icin ikinci is satiri)
  await seedQueued(db, organizationId, '4111000008', { attemptCount: 1 })
  await db.insert(schema.labelJobs).values({
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId: '4111000008', jobType: 'LABEL_REPRINT',
    status: 'UNKNOWN_AFTER_NETWORK', attemptCount: 2,
  })
  // 9 — artefakt
  await seedQueued(db, organizationId, '4111000009', { attemptCount: 1 })
  await db.insert(schema.shipments).values({
    organizationId, marketplace: 'Trendyol', packageId: '4111000009',
    provider: 'surat', trackingNumber: '7281000009',
    source: 'local_create', status: 'created',
  })

  const normalizer = await import('./shipments/queueNormalizer.ts')
  const report = await normalizer.inspectQueueNormalization(db, { organizationId })
  const byPackage = Object.fromEntries(
    report.candidates.map((candidate) => [candidate.packageId, candidate]),
  )
  for (const packageId of ['4111000007', '4111000008', '4111000009']) {
    assert.equal(byPackage[packageId].verdict, 'REFUSED_NETWORK_EVIDENCE', packageId)
    assert.equal(byPackage[packageId].safeToNormalize, false, packageId)
    assert.equal(byPackage[packageId].targetState, null, packageId)
  }

  const result = await normalizer.applyQueueNormalization(db, { organizationId })
  assert.equal(result.normalized, 0, 'ag kanitli satir NORMALIZE EDILDI')
  // 4111000008 icin IKI satir var (QUEUED + UNKNOWN_AFTER_NETWORK); paket
  // anahtarli harita ikincisini ezer. Bu yuzden HEDEF satir is turuyle
  // secilir — yoksa yanlis satiri olcerdik.
  const rows = await db.select().from(schema.labelJobs)
  for (const packageId of ['4111000007', '4111000008', '4111000009']) {
    const target = rows.find(
      (row) => row.packageId === packageId && row.jobType === 'LABEL_PREPARE',
    )
    assert.equal(target.status, 'QUEUED', packageId)
  }
  // UNKNOWN satiri da DOKUNULMADI.
  const unknownRow = rows.find((row) => row.jobType === 'LABEL_REPRINT')
  assert.equal(unknownRow.status, 'UNKNOWN_AFTER_NETWORK')
})

/* ═══ NORMALIZE-10 ═══════════════════════════════════════════════════ */

test('NORMALIZE-10: ikinci calistirma SIFIR yazim uretir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedProductionShapes(db, organizationId)
  const normalizer = await import('./shipments/queueNormalizer.ts')

  const first = await normalizer.applyQueueNormalization(db, { organizationId })
  assert.equal(first.normalized, 13)
  const afterFirst = await jobsByPackage(db)

  const second = await normalizer.applyQueueNormalization(db, { organizationId })
  assert.equal(second.normalized, 0, 'ikinci calistirma YAZIM yapti')
  assert.equal(second.report.queuedTotal, 0)

  const afterSecond = await jobsByPackage(db)
  for (const shape of PRODUCTION_SHAPES) {
    assert.equal(
      afterSecond[shape.packageId].updatedAt.getTime(),
      afterFirst[shape.packageId].updatedAt.getTime(),
      `${shape.packageId} ikinci calistirmada DEGISTI`,
    )
  }
})

/* ═══ NORMALIZE-12 ═══════════════════════════════════════════════════ */

test('NORMALIZE-12: eszamanli normalizasyon GUVENLI (tek gecis)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedQueued(db, organizationId, '4111000012', {
    marketplaceStatus: 'Cancelled', attemptCount: 1,
  })
  const normalizer = await import('./shipments/queueNormalizer.ts')

  const results = await Promise.all([
    normalizer.applyQueueNormalization(db, { organizationId }),
    normalizer.applyQueueNormalization(db, { organizationId }),
    normalizer.applyQueueNormalization(db, { organizationId }),
  ])
  const total = results.reduce((sum, result) => sum + result.normalized, 0)
  assert.equal(total, 1, `ayni satir ${total} kez normalize edildi`)
  const after = await jobsByPackage(db)
  assert.equal(after['4111000012'].status, 'BLOCKED')
  assert.equal(after['4111000012'].attemptCount, 1)
  assert.equal((await db.select().from(schema.labelJobs)).length, 1)
})

/* ═══ TAZE MEŞRU SATIR DOKUNULMAZ ════════════════════════════════════ */

test('NORMALIZE-13: taze ve gecerli satir (attempt=0) DOKUNULMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedQueued(db, organizationId, '4111000013', {
    marketplaceStatus: 'Picking', attemptCount: 0,
  })
  const normalizer = await import('./shipments/queueNormalizer.ts')

  const report = await normalizer.inspectQueueNormalization(db, { organizationId })
  assert.equal(report.candidates[0].verdict, 'LEAVE_QUEUED_FRESH')
  assert.equal(report.candidates[0].queueOrigin, 'FRESH_PRODUCER')
  assert.equal(report.candidates[0].safeToNormalize, false)

  const result = await normalizer.applyQueueNormalization(db, { organizationId })
  assert.equal(result.normalized, 0)
  assert.equal((await jobsByPackage(db))['4111000013'].status, 'QUEUED')
})

/* ═══ NORMALİZASYON SONRASI CANLANDIRMA GÖRÜNÜRLÜĞÜ ══════════════════ */

test('NORMALIZE-14: normalizasyon sonrasi canlandirma araci B satirlarini TANIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedProductionShapes(db, organizationId)
  const normalizer = await import('./shipments/queueNormalizer.ts')
  await normalizer.applyQueueNormalization(db, { organizationId })

  const inspector = await import('./shipments/revivalInspector.ts')
  const report = await inspector.inspectRevivalCandidates(db, { organizationId })
  const byPackage = Object.fromEntries(
    report.candidates.map((candidate) => [candidate.packageId, candidate]),
  )
  // B satirlari: hazirlik gecerli + bagimlilik sinifi kod → SAFE_TO_REVIVE.
  for (const packageId of [
    '4110352749', '4110388725', '4110522157', '4110561448', '4110667628',
  ]) {
    assert.equal(byPackage[packageId].safeToRevive, true, packageId)
  }
  // A satirlari: hala uygun degil → canlandirilmaz.
  for (const packageId of [
    '4110043440', '4111338022', '4111722658',
  ]) {
    assert.equal(byPackage[packageId].safeToRevive, false, packageId)
  }
})

/* ═══ MEVCUT ÜRETİCİ DAVRANIŞI — AYRI KANIT ══════════════════════════ */

test('PRODUCER-NOW: mevcut uretici Cancelled/Shipped icin IS EKLEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const encryption = await import('./orders/orderEncryption.ts')
  const producer = await import('./shipments/autoLabelProducer.ts')

  for (const [packageId, status] of [
    ['4111900001', 'Cancelled'],
    ['4111900002', 'Shipped'],
    ['4111900003', 'Created'],
    ['4111900004', 'Picking'],
    ['4111900005', 'Delivered'],
    ['4111900006', 'Returned'],
  ]) {
    await db.insert(schema.orders).values({
      organizationId, marketplace: 'Trendyol', packageId,
      orderNumber: `ORD-${packageId}`,
      orderDate: new Date('2026-08-26T00:00:00.000Z'),
      cargoTrackingNumber: `7281${packageId.slice(-6)}`,
      operationStatus: 'NEW', marketplaceStatus: status,
      cargoProviderName: 'Surat Kargo',
      firstSeenAt: new Date('2026-08-26T00:00:00.000Z'),
      rawPayloadEncrypted: encryption.encryptOrderPayload({
        orderNumber: `ORD-${packageId}`, id: packageId,
      }),
    })
  }

  await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  const after = await jobsByPackage(db)

  // Terminal ve NOT_YET statuler icin HICBIR is EKLENMEZ.
  for (const packageId of [
    '4111900001', '4111900002', '4111900003', '4111900005', '4111900006',
  ]) {
    assert.equal(after[packageId], undefined, `${packageId} icin is EKLENDI`)
  }
  // YALNIZ Picking sıraya girer.
  assert.ok(after['4111900004'], 'Picking paketi siraya GIRMEDI')
  assert.equal(after['4111900004'].status, 'QUEUED')
  assert.equal(after['4111900004'].attemptCount, 0)
  assert.equal((await db.select().from(schema.labelJobs)).length, 1)
})

test('PRODUCER-NOW-2: Created is calistirilabilir aday HALINE GELMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const encryption = await import('./orders/orderEncryption.ts')
  await db.insert(schema.orders).values({
    organizationId, marketplace: 'Trendyol', packageId: '4111900010',
    orderNumber: 'ORD-4111900010',
    orderDate: new Date('2026-08-26T00:00:00.000Z'),
    cargoTrackingNumber: '7281900010', operationStatus: 'NEW',
    marketplaceStatus: 'Created', cargoProviderName: 'Surat Kargo',
    firstSeenAt: new Date('2026-08-26T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload({
      orderNumber: 'ORD-4111900010', id: '4111900010',
    }),
  })
  const producer = await import('./shipments/autoLabelProducer.ts')
  await producer.enqueueEligibleAutoLabelJobs(db, organizationId)

  // Kanarya aday secici de onu ADAY GORMEZ.
  const selector = await import('./shipments/canaryCandidateSelector.ts')
  const candidates = await selector.selectCanaryCandidates(db, { organizationId })
  assert.equal(candidates.safeCount, 0)
  // Ve hazirlik taşıyıcıya CIKMAYI acmaz.
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  const prepared = await prepareLabelJob(db, {
    organizationId, packageId: '4111900010', marketplace: 'Trendyol',
  })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.blockerCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
})

/* ═══ REG ════════════════════════════════════════════════════════════ */

test('NORMALIZE-REG: arac salt-okunur/mutasyon ayrimi ve kayit', async () => {
  const source = readFileSync(
    join(here, 'shipments', 'queueNormalizer.ts'), 'utf8',
  )
  // Tasiyiciya CIKIS YOK.
  assert.ok(!/await fetch\(/.test(source))
  // Kosul GUNCELLEMENIN ICINDE (idempotent ikinci calistirma).
  assert.match(source, /eq\(labelJobs\.status, 'QUEUED'\)/)
  // Yeni is/operasyon EKLENMEZ.
  assert.ok(!/\.insert\(labelJobs\)/.test(source))
  assert.ok(!/\.insert\(shipmentOperations\)/.test(source))
  // attempt_count ve created_at YAZILMAZ.
  //
  // Rapor nesnesi bu alanlari OKUR (`attemptCount: candidate.attemptCount`);
  // olculmesi gereken sey GUNCELLEME govdesidir. Bu yuzden yalniz
  // `.set({ ... })` blogu incelenir.
  const setStart = source.indexOf('.set({')
  const setEnd = source.indexOf('})', setStart)
  assert.ok(setStart > 0 && setEnd > setStart, 'guncelleme govdesi bulunamadi')
  const setBlock = source.slice(setStart, setEnd)
  assert.ok(!/attemptCount/.test(setBlock), 'attempt_count YAZILIYOR')
  assert.ok(!/createdAt/.test(setBlock), 'created_at YAZILIYOR')
  // Yalniz beklenen alanlar yazilir.
  assert.match(setBlock, /status: candidate\.targetState/)
  assert.match(setBlock, /lastErrorCode: candidate\.targetErrorCode/)

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(pkg.scripts['auto-label:queue-normalize:inspect'], /^node /)
  assert.match(pkg.scripts['auto-label:queue-normalize:apply'], /--apply/)
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/queue-normalization-flow.test.mjs'))
  assert.ok(and && eq)
})
