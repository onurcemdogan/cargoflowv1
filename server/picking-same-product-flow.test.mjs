import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'
import { randomBytes } from 'node:crypto'

// Kalıcı okuma yolu testi için hermetik şifreleme anahtarı.
process.env.ORDER_DATA_ENCRYPTION_KEY =
  process.env.ORDER_DATA_ENCRYPTION_KEY ?? randomBytes(32).toString('hex')

// TOPLANACAK ÜRÜNLER + AYNI ÜRÜN SİPARİŞİ.
//
// Bu paket YALNIZ operasyon görünürlüğü/filtrelemesini kilitler. Sürat
// etiket/footer aggregation'ı kapsam DIŞINDADIR ve buradan beslenmez:
// orada kimlik strict kalır (ürün + SKU + renk + BEDEN).

let vite

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
    // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
    // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
    // "server is being restarted or closed" hatası verir. SSR-only test
    // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
    // tarama tamamen kapatılır.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
})

after(async () => {
  await vite?.close()
})

const load = (path) => vite.ssrLoadModule(path)

const FAMILY = '/src/utils/orderProductFamily.ts'
const CLASSIFICATION = '/src/utils/orderClassification.ts'
const VIEW_MODEL = '/src/dashboard/dashboardViewModel.ts'

/** Aynı kanonik ürün (contentId), renk/beden dışarıdan verilir. */
function line({
  id = 'l1',
  contentId = 'C-100',
  color = 'Lacivert',
  size = '36',
  quantity = 1,
  sku = undefined,
  barcode = undefined,
  productName = 'Scuba Secil Detayli Tesettur Elbise',
} = {}) {
  return {
    id,
    productName,
    sku: sku ?? `SKU-${size}`,
    merchantSku: sku ?? `SKU-${size}`,
    barcode: barcode ?? `BC-${size}`,
    quantity,
    color,
    size,
    productContentId: contentId,
  }
}

/**
 * Varsayılan: LABEL_READY (etiket hazır, BASILMAMIŞ) → toplama kapsamında.
 * `stage` ile kapanmış durumlar üretilebilir.
 */
function order(id, items, overrides = {}) {
  return {
    id,
    orderNumber: `ORD-${id}`,
    marketplace: 'Trendyol',
    packageId: `PKG-${id}`,
    customerName: 'SENTETIK ALICI',
    city: 'İstanbul',
    district: 'Kadıköy',
    orderDate: '2026-08-01T10:00:00.000Z',
    status: 'Created',
    marketplaceStatus: 'Created',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    items,
    shipment: {
      provider: 'surat-kargo',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      dispatchRegistrationConfirmed: true,
      barcodeRaw: `^XA^FD${id}^FS^XZ`,
      barcode: `BARCODE-${id}`,
      zplReady: true,
      printEnabled: true,
    },
    ...overrides,
  }
}

const printed = (id, items) =>
  order(id, items, {
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
  })

async function pickingOf(orders) {
  const { buildDashboardViewModel } = await load(VIEW_MODEL)
  const model = buildDashboardViewModel({
    orders,
    products: [],
    selectedPeriod: { key: 'today' },
    now: new Date('2026-08-10T09:00:00.000Z'),
  })
  return model.pickingLists
}

function familyRow(picking, productNamePart = 'Scuba') {
  return picking.products.find((product) =>
    product.productName.includes(productNamePart),
  )
}

// ═══ PICKING ══════════════════════════════════════════════════════════════

test('PICKING-1: LABEL_PRINTED olmayan aktif sipariş listede', async () => {
  const picking = await pickingOf([order('a', [line({ quantity: 2 })])])
  const row = familyRow(picking)
  assert.ok(row, 'ürün ailesi satırı üretilmeli')
  assert.equal(row.quantity, 2)
  assert.equal(row.orderCount, 1)
})

test('PICKING-2: LABEL_PRINTED toplama hesabında YOK', async () => {
  const picking = await pickingOf([printed('a', [line({ quantity: 2 })])])
  assert.equal(picking.products.length, 0)
  assert.equal(picking.orderCount, 0)
  assert.equal(picking.totalQuantity, 0)
})

test('PICKING-3: iptal/teslim/iade/arşiv toplama hesabında YOK', async () => {
  const closed = [
    order('cancel', [line()], {
      status: 'Cancelled',
      marketplaceStatus: 'Cancelled',
      operationStatus: 'CANCELLED',
    }),
    order('delivered', [line()], {
      status: 'Delivered',
      marketplaceStatus: 'Delivered',
      operationStatus: 'DELIVERED',
    }),
    order('returned', [line()], {
      status: 'Returned',
      marketplaceStatus: 'Returned',
      operationStatus: 'RETURNED',
    }),
    order('archived', [line()], { archived: true, archivedAt: '2026-07-01' }),
  ]
  const picking = await pickingOf(closed)
  assert.equal(picking.products.length, 0, 'kapanmış siparişler toplanmaz')
})

test('PICKING-4: 36+40+42 tek ailede toplanır, beden kırılımı doğru', async () => {
  const picking = await pickingOf([
    order('a', [line({ size: '36', quantity: 9 })]),
    order('b', [line({ size: '40', quantity: 6 })]),
    order('c', [line({ size: '42', quantity: 10 })]),
  ])
  assert.equal(picking.products.length, 1, 'beden aileyi BÖLMEZ')
  const row = picking.products[0]
  assert.equal(row.quantity, 25)
  assert.equal(row.orderCount, 3)
  const bySize = Object.fromEntries(
    row.variants.map((variant) => [variant.size, variant.quantity]),
  )
  assert.deepEqual(bySize, { 36: 9, 40: 6, 42: 10 })
})

test('PICKING-5: aynı canonical ürün farklı renk → AYRI aile', async () => {
  const picking = await pickingOf([
    order('a', [line({ color: 'Lacivert', size: '36' })]),
    order('b', [line({ color: 'Bordo', size: '40' })]),
  ])
  assert.equal(picking.products.length, 2, 'renk ayrı üründür')
  assert.equal(new Set(picking.products.map((p) => p.key)).size, 2)
})

test('PICKING-6: baskıda atlanan sipariş listede KALIR', async () => {
  // 3 seçildi · 2 başarıyla LABEL_PRINTED · 1 atlandı (durum değişmedi).
  const picking = await pickingOf([
    printed('a', [line({ size: '36', quantity: 1 })]),
    printed('b', [line({ size: '40', quantity: 1 })]),
    order('c', [line({ size: '42', quantity: 1 })]),
  ])
  assert.equal(picking.orderCount, 1)
  const row = picking.products[0]
  assert.equal(row.quantity, 1)
  assert.deepEqual(
    row.orders.map((entry) => entry.orderId),
    ['c'],
  )
})

test('PICKING-7: başarılı LABEL_PRINTED adedi ANINDA düşürür', async () => {
  const before = await pickingOf([
    order('a', [line({ size: '36', quantity: 8 })]),
    order('b', [line({ size: '40', quantity: 2 })]),
  ])
  assert.equal(familyRow(before).quantity, 10)
  // Aynı veri kümesi, b baskıya gönderildi → yeniden hesap.
  const after = await pickingOf([
    order('a', [line({ size: '36', quantity: 8 })]),
    printed('b', [line({ size: '40', quantity: 2 })]),
  ])
  assert.equal(familyRow(after).quantity, 8, '10 → 8 düşmeli')
  assert.equal(familyRow(after).orderCount, 1)
})

test('PICKING-8: aynı bedende birden çok sipariş → adet ve DISTINCT sipariş doğru', async () => {
  const picking = await pickingOf([
    order('a', [line({ size: '42', quantity: 3 })]),
    order('b', [line({ size: '42', quantity: 4 })]),
  ])
  const row = picking.products[0]
  assert.equal(row.quantity, 7)
  assert.equal(row.orderCount, 2)
  const variant = row.variants.find((entry) => entry.size === '42')
  assert.equal(variant.quantity, 7)
  assert.equal(variant.orderCount, 2)
})

test('PICKING-9: kırpma SESSİZ değildir (gizlenen aile sayısı raporlanır)', async () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    order(`o${index}`, [
      line({
        contentId: `C-${index}`,
        productName: `Urun ${index}`,
        quantity: 60 - index,
      }),
    ]),
  )
  const picking = await pickingOf(many)
  assert.equal(picking.totalFamilyCount, 60)
  assert.equal(
    picking.hiddenFamilyCount,
    60 - picking.products.length,
    'gizlenen aile sayısı açıkça bildirilmeli',
  )
  assert.ok(picking.hiddenFamilyCount > 0)
})

test('PICKING-10: operasyon durum özeti kanonik aşamalardan türer', async () => {
  const picking = await pickingOf([
    order('ready', [line({ size: '36' })]),
    order('waiting', [line({ size: '40' })], {
      operationStatus: 'NEW',
      labelStatus: 'NONE',
      shipment: undefined,
    }),
  ])
  const row = picking.products[0]
  const stages = Object.fromEntries(
    row.stageBreakdown.map((entry) => [entry.stage, entry.count]),
  )
  assert.equal(stages.labelReady, 1)
  assert.ok(
    (stages.barcodeWaiting ?? 0) + (stages.open ?? 0) === 1,
    'barkod bekleyen sipariş kanonik aşamada sayılmalı',
  )
})

// ═══ SAME PRODUCT FILTER ══════════════════════════════════════════════════

const DATE_FILTER = { preset: 'all', timezone: 'Europe/Istanbul' }

async function visible(orders, overrides = {}) {
  const { buildVisibleOrders } = await load(CLASSIFICATION)
  return buildVisibleOrders({
    persistentOrders: orders,
    selectedTab: 'all',
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: DATE_FILTER,
    searchQuery: '',
    now: new Date('2026-08-10T09:00:00.000Z'),
    ...overrides,
  })
}

const idsOf = (result) => result.visibleOrders.map((order) => order.id).sort()

test('SAME-PRODUCT-1: 36/40/42 → üç sipariş de repeated', async () => {
  const orders = [
    order('a', [line({ size: '36' })]),
    order('b', [line({ size: '40' })]),
    order('c', [line({ size: '42' })]),
  ]
  const result = await visible(orders, { sameProductFilter: 'repeated' })
  assert.deepEqual(idsOf(result), ['a', 'b', 'c'])
})

test('SAME-PRODUCT-2: Lacivert vs Bordo AYRI grup', async () => {
  const orders = [
    order('a', [line({ color: 'Lacivert', size: '36' })]),
    order('b', [line({ color: 'Lacivert', size: '40' })]),
    order('c', [line({ color: 'Bordo', size: '40' })]),
  ]
  const repeated = await visible(orders, { sameProductFilter: 'repeated' })
  assert.deepEqual(idsOf(repeated), ['a', 'b'], 'Bordo eşleşmemeli')
  const unique = await visible(orders, { sameProductFilter: 'unique' })
  assert.deepEqual(idsOf(unique), ['c'])
})

test('SAME-PRODUCT-3: tek sipariş quantity=5 tekrar SAYILMAZ', async () => {
  const orders = [order('a', [line({ quantity: 5 })])]
  const repeated = await visible(orders, { sameProductFilter: 'repeated' })
  assert.deepEqual(idsOf(repeated), [], 'adet tekrar değildir')
  const unique = await visible(orders, { sameProductFilter: 'unique' })
  assert.deepEqual(idsOf(unique), ['a'])
})

test('SAME-PRODUCT-4: beden bazlı farklı SKU/barkod aynı grubu BOZMAZ', async () => {
  const orders = [
    order('a', [line({ size: '36', sku: 'SKU-A-36', barcode: 'BC-A-36' })]),
    order('b', [line({ size: '42', sku: 'SKU-A-42', barcode: 'BC-A-42' })]),
  ]
  const result = await visible(orders, { sameProductFilter: 'repeated' })
  assert.deepEqual(idsOf(result), ['a', 'b'])
})

test('SAME-PRODUCT-5: çok ürünlü sipariş listede BİR KEZ görünür', async () => {
  // 'multi' hem X hem Y ailesinde tekrar ediyor; yine de tek satır.
  const orders = [
    order('multi', [
      line({ id: 'x', contentId: 'C-X', size: '36' }),
      line({ id: 'y', contentId: 'C-Y', size: '40', productName: 'Abiye Gri' }),
    ]),
    order('x2', [line({ id: 'x', contentId: 'C-X', size: '38' })]),
    order('y2', [
      line({ id: 'y', contentId: 'C-Y', size: '42', productName: 'Abiye Gri' }),
    ]),
  ]
  const result = await visible(orders, { sameProductFilter: 'repeated' })
  const ids = result.visibleOrders.map((entry) => entry.id)
  assert.equal(ids.filter((id) => id === 'multi').length, 1, 'tekrar YOK')
  assert.deepEqual([...ids].sort(), ['multi', 'x2', 'y2'])
})

test('SAME-PRODUCT-6: Yeni Siparişler sekmesiyle doğru compose', async () => {
  const orders = [
    order('a', [line({ size: '36' })], {
      operationStatus: 'NEW',
      labelStatus: 'NONE',
      shipment: undefined,
    }),
    order('b', [line({ size: '40' })], {
      operationStatus: 'NEW',
      labelStatus: 'NONE',
      shipment: undefined,
    }),
    order('c', [line({ color: 'Bordo', size: '40' })], {
      operationStatus: 'NEW',
      labelStatus: 'NONE',
      shipment: undefined,
    }),
    order('d', [
      line({ contentId: 'C-999', productName: 'Baska Urun', size: '38' }),
    ]),
  ]
  const result = await visible(orders, {
    selectedTab: 'newOrders',
    sameProductFilter: 'repeated',
  })
  assert.deepEqual(idsOf(result), ['a', 'b'], 'C ve D görünmemeli')
})

test('SAME-PRODUCT-7: şehir/tarih/pazaryeri filtreleriyle doğru kesişim', async () => {
  const orders = [
    order('a', [line({ size: '36' })], { city: 'İstanbul' }),
    order('b', [line({ size: '40' })], { city: 'İstanbul' }),
    // Aynı ürün ama BAŞKA şehir: şehir filtresi kapsamı daralttığı için
    // 'c' hem görünmez hem de tekrar hesabına GİRMEZ.
    order('c', [line({ size: '42' })], { city: 'Ankara' }),
  ]
  const scoped = await visible(orders, {
    cityFilter: 'İstanbul',
    sameProductFilter: 'repeated',
  })
  assert.deepEqual(idsOf(scoped), ['a', 'b'])

  // Şehir Ankara + repeated: kapsamda tek sipariş kalır → tekrar YOK.
  const ankara = await visible(orders, {
    cityFilter: 'Ankara',
    sameProductFilter: 'repeated',
  })
  assert.deepEqual(idsOf(ankara), [])
})

test('SAME-PRODUCT-8: mevcut filtre davranışları BOZULMAZ (all = değişmez)', async () => {
  const orders = [
    order('a', [line({ size: '36' })]),
    order('b', [line({ size: '40' })]),
  ]
  const base = await visible(orders)
  const explicit = await visible(orders, { sameProductFilter: 'all' })
  assert.deepEqual(idsOf(base), idsOf(explicit))
  assert.equal(base.visibleOrders.length, 2)
})

// ═══ CANLI DURUM SENARYOSU ════════════════════════════════════════════════

test('LIVE-RECOMPUTE: A/B basıldı, C atlandı → toplama YALNIZ C, filtre yeniden hesaplanır', async () => {
  const initial = [
    order('a', [line({ size: '36', quantity: 1 })]),
    order('b', [line({ size: '40', quantity: 1 })]),
    order('c', [line({ size: '42', quantity: 1 })]),
  ]
  const startPicking = await pickingOf(initial)
  assert.equal(startPicking.orderCount, 3)
  const startRepeated = await visible(initial, {
    sameProductFilter: 'repeated',
  })
  assert.deepEqual(idsOf(startRepeated), ['a', 'b', 'c'])

  // A ve B başarıyla LABEL_PRINTED; C atlandı (durumu değişmedi).
  const afterPrint = [
    printed('a', [line({ size: '36', quantity: 1 })]),
    printed('b', [line({ size: '40', quantity: 1 })]),
    order('c', [line({ size: '42', quantity: 1 })]),
  ]
  const endPicking = await pickingOf(afterPrint)
  assert.equal(endPicking.orderCount, 1, 'yalnız C toplanacak')
  assert.deepEqual(
    endPicking.products[0].orders.map((entry) => entry.orderId),
    ['c'],
  )
  assert.equal(endPicking.totalQuantity, 1, 'ESKİ state gösterilmemeli')
})

// ═══ ETİKET AGGREGATION SÖZLEŞMESİ (REGRESYON) ════════════════════════════

test('LABEL-AGG-UNTOUCHED: Sürat footer kimliği BEDEN dâhil strict kalır', async () => {
  const { aggregateProductLineItems } = await load(
    '/src/utils/suratZplProductLine.ts',
  )
  const lines = aggregateProductLineItems([
    { productName: 'Elbise', sku: 'SKU-1', color: 'Lacivert', size: '36', quantity: 1 },
    { productName: 'Elbise', sku: 'SKU-1', color: 'Lacivert', size: '42', quantity: 1 },
  ])
  assert.equal(
    lines.length,
    2,
    'etiket tarafında beden AYRI kalemdir (operasyon gruplaması sızmamalı)',
  )
})

test('FAMILY-KEY: beden anahtarda YOK, renk anahtarda VAR, SKU eşitlik anahtarı DEĞİL', async () => {
  const { resolveProductFamilyIdentity } = await load(FAMILY)
  const a = resolveProductFamilyIdentity(line({ size: '36', sku: 'SKU-A' }))
  const b = resolveProductFamilyIdentity(line({ size: '42', sku: 'SKU-B' }))
  const bordo = resolveProductFamilyIdentity(line({ color: 'Bordo' }))
  assert.equal(a.key, b.key, 'beden/SKU aileyi bölmemeli')
  assert.notEqual(a.key, bordo.key, 'renk aileyi bölmeli')
  assert.equal(a.source, 'productContentId')
  assert.ok(!a.key.includes('36') && !a.key.includes('sku'))
})

test('FAMILY-FALLBACK: kanonik kimlik yoksa ad+renk, beden yine YOK', async () => {
  const { resolveProductFamilyIdentity } = await load(FAMILY)
  const base = { productName: 'Taşlı  Simli Abiye', color: 'Gri', quantity: 1 }
  const a = resolveProductFamilyIdentity({ ...base, size: '38' })
  const b = resolveProductFamilyIdentity({ ...base, size: '42' })
  // Anlamsız boşluk/büyük-küçük farkı aileyi BÖLMEZ (fuzzy DEĞİL, normalize).
  const c = resolveProductFamilyIdentity({
    ...base,
    productName: 'TAŞLI SİMLİ ABİYE',
    size: '40',
  })
  assert.equal(a.key, b.key)
  assert.equal(a.key, c.key)
  assert.equal(a.source, 'nameColorFallback')
})

test('PERF: 4000 sipariş tek geçişte indekslenir (O(N·I))', async () => {
  const { buildProductFamilyIndex, buildRepeatedProductOrderIds } =
    await load(FAMILY)
  const orders = Array.from({ length: 4000 }, (_, index) =>
    order(`o${index}`, [
      line({
        contentId: `C-${index % 200}`,
        size: String(36 + (index % 5) * 2),
        quantity: 1,
      }),
    ]),
  )
  const startedAt = process.hrtime.bigint()
  const families = buildProductFamilyIndex(orders)
  const repeated = buildRepeatedProductOrderIds(orders)
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  assert.equal(families.length, 200)
  assert.equal(repeated.size, 4000)
  assert.ok(elapsedMs < 1500, `indeksleme çok yavaş: ${elapsedMs.toFixed(1)} ms`)
})

// ═══ GÖRÜNÜM GRUPLAMASI (filtre semantiği DEĞİŞMEZ) ═══════════════════════

async function grouped(orders) {
  const { groupOrdersBySameProductFamily } = await load(FAMILY)
  return groupOrdersBySameProductFamily(orders)
}

test('SAME-PRODUCT-GROUP-1: A/B/C aynı aile → arka arkaya ve TEK grup', async () => {
  // Araya başka ürün girmiş "normal sipariş sırası".
  const other = order('z', [
    line({ contentId: 'C-999', productName: 'Baska Urun', size: '38' }),
  ])
  const input = [
    order('a', [line({ size: '36' })]),
    other,
    order('b', [line({ size: '40' })]),
    order('c', [line({ size: '42' })]),
  ]
  const result = await grouped(input)
  const ids = result.orders.map((entry) => entry.id)
  assert.deepEqual(ids, ['a', 'b', 'c', 'z'], 'aile bitişik olmalı')

  const family = result.groups[0]
  assert.equal(family.orderCount, 3)
  assert.equal(family.totalQuantity, 3)
  assert.deepEqual(family.sizes, ['36', '40', '42'])
  // Üç sipariş de AYNI başlığı paylaşır.
  const keys = new Set(['a', 'b', 'c'].map((id) => result.headerByOrderId.get(id).key))
  assert.equal(keys.size, 1)
})

test('SAME-PRODUCT-GROUP-2: aynı model Bordo AYRI grup', async () => {
  const result = await grouped([
    order('a', [line({ color: 'Lacivert', size: '36' })]),
    order('d', [line({ color: 'Bordo', size: '40' })]),
    order('b', [line({ color: 'Lacivert', size: '40' })]),
  ])
  assert.equal(result.groups.length, 2, 'renk ayrı grup')
  const lacivert = result.headerByOrderId.get('a').key
  assert.equal(result.headerByOrderId.get('b').key, lacivert)
  assert.notEqual(result.headerByOrderId.get('d').key, lacivert)
  // Bordo satırı Lacivert grubunun ARASINA girmez.
  assert.deepEqual(result.orders.map((entry) => entry.id), ['a', 'b', 'd'])
})

test('SAME-PRODUCT-GROUP-3: beden grup anahtarına GİRMEZ', async () => {
  const result = await grouped([
    order('a', [line({ size: '36' })]),
    order('b', [line({ size: '42' })]),
  ])
  assert.equal(result.groups.length, 1)
  assert.ok(!result.groups[0].key.includes('36'))
  assert.ok(!result.groups[0].key.includes('42'))
})

test('SAME-PRODUCT-GROUP-4: çok ürünlü sipariş TEK grupta, TEK kez', async () => {
  const input = [
    order('multi', [
      line({ id: 'x', contentId: 'C-X', size: '36' }),
      line({ id: 'y', contentId: 'C-Y', size: '40', productName: 'Abiye Gri' }),
    ]),
    order('x2', [line({ id: 'x', contentId: 'C-X', size: '38' })]),
    order('x3', [line({ id: 'x', contentId: 'C-X', size: '40' })]),
    order('y2', [
      line({ id: 'y', contentId: 'C-Y', size: '42', productName: 'Abiye Gri' }),
    ]),
  ]
  const result = await grouped(input)
  const ids = result.orders.map((entry) => entry.id)
  assert.equal(ids.length, 4, 'sipariş sayısı değişmez')
  assert.equal(ids.filter((id) => id === 'multi').length, 1, 'tek kez')
  // Birincil aile = kapsamda EN ÇOK siparişi olan (C-X: 3 sipariş).
  assert.equal(
    result.headerByOrderId.get('multi').key,
    result.headerByOrderId.get('x2').key,
  )
})

test('SAME-PRODUCT-GROUP-5: gruplama KÜMEYİ değiştirmez, yalnız sırayı', async () => {
  const input = [
    order('a', [line({ size: '36' })]),
    order('z', [line({ contentId: 'C-999', productName: 'Tekil', size: '38' })]),
    order('b', [line({ size: '40' })]),
  ]
  const result = await grouped(input)
  assert.deepEqual(
    result.orders.map((entry) => entry.id).sort(),
    input.map((entry) => entry.id).sort(),
    'sipariş eklenmez/çıkarılmaz',
  )
})

test('SAME-PRODUCT-GROUP-6: grup İÇİNDE mevcut sıralama KORUNUR (stabil)', async () => {
  const result = await grouped([
    order('c', [line({ size: '42' })]),
    order('a', [line({ size: '36' })]),
    order('b', [line({ size: '40' })]),
  ])
  assert.deepEqual(
    result.orders.map((entry) => entry.id),
    ['c', 'a', 'b'],
    'giriş sırası grup içinde bozulmamalı',
  )
})

test('SAME-PRODUCT-GROUP-7: filtre KAPSAMI değişmedi (all → gruplama yok)', async () => {
  // Gruplama YALNIZ sunumdur: buildVisibleOrders sonucu aynı kalır.
  const orders = [
    order('a', [line({ size: '36' })]),
    order('b', [line({ size: '40' })]),
    order('z', [line({ contentId: 'C-999', productName: 'Tekil', size: '38' })]),
  ]
  const repeated = await visible(orders, { sameProductFilter: 'repeated' })
  assert.deepEqual(idsOf(repeated), ['a', 'b'])
  const result = await grouped(repeated.visibleOrders)
  assert.deepEqual(result.orders.map((entry) => entry.id), ['a', 'b'])
})

// ═══ YERLEŞİM SÖZLEŞMESİ (SALT SUNUM) ═════════════════════════════════════

test('PICKING-UX-LAYOUT: Toplanacak Ürünler TAM GENİŞLİK, dar sağ kolon YOK', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync('src/index.css', 'utf8')
  assert.ok(
    css.includes('.dashboard-picking-card { grid-column: span 12; }'),
    'picking kartı 12 kolon (tam genişlik) olmalı',
  )
  assert.ok(
    !css.includes('.dashboard-picking-card { grid-column: span 4; }'),
    'dar sağ kolon (span 4) kaldırılmalı',
  )
  assert.ok(
    !css.includes('max-height: 340px'),
    'küçük iç scroll penceresi kaldırılmalı',
  )
  // Operasyon Akışı korunur ve kendi satırında tam genişliktir.
  assert.ok(css.includes('.dashboard-operation-flow-card { grid-column: span 12; }'))

  const page = readFileSync('src/pages/DashboardPage.tsx', 'utf8')
  const opsIndex = page.indexOf('dashboard-analytics-row-ops')
  const pickingIndex = page.indexOf('dashboard-picking-row')
  assert.ok(opsIndex > 0 && pickingIndex > 0, 'iki bölüm de bulunmalı')
  assert.ok(
    opsIndex < pickingIndex,
    "Toplanacak Ürünler, Operasyon Akışının ALTINDA olmalı",
  )
  // Operasyon Akışı kaldırılmadı.
  assert.ok(page.includes('title="Operasyon Akışı"'))
})

test('PICKING-UX-PURE: sunum bileşeni İŞ KURALI içermez', async () => {
  const { readFileSync } = await import('node:fs')
  // Yorum satırları AYIKLANIR: sözleşme KODA bakar, açıklamaya değil.
  const card = readFileSync('src/components/PickingProductsCard.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((row) => !row.trim().startsWith('//'))
    .join('\n')
  for (const forbidden of [
    'isPickingEligible',
    'resolveProductFamilyKey',
    'buildProductFamilyIndex',
    'classifyOrderForTabs',
    'LABEL_PRINTED',
    'fetch(',
  ]) {
    assert.ok(
      !card.includes(forbidden),
      `sunum bileşeni ${forbidden} kullanmamalı`,
    )
  }
  // Hazır veriyi yeniden gruplayan/filtreleyen tarama YOK.
  assert.ok(!card.includes('orders.filter('), 'yeni sipariş taraması yok')
  assert.ok(!card.includes('products.filter('), 'yeni ürün taraması yok')
})

// ═══ BEDEN ÇÖZÜMLEME (SUNUM) ══════════════════════════════════════════════
//
// ÜRETİM HATASI: tüm beden chip'leri "Bedensiz" görünüyordu. Ürün ailesi
// mantığı DOĞRUYDU; kayıp yalnız beden GÖSTERİM kaynağındaydı.

/** Kalıcı okuma yolundaki gerçek durum: size yok, variantAttributes boş. */
function persistedLine({
  id = 'l1',
  contentId = 'C-100',
  productSize = '42',
  quantity = 1,
  sku = undefined,
  barcode = undefined,
  productName = 'Scuba Secil Detayli Tesettur Elbise',
  color = 'Lacivert',
} = {}) {
  return {
    id,
    productName,
    sku: sku ?? `SKU-${productSize}`,
    merchantSku: sku ?? `SKU-${productSize}`,
    barcode: barcode ?? `BC-${productSize}`,
    quantity,
    color,
    // size YOK · variantAttributes BOŞ  ← hatanın üretim koşulu
    variantAttributes: [],
    productContentId: contentId,
    rawLine: { productSize },
  }
}

test('SIZE-1: size yok + variantAttributes boş + rawLine.productSize=42 → 42', async () => {
  const picking = await pickingOf([order('a', [persistedLine({ quantity: 6 })])])
  const row = picking.products[0]
  assert.equal(row.variants.length, 1)
  assert.equal(row.variants[0].size, '42', 'beden ham satırdan çözülmeli')
  assert.notEqual(row.variants[0].size, 'Bedensiz')
  assert.equal(row.variants[0].quantity, 6)
})

test('SIZE-1b: sipariş düzeyi rawOrder.lines[].productSize de çözülür', async () => {
  // Kalemde rawLine İLİŞTİRİLMEMİŞ; beden yalnız sipariş ham gövdesinde.
  const item = persistedLine({ quantity: 3 })
  delete item.rawLine
  const picking = await pickingOf([
    order('a', [item], {
      rawOrder: { lines: [{ barcode: item.barcode, productSize: '42' }] },
    }),
  ])
  assert.equal(picking.products[0].variants[0].size, '42')
})

test('SIZE-2: 36+40+42 TEK aile, ÜÇ beden kırılımı', async () => {
  const picking = await pickingOf([
    order('a', [persistedLine({ id: 'a1', productSize: '36', quantity: 4 })]),
    order('b', [persistedLine({ id: 'b1', productSize: '40', quantity: 5 })]),
    order('c', [persistedLine({ id: 'c1', productSize: '42', quantity: 6 })]),
  ])
  assert.equal(picking.products.length, 1, 'beden aileyi BÖLMEZ')
  const row = picking.products[0]
  assert.equal(row.quantity, 15)
  assert.equal(row.orderCount, 3)
  const bySize = Object.fromEntries(
    row.variants.map((variant) => [variant.size, variant.quantity]),
  )
  assert.deepEqual(bySize, { 36: 4, 40: 5, 42: 6 })
})

test('SIZE-3: beden bazlı farklı SKU/barkod aileyi BÖLMEZ', async () => {
  const picking = await pickingOf([
    order('a', [
      persistedLine({
        id: 'a1',
        productSize: '36',
        sku: 'SKU-A-36',
        barcode: 'BC-A-36',
      }),
    ]),
    order('b', [
      persistedLine({
        id: 'b1',
        productSize: '42',
        sku: 'SKU-A-42',
        barcode: 'BC-A-42',
      }),
    ]),
  ])
  assert.equal(picking.products.length, 1)
  assert.deepEqual(
    picking.products[0].variants.map((variant) => variant.size).sort(),
    ['36', '42'],
  )
})

test('SIZE-4: çok ürünlü siparişte bedenler KARIŞMAZ', async () => {
  const itemA = persistedLine({
    id: 'la',
    contentId: 'C-X',
    productSize: '36',
    productName: 'Urun X',
  })
  const itemB = persistedLine({
    id: 'lb',
    contentId: 'C-Y',
    productSize: '42',
    productName: 'Urun Y',
  })
  delete itemA.rawLine
  delete itemB.rawLine
  const picking = await pickingOf([
    order('multi', [itemA, itemB], {
      rawOrder: {
        lines: [
          { barcode: itemA.barcode, productSize: '36' },
          { barcode: itemB.barcode, productSize: '42' },
        ],
      },
    }),
  ])
  const x = picking.products.find((entry) => entry.productName === 'Urun X')
  const y = picking.products.find((entry) => entry.productName === 'Urun Y')
  assert.equal(x.variants[0].size, '36')
  assert.equal(y.variants[0].size, '42')
})

test('SIZE-4b: AYNI contentId iki bedende → belirsiz anahtar KULLANILMAZ', async () => {
  // "İlk productSize'ı hepsine ver" TÜRÜ geri düşüş YOK: yanlış beden
  // göstermektense Bedensiz doğrudur.
  const itemA = persistedLine({ id: 'la', barcode: '', sku: 'AYNI' })
  const itemB = persistedLine({ id: 'lb', barcode: '', sku: 'AYNI' })
  delete itemA.rawLine
  delete itemB.rawLine
  const picking = await pickingOf([
    order('multi', [itemA, itemB], {
      rawOrder: {
        lines: [
          { merchantSku: 'AYNI', productSize: '36' },
          { merchantSku: 'AYNI', productSize: '42' },
        ],
      },
    }),
  ])
  const sizes = picking.products[0].variants.map((variant) => variant.size)
  assert.deepEqual(sizes, ['Bedensiz'], 'belirsiz eşleşmede beden atanmaz')
})

test('SIZE-5: hiçbir yapılandırılmış beden yoksa Bedensiz', async () => {
  const item = persistedLine({ quantity: 2 })
  delete item.rawLine
  const picking = await pickingOf([order('a', [item])])
  assert.equal(picking.products[0].variants[0].size, 'Bedensiz')
})

test('SIZE-6: ÜRÜN ADI beden kaynağı DEĞİLDİR', async () => {
  const item = persistedLine({
    productName: 'Scuba Elbise SCUBA-SEC01, 42',
    quantity: 1,
  })
  delete item.rawLine
  const picking = await pickingOf([order('a', [item])])
  assert.equal(
    picking.products[0].variants[0].size,
    'Bedensiz',
    'addaki sayı beden sanılmamalı',
  )
})

test('SIZE-7: variantAttributes Beden niteliği çözülür', async () => {
  const item = persistedLine({ quantity: 1 })
  delete item.rawLine
  item.variantAttributes = [{ attributeName: 'Beden', attributeValue: '40' }]
  const picking = await pickingOf([order('a', [item])])
  assert.equal(picking.products[0].variants[0].size, '40')
})

test('SIZE-KEY-UNCHANGED: beden çözülse de AİLE ANAHTARI aynı kalır', async () => {
  const { resolveProductFamilyIdentity } = await load(FAMILY)
  const a = resolveProductFamilyIdentity(persistedLine({ productSize: '36' }))
  const b = resolveProductFamilyIdentity(persistedLine({ productSize: '42' }))
  assert.equal(a.key, b.key, 'beden aile anahtarına GİRMEZ')
  assert.ok(!a.key.includes('36') && !a.key.includes('42'))
})

test('SIZE-PERSIST: rowToOrder bedeni SAKLI ham gövdeden geri kurar', async () => {
  // ÜRETİM YOLU: sipariş DB'den okunurken satırda `size` alanı YOKTU.
  const { toLineInsertValues, rowToOrder } = await load(
    '/server/orders/orderMapper.ts',
  )
  const rows = toLineInsertValues('org-1', 'order-1', {
    items: [
        {
          id: 'ty_line_1',
          productName: 'Scuba Secil',
          merchantSku: 'SKU-42',
          barcode: 'BC-42',
          quantity: 6,
          color: 'Lacivert',
          size: '42',
          variantAttributes: [],
        productContentId: 'C-100',
      },
    ],
  })
  // DB kolonlarında beden YOK; yalnız şifreli ham gövdede saklı.
  assert.equal(rows[0].size, undefined, 'ayrı beden kolonu YOK (migration yok)')
  assert.ok(rows[0].rawPayloadEncrypted, 'ham gövde saklanmış olmalı')

  const domain = rowToOrder({ id: 'order-1', orderNumber: 'ORD-1' }, rows)
  assert.equal(domain.items[0].size, '42', 'beden okuma yolunda geri gelmeli')
  assert.equal(domain.items[0].color, 'Lacivert')
})

// ═══ ARŞİV ETKİSİ (ARCHIVE-7) ═════════════════════════════════════════════

test('ARCHIVE-7: arşivlenmiş sipariş picking/same-product AKTİF hesaplarına GİRMEZ', async () => {
  const archived = order('arch', [line({ size: '36', quantity: 5 })], {
    archivedAt: '2026-08-01T00:00:00.000Z',
  })
  const active = order('act', [line({ size: '40', quantity: 2 })])

  const picking = await pickingOf([archived, active])
  assert.equal(picking.orderCount, 1, 'yalnız aktif sipariş toplanır')
  assert.equal(picking.totalQuantity, 2)
  assert.deepEqual(
    picking.products[0].orders.map((entry) => entry.orderId),
    ['act'],
  )

  // Same-product kapsamı da arşivliyi görmemeli (aktif sekme kapsamında).
  const repeated = await visible([archived, active], {
    selectedTab: 'newOrders',
    sameProductFilter: 'repeated',
  })
  assert.ok(
    !idsOf(repeated).includes('arch'),
    'arşivli sipariş aktif tekrar hesabına girmemeli',
  )
})
