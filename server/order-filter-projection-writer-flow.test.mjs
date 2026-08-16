import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// B2-1b-B1 — PARÇA SAHİPLİKLİ PROJEKSİYON YAZICISI (GERÇEK DB).
//
// En kritik değişmez: her yaşam döngüsü YALNIZ kendi kolonlarını yazar.
// Eşzamanlı order/shipment/operation yazımı birbirinin parçasını EZEMEZ.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const schema = await import('./db/schema.ts')
const repo = await import('./orders/orderFilterProjectionRepository.ts')

const nl = (v) => v.split('\r\n').join('\n')
const REPO_SOURCE = nl(
  readFileSync('server/orders/orderFilterProjectionRepository.ts', 'utf8'),
)

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, f), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function makeDb() {
  const pglite = new PGlite()
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db, slug) {
  const rows = await db.execute(
    sql.raw(`insert into organizations (name, slug)
             values ('Org','${slug}-${randomBytes(4).toString('hex')}') returning id`),
  )
  return String((Array.isArray(rows) ? rows[0] : rows.rows[0]).id)
}

async function makeOrder(db, organizationId, overrides = {}) {
  const id = randomUUID()
  const o = {
    packageId: 'PKG1', orderNumber: '1141000042', externalOrderId: 'EXT-42',
    marketplaceStatus: 'Created', operationStatus: 'NEW',
    city: 'İstanbul', district: 'Kadıköy', cargoTrackingNumber: '727001042',
    first: 'Ömer', last: 'Şahin', email: 'omer@ornek.com', phone: '05550001000',
    ...overrides,
  }
  await db.execute(sql.raw(
    `insert into orders (id, organization_id, marketplace, package_id, order_number,
       external_order_id, marketplace_status, operation_status,
       customer_first_name, customer_last_name, customer_email, customer_phone,
       shipping_city, shipping_district, cargo_tracking_number, order_date)
     values ('${id}','${organizationId}','Trendyol','${o.packageId}','${o.orderNumber}',
       '${o.externalOrderId}','${o.marketplaceStatus}','${o.operationStatus}',
       '${o.first}','${o.last}','${o.email}','${o.phone}',
       '${o.city}','${o.district}','${o.cargoTrackingNumber}','2026-01-01T09:00:00.000Z')`))
  return id
}

async function readProjection(db, organizationId, orderId) {
  const rows = await db.execute(sql.raw(
    `select * from order_filter_projection
     where organization_id='${organizationId}' and order_id='${orderId}'`))
  const list = (Array.isArray(rows) ? rows : rows.rows) ?? []
  return list[0] ?? null
}

// ═══ 1. ORDER PARÇASI ═════════════════════════════════════════════════════

test('WRT-1: order parcasi kanonik token uretir (decrypt YOK)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wrt1')
  const orderId = await makeOrder(db, org)

  const result = await repo.refreshOrderProjectionFragment(db, org, [orderId])
  assert.equal(result.refreshed, 1)
  const row = await readProjection(db, org, orderId)
  assert.equal(row.shipping_city_token, 'istanbul')
  // NOKTASIZ ı (U+0131) NFD ile AYRIŞMAZ ve [^a-z0-9] tarafından SİLİNİR.
  // "Kadıköy" → "kadkoy". Bu MEVCUT üretim davranışıdır; projeksiyon onu
  // birebir yeniden üretir (parite amacı budur, "düzeltmek" değil).
  assert.equal(row.shipping_district_token, 'kadkoy')
  assert.equal(row.marketplace_token, 'trendyol')
  assert.equal(row.operation_status_token, 'new')
  assert.equal(row.marketplace_status, 'Created')
  assert.ok(String(row.customer_search_token).includes('omer'))
  assert.ok(String(row.order_number_order_token).includes('1141000042'))
  assert.equal(Number(row.projection_version), 1)
  // Shipment/operation parcalari ORDER yazimiyla DOLDURULMAZ.
  assert.equal(row.order_number_shipment_token, null)
  assert.equal(row.cargo_slip_shipment_token, null)
  assert.equal(row.cargo_slip_operation_token, null)
})

// ═══ 2. LOST UPDATE — TASARIMIN ANA İSPATI ════════════════════════════════

test('WRT-2: ucu parca birbirini EZMEZ (lost update yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wrt2')
  const orderId = await makeOrder(db, org)

  // T0: uc parca da yazili.
  await repo.refreshOrderProjectionFragment(db, org, [orderId])
  await repo.updateShipmentProjectionFragment(db, org, orderId, {
    ozelKargoTakipNo: '727AAA', cargoSlipShipmentValues: ['GND-B'],
  })
  await repo.updateOperationProjectionFragment(db, org, orderId, {
    cargoSlipOperationValues: ['TNO-C'],
  })
  const t0 = await readProjection(db, org, orderId)
  assert.ok(String(t0.order_number_order_token).includes('1141000042'))
  assert.ok(String(t0.order_number_shipment_token).includes('727aaa'))
  assert.ok(String(t0.cargo_slip_operation_token).includes('tno-c'))

  // A2 / B2 / C2 — araya girmis sirayla.
  await db.execute(sql.raw(
    `update orders set order_number='1149999999' where id='${orderId}'`))
  await repo.refreshOrderProjectionFragment(db, org, [orderId])
  await repo.updateShipmentProjectionFragment(db, org, orderId, {
    ozelKargoTakipNo: '727BBB', cargoSlipShipmentValues: ['GND-B2'],
  })
  await repo.updateOperationProjectionFragment(db, org, orderId, {
    cargoSlipOperationValues: ['TNO-C2'],
  })

  const final = await readProjection(db, org, orderId)
  // A2 + B2 + C2 — hicbiri eski degere donmedi.
  assert.ok(String(final.order_number_order_token).includes('1149999999'), 'A2')
  assert.ok(String(final.order_number_shipment_token).includes('727bbb'), 'B2')
  assert.ok(String(final.cargo_slip_shipment_token).includes('gnd-b2'), 'B2 slip')
  assert.ok(String(final.cargo_slip_operation_token).includes('tno-c2'), 'C2')
})

test('WRT-3: shipment yazimi ORDER parcasini KORUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wrt3')
  const orderId = await makeOrder(db, org)
  await repo.refreshOrderProjectionFragment(db, org, [orderId])
  const before = await readProjection(db, org, orderId)

  await repo.updateShipmentProjectionFragment(db, org, orderId, {
    ozelKargoTakipNo: '727XYZ',
  })
  const after = await readProjection(db, org, orderId)
  assert.equal(after.order_number_order_token, before.order_number_order_token)
  assert.equal(after.customer_search_token, before.customer_search_token)
  assert.equal(after.shipping_city_token, before.shipping_city_token)
})

// ═══ 4. IDEMPOTENCY ═══════════════════════════════════════════════════════

test('WRT-4: tekrarli yazim IDEMPOTENT', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wrt4')
  const orderId = await makeOrder(db, org)
  await repo.refreshOrderProjectionFragment(db, org, [orderId])
  const first = await readProjection(db, org, orderId)
  await repo.refreshOrderProjectionFragment(db, org, [orderId])
  await repo.refreshOrderProjectionFragment(db, org, [orderId])
  const third = await readProjection(db, org, orderId)
  for (const key of [
    'marketplace_token', 'operation_status_token', 'shipping_city_token',
    'customer_search_token', 'order_number_order_token', 'cargo_slip_order_token',
  ]) assert.equal(third[key], first[key], key)
  // Tek satir kalir (1:1).
  const rows = await db.execute(sql.raw(
    `select count(*)::int as c from order_filter_projection where order_id='${orderId}'`))
  const list = (Array.isArray(rows) ? rows : rows.rows) ?? []
  assert.equal(Number(list[0].c), 1)
})

// ═══ 5. TENANT İZOLASYONU ═════════════════════════════════════════════════

test('WRT-5: capraz tenant yazimi ENGELLENIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'wrt5a')
  const orgB = await makeOrg(db, 'wrt5b')
  const orderA = await makeOrder(db, orgA)
  await repo.refreshOrderProjectionFragment(db, orgA, [orderA])

  // B kapsamiyla A'nin siparisini yenilemeye calis → hicbir satir bulunmaz.
  const result = await repo.refreshOrderProjectionFragment(db, orgB, [orderA])
  assert.equal(result.refreshed, 0)
  const rows = await db.execute(sql.raw(
    `select organization_id from order_filter_projection where order_id='${orderA}'`))
  const list = (Array.isArray(rows) ? rows : rows.rows) ?? []
  assert.equal(list.length, 1)
  assert.equal(String(list[0].organization_id), orgA)
})

// ═══ 6. YAPISAL: DECRYPT / AĞ YOK ═════════════════════════════════════════

test('WRT-6: yazici decrypt/ag YAPMAZ', () => {
  const code = REPO_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of [
    'decrypt', 'fetch(', 'process.env', 'carrierPayload', 'responsePayload',
    'shipmentEncryption', 'orderEncryption',
  ]) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
})

test('WRT-7: her yazici YALNIZ kendi kolonlarini SET eder', () => {
  const orderSet = REPO_SOURCE.slice(
    REPO_SOURCE.indexOf('refreshOrderProjectionFragment'),
    REPO_SOURCE.indexOf('updateShipmentProjectionFragment'),
  )
  // ORDER yazici shipment/operation kolonlarina DOKUNMAZ.
  for (const col of [
    'order_number_shipment_token', 'cargo_slip_shipment_token',
    'cargo_slip_operation_token',
  ]) assert.equal(orderSet.includes(col), false, `order→${col}`)

  const shipSet = REPO_SOURCE.slice(
    REPO_SOURCE.indexOf('updateShipmentProjectionFragment'),
    REPO_SOURCE.indexOf('updateOperationProjectionFragment'),
  )
  for (const col of [
    'marketplace_token', 'customer_search_token', 'order_number_order_token',
    'cargo_slip_operation_token',
  ]) assert.equal(shipSet.includes(col), false, `shipment→${col}`)
})

// ═══ 8. SIR DIŞLAMA ═══════════════════════════════════════════════════════

test('WRT-8: projeksiyon kolonlarinda SIR YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wrt8')
  const orderId = await makeOrder(db, org)
  await repo.refreshOrderProjectionFragment(db, org, [orderId])
  const row = await readProjection(db, org, orderId)
  const keys = Object.keys(row).join(' ').toLowerCase()
  for (const secret of [
    'password', 'sifre', 'secret', 'apikey', 'webpassword', 'credential',
    'payload', 'encrypted',
  ]) assert.equal(keys.includes(secret), false, secret)
})
