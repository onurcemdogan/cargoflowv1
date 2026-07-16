import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const host = '127.0.0.1'

test('Sürat ortak barkod, ön kayıt ve tracking durumları doğru ayrılır', async (t) => {
  const requests = []
  const legacyResponses = [
    {
      ResponseId: '013',
      Message: '[013] Barkod Tekrardan İletilmiştir',
      KargoTakipNo: '25220148446193',
      BarkodNo: '01231201025',
    },
    {
      ResponseId: '014',
      Message: '[014] Desi/Kg Güncellenmiştir. Barkod Tekrar İletilmiştir',
      KargoTakipNo: '25220148446193',
      BarkodNo: '01231201025',
    },
    {
      ResponseId: '015',
      Message: '[015] Desi/Kg Güncellenmiştir. Barkod İletilmiştir',
      KargoTakipNo: '25220148446193',
      BarkodNo: '01231201025',
    },
    {
      ResponseId: '016',
      Message: '[016] Barkod Gönderilmiştir',
      KargoTakipNo: '25220148446193',
      BarkodNo: '01231201025',
    },
    '[009] Bu Siparişe Ait Gönderi Oluşmuştur',
    'Bu gonderi daha önce oluşturulmuş.',
    'Tamam',
  ]
  let trackingCallCount = 0

  const mockSurat = http.createServer(async (request, response) => {
    const body = await readBody(request)
    const soapAction = String(request.headers.soapaction ?? '')
    requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers['content-type'],
      soapAction,
      body,
    })

    if (request.url?.startsWith('/integration/order/sellers/')) {
      if (request.method !== 'PUT') {
        response.writeHead(405, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ message: 'Method not allowed' }))
        return
      }
      if (request.url.includes('FAILPICKING')) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            errors: ['Package cannot be moved to Picking'],
          }),
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'Picking' }))
      return
    }

    if (request.url === '/api/GonderiyiKargoyaGonder') {
      if (body.includes('7270033764185795')) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify(
            '[043] - TRENDYOL TARAFINDAN DÖNEN HATA MESAJI HATA KODU : 1002 Kargo uygun bir statüde değil.',
          ),
        )
        return
      }
      if (body.includes('FAILREGISTER')) {
        response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify('[500] Gönderi kayıt servisi reddetti'))
        return
      }
      if (body.includes('FAILBARCODE')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            ResponseId: '016',
            Message: '[016] Barkod Gönderilmiştir',
          }),
        )
        return
      }
      const result = legacyResponses.shift() ?? {
        ResponseId: '016',
        Message: '[016] Barkod Gönderilmiştir',
        KargoTakipNo: '25220148446193',
        BarkodNo: '01231201025',
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(result))
      return
    }

    if (soapAction.includes('OrtakBarkodOlustur')) {
      if (body.includes('<ReferansNo>FAILBARCODE</ReferansNo>')) {
        sendSoapComplex(
          response,
          'OrtakBarkodOlustur',
          `<isError>true</isError>
           <Message>Bilgiler güncellenirken hata oluştu.</Message>
           <KargoTakipNo />`,
        )
        return
      }
      if (body.includes('<ReferansNo>KARGOBARKODU</ReferansNo>')) {
        sendSoapComplex(
          response,
          'OrtakBarkodOlustur',
          `<isError>false</isError>
           <Message>Teknik ZPL oluÅŸturuldu</Message>
           <Barcode><anyType>^XA ^FT48,300^BCN,,Y,N ^FDWeb00155729156^FS ^XZ</anyType></Barcode>`,
        )
        return
      }
      if (
        body.includes('<ReferansNo>WEBONLY</ReferansNo>') ||
        body.includes('<ReferansNo>WEBONLY-CARGO</ReferansNo>')
      ) {
        sendSoapComplex(
          response,
          'OrtakBarkodOlustur',
          `<isError>false</isError>
           <Message>Teknik ZPL oluşturuldu</Message>
           <Barcode><anyType>^XA ^FT48,300^BCN,,Y,N ^FDWebWEBONLY^FS ^XZ</anyType></Barcode>`,
        )
        return
      }
      sendSoapComplex(
        response,
        'OrtakBarkodOlustur',
        `<isError>false</isError>
         <Message>Barkod oluşturuldu</Message>
         <KargoTakipNo>25220148446193</KargoTakipNo>
         <TNo>TNO25220148446193</TNo>
         <Barcode><anyType>^XA ^FT48,300^BCN,,Y,N ^FD&gt;:01231201025^FS ^XZ</anyType></Barcode>`,
      )
      return
    }

    if (
      soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      )
    ) {
      sendSoapComplex(
        response,
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
        `<isError>false</isError>
         <Message>014</Message>
         <Barcode>^XA
          ^FT514,79^A0N,28,28^FH\^FD89815102462541^FS
          ^FT453,79^A0N,23,24^FH\^FDT.No:^FS
          ^FT25,706^A0B,20,28^FH\^FDSiparis No: 7270039999999998^FS
          ^BY4,4,143 ^FT48,300^BCN,,Y,N ^FD&gt;:01249329179^FS
          ^BY256,256 ^FT690,650 ^BQN,4,4 ^FDQA,7270039999999998^FS
          ^XZ</Barcode>`,
      )
      return
    }

    if (soapAction.includes('KargoBarkoduSiparis')) {
      if (body.includes('CARRIERLABEL')) {
        sendSoapComplex(
          response,
          'KargoBarkoduSiparis',
          `<OzelKargoTakipNo />
           <KargoTakipNo />
           <Aciklama>Object reference not set to an instance of an object.</Aciklama>
           <BarkodNo />`,
        )
        return
      }
      sendSoapComplex(
        response,
        'KargoBarkoduSiparis',
        `<OzelKargoTakipNo>7270034129020027</OzelKargoTakipNo>
         <KargoTakipNo>25220148446193</KargoTakipNo>
         <Aciklama>PDF barkod oluÅŸturuldu</Aciklama>
         <BarkodNo><string>01231201025</string></BarkodNo>
         <PdfBarkod>JVBERi0xLjQKJVRFU1Q=</PdfBarkod>
         <Detay><VarisSube>KadÄ±kÃ¶y</VarisSube><SonAktarma>GEREDE AKTARMA</SonAktarma><ParcaAdedi>1</ParcaAdedi></Detay>`,
      )
      return
    }

    if (soapAction.includes('KargoBarkodu')) {
      if (body.includes('7270039999999999')) {
        sendSoapComplex(
          response,
          'KargoBarkodu',
          `<OzelKargoTakipNo>7270039999999999</OzelKargoTakipNo>
           <KargoTakipNo>253220148446193</KargoTakipNo>
           <Aciklama>Operasyonel barkod oluÅŸturuldu</Aciklama>
           <BarkodNo><string>01231201025</string></BarkodNo>`,
        )
        return
      }
      sendSoapComplex(
        response,
        'KargoBarkodu',
        `<OzelKargoTakipNo />
         <KargoTakipNo />
         <Aciklama>KayÄ±t bulunamadÄ±</Aciklama>
         <BarkodNo />`,
      )
      return
    }

    if (soapAction.includes('KargoTakipHareketDetayi')) {
      if (body.includes('MISSING-TRACKING')) {
        sendSoapString(
          response,
          'KargoTakipHareketDetayi',
          JSON.stringify({
            IsError: true,
            errorMessage: 'Sipariş bulunamadı.',
            Gonderiler: [],
          }),
        )
        return
      }
      if (
        body.includes('WEBONLY') ||
        body.includes('CARRIERLABEL') ||
        body.includes('7270039999999998')
      ) {
        sendSoapString(
          response,
          'KargoTakipHareketDetayi',
          JSON.stringify({
            IsError: false,
            errorMessage: '',
            Gonderiler: [],
          }),
        )
        return
      }
      trackingCallCount += 1
      if (trackingCallCount === 1) {
        sendSoapString(
          response,
          'KargoTakipHareketDetayi',
          JSON.stringify({
            IsError: false,
            errorMessage:
              'Veri aktarımı sağlanmış olup kargo kabul bekleniyor.',
            Gonderiler: [],
          }),
        )
        return
      }
      sendSoapString(
        response,
        'KargoTakipHareketDetayi',
        JSON.stringify({
          IsError: false,
          errorMessage: '',
          Gonderiler: [
            {
              WebSiparisKodu: 'PKG123',
              SatisKodu: 'PKG123',
              OzelKargoTakipNo: 'PKG123',
              KargoTakipNo: '25220148446193',
              BarkodNo: '01231201025',
              KargonunDurumu: 'Teslim Edildi',
              KargonunDurumuSayi: '6',
              KargonunBulunduguYer: 'Kadıköy Teslimat Şubesi',
              SonHareketTarihi: '2026-06-19T12:30:00',
              TeslimatSubesi: 'Kadıköy',
              TeslimatSubeTel: '02160000000',
              IadeDurum: '',
              DevirDurum: '',
              TakipUrl:
                'https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=25220148446193',
            },
          ],
        }),
      )
      return
    }

    response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end(`Beklenmeyen istek: ${request.url} ${soapAction}`)
  })

  const mockPort = await listen(mockSurat)
  t.after(() => mockSurat.close())

  const apiPort = await getFreePort()
  const configDirectory = await mkdtemp(join(tmpdir(), 'cargoflow-surat-test-'))
  t.after(() => rm(configDirectory, { recursive: true, force: true }))
  const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CARGOFLOW_API_PORT: String(apiPort),
      SURAT_SOAP_URL: `http://${host}:${mockPort}/services.asmx`,
      SURAT_REST_TEST_BASE_URL: `http://${host}:${mockPort}`,
      SURAT_REST_LIVE_BASE_URL: `http://${host}:${mockPort}`,
      TRENDYOL_PROD_BASE_URL: `http://${host}:${mockPort}`,
      TRENDYOL_STAGE_BASE_URL: `http://${host}:${mockPort}`,
      CARGOFLOW_CONFIG_DIR: configDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => apiProcess.kill())
  await waitForHealth(apiPort, apiProcess)

  const order = buildOrder()
  const legacyConfig = buildConfig({
    allowPreRegistrationRest: true,
    serviceMode: 'PRE_REGISTRATION_REST',
    serviceType: 'GonderiyiKargoyaGonderRestJson',
    createShipmentPath: '/api/GonderiyiKargoyaGonder',
  })

  for (const expectedCode of ['013', '014', '015', '016', '009']) {
    const response = await postJson(apiPort, '/api/shipments/surat/create', {
      config: legacyConfig,
      order,
    })
    assert.equal(response.ok, true)
    assert.equal(response.serviceType, 'GonderiyiKargoyaGonderRestJson')
    assert.equal(response.payloadFormat, 'JSON')
    assert.equal(response.suratCreateLog.responseCode, expectedCode)
    assert.equal(
      response.suratCreateLog.barcodeResponseCodeDetected,
      expectedCode !== '009',
    )
    assert.equal(response.suratCreateLog.hasTrackingNumber, expectedCode !== '009')
    assert.equal(response.suratCreateLog.preRegistrationOnly, true)
    assert.equal(
      response.shipment.lifecycleStatus,
      'LABEL_READY',
    )
    assert.ok(response.message)
  }

  const legacyRequest = requests.find(
    (item) => item.path === '/api/GonderiyiKargoyaGonder',
  )
  const legacyBody = JSON.parse(legacyRequest.body)
  assert.match(legacyRequest.contentType, /application\/json/)
  assert.equal(legacyBody.Gonderi.OzelKargoTakipNo, '7270033563324593')
  assert.equal(legacyBody.Gonderi.ReferansNo, '7270033563324593')
  assert.equal(legacyBody.Gonderi.WebSiparisKodu, 'ORDER123')
  assert.equal(legacyBody.Gonderi.SatisKodu, 'ORDER123')
  assert.equal(
    legacyBody.Gonderi.MarketplaceIntegrationCode,
    '7270033563324593',
  )
  assert.equal(legacyBody.Gonderi.Pazaryerimi, 1)
  assert.equal(legacyBody.Gonderi.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(legacyBody.Gonderi.Iademi, false)
  assert.equal(legacyBody.Gonderi.Adet, 3)

  const pdfBarcodeConfig = buildConfig({
    serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
    serviceType: 'KargoBarkoduSiparisSoap',
    createShipmentPath: '/api/KargoBarkoduSiparis',
    webPassword: 'TEST_WEB_PASSWORD',
  })
  const requestCountBeforeMissingContract = requests.length
  const missingContractConfig = buildConfig({
    serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
    serviceType: 'KargoBarkoduSiparisSoap',
    createShipmentPath: '/api/KargoBarkoduSiparis',
    webPassword: 'TEST_WEB_PASSWORD',
    entegrasyonSozlesme: '',
  })
  const missingContractResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: missingContractConfig, order },
  )
  assert.equal(missingContractResponse.ok, true)
  const missingContractSoapRequest = requests
    .slice(requestCountBeforeMissingContract)
    .find((item) => item.soapAction.includes('KargoBarkoduSiparis'))
  assert.ok(missingContractSoapRequest)
  assert.match(
    missingContractSoapRequest.body,
    /<EntegrasyonSozlesme>0<\/EntegrasyonSozlesme>/,
  )
  const requestCountBeforePdfBarcode = requests.length
  const pdfBarcodeResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: pdfBarcodeConfig,
      order: {
        ...order,
        id: 'order-pdf-barcode',
        orderNumber: '11397075043',
        packageId: '3986108535',
        shipmentPackageId: '3986108535',
        cargoTrackingNumber: '7270034129020027',
      },
    },
  )
  assert.equal(pdfBarcodeResponse.ok, true)
  assert.equal(pdfBarcodeResponse.serviceType, 'KargoBarkoduSiparisSoap')
  assert.equal(pdfBarcodeResponse.operationName, 'KargoBarkoduSiparis')
  assert.equal(pdfBarcodeResponse.shipment.trackingNumber, '25220148446193')
  assert.equal(pdfBarcodeResponse.shipment.tNo, '25220148446193')
  assert.equal(pdfBarcodeResponse.shipment.barcode, '01231201025')
  assert.equal(pdfBarcodeResponse.shipment.barkodNo, '01231201025')
  assert.equal(pdfBarcodeResponse.shipment.hasPdfBarkod, true)
  assert.equal(pdfBarcodeResponse.shipment.pdfReady, true)
  assert.equal(pdfBarcodeResponse.shipment.printEnabled, true)
  assert.equal(pdfBarcodeResponse.shipment.labelStatus, 'READY')
  assert.equal(
    pdfBarcodeResponse.shipment.barcodeSource,
    'surat.KargoTakipHareketDetayi.BarkodNo',
  )
  assert.equal(
    pdfBarcodeResponse.shipment.trackingSource,
    'surat.KargoTakipHareketDetayi.KargoTakipNo',
  )
  assert.equal(pdfBarcodeResponse.shipment.verificationStage, 'serdendip_verified')
  assert.equal(pdfBarcodeResponse.trackingVerification.serdendipVerified, true)
  assert.equal(
    pdfBarcodeResponse.download.fileName,
    'surat-etiket-11397075043.pdf',
  )
  const pdfSoapRequest = requests
    .slice(requestCountBeforePdfBarcode)
    .find((item) => item.soapAction.includes('KargoBarkoduSiparis'))
  assert.ok(pdfSoapRequest)
  assert.match(pdfSoapRequest.body, /<WebPassword>TEST_WEB_PASSWORD<\/WebPassword>/)
  assert.match(pdfSoapRequest.body, /<ReferansNo>7270034129020027<\/ReferansNo>/)
  assert.match(pdfSoapRequest.body, /<OzelKargoTakipNo>7270034129020027<\/OzelKargoTakipNo>/)
  assert.match(pdfSoapRequest.body, /<SiparisObjId>0<\/SiparisObjId>/)
  assert.match(
    pdfSoapRequest.body,
    /<EntegrasyonSozlesme>12345<\/EntegrasyonSozlesme>/,
  )
  assert.doesNotMatch(pdfSoapRequest.body, /<EntegrasyonMusteri>/)
  assert.ok(
    pdfSoapRequest.body.indexOf('<GonderiSekli>') <
      pdfSoapRequest.body.indexOf('<KisiKurum>'),
  )
  assert.ok(
    pdfSoapRequest.body.indexOf('<SevkAdresiAdi>') <
      pdfSoapRequest.body.indexOf('<TeslimSekli>'),
  )
  assert.ok(
    pdfSoapRequest.body.indexOf('<EntegrasyonSozlesme>') <
      pdfSoapRequest.body.indexOf('<Iademi>'),
  )

  const idempotencyRequestStart = requests.length
  const idempotencyBody = {
    config: pdfBarcodeConfig,
    order: {
      ...order,
      id: 'order-idempotency-parallel',
      orderNumber: 'IDEMPOTENCY-ORDER',
      packageId: 'IDEMPOTENCY-PACKAGE',
      shipmentPackageId: 'IDEMPOTENCY-PACKAGE',
      cargoTrackingNumber: '7270034129020027',
    },
  }
  const [parallelCreateA, parallelCreateB] = await Promise.all([
    postJson(apiPort, '/api/shipments/surat/create', idempotencyBody),
    postJson(apiPort, '/api/shipments/surat/create', idempotencyBody),
  ])
  assert.equal(parallelCreateA.ok, true)
  assert.equal(parallelCreateB.ok, true)
  assert.equal(
    requests
      .slice(idempotencyRequestStart)
      .filter((item) => item.soapAction.includes('KargoBarkoduSiparis'))
      .length,
    1,
  )
  assert.equal(
    [parallelCreateA, parallelCreateB].some(
      (item) => item.idempotency.reusedInFlight === true,
    ),
    true,
  )
  const requestCountBeforePersistedReplay = requests.length
  const persistedReplay = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    idempotencyBody,
  )
  assert.equal(persistedReplay.ok, true)
  assert.equal(persistedReplay.idempotency.restoredFromStore, true)
  assert.equal(persistedReplay.idempotency.carrierCreateCalled, false)
  assert.equal(requests.length, requestCountBeforePersistedReplay)

  const sellerCredentialRequestStart = requests.length
  const sellerCredentialResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: buildConfig({
        serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
        serviceType: 'KargoBarkoduSiparisSoap',
        createShipmentPath: '/api/KargoBarkoduSiparis',
        sellerPaysKullaniciAdi: 'SELLER_CARI',
        sellerPaysSifre: 'SELLER_SIFRE',
        sellerPaysWebPassword: 'SELLER_WEB_PASSWORD',
      }),
      order: {
        ...order,
        id: 'order-seller-pays-credential',
        orderNumber: 'SELLER-PAYS-ORDER',
      },
    },
  )
  assert.equal(sellerCredentialResponse.ok, true)
  const sellerCredentialRequest = requests
    .slice(sellerCredentialRequestStart)
    .find((item) => item.soapAction.includes('KargoBarkoduSiparis'))
  assert.match(sellerCredentialRequest.body, /<cariKodu>SELLER_CARI<\/cariKodu>/)
  assert.match(
    sellerCredentialRequest.body,
    /<WebPassword>SELLER_WEB_PASSWORD<\/WebPassword>/,
  )

  const codCredentialRequestStart = requests.length
  const codCredentialResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: buildConfig({
        serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
        serviceType: 'KargoBarkoduSiparisSoap',
        createShipmentPath: '/api/KargoBarkoduSiparis',
        codKullaniciAdi: 'COD_CARI',
        codSifre: 'COD_SIFRE',
        codWebPassword: 'COD_WEB_PASSWORD',
      }),
      order: {
        ...order,
        id: 'order-cod-credential',
        orderNumber: 'COD-ORDER',
        isCashOnDelivery: true,
        cashOnDeliveryAmount: 25.5,
      },
    },
  )
  assert.equal(codCredentialResponse.ok, true)
  const codCredentialRequest = requests
    .slice(codCredentialRequestStart)
    .find((item) => item.soapAction.includes('KargoBarkoduSiparis'))
  assert.match(codCredentialRequest.body, /<cariKodu>COD_CARI<\/cariKodu>/)
  assert.match(
    codCredentialRequest.body,
    /<WebPassword>COD_WEB_PASSWORD<\/WebPassword>/,
  )
  assert.match(
    codCredentialRequest.body,
    /<KapidanOdemeTutari>25.5<\/KapidanOdemeTutari>/,
  )

  const diagnosticLoop = await postJson(
    apiPort,
    '/api/diagnostics/surat/common-barcode-loop',
    {
      config: buildConfig({
        serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
        serviceType: 'KargoBarkoduSiparisSoap',
        createShipmentPath: '/api/KargoBarkoduSiparis',
        webPassword: '',
      }),
      order: {
        ...order,
        id: 'order-diagnostic-loop',
        orderNumber: '11397075043',
        packageId: '3986108535',
        shipmentPackageId: '3986108535',
        cargoTrackingNumber: '7270034129020027',
        marketplaceStatus: 'Picking',
        packageStatus: 'Picking',
        cargoProviderName: 'Sürat Kargo Marketplace',
      },
    },
  )
  assert.equal(diagnosticLoop.ok, true)
  assert.equal(diagnosticLoop.canAttemptLiveSuratCall, false)
  assert.equal(diagnosticLoop.terminalBlocker.stepId, 'credentials')
  assert.equal(
    diagnosticLoop.steps.find((step) => step.id === 'request-mapping').status,
    'PASS',
  )
  assert.equal(
    diagnosticLoop.steps.find((step) => step.id === 'credentials').evidence
      .normalShipmentPasswordUsedAsWebPassword,
    false,
  )

  const samePasswordDiagnostic = await postJson(
    apiPort,
    '/api/diagnostics/surat/common-barcode-loop',
    {
      config: buildConfig({
        serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
        serviceType: 'KargoBarkoduSiparisSoap',
        createShipmentPath: '/api/KargoBarkoduSiparis',
        webPassword: 'TEST_SIFRE',
      }),
      order: {
        ...order,
        marketplaceStatus: 'Picking',
        packageStatus: 'Picking',
        cargoProviderName: 'Sürat Kargo Marketplace',
      },
    },
  )
  const samePasswordCredentialStep = samePasswordDiagnostic.steps.find(
    (step) => step.id === 'credentials',
  )
  assert.equal(samePasswordCredentialStep.status, 'WARN')
  assert.equal(
    samePasswordCredentialStep.evidence.webPasswordMatchesShipmentPassword,
    true,
  )

  const carrierLabelFallbackRequestCount = requests.length
  const carrierLabelFallbackResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: buildConfig({
        serviceMode: 'KARGO_BARKODU_SIPARIS_SOAP',
        serviceType: 'KargoBarkoduSiparisSoap',
        createShipmentPath: '/api/KargoBarkoduSiparis',
        webPassword: 'TEST_SIFRE',
      }),
      order: {
        ...order,
        id: 'order-carrier-label',
        orderNumber: 'CARRIERLABEL-ORDER',
        packageId: 'CARRIERLABEL',
        shipmentPackageId: 'CARRIERLABEL',
        cargoTrackingNumber: '7270039999999998',
        customerName: 'CARRIERLABEL',
      },
    },
  )
  assert.equal(carrierLabelFallbackResponse.ok, false)
  assert.equal(
    carrierLabelFallbackResponse.serviceType,
    'KargoBarkoduSiparisSoap',
  )
  assert.equal(
    carrierLabelFallbackResponse.operationName,
    'KargoBarkoduSiparis',
  )
  assert.equal(
    carrierLabelFallbackResponse.errorCode,
    'SURAT_WEB_PASSWORD_INVALID_OR_PERMISSION_MISSING',
  )
  assert.equal(carrierLabelFallbackResponse.shipment.printEnabled, false)
  assert.equal(carrierLabelFallbackResponse.shipment.verifiedShipment, false)
  const carrierLabelRequests = requests.slice(carrierLabelFallbackRequestCount)
  assert.equal(
    carrierLabelRequests.some((item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    ),
    false,
  )

  const duplicateResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: legacyConfig, order },
  )
  assert.equal(duplicateResponse.ok, true)
  assert.equal(duplicateResponse.suratCreateLog.duplicateShipment, true)
  assert.equal(duplicateResponse.shipment.trackingNumber, '25220148446193')

  const tamamResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: legacyConfig, order },
  )
  assert.equal(tamamResponse.shipment.verifiedShipment, true)
  assert.equal(tamamResponse.shipment.lifecycleStatus, 'LABEL_READY')
  assert.match(tamamResponse.message, /doğrulandı/i)

  const staleLegacyConfigWithoutServiceMode = buildConfig({
    webPassword: 'TEST_WEB_PASSWORD',
    serviceType: 'GonderiyiKargoyaGonderRestJson',
    createShipmentPath: '/api/GonderiyiKargoyaGonder',
  })
  delete staleLegacyConfigWithoutServiceMode.surat.serviceMode
  const migratedDefaultResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: staleLegacyConfigWithoutServiceMode, order },
  )
  assert.equal(migratedDefaultResponse.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(migratedDefaultResponse.operationName, 'OrtakBarkodOlustur')
  assert.equal(migratedDefaultResponse.shipment.verifiedShipment, true)

  const transferredTracking = await postJson(
    apiPort,
    '/api/shipments/surat/track',
    {
      config: legacyConfig.surat,
      webSiparisKodu: 'PKG123',
      orderId: order.id,
      shipmentId: 'shipment-legacy',
    },
  )
  assert.equal(transferredTracking.ok, true)
  assert.equal(
    transferredTracking.trackingState,
    'TRACKING_CONFIRMED',
  )
  assert.equal(transferredTracking.gonderilerLength, 1)
  assert.equal(transferredTracking.tracking.KargoTakipNo, '25220148446193')
  assert.ok(transferredTracking.message)

  const missingTracking = await postJson(
    apiPort,
    '/api/shipments/surat/track',
    {
      config: legacyConfig.surat,
      webSiparisKodu: 'MISSING-TRACKING',
      orderId: order.id,
      shipmentId: 'shipment-missing',
    },
  )
  assert.equal(missingTracking.ok, false)
  assert.equal(missingTracking.gonderilerLength, 0)
  assert.equal(missingTracking.trackingState, 'SURAT_TRACKING_MISSING')

  const commonBarcodeConfig = buildConfig({
    allowPreRegistrationRest: true,
    serviceMode: 'ORTAK_BARKOD_SOAP',
    serviceType: 'OrtakBarkodOlusturSoap',
    createShipmentPath: '/api/OrtakBarkodOlustur',
  })
  const requestCountBeforeMissingTracking = requests.length
  const missingCargoTrackingResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: commonBarcodeConfig,
      order: { ...order, cargoTrackingNumber: '' },
    },
  )
  assert.equal(missingCargoTrackingResponse.ok, false)
  assert.match(
    missingCargoTrackingResponse.message,
    /Trendyol cargoTrackingNumber bulunamadı/i,
  )
  assert.equal(requests.length, requestCountBeforeMissingTracking)

  const commonBarcodeFlowRequestStart = requests.length
  const commonBarcodeResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: commonBarcodeConfig, order },
  )
  assert.equal(commonBarcodeResponse.ok, true)
  assert.equal(commonBarcodeResponse.serviceType, 'OrtakBarkodOlusturSoap')
  assert.equal(commonBarcodeResponse.payloadFormat, 'SOAP/XML')
  assert.equal(commonBarcodeResponse.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(commonBarcodeResponse.operationName, 'OrtakBarkodOlustur')
  assert.equal(commonBarcodeResponse.shipment.trackingNumber, '25220148446193')
  assert.equal(commonBarcodeResponse.shipment.kargoTakipNo, '25220148446193')
  assert.equal(commonBarcodeResponse.shipment.tNo, '25220148446193')
  assert.equal(commonBarcodeResponse.shipment.barcode, '01231201025')
  assert.equal(commonBarcodeResponse.shipment.barcodeValue, '01231201025')
  assert.match(commonBarcodeResponse.shipment.barcodeRaw, /\^XA/)
  assert.equal(
    commonBarcodeResponse.shipment.zplSource,
    'surat.ortakBarkod.BarcodeRaw',
  )
  assert.equal(
    commonBarcodeResponse.shipment.barcodeSource,
    'surat.KargoTakipHareketDetayi.BarkodNo',
  )
  assert.equal(
    commonBarcodeResponse.shipment.codeMapping.trackingField,
    'kargoTakipNo',
  )
  assert.equal(
    commonBarcodeResponse.shipment.codeMapping.barcodeField,
    'barcode',
  )
  assert.equal(commonBarcodeResponse.shipment.verifiedShipment, true)
  assert.equal(
    commonBarcodeResponse.shipment.dispatchRegistrationConfirmed,
    true,
  )
  assert.equal(commonBarcodeResponse.deprecatedServiceModeRequested, undefined)
  assert.equal(commonBarcodeResponse.trackingVerification.serdendipVerified, true)
  assert.equal(commonBarcodeResponse.shipment.labelStatus, 'READY')
  assert.equal(commonBarcodeResponse.suratCreateLog.KargoTakipNo, '25220148446193')
  assert.equal(commonBarcodeResponse.suratCreateLog.Barcode, '01231201025')
  assert.equal(
    commonBarcodeResponse.suratCreateLog.trackingVerification.serdendipVerified,
    true,
  )
  assert.equal(commonBarcodeResponse.suratCreateLog.verifiedShipment, true)
  assert.equal(commonBarcodeResponse.suratCreateLog.hasTrackingNumber, true)
  assert.equal(commonBarcodeResponse.suratCreateLog.hasBarcode, true)
  const commonBarcodeFlowRequests = requests.slice(
    commonBarcodeFlowRequestStart,
  )
  const dispatchRegistrationIndex = commonBarcodeFlowRequests.findIndex(
    (item) => item.path === '/api/GonderiyiKargoyaGonder',
  )
  const commonLabelIndex = commonBarcodeFlowRequests.findIndex((item) =>
    item.soapAction.includes('OrtakBarkodOlustur'),
  )
  assert.ok(dispatchRegistrationIndex >= 0)
  assert.ok(commonLabelIndex >= 0)
  assert.ok(dispatchRegistrationIndex < commonLabelIndex)
  assert.equal(
    commonBarcodeResponse.suratCreateLog.rawRequestContainsExpectedOperation,
    true,
  )
  assert.equal(
    commonBarcodeResponse.suratCreateLog.rawRequestContainsLegacyOperation,
    false,
  )
  assert.equal(commonBarcodeResponse.suratCreateLog.wrongServiceCalled, false)
  const commonBarcodeConfigWithTrendyol = {
    ...commonBarcodeConfig,
    trendyol: {
      sellerId: '12345',
      apiKey: 'TY_KEY',
      apiSecret: 'TY_SECRET',
      environment: 'prod',
      userAgentName: 'CargoFlowTest',
    },
  }
  const suratCallsBeforePickingFlow = requests.filter(
    (item) => item.soapAction.includes('OrtakBarkodOlustur'),
  ).length
  const createdToPickingResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: commonBarcodeConfigWithTrendyol,
      order: {
        ...order,
        id: 'order-created-to-picking',
        orderNumber: 'ORDER-PICKING',
        packageId: 'CREATEDPICKING',
        shipmentPackageId: 'CREATEDPICKING',
        cargoTrackingNumber: '7270031111111111',
        marketplaceStatus: 'Created',
        packageStatus: 'Created',
        rawPackage: {
          lines: [{ id: 987654, quantity: 2 }],
        },
      },
    },
  )
  assert.equal(createdToPickingResponse.ok, true)
  assert.equal(
    createdToPickingResponse.shipment.trendyolPreflight.pickingUpdatePerformed,
    true,
  )
  assert.equal(
    createdToPickingResponse.shipment.trendyolPreflight.requiresPickingUpdate,
    false,
  )
  assert.equal(createdToPickingResponse.shipment.verifiedShipment, true)
  const pickingRequest = requests.find(
    (item) =>
      item.method === 'PUT' &&
      item.path ===
        '/integration/order/sellers/12345/shipment-packages/CREATEDPICKING',
  )
  assert.ok(pickingRequest)
  const pickingRequestBody = JSON.parse(pickingRequest.body)
  assert.equal(pickingRequestBody.status, 'Picking')
  assert.deepEqual(pickingRequestBody.lines, [
    { lineId: '987654', quantity: 2 },
  ])
  const firstNewSuratCallIndex = requests.findIndex(
    (item, index) =>
      index > requests.indexOf(pickingRequest) &&
      item.soapAction.includes('OrtakBarkodOlustur') &&
      item.body.includes('7270031111111111'),
  )
  assert.ok(firstNewSuratCallIndex > requests.indexOf(pickingRequest))
  assert.equal(
    requests.filter((item) => item.soapAction.includes('OrtakBarkodOlustur'))
      .length,
    suratCallsBeforePickingFlow + 1,
  )

  const suratCallsBeforeFailedPicking = requests.filter(
    (item) => item.soapAction.includes('OrtakBarkodOlustur'),
  ).length
  const failedPickingResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: commonBarcodeConfigWithTrendyol,
      order: {
        ...order,
        id: 'order-failed-picking',
        orderNumber: 'ORDER-FAILPICKING',
        packageId: 'FAILPICKING',
        shipmentPackageId: 'FAILPICKING',
        cargoTrackingNumber: '7270032222222222',
        marketplaceStatus: 'Created',
        packageStatus: 'Created',
        rawPackage: {
          lines: [{ id: 444555, quantity: 1 }],
        },
      },
    },
  )
  assert.equal(failedPickingResponse.ok, false)
  assert.equal(
    failedPickingResponse.shipment.errorCategory,
    'TRENDYOL_PICKING_UPDATE_FAILED',
  )
  assert.equal(
    failedPickingResponse.shipment.dispatchRegistrationConfirmed,
    false,
  )
  assert.match(failedPickingResponse.message, /işleme alınamadı/i)
  assert.equal(
    requests.filter((item) => item.soapAction.includes('OrtakBarkodOlustur'))
      .length,
    suratCallsBeforeFailedPicking,
  )

  const resolvedByKargoBarkoduResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: commonBarcodeConfig,
      order: {
        ...order,
        id: 'order-kargo-barkodu',
        orderNumber: '11360466937',
        packageId: 'KARGOBARKODU',
        shipmentPackageId: 'KARGOBARKODU',
        cargoTrackingNumber: '7270039999999999',
      },
    },
  )
  assert.equal(resolvedByKargoBarkoduResponse.ok, true)
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.operationalBarcodeVerified,
    true,
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.verificationStage,
    'serdendip_verified',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.trackingNumber,
    '25220148446193',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.tNo,
    '25220148446193',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.barcode,
    '01231201025',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.barcodeSource,
    'surat.KargoTakipHareketDetayi.BarkodNo',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.trackingSource,
    'surat.KargoTakipHareketDetayi.KargoTakipNo',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.lifecycleStatus,
    'LABEL_READY',
  )
  assert.equal(resolvedByKargoBarkoduResponse.shipment.printEnabled, true)
  assert.equal(
    resolvedByKargoBarkoduResponse.trackingVerification.serdendipVerified,
    true,
  )
  const kargoBarkoduSoap = requests.find((item) =>
    item.soapAction.includes('/KargoBarkodu"'),
  )
  assert.equal(kargoBarkoduSoap, undefined)
  const webOnlyResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: commonBarcodeConfig,
      order: {
        ...order,
        id: 'order-web-only',
        orderNumber: 'WEBONLY-ORDER',
        packageId: 'WEBONLY',
        shipmentPackageId: 'WEBONLY',
        cargoTrackingNumber: 'WEBONLY-CARGO',
      },
    },
  )
  assert.equal(webOnlyResponse.ok, false)
  assert.equal(webOnlyResponse.shipment.technicalZplReceived, true)
  assert.equal(webOnlyResponse.shipment.operationalBarcodeVerified, false)
  assert.equal(webOnlyResponse.shipment.verifiedShipment, false)
  assert.equal(
    webOnlyResponse.shipment.lifecycleStatus,
    'SURAT_TRACKING_MISSING',
  )
  assert.equal(webOnlyResponse.shipment.labelStatus, 'BLOCKED')
  assert.equal(webOnlyResponse.shipment.printEnabled, false)
  assert.equal(webOnlyResponse.shipment.finalSuratBarcode, '')
  assert.equal(webOnlyResponse.shipment.barcode, '')
  assert.equal(webOnlyResponse.shipment.barkodNo, '')
  assert.equal(
    webOnlyResponse.shipment.internalWebBarcode,
    'WebWEBONLY',
  )
  assert.equal(
    webOnlyResponse.shipment.zplAnalysis.acceptedFinalBarcode,
    'WebWEBONLY',
  )
  assert.equal(webOnlyResponse.trackingVerification.serdendipVerified, false)
  assert.equal(
    commonBarcodeResponse.shipment.lifecycleStatus,
    'LABEL_READY',
  )

  const actualCommonBarcodeSoap = requests
    .filter((item) => item.soapAction.includes('OrtakBarkodOlustur'))
    .at(-1)
  assert.ok(actualCommonBarcodeSoap)
  assert.match(actualCommonBarcodeSoap.body, /<BirimDesi>2<\/BirimDesi>/)
  assert.match(actualCommonBarcodeSoap.body, /<BirimKg>2<\/BirimKg>/)
  assert.match(actualCommonBarcodeSoap.body, /<ReferansNo>WEBONLY-CARGO<\/ReferansNo>/)
  assert.match(actualCommonBarcodeSoap.body, /<WebSiparisKodu>WEBONLY-ORDER<\/WebSiparisKodu>/)
  assert.match(actualCommonBarcodeSoap.body, /<SatisKodu>WEBONLY-ORDER<\/SatisKodu>/)
  assert.match(actualCommonBarcodeSoap.body, /<OzelKargoTakipNo>WEBONLY-CARGO<\/OzelKargoTakipNo>/)
  assert.match(actualCommonBarcodeSoap.body, /<MarketplaceIntegrationCode>WEBONLY-CARGO<\/MarketplaceIntegrationCode>/)
  assert.match(actualCommonBarcodeSoap.body, /<KisiKurum>/)
  assert.match(actualCommonBarcodeSoap.body, /<AliciAdresi>Test adresi<\/AliciAdresi>/)
  assert.match(actualCommonBarcodeSoap.body, /2x/)

  const requestedMappingOrder = {
    ...order,
    orderNumber: '11357347675',
    packageId: '3952033136',
    shipmentPackageId: '3952033136',
    cargoTrackingNumber: '7270033753100082',
    address:
      'Dumlupınar mahallesi Selçuklu Konya Selçuklu Konya Dumlupınar mahallesi',
    shipmentAddress: {
      fullAddress: 'Dumlupınar mahallesi Selçuklu Konya',
      address1: 'Dumlupınar mahallesi',
      district: 'Selçuklu',
      city: 'Konya',
    },
  }
  const requestedMappingResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: commonBarcodeConfig, order: requestedMappingOrder },
  )
  assert.equal(requestedMappingResponse.ok, true)
  const requestedRestRequest = requests.find(
    (item) =>
      item.soapAction.includes('OrtakBarkodOlustur') &&
      item.body.includes('7270033753100082'),
  )
  assert.ok(requestedRestRequest)
  const requestedXmlField = (field) =>
    requestedRestRequest.body.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`))?.[1] ?? ''
  const requestedRestBody = {
    Gonderi: {
      ReferansNo: requestedXmlField('ReferansNo'),
      WebSiparisKodu: requestedXmlField('WebSiparisKodu'),
      SatisKodu: requestedXmlField('SatisKodu'),
      OzelKargoTakipNo: requestedXmlField('OzelKargoTakipNo'),
      MarketplaceIntegrationCode: requestedXmlField('MarketplaceIntegrationCode'),
      AliciAdresi: requestedXmlField('AliciAdresi'),
    },
  }
  assert.equal(requestedRestBody.Gonderi.ReferansNo, '7270033753100082')
  assert.equal(requestedRestBody.Gonderi.WebSiparisKodu, '11357347675')
  assert.equal(requestedRestBody.Gonderi.SatisKodu, '11357347675')
  assert.equal(
    requestedRestBody.Gonderi.OzelKargoTakipNo,
    '7270033753100082',
  )
  assert.equal(
    requestedRestBody.Gonderi.MarketplaceIntegrationCode,
    '7270033753100082',
  )
  assert.equal(
    requestedRestBody.Gonderi.AliciAdresi,
    'Dumlupınar mahallesi Selçuklu Konya',
  )
  assert.equal(
    requestedMappingResponse.requestFieldMapping.WebSiparisKodu,
    '11357347675',
  )
  assert.equal(
    requestedMappingResponse.requestFieldMapping.ReferansNo,
    '7270033753100082',
  )
  assert.equal(
    requestedMappingResponse.requestFieldMapping.MarketplaceIntegrationCode,
    '7270033753100082',
  )

  const commonBarcodeCallsBeforeStatusRejected = requests.filter((item) =>
    item.path === '/api/GonderiyiKargoyaGonder',
  ).length
  const statusRejectedResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: legacyConfig,
      order: {
        ...order,
        id: 'order-status-1002',
        orderNumber: '11358508699',
        packageId: 'STATUS1002',
        shipmentPackageId: 'STATUS1002',
        cargoTrackingNumber: '7270033764185795',
        marketplaceStatus: 'Picking',
        packageStatus: 'Picking',
        cargoProviderName: 'Sürat Kargo Marketplace',
      },
    },
  )
  assert.equal(statusRejectedResponse.ok, false)
  assert.equal(statusRejectedResponse.errorCode, '1002')
  assert.equal(
    statusRejectedResponse.shipment.errorCategory,
    'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  )
  assert.equal(
    statusRejectedResponse.shipment.verificationStage,
    'dispatch_rejected',
  )
  assert.equal(
    statusRejectedResponse.shipment.dispatchRegistrationConfirmed,
    false,
  )
  assert.equal(
    statusRejectedResponse.shipment.lifecycleStatus,
    'SURAT_DISPATCH_REJECTED',
  )
  assert.equal(statusRejectedResponse.shipment.zplReady, false)
  assert.equal(statusRejectedResponse.shipment.printEnabled, false)
  assert.equal(statusRejectedResponse.shipment.barcodeRaw, '')
  assert.equal(
    statusRejectedResponse.shipment.statusComputedFrom,
    'SURAT_REJECTED',
  )
  assert.equal(
    statusRejectedResponse.shipment.newStatus,
    'SURAT_DISPATCH_REJECTED',
  )
  assert.equal(statusRejectedResponse.shipment.tabBucket, 'DURUM_UYGUN_DEGIL')
  assert.equal(statusRejectedResponse.suratCreateLog.requestValidation.ok, true)
  assert.equal(
    statusRejectedResponse.suratCreateLog.errorCategory,
    'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  )
  assert.equal(
    statusRejectedResponse.suratCreateLog.verificationStage,
    'dispatch_rejected',
  )
  assert.equal(
    statusRejectedResponse.requestFieldMapping.MarketplaceIntegrationCode,
    '7270033764185795',
  )
  assert.equal(statusRejectedResponse.rejectionDiagnosis.suratResponse, 'REJECTED')
  assert.match(
    statusRejectedResponse.message,
    /statüsünde gönderi oluşturulmasına izin vermiyor/i,
  )
  assert.equal(
    requests.filter((item) =>
      item.path === '/api/GonderiyiKargoyaGonder',
    ).length,
    commonBarcodeCallsBeforeStatusRejected + 1,
  )

  const commonBarcodeCallsBeforeRegistrationFailure = requests.filter(
    (item) => item.path === '/api/GonderiyiKargoyaGonder',
  ).length
  const failedRegistrationResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: legacyConfig,
      order: { ...order, cargoTrackingNumber: 'FAILREGISTER' },
    },
  )
  assert.equal(failedRegistrationResponse.ok, false)
  assert.match(
    failedRegistrationResponse.message,
    /geçerli takip\/barkod kodu alınamadı/i,
  )
  assert.equal(failedRegistrationResponse.responseStatus, 500)
  assert.equal(
    requests.filter((item) =>
      item.path === '/api/GonderiyiKargoyaGonder',
    ).length,
    commonBarcodeCallsBeforeRegistrationFailure + 1,
  )

  const failedBarcodeResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: commonBarcodeConfig,
      order: { ...order, cargoTrackingNumber: 'FAILBARCODE' },
    },
  )
  assert.equal(failedBarcodeResponse.ok, false)
  assert.equal(
    failedBarcodeResponse.shipment.lifecycleStatus,
    'SURAT_BARCODE_FAILED',
  )
  assert.equal(failedBarcodeResponse.shipment.labelStatus, 'BLOCKED')
  assert.equal(failedBarcodeResponse.shipment.verifiedShipment, false)
  assert.equal(failedBarcodeResponse.shipment.trackingNumber, '')
  assert.equal(failedBarcodeResponse.shipment.barcode, '')
  assert.match(
    failedBarcodeResponse.message,
    /geçerli takip\/barkod kodu alınamadı/i,
  )

  const confirmedTracking = await postJson(
    apiPort,
    '/api/shipments/surat/track',
    {
      config: commonBarcodeConfig.surat,
      webSiparisKodu: 'PKG123',
      orderId: order.id,
      shipmentId: 'shipment-common',
    },
  )
  assert.equal(confirmedTracking.ok, true)
  assert.equal(confirmedTracking.trackingState, 'TRACKING_CONFIRMED')
  assert.equal(confirmedTracking.gonderilerLength, 1)
  assert.equal(confirmedTracking.tracking.KargoTakipNo, '25220148446193')
  assert.equal(confirmedTracking.tracking.BarkodNo, '01231201025')
  assert.equal(confirmedTracking.tracking.KargonunDurumuSayi, '6')
  assert.equal(confirmedTracking.carrierStatus.key, 'DELIVERED')
  assert.equal(confirmedTracking.carrierStatus.label, 'Teslim Edildi')
  assert.equal(
    confirmedTracking.carrierStatus.operationStatus,
    'DELIVERED',
  )
  assert.equal(
    confirmedTracking.suratTrackingLog.KargonunBulunduguYer,
    'Kadıköy Teslimat Şubesi',
  )
  assert.equal(
    confirmedTracking.suratTrackingLog.SonHareketTarihi,
    '2026-06-19T12:30:00',
  )
})

function buildConfig(overrides) {
  return {
    surat: {
      kullaniciAdi: 'TEST_CARI',
      sifre: 'TEST_SIFRE',
      firmaId: '',
      entegrasyonSozlesme: '12345',
      ortam: 'test',
      trackingServiceType: 'KargoTakipHareketDetayiSoap',
      trackingPath: '/api/KargoTakipHareketDetayi',
      trackingVerificationDelaysMs: [0],
      ...overrides,
    },
  }
}

function buildOrder() {
  return {
    id: 'order-1',
    orderNumber: 'ORDER123',
    packageId: 'PKG123',
    cargoTrackingNumber: '7270033563324593',
    customerName: 'Test Alıcı',
    customerPhone: '5550000000',
    customerEmail: 'test@example.com',
    address: 'Test adresi Test adresi',
    shipmentAddress: {
      fullAddress: 'Test adresi',
      address1: 'Test adresi',
      district: 'Kadıköy',
      city: 'İstanbul',
    },
    city: 'İstanbul',
    district: 'Kadıköy',
    desi: 2,
    desiSource: 'manual',
    weightKg: 2,
    items: [
      { productName: 'Ürün A', color: 'Siyah', size: 'M', quantity: 2 },
      { productName: 'Ürün B', quantity: 1 },
    ],
  }
}

function sendSoapString(response, operation, result) {
  sendSoapComplex(response, operation, escapeXml(result))
}

function sendSoapComplex(response, operation, resultXml) {
  response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
  response.end(`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation}Response xmlns="http://tempuri.org/">
      <${operation}Result>${resultXml}</${operation}Result>
    </${operation}Response>
  </soap:Body>
</soap:Envelope>`)
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      resolve(server.address().port)
    })
  })
}

async function getFreePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

async function waitForHealth(port, child) {
  let lastError
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`CargoFlow API erken kapandı: ${child.exitCode}`)
    }
    try {
      const response = await fetch(`http://${host}:${port}/api/health`)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw lastError ?? new Error('CargoFlow API başlatılamadı')
}

async function postJson(port, path, body) {
  const response = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  assert.equal(response.ok, true, text)
  return JSON.parse(text)
}
