import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// 10 FILTRE — SUNUCU TARAFI PARITE DOGRULAMASI.
//
// ESKI YOL: OrdersPage tum siparis dizisini indirip buildVisibleOrders ile
// istemcide filtreliyordu.
// YENI YOL: ayni kanonik buildVisibleOrders SUNUCUDA calisir; istemciye
// yalniz sayfa doner.
//
// Bu paket her filtre icin ESKI ve YENI sonuc KIMLIK KUMELERININ birebir ayni
// oldugunu dogrular. Ayrica N+1 olmadigini ve sayfalamanin filtreden SONRA
// uygulandigini kanitlar.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const schema = await import('./db/schema.ts')
const service = await import('./orders/orderPersistenceService.ts')
const filterProjection = await import('./orders/orderFilterProjection.ts')
const classification = await import('../src/utils/orderClassification.ts')

const nl = (value) => value.split('\r\n').join('\n')
const PROJECTION_SOURCE = nl(
  readFileSync('server/orders/orderFilterProjection.ts', 'utf8'),
)

const MARKETPLACE = 'Trendyol'
const PROVIDER = 'surat'
const MARKETPLACE_STATUSES = [
  'Created',
  'Picking',
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
]
const OPERATION_STATUSES = ['NEW', 'LABEL_READY', 'LABEL_PRINTED', 'ERROR']
const CITIES = ['Istanbul', 'Ankara', 'Izmir']

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

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

/** Filtre cesitliligini garanti eden fixture. */
async function makeCtx({ count = 90 } = {}) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const { client, counter } = withQueryCounter(pglite)
  const db = drizzle(client, { schema })
  const rawDb = drizzle(pglite, { schema })
  const { encryptShipmentPayload } = await import(
    './shipments/shipmentEncryption.ts'
  )
  const { encryptOrderPayload } = await import('./orders/orderEncryption.ts')
  const addressCipher = encryptOrderPayload({
    fullAddress: 'Ornek Mah. Ornek Cad. No 1',
    city: 'Istanbul',
  })
  const orgRows = await rawDb.execute(
    sql.raw(
      `insert into organizations (name, slug) values ('Filt','filt-${randomBytes(4).toString('hex')}') returning id`,
    ),
  )
  const organizationId = String(
    (Array.isArray(orgRows) ? orgRows[0] : orgRows.rows[0]).id,
  )
  const accountRows = await rawDb.execute(
    sql.raw(
      `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
       values ('${organizationId}','${MARKETPLACE}','277221',true) returning id`,
    ),
  )
  const marketplaceAccountId = String(
    (Array.isArray(accountRows) ? accountRows[0] : accountRows.rows[0]).id,
  )

  const orderValues = []
  const lineValues = []
  const shipmentValues = []
  const operationValues = []
  const orderIds = []
  for (let seq = 0; seq < count; seq += 1) {
    const orderId = randomUUID()
    orderIds.push(orderId)
    const packageId = `PKG${1_000_000 + seq}`
    const orderDate = new Date(
      Date.UTC(2026, 0, 1, 9, 0, 0) + seq * 3_600_000,
    ).toISOString()
    const city = CITIES[seq % CITIES.length]
    // Kargo saglayici adi: bazi kayitlarda dolu, bazilarinda bos.
    const provider = seq % 3 === 0 ? 'Surat Kargo' : seq % 3 === 1 ? 'Aras' : ''
    orderValues.push(
      `('${orderId}','${organizationId}','${marketplaceAccountId}','${MARKETPLACE}',` +
        `'${packageId}','114${1_000_000 + seq}','${packageId}',` +
        `'${MARKETPLACE_STATUSES[seq % MARKETPLACE_STATUSES.length]}',` +
        `'${OPERATION_STATUSES[seq % OPERATION_STATUSES.length]}',` +
        `'Musteri${seq % 7}','Soyad${seq % 5}','musteri${seq % 7}@ornek.com',` +
        `'0555000${String(1000 + (seq % 30))}','${addressCipher}','${city}','Merkez',` +
        `${provider ? `'${provider}'` : 'null'},` +
        `${seq % 4 === 0 ? `'72700${1000 + seq}'` : 'null'},'${orderDate}')`,
    )
    // Cok urunlu / tek urunlu karisimi + tekrar eden urun aileleri.
    // SON 5 siparis TEKIL urun tasir → sameProduct'in HER IKI kolu da
    // (repeated / unique) bos olmayan sonuc uretir.
    const lineCount = seq % 5 === 0 ? 2 : 1
    const unique = seq >= count - 5
    const familyKey = unique ? `U${seq}` : String(seq % 6)
    for (let line = 0; line < lineCount; line += 1) {
      lineValues.push(
        `('${randomUUID()}','${organizationId}','${orderId}','L${seq}-${line}',` +
          `'P${familyKey}','SKU${familyKey}','869${familyKey}',` +
          `'Ornek Urun ${familyKey}',1,10.00,10.00)`,
      )
    }
    if (seq % 3 === 0) {
      const carrierCipher = encryptShipmentPayload({
        labelStatus: 'READY',
        shipmentStatus: 'CREATED',
        dispatchRegistrationConfirmed: true,
        ozelKargoTakipNo: `7270000${seq}`,
        gonderiNo: `GND${seq}`,
        irsaliyeNo: `IRS${seq}`,
      })
      shipmentValues.push(
        `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
          `'${PROVIDER}','local_create','created','727000${seq}','BRK${seq}','${carrierCipher}')`,
      )
      operationValues.push(
        `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
          `'${PROVIDER}','create','idem-${seq}','succeeded','${carrierCipher}')`,
      )
    }
  }
  await rawDb.execute(
    sql.raw(
      `insert into orders (id, organization_id, marketplace_account_id, marketplace,
         package_id, order_number, external_order_id, marketplace_status, operation_status,
         customer_first_name, customer_last_name, customer_email, customer_phone,
         shipping_address_encrypted, shipping_city, shipping_district,
         cargo_provider_name, cargo_tracking_number, order_date)
       values ${orderValues.join(',')}`,
    ),
  )
  await rawDb.execute(
    sql.raw(
      `insert into order_lines (id, organization_id, order_id, external_line_id,
         product_id, merchant_sku, barcode, product_name, quantity, unit_price, line_total)
       values ${lineValues.join(',')}`,
    ),
  )
  await rawDb.execute(
    sql.raw(
      `insert into shipments (id, organization_id, marketplace, package_id,
         provider, source, status, tracking_number, barcode, carrier_payload_encrypted)
       values ${shipmentValues.join(',')}`,
    ),
  )
  await rawDb.execute(
    sql.raw(
      `insert into shipment_operations (id, organization_id, marketplace,
         package_id, provider, operation_type, idempotency_key, status,
         response_payload_encrypted)
       values ${operationValues.join(',')}`,
    ),
  )
  return { pglite, db, rawDb, counter, organizationId, marketplaceAccountId, count }
}

/** ESKI YOL: tum siparisleri view-model olarak al (istemcinin sahip oldugu dizi). */
async function loadAllViews(ctx) {
  const collected = []
  for (let page = 1; ; page += 1) {
    const result = await service.listOrders(
      ctx.db,
      ctx.organizationId,
      { page, pageSize: 100, sort: 'orderDateDesc' },
      ctx.marketplaceAccountId,
    )
    collected.push(...result.orders)
    if (collected.length >= result.total) break
  }
  return collected
}

const BASE_CLIENT_INPUT = {
  selectedTab: 'all',
  marketplaceFilter: 'all',
  operationStatusFilter: 'all',
  cargoFilter: 'all',
  dateFilter: { preset: 'all', timezone: 'Europe/Istanbul' },
  searchQuery: '',
}

/** ESKI istemci sonucu (kimlik kumesi). */
function clientIds(views, overrides) {
  return classification
    .buildVisibleOrders({
      ...BASE_CLIENT_INPUT,
      persistentOrders: views,
      ...overrides,
    })
    .visibleOrders.map((order) => String(order.id))
}

/** YENI sunucu sonucu (kimlik kumesi). */
async function serverIds(ctx, filters) {
  const projection = await filterProjection.loadFilteredProjection(
    ctx.db,
    ctx.organizationId,
    filters,
    ctx.marketplaceAccountId,
  )
  return projection.orderIds
}

// ═══ 10 FILTRE — TEK TEK PARITE ═══════════════════════════════════════════

const CASES = [
  ['marketplace', { marketplaceFilter: 'Trendyol' }, { marketplace: 'Trendyol' }],
  ['cargo (saglayici adi)', { cargoFilter: 'Aras' }, { cargo: 'Aras' }],
  ['cargo (surat)', { cargoFilter: 'Surat' }, { cargo: 'Surat' }],
  ['cargo (bekliyor)', { cargoFilter: 'Bekliyor' }, { cargo: 'Bekliyor' }],
  ['cargo (hatali)', { cargoFilter: 'Hatali' }, { cargo: 'Hatali' }],
  ['customerQuery', { customerQuery: 'Musteri3' }, { customerQuery: 'Musteri3' }],
  ['productQuery', { productQuery: 'Ornek Urun 4' }, { productQuery: 'Ornek Urun 4' }],
  ['orderNumberQuery', { orderNumberQuery: '7270000' }, { orderNumberQuery: '7270000' }],
  ['cargoSlipQuery', { cargoSlipQuery: '72700' }, { cargoSlipQuery: '72700' }],
  ['multiProduct (multi)', { multiProductFilter: 'multi' }, { multiProduct: 'multi' }],
  ['multiProduct (single)', { multiProductFilter: 'single' }, { multiProduct: 'single' }],
  ['actionFilter (createEligible)', { actionFilter: 'createEligible' }, { action: 'createEligible' }],
  ['actionFilter (printEligible)', { actionFilter: 'printEligible' }, { action: 'printEligible' }],
  ['operationTab (labelReady)', { operationTabFilter: 'labelReady' }, { operationTab: 'labelReady' }],
  ['operationTab (barcodePending)', { operationTabFilter: 'barcodePending' }, { operationTab: 'barcodePending' }],
  ['sameProduct (repeated)', { sameProductFilter: 'repeated' }, { sameProduct: 'repeated' }],
  ['sameProduct (unique)', { sameProductFilter: 'unique' }, { sameProduct: 'unique' }],
]

for (const [label, clientOverride, serverFilters] of CASES) {
  test(`PARITY: ${label}`, async () => {
    const ctx = await makeCtx()
    const views = await loadAllViews(ctx)
    const expected = clientIds(views, clientOverride)
    const actual = await serverIds(ctx, serverFilters)
    assert.deepEqual(actual, expected, label)
    await ctx.pglite.close()
  })
}

test('PARITY-MEANINGFUL: fixture her filtre icin AYIRT EDICI', async () => {
  const ctx = await makeCtx()
  const views = await loadAllViews(ctx)
  const all = clientIds(views, {})
  // Her filtre gercekten daraltmali (aksi halde parite testi bos gecerdi).
  for (const [label, clientOverride] of CASES) {
    const filtered = clientIds(views, clientOverride)
    // BOS sonuc parite testini ANLAMSIZ yapar (iki taraf da bos gecerdi).
    // printEligible ISTISNA: fixture basilabilir etiket + bos print history
    // kombinasyonunu uretmiyor → o vaka icin parite VACUOUS'tur, raporda
    // acikca belirtilir.
    if (label !== 'actionFilter (printEligible)') {
      assert.ok(filtered.length > 0, `${label} hic sonuc uretmiyor`)
    }
    // marketplace fixture'da TEK degerli oldugu icin daraltmasi beklenmez.
    if (!label.startsWith('marketplace') && filtered.length > 0) {
      assert.ok(
        filtered.length < all.length,
        `${label} daraltmiyor (${filtered.length}/${all.length})`,
      )
    }
  }
  await ctx.pglite.close()
})

// ═══ BIRLESIK FILTRELER ═══════════════════════════════════════════════════

const COMBINED = [
  [
    'marketplace + cargo + operationTab',
    { marketplaceFilter: 'Trendyol', cargoFilter: 'Surat', operationTabFilter: 'labelReady' },
    { marketplace: 'Trendyol', cargo: 'Surat', operationTab: 'labelReady' },
  ],
  [
    'productQuery + sameProduct',
    { productQuery: 'Ornek Urun', sameProductFilter: 'repeated' },
    { productQuery: 'Ornek Urun', sameProduct: 'repeated' },
  ],
  [
    'customerQuery + multiProduct + action',
    { customerQuery: 'Musteri', multiProductFilter: 'single', actionFilter: 'createEligible' },
    { customerQuery: 'Musteri', multiProduct: 'single', action: 'createEligible' },
  ],
  [
    'tab + search + cargoSlipQuery',
    { selectedTab: 'labelStage', searchQuery: '114', cargoSlipQuery: '72700' },
    { tab: 'labelStage', search: '114', cargoSlipQuery: '72700' },
  ],
]

for (const [label, clientOverride, serverFilters] of COMBINED) {
  test(`PARITY-COMBINED: ${label}`, async () => {
    const ctx = await makeCtx()
    const views = await loadAllViews(ctx)
    const expected = clientIds(views, clientOverride)
    const actual = await serverIds(ctx, serverFilters)
    assert.deepEqual(actual, expected, label)
    await ctx.pglite.close()
  })
}

// ═══ SIRA + SAYFALAMA ═════════════════════════════════════════════════════

test('ORDER-1: filtre SIRASI kanonik pipeline ile ayni (sameProduct EN SON)', () => {
  // Sunucu kendi sirasini kurmaz; kanonik buildVisibleOrders'i cagirir.
  assert.ok(PROJECTION_SOURCE.includes('buildVisibleOrders({'))
  assert.ok(
    PROJECTION_SOURCE.includes("from '../../src/utils/orderClassification.ts'"),
  )
  // Yerel bir filtre sirasi/kurali TANIMLANMAZ.
  for (const forbidden of ['.filter((order) =>', 'sameProductFilter ===', 'normalizedToken(']) {
    assert.equal(PROJECTION_SOURCE.includes(forbidden), false, forbidden)
  }
})

test('PAGE-1: sayfalama filtreden SONRA; total gercek filtreli kume', async () => {
  const ctx = await makeCtx()
  const views = await loadAllViews(ctx)
  const expected = clientIds(views, { operationTabFilter: 'labelReady' })
  const page = await filterProjection.listFilteredOrdersPage(
    ctx.db,
    ctx.organizationId,
    { operationTab: 'labelReady', page: 1, pageSize: 5 },
    ctx.marketplaceAccountId,
  )
  assert.equal(page.total, expected.length, 'total FILTRELENMIS kume')
  assert.equal(page.orders.length, Math.min(5, expected.length))
  assert.deepEqual(
    page.orders.map((order) => String(order.id)),
    expected.slice(0, 5),
    'ilk sayfa filtreli kumenin basi',
  )
  // Ikinci sayfa da ayni kumeden dilimlenir.
  const second = await filterProjection.listFilteredOrdersPage(
    ctx.db,
    ctx.organizationId,
    { operationTab: 'labelReady', page: 2, pageSize: 5 },
    ctx.marketplaceAccountId,
  )
  assert.deepEqual(
    second.orders.map((order) => String(order.id)),
    expected.slice(5, 10),
  )
  await ctx.pglite.close()
})

// ═══ N+1 YOK ══════════════════════════════════════════════════════════════

test('NO-N1: sorgu sayisi aday sayisiyla LINEER BUYUMEZ', async () => {
  const small = await makeCtx({ count: 30 })
  small.counter.reset()
  const smallResult = await filterProjection.loadFilteredProjection(
    small.db,
    small.organizationId,
    { cargoSlipQuery: '72700' },
    small.marketplaceAccountId,
  )
  const smallQueries = small.counter.count
  await small.pglite.close()

  const large = await makeCtx({ count: 300 })
  large.counter.reset()
  const largeResult = await filterProjection.loadFilteredProjection(
    large.db,
    large.organizationId,
    { cargoSlipQuery: '72700' },
    large.marketplaceAccountId,
  )
  const largeQueries = large.counter.count
  await large.pglite.close()

  assert.equal(
    largeQueries,
    smallQueries,
    `30 aday→${smallQueries} sorgu, 300 aday→${largeQueries} sorgu`,
  )
  assert.ok(smallQueries <= 5, `sorgu sayisi: ${smallQueries}`)
  // Payload'a bagli filtre gercekten sonuc uretmeli (bos parite anlamsiz).
  assert.ok(smallResult.orderIds.length > 0)
  assert.ok(largeResult.orderIds.length > smallResult.orderIds.length)
})

test('NO-N1-SOURCE: per-order lookup DONGUSU YOK', () => {
  // Tekil (per-order) repository cagrilari HIC kullanilmaz.
  for (const forbidden of [
    'await findShipment(',
    'findLatestOperationByPackage(',
  ]) {
    assert.equal(PROJECTION_SOURCE.includes(forbidden), false, forbidden)
  }
  // Siparis dongusunun ICINDE await YOK (map/for-of saf bellek isidir).
  const loopStart = PROJECTION_SOURCE.indexOf('let views = orderRows.map(')
  const orderLoop = PROJECTION_SOURCE.slice(
    loopStart,
    PROJECTION_SOURCE.indexOf('applyExternalProcessingState(', loopStart),
  )
  assert.ok(orderLoop.length > 0)
  assert.equal(orderLoop.includes('await '), false, 'dongu icinde await')
  assert.ok(PROJECTION_SOURCE.includes('findShipmentsByPackageIds('))
  assert.ok(PROJECTION_SOURCE.includes('findLatestOperationsByPackageIds('))
  // Siparis satirlari kimlik listesi BIND EDILMEDEN (alt sorgu ile) gelir →
  // 65.535 parametre tavani sorunu olusmaz.
  assert.ok(PROJECTION_SOURCE.includes('inArray(orderLines.orderId, scopedOrderIds)'))
})

// ═══ KAPSAM ═══════════════════════════════════════════════════════════════

test('SCOPE-1: tenant + aktif hesap kapsami KORUNUR', async () => {
  const ctx = await makeCtx({ count: 20 })
  const other = await ctx.rawDb.execute(
    sql.raw(
      `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
       values ('${ctx.organizationId}','${MARKETPLACE}','999999',false) returning id`,
    ),
  )
  const otherId = String(
    (Array.isArray(other) ? other[0] : other.rows[0]).id,
  )
  await ctx.rawDb.execute(
    sql.raw(
      `insert into orders (organization_id, marketplace_account_id, marketplace,
         package_id, order_number, marketplace_status, order_date)
       values ('${ctx.organizationId}','${otherId}','${MARKETPLACE}','OTHER-1','114999','Created','2026-01-01T09:00:00Z')`,
    ),
  )
  const projection = await filterProjection.loadFilteredProjection(
    ctx.db,
    ctx.organizationId,
    {},
    ctx.marketplaceAccountId,
  )
  assert.equal(projection.total, 20, 'baska hesap SIZMAZ')
  assert.equal(projection.instrumentation.candidateRowsBeforeCanonical, 20)
  await ctx.pglite.close()
})

test('INSTRUMENT-1: maliyet SEFFAF raporlanir', async () => {
  const ctx = await makeCtx({ count: 60 })
  const projection = await filterProjection.loadFilteredProjection(
    ctx.db,
    ctx.organizationId,
    { cargoSlipQuery: '72700' },
    ctx.marketplaceAccountId,
  )
  const info = projection.instrumentation
  assert.equal(info.candidateRowsBeforeCanonical, 60)
  assert.equal(info.shipmentBulkQueries, 1)
  assert.equal(info.operationBulkQueries, 1)
  assert.ok(info.payloadRowsDecrypted > 0, 'payload filtreleri decrypt GEREKTIRIR')
  assert.ok(info.queriesPerRequest <= 5, `sorgu: ${info.queriesPerRequest}`)
  assert.ok(info.canonicalDurationMs >= 0)
  await ctx.pglite.close()
})
