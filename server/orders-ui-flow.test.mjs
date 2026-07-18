import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('Sipariş sekmeleri ilgili statüleri çeker ve şablon editörü görünürdür', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())

  const { statusesForFetch } = await vite.ssrLoadModule(
    '/src/utils/ordersTabs.ts',
  )
  const { LabelTemplatesPage } = await vite.ssrLoadModule(
    '/src/pages/LabelTemplatesPage.tsx',
  )
  const { OrdersPage } = await vite.ssrLoadModule(
    '/src/pages/OrdersPage.tsx',
  )
  const { defaultLabelTemplate } = await vite.ssrLoadModule(
    '/src/services/integrationConfigService.ts',
  )

  assert.ok(statusesForFetch('delivered').includes('Delivered'))
  assert.ok(statusesForFetch('delivered').includes('Created'))
  assert.ok(statusesForFetch('cancelReturn').includes('Cancelled'))
  assert.ok(statusesForFetch('cancelReturn').includes('Shipped'))
  assert.ok(statusesForFetch('labelReady').includes('Created'))
  assert.ok(statusesForFetch('currentSync').includes('Created'))
  assert.ok(statusesForFetch('all').includes('Delivered'))

  const html = renderToStaticMarkup(
    createElement(LabelTemplatesPage, {
      template: defaultLabelTemplate,
      orders: [buildOrder()],
      onSave: () => {},
    }),
  )
  assert.match(html, /Etiket Düzenleyici/)
  assert.match(html, /Yazı Boyutları/)
  assert.match(html, /Dengeli Boyutlara Dön/)
  assert.match(html, /Etikette Görünecek Alanlar/)
  assert.ok(
    html.indexOf('Yazı Boyutları') <
      html.indexOf('Etikette Görünecek Alanlar'),
  )
  assert.match(html, /--label-delivery-route-size:1[3-8]px/)
  assert.match(html, /--label-transfer-size:1[2-6]px/)

  const { OrderWorkflowService } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )
  const { OrdersTable } = await vite.ssrLoadModule(
    '/src/components/OrdersTable.tsx',
  )
  const { OrderDetailDrawer } = await vite.ssrLoadModule(
    '/src/components/OrderDetailDrawer.tsx',
  )
  const { resolveProductImage } = await vite.ssrLoadModule(
    '/src/utils/productImage.ts',
  )
  const { mapMarketplaceStatus, mapOperationStatus } =
    await vite.ssrLoadModule('/src/utils/statusPresentation.ts')
  const {
    isBarcodePending,
    isLabelReadyForPrint,
    migrateUnconfirmedSerendipState,
  } =
    await vite.ssrLoadModule('/src/utils/orderStatus.ts')
  const { buildVisibleOrders, classifyOrderForTabs } =
    await vite.ssrLoadModule('/src/utils/orderClassification.ts')
  const { resolveOrderStatus } =
    await vite.ssrLoadModule('/src/utils/shipmentStatus.ts')
  const { verifySuratShipment } =
    await vite.ssrLoadModule('/src/utils/suratVerification.ts')
  const { formatDisplayDate, formatDebugDateTime } =
    await vite.ssrLoadModule('/src/utils/formatters.ts')

  const shippedMarketplaceWithPendingSurat = {
    ...buildOrder(),
    id: 'shipped-marketplace-pending-surat',
    marketplaceStatus: 'Shipped',
    operationStatus: 'SURAT_CREATED_NO_TRACKING',
    status: 'Kargo Oluşturuldu',
    shipment: {
      dispatchRegistrationConfirmed: true,
      noTrackingReason: 'Sürat takip no henüz dönmedi',
      suratTrackingLog: {
        gonderilerLength: 1,
        KargonunDurumuSayi: '1',
      },
    },
  }
  const shippedMarketplaceClassification = classifyOrderForTabs(
    shippedMarketplaceWithPendingSurat,
  )
  const shippedMarketplaceResolvedStatus = resolveOrderStatus(
    shippedMarketplaceWithPendingSurat,
  )
  assert.equal(shippedMarketplaceResolvedStatus.statusSource, 'marketplace')
  assert.equal(shippedMarketplaceResolvedStatus.label, 'Kargoya Verildi')
  assert.equal(shippedMarketplaceClassification.isBarcodeWaiting, false)
  assert.equal(shippedMarketplaceClassification.isOpenOperation, false)
  assert.equal(shippedMarketplaceClassification.isHandedToCargo, true)
  assert.equal(
    buildVisibleOrders({
      persistentOrders: [shippedMarketplaceWithPendingSurat],
      selectedTab: 'barcodePending',
      marketplaceFilter: 'all',
      operationStatusFilter: 'all',
      cargoFilter: 'all',
      dateFilter: { preset: 'all' },
      searchQuery: '',
    }).visibleOrders.length,
    0,
  )
  assert.equal(
    buildVisibleOrders({
      persistentOrders: [shippedMarketplaceWithPendingSurat],
      selectedTab: 'handedToCargo',
      marketplaceFilter: 'all',
      operationStatusFilter: 'all',
      cargoFilter: 'all',
      dateFilter: { preset: 'all' },
      searchQuery: '',
    }).visibleOrders.length,
    1,
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
  const workflow = new OrderWorkflowService({}, {}, {}, {}, { append: () => [] })
  const imageUrl = 'https://cdn.example.com/product.jpg'
  const enriched = workflow.enrichOrderImages([buildOrder()], [
    {
      id: 'product-ui',
      marketplace: 'Trendyol',
      productContentId: 'CONTENT-UI',
      productName: 'Test Ürün',
      sku: 'zeynafb090-3',
      stockCode: 'zeynafb090-3',
      barcode: 'DIFFERENT-BARCODE',
      imageUrl,
      images: [imageUrl],
      stock: 1,
      price: 100,
      source: 'real',
      updatedAt: new Date().toISOString(),
    },
  ])
  assert.equal(enriched[0].items[0].imageUrl, imageUrl)
  assert.equal(enriched[0].items[0].imageResolvedFrom, 'productCache')
  assert.equal(enriched[0].items[0].matchedProductId, 'product-ui')
  // Yeni eşleştirme önceliği: barcode → merchantSku → sku → stockCode →
  // varyant kimlikleri → model → isim. Bu fixture sku ile eşleşir.
  assert.equal(enriched[0].items[0].matchedBy, 'sku')
  const persistedResolution = resolveProductImage(enriched[0].items[0], [
    {
      id: 'product-ui',
      marketplace: 'Trendyol',
      productContentId: 'CONTENT-UI',
      productName: 'Test Ürün',
      sku: 'zeynafb090-3',
      stockCode: 'zeynafb090-3',
      barcode: 'DIFFERENT-BARCODE',
      imageUrl,
      images: [imageUrl],
      stock: 1,
      price: 100,
      source: 'real',
      updatedAt: new Date().toISOString(),
    },
  ])
  assert.equal(persistedResolution.imageResolvedFrom, 'productCache')
  assert.equal(persistedResolution.matchedProductId, 'product-ui')
  assert.equal(persistedResolution.matchedBy, 'sku')
  assert.match(persistedResolution.imageSource, /^product\./)
  const tableHtml = renderToStaticMarkup(
    createElement(OrdersTable, {
      orders: enriched,
      products: [],
      selectedIds: [],
      onToggleOrder: () => {},
      onToggleAll: () => {},
      onOpenOrder: () => {},
      onDesiChange: () => {},
    }),
  )
  assert.match(tableHtml, /cdn\.example\.com\/product\.jpg/)
  assert.match(tableHtml, /Toplam koli desisi/)
  assert.match(tableHtml, /11336194107 Toplam koli desisi/)

  const barcodeMatchedOrder = buildOrder()
  barcodeMatchedOrder.items[0].productContentId = ''
  const barcodeResolution = resolveProductImage(barcodeMatchedOrder.items[0], [
    {
      id: 'barcode-product',
      marketplace: 'Trendyol',
      productName: 'Barkod eşleşen ürün',
      sku: 'OTHER-SKU',
      barcode: 'PRODUCT-UI',
      productImageUrl: 'https://cdn.example.com/barcode-match.jpg',
      stock: 1,
      price: 100,
      source: 'real',
      updatedAt: new Date().toISOString(),
    },
  ])
  assert.equal(barcodeResolution.imageResolvedFrom, 'productCache')
  assert.equal(barcodeResolution.matchedBy, 'barcode')
  assert.equal(barcodeResolution.matchedProductId, 'barcode-product')

  const rawLineImageOrder = buildOrder()
  rawLineImageOrder.items[0].productImageUrl = ''
  rawLineImageOrder.items[0].imageUrl = ''
  rawLineImageOrder.items[0].rawLine = {
    product: {
      media: [{ url: 'https://cdn.example.com/raw-line-media.jpg' }],
    },
  }
  const rawLineResolution = resolveProductImage(rawLineImageOrder.items[0], [])
  assert.equal(rawLineResolution.imageResolvedFrom, 'orderLine')
  assert.equal(rawLineResolution.matchedBy, 'orderLine')
  assert.match(rawLineResolution.url, /raw-line-media\.jpg/)

  const directImageUrl = 'https://cdn.example.com/direct-order-line.jpg'
  const directImageOrder = buildOrder()
  directImageOrder.items[0].productImageUrl = directImageUrl
  directImageOrder.items[0].imageResolvedFrom = 'orderLine'
  const directImageHtml = renderToStaticMarkup(
    createElement(OrdersTable, {
      orders: [directImageOrder],
      products: [],
      selectedIds: [],
      onToggleOrder: () => {},
      onToggleAll: () => {},
      onOpenOrder: () => {},
    }),
  )
  assert.match(directImageHtml, /direct-order-line\.jpg/)

  const placeholderHtml = renderToStaticMarkup(
    createElement(OrdersTable, {
      orders: [buildOrder({ withoutImageIdentity: true })],
      products: [],
      selectedIds: [],
      onToggleOrder: () => {},
      onToggleAll: () => {},
      onOpenOrder: () => {},
    }),
  )
  assert.match(placeholderHtml, /Görsel yok/)
  const missingResolution = resolveProductImage(
    buildOrder({ withoutImageIdentity: true }).items[0],
    [],
  )
  assert.equal(missingResolution.imageResolvedFrom, 'none')
  assert.equal(missingResolution.matchedBy, 'none')

  assert.equal(
    mapMarketplaceStatus('trendyol', 'Created').label,
    'Sipariş Oluştu',
  )
  assert.equal(
    mapMarketplaceStatus('trendyol', 'Picking').label,
    'Hazırlanıyor',
  )
  const pickingOrder = {
    ...buildOrder(),
    marketplaceStatus: 'Picking',
  }
  assert.equal(mapOperationStatus(pickingOrder).label, 'Barkod Bekliyor')
  const pickingHtml = renderToStaticMarkup(
    createElement(OrdersTable, {
      orders: [pickingOrder],
      products: [],
      selectedIds: [],
      onToggleOrder: () => {},
      onToggleAll: () => {},
      onOpenOrder: () => {},
    }),
  )
  assert.match(pickingHtml, /Barkod Bekliyor/)
  assert.match(pickingHtml, /Pazaryeri: Hazırlanıyor/)
  assert.doesNotMatch(pickingHtml, />Picking</)

  const persistedReady = {
    ...buildOrder(),
    cargoTrackingNumber: '7270033990557601',
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    matchStatus: true,
    shipment: {
      id: 'shipment-ui-ready',
      provider: 'surat-kargo',
      trackingNumber: '2512361562501',
      trackingUrl: '',
      shipmentCode: 'PKG-UI',
      barcodeValue: '0123990557601',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      operationName: 'OrtakBarkodOlustur',
      kargoTakipNo: '2512361562501',
      tNo: '2512361562501',
      barcode: '0123990557601',
      barcodeRaw: '^XA^FD0123990557601^FS^XZ',
      webSiparisKodu: '7270033990557601',
      ozelKargoTakipNo: '7270033990557601',
      status: 'created',
      source: 'real',
      rawResponse: {},
      verifiedShipment: true,
      dispatchRegistrationConfirmed: true,
      operationalBarcodeVerified: true,
      serdendipVerified: true,
      verificationStage: 'serdendip_verified',
      lifecycleStage: 'VERIFIED',
      suratTrackingLog: {
        gonderilerLength: 1,
        KargoTakipNo: '2512361562501',
        BarkodNo: '0123990557601',
        WebSiparisKodu: '7270033990557601',
        OzelKargoTakipNo: '7270033990557601',
      },
      createdAt: new Date().toISOString(),
    },
  }
  assert.equal(isBarcodePending(persistedReady), false)
  assert.equal(isLabelReadyForPrint(persistedReady), true)
  assert.equal(mapOperationStatus(persistedReady).label, 'Etiket Hazır')

  const legacyUnconfirmedPrinted = {
    ...persistedReady,
    status: 'Etiket Basıldı',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: {
      printedAt: new Date().toISOString(),
      printJobId: 'legacy-unconfirmed-print',
    },
    shipment: {
      ...persistedReady.shipment,
      trackingNumber: '89815102462541',
      kargoTakipNo: '89815102462541',
      tNo: '89815102462541',
      serdendipVerified: undefined,
      verificationStage: 'operational_barcode_verified',
      suratTrackingLog: undefined,
    },
  }
  const migratedUnconfirmed = migrateUnconfirmedSerendipState(
    legacyUnconfirmedPrinted,
  )
  const migratedUnconfirmedVerification = verifySuratShipment(
    migratedUnconfirmed,
  )
  assert.equal(migratedUnconfirmed.operationStatus, 'SURAT_TRACKING_MISSING')
  assert.equal(migratedUnconfirmed.labelStatus, 'BLOCKED')
  assert.equal(migratedUnconfirmed.shipment?.trackingNumber, '')
  assert.equal(migratedUnconfirmed.shipment?.tNo, '')
  assert.equal(migratedUnconfirmed.shipment?.printEnabled, false)
  assert.equal(migratedUnconfirmedVerification.trackingNumber, '')
  assert.equal(migratedUnconfirmedVerification.tNo, '')
  assert.equal(
    classifyOrderForTabs(migratedUnconfirmed).isLabelPrinted,
    false,
  )

  const legacyConfirmedByTracking = {
    ...legacyUnconfirmedPrinted,
    shipment: {
      ...legacyUnconfirmedPrinted.shipment,
      trackingNumber: '07414623015915',
      kargoTakipNo: '07414623015915',
      tNo: '07414623015915',
      suratTrackingLog: {
        gonderilerLength: 1,
        Gonderiler: [{}],
        KargoTakipNo: '07414623015915',
      },
    },
  }
  assert.equal(
    migrateUnconfirmedSerendipState(legacyConfirmedByTracking),
    legacyConfirmedByTracking,
  )

  const emptyTrackingWorkflow = new OrderWorkflowService(
    {},
    {
      trackShipment: async () => ({
        trackingReference: 'PKG-UI',
        responseStatus: 200,
        data: {
          ok: true,
          trackingState: 'SURAT_TRANSFERRED_BUT_NO_BARCODE',
          gonderilerLength: 0,
          tracking: {},
          suratTrackingLog: {
            rawRequest: {},
            rawResponse: {},
            parsedResponse: {},
            KargoTakipNo: '',
            TakipUrl: '',
            KargonunDurumu: '',
            KargonunDurumuSayi: '',
            Satiskodu: '',
            KargoObjId: '',
            SeriNo: '',
            SiraNo: '',
            Hareketler: [],
            Gonderiler: [],
            gonderilerLength: 0,
          },
        },
      }),
    },
    {},
    {},
    { append: () => [] },
  )
  const printedBeforeEmptyTracking = {
    ...persistedReady,
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: {
      printedAt: new Date().toISOString(),
      printJobId: 'print-job-empty-tracking',
    },
  }
  const emptyTrackingWorkflowResult =
    await emptyTrackingWorkflow.trackShipments(
      [printedBeforeEmptyTracking],
      [printedBeforeEmptyTracking.id],
      {},
    )
  assert.equal(
    emptyTrackingWorkflowResult.orders[0].operationStatus,
    'LABEL_PRINTED',
  )

  const failedBeforePendingTracking = {
    ...printedBeforeEmptyTracking,
    status: 'Hata',
    operationStatus: 'ERROR',
    labelStatus: 'BLOCKED',
    label: undefined,
  }
  const pendingTrackingWorkflowResult =
    await emptyTrackingWorkflow.trackShipments(
      [failedBeforePendingTracking],
      [failedBeforePendingTracking.id],
      {},
    )
  assert.equal(
    pendingTrackingWorkflowResult.orders[0].operationStatus,
    'SURAT_TRANSFERRED_BUT_NO_BARCODE',
  )
  assert.equal(
    pendingTrackingWorkflowResult.orders[0].status,
    'Takip no/T.No Alınamadı',
  )

  const deliveredTrackingWorkflow = new OrderWorkflowService(
    {},
    {
      trackShipment: async () => ({
        trackingReference: 'PKG-UI',
        responseStatus: 200,
        data: {
          ok: true,
          trackingState: 'TRACKING_CONFIRMED',
          gonderilerLength: 1,
          tracking: {
            KargoTakipNo: '2512361562501',
            Barkod: '0123990557601',
          },
          suratTrackingLog: {
            rawRequest: {},
            rawResponse: {},
            parsedResponse: {},
            KargoTakipNo: '2512361562501',
            Barkod: '0123990557601',
            TakipUrl: '',
            KargonunDurumu: 'Teslim Edildi',
            KargonunDurumuSayi: '6',
            SonHareketTarihi: '2026-06-19T12:30:00',
            Satiskodu: '',
            KargoObjId: '',
            SeriNo: '',
            SiraNo: '',
            Hareketler: [],
            Gonderiler: [{}],
            gonderilerLength: 1,
            createdAt: new Date().toISOString(),
          },
        },
      }),
    },
    {},
    {},
    { append: () => [] },
  )
  const deliveredTrackingWorkflowResult =
    await deliveredTrackingWorkflow.trackShipments(
      [persistedReady],
      [persistedReady.id],
      {},
    )
  assert.equal(
    deliveredTrackingWorkflowResult.orders[0].operationStatus,
    'DELIVERED',
  )
  assert.equal(
    deliveredTrackingWorkflowResult.orders[0].shipment.carrierStatusKey,
    'DELIVERED',
  )
  assert.equal(
    deliveredTrackingWorkflowResult.orders[0].shipment.deliveredAt,
    '2026-06-19T12:30:00',
  )

  const candidateDetailOrder = buildOrder()
  candidateDetailOrder.shipment = {
    candidateTNo: '41176176501029',
    candidateBarkodNo: '01249710673',
    candidateVerificationStatus: 'PENDING_VERIFICATION',
  }
  const detailHtml = renderToStaticMarkup(
    createElement(OrderDetailDrawer, {
      order: candidateDetailOrder,
      products: [
        {
          id: 'drawer-product',
          marketplace: 'Trendyol',
          productContentId: 'CONTENT-UI',
          productName: 'Drawer ürün',
          sku: 'drawer-sku',
          barcode: 'drawer-barcode',
          imageUrl: 'https://cdn.example.com/drawer-product.jpg',
          stock: 1,
          price: 100,
          source: 'real',
          updatedAt: new Date().toISOString(),
        },
      ],
      busy: false,
      onClose: () => {},
      onCreateShipment: () => {},
      onTrackShipment: () => {},
      onPreviewLabel: () => {},
      onDownloadZpl: () => {},
      onPrintLabel: () => {},
    }),
  )
  assert.match(detailHtml, /drawer-product\.jpg/)
  assert.match(detailHtml, /Ürün Görsel Debug/)
  assert.match(detailHtml, /drawer-product/)
  assert.match(detailHtml, /productContentId/)
  assert.match(detailHtml, /Aday T\.No/)
  assert.match(detailHtml, /41176176501029/)
  assert.match(detailHtml, /Aday Barkod/)
  assert.match(detailHtml, /01249710673/)
  assert.match(detailHtml, /Serendip/)
  assert.match(detailHtml, /Pazaryeri: Sipariş Oluştu/)

  const activeOrders = Array.from({ length: 11 }, (_, index) => ({
    ...buildOrder(),
    id: `active-${index}`,
    externalOrderId: `ACTIVE-${index}`,
    orderNumber: `ACTIVE-${index}`,
  }))
  const shippedOrders = Array.from({ length: 4 }, (_, index) => ({
    ...buildOrder(),
    id: `shipped-${index}`,
    externalOrderId: `SHIPPED-${index}`,
    orderNumber: `SHIPPED-${index}`,
    marketplaceStatus: 'Shipped',
    operationStatus: 'HANDED_TO_CARGO',
  }))
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayPending = {
    ...buildOrder(),
    id: 'active-yesterday',
    externalOrderId: 'ACTIVE-YESTERDAY',
    orderNumber: 'ACTIVE-YESTERDAY',
    createdAt: yesterday.toISOString(),
  }
  const ordersHtml = renderToStaticMarkup(
    createElement(OrdersPage, {
      orders: [...activeOrders, yesterdayPending, ...shippedOrders],
      products: [],
      labelTemplate: defaultLabelTemplate,
      labelMappingConfig: {},
      labelPreviewDrafts: {},
      selectedIds: [],
      busy: false,
      initialQuickTab: 'barcodePending',
      onToggleOrder: () => {},
      onToggleAll: () => {},
      onFetchOrders: () => {},
      onCreateShipments: () => {},
      onCreateShipmentForOrder: () => {},
      onTrackShipments: () => {},
      onTrackShipmentForOrder: () => {},
      onGenerateLabels: () => {},
      onDownloadZpl: () => {},
      onDownloadZplForOrder: () => {},
      onLabelMappingConfigChange: () => {},
      onLabelPreviewOverridesChange: () => {},
      onMarkPrinted: () => {},
      onMarkPrintedForOrder: () => {},
      onMarkHandedToCargo: () => {},
    }),
  )
  assert.match(ordersHtml, /Tüm Açık Operasyonlar \(12\)/)
  assert.match(ordersHtml, /Barkod Bekleyenler \(12\)/)
  assert.match(ordersHtml, /Kargoya Verilenler \(4\)/)
  assert.match(ordersHtml, /Tümü \(16\)/)
  assert.match(ordersHtml, /Tüm Tarihler/)

  const deliveredOrders = Array.from({ length: 154 }, (_, index) => ({
    ...buildOrder(),
    id: `delivered-${index}`,
    orderNumber: `DELIVERED-${index}`,
    marketplaceStatus: 'Delivered',
    operationStatus: 'DELIVERED',
  }))
  const canceledOrders = Array.from({ length: 9 }, (_, index) => ({
    ...buildOrder(),
    id: `canceled-${index}`,
    orderNumber: `CANCELED-${index}`,
    marketplaceStatus: index % 2 === 0 ? 'Cancelled' : 'Returned',
    operationStatus: 'ERROR',
  }))
  const persistentOrders = [...deliveredOrders, ...canceledOrders]
  const filters = {
    persistentOrders,
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
  }
  const allOrdersResult = buildVisibleOrders({
    ...filters,
    selectedTab: 'all',
  })
  assert.equal(allOrdersResult.visibleOrders.length, 163)
  assert.equal(allOrdersResult.debug.afterTabFilter, 163)
  assert.equal(allOrdersResult.debug.afterMarketplaceFilter, 163)
  assert.equal(allOrdersResult.debug.afterOperationStatusFilter, 163)
  assert.equal(allOrdersResult.debug.afterCargoFilter, 163)
  assert.equal(allOrdersResult.debug.afterDateFilter, 163)
  assert.equal(allOrdersResult.debug.afterSearch, 163)
  assert.equal(
    buildVisibleOrders({ ...filters, selectedTab: 'delivered' }).visibleOrders
      .length,
    154,
  )
  assert.equal(
    buildVisibleOrders({ ...filters, selectedTab: 'cancelReturn' }).visibleOrders
      .length,
    9,
  )
  assert.equal(
    buildVisibleOrders({ ...filters, selectedTab: 'archive' }).visibleOrders
      .length,
    0,
  )

  const explicitlyArchived = {
    ...buildOrder(),
    id: 'explicitly-archived',
    archived: true,
  }
  assert.equal(classifyOrderForTabs(explicitlyArchived).isArchived, true)
  assert.equal(classifyOrderForTabs(deliveredOrders[0]).isArchived, false)

  const createdClassification = classifyOrderForTabs(buildOrder())
  const pickingClassification = classifyOrderForTabs({
    ...buildOrder(),
    marketplaceStatus: 'Picking',
  })
  assert.equal(createdClassification.isDelivered, false)
  assert.equal(createdClassification.isBarcodeWaiting, true)
  assert.equal(pickingClassification.isDelivered, false)
  assert.equal(pickingClassification.isBarcodeWaiting, true)

  const suratDelivered = {
    ...buildOrder(),
    marketplaceStatus: 'Created',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    deliveryDate: '2026-06-01T10:00:00.000Z',
    label: {
      printedAt: '2026-06-02T11:00:00.000Z',
    },
    shipment: {
      id: 'surat-delivered',
      provider: 'surat-kargo',
      trackingNumber: '25220148446193',
      trackingUrl: '',
      shipmentCode: 'PKG-DELIVERED',
      barcodeValue: '01231201025',
      status: 'created',
      source: 'real',
      rawResponse: {},
      createdAt: new Date().toISOString(),
      suratTrackingLog: {
        rawRequest: {},
        rawResponse: {},
        parsedResponse: {},
        KargoTakipNo: '25220148446193',
        TakipUrl: '',
        KargonunDurumu: 'Teslim Edildi',
        KargonunDurumuSayi: '6',
        Satiskodu: '',
        KargoObjId: '',
        SeriNo: '',
        SiraNo: '',
        Hareketler: [],
        Gonderiler: [{}],
        gonderilerLength: 1,
      },
    },
  }
  const suratDeliveredStatus = resolveOrderStatus(suratDelivered)
  assert.equal(suratDeliveredStatus.label, 'Teslim Edildi')
  assert.equal(suratDeliveredStatus.statusSource, 'suratTracking')
  assert.equal(suratDeliveredStatus.sourceLabel, 'Sürat Kargo Takip')
  assert.equal(suratDeliveredStatus.delivered, true)

  const emptyTracking = {
    ...suratDelivered,
    operationStatus: 'LABEL_PRINTED',
    shipment: {
      ...suratDelivered.shipment,
      suratTrackingLog: {
        ...suratDelivered.shipment.suratTrackingLog,
        KargonunDurumu: '',
        KargonunDurumuSayi: '',
        Gonderiler: [],
        gonderilerLength: 0,
      },
    },
  }
  const emptyTrackingStatus = resolveOrderStatus(emptyTracking)
  assert.equal(emptyTrackingStatus.label, 'Etiket Basıldı')
  assert.equal(emptyTrackingStatus.statusSource, 'localOperation')
  assert.equal(emptyTrackingStatus.delivered, false)

  const trendyolDeliveredStatus = resolveOrderStatus({
    ...buildOrder(),
    marketplaceStatus: 'Delivered',
  })
  assert.equal(trendyolDeliveredStatus.label, 'Teslim Edildi')
  assert.equal(trendyolDeliveredStatus.statusSource, 'marketplace')

  const trendyolShippedStatus = resolveOrderStatus({
    ...buildOrder(),
    marketplaceStatus: 'Shipped',
  })
  assert.equal(trendyolShippedStatus.label, 'Kargoya Verildi')
  assert.equal(trendyolShippedStatus.statusSource, 'marketplace')

  const plannedDateOnlyStatus = resolveOrderStatus({
    ...buildOrder(),
    deliveryDate: '2020-01-01T00:00:00.000Z',
  })
  assert.equal(plannedDateOnlyStatus.delivered, false)
  assert.equal(plannedDateOnlyStatus.plannedDeliveryDateIgnoredForStatus, true)

  assert.equal(formatDisplayDate('2026-06-14T19:27:00.000Z'), '14.06.2026')
  assert.equal(formatDisplayDate('invalid-date'), '-')
  assert.match(
    formatDebugDateTime('2026-06-14T19:27:00.000Z'),
    /14\.06\.2026/,
  )

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const oldOrder = {
    ...buildOrder(),
    id: 'old-order',
    createdAt: '2024-01-01T12:00:00.000Z',
  }
  assert.equal(
    buildVisibleOrders({
      ...filters,
      persistentOrders: [oldOrder],
      selectedTab: 'all',
      dateFilter: { preset: 'all' },
    }).visibleOrders.length,
    1,
  )
  assert.equal(
    buildVisibleOrders({
      ...filters,
      persistentOrders: [oldOrder],
      selectedTab: 'all',
      dateFilter: {
        preset: 'today',
        startTime: todayStart.getTime(),
        endTime: Date.now(),
      },
    }).visibleOrders.length,
    0,
  )

  const previousSyncAt = '2026-06-24T10:00:00.000Z'
  const latestSyncAt = '2026-06-25T10:00:00.000Z'
  const staleOpenOrders = Array.from({ length: 4 }, (_, index) => ({
    ...buildOrder(),
    id: `stale-open-${index}`,
    orderNumber: `STALE-${index}`,
    packageId: `STALE-PKG-${index}`,
    orderDate: previousSyncAt,
    lastMarketplaceSyncedAt: previousSyncAt,
    lastMarketplaceSyncBatchId: previousSyncAt,
  }))
  const latestSyncedOrders = Array.from({ length: 34 }, (_, index) => ({
    ...buildOrder(),
    id: `latest-sync-${index}`,
    orderNumber: `LATEST-${index}`,
    packageId: `LATEST-PKG-${index}`,
    marketplaceStatus: 'Delivered',
    operationStatus: 'DELIVERED',
    orderDate: latestSyncAt,
    lastMarketplaceSyncedAt: latestSyncAt,
    lastMarketplaceSyncBatchId: latestSyncAt,
  }))
  const oldOrderSeenInLatestSync = {
    ...buildOrder(),
    id: 'latest-sync-old-order',
    orderNumber: 'LATEST-BUT-OLD',
    packageId: 'LATEST-BUT-OLD-PKG',
    orderDate: '2026-06-01T10:00:00.000Z',
    lastMarketplaceSyncedAt: latestSyncAt,
    lastMarketplaceSyncBatchId: latestSyncAt,
  }
  const latestSyncResult = buildVisibleOrders({
    ...filters,
    persistentOrders: [
      ...staleOpenOrders,
      ...latestSyncedOrders,
      oldOrderSeenInLatestSync,
    ],
    selectedTab: 'currentSync',
    dateFilter: { preset: 'all' },
  })
  assert.equal(latestSyncResult.visibleOrders.length, 34)
  assert.equal(latestSyncResult.debug.latestSyncCount, 34)
  assert.equal(latestSyncResult.debug.afterTabFilter, 34)
  assert.equal(
    latestSyncResult.visibleOrders.some(
      (order) => order.orderNumber === 'LATEST-BUT-OLD',
    ),
    false,
  )
  assert.equal(
    buildVisibleOrders({
      ...filters,
      persistentOrders: [...staleOpenOrders, ...latestSyncedOrders],
      selectedTab: 'open',
      dateFilter: { preset: 'all' },
    }).visibleOrders.length,
    4,
  )
})

function buildOrder(options = {}) {
  return {
    id: 'order-ui',
    marketplace: 'Trendyol',
    externalOrderId: '11336194107',
    orderNumber: '11336194107',
    packageId: 'PKG-UI',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    source: 'real',
    status: 'Yeni',
    customerName: 'Şükran Güneş',
    customerPhone: '5550000000',
    customerEmail: '',
    address: 'Başakşehir Mahallesi Süleyman Caddesi Evila Evleri Sitesi',
    city: 'İstanbul',
    district: 'Başakşehir',
    totalAmount: 100,
    createdAt: new Date().toISOString(),
    items: [
      {
        id: 'item-ui',
        productName: 'Yandan Kuyruklu İspanyol Kol Saten Tesettür Abiye',
        sku: 'zeynafb090-3',
        barcode: 'PRODUCT-UI',
        productContentId: options.withoutImageIdentity ? '' : 'CONTENT-UI',
        color: 'Lacivert',
        size: '38',
        quantity: 1,
        variantAttributes: [],
      },
    ],
  }
}
