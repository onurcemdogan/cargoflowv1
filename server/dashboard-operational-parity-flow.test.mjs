import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ DASHBOARD OPERASYON ANLIK GÖRÜNTÜSÜ — PARİTE ═══════════════════════
//
// Dashboard'ın operasyon sayaçları TÜM tenant siparişlerini ister. Eskiden
// bunun bedeli, tarayıcının sipariş tablosunun TAMAMINI indirmesiydi.
//
// Yeni yol: AYNI `buildDashboardViewModel` sunucuda çalışır. Bu dosyanın
// işi, sunucunun ürettiği beş operasyon alanının, tarayıcının tam liste
// üzerinde hesaplayacağıyla BİREBİR aynı olduğunu kanıtlamaktır.
//
// "Performans, cevabı değiştirmeyi haklı çıkarmaz."
//
// TAŞIYICI VE PAZARYERİ ÇAĞRISI YOKTUR.

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

const FIXED_NOW = new Date('2026-07-20T09:00:00.000Z')
const PERIOD = { key: 'last30' }

const STATUSES = ['Created', 'Picking', 'Shipped', 'Delivered', 'Cancelled']
const OPERATIONS = ['NEW', 'LABEL_READY', 'LABEL_PRINTED', 'HANDED_TO_CARGO']

async function seed(db, schema, count, orgName = 'dashparity') {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: orgName, slug: `${orgName}-${randomBytes(4).toString('hex')}` })
    .returning()
  const rows = []
  for (let index = 0; index < count; index += 1) {
    rows.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId: `DPKG-${index}`,
      orderNumber: `DORD-${String(index).padStart(5, '0')}`,
      customerFirstName: 'Şükrü',
      customerLastName: `Öz${index % 9}`,
      shippingCity: ['İstanbul', 'Ankara', 'İzmir'][index % 3],
      shippingDistrict: ['Kadıköy', 'Çankaya', 'Bornova'][index % 3],
      marketplaceStatus: STATUSES[index % STATUSES.length],
      operationStatus: OPERATIONS[index % OPERATIONS.length],
      orderDate: new Date(Date.UTC(2026, 6, 1 + (index % 19), index % 24)),
    })
  }
  const chunk = 250
  for (let index = 0; index < rows.length; index += chunk) {
    await db.insert(schema.orders).values(rows.slice(index, index + chunk))
  }
  const persisted = (await db.select().from(schema.orders)).filter(
    (row) => String(row.organizationId) === String(org.id),
  )
  const lines = []
  for (const row of persisted) {
    const index = Number(String(row.packageId).split('-')[1])
    const lineCount = index % 4 === 0 ? 2 : 1
    for (let line = 0; line < lineCount; line += 1) {
      lines.push({
        organizationId: org.id,
        orderId: row.id,
        externalLineId: `DL-${index}-${line}`,
        productName: `Ürün ${index % 6}`,
        merchantSku: `DSKU-${index}-${line}`,
        quantity: 1 + (index % 2),
        variantAttributes: [],
      })
    }
  }
  for (let index = 0; index < lines.length; index += chunk) {
    await db.insert(schema.orderLines).values(lines.slice(index, index + chunk))
  }
  return { organizationId: org.id }
}

async function setup(count = 120) {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await load('/server/db/schema.ts')
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const org = await seed(db, schema, count)
  const deps = {
    persistence: await load('/server/orders/orderPersistenceService.ts'),
    products: await load('/server/products/productPersistenceService.ts'),
    workspace: await load('/server/orders/ordersWorkspaceService.ts'),
    operational: await load('/server/dashboard/dashboardOperationalService.ts'),
    viewModel: await load('/src/dashboard/dashboardViewModel.ts'),
    orderStatus: await load('/src/utils/orderStatus.ts'),
    externalProcessing: await load('/src/utils/externalProcessing.ts'),
    orderCounts: await load('/src/utils/orderCounts.ts'),
  }
  deps.workspace.resetOrdersWorkspaceCache()
  deps.operational.resetDashboardProductCache()
  return { pglite, db, schema, org, deps }
}

/** ESKİ yol: tarayıcı tam listeyi indirir ve view-model'i kendisi hesaplar. */
async function legacyClientViewModel(deps, db, organizationId) {
  const collected = []
  let page = 1
  for (;;) {
    const result = await deps.persistence.listOrders(
      db, organizationId, { page, pageSize: 100 }, undefined,
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
  const orders = deps.orderCounts.dedupeOrdersByPackageIdentity(stamped)
  const products = await deps.products.listAllProducts(db, organizationId, undefined)
  return deps.viewModel.buildDashboardViewModel({
    orders,
    products,
    selectedPeriod: PERIOD,
    now: FIXED_NOW,
  })
}

test('DASH-1: operasyon sayaçları sunucu ve istemcide BİREBİR aynı', async (t) => {
  const { pglite, db, org, deps } = await setup(120)
  t.after(() => pglite.close())
  const legacy = await legacyClientViewModel(deps, db, org.organizationId)
  const server = await deps.operational.buildDashboardOperationalSnapshot(
    db, org.organizationId, PERIOD, undefined, FIXED_NOW,
  )
  assert.deepEqual(
    server.snapshot.operationalSummary,
    legacy.operationalSummary,
    'operationalSummary birebir aynı',
  )
})

test('DASH-2: aksiyon listesi paritesi', async (t) => {
  const { pglite, db, org, deps } = await setup(120)
  t.after(() => pglite.close())
  const legacy = await legacyClientViewModel(deps, db, org.organizationId)
  const server = await deps.operational.buildDashboardOperationalSnapshot(
    db, org.organizationId, PERIOD, undefined, FIXED_NOW,
  )
  assert.deepEqual(server.snapshot.actionRequired, legacy.actionRequired)
})

test('DASH-3: toplama listesi paritesi (ürün ailesi + adet)', async (t) => {
  const { pglite, db, org, deps } = await setup(120)
  t.after(() => pglite.close())
  const legacy = await legacyClientViewModel(deps, db, org.organizationId)
  const server = await deps.operational.buildDashboardOperationalSnapshot(
    db, org.organizationId, PERIOD, undefined, FIXED_NOW,
  )
  assert.deepEqual(server.snapshot.pickingLists, legacy.pickingLists)
})

test('DASH-4: son operasyonlar paritesi', async (t) => {
  const { pglite, db, org, deps } = await setup(120)
  t.after(() => pglite.close())
  const legacy = await legacyClientViewModel(deps, db, org.organizationId)
  const server = await deps.operational.buildDashboardOperationalSnapshot(
    db, org.organizationId, PERIOD, undefined, FIXED_NOW,
  )
  assert.deepEqual(server.snapshot.recentOperations, legacy.recentOperations)
})

test('DASH-5: anlık görüntü uygulanınca TAM view-model operasyon alanları DEĞİŞMEZ', async (t) => {
  // Kritik: istemci artık tam listeye sahip DEĞİL. Kısmi havuz + sunucu
  // anlık görüntüsü ile üretilen view-model'in operasyon alanları, tam
  // liste ile üretilenle AYNI olmalıdır.
  const { pglite, db, org, deps } = await setup(120)
  t.after(() => pglite.close())
  const legacy = await legacyClientViewModel(deps, db, org.organizationId)
  const server = await deps.operational.buildDashboardOperationalSnapshot(
    db, org.organizationId, PERIOD, undefined, FIXED_NOW,
  )

  // Tarayıcı yalnız ZİYARET EDİLEN sayfayı bilir: ilk 25 kayıt.
  const partialPool = await deps.persistence.listOrders(
    db, org.organizationId, { page: 1, pageSize: 25 }, undefined,
  )
  const partial = partialPool.orders.map((order) =>
    deps.orderStatus.withDerivedOperationStatus(order),
  )

  const withSnapshot = deps.viewModel.buildDashboardViewModel({
    orders: partial,
    operationalSnapshot: server.snapshot,
    products: [],
    selectedPeriod: PERIOD,
    now: FIXED_NOW,
  })

  assert.deepEqual(withSnapshot.operationalSummary, legacy.operationalSummary)
  assert.deepEqual(withSnapshot.actionRequired, legacy.actionRequired)
  assert.deepEqual(withSnapshot.pickingLists, legacy.pickingLists)
  assert.deepEqual(withSnapshot.recentOperations, legacy.recentOperations)
  // Huni, sayaç nesnesinden türer → otomatik tutarlı.
  assert.deepEqual(withSnapshot.operationFlow, legacy.operationFlow)
})

test('DASH-6: kısmi havuz + anlık görüntü YOKSA sayaçlar YANLIŞ olur (test gerçekten bir şey kanıtlıyor)', async (t) => {
  // Negatif kontrol. Anlık görüntü olmadan kısmi havuz FARKLI sonuç üretmeli;
  // aksi halde DASH-5 hiçbir şey kanıtlamıyor olurdu.
  const { pglite, db, org, deps } = await setup(120)
  t.after(() => pglite.close())
  const legacy = await legacyClientViewModel(deps, db, org.organizationId)
  const partialPool = await deps.persistence.listOrders(
    db, org.organizationId, { page: 1, pageSize: 25 }, undefined,
  )
  const partial = partialPool.orders.map((order) =>
    deps.orderStatus.withDerivedOperationStatus(order),
  )
  const withoutSnapshot = deps.viewModel.buildDashboardViewModel({
    orders: partial,
    products: [],
    selectedPeriod: PERIOD,
    now: FIXED_NOW,
  })
  assert.notDeepEqual(
    withoutSnapshot.operationalSummary,
    legacy.operationalSummary,
    'kısmi havuz anlık görüntüsüz FARKLI olmalı (negatif kontrol)',
  )
})

test('DASH-7: kiracı izolasyonu — anlık görüntü yalnız kendi organizasyonunu sayar', async (t) => {
  const { pglite, db, schema, org, deps } = await setup(60)
  t.after(() => pglite.close())
  const other = await seed(db, schema, 200, 'digerdash')

  deps.workspace.resetOrdersWorkspaceCache()
  deps.operational.resetDashboardProductCache()
  const mine = await deps.operational.buildDashboardOperationalSnapshot(
    db, org.organizationId, PERIOD, undefined, FIXED_NOW,
  )
  assert.equal(mine.scannedOrders, 60, 'yalnız kendi siparişleri taranır')

  deps.workspace.resetOrdersWorkspaceCache()
  deps.operational.resetDashboardProductCache()
  const theirs = await deps.operational.buildDashboardOperationalSnapshot(
    db, other.organizationId, PERIOD, undefined, FIXED_NOW,
  )
  assert.equal(theirs.scannedOrders, 200)
})

test('DASH-8: anlık görüntü, tam sipariş yükünün ÇOK ALTINDA kalır ve DOĞRUSAL BÜYÜMEZ', async (t) => {
  // DÜRÜSTLÜK NOTU: anlık görüntü SABİT boyutlu DEĞİLDİR. `pickingLists`
  // her ürün ailesi için toplanacak sipariş referanslarını taşır ve bu
  // bilgi operatörün İŞİDİR — kırpılamaz. Dolayısıyla "hiç büyümez" demek
  // YANLIŞ olurdu.
  //
  // Kanıtlanan iki gerçek şudur:
  //   1) Büyüme DOĞRUSAL DEĞİLDİR (5 kat sipariş → 5 kattan az gövde).
  //   2) Gövde, eski mimarinin tarayıcıya indirdiği TAM sipariş yükünün
  //      küçük bir kesridir.
  const small = await setup(100)
  t.after(() => small.pglite.close())
  const large = await setup(500)
  t.after(() => large.pglite.close())

  const measure = async (ctx) => {
    ctx.deps.workspace.resetOrdersWorkspaceCache()
    ctx.deps.operational.resetDashboardProductCache()
    const result = await ctx.deps.operational.buildDashboardOperationalSnapshot(
      ctx.db, ctx.org.organizationId, PERIOD, undefined, FIXED_NOW,
    )
    // ESKİ yolun tarayıcıya indirdiği yük: tam sipariş koleksiyonu.
    const legacyPayload = await ctx.deps.persistence.listOrdersForWorkspace(
      ctx.db, ctx.org.organizationId, undefined,
    )
    return {
      result,
      bytes: JSON.stringify(result.snapshot).length,
      legacyBytes: JSON.stringify(legacyPayload).length,
    }
  }

  const smallResult = await measure(small)
  const largeResult = await measure(large)
  assert.equal(smallResult.result.scannedOrders, 100)
  assert.equal(largeResult.result.scannedOrders, 500)

  const orderGrowth = 500 / 100
  const byteGrowth = largeResult.bytes / smallResult.bytes
  assert.ok(
    byteGrowth < orderGrowth,
    `büyüme doğrusal altı olmalı (sipariş ×${orderGrowth}, gövde ×${byteGrowth.toFixed(2)})`,
  )

  const ratio = largeResult.bytes / largeResult.legacyBytes
  assert.ok(
    ratio < 0.2,
    `anlık görüntü tam yükün %20'sinden küçük olmalı (${(ratio * 100).toFixed(1)}%: ` +
      `${largeResult.bytes} / ${largeResult.legacyBytes})`,
  )
})
