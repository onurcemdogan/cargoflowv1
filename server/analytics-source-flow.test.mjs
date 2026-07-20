import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'

const host = '127.0.0.1'

// A/B) Analytics endpoint'i tüm sayfaları birleştirir ve 120 kayıt
// üstünde veri kaybetmez; operational store'a yazmaz (sunucu tarafında
// sipariş persist YOKTUR, yalnız normalize edilmiş veri döner).
test('analytics endpoint tüm sayfaları cap olmadan birleştirir', async (t) => {
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (!url.pathname.endsWith('/orders')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'not found' }))
      return
    }
    const status = url.searchParams.get('status')
    const page = Number(url.searchParams.get('page') ?? 0)
    if (status === 'Delivered' && page < 2) {
      const content = Array.from({ length: 100 }, (_, index) =>
        buildPackage(page * 100 + index),
      )
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          content,
          page,
          size: 200,
          totalPages: 2,
          totalElements: 200,
        }),
      )
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({ content: [], page, size: 200, totalPages: 1, totalElements: 0 }),
    )
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())

  const configDir = mkdtempSync(join(tmpdir(), 'cargoflow-analytics-'))
  const apiPort = await getFreePort()
  const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CARGOFLOW_API_PORT: String(apiPort),
      CARGOFLOW_CONFIG_DIR: configDir,
      TRENDYOL_PROD_BASE_URL: `http://${host}:${mockPort}`,
      TRENDYOL_STAGE_BASE_URL: `http://${host}:${mockPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => apiProcess.kill())
  await waitForHealth(apiPort, apiProcess)

  // Kimlik bilgileri sunucunun şifreli local-config store'una (temp dizin)
  // yazılır; gerçek kullanıcı config'ine dokunulmaz.
  const putResponse = await fetch(
    `http://${host}:${apiPort}/api/local-config/integration`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CargoFlow-Client-Host': host,
      },
      body: JSON.stringify({
        config: {
          trendyol: {
            sellerId: 'SELLER-1',
            apiKey: 'api-key',
            apiSecret: 'api-secret',
            environment: 'prod',
            userAgentName: '',
          },
          surat: {},
        },
      }),
    },
  )
  assert.equal((await putResponse.json()).ok, true)

  const params = new URLSearchParams({
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-07-19T23:59:59.999Z',
  })
  const analyticsResponse = await fetch(
    `http://${host}:${apiPort}/api/analytics/orders?${params}`,
    { headers: { 'X-CargoFlow-Client-Host': host } },
  )
  const payload = await analyticsResponse.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.fetchedCount, 200, '120 üstü kayıpsız birleşmeli')
  assert.equal(payload.packageCount, 200)
  assert.equal(payload.orders.length, 200)
  assert.equal(payload.orders[0].marketplace, 'Trendyol')

  // Geçersiz tarih → 400; Sürat/create yan etkisi yok (GET, salt okuma).
  const badResponse = await fetch(
    `http://${host}:${apiPort}/api/analytics/orders?startDate=x&endDate=y`,
    { headers: { 'X-CargoFlow-Client-Host': host } },
  )
  assert.equal(badResponse.status, 400)
})

// C/D/E/F) Frontend service: storage'a yazmaz, persistOrders çağrısı yok
// (bağımsız modül), aynı/kapsanan aralık cache'ten döner, kapsam dışına
// çıkınca birleşik aralık için YENİ fetch yapılır.
test('analytics service cache ve read-only sözleşmesi', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { fetchDashboardAnalyticsOrders, resetDashboardAnalyticsCache } =
    await vite.ssrLoadModule('/src/services/dashboardAnalyticsService.ts')

  const storageWrites = []
  const previousWindow = globalThis.window
  globalThis.window = {
    location: { hostname: 'localhost' },
    localStorage: {
      getItem: () => null,
      setItem: (key) => storageWrites.push(key),
      removeItem: () => {},
    },
  }
  const previousFetch = globalThis.fetch
  const fetchCalls = []
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url))
    return {
      ok: true,
      json: async () => ({
        ok: true,
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-07-19T23:59:59.999Z',
        totalElements: 2,
        fetchedCount: 2,
        packageCount: 2,
        orders: [
          { id: 'a', orderNumber: 'A', packageId: 'PA', marketplace: 'Trendyol', items: [] },
          { id: 'b', orderNumber: 'B', packageId: 'PB', marketplace: 'Trendyol', items: [] },
        ],
      }),
    }
  }
  t.after(() => {
    globalThis.fetch = previousFetch
    globalThis.window = previousWindow
  })

  resetDashboardAnalyticsCache()
  const start = new Date('2026-07-10T00:00:00.000Z')
  const end = new Date('2026-07-12T23:59:59.999Z')
  const first = await fetchDashboardAnalyticsOrders(start, end)
  assert.equal(first.orders.length, 2)
  assert.equal(fetchCalls.length, 1, 'ilk çağrı ağa çıkar')

  // E) Aynı aralık cache'ten gelir.
  await fetchDashboardAnalyticsOrders(start, end)
  assert.equal(fetchCalls.length, 1, 'aynı aralık cache-hit olmalı')

  // Kapsanan dar aralık da cache'ten gelir.
  await fetchDashboardAnalyticsOrders(
    new Date('2026-07-11T00:00:00.000Z'),
    new Date('2026-07-11T23:59:59.999Z'),
  )
  assert.equal(fetchCalls.length, 1, 'kapsanan aralık cache-hit olmalı')

  // F) Kapsam dışına çıkınca birleşik aralık için yeni fetch yapılır.
  await fetchDashboardAnalyticsOrders(
    new Date('2026-06-01T00:00:00.000Z'),
    end,
  )
  assert.equal(fetchCalls.length, 2, 'kapsam dışı aralık yeni fetch yapmalı')
  assert.match(decodeURIComponent(fetchCalls[1]), /2026-06-01T00:00:00\.000Z/)

  // C/D) Hiçbir storage yazımı ve persistOrders çağrısı yok.
  assert.equal(storageWrites.length, 0)
})

// H/I/G) viewModel: satış alanları analytics verisinden (120 cap'siz),
// operasyon sayaçları operational store'dan; analytics yokken operasyon
// paneli çalışmaya devam eder.
test('dashboard satış=analytics, operasyon=store ayrımı', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const now = new Date('2026-07-19T12:00:00.000Z')
  const salesOrder = (index) => ({
    id: `analytics-${index}`,
    marketplace: 'Trendyol',
    externalOrderId: `A-${index}`,
    orderNumber: `A-${index}`,
    packageId: `APKG-${index}`,
    customerName: 'X',
    customerPhone: '',
    customerEmail: '',
    address: 'x',
    city: 'İstanbul',
    district: 'Fatih',
    marketplaceStatus: 'Delivered',
    operationStatus: 'DELIVERED',
    source: 'real',
    status: 'Teslim Edildi',
    totalAmount: 10,
    createdAt: '2026-07-05T10:00:00.000Z',
    orderDate: '2026-07-05T10:00:00.000Z',
    items: [{ id: `L-${index}`, productName: 'Ü', sku: 's', barcode: `b${index}`, quantity: 1, price: 10 }],
  })
  const operationalOrder = (index) => ({
    ...salesOrder(index),
    id: `ops-${index}`,
    orderNumber: `O-${index}`,
    packageId: `OPKG-${index}`,
    marketplaceStatus: 'Picking',
    operationStatus: 'READY_TO_SHIP',
    status: 'Yeni',
    orderDate: '2026-07-19T10:00:00.000Z',
    createdAt: '2026-07-19T10:00:00.000Z',
  })
  const analyticsOrders = Array.from({ length: 150 }, (_, i) => salesOrder(i))
  const operationalOrders = [operationalOrder(1), operationalOrder(2), operationalOrder(3)]

  const viewModel = buildDashboardViewModel({
    orders: operationalOrders,
    analyticsOrders,
    selectedPeriod: { key: 'month' },
    now,
  })
  const monthCard = viewModel.salesPeriodCards.find((card) => card.key === 'month')
  // B) 120 cap'i satış analitiğini artık SINIRLAMAZ.
  assert.equal(monthCard.packageCount, 150)
  assert.equal(viewModel.salesSummary.orderCount.value, 150)
  // I) Operasyon sayaçları operational store'dan.
  assert.equal(viewModel.operationalSummary.openOperations, 3)

  // G) Analytics yokken (hata durumu) operasyon paneli çalışır.
  const fallback = buildDashboardViewModel({
    orders: operationalOrders,
    selectedPeriod: { key: 'month' },
    now,
  })
  assert.equal(fallback.operationalSummary.openOperations, 3)
})

function buildPackage(index) {
  return {
    id: `PKG-${index}`,
    packageId: `PKG-${index}`,
    shipmentPackageId: `PKG-${index}`,
    orderNumber: `ORDER-${index}`,
    orderDate: Date.parse('2026-07-08T10:00:00.000Z'),
    status: 'Delivered',
    cargoProviderName: 'Sürat Kargo Marketplace',
    cargoProviderId: 27,
    cargoCompanyId: 27,
    cargoTrackingNumber: `7270031${String(index).padStart(9, '0')}`,
    customerFirstName: 'Müşteri',
    customerLastName: `${index}`,
    shipmentAddress: {
      fullAddress: `Adres ${index}`,
      city: 'İstanbul',
      district: 'Kadıköy',
      phone: '5550000000',
    },
    lines: [
      {
        id: `LINE-${index}`,
        productName: `Ürün ${index}`,
        barcode: `BARCODE-${index}`,
        sku: `SKU-${index}`,
        merchantSku: `MSKU-${index}`,
        quantity: 1,
        price: 100,
      },
    ],
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      resolve(server.address().port)
    })
  })
}

async function getFreePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForHealth(port, child) {
  const startedAt = Date.now()
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await fetch(`http://${host}:${port}/api/health`)
      if (response.ok) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`API server başlamadı. ${stderr}`)
}
