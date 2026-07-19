import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('4293 ham listing, barcode tekrar etse bile varyant kimliğiyle korunur', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const {
    dedupeProductsByVariantIdentity,
    mergeProductsWithCache,
    productVariantIdentity,
  } = await vite.ssrLoadModule('/src/services/orderWorkflowService.ts')

  const catalog = Array.from({ length: 4293 }, (_, index) =>
    product({
      id: `row-${index}`,
      externalVariantId: `listing-${index}`,
      barcode: `barcode-${index % 1154}`,
      productMainId: `parent-${Math.floor(index / 12)}`,
      color: index % 2 === 0 ? 'Yeşil' : 'Bordo',
      size: String(36 + (index % 4) * 2),
    }),
  )
  const deduped = dedupeProductsByVariantIdentity(catalog)
  const merged = mergeProductsWithCache(deduped, [])

  assert.equal(deduped.length, 4293)
  assert.equal(merged.length, 4293)
  assert.equal(new Set(merged.map(productVariantIdentity)).size, 4293)
})

test('aynı productMainId altındaki farklı barkod, renk ve beden varyantları ayrı kalır', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { dedupeProductsByVariantIdentity } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )
  const variants = [
    product({ externalVariantId: 'v1', barcode: 'B1', color: 'Yeşil', size: '38' }),
    product({ externalVariantId: 'v2', barcode: 'B2', color: 'Bordo', size: '38' }),
    product({ externalVariantId: 'v3', barcode: 'B3', color: 'Bordo', size: '40' }),
  ]
  assert.equal(dedupeProductsByVariantIdentity(variants).length, 3)
})

test('kısmi ürün senkronu son başarılı tam cache üzerine yazılmaz', async (t) => {
  const storage = memoryStorage()
  globalThis.window = { localStorage: storage }
  t.after(() => {
    delete globalThis.window
  })
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { OrderWorkflowService } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )
  let fetchResponse = {
    products: Array.from({ length: 5 }, (_, index) =>
      product({ id: `full-${index}`, externalVariantId: `full-${index}`, barcode: `FULL-${index}` }),
    ),
    source: 'real',
    message: 'complete',
    debug: productDebug({ expectedTotal: 5, fetchedCount: 5, status: 'COMPLETE' }),
  }
  const service = new OrderWorkflowService(
    { fetchProducts: async () => fetchResponse },
    {},
    {},
    {},
    { append: () => [] },
  )
  const config = { trendyol: { sellerId: 'seller-1' } }
  const complete = await service.fetchProducts(config)
  assert.equal(complete.products.length, 5)
  assert.equal(service.loadProductCatalog().metadata.syncStatus, 'COMPLETE')

  fetchResponse = {
    products: Array.from({ length: 2 }, (_, index) =>
      product({ id: `partial-${index}`, externalVariantId: `partial-${index}`, barcode: `PART-${index}` }),
    ),
    source: 'real',
    message: 'partial',
    debug: productDebug({
      expectedTotal: 5,
      fetchedCount: 2,
      status: 'PARTIAL',
      failedPages: [1],
    }),
  }
  const partial = await service.fetchProducts(config)
  assert.equal(partial.result.level, 'error')
  assert.equal(partial.result.productSyncDebug.cachePreserved, true)
  assert.equal(partial.products.length, 5)
  assert.deepEqual(
    service.loadProducts().map((entry) => entry.barcode),
    ['FULL-0', 'FULL-1', 'FULL-2', 'FULL-3', 'FULL-4'],
  )
})

test('eski şemasız 1154 kayıtlık cache tam katalog olarak hydrate edilmez', async (t) => {
  const storage = memoryStorage()
  globalThis.window = { localStorage: storage }
  t.after(() => {
    delete globalThis.window
  })
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { OrderWorkflowService, isValidProductCatalogCache } =
    await vite.ssrLoadModule('/src/services/orderWorkflowService.ts')
  const legacy = Array.from({ length: 1154 }, (_, index) =>
    product({ id: `legacy-${index}`, barcode: `LEG-${index}` }),
  )
  storage.setItem('cargoFlow_products_v3:seller-1', JSON.stringify(legacy))
  const service = new OrderWorkflowService({}, {}, {}, {}, { append: () => [] })
  service.setMarketplaceAccount('seller-1')
  assert.equal(service.loadProducts().length, 0)
  assert.equal(isValidProductCatalogCache(legacy), false)
})

test('frontend ve backend build revizyonu farklıysa mismatch uyarısı üretilir', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildRevisionMismatch } = await vite.ssrLoadModule(
    '/src/utils/buildRevision.ts',
  )
  assert.equal(buildRevisionMismatch('new123', 'old456'), true)
  assert.equal(buildRevisionMismatch('same123', 'same123'), false)
  assert.equal(buildRevisionMismatch('unknown', 'old456'), false)
})

function product(overrides = {}) {
  return {
    id: 'product',
    marketplace: 'Trendyol',
    externalVariantId: 'variant',
    externalProductId: 'content',
    productContentId: 'content',
    productMainId: 'same-parent',
    productCode: 'model',
    productName: 'Ürün',
    sku: 'sku',
    stockCode: 'stock',
    barcode: 'barcode',
    color: 'Yeşil',
    size: '38',
    images: ['https://cdn.example.com/product.jpg'],
    imageUrl: 'https://cdn.example.com/product.jpg',
    productImageUrl: 'https://cdn.example.com/product.jpg',
    ...overrides,
  }
}

function productDebug(overrides = {}) {
  return {
    expectedTotal: 0,
    fetchedCount: 0,
    rawApiRecordsCount: 0,
    normalizedProductsCount: 0,
    afterDedupCount: 0,
    afterMergeCount: 0,
    persistedProductsCount: 0,
    productsStoreCount: 0,
    fetchedPages: 1,
    expectedPages: 1,
    failedPages: [],
    requestedPageSize: 200,
    responsePageSize: 200,
    uniqueBarcodeCount: 0,
    uniqueProductContentIdCount: 0,
    uniqueProductMainIdCount: 0,
    uniqueExternalVariantIdCount: 0,
    uniqueVariantCount: 0,
    completenessRatio: 1,
    status: 'COMPLETE',
    ...overrides,
  }
}

function memoryStorage() {
  const entries = new Map()
  return {
    get length() {
      return entries.size
    },
    key(index) {
      return Array.from(entries.keys())[index] ?? null
    },
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null
    },
    setItem(key, value) {
      entries.set(key, String(value))
    },
    removeItem(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
  }
}
