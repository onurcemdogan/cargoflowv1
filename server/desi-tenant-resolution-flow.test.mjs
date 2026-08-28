import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ KİRACI DESİSİ — TEK ÇÖZÜCÜ, HER ÇAĞIRAN İÇİN AYNI ══════════════════
//
// ÜRETİM ARIZASI (paket 4109804198): create yolu desiyi YALNIZ istek
// gövdesinden okuyordu. Değeri TARAYICI hesaplayıp gönderiyordu, bu yüzden
// elle etiket çalışıyordu. Arka plan worker'ının tarayıcısı olmadığı için
// create taşıyıcıya HİÇ ÇIKMADAN düştü:
//
//   preflightValid = true
//   carrierCalled  = false
//   "Desi bilgisi eksik. Sürat gönderisi oluşturmadan önce desi girilmelidir."
//
// OTORİTER KAYNAK: organization_settings.settings_json.shipmentDefaults
//                  .defaultUnitDesi  (+ multiplyByItemQuantity)
//
// Bu dosya iki şeyi kanıtlar:
//   1. Elle yol ile arka plan yolu AYNI desiyi çözer.
//   2. Desi yoksa taşıyıcıya ÇIKILMAZ ve iş KALICI olarak bloke OLMAZ.
//
// GERÇEK SÜRAT ÇAĞRISI YOKTUR.

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

async function makeOrg(db, name, desi) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, slug: `${name.toLowerCase()}-${randomBytes(4).toString('hex')}` })
    .returning()
  if (desi != null) {
    const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
    await defaults.saveShipmentDefaults(db, org.id, {
      defaultUnitDesi: desi,
      // Paket başına TEK kez: testlerin beklentisi net kalsın.
      multiplyByItemQuantity: false,
      labelPrintTemplate: 'cargoflow_html',
    })
  }
  return org.id
}

/** Tek satırlı, desisi ÇÖZÜLMEMİŞ sipariş — worker'ın gördüğü şekil. */
const ORDER = (packageId = 'PKG-1') => ({
  id: `order-${packageId}`,
  orderNumber: `ORD-${packageId}`,
  packageId,
  marketplace: 'Trendyol',
  cargoTrackingNumber: `727000${packageId}`,
  items: [{ id: 'L-0', productName: 'Urun A', quantity: 1, sku: 'SKU-1' }],
})

/* ═══ 1 — ELLE YOL ═══════════════════════════════════════════════════ */

test('DESI-TENANT-1: kiraci desi = 2 → elle create BirimDesi = 2', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const organizationId = await makeOrg(db, 'TarzimTuba', 2)

  // Elle yolda tarayıcı desiyi ÇÖZMÜŞ olarak gönderir.
  const manual = await resolver.resolveShipmentDesi({
    db, organizationId, order: { ...ORDER(), desi: 2 },
  })
  assert.equal(manual.desi, 2)
  assert.equal(manual.source, 'request')
  assert.equal(manual.tenantSettingPresent, true)
  assert.equal(manual.tenantSettingValue, 2)
})

/* ═══ 2 — ARKA PLAN WORKER ══════════════════════════════════════════ */

test('DESI-TENANT-2: ayni kiraci → worker yolunda da BirimDesi = 2', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const organizationId = await makeOrg(db, 'TarzimTuba', 2)

  // Worker'ın gördüğü sipariş: desi ÇÖZÜLMEMİŞ.
  const auto = await resolver.resolveShipmentDesi({
    db, organizationId, order: ORDER(),
  })
  assert.equal(auto.desi, 2, 'worker desiyi cozemedi')
  assert.equal(auto.source, 'tenant_settings')
  assert.ok(auto.lineSources.includes('tenant_default'))
})

/* ═══ 3 — İKİSİ AYNI ════════════════════════════════════════════════ */

test('DESI-TENANT-3: elle ve worker AYNI desiyi cozer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const organizationId = await makeOrg(db, 'TarzimTuba', 2)

  const auto = await resolver.resolveShipmentDesi({
    db, organizationId, order: ORDER(),
  })
  // Elle yol, tarayıcının çözdüğü değeri gönderir; kiracı ayarı AYNI olduğu
  // için iki yol AYNI sayıya iner.
  const manual = await resolver.resolveShipmentDesi({
    db, organizationId, order: { ...ORDER(), desi: auto.desi },
  })
  assert.equal(manual.desi, auto.desi)
  assert.equal(manual.desi, 2)
  // SURAT_BIRIM_DESI bu değerin AYNISIDIR: create `BirimDesi: desi` yazar.
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(server, /BirimDesi: desi/)
})

/* ═══ 4 — DESİ YOK → TAŞIYICIYA ÇIKILMAZ ═══════════════════════════ */

test('DESI-TENANT-4: desi ayarli degil → tasiyici cagrisi 0, UNKNOWN degil', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const policy = await load('/server/shipments/suratAutoLabelPolicy.ts')
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await makeOrg(db, 'NoDesi', null)

  // Çözülemez ve UYDURULMAZ.
  const resolution = await resolver.resolveShipmentDesi({
    db, organizationId, order: ORDER(),
  })
  assert.equal(resolution.desi, null)
  assert.equal(resolution.source, 'unresolved')
  assert.equal(resolution.tenantSettingPresent, false)
  assert.match(resolution.reason, /ayarlı değil/)

  // Taşıyıcı ÇAĞRILMADIĞI için iş KALICI olarak bloke OLMAZ.
  const state = policy.resolveAutoLabelJobState({
    networkCrossed: false, labelReady: false,
  })
  assert.notEqual(state.state, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(state.retryAllowed, true)

  await queue.enqueueLabelJob(db, {
    organizationId, marketplace: 'Trendyol', carrier: 'surat', packageId: 'PKG-1',
  })
  let carrierCalls = 0
  const report = await worker.runLabelJobCycle({
    db, workerId: 'w1', batchSize: 5,
    // Desi eksikliği AĞDAN ÖNCE reddedilir: carrierCreateCalled = false.
    runLabel: async () => ({
      labelReady: false, networkCrossed: false, carrierCalls: 0,
      errorCode: 'BLOCKED_DESI_MISSING',
    }),
  })
  assert.equal(carrierCalls, 0)
  assert.equal(report.carrierCalls, 0)
  assert.equal(report.unknownAfterNetwork, 0, 'kalici bloke edildi!')
  assert.equal(report.failedSafeToRetry, 1)
})

/* ═══ 5 — DESİ SONRADAN AYARLANIR ══════════════════════════════════ */

test('DESI-TENANT-5: desi sonradan ayarlanir → AYNI is yeniden calisir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const organizationId = await makeOrg(db, 'LateDesi', null)

  await queue.enqueueLabelJob(db, {
    organizationId, marketplace: 'Trendyol', carrier: 'surat', packageId: 'PKG-1',
  })
  // 1. tur: desi yok → taşıyıcı çağrılmaz, iş yeniden denenebilir kalır.
  const first = await worker.runLabelJobCycle({
    db, workerId: 'w1', batchSize: 5,
    runLabel: async () => ({
      labelReady: false, networkCrossed: false, carrierCalls: 0,
      errorCode: 'BLOCKED_DESI_MISSING',
    }),
  })
  assert.equal(first.carrierCalls, 0)
  assert.equal(first.failedSafeToRetry, 1)

  // Müşteri desiyi ayarlar.
  await defaults.saveShipmentDefaults(db, organizationId, {
    defaultUnitDesi: 3,
    multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  assert.equal(
    (await resolver.resolveShipmentDesi({ db, organizationId, order: ORDER() })).desi,
    3,
  )

  // GERİ ÇEKİLME SÜRESİ: `completeLabelJob`, güvenle tekrarlanabilir işleri
  // 60 sn ileri tarihler — üretimde DOĞRU davranıştır (hata döngüsü yok).
  // Testte o süreyi beklemek yerine `available_at` GERİYE alınır.
  await pglite.exec("UPDATE label_jobs SET available_at = now() - interval '5 minutes'")

  // 2. tur: AYNI iş yeniden talep edilir ve TEK create yapılır.
  let creates = 0
  const second = await worker.runLabelJobCycle({
    db, workerId: 'w2', batchSize: 5,
    runLabel: async () => {
      creates += 1
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(second.claimed, 1, 'is yeniden talep edilmedi')
  assert.equal(creates, 1)
  assert.equal(second.ready, 1)

  // MÜKERRER İŞ YOK: hâlâ tek mantıksal iş.
  const jobs = await db.select().from(schema.labelJobs)
  assert.equal(jobs.length, 1)
})

/* ═══ 6 — KİRACI İZOLASYONU ════════════════════════════════════════ */

test('DESI-TENANT-6: Kiraci A=2, Kiraci B=4 — sizinti YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const orgA = await makeOrg(db, 'TenantA', 2)
  const orgB = await makeOrg(db, 'TenantB', 4)

  const a = await resolver.resolveShipmentDesi({
    db, organizationId: orgA, order: ORDER('A-1'),
  })
  const b = await resolver.resolveShipmentDesi({
    db, organizationId: orgB, order: ORDER('B-1'),
  })
  assert.equal(a.desi, 2)
  assert.equal(b.desi, 4)
  // A'yı tekrar çöz: B araya girdi diye DEĞİŞMEZ.
  const aAgain = await resolver.resolveShipmentDesi({
    db, organizationId: orgA, order: ORDER('A-2'),
  })
  assert.equal(aAgain.desi, 2)
  assert.equal(aAgain.tenantSettingValue, 2)
})

/* ═══ 7 — FATURALAMA DEĞİŞMEDİ ════════════════════════════════════ */

test('DESI-TENANT-7: WhoPays davranisi DEGISMEDI', async () => {
  const routing = await load('/server/shipments/suratRoutingModel.ts')
  assert.equal(routing.resolveBillingPartyV2({}).billingParty, 'TRENDYOL_PAYS')
  assert.equal(
    routing.resolveBillingPartyV2({ whoPays: 1 }).billingParty, 'SELLER_PAYS',
  )
  // Desi çözücüsü faturalamaya DOKUNMAZ.
  const source = readFileSync(
    join(here, 'shipments', 'resolveShipmentDesi.ts'), 'utf8',
  )
  for (const forbidden of ['whoPays', 'KimOder', 'billingParty', 'Tarife']) {
    assert.ok(!source.includes(forbidden), `desi cozucusunde ${forbidden}`)
  }
})

/* ═══ 8 — TAŞIYICI SÖZLEŞMESİ ═════════════════════════════════════ */

test('DESI-TENANT-8: SOAP OrtakBarkodOlustur TEK cagri, SECOND_CREATE = NO', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await makeOrg(db, 'OneCall', 2)

  for (let index = 0; index < 5; index += 1) {
    await queue.enqueueLabelJob(db, {
      organizationId, marketplace: 'Trendyol', carrier: 'surat',
      packageId: `PKG-${index}`,
    })
  }
  const perPackage = new Map()
  const report = await worker.runLabelJobCycle({
    db, workerId: 'w1', batchSize: 10,
    runLabel: async (job) => {
      perPackage.set(job.packageId, (perPackage.get(job.packageId) ?? 0) + 1)
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(report.carrierCalls, 5)
  for (const [packageId, count] of perPackage) {
    assert.equal(count, 1, `${packageId} icin ${count} create`)
  }
  // Taşıyıcı sözleşmesi DEĞİŞMEDİ.
  const transport = readFileSync(
    join(here, 'shipments', 'suratLabelTransportRoute.ts'), 'utf8',
  )
  assert.match(transport, /OrtakBarkodOlustur/)
  assert.match(transport, /webservices\.suratkargo\.com\.tr\/services\.asmx/)
})

/* ═══ PAYLAŞILAN SINIR ════════════════════════════════════════════ */

test('DESI-TENANT-9: desi ORKESTRASYON SINIRINDA cozulur (worker yamasi DEGIL)', async () => {
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Çözüm create'in KENDİSİNDE: her çağıran aynı değeri alır.
  assert.match(server, /await ensureTenantResolvedDesi\(request\)/)
  const coreIndex = server.indexOf('async function createSuratShipmentCore')
  const resolveIndex = server.indexOf('await ensureTenantResolvedDesi(request)')
  assert.ok(resolveIndex > coreIndex, 'cozum create icinde degil')

  // Worker'ın gövdesine desi ENJEKTE EDİLMEZ.
  //
  // Yorum satırları HARİÇ tutulur: kök nedeni anlatan bir yorumda "desi"
  // geçmesi kusur değildir. Aranan şey KOD'da bir desi ataması olmasıdır.
  const workerStart = server.indexOf('async function runLabelJobViaCreateHandler')
  const workerEnd = server.indexOf('async function startLabelJobWorkerOnBoot')
  const workerCode = server
    .slice(workerStart, workerEnd)
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
  const FORBIDDEN = [
    new RegExp('\bdesi\s*:', 'i'),
    new RegExp('\.desi\s*=', 'i'),
    new RegExp('defaultUnitDesi', 'i'),
  ]
  for (const pattern of FORBIDDEN) {
    assert.ok(!pattern.test(workerCode), 'worker govdesinde desi atamasi: ' + pattern)
  }

  // Ağ sınırı KANITLA belirlenir, varsayımla değil.
  assert.match(workerCode, /carrierCreateCalled === false/)
})

test('DESI-TENANT-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})
