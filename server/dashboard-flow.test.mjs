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
  const {
    normalizeProductImageUrl,
    normalizeProductIdentifier,
    resolveProductCacheMatch,
    resolveProductImageCandidates,
  } = await vite.ssrLoadModule('/src/utils/productImage.ts')
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
      onCreateShipment: () => {},
      onTrackShipment: () => {},
      onDesiChange: () => {},
    }),
  )
  assert.match(html, /Dashboard/)
  assert.match(html, /aria-label=/)
  assert.match(html, /data-order-number=/)
  assert.match(html, /Açık Operasyon/)
  assert.match(html, /Satış Analitiği/)
  assert.match(html, /Satış \(Net\)/)
  assert.match(html, /İade \/ İptal \(Net\)/)
  assert.match(html, /Geçen Ay/)
  assert.match(html, /7 Gün/)
  assert.match(html, /Operasyon Akışı/)
  assert.match(html, /Operasyon Analitiği/)
  assert.match(html, /Aksiyon Gerektirenler/)
  assert.match(html, /Son Operasyonlar/)
  assert.match(html, /En Çok Satan Ürünler/)
  assert.match(html, /Sürat Kargo/)
  assert.doesNotMatch(html, /hazırlık oranı/i)
  assert.doesNotMatch(html, /başarı oranı/i)
  assert.doesNotMatch(html, /Kalıcı operasyon listesindeki tüm siparişler/i)
  assert.doesNotMatch(html, /Toplam Sipariş/)

  // Lifecycle uyumu: LABEL_READY_AWAITING_ACCEPTANCE (ön-atanmış kodlar +
  // ZPL) Barkod Bekleyen DEĞİLDİR, Etiket Hazır'dır, hata sayılmaz.
  const preassignedOrder = buildPreassignedOrder('PRE1')
  const preassignedSummary = buildDashboardSummary({
    orders: [preassignedOrder],
    ...integrations,
    printerSettings,
  })
  assert.equal(preassignedSummary.barcodeWaiting, 0)
  assert.equal(preassignedSummary.labelReady, 1)
  assert.equal(preassignedSummary.errors, 0)
  assert.equal(preassignedSummary.openOperations, 1)
  assert.equal(preassignedSummary.recentOrders[0].status, 'Etiket Hazır')
  const preassignedTabs = buildVisibleOrders({
    persistentOrders: [preassignedOrder],
    selectedTab: 'labelReady',
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
  })
  assert.equal(preassignedTabs.visibleOrders.length, 1)
  const preassignedBarcodeTab = buildVisibleOrders({
    persistentOrders: [preassignedOrder],
    selectedTab: 'barcodePending',
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
  })
  assert.equal(preassignedBarcodeTab.visibleOrders.length, 0)

  // Preassigned + gerçekten basılmış → Etiket Basıldı sayılır.
  const preassignedPrinted = {
    ...preassignedOrder,
    status: 'Etiket Basıldı',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: {
      id: 'label-pre-printed',
      labelType: 'zpl',
      barcodeFormat: 'Code128',
      barcodeValue: preassignedOrder.shipment.barkodNo,
      templateId: 'tpl',
      zplContent: preassignedOrder.shipment.barcodeRaw,
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      createdAt: new Date().toISOString(),
      printedAt: new Date().toISOString(),
      printCount: 1,
    },
  }
  const preassignedPrintedSummary = buildDashboardSummary({
    orders: [preassignedPrinted],
    ...integrations,
    printerSettings,
  })
  assert.equal(preassignedPrintedSummary.labelPrinted, 1)
  assert.equal(preassignedPrintedSummary.labelReady, 0)

  // printEnabled=true ama printedAt yok → basıldı SAYILMAZ.
  assert.equal(preassignedSummary.labelPrinted, 0)

  // Aynı packageId iki satırdan gelirse sayaçlar bir kez sayar.
  const duplicateSummary = buildDashboardSummary({
    orders: [
      preassignedOrder,
      { ...preassignedOrder, id: 'duplicate-row-id' },
      buildOrder('UNIQ'),
    ],
    ...integrations,
    printerSettings,
  })
  assert.equal(duplicateSummary.totalOrders, 2)
  assert.equal(duplicateSummary.labelReady, 1)
  assert.equal(duplicateSummary.barcodeWaiting, 1)
  assert.equal(duplicateSummary.openOperations, 2)

  // Dashboard kartı → Siparişler geçiş sözleşmesi: filtreler varsayılana
  // döndüğünde kart sayısı, hedef sekmenin görünür TEKİL paket sayısına eşit.
  const parityOrders = [
    preassignedOrder,
    { ...preassignedOrder, id: 'duplicate-row-id' },
    buildOrder('P1'),
    buildOrder('P2'),
  ]
  const paritySummary = buildDashboardSummary({
    orders: parityOrders,
    ...integrations,
    printerSettings,
  })
  const defaultFilters = {
    persistentOrders: parityOrders,
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
  }
  const uniquePackages = (list) =>
    new Set(
      list.map((order) =>
        String(order.packageId || order.shipmentPackageId || order.id),
      ),
    ).size
  assert.equal(
    uniquePackages(
      buildVisibleOrders({ ...defaultFilters, selectedTab: 'labelReady' })
        .visibleOrders,
    ),
    paritySummary.labelReady,
  )
  assert.equal(
    uniquePackages(
      buildVisibleOrders({ ...defaultFilters, selectedTab: 'barcodePending' })
        .visibleOrders,
    ),
    paritySummary.barcodeWaiting,
  )
  assert.equal(
    uniquePackages(
      buildVisibleOrders({ ...defaultFilters, selectedTab: 'open' })
        .visibleOrders,
    ),
    paritySummary.openOperations,
  )

  // Ürün görseli çözümleme sözleşmesi.
  assert.equal(
    normalizeProductImageUrl('//cdn.dsmcdn.com/x/y.jpg'),
    'https://cdn.dsmcdn.com/x/y.jpg',
  )
  assert.equal(
    normalizeProductImageUrl('http://cdn.dsmcdn.com/x.jpg'),
    'https://cdn.dsmcdn.com/x.jpg',
  )
  assert.equal(
    normalizeProductImageUrl(
      '  https://cdn.dsmcdn.com/a.jpg?w=100&amp;h=100  ',
    ),
    'https://cdn.dsmcdn.com/a.jpg?w=100&h=100',
  )
  assert.equal(normalizeProductImageUrl('javascript:alert(1)'), '')
  assert.equal(normalizeProductImageUrl(''), '')

  // Öncelik: line.productImageUrl → imageUrl; aynı URL dedupe edilir.
  const lineItem = {
    id: 'line-1',
    productName: 'Ürün',
    quantity: 1,
    variantAttributes: [],
    productImageUrl: 'https://cdn.dsmcdn.com/primary.jpg',
    imageUrl: 'https://cdn.dsmcdn.com/primary.jpg',
    rawLine: {
      productImageUrl: 'https://cdn.dsmcdn.com/primary.jpg',
      imageUrl: '//cdn.dsmcdn.com/secondary.jpg',
    },
  }
  const lineCandidates = resolveProductImageCandidates(lineItem, [])
  assert.equal(lineCandidates[0].url, 'https://cdn.dsmcdn.com/primary.jpg')
  assert.equal(lineCandidates[1].url, 'https://cdn.dsmcdn.com/secondary.jpg')
  assert.equal(
    new Set(lineCandidates.map((candidate) => candidate.url)).size,
    lineCandidates.length,
  )

  // productImageUrl boşsa imageUrl kullanılır.
  const fallbackItem = {
    ...lineItem,
    productImageUrl: '',
    rawLine: { imageUrl: 'https://cdn.dsmcdn.com/only-imageurl.jpg' },
    imageUrl: '',
  }
  assert.equal(
    resolveProductImageCandidates(fallbackItem, [])[0].url,
    'https://cdn.dsmcdn.com/only-imageurl.jpg',
  )

  // Eski persisted kayıt: normalized alanlar boş, raw payload'da görsel var
  // → read-time fallback devreye girer.
  const legacyItem = {
    id: 'line-legacy',
    productName: 'Legacy Ürün',
    quantity: 1,
    variantAttributes: [],
    productImageUrl: '',
    imageUrl: '',
    rawLine: {
      product: { images: ['https://cdn.dsmcdn.com/raw-product.jpg'] },
    },
  }
  assert.equal(
    resolveProductImageCandidates(legacyItem, [])[0].url,
    'https://cdn.dsmcdn.com/raw-product.jpg',
  )

  // Hiç görsel yoksa aday listesi boş → UI placeholder gösterir.
  const emptyItem = {
    id: 'line-empty',
    productName: 'Görselsiz',
    quantity: 1,
    variantAttributes: [],
    rawLine: {},
  }
  assert.equal(resolveProductImageCandidates(emptyItem, []).length, 0)

  // Görsel eksikliği operasyonel sınıflandırmayı ETKİLEMEZ:
  // görselsiz preassigned sipariş yine Etiket Hazır'dır.
  const imagelessPreassigned = {
    ...buildPreassignedOrder('IMGLESS'),
    items: [emptyItem],
  }
  const imagelessSummary = buildDashboardSummary({
    orders: [imagelessPreassigned],
    ...integrations,
    printerSettings,
  })
  assert.equal(imagelessSummary.labelReady, 1)
  assert.equal(imagelessSummary.errors, 0)

  // ---- Ürün cache eşleştirme sözleşmesi ----
  const cacheProduct = (overrides = {}) => ({
    id: `prod-${overrides.barcode || overrides.productMainId || Math.random()}`,
    marketplace: 'Trendyol',
    productName: 'Önü Drapeli Loş Tesettür Takım 6496',
    barcode: '',
    sku: '',
    stockCode: '',
    productCode: '',
    productMainId: '6496',
    color: 'Krem',
    size: '42',
    images: ['https://cdn.dsmcdn.com/model-6496.jpg'],
    imageUrl: 'https://cdn.dsmcdn.com/model-6496.jpg',
    source: 'real',
    createdAt: new Date().toISOString(),
    ...overrides,
  })
  const cacheItem = (overrides = {}) => ({
    id: 'line-cache',
    productName: 'Önü Drapeli Loş Tesettür Takım 6496, 42',
    quantity: 1,
    variantAttributes: [],
    rawLine: {},
    ...overrides,
  })

  // Test 1: ayraç varyasyonu — 649688-5 siparişi, 649688_5 ürün barkoduyla eşleşir.
  assert.equal(
    normalizeProductIdentifier('649688-5'),
    normalizeProductIdentifier('649688_5'),
  )
  assert.equal(
    normalizeProductIdentifier('649688-5'),
    normalizeProductIdentifier('649688/5'),
  )
  assert.notEqual(
    normalizeProductIdentifier('649688-5'),
    normalizeProductIdentifier('649688-6'),
  )
  const separatorMatch = resolveProductCacheMatch(
    cacheItem({ barcode: '649688-5' }),
    [cacheProduct({ barcode: '649688_5' })],
  )
  assert.equal(separatorMatch.matchedBy, 'barcode')
  assert.equal(separatorMatch.failureReason, '')

  // Test 2: barkod yok, merchantSku + beden birebir → merchantSku eşleşir.
  // merchantSku TEK BAŞINA (beden teyidi olmadan) yeterli DEĞİLDİR; aynı
  // merchantSku birden çok varyantı temsil edebilir.
  const merchantMatch = resolveProductCacheMatch(
    cacheItem({
      merchantSku: 'MRC-001',
      size: '42',
      productName: 'Bilinmeyen Ürün X',
    }),
    [cacheProduct({ sku: 'MRC-001' })],
  )
  assert.equal(merchantMatch.matchedBy, 'merchantSku')
  assert.ok(merchantMatch.product)
  const merchantWithoutSize = resolveProductCacheMatch(
    cacheItem({ merchantSku: 'MRC-001', productName: 'Bilinmeyen Ürün X' }),
    [cacheProduct({ sku: 'MRC-001' })],
  )
  assert.equal(merchantWithoutSize.matchedBy, 'none')
  assert.equal(merchantWithoutSize.failureReason, 'VARIANT_NOT_IN_CACHE')

  // Test 3a: isimde model kodu varsa model eşleşmesi öncelikli ve doğrudur.
  const nameModelMatch = resolveProductCacheMatch(
    cacheItem({ color: 'Krem', size: '42' }),
    [cacheProduct()],
  )
  assert.equal(nameModelMatch.matchedBy, 'modelColorSize')
  assert.ok(nameModelMatch.product)

  // Test 3b: kimlik ve model kodu yok — isim + renk + beden güvenli fallback.
  const nameMatch = resolveProductCacheMatch(
    cacheItem({
      productName: 'Saten Uzun Kollu Elbise, 42',
      color: 'Krem',
      size: '42',
    }),
    [
      cacheProduct({
        productName: 'Saten Uzun Kollu Elbise',
        productMainId: 'SATEN-ELB',
      }),
    ],
  )
  assert.equal(nameMatch.matchedBy, 'normalizedNameColorSize')
  assert.ok(nameMatch.product)

  // Model + varyant: sipariş barkodu katalogdakinden tamamen farklı olsa
  // bile productMainId + beden üzerinden doğru varyant bulunur (77852 örneği).
  const modelMatch = resolveProductCacheMatch(
    cacheItem({
      productName: 'Luna Zarafet Tesettür Kırmızı Abiye 77852, 36',
      barcode: 'fb7785213',
      size: '36',
    }),
    [
      cacheProduct({
        productName: 'Luna Zarafet Tesettür Kırmızı Abiye 77852',
        productMainId: '77852',
        barcode: 'asjdhıahsd715',
        size: '36',
        color: 'Siyahh',
        images: ['https://cdn.dsmcdn.com/77852.jpg'],
        imageUrl: 'https://cdn.dsmcdn.com/77852.jpg',
      }),
    ],
  )
  assert.equal(modelMatch.matchedBy, 'modelColorSize')
  assert.ok(modelMatch.product)

  // Test 4: aynı isim iki FARKLI modelde → belirsiz parent → eşleşme yok.
  const ambiguous = resolveProductCacheMatch(cacheItem(), [
    cacheProduct({ productMainId: 'MODEL-A' }),
    cacheProduct({ productMainId: 'MODEL-B' }),
  ])
  assert.equal(ambiguous.matchedBy, 'none')
  assert.equal(ambiguous.failureReason, 'MULTIPLE_NAME_MATCHES')

  // Test 5: ürün bulundu ama görseli yok → aday listesi boş kalır.
  const noImageProduct = cacheProduct({
    barcode: 'NOIMG-1',
    images: [],
    imageUrl: '',
  })
  const noImageCandidates = resolveProductImageCandidates(
    cacheItem({ barcode: 'NOIMG-1' }),
    [noImageProduct],
  )
  assert.equal(noImageCandidates.length, 0)

  // Test 6: cache boş → CACHE_NOT_SYNCED.
  const emptyCache = resolveProductCacheMatch(cacheItem(), [])
  assert.equal(emptyCache.failureReason, 'CACHE_NOT_SYNCED')

  // Test 7: placeholder değerler kimlik sayılmaz.
  assert.equal(normalizeProductIdentifier('merchantSku'), '')
  assert.equal(normalizeProductIdentifier('sku'), '')
  assert.equal(normalizeProductIdentifier(' - '), '')
  assert.equal(normalizeProductIdentifier('null'), '')
  const placeholderResult = resolveProductCacheMatch(
    cacheItem({
      productName: 'Kısa Ad',
      merchantSku: 'merchantSku',
      sku: 'sku',
    }),
    [cacheProduct({ sku: 'merchantsku', productName: 'Kısa Ad' })],
  )
  assert.equal(placeholderResult.matchedBy, 'none')

  // Test 8: eşleşme değişiklikleri sayaçları/eligibility'yi etkilemez —
  // görselsiz preassigned yine Etiket Hazır (yukarıda doğrulandı) ve
  // varyant index'i verified fixture'ların sınıflandırmasını değiştirmedi
  // (bu testin önceki tüm assert'leri aynı koşuda geçti).
})

function buildPreassignedOrder(suffix) {
  const numericSuffix = toNumericSuffix(suffix)
  const trackingNumber = `9971862145${numericSuffix.padStart(4, '0')}`
  const barcodeNumber = `0125000803${numericSuffix}`
  const webSiparisKodu = `7270077${numericSuffix}`
  const barcodeRaw = `^XA^FO20,20^FDT.No: ${trackingNumber}^FS^FT48,300^BCN,,Y,N^FD>:${barcodeNumber}^FS^XZ`
  return {
    ...buildOrder(suffix),
    cargoTrackingNumber: webSiparisKodu,
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    cargoProviderName: 'Sürat Kargo',
    shipment: {
      id: `shipment-${suffix}`,
      provider: 'surat-kargo',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      operationName: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      trackingNumber,
      kargoTakipNo: trackingNumber,
      tNo: trackingNumber,
      barcode: barcodeNumber,
      barkodNo: barcodeNumber,
      barcodeValue: barcodeNumber,
      finalSuratBarcode: barcodeNumber,
      barcodeRaw,
      trackingUrl: '',
      shipmentCode: `PKG-${suffix}`,
      webSiparisKodu,
      ozelKargoTakipNo: webSiparisKodu,
      barcodeSource: 'surat.create.preassignedBarkod',
      trackingSource: 'surat.create.preassignedTNo',
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      labelStatus: 'READY',
      status: 'created',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      verificationStage: 'preassigned_awaiting_acceptance',
      printEnabled: true,
      source: 'real',
      verifiedShipment: false,
      dispatchRegistrationConfirmed: false,
      operationalBarcodeVerified: false,
      serdendipVerified: false,
      noTrackingReason: 'Etiket hazır; fiziksel Sürat kabulü bekleniyor.',
      diagnosticMessage:
        'Etiket yazdırılabilir; Serendip kaydı fiziksel tesellümden sonra doğrulanacaktır.',
      rawResponse: {},
      createdAt: new Date().toISOString(),
    },
  }
}

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
  const trackingNumber = `25123615625${numericSuffix}`
  const barcodeNumber = `0123990557${numericSuffix}`
  const webSiparisKodu = `7270099${numericSuffix}`
  return {
    ...buildOrder(suffix),
    cargoTrackingNumber: webSiparisKodu,
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    cargoProviderName: 'Sürat Kargo',
    shipment: {
      id: `shipment-${suffix}`,
      provider: 'surat-kargo',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      operationName: 'OrtakBarkodOlustur',
      trackingNumber,
      kargoTakipNo: trackingNumber,
      tNo: trackingNumber,
      barcode: barcodeNumber,
      barcodeRaw,
      trackingUrl: '',
      shipmentCode: `PKG-${suffix}`,
      webSiparisKodu,
      ozelKargoTakipNo: webSiparisKodu,
      barcodeValue: barcodeNumber,
      barcodeSource: 'surat.ortakBarkod.Barcode',
      zplSource: 'surat.ortakBarkod.BarcodeRaw',
      labelStatus: 'READY',
      status: 'created',
      lifecycleStatus: 'LABEL_READY',
      source: 'real',
      verifiedShipment: true,
      dispatchRegistrationConfirmed: true,
      operationalBarcodeVerified: true,
      serdendipVerified: true,
      verificationStage: 'serdendip_verified',
      lifecycleStage: 'VERIFIED',
      suratTrackingLog: {
        gonderilerLength: 1,
        KargoTakipNo: trackingNumber,
        BarkodNo: barcodeNumber,
        WebSiparisKodu: webSiparisKodu,
        OzelKargoTakipNo: webSiparisKodu,
      },
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
