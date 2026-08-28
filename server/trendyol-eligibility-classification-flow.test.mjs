import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ TRENDYOL UYGUNLUK REDDİNİN SINIFLANDIRILMASI ═══════════════════════
//
// ÜRETİM KANITI (paket 4110109345):
//   status=UNKNOWN_AFTER_NETWORK · attempt_count=26
//   last_error_code=TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS
//   shipment_operations=0 · shipments=0
//
// Yani taşıyıcıya HİÇ ÇIKILMAMIŞTI ama iş "ağ sonrası belirsiz" sayıldı.
//
// ═══ KÖK NEDEN (koddan) ══════════════════════════════════════════════════
// `index.mjs` → create handler, `if (!trendyolPreflight.canCallSurat)` ile
// finansal kapıdan ve kimlik çözümünden ÖNCE reddeder ve
// `buildTrendyolPreflightBlockedResponse` döndürür (endpoint
// `preflight:Trendyol`, statusCode 0, rawRequest.skipped=true).
//
// Ama o yanıt `carrierCreateCalled` KANIT ALANINI TAŞIMIYORDU. Worker
// (`runLabelJobViaCreateHandler`) şunu yapar:
//     let networkCrossed = true
//     if (payload && payload.carrierCreateCalled === false) networkCrossed = false
// Alan `undefined` olduğu için ihtiyatlı varsayım KALDI → networkCrossed
// true → `resolveAutoLabelJobState` → UNKNOWN_AFTER_NETWORK.
//
// Alan YAZILMADIĞI için OKUNAMADI. Düzeltme kodun kendisini değil KANITI
// ekler; sınıflandırma yine KANITA dayanır.
//
// ═══ UNKNOWN GÜVENLİĞİ GEVŞETİLMEDİ ══════════════════════════════════════
// Aynı hata kategorisi Sürat YANITINDAN da doğabilir (`index.mjs` ~10827).
// O yol GERÇEKTEN ağ geçmiştir ve UNKNOWN_AFTER_NETWORK kalmalıdır.
// Bu yüzden eşleme koda göre değil KANITA göre yapılır.

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

async function seed(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()
  const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
  await defaults.saveShipmentDefaults(db, org.id, {
    defaultUnitDesi: 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  const credentials = await load('/server/integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })
  const encryption = await load('/server/orders/orderEncryption.ts')
  await db.insert(schema.orders).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: TARGET,
    orderNumber: ORDER_NUMBER,
    orderDate: new Date('2026-08-20T00:00:00.000Z'),
    cargoTrackingNumber: '7279999999',
    operationStatus: 'NEW',
    marketplaceStatus: options.marketplaceStatus ?? 'Picking',
    cargoProviderName: options.cargoProviderName ?? 'Surat Kargo',
    firstSeenAt: new Date('2026-08-20T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptOrderPayload({
      orderNumber: ORDER_NUMBER, id: TARGET,
    }),
  })
  await db.insert(schema.labelJobs).values({
    organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
    packageId: TARGET, jobType: 'LABEL_PREPARE',
    status: options.jobStatus ?? 'BLOCKED', attemptCount: options.attemptCount ?? 0,
  })
  return org.id
}

/* ═══ ELIGIBILITY-1 ══════════════════════════════════════════════════ */

test('ELIGIBILITY-1: uygun olmayan statu → TASIYICI CAGRISI 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  // Trendyol "Created/Yeni": once Picking gerekir → create handler
  // taşıyıcıya CIKMADAN reddeder.
  const organizationId = await seed(db, { marketplaceStatus: 'Created' })
  const calls = { count: 0 }

  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test',
    runLabel: async () => {
      calls.count += 1
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })

  assert.equal(calls.count, 0, 'uygun olmayan statude tasiyiciya CIKILDI')
  assert.equal(report.totalCarrierCalls, 0)
  assert.equal(report.gatesPassed, false)
  assert.ok(
    report.blockers.includes('TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'),
    report.blockers.join(','),
  )
})

/* ═══ ELIGIBILITY-2 / ELIGIBILITY-3 ══════════════════════════════════ */

test('ELIGIBILITY-2/3: kanit tasindiginda → BLOCKED, ASLA UNKNOWN', async (t) => {
  const policy = await load('/server/shipments/suratAutoLabelPolicy.ts')

  // Uygunluk reddi AGDAN ONCEDIR: `carrierCreateCalled: false` kaniti
  // artik yaniti tasir → networkCrossed false.
  const state = policy.resolveAutoLabelJobState({
    networkCrossed: false,
    labelReady: false,
    blocked: false,
    errorCode: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  })
  assert.equal(state.state, 'BLOCKED')
  assert.notEqual(state.state, 'UNKNOWN_AFTER_NETWORK')
  // Deterministik: kendi kendine TEKRAR DENENMEZ.
  assert.equal(state.retryAllowed, false)
  assert.ok(
    policy.isDeterministicPreNetworkBlocker('TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'),
  )
})

test('ELIGIBILITY-2b: AGDAN ONCEKI ret yanitinda KANIT ALANI YAZILIR', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Uygunluk reddi ve Picking guncelleme reddi: ikisi de Surat'a CIKMAZ.
  const eligibility = source.search(
    /errorCode: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',\s*\n\s*errorSource: 'Trendyol',/,
  )
  assert.ok(eligibility > 0, 'uygunluk reddi cagrisi bulunamadi')
  const window = source.slice(eligibility, eligibility + 400)
  assert.match(window, /carrierCreateCalled: false/)
  assert.match(window, /requestSent: false/)

  // Picking guncelleme reddi de AGDAN ONCEDIR ve kaniti tasir.
  const picking = source.search(/errorCode: 'TRENDYOL_PICKING_UPDATE_FAILED',/)
  assert.ok(picking > 0, 'picking reddi cagrisi bulunamadi')
  assert.match(source.slice(picking, picking + 400), /carrierCreateCalled: false/)

  // Yanit kurucusu alani KOSULLU yazar; bilmeyen cagiran icin DEGISMEZ.
  assert.match(source, /carrierCreateCalled === undefined \? \{\} : \{ carrierCreateCalled \}/)
})

/* ═══ ELIGIBILITY-4 ══════════════════════════════════════════════════ */

test('ELIGIBILITY-4: attempt_count DONGUYE girmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')
  const organizationId = await seed(db, {
    marketplaceStatus: 'Created', attemptCount: 26,
  })

  // Kapi kapali → talep EDILMEZ → sayac ARTMAZ. Uc kez denense bile.
  for (let index = 0; index < 3; index += 1) {
    await runner.runSingleLabelJob(db, {
      organizationId, packageId: TARGET, workerId: 'test',
      runLabel: async () => ({ labelReady: true, networkCrossed: true, carrierCalls: 1 }),
    })
  }
  const rows = await db.select().from(schema.labelJobs)
  assert.equal(rows[0].attemptCount, 26, 'attempt_count DONGUYE girdi')
  assert.equal(rows[0].status, 'BLOCKED')
})

/* ═══ ELIGIBILITY-5 ══════════════════════════════════════════════════ */

test('ELIGIBILITY-5: GERCEK ag belirsizligi HALA UNKNOWN_AFTER_NETWORK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const policy = await load('/server/shipments/suratAutoLabelPolicy.ts')
  const runner = await load('/server/shipments/singleLabelJobRunner.ts')

  // Surat YANITINDAN dogan ayni kategori: ag GERCEKTEN gecildi.
  // UNKNOWN guvenligi GEVSETILMEDI.
  const crossed = policy.resolveAutoLabelJobState({
    networkCrossed: true,
    labelReady: false,
    blocked: false,
    errorCode: 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  })
  assert.equal(crossed.state, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(crossed.retryAllowed, false)

  // Uctan uca: uygun statu + ag gecildi + etiket yok → UNKNOWN.
  const organizationId = await seed(db)
  const report = await runner.runSingleLabelJob(db, {
    organizationId, packageId: TARGET, workerId: 'test',
    runLabel: async () => ({
      labelReady: false, networkCrossed: true,
      errorCode: 'SURAT_SOAP_TRANSPORT_FAILED', carrierCalls: 1,
    }),
  })
  assert.equal(report.statusAfter, 'UNKNOWN_AFTER_NETWORK')
})

/* ═══ ÖN KONTROL PARİTESİ ════════════════════════════════════════════ */

test('ELIGIBILITY-PARITY: on kontrol ve create handler AYNI kurali kullanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')
  const rule = await load('/server/shipments/trendyolShipmentEligibility.ts')

  // TEK KURAL: `index.mjs` kendi kopyasini TUTMAZ, DELEGE eder.
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(
    source,
    /function buildTrendyolShipmentPreflight\(order = \{\}\) \{\s*\n\s*return buildTrendyolShipmentEligibility\(order\)\s*\n\}/,
  )
  assert.match(
    source,
    /import \{ buildTrendyolShipmentEligibility \} from '\.\/shipments\/trendyolShipmentEligibility\.ts'/,
  )

  // Uygun OLMAYAN paket: on kontrol ARTIK "evet" DEMEZ.
  const blockedOrg = await seed(db, { marketplaceStatus: 'Created' })
  const blocked = await preflight.preflightLabelJob(db, {
    organizationId: blockedOrg, packageId: TARGET,
  })
  assert.equal(blocked.eligibleForCreate, false)
  assert.equal(blocked.preflightValid, false)
  assert.equal(blocked.wouldCallCarrier, false)
  assert.ok(blocked.blockers.includes('TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'))
  assert.equal(blocked.networkCalls, 0)
  assert.equal(blocked.dbWrites, 0)
  assert.equal(blocked.carrierCalls, 0)

  // PARİTE: ön kontrolün uygunluk kararı = kuralın kararı.
  const persistence = await load('/server/orders/orderPersistenceService.ts')
  const repository = await load('/server/orders/orderRepository.ts')
  const row = await repository.findOrderByPackageId(
    db, blockedOrg, 'Trendyol', TARGET,
  )
  const order = await persistence.getOrder(db, blockedOrg, String(row.id))
  assert.equal(
    blocked.eligibleForCreate,
    rule.buildTrendyolShipmentEligibility(order).canCallSurat,
  )

  // Uygun paket: on kontrol yine "evet" der.
  const okOrg = await seed(db)
  const ok = await preflight.preflightLabelJob(db, {
    organizationId: okOrg, packageId: TARGET,
  })
  assert.equal(ok.eligibleForCreate, true)
  assert.ok(!ok.blockers.includes('TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'))
})

test('ELIGIBILITY-REG: yeni test dosyasi test:surat icinde KAYITLI', async () => {
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/trendyol-eligibility-classification-flow.test.mjs'))
  assert.ok(list.includes('server/canary-candidate-selector-flow.test.mjs'))
})
