import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// GERÇEK DENEMENİN GÖRÜNÜRLÜĞÜ — üretim kusurunun tam yeniden üretimi.
//
// ═══ ÜRETİM KANITI ════════════════════════════════════════════════════════
//   orderNumber   11519247408
//   packageId     4088060589
//   marketplace   7270036062402465
//   correlationId 0f0aef58-91e6-4700-b08f-0ebb0166e6a1
//   HTTP 200 + System.InvalidCastException (String → KargoBarkod)
//   at OrtakBarkodController.OrtakBarkodOlusturSonuc line 1836
//
// ═══ ÖLÇÜLEN KÖK NEDEN ════════════════════════════════════════════════════
// Kanonik uç HTTP 200 döndürüp gövdede .NET istisnası veriyor. İstemci onu
// ayrıştırırken FIRLATIYOR. `traceAttempt` adaptörün YEREL değişkeniydi ve
// yığınla KAYBOLUYORDU; route'un `catch` dalı izsiz bir gövde döndürdüğü için
// hiçbir şey kaydedilmiyordu. Tablo üretimde VAR olmasına rağmen Canlı Debug
// "Henüz bir Sürat gönderi denemesi kaydedilmedi." diyordu.
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK.
assert.notEqual(process.env.REAL_CARRIER_CREATE, '1')
assert.notEqual(process.env.LIVE_CREATE, '1')

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const repo = await import('./shipments/suratTraceRepository.ts')
const trace = await import('./shipments/suratCreateTrace.ts')

const SOURCE = readFileSync(join(here, 'index.mjs'), 'utf8')
  .split('\r\n').join('\n')
const ADAPTER = readFileSync(
  join(here, 'shipments', 'suratCanonicalCreateAdapter.ts'), 'utf8',
)

const PROD = {
  orderNumber: '11519247408',
  packageId: '4088060589',
  marketplaceIdentity: '7270036062402465',
  correlationId: '0f0aef58-91e6-4700-b08f-0ebb0166e6a1',
  exception:
    "System.InvalidCastException: Unable to cast object of type 'System.String' "
    + "to type 'KargoBarkod' at SK_WebService.Api.Controllers."
    + 'OrtakBarkodController.OrtakBarkodOlusturSonuc(...) line 1836',
}

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function freshDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'vis', slug: `vis-${randomBytes(4).toString('hex')}` })
    .returning()
  return { db, organizationId: org.id }
}

/** Adaptörün gerçek yapı taşlarıyla, üretimdeki gibi bir başarısız deneme. */
function buildFailedAttempt() {
  const traceId = PROD.correlationId
  let attempt = trace.createTraceAttempt({
    traceId, createdAt: '2026-08-19T12:00:00.000Z',
  })
  attempt = trace.appendTraceStage(attempt, {
    stage: 'PRE_FLIGHT', section: 'ROUTING', at: '2026-08-19T12:00:00.100Z',
    data: { serviceMode: 'SURAT_CANONICAL_API' },
  })
  attempt = trace.appendTraceStage(attempt, {
    stage: 'REQUEST_READY', section: 'REQUEST', at: '2026-08-19T12:00:00.200Z',
    data: { ozelKargoTakipNo: PROD.marketplaceIdentity },
  })
  attempt = trace.appendTraceStage(attempt, {
    stage: 'FINAL', section: 'FINAL_RESULT', at: '2026-08-19T12:00:01.000Z',
    data: {
      outcome: 'SURAT_CANONICAL_RESULT_UNPARSEABLE',
      carrierCreateStatus: 'UNKNOWN',
      carrierCalled: true,
      carrierExceptionSummary: PROD.exception,
    },
  })
  return attempt
}

/* ═══ D1 — GERÇEK BAŞARISIZ DENEME KALICILAŞIR ══════════════════════ */

test('D1: gercek BASARISIZ deneme kalicilasir', async () => {
  const { db, organizationId } = await freshDb()
  const attempt = buildFailedAttempt()

  const written = await repo.persistTraceAttempt(db, organizationId, {
    traceId: attempt.traceId,
    createdAt: attempt.createdAt,
    stages: attempt.stages,
    summary: { carrierCreateStatus: 'UNKNOWN', httpStatus: 200 },
    orderNumber: PROD.orderNumber,
    packageId: PROD.packageId,
    marketplace: 'Trendyol',
    serviceMode: 'SURAT_CANONICAL_API',
    operation: 'OrtakBarkodOlustur',
    finalState: 'UNKNOWN',
  })
  assert.equal(written.persisted, true)

  const latest = await repo.readLatestTraceAttempt(db, organizationId)
  assert.ok(latest, 'BASARISIZ deneme kaydedilmedi')
  assert.equal(latest.traceId, PROD.correlationId)
  assert.equal(latest.orderNumber, PROD.orderNumber)
  assert.equal(latest.packageId, PROD.packageId)
  assert.equal(latest.finalState, 'UNKNOWN')
})

/* ═══ D2 — BAŞARI da kalıcılaşır ════════════════════════════════════ */

test('D2: BASARILI deneme de kalicilasir', async () => {
  const { db, organizationId } = await freshDb()
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'TR-SUCCESS-1',
    createdAt: '2026-08-19T13:00:00.000Z',
    stages: [{ stage: 'FINAL', section: 'FINAL_RESULT', at: 'x', data: {} }],
    orderNumber: '11415535074',
    finalState: 'BARCODE_SUCCESS',
  })
  const latest = await repo.readLatestTraceAttempt(db, organizationId)
  assert.equal(latest.finalState, 'BARCODE_SUCCESS')
})

/* ═══ D3 — RELOAD aynı izi döndürür ═════════════════════════════════ */

test('D3: yeniden okuma AYNI izi dondurur (reload)', async () => {
  const { db, organizationId } = await freshDb()
  const attempt = buildFailedAttempt()
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: attempt.traceId, createdAt: attempt.createdAt,
    stages: attempt.stages, orderNumber: PROD.orderNumber,
  })
  // "Sayfa yenilendi" = bagimsiz ikinci okuma.
  const first = await repo.listTraceAttempts(db, organizationId, 50)
  const second = await repo.listTraceAttempts(db, organizationId, 50)
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(second[0].traceId, PROD.correlationId)
  // Asamalar KORUNUR (append-only).
  assert.equal(second[0].stages.length, attempt.stages.length)
})

/* ═══ D4 — A/B izolasyonu ═══════════════════════════════════════════ */

test('D4: Trace A ile Trace B KARISMAZ', async () => {
  const { db, organizationId } = await freshDb()
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'TR-A', createdAt: '2026-08-19T10:00:00Z',
    stages: [], orderNumber: 'ORDER-A', finalState: 'A_STATE',
  })
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'TR-B', createdAt: '2026-08-19T11:00:00Z',
    stages: [], orderNumber: 'ORDER-B', finalState: 'B_STATE',
  })
  const all = await repo.listTraceAttempts(db, organizationId, 50)
  const a = all.find((t) => t.traceId === 'TR-A')
  const b = all.find((t) => t.traceId === 'TR-B')
  assert.equal(a.orderNumber, 'ORDER-A')
  assert.equal(a.finalState, 'A_STATE')
  assert.equal(b.orderNumber, 'ORDER-B')
  assert.equal(b.finalState, 'B_STATE')
  // "Son Deneme" TEK kayittir; alanlari karismaz.
  const latest = await repo.readLatestTraceAttempt(db, organizationId)
  assert.equal(latest.traceId, 'TR-B')
  assert.equal(latest.orderNumber, 'ORDER-B')
})

/* ═══ KÖK NEDEN BAĞLAMASI — kod düzeyinde ═══════════════════════════ */

test('VIS-1: taşıyıcı FIRLATSA BİLE iz kaybolmaz', () => {
  // Adaptor, tasiyici cagrisini yakalar ve izi SONUC olarak dondurur.
  assert.match(ADAPTER, /catch \(carrierError\) \{/)
  assert.match(ADAPTER, /SURAT_CANONICAL_RESULT_UNPARSEABLE/)
  // Firlatma dalinda da traceAttempt DONER.
  const at = ADAPTER.indexOf('catch (carrierError)')
  const region = ADAPTER.slice(at, at + 2200)
  assert.match(region, /traceAttempt: appendTraceStage\(/)
  assert.match(region, /carrierExceptionSummary/)
})

test('VIS-2: tasiyiciya GIDILDIYSE durum NOT_STARTED denmez', () => {
  const at = ADAPTER.indexOf('catch (carrierError)')
  const region = ADAPTER.slice(at, at + 2200)
  // Gonderinin olusup olusmadigi BILINMIYOR → UNKNOWN.
  assert.match(region, /carrierCreateStatus: 'UNKNOWN'/)
  assert.match(region, /carrierCalled: true/)
  assert.equal(
    /carrierCreateStatus: 'NOT_STARTED'/.test(region), false,
    'tasiyiciya gidildigi halde NOT_STARTED deniyor — ikinci create riski',
  )
})

test('VIS-3: TUM create cikis yollari yanit sinirinda iz yazar', () => {
  // Onceki kusur: iz YALNIZ kanonik BASARI dalinda yaziliyordu.
  assert.match(SOURCE, /const withSuratTracePersistence = \(handler\) =>/)
  assert.match(
    SOURCE,
    /app\.post\('\/api\/shipments\/surat', withSuratTracePersistence\(createSuratShipment\)\)/,
  )
  assert.match(SOURCE, /withSuratTracePersistence\(createSuratShipment\),/)
  // Yazma AWAITED: yanit gonderildikten sonra iz kaybolmaz.
  const at = SOURCE.indexOf('const withSuratTracePersistence')
  const region = SOURCE.slice(at, at + 900)
  assert.match(region, /if \(pending\) await pending/)
  assert.match(region, /response\.json = originalJson/)
})

test('VIS-4: iz yazimi create yanitini BOZMAZ', () => {
  const at = SOURCE.indexOf('async function persistSuratTraceAttempt(')
  const body = SOURCE.slice(at, SOURCE.indexOf('\n}', at))
  assert.match(body, /try \{/)
  assert.match(body, /\} catch \{/)
})

/* ═══ R1..R5 — OKUMA YOLU (üretim kusuru: DBde 2 iz, arayüz "kayıt yok") ═══ */

test('R1: REJECTED iz de API tarafindan DONDURULUR', async () => {
  const { db, organizationId } = await freshDb()
  // Uretimdeki iki gercek iz: IKISI DE REJECTED.
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'CF-4088060589', createdAt: '2026-08-19T08:23:21.737Z',
    stages: [], orderNumber: '11519247408', packageId: '4088060589',
    serviceMode: 'SURAT_CANONICAL_API', operation: 'OrtakBarkodOlustur',
    finalState: 'REJECTED',
  })
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'CF-4088105329', createdAt: '2026-08-19T09:05:37.912Z',
    stages: [], orderNumber: '11519297641', packageId: '4088105329',
    serviceMode: 'SURAT_CANONICAL_API', operation: 'OrtakBarkodOlustur',
    finalState: 'REJECTED',
  })
  const rows = await repo.listTraceAttempts(db, organizationId, 50)
  assert.equal(rows.length, 2, 'REJECTED izler SUZULDU')
  for (const row of rows) assert.equal(row.finalState, 'REJECTED')
})

test('R2: EN YENI REJECTED iz "Son Deneme" olur', async () => {
  const { db, organizationId } = await freshDb()
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'CF-4088060589', createdAt: '2026-08-19T08:23:21.737Z',
    stages: [], finalState: 'REJECTED', orderNumber: '11519247408',
  })
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'CF-4088105329', createdAt: '2026-08-19T09:05:37.912Z',
    stages: [], finalState: 'REJECTED', orderNumber: '11519297641',
  })
  const latest = await repo.readLatestTraceAttempt(db, organizationId)
  // BASARI filtresi YOK: basarisiz deneme de Son Deneme olabilir.
  assert.equal(latest.traceId, 'CF-4088105329')
  assert.equal(latest.finalState, 'REJECTED')
  assert.equal(latest.orderNumber, '11519297641')
})

test('R3: KIRACI izolasyonu — B kiracisi A izlerini GORMEZ', async () => {
  const { db, organizationId } = await freshDb()
  const [other] = await db.insert(schema.organizations)
    .values({ name: 'b', slug: `b-${randomBytes(4).toString('hex')}` })
    .returning()
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'CF-A', createdAt: '2026-08-19T09:00:00Z', stages: [],
  })
  assert.equal((await repo.listTraceAttempts(db, other.id)).length, 0)
  assert.equal(await repo.readLatestTraceAttempt(db, other.id), null)
})

test('R4: yeniden okuma AYNI izi dondurur', async () => {
  const { db, organizationId } = await freshDb()
  await repo.persistTraceAttempt(db, organizationId, {
    traceId: 'CF-4088105329', createdAt: '2026-08-19T09:05:37.912Z', stages: [],
  })
  const a = await repo.readLatestTraceAttempt(db, organizationId)
  const b = await repo.readLatestTraceAttempt(db, organizationId)
  assert.equal(a.traceId, b.traceId)
})

/* ═══ KÖK NEDEN — İKİ AYRI SIRA/KAPI KUSURU ═════════════════════════ */

test('R-API-1: debug ucu /api 404 CATCH-ALLDAN ONCE kayitli', () => {
  // OLCULEN KUSUR: uc, bilinmeyen /api/* isteklerini yutan 404 catch-all'dan
  // SONRA kayit edilmisti. Express kayit SIRASINA gore eslestirir, dolayisiyla
  // istek uca HIC ULASMIYOR ve 404 donuyordu — DBde iki iz varken.
  const getAt = SOURCE.indexOf("app.get('/api/debug/surat-traces'")
  const deleteAt = SOURCE.indexOf("app.delete('/api/debug/surat-traces'")
  const catchAllAt = SOURCE.indexOf("app.use('/api', (_request, response) => {")
  assert.ok(getAt > 0 && deleteAt > 0 && catchAllAt > 0, 'rotalar/catch-all yok')
  assert.ok(getAt < catchAllAt, 'GET ucu catch-alldan SONRA kayitli')
  assert.ok(deleteAt < catchAllAt, 'DELETE ucu catch-alldan SONRA kayitli')
})

test('R-API-2: /api/debug tenantAuth kapisinda', () => {
  // Ayni kok neden ikinci kez: yol TENANT_AUTH_PATHS icinde olmazsa
  // `tenantAuth` calismaz, `request.auth` bos kalir ve guard 404 doner.
  const at = SOURCE.indexOf('const TENANT_AUTH_PATHS = [')
  const end = SOURCE.indexOf(']', at)
  const list = SOURCE.slice(at, end)
  assert.match(list, /'\/api\/debug'/, '/api/debug auth kapisinda DEGIL')
})

/* ═══ B1 — DENETÇİ: alan/TİP raporu ve SIR/PII maskesi ══════════════ */

test('B1: denetci TIP raporlar ve SIR/PII basmaz', async () => {
  const cli = await import('./shipments/suratTraceInspectCli.ts')
  // Tip ayrimi sozlesme karsilastirmasinin cekirdegi.
  assert.equal(cli.runtimeType(undefined), 'absent')
  assert.equal(cli.runtimeType(null), 'null')
  assert.equal(cli.runtimeType({}), 'object')
  assert.equal(cli.runtimeType([]), 'array')
  assert.equal(cli.runtimeType('x'), 'string')
  assert.equal(cli.runtimeType(1), 'number')
  assert.equal(cli.runtimeType(true), 'boolean')

  // Kimlik DEGERI asla basilmaz.
  const secret = cli.describeField('Sifre', 'p@ssw0rd')
  assert.equal(secret.includes('p@ssw0rd'), false, 'parola sizdi')
  assert.match(secret, /PRESENT \(masked\)/)
  assert.match(cli.describeField('KullaniciAdi', 'user1'), /masked/)
  // PII maskelenir.
  assert.match(cli.describeField('AliciAdresi', 'Bir adres'), /pii-masked/)
  // Is alanlari TIP + DEGER ile gorunur.
  assert.match(cli.describeField('Pazaryerimi', 1), /number · 1/)
  assert.match(cli.describeField('OdemeTipi', 1), /number · 1/)
  assert.equal(cli.describeField('WhoPays', undefined), 'absent · ABSENT')
})

test('B1b: denetlenen tel alanlari gorev listesini KAPSAR', async () => {
  const cli = await import('./shipments/suratTraceInspectCli.ts')
  for (const field of [
    'KullaniciAdi', 'Sifre', 'Gonderi', 'Pazaryerimi', 'EntegrasyonFirmasi',
    'OdemeTipi', 'ReferansNo', 'OzelKargoTakipNo',
    'KapidanOdemeTahsilatTipi', 'KapidanOdemeTutari',
    'WhoPays', 'KimOder', 'FirmaId', 'Iademi',
  ]) {
    assert.ok(
      cli.AUDITED_WIRE_FIELDS.includes(field),
      `denetlenen alan listesinde YOK: ${field}`,
    )
  }
})

test('B1c: denetci SALT OKUNUR — yazma/create cagrisi YOK', () => {
  const cli = readFileSync(
    join(here, 'shipments', 'suratTraceInspectCli.ts'), 'utf8',
  )
  for (const forbidden of ['insert(', 'update(', 'delete(', 'fetch(']) {
    assert.equal(
      cli.includes(forbidden), false,
      `denetci mutasyon/ag cagrisi iceriyor: ${forbidden}`,
    )
  }
  // Sayaclar DENETCININ kendi yan etkisidir, DENEMENIN ozelligi degil:
  // etiketsiz `NETWORK_CALLS 0` ayni izde `carrierCalled=true` dururken
  // "tasiyiciya gidilmedi" gibi okunuyordu.
  assert.match(
    cli,
    /INSPECTOR_NETWORK_CALLS=0 · INSPECTOR_DB_WRITES=0 · INSPECTOR_CREATE_CALLS=0/,
  )
})

/* ═══ B3/B4 — KİMLİK ALANLARI KARIŞMAZ ═════════════════════════════ */

test('B3/B4: ReferansNo ile OzelKargoTakipNo ayri kaynaklardir', () => {
  const model = readFileSync(
    join(here, 'shipments', 'suratCanonicalGonderiModel.ts'), 'utf8',
  )
  // OzelKargoTakipNo YALNIZ saglayici kargo numarasindan; fallback YASAK.
  assert.match(model, /fallback YOKTUR/)
  // ReferansNo BAGIMSIZ opsiyonel alan olarak atanir.
  assert.match(model, /assignOptional\(model, 'ReferansNo', str\(input\.referansNo\)\)/)
  // Model, OzelKargoTakipNo'yu ReferansNo'dan TUREMEZ.
  assert.equal(
    /ozelKargoTakipNo[^\n]*referansNo/i.test(model), false,
    'OzelKargoTakipNo ReferansNodan turetiliyor',
  )
})

/* ═══ B10/B11 — OTOMATİK FALLBACK YOK ══════════════════════════════ */

test('B10/B11: kanonik hatadan SONRA otomatik SOAP create YOK', () => {
  const CAST = readFileSync(
    join(here, 'shipments', 'suratCanonicalCastRecovery.ts'), 'utf8',
  )
  assert.match(CAST, /LEGACY_FALLBACK_DEFAULT_ENABLED = false/)
  // Kanonik dalda hata sonrasi ikinci bir create cagrisi OLMAMALI.
  // BOLGE YALNIZ KANONIK DALDIR. Sonraki `if (config.serviceMode === ...)`
  // ayri bir servis modudur ve SOAP cagirmasi MESRUDUR; onu bu bolgeye almak
  // testi yanlis yere baglar.
  const canonicalAt = SOURCE.indexOf('if (config.serviceMode === SURAT_CANONICAL_SERVICE_MODE)')
  const nextBranchAt = SOURCE.indexOf(
    "if (config.serviceMode === 'KARGO_BARKODU_SIPARIS_SOAP')", canonicalAt,
  )
  assert.ok(nextBranchAt > canonicalAt, 'kanonik dal sinirlanamadi')
  const region = SOURCE.slice(canonicalAt, nextBranchAt)
  for (const soap of [
    'createSuratCommonBarcodeSoap', 'createSuratRegisteredCommonBarcode',
    'createSuratBarcodeOrderSoap',
  ]) {
    assert.equal(
      region.includes(soap), false,
      `kanonik dal hata sonrasi SOAP create cagiriyor: ${soap}`,
    )
  }
})
