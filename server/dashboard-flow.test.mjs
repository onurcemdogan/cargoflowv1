import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('Dashboard provider bağımsız ve gerçek state kurallarıyla çalışır', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())

  const { buildDashboardSummary } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardSummary.ts',
  )
  const { DashboardPage } = await vite.ssrLoadModule(
    '/src/pages/DashboardPage.tsx',
  )
  const { buildVisibleOrders } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const integrations = buildIntegrations()
  const printerSettings = buildPrinterSettings()

  // Test 1: Üç siparişin hiçbirinde barkod yok.
  const pendingOrders = [
    buildOrder('1'),
    buildOrder('2'),
    buildOrder('3'),
  ]
  const pendingSummary = buildDashboardSummary({
    orders: pendingOrders,
    ...integrations,
    printerSettings,
  })
  assert.equal(pendingSummary.totalOrders, 3)
  assert.equal(pendingSummary.allOrders, 3)
  assert.equal(pendingSummary.openOperations, 3)
  assert.equal(pendingSummary.todayOrders, 3)
  assert.equal(pendingSummary.monthlyOrders, 3)
  assert.equal(pendingSummary.selectedPeriod, 'today')
  assert.equal(pendingSummary.barcodeWaiting, 3)
  assert.equal(pendingSummary.labelReady, 0)
  assert.equal(pendingSummary.labelPrinted, 0)
  assert.equal(
    pendingSummary.recentOrders[0].marketplaceProviderName,
    'Trendyol',
  )

  // Arşiv statüleri barkod kuyruğuna ve hata sayısına karışmaz.
  const shipped = {
    ...buildOrder('SHIPPED'),
    marketplaceStatus: 'Shipped',
    operationStatus: 'HANDED_TO_CARGO',
  }
  const canceled = {
    ...buildOrder('CANCELED'),
    marketplaceStatus: 'Cancelled',
    operationStatus: 'ERROR',
    status: 'Hata',
  }
  const mixedSummary = buildDashboardSummary({
    orders: [...pendingOrders, shipped, canceled],
    ...integrations,
    printerSettings,
  })
  assert.equal(mixedSummary.totalOrders, 5)
  assert.equal(mixedSummary.openOperations, 3)
  assert.equal(mixedSummary.barcodeWaiting, 3)
  assert.equal(mixedSummary.errors, 0)
  assert.equal(mixedSummary.canceledOrReturned, 1)
  assert.equal(
    mixedSummary.flowSteps.find((step) => step.key === 'cargo').count,
    1,
  )

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const dailySummary = buildDashboardSummary({
    orders: [
      ...pendingOrders,
      {
        ...buildOrder('YESTERDAY'),
        createdAt: yesterday.toISOString(),
      },
    ],
    ...integrations,
    printerSettings,
  })
  assert.equal(dailySummary.totalOrders, 4)
  assert.equal(dailySummary.openOperations, 4)
  assert.equal(dailySummary.todayOrders, 3)
  assert.equal(dailySummary.barcodeWaiting, 4)

  const monthlyWorkload = [
    ...Array.from({ length: 16 }, (_, index) =>
      buildOrder(`MONTH-PENDING-${index}`),
    ),
    ...Array.from({ length: 163 }, (_, index) => ({
      ...buildOrder(`MONTH-CLOSED-${index}`),
      marketplaceStatus: 'Shipped',
      operationStatus: 'HANDED_TO_CARGO',
    })),
  ]
  const monthlySummary = buildDashboardSummary({
    orders: monthlyWorkload,
    ...integrations,
    printerSettings,
    selectedPeriod: 'month',
  })
  assert.equal(monthlySummary.allOrders, 179)
  assert.equal(monthlySummary.monthlyOrders, 179)
  assert.equal(monthlySummary.openOperations, 16)
  assert.equal(monthlySummary.barcodeWaiting, 16)
  const sharedFilters = {
    persistentOrders: monthlyWorkload,
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
  }
  assert.equal(
    buildVisibleOrders({ ...sharedFilters, selectedTab: 'open' }).visibleOrders
      .length,
    monthlySummary.openOperations,
  )
  assert.equal(
    buildVisibleOrders({ ...sharedFilters, selectedTab: 'barcodePending' })
      .visibleOrders.length,
    monthlySummary.barcodeWaiting,
  )

  const yesterdayReadySummary = buildDashboardSummary({
    orders: [
      {
        ...buildReadyOrder('YESTERDAY-READY'),
        createdAt: yesterday.toISOString(),
      },
    ],
    ...integrations,
    printerSettings,
  })
  assert.equal(yesterdayReadySummary.labelReady, 1)

  // Test 2: Doğrulanmış ve BarcodeRaw bulunan sipariş hazırdır.
  const readyOrder = buildReadyOrder('READY')
  const readySummary = buildDashboardSummary({
    orders: [readyOrder],
    ...integrations,
    printerSettings,
  })
  assert.equal(readySummary.labelReady, 1)
  assert.equal(
    readySummary.recentOrders[0].carrierProviderName,
    'Sürat Kargo',
  )

  // Test 3: PRINTED ancak gerçek printedAt ile sayılır.
  const printedOrder = {
    ...readyOrder,
    status: 'Etiket Basıldı',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: {
      id: 'label-printed',
      labelType: 'zpl',
      barcodeFormat: 'Code128',
      barcodeValue: '01239905576',
      templateId: 'tpl',
      zplContent: readyOrder.shipment.barcodeRaw,
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      createdAt: new Date().toISOString(),
      printedAt: new Date().toISOString(),
      printCount: 1,
    },
  }
  const printedSummary = buildDashboardSummary({
    orders: [printedOrder],
    ...integrations,
    printerSettings,
  })
  assert.equal(printedSummary.labelPrinted, 1)
  const oldPrintedSummary = buildDashboardSummary({
    orders: [
      {
        ...printedOrder,
        label: {
          ...printedOrder.label,
          printedAt: yesterday.toISOString(),
        },
      },
    ],
    ...integrations,
    printerSettings,
  })
  assert.equal(oldPrintedSummary.labelPrinted, 0)
  const allPeriodPrintedSummary = buildDashboardSummary({
    orders: [
      {
        ...printedOrder,
        label: {
          ...printedOrder.label,
          printedAt: yesterday.toISOString(),
        },
      },
    ],
    ...integrations,
    printerSettings,
    selectedPeriod: 'all',
  })
  assert.equal(allPeriodPrintedSummary.labelPrinted, 1)

  const yesterdayBacklogTodayPeriod = buildDashboardSummary({
    orders: [
      {
        ...buildOrder('YESTERDAY-BACKLOG'),
        createdAt: yesterday.toISOString(),
      },
    ],
    ...integrations,
    printerSettings,
    selectedPeriod: 'today',
  })
  assert.equal(yesterdayBacklogTodayPeriod.todayOrders, 0)
  assert.equal(yesterdayBacklogTodayPeriod.openOperations, 1)
  assert.equal(yesterdayBacklogTodayPeriod.barcodeWaiting, 1)

  // Test 4: verifiedShipment var ama BarcodeRaw yoksa hatalıdır.
  const missingRaw = {
    ...readyOrder,
    labelStatus: 'READY',
    shipment: {
      ...readyOrder.shipment,
      barcodeRaw: '',
      zplSource: 'generated',
    },
  }
  const errorSummary = buildDashboardSummary({
    orders: [missingRaw],
    ...integrations,
    printerSettings,
  })
  assert.equal(errorSummary.errors, 0)
  assert.equal(
    errorSummary.actionItems.find((item) => item.key === 'raw-missing').count,
    1,
  )

  // Test 5: Boş dashboard sahte metrik göstermez.
  const emptySummary = buildDashboardSummary({
    orders: [],
    ...integrations,
    printerSettings,
  })
  assert.equal(emptySummary.totalOrders, 0)
  assert.equal(emptySummary.openOperations, 0)
  assert.equal(emptySummary.barcodeWaiting, 0)
  assert.equal(emptySummary.labelReady, 0)
  assert.equal(emptySummary.labelPrinted, 0)
  assert.equal(emptySummary.printerHealth.status, 'connected')

  const downloadPrinterSummary = buildDashboardSummary({
    orders: [],
    ...integrations,
    printerSettings: {
      ...printerSettings,
      mode: 'download',
    },
  })
  assert.equal(downloadPrinterSummary.printerHealth.status, 'not_configured')

  // Test 6: Bilinmeyen provider key dashboard'u bozmaz.
  const unknownProviderOrder = {
    ...buildOrder('UNKNOWN'),
    marketplace: 'YeniPazar',
    shipment: {
      ...buildReadyOrder('UNKNOWN').shipment,
      provider: 'yeni-kargo',
    },
  }
  const unknownSummary = buildDashboardSummary({
    orders: [unknownProviderOrder],
    ...integrations,
    printerSettings,
  })
  assert.equal(
    unknownSummary.recentOrders[0].marketplaceProviderName,
    'Bilinmeyen Pazaryeri',
  )
  assert.equal(
    unknownSummary.recentOrders[0].carrierProviderName,
    'Bilinmeyen Kargo',
  )

  const html = renderToStaticMarkup(
    createElement(DashboardPage, {
      orders: [readyOrder, buildOrder('PENDING')],
      integrationConfig: buildConfig(),
      printerSettings,
      apiDebugLogs: [],
      loading: false,
      lastSyncedAt: new Date().toISOString(),
      onRefresh: () => {},
      onNavigatePage: () => {},
      onNavigateOrders: () => {},
      onPreviewOrder: () => {},
      onDownloadOrder: () => {},
      onPrintOrder: () => {},
    }),
  )
  assert.match(html, /Bugünkü Kargo Operasyonu/)
  assert.match(html, /Açık Operasyon/)
  assert.match(html, /Bugün gelen/)
  assert.match(html, /Bu ay alınan/)
  assert.match(html, /Son 7 Gün/)
  assert.match(html, /Hatalı \/ Aksiyon Gerekli/)
  assert.match(html, /Operasyon Akışı/)
  assert.match(html, /Aksiyon Gerektirenler/)
  assert.match(html, /Son Siparişler/)
  assert.match(html, /Sürat Kargo/)
  assert.doesNotMatch(html, /hazırlık oranı/i)
  assert.doesNotMatch(html, /başarı oranı/i)
  assert.doesNotMatch(html, /Kalıcı operasyon listesindeki tüm siparişler/i)
  assert.doesNotMatch(html, /Toplam Sipariş/)
})

function buildIntegrations() {
  return {
    marketplaceIntegrations: [
      {
        providerKey: 'trendyol',
        providerName: 'Trendyol',
        status: 'connected',
        errorCount: 0,
        detail: 'Bağlı',
      },
    ],
    carrierIntegrations: [
      {
        providerKey: 'surat',
        providerName: 'Sürat Kargo',
        status: 'connected',
        errorCount: 0,
        detail: 'Bağlı',
      },
    ],
  }
}

function buildReadyOrder(suffix) {
  const numericSuffix = toNumericSuffix(suffix)
  const barcodeRaw = `^XA^FO20,20^FD0123990557${numericSuffix}^FS^XZ`
  return {
    ...buildOrder(suffix),
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    cargoProviderName: 'Sürat Kargo',
    shipment: {
      id: `shipment-${suffix}`,
      provider: 'surat-kargo',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      operationName: 'OrtakBarkodOlustur',
      trackingNumber: `25123615625${numericSuffix}`,
      kargoTakipNo: `25123615625${numericSuffix}`,
      barcode: `0123990557${numericSuffix}`,
      barcodeRaw,
      trackingUrl: '',
      shipmentCode: `PKG-${suffix}`,
      barcodeValue: `0123990557${numericSuffix}`,
      barcodeSource: 'surat.ortakBarkod.Barcode',
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      labelStatus: 'READY',
      status: 'created',
      lifecycleStatus: 'LABEL_READY',
      source: 'real',
      verifiedShipment: true,
      dispatchRegistrationConfirmed: true,
      serdendipVerified: true,
      verificationStage: 'serdendip_verified',
      rawResponse: {},
      createdAt: new Date().toISOString(),
    },
  }
}

function toNumericSuffix(value) {
  const text = String(value ?? '')
  const digits = text.replace(/\D/g, '')
  if (digits) return digits
  const hash = Array.from(text).reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  )
  return String(hash % 10000).padStart(4, '0')
}

function buildOrder(suffix) {
  return {
    id: `order-${suffix}`,
    marketplace: 'Trendyol',
    externalOrderId: `ORDER-${suffix}`,
    orderNumber: `ORDER-${suffix}`,
    packageId: `PKG-${suffix}`,
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
    totalAmount: 100,
    createdAt: new Date().toISOString(),
    items: [
      {
        id: `item-${suffix}`,
        productName: 'Test Ürün',
        sku: 'SKU-1',
        barcode: 'PRODUCT-1',
        productImageUrl: 'https://cdn.example.com/dashboard-product.jpg',
        imageResolvedFrom: 'orderLine',
        quantity: 1,
        variantAttributes: [],
      },
    ],
  }
}

function buildPrinterSettings() {
  return {
    printerName: 'Zebra ZD220',
    mode: 'local-agent',
    labelSize: '100x100',
    defaultFormat: 'zpl',
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
    surat: {
      kullaniciAdi: 'TEST',
      sifre: 'TEST',
      firmaId: '1',
      ortam: 'live',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      serviceType: 'OrtakBarkodOlusturSoap',
      createShipmentPath: '/api/OrtakBarkodOlustur',
      trackingServiceType: 'KargoTakipHareketDetayiSoap',
      trackingPath: '/api/KargoTakipHareketDetayi',
    },
  }
}
