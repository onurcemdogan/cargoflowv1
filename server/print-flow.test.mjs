import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('Zebra baskı state, hata ve yeniden baskı kuralları', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())

  const { OrderWorkflowService } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )
  const { ZebraZplLabelProvider } = await vite.ssrLoadModule(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const { PrintPreviewModal } = await vite.ssrLoadModule(
    '/src/components/PrintPreviewModal.tsx',
  )
  const { LabelPreviewModal } = await vite.ssrLoadModule(
    '/src/components/LabelPreviewModal.tsx',
  )
  const { resolvePrintableLabel } = await vite.ssrLoadModule(
    '/src/utils/printableLabel.ts',
  )
  const {
    buildCleanLabelHtml,
    cancelReservedCleanLabelPrintWindow,
    reserveCleanLabelPrintWindow,
  } = await vite.ssrLoadModule(
    '/src/utils/browserLabelPrint.ts',
  )
  const {
    isLabelPrinted,
    isLabelReadyForPrint,
    migrateSuspiciousPrintedState,
  } = await vite.ssrLoadModule('/src/utils/orderStatus.ts')

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

  let reservedHtml = ''
  let openedPrintWindow = false
  const fakePrintWindow = {
    closed: false,
    document: {
      open: () => {},
      write: (html) => {
        reservedHtml = html
      },
      close: () => {},
    },
    close() {
      this.closed = true
    },
  }
  globalThis.window.open = () => {
    openedPrintWindow = true
    return fakePrintWindow
  }
  const reservedWindow = reserveCleanLabelPrintWindow()
  assert.equal(openedPrintWindow, true)
  assert.equal(reservedWindow, fakePrintWindow)
  assert.match(reservedHtml, /Etiket/)
  cancelReservedCleanLabelPrintWindow()
  assert.equal(fakePrintWindow.closed, true)

  const labelProvider = new ZebraZplLabelProvider()
  const audit = { append: () => [] }
  const successPrinter = createPrintProvider(true)
  const workflow = new OrderWorkflowService(
    {},
    { createShipment: async () => buildShipment() },
    labelProvider,
    successPrinter,
    audit,
  )

  // Test 1: Ortak barkod başarısı yalnız READY yapar.
  const created = await workflow.createShipments(
    [buildOrder('1')],
    ['order-1'],
    buildConfig(),
  )
  const readyOrder = created.orders[0]
  assert.equal(readyOrder.labelStatus, 'READY')
  assert.equal(readyOrder.operationStatus, 'LABEL_READY')
  assert.equal(readyOrder.status, 'Etiket Hazır')
  assert.equal(readyOrder.label?.printedAt, undefined)
  assert.equal(isLabelReadyForPrint(readyOrder), true)
  assert.equal(isLabelPrinted(readyOrder), false)

  const cleanPrintHtml = buildCleanLabelHtml(
    [readyOrder],
    buildTemplate(),
  )
  assert.match(cleanPrintHtml, /@page \{ size: 100mm 100mm; margin: 0; \}/)
  assert.match(cleanPrintHtml, /width: 100mm/)
  assert.match(cleanPrintHtml, /height: 100mm/)
  assert.equal((cleanPrintHtml.match(/class="label-page"/g) ?? []).length, 1)
  assert.match(cleanPrintHtml, /SURAT KARGO/)
  assert.match(cleanPrintHtml, /T.No/)
  assert.match(cleanPrintHtml, /surat-barcode/)
  assert.match(cleanPrintHtml, /<body>[\s\S]*class="label-page"/)
  assert.match(cleanPrintHtml, /CargoFlow Etiket/)
  assert.match(cleanPrintHtml, /01231201021/)
  assert.doesNotMatch(cleanPrintHtml, /modal-backdrop|icon-button|127\.0\.0\.1/)

  const marketplaceCodeOnly = '7270034052882693'
  const marketplaceCodeOrder = {
    ...buildOrder('MARKETPLACE-CODE'),
    cargoTrackingNumber: marketplaceCodeOnly,
    shipment: {
      ...buildShipment('MARKETPLACE-CODE'),
      trackingNumber: marketplaceCodeOnly,
      kargoTakipNo: marketplaceCodeOnly,
      barcode: marketplaceCodeOnly,
      barcodeValue: marketplaceCodeOnly,
      finalSuratBarcode: marketplaceCodeOnly,
      barcodeSource: 'trendyol.cargoTrackingNumber',
      trackingSource: 'trendyol.cargoTrackingNumber',
      barcodeRaw: '',
      rawResponse: {
        parsedResponse: {
          KargoTakipNo: marketplaceCodeOnly,
          Barcode: marketplaceCodeOnly,
          BarcodeRaw: '',
        },
      },
      suratCreateLog: {
        ...buildShipment('MARKETPLACE-CODE').suratCreateLog,
        KargoTakipNo: marketplaceCodeOnly,
        Barcode: marketplaceCodeOnly,
        BarcodeRaw: '',
        parsedResponse: {
          KargoTakipNo: marketplaceCodeOnly,
          Barcode: marketplaceCodeOnly,
          BarcodeRaw: '',
        },
      },
    },
  }
  const marketplaceCodeResolution = resolvePrintableLabel(marketplaceCodeOrder)
  assert.equal(marketplaceCodeResolution.canPreview, false)
  assert.equal(marketplaceCodeResolution.canPrint, false)
  assert.throws(
    () => buildCleanLabelHtml([marketplaceCodeOrder], buildTemplate()),
    /S.rat barkod de.eri/,
  )

  // Test 2: Önizleme label üretir ama sipariş state'ini değiştirmez.
  const previewLabel = await labelProvider.generateSingle({
    order: readyOrder,
    shipment: readyOrder.shipment,
    template: buildTemplate(),
  })
  assert.equal(previewLabel.zplSource, 'generated')
  assert.equal(previewLabel.desi, 2)
  assert.match(previewLabel.zplContent, /\^FD2\.00\^FS/)
  assert.equal(readyOrder.labelStatus, 'READY')
  assert.equal(readyOrder.operationStatus, 'LABEL_READY')

  // Test 3: ZPL indirme PRINTED yapmaz.
  const downloaded = await workflow.prepareZplDownload(
    created.orders,
    [readyOrder.id],
    buildConfig(),
    buildPrinterSettings(),
    buildTemplate(),
  )
  assert.equal(downloaded.printResult.status, 'download_required')
  assert.equal(downloaded.orders[0].labelStatus, 'READY')
  assert.equal(downloaded.orders[0].operationStatus, 'LABEL_READY')
  assert.equal(downloaded.orders[0].label?.printedAt, undefined)

  // Test 4: Başarılı gerçek print ilk baskı kaydını oluşturur.
  const firstPrint = await workflow.printLabels(
    created.orders,
    [readyOrder.id],
    buildPrinterSettings(),
    buildTemplate(),
    {},
    {
      confirmedAt: '2026-06-18T13:00:00.000Z',
      printedBy: 'local user',
      includePreviouslyPrinted: false,
    },
  )
  const printed = firstPrint.orders[0]
  assert.equal(printed.labelStatus, 'PRINTED')
  assert.equal(printed.operationStatus, 'LABEL_PRINTED')
  assert.ok(printed.label.printedAt)
  assert.equal(printed.label.printCount, 1)
  assert.equal(printed.label.printedBy, 'local user')
  assert.equal(printed.label.printSource, 'generated')
  assert.equal(printed.label.printHistory.length, 1)
  assert.equal(printed.label.printHistory[0].type, 'PRINT')
  assert.equal(isLabelPrinted(printed), true)

  // Test 5: Provider error state'i değiştirmez.
  const failureWorkflow = new OrderWorkflowService(
    {},
    {},
    labelProvider,
    createPrintProvider(false),
    audit,
  )
  const failedPrint = await failureWorkflow.printLabels(
    created.orders,
    [readyOrder.id],
    buildPrinterSettings(),
    buildTemplate(),
    {},
    {
      confirmedAt: '2026-06-18T13:01:00.000Z',
      printedBy: 'local user',
      includePreviouslyPrinted: false,
    },
  )
  assert.equal(failedPrint.result.level, 'error')
  assert.equal(failedPrint.orders[0].labelStatus, 'READY')
  assert.equal(failedPrint.orders[0].operationStatus, 'LABEL_READY')
  assert.equal(failedPrint.orders[0].label?.printedAt, undefined)

  // Test 6: Onaysız reprint (include=false) provider'a gitmez.
  const callsBefore = successPrinter.calls.length
  const cancelledReprint = await workflow.printLabels(
    firstPrint.orders,
    [printed.id],
    buildPrinterSettings(),
    buildTemplate(),
    {},
    {
      confirmedAt: '2026-06-18T13:02:00.000Z',
      printedBy: 'local user',
      includePreviouslyPrinted: false,
    },
  )
  assert.equal(cancelledReprint.result.level, 'warning')
  assert.equal(successPrinter.calls.length, callsBefore)
  assert.equal(cancelledReprint.orders[0].label.printCount, 1)

  // Test 7: Onaylı reprint ilk baskıyı korur ve history artırır.
  const firstPrintedAt = printed.label.printedAt
  const reprinted = await workflow.printLabels(
    firstPrint.orders,
    [printed.id],
    buildPrinterSettings(),
    buildTemplate(),
    {},
    {
      confirmedAt: '2026-06-18T13:03:00.000Z',
      printedBy: 'local user',
      includePreviouslyPrinted: true,
    },
  )
  const reprintedOrder = reprinted.orders[0]
  assert.equal(reprintedOrder.labelStatus, 'PRINTED')
  assert.equal(reprintedOrder.operationStatus, 'LABEL_PRINTED')
  assert.equal(reprintedOrder.label.printedAt, firstPrintedAt)
  assert.equal(reprintedOrder.label.printCount, 2)
  assert.equal(reprintedOrder.label.printHistory.at(-1).type, 'REPRINT')
  assert.equal(
    reprintedOrder.label.printHistory.at(-1).reason,
    'User confirmed reprint',
  )
  assert.notEqual(reprintedOrder.label.lastPrintJobId, undefined)

  // Test 8: Toplu baskıda printed kayıt varsayılan olarak hariç tutulur.
  const secondReady = {
    ...buildOrder('2'),
    shipment: buildShipment('2'),
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }
  const bulk = await workflow.printLabels(
    [printed, secondReady],
    [printed.id, secondReady.id],
    buildPrinterSettings(),
    buildTemplate(),
    {},
    {
      confirmedAt: '2026-06-18T13:04:00.000Z',
      printedBy: 'local user',
      includePreviouslyPrinted: false,
    },
  )
  assert.equal(bulk.orders[0].label.printCount, 1)
  assert.equal(bulk.orders[1].label.printCount, 1)
  assert.equal(bulk.orders[1].labelStatus, 'PRINTED')

  const bulkModalHtml = renderToStaticMarkup(
    createElement(PrintPreviewModal, {
      orders: [printed, secondReady],
      mode: 'print',
      template: buildTemplate(),
      mappingConfig: {},
      printerSettings: buildPrinterSettings(),
      busy: false,
      onClose: () => {},
      onConfirm: () => {},
    }),
  )
  assert.match(bulkModalHtml, /Toplu Yazdırma Onayı/)
  assert.match(bulkModalHtml, /Daha önce basılmışları hariç tut/)
  assert.match(bulkModalHtml, /Tümünü tekrar yazdır/)
  assert.match(bulkModalHtml, /mükerrer etiket/)
  assert.equal(
    (bulkModalHtml.match(/bulk-label-preview-item/g) ?? []).length,
    2,
  )
  assert.equal(
    (bulkModalHtml.match(/label-preview-card/g) ?? []).length,
    2,
  )
  assert.doesNotMatch(bulkModalHtml, /Sürat ZPL ham çıktısı/)

  // Toplu önizleme tekli etiket kartını tam boy ve tek sütunda tekrar kullanır.
  const thirdReady = {
    ...buildOrder('3'),
    shipment: buildShipment('3'),
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }
  const threePreviewHtml = renderToStaticMarkup(
    createElement(PrintPreviewModal, {
      orders: [readyOrder, secondReady, thirdReady],
      mode: 'preview',
      template: buildTemplate(),
      mappingConfig: {},
      previewDrafts: {},
      printerSettings: buildPrinterSettings(),
      busy: false,
      onClose: () => {},
      onConfirm: () => {},
    }),
  )
  assert.equal(
    (threePreviewHtml.match(/label-preview-card/g) ?? []).length,
    3,
  )
  assert.equal(
    (threePreviewHtml.match(/bulk-label-preview-item/g) ?? []).length,
    3,
  )
  assert.doesNotMatch(threePreviewHtml, /label-preview-card compact/)
  assert.doesNotMatch(threePreviewHtml, /label-meta-row/)
  assert.match(threePreviewHtml, /ZPL İndir/)
  assert.match(threePreviewHtml, />Yazdır</)

  const tenPreviewOrders = Array.from({ length: 10 }, (_, index) => ({
    ...buildOrder(`TEN-${index}`),
    shipment: buildShipment(`TEN-${index}`),
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }))
  const tenPreviewHtml = renderToStaticMarkup(
    createElement(PrintPreviewModal, {
      orders: tenPreviewOrders,
      mode: 'preview',
      template: buildTemplate(),
      mappingConfig: {},
      previewDrafts: {},
      printerSettings: buildPrinterSettings(),
      busy: false,
      onClose: () => {},
      onConfirm: () => {},
      onModeChange: () => {},
    }),
  )
  assert.equal(
    (tenPreviewHtml.match(/bulk-label-preview-item/g) ?? []).length,
    10,
  )
  assert.equal(
    (tenPreviewHtml.match(/label-preview-card/g) ?? []).length,
    10,
  )

  const batchDownload = await workflow.prepareZplDownload(
    [readyOrder, secondReady, thirdReady],
    [readyOrder.id, secondReady.id, thirdReady.id],
    buildConfig(),
    buildPrinterSettings(),
    buildTemplate(),
  )
  assert.equal(
    (batchDownload.printResult.content.match(/\^XA/g) ?? []).length,
    3,
  )
  assert.equal(batchDownload.result.bulkActionDebug.selectedCount, 3)
  assert.equal(batchDownload.result.bulkActionDebug.labelsWithBarcodeRaw, 3)

  const missingRawShipment = withoutBarcodeRaw(buildShipment('4'))
  const missingRawOrder = {
    ...buildOrder('4'),
    shipment: missingRawShipment,
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }
  const partialPreviewHtml = renderToStaticMarkup(
    createElement(PrintPreviewModal, {
      orders: [secondReady, thirdReady, missingRawOrder],
      mode: 'preview',
      template: buildTemplate(),
      mappingConfig: {},
      previewDrafts: {},
      printerSettings: buildPrinterSettings(),
      busy: false,
      onClose: () => {},
      onConfirm: () => {},
    }),
  )
  assert.equal(
    (partialPreviewHtml.match(/label-preview-card/g) ?? []).length,
    3,
  )
  assert.match(partialPreviewHtml, /Etiket çözümleme detayı/)

  const missingRawResolution = resolvePrintableLabel(missingRawOrder)
  assert.equal(missingRawResolution.canPreview, true)
  assert.equal(missingRawResolution.canPrint, true)
  assert.equal(missingRawResolution.debug.hasBarcodeRaw, false)
  const missingRawCleanPrintHtml = buildCleanLabelHtml(
    [missingRawOrder],
    buildTemplate(),
  )
  assert.equal(
    (missingRawCleanPrintHtml.match(/class="label-page"/g) ?? []).length,
    1,
  )
  assert.match(missingRawCleanPrintHtml, /01231201024/)

  // Selected row shipment taşımıyorsa canonical order state kullanılır.
  const canonicalReady = {
    ...buildOrder('CANONICAL'),
    shipment: buildShipment('5'),
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }
  const selectedRow = {
    ...buildOrder('CANONICAL'),
    shipment: undefined,
  }
  const canonicalResolution = resolvePrintableLabel(selectedRow, {
    orders: [canonicalReady],
  })
  assert.equal(canonicalResolution.canPreview, true)
  assert.equal(canonicalResolution.canPrint, true)
  assert.equal(canonicalResolution.debug.canonicalOrderFound, true)
  assert.equal(canonicalResolution.debug.selectedRowHasBarcodeRaw, false)
  assert.equal(canonicalResolution.debug.hasBarcodeRaw, true)

  const canonicalPreviewHtml = renderToStaticMarkup(
    createElement(PrintPreviewModal, {
      orders: [selectedRow],
      canonicalOrders: [canonicalReady],
      mode: 'preview',
      template: buildTemplate(),
      mappingConfig: {},
      previewDrafts: {},
      printerSettings: buildPrinterSettings(),
      busy: false,
      onClose: () => {},
      onConfirm: () => {},
    }),
  )
  assert.match(canonicalPreviewHtml, /label-preview-card/)
  assert.doesNotMatch(canonicalPreviewHtml, /Bu etiket önizlenemedi/)

  // BarcodeRaw ham SOAP/XML içinden çıkarılır.
  const rawXmlOrder = {
    ...buildOrder('RAW-XML'),
    serviceMode: 'ORTAK_BARKOD_SOAP',
    operationName: 'OrtakBarkodOlustur',
    rawSuratCreateResponse: {
      KargoTakipNo: '2522014844619RAW',
      Barcode: '0123120102RAW',
      rawResponse:
        '&lt;Barcode&gt;&lt;anyType&gt;^XA^FO20,20^FDRAW-XML^FS^XZ&lt;/anyType&gt;&lt;/Barcode&gt;',
    },
  }
  const rawXmlResolution = resolvePrintableLabel(rawXmlOrder)
  assert.equal(rawXmlResolution.canPreview, false)
  assert.equal(rawXmlResolution.canPrint, false)
  assert.match(rawXmlResolution.warningReason, /Önce Sürat gönderisi/i)
  assert.equal(rawXmlResolution.barcodeRaw, '^XA^FO20,20^FDRAW-XML^FS^XZ')
  assert.equal(
    rawXmlResolution.debug.dataSource.includes('extractedFromRawXml'),
    true,
  )

  // Kullanıcı önizleme taslağı resmi BarcodeRaw baskı kaynağını değiştirmez.
  const editablePreviewHtml = renderToStaticMarkup(
    createElement(LabelPreviewModal, {
      order: readyOrder,
      template: {
        ...buildTemplate(),
        typography: {
          headerName: 15,
          address: 11,
          route: 16,
          cargoValue: 21,
          deliveryTitle: 18,
          deliveryRoute: 25,
          transfer: 22,
          productTitle: 12,
          productMeta: 10,
        },
      },
      mappingConfig: {},
      previewOverrides: {
        recipientName: 'Düzenlenmiş Alıcı',
        routeCenter: 'ÇOK UZUN TESLİMAT BÖLGESİ / MERKEZ',
      },
      busy: false,
      onClose: () => {},
      onMappingConfigChange: () => {},
      onPreviewOverridesChange: () => {},
      onDownloadZpl: () => {},
      onPrint: () => {},
    }),
  )
  assert.match(editablePreviewHtml, /Düzenlenmiş Alıcı/)
  assert.match(editablePreviewHtml, /Etiketi Düzenle/)
  assert.match(editablePreviewHtml, /--label-delivery-route-size:15px/)

  const singleReprintHtml = renderToStaticMarkup(
    createElement(PrintPreviewModal, {
      orders: [printed],
      mode: 'print',
      template: buildTemplate(),
      mappingConfig: {},
      printerSettings: buildPrinterSettings(),
      busy: false,
      onClose: () => {},
      onConfirm: () => {},
    }),
  )
  assert.match(singleReprintHtml, /Bu etiket daha önce basıldı/)
  assert.match(singleReprintHtml, /Tekrar yazdırmak istediğinizden emin misiniz/)
  assert.match(singleReprintHtml, /Vazgeç/)
  assert.match(singleReprintHtml, /Tekrar Yazdır/)

  // Eski otomatik PRINTED kaydı gerçek baskı kanıtı yoksa READY'ye döner.
  const suspicious = migrateSuspiciousPrintedState({
    ...secondReady,
    status: 'Etiket Basıldı',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: {
      ...previewLabel,
      printedAt: undefined,
      printJobId: undefined,
    },
  })
  assert.equal(suspicious.status, 'Etiket Hazır')
  assert.equal(suspicious.operationStatus, 'LABEL_READY')
  assert.equal(suspicious.labelStatus, 'READY')
  assert.match(suspicious.printMigrationNote, /gerçek yazdırma kaydı bulunamadı/)

  const suspiciousOldDownload = migrateSuspiciousPrintedState({
    ...secondReady,
    status: 'Etiket Basıldı',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: {
      ...previewLabel,
      printedAt: '2026-06-18T12:00:00.000Z',
      printJobId: undefined,
    },
  })
  assert.equal(suspiciousOldDownload.labelStatus, 'READY')
  assert.equal(suspiciousOldDownload.operationStatus, 'LABEL_READY')
})

function createPrintProvider(ok) {
  return {
    calls: [],
    async print(input) {
      this.calls.push(input)
      if (input.action === 'download') {
        return {
          fileName: 'test.zpl',
          content: input.orders.map((order) => order.label.zplContent).join('\n'),
          status: 'download_required',
          ok: true,
          provider: 'test-download',
          printerName: input.printerSettings.printerName,
        }
      }
      return {
        fileName: 'test.zpl',
        content: input.orders.map((order) => order.label.zplContent).join('\n'),
        status: ok ? 'printed' : 'failed',
        ok,
        provider: 'test-zebra',
        printerName: input.printerSettings.printerName,
        printJobId: ok ? `job-${this.calls.length}` : undefined,
        errorMessage: ok ? undefined : 'Printer offline',
        jobs: input.orders.map((order, index) => ({
          orderNumber: order.orderNumber,
          ok,
          printJobId: ok ? `job-${this.calls.length}-${index}` : undefined,
          errorMessage: ok ? undefined : 'Printer offline',
        })),
      }
    },
  }
}

function buildOrder(suffix) {
  return {
    id: `order-${suffix}`,
    marketplace: 'Trendyol',
    externalOrderId: `ORDER-${suffix}`,
    orderNumber: `ORDER-${suffix}`,
    packageId: `PKG-${suffix}`,
    cargoTrackingNumber: `72700335633245${suffix}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    source: 'real',
    status: 'Yeni',
    customerName: 'Test Alıcı',
    customerPhone: '5550000000',
    customerEmail: 'test@example.com',
    address: 'Test adresi',
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 100,
    desi: 2,
    desiSource: 'manual',
    createdAt: new Date().toISOString(),
    items: [
      {
        id: `item-${suffix}`,
        productName: 'Ürün A',
        sku: 'SKU-A',
        barcode: 'PRODUCT-A',
        quantity: 1,
        variantAttributes: [],
      },
    ],
  }
}

function buildShipment(suffix = '1') {
  const numericSuffix = toNumericSuffix(suffix)
  const barcode = `0123120102${numericSuffix}`
  const tracking = `2522014844619${numericSuffix}`
  const barcodeRaw = `^XA\n^FO20,20^BCN,80,Y,N,N^FD${barcode}^FS\n^XZ`
  const parsedResponse = {
    KargoTakipNo: tracking,
    Barcode: barcode,
    BarcodeRaw: barcodeRaw,
    ReferansNo: `PKG-${suffix}`,
  }
  return {
    id: `shipment-${suffix}`,
    provider: 'surat-kargo',
    serviceMode: 'ORTAK_BARKOD_SOAP',
    operationName: 'OrtakBarkodOlustur',
    trackingNumber: tracking,
    kargoTakipNo: tracking,
    barcode,
    barcodeRaw,
    trackingUrl: '',
    shipmentCode: `PKG-${suffix}`,
    satisKodu: `PKG-${suffix}`,
    webSiparisKodu: `PKG-${suffix}`,
    ozelKargoTakipNo: `PKG-${suffix}`,
    barcodeValue: barcode,
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
    rawResponse: { parsedResponse },
    suratCreateLog: {
      rawRequest: '<OrtakBarkodOlustur />',
      rawResponse: '<OrtakBarkodOlusturResponse />',
      responseStatus: 200,
      contentType: 'text/xml',
      parsedResponse,
      createdAt: new Date().toISOString(),
      orderId: `order-${suffix}`,
      shipmentId: `PKG-${suffix}`,
      serviceType: 'OrtakBarkodOlusturSoap',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      operationName: 'OrtakBarkodOlustur',
      endpoint: 'OrtakBarkodOlustur',
      payloadFormat: 'SOAP/XML',
      hasTrackingNumber: true,
      hasBarcode: true,
      verifiedShipment: true,
      KargoTakipNo: tracking,
      Barcode: barcode,
      BarcodeRaw: barcodeRaw,
      requestReference: `PKG-${suffix}`,
    },
    createdAt: new Date().toISOString(),
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

function withoutBarcodeRaw(shipment) {
  const parsedResponse = {
    ...shipment.suratCreateLog.parsedResponse,
    BarcodeRaw: '',
  }
  return {
    ...shipment,
    barcodeRaw: '',
    rawResponse: { parsedResponse },
    suratCreateLog: {
      ...shipment.suratCreateLog,
      BarcodeRaw: '',
      parsedResponse,
    },
  }
}

function buildPrinterSettings() {
  return {
    printerName: 'Zebra Test',
    mode: 'local-agent',
    labelSize: '100x100',
    defaultFormat: 'zpl',
  }
}

function buildTemplate() {
  return {
    id: 'tpl-test',
    name: 'Test',
    widthMm: 100,
    heightMm: 100,
    widthDots: 799,
    heightDots: 799,
    barcodeX: 80,
    barcodeY: 560,
    barcodeModuleWidth: 3,
    barcodeHeight: 120,
    fontSize: 24,
    lineGap: 38,
    fieldStartX: 32,
    fieldStartY: 120,
    fields: [],
    updatedAt: new Date().toISOString(),
  }
}

function buildConfig() {
  return {
    trendyol: {
      sellerId: '',
      apiKey: '',
      apiSecret: '',
      environment: 'prod',
      userAgentName: '',
    },
    surat: {
      kullaniciAdi: 'TEST',
      sifre: 'TEST',
      firmaId: '',
      ortam: 'test',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      serviceType: 'OrtakBarkodOlusturSoap',
      createShipmentPath: '/api/OrtakBarkodOlustur',
      trackingServiceType: 'KargoTakipHareketDetayiSoap',
      trackingPath: '/api/KargoTakipHareketDetayi',
    },
  }
}
