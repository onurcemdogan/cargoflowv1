import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('dashboard view model dönem, comparison ve paket tekilleştirmesini korur', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const {
    buildDashboardViewModel,
    calculateComparison,
  } = await vite.ssrLoadModule('/src/dashboard/dashboardViewModel.ts')
  const now = new Date('2026-07-19T12:00:00')
  const today = order('today', '2026-07-19T10:00:00', {
    totalAmount: 300,
    items: [
      item('A-38', 2, 100, '38'),
      item('A-40', 1, 100, '40'),
    ],
  })
  const duplicate = { ...today, id: 'duplicate-today' }
  const yesterday = order('yesterday', '2026-07-18T10:00:00', {
    totalAmount: 150,
  })
  const model = buildDashboardViewModel({
    orders: [today, duplicate, yesterday],
    products: [],
    selectedPeriod: { key: 'today' },
    now,
  })

  assert.equal(model.salesSummary.salesAmount.value, 300)
  assert.equal(model.salesSummary.salesAmount.comparison.previous, 150)
  assert.equal(model.salesSummary.orderCount.value, 1)
  assert.equal(model.salesSummary.lineCount.value, 2)
  assert.equal(model.salesSummary.productCount.value, 3)
  assert.equal(model.salesChart.granularity, 'hourly')
  assert.equal(model.salesChart.current.length, 24)
  assert.equal(model.marketplaceDistribution.length, 1)
  assert.equal(model.marketplaceDistribution[0].label, 'Trendyol')
  assert.equal(model.marketplaceDistribution[0].share, 100)
  assert.equal(model.topProducts.length, 2)
  assert.notEqual(model.topProducts[0].key, model.topProducts[1].key)
  assert.deepEqual(calculateComparison(10, 0), {
    current: 10,
    previous: 0,
    absoluteChange: 10,
    percentageChange: 0,
    direction: 'up',
    comparable: false,
  })
})

test('dashboard operation detail resolves the full order with strong identity', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { resolveDashboardOrder } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const preferred = order('preferred', '2026-07-19T10:00:00', {
    id: 'current-id',
    marketplace: 'Trendyol',
    packageId: 'PKG-42',
    shipmentPackageId: 'SHP-42',
    orderNumber: '11420000001',
  })
  const staleId = order('stale', '2026-07-19T09:00:00', {
    id: 'stale-id',
    marketplace: 'Trendyol',
    packageId: 'PKG-OLD',
    orderNumber: '11420000001',
  })
  const operation = {
    id: 'stale-id',
    marketplace: ' TRENDYOL ',
    orderNumber: '11420000001',
    packageId: ' pkg-42 ',
  }

  assert.equal(
    resolveDashboardOrder([staleId, preferred], operation)?.id,
    preferred.id,
  )
  assert.equal(
    resolveDashboardOrder([preferred], {
      ...operation,
      packageId: 'missing',
      id: preferred.id,
    })?.id,
    preferred.id,
  )
  assert.equal(
    resolveDashboardOrder([preferred], {
      ...operation,
      packageId: undefined,
      id: 'missing-id',
    })?.id,
    preferred.id,
  )
  assert.equal(
    resolveDashboardOrder([preferred], {
      ...operation,
      packageId: undefined,
      id: 'missing-id',
      orderNumber: 'missing-order',
    }),
    undefined,
  )
})

test('dashboard iade, şehir normalizasyonu ve eksik şehir verisini güvenle işler', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const orders = [
    order('istanbul-a', '2026-07-19T08:00:00', { city: 'ISTANBUL' }),
    order('istanbul-b', '2026-07-19T09:00:00', { city: 'istanbul' }),
    order('unknown', '2026-07-19T10:00:00', { city: '' }),
    order('returned', '2026-07-19T11:00:00', {
      city: 'İzmir',
      marketplaceStatus: 'Returned',
      operationStatus: 'ERROR',
      totalAmount: 80,
    }),
  ]
  const model = buildDashboardViewModel({
    orders,
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })

  assert.equal(model.salesSummary.orderCount.value, 3)
  assert.equal(model.salesSummary.returnCount.value, 1)
  assert.equal(model.salesSummary.returnAmount.value, 80)
  assert.equal(
    model.cityDistribution.find((row) => row.label === 'İstanbul')?.orderCount,
    2,
  )
  assert.equal(
    model.cityDistribution.find((row) => row.label === 'Bilinmeyen')?.orderCount,
    1,
  )
  assert.equal(model.operationalSummary.errors, 0)
})

test('dashboard backlog metrikleri dönem filtresinden etkilenmez ve render side effect üretmez', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const oldOpen = order('old-open', '2026-07-10T10:00:00')
  const todayShipped = order('today-shipped', '2026-07-19T10:00:00', {
    marketplaceStatus: 'Shipped',
    operationStatus: 'HANDED_TO_CARGO',
  })
  const frozen = structuredClone([oldOpen, todayShipped])
  const model = buildDashboardViewModel({
    orders: [oldOpen, todayShipped],
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })

  assert.equal(model.operationalSummary.openOperations, 1)
  assert.equal(model.operationalSummary.barcodeWaiting, 1)
  assert.equal(model.operationalSummary.handedToCargo, 1)
  assert.equal(
    model.operationFlow.find((step) => step.key === 'open')?.count,
    model.operationalSummary.openOperations,
  )
  assert.equal(
    model.operationFlow.find((step) => step.key === 'cargo')?.count,
    model.operationalSummary.handedToCargo,
  )
  assert.deepEqual([oldOpen, todayShipped], frozen)
})

test('dashboard lifecycle and action filters match Orders results', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const { buildVisibleOrders } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const orderDate = '2026-07-19T10:00:00'
  const preassigned = preassignedOrder('PREASSIGNED', orderDate)
  const ready = verifiedReadyOrder('PRINTED', orderDate)
  const printed = {
    ...ready,
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: {
      id: 'label-printed',
      labelType: 'zpl',
      barcodeFormat: 'Code128',
      barcodeValue: ready.shipment.barcode,
      templateId: 'surat',
      zplContent: ready.shipment.barcodeRaw,
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      createdAt: orderDate,
      printedAt: orderDate,
      printCount: 1,
      printHistory: [{ printedAt: orderDate }],
    },
  }
  const handed = order('HANDED', orderDate, {
    marketplaceStatus: 'Shipped',
    operationStatus: 'HANDED_TO_CARGO',
  })
  const delivered = order('DELIVERED', orderDate, {
    marketplaceStatus: 'Delivered',
    operationStatus: 'DELIVERED',
  })
  const critical = order('CRITICAL', orderDate, { city: '', desi: null })
  const orders = [preassigned, printed, handed, delivered, critical]
  const model = buildDashboardViewModel({
    orders,
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })

  assert.equal(model.operationalSummary.labelReady, 1)
  assert.equal(model.operationalSummary.labelPrinted, 1)
  assert.equal(model.operationalSummary.handedToCargo, 1)
  assert.equal(model.operationalSummary.delivered, 1)
  assert.equal(
    model.actionRequired.find((row) => row.key === 'verification-waiting')?.count,
    1,
  )
  assert.equal(model.operationalSummary.errors, 0)

  const baseFilters = {
    persistentOrders: orders,
    selectedTab: 'all',
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    cityFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
  }
  for (const [actionFilter, actionKey] of [
    ['createEligible', 'create-required'],
    ['printEligible', 'print-required'],
    ['critical', 'critical-data'],
  ]) {
    const visibleCount = buildVisibleOrders({
      ...baseFilters,
      actionFilter,
    }).visibleOrders.length
    assert.equal(
      visibleCount,
      model.actionRequired.find((row) => row.key === actionKey)?.count,
    )
  }
})

function item(barcode, quantity = 1, price = 100, size = '38') {
  return {
    id: `item-${barcode}`,
    productName: `Test Ürün ${size}`,
    sku: `SKU-${barcode}`,
    merchantSku: `MERCHANT-${barcode}`,
    barcode,
    quantity,
    price,
    color: 'Siyah',
    size,
    variantAttributes: [],
  }
}

function order(suffix, orderDate, overrides = {}) {
  return {
    id: `order-${suffix}`,
    marketplace: 'Trendyol',
    externalOrderId: `ORDER-${suffix}`,
    orderNumber: `ORDER-${suffix}`,
    packageId: `PKG-${suffix}`,
    shipmentPackageId: `PKG-${suffix}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    source: 'real',
    status: 'Yeni',
    customerName: 'Test Müşteri',
    customerPhone: '',
    customerEmail: '',
    address: 'Test adresi',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoProviderName: 'Sürat Kargo Marketplace',
    cargoTrackingNumber: `727${suffix}`,
    totalAmount: 100,
    totalPrice: 100,
    createdAt: orderDate,
    orderDate,
    desi: 2,
    items: [item(`BARCODE-${suffix}`)],
    ...overrides,
  }
}

function preassignedOrder(suffix, orderDate) {
  const base = order(suffix, orderDate)
  const trackingNumber = '99718621450001'
  const barcode = '0125000803001'
  const barcodeRaw = `^XA^FO20,20^FDT.No: ${trackingNumber}^FS^FT48,300^BCN,,Y,N^FD>:${barcode}^FS^XZ`
  return {
    ...base,
    status: 'Etiket HazÄ±r',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    shipment: {
      id: `shipment-${suffix}`,
      provider: 'surat-kargo',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      trackingNumber,
      kargoTakipNo: trackingNumber,
      tNo: trackingNumber,
      barcode,
      barkodNo: barcode,
      barcodeValue: barcode,
      finalSuratBarcode: barcode,
      barcodeRaw,
      webSiparisKodu: base.cargoTrackingNumber,
      ozelKargoTakipNo: base.cargoTrackingNumber,
      labelStatus: 'READY',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      verificationStage: 'preassigned_awaiting_acceptance',
      printEnabled: true,
      source: 'real',
      verifiedShipment: false,
      dispatchRegistrationConfirmed: false,
      operationalBarcodeVerified: false,
      serdendipVerified: false,
      noTrackingReason: 'Fiziksel kabul bekleniyor.',
      createdAt: orderDate,
    },
  }
}

function verifiedReadyOrder(suffix, orderDate) {
  const base = order(suffix, orderDate)
  const trackingNumber = '25123615625001'
  const barcode = '0123990557001'
  const barcodeRaw = `^XA^FO20,20^FD${barcode}^FS^XZ`
  return {
    ...base,
    status: 'Etiket HazÄ±r',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    shipment: {
      id: `shipment-${suffix}`,
      provider: 'surat-kargo',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      trackingNumber,
      kargoTakipNo: trackingNumber,
      tNo: trackingNumber,
      barcode,
      barkodNo: barcode,
      barcodeValue: barcode,
      finalSuratBarcode: barcode,
      barcodeRaw,
      webSiparisKodu: base.cargoTrackingNumber,
      ozelKargoTakipNo: base.cargoTrackingNumber,
      labelStatus: 'READY',
      lifecycleStatus: 'LABEL_READY',
      source: 'real',
      verifiedShipment: true,
      dispatchRegistrationConfirmed: true,
      operationalBarcodeVerified: true,
      serdendipVerified: true,
      verificationStage: 'serdendip_verified',
      suratTrackingLog: {
        gonderilerLength: 1,
        KargoTakipNo: trackingNumber,
        BarkodNo: barcode,
        WebSiparisKodu: base.cargoTrackingNumber,
      },
      createdAt: orderDate,
    },
  }
}
