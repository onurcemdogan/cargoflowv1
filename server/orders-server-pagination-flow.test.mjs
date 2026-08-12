import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// SUNUCU TARAFI SIPARIS SAYFALAMA + SEKME SAYACLARI + N+1 KALDIRMA.
//
// OLCULEN URETIM DARBOGAZI:
//   listOrders sipariş BASINA 2 ek sorgu calistiriyordu (findShipment +
//   findLatestOperationByPackage). 25 satirlik sayfa 37, 100'luk sayfa 148
//   sorgu. Uretimde shipments tablosunda ~589 satir olmasina ragmen
//   shipments_org_package_idx tarama sayaci ~994.000'e cikmisti.
//
// SEMANTIK GARANTISI: sunucu sekme siniflandirmasi icin IKINCI bir kural
// seti YAZILMADI; frontend'in kullandigi kanonik classifyOrderForTabs /
// orderMatchesQuickTab AYNEN import edilir. Bu paket ikisinin AYNI fixture
// uzerinde AYNI sonucu verdigini dogrular.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const schema = await import('./db/schema.ts')
const service = await import('./orders/orderPersistenceService.ts')
const projection = await import('./orders/orderTabProjection.ts')
const classification = await import('../src/utils/orderClassification.ts')

const nl = (value) => value.split('\r\n').join('\n')
const ENTRY_SOURCE = nl(readFileSync('server/index.mjs', 'utf8'))
const SERVICE_SOURCE = nl(
  readFileSync('server/orders/orderPersistenceService.ts', 'utf8'),
)
const PROJECTION_SOURCE = nl(
  readFileSync('server/orders/orderTabProjection.ts', 'utf8'),
)
const ORDERS_PAGE_SOURCE = nl(readFileSync('src/pages/OrdersPage.tsx', 'utf8'))

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

/** drizzle tum SQL'i client.query uzerinden gonderir → sorgu sayaci. */
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

const MARKETPLACE = 'Trendyol'
const PROVIDER = 'surat'
const STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
]

async function makeCtx({ count = 40, shipmentEvery = 2, orgCount = 1 } = {}) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const { client, counter } = withQueryCounter(pglite)
  const db = drizzle(client, { schema })
  const rawDb = drizzle(pglite, { schema })
  const { encryptShipmentPayload } = await import(
    './shipments/shipmentEncryption.ts'
  )
  const carrierCipher = encryptShipmentPayload({
    labelStatus: 'READY',
    shipmentStatus: 'CREATED',
    dispatchRegistrationConfirmed: true,
    ozelKargoTakipNo: '7270000000000',
  })

  const orgs = []
  for (let index = 0; index < orgCount; index += 1) {
    const orgRows = await rawDb.execute(
      sql.raw(
        `insert into organizations (name, slug) values ('Org${index}','org-${randomBytes(4).toString('hex')}') returning id`,
      ),
    )
    const organizationId = String(
      (Array.isArray(orgRows) ? orgRows[0] : orgRows.rows[0]).id,
    )
    const accountRows = await rawDb.execute(
      sql.raw(
        `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
         values ('${organizationId}','${MARKETPLACE}','2772${index}',true) returning id`,
      ),
    )
    const marketplaceAccountId = String(
      (Array.isArray(accountRows) ? accountRows[0] : accountRows.rows[0]).id,
    )
    const orderValues = []
    const shipmentValues = []
    const operationValues = []
    for (let seq = 0; seq < count; seq += 1) {
      const packageId = `PKG${index}-${1_000_000 + seq}`
      const orderDate = new Date(
        Date.UTC(2026, 0, 1, 9, 0, 0) + seq * 60_000,
      ).toISOString()
      const operationStatus =
        seq % 4 === 0 ? 'LABEL_PRINTED' : seq % 4 === 1 ? 'LABEL_READY' : 'NEW'
      orderValues.push(
        `('${randomUUID()}','${organizationId}','${marketplaceAccountId}','${MARKETPLACE}',` +
          `'${packageId}','114${index}${1_000_000 + seq}','${STATUSES[seq % STATUSES.length]}',` +
          `'${operationStatus}','Istanbul','Kadikoy','${orderDate}')`,
      )
      if (seq % shipmentEvery === 0) {
        shipmentValues.push(
          `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
            `'${PROVIDER}','local_create','created','7270000${seq}','${carrierCipher}')`,
        )
        operationValues.push(
          `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
            `'${PROVIDER}','create','idem-${index}-${seq}-a','failed','${carrierCipher}')`,
        )
        operationValues.push(
          `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
            `'${PROVIDER}','create','idem-${index}-${seq}-b','succeeded','${carrierCipher}')`,
        )
      }
    }
    await rawDb.execute(
      sql.raw(
        `insert into orders (id, organization_id, marketplace_account_id, marketplace,
           package_id, order_number, marketplace_status, operation_status,
           shipping_city, shipping_district, order_date)
         values ${orderValues.join(',')}`,
      ),
    )
    if (shipmentValues.length) {
      await rawDb.execute(
        sql.raw(
          `insert into shipments (id, organization_id, marketplace, package_id,
             provider, source, status, tracking_number, carrier_payload_encrypted)
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
    }
    orgs.push({ organizationId, marketplaceAccountId })
  }
  return { pglite, db, rawDb, counter, orgs }
}

// ═══ PERF-P0-1 / P0-9 — SUNUCU SAYFALAMA ══════════════════════════════════

test('PERF-P0-1: 25 gorunur siparis icin backend YALNIZ 25 satir doner', async () => {
  const ctx = await makeCtx({ count: 400 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  const result = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 25, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  assert.equal(result.orders.length, 25, 'sayfa boyutu kadar satir')
  assert.equal(result.total, 400, 'toplam ayrica bildirilir')
  await ctx.pglite.close()
})

test('PERF-P0-9: sekme filtreli sayfa da SAYFA BOYUTUNU asmaz', async () => {
  const ctx = await makeCtx({ count: 400 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  const result = await projection.listOrdersForTab(
    ctx.db,
    organizationId,
    { tab: 'newOrders', page: 1, pageSize: 25, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  assert.ok(result.orders.length <= 25, `donen satir: ${result.orders.length}`)
  // Toplam sekme kumesi ayri bildirilir → istemci TUM kumeyi indirmez.
  assert.ok(result.total >= result.orders.length)
  await ctx.pglite.close()
})

// ═══ PERF-P0-7 / P0-8 — N+1 KALDIRILDI ════════════════════════════════════

test('PERF-P0-7: 25 siparis icin gonderi/operasyon N+1 YOK', async () => {
  const ctx = await makeCtx({ count: 100, shipmentEvery: 1 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  ctx.counter.reset()
  const result = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 25, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  assert.equal(result.orders.length, 25)
  // orders + count + lines + shipments + operations = 5
  assert.ok(
    ctx.counter.count <= 5,
    `sayfa basina sorgu: ${ctx.counter.count} (hedef <= 5)`,
  )
  await ctx.pglite.close()
})

test('PERF-P0-8: sayfa boyutu 2 katina cikinca sorgu sayisi DEGISMEZ', async () => {
  const ctx = await makeCtx({ count: 200, shipmentEvery: 1 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  ctx.counter.reset()
  await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 25, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const small = ctx.counter.count
  ctx.counter.reset()
  await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 50, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const large = ctx.counter.count
  assert.equal(large, small, `25→${small} sorgu, 50→${large} sorgu`)
  await ctx.pglite.close()
})

test('PERF-P0-7b: toplu birlestirme gonderi GORUNUMUNU degistirmez', async () => {
  // Tekil (getOrder) ve toplu (listOrders) yol AYNI gorunumu uretmeli.
  const ctx = await makeCtx({ count: 6, shipmentEvery: 1 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  const list = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 6, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  for (const listed of list.orders) {
    const single = await service.getOrder(
      ctx.db,
      organizationId,
      String(listed.id),
      marketplaceAccountId,
    )
    assert.equal(single.hasPrintableLabel, listed.hasPrintableLabel)
    assert.equal(single.labelStatus, listed.labelStatus)
    assert.deepEqual(single.shipment, listed.shipment)
    assert.equal(single.cargoTrackingNumber, listed.cargoTrackingNumber)
  }
  await ctx.pglite.close()
})

test('PERF-P0-7c: operasyon secimi "basarili onceliklidir" kuralini KORUR', async () => {
  // Fixture her pakete once failed, sonra succeeded operasyon yaziyor.
  const ctx = await makeCtx({ count: 4, shipmentEvery: 1 })
  const { organizationId } = ctx.orgs[0]
  const { findLatestOperationByPackage, findLatestOperationsByPackageIds } =
    await import('./shipments/shipmentOperationRepository.ts')
  const rows = await ctx.rawDb.execute(
    sql.raw(
      `select distinct package_id from shipments where organization_id = '${organizationId}'`,
    ),
  )
  const packageIds = (Array.isArray(rows) ? rows : rows.rows).map((row) =>
    String(row.package_id),
  )
  const bulk = await findLatestOperationsByPackageIds(
    ctx.db,
    organizationId,
    packageIds,
  )
  for (const packageId of packageIds) {
    const single = await findLatestOperationByPackage(
      ctx.db,
      organizationId,
      packageId,
    )
    assert.equal(bulk.get(packageId).status, single.status)
    assert.equal(bulk.get(packageId).status, 'succeeded')
    assert.deepEqual(bulk.get(packageId).payload, single.payload)
  }
  await ctx.pglite.close()
})

// ═══ PERF-P0-6 — SEKME SAYACI SEMANTIGI ═══════════════════════════════════

test('PERF-P0-6: sunucu sayaclari KANONIK istemci sinifiyla BIREBIR ayni', async () => {
  const ctx = await makeCtx({ count: 160, shipmentEvery: 3 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]

  // SUNUCU: izdusum + kanonik siniflandirici.
  const serverSide = await projection.loadTabProjection(
    ctx.db,
    organizationId,
    {},
    marketplaceAccountId,
  )

  // ISTEMCI (ESKI YOL): tum siparisleri view-model olarak al, ayni kanonik
  // fonksiyonlarla say. Iki yol AYNI sayilari vermeli.
  const all = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 100, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const page2 = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 2, pageSize: 100, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const clientOrders = [...all.orders, ...page2.orders]
  assert.equal(clientOrders.length, 160)

  const clientCounts = Object.fromEntries(
    projection.QUICK_TAB_KEYS.map((key) => [key, 0]),
  )
  for (const order of clientOrders) {
    const state = classification.classifyOrderForTabs(order)
    for (const key of projection.QUICK_TAB_KEYS) {
      if (classification.orderMatchesQuickTab(state, key)) clientCounts[key] += 1
    }
  }
  assert.deepEqual(serverSide.counts, clientCounts)
  // Sayaclar anlamli olmali (hepsi sifir degil).
  assert.ok(clientCounts.all === 160)
  assert.ok(clientCounts.delivered > 0)
  assert.ok(clientCounts.cancelReturn > 0)
  await ctx.pglite.close()
})

test('PERF-P0-6b: sekme kumesi ve SIRASI OrdersPage ile ayni', () => {
  const tabsBlock = ORDERS_PAGE_SOURCE.slice(
    ORDERS_PAGE_SOURCE.indexOf('const quickTabs'),
    ORDERS_PAGE_SOURCE.indexOf('const operationTabOptions'),
  )
  const uiKeys = Array.from(tabsBlock.matchAll(/key: '([a-zA-Z]+)'/g)).map(
    (match) => match[1],
  )
  assert.deepEqual([...projection.QUICK_TAB_KEYS], uiKeys)
})

test('PERF-P0-6c: sunucu IKINCI bir sekme kural seti TANIMLAMAZ', () => {
  // Kanonik siniflandirici import edilir; kural kopyalanmaz.
  assert.ok(
    PROJECTION_SOURCE.includes(
      "from '../../src/utils/orderClassification.ts'",
    ),
  )
  assert.ok(PROJECTION_SOURCE.includes('classifyOrderForTabs('))
  assert.ok(PROJECTION_SOURCE.includes('orderMatchesQuickTab('))
  // Yerel bir "isDelivered/isLabelReady" turetmesi YOK.
  assert.equal(PROJECTION_SOURCE.includes('isLabelReady ='), false)
  assert.equal(PROJECTION_SOURCE.includes('isDelivered ='), false)
})

// ═══ PERF-P0-4/P0-5 — SUNUCU TARAFI ARAMA / SIRALAMA ══════════════════════

test('PERF-P0-4: arama SUNUCUDA daraltilir (sinirli sonuc)', async () => {
  const ctx = await makeCtx({ count: 120 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  const target = await ctx.rawDb.execute(
    sql.raw(
      `select order_number from orders where organization_id = '${organizationId}' limit 1`,
    ),
  )
  const orderNumber = String(
    (Array.isArray(target) ? target[0] : target.rows[0]).order_number,
  )
  const result = await service.listOrders(
    ctx.db,
    organizationId,
    { search: orderNumber, page: 1, pageSize: 25 },
    marketplaceAccountId,
  )
  assert.equal(result.total, 1, 'arama DB tarafinda daraltir')
  assert.equal(result.orders.length, 1)
  await ctx.pglite.close()
})

test('PERF-P0-5: siralama DB tarafindadir (asc/desc gercekten farkli)', async () => {
  const ctx = await makeCtx({ count: 60 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  const desc = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 5, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const asc = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 5, sort: 'orderDateAsc' },
    marketplaceAccountId,
  )
  assert.notEqual(desc.orders[0].id, asc.orders[0].id)
  const descDates = desc.orders.map((order) => String(order.orderDate))
  assert.deepEqual(descDates, [...descDates].sort().reverse())
  await ctx.pglite.close()
})

// ═══ PERF-P0-10 / P0-11 — IZOLASYON ═══════════════════════════════════════

test('PERF-P0-10: tenant izolasyonu KORUNUR (toplu yolda da)', async () => {
  const ctx = await makeCtx({ count: 30, shipmentEvery: 1, orgCount: 2 })
  const [first, second] = ctx.orgs
  const result = await service.listOrders(
    ctx.db,
    first.organizationId,
    { page: 1, pageSize: 100 },
    first.marketplaceAccountId,
  )
  assert.equal(result.total, 30, 'yalniz kendi organizasyonu')
  // Diger organizasyonun gonderisi SIZMAZ.
  const counts = await projection.loadTabProjection(
    ctx.db,
    second.organizationId,
    {},
    second.marketplaceAccountId,
  )
  assert.equal(counts.counts.all, 30)
  assert.equal(counts.scannedCount, 30)
  await ctx.pglite.close()
})

test('PERF-P0-11: aktif marketplaceAccountId kapsami KORUNUR', async () => {
  const ctx = await makeCtx({ count: 20 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  // Ayni org, IKINCI (pasif) hesap altinda kayit.
  const otherAccount = await ctx.rawDb.execute(
    sql.raw(
      `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
       values ('${organizationId}','${MARKETPLACE}','999999',false) returning id`,
    ),
  )
  const otherId = String(
    (Array.isArray(otherAccount) ? otherAccount[0] : otherAccount.rows[0]).id,
  )
  await ctx.rawDb.execute(
    sql.raw(
      `insert into orders (organization_id, marketplace_account_id, marketplace,
         package_id, order_number, marketplace_status, order_date)
       values ('${organizationId}','${otherId}','${MARKETPLACE}','OTHER-1','114999','Created','2026-01-01T09:00:00Z')`,
    ),
  )
  const scoped = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 100 },
    marketplaceAccountId,
  )
  assert.equal(scoped.total, 20, 'baska hesabin siparisi GORUNMEZ')
  const counts = await projection.loadTabProjection(
    ctx.db,
    organizationId,
    {},
    marketplaceAccountId,
  )
  assert.equal(counts.scannedCount, 20)
  await ctx.pglite.close()
})

// ═══ PERF-P0-12/13/14 — MEVCUT SOZLESMELER ════════════════════════════════

test('PERF-P0-12: NULL hesap yazma engeli (69a666d) KORUNUR', () => {
  assert.ok(ENTRY_SOURCE.includes('resolveActiveMarketplaceAccountScope('))
  assert.ok(ENTRY_SOURCE.includes("accountScope.status !== 'ok'"))
  assert.ok(ENTRY_SOURCE.includes('response.status(resolutionError ? 503 : 409)'))
  assert.ok(ENTRY_SOURCE.includes('return { synced: false, skipped: accountScope.status }'))
  assert.equal(
    (ENTRY_SOURCE.match(/requireMarketplaceAccount: true/g) ?? []).length,
    3,
    'uc calisma zamani yazma noktasi',
  )
  assert.ok(SERVICE_SOURCE.includes("throw new Error('marketplace_account_required')"))
})

test('PERF-P0-13: Trendyol statu esleme ve sync sozlesmeleri KORUNUR', () => {
  assert.ok(ENTRY_SOURCE.includes('const marketplaceStatus = normalizeStatus(item.status)'))
  assert.ok(ENTRY_SOURCE.includes('async function retryTrendyolStatusPass'))
  assert.ok(ENTRY_SOURCE.includes('beginSyncFlight(flightKey)'))
  assert.ok(ENTRY_SOURCE.includes('complete: false'))
  assert.ok(ENTRY_SOURCE.includes('async function reconcileStaleOpenForOrganization'))
})

test('PERF-P0-14: etiket/baski gorunum alanlari BOZULMADI', async () => {
  const ctx = await makeCtx({ count: 4, shipmentEvery: 1 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  const result = await service.listOrders(
    ctx.db,
    organizationId,
    { page: 1, pageSize: 4 },
    marketplaceAccountId,
  )
  for (const order of result.orders) {
    // Gonderi baglantisi ve yazdirilabilirlik bayragi hala uretiliyor.
    assert.ok(order.shipment, 'shipment gorunumu var')
    assert.equal(typeof order.hasPrintableLabel, 'boolean')
    assert.equal(order.labelStatus, 'READY')
    // Ham ZPL ISTEMCIYE DONMEZ (mevcut sozlesme).
    assert.equal('technicalZpl' in order, false)
  }
  await ctx.pglite.close()
})

test('PERF-P0-ARCHIVE: arsiv davranisi BU TURDA DEGISTIRILMEDI', () => {
  const REPO = nl(readFileSync('server/orders/orderRepository.ts', 'utf8'))
  const buildWhere = REPO.slice(
    REPO.indexOf('export function buildOrderWhere('),
    REPO.indexOf('export async function findOrders('),
  )
  // Arsiv kosulu EKLENMEDI: mevcut urun davranisi korunuyor (ayri P1).
  assert.equal(buildWhere.includes('archivedAt'), false)
})

// ═══ SORGU BUTCESI SOZLESMESI ═════════════════════════════════════════════

test('PERF-P0-BUDGET: sekme filtreli sayfa da sabit sorgu butcesinde', async () => {
  const ctx = await makeCtx({ count: 200, shipmentEvery: 1 })
  const { organizationId, marketplaceAccountId } = ctx.orgs[0]
  ctx.counter.reset()
  await projection.listOrdersForTab(
    ctx.db,
    organizationId,
    { tab: 'labelStage', page: 1, pageSize: 25, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const small = ctx.counter.count
  ctx.counter.reset()
  await projection.listOrdersForTab(
    ctx.db,
    organizationId,
    { tab: 'labelStage', page: 1, pageSize: 50, sort: 'orderDateDesc' },
    marketplaceAccountId,
  )
  const large = ctx.counter.count
  // Sekme yolu izdusum + sayfa okumasi yapar; sayfa BOYUTU sorgu sayisini
  // ARTIRMAZ (N+1 yok).
  assert.equal(large, small, `25→${small}, 50→${large}`)
  assert.ok(small <= 8, `sekme yolu sorgu sayisi: ${small}`)
  await ctx.pglite.close()
})

test('PERF-P0-ENDPOINT: sayaç ucu :id rotasindan ONCE tanimli', () => {
  const countsIndex = ENTRY_SOURCE.indexOf("app.get('/api/orders/counts'")
  const idIndex = ENTRY_SOURCE.indexOf("app.get('/api/orders/:id'")
  assert.ok(countsIndex > 0, 'sayaç ucu tanimli')
  assert.ok(
    countsIndex < idIndex,
    'counts, :id rotasindan ONCE gelmeli (aksi halde id sanilir)',
  )
  // Liste ucu tab parametresini gecirir.
  assert.ok(ENTRY_SOURCE.includes('tab: strOrUndef(query.tab)'))
  // SOZLESME GUNCELLENDI: liste ucu artik 10 filtrenin tamamini kabul eden
  // yonlendiriciyi (hizli yol / kanonik yol) kullanir.
  assert.ok(ENTRY_SOURCE.includes('listOrdersForRequest('))
})
