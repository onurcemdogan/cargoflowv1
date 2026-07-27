import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

// FAZ 1 — Dashboard "Yenile" izolasyonu.
// Amaç: Dashboard yenileme AKIŞI yalnız (1) yerel DB reload (GET /api/orders),
// (2) analitik cache bypass, (3) analitik yeniden hesaplama yapar. Etiket
// oluşturma, desi doğrulaması, PrintPreview readiness, provider create, ZPL
// render veya /api/orders/sync ÇALIŞTIRMAZ. Aşağıdaki testler bu izolasyonu
// erişilebilir kesişme noktalarında (analitik servis fetch yüzeyi, dashboard
// banner sözleşmesi, saf view-model yeniden hesabı) doğrular.

const DESI_ERROR = 'Desi bilgisi eksik'
const SAFE_LOAD_ERROR =
  'Sipariş verileri yüklenemedi. Bağlantıyı kontrol edip tekrar deneyin.'

async function withVite(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  return vite
}

function analyticsOrdersPayload() {
  return {
    ok: true,
    orders: [],
    totalElements: 0,
    fetchedCount: 0,
    packageCount: 0,
    startDate: new Date(0).toISOString(),
    endDate: new Date(0).toISOString(),
  }
}

function analyticsClaimsPayload() {
  return {
    ok: true,
    claims: [],
    uniqueClaimCount: 0,
    affectedPackageCount: 0,
    amountBasis: 'test',
    startDate: new Date(0).toISOString(),
    endDate: new Date(0).toISOString(),
  }
}

// global fetch'i yakalayan mock: çağrılan tüm URL'leri kaydeder.
function installFetchSpy(payloadFactory) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      json: async () => payloadFactory(),
    }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

test('FAZ1-A: analitik orders yenilemesi YALNIZ /api/analytics/orders (refresh) çağırır; sync/label/create yok', async (t) => {
  const vite = await withVite(t)
  const service = await vite.ssrLoadModule(
    '/src/services/dashboardAnalyticsService.ts',
  )
  service.resetDashboardAnalyticsCache()
  const spy = installFetchSpy(analyticsOrdersPayload)
  try {
    await service.fetchDashboardAnalyticsOrders(
      new Date('2026-07-01T00:00:00Z'),
      new Date('2026-07-19T23:59:59Z'),
      { refresh: true },
    )
  } finally {
    spy.restore()
    service.resetDashboardAnalyticsCache()
  }
  assert.equal(spy.calls.length, 1)
  assert.match(spy.calls[0], /\/api\/analytics\/orders\?/)
  assert.match(spy.calls[0], /refresh=true/)
  // Yenileme sırasında operasyonel sync / label / create endpoint'i çağrılmaz.
  assert.ok(!spy.calls.some((url) => url.includes('/api/orders/sync')))
  assert.ok(!spy.calls.some((url) => /label|zpl|barcode|shipment/i.test(url)))
})

test('FAZ1-B: analitik claims yenilemesi YALNIZ /api/analytics/claims (refresh) çağırır', async (t) => {
  const vite = await withVite(t)
  const service = await vite.ssrLoadModule(
    '/src/services/dashboardAnalyticsService.ts',
  )
  service.resetDashboardAnalyticsCache()
  const spy = installFetchSpy(analyticsClaimsPayload)
  try {
    await service.fetchDashboardAnalyticsClaims(
      new Date('2026-07-01T00:00:00Z'),
      new Date('2026-07-19T23:59:59Z'),
      { refresh: true },
    )
  } finally {
    spy.restore()
    service.resetDashboardAnalyticsCache()
  }
  assert.equal(spy.calls.length, 1)
  assert.match(spy.calls[0], /\/api\/analytics\/claims\?/)
  assert.match(spy.calls[0], /refresh=true/)
  assert.ok(!spy.calls.some((url) => url.includes('/api/orders/sync')))
})

test('FAZ1-C: refresh=false kapsayan cache ağa çıkmaz; refresh=true cache bypass eder', async (t) => {
  const vite = await withVite(t)
  const service = await vite.ssrLoadModule(
    '/src/services/dashboardAnalyticsService.ts',
  )
  service.resetDashboardAnalyticsCache()
  const start = new Date('2026-07-01T00:00:00Z')
  const end = new Date('2026-07-19T23:59:59Z')
  const spy = installFetchSpy(analyticsOrdersPayload)
  try {
    // İlk yükleme: 1 ağ çağrısı.
    await service.fetchDashboardAnalyticsOrders(start, end, { refresh: false })
    assert.equal(spy.calls.length, 1)
    // Kapsayan aralık, refresh yok → ağa ÇIKMAZ (cache).
    await service.fetchDashboardAnalyticsOrders(start, end, { refresh: false })
    assert.equal(spy.calls.length, 1)
    // Yenile → cache bypass, tekrar ağ çağrısı ve refresh=true parametresi.
    await service.fetchDashboardAnalyticsOrders(start, end, { refresh: true })
    assert.equal(spy.calls.length, 2)
    assert.match(spy.calls[1], /refresh=true/)
  } finally {
    spy.restore()
    service.resetDashboardAnalyticsCache()
  }
})

test('FAZ1-D: buildDashboardViewModel yeniden hesabı desi=null ile HATA ATMAZ ve desi banner metni üretmez', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const printedOrder = {
    id: 'order-114',
    marketplace: 'Trendyol',
    orderNumber: '11400000001',
    packageId: 'PKG-114',
    shipmentPackageId: 'PKG-114',
    marketplaceStatus: 'Hazırlanıyor',
    operationStatus: 'LABEL_PRINTED',
    status: 'Etiket Basıldı',
    customerName: 'Test',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoTrackingNumber: '7270000000114',
    cargoProviderName: 'Sürat Kargo',
    totalAmount: 100,
    createdAt: '2026-07-19T10:00:00',
    orderDate: '2026-07-19T10:00:00',
    desi: null,
    hasPrintableLabel: true,
    items: [{ id: 'i1', productName: 'Ürün', quantity: 1, price: 100 }],
    shipment: { ozelKargoTakipNo: '7270000000114', hasPrintableLabel: true },
  }
  let model
  assert.doesNotThrow(() => {
    model = buildDashboardViewModel({
      orders: [printedOrder],
      selectedPeriod: { key: 'today' },
      now: new Date('2026-07-19T12:00:00'),
    })
  })
  assert.ok(Array.isArray(model.recentOperations))
  assert.equal(model.recentOperations.length, 1)
  // Yeniden hesap desi doğrulamasına girmez → desi hata metni yoktur.
  assert.ok(!JSON.stringify(model).includes(DESI_ERROR))
})

test('FAZ1-E: DashboardPage banner order-load hatasını gösterir; desi/label metni sızmaz', async (t) => {
  const vite = await withVite(t)
  const { DashboardPage } = await vite.ssrLoadModule('/src/pages/DashboardPage.tsx')
  const { defaultIntegrationConfig, defaultPrinterSettings } =
    await vite.ssrLoadModule('/src/services/integrationConfigService.ts')
  const html = renderToStaticMarkup(
    createElement(DashboardPage, {
      orders: [],
      products: [],
      integrationConfig: defaultIntegrationConfig,
      printerSettings: defaultPrinterSettings,
      apiDebugLogs: [],
      loading: false,
      error: SAFE_LOAD_ERROR,
      onRefresh: () => {},
      onNavigatePage: () => {},
      onNavigateOrders: () => {},
      onDownloadOrder: () => {},
      onPrintOrder: () => {},
      onCreateShipment: () => {},
      onTrackShipment: () => {},
      onDesiChange: () => {},
    }),
  )
  assert.ok(html.includes('Dashboard verileri yenilenemedi'))
  assert.ok(html.includes('Sipariş verileri yüklenemedi'))
  // Banner label iş akışı mesajı taşımaz.
  assert.ok(!html.includes(DESI_ERROR))
})

test('FAZ1-F: DashboardPage error=undefined iken "yenilenemedi" banner render edilmez', async (t) => {
  const vite = await withVite(t)
  const { DashboardPage } = await vite.ssrLoadModule('/src/pages/DashboardPage.tsx')
  const { defaultIntegrationConfig, defaultPrinterSettings } =
    await vite.ssrLoadModule('/src/services/integrationConfigService.ts')
  const html = renderToStaticMarkup(
    createElement(DashboardPage, {
      orders: [],
      products: [],
      integrationConfig: defaultIntegrationConfig,
      printerSettings: defaultPrinterSettings,
      apiDebugLogs: [],
      loading: false,
      error: undefined,
      onRefresh: () => {},
      onNavigatePage: () => {},
      onNavigateOrders: () => {},
      onDownloadOrder: () => {},
      onPrintOrder: () => {},
      onCreateShipment: () => {},
      onTrackShipment: () => {},
      onDesiChange: () => {},
    }),
  )
  assert.ok(!html.includes('Dashboard verileri yenilenemedi'))
})

test('FAZ1-G: DashboardPage LABEL_PRINTED + desi=null siparişte hiçbir desi/label hata metni göstermez', async (t) => {
  const vite = await withVite(t)
  const { DashboardPage } = await vite.ssrLoadModule('/src/pages/DashboardPage.tsx')
  const { defaultIntegrationConfig, defaultPrinterSettings } =
    await vite.ssrLoadModule('/src/services/integrationConfigService.ts')
  const printedOrder = {
    id: 'order-114',
    marketplace: 'Trendyol',
    orderNumber: '11400000001',
    packageId: 'PKG-114',
    shipmentPackageId: 'PKG-114',
    marketplaceStatus: 'Hazırlanıyor',
    operationStatus: 'LABEL_PRINTED',
    status: 'Etiket Basıldı',
    customerName: 'Test',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoTrackingNumber: '7270000000114',
    cargoProviderName: 'Sürat Kargo',
    totalAmount: 100,
    createdAt: '2026-07-19T10:00:00',
    orderDate: '2026-07-19T10:00:00',
    desi: null,
    hasPrintableLabel: true,
    items: [{ id: 'i1', productName: 'Ürün', quantity: 1, price: 100 }],
    shipment: { ozelKargoTakipNo: '7270000000114', hasPrintableLabel: true },
  }
  const html = renderToStaticMarkup(
    createElement(DashboardPage, {
      orders: [printedOrder],
      products: [],
      integrationConfig: defaultIntegrationConfig,
      printerSettings: defaultPrinterSettings,
      apiDebugLogs: [],
      loading: false,
      error: undefined,
      onRefresh: () => {},
      onNavigatePage: () => {},
      onNavigateOrders: () => {},
      onDownloadOrder: () => {},
      onPrintOrder: () => {},
      onCreateShipment: () => {},
      onTrackShipment: () => {},
      onDesiChange: () => {},
    }),
  )
  assert.ok(!html.includes(DESI_ERROR))
  assert.ok(!html.includes('Dashboard verileri yenilenemedi'))
  // Canonical LABEL_PRINTED "Etiket Basıldı" olarak görünür.
  assert.ok(html.includes('Etiket Basıldı'))
})

test('FAZ1-H: buildDashboardViewModel saf yeniden hesaptır (girdi mutasyonu yok, çift çağrı stabildir)', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const orders = [
    {
      id: 'order-1',
      marketplace: 'Trendyol',
      orderNumber: '11400000002',
      packageId: 'PKG-1',
      shipmentPackageId: 'PKG-1',
      marketplaceStatus: 'Created',
      operationStatus: 'NEW',
      status: 'Yeni',
      customerName: 'Test',
      city: 'İstanbul',
      totalAmount: 100,
      createdAt: '2026-07-19T10:00:00',
      orderDate: '2026-07-19T10:00:00',
      desi: null,
      items: [{ id: 'i1', productName: 'Ürün', quantity: 1, price: 100 }],
    },
  ]
  const frozen = structuredClone(orders)
  const first = buildDashboardViewModel({
    orders,
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })
  const second = buildDashboardViewModel({
    orders,
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })
  // Girdi mutasyona uğramaz (çift Yenile güvenli).
  assert.deepEqual(orders, frozen)
  // Aynı girdi → aynı operasyon özeti (deterministik yeniden hesap).
  assert.deepEqual(first.operationalSummary, second.operationalSummary)
})
