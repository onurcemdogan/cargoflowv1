import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const statements = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    statements.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return statements
}

// ═══ SİPARİŞ ÇALIŞMA ALANI — PARİTE VE SUNUCU SAYFALAMA ═════════════════
//
// Eski mimari: tarayıcı TÜM sipariş tablosunu 100'erlik sayfalarla indirir
// (10k'da ~100 HTTP turu, 20k üstünde AÇIK hata), sonra filtreleme,
// sıralama, gruplama ve sayfalamayı React içinde yapardı.
//
// Yeni mimari: AYNI saf projeksiyon (`buildOrdersWorkspaceResult`) sunucuda
// çalışır; tarayıcıya yalnız istenen sayfa iner.
//
// BU DOSYANIN İŞİ: yeni yolun ESKİ yolla BİREBİR aynı cevabı verdiğini
// kanıtlamak. "Yaklaşık aynı" kabul edilmez — görünen satırlar, toplam
// sayılar, sekme sayaçları ve filtre seçenekleri TAM eşleşmelidir.
//
// TAŞIYICI VE PAZARYERİ ÇAĞRISI YOKTUR.

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

const CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Şanlıurfa', 'Çanakkale']
const DISTRICTS = ['Kadıköy', 'Çankaya', 'Bornova', 'Siverek', 'Ayvacık']
const NAMES = ['Şükrü Öz', 'Ayşe Çelik', 'Ibrahim Ünal', 'Zeynep Işık', 'Ömer Gül']
const STATUSES = ['Created', 'Picking', 'Shipped', 'Delivered', 'Cancelled']

/**
 * ÇEŞİTLİ fixture. Tek tip veri pariteyi kanıtlamaz: farklı şehir, ilçe,
 * statü, tarih, Türkçe karakterli ad ve çok ürünlü sipariş ŞART.
 */
async function seedWorkspace(db, schema, count, orgName = 'parity') {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: orgName, slug: `${orgName}-${randomBytes(4).toString('hex')}` })
    .returning()

  const orderRows = []
  for (let index = 0; index < count; index += 1) {
    orderRows.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId: `PKG-${index}`,
      orderNumber: `ORD-${String(index).padStart(5, '0')}`,
      customerFirstName: NAMES[index % NAMES.length].split(' ')[0],
      customerLastName: NAMES[index % NAMES.length].split(' ')[1],
      shippingCity: CITIES[index % CITIES.length],
      shippingDistrict: DISTRICTS[index % DISTRICTS.length],
      marketplaceStatus: STATUSES[index % STATUSES.length],
      orderDate: new Date(Date.UTC(2026, 6, 1 + (index % 28), index % 24)),
      operationStatus: index % 4 === 0 ? 'LABEL_READY' : 'NEW',
    })
  }
  const chunk = 250
  for (let index = 0; index < orderRows.length; index += chunk) {
    await db.insert(schema.orders).values(orderRows.slice(index, index + chunk))
  }
  const persisted = await db.select().from(schema.orders)
  const mine = persisted.filter((row) => String(row.organizationId) === String(org.id))
  const lines = []
  for (const row of mine) {
    const index = Number(String(row.packageId).split('-')[1])
    // Her 5. sipariş ÇOK ürünlü — multiProduct filtresi ve ürün ailesi
    // gruplaması gerçek veriyle sınanır.
    const lineCount = index % 5 === 0 ? 2 : 1
    for (let line = 0; line < lineCount; line += 1) {
      lines.push({
        organizationId: org.id,
        orderId: row.id,
        externalLineId: `L-${index}-${line}`,
        productName: `Ürün ${index % 7} Model`,
        merchantSku: `SKU-${index}-${line}`,
        quantity: 1 + (index % 3),
        variantAttributes: [],
      })
    }
  }
  for (let index = 0; index < lines.length; index += chunk) {
    await db.insert(schema.orderLines).values(lines.slice(index, index + chunk))
  }
  return { organizationId: org.id, count }
}

async function makeDb() {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await load('/server/db/schema.ts')
  const pglite = new PGlite()
  for (const statement of migrationStatements()) {
    await pglite.exec(statement)
  }
  const db = drizzle(pglite, { schema })
  return { pglite, db, schema }
}

/**
 * ESKİ (referans) yol: tüm tabloyu 100'erlik sayfalarla topla, istemci
 * türetmelerini uygula, sonra projeksiyonu TARAYICIDAKİ gibi tam dizi
 * üzerinde çalıştır.
 */
async function legacyClientPipeline(deps, organizationId, query) {
  const { persistence, db, orderStatus, externalProcessing, orderCounts, projection } =
    deps
  const collected = []
  let page = 1
  for (;;) {
    const result = await persistence.listOrders(
      db,
      organizationId,
      { page, pageSize: 100 },
      undefined,
    )
    collected.push(...result.orders)
    if (collected.length >= result.total || result.orders.length === 0) break
    page += 1
  }
  const derived = collected.map((order) =>
    orderStatus.withDerivedOperationStatus(order),
  )
  const stamped = externalProcessing.applyExternalProcessingState(derived, {
    entries: {},
  })
  const deduped = orderCounts.dedupeOrdersByPackageIdentity(stamped)
  return projection.buildOrdersWorkspaceResult(deduped, query, FIXED_NOW)
}

/** ESKİ istemci havuzu (yalnız sipariş dizisi) — projeksiyon UYGULANMAZ. */
async function legacyClientPipelineOrders(deps, organizationId) {
  const collected = []
  let page = 1
  for (;;) {
    const result = await deps.persistence.listOrders(
      deps.db, organizationId, { page, pageSize: 100 }, undefined,
    )
    collected.push(...result.orders)
    if (collected.length >= result.total || result.orders.length === 0) break
    page += 1
  }
  const derived = collected.map((order) =>
    deps.orderStatus.withDerivedOperationStatus(order),
  )
  const stamped = deps.externalProcessing.applyExternalProcessingState(derived, {
    entries: {},
  })
  return deps.orderCounts.dedupeOrdersByPackageIdentity(stamped)
}

const FIXED_NOW = new Date('2026-07-20T09:00:00.000Z')

function baseQuery(overrides = {}) {
  return {
    tab: 'all',
    operationTab: 'all',
    marketplace: 'all',
    status: 'all',
    cargo: 'all',
    city: 'all',
    district: 'all',
    multiProduct: 'all',
    sameProduct: 'all',
    action: 'all',
    date: { preset: 'all' },
    search: '',
    customerQuery: '',
    productQuery: '',
    orderNumberQuery: '',
    cargoSlipQuery: '',
    sortKey: 'orderDate',
    sortDirection: 'desc',
    page: 1,
    pageSize: 25,
    ...overrides,
  }
}

function visibleIds(result) {
  return result.items.map((order) => String(order.id))
}

async function setup(count = 140) {
  const { pglite, db, schema } = await makeDb()
  const seed = await seedWorkspace(db, schema, count)
  const deps = {
    db,
    persistence: await load('/server/orders/orderPersistenceService.ts'),
    workspace: await load('/server/orders/ordersWorkspaceService.ts'),
    projection: await load('/src/utils/ordersWorkspaceQuery.ts'),
    orderStatus: await load('/src/utils/orderStatus.ts'),
    externalProcessing: await load('/src/utils/externalProcessing.ts'),
    orderCounts: await load('/src/utils/orderCounts.ts'),
  }
  deps.workspace.resetOrdersWorkspaceCache()
  return { pglite, db, schema, seed, deps }
}

async function assertParity(t, overrides, count = 140) {
  const { pglite, seed, deps, db } = await setup(count)
  t.after(() => pglite.close())
  const query = baseQuery(overrides)
  const legacy = await legacyClientPipeline(deps, seed.organizationId, query)
  const server = await deps.workspace.buildOrdersWorkspacePage(
    db,
    seed.organizationId,
    query,
    undefined,
    FIXED_NOW,
  )
  assert.deepEqual(
    visibleIds(server),
    visibleIds(legacy),
    'görünen satırlar birebir aynı olmalı',
  )
  assert.equal(server.totalItems, legacy.totalItems, 'toplam kayıt aynı')
  assert.equal(server.pageCount, legacy.pageCount, 'sayfa sayısı aynı')
  assert.equal(server.page, legacy.page, 'sayfa numarası aynı')
  assert.deepEqual(server.tabCounts, legacy.tabCounts, 'sekme sayaçları aynı')
  assert.deepEqual(server.cityOptions, legacy.cityOptions, 'şehir seçenekleri aynı')
  assert.deepEqual(
    server.districtOptions,
    legacy.districtOptions,
    'ilçe seçenekleri aynı',
  )
  assert.deepEqual(server.listedCounts, legacy.listedCounts, 'paket sayaçları aynı')
  return { server, legacy }
}

test('WS-1: ilk sayfa — sunucu projeksiyonu eski istemci yoluyla AYNI', async (t) => {
  const { server } = await assertParity(t, { page: 1 })
  assert.equal(server.items.length, 25)
})

test('WS-2: orta sayfa parite', async (t) => {
  await assertParity(t, { page: 3 })
})

test('WS-3: son sayfa parite (kısmi sayfa dahil)', async (t) => {
  const { server } = await assertParity(t, { page: 6, pageSize: 25 })
  assert.ok(server.items.length > 0, 'son sayfa boş dönmemeli')
})

test('WS-4: arama filtresi parite', async (t) => {
  const { server } = await assertParity(t, { search: 'Şükrü' })
  assert.ok(server.totalItems > 0, 'Türkçe karakterli arama sonuç döndürmeli')
})

test('WS-5: pazaryeri statü filtresi parite', async (t) => {
  await assertParity(t, { status: 'Shipped' })
})

test('WS-6: şehir + ilçe filtresi parite', async (t) => {
  await assertParity(t, { city: 'İzmir', district: 'Bornova' })
})

test('WS-7: tarih aralığı filtresi parite', async (t) => {
  await assertParity(t, {
    date: {
      preset: 'custom',
      startTime: Date.UTC(2026, 6, 5),
      endTime: Date.UTC(2026, 6, 12, 23, 59, 59, 999),
    },
  })
})

test('WS-8: artan sıralama parite', async (t) => {
  await assertParity(t, { sortDirection: 'asc' })
})

test('WS-9: sipariş numarasına göre sıralama parite (tr-TR, numeric)', async (t) => {
  await assertParity(t, { sortKey: 'orderNumber', sortDirection: 'asc' })
})

test('WS-10: sonuç yokken parite (boş liste)', async (t) => {
  const { server } = await assertParity(t, { search: 'BULUNMAYAN-ARAMA-XYZ' })
  assert.equal(server.totalItems, 0)
  assert.deepEqual(server.items, [])
})

test('WS-11: aynı ürün gruplaması parite', async (t) => {
  await assertParity(t, { sameProduct: 'repeated' })
})

test('WS-12: çok ürünlü filtre parite', async (t) => {
  await assertParity(t, { multiProduct: 'multi' })
})

test('WS-13: sekme değişimi parite (etiket aşaması)', async (t) => {
  await assertParity(t, { tab: 'labelStage' })
})

test('WS-14: sayfa boyutu 100 ile sınırlıdır (sözleşme korunur)', async (t) => {
  const { pglite, seed, deps, db } = await setup(140)
  t.after(() => pglite.close())
  const server = await deps.workspace.buildOrdersWorkspacePage(
    db,
    seed.organizationId,
    baseQuery({ pageSize: 100 }),
    undefined,
    FIXED_NOW,
  )
  assert.equal(server.pageSize, 100)
  assert.equal(server.items.length, 100)
})

test('WS-15: sorgu sayısı SAYFA BOYUTUNDAN bağımsız (N+1 yok)', async (t) => {
  const { pglite, seed, deps, db } = await setup(140)
  t.after(() => pglite.close())
  const bench = await load('/server/benchmarks/appPerformanceBenchmark.ts')

  const count = async (pageSize) => {
    deps.workspace.resetOrdersWorkspaceCache()
    const counter = bench.countingDb(db)
    await deps.workspace.buildOrdersWorkspacePage(
      counter.db,
      seed.organizationId,
      baseQuery({ pageSize }),
      undefined,
      FIXED_NOW,
    )
    return counter.count()
  }

  const small = await count(10)
  const large = await count(100)
  assert.equal(small, large, `sorgu sayısı sabit olmalı (${small} vs ${large})`)
})

test('WS-16: revizyon cache — değişmeyen veri yeniden OKUNMAZ, değişen veri OKUNUR', async (t) => {
  const { pglite, seed, deps, db, schema } = await setup(60)
  t.after(() => pglite.close())
  const bench = await load('/server/benchmarks/appPerformanceBenchmark.ts')

  deps.workspace.resetOrdersWorkspaceCache()
  const cold = bench.countingDb(db)
  const first = await deps.workspace.buildOrdersWorkspacePage(
    cold.db, seed.organizationId, baseQuery(), undefined, FIXED_NOW,
  )
  const coldQueries = cold.count()
  assert.equal(first.cacheHit, false, 'ilk istek cache MISS olmalı')

  const warm = bench.countingDb(db)
  const second = await deps.workspace.buildOrdersWorkspacePage(
    warm.db, seed.organizationId, baseQuery({ page: 2 }), undefined, FIXED_NOW,
  )
  assert.equal(second.cacheHit, true, 'değişmemiş veri cache HIT olmalı')
  assert.ok(
    warm.count() < coldQueries,
    `cache HIT daha az sorgu üretmeli (${warm.count()} < ${coldQueries})`,
  )

  // Veri DEĞİŞTİ: revizyon damgası değişmeli ve tam liste YENİDEN okunmalı.
  // Bayat liste göstermek, hızlı olmaktan DAHA KÖTÜDÜR.
  await db.insert(schema.orders).values({
    organizationId: seed.organizationId,
    marketplace: 'Trendyol',
    packageId: 'PKG-NEW-1',
    orderNumber: 'ORD-NEW-1',
    orderDate: new Date(Date.UTC(2026, 6, 20)),
    operationStatus: 'NEW',
  })
  const third = await deps.workspace.buildOrdersWorkspacePage(
    db, seed.organizationId, baseQuery(), undefined, FIXED_NOW,
  )
  assert.equal(third.cacheHit, false, 'veri değişince cache GEÇERSİZ olmalı')
  assert.equal(third.totalItems, first.totalItems + 1, 'yeni kayıt görünmeli')
})

test('WS-17: kiracı izolasyonu — başka organizasyonun siparişi ASLA görünmez', async (t) => {
  const { pglite, db, schema, seed, deps } = await setup(40)
  t.after(() => pglite.close())
  const other = await seedWorkspace(db, schema, 40, 'digerkiraci')

  deps.workspace.resetOrdersWorkspaceCache()
  const mine = await deps.workspace.buildOrdersWorkspacePage(
    db, seed.organizationId, baseQuery({ pageSize: 100 }), undefined, FIXED_NOW,
  )
  deps.workspace.resetOrdersWorkspaceCache()
  const theirs = await deps.workspace.buildOrdersWorkspacePage(
    db, other.organizationId, baseQuery({ pageSize: 100 }), undefined, FIXED_NOW,
  )
  const mineIds = new Set(visibleIds(mine))
  for (const id of visibleIds(theirs)) {
    assert.equal(mineIds.has(id), false, 'çapraz kiracı sızıntısı YOK')
  }
  assert.equal(mine.totalItems, 40)
  assert.equal(theirs.totalItems, 40)
})

test('WS-18: yanıt gövdesi TOPLAM sipariş sayısıyla BÜYÜMEZ', async (t) => {
  // Eski mimarinin gerçek maliyeti buydu: 10k siparişte gövde 10k satır
  // taşıyordu. Yeni yolda gövde SAYFA BOYUTUNA bağlıdır; koleksiyon
  // büyüdükçe büyümez.
  const small = await setup(150)
  t.after(() => small.pglite.close())
  const large = await setup(600)
  t.after(() => large.pglite.close())

  const measure = async (ctx) => {
    ctx.deps.workspace.resetOrdersWorkspaceCache()
    const page = await ctx.deps.workspace.buildOrdersWorkspacePage(
      ctx.db, ctx.seed.organizationId, baseQuery({ pageSize: 25 }),
      undefined, FIXED_NOW,
    )
    return { page, bytes: JSON.stringify(page.items).length }
  }

  const smallResult = await measure(small)
  const largeResult = await measure(large)

  assert.equal(smallResult.page.items.length, 25)
  assert.equal(largeResult.page.items.length, 25)
  assert.equal(smallResult.page.totalItems, 150)
  assert.equal(largeResult.page.totalItems, 600)
  assert.equal(largeResult.page.scannedOrders, 600, 'tarama SUNUCUDA yapılır')
  // Koleksiyon 4 KAT büyüdü; gövde %25'ten fazla büyümemeli.
  assert.ok(
    largeResult.bytes <= smallResult.bytes * 1.25,
    `gövde koleksiyonla büyümemeli (${smallResult.bytes} → ${largeResult.bytes})`,
  )
})

/* ═══ WS-19 — SEKME SAYAÇLARI TEK GEÇİŞTE AYNI ═══════════════════════ */

test('WS-19: tek geçişli sekme sayaçları, sekme başına yeniden filtreleyen NAİF hesapla AYNI', async (t) => {
  // Sayaçlar artık filtre hattını sekme başına tekrar çalıştırmıyor. Bu test
  // o optimizasyonun DENKLİĞİNİ kilitler: naif biçim (her sekme için baştan
  // `buildVisibleOrders`) burada bağımsızca hesaplanır ve karşılaştırılır.
  // Bir gün `selectedTab` hattın başka bir aşamasını etkilerse bu test düşer.
  const { pglite, seed, deps, db } = await setup(220)
  t.after(() => pglite.close())
  const classification = await load('/src/utils/orderClassification.ts')

  const scenarios = [
    {},
    { status: 'Shipped' },
    { city: 'İzmir' },
    { search: 'Şükrü' },
    { multiProduct: 'multi' },
    {
      date: {
        preset: 'custom',
        startTime: Date.UTC(2026, 6, 5),
        endTime: Date.UTC(2026, 6, 20, 23, 59, 59, 999),
      },
    },
  ]

  for (const overrides of scenarios) {
    const query = baseQuery(overrides)
    const server = await deps.workspace.buildOrdersWorkspacePage(
      db, seed.organizationId, query, undefined, FIXED_NOW,
    )

    // Referans: eski istemci havuzu üzerinde, SEKME BAŞINA yeniden filtreleme.
    const reference = await legacyClientPipelineOrders(deps, seed.organizationId)
    const naive = {}
    for (const tab of deps.projection.ORDERS_QUICK_TABS) {
      naive[tab.key] = classification.buildVisibleOrders({
        persistentOrders: reference,
        selectedTab: tab.key,
        marketplaceFilter: query.marketplace,
        operationStatusFilter: query.status,
        cargoFilter: query.cargo,
        cityFilter: query.city,
        districtFilter: query.district,
        multiProductFilter: query.multiProduct,
        actionFilter: query.action,
        dateFilter: {
          preset: query.date.preset,
          startTime: query.date.startTime ?? Number.NEGATIVE_INFINITY,
          endTime: query.date.endTime ?? Number.POSITIVE_INFINITY,
          timezone: query.date.timezone,
        },
        searchQuery: query.search,
        customerQuery: query.customerQuery,
        productQuery: query.productQuery,
        orderNumberQuery: query.orderNumberQuery,
        cargoSlipQuery: query.cargoSlipQuery,
        now: FIXED_NOW,
      }).visibleOrders.length
    }
    assert.deepEqual(
      server.tabCounts,
      naive,
      `sekme sayaçları ayrıştı: ${JSON.stringify(overrides)}`,
    )
  }
})

/* ═══ WS-20 — ÖNBELLEK BELLEK BÜTÇESİ ═══════════════════════════════ */

test('WS-20: önbellek HACİMLE sınırlıdır ve tahliye CEVABI DEĞİŞTİRMEZ', async (t) => {
  // Kapsam SAYISI ile sınırlamak kayıt BÜYÜKLÜĞÜNÜ görmezden gelirdi: sekiz
  // küçük kiracı ile sekiz tane 25.000 siparişli kiracı aynı sayılırdı.
  // Bütçe sipariş sayısına bağlıdır. Bu test hem sınırın UYGULANDIĞINI hem de
  // tahliyenin bir DOĞRULUK sınırı OLMADIĞINI kanıtlar.
  const { pglite, db, schema, deps } = await setup(60)
  t.after(() => pglite.close())
  const second = await seedWorkspace(db, schema, 60, 'parity-b')
  const first = await db.select().from(schema.orders)
  const firstOrg = first.find((row) => String(row.packageId) === 'PKG-0')
    .organizationId

  deps.workspace.resetOrdersWorkspaceCache()
  deps.workspace.setMaxCachedOrdersForTest(100)

  const query = baseQuery()
  const before = await deps.workspace.buildOrdersWorkspacePage(
    db, firstOrg, query, undefined, FIXED_NOW,
  )
  assert.equal(before.cacheHit, false, 'ilk okuma veritabanından gelmeli')

  // İkinci kapsam yüklenince bütçe (100) aşılır → EN ESKİ kapsam düşer.
  await deps.workspace.buildOrdersWorkspacePage(
    db, second.organizationId, query, undefined, FIXED_NOW,
  )
  assert.ok(
    deps.workspace.cachedWorkspaceOrderCount() <= 100,
    `önbellek bütçesi aşıldı: ${deps.workspace.cachedWorkspaceOrderCount()}`,
  )

  // Düşen kapsam yeniden OKUNUR (cacheHit=false) ve cevap AYNIDIR.
  const after = await deps.workspace.buildOrdersWorkspacePage(
    db, firstOrg, query, undefined, FIXED_NOW,
  )
  assert.equal(after.cacheHit, false, 'tahliye edilen kapsam yeniden okunmalı')
  assert.deepEqual(visibleIds(after), visibleIds(before), 'görünen satırlar AYNI')
  assert.equal(after.totalItems, before.totalItems)
  assert.deepEqual(after.tabCounts, before.tabCounts)
  assert.deepEqual(after.listedCounts, before.listedCounts)

  deps.workspace.resetOrdersWorkspaceCache()
})
