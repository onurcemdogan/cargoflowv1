import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('Ortak Barkod SOAP label mapping ve canlı ZPL guard doğru çalışır', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())

  const { buildLabelData } = await vite.ssrLoadModule('/src/utils/labelData.ts')
  const { resolveNormalizedDesi } = await vite.ssrLoadModule(
    '/src/utils/desi.ts',
  )
  const { ZebraZplLabelProvider } = await vite.ssrLoadModule(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const { OrderWorkflowService } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )
  const {
    canCreateShipment,
    canDownloadZpl,
    canMarkPrinted,
    isBarcodePending,
    isLabelReadyForPrint,
    isSuratVerificationPending,
    normalizeVerifiedOrtakBarkodState,
  } =
    await vite.ssrLoadModule(
    '/src/utils/orderStatus.ts',
    )
  const { IntegrationConfigService } = await vite.ssrLoadModule(
    '/src/services/integrationConfigService.ts',
  )
  const { analyzeSuratZpl } = await vite.ssrLoadModule(
    '/src/utils/suratZplAnalysis.ts',
  )
  const { verifySuratShipment } = await vite.ssrLoadModule(
    '/src/utils/suratVerification.ts',
  )
  const { resolvePrintableLabel } = await vite.ssrLoadModule(
    '/src/utils/printableLabel.ts',
  )

  const order = buildOrder()
  const baseShipment = buildShipment()
  const shipment = {
    ...baseShipment,
    barcodeRaw: undefined,
    zplSource: 'generated',
    suratCreateLog: {
      ...baseShipment.suratCreateLog,
      BarcodeRaw: undefined,
      parsedResponse: {
        ...baseShipment.suratCreateLog.parsedResponse,
        BarcodeRaw: undefined,
      },
    },
  }
  order.shipment = shipment

  const labelData = buildLabelData(order, shipment, buildTemplate())
  assert.equal(labelData.tNo, '25220148446193')
  assert.equal(labelData.trackingNumber, '25220148446193')
  assert.equal(labelData.barcodeValue, '01231201025')
  assert.equal(labelData.mainBarcodeValue, '01231201025')
  assert.equal(labelData.leftVerticalReference, 'PKG123')
  assert.equal(labelData.verifiedShipment, true)
  assert.equal(labelData.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(labelData.operationName, 'OrtakBarkodOlustur')
  assert.equal(labelData.barcodeSource, 'surat.ortakBarkod.Barcode')

  const provider = new ZebraZplLabelProvider()
  const label = await provider.generateSingle({
    order,
    shipment,
    template: buildTemplate(),
  })
  assert.equal(label.barcodeValue, '01231201025')
  assert.match(label.zplContent, /FDT\.No: 25220148446193/)
  assert.match(label.zplContent, /\^FD01231201025\^FS/)
  assert.match(label.zplContent, /Ref No: PKG123/)
  assert.equal(label.zplSource, 'generated')

  const suratRawZpl =
    '^XA\n^FO20,20^A0N,30,30^FDSURAT RAW LABEL^FS\n^FO20,70^BCN,80,Y,N,N^FD01231201025^FS\n^XZ'
  const rawShipment = {
    ...shipment,
    barcodeRaw: suratRawZpl,
    zplSource: 'surat.ortakBarkod.BarcodeRaw',
    suratCreateLog: {
      ...shipment.suratCreateLog,
      BarcodeRaw: suratRawZpl,
      parsedResponse: {
        ...shipment.suratCreateLog.parsedResponse,
        BarcodeRaw: suratRawZpl,
      },
    },
  }
  const rawLabel = await provider.generateSingle({
    order: { ...order, shipment: rawShipment },
    shipment: rawShipment,
    template: buildTemplate(),
  })
  assert.equal(rawLabel.zplSource, 'generated')
  assert.equal(rawLabel.desi, 2)
  assert.equal(rawLabel.desiSource, 'manual')
  assert.match(rawLabel.zplContent, /\^FDTop Ds\/Kg\^FS/)
  assert.match(rawLabel.zplContent, /\^FD2\.00\^FS/)

  const mismatchedRawZpl =
    '^XA\n^FO20,20^A0N,20,20^FDTop Ds/Kg^FS\n^FO20,45^A0N,30,30^FD1.00^FS\n^XZ'
  const mismatchShipment = {
    ...rawShipment,
    barcodeRaw: mismatchedRawZpl,
    suratCreateLog: {
      ...rawShipment.suratCreateLog,
      BarcodeRaw: mismatchedRawZpl,
      parsedResponse: {
        ...rawShipment.suratCreateLog.parsedResponse,
        BarcodeRaw: mismatchedRawZpl,
      },
    },
  }
  const mismatchLabel = await provider.generateSingle({
    order: { ...order, shipment: mismatchShipment },
    shipment: mismatchShipment,
    template: buildTemplate(),
  })
  assert.match(mismatchLabel.desiMismatchWarning, /farkl/i)
  assert.equal(mismatchLabel.desiDebug.apiResponseDesi, 1)
  assert.equal(mismatchLabel.desiDebug.finalNormalizedDesi, 2)
  assert.equal(mismatchLabel.desiDebug.zplPrintedDesi, 2)
  assert.match(mismatchLabel.zplContent, /\^FD2\.00\^FS/)

  const manualDesi = resolveNormalizedDesi({
    ...order,
    desi: 4.5,
    desiSource: 'manual',
    items: [{ ...order.items[0], desi: 3 }],
  })
  assert.equal(manualDesi.desi, 4.5)
  assert.equal(manualDesi.desiSource, 'manual')

  const productDesi = resolveNormalizedDesi({
    ...order,
    desi: null,
    desiSource: null,
    items: [{ ...order.items[0], desi: 3 }],
  })
  assert.equal(productDesi.desi, 3)
  assert.equal(productDesi.desiSource, 'product')

  const calculatedDesi = resolveNormalizedDesi({
    ...order,
    desi: null,
    desiSource: null,
    items: [
      {
        ...order.items[0],
        desi: null,
        lengthCm: 30,
        widthCm: 20,
        heightCm: 10,
      },
    ],
  })
  assert.equal(calculatedDesi.desi, 4)
  assert.equal(calculatedDesi.desiSource, 'calculated')

  const missingDesi = resolveNormalizedDesi({
    ...order,
    desi: null,
    desiSource: null,
    items: [{ ...order.items[0], desi: null }],
  })
  assert.equal(missingDesi.desi, null)
  assert.equal(missingDesi.desiSource, null)

  const missingBarcodeShipment = {
    ...shipment,
    barcode: '',
    barcodeValue: '',
    barcodeSource: '',
    barcodeRaw: '',
    verifiedShipment: false,
    operationalBarcodeVerified: false,
    lifecycleStage: 'SHIPMENT_REGISTERED_LABEL_REQUIRED',
    suratTrackingLog: {
      ...shipment.suratTrackingLog,
      BarkodNo: '',
    },
    suratCreateLog: {
      ...shipment.suratCreateLog,
      Barcode: '',
      BarcodeRaw: '',
      hasBarcode: false,
      verifiedShipment: false,
      parsedResponse: {
        ...shipment.suratCreateLog.parsedResponse,
        Barcode: '',
        Barkod: '',
        BarcodeRaw: '',
      },
    },
  }
  await assert.rejects(
    () =>
      provider.generateSingle({
        order: { ...order, shipment: missingBarcodeShipment },
        shipment: missingBarcodeShipment,
        template: buildTemplate(),
      }),
    /Etiket yazdırılamadı/,
  )
  assert.equal(
    canCreateShipment({
      ...order,
      shipment: missingBarcodeShipment,
      operationStatus: 'SURAT_BARCODE_FAILED',
      labelStatus: 'BLOCKED',
    }),
    true,
  )
  assert.equal(
    canCreateShipment({
      ...order,
      shipment: rawShipment,
      operationStatus: 'LABEL_READY',
      labelStatus: 'READY',
    }),
    false,
  )
  assert.equal(
    canCreateShipment({
      ...order,
      shipment: {
        ...rawShipment,
        dispatchRegistrationConfirmed: false,
      },
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
      label: {
        id: 'old-unconfirmed-label',
        labelType: 'zpl',
        barcodeFormat: 'Code128',
        barcodeValue: '01231201025',
        templateId: 'tpl-test',
        zplContent: suratRawZpl,
        createdAt: new Date().toISOString(),
        printedAt: new Date().toISOString(),
      },
    }),
    true,
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

  storage.set(
    'cargoflow.integrationConfig',
    JSON.stringify({
      ...buildConfig(),
      surat: {
        ...buildConfig().surat,
        serviceMode: undefined,
        serviceType: 'GonderiyiKargoyaGonderRestJson',
        createShipmentPath: '/api/GonderiyiKargoyaGonder',
      },
    }),
  )
  const configService = new IntegrationConfigService()
  const migratedConfig = configService.loadIntegrationConfig()
  assert.equal(migratedConfig.surat.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(
    migratedConfig.surat.serviceType,
    'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
  )
  assert.equal(
    migratedConfig.surat.createShipmentPath,
    '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  )
  const explicitLegacyConfig = configService.saveIntegrationConfig({
    ...migratedConfig,
    surat: {
      ...migratedConfig.surat,
      serviceMode: 'PRE_REGISTRATION_REST',
      serviceType: 'OrtakBarkodOlusturSoap',
      createShipmentPath: '/api/OrtakBarkodOlustur',
    },
  })
  assert.equal(explicitLegacyConfig.surat.serviceMode, 'PRE_REGISTRATION_REST')
  assert.equal(
    explicitLegacyConfig.surat.serviceType,
    'GonderiyiKargoyaGonderRestJson',
  )
  assert.equal(
    explicitLegacyConfig.surat.createShipmentPath,
    '/api/GonderiyiKargoyaGonder',
  )
  assert.equal(
    configService.loadIntegrationConfig().surat.serviceMode,
    'PRE_REGISTRATION_REST',
  )

  const workflow = new OrderWorkflowService(
    {},
    { createShipment: async () => buildShipment() },
    provider,
    {},
    { append: () => [] },
  )
  const missingDesiOrder = {
    ...buildOrder(),
    desi: null,
    desiSource: null,
  }
  const missingDesiResult = await workflow.createShipments(
    [missingDesiOrder],
    [missingDesiOrder.id],
    buildConfig(),
  )
  assert.match(missingDesiResult.result.message, /Desi bilgisi eksik/i)
  assert.doesNotMatch(missingDesiResult.result.message, /zaten oluşturulmuş/i)
  assert.match(
    missingDesiResult.result.bulkActionDebug.skippedReasons.join(' '),
    /Top Ds\/Kg/i,
  )

  const workflowOrder = buildOrder()
  const workflowResult = await workflow.createShipments(
    [workflowOrder],
    [workflowOrder.id],
    buildConfig(),
  )
  const readyOrder = workflowResult.orders[0]
  assert.equal(readyOrder.operationStatus, 'LABEL_READY')
  assert.equal(readyOrder.labelStatus, 'READY')
  assert.equal(readyOrder.shipment.labelStatus, 'READY')
  assert.equal(readyOrder.shipment.verifiedShipment, true)
  assert.equal(readyOrder.status, 'Etiket Hazır')
  assert.equal(readyOrder.shipment.statusComputedFrom, 'ORTAK_BARKOD_SUCCESS')
  assert.equal(readyOrder.shipment.tabBucket, 'ETIKET_BASILACAKLAR')
  assert.equal(canDownloadZpl(readyOrder), true)

  const staleErrorOrder = {
    ...buildOrder(),
    shipment: rawShipment,
    operationStatus: 'ERROR',
    labelStatus: 'BLOCKED',
    status: 'Hata',
    error: 'Önceki hata',
    errorMessage: 'Önceki ortak barkod hatası',
    noTrackingReason: 'Takip no yok',
    labelBlockedReason: 'Baskı engellendi',
    zplDisabledReason: 'ZPL kapalı',
  }
  const recoveredOrder = normalizeVerifiedOrtakBarkodState(staleErrorOrder)
  assert.equal(recoveredOrder.operationStatus, 'LABEL_READY')
  assert.equal(recoveredOrder.labelStatus, 'READY')
  assert.equal(recoveredOrder.status, 'Etiket Hazır')
  assert.equal(recoveredOrder.error, undefined)
  assert.equal(recoveredOrder.errorMessage, undefined)
  assert.equal(recoveredOrder.noTrackingReason, undefined)
  assert.equal(recoveredOrder.labelBlockedReason, undefined)
  assert.equal(recoveredOrder.zplDisabledReason, undefined)
  assert.equal(recoveredOrder.matchStatus, true)
  assert.equal(
    recoveredOrder.matchReason,
    'OrtakBarkodOlustur KargoTakipNo + Barcode doğrulandı',
  )
  assert.equal(recoveredOrder.zplReady, true)
  assert.equal(recoveredOrder.printEnabled, true)
  assert.equal(recoveredOrder.shipment.previousStatus, 'ERROR')
  assert.equal(recoveredOrder.shipment.newStatus, 'LABEL_READY')
  assert.equal(recoveredOrder.shipment.previousErrorCleared, true)
  assert.equal(isBarcodePending(recoveredOrder), false)
  assert.equal(isSuratVerificationPending(recoveredOrder), false)
  assert.equal(isLabelReadyForPrint(recoveredOrder), true)
  assert.equal(canDownloadZpl(recoveredOrder), true)
  assert.equal(canMarkPrinted(recoveredOrder), true)

  storage.set('cargoFlow_orders_v3', JSON.stringify([staleErrorOrder]))
  const refreshWorkflow = new OrderWorkflowService(
    {
      fetchOrders: async () => ({
        orders: [{ ...buildOrder(), status: 'Yeni', operationStatus: 'NEW' }],
        source: 'real',
        message: '1 sipariş',
      }),
    },
    {},
    provider,
    {},
    { append: () => [] },
  )
  const refreshed = await refreshWorkflow.fetchOrders(buildConfig())
  assert.equal(refreshed.orders[0].operationStatus, 'LABEL_READY')
  assert.equal(refreshed.orders[0].labelStatus, 'READY')
  assert.equal(refreshed.orders[0].shipment.barcodeRaw, suratRawZpl)
  assert.equal(refreshed.orders[0].errorMessage, undefined)

  const legacyOrder = {
    ...buildOrder(),
    shipment: {
      ...buildShipment(),
      serviceMode: 'PRE_REGISTRATION_REST',
      verifiedShipment: false,
      lifecycleStatus: 'SURAT_CREATED_NO_TRACKING',
      trackingNumber: '',
      kargoTakipNo: '',
      barcode: '',
      barcodeValue: 'PKG123',
      barcodeSource: 'temporary shipmentReference',
      suratCreateLog: {
        ...buildShipment().suratCreateLog,
        serviceMode: 'PRE_REGISTRATION_REST',
        serviceType: 'GonderiyiKargoyaGonderRestJson',
        operationName: 'GonderiyiKargoyaGonder',
        hasTrackingNumber: false,
        hasBarcode: false,
        verifiedShipment: false,
        KargoTakipNo: '',
        Barcode: '',
      },
    },
    operationStatus: 'SURAT_CREATED_NO_TRACKING',
    status: 'Ön Kayıt Yapıldı',
  }
  assert.equal(canCreateShipment(legacyOrder), false)

  const failedShipment = {
    ...buildShipment(),
    status: 'failed',
    lifecycleStatus: 'SURAT_BARCODE_FAILED',
    labelStatus: 'BLOCKED',
    verifiedShipment: false,
    trackingNumber: '',
    kargoTakipNo: '',
    barcode: '',
    barcodeValue: 'PKG123',
    barcodeSource: '',
    diagnosticMessage:
      'OrtakBarkodOlustur çağrıldı ancak Sürat KargoTakipNo/Barcode döndürmedi. Sürat ortak barkod yetkisi, SOAP parametreleri veya hesap ayarları kontrol edilmeli.',
    suratCreateLog: {
      ...buildShipment().suratCreateLog,
      hasTrackingNumber: false,
      hasBarcode: false,
      verifiedShipment: false,
      KargoTakipNo: '',
      Barcode: '',
      parsedResponse: {
        KargoTakipNo: '',
        Barcode: '',
        Barkod: '',
        BarkodNo: '',
        requestReference: 'PKG123',
      },
    },
  }
  const failedWorkflow = new OrderWorkflowService(
    {},
    { createShipment: async () => failedShipment },
    provider,
    {},
    { append: () => [] },
  )
  const failedOrderResult = await failedWorkflow.createShipments(
    [buildOrder()],
    ['order-1'],
    buildConfig(),
  )
  const failedOrder = failedOrderResult.orders[0]
  assert.equal(failedOrder.operationStatus, 'SURAT_BARCODE_FAILED')
  assert.equal(failedOrder.labelStatus, 'BLOCKED')
  assert.equal(canDownloadZpl(failedOrder), false)
  assert.equal(canMarkPrinted(failedOrder), false)

  const uncertainShipment = {
    ...buildShipment(),
    status: 'failed',
    lifecycleStatus: 'SURAT_CREATE_UNCERTAIN',
    labelStatus: 'BLOCKED',
    verifiedShipment: false,
    dispatchRegistrationConfirmed: false,
    operationalBarcodeVerified: false,
    technicalZplReceived: false,
    trackingNumber: '',
    kargoTakipNo: '',
    tNo: '',
    barcode: '',
    barkodNo: '',
    barcodeValue: '',
    barcodeRaw: '',
    rawResponse: {},
    printEnabled: false,
    verificationStage: 'tracking_confirmation_missing',
    errorCategory: 'SURAT_TRACKING_CONFIRMATION_MISSING',
    codeCandidates: {
      unverifiedTNoCandidate: '24510610424923',
      unverifiedBarcodeCandidate: '01249492893',
    },
    noTrackingReason:
      'Serendip Gonderiler=1 teyidi yok. Aday kodlar yazdirilamaz.',
    suratCreateLog: {
      serviceMode: 'ORTAK_BARKOD_SOAP',
      serviceType: 'OrtakBarkodOlusturSoap',
      operationName: 'OrtakBarkodOlustur',
      verifiedShipment: false,
      codeCandidates: {
        unverifiedTNoCandidate: '24510610424923',
        unverifiedBarcodeCandidate: '01249492893',
      },
    },
  }
  const uncertainWorkflow = new OrderWorkflowService(
    {},
    { createShipment: async () => uncertainShipment },
    provider,
    {},
    { append: () => [] },
  )
  const uncertainOrderResult = await uncertainWorkflow.createShipments(
    [buildOrder()],
    ['order-1'],
    buildConfig(),
  )
  const uncertainOrder = uncertainOrderResult.orders[0]
  assert.equal(uncertainOrder.operationStatus, 'SURAT_TRACKING_MISSING')
  assert.equal(uncertainOrder.labelStatus, 'BLOCKED')
  assert.equal(uncertainOrder.shipment.printEnabled, false)
  assert.equal(uncertainOrder.shipment.trackingNumber, '')
  assert.equal(uncertainOrder.shipment.barcode, '')
  assert.equal(canDownloadZpl(uncertainOrder), false)
  assert.equal(canMarkPrinted(uncertainOrder), false)

  const webOnlyZpl =
    '^XA^FO20,20^A0N,25,25^FDT.No:^FS^FO20,55^BCN,80,Y,N,N^FDWeb3952033136^FS^XZ'
  const webAnalysis = analyzeSuratZpl(webOnlyZpl)
  assert.equal(webAnalysis.internalWebBarcode, 'Web3952033136')
  assert.equal(webAnalysis.acceptedFinalBarcode, 'Web3952033136')
  assert.equal(webAnalysis.rejectionReason, '')

  const webOnlyShipment = {
    ...buildShipment(),
    trackingNumber: '',
    kargoTakipNo: '',
    tNo: '',
    barcode: '',
    barcodeValue: '',
    barcodeRaw: webOnlyZpl,
    verifiedShipment: false,
    operationalBarcodeVerified: false,
    technicalZplReceived: true,
    verificationStage: 'zpl_received_but_not_operationally_verified',
    lifecycleStatus: 'SURAT_TRACKING_MISSING',
    labelStatus: 'BLOCKED',
    suratCreateLog: {
      ...buildShipment().suratCreateLog,
      verifiedShipment: false,
      KargoTakipNo: '',
      Barcode: '',
      BarcodeRaw: webOnlyZpl,
      zplAnalysis: webAnalysis,
      parsedResponse: {
        KargoTakipNo: '',
        Barcode: 'Web3952033136',
        BarcodeRaw: webOnlyZpl,
      },
    },
  }
  const webOnlyOrder = {
    ...buildOrder(),
    shipment: webOnlyShipment,
    operationStatus: 'SURAT_TRACKING_MISSING',
    labelStatus: 'BLOCKED',
  }
  const webVerification = verifySuratShipment(
    webOnlyOrder,
    webOnlyShipment,
  )
  assert.equal(webVerification.technicalZplReceived, true)
  assert.equal(
    webVerification.operationalBarcodeVerified,
    false,
    JSON.stringify(webVerification),
  )
  assert.equal(webVerification.operationalPrintAllowed, false)
  assert.equal(canDownloadZpl(webOnlyOrder), false)
  assert.equal(canMarkPrinted(webOnlyOrder), false)
  const webPrintable = resolvePrintableLabel(webOnlyOrder)
  assert.equal(webPrintable.canPreview, false)
  assert.equal(webPrintable.canPrint, false)

  const webAndQrZpl =
    '^XA^FO20,20^BCN,80,Y,N,N^FD>:Web00155611659^FS^FO20,120^BXN,4,200^FDWeb00155611659-S119-2357^FS^FO20,220^BQN,2,4^FDQA,7270033753100082^FS^XZ'
  const webAndQrAnalysis = analyzeSuratZpl(webAndQrZpl)
  assert.deepEqual(webAndQrAnalysis.mainCode128Candidates, [
    'Web00155611659',
  ])
  assert.deepEqual(webAndQrAnalysis.dataMatrixCandidates, [
    'Web00155611659-S119-2357',
  ])
  assert.deepEqual(webAndQrAnalysis.qrCandidates, ['7270033753100082'])
  assert.equal(webAndQrAnalysis.acceptedFinalBarcode, 'Web00155611659')
  assert.equal(webAndQrAnalysis.rejectionReason, '')

  const webAndQrShipment = {
    ...webOnlyShipment,
    barcodeRaw: webAndQrZpl,
    internalWebBarcode: 'Web00155611659',
    zplAnalysis: webAndQrAnalysis,
    suratCreateLog: {
      ...webOnlyShipment.suratCreateLog,
      BarcodeRaw: webAndQrZpl,
      zplAnalysis: webAndQrAnalysis,
      parsedResponse: {
        KargoTakipNo: '',
        Barcode: '',
        BarcodeRaw: webAndQrZpl,
      },
    },
  }
  const webAndQrOrder = {
    ...webOnlyOrder,
    cargoTrackingNumber: '7270033753100082',
    shipment: webAndQrShipment,
  }
  const webAndQrVerification = verifySuratShipment(
    webAndQrOrder,
    webAndQrShipment,
  )
  assert.equal(webAndQrVerification.finalSuratBarcode, '')
  assert.equal(webAndQrVerification.officialBarcodeValue, '')
  const webAndQrLabelData = buildLabelData(webAndQrOrder, webAndQrShipment)
  assert.equal(webAndQrLabelData.suratFieldMapping.selectedBarcodeValue, '')

  const officialWebShipment = {
    ...webAndQrShipment,
    barcode: 'Web00155611659',
    barcodeValue: 'Web00155611659',
    barcodeSource: 'surat.ortakBarkod.BarcodeRaw.Code128',
    finalSuratBarcode: 'Web00155611659',
    verifiedShipment: true,
    dispatchRegistrationConfirmed: true,
    operationalBarcodeVerified: true,
    verificationStage: 'operational_barcode_verified',
    lifecycleStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }
  const officialWebOrder = {
    ...webAndQrOrder,
    shipment: officialWebShipment,
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  }
  const officialWebVerification = verifySuratShipment(
    officialWebOrder,
    officialWebShipment,
  )
  assert.equal(officialWebVerification.operationalBarcodeVerified, false)
  assert.equal(officialWebVerification.finalSuratBarcode, '')
  assert.equal(officialWebVerification.officialBarcodeValue, '')
  const officialWebLabelData = buildLabelData(
    officialWebOrder,
    officialWebShipment,
  )
  assert.equal(
    officialWebLabelData.suratFieldMapping.selectedBarcodeValue,
    '',
  )
})

function buildOrder() {
  return {
    id: 'order-1',
    marketplace: 'Trendyol',
    externalOrderId: 'ORDER123',
    orderNumber: 'ORDER123',
    packageId: 'PKG123',
    cargoTrackingNumber: '7270033563324593',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    source: 'real',
    status: 'Kargo Oluşturuldu',
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
        id: 'item-1',
        productName: 'Ürün A',
        sku: 'SKU-A',
        barcode: 'PRODUCT-A',
        quantity: 2,
        variantAttributes: [],
      },
    ],
  }
}

function buildShipment() {
  const barcodeRaw =
    '^XA\n^FO20,20^A0N,30,30^FDSURAT LABEL^FS\n^FO20,70^BCN,80,Y,N,N^FD01231201025^FS\n^XZ'
  const parsedResponse = {
    KargoTakipNo: '25220148446193',
    TNo: '25220148446193',
    Barcode: '01231201025',
    BarcodeRaw: barcodeRaw,
    Barkod: '01231201025',
    requestReference: 'PKG123',
  }
  return {
    id: 'shp-1',
    provider: 'surat-kargo',
    serviceMode: 'ORTAK_BARKOD_SOAP',
    operationName: 'OrtakBarkodOlustur',
    trackingNumber: '25220148446193',
    kargoTakipNo: '25220148446193',
    tNo: '25220148446193',
    barcode: '01231201025',
    barcodeRaw,
    zplSource: 'surat.ortakBarkod.BarcodeRaw',
    trackingUrl:
      'https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=25220148446193',
    shipmentCode: 'PKG123',
    satisKodu: 'ORDER123',
    webSiparisKodu: '7270033563324593',
    ozelKargoTakipNo: '7270033563324593',
    barcodeValue: '01231201025',
    barcodeSource: 'surat.ortakBarkod.Barcode',
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
      KargoTakipNo: '25220148446193',
      BarkodNo: '01231201025',
      WebSiparisKodu: '7270033563324593',
      OzelKargoTakipNo: '7270033563324593',
    },
    rawResponse: { parsedResponse },
    suratCreateLog: {
      rawRequest: '<soap:Envelope />',
      rawResponse: '<soap:Envelope />',
      responseStatus: 200,
      contentType: 'text/xml',
      parsedResponse,
      createdAt: new Date().toISOString(),
      orderId: 'order-1',
      shipmentId: 'PKG123',
      serviceType: 'OrtakBarkodOlusturSoap',
      serviceMode: 'ORTAK_BARKOD_SOAP',
      operationName: 'OrtakBarkodOlustur',
      endpoint: 'OrtakBarkodOlustur',
      payloadFormat: 'SOAP/XML',
      hasTrackingNumber: true,
      hasBarcode: true,
      verifiedShipment: true,
      KargoTakipNo: '25220148446193',
      codeMapping: {
        trackingField: 'kargoTakipNo',
        barcodeField: 'Barcode',
        tNoField: 'TNo',
        trackingValue: '25220148446193',
        barcodeValue: '01231201025',
        tNoValue: '25220148446193',
      },
      Barcode: '01231201025',
      BarcodeRaw: barcodeRaw,
      barcodeSource: 'surat.ortakBarkod.Barcode',
      requestReference: 'PKG123',
    },
    createdAt: new Date().toISOString(),
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
      serviceType: 'OrtakBarkodOlusturSoap',
      createShipmentPath: '/api/OrtakBarkodOlustur',
      trackingServiceType: 'KargoTakipHareketDetayiSoap',
      trackingPath: '/api/KargoTakipHareketDetayi',
    },
  }
}
