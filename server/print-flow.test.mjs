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

  // Popup rezervasyonu kaldırıldı: reserve artık pencere AÇMAZ, cancel
  // hiçbir şey KAPATMAZ (kalıcı iframe print motoru kullanılır).
  let openedPrintWindow = false
  globalThis.window.open = () => {
    openedPrintWindow = true
    return null
  }
  const reservedWindow = reserveCleanLabelPrintWindow()
  assert.equal(reservedWindow, null)
  assert.equal(openedPrintWindow, false)
  cancelReservedCleanLabelPrintWindow()
  assert.equal(openedPrintWindow, false)

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
  // Kritik kod alanları eksik: canonical HTML fallback da devreye girmez.
  assert.throws(
    () => buildCleanLabelHtml([marketplaceCodeOrder], buildTemplate()),
    /T\.No\/barkod eksik/,
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
  // Yeni politika: legacy kayıtta raw ZPL yoksa etiket canonical
  // T.No/barkod/QR alanlarından HTML olarak yazdırılır (create çağrısı yok);
  // ZPL indirme ise yalnız gerçek ZPL varken açık kalır.
  const missingRawHtml = buildCleanLabelHtml(
    [missingRawOrder],
    buildTemplate(),
  )
  assert.equal(
    (missingRawHtml.match(/class="label-page"/g) ?? []).length,
    1,
  )

  // Selected row shipment taşımıyorsa canonical order state kullanılır.
  const canonicalShipment = buildShipment('5')
  const canonicalReady = {
    ...buildOrder('CANONICAL'),
    cargoTrackingNumber: canonicalShipment.webSiparisKodu,
    shipment: canonicalShipment,
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }
  const selectedRow = {
    ...buildOrder('CANONICAL'),
    cargoTrackingNumber: canonicalShipment.webSiparisKodu,
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

test('Toplu yazdırma tek dokümanda doğru alan eşlemesiyle çalışır', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())

  const { printSuratLabels, buildCleanLabelHtml, buildSuratZplDownload } =
    await vite.ssrLoadModule('/src/utils/browserLabelPrint.ts')
  const {
    buildAddressLayout,
    normalizeRecipientPhone,
    resolveRecipientPhone,
    resolveSuratSenderName,
  } = await vite.ssrLoadModule('/src/utils/labelData.ts')

  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let printCalls = 0
  let writtenHtml = ''
  let iframeCreateCount = 0
  let iframeRemoved = false
  let windowCloseCalls = 0
  const fakeFrameWindow = {
    closed: false,
    focus: () => {},
    print: () => {
      printCalls += 1
    },
    close() {
      windowCloseCalls += 1
      this.closed = true
    },
  }
  const fakeIframe = {
    style: {},
    isConnected: true,
    setAttribute: () => {},
    contentDocument: {
      open: () => {},
      write: (html) => {
        writtenHtml = html
      },
      close: () => {},
      readyState: 'complete',
    },
    contentWindow: fakeFrameWindow,
    remove: () => {
      iframeRemoved = true
    },
  }
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  }
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, 'iframe')
      iframeCreateCount += 1
      return fakeIframe
    },
    body: { appendChild: () => {} },
  }
  t.after(() => {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  })

  const stripZpl = (shipment) => ({
    ...withoutBarcodeRaw(shipment),
    zplAnalysis: undefined,
  })
  const preassignedOrder = (suffix, overrides = {}) => {
    const base = buildShipment(suffix)
    return {
      ...buildOrder(suffix),
      shipment: {
        ...base,
        verifiedShipment: false,
        dispatchRegistrationConfirmed: false,
        operationalBarcodeVerified: false,
        serdendipVerified: false,
        lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
        candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
        verificationStage: 'preassigned_awaiting_acceptance',
        lifecycleStage: 'LABEL_CREATED_UNVERIFIED',
        printEnabled: true,
        labelStatus: 'READY',
        suratTrackingLog: undefined,
        ...overrides,
      },
      status: 'Etiket Hazır',
      operationStatus: 'LABEL_READY',
      labelStatus: 'READY',
    }
  }

  // Alan eşleme testi: T.No, Code128 ve QR üç farklı değerdir ve karışmaz.
  const mappingOrder = preassignedOrder('MAP1', {
    trackingNumber: '',
    tNo: '',
    kargoTakipNo: '',
    barcode: '',
    barkodNo: '',
    finalSuratBarcode: '',
    barcodeValue: '',
    candidateTNo: '',
    candidateBarkodNo: '',
    ozelKargoTakipNo: '7270034518943203',
    zplAnalysis: {
      acceptedTNo: '23418093205124',
      acceptedFinalBarcode: '01249974986',
    },
  })
  mappingOrder.cargoTrackingNumber = '7270034518943203'

  const mappingResult = await printSuratLabels(
    [mappingOrder],
    buildTemplate(),
  )
  assert.equal(mappingResult.printCalled, true)
  assert.equal(printCalls, 1)
  assert.equal(mappingResult.models.length, 1)
  assert.equal(mappingResult.models[0].trackingNumber, '23418093205124')
  assert.equal(mappingResult.models[0].barcodeNumber, '01249974986')
  assert.equal(mappingResult.models[0].ozelKargoTakipNo, '7270034518943203')
  assert.match(writtenHtml, /T\.No: <strong>23418093205124<\/strong>/)
  assert.match(writtenHtml, /data-barcode-value="01249974986"/)
  assert.doesNotMatch(writtenHtml, /data-barcode-value="23418093205124"/)
  assert.match(writtenHtml, /data-qr-value="7270034518943203"/)
  assert.doesNotMatch(writtenHtml, /data-qr-value="01249974986"/)
  assert.equal(fakeFrameWindow.closed, false)

  // ZPL İndir: print'ten bağımsız; .zpl içeriği ve barkodlu dosya adı üretir,
  // window.print çağrılmaz.
  const printCallsBeforeDownload = printCalls
  const zplDownload = buildSuratZplDownload([mappingOrder])
  assert.ok(zplDownload)
  assert.equal(zplDownload.models.length, 1)
  assert.match(zplDownload.content, /\^XA/)
  assert.match(zplDownload.content, /\^XZ/)
  assert.equal(zplDownload.fileName, 'surat-ORDER-MAP1-01249974986.zpl')
  assert.equal(printCalls, printCallsBeforeDownload)
  // Legacy kayıt (raw ZPL yok): .zpl dosyası OLUŞMAZ ve neden açıkça
  // raporlanır; Etiketi Yazdır ise canonical HTML fallback ile çalışır.
  const emptyZplDownload = buildSuratZplDownload([
    preassignedOrder('D1', stripZpl(buildShipment('D1'))),
  ])
  assert.ok(emptyZplDownload)
  assert.equal(emptyZplDownload.content, '')
  assert.equal(emptyZplDownload.models.length, 0)
  assert.match(
    emptyZplDownload.skipped[0].reason,
    /ham ZPL verisi bulunamadı/,
  )

  // Üç uygun sipariş: tek print çağrısı, üç sayfa, kod sızması yok.
  printCalls = 0
  writtenHtml = ''
  const bulkOrders = [
    preassignedOrder('11'),
    preassignedOrder('12'),
    preassignedOrder('13'),
  ]
  const bulkResult = await printSuratLabels(bulkOrders, buildTemplate())
  assert.equal(printCalls, 1)
  assert.equal(bulkResult.models.length, 3)
  assert.equal(bulkResult.skipped.length, 0)
  assert.equal(
    (writtenHtml.match(/class="label-page"/g) ?? []).length,
    3,
  )
  for (const model of bulkResult.models) {
    assert.equal(
      (writtenHtml.match(
        new RegExp(`data-barcode-value="${model.barcodeNumber}"`, 'g'),
      ) ?? []).length,
      1,
    )
    assert.equal(
      (writtenHtml.match(
        new RegExp(`T\\.No: <strong>${model.trackingNumber}</strong>`, 'g'),
      ) ?? []).length,
      1,
    )
  }
  assert.match(writtenHtml, /\.label-page:last-child \{ break-after: auto/)
  assert.equal(fakeFrameWindow.closed, false)

  // Karma seçim: uygun olmayanlar nedenleriyle atlanır, print bir kez çağrılır.
  printCalls = 0
  const mixedResult = await printSuratLabels(
    [
      preassignedOrder('21'),
      preassignedOrder('22'),
      preassignedOrder('23', stripZpl(buildShipment('23'))),
      preassignedOrder('24', {
        barcode: '',
        barkodNo: '',
        finalSuratBarcode: '',
        barcodeValue: '',
        candidateBarkodNo: '',
        zplAnalysis: undefined,
        rawResponse: {},
        suratCreateLog: undefined,
      }),
    ],
    buildTemplate(),
  )
  assert.equal(printCalls, 1)
  // ZPL'siz ('23') sipariş artık canonical HTML fallback ile BASILIR;
  // yalnız kritik kodları eksik olan ('24') atlanır.
  assert.equal(mixedResult.models.length, 3)
  assert.equal(mixedResult.skipped.length, 1)
  assert.equal(
    mixedResult.models.find((model) => model.orderNumber === 'ORDER-23')
      ?.printSource,
    'canonical_html',
  )
  assert.ok(
    mixedResult.skipped.every((item) => item.orderNumber && item.reason),
  )

  // Hiç uygun sipariş yoksa (kritik kodlar eksik) print çağrılmaz.
  printCalls = 0
  const emptyResult = await printSuratLabels(
    [
      preassignedOrder('31', {
        ...stripZpl(buildShipment('31')),
        barcode: '',
        barkodNo: '',
        finalSuratBarcode: '',
        barcodeValue: '',
        candidateBarkodNo: '',
        rawResponse: {},
        suratCreateLog: undefined,
      }),
    ],
    buildTemplate(),
  )
  assert.equal(printCalls, 0)
  assert.equal(emptyResult.printCalled, false)
  assert.equal(emptyResult.models.length, 0)
  assert.equal(emptyResult.skipped.length, 1)

  // Duplicate seçim tek etikete indirgenir.
  printCalls = 0
  writtenHtml = ''
  const duplicate = preassignedOrder('41')
  const duplicateResult = await printSuratLabels(
    [duplicate, duplicate],
    buildTemplate(),
  )
  assert.equal(printCalls, 1)
  assert.equal(duplicateResult.models.length, 1)
  assert.equal(
    (writtenHtml.match(/class="label-page"/g) ?? []).length,
    1,
  )

  // buildCleanLabelHtml de aynı seçimi kullanır (tek politika): legacy
  // ZPL'siz preassigned kayıt canonical HTML fallback ile TEK sayfa üretir.
  const strippedCanonicalHtml = buildCleanLabelHtml(
    [preassignedOrder('51', stripZpl(buildShipment('51')))],
    buildTemplate(),
  )
  assert.equal(
    (strippedCanonicalHtml.match(/class="label-page"/g) ?? []).length,
    1,
  )

  // Regresyon (11424170556): 016 yanıtında üst seviye Barcode alanlarına
  // T.No sızsa bile canonical model ZPL analizinden doğru barkodu çözer.
  printCalls = 0
  writtenHtml = ''
  const collisionOrder = preassignedOrder('COLL1', {
    trackingNumber: '99718621452161',
    tNo: '99718621452161',
    kargoTakipNo: '99718621452161',
    // Eski parser hatası: barkod alanları da T.No değerini taşıyor.
    barcode: '99718621452161',
    barkodNo: '99718621452161',
    barcodeValue: '99718621452161',
    finalSuratBarcode: '99718621452161',
    candidateTNo: '99718621452161',
    candidateBarkodNo: '99718621452161',
    ozelKargoTakipNo: '7270034532270019',
    codeMapping: {
      trackingValue: '99718621452161',
      tNoValue: '99718621452161',
      barcodeValue: '99718621452161',
    },
    zplAnalysis: {
      acceptedTNo: '99718621452161',
      acceptedFinalBarcode: '01250077333',
    },
  })
  collisionOrder.cargoTrackingNumber = '7270034532270019'
  const collisionResult = await printSuratLabels(
    [collisionOrder],
    buildTemplate(),
  )
  assert.equal(collisionResult.printCalled, true)
  assert.equal(printCalls, 1)
  assert.equal(collisionResult.models[0].trackingNumber, '99718621452161')
  assert.equal(collisionResult.models[0].barcodeNumber, '01250077333')
  assert.equal(
    collisionResult.models[0].ozelKargoTakipNo,
    '7270034532270019',
  )
  assert.notEqual(
    collisionResult.models[0].trackingNumber,
    collisionResult.models[0].barcodeNumber,
  )
  assert.match(writtenHtml, /T\.No: <strong>99718621452161<\/strong>/)
  assert.match(writtenHtml, /data-barcode-value="01250077333"/)
  assert.doesNotMatch(writtenHtml, /data-barcode-value="99718621452161"/)
  assert.match(writtenHtml, /data-qr-value="7270034532270019"/)

  // ---- Etiket düzeni sözleşmesi (gönderici/adres/telefon/parça) ----

  // Test: gönderici üstte, alıcı adres bloğunda; alıcı adı sender fallback'i DEĞİL.
  printCalls = 0
  writtenHtml = ''
  const layoutOrder = preassignedOrder('LAY1')
  layoutOrder.customerName = 'GÖRKEM GENÇÇOBAN'
  layoutOrder.customerPhone = '05321234567'
  layoutOrder.address =
    'ETİMESGUT ERYAMAN YAVUZ SELİM MAHALLESİ IĞDIR CADDESİ SERPİL SİTESİ 4C BLOK DAİRE 15 ETİMESGUT ANKARA'
  layoutOrder.shipment.suratTrackingLog = {
    GonderenUnvan: 'HASAN GÜREL',
  }
  const layoutResult = await printSuratLabels([layoutOrder], buildTemplate())
  assert.equal(layoutResult.printCalled, true)
  assert.match(
    writtenHtml,
    /surat-sender-name">HASAN GÜREL<\/b>/,
  )
  assert.match(
    writtenHtml,
    /surat-recipient-name">GÖRKEM GENÇÇOBAN<\/b>/,
  )
  assert.doesNotMatch(
    writtenHtml,
    /surat-sender-name">GÖRKEM GENÇÇOBAN/,
  )
  // Adres kayıpsız: tüm kelimeler mevcut, '...' yok, ellipsis CSS'i yok.
  for (const word of ['ETİMESGUT', 'ERYAMAN', 'IĞDIR', 'SERPİL', 'SİTESİ', 'DAİRE', '15', 'ANKARA']) {
    assert.ok(writtenHtml.includes(word), `adres kelimesi eksik: ${word}`)
  }
  assert.doesNotMatch(writtenHtml, /\.\.\./)
  assert.doesNotMatch(writtenHtml, /text-overflow: ellipsis;[^}]*}\s*\.surat-address/)
  // Parça bloğu ayrı satır sınıfları mevcut.
  assert.match(writtenHtml, /surat-parcel-label/)
  assert.match(writtenHtml, /surat-parcel-count/)
  assert.match(writtenHtml, /surat-delivery-type/)
  assert.match(writtenHtml, /surat-destination/)
  assert.match(writtenHtml, /surat-transfer/)
  // Telefon normalize görünür (maskeli görüntü 532*****67 formatına izinli).
  assert.match(writtenHtml, /TEL: 532/)
  assert.doesNotMatch(writtenHtml, /TEL: -</)
  // Canonical kodlar değişmedi.
  assert.match(
    writtenHtml,
    new RegExp(`data-barcode-value="${layoutOrder.shipment.barcode}"`),
  )
  assert.match(
    writtenHtml,
    new RegExp(
      `T\\.No: <strong>${layoutOrder.shipment.trackingNumber}</strong>`,
    ),
  )

  // Telefon çözücü sözleşmesi.
  assert.equal(normalizeRecipientPhone('05321234567'), '532 123 45 67')
  assert.equal(normalizeRecipientPhone('+90 532 123 45 67'), '532 123 45 67')
  assert.equal(normalizeRecipientPhone('905321234567'), '532 123 45 67')
  assert.equal(normalizeRecipientPhone('542*******'), '542*******')
  assert.equal(normalizeRecipientPhone('-'), '')
  assert.equal(normalizeRecipientPhone('0000000000'), '')
  const noPhone = resolveRecipientPhone(
    { customerPhone: '', items: [] },
    undefined,
  )
  assert.equal(noPhone.phone, '')
  assert.equal(noPhone.reason, 'PHONE_NOT_PROVIDED_BY_MARKETPLACE')

  // Adres layout: uzun adres kayıpsız, kademeli font.
  const longLayout = buildAddressLayout(
    'ETİMESGUT ERYAMAN YAVUZ SELİM MAHALLESİ IĞDIR CADDESİ SERPİL SİTESİ 4C BLOK DAİRE 15 ETİMESGUT ANKARA',
  )
  assert.equal(longLayout.lines.join(' ').includes('DAİRE 15'), true)
  assert.ok(longLayout.lines.length <= 4)
  const veryLongLayout = buildAddressLayout(
    'ETİMESGUT ERYAMAN YAVUZ SELİM MAHALLESİ IĞDIR CADDESİ SERPİL SİTESİ 4C BLOK DAİRE 15 KAT 3 GİRİŞ B KAPI NO 7 YAKINLARINDA ESKİ PAZAR YERİ KARŞISI ETİMESGUT ANKARA TÜRKİYE',
  )
  assert.equal(
    veryLongLayout.lines.join(' ').includes('ESKİ PAZAR YERİ'),
    true,
  )
  assert.ok(['long', 'xlong'].includes(veryLongLayout.fontScale))
  const shortLayout = buildAddressLayout('Kısa Mah. No:1 Merkez')
  assert.equal(shortLayout.fontScale, 'normal')

  // Sender resolver: alıcı adı asla fallback değil.
  assert.equal(
    resolveSuratSenderName(
      { customerName: 'ALICI KİŞİ', items: [] },
      { suratTrackingLog: { GonderenUnvan: 'HASAN GÜREL' } },
    ),
    'HASAN GÜREL',
  )
  assert.notEqual(
    resolveSuratSenderName({ customerName: 'ALICI KİŞİ', items: [] }, {}),
    'ALICI KİŞİ',
  )

  // Kalıcı iframe garantileri: tüm printler boyunca iframe BİR kez
  // oluşturulur, hiç kaldırılmaz, hiçbir pencere kapatılmaz.
  assert.equal(iframeCreateCount, 1)
  assert.equal(iframeRemoved, false)
  assert.equal(windowCloseCalls, 0)
  assert.equal(fakeFrameWindow.closed, false)

  // In-flight guard: aynı anda ikinci çağrı print üretmez; ilk çağrı
  // tamamlanınca yeni print normal çalışır.
  printCalls = 0
  const guardFirst = printSuratLabels([preassignedOrder('61')], buildTemplate())
  const guardSecond = printSuratLabels(
    [preassignedOrder('62')],
    buildTemplate(),
  )
  const [guardFirstResult, guardSecondResult] = await Promise.all([
    guardFirst,
    guardSecond,
  ])
  assert.equal(printCalls, 1)
  assert.equal(guardFirstResult.printCalled, true)
  assert.equal(guardSecondResult.printCalled, false)
  assert.match(
    guardSecondResult.skipped.map((item) => item.reason).join(' '),
    /Devam eden bir yazdırma/,
  )
  const afterGuard = await printSuratLabels(
    [preassignedOrder('63')],
    buildTemplate(),
  )
  assert.equal(afterGuard.printCalled, true)
  assert.equal(printCalls, 2)
  assert.equal(iframeCreateCount, 1)
  assert.equal(iframeRemoved, false)
  assert.equal(windowCloseCalls, 0)
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
  const webSiparisKodu = `72700335633245${suffix}`
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
    satisKodu: `ORDER-${suffix}`,
    webSiparisKodu,
    ozelKargoTakipNo: webSiparisKodu,
    barcodeValue: barcode,
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
      KargoTakipNo: tracking,
      BarkodNo: barcode,
      WebSiparisKodu: webSiparisKodu,
      OzelKargoTakipNo: webSiparisKodu,
    },
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
