import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ GENEL WORKER PARİTESİ ══════════════════════════════════════════════
//
// ÜRETİM OLAYI: aday seçici üç paketi `SAFE_CANARY=YES` ilan etti, `run-once`
// biri için READY üretti. GENEL worker açılınca AYNI koşullardaki üç paket
// `BLOCKED · SURAT_PREFLIGHT_DESI_MISSING` oldu ve izler taşıyıcıya
// ÇIKILMADIĞINI kanıtladı.
//
// SEBEP: worker siparişi create handler'a HAM veriyordu; desinin çözülmesini
// handler'ın İÇİNDEKİ `ensureTenantResolvedDesi` kancasına bırakıyordu. O
// kanca sessizce çalışmazsa `order.desi` boş kalır ve create AĞDAN ÖNCE
// düşer. Ön kontrol ise desiyi KENDİ çözüyordu → aynı paket, iki gerçek.
//
// İkinci sonuç: `Created` paketleri de desi hatası yazdı, çünkü desi kapısı
// uygunluk kapısından ÖNCE patlıyordu.
//
// Bu dosya HAZIRLIĞIN dört çağıran için AYNI olduğunu ölçer ve worker'ı
// GERÇEK `claimLabelJobs` yolundan çalıştırır — talep sorgusu ATLANMAZ.
//
// GERÇEK TAŞIYICI ÇAĞRISI YOKTUR: taşıyıcı sınırı enjekte edilir ve sayılır.

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

const PICKING = '4110388725'
const CREATED = '4110352749'

async function seed(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()
  if (options.desi !== null) {
    const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
    await defaults.saveShipmentDefaults(db, org.id, {
      defaultUnitDesi: options.desi ?? 2,
      multiplyByItemQuantity: false,
      labelPrintTemplate: 'cargoflow_html',
    })
  }
  const credentials = await load('/server/integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER', liveSifre: 'CF-TEST-PASS',
  })
  const encryption = await load('/server/orders/orderEncryption.ts')

  for (const [packageId, marketplaceStatus] of [
    [PICKING, 'Picking'],
    [CREATED, 'Created'],
  ]) {
    await db.insert(schema.orders).values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `ORD-${packageId}`,
      orderDate: new Date('2026-08-27T00:00:00.000Z'),
      cargoTrackingNumber: `7280${packageId.slice(-6)}`,
      operationStatus: 'NEW',
      marketplaceStatus,
      cargoProviderName: 'Surat Kargo',
      firstSeenAt: new Date('2026-08-27T00:00:00.000Z'),
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

/**
 * ÜRETİM WORKER'ININ YAPTIĞININ AYNISI — ama taşıyıcı sınırı ENJEKTE.
 *
 * `runLabelJobViaCreateHandler` bu hazırlığı çağırır ve `prepared.ok`
 * değilse taşıyıcıya ÇIKMADAN deterministik kodla döner. Burada AYNI
 * sözleşme kurulur; farkı olsaydı WORKER-PARITY-6 düşerdi.
 */
function makeWorkerRunLabel(db, organizationId, carrier) {
  return async (job) => {
    const { prepareLabelJob } = await load(
      '/server/shipments/labelJobPreparation.ts',
    )
    const prepared = await prepareLabelJob(db, {
      organizationId,
      packageId: job.packageId,
      marketplace: job.marketplace,
    })
    if (!prepared.ok) {
      return {
        labelReady: false,
        networkCrossed: false,
        blocked: true,
        errorCode: prepared.blockerCode,
        errorSummary: prepared.errorSummary,
        carrierCalls: 0,
      }
    }
    // TAŞIYICI SINIRI — gerçek ağ YOK, çağrı SAYILIR.
    return carrier(prepared)
  }
}

async function runWorkerCycle(db, organizationId, carrier) {
  const worker = await load('/server/shipments/labelJobWorker.ts')
  return worker.runLabelJobCycle({
    db,
    workerId: 'worker-parity-test',
    runLabel: makeWorkerRunLabel(db, organizationId, carrier),
  })
}

async function jobsByPackage(db) {
  const rows = await db.select().from(schema.labelJobs)
  return Object.fromEntries(rows.map((row) => [row.packageId, row]))
}

/* ═══ WORKER-PARITY-1 / 2 / 3 ════════════════════════════════════════ */

test('WORKER-PARITY-1/2/3: Picking + kiraci desi 2 → BirimDesi 2, TEK create, READY', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const seen = []

  await runWorkerCycle(db, organizationId, (prepared) => {
    // Taşıyıcıya giden semantik desi BURADA ölçülür.
    seen.push({
      packageId: prepared.packageId,
      resolvedDesi: prepared.resolvedDesi,
      birimDesi: prepared.suratBirimDesi,
      orderDesi: Number(prepared.order.desi),
      whoPays: prepared.expectedWhoPays,
      role: prepared.credentialRole,
    })
    return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
  })

  // WORKER-PARITY-3: yalnız UYGUN paket taşıyıcıya gitti — TEK create.
  assert.equal(seen.length, 1, 'tasiyici sinirina birden fazla paket gitti')
  assert.equal(seen[0].packageId, PICKING)
  // WORKER-PARITY-2: Desi 2 → BirimDesi 2, ve sipariş gövdesine YAZILDI.
  assert.equal(seen[0].resolvedDesi, 2)
  assert.equal(seen[0].birimDesi, 2)
  assert.equal(seen[0].orderDesi, 2, 'desi siparis govdesine ENJEKTE EDILMEDI')
  // WhoPays semantiği DEĞİŞMEDİ.
  assert.equal(seen[0].whoPays, 3)
  assert.equal(seen[0].role, 'PRIMARY_MARKETPLACE')

  // WORKER-PARITY-1: iş READY.
  const after = await jobsByPackage(db)
  assert.equal(after[PICKING].status, 'READY')
  assert.equal(after[PICKING].attemptCount, 1)
})

/* ═══ WORKER-PARITY-4 / 5 ════════════════════════════════════════════ */

test('WORKER-PARITY-4/5: Created → BLOCKED TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS, create 0', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const calls = { count: 0 }

  await runWorkerCycle(db, organizationId, () => {
    calls.count += 1
    return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
  })

  const after = await jobsByPackage(db)
  // WORKER-PARITY-4: kesin kod — desi hatası DEĞİL.
  assert.equal(after[CREATED].status, 'BLOCKED')
  assert.equal(after[CREATED].lastErrorCode, 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS')
  assert.notEqual(after[CREATED].lastErrorCode, 'SURAT_PREFLIGHT_DESI_MISSING')
  // TASK 8: özet kod ile TUTARLI; kimlik cümlesi KULLANILMAZ.
  assert.match(after[CREATED].lastErrorSummary, /uygun statüde değil|Picking/)
  assert.ok(!/kimlik doğrulaması/i.test(after[CREATED].lastErrorSummary ?? ''))
  // WORKER-PARITY-5: Created paket taşıyıcıya HİÇ gitmedi (yalnız Picking gitti).
  assert.equal(calls.count, 1)
})

/* ═══ WORKER-PARITY-6 ════════════════════════════════════════════════ */

test('WORKER-PARITY-6: run-once ve worker hazirlik verisi AYNI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const preparation = await load('/server/shipments/labelJobPreparation.ts')
  const preflight = await load('/server/shipments/labelJobPreflight.ts')

  for (const packageId of [PICKING, CREATED]) {
    const prepared = await preparation.prepareLabelJob(db, {
      organizationId, packageId, marketplace: 'Trendyol',
    })
    // run-once ve seçici ön kontrolü tüketir; ön kontrol de AYNI hazırlığı.
    const viaPreflight = await preflight.preflightLabelJob(db, {
      organizationId, packageId,
    })
    assert.equal(viaPreflight.resolvedDesi, prepared.resolvedDesi, packageId)
    assert.equal(viaPreflight.suratBirimDesi, prepared.suratBirimDesi, packageId)
    assert.equal(viaPreflight.tenantDesi, prepared.tenantDesi, packageId)
    assert.equal(viaPreflight.billingParty, prepared.billingParty, packageId)
    assert.equal(
      viaPreflight.expectedSuratWhoPays, prepared.expectedWhoPays, packageId,
    )
    assert.equal(viaPreflight.credentialRole, prepared.credentialRole, packageId)
    assert.equal(
      viaPreflight.credentialResolved,
      prepared.credentialSnapshot.resolved,
      packageId,
    )
    assert.equal(viaPreflight.eligibleForCreate, prepared.eligibleForCreate, packageId)
    assert.equal(viaPreflight.preflightValid, prepared.ok, packageId)
  }
})

/* ═══ WORKER-PARITY-7 ════════════════════════════════════════════════ */

test('WORKER-PARITY-7: aday secici ve worker uygunlugu AYNI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seed(db)
  const selector = await load('/server/shipments/canaryCandidateSelector.ts')
  const preparation = await load('/server/shipments/labelJobPreparation.ts')

  const report = await selector.selectCanaryCandidates(db, { organizationId })
  for (const candidate of report.candidates) {
    const prepared = await preparation.prepareLabelJob(db, {
      organizationId, packageId: candidate.packageId, marketplace: 'Trendyol',
    })
    assert.equal(
      candidate.wouldCallCarrier, prepared.ok,
      `${candidate.packageId}: secici ve worker AYRISTI`,
    )
    assert.equal(candidate.resolvedDesi, prepared.resolvedDesi, candidate.packageId)
    assert.equal(
      candidate.safeCanary, prepared.ok && candidate.attemptCount === 0,
      candidate.packageId,
    )
  }
  // Created paket seçicide de aday DEĞİL.
  const created = report.candidates.find((c) => c.packageId === CREATED)
  assert.equal(created.safeCanary, false)
  assert.ok(created.blockers.includes('TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'))
})

/* ═══ WORKER-PARITY-8 / 9 ════════════════════════════════════════════ */

test('WORKER-PARITY-8/9: deterministik ret ASLA retry veya UNKNOWN olmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  // Kiracıda desi ayarı YOK → deterministik desi reddi.
  const organizationId = await seed(db, { desi: null })
  const calls = { count: 0 }

  await runWorkerCycle(db, organizationId, () => {
    calls.count += 1
    return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
  })

  assert.equal(calls.count, 0, 'desi yokken tasiyiciya CIKILDI')
  const after = await jobsByPackage(db)
  for (const packageId of [PICKING, CREATED]) {
    // WORKER-PARITY-8: kendi kendine uyanan satır BIRAKILMAZ.
    assert.notEqual(after[packageId].status, 'FAILED_SAFE_TO_RETRY', packageId)
    // WORKER-PARITY-9: ağ geçilmedi → UNKNOWN ASLA yazılmaz.
    assert.notEqual(after[packageId].status, 'UNKNOWN_AFTER_NETWORK', packageId)
    assert.equal(after[packageId].status, 'BLOCKED', packageId)
  }
  // TASK 8: desi kodu → desi cümlesi. Kimlik cümlesi KARIŞTIRILMAZ.
  assert.equal(after[PICKING].lastErrorCode, 'SURAT_PREFLIGHT_DESI_MISSING')
  assert.match(after[PICKING].lastErrorSummary, /Desi bilgisi çözülemedi/)
  assert.ok(!/kimlik doğrulaması/i.test(after[PICKING].lastErrorSummary ?? ''))

  // Sayaç DÖNGÜYE girmez: ikinci tur BLOKE satırı TALEP ETMEZ.
  await runWorkerCycle(db, organizationId, () => {
    calls.count += 1
    return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
  })
  const second = await jobsByPackage(db)
  assert.equal(second[PICKING].attemptCount, after[PICKING].attemptCount)
  assert.equal(calls.count, 0)
})

/* ═══ TALEP SORGUSU ATLANMAZ ═════════════════════════════════════════ */

test('WORKER-PARITY-REG: worker GERCEK claimLabelJobs yolunu kullanir', async () => {
  const worker = readFileSync(join(here, 'shipments', 'labelJobWorker.ts'), 'utf8')
  assert.match(worker, /claimLabelJobs/)

  // Worker create yolu PAYLASILAN hazirligi tuketir; kendi siparis/desi
  // yuklemesini YAPMAZ.
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const at = source.indexOf('async function runLabelJobViaCreateHandler(job)')
  assert.ok(at > 0)
  const body = source.slice(at, source.indexOf('\nasync function startLabelJobWorkerOnBoot', at))
  assert.match(body, /prepareLabelJob\(db, \{/)
  assert.match(body, /const order = prepared\.order/)
  // Ikinci bir siparis yukleme yolu KALMADI.
  assert.ok(
    !/findOrderByPackageId\(/.test(body),
    'worker hala KENDI siparis yuklemesini yapiyor',
  )
  assert.ok(
    !/persistence\.getOrder\(/.test(body),
    'worker hala KENDI view-model yuklemesini yapiyor',
  )

  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/worker-preparation-parity-flow.test.mjs'))
})
