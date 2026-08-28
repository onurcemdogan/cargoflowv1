import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ DESİ ÇALIŞMA ZAMANI — GERÇEK ÜRETİM ARIZASI (paket 4110109345) ═════
//
// KANIT:
//   serviceMode = ORTAK_BARKOD_SOAP · credentialResolved = true
//   billingParty = TRENDYOL_PAYS   · expectedSuratWhoPays = 3
//   ACTUAL_WIRE = STAGE_MISSING    · carrierCalled = false
//   carrierExceptionSummary = "Desi bilgisi eksik..."
//   job.last_error_code = SURAT_SOAP_TRANSPORT_FAILED  (YANLIŞ)
//   job.attempt_count   = 2                            (SONSUZ TEKRAR)
//
// Kiracı ayarı KANITLI: defaultUnitDesi = 2, multiplyByItemQuantity = false
//
// ÜÇ AYRI KUSUR:
//   1. Çözücü SATIR BAŞINA topluyordu; satırsız siparişte toplam 0 → desi
//      "çözülemedi" sayılıyordu. Ayar "gönderi başına varsayılan"dır.
//   2. Zarf hiç kurulmadığı hâlde hata TAŞIMA hatası olarak kodlanıyordu.
//   3. Deterministik ağ-öncesi ret her turda yeniden deneniyordu.
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

/** Üretim ayarı: 2 desi, çarpan KAPALI. */
async function makeTenant(db, name = 'TarzimTuba', desi = 2) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, slug: `${name.toLowerCase()}-${randomBytes(4).toString('hex')}` })
    .returning()
  if (desi != null) {
    const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
    await defaults.saveShipmentDefaults(db, org.id, {
      defaultUnitDesi: desi,
      multiplyByItemQuantity: false,
      labelPrintTemplate: 'cargoflow_html',
    })
  }
  return org.id
}

/** 4110109345'in şekli: gerçek paket, ürün SATIRI YOK. */
const LINELESS_ORDER = {
  id: 'order-4110109345',
  orderNumber: '11545965908',
  packageId: '4110109345',
  marketplace: 'Trendyol',
  cargoTrackingNumber: '7279999999',
  items: [],
}

const LINED_ORDER = {
  ...LINELESS_ORDER,
  items: [{ id: 'L-0', productName: 'Urun A', quantity: 1, sku: 'SKU-1' }],
}

test('DESI-RUNTIME-1: kiraci 2 → SATIRSIZ siparis dahil BirimDesi 2', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const organizationId = await makeTenant(db)

  // KÖK KUSUR: satırsız siparişte toplam 0 çıkıyor ve desi "çözülemedi"
  // sayılıyordu — kiracıda ayar OLMASINA rağmen.
  const lineless = await resolver.resolveShipmentDesi({
    db, organizationId, order: LINELESS_ORDER,
  })
  assert.equal(lineless.desi, 2, 'satirsiz siparis icin desi cozulemedi')
  assert.equal(lineless.source, 'tenant_settings')
  assert.equal(lineless.tenantSettingValue, 2)

  // Satırlı sipariş davranışı DEĞİŞMEDİ.
  const lined = await resolver.resolveShipmentDesi({
    db, organizationId, order: LINED_ORDER,
  })
  assert.equal(lined.desi, 2)

  // SURAT_BIRIM_DESI aynı değerdir: create `BirimDesi: desi` yazar.
  assert.match(readFileSync(join(here, 'index.mjs'), 'utf8'), /BirimDesi: desi/)
})

test('DESI-RUNTIME-2: elle ve worker AYNI cozucuyu/orkestrasyonu kullanir', async () => {
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Tek giriş noktası: create çekirdeği desiyi kendisi çözer.
  assert.match(server, /await ensureTenantResolvedDesi\(request\)/)
  const core = server.indexOf('async function createSuratShipmentCore')
  assert.ok(server.indexOf('await ensureTenantResolvedDesi(request)') > core)
  // Worker gövdesinde İKİNCİ bir desi yolu YOK.
  const wStart = server.indexOf('async function runLabelJobViaCreateHandler')
  const wEnd = server.indexOf('async function startLabelJobWorkerOnBoot')
  const workerCode = server.slice(wStart, wEnd)
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10))
  assert.ok(!/\bdesi\s*:/i.test(workerCode))
  assert.ok(!/defaultUnitDesi/i.test(workerCode))
})

test('DESI-RUNTIME-3: cozulen desi orkestrasyon ile preflight arasinda DUSMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const resolver = await load('/server/shipments/resolveShipmentDesi.ts')
  const organizationId = await makeTenant(db)

  // `ensureTenantResolvedDesi` siparis NESNESINI mutate eder; create ayni
  // referansi okur. Burada o sozlesme dogrulanir.
  const order = { ...LINELESS_ORDER }
  const resolution = await resolver.resolveShipmentDesi({ db, organizationId, order })
  order.desi = resolution.desi
  assert.equal(Number(order.desi) > 0, true)

  // Preflight'in okudugu alan ADI ile cozulen alan ADI AYNI olmali.
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(server, /const desi = toPositiveNumber\(order\.desi\)/)
  assert.match(server, /order\.desi = resolution\.desi/)
})

test('DESI-RUNTIME-4: desi yoksa TASIMA hatasi DEGIL, kesin preflight kodu', async () => {
  const soap = await load('/server/shipments/suratSoapPrimaryCreate.ts')
  // Zarf kurulmadan atilan desi hatasi TASIMA hatasi olarak kodlanmaz.
  assert.equal(
    soap.classifyPreNetworkFailure(new Error('Desi bilgisi eksik. Sürat gönderisi...')),
    'SURAT_PREFLIGHT_DESI_MISSING',
  )
  assert.equal(
    soap.classifyPreNetworkFailure(new Error('Sürat kimlik doğrulaması tamamlanamadı')),
    'SURAT_CREDENTIAL_CONFIG_INVALID',
  )
  assert.ok(!soap.PRE_NETWORK_FAILURE_CODES.includes('SURAT_SOAP_TRANSPORT_FAILED'))

  // TASIMA kodu YALNIZ zarf kurulduysa kullanilir.
  const source = readFileSync(
    join(here, 'shipments', 'suratSoapPrimaryCreate.ts'), 'utf8',
  )
  assert.match(source, /crossedNetwork\s*\n?\s*\?\s*'SURAT_SOAP_TRANSPORT_FAILED'/)
})

test('DESI-RUNTIME-5: DETERMINISTIK engel her turda TEKRAR DENENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await makeTenant(db, 'NoDesi', null)

  await queue.enqueueLabelJob(db, {
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId: '4110109345',
  })

  let attempts = 0
  const runLabel = async () => {
    attempts += 1
    return {
      labelReady: false, networkCrossed: false, carrierCalls: 0,
      errorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
      errorSummary: 'Desi bilgisi eksik.',
    }
  }

  const first = await worker.runLabelJobCycle({
    db, workerId: 'w1', batchSize: 5, runLabel,
  })
  assert.equal(first.blocked, 1, 'deterministik engel BLOKE edilmedi')
  assert.equal(first.carrierCalls, 0)

  // ÜRETİM KUSURU: geri çekilme suresi dolunca is TEKRAR taleple ediliyordu.
  // Artik BLOKE oldugu icin veri degismeden TEKRAR DENENMEZ.
  await pglite.exec("UPDATE label_jobs SET available_at = now() - interval '1 hour'")
  const second = await worker.runLabelJobCycle({
    db, workerId: 'w2', batchSize: 5, runLabel,
  })
  assert.equal(second.claimed, 0, 'veri degismeden yeniden denendi')
  assert.equal(attempts, 1, `attempt_count buyudu: ${attempts}`)

  const jobs = await db.select().from(schema.labelJobs)
  assert.equal(jobs[0].status, 'BLOCKED')
  assert.equal(jobs[0].attemptCount, 1)
})

test('DESI-RUNTIME-6: desi ayarlaninca AYNI is canlanir, TEK create olur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const defaults = await load('/server/onboarding/shipmentDefaultsRepository.ts')
  const organizationId = await makeTenant(db, 'LateDesi', null)

  await queue.enqueueLabelJob(db, {
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId: '4110109345',
  })
  await worker.runLabelJobCycle({
    db, workerId: 'w1', batchSize: 5,
    runLabel: async () => ({
      labelReady: false, networkCrossed: false, carrierCalls: 0,
      errorCode: 'SURAT_PREFLIGHT_DESI_MISSING',
    }),
  })
  assert.equal((await db.select().from(schema.labelJobs))[0].status, 'BLOCKED')

  // Müşteri desiyi ayarlar → BAĞIMLILIK DEĞİŞTİ.
  await defaults.saveShipmentDefaults(db, organizationId, {
    defaultUnitDesi: 2, multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  const revived = await queue.reactivateBlockedLabelJobs(db, {
    organizationId, errorCodes: ['SURAT_PREFLIGHT_DESI_MISSING'],
  })
  assert.equal(revived, 1)

  let creates = 0
  const second = await worker.runLabelJobCycle({
    db, workerId: 'w2', batchSize: 5,
    runLabel: async () => {
      creates += 1
      return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
    },
  })
  assert.equal(second.claimed, 1)
  assert.equal(creates, 1, 'tek create degil')
  assert.equal(second.ready, 1)
  // MÜKERRER İŞ YOK: hâlâ TEK mantıksal iş.
  assert.equal((await db.select().from(schema.labelJobs)).length, 1)
})

test('DESI-RUNTIME-7: carrierCallStarted=false iken UNKNOWN_AFTER_NETWORK IMKANSIZ', async () => {
  const policy = await load('/server/shipments/suratAutoLabelPolicy.ts')
  for (const errorCode of [
    'SURAT_PREFLIGHT_DESI_MISSING',
    'SURAT_CREDENTIAL_CONFIG_INVALID',
    'SURAT_PREFLIGHT_FAILED',
    'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
  ]) {
    const state = policy.resolveAutoLabelJobState({
      networkCrossed: false, labelReady: false, errorCode,
    })
    assert.notEqual(state.state, 'UNKNOWN_AFTER_NETWORK', errorCode)
    assert.equal(state.state, 'BLOCKED', errorCode)
    assert.equal(state.retryAllowed, false)
  }
  // Ağ GERÇEKTEN geçildiyse ihtiyat korunur.
  assert.equal(
    policy.resolveAutoLabelJobState({
      networkCrossed: true, labelReady: false, errorCode: 'SURAT_SOAP_TRANSPORT_FAILED',
    }).state,
    'UNKNOWN_AFTER_NETWORK',
  )
})

test('DESI-RUNTIME-8: TRENDYOL_PAYS ve PRIMARY_MARKETPLACE DEGISMEDI', async () => {
  const routing = await load('/server/shipments/suratRoutingModel.ts')
  assert.equal(routing.resolveBillingPartyV2({}).billingParty, 'TRENDYOL_PAYS')
  assert.equal(
    routing.resolveBillingPartyV2({ whoPays: 1 }).billingParty, 'SELLER_PAYS',
  )
  const resolver = readFileSync(
    join(here, 'shipments', 'resolveShipmentDesi.ts'), 'utf8',
  )
  for (const forbidden of ['whoPays', 'KimOder', 'billingParty', 'PRIMARY_MARKETPLACE']) {
    assert.ok(!resolver.includes(forbidden), `desi cozucusunde ${forbidden}`)
  }
})

test('DESI-RUNTIME-9/10: basari basina TEK SOAP, SECOND_CREATE = NO', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await makeTenant(db)

  for (let index = 0; index < 4; index += 1) {
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
  assert.equal(report.carrierCalls, 4)
  for (const [packageId, count] of perPackage) {
    assert.equal(count, 1, `${packageId} icin ${count} create`)
  }
  const transport = readFileSync(
    join(here, 'shipments', 'suratLabelTransportRoute.ts'), 'utf8',
  )
  assert.match(transport, /OrtakBarkodOlustur/)
  assert.match(transport, /webservices\.suratkargo\.com\.tr\/services\.asmx/)
})

test('DESI-RUNTIME-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})
