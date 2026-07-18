import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
      authorizationPresent: Boolean(request.headers.authorization),
      authorizationScheme: String(request.headers.authorization ?? '')
        .split(' ')[0]
        .trim(),
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

    if (request.url === '/api/Gonderi/GonderiOlustur') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          ResponseId: '016',
          Message: '[016] Barkod Gonderilmistir',
          KargoTakipNo: '25220148446194',
          BarkodNo: '01231201026',
        }),
      )
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
      if (body.includes('7270039999999911')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            ResponseId: '016',
            Message: '[016] Barkod GÃ¶nderilmiÅŸtir',
            KargoTakipNo: '25220148446193',
            BarkodNo: '01231201025',
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

    if (soapAction.includes('/OrtakBarkodOlustur"')) {
      sendSoapComplex(
        response,
        'OrtakBarkodOlustur',
        `<isError>false</isError>
         <Message>016</Message>
         <KargoTakipNo>25220148446193</KargoTakipNo>
         <Barcode><anyType>^XA ^FO20,20^A0N,30,30^FDT.No: 25220148446193^FS ^FT48,300^BCN,,Y,N ^FD&gt;:01231201025^FS ^XZ</anyType></Barcode>`,
      )
      return
    }

    if (soapAction.includes('/GonderiyiKargoyaGonderYeni"')) {
      sendSoapString(response, 'GonderiyiKargoyaGonderYeni', 'Tamam')
      return
    }

    if (
      soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      )
    ) {
      if (
        body.includes(
          '<OzelKargoTakipNo>7270039999999997</OzelKargoTakipNo>',
        )
      ) {
        sendSoapComplex(
          response,
          'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
          `<isError>false</isError>
           <Message>016</Message>
           <KargoTakipNo>24510610424923</KargoTakipNo>
           <Barcode><anyType>^XA ^FT48,300^BCN,,Y,N ^FD&gt;:01249492893^FS ^XZ</anyType></Barcode>`,
        )
        return
      }
      if (body.includes('<ReferansNo>FAILBARCODE</ReferansNo>')) {
        sendSoapComplex(
          response,
          'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
          `<isError>true</isError>
           <Message>Bilgiler güncellenirken hata oluştu.</Message>
           <KargoTakipNo />`,
        )
        return
      }
      if (body.includes('<ReferansNo>KARGOBARKODU</ReferansNo>')) {
        sendSoapComplex(
          response,
          'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
          `<isError>false</isError>
           <Message>016</Message>
           <KargoTakipNo>25220148446193</KargoTakipNo>
           <Barcode><anyType>^XA ^FO20,20^A0N,30,30^FDT.No: 25220148446193^FS ^FT48,300^BCN,,Y,N ^FD&gt;:01231201025^FS ^XZ</anyType></Barcode>`,
        )
        return
      }
      if (
        body.includes('<ReferansNo>WEBONLY</ReferansNo>') ||
        body.includes('<ReferansNo>WEBONLY-CARGO</ReferansNo>')
      ) {
        sendSoapComplex(
          response,
          'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
          `<isError>false</isError>
           <Message>Teknik ZPL oluşturuldu</Message>
           <Barcode><anyType>^XA ^FT48,300^BCN,,Y,N ^FDWebWEBONLY^FS ^XZ</anyType></Barcode>`,
        )
        return
      }
      sendSoapComplex(
        response,
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
        `<isError>false</isError>
         <Message>Barkod oluşturuldu</Message>
         <KargoTakipNo>25220148446193</KargoTakipNo>
         <TNo>TNO25220148446193</TNo>
         <Barcode><anyType>^XA ^FT48,300^BCN,,Y,N ^FD&gt;:01231201025^FS ^XZ</anyType></Barcode>`,
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

    if (soapAction.includes('/WebSiparisKodu"')) {
      if (body.includes('7270039999999999')) {
        sendSoapComplex(
          response,
          'WebSiparisKodu',
          `<NewDataSet>
             <Table>
               <WebSiparisKodu>7270039999999999</WebSiparisKodu>
               <TakipNo>25220148446193</TakipNo>
               <Barkod>01231201025</Barkod>
               <Durum>Hazirlanıyor</Durum>
             </Table>
           </NewDataSet>`,
        )
        return
      }
      sendSoapComplex(response, 'WebSiparisKodu', '<NewDataSet />')
      return
    }

    if (soapAction.includes('KargoBarkodu')) {
      if (body.includes('7270039999999999')) {
        sendSoapComplex(
          response,
          'KargoBarkodu',
          `<OzelKargoTakipNo>7270039999999999</OzelKargoTakipNo>
           <KargoTakipNo>25220148446193</KargoTakipNo>
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
      if (body.includes('7270039999999912')) {
        sendSoapString(
          response,
          'KargoTakipHareketDetayi',
          JSON.stringify({
            IsError: false,
            errorMessage: '',
            Gonderiler: [
              {
                WebSiparisKodu: '7270039999999912',
                KargoTakipNo: '25220148446194',
                BarkodNo: '01231201026',
                KargonunDurumu: 'Evrak Olusturuldu',
                KargonunDurumuSayi: '1',
              },
            ],
          }),
        )
        return
      }
      if (body.includes('7270039999999999')) {
        sendSoapString(
          response,
          'KargoTakipHareketDetayi',
          JSON.stringify({
            IsError: false,
            errorMessage: '',
            Gonderiler: [
              {
                WebSiparisKodu: '7270039999999999',
                KargoTakipNo: '25220148446193',
                KargonunDurumu: 'Evrak Olusturuldu',
                KargonunDurumuSayi: '1',
              },
            ],
          }),
        )
        return
      }
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
        body.includes('7270039999999998') ||
        body.includes('UNVERIFIEDCODES') ||
        body.includes('ORDER-UNVERIFIED-CODES') ||
        body.includes('7270039999999997') ||
        body.includes('24510610424923') ||
        body.includes('01249492893')
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
      const requestedWebSiparisKodu =
        body.match(/<WebSiparisKodu>([^<]+)<\/WebSiparisKodu>/i)?.[1] ||
        'PKG123'
      sendSoapString(
        response,
        'KargoTakipHareketDetayi',
        JSON.stringify({
          IsError: false,
          errorMessage: '',
          Gonderiler: [
            {
              WebSiparisKodu: requestedWebSiparisKodu,
              SatisKodu: requestedWebSiparisKodu,
              OzelKargoTakipNo: requestedWebSiparisKodu,
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

  for (const [codeIndex, expectedCode] of [
    '013',
    '014',
    '015',
    '016',
    '009',
  ].entries()) {
    const codeOrder =
      codeIndex === 0
        ? order
        : {
            ...order,
            id: `${order.id}-${expectedCode}`,
            orderNumber: `${order.orderNumber}-${expectedCode}`,
            packageId: `${order.packageId}-${expectedCode}`,
            shipmentPackageId: `${order.shipmentPackageId}-${expectedCode}`,
            cargoTrackingNumber: `${order.cargoTrackingNumber}${codeIndex}`,
          }
    const response = await postJson(apiPort, '/api/shipments/surat/create', {
      config: legacyConfig,
      order: codeOrder,
    })
    assert.equal(
      response.ok,
      false,
      JSON.stringify(response),
    )
    assert.equal(response.serviceType, 'GonderiyiKargoyaGonderRestJson')
    assert.equal(response.payloadFormat, 'JSON')
    assert.equal(response.suratCreateLog.responseCode, expectedCode)
    assert.equal(
      response.suratCreateLog.barcodeResponseCodeDetected,
      expectedCode !== '009',
    )
    assert.equal(response.suratCreateLog.hasTrackingNumber, expectedCode !== '009')
    assert.equal(response.suratCreateLog.preRegistrationOnly, true)
    if (expectedCode === '009') {
      assert.equal(response.shipment, undefined)
    } else {
      assert.equal(
        response.shipment.lifecycleStatus,
        codeIndex === 0
          ? 'SURAT_CREATED_NO_TRACKING'
          : 'SHIPMENT_REGISTERED_LABEL_REQUIRED',
      )
      assert.equal(response.shipment.labelStatus, 'BLOCKED')
      assert.equal(response.shipment.printEnabled, false)
    }
    if (codeIndex === 0) {
      assert.equal(
        response.errorCode,
        'SURAT_TRACKING_CONFIRMATION_MISSING',
      )
      assert.equal(
        response.suratCreateLog.codeMapping.trackingValue,
        '25220148446193',
      )
      assert.equal(
        response.suratCreateLog.codeMapping.barcodeValue,
        '01231201025',
      )
    } else if (expectedCode === '009') {
      assert.equal(response.suratCreateLog.codeMapping.trackingValue, '')
      assert.equal(response.suratCreateLog.codeMapping.barcodeValue, '')
    }
    assert.ok(response.message)
  }

  const legacyRequest = requests.find(
    (item) => item.path === '/api/GonderiyiKargoyaGonder',
  )
  const legacyBody = JSON.parse(legacyRequest.body)
  assert.match(legacyRequest.contentType, /application\/json/)
  assert.equal(legacyBody.Gonderi.OzelKargoTakipNo, '7270033563324593')
  assert.equal(legacyBody.Gonderi.ReferansNo, 'PKG123')
  assert.equal('WebSiparisKodu' in legacyBody.Gonderi, false)
  assert.equal('SatisKodu' in legacyBody.Gonderi, false)
  assert.equal('MarketplaceIntegrationCode' in legacyBody.Gonderi, false)
  assert.equal(legacyBody.Gonderi.Pazaryerimi, 1)
  assert.equal(legacyBody.Gonderi.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(legacyBody.Gonderi.Iademi, false)
  // Adet = koli sayısı sözleşmesi: çok ürünlü sipariş TEK koliyle gider;
  // ürün adedi (3) artık Adet'e yazılmaz.
  assert.equal(legacyBody.Gonderi.Adet, 1)

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
    {
      config: missingContractConfig,
      order: {
        ...order,
        id: 'order-missing-contract',
        orderNumber: 'ORDER-MISSING-CONTRACT',
        packageId: 'PACKAGE-MISSING-CONTRACT',
        shipmentPackageId: 'PACKAGE-MISSING-CONTRACT',
        cargoTrackingNumber: '72700335633245939',
      },
    },
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
  const pdfCreateRequests = requests.slice(requestCountBeforePdfBarcode)
  assert.equal(
    pdfCreateRequests.filter((item) =>
      item.soapAction.includes('KargoBarkoduSiparis'),
    ).length,
    1,
  )
  assert.equal(
    pdfCreateRequests.some(
      (item) => item.path === '/api/GonderiyiKargoyaGonder',
    ),
    false,
  )
  assert.equal(
    pdfCreateRequests.some((item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    ),
    false,
  )
  assert.match(pdfSoapRequest.contentType, /text\/xml/)
  assert.match(
    pdfSoapRequest.soapAction,
    /http:\/\/tempuri\.org\/KargoBarkoduSiparis/,
  )
  assert.match(pdfSoapRequest.body, /<KargoBarkoduSiparis xmlns="http:\/\/tempuri\.org\/">/)
  assert.match(pdfSoapRequest.body, /<WebPassword>TEST_WEB_PASSWORD<\/WebPassword>/)
  assert.match(pdfSoapRequest.body, /<ReferansNo>3986108535<\/ReferansNo>/)
  assert.match(pdfSoapRequest.body, /<OzelKargoTakipNo>7270034129020027<\/OzelKargoTakipNo>/)
  assert.match(pdfSoapRequest.body, /<SiparisObjId>0<\/SiparisObjId>/)
  assert.match(
    pdfSoapRequest.body,
    /<EntegrasyonSozlesme>12345<\/EntegrasyonSozlesme>/,
  )
  assert.doesNotMatch(pdfSoapRequest.body, /<EntegrasyonMusteri>/)
  assert.doesNotMatch(
    pdfSoapRequest.body,
    /<WebSiparisKodu>|<SatisKodu>|<MarketplaceIntegrationCode>|<DesiSource>/,
  )
  assert.doesNotMatch(
    pdfSoapRequest.body,
    /<SahisBirim><\/SahisBirim>|<TelefonEv><\/TelefonEv>|<TelefonIs><\/TelefonIs>|<AliciKodu><\/AliciKodu>|<IrsaliyeSeriNo><\/IrsaliyeSeriNo>|<IrsaliyeSiraNo><\/IrsaliyeSiraNo>|<EkHizmetler><\/EkHizmetler>|<TeslimSubeKodu><\/TeslimSubeKodu>/,
  )
  const officialKargoBarkoduSiparisSequence = [
    'GonderiSekli',
    'KisiKurum',
    'AliciAdresi',
    'Il',
    'Ilce',
    'TelefonCep',
    'Email',
    'KargoTuru',
    'Odemetipi',
    'ReferansNo',
    'OzelKargoTakipNo',
    'Adet',
    'BirimDesi',
    'BirimKg',
    'KargoIcerigi',
    'KapidanOdemeTahsilatTipi',
    'KapidanOdemeTutari',
    'SevkAdresiAdi',
    'TeslimSekli',
    'TasimaSekli',
    'VarisSubeObjId',
    'EvrakSiraNo',
    'SiparisObjId',
    'Pazaryerimi',
    'EntegrasyonFirmasi',
    'EntegrasyonSozlesme',
    'Iademi',
    'KWebGonderiGirisiKaynak',
  ]
  let previousKargoBarkoduSiparisFieldIndex = -1
  for (const field of officialKargoBarkoduSiparisSequence) {
    const fieldIndex = pdfSoapRequest.body.indexOf(`<${field}>`)
    assert.ok(
      fieldIndex > previousKargoBarkoduSiparisFieldIndex,
      `${field} KargoBarkoduSiparis WSDL sirasinda olmali`,
    )
    previousKargoBarkoduSiparisFieldIndex = fieldIndex
  }
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

  const officialCommonConfig = buildConfig({
    serviceMode: 'ORTAK_BARKOD_SOAP',
    serviceType: 'OrtakBarkodOlusturSoap',
    createShipmentPath: '/api/OrtakBarkodOlustur',
  })
  const officialCommonRequestStart = requests.length
  const officialCommonResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: officialCommonConfig,
      order: {
        ...order,
        id: 'order-official-common-barcode',
        orderNumber: 'OFFICIAL-COMMON-ORDER',
        packageId: 'OFFICIAL-COMMON-PACKAGE',
        shipmentPackageId: 'OFFICIAL-COMMON-PACKAGE',
        cargoTrackingNumber: '7270039999999911',
      },
    },
  )
  assert.equal(officialCommonResponse.ok, true)
  assert.equal(officialCommonResponse.operationName, 'OrtakBarkodOlustur')
  assert.equal(officialCommonResponse.serviceType, 'OrtakBarkodOlusturSoap')
  assert.equal(
    officialCommonResponse.trackingVerification.responseWebSiparisKodu,
    '7270039999999911',
  )
  assert.equal(
    officialCommonResponse.trackingVerification.trackingReferenceMatchesCreate,
    true,
  )
  const officialCommonRequests = requests.slice(officialCommonRequestStart)
  const officialCommonSoap = officialCommonRequests.find((item) =>
    item.soapAction.includes('/OrtakBarkodOlustur"'),
  )
  assert.ok(officialCommonSoap)
  assert.match(
    officialCommonSoap.soapAction,
    /http:\/\/tempuri\.org\/OrtakBarkodOlustur/,
  )
  assert.match(
    officialCommonSoap.body,
    /<OrtakBarkodOlustur xmlns="http:\/\/tempuri\.org\/">/,
  )
  assert.doesNotMatch(
    officialCommonSoap.body,
    /<WebSiparisKodu>|<SatisKodu>|<MarketplaceIntegrationCode>|<DesiSource>/,
  )
  assert.equal(
    officialCommonRequests.some(
      (item) => item.path === '/api/GonderiyiKargoyaGonder',
    ),
    true,
  )
  assert.equal(
    officialCommonRequests.some((item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    ),
    false,
  )
  assert.equal(
    officialCommonRequests.filter((item) =>
      item.soapAction.includes('/OrtakBarkodOlustur"'),
    ).length,
    1,
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
        serviceMode: 'ORTAK_BARKOD_SOAP',
        serviceType:
          'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
        createShipmentPath:
          '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
        sifre: '',
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
      .shipmentPasswordConfigured,
    false,
  )

  const samePasswordDiagnostic = await postJson(
    apiPort,
    '/api/diagnostics/surat/common-barcode-loop',
    {
      config: buildConfig({
        serviceMode: 'ORTAK_BARKOD_SOAP',
        serviceType:
          'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
        createShipmentPath:
          '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
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
  assert.equal(samePasswordCredentialStep.status, 'PASS')
  assert.equal(
    samePasswordCredentialStep.evidence.webPasswordRequired,
    false,
  )
  assert.equal(samePasswordDiagnostic.canAttemptLiveSuratCall, true)

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

  const duplicateRequestStart = requests.length
  const duplicateResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: legacyConfig, order },
  )
  assert.equal(duplicateResponse.ok, false)
  assert.equal(duplicateResponse.idempotency.carrierCreateCalled, false)
  assert.equal(duplicateResponse.idempotency.createCallCount, 1)
  assert.match(duplicateResponse.message, /create|Ã§aÄŸrÄ±sÄ±|SÃ¼rat/i)
  assert.equal(
    requests.slice(duplicateRequestStart).some((item) =>
      item.soapAction.includes('OrtakBarkodOlustur') ||
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    ),
    false,
  )

  const tamamResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: legacyConfig, order },
  )
  assert.equal(tamamResponse.ok, false)
  assert.equal(tamamResponse.idempotency.carrierCreateCalled, false)
  assert.equal(tamamResponse.idempotency.createCallCount, 1)
  const staleLegacyConfigWithoutServiceMode = buildConfig({
    webPassword: 'TEST_WEB_PASSWORD',
    serviceType: 'GonderiyiKargoyaGonderRestJson',
    createShipmentPath: '/api/GonderiyiKargoyaGonder',
  })
  delete staleLegacyConfigWithoutServiceMode.surat.serviceMode
  const migratedDefaultResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: staleLegacyConfigWithoutServiceMode,
      order: {
        ...order,
        id: 'order-migrated-default',
        orderNumber: 'ORDER-MIGRATED-DEFAULT',
        packageId: 'MIGRATEDDEFAULT',
        shipmentPackageId: 'MIGRATEDDEFAULT',
      },
    },
  )
  assert.equal(migratedDefaultResponse.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(
    migratedDefaultResponse.operationName,
    'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  )
  assert.equal(migratedDefaultResponse.shipment.verifiedShipment, true)

  const transferredTracking = await postJson(
    apiPort,
    '/api/shipments/surat/track',
    {
      config: legacyConfig.surat,
      webSiparisKodu: order.cargoTrackingNumber,
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
  const persistedCreateStore = JSON.parse(
    await readFile(
      join(configDirectory, 'surat-create-operations.json'),
      'utf8',
    ),
  )
  const enrichedCreateRecord = Object.values(
    persistedCreateStore.operations,
  ).find((record) => record.orderId === order.id)
  assert.equal(enrichedCreateRecord.maxCreateCalls, 1)
  assert.equal(
    enrichedCreateRecord.soapAction,
    `http://tempuri.org/${enrichedCreateRecord.operation}`,
  )
  assert.equal(enrichedCreateRecord.requestRoot, enrichedCreateRecord.operation)
  assert.equal(enrichedCreateRecord.ozelKargoTakipNo, '7270033563324593')
  assert.equal(enrichedCreateRecord.referansNo, 'PKG123')
  assert.equal(enrichedCreateRecord.desi, 2)
  assert.equal(enrichedCreateRecord.desiSource, 'MANUAL_USER_CONFIRMED')
  assert.equal(
    enrichedCreateRecord.verificationStatus,
    'VERIFIED',
    JSON.stringify(enrichedCreateRecord),
  )

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
    webPassword: 'TEST_WEB_PASSWORD',
    serviceMode: 'ORTAK_BARKOD_SOAP',
    serviceType:
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    createShipmentPath:
      '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  })
  const v2RequestStart = requests.length
  const v2Response = await postJson(apiPort, '/api/shipments/surat/create', {
    config: buildConfig({
      serviceMode: 'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
      serviceType: 'GonderiOlusturV2',
      createShipmentPath: '/api/Gonderi/GonderiOlustur',
      firmaId: 'TEST_FIRMA',
    }),
    order: {
      ...order,
      id: 'order-v2-request-snapshot',
      orderNumber: 'ORDER-V2-SNAPSHOT',
      packageId: 'V2SNAPSHOT',
      shipmentPackageId: 'V2SNAPSHOT',
      cargoTrackingNumber: '7270039999999912',
      desi: 2.5,
      weightKg: 1.75,
      shipmentAddress: {
        ...order.shipmentAddress,
        cityId: 34,
      },
    },
  })
  assert.equal(v2Response.ok, true, JSON.stringify(v2Response))
  const v2WireRequest = requests
    .slice(v2RequestStart)
    .find((item) => item.path === '/api/Gonderi/GonderiOlustur')
  assert.ok(v2WireRequest)
  const v2WirePayload = JSON.parse(v2WireRequest.body)
  assert.equal(v2WirePayload.Data[0].Desi, 2.5)
  assert.equal(v2WirePayload.Data[0].Kg, 1.75)
  assert.equal(v2WirePayload.Data[0].SatisKodu, '7270039999999912')
  assert.equal(v2WireRequest.authorizationPresent, true)
  assert.equal(v2WireRequest.authorizationScheme, 'Basic')
  assert.deepEqual(v2WirePayload.Data[0].Gonderen, {
    MusteriId: 'TEST_SENDER',
    Adi: 'Test',
    Soyadi: 'Gonderen',
    Telefon: '5551111111',
    Email: 'sender@example.test',
    Adres: 'Test gonderen adresi',
    IlId: 34,
    IlceAdi: 'Kadikoy',
  })
  assert.equal(v2WirePayload.Data[0].Alici.MusteriId, 'test@example.com')
  assert.equal(v2WirePayload.Data[0].Alici.IlId, 34)
  for (const undocumentedField of [
    'WebSiparisKodu',
    'OzelKargoTakipNo',
    'MarketplaceIntegrationCode',
    'ReferansNo',
  ]) {
    assert.equal(
      Object.hasOwn(v2WirePayload.Data[0], undocumentedField),
      false,
      `${undocumentedField} GonderiOlustur v2 PDF modelinde yok`,
    )
  }
  const requestCountBeforeInvalidV2Contract = requests.length
  const invalidV2Contract = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: {
        surat: {
          ...buildConfig({
            serviceMode: 'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
            serviceType: 'GonderiOlusturV2',
            createShipmentPath: '/api/Gonderi/GonderiOlustur',
            firmaId: 'TEST_FIRMA',
          }).surat,
          restBasicUsername: '',
          restBasicPassword: '',
          restSenderMusteriId: '',
          restSenderAdi: '',
          restSenderSoyadi: '',
          restSenderTelefon: '',
          restSenderAdres: '',
          restSenderIlId: 0,
          restSenderIlceAdi: '',
        },
      },
      order: {
        ...order,
        id: 'order-v2-contract-incomplete',
        orderNumber: 'ORDER-V2-CONTRACT-INCOMPLETE',
        packageId: 'V2CONTRACTINCOMPLETE',
        shipmentPackageId: 'V2CONTRACTINCOMPLETE',
        cargoTrackingNumber: '7270039999999913',
        customerPhone: '',
        shipmentAddress: {
          ...order.shipmentAddress,
          cityId: 34,
        },
      },
    },
  )
  assert.equal(invalidV2Contract.ok, false)
  assert.equal(
    invalidV2Contract.errorCode,
    'SURAT_GONDERI_V2_CONTRACT_INCOMPLETE',
  )
  assert.match(invalidV2Contract.message, /Tasiyiciya istek gonderilmedi/i)
  assert.equal(requests.length, requestCountBeforeInvalidV2Contract)
  const requestCountBeforeMissingTracking = requests.length
  const missingCargoTrackingResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: commonBarcodeConfig,
      order: {
        ...order,
        id: 'order-missing-cargo-tracking',
        orderNumber: 'ORDER-MISSING-CARGO-TRACKING',
        packageId: 'MISSINGCARGOTRACKING',
        shipmentPackageId: 'MISSINGCARGOTRACKING',
        cargoTrackingNumber: '',
      },
    },
  )
  assert.equal(missingCargoTrackingResponse.ok, false)
  assert.match(
    missingCargoTrackingResponse.message,
    /Trendyol cargoTrackingNumber bulunamadı/i,
  )
  assert.equal(requests.length, requestCountBeforeMissingTracking)

  const commonBarcodeFlowRequestStart = requests.length
  const directCommonBarcodeOrder = {
    ...order,
    id: 'order-direct-common-barcode',
    orderNumber: 'ORDER-DIRECT-COMMON',
    packageId: 'DIRECTCOMMON',
    shipmentPackageId: 'DIRECTCOMMON',
  }
  const commonBarcodeResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    { config: commonBarcodeConfig, order: directCommonBarcodeOrder },
  )
  assert.equal(commonBarcodeResponse.ok, true)
  assert.equal(
    commonBarcodeResponse.serviceType,
    'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
  )
  assert.equal(commonBarcodeResponse.payloadFormat, 'SOAP/XML')
  assert.equal(commonBarcodeResponse.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(
    commonBarcodeResponse.operationName,
    'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  )
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
    item.soapAction.includes(
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    ),
  )
  assert.equal(dispatchRegistrationIndex, -1)
  assert.ok(commonLabelIndex >= 0)
  assert.equal(
    commonBarcodeFlowRequests.filter((item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    ).length,
    1,
  )
  const officialBarcodeRequest =
    commonBarcodeFlowRequests[commonLabelIndex].body
  assert.match(
    officialBarcodeRequest,
    /<ReferansNo>DIRECTCOMMON<\/ReferansNo>/,
  )
  assert.match(
    officialBarcodeRequest,
    /<OzelKargoTakipNo>7270033563324593<\/OzelKargoTakipNo>/,
  )
  assert.doesNotMatch(officialBarcodeRequest, /<WebSiparisKodu>/)
  assert.doesNotMatch(officialBarcodeRequest, /<SatisKodu>/)
  assert.doesNotMatch(officialBarcodeRequest, /<MarketplaceIntegrationCode>/)
  assert.match(officialBarcodeRequest, /<BirimDesi>2<\/BirimDesi>/)
  assert.match(officialBarcodeRequest, /<BirimKg>2<\/BirimKg>/)
  assert.match(officialBarcodeRequest, /<OdemeTipi>1<\/OdemeTipi>/)
  assert.match(
    officialBarcodeRequest,
    /<KapidanOdemeTahsilatTipi>0<\/KapidanOdemeTahsilatTipi>/,
  )
  assert.doesNotMatch(officialBarcodeRequest, /<KapidanOdemeTutari>/)
  assert.doesNotMatch(officialBarcodeRequest, /<SahisBirim>/)
  assert.doesNotMatch(officialBarcodeRequest, /<TelefonEv>/)
  assert.doesNotMatch(officialBarcodeRequest, /<TelefonIs>/)
  assert.doesNotMatch(officialBarcodeRequest, /<AliciKodu>/)
  assert.doesNotMatch(officialBarcodeRequest, /<IrsaliyeSeriNo>/)
  assert.doesNotMatch(officialBarcodeRequest, /<IrsaliyeSiraNo>/)
  assert.doesNotMatch(officialBarcodeRequest, /<EkHizmetler>/)
  assert.doesNotMatch(officialBarcodeRequest, /<TeslimSubeKodu>/)
  const officialGonderiModelSequence = [
    'KisiKurum',
    'AliciAdresi',
    'Il',
    'Ilce',
    'TelefonCep',
    'Email',
    'KargoTuru',
    'OdemeTipi',
    'ReferansNo',
    'OzelKargoTakipNo',
    'Adet',
    'BirimDesi',
    'BirimKg',
    'KargoIcerigi',
    'KapidanOdemeTahsilatTipi',
    'TasimaSekli',
    'TeslimSekli',
    'SevkAdresi',
    'GonderiSekli',
    'Pazaryerimi',
    'EntegrasyonFirmasi',
    'Iademi',
  ]
  let previousGonderiFieldIndex = -1
  for (const field of officialGonderiModelSequence) {
    const fieldIndex = officialBarcodeRequest.indexOf(`<${field}>`)
    assert.ok(fieldIndex > previousGonderiFieldIndex, `${field} WSDL sırasında olmalı`)
    previousGonderiFieldIndex = fieldIndex
  }
  assert.equal(
    commonBarcodeResponse.suratCreateLog.rawRequestContainsExpectedOperation,
    true,
  )
  assert.equal(
    commonBarcodeResponse.suratCreateLog.rawRequestContainsLegacyOperation,
    false,
  )
  assert.equal(commonBarcodeResponse.suratCreateLog.wrongServiceCalled, false)

  const gonderiYeniRequestStart = requests.length
  const gonderiYeniOrder = {
    ...order,
    id: 'order-gonderi-yeni-soap',
    orderNumber: 'ORDER-GONDERI-YENI',
    packageId: 'PACKAGE-GONDERI-YENI',
    shipmentPackageId: 'PACKAGE-GONDERI-YENI',
    cargoTrackingNumber: '7270039999999999',
  }
  const gonderiYeniResponse = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    {
      config: buildConfig({
        serviceMode: 'GONDERI_YENI_SOAP',
        serviceType: 'GonderiyiKargoyaGonderYeniSoap',
        createShipmentPath: '/api/GonderiyiKargoyaGonderYeni',
      }),
      order: gonderiYeniOrder,
    },
  )
  assert.equal(gonderiYeniResponse.ok, false)
  assert.equal(gonderiYeniResponse.serviceMode, 'GONDERI_YENI_SOAP')
  assert.equal(
    gonderiYeniResponse.serviceType,
    'GonderiyiKargoyaGonderYeniSoap',
  )
  assert.equal(
    gonderiYeniResponse.operationName,
    'GonderiyiKargoyaGonderYeni',
  )
  assert.equal(
    gonderiYeniResponse.shipment.lifecycleStage,
    'SHIPMENT_REGISTERED_LABEL_REQUIRED',
  )
  assert.equal(gonderiYeniResponse.shipment.printEnabled, false)
  assert.deepEqual(gonderiYeniResponse.shipment.lifecycleMilestones, [
    'CREATE_ACCEPTED',
    'SHIPMENT_REGISTERED',
    'TRACKING_ACTIVE',
  ])
  const gonderiYeniRequests = requests.slice(gonderiYeniRequestStart)
  const gonderiYeniSoapRequests = gonderiYeniRequests.filter((item) =>
    item.soapAction.includes('/GonderiyiKargoyaGonderYeni"'),
  )
  assert.equal(gonderiYeniSoapRequests.length, 1)
  assert.match(
    gonderiYeniSoapRequests[0].soapAction,
    /http:\/\/tempuri\.org\/GonderiyiKargoyaGonderYeni/,
  )
  assert.match(
    gonderiYeniSoapRequests[0].body,
    /<GonderiyiKargoyaGonderYeni xmlns="http:\/\/tempuri\.org\/">/,
  )
  assert.match(
    gonderiYeniSoapRequests[0].body,
    /<ReferansNo>PACKAGE-GONDERI-YENI<\/ReferansNo>/,
  )
  assert.match(
    gonderiYeniSoapRequests[0].body,
    /<OzelKargoTakipNo>7270039999999999<\/OzelKargoTakipNo>/,
  )
  assert.doesNotMatch(
    gonderiYeniSoapRequests[0].body,
    /<WebSiparisKodu>|<SatisKodu>|<MarketplaceIntegrationCode>/,
  )

  const registeredLabelRequestStart = requests.length
  const registeredLabelResponse = await postJson(
    apiPort,
    '/api/shipments/surat/label',
    {
      config: buildConfig({
        serviceMode: 'ORTAK_BARKOD_SOAP',
        serviceType: 'OrtakBarkodOlusturSoap',
        createShipmentPath: '/api/OrtakBarkodOlustur',
      }),
      order: gonderiYeniOrder,
    },
  )
  assert.equal(registeredLabelResponse.ok, true)
  assert.equal(registeredLabelResponse.shipment.verifiedShipment, true)
  assert.equal(registeredLabelResponse.shipment.printEnabled, true)
  assert.equal(registeredLabelResponse.shipment.tNo, '25220148446193')
  assert.equal(registeredLabelResponse.shipment.barkodNo, '01231201025')
  assert.equal(registeredLabelResponse.labelIdempotency.labelCallCount, 1)
  assert.equal(
    registeredLabelResponse.labelIdempotency.shipmentCreateCallCount,
    1,
  )
  assert.equal(
    registeredLabelResponse.labelIdempotency.shipmentCreateRepeated,
    false,
  )
  const registeredLabelRequests = requests.slice(registeredLabelRequestStart)
  assert.equal(
    registeredLabelRequests.filter((item) =>
      item.soapAction.includes('/OrtakBarkodOlustur"'),
    ).length,
    1,
  )
  assert.equal(
    registeredLabelRequests.filter((item) =>
      item.soapAction.includes('/GonderiyiKargoyaGonderYeni"'),
    ).length,
    0,
  )
  const duplicateRegisteredLabelResponse = await postJson(
    apiPort,
    '/api/shipments/surat/label',
    {
      config: buildConfig({
        serviceMode: 'ORTAK_BARKOD_SOAP',
        serviceType: 'OrtakBarkodOlusturSoap',
        createShipmentPath: '/api/OrtakBarkodOlustur',
      }),
      order: gonderiYeniOrder,
    },
  )
  assert.equal(duplicateRegisteredLabelResponse.ok, false)
  assert.equal(
    duplicateRegisteredLabelResponse.errorCode,
    'SURAT_LABEL_IDEMPOTENCY_BLOCKED',
  )

  const directCommonIdempotencyStart = requests.length
  const directCommonIdempotencyBody = {
    config: commonBarcodeConfig,
    order: {
      ...order,
      id: 'order-direct-common-idempotency',
      orderNumber: 'ORDER-DIRECT-IDEMPOTENCY',
      packageId: 'DIRECTIDEMPOTENCY',
      shipmentPackageId: 'DIRECTIDEMPOTENCY',
    },
  }
  const [directCommonCreateA, directCommonCreateB] = await Promise.all([
    postJson(apiPort, '/api/shipments/surat/create', directCommonIdempotencyBody),
    postJson(apiPort, '/api/shipments/surat/create', directCommonIdempotencyBody),
  ])
  assert.equal(directCommonCreateA.ok, true)
  assert.equal(directCommonCreateB.ok, true)
  assert.equal(
    requests
      .slice(directCommonIdempotencyStart)
      .filter((item) =>
        item.soapAction.includes(
          'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
        ),
      )
      .length,
    1,
  )
  assert.equal(
    [directCommonCreateA, directCommonCreateB].some(
      (item) => item.idempotency.reusedInFlight === true,
    ),
    true,
  )
  const unverifiedCodesBody = {
    config: commonBarcodeConfig,
    order: {
      ...order,
      id: 'order-unverified-codes',
      orderNumber: 'ORDER-UNVERIFIED-CODES',
      packageId: 'UNVERIFIEDCODES',
      shipmentPackageId: 'UNVERIFIEDCODES',
      cargoTrackingNumber: '7270039999999997',
    },
  }
  const unverifiedCodesFirst = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    unverifiedCodesBody,
  )
  // 17.07.2026 politikası: ilk create yanıtı 016/014 + geçerli ZPL + numeric
  // T.No/barkod içeriyorsa etiket ön-atanmış kodlarla hemen yazdırılabilir;
  // Gonderiler=0 fiziksel kabul öncesi normaldir ve hata sayılmaz.
  assert.equal(unverifiedCodesFirst.ok, true)
  assert.equal(unverifiedCodesFirst.errorCode, undefined)
  assert.equal(
    unverifiedCodesFirst.shipment.lifecycleStatus,
    'LABEL_READY_AWAITING_ACCEPTANCE',
  )
  assert.equal(
    unverifiedCodesFirst.shipment.verificationStage,
    'preassigned_awaiting_acceptance',
  )
  assert.equal(unverifiedCodesFirst.shipment.errorCategory, '')
  assert.equal(unverifiedCodesFirst.shipment.candidateTNo, '24510610424923')
  assert.equal(unverifiedCodesFirst.shipment.candidateBarkodNo, '01249492893')
  assert.equal(unverifiedCodesFirst.shipment.tNo, '24510610424923')
  assert.equal(
    unverifiedCodesFirst.shipment.trackingNumber,
    '24510610424923',
  )
  assert.equal(unverifiedCodesFirst.shipment.kargoTakipNo, '24510610424923')
  assert.equal(unverifiedCodesFirst.shipment.barkodNo, '01249492893')
  assert.equal(unverifiedCodesFirst.shipment.finalSuratBarcode, '01249492893')
  assert.equal(
    unverifiedCodesFirst.shipment.candidateVerificationStatus,
    'PREASSIGNED_AWAITING_ACCEPTANCE',
  )
  assert.equal(unverifiedCodesFirst.shipment.printEnabled, true)
  assert.equal(unverifiedCodesFirst.shipment.labelStatus, 'READY')
  assert.equal(unverifiedCodesFirst.shipment.verifiedShipment, false)
  assert.equal(
    unverifiedCodesFirst.shipment.operationalBarcodeVerified,
    false,
  )
  assert.equal(unverifiedCodesFirst.idempotency.createCallCount, 1)
  const unverifiedTrackingAfterGrace = await postJson(
    apiPort,
    '/api/shipments/surat/track',
    {
      config: {
        ...commonBarcodeConfig.surat,
        labelRegistrationGraceMs: 0,
      },
      orderId: 'order-unverified-codes',
      shipmentId: 'UNVERIFIEDCODES',
      webSiparisKodu: '7270039999999997',
      queryReference: {
        value: '7270039999999997',
        type: 'WEB_SIPARIS_KODU',
        source: 'test.createRequest.OzelKargoTakipNo',
      },
    },
  )
  assert.equal(unverifiedTrackingAfterGrace.gonderilerLength, 0)
  assert.equal(
    unverifiedTrackingAfterGrace.verificationPersistence.verificationStatus,
    'LABEL_CREATED_NOT_REGISTERED',
  )
  assert.equal(
    unverifiedTrackingAfterGrace.verificationPersistence.status,
    'FAILED_SAFE',
  )
  assert.equal(
    unverifiedTrackingAfterGrace.verificationPersistence.carrierTrackingNumber,
    '',
  )
  const requestsBeforeUnverifiedReplay = requests.length
  const unverifiedCodesReplay = await postJson(
    apiPort,
    '/api/shipments/surat/create',
    unverifiedCodesBody,
  )
  assert.equal(unverifiedCodesReplay.ok, false)
  assert.equal(
    unverifiedCodesReplay.errorCode,
    'SURAT_CREATE_IDEMPOTENCY_BLOCKED',
  )
  assert.equal(unverifiedCodesReplay.serviceMode, 'ORTAK_BARKOD_SOAP')
  assert.equal(
    unverifiedCodesReplay.operationName,
    'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  )
  // 17.07.2026 kanıtı: ön-atanmış kodlar tesellümde birebir korunur;
  // kabul bekleyen etiket bu kodlarla yazdırılabilir, create tekrarı yine yasaktır.
  assert.equal(
    unverifiedCodesReplay.shipment.lifecycleStatus,
    'LABEL_READY_AWAITING_ACCEPTANCE',
  )
  assert.equal(
    unverifiedCodesReplay.shipment.candidateVerificationStatus,
    'PREASSIGNED_AWAITING_ACCEPTANCE',
  )
  assert.equal(
    unverifiedCodesReplay.shipment.verificationStage,
    'preassigned_awaiting_acceptance',
  )
  assert.equal(unverifiedCodesReplay.shipment.errorCategory, '')
  assert.equal(
    unverifiedCodesReplay.shipment.suratCreateLog.operationName,
    'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
  )
  assert.equal(unverifiedCodesReplay.idempotency.carrierCreateCalled, false)
  assert.deepEqual(unverifiedCodesReplay.idempotency.candidateIdentifiers, [
    '24510610424923',
    '01249492893',
  ])
  assert.equal(
    unverifiedCodesReplay.shipment.codeCandidates.unverifiedTNoCandidate,
    '24510610424923',
  )
  assert.equal(
    unverifiedCodesReplay.shipment.codeCandidates.unverifiedBarcodeCandidate,
    '01249492893',
  )
  assert.equal(unverifiedCodesReplay.shipment.printEnabled, true)
  assert.equal(unverifiedCodesReplay.shipment.tNo, '24510610424923')
  assert.equal(unverifiedCodesReplay.shipment.barkodNo, '01249492893')
  assert.equal(unverifiedCodesReplay.shipment.verifiedShipment, false)
  assert.equal(requests.length, requestsBeforeUnverifiedReplay)
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
    (item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
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
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ) &&
      item.body.includes('7270031111111111'),
  )
  assert.ok(firstNewSuratCallIndex > requests.indexOf(pickingRequest))
  assert.equal(
    requests.filter((item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    )
      .length,
    suratCallsBeforePickingFlow + 1,
  )

  const suratCallsBeforeFailedPicking = requests.filter(
    (item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
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
    requests.filter((item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    )
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
  assert.equal(
    resolvedByKargoBarkoduResponse.ok,
    true,
    JSON.stringify(resolvedByKargoBarkoduResponse),
  )
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
    'surat.WebSiparisKodu.Barkod',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.shipment.trackingSource,
    'surat.WebSiparisKodu.TakipNo',
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
  assert.equal(
    resolvedByKargoBarkoduResponse.operationalBarcodeResolution.WebSiparisKodu,
    '7270039999999999',
  )
  assert.equal(
    resolvedByKargoBarkoduResponse.operationalBarcodeResolution.referenceMatches,
    true,
  )
  const webSiparisKoduSoap = requests.find(
    (item) =>
      item.soapAction.includes('/WebSiparisKodu"') &&
      item.body.includes('7270039999999999'),
  )
  assert.ok(webSiparisKoduSoap)
  assert.match(
    webSiparisKoduSoap.body,
    /<WebSiparisKodu>7270039999999999<\/WebSiparisKodu>/,
  )
  assert.doesNotMatch(webSiparisKoduSoap.body, /11360466937|KARGOBARKODU/)
  assert.equal(
    requests.some(
      (item) =>
        item.soapAction.includes('/KargoBarkodu"') &&
        item.body.includes('7270039999999999'),
    ),
    false,
  )
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
    .filter((item) =>
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ),
    )
    .at(-1)
  assert.ok(actualCommonBarcodeSoap)
  assert.match(actualCommonBarcodeSoap.body, /<BirimDesi>2<\/BirimDesi>/)
  assert.match(actualCommonBarcodeSoap.body, /<BirimKg>2<\/BirimKg>/)
  assert.match(actualCommonBarcodeSoap.body, /<ReferansNo>WEBONLY<\/ReferansNo>/)
  assert.doesNotMatch(actualCommonBarcodeSoap.body, /<WebSiparisKodu>/)
  assert.doesNotMatch(actualCommonBarcodeSoap.body, /<SatisKodu>/)
  assert.match(actualCommonBarcodeSoap.body, /<OzelKargoTakipNo>WEBONLY-CARGO<\/OzelKargoTakipNo>/)
  assert.doesNotMatch(actualCommonBarcodeSoap.body, /<MarketplaceIntegrationCode>/)
  assert.match(actualCommonBarcodeSoap.body, /<KisiKurum>/)
  assert.match(actualCommonBarcodeSoap.body, /<AliciAdresi>Test adresi<\/AliciAdresi>/)
  assert.match(actualCommonBarcodeSoap.body, /2x/)

  const requestedMappingOrder = {
    ...order,
    id: 'order-requested-mapping',
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
      item.soapAction.includes(
        'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
      ) &&
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
  assert.equal(requestedRestBody.Gonderi.ReferansNo, '3952033136')
  assert.equal(requestedRestBody.Gonderi.WebSiparisKodu, '')
  assert.equal(requestedRestBody.Gonderi.SatisKodu, '')
  assert.equal(
    requestedRestBody.Gonderi.OzelKargoTakipNo,
    '7270033753100082',
  )
  assert.equal(requestedRestBody.Gonderi.MarketplaceIntegrationCode, '')
  assert.equal(
    requestedRestBody.Gonderi.AliciAdresi,
    'Dumlupınar mahallesi Selçuklu Konya',
  )
  assert.equal(
    requestedMappingResponse.requestFieldMapping.WebSiparisKodu,
    '',
  )
  assert.equal(
    requestedMappingResponse.requestFieldMapping.ReferansNo,
    '3952033136',
  )
  assert.equal(
    requestedMappingResponse.requestFieldMapping.MarketplaceIntegrationCode,
    '',
  )
  assert.equal(
    requestedMappingResponse.requestFieldMapping.TrackingWebSiparisKodu,
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
      order: {
        ...order,
        id: 'order-failed-registration',
        orderNumber: 'ORDER-FAILED-REGISTRATION',
        packageId: 'PACKAGE-FAILED-REGISTRATION',
        shipmentPackageId: 'PACKAGE-FAILED-REGISTRATION',
        cargoTrackingNumber: 'FAILREGISTER',
      },
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
      order: {
        ...order,
        id: 'order-failed-common-barcode',
        orderNumber: 'ORDER-FAILED-COMMON-BARCODE',
        packageId: 'FAILBARCODE',
        shipmentPackageId: 'FAILBARCODE',
        cargoTrackingNumber: 'FAILBARCODE',
      },
    },
  )
  assert.equal(failedBarcodeResponse.ok, false)
  assert.equal(failedBarcodeResponse.shipment, undefined)
  assert.match(
    failedBarcodeResponse.message,
    /hata oluştu/i,
  )

  const trackingSoapCallsBeforeInvalid = requests.filter((item) =>
    item.soapAction.includes('KargoTakipHareketDetayi'),
  ).length
  const invalidTNoResponse = await fetch(
    `http://${host}:${apiPort}/api/shipments/surat/track`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: commonBarcodeConfig.surat,
        queryReference: {
          value: '07414623015915',
          type: 'T_NO',
          source: 'negative-control',
        },
      }),
    },
  )
  assert.equal(invalidTNoResponse.status, 400)
  const invalidTNo = await invalidTNoResponse.json()
  assert.equal(invalidTNo.errorCode, 'SURAT_TRACKING_REFERENCE_INVALID')
  assert.equal(invalidTNo.rejectedReferenceType, 'T_NO')

  const invalidLegacyFallbackResponse = await fetch(
    `http://${host}:${apiPort}/api/shipments/surat/track`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: commonBarcodeConfig.surat,
        trackingNumber: '07414623015915',
        shipmentCode: 'PKG123',
      }),
    },
  )
  assert.equal(invalidLegacyFallbackResponse.status, 400)
  assert.equal(
    requests.filter((item) =>
      item.soapAction.includes('KargoTakipHareketDetayi'),
    ).length,
    trackingSoapCallsBeforeInvalid,
  )

  const confirmedTracking = await postJson(
    apiPort,
    '/api/shipments/surat/track',
    {
      config: commonBarcodeConfig.surat,
      webSiparisKodu: 'PKG123',
      queryReference: {
        value: 'PKG123',
        type: 'WEB_SIPARIS_KODU',
        source: 'createRequest.OzelKargoTakipNo',
      },
      webSiparisKoduCandidates: [
        '07414623015915',
        '01231201025',
        'ORDER123',
      ],
      trackingNumber: '07414623015915',
      shipmentCode: 'PKG123-WRONG-FALLBACK',
      orderId: order.id,
      shipmentId: 'shipment-common',
    },
  )
  assert.equal(confirmedTracking.ok, true)
  assert.equal(confirmedTracking.trackingState, 'TRACKING_CONFIRMED')
  assert.equal(confirmedTracking.gonderilerLength, 1)
  assert.equal(confirmedTracking.tracking.KargoTakipNo, '25220148446193')
  assert.equal(confirmedTracking.tracking.BarkodNo, '01231201025')
  assert.equal(confirmedTracking.trackingReferenceType, 'WEB_SIPARIS_KODU')
  assert.equal(
    confirmedTracking.trackingReferenceSource,
    'createRequest.OzelKargoTakipNo',
  )
  assert.equal(confirmedTracking.trackingAttempts.length, 1)
  assert.equal(confirmedTracking.trackingAttempts[0].queryValue, 'PKG123')
  assert.equal(
    confirmedTracking.trackingAttempts[0].queryType,
    'WEB_SIPARIS_KODU',
  )
  const typedTrackingSoap = requests
    .filter((item) => item.soapAction.includes('KargoTakipHareketDetayi'))
    .at(-1)
  assert.match(
    typedTrackingSoap.body,
    /<WebSiparisKodu>PKG123<\/WebSiparisKodu>/,
  )
  assert.doesNotMatch(
    typedTrackingSoap.body,
    /07414623015915|01231201025|ORDER123|PKG123-WRONG-FALLBACK/,
  )
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
      restBasicUsername: 'TEST_BASIC_USER',
      restBasicPassword: 'TEST_BASIC_PASSWORD',
      restSenderMusteriId: 'TEST_SENDER',
      restSenderAdi: 'Test',
      restSenderSoyadi: 'Gonderen',
      restSenderTelefon: '5551111111',
      restSenderEmail: 'sender@example.test',
      restSenderAdres: 'Test gonderen adresi',
      restSenderIlId: 34,
      restSenderIlceAdi: 'Kadikoy',
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
