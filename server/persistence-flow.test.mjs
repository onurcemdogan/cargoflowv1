import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('Yeni senkronizasyon kalÄ±cÄ± operasyon listesini merge eder', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())

  const { OrderWorkflowService } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )
  const storage = new Map()
  const previousWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  }
  t.after(() => {
    globalThis.window = previousWindow
  })

  const yesterdayPending = buildOrder('OLD-PENDING')
  const yesterdayReady = buildReadyOrder('OLD-READY')
  const staleLocalizedError = {
    ...buildOrder('STALE-LOCALIZED-ERROR'),
    marketplaceStatus: 'SipariÅŸ OluÅŸtu',
    status: 'HatalÄ±',
    operationStatus: 'ERROR',
    errorMessage: 'Eski lokal hata',
    shipment: {
      dispatchRegistrationConfirmed: false,
      noTrackingReason: 'SÃ¼rat takip no alÄ±namadÄ±',
    },
  }
  storage.set(
    'cargoFlow_orders_v3',
    JSON.stringify([yesterdayPending, yesterdayReady, staleLocalizedError]),
  )

  let fetchedOrders = [buildOrder('NEW-TODAY')]
  const marketplaceProvider = {
    fetchOrders: async () => ({
      orders: fetchedOrders,
      page: 0,
      size: 200,
      totalPages: 1,
      hasNextPage: false,
      source: 'real',
      message: 'ok',
    }),
  }
  const workflow = new OrderWorkflowService(
    marketplaceProvider,
    {},
    {},
    {},
    { append: () => [] },
  )

  const firstSync = await workflow.fetchOrders(buildConfig())
  assert.equal(firstSync.orders.length, 4)
  const firstFreshOrder = firstSync.orders.find(
    (order) => order.packageId === 'PKG-NEW-TODAY',
  )
  assert.ok(firstFreshOrder?.lastMarketplaceSyncedAt)
  assert.ok(firstFreshOrder?.lastMarketplaceSyncBatchId)
  assert.ok(firstSync.orders.some((order) => order.id === yesterdayPending.id))
  assert.ok(firstSync.orders.some((order) => order.id === yesterdayReady.id))
  const archivedOldPending = firstSync.orders.find(
    (order) => order.id === yesterdayPending.id,
  )
  assert.equal(archivedOldPending.archived, true)
  assert.equal(
    archivedOldPending.archivedReason,
    'not_seen_in_latest_marketplace_sync',
  )
  assert.equal(archivedOldPending.status, 'Arşiv')
  assert.equal(archivedOldPending.shipment, undefined)
  const archivedLocalizedError = firstSync.orders.find(
    (order) => order.id === staleLocalizedError.id,
  )
  assert.equal(archivedLocalizedError.archived, true)
  assert.equal(
    archivedLocalizedError.archivedReason,
    'not_seen_in_latest_marketplace_sync',
  )
  assert.equal(archivedLocalizedError.status, 'Arşiv')
  const retainedReady = firstSync.orders.find(
    (order) => order.id === yesterdayReady.id,
  )
  assert.equal(retainedReady.archived, undefined)

  fetchedOrders = [
    {
      ...buildOrder('OLD-READY'),
      customerName: 'GÃ¼ncel MÃ¼ÅŸteri',
      address: 'GÃ¼ncel adres',
      shipment: undefined,
      label: undefined,
      labelStatus: undefined,
    },
  ]
  const secondSync = await workflow.fetchOrders(buildConfig())
  assert.equal(secondSync.orders.length, 4)
  const mergedReady = secondSync.orders.find(
    (order) => order.packageId === 'PKG-OLD-READY',
  )
  assert.equal(mergedReady.customerName, 'GÃ¼ncel MÃ¼ÅŸteri')
  assert.equal(mergedReady.address, 'GÃ¼ncel adres')
  assert.equal(mergedReady.shipment.trackingNumber, 'TRACK-OLD-READY')
  assert.equal(mergedReady.shipment.barcodeRaw, '^XA^FDOLD-READY^FS^XZ')
  assert.equal(mergedReady.labelStatus, 'READY')
  assert.equal(mergedReady.operationStatus, 'LABEL_READY')
  assert.ok(mergedReady.lastMarketplaceSyncedAt)
  assert.equal(
    secondSync.orders.filter((order) => order.packageId === 'PKG-OLD-READY')
      .length,
    1,
  )

  fetchedOrders = [buildOrder('NEWER-PACKAGE')]
  const thirdSync = await workflow.fetchOrders(buildConfig())
  assert.equal(thirdSync.orders.length, 5)
  assert.ok(
    thirdSync.orders.some(
      (order) => order.packageId === 'PKG-NEWER-PACKAGE',
    ),
  )
})

function buildOrder(suffix) {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return {
    id: `order-${suffix}`,
    marketplace: 'Trendyol',
    externalOrderId: `ORDER-${suffix}`,
    orderNumber: `ORDER-${suffix}`,
    packageId: `PKG-${suffix}`,
    shipmentPackageId: `SHIPMENT-PKG-${suffix}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    source: 'real',
    status: 'Yeni',
    customerName: 'Test MÃ¼ÅŸteri',
    customerPhone: '',
    customerEmail: '',
    address: 'Test adresi',
    city: 'Ä°stanbul',
    district: 'KadÄ±kÃ¶y',
    totalAmount: 100,
    createdAt: yesterday.toISOString(),
    orderDate: yesterday.toISOString(),
    items: [
      {
        id: `line-${suffix}`,
        productName: 'Test ÃœrÃ¼n',
        sku: `SKU-${suffix}`,
        merchantSku: `SKU-${suffix}`,
        barcode: `PRODUCT-${suffix}`,
        quantity: 1,
        variantAttributes: [],
      },
    ],
  }
}

function buildReadyOrder(suffix) {
  return {
    ...buildOrder(suffix),
    status: 'Etiket HazÄ±r',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    shipmentStatus: 'VERIFIED',
    suratVerificationStatus: 'VERIFIED',
    zplReady: true,
    printEnabled: true,
    matchStatus: true,
    shipment: {
      id: `shipment-${suffix}`,
      provider: 'surat-kargo',
      trackingNumber: `TRACK-${suffix}`,
      trackingUrl: '',
      shipmentCode: `PKG-${suffix}`,
      barcodeValue: `BARCODE-${suffix}`,
      serviceMode: 'ORTAK_BARKOD_SOAP',
      operationName: 'OrtakBarkodOlustur',
      kargoTakipNo: `TRACK-${suffix}`,
      barcode: `BARCODE-${suffix}`,
      barcodeRaw: `^XA^FD${suffix}^FS^XZ`,
      barcodeSource: 'surat.ortakBarkod.Barcode',
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      labelStatus: 'READY',
      shipmentStatus: 'VERIFIED',
      suratVerificationStatus: 'VERIFIED',
      zplReady: true,
      printEnabled: true,
      matchStatus: true,
      status: 'created',
      lifecycleStatus: 'LABEL_READY',
      source: 'real',
      rawResponse: {},
      verifiedShipment: true,
      dispatchRegistrationConfirmed: true,
      operationalBarcodeVerified: true,
      serdendipVerified: true,
      verificationStage: 'serdendip_verified',
      createdAt: new Date().toISOString(),
    },
  }
}

function buildConfig() {
  return {
    trendyol: {
      sellerId: '123456',
      apiKey: 'test-api-key',
      apiSecret: 'test-api-secret',
      environment: 'prod',
      userAgentName: 'CargoFlow',
    },
    surat: {},
  }
}
