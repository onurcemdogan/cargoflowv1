import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ GERÇEK WORKER BAĞIMLILIK GRAFİ ═════════════════════════════════════
//
// Bu dosya VITE KULLANMAZ. Modüller üretimin çözücüsüyle (`node`) doğrudan
// yüklenir; çünkü ölçtüğümüz kusur TAM OLARAK çözücü farkıydı:
//   `tsx` uzantısız `./productImage` import'unu çözer, `node` ÇÖZMEZ.
//
// Aday seçici (`tsx`) "PREFLIGHT_VALID=true" derken, worker (`node`)
// hazırlığı `Cannot find module` ile patlıyor ve iş
// `SURAT_PREFLIGHT_FAILED` yazıyordu. Beş üretim paketi böyle bloke oldu.
//
// GERÇEK TAŞIYICI ÇAĞRISI YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const REAL_ORDER_KEY = randomBytes(32).toString('hex')
const REAL_CREDENTIAL_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= REAL_ORDER_KEY
process.env.CREDENTIAL_ENCRYPTION_KEY ??= REAL_CREDENTIAL_KEY

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

/** Üretimde bloke olan beş paketten ikisinin şekli. */
const PICKING = '4110965877'
const CREATED = '4111052547'

async function seed(db) {
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
  for (const [packageId, marketplaceStatus] of [
    [PICKING, 'Picking'], [CREATED, 'Created'],
  ]) {
    await db.insert(schema.orders).values({
      organizationId: org.id, marketplace: 'Trendyol', packageId,
      orderNumber: `ORD-${packageId}`,
      orderDate: new Date('2026-08-28T00:00:00.000Z'),
      cargoTrackingNumber: `7281${packageId.slice(-6)}`,
      operationStatus: 'NEW', marketplaceStatus,
      cargoProviderName: 'Surat Kargo',
      firstSeenAt: new Date('2026-08-28T00:00:00.000Z'),
      rawPayloadEncrypted: encryption.encryptOrderPayload({
        orderNumber: `ORD-${packageId}`, id: packageId,
      }),
    })
    await db.insert(schema.labelJobs).values({
      organizationId: org.id, marketplace: 'Trendyol', carrier: 'surat',
      packageId, jobType: 'LABEL_PREPARE', status: 'QUEUED', attemptCount: 0,
    })
  }
  return org.id
}

/* ═══ BOOTSTRAP-1 ════════════════════════════════════════════════════ */

test('BOOTSTRAP-1: gercek worker bagimlilik grafi URETIM cozucusuyle kurulur', async () => {
  // Worker'in uretimde yukledigi ZINCIRIN TAMAMI — mock YOK, Vite YOK.
  const modules = [
    './db/client.ts',
    './shipments/labelJobWorker.ts',
    './shipments/labelJobQueue.ts',
    './shipments/labelJobPreparation.ts',
    './shipments/resolveShipmentDesi.ts',
    './shipments/trendyolShipmentEligibility.ts',
    './shipments/suratRoutingModel.ts',
    './shipments/suratCredentialSnapshot.ts',
    './shipments/suratAutoLabelPolicy.ts',
    './integrations/credentialService.ts',
    './onboarding/shipmentDefaultsRepository.ts',
    './orders/orderPersistenceService.ts',
    './orders/orderRepository.ts',
    './orders/orderEncryption.ts',
  ]
  const failures = []
  for (const entry of modules) {
    try {
      await import(entry)
    } catch (error) {
      failures.push(`${entry} :: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'))
})

/* ═══ BOOTSTRAP-2 / BOOTSTRAP-3 ══════════════════════════════════════ */

test('BOOTSTRAP-2/3: Picking + desi 2 hazirlik BASARILI, kimlik COZULUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')

  const prepared = await prepareLabelJob(db, {
    organizationId, packageId: PICKING, marketplace: 'Trendyol',
  })

  // BOOTSTRAP-2 — siparis, ayarlar, desi.
  assert.equal(prepared.ok, true, String(prepared.failureDetail))
  assert.equal(prepared.failureStage, null)
  assert.equal(prepared.orderNumber, `ORD-${PICKING}`)
  assert.equal(prepared.tenantSettingsLoaded, true)
  assert.equal(prepared.tenantDesi, 2)
  assert.equal(prepared.resolvedDesi, 2)
  assert.equal(prepared.suratBirimDesi, 2)
  assert.equal(Number(prepared.order.desi), 2)
  assert.equal(prepared.eligibleForCreate, true)

  // BOOTSTRAP-3 — kimlik, AG CAGRISI OLMADAN.
  assert.equal(prepared.billingParty, 'TRENDYOL_PAYS')
  assert.equal(prepared.expectedWhoPays, 3)
  assert.equal(prepared.credentialRole, 'PRIMARY_MARKETPLACE')
  assert.equal(prepared.credentialSnapshot.resolved, true)
  assert.equal(prepared.networkCalls, 0)
  assert.equal(prepared.carrierCalls, 0)
})

/* ═══ BOOTSTRAP-4 ════════════════════════════════════════════════════ */

test('BOOTSTRAP-4: Created KESIN uygunluk blokcusu verir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')

  const prepared = await prepareLabelJob(db, {
    organizationId, packageId: CREATED, marketplace: 'Trendyol',
  })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.blockerCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
  assert.notEqual(prepared.blockerCode, 'SURAT_PREFLIGHT_FAILED')
  // Desi GECERLIYDI; hata desiye YIKILMADI.
  assert.equal(prepared.resolvedDesi, 2)
  assert.equal(prepared.carrierCalls, 0)
})

/* ═══ BOOTSTRAP-5 / BOOTSTRAP-6 ══════════════════════════════════════ */

test('BOOTSTRAP-5/6: eksik sifreleme anahtari KESIN ve GUVENLI hata verir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')

  const orderKey = process.env.ORDER_DATA_ENCRYPTION_KEY
  const credentialKey = process.env.CREDENTIAL_ENCRYPTION_KEY
  t.after(() => {
    process.env.ORDER_DATA_ENCRYPTION_KEY = orderKey
    process.env.CREDENTIAL_ENCRYPTION_KEY = credentialKey
  })

  // BOOTSTRAP-5: siparis PII'si okunamaz → LOAD_ORDER asamasinda duser.
  delete process.env.ORDER_DATA_ENCRYPTION_KEY
  delete process.env.CREDENTIAL_ENCRYPTION_KEY
  const prepared = await prepareLabelJob(db, {
    organizationId, packageId: PICKING, marketplace: 'Trendyol',
  })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.failureStage, 'LOAD_ORDER')
  assert.equal(prepared.blockerCode, 'SURAT_PREFLIGHT_ENCRYPTION_KEY_MISSING')
  assert.ok(prepared.failureDetail, 'gercek sebep KAYBOLDU')
  assert.equal(prepared.carrierCalls, 0)

  // BOOTSTRAP-6: ANAHTAR DEGERI teshis metnine SIZMAZ.
  const detail = String(prepared.failureDetail)
  assert.ok(!detail.includes(orderKey), 'siparis anahtari SIZDI')
  assert.ok(!detail.includes(credentialKey), 'kimlik anahtari SIZDI')
  // Ozet de kesindir; genel cumle DEGIL.
  assert.notEqual(prepared.errorSummary, 'Sürat gönderisi hazırlanamadı.')
})

test('BOOTSTRAP-6b: teshis metni SIRLARI maskeler', async () => {
  const { sanitizeDiagnostic } = await import('./shipments/labelJobPreparation.ts')
  const key = randomBytes(32).toString('hex')
  const dirty =
    `connect failed postgres://user:hunter2@10.0.0.1:5432/cargoflow `
    + `password=hunter2 key=${key}`
  const clean = sanitizeDiagnostic(dirty)
  assert.ok(!clean.includes('hunter2'), 'parola SIZDI')
  assert.ok(!clean.includes(key), 'anahtar SIZDI')
  assert.ok(!clean.includes('10.0.0.1'), 'baglanti dizesi SIZDI')
  // Teknik sebep KORUNUR.
  assert.match(clean, /connect failed/)
})

/* ═══ BOOTSTRAP-7 / BOOTSTRAP-8 ══════════════════════════════════════ */

test('BOOTSTRAP-7/8: hazirlik istisnasi ASLA asama/tur/mesaj KAYBETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')

  // SEMA AYRISMASI: `orders` okunurken istisna.
  await pglite.exec('ALTER TABLE "orders" DROP COLUMN "sales_disposition"')
  const prepared = await prepareLabelJob(db, {
    organizationId, packageId: PICKING, marketplace: 'Trendyol',
  })

  // BOOTSTRAP-7: asama, tur ve mesaj TASINIR.
  assert.equal(prepared.ok, false)
  assert.equal(prepared.failureStage, 'LOAD_ORDER')
  assert.ok(prepared.failureType, 'istisna turu KAYBOLDU')
  assert.match(String(prepared.failureDetail), /sales_disposition/)
  assert.equal(prepared.blockerCode, 'SURAT_PREFLIGHT_SCHEMA_DRIFT')
  // BOOTSTRAP-8: tasiyici cagrisi SIFIR.
  assert.equal(prepared.carrierCalls, 0)
  assert.equal(prepared.networkCalls, 0)
  assert.equal(prepared.dbWrites, 0)
})

/* ═══ BOOTSTRAP-9 ════════════════════════════════════════════════════ */

test('BOOTSTRAP-9: genel claim yolu GERCEK hazirligi kullanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const worker = await import('./shipments/labelJobWorker.ts')
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  const carrier = []

  await worker.runLabelJobCycle({
    db,
    workerId: 'bootstrap-test',
    runLabel: async (job) => {
      const prepared = await prepareLabelJob(db, {
        organizationId, packageId: job.packageId, marketplace: job.marketplace,
      })
      if (!prepared.ok) {
        return {
          labelReady: false, networkCrossed: false, blocked: true,
          errorCode: prepared.blockerCode,
          errorSummary: prepared.errorSummary, carrierCalls: 0,
        }
      }
      carrier.push({ packageId: prepared.packageId, desi: prepared.suratBirimDesi })
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })

  assert.equal(carrier.length, 1)
  assert.equal(carrier[0].packageId, PICKING)
  assert.equal(carrier[0].desi, 2)
  const rows = await db.select().from(schema.labelJobs)
  const byPackage = Object.fromEntries(rows.map((row) => [row.packageId, row]))
  assert.equal(byPackage[PICKING].status, 'READY')
  assert.equal(byPackage[CREATED].status, 'BLOCKED')
  assert.equal(byPackage[CREATED].lastErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
})

/* ═══ BOOTSTRAP-10 ═══════════════════════════════════════════════════ */

test('BOOTSTRAP-10: run-once / secici / worker hazirlik PARITESI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')
  const { preflightLabelJob } = await import('./shipments/labelJobPreflight.ts')
  const selector = await import('./shipments/canaryCandidateSelector.ts')

  const report = await selector.selectCanaryCandidates(db, { organizationId })
  for (const packageId of [PICKING, CREATED]) {
    const prepared = await prepareLabelJob(db, {
      organizationId, packageId, marketplace: 'Trendyol',
    })
    const viaPreflight = await preflightLabelJob(db, { organizationId, packageId })
    const candidate = report.candidates.find((c) => c.packageId === packageId)

    assert.equal(viaPreflight.resolvedDesi, prepared.resolvedDesi, packageId)
    assert.equal(viaPreflight.preflightValid, prepared.ok, packageId)
    assert.equal(candidate.resolvedDesi, prepared.resolvedDesi, packageId)
    assert.equal(candidate.wouldCallCarrier, prepared.ok, packageId)
    assert.equal(candidate.credentialResolved, prepared.credentialSnapshot.resolved, packageId)
  }
})

/* ═══ BOOTSTRAP-REG ══════════════════════════════════════════════════ */

test('BOOTSTRAP-REG: worker on kontrol CLI duz `node` ile calisir', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const script = pkg.scripts['auto-label:worker:preflight']
  assert.ok(script, 'auto-label:worker:preflight KAYITLI DEGIL')
  // `tsx` YASAK: uretim cozucusunu olcmek icin DUZ `node` sart.
  assert.match(script, /^node /)
  assert.ok(!/tsx/.test(script), 'CLI tsx ile calisirsa uretim farki OLCULMEZ')

  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/worker-bootstrap-dependency-flow.test.mjs'))
})
