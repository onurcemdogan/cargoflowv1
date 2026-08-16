// ÖN-ELEME KIYASLAMASI — YALNIZ ÖLÇÜM.
//
// Üretim verisine DOKUNMAZ: her koşum atılabilir bir PGlite üzerinde kendi
// veri kümesini kurar. Taşıyıcı/pazaryeri çağrısı YOK.
//
// Kullanım:
//   node server/perf/projectionPrefilterBenchmark.mjs 1000 5000 10000
//
// Ölçülenler: süre, kanonike giren aday satır, çözülen yük, sorgu sayısı,
// sonuç sayısı ve PARİTE. Parite bozuksa sayı ne kadar iyi olursa olsun
// koşum BAŞARISIZ sayılır.
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { sql } from 'drizzle-orm'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', '..', 'drizzle')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('../db/schema.ts')
const legacyEngine = await import('../orders/orderFilterProjection.ts')
const query = await import('../orders/orderProjectionQuery.ts')
const backfill = await import('../orders/orderProjectionBackfill.ts')
const { encryptShipmentPayload } = await import('../shipments/shipmentEncryption.ts')

const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []
const CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya']
const DISTRICTS = ['Kadıköy', 'Çankaya', 'Bornova', 'Nilüfer', 'Konyaaltı']
const NAMES = ['Ömer', 'Ayşe', 'Mehmet', 'Zeynep', 'Can']

function now() {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}

async function seed(count) {
  const pglite = new PGlite()
  const db = drizzle(pglite, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  const org = String(rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug) values ('Perf','perf-${randomBytes(4).toString('hex')}')
     returning id`)))[0].id)

  // Şifreleme bir kez yapılır; ölçüm okuma yolunu hedefliyor.
  const payload = encryptShipmentPayload({
    ozelKargoTakipNo: 'OZEL-PERF',
    carrierTrackingNumber: '11419469827',
    barkodNo: 'BAR-PERF',
  })

  const CHUNK = 500
  for (let start = 0; start < count; start += CHUNK) {
    const end = Math.min(start + CHUNK, count)
    const orderValues = []
    const shipmentValues = []
    for (let i = start; i < end; i += 1) {
      const city = CITIES[i % CITIES.length]
      const district = DISTRICTS[i % DISTRICTS.length]
      const name = NAMES[i % NAMES.length]
      const day = String((i % 28) + 1).padStart(2, '0')
      orderValues.push(
        `('${org}','Trendyol','PKG-${i}','114${String(i).padStart(7, '0')}',` +
        `'EXT-${i}','Created','NEW','${name}','Soyad${i}',` +
        `'user${i}@ornek.com','0555${String(i).padStart(7, '0')}',` +
        `'${city}','${district}','727${String(i).padStart(7, '0')}',` +
        `'2026-01-${day}T09:00:00.000Z')`,
      )
      shipmentValues.push(
        `('${org}','Trendyol','PKG-${i}','surat','local_create','created',` +
        `'TRK-${i}','BAR-${i}','${payload}')`,
      )
    }
    await db.execute(sql.raw(
      `insert into orders (organization_id, marketplace, package_id, order_number,
         external_order_id, marketplace_status, operation_status,
         customer_first_name, customer_last_name, customer_email, customer_phone,
         shipping_city, shipping_district, cargo_tracking_number, order_date)
       values ${orderValues.join(',')}`))
    await db.execute(sql.raw(
      `insert into shipments (organization_id, marketplace, package_id, provider,
         source, status, tracking_number, barcode, carrier_payload_encrypted)
       values ${shipmentValues.join(',')}`))
  }
  return { pglite, db, org }
}

/** Ölçülen yollar — hepsi ön-elemeye UYGUN filtreler. */
const PATHS = [
  ['city p1/25', { city: 'İstanbul', page: 1, pageSize: 25 }],
  ['city p1/100', { city: 'İstanbul', page: 1, pageSize: 100 }],
  ['marketplace + city', { marketplace: 'Trendyol', city: 'Ankara', page: 1, pageSize: 25 }],
  ['customerQuery', { customerQuery: 'Soyad42', page: 1, pageSize: 25 }],
  ['orderNumberQuery', { orderNumberQuery: '7270000042', page: 1, pageSize: 25 }],
  ['cargoSlipQuery', { cargoSlipQuery: '7270000042', page: 1, pageSize: 25 }],
  ['district', { district: 'Kadıköy', page: 1, pageSize: 25 }],
]

async function measure(db, org, filters) {
  const legacyStart = now()
  const legacy = await legacyEngine.loadFilteredProjection(db, org, filters, null)
  const legacyMs = now() - legacyStart

  const projectionStart = now()
  const ids = await query.selectPrefilteredOrderIds(db, org, filters, null)
  const prefilter = ids ? query.buildCandidateIdCondition(ids) : null
  const projection = await legacyEngine.loadFilteredProjection(
    db, org, filters, null, null, prefilter,
  )
  const projectionMs = now() - projectionStart

  const legacyIds = legacy.orderIds
  const projectionIds = projection.orderIds
  const parity =
    legacyIds.length === projectionIds.length &&
    legacyIds.every((id, index) => projectionIds[index] === id)

  return {
    parity,
    resultCount: legacyIds.length,
    legacyMs: Math.round(legacyMs),
    projectionMs: Math.round(projectionMs),
    legacyCandidates: legacy.instrumentation.candidateRowsBeforeCanonical,
    projectionCandidates: projection.instrumentation.candidateRowsBeforeCanonical,
    legacyDecrypted: legacy.instrumentation.payloadRowsDecrypted,
    projectionDecrypted: projection.instrumentation.payloadRowsDecrypted,
    legacyQueries: legacy.instrumentation.queriesPerRequest,
    projectionQueries: projection.instrumentation.queriesPerRequest,
  }
}

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0)
const DATASETS = sizes.length > 0 ? sizes : [1000, 5000, 10000]

let allParity = true
for (const size of DATASETS) {
  const seedStart = now()
  const { pglite, db, org } = await seed(size)
  const seedMs = Math.round(now() - seedStart)

  const backfillStart = now()
  const summary = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 500,
  })
  const backfillMs = Math.round(now() - backfillStart)
  const heap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)

  console.info(`\n=== DATASET ${size} ===`)
  console.info(
    `seed=${seedMs}ms  backfill=${backfillMs}ms rows=${summary.written}` +
    ` batches=${summary.batches}  heapAfterMB=${heap}`,
  )
  console.info(
    'path'.padEnd(20) +
    'legacyMs'.padStart(10) + 'projMs'.padStart(9) +
    'legacyCand'.padStart(12) + 'projCand'.padStart(10) +
    'legacyDec'.padStart(11) + 'projDec'.padStart(9) +
    'rows'.padStart(7) + '  parity',
  )
  for (const [label, filters] of PATHS) {
    const m = await measure(db, org, filters)
    if (!m.parity) allParity = false
    console.info(
      label.padEnd(20) +
      String(m.legacyMs).padStart(10) + String(m.projectionMs).padStart(9) +
      String(m.legacyCandidates).padStart(12) + String(m.projectionCandidates).padStart(10) +
      String(m.legacyDecrypted).padStart(11) + String(m.projectionDecrypted).padStart(9) +
      String(m.resultCount).padStart(7) + '  ' + (m.parity ? 'OK' : 'FAIL'),
    )
  }
  await pglite.close()
}

console.info(`\nPARITY_ALL ${allParity ? 'OK' : 'FAIL'}`)
process.exitCode = allParity ? 0 : 1
