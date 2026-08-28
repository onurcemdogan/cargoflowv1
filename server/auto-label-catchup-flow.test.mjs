import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ TEK SEFERLİK YAKALAMA (CATCH-UP) ═══════════════════════════════════
//
// ÜRÜN BOŞLUĞU: aktivasyon sınırı, sınırdan ÖNCE gelmiş ve hâlâ açık olan
// siparişleri sonsuza dek elle işlenmeye bırakıyordu (üretimde 19 sipariş).
//
// ÇÖZÜM SINIRI GEVŞETMEK DEĞİLDİR. Normal üretici hâlâ yalnız
// `first_seen_at >= activatedAt` alır. Yakalama, operatörün AÇIKÇA
// çalıştırdığı, tek organizasyona kilitli, önce SALT-OKUNUR incelenebilen
// AYRI bir işlemdir ve yalnız aktivasyon sınırını atlar — başka hiçbir
// kapıyı değil.
//
// TAŞIYICI ÇAĞRISI YOKTUR: yakalama Sürat'i çağırmaz, yalnız iş yazar.

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

const ACTIVATED_AT = '2026-08-28T00:00:00.000Z'
const BEFORE = new Date('2026-08-20T00:00:00.000Z')
const HISTORICAL = 120
const OPEN_ELIGIBLE = 19

const PARAMS = (organizationId, organizationName = 'TarzimTuba') => ({
  organizationId, organizationName, marketplace: 'Trendyol', carrier: 'Surat',
})

/**
 * Üretim şekli: 120 tarihsel ALAKASIZ sipariş (kapanmış/terminal) +
 * 19 GÜNCEL AÇIK uygun sipariş. Hepsi aktivasyon sınırından ÖNCE görülmüş.
 */
async function seedTenant(db, options = {}) {
  const mapper = await load('/server/orders/orderMapper.ts')
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tarzim-${randomBytes(4).toString('hex')}` })
    .returning()

  const rows = []
  // ── 120 tarihsel, ALAKASIZ (teslim/iptal/iade + etiket basılmış) ──
  const closedStatuses = ['Delivered', 'Cancelled', 'Returned', 'Shipped']
  for (let index = 0; index < HISTORICAL; index += 1) {
    rows.push({
      ...mapper.toOrderInsertValues(org.id, {
        marketplace: 'Trendyol',
        packageId: `OLD-${index}`,
        orderNumber: `ORD-OLD-${index}`,
        marketplaceStatus: closedStatuses[index % closedStatuses.length],
        cargoTrackingNumber: `7270000${index}`,
        orderDate: BEFORE.toISOString(),
        totalAmount: '100.00',
        rawOrder: { whoPays: undefined, status: closedStatuses[index % 4] },
      }),
      operationStatus: index % 2 === 0 ? 'LABEL_PRINTED' : 'DELIVERED',
      firstSeenAt: BEFORE,
    })
  }
  // ── 19 güncel AÇIK ve UYGUN ──
  for (let index = 0; index < OPEN_ELIGIBLE; index += 1) {
    rows.push({
      ...mapper.toOrderInsertValues(org.id, {
        marketplace: 'Trendyol',
        packageId: `OPEN-${index}`,
        orderNumber: `ORD-OPEN-${index}`,
        marketplaceStatus: 'Created',
        cargoTrackingNumber: `7279900${index}`,
        orderDate: BEFORE.toISOString(),
        totalAmount: '250.00',
        // whoPays YOK → TRENDYOL_PAYS (pazaryeri öder) — üretim varsayılanı.
        rawOrder: { status: 'Created' },
      }),
      operationStatus: 'NEW',
      firstSeenAt: BEFORE,
    })
  }
  for (const extra of options.extraRows ?? []) rows.push(extra(org.id, mapper))
  await db.insert(schema.orders).values(rows)

  // YAKALAMA, KİRACININ OTOMATİK ETİKETİ AÇMIŞ OLMASINI GEREKTİRİR.
  // Opt-in yapmamış bir kiracı için geçmişi toplamak, istenmemiş bir
  // taşıyıcı mutasyonu üretmek olurdu. Üretim akışı da aynıdır: önce
  // aktivasyon, sonra tek seferlik yakalama.
  if (options.activate !== false) {
    const producer = await load('/server/shipments/autoLabelProducer.ts')
    await producer.activateAutoLabel(db, org.id, {
      marketplaces: ['trendyol'], carriers: ['surat'], now: ACTIVATED_AT,
    })
  }
  return org.id
}

/* ═══ 1 — SEÇİM ══════════════════════════════════════════════════════ */

test('CATCHUP-1: 120 tarihsel + 19 acik → YALNIZ acik uygun set secilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  const organizationId = await seedTenant(db)

  const report = await catchup.inspectCatchupCandidates(db, PARAMS(organizationId))
  // Terminal/kapanmış 120 sipariş "açık" sorgusuna HİÇ girmez.
  assert.equal(report.totalOpen, OPEN_ELIGIBLE)
  assert.equal(report.eligible, OPEN_ELIGIBLE)
  assert.equal(report.blocked, 0)
  for (const candidate of report.candidates) {
    assert.ok(candidate.packageId.startsWith('OPEN-'), candidate.packageId)
    assert.equal(candidate.eligibilityResult, 'ELIGIBLE')
  }
  // SALT-OKUNUR.
  assert.equal(report.networkCalls, 0)
  assert.equal(report.dbWrites, 0)
  assert.equal(report.carrierCalls, 0)
})

test('CATCHUP-1b: NORMAL uretici hala SINIRA uyar (gevsetilmedi)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const producer = await load('/server/shipments/autoLabelProducer.ts')
  const organizationId = await seedTenant(db)
  // Tüm siparişler sınırdan ÖNCE görülmüş → normal üretici HİÇBİRİNİ almaz.
  const report = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(report.examined, 0)
  assert.equal(report.enqueued, 0)
})

/* ═══ 2 — ÖNCEKİ TAŞIYICI DENEMESİ ═══════════════════════════════════ */

test('CATCHUP-2: onceki create denemesi olan paket HARIC', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const organizationId = await seedTenant(db)

  // OPEN-0 için taşıyıcı çağrılmış bir operasyon kaydı.
  await db.insert(schema.shipmentOperations).values({
    organizationId, marketplace: 'Trendyol', packageId: 'OPEN-0',
    orderNumber: 'ORD-OPEN-0', provider: 'surat', operationType: 'create',
    idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
    status: 'failed', createCallCount: 1, carrierCreateCalled: true,
  })

  const report = await catchup.inspectCatchupCandidates(db, PARAMS(organizationId))
  assert.equal(report.eligible, OPEN_ELIGIBLE - 1)
  assert.equal(report.priorAttempt, 1)
  const blocked = report.candidates.find((c) => c.packageId === 'OPEN-0')
  assert.equal(blocked.eligibilityResult, 'BLOCKED')
  assert.match(blocked.reason, /Önceki create denemesi/)
})

/* ═══ 3 — MEVCUT ETİKET ══════════════════════════════════════════════ */

test('CATCHUP-3: etiketi/tasiyici artefakti olan paket HARIC', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await seedTenant(db)

  // OPEN-1: taşıyıcı artefaktı (shipment kaydı) var.
  await db.insert(schema.shipments).values({
    organizationId, marketplace: 'Trendyol', packageId: 'OPEN-1',
    orderNumber: 'ORD-OPEN-1', provider: 'surat', source: 'local_create',
    status: 'created',
  })
  // OPEN-2: etiketi HAZIR bir iş var.
  await queue.enqueueLabelJob(db, {
    organizationId, marketplace: 'Trendyol', carrier: 'surat', packageId: 'OPEN-2',
  })
  await db.update(schema.labelJobs).set({ status: 'READY' })

  const report = await catchup.inspectCatchupCandidates(db, PARAMS(organizationId))
  assert.equal(report.eligible, OPEN_ELIGIBLE - 2)
  assert.equal(report.alreadyReady, 1)
  const carrierBlocked = report.candidates.find((c) => c.packageId === 'OPEN-1')
  assert.match(carrierBlocked.reason, /Taşıyıcı artefaktı/)
  const readyBlocked = report.candidates.find((c) => c.packageId === 'OPEN-2')
  assert.match(readyBlocked.reason, /zaten hazır/)
})

/* ═══ 4 — İPTAL / İADE / TESLİM ══════════════════════════════════════ */

test('CATCHUP-4: iptal/iade/teslim edilmis siparisler HARIC', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const mapper = await load('/server/orders/orderMapper.ts')
  const organizationId = await seedTenant(db)

  // AÇIK operasyon durumunda ama pazaryeri statüsü terminal olan paketler.
  const rows = ['Cancelled', 'Returned', 'Delivered', 'UnDelivered'].map(
    (status, index) => ({
      ...mapper.toOrderInsertValues(organizationId, {
        marketplace: 'Trendyol',
        packageId: `TERM-${index}`,
        orderNumber: `ORD-TERM-${index}`,
        marketplaceStatus: status,
        cargoTrackingNumber: `7271111${index}`,
        orderDate: BEFORE.toISOString(),
        totalAmount: '10.00',
        rawOrder: { status },
      }),
      operationStatus: 'NEW',
      firstSeenAt: BEFORE,
    }),
  )
  await db.insert(schema.orders).values(rows)

  const report = await catchup.inspectCatchupCandidates(db, PARAMS(organizationId))
  assert.equal(report.totalOpen, OPEN_ELIGIBLE + 4)
  // Dördü de REDDEDİLİR; uygun sayısı DEĞİŞMEZ.
  assert.equal(report.eligible, OPEN_ELIGIBLE)
  for (let index = 0; index < 4; index += 1) {
    const blocked = report.candidates.find((c) => c.packageId === `TERM-${index}`)
    assert.equal(blocked.eligibilityResult, 'BLOCKED')
    assert.match(blocked.reason, /terminal|dispozisyon/)
  }
})

/* ═══ 5 — MÜKERRER ÇALIŞTIRMA ════════════════════════════════════════ */

test('CATCHUP-5: yakalama IKI KEZ calissa da mukerrer is DOGMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const queue = await load('/server/shipments/labelJobQueue.ts')
  const organizationId = await seedTenant(db)

  const first = await catchup.enqueueCatchupJobs(db, PARAMS(organizationId))
  assert.equal(first.enqueued, OPEN_ELIGIBLE)
  assert.equal(first.carrierCalls, 0)

  const second = await catchup.enqueueCatchupJobs(db, PARAMS(organizationId))
  // İkinci turda TEK BİR yeni iş bile doğmaz: ilk turda yazılan işler
  // artık "kuyrukta iş var" gerekçesiyle ADAY BİLE OLMAZ.
  assert.equal(second.enqueued, 0)

  const stats = await queue.labelJobStats(db, organizationId)
  assert.equal(stats.QUEUED, OPEN_ELIGIBLE)
  const jobs = await db.select().from(schema.labelJobs)
  assert.equal(jobs.length, OPEN_ELIGIBLE, 'mantiksal is sayisi degisti')
})

/* ═══ 6 — WORKER: PAKET BAŞINA EN FAZLA 1 SÜRAT ETİKETİ ═════════════ */

test('CATCHUP-6: worker paket basina EN FAZLA BIR Surat etiketi uretir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const organizationId = await seedTenant(db)
  await catchup.enqueueCatchupJobs(db, PARAMS(organizationId))

  // Gerçek Sürat ÇAĞRILMAZ: create enjekte edilir ve sayılır.
  const createdPerPackage = new Map()
  let soapCalls = 0
  const runLabel = async (job) => {
    createdPerPackage.set(
      job.packageId, (createdPerPackage.get(job.packageId) ?? 0) + 1,
    )
    soapCalls += 1
    return { labelReady: true, networkCrossed: true, carrierCalls: 1 }
  }

  let ready = 0
  for (let cycle = 0; cycle < 10 && ready < OPEN_ELIGIBLE; cycle += 1) {
    const report = await worker.runLabelJobCycle({
      db, workerId: `w-${cycle}`, batchSize: 25, runLabel,
    })
    if (report.claimed === 0) break
    ready += report.ready
  }

  assert.equal(ready, OPEN_ELIGIBLE)
  assert.equal(soapCalls, OPEN_ELIGIBLE, 'paket basina 1 cagri degil')
  for (const [packageId, count] of createdPerPackage) {
    assert.equal(count, 1, `${packageId} icin ${count} create`)
  }
  // SECOND_CREATE = NO
  assert.equal(createdPerPackage.size, OPEN_ELIGIBLE)
})

/* ═══ 7 — FATURALAMA DEĞİŞMEDİ ══════════════════════════════════════ */

test('CATCHUP-7: TRENDYOL_PAYS → PRIMARY_MARKETPLACE DEGISMEDI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const routing = await load('/server/shipments/suratRoutingModel.ts')
  const billing = await load('/server/shipments/suratBillingParty.ts')
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const organizationId = await seedTenant(db)

  // whoPays YOKSA → TRENDYOL_PAYS (pazaryeri öder) — üretim sözleşmesi.
  assert.equal(routing.resolveBillingPartyV2({}).billingParty, 'TRENDYOL_PAYS')
  // whoPays=1 → SELLER_PAYS.
  assert.equal(
    routing.resolveBillingPartyV2({ whoPays: 1 }).billingParty, 'SELLER_PAYS',
  )
  // Yakalama modülü faturalamayı KENDİ hesaplamaz; kanonik çözücüyü kullanır.
  const source = readFileSync(
    join(here, 'shipments', 'autoLabelCatchup.ts'), 'utf8',
  )
  assert.match(source, /resolveBillingPartyV2/)
  for (const forbidden of ['whoPays', 'KimOder', 'Tarife', 'EntegrasyonSozlesme']) {
    assert.ok(!source.includes(forbidden), `yakalama icinde ${forbidden}`)
  }
  // WhoPays çözülemeyen paket UYGUN OLMAZ.
  assert.ok(billing.BILLING_PARTIES.includes('UNKNOWN'))
  const report = await catchup.inspectCatchupCandidates(db, PARAMS(organizationId))
  assert.equal(report.eligible, OPEN_ELIGIBLE)
})

/* ═══ 8/9 — TAŞIYICI SÖZLEŞMESİ ═════════════════════════════════════ */

test('CATCHUP-8: yakalama SURAT I CAGIRMAZ; create tek ve ayni yolda', async () => {
  const source = readFileSync(
    join(here, 'shipments', 'autoLabelCatchup.ts'), 'utf8',
  )
  // Yakalama taşıyıcıya ÇIKMAZ: kendi istemcisini kurmaz, SOAP bilmez.
  for (const forbidden of [
    'OrtakBarkodOlustur', 'services.asmx', 'createSuratSoapPrimaryShipment',
    'fetch(', 'REST', 'axios',
  ]) {
    assert.ok(!source.includes(forbidden), `yakalama icinde ${forbidden}`)
  }
  // Yalnız kuyruğa yazar.
  assert.match(source, /enqueueLabelJob/)

  // Gerçek create hâlâ TEK yerde ve TEK SOAP çağrısıyla.
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(server, /withSuratTracePersistence\(createSuratShipment\)/)
  const soap = readFileSync(
    join(here, 'shipments', 'suratLabelTransportRoute.ts'), 'utf8',
  )
  assert.match(soap, /OrtakBarkodOlustur/)
  assert.match(soap, /webservices\.suratkargo\.com\.tr\/services\.asmx/)
})

test('CATCHUP-9: SECOND_CREATE = NO — is ancak TEK KEZ talep edilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const catchup = await load('/server/shipments/autoLabelCatchup.ts')
  const worker = await load('/server/shipments/labelJobWorker.ts')
  const organizationId = await seedTenant(db)
  await catchup.enqueueCatchupJobs(db, PARAMS(organizationId))

  // Ağ geçildi, sonuç BELİRSİZ → iş bir daha TALEP EDİLMEZ.
  let attempts = 0
  const failing = async () => {
    attempts += 1
    throw new Error('baglanti koptu')
  }
  const first = await worker.runLabelJobCycle({
    db, workerId: 'w1', batchSize: 25, runLabel: failing,
  })
  assert.equal(first.unknownAfterNetwork, OPEN_ELIGIBLE)
  const second = await worker.runLabelJobCycle({
    db, workerId: 'w2', batchSize: 25, staleLockMs: 1, runLabel: failing,
  })
  assert.equal(second.claimed, 0)
  assert.equal(attempts, OPEN_ELIGIBLE)

  // Yakalama TEKRAR çalışsa bile bu paketler ADAY OLMAZ.
  const again = await catchup.enqueueCatchupJobs(db, PARAMS(organizationId))
  assert.equal(again.enqueued, 0)
  assert.equal(again.report.unknownAfterNetwork, OPEN_ELIGIBLE)
})

/* ═══ İŞLETİM GÜVENLİĞİ ═════════════════════════════════════════════ */

test('CATCHUP-10: yakalama ACILISA BAGLI DEGIL ve org ZORUNLU', async () => {
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Uygulama açılışı yakalamayı ASLA çağırmaz.
  assert.ok(!server.includes('enqueueCatchupJobs'))
  assert.ok(!server.includes('autoLabelCatchup'))

  const cli = readFileSync(
    join(here, 'shipments', 'autoLabelCatchupCli.ts'), 'utf8',
  )
  // Organizasyon açıkça verilmelidir; varsayılan yoktur.
  assert.match(cli, /Organizasyon ZORUNLU/)
  assert.match(cli, /--name/)
  // Varsayılan mod SALT-OKUNUR; yazım ancak --enqueue ile.
  assert.match(cli, /const mode = process\.argv\.includes\('--enqueue'\)/)
})

test('CATCHUP-11: politika sinir atlamasi YALNIZ yakalamaya ait', async () => {
  const policy = readFileSync(
    join(here, 'shipments', 'suratAutoLabelPolicy.ts'), 'utf8',
  )
  const producer = readFileSync(
    join(here, 'shipments', 'autoLabelProducer.ts'), 'utf8',
  )
  const catchupSource = readFileSync(
    join(here, 'shipments', 'autoLabelCatchup.ts'), 'utf8',
  )
  // Bayrak politikada TANIMLI ve KOŞULLU.
  assert.match(policy, /skipActivationBoundary/)
  // NORMAL uretici bayragi ASLA vermez.
  assert.ok(
    !producer.includes('skipActivationBoundary'),
    'normal uretici sinir atliyor!',
  )
  // Yalniz yakalama verir.
  assert.match(catchupSource, /skipActivationBoundary: true/)
})

test('CATCHUP-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})
