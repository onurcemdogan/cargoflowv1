import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'

const host = '127.0.0.1'
const now = new Date('2026-07-19T12:00:00.000Z')

// --- Ortak fixture'lar ----------------------------------------------------
function saleOrder({
  id,
  packageId,
  lineId,
  qty = 1,
  price = 1000,
  orderDate = '2026-07-05T10:00:00.000Z',
  marketplaceStatus = 'Delivered',
}) {
  return {
    id,
    marketplace: 'Trendyol',
    externalOrderId: packageId,
    orderNumber: id,
    packageId,
    shipmentPackageId: packageId,
    customerName: 'X',
    customerPhone: '',
    customerEmail: '',
    address: 'x',
    city: 'İstanbul',
    district: 'Fatih',
    marketplaceStatus,
    operationStatus: 'DELIVERED',
    source: 'real',
    status: 'Teslim Edildi',
    totalAmount: price,
    totalPrice: price,
    createdAt: orderDate,
    orderDate,
    items: [
      {
        id: `ty_line_${lineId}`,
        productName: 'Ü',
        sku: 's',
        barcode: `b${lineId}`,
        quantity: qty,
        price: price / qty,
      },
    ],
    rawOrder: { status: marketplaceStatus },
  }
}

function claim({
  claimId,
  packageId,
  lineId,
  status = 'Accepted',
  eventDate = '2026-07-10T10:00:00.000Z',
  quantity = 1,
  amount = 1000,
}) {
  return {
    claimId,
    packageId,
    orderNumber: '',
    orderLineId: String(lineId),
    claimStatus: status,
    claimType: 'Beğenmedim',
    eventDate,
    quantity,
    amount,
    amountSource: 'line_price_fallback',
  }
}

const monthOf = (cards) => cards.find((card) => card.key === 'month')
const lastMonthOf = (cards) => cards.find((card) => card.key === 'lastMonth')

// --- Pure helper: classifyAnalyticsClaim ---------------------------------
test('classifyAnalyticsClaim statüleri doğru sınıflar', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { classifyAnalyticsClaim } = await vite.ssrLoadModule(
    '/src/dashboard/analyticsClaims.ts',
  )
  const base = { claimId: 'c', packageId: 'p', orderLineId: 'l', eventDate: 'e', quantity: 2, amount: 50 }
  assert.equal(classifyAnalyticsClaim({ ...base, claimStatus: 'Accepted' }).disposition, 'accepted_return')
  assert.equal(classifyAnalyticsClaim({ ...base, claimStatus: 'Rejected' }).disposition, 'rejected')
  assert.equal(classifyAnalyticsClaim({ ...base, claimStatus: 'Cancelled' }).disposition, 'rejected')
  assert.equal(classifyAnalyticsClaim({ ...base, claimStatus: 'Created' }).disposition, 'pending')
  assert.equal(classifyAnalyticsClaim({ ...base, claimStatus: 'WaitingInAction' }).disposition, 'pending')
  assert.equal(classifyAnalyticsClaim({ ...base, claimStatus: 'BilinmeyenX' }).disposition, 'ignored')
})

// --- Pure helper: F (aynı claim iki kez) ve G (exclude) ------------------
test('summarizeAcceptedClaimsForPeriod dedup (F) ve exclude (G)', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { summarizeAcceptedClaimsForPeriod } = await vite.ssrLoadModule(
    '/src/dashboard/analyticsClaims.ts',
  )
  const inPeriod = () => true
  const c = claim({ claimId: 'C1', packageId: 'P1', lineId: '10', amount: 100 })

  // F) Aynı claim iki sayfada → bir kez uygulanır.
  const dedup = summarizeAcceptedClaimsForPeriod([c, { ...c }], inPeriod, {})
  assert.equal(dedup.amountDeduction, 100)
  assert.equal(dedup.unitDeduction, 1)
  assert.equal(dedup.returnedPackageCount, 1)

  // G) Paket status ile zaten iade/iptal → claim uygulanmaz (çift düşüm yok).
  const excluded = summarizeAcceptedClaimsForPeriod([c], inPeriod, {
    excludePackageIds: new Set(['P1']),
  })
  assert.equal(excluded.amountDeduction, 0)
  assert.equal(excluded.returnedPackageCount, 0)
})

// --- viewModel: A, B, C, D, E, H -----------------------------------------
test('dashboard satış kartları claim mutabakatı (A-E, H)', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildDashboardSalesPeriodCards } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const cards = (orders, claims) =>
    buildDashboardSalesPeriodCards(orders, now, claims)

  // A) Delivered order + accepted claim → satıştan düşer, iadeye eklenir.
  {
    const orders = [saleOrder({ id: 'A', packageId: 'PA', lineId: '1', price: 1000 })]
    const base = monthOf(cards(orders))
    assert.equal(base.salesAmount, 1000)
    assert.equal(base.packageCount, 1)
    const withClaim = monthOf(
      cards(orders, [claim({ claimId: 'CA', packageId: 'PA', lineId: '1', amount: 1000 })]),
    )
    assert.equal(withClaim.salesAmount, 0)
    assert.equal(withClaim.packageCount, 0)
    assert.equal(withClaim.returnCancellationAmount, 1000)
    assert.equal(withClaim.returnPackageCount, 1)
  }

  // B) Rejected claim → hiçbir metrik değişmez.
  {
    const orders = [saleOrder({ id: 'B', packageId: 'PB', lineId: '2', price: 800 })]
    const base = monthOf(cards(orders))
    const rejected = monthOf(
      cards(orders, [claim({ claimId: 'CB', packageId: 'PB', lineId: '2', status: 'Rejected', amount: 800 })]),
    )
    assert.deepEqual(
      [rejected.salesAmount, rejected.packageCount, rejected.returnCancellationAmount, rejected.returnPackageCount],
      [base.salesAmount, base.packageCount, base.returnCancellationAmount, base.returnPackageCount],
    )
  }

  // C) Pending claim → satıştan düşmez.
  {
    const orders = [saleOrder({ id: 'C', packageId: 'PC', lineId: '3', price: 700 })]
    const pending = monthOf(
      cards(orders, [claim({ claimId: 'CC', packageId: 'PC', lineId: '3', status: 'Created', amount: 700 })]),
    )
    assert.equal(pending.salesAmount, 700)
    assert.equal(pending.packageCount, 1)
    assert.equal(pending.returnCancellationAmount, 0)
  }

  // D) Kısmi adet iadesi → adet/tutar kısmi düşer, paket ve satır net'te kalır.
  {
    const orders = [saleOrder({ id: 'D', packageId: 'PD', lineId: '4', qty: 3, price: 300 })]
    const partial = monthOf(
      cards(orders, [claim({ claimId: 'CD', packageId: 'PD', lineId: '4', quantity: 1, amount: 100 })]),
    )
    assert.equal(partial.salesAmount, 200)
    assert.equal(partial.productCount, 2)
    assert.equal(partial.packageCount, 1, 'kısmi iade paketi net pakette kalır')
    assert.equal(partial.lineCount, 1, 'kısmi iade satırı net satırda kalır')
    assert.equal(partial.returnCancellationAmount, 100)
    assert.equal(partial.returnPackageCount, 1)
  }

  // E) Tam paket iadesi → packageNet düşer.
  {
    const orders = [saleOrder({ id: 'E', packageId: 'PE', lineId: '5', qty: 2, price: 200 })]
    const full = monthOf(
      cards(orders, [claim({ claimId: 'CE', packageId: 'PE', lineId: '5', quantity: 2, amount: 200 })]),
    )
    assert.equal(full.packageCount, 0)
    assert.equal(full.lineCount, 0)
    assert.equal(full.productCount, 0)
    assert.equal(full.salesAmount, 0)
    assert.equal(full.returnPackageCount, 1)
  }

  // H) order-cohort: order geçen ay, claim event bu ay → iade SİPARİŞİN
  // ayına (GEÇEN AY) yazılır; bu ay (claim event ayı) etkilenmez. Böylece
  // satış hangi ayda sayıldıysa iade de o ay düşer (Durusoft mutabakatı).
  {
    const orders = [
      saleOrder({ id: 'H', packageId: 'PH', lineId: '6', price: 500, orderDate: '2026-06-15T10:00:00.000Z' }),
    ]
    const result = cards(orders, [
      claim({ claimId: 'CH', packageId: 'PH', lineId: '6', amount: 500, eventDate: '2026-07-10T10:00:00.000Z' }),
    ])
    const june = lastMonthOf(result)
    const july = monthOf(result)
    // Geçen ay (siparişin ayı): iade burada net satıştan düşer.
    assert.equal(june.salesAmount, 0, 'iade siparişin ayında satıştan düşer')
    assert.equal(june.returnCancellationAmount, 500)
    assert.equal(june.returnPackageCount, 1)
    assert.equal(june.packageCount, 0, 'tam iade paketi siparişin ayından düşer')
    // Bu ay (claim event ayı): etkilenmez.
    assert.equal(july.returnPackageCount, 0, 'iade claim event ayına yazılmaz')
    assert.equal(july.returnCancellationAmount, 0)
  }
})

// --- viewModel: I (claims yoksa operasyon paneli çalışır) ----------------
test('claims verisi olmadan satış brüt kalır, operasyon paneli çalışır (I)', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const analyticsOrders = [saleOrder({ id: 'I', packageId: 'PI', lineId: '7', price: 900 })]
  const operationalOrders = [
    { ...saleOrder({ id: 'OP', packageId: 'POP', lineId: '8' }), marketplaceStatus: 'Picking', operationStatus: 'READY_TO_SHIP', status: 'Yeni' },
  ]
  const vm = buildDashboardViewModel({
    orders: operationalOrders,
    analyticsOrders,
    // analyticsClaims YOK → iade düşümü uygulanmaz.
    selectedPeriod: { key: 'month' },
    now,
  })
  const month = monthOf(vm.salesPeriodCards)
  assert.equal(month.salesAmount, 900, 'claims yokken satış brüt kalır')
  assert.equal(month.returnCancellationAmount, 0)
  // Operasyon paneli orders'tan çalışmaya devam eder.
  assert.equal(vm.operationalSummary.openOperations, 1)
})

// --- e2e endpoint + J (Sürat create çağrısı 0) ---------------------------
test('claims endpoint pagination, dedupe, statü ve Sürat izolasyonu (J)', async (t) => {
  const receivedPaths = []
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    receivedPaths.push(url.pathname)
    if (!url.pathname.endsWith('/claims')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'not found' }))
      return
    }
    const page = Number(url.searchParams.get('page') ?? 0)
    let content = []
    if (page === 0) {
      content = Array.from({ length: 100 }, (_, i) => buildClaim(i, 'Accepted'))
    } else if (page === 1) {
      content = [
        ...Array.from({ length: 30 }, (_, i) => buildClaim(100 + i, 'Accepted')),
        ...Array.from({ length: 10 }, (_, i) => buildClaim(130 + i, 'Rejected')),
        ...Array.from({ length: 10 }, (_, i) => buildClaim(140 + i, 'Created')),
        buildClaim(0, 'Accepted'), // sayfalar arası duplicate
      ]
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({ content, page, size: 200, totalPages: 2, totalElements: 151 }),
    )
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())

  const configDir = mkdtempSync(join(tmpdir(), 'cargoflow-claims-'))
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

  const putResponse = await fetch(`http://${host}:${apiPort}/api/local-config/integration`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-CargoFlow-Client-Host': host },
    body: JSON.stringify({
      config: {
        trendyol: { sellerId: 'SELLER-1', apiKey: 'api-key', apiSecret: 'api-secret', environment: 'prod', userAgentName: '' },
        surat: {},
      },
    }),
  })
  assert.equal((await putResponse.json()).ok, true)

  const params = new URLSearchParams({
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: '2026-07-20T23:59:59.999Z',
  })
  const claimsResponse = await fetch(`http://${host}:${apiPort}/api/analytics/claims?${params}`, {
    headers: { 'X-CargoFlow-Client-Host': host },
  })
  const payload = await claimsResponse.json()
  assert.equal(payload.ok, true)
  // 150 unique claim (CLAIM-0 sayfa+pencere tekrarları tek sayılır).
  assert.equal(payload.uniqueClaimCount, 150)
  assert.equal(payload.fetchedCount, 150)
  // Kabul edilen: 0..99 (100) + 100..129 (30) = 130 paket.
  assert.equal(payload.affectedPackageCount, 130)
  assert.equal(payload.amountBasis, 'line_price_fallback')

  const accepted = payload.claims.find((c) => c.claimStatus === 'Accepted')
  assert.equal(accepted.isAcceptedReturn, true)
  assert.equal(accepted.amount, 100) // line price 100 × 1 adet
  // packageId orijinal SATIŞ paketidir (outbound), iade paketi değil.
  assert.ok(
    accepted.packageId.startsWith('80000'),
    `packageId outbound olmalı: ${accepted.packageId}`,
  )
  assert.ok(accepted.returnPackageId.startsWith('90000'))
  const rejected = payload.claims.find((c) => c.claimStatus === 'Rejected')
  assert.equal(rejected.isCancelledOrRejected, true)
  assert.equal(rejected.isAcceptedReturn, false)

  // J) Yalnız /claims istekleri; hiçbir Sürat/shipment çağrısı yok.
  assert.ok(receivedPaths.length > 0)
  assert.ok(
    receivedPaths.every((path) => path.endsWith('/claims')),
    `beklenmeyen path: ${receivedPaths.find((p) => !p.endsWith('/claims'))}`,
  )
  assert.ok(!receivedPaths.some((path) => /surat|shipment|gonderi/i.test(path)))
})

function buildClaim(index, status) {
  return {
    id: `CLAIM-${index}`,
    claimId: `CLAIM-${index}`,
    orderNumber: `ORD-${index}`,
    orderDate: Date.parse('2026-07-01T00:00:00.000Z'),
    claimDate: Date.parse('2026-07-10T00:00:00.000Z'),
    orderShipmentPackageId: 900000 + index, // iade (inbound) paketi
    orderOutboundPackageId: 800000 + index, // orijinal satış paketi
    items: [
      {
        orderLine: {
          id: 5000 + index,
          productName: `Ürün ${index}`,
          barcode: `B${index}`,
          price: 100,
        },
        claimItems: [
          {
            id: `CI-${index}`,
            orderLineItemId: 5000 + index,
            claimItemStatus: { name: status },
            customerClaimItemReason: { name: 'Beğenmedim' },
          },
        ],
      },
    ],
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve(server.address().port))
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
