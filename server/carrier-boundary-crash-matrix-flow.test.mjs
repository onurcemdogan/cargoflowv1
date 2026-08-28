import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// ═══ TAŞIYICI SINIRI VE ÇÖKME MATRİSİ ═══════════════════════════════════
//
// GERİ ALINAMAZ KOMUT:
//   server/index.mjs → callSuratSoap → `await fetch(SURAT_SOAP_URL, ...)`
//
// ÖLÇÜLEN AÇIK: `carrier_create_called` YALNIZ create DÖNDÜKTEN sonra
// kalıcılaşıyordu. `fetch` ile sonucun yazımı arasında ölen bir süreç
// diskte "taşıyıcıya gidilmedi" bırakıyordu; bayat kurtarma bunu güvenli
// sayıp işi kuyruğa alıyor ve İKİNCİ GERÇEK GÖNDERİ üretebiliyordu.
//
// DÜZELTİLMİŞ SIRA:
//   rezervasyon → zarf → kimlik paritesi → [KANIT YAZ] → fetch → sonuç yaz
//
// İhtiyatlı yön DOĞRU yöndür: yanlışlıkla "belirsiz" demek insan
// incelemesiyle geri alınabilir; yanlışlıkla "gidilmedi" demek geri
// alınamaz ikinci gönderi üretir.
//
// Bu dosya VITE KULLANMAZ. GERÇEK TAŞIYICI ÇAĞRISI YOKTUR.

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

const PACKAGE = '4111289850'

async function seedOperation(db, organizationId, overrides = {}) {
  await db.insert(schema.shipmentOperations).values({
    organizationId, marketplace: 'Trendyol', packageId: PACKAGE,
    orderNumber: `ORD-${PACKAGE}`, provider: 'surat',
    operationType: 'OrtakBarkodOlustur',
    idempotencyKey: `idem-${PACKAGE}`,
    status: overrides.status ?? 'pending',
    createCallCount: overrides.createCallCount ?? 1,
    carrierCreateCalled: overrides.carrierCreateCalled ?? false,
  })
}

async function seedJob(db, organizationId, overrides = {}) {
  await db.insert(schema.labelJobs).values({
    organizationId, marketplace: 'Trendyol', carrier: 'surat',
    packageId: PACKAGE, jobType: 'LABEL_PREPARE',
    status: overrides.status ?? 'PREPARING',
    attemptCount: overrides.attemptCount ?? 1,
    lockedAt: overrides.lockedAt ?? new Date(Date.now() - 60 * 60 * 1000),
    lockedBy: 'dead@worker',
  })
}

async function makeOrg(db) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'TarzimTuba', slug: `tt-${randomBytes(4).toString('hex')}` })
    .returning()
  return org.id
}

/* ═══ BOUNDARY-1 — kaynak sırası ═════════════════════════════════════ */

test('BOUNDARY-1: KANIT YAZIMI geri alinamaz fetch ten ONCE gelir', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const marker = source.indexOf('await markCarrierBoundaryEntered()')
  const soapFetch = source.indexOf('await fetch(SURAT_SOAP_URL')
  assert.ok(marker > 0, 'sinir kaniti yazimi YOK')
  assert.ok(soapFetch > 0)

  // SOAP gonderiminden hemen onceki blokta kanit yazimi olmali.
  const window = source.slice(Math.max(0, soapFetch - 900), soapFetch)
  assert.match(window, /await markCarrierBoundaryEntered\(\)/)
  // Tel kancasi da BEKLENIR; beklenmezse fetch kanittan once gidebilir.
  assert.match(window, /await onWireReady\(body\)/)
})

test('BOUNDARY-1b: HER tasiyici create kenari kanit yazar', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  // SOAP birincil + REST sevk kaydi + REST create kenari.
  const marks = source.split('await markCarrierBoundaryEntered()').length - 1
  assert.ok(marks >= 3, `beklenen >=3 kenar, bulunan ${marks}`)
  // Salt-okunur izleme uclari kanit YAZMAZ (yanlis belirsizlik uretmesin).
  const trackAt = source.indexOf('async function trackShipmentRest')
  const trackBody = source.slice(trackAt, trackAt + 2500)
  assert.ok(!/markCarrierBoundaryEntered/.test(trackBody))
})

/* ═══ BOUNDARY-2 — sink davranışı ════════════════════════════════════ */

test('BOUNDARY-2: kanit BIR KEZ yazilir ve eszamanli akislar KARISMAZ', async () => {
  const sink = await import('./shipments/carrierBoundarySink.ts')
  const writes = []

  await sink.runWithCarrierBoundary(
    { entered: false, persistBoundaryEntered: async () => { writes.push('A') } },
    async () => {
      await sink.markCarrierBoundaryEntered()
      // Ayni denemede ikinci kenar: TEKRAR YAZMAZ.
      await sink.markCarrierBoundaryEntered()
      assert.equal(sink.carrierBoundaryEntered(), true)
    },
  )
  assert.deepEqual(writes, ['A'])

  // ESZAMANLILIK: iki create ayni anda; kanitlar KARISMAZ.
  const seen = []
  await Promise.all([
    sink.runWithCarrierBoundary(
      { entered: false, persistBoundaryEntered: async () => { seen.push('one') } },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        await sink.markCarrierBoundaryEntered()
      },
    ),
    sink.runWithCarrierBoundary(
      { entered: false, persistBoundaryEntered: async () => { seen.push('two') } },
      async () => { await sink.markCarrierBoundaryEntered() },
    ),
  ])
  assert.deepEqual(seen.sort(), ['one', 'two'])

  // Baglam YOKSA sessizce gecer (elle/tekil yollar bozulmaz).
  await sink.markCarrierBoundaryEntered()
  assert.equal(sink.carrierBoundaryEntered(), false)
})

test('BOUNDARY-3: kanit YAZILAMAZSA istek GONDERILMEZ', async () => {
  const sink = await import('./shipments/carrierBoundarySink.ts')
  let sent = false
  await assert.rejects(
    () => sink.runWithCarrierBoundary(
      {
        entered: false,
        persistBoundaryEntered: async () => { throw new Error('disk dolu') },
      },
      async () => {
        await sink.markCarrierBoundaryEntered()
        sent = true
      },
    ),
    /disk dolu/,
  )
  assert.equal(sent, false, 'kanit yazilamadigi halde istek GONDERILDI')
})

/* ═══ CRASH MATRISI ══════════════════════════════════════════════════ */

test('CRASH-05: rezervasyon var, sinir kaniti YOK → GUVENLI YENIDEN KULLANIM', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeOrg(db)
  await seedJob(db, organizationId)
  await seedOperation(db, organizationId, { carrierCreateCalled: false })

  const { classifyStalePreparing } = await import(
    './shipments/stalePreparingClassifier.ts'
  )
  const verdict = classifyStalePreparing({
    status: 'PREPARING', lockedAt: new Date(Date.now() - 3600_000),
    lockAgeMs: 3600_000, staleAfterMs: 600_000,
    carrierCreateCalled: false, createCallCount: 1,
    carrierArtifactExists: false, readyLabelExists: false,
    unknownAfterNetworkEvidence: false, preparationValid: true,
  })
  assert.equal(verdict.verdict, 'SAFE_STALE_PRE_NETWORK')
  assert.equal(verdict.targetStatus, 'QUEUED')
})

test('CRASH-06/07/08: sinir kaniti VAR → BELIRSIZ, ASLA otomatik tekrar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeOrg(db)
  await seedJob(db, organizationId)
  // Kanit AGA CIKMADAN once yazildi; sonuc hic yazilamadi (surec oldu).
  await seedOperation(db, organizationId, { carrierCreateCalled: true })

  const queue = await import('./shipments/labelJobQueue.ts')
  const released = await queue.releaseStaleLocks(db, { olderThanMs: 1_000 })
  assert.equal(released, 0, 'ag sinirina girilmis is kuyruga alindi')

  const rows = await db.select().from(schema.labelJobs)
  assert.equal(rows[0].status, 'UNKNOWN_AFTER_NETWORK')

  // Bayat kurtarma da ACIKCA istense bile ACMAZ.
  const recovery = await import('./shipments/staleJobRecovery.ts')
  const result = await recovery.recoverStaleJobs(db, {
    organizationId, packageIds: [PACKAGE],
  })
  assert.equal(result.recovered, 0)
})

test('CRASH-09/10: artefakt VAR ama is READY degil → CREATE YOK, uzlastir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await makeOrg(db)
  await seedJob(db, organizationId)
  await seedOperation(db, organizationId, { carrierCreateCalled: true })
  await db.insert(schema.shipments).values({
    organizationId, marketplace: 'Trendyol', packageId: PACKAGE,
    provider: 'surat', trackingNumber: '7281000009',
    source: 'local_create', status: 'created',
  })

  const { classifyStalePreparing } = await import(
    './shipments/stalePreparingClassifier.ts'
  )
  const verdict = classifyStalePreparing({
    status: 'PREPARING', lockedAt: new Date(Date.now() - 3600_000),
    lockAgeMs: 3600_000, staleAfterMs: 600_000,
    carrierCreateCalled: true, createCallCount: 1,
    carrierArtifactExists: true, readyLabelExists: false,
    unknownAfterNetworkEvidence: false, preparationValid: true,
  })
  // Artefakt UNCERTAIN'den ONCE gelir: ikinci create yerine UZLASTIRMA.
  assert.equal(verdict.verdict, 'ALREADY_READY')
  assert.equal(verdict.targetStatus, 'READY')
})

/* ═══ IDEMPOTENCY GUARDS ═════════════════════════════════════════════ */

test('IDEMPOTENCY-1: create_call_count TEK BASINA guvenli tekrari ENGELLEMEZ', async () => {
  const { classifyStalePreparing } = await import(
    './shipments/stalePreparingClassifier.ts'
  )
  // Sayac 5 ama tasiyici kaniti YOK → hala guvenli.
  const verdict = classifyStalePreparing({
    status: 'PREPARING', lockedAt: new Date(Date.now() - 3600_000),
    lockAgeMs: 3600_000, staleAfterMs: 600_000,
    carrierCreateCalled: false, createCallCount: 5,
    carrierArtifactExists: false, readyLabelExists: false,
    unknownAfterNetworkEvidence: false, preparationValid: true,
  })
  assert.equal(verdict.safeToRecover, true)
})

test('IDEMPOTENCY-2: kalici sinir kaniti sonuc nesnesini EZER', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Sonuc "gidilmedi" dese bile diskte kanit varsa satir SILINMEZ.
  assert.match(source, /const persistedBoundary = await readSuratCreateOperation\(/)
  assert.match(
    source,
    /didSuratCreateReachCarrier\(result\) \|\| persistedBoundary/,
  )
  // Istisna yolu da kalici kaniti korur.
  assert.match(source, /boundaryPersisted \? \{ carrierCreateCalled: true \} : \{\}/)
})

test('IDEMPOTENCY-3: UNKNOWN operasyon ASLA yeniden acilmaz', async () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const at = source.indexOf("['IN_PROGRESS', 'UNKNOWN'].includes(existing.status)")
  assert.ok(at > 0)
  const branch = source.slice(at, at + 700)
  assert.match(branch, /existing\.status === 'UNKNOWN' \|\| existing\.carrierCreateCalled === true/)
  assert.match(branch, /return buildSuratIdempotencyBlockedResponse/)
})

test('REG: bu dosya uretim cozucusuyle calisir ve suitede KAYITLI', async () => {
  const self = readFileSync(
    join(here, 'carrier-boundary-crash-matrix-flow.test.mjs'), 'utf8',
  )
  const importsVite = self
    .split(String.fromCharCode(10))
    .some((line) => /^\s*import\s/.test(line) && /vite/.test(line))
  assert.equal(importsVite, false)
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(list.includes('server/carrier-boundary-crash-matrix-flow.test.mjs'))
  assert.ok(and && eq)
})
