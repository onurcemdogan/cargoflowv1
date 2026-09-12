import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// ═══ ARKA PLANDA HAZIRLANAN ETİKET — Created PAKETLER ═══════════════════
//
// ═══ ÜRETİMDE ÖLÇÜLEN DURUM ══════════════════════════════════════════════
// `LABEL_WORKER_ENABLED=true`, `TRENDYOL_STREAM_SYNC_ENABLED=true`, kiracı
// otomatik etiketi AÇIK, PM2 günlüğünde "arka plan etiket worker etkin" —
// buna rağmen `QUEUED_TOTAL = 0`. Altı yeni `Created` sipariş HİÇBİR ZAMAN
// sıraya girmedi ve kullanıcı her seferinde butona basıp taşıyıcıyı
// bekledi.
//
// ═══ KÖK NEDEN: ÜÇ KATMAN, ÜÇ FARKLI GERÇEK ══════════════════════════════
//   üretici        `classifyMarketplaceLifecycle`      → NOT_YET (sıraya almaz)
//   worker hazırlık `canCallSurat`                     → false   (NOT_ELIGIBLE)
//   create handler  `ensureTrendyolPickingBeforeSurat` → Picking'e ALIR
//
// Yani ELLE BUTON aynı paket için Created → Picking geçişini ZATEN
// yapıyordu; arka plan yol o yeteneğe ULAŞMADAN iki kapı önce
// reddediliyordu.
//
// ═══ BU PAKETİN KİLİTLEDİĞİ SÖZLEŞME ═════════════════════════════════════
//   · `Created` kapısı SİLİNMEDİ: yaşam döngüsü sınıfı hâlâ `NOT_YET`.
//   · Geçişi yapan TEK yer, elle butonun da kullandığı kanonik create
//     orkestrasyonudur. İkinci bir Picking uygulaması YOKTUR.
//   · Arka plan geçişi kiracının AÇIK onayına ve KENDİ aktivasyon
//     sınırına bağlıdır; kod dağıtımı geçmişi mutasyona uğratamaz.
//   · Terminal paketler, mevcut artefaktlar ve ağ belirsizliği AYNEN
//     korunur.
//
// GERÇEK TAŞIYICI/PAZARYERİ ÇAĞRISI YOKTUR: sınır enjekte edilir ve SAYILIR.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

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

// ═══ ZAMAN EKSENİ — İKİ AYRI SINIR ══════════════════════════════════════
//
// AUTO_LABEL_AT : otomatik etiket açıldı.
// LEGACY_SEEN   : bu andan SONRA görülmüş ama Created diye BEKLEYEN
//                 paketler (üretimdeki altı sipariş bu sınıftadır).
// PICKING_AT    : arka plan Created→Picking AYRICA açıldı.
// FRESH_SEEN    : bu andan SONRA görülen YENİ paketler.
const AUTO_LABEL_AT = new Date('2026-08-20T00:00:00.000Z')
const LEGACY_SEEN = new Date('2026-09-01T00:00:00.000Z')
const PICKING_AT = new Date('2026-09-05T00:00:00.000Z')
const FRESH_SEEN = new Date('2026-09-08T00:00:00.000Z')

async function makeTenant(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `bg-${randomBytes(4).toString('hex')}` })
    .returning()
  const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
  await defaults.saveShipmentDefaults(db, org.id, {
    defaultUnitDesi: options.desi ?? 2,
    multiplyByItemQuantity: options.multiply ?? false,
    labelPrintTemplate: 'cargoflow_html',
  })
  const credentials = await import('./integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })
  const producer = await import('./shipments/autoLabelProducer.ts')
  if (options.autoLabel !== false) {
    await producer.activateAutoLabel(db, org.id, {
      marketplaces: ['trendyol'], carriers: ['surat'],
      now: AUTO_LABEL_AT.toISOString(),
    })
  }
  if (options.backgroundPicking === true) {
    await producer.activateBackgroundPicking(db, org.id, {
      now: PICKING_AT.toISOString(),
    })
  }
  return org.id
}

async function seedPackage(db, organizationId, packageId, options = {}) {
  const encryption = await import('./orders/orderEncryption.ts')
  const raw = { orderNumber: `ORD-${packageId}`, id: packageId }
  if (options.whoPays !== undefined) raw.whoPays = options.whoPays
  const [order] = await db.insert(schema.orders).values({
    organizationId, marketplace: 'Trendyol', packageId,
    orderNumber: `ORD-${packageId}`,
    orderDate: options.orderDate ?? FRESH_SEEN,
    cargoTrackingNumber: options.cargoTrackingNumber ?? `7281${packageId.slice(-6)}`,
    operationStatus: options.operationStatus ?? 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Created',
    cargoProviderName: options.cargoProviderName ?? 'Surat Kargo',
    firstSeenAt: options.firstSeenAt ?? FRESH_SEEN,
    rawPayloadEncrypted: encryption.encryptOrderPayload(raw),
  }).returning()
  if (options.lines) {
    await db.insert(schema.orderLines).values(
      options.lines.map((line, index) => ({
        organizationId, orderId: order.id,
        externalLineId: `${packageId}-${index}`,
        productName: line.productName ?? 'Urun',
        quantity: line.quantity ?? 1,
        rawPayloadEncrypted: encryption.encryptOrderPayload(line),
      })),
    )
  }
  return order.id
}

const runProducer = async (db, organizationId) => {
  const producer = await import('./shipments/autoLabelProducer.ts')
  return producer.enqueueEligibleAutoLabelJobs(db, organizationId)
}

const prepare = async (db, organizationId, packageId) => {
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  return prepareLabelJob(db, { organizationId, packageId, marketplace: 'Trendyol' })
}

const jobsOf = (db, organizationId) =>
  db.select().from(schema.labelJobs)
    .where(eq(schema.labelJobs.organizationId, organizationId))

/* ═══ AUTO-BG-1 ══════════════════════════════════════════════════════════
 * Worker açık + kiracı aktif + sınırdan SONRA gelen UYGUN sipariş
 * → iş kuyruğa girer.
 */
test('AUTO-BG-1: aktivasyon sonrasi uygun yeni siparis SIRAYA girer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  await seedPackage(db, organizationId, 'PKG-ELIG-1', {
    marketplaceStatus: 'Picking',
  })

  const report = await runProducer(db, organizationId)
  assert.equal(report.enqueued, 1, `blocked=${JSON.stringify(report.blocked)}`)
  const jobs = await jobsOf(db, organizationId)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].status, 'QUEUED')
  assert.equal(jobs[0].packageId, 'PKG-ELIG-1')
  assert.equal(jobs[0].jobType, 'LABEL_PREPARE')
})

/* ═══ AUTO-BG-2 ══════════════════════════════════════════════════════════
 * `Created` sipariş için arka plan hazırlığı, elle yolun kullandığı AYNI
 * güvenli Picking davranışını kullanır — çünkü elle yol bunu destekliyor.
 */
test('AUTO-BG-2: Created siparis ELLE YOLUN kanonik Picking gecisini paylasir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { backgroundPicking: true })
  await seedPackage(db, organizationId, 'PKG-CREATED-1', {
    marketplaceStatus: 'Created',
  })

  const report = await runProducer(db, organizationId)
  assert.equal(report.enqueued, 1, `blocked=${JSON.stringify(report.blocked)}`)

  // Hazırlık GERÇEĞİ SÖYLER: create orkestrasyonu önce Picking geçişini
  // yapacak ve bu geçiş kiracı tarafından YETKİLENDİRİLMİŞ.
  const prepared = await prepare(db, organizationId, 'PKG-CREATED-1')
  assert.equal(prepared.ok, true, `blockers=${prepared.blockers.join(',')}`)
  assert.equal(prepared.requiresPickingUpdate, true)
  assert.equal(prepared.pickingTransitionAuthorized, true)
  assert.equal(prepared.eligibleForCreate, true)
  assert.equal(prepared.marketplaceStatus, 'Created')

  // ═══ İKİNCİ UYGULAMA YOK — YAPISAL KANIT ═════════════════════════════
  //
  // Picking geçişini yapan TEK fonksiyon `ensureTrendyolPickingBeforeSurat`
  // ve o da tek bir yerde tanımlıdır. Arka plan yol create çekirdeğini
  // paylaştığı için AYNI çağrıyı kullanır.
  const server = readFileSync(join(root, 'server', 'index.mjs'), 'utf8')
  assert.equal(
    (server.match(/^async function ensureTrendyolPickingBeforeSurat\(/gm) ?? []).length,
    1,
    'Picking gecisi icin TEK tanim olmali',
  )
  assert.equal(
    (server.match(/await ensureTrendyolPickingBeforeSurat\(/g) ?? []).length,
    1,
    'Picking gecisi TEK yerden cagrilmali (create cekirdegi)',
  )
  // Worker kendi create'ini KURMAZ: elle butonun handler'ını çağırır.
  assert.match(
    server,
    /await withSuratTracePersistence\(createSuratShipment\)\(\s*syntheticRequest, syntheticResponse,\s*\)/,
    'worker elle yolun create handler ini calistirmali',
  )
})

/* ═══ AUTO-BG-2b — EN KRİTİK GÜVENLİK ════════════════════════════════════
 * Onay YOKKEN davranış BUGÜNKÜNÜN AYNISI; onay VARKEN bile geçmişte
 * görülmüş paketler DOKUNULMAZ.
 */
test('AUTO-BG-2b: onay yoksa Created BLOKE; onay varsa bile GECMIS dokunulmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())

  // (a) Arka plan Picking AÇILMAMIŞ → `Created` kapısı aynen durur.
  const closed = await makeTenant(db)
  await seedPackage(db, closed, 'PKG-NOAUTH', { marketplaceStatus: 'Created' })
  const closedReport = await runProducer(db, closed)
  assert.equal(closedReport.enqueued, 0)
  assert.equal(closedReport.blocked.BACKGROUND_PICKING_NOT_ACTIVATED, 1)
  assert.equal((await jobsOf(db, closed)).length, 0)
  const closedPrepared = await prepare(db, closed, 'PKG-NOAUTH')
  assert.equal(closedPrepared.ok, false)
  assert.equal(closedPrepared.blockerCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
  assert.equal(closedPrepared.pickingTransitionAuthorized, false)

  // (b) Açık — ama üretimdeki altı sipariş gibi, KENDİ sınırından ÖNCE
  //     görülmüş paketler kod dağıtımıyla TOPLUCA mutasyona uğramaz.
  const open = await makeTenant(db, { backgroundPicking: true })
  await seedPackage(db, open, 'PKG-LEGACY', {
    marketplaceStatus: 'Created', firstSeenAt: LEGACY_SEEN,
  })
  await seedPackage(db, open, 'PKG-FRESH', {
    marketplaceStatus: 'Created', firstSeenAt: FRESH_SEEN,
  })
  const openReport = await runProducer(db, open)
  assert.equal(openReport.enqueued, 1, 'YALNIZ yeni paket sıraya girmeli')
  assert.equal(openReport.blocked.BEFORE_BACKGROUND_PICKING_BOUNDARY, 1)
  const openJobs = await jobsOf(db, open)
  assert.deepEqual(openJobs.map((row) => row.packageId), ['PKG-FRESH'])
  // Geçmiş paket worker'a düşse bile hazırlık onu REDDEDER.
  const legacyPrepared = await prepare(db, open, 'PKG-LEGACY')
  assert.equal(legacyPrepared.ok, false)
  assert.equal(legacyPrepared.pickingTransitionAuthorized, false)
  assert.equal(legacyPrepared.blockerCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
})

/* ═══ AUTO-BG-3 ═════════════════════════════════════════════════════════ */
test('AUTO-BG-3: Picking siparis DOGRUDAN hazirlanir (gecis GEREKMEZ)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { backgroundPicking: true })
  await seedPackage(db, organizationId, 'PKG-PICKING', {
    marketplaceStatus: 'Picking',
  })

  const prepared = await prepare(db, organizationId, 'PKG-PICKING')
  assert.equal(prepared.ok, true, `blockers=${prepared.blockers.join(',')}`)
  assert.equal(prepared.requiresPickingUpdate, false, 'gecis GEREKMEMELI')
  assert.equal(prepared.eligibleForCreate, true)
  assert.equal(prepared.eligibility.canCallSurat, true)
  // Onay AÇIK olsa da uygun paket için pazaryeri statüsü DEĞİŞMEZ.
  assert.equal(prepared.eligibility.requiresPickingUpdate, false)
})

/* ═══ AUTO-BG-4 ═════════════════════════════════════════════════════════ */
test('AUTO-BG-4: terminal statu ASLA siraya girmez ve ASLA create acmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { backgroundPicking: true })
  const terminal = [
    'Cancelled', 'Returned', 'UnDelivered', 'UnSupplied',
    'Shipped', 'AtCollectionPoint', 'Delivered',
  ]
  for (const [index, status] of terminal.entries()) {
    await seedPackage(db, organizationId, `PKG-TERM-${index}`, {
      marketplaceStatus: status,
    })
  }

  const report = await runProducer(db, organizationId)
  assert.equal(report.enqueued, 0)
  assert.equal(report.blocked.MARKETPLACE_LIFECYCLE_TERMINAL, terminal.length)
  assert.equal((await jobsOf(db, organizationId)).length, 0)

  // Kanonik kapı, YETKİ VERİLSE BİLE terminal paketi geçirmez: terminal
  // için "yetki" diye bir kavram YOKTUR.
  const eligibility = await import('./shipments/trendyolShipmentEligibility.ts')
  for (const status of terminal) {
    const gate = eligibility.resolveBackgroundPreparationGate(
      { marketplaceStatus: status, cargoTrackingNumber: '7281000000' },
      { allowPickingTransition: true },
    )
    assert.equal(gate.allowed, false, `${status} GECMEMELI`)
    assert.equal(gate.lifecycle, 'TERMINAL', status)
    assert.equal(gate.requiresPickingUpdate, false, status)
  }
  for (const status of terminal) {
    const prepared = await prepare(
      db, organizationId, `PKG-TERM-${terminal.indexOf(status)}`,
    )
    assert.equal(prepared.ok, false, status)
    assert.equal(prepared.eligibleForCreate, false, status)
  }
})

/* ═══ AUTO-BG-5 ═════════════════════════════════════════════════════════ */
test('AUTO-BG-5: ayni paket TEKRAR gorulse de MUKERRER is/create dogmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { backgroundPicking: true })
  await seedPackage(db, organizationId, 'PKG-DUP', { marketplaceStatus: 'Created' })

  const first = await runProducer(db, organizationId)
  assert.equal(first.enqueued, 1)
  // Akış senkronu aynı paketi tekrar görür — üretici tekrar çalışır.
  const second = await runProducer(db, organizationId)
  const third = await runProducer(db, organizationId)
  assert.equal(second.enqueued, 0)
  assert.equal(third.enqueued, 0)
  assert.equal(second.blocked.ALREADY_QUEUED, 1)

  // TEKİLLİK VERİTABANINDADIR: üç turdan sonra da TEK satır.
  const jobs = await jobsOf(db, organizationId)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].attemptCount, 0, 'deneme sayaci ARTMAMALI')

  // Eşzamanlı iki üretici turu da tek satır bırakır.
  await Promise.all([
    runProducer(db, organizationId), runProducer(db, organizationId),
  ])
  assert.equal((await jobsOf(db, organizationId)).length, 1)
})

/* ═══ AUTO-BG-6 ══════════════════════════════════════════════════════════
 * READY etiket varsa buton taşıyıcıyı ÇAĞIRMAZ.
 */
test('AUTO-BG-6: READY etiket varken buton TASIYICIYI CAGIRMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { backgroundPicking: true })
  await seedPackage(db, organizationId, 'PKG-READY', {
    marketplaceStatus: 'Created',
  })
  // Arka plan çalışmış: iş READY ve taşıyıcı artefaktı yazılmış.
  await db.insert(schema.labelJobs).values({
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId: 'PKG-READY', jobType: 'LABEL_PREPARE', status: 'READY',
  })
  await db.insert(schema.shipments).values({
    organizationId, marketplace: 'Trendyol', packageId: 'PKG-READY',
    orderNumber: 'ORD-PKG-READY', provider: 'surat-kargo',
    source: 'local_create', status: 'created',
    trackingNumber: '21012920014311', barcode: '01254596670',
  })

  // 1) Buton politikası: taşıyıcı çağrısı SIFIR.
  const policy = await import('./shipments/suratAutoLabelPolicy.ts')
  const action = policy.resolveLabelButtonAction({
    jobState: 'READY', hasStoredLabel: true, eligible: true,
  })
  assert.equal(action.action, 'OPEN_STORED_LABEL')
  assert.equal(action.carrierCalls, 0)

  // 2) Hazırlık: artefakt VARSA create AÇILMAZ — ne elle ne arka planda.
  const prepared = await prepare(db, organizationId, 'PKG-READY')
  assert.equal(prepared.ok, false)
  assert.equal(prepared.carrierArtifactExists, true)
  assert.equal(prepared.blockerCode, 'SURAT_PREFLIGHT_CARRIER_ARTIFACT_EXISTS')
  assert.equal(prepared.carrierCalls, 0)
  assert.equal(prepared.networkCalls, 0)

  // 3) Üretici ikinci bir iş AÇMAZ.
  const report = await runProducer(db, organizationId)
  assert.equal(report.enqueued, 0)
  assert.equal((await jobsOf(db, organizationId)).length, 1)

  // ═══ 4) BUTON YOLU: KISA DEVRE, TAŞIYICI SINIRINDAN ÖNCE ═════════════
  //
  // Bu SIRALAMA sözleşmenin kendisidir. Kalıcı SUCCESS kaydı
  // `executeIdempotentSuratCreate` içinde, `createSuratShipmentCore`
  // ÇAĞRILMADAN ÖNCE yanıtlanır. Çekirdeğe girilmediği için:
  //   · `ensureTrendyolPickingBeforeSurat` ÇALIŞMAZ  → Trendyol mutasyonu YOK
  //   · Sürat rota/SOAP dalına GİRİLMEZ              → SOAP çağrısı YOK
  // Sıra tersine dönseydi, hazır etiketi olan bir pakete basmak ikinci bir
  // fiziksel gönderi açabilirdi.
  const server = readFileSync(join(root, 'server', 'index.mjs'), 'utf8')
  const idempotentAt = server.indexOf(
    'async function executeIdempotentSuratCreate(request, operation)',
  )
  assert.ok(idempotentAt > 0)
  const body = server.slice(idempotentAt)
  const replayAt = body.indexOf("if (existing?.status === 'SUCCESS') {")
  const coreAt = body.indexOf('await createSuratShipmentCore(request, {')
  assert.ok(replayAt > 0, 'kalici SUCCESS tekrari BULUNAMADI')
  assert.ok(coreAt > 0, 'create cekirdegi cagrisi BULUNAMADI')
  assert.ok(
    replayAt < coreAt,
    'kalici etiket tekrari create cekirdeginden ONCE olmali',
  )
  // Tekrar yanıtı taşıyıcıya çıkılmadığını AÇIKÇA beyan eder; worker ve
  // gözlemlenebilirlik bu kanıt alanını okur.
  const persistedAt = server.indexOf(
    'function buildPersistedSuratCreateResponse(record, operation)',
  )
  assert.ok(persistedAt > 0)
  assert.match(
    server.slice(persistedAt, persistedAt + 4000),
    /carrierCreateCalled: false/,
  )
  // Ve çekirdeğe girilseydi Picking geçişi ORADA olurdu — yani kısa devre
  // gerçekten pazaryeri mutasyonunun ÖNÜNDEDİR.
  assert.ok(
    server.indexOf('await ensureTrendyolPickingBeforeSurat(')
      > server.indexOf('async function createSuratShipmentCore(request, response)'),
    'Picking gecisi create cekirdeginin ICINDE olmali',
  )
})

/* ═══ AUTO-BG-7 ══════════════════════════════════════════════════════════
 * Arka plan READY yaptıktan sonra buton AYNI kalıcı ZPL'i döndürür.
 */
test('AUTO-BG-7: buton arka planin urettigi KALICI ZPL i AYNEN dondurur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db)
  const repo = await import('./shipments/printZplRepository.ts')
  const encryption = await import('./shipments/shipmentEncryption.ts')

  // SENTETİK taşıyıcı kaynağı — gerçek müşteri verisi YOK.
  const official = [
    '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
    '^FO470,20^A0N,26,26^FDT.No: 21012920014311^FS',
    '^FO60,150^BY3^BCN,150,Y,N,N^FD01254596670^FS',
    '^FO60,510^A0N,30,30^FDPOCH   KOLI     2,00^FS',
    '^XZ',
  ].join('\n')
  const items = [{ productName: 'Urun', quantity: 1, sku: 'SKU-1' }]
  const carrierPayload = repo.attachPrintZplArtifact(
    {
      technicalZpl: official,
      technicalZplSha256: (await import('../src/utils/augmentedSuratZpl.ts'))
        .sha256Hex(official),
      technicalZplLength: official.length,
    },
    items,
    '2026-09-09T10:00:00.000Z',
  )
  await db.insert(schema.shipments).values({
    organizationId, marketplace: 'Trendyol', packageId: 'PKG-SERVE',
    orderNumber: 'ORD-PKG-SERVE', provider: 'surat-kargo',
    source: 'local_create', status: 'created',
    trackingNumber: '21012920014311', barcode: '01254596670',
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(carrierPayload),
  })
  const persistedZpl = carrierPayload.printZplArtifact.printZpl

  // Buton yolu: kalıcı artefakt HER ZAMAN kazanır; yeniden kurgulanmaz,
  // katalog okunmaz, taşıyıcıya çıkılmaz.
  const resolution = await repo.resolvePrintableLabelForServing(
    db,
    {
      organizationId, marketplace: 'Trendyol',
      packageId: 'PKG-SERVE', provider: 'surat-kargo',
    },
    {
      now: '2026-09-10T10:00:00.000Z',
      loadItems: async () => {
        throw new Error('KALICI ARTEFAKT VARKEN katalog OKUNMAMALI')
      },
    },
  )
  assert.equal(resolution.kind, 'artifact')
  assert.equal(resolution.model.printZpl, persistedZpl, 'BAYT BAYT ayni olmali')
  assert.equal(
    resolution.model.printZplSha256,
    carrierPayload.printZplArtifact.printZplSha256,
  )
  // Taşıyıcı kaynağı EZİLMEDİ.
  const [row] = await db.select().from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  const stored = encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
  assert.equal(stored.technicalZpl, official)
})

/* ═══ AUTO-BG-8 ═════════════════════════════════════════════════════════ */
test('AUTO-BG-8: kiraci varsayilani 2, override yok → arka plan desi 2', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { desi: 2, backgroundPicking: true })
  await seedPackage(db, organizationId, 'PKG-DESI', {
    marketplaceStatus: 'Created',
    lines: [{ productName: 'Urun A', quantity: 3 }],
  })

  const prepared = await prepare(db, organizationId, 'PKG-DESI')
  assert.equal(prepared.ok, true, `blockers=${prepared.blockers.join(',')}`)
  assert.equal(prepared.tenantDesi, 2)
  assert.equal(prepared.multiplyByItemQuantity, false)
  assert.equal(prepared.resolvedDesi, 2, 'arka plan create desisi 2 olmali')
  assert.equal(prepared.suratBirimDesi, 2, 'Surat BirimDesi ayni deger')
  // Değer siparişe AÇIKÇA enjekte edilir — create gövdesinin okuduğu alan.
  assert.equal(prepared.order.desi, 2)

  // ═══ ELLE YOL İLE PARİTE ══════════════════════════════════════════════
  // Sunucu çözücüsü kanonik `finalDesi` okur; tarayıcının gönderdiği ile
  // arka planın çözdüğü AYNI değerdir.
  const resolver = await import('./shipments/resolveShipmentDesi.ts')
  const manual = await resolver.resolveShipmentDesi({
    db, organizationId, order: { ...prepared.order, desi: undefined },
  })
  assert.equal(manual.desi, 2)
  const source = readFileSync(
    join(root, 'server', 'shipments', 'resolveShipmentDesi.ts'), 'utf8',
  )
  assert.match(source, /positive\(calculation\?\.finalDesi\)/)
})

/* ═══ AUTO-BG-9 ══════════════════════════════════════════════════════════
 * Yakalama ve normal yaşam döngüsü kararları AYNI kanonik kurala uyar.
 */
test('AUTO-BG-9: yakalama ve uretici AYNI kanonik yasam dongusu kuralini kullanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const eligibility = await import('./shipments/trendyolShipmentEligibility.ts')
  const catchup = await import('./shipments/autoLabelCatchup.ts')
  const producerSource = readFileSync(
    join(root, 'server', 'shipments', 'autoLabelProducer.ts'), 'utf8',
  )
  const catchupSource = readFileSync(
    join(root, 'server', 'shipments', 'autoLabelCatchup.ts'), 'utf8',
  )

  // 1) İKİ YOL DA AYNI FONKSİYONU ÇAĞIRIR — ikinci bir statü tablosu YOK.
  for (const [name, text] of [
    ['uretici', producerSource], ['yakalama', catchupSource],
  ]) {
    assert.match(
      text, /resolveBackgroundPreparationGate\(/,
      `${name} kanonik kapiyi kullanmali`,
    )
  }
  assert.doesNotMatch(
    catchupSource,
    /if \(CATCHUP_EXCLUDED_MARKETPLACE_STATUSES\.includes\(providerStatus\)\)/,
    'yakalama KENDI statu listesiyle karar VERMEMELI',
  )

  // 2) SÖZLEŞME ARTIK DOĞRU: yakalama YALNIZ aktivasyon sınırını atlar.
  //    Sınırı atlayan bir yol pazaryeri statüsünü DEĞİŞTİREMEZ.
  const organizationId = await makeTenant(db, { backgroundPicking: true })
  await seedPackage(db, organizationId, 'PKG-OLD-CREATED', {
    marketplaceStatus: 'Created', firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
  })
  await seedPackage(db, organizationId, 'PKG-OLD-PICKING', {
    marketplaceStatus: 'Picking', firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
  })
  const report = await catchup.inspectCatchupCandidates(db, {
    organizationId, organizationName: 'TarzimTuba',
    marketplace: 'Trendyol', carrier: 'Surat',
  })
  assert.equal(report.carrierCalls, 0)
  assert.equal(report.dbWrites, 0)
  const created = report.candidates.find((c) => c.packageId === 'PKG-OLD-CREATED')
  const picking = report.candidates.find((c) => c.packageId === 'PKG-OLD-PICKING')
  assert.equal(created.eligibilityResult, 'BLOCKED', 'Created YAKALANMAZ')
  assert.match(created.reason, /Picking statüsüne alınmadan/)
  assert.equal(picking.eligibilityResult, 'ELIGIBLE', 'sinir ATLANIR — bu KORUNDU')

  // 3) POLİTİKA DÜZEYİNDE DE KİLİTLİ: sınır atlayan çağıran, Picking
  //    geçişi gerektiren bir paketi ASLA sıraya alamaz.
  const policy = await import('./shipments/suratAutoLabelPolicy.ts')
  const decision = policy.resolveAutoLabelEnqueue({
    scope: { organizationId, marketplace: 'Trendyol', carrier: 'Surat' },
    packageId: 'PKG-OLD-CREATED',
    settings: {
      enabled: true, marketplaces: ['trendyol'], carriers: ['surat'],
      activatedAt: AUTO_LABEL_AT.toISOString(),
      backgroundPicking: { enabled: true, activatedAt: PICKING_AT.toISOString() },
    },
    eligibility: { eligible: true },
    billingResolved: true, credentialResolved: true,
    hasLabelArtifact: false, hasCarrierArtifact: false,
    previousNetworkCrossed: false,
    requiresPickingUpdate: true,
    skipActivationBoundary: true,
  })
  assert.equal(decision.enqueue, false)
  assert.equal(decision.blockReason, 'BACKGROUND_PICKING_NOT_ACTIVATED')

  // 4) `Created` sınıfı SİLİNMEDİ: hâlâ `NOT_YET`.
  const verdict = eligibility.classifyMarketplaceLifecycle({
    marketplaceStatus: 'Created', cargoTrackingNumber: '7281000000',
  })
  assert.equal(verdict.lifecycle, 'NOT_YET')
  assert.equal(verdict.requiresPickingUpdate, true)
  assert.equal(verdict.pickingTransitionAvailable, true)
})

/* ═══ AUTO-BG-10 ════════════════════════════════════════════════════════ */
test('AUTO-BG-10: UNKNOWN_AFTER_NETWORK ikinci create e DONUSMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeTenant(db, { backgroundPicking: true })
  await seedPackage(db, organizationId, 'PKG-UNK', { marketplaceStatus: 'Created' })
  await db.insert(schema.labelJobs).values({
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId: 'PKG-UNK', jobType: 'LABEL_PREPARE',
    status: 'UNKNOWN_AFTER_NETWORK', attemptCount: 1,
  })

  // Üretici bu satırı CANLANDIRMAZ: canlandırma YALNIZ `BLOCKED` içindir.
  const report = await runProducer(db, organizationId)
  assert.equal(report.enqueued, 0)
  assert.equal(report.blocked.ALREADY_QUEUED, 1)
  const [job] = await jobsOf(db, organizationId)
  assert.equal(job.status, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(job.attemptCount, 1, 'deneme sayaci ARTMAMALI')

  // Yakalama da almaz.
  const catchup = await import('./shipments/autoLabelCatchup.ts')
  const catchupReport = await catchup.inspectCatchupCandidates(db, {
    organizationId, organizationName: 'TarzimTuba',
    marketplace: 'Trendyol', carrier: 'Surat',
  })
  const candidate = catchupReport.candidates.find((c) => c.packageId === 'PKG-UNK')
  assert.equal(candidate.eligibilityResult, 'BLOCKED')

  // Durum makinesi: ağ geçildi + etiket yok → OTOMATİK çıkış YOK.
  const policy = await import('./shipments/suratAutoLabelPolicy.ts')
  const state = policy.resolveAutoLabelJobState({
    networkCrossed: true, labelReady: false,
  })
  assert.equal(state.state, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(state.retryAllowed, false)
  // Buton da taşıyıcıya ÇIKMAZ; mutabakat ister.
  const action = policy.resolveLabelButtonAction({
    jobState: 'UNKNOWN_AFTER_NETWORK', hasStoredLabel: false, eligible: true,
  })
  assert.equal(action.action, 'REQUIRES_RECONCILIATION')
  assert.equal(action.carrierCalls, 0)
})

/* ═══ KAYIT ═════════════════════════════════════════════════════════════ */
test('AUTO-BG-REG: bu dosya test:surat ve kabul paketinde KAYITLI', () => {
  const registry = JSON.parse(
    readFileSync(join(root, 'server', 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(
    files.includes('server/auto-label-background-picking-flow.test.mjs'),
    'suratSuiteFiles.json icinde KAYITLI olmali',
  )
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(
    pkg.scripts['test:auto-label:acceptance'],
    /auto-label-background-picking-flow\.test\.mjs/,
  )

  // ═══ OPERATÖR KOMUTU DÜZ `node` İLE ÇALIŞIR ═══════════════════════════
  //
  // Testler Vite ile, üretim düz `node` ile çalışır; bu fark daha önce
  // beş paketi bloke etti. Aktivasyon komutu üretim çözücüsüyle
  // çalışmalıdır — `tsx` gerektiren bir komut, gerektiği anda üretimde
  // ÇALIŞMAZ.
  for (const script of [
    'auto-label:activation:inspect',
    'auto-label:activation:enable',
    'auto-label:activation:enable-background-picking',
  ]) {
    assert.ok(pkg.scripts[script], `${script} KAYITLI olmali`)
    assert.match(pkg.scripts[script], /^node server\/shipments\//, script)
  }

  // Aktivasyon damgası DAİMA `now`dur: komut geçmişe çekilebilir bir
  // tarih bayrağı KABUL ETMEZ.
  const cli = readFileSync(
    join(root, 'server', 'shipments', 'autoLabelActivationCli.ts'), 'utf8',
  )
  assert.match(cli, /const now = new Date\(\)\.toISOString\(\)/)
  assert.doesNotMatch(
    cli, /readFlag\('(now|activatedAt|since|boundary)'\)/,
    'sinir GECMISE cekilebilir OLMAMALI',
  )
})
