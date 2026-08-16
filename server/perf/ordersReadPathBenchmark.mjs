// ORDERS OKUMA YOLU BENCHMARK'I — YALNIZ ÖLÇÜM, ÜRETİM KODU DEĞİL.
//
// Hermetik PGlite üzerinde production-shaped sentetik veri üretir ve
// sayfalama/sekme/filtre yollarını ölçer. Gerçek production DB'ye
// DOKUNMAZ; hiçbir üretim modülü bu dosyayı import ETMEZ.
//
// Kullanım:  node server/perf/ordersReadPathBenchmark.mjs [1000 5000 10000]
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('../db/schema.ts')
const service = await import('../orders/orderPersistenceService.ts')
const tabProjection = await import('../orders/orderTabProjection.ts')
const filterProjection = await import('../orders/orderFilterProjection.ts')

const MARKETPLACE = 'Trendyol'
const PROVIDER = 'surat'
const MARKETPLACE_STATUSES = [
  'Created', 'Picking', 'Shipped', 'AtCollectionPoint',
  'Delivered', 'Cancelled', 'Returned',
]
const OPERATION_STATUSES = ['NEW', 'LABEL_READY', 'LABEL_PRINTED', 'ERROR']
const CITIES = ['Istanbul', 'Ankara', 'Izmir', 'Bursa', 'Antalya']
const DISTRICTS = ['Kadikoy', 'Cankaya', 'Konak', 'Nilufer', 'Muratpasa']

function migrationStatements() {
  const dir = join(root, 'drizzle')
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

/** Her SQL çağrısını sayar (N+1 tespiti için). */
function withQueryCounter(client) {
  const counter = { count: 0, reset() { counter.count = 0 } }
  const proxy = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'query' && typeof value === 'function') {
        return (...args) => {
          counter.count += 1
          return value.apply(target, args)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { client: proxy, counter }
}

async function seed(count) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const { client, counter } = withQueryCounter(pglite)
  const db = drizzle(client, { schema })
  const rawDb = drizzle(pglite, { schema })
  const { encryptShipmentPayload } = await import('../shipments/shipmentEncryption.ts')
  const { encryptOrderPayload } = await import('../orders/orderEncryption.ts')
  const addressCipher = encryptOrderPayload({
    fullAddress: 'Ornek Mah. Ornek Cad. No 1', city: 'Istanbul',
  })
  const orgRows = await rawDb.execute(sql.raw(
    `insert into organizations (name, slug) values ('Bench','bench-${randomBytes(4).toString('hex')}') returning id`))
  const organizationId = String((Array.isArray(orgRows) ? orgRows[0] : orgRows.rows[0]).id)
  const accountRows = await rawDb.execute(sql.raw(
    `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
     values ('${organizationId}','${MARKETPLACE}','277221',true) returning id`))
  const marketplaceAccountId = String(
    (Array.isArray(accountRows) ? accountRows[0] : accountRows.rows[0]).id)

  const orderValues = []; const lineValues = []
  const shipmentValues = []; const operationValues = []
  for (let seq = 0; seq < count; seq += 1) {
    const orderId = randomUUID()
    const packageId = `PKG${1_000_000 + seq}`
    // createdAt/orderDate dağılımı: ~1 yıla yayılır.
    const orderDate = new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + seq * 900_000).toISOString()
    const city = CITIES[seq % CITIES.length]
    const district = DISTRICTS[seq % DISTRICTS.length]
    const provider = seq % 3 === 0 ? 'Surat Kargo' : seq % 3 === 1 ? 'Aras' : ''
    orderValues.push(
      `('${orderId}','${organizationId}','${marketplaceAccountId}','${MARKETPLACE}',` +
      `'${packageId}','114${1_000_000 + seq}','${packageId}',` +
      `'${MARKETPLACE_STATUSES[seq % MARKETPLACE_STATUSES.length]}',` +
      `'${OPERATION_STATUSES[seq % OPERATION_STATUSES.length]}',` +
      `'Musteri${seq % 97}','Soyad${seq % 53}','musteri${seq % 97}@ornek.com',` +
      `'0555000${String(1000 + (seq % 30))}','${addressCipher}','${city}','${district}',` +
      `${provider ? `'${provider}'` : 'null'},` +
      `${seq % 4 === 0 ? `'72700${1000 + seq}'` : 'null'},'${orderDate}')`)
    const lineCount = seq % 5 === 0 ? 2 : 1
    const unique = seq >= count - 5
    const familyKey = unique ? `U${seq}` : String(seq % 40)
    for (let line = 0; line < lineCount; line += 1) {
      lineValues.push(
        `('${randomUUID()}','${organizationId}','${orderId}','L${seq}-${line}',` +
        `'P${familyKey}','SKU${familyKey}','869${familyKey}',` +
        `'Ornek Urun ${familyKey}',1,10.00,10.00)`)
    }
    if (seq % 3 === 0) {
      const carrierCipher = encryptShipmentPayload({
        labelStatus: 'READY', shipmentStatus: 'CREATED',
        dispatchRegistrationConfirmed: true,
        ozelKargoTakipNo: `7270000${seq}`, gonderiNo: `GND${seq}`, irsaliyeNo: `IRS${seq}`,
      })
      shipmentValues.push(
        `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
        `'${PROVIDER}','local_create','created','727000${seq}','BRK${seq}','${carrierCipher}')`)
      operationValues.push(
        `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
        `'${PROVIDER}','create','idem-${seq}','succeeded','${carrierCipher}')`)
    }
  }
  // Toplu insert: parametre tavanına takılmamak için parçalara böl.
  const chunk = (values, header) => {
    for (let i = 0; i < values.length; i += 500) {
      const slice = values.slice(i, i + 500)
      if (slice.length) rawDb.execute(sql.raw(`${header} values ${slice.join(',')}`))
    }
  }
  await (async () => {
    for (let i = 0; i < orderValues.length; i += 500) {
      await rawDb.execute(sql.raw(
        `insert into orders (id, organization_id, marketplace_account_id, marketplace,
         package_id, order_number, external_order_id, marketplace_status, operation_status,
         customer_first_name, customer_last_name, customer_email, customer_phone,
         shipping_address_encrypted, shipping_city, shipping_district,
         cargo_provider_name, cargo_tracking_number, order_date) values ${
          orderValues.slice(i, i + 500).join(',')}`))
    }
    for (let i = 0; i < lineValues.length; i += 500) {
      await rawDb.execute(sql.raw(
        `insert into order_lines (id, organization_id, order_id, external_line_id,
         product_id, merchant_sku, barcode, product_name, quantity, unit_price, line_total)
         values ${lineValues.slice(i, i + 500).join(',')}`))
    }
    for (let i = 0; i < shipmentValues.length; i += 500) {
      await rawDb.execute(sql.raw(
        `insert into shipments (id, organization_id, marketplace, package_id, provider,
         source, status, tracking_number, barcode, carrier_payload_encrypted)
         values ${shipmentValues.slice(i, i + 500).join(',')}`))
    }
    for (let i = 0; i < operationValues.length; i += 500) {
      await rawDb.execute(sql.raw(
        `insert into shipment_operations (id, organization_id, marketplace, package_id,
         provider, operation_type, idempotency_key, status, response_payload_encrypted)
         values ${operationValues.slice(i, i + 500).join(',')}`))
    }
  })()
  void chunk
  return { pglite, db, counter, organizationId, marketplaceAccountId }
}

/** Tek ölçüm: süre, sorgu sayısı, payload bayt, satır sayısı. */
async function measure(label, counter, run) {
  counter.reset()
  const started = process.hrtime.bigint()
  const result = await run()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const rows = Array.isArray(result?.orders)
    ? result.orders.length
    : Array.isArray(result?.orderIds) ? result.orderIds.length : 0
  const bytes = Buffer.byteLength(JSON.stringify(result ?? {}), 'utf8')
  return {
    label,
    ms: Number(ms.toFixed(1)),
    queries: counter.count,
    bytes,
    rows,
    total: result?.total ?? null,
  }
}

async function runDataset(count) {
  const ctx = await seed(count)
  const { db, counter, organizationId: org, marketplaceAccountId: acc } = ctx
  const rows = []
  const list = (filters) => service.listOrders(db, org, filters, acc)
  const tab = (filters) => tabProjection.listOrdersForTab(db, org, filters, acc, null)
  const proj = (filters) => filterProjection.loadFilteredProjection(db, org, filters, acc, null)

  rows.push(await measure('A newOrders tab p1/25', counter, () => tab({ tab: 'newOrders', page: 1, pageSize: 25 })))
  rows.push(await measure('B all p1/25', counter, () => list({ page: 1, pageSize: 25 })))
  rows.push(await measure('C all p10/25', counter, () => list({ page: 10, pageSize: 25 })))
  rows.push(await measure('D all p1/100', counter, () => list({ page: 1, pageSize: 100 })))
  rows.push(await measure('E tab switch labelStage', counter, () => tab({ tab: 'labelStage', page: 1, pageSize: 25 })))
  rows.push(await measure('F orderNumber search', counter, () => proj({ search: '1141000042' })))
  rows.push(await measure('G customer search', counter, () => proj({ search: 'Musteri42' })))
  rows.push(await measure('H product filter', counter, () => proj({ productQuery: 'Ornek Urun 7' })))
  rows.push(await measure('I city/district filter', counter, () => proj({ city: 'Istanbul', district: 'Kadikoy' })))
  rows.push(await measure('J date filter', counter, () => proj({ startDate: '2026-01-01', endDate: '2026-02-01' })))
  rows.push(await measure('K tabCounts', counter, () => tabProjection.loadTabProjection(db, org, {}, acc, null)))
  rows.push(await measure('L cargoSlip filter', counter, () => proj({ cargoSlipQuery: '72700' })))

  await ctx.pglite.close()
  return rows
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean)
const datasets = sizes.length ? sizes : [1000, 5000, 10000]
const all = {}
for (const size of datasets) {
  const started = Date.now()
  all[size] = await runDataset(size)
  console.log(`\n=== ${size} ORDERS  (seed+bench ${((Date.now() - started) / 1000).toFixed(1)}s) ===`)
  console.log('label                     ms      queries   bytes     rows   total')
  for (const r of all[size]) {
    console.log(
      `${r.label.padEnd(24)} ${String(r.ms).padStart(8)} ${String(r.queries).padStart(8)}` +
      ` ${String(r.bytes).padStart(9)} ${String(r.rows).padStart(6)} ${String(r.total ?? '-').padStart(7)}`)
  }
}

// Sorgu sayısı dataset büyüklüğüyle BÜYÜMEMELİ.
console.log('\n=== QUERY COUNT GROWTH (dataset büyüdükçe) ===')
const first = datasets[0]
for (let i = 0; i < all[first].length; i += 1) {
  const label = all[first][i].label
  const counts = datasets.map((s) => all[s][i].queries)
  const grew = counts.some((c) => c !== counts[0])
  console.log(`${label.padEnd(24)} ${counts.join(' -> ')}  ${grew ? 'BUYUDU' : 'SABIT'}`)
}
