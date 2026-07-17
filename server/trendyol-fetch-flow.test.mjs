import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import test from 'node:test'

const host = '127.0.0.1'

test('Trendyol sipariş senkronizasyonu tüm statü sayfalarını çekip parse eder', async (t) => {
  const requests = []
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    requests.push({
      path: url.pathname,
      status: url.searchParams.get('status') ?? '',
      page: Number(url.searchParams.get('page') ?? 0),
      size: Number(url.searchParams.get('size') ?? 0),
      orderByField: url.searchParams.get('orderByField') ?? '',
      orderByDirection: url.searchParams.get('orderByDirection') ?? '',
    })

    if (!url.pathname.endsWith('/orders')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'not found' }))
      return
    }

    const requestedStatus = url.searchParams.get('status')
    const status = requestedStatus ?? 'UNFILTERED'
    const page = Number(url.searchParams.get('page') ?? 0)
    const content = buildPageContent(status, page)
    const totalPages = status === 'UNFILTERED' ? 1 : 2
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        content,
        page,
        size: Number(url.searchParams.get('size') ?? 1),
        totalPages,
        totalElements:
          status === 'Created' ? 2 : status === 'UNFILTERED' ? 2 : 1,
      }),
    )
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())

  const apiPort = await getFreePort()
  const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CARGOFLOW_API_PORT: String(apiPort),
      TRENDYOL_PROD_BASE_URL: `http://${host}:${mockPort}`,
      TRENDYOL_STAGE_BASE_URL: `http://${host}:${mockPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => apiProcess.kill())
  await waitForHealth(apiPort, apiProcess)

  const response = await postJson(apiPort, '/api/trendyol/orders/fetch', {
    credentials: {
      sellerId: 'SELLER-1',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      environment: 'prod',
    },
    query: {
      startDate: Date.parse('2026-07-01T00:00:00.000Z'),
      endDate: Date.parse('2026-07-08T23:59:59.000Z'),
      size: 1,
    },
  })

  assert.equal(response.ok, true)
  assert.equal(response.orders.length, 4)
  assert.equal(response.debug.rawOrdersCount, 4)
  assert.equal(response.debug.normalizedOrdersCount, 4)
  assert.equal(response.debug.totalLineCount, 4)
  assert.deepEqual(
    response.orders.map((order) => order.packageId).sort(),
    [
      'PKG-CREATED-0',
      'PKG-CREATED-1',
      'PKG-HIDDEN-CREATED',
      'PKG-PICKING-0',
    ],
  )
  assert.equal(
    response.orders.find((order) => order.packageId === 'PKG-CREATED-1')
      ?.items[0]?.imageUrl,
    'https://cdn.example.com/PKG-CREATED-1.jpg',
  )
  assert.ok(
    requests.some((request) => request.status === '' && request.page === 0),
    'Statü filtresinin kaçırdığı yeni paketler için filtresiz güvenlik ağı çağrılmalı.',
  )
  assert.equal(response.debug.fetchDebug.unfilteredFallback.ok, true)
  assert.equal(response.debug.fetchDebug.unfilteredFallback.addedCount, 1)
  assert.ok(
    requests.some(
      (request) => request.status === 'Created' && request.page === 0,
    ),
  )
  assert.ok(
    requests.some(
      (request) => request.status === 'Created' && request.page === 1,
    ),
  )
  assert.ok(
    requests.some(
      (request) => request.status === 'Picking' && request.page === 0,
    ),
  )
  assert.ok(
    requests.some(
      (request) => request.status === 'Picking' && request.page === 1,
    ),
  )
  assert.ok(
    requests.some(
      (request) => request.status === 'Shipped' && request.page === 0,
    ),
    'Statü verilmediğinde Shipped kayıtları da güncellenmeli.',
  )
  assert.ok(
    requests.some(
      (request) => request.status === 'Delivered' && request.page === 0,
    ),
    'Statü verilmediğinde Delivered kayıtları da güncellenmeli.',
  )
  assert.ok(
    requests.some(
      (request) => request.status === 'Cancelled' && request.page === 0,
    ),
    'Statü verilmediğinde iptal kayıtları da güncellenmeli.',
  )
  assert.ok(
    response.debug.statusRequests.every((entry) =>
      Array.isArray(entry.pageRequests),
    ),
  )
})

function buildPageContent(status, page) {
  if (status === 'UNFILTERED' && page === 0) {
    return [
      buildPackage({
        status: 'Created',
        suffix: 'CREATED-0',
        packageId: 'PKG-CREATED-0',
      }),
      buildPackage({
        status: 'Created',
        suffix: 'HIDDEN-CREATED',
        packageId: 'PKG-HIDDEN-CREATED',
      }),
    ]
  }
  if (status === 'Created') {
    return [
      buildPackage({
        status,
        suffix: `CREATED-${page}`,
        packageId: `PKG-CREATED-${page}`,
      }),
    ]
  }
  if (status === 'Picking' && page === 0) {
    return [
      buildPackage({
        status,
        suffix: 'PICKING-0',
        packageId: 'PKG-PICKING-0',
      }),
    ]
  }
  return []
}

function buildPackage({ status, suffix, packageId }) {
  return {
    id: packageId,
    packageId,
    shipmentPackageId: packageId,
    orderNumber: `ORDER-${suffix}`,
    orderDate: Date.parse('2026-07-08T10:00:00.000Z'),
    status,
    cargoProviderName: 'Sürat Kargo Marketplace',
    cargoProviderId: 27,
    cargoCompanyId: 27,
    cargoTrackingNumber: `727003${suffix.replace(/\D/g, '').padEnd(10, '0')}`,
    customerFirstName: `Müşteri`,
    customerLastName: suffix,
    shipmentAddress: {
      fullAddress: `Adres ${suffix}`,
      city: 'İstanbul',
      district: 'Kadıköy',
      phone: '5550000000',
    },
    lines: [
      {
        id: `LINE-${suffix}`,
        productName: `Ürün ${suffix}`,
        barcode: `BARCODE-${suffix}`,
        sku: `SKU-${suffix}`,
        merchantSku: `MSKU-${suffix}`,
        quantity: 1,
        productContentId: `CONTENT-${suffix}`,
        imageUrl: `https://cdn.example.com/${packageId}.jpg`,
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

  while (Date.now() - startedAt < 10000) {
    try {
      const response = await fetch(`http://${host}:${port}/api/health`)
      if (response.ok) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  throw new Error(`API server başlamadı. ${stderr}`)
}

async function postJson(port, path, body) {
  const response = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}
