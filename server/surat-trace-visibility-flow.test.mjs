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
