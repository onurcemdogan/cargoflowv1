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
          status === 'Created' ? 2 : status === 'UNFILTERED' ? 3 : 1,
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
  assert.equal(response.orders.length, 5)
  assert.equal(response.debug.rawOrdersCount, 5)
  assert.equal(response.debug.normalizedOrdersCount, 5)
  assert.equal(response.debug.totalLineCount, 5)
  assert.deepEqual(
    response.orders.map((order) => order.packageId).sort(),
    [
      'PKG-CREATED-0',
      'PKG-CREATED-1',
      'PKG-HIDDEN-CREATED',
      'PKG-PICKING-0',
      'PKG-UNKNOWN-0',
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
  assert.equal(response.debug.fetchDebug.unfilteredFallback.addedCount, 2)
  assert.equal(
    response.orders.find((order) => order.packageId === 'PKG-UNKNOWN-0')
      ?.marketplaceStatus,
    'Unknown',
    'Bilinmeyen pazaryeri statüsü Tümü kapsamından sessizce düşmemeli.',
  )
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

test('Sipariş statülerinden biri alınamazsa PARTIAL sonuç başarı sayılmaz', async (t) => {
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (url.searchParams.get('status') === 'Picking') {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'temporary upstream error' }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        content:
          url.searchParams.get('status') === 'Created'
            ? [
                buildPackage({
                  status: 'Created',
                  suffix: 'PARTIAL-CREATED',
                  packageId: 'PKG-PARTIAL-CREATED',
                }),
              ]
            : [],
        page: 0,
        size: 200,
        totalPages: 1,
        totalElements: url.searchParams.get('status') === 'Created' ? 1 : 0,
      }),
    )
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())
  const { apiPort, apiProcess } = await startApiWithTrendyolMock(mockPort)
  t.after(() => apiProcess.kill())

  const body = await postJson(apiPort, '/api/trendyol/orders/fetch', {
    credentials: {
      sellerId: 'SELLER-1',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      environment: 'prod',
    },
    query: {
      startDate: Date.parse('2026-07-01T00:00:00.000Z'),
      endDate: Date.parse('2026-07-08T23:59:59.999Z'),
      size: 200,
    },
  })

  assert.equal(body.ok, false)
  assert.deepEqual(body.orders, [])
  assert.equal(body.debug.syncStatus, 'PARTIAL')
  assert.equal(body.debug.partialRecordCount, 1)
  assert.match(body.message, /kısmi/i)
})

test('Ürün kataloğu tüm sayfaları çeker, orta sayfa 429 hatasını tekrarlar ve varyantları korur', async (t) => {
  const pageAttempts = new Map()
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (!url.pathname.endsWith('/products')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'not found' }))
      return
    }
    const page = Number(url.searchParams.get('page') ?? 0)
    const attempt = (pageAttempts.get(page) ?? 0) + 1
    pageAttempts.set(page, attempt)
    if (page === 2 && attempt === 1) {
      response.writeHead(429, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '0',
      })
      response.end(JSON.stringify({ message: 'rate limited' }))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'x-ratelimit-remaining': String(100 - page),
    })
    response.end(
      JSON.stringify({
        content: buildProductPage(page, 200),
        page,
        size: 200,
        totalPages: 5,
        totalElements: 1000,
      }),
    )
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())
  const { apiPort, apiProcess } = await startApiWithTrendyolMock(mockPort)
  t.after(() => apiProcess.kill())

  const { status, body } = await postJsonWithStatus(
    apiPort,
    '/api/trendyol/products/fetch',
    productFetchBody(),
  )

  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.products.length, 1000)
  assert.equal(body.debug.status, 'COMPLETE')
  assert.equal(body.debug.expectedTotal, 1000)
  assert.equal(body.debug.rawApiRecordsCount, 1000)
  assert.equal(body.debug.normalizedProductsCount, 1000)
  assert.equal(body.debug.fetchedPages, 5)
  assert.equal(body.debug.expectedPages, 5)
  assert.deepEqual(body.debug.failedPages, [])
  assert.equal(body.debug.pages.find((entry) => entry.page === 2).retryCount, 1)
  assert.equal(pageAttempts.get(2), 2)
  assert.equal(
    body.products.filter((product) => product.barcode === 'SHARED-0').length,
    10,
    'Aynı barkodu taşıyan farklı platformListingId kayıtları normalize aşamasında kaybolmamalı.',
  )
})

test('Kalıcı ara sayfa hatasında kısmi ürün kataloğu istemciye ve ana cache akışına verilmez', async (t) => {
  const pageAttempts = new Map()
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    const page = Number(url.searchParams.get('page') ?? 0)
    pageAttempts.set(page, (pageAttempts.get(page) ?? 0) + 1)
    if (page === 3) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'temporary upstream error' }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        content: buildProductPage(page, 200),
        page,
        size: 200,
        totalPages: 5,
        totalElements: 1000,
      }),
    )
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())
  const { apiPort, apiProcess } = await startApiWithTrendyolMock(mockPort)
  t.after(() => apiProcess.kill())

  const { status, body } = await postJsonWithStatus(
    apiPort,
    '/api/trendyol/products/fetch',
    productFetchBody(),
  )

  assert.equal(status, 502)
  assert.equal(body.ok, false)
  assert.deepEqual(body.products, [])
  assert.equal(body.debug.status, 'PARTIAL')
  assert.equal(body.debug.rawApiRecordsCount, 800)
  assert.deepEqual(body.debug.failedPages, [3])
  assert.equal(body.debug.pages.find((entry) => entry.page === 3).retryCount, 2)
  assert.equal(pageAttempts.get(3), 3)
})

function productFetchBody() {
  return {
    credentials: {
      sellerId: 'SELLER-1',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      environment: 'prod',
    },
  }
}

function buildProductPage(page, size) {
  return Array.from({ length: size }, (_, index) => {
    const absoluteIndex = page * size + index
    return {
      id: `content-${Math.floor(absoluteIndex / 5)}`,
      platformListingId: `listing-${absoluteIndex}`,
      productMainId: `main-${Math.floor(absoluteIndex / 20)}`,
      productCode: `product-${absoluteIndex}`,
      barcode: `SHARED-${absoluteIndex % 100}`,
      merchantSku: `SKU-${absoluteIndex}`,
      title: `Ürün ${absoluteIndex}`,
      color: absoluteIndex % 2 === 0 ? 'Yeşil' : 'Bordo',
      size: String(36 + (absoluteIndex % 4) * 2),
      images: [{ url: `https://cdn.example.com/${absoluteIndex}.jpg` }],
    }
  })
}

async function startApiWithTrendyolMock(mockPort) {
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
  await waitForHealth(apiPort, apiProcess)
  return { apiPort, apiProcess }
}

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
      buildPackage({
        status: 'UnexpectedMarketplaceState',
        suffix: 'UNKNOWN-0',
        packageId: 'PKG-UNKNOWN-0',
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

async function postJsonWithStatus(port, path, body) {
  const response = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
