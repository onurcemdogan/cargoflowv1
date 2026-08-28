import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ TEK PAYLAŞILAN, SALT-OKUNUR ETİKET İŞİ ÖN KONTROLÜ ═════════════════
//
// ÜRETİM KANITI: `auto-label:job:inspect`, kiracı ayarı 2 iken
// `RESOLVER_DESI = null` ve `BLOCKERS = DESI_COZUMU_OKUNAMADI` yazdı.
// O engel ÇÖZÜCÜDEN değil, incelemenin KENDİ `catch {}` bloğundan geldi:
// hazırlık bir istisna attı ve GERÇEK sebep YUTULDU.
//
// İki ayrı hazırlık = iki ayrı gerçek. Bu dosya şunu sabitler:
//   1. Hazırlık TEK yerdedir (`preflightLabelJob`).
//   2. İnceleme AYNI hazırlığı çağırır; kopya uygulama YOKTUR.
//   3. İstisna ASLA yutulmaz; mesaj AYNEN taşınır.
//   4. Ön kontrol taşıyıcı ağının HEMEN ÖNCESİNDE durur.
//
// TAŞIYICI ÇAĞRISI YOKTUR. VERİTABANI YAZIMI YOKTUR.

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

/** Üretim paketi 4110109345: gerçek sipariş, ürün SATIRI YOK. */
const PACKAGE_ID = '4110109345'
const ORDER_NUMBER = '11545965908'

/**
 * @param options.desi kiracı `defaultUnitDesi` (null → ayar YOK)
 * @param options.whoPays Trendyol ham alanı (undefined → pazaryeri öder)
 * @param options.jobStatus etiket işi durumu (null → iş YOK)
 */
async function seed(db, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()

  if (options.desi != null) {
    const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
    await defaults.saveShipmentDefaults(db, org.id, {
      defaultUnitDesi: options.desi,
      multiplyByItemQuantity: false,
      labelPrintTemplate: 'cargoflow_html',
    })
  }

  // KİMLİK: YALNIZ `live*` alanları yazılır — taban `kullaniciAdi`/`sifre`
  // BİLEREK boş bırakılır. Kanonik hesap `deriveCanonicalPrimaryAccount`
  // ile TÜREMEK ZORUNDADIR; elle taban alan okuyan bir kopya burada
  // "kimlik yok" derdi (üretimde ölçülen kusur CF-4088678590).
  const credentials = await load('/server/integrations/credentialService.ts')
  await credentials.saveIntegrationCredential(db, org.id, 'surat', {
    liveKullaniciAdi: 'CF-TEST-USER',
    liveSifre: 'CF-TEST-PASS',
  })

  const encryption = await load('/server/orders/orderEncryption.ts')
  const raw = { orderNumber: ORDER_NUMBER, id: PACKAGE_ID }
  if (options.whoPays !== undefined) raw.whoPays = options.whoPays
  await db.insert(schema.orders).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: PACKAGE_ID,
    orderNumber: ORDER_NUMBER,
    orderDate: new Date('2026-08-20T00:00:00.000Z'),
    cargoTrackingNumber: '7279999999',
    operationStatus: 'NEW',
    // UYGUN STATU: create handler'in uygunluk kapisi bu paketi gecirir.
    // (Created/Yeni statusu Picking guncellemesi ister ve KAPIDA DURUR.)
    marketplaceStatus: options.marketplaceStatus ?? 'Picking',
    cargoProviderName: options.cargoProviderName ?? 'Surat Kargo',
    firstSeenAt: new Date('2026-08-20T00:00:00.000Z'),
    // PII ve ham sipariş ŞİFRELİ saklanır — üretimdeki yolun AYNISI.
    rawPayloadEncrypted: encryption.encryptOrderPayload(raw),
  })

  if (options.jobStatus !== null) {
    await db.insert(schema.labelJobs).values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      carrier: 'surat',
      packageId: PACKAGE_ID,
      jobType: 'LABEL_PREPARE',
      status: options.jobStatus ?? 'BLOCKED',
      attemptCount: options.attemptCount ?? 25,
      lastErrorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
    })
  }
  if (options.extra) await options.extra(db, org.id)
  return org.id
}

/* ═══ PREFLIGHT-1 ════════════════════════════════════════════════════ */

test('PREFLIGHT-1: SALT-OKUNUR — yazim, ag ve tasiyici cagrisi YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')
  const organizationId = await seed(db, { desi: 2 })

  const before = await db.select().from(schema.labelJobs)
  const result = await preflight.preflightLabelJob(db, {
    organizationId, packageId: PACKAGE_ID,
  })

  assert.equal(result.networkCalls, 0)
  assert.equal(result.dbWrites, 0)
  assert.equal(result.carrierCalls, 0)

  // Hiçbir satır DEĞİŞMEDİ — durum da deneme sayacı da AYNI.
  const afterJobs = await db.select().from(schema.labelJobs)
  assert.deepEqual(
    afterJobs.map((job) => [job.packageId, job.status, job.attemptCount]),
    before.map((job) => [job.packageId, job.status, job.attemptCount]),
  )
  // Taşıyıcı artefaktı YARATILMADI.
  assert.equal((await db.select().from(schema.shipments)).length, 0)
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 0)
})

/* ═══ PREFLIGHT-2 ════════════════════════════════════════════════════ */

test('PREFLIGHT-2: kiraci desi 2 → SATIRSIZ pakette BirimDesi 2', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')
  const organizationId = await seed(db, { desi: 2 })

  const result = await preflight.preflightLabelJob(db, {
    organizationId, packageId: PACKAGE_ID,
  })

  assert.equal(result.orderNumber, ORDER_NUMBER)
  assert.equal(result.tenantDesi, 2)
  assert.equal(result.multiplyByItemQuantity, false)
  assert.equal(result.orderLinesCount, 0)
  assert.equal(result.resolvedDesi, 2, 'paylasilan cozucu desiyi bulamadi')
  assert.equal(result.desiSource, 'tenant_settings')
  // Sürat sözleşmesi: `BirimDesi` çözülen desidir.
  assert.equal(result.suratBirimDesi, 2)
  assert.ok(!result.blockers.includes('DESI_COZULEMIYOR'))
  assert.equal(result.failureDetail, null)
})

/* ═══ PREFLIGHT-3 ════════════════════════════════════════════════════ */

test('PREFLIGHT-3: inceleme ve worker on kontrolu AYNI sonucu verir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const organizationId = await seed(db, { desi: 2 })

  const worker = await preflight.preflightLabelJob(db, {
    organizationId, packageId: PACKAGE_ID,
  })
  const inspector = await legacy.inspectSingleJobReactivation(db, {
    organizationId, packageId: PACKAGE_ID,
  })

  // PARİTE: inceleme artık KOPYA bir hazırlık çalıştırmaz.
  assert.equal(inspector.resolverDesi, worker.resolvedDesi)
  assert.equal(inspector.tenantDesiValue, worker.tenantDesi)
  assert.equal(inspector.multiplyByItemQuantity, worker.multiplyByItemQuantity)
  assert.equal(inspector.resolverDesi, 2)
  // Üretimdeki hayalet engel ARTIK YOK.
  assert.ok(!inspector.blockers.includes('DESI_COZUMU_OKUNAMADI'))
  assert.ok(!inspector.blockers.includes('DESI_COZULEMIYOR'))
})

/* ═══ PREFLIGHT-4 ════════════════════════════════════════════════════ */

test('PREFLIGHT-4: istisna YUTULMAZ — gercek sebep aynen tasinir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')
  const legacy = await load('/server/shipments/legacyRetryQuarantine.ts')
  const organizationId = await seed(db, { desi: 2 })

  // ŞEMA AYRIŞMASI benzetimi: kod `orders` tablosunu okuyor ama kolon YOK.
  // Üretimde bu, `DESI_COZUMU_OKUNAMADI` diye ETİKETLENİP kayboluyordu.
  await pglite.exec('ALTER TABLE "orders" DROP COLUMN "sales_disposition"')

  const result = await preflight.preflightLabelJob(db, {
    organizationId, packageId: PACKAGE_ID,
  })
  assert.ok(result.failureDetail, 'gercek istisna mesaji KAYBOLDU')
  assert.match(result.failureDetail, /sales_disposition/)
  // Mesaj deterministik olarak sınıflandırılır; uydurma sebep YOK.
  assert.ok(result.blockers.includes('SEMA_SURUMU_ESKI'), result.blockers.join(','))
  assert.equal(result.preflightValid, false)
  assert.equal(result.wouldCallCarrier, false)

  // İnceleme de artık sebebi TAŞIR; genel etikete indirgemez.
  const inspector = await legacy.inspectSingleJobReactivation(db, {
    organizationId, packageId: PACKAGE_ID,
  })
  assert.equal(inspector.safeToReactivate, false)
  assert.ok(
    inspector.blockers.some((blocker) => blocker.includes('sales_disposition')),
    inspector.blockers.join(','),
  )
})

/* ═══ PREFLIGHT-5 ════════════════════════════════════════════════════ */

test('PREFLIGHT-5: kiracida desi ayari YOKSA create ACILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')
  const organizationId = await seed(db, { desi: null })

  const result = await preflight.preflightLabelJob(db, {
    organizationId, packageId: PACKAGE_ID,
  })
  // SESSİZ VARSAYILAN YOK — uydurma desi, yanlış fiyatlı bir gönderidir.
  assert.equal(result.resolvedDesi, null)
  assert.equal(result.suratBirimDesi, null)
  assert.ok(result.blockers.includes('TENANT_DESI_AYARLI_DEGIL'))
  assert.ok(result.blockers.includes('DESI_COZULEMIYOR'))
  assert.equal(result.preflightValid, false)
  assert.equal(result.wouldCallCarrier, false)
})

/* ═══ PREFLIGHT-6 ════════════════════════════════════════════════════ */

test('PREFLIGHT-6: WhoPays semantigi DEGISMEDEN raporlanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')

  // whoPays ALANI YOK → pazaryeri öder → 3 / PRIMARY_MARKETPLACE.
  const marketplacePays = await seed(db, { desi: 2 })
  const first = await preflight.preflightLabelJob(db, {
    organizationId: marketplacePays, packageId: PACKAGE_ID,
  })
  assert.equal(first.billingParty, 'TRENDYOL_PAYS')
  assert.equal(first.expectedSuratWhoPays, 3)
  assert.equal(first.credentialRole, 'PRIMARY_MARKETPLACE')
  // Kanonik türetme UYGULANDI: taban alanlar boşken kimlik ÇÖZÜLDÜ.
  assert.equal(first.credentialResolved, true)
  assert.ok(!first.blockers.includes('KIMLIK_COZULEMIYOR'))

  // whoPays = 1 → satıcı öder → 1 / SELLER_PAYS.
  const sellerPays = await seed(db, { desi: 2, whoPays: 1 })
  const second = await preflight.preflightLabelJob(db, {
    organizationId: sellerPays, packageId: PACKAGE_ID,
  })
  assert.equal(second.billingParty, 'SELLER_PAYS')
  assert.equal(second.expectedSuratWhoPays, 1)
  assert.equal(second.credentialRole, 'SELLER_PAYS')
})

/* ═══ PREFLIGHT-7 ════════════════════════════════════════════════════ */

test('PREFLIGHT-7: KUYRUKTAKI isler on kontrolden ETKILENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const preflight = await load('/server/shipments/labelJobPreflight.ts')
  // Üretimde worker KAPALIYKEN sıraya giren üç meşru iş.
  const QUEUED = ['4110346669', '4110352749', '4110388725']
  const organizationId = await seed(db, {
    desi: 2,
    extra: async (database, orgId) => {
      for (const packageId of QUEUED) {
        await database.insert(schema.labelJobs).values({
          organizationId: orgId, marketplace: 'Trendyol', carrier: 'surat',
          packageId, jobType: 'LABEL_PREPARE', status: 'QUEUED', attemptCount: 0,
        })
      }
      // Taşıyıcı artefaktı OLAN bir paket create'e AÇILMAZ.
      await database.insert(schema.shipments).values({
        organizationId: orgId, marketplace: 'Trendyol', packageId: '4110346669',
        provider: 'surat', trackingNumber: '7280000001', source: 'local_create',
        status: 'created',
      })
    },
  })

  // Artefaktı olan paket: create KESİNLİKLE açılmaz.
  const withArtifact = await preflight.preflightLabelJob(db, {
    organizationId, packageId: '4110346669',
  })
  assert.ok(withArtifact.blockers.includes('TASIYICI_ARTEFAKTI_VAR'))
  assert.equal(withArtifact.wouldCallCarrier, false)

  // Diğer iki iş SORGULANSA BİLE dokunulmaz kalır.
  for (const packageId of QUEUED.slice(1)) {
    await preflight.preflightLabelJob(db, { organizationId, packageId })
  }
  const rows = await db.select().from(schema.labelJobs)
  for (const packageId of QUEUED) {
    const job = rows.find((row) => row.packageId === packageId)
    assert.equal(job.status, 'QUEUED', packageId)
    assert.equal(job.attemptCount, 0, packageId)
  }
})
