import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ ÜRETİM ÇALIŞMA ZAMANI — VITE YOK, `tsx` YOK ════════════════════════
//
// ═══ NEDEN BU DOSYA VAR ══════════════════════════════════════════════════
// 2404 sunucu testi GEÇİYORDU ve üretim yine patladı. Sebep: diğer bütün
// test dosyaları modülleri VITE üzerinden (`ssrLoadModule`) yükler ve Vite
// UZANTISIZ göreli import'ları çözer. Üretim ise `node server/index.mjs`
// ile çalışır ve Node'un ESM çözücüsü uzantısız `.ts` import'unu ÇÖZMEZ.
//
// Yani test koşum ortamı üretimden DAHA HOŞGÖRÜLÜYDÜ; ölçtüğümüz şey
// üretimin çalıştırdığı şey DEĞİLDİ.
//
// ÜRETİM KANITI: worker açılınca beş paket
//     BLOCKED · attempt_count=1 · SURAT_PREFLIGHT_FAILED
//     "Sürat gönderisi hazırlanamadı."
// oldu ve HİÇBİR Sürat izi doğmadı. Gerçek istisna şuydu:
//     Cannot find module '.../src/utils/productImage'
//     imported from .../src/utils/orderDesi.ts
// `orderDesi.ts` uzantısız `./productImage` import ediyordu. CLI (`tsx`)
// çözüyordu, sunucu (`node`) çözemiyordu. Aynı kod, iki farklı gerçek.
//
// BU DOSYA VITE KULLANMAZ. Modüller üretimdeki gibi DOĞRUDAN import edilir.
// Böylece aynı sınıf hata bir daha sessizce geçemez.
//
// GERÇEK TAŞIYICI ÇAĞRISI YOKTUR: taşıyıcı sınırı enjekte edilir ve sayılır.

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

/** Sunucunun `src/` altından KULLANDIĞI her modül. */
const SERVER_REACHABLE_SRC = [
  'src/auth/passwordPolicy.ts',
  'src/dashboard/dashboardSalesMetricDefinition.ts',
  'src/services/integrationConfigService.ts',
  'src/types/cargoflow.ts',
  'src/utils/augmentedSuratZpl.ts',
  'src/utils/labelTenantBlocks.ts',
  'src/utils/officialSuratLabel.ts',
  'src/utils/orderDesi.ts',
  'src/utils/orderLineIntegrity.ts',
  'src/utils/printableLabelJob.ts',
  'src/utils/shipmentStatus.ts',
  'src/utils/suratDurusoftComposer.ts',
  'src/utils/suratProductDetailLabel.ts',
  'src/utils/suratProductLineItems.ts',
  'src/utils/suratSemanticParser.ts',
  'src/utils/suratZplGeometry.ts',
  'src/utils/suratZplProductLine.ts',
]

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
    [PICKING, 'Picking'],
    [CREATED, 'Created'],
  ]) {
    await db.insert(schema.orders).values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `ORD-${packageId}`,
      orderDate: new Date('2026-08-28T00:00:00.000Z'),
      cargoTrackingNumber: `7281${packageId.slice(-6)}`,
      operationStatus: 'NEW',
      marketplaceStatus,
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

/* ═══ RUNTIME-1 ══════════════════════════════════════════════════════ */

test('RUNTIME-1: sunucunun kullandigi HER src modulu URETIM cozucusuyle yuklenir', async () => {
  const failures = []
  for (const entry of SERVER_REACHABLE_SRC) {
    try {
      await import(`../${entry}`)
    } catch (error) {
      failures.push(`${entry} :: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  assert.deepEqual(
    failures, [],
    'Uretim calisma zamaninda COZULEMEYEN modul(ler) var:\n' + failures.join('\n'),
  )
})

/* ═══ RUNTIME-2 ══════════════════════════════════════════════════════ */

test('RUNTIME-2: hazirlik boru hatti ve desi cozucusu URETIM cozucusuyle yuklenir', async () => {
  // Uretimde patlayan TAM zincir: hazirlik → desi cozucu → orderDesi →
  // productImage. Vite ARACILIK ETMEZ.
  const preparation = await import('./shipments/labelJobPreparation.ts')
  assert.equal(typeof preparation.prepareLabelJob, 'function')
  const resolver = await import('./shipments/resolveShipmentDesi.ts')
  assert.equal(typeof resolver.resolveShipmentDesi, 'function')
  const orderDesi = await import('../src/utils/orderDesi.ts')
  assert.equal(typeof orderDesi.calculateOrderDesi, 'function')
})

/* ═══ RUNTIME-3 ══════════════════════════════════════════════════════ */

test('RUNTIME-3: GERCEK worker bootstrap kapanisi URETIM cozucusuyle yuklenir', async () => {
  // `server/index.mjs` uretimde `node` ile calisir. Dinleyici ACILMAZ.
  process.env.CF_IMPORT_ONLY = '1'
  const app = await import('./index.mjs')
  assert.equal(typeof app.runLabelJobViaCreateHandler, 'function')
  const worker = await import('./shipments/labelJobWorker.ts')
  assert.equal(typeof worker.runLabelJobCycle, 'function')
  assert.equal(typeof worker.startLabelJobScheduler, 'function')
  // Dinleyici ACILMADI.
  const servers = process._getActiveHandles().filter(
    (handle) => handle?.constructor?.name === 'Server',
  )
  assert.equal(servers.length, 0)
})

/* ═══ RUNTIME-4 ══════════════════════════════════════════════════════ */

test('RUNTIME-4: GERCEK claim yolu → Picking → desi 2 → TEK create → READY', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)

  // Worker'in uretimde kullandigi MODULLERIN KENDISI — Vite YOK, mock YOK.
  const worker = await import('./shipments/labelJobWorker.ts')
  const { prepareLabelJob } = await import('./shipments/labelJobPreparation.ts')

  const carrier = []
  await worker.runLabelJobCycle({
    db,
    workerId: 'production-runtime-test',
    runLabel: async (job) => {
      // `runLabelJobViaCreateHandler` ile AYNI sozlesme.
      const prepared = await prepareLabelJob(db, {
        organizationId,
        packageId: job.packageId,
        marketplace: job.marketplace,
      })
      if (!prepared.ok) {
        return {
          labelReady: false, networkCrossed: false, blocked: true,
          errorCode: prepared.blockerCode,
          errorSummary: prepared.failureDetail
            ? `${prepared.errorSummary} · ${prepared.failureDetail}`
            : prepared.errorSummary,
          carrierCalls: 0,
        }
      }
      // TASIYICI SINIRI — gercek ag YOK.
      carrier.push({
        packageId: prepared.packageId,
        birimDesi: prepared.suratBirimDesi,
        orderDesi: Number(prepared.order.desi),
        eligible: prepared.eligibleForCreate,
        whoPays: prepared.expectedWhoPays,
      })
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })

  // TEK create ve YALNIZ uygun paket icin.
  assert.equal(carrier.length, 1)
  assert.equal(carrier[0].packageId, PICKING)
  assert.equal(carrier[0].birimDesi, 2)
  assert.equal(carrier[0].orderDesi, 2)
  assert.equal(carrier[0].eligible, true)
  assert.equal(carrier[0].whoPays, 3)

  const rows = await db.select().from(schema.labelJobs)
  const byPackage = Object.fromEntries(rows.map((row) => [row.packageId, row]))
  assert.equal(byPackage[PICKING].status, 'READY')
  assert.equal(byPackage[PICKING].attemptCount, 1)

  // Created paket: KESIN kod, taşıyıcıya CIKILMADI.
  assert.equal(byPackage[CREATED].status, 'BLOCKED')
  assert.equal(byPackage[CREATED].lastErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
  assert.notEqual(byPackage[CREATED].lastErrorCode, 'SURAT_PREFLIGHT_FAILED')
})

/* ═══ RUNTIME-5 ══════════════════════════════════════════════════════ */

test('RUNTIME-5: modul cozumleme hatasi GENEL koda DUSMEZ, sebep TASINIR', async () => {
  const { PREPARATION_BLOCKER_CODES, summarizeBlocker } = await import(
    './shipments/labelJobPreparation.ts'
  )
  assert.equal(
    PREPARATION_BLOCKER_CODES.MODULE_LOAD,
    'SURAT_PREFLIGHT_MODULE_LOAD_FAILED',
  )
  // Genel cumle DEGIL, kendi cumlesi.
  const summary = summarizeBlocker(PREPARATION_BLOCKER_CODES.MODULE_LOAD)
  assert.match(summary, /modül çözümlemesi/)
  assert.notEqual(summary, 'Sürat gönderisi hazırlanamadı.')

  // Worker gercek istisnayi OZETE ekler ve gunluge yazar.
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const at = source.indexOf('async function runLabelJobViaCreateHandler(job)')
  const body = source.slice(at, at + 4000)
  assert.match(body, /const detail = prepared\.failureDetail/)
  assert.match(body, /preparationFailureDetail: detail/)
  assert.match(body, /console\.warn\(/)
  // Genel ozet TEK BASINA yazilmaz.
  assert.match(body, /\$\{prepared\.errorSummary\} · \$\{detail\}/)
})

/* ═══ RUNTIME-REG ════════════════════════════════════════════════════ */

test('RUNTIME-REG: bu dosya VITE KULLANMAZ ve suitede KAYITLI', async () => {
  const self = readFileSync(
    join(here, 'production-runtime-worker-flow.test.mjs'), 'utf8',
  )
  // Vite araciligi bu dosyada YASAK: uretim cozucusu olcumu bozulur.
  // (Kendi iddia metnini saymamak icin GERCEK import satiri aranir.)
  const importsVite = self
    .split('\n')
    .some((line) => /^\s*import\s/.test(line) && /vite/.test(line))
  assert.equal(importsVite, false, 'bu dosya Vite ile yuklerse olcum ANLAMSIZ')
  const usesSsrLoad = self
    .split('\n')
    .some((line) => /_vite\.ssrLoadModule|createServer\(/.test(line))
  assert.equal(usesSsrLoad, false)

  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/production-runtime-worker-flow.test.mjs'))
})
