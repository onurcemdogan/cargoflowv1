import assert from 'node:assert/strict'
import test from 'node:test'

// P5/ARAS-EXPANSION — ARAS TAŞIMA İSTEMCİSİ (transport layer).
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK. Tüm çağrılar enjekte edilen sahte
// `fetchImpl` ile yürür.
assert.notEqual(
  process.env.REAL_CARRIER_NETWORK, '1',
  'REAL_CARRIER_NETWORK=1 ile calistirilamaz',
)

const CLIENT = await import('./carriers/aras/arasClient.ts')
const C = await import('./carriers/aras/arasContract.ts')
const SO = await import('./carriers/aras/arasSetOrder.ts')

const credentials = { userName: 'aras-user', password: 'aras-pass' }

function buildProvenEnvelope() {
  const built = SO.buildArasSetOrder({
    credentials,
    integrationCode: 'ARAS:org:1:CREATE',
    fields: { ReceiverName: 'A B', ReceiverAddress: 'Adres' },
  })
  assert.equal(built.ok, true)
  return SO.buildArasSetOrderEnvelope(built.order)
}

function xmlResponse(status, bodyXml) {
  return async (_url, _init) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyXml,
  })
}

/* ═══ ARC-1: hicbir cagri resolveArasEndpoint disinda bir URL'e gitmez ═══ */

test('ARC-1: SetOrder yalnız resolveArasEndpoint URLine gider', async () => {
  const envelope = buildProvenEnvelope()
  let calledUrl = null
  const fetchImpl = async (url, init) => {
    calledUrl = url
    return {
      ok: true, status: 200,
      text: async () => '<Envelope><ResultCode>0</ResultCode></Envelope>',
    }
  }
  await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(calledUrl, C.ARAS_TEST_ENDPOINT)
})

test('ARC-1b: uretim adresi yapilandirilmadiysa hicbir cagri yapilmaz', async () => {
  const envelope = buildProvenEnvelope()
  let called = false
  const fetchImpl = async () => {
    called = true
    return { ok: true, status: 200, text: async () => '<a/>' }
  }
  const outcome = await CLIENT.callArasSetOrder({
    envelope, environment: 'PRODUCTION', fetchImpl,
  })
  assert.equal(called, false)
  assert.equal(outcome.networkCalled, false)
  assert.equal(outcome.errorCode, 'ARAS_ENDPOINT_UNRESOLVED')
})

/* ═══ ARC-2: zarf byte-for-byte, yeniden kurulmaz ═══════════════════════ */

test('ARC-2: gonderilen govde tam olarak buildArasSetOrderEnvelope ciktisidir', async () => {
  const envelope = buildProvenEnvelope()
  let sentBody = null
  const fetchImpl = async (_url, init) => {
    sentBody = init.body
    return {
      ok: true, status: 200,
      text: async () => '<Envelope><ResultCode>0</ResultCode></Envelope>',
    }
  }
  await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(sentBody, envelope)
})

test('ARC-2b: SOAPAction basligi zarfin operasyon adindan turer', async () => {
  const envelope = buildProvenEnvelope()
  let sentHeaders = null
  const fetchImpl = async (_url, init) => {
    sentHeaders = init.headers
    return {
      ok: true, status: 200,
      text: async () => '<Envelope><ResultCode>0</ResultCode></Envelope>',
    }
  }
  await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(sentHeaders.SOAPAction, 'http://tempuri.org/SetOrder')
})

/* ═══ ARC-3: transport hatalari asla sentetik basari olmaz ══════════════ */

test('ARC-3: SOAP fault basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<soap:Envelope><soap:Body><soap:Fault><faultcode>Server</faultcode>'
      + '<faultstring>err</faultstring></soap:Fault></soap:Body></soap:Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_TRANSPORT_UNKNOWN')
  assert.equal(outcome.raw, null)
})

test('ARC-3b: HTTP 500 basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(500, '<Envelope/>')
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_TRANSPORT_HTTP_ERROR')
})

test('ARC-3c: bicimsiz XML basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(200, 'not xml at all')
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
})

test('ARC-3d: zaman asimi basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = async (_url, init) => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl, timeoutMs: 5 })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_TRANSPORT_TIMEOUT')
})

test('ARC-3e: yanit basliklari doner ama govde HIC BITMEZSE zaman asimi yine devrededir', async () => {
  // Sunucu 200 ile hemen doner ama gövde akışı hiç kapanmaz (asılı kalır).
  // Zamanlayıcı `doFetch` cozulur cozulmez temizlenirse bu okuma SÜRESİZ
  // askıda kalırdı; düzeltmeden sonra abort sinyali `response.text()`i de
  // keser ve sonuç zaman aşımı olarak sınıflanır.
  const envelope = buildProvenEnvelope()
  const fetchImpl = async (_url, init) => ({
    ok: true,
    status: 200,
    text: () =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  })
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl, timeoutMs: 5 })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_TRANSPORT_TIMEOUT')
})

test('ARC-3f: eslesmeyen acilis/kapanis etiketli govde basari SAYILMAZ (ResultCode=0 icerse bile)', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode>0</ResultCode></Foo>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
  assert.equal(outcome.raw, null)
})

test('ARC-3g: kapatilmamis acilis etiketi basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(200, '<Envelope><ResultCode>0</ResultCode>')
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
})

test('ARC-3h: yorum icine gizlenmis ResultCode=0 CIKARILMAZ (dogrulama ve cikarim ayni govde uzerinde calisir)', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><!--<ResultCode>0</ResultCode>--></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ResultCode, undefined)
})

test('ARC-3i: birden fazla kok elemani (self-closing kok + kardes) basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(200, '<Envelope/><ResultCode>0</ResultCode>')
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
  assert.equal(outcome.raw, null)
})

test('ARC-3j: kok elemani kapandiktan sonra govde disi metin basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode>0</ResultCode></Envelope>garbage',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
  assert.equal(outcome.raw, null)
})

test('ARC-3k: CDATA icindeki ResultCode metni SILINMEZ, alan degerine katilir (0<![CDATA[99]]> -> "099")', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode>0<![CDATA[99]]></ResultCode></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ResultCode, '099')
})

test('ARC-3l: CDATA icinde sahte kapanan/acilan etiket karakterleri gercek etiket SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode><![CDATA[<not-a-tag>]]>0</ResultCode></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ResultCode, '<not-a-tag>0')
})

test('ARC-3m: CDATA icine gizlenmis sahte <ResultCode>0</ResultCode> govdesi GERCEK ALAN SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><OtherField><![CDATA[<ResultCode>0</ResultCode>]]></OtherField></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ResultCode, undefined)

  const C_mod = await import('./carriers/aras/arasContract.ts')
  const classified = C_mod.classifyArasSetOrderResult(outcome.raw)
  assert.equal(classified.ok, false)
})

test('ARC-3n: CDATA icine gizlenmis sahte <soap:Fault> govdesi gercek FAULT SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode>0</ResultCode>'
      + '<Note><![CDATA[<soap:Fault><faultcode>x</faultcode></soap:Fault>]]></Note></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ResultCode, '0')
})

test('ARC-3o: CDATA icindeki yorum-benzeri metin ("<!--99-->") GERCEK YORUM SAYILIP SILINMEZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode><![CDATA[0<!--99-->]]></ResultCode></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ResultCode, '0<!--99-->')

  const C_mod = await import('./carriers/aras/arasContract.ts')
  const classified = C_mod.classifyArasSetOrderResult(outcome.raw)
  assert.equal(classified.ok, false)
})

test('ARC-3p: kapanis etiketinde adin ardindan bosluk-disi gereksiz metin (</ResultCode junk>) basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode>0</ResultCode junk></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
  assert.equal(outcome.raw, null)
})

test('ARC-3q: acilis etiketinde adin ardindan gecersiz oznitelik-disi metin (<ResultCode !>) basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode !>0</ResultCode></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
  assert.equal(outcome.raw, null)
})

test('ARC-3r: acilis etiketinde tekrarlanan oznitelik adi (<ResultCode a="1" a="2">) basari SAYILMAZ', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<Envelope><ResultCode a="1" a="2">0</ResultCode></Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_MALFORMED_RESPONSE')
  assert.equal(outcome.raw, null)
})

/* ═══ ARC-4: basarili yanit yalnız KANITLI alanlari cikarir ═════════════ */

test('ARC-4: basarili SetOrder yaniti ResultCode/ResultMessage/InvoiceKey/OrgReceiverCustId cikarir', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<soap:Envelope><soap:Body><SetOrderResponse><SetOrderResult>'
      + '<ResultCode>0</ResultCode><ResultMessage>OK</ResultMessage>'
      + '<InvoiceKey>INV1</InvoiceKey><OrgReceiverCustId>R1</OrgReceiverCustId>'
      + '<UnknownField>should-not-leak</UnknownField>'
      + '</SetOrderResult></SetOrderResponse></soap:Body></soap:Envelope>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ResultCode, '0')
  assert.equal(outcome.raw.ResultMessage, 'OK')
  assert.equal(outcome.raw.InvoiceKey, 'INV1')
  assert.equal(outcome.raw.OrgReceiverCustId, 'R1')
  assert.equal('UnknownField' in outcome.raw, false)

  const C_mod = await import('./carriers/aras/arasContract.ts')
  const classified = C_mod.classifyArasSetOrderResult(outcome.raw)
  assert.equal(classified.ok, true)
})

test('ARC-4b: ResultCode 0 disi basari SAYILMAZ (sinif. degismez)', async () => {
  const envelope = buildProvenEnvelope()
  const fetchImpl = xmlResponse(
    200,
    '<SetOrderResult><ResultCode>99</ResultCode>'
      + '<ResultMessage>Reddedildi</ResultMessage></SetOrderResult>',
  )
  const outcome = await CLIENT.callArasSetOrder({ envelope, fetchImpl })
  assert.equal(outcome.ok, true) // transport basarili tasindi
  const C_mod = await import('./carriers/aras/arasContract.ts')
  const classified = C_mod.classifyArasSetOrderResult(outcome.raw)
  assert.equal(classified.ok, false)
  assert.equal(classified.errorCode, 'ARAS_SET_ORDER_REJECTED')
  assert.equal(classified.resultCode, '99')
})

/* ═══ ARC-5: dogrulama — yalniz GetOrderWithIntegrationCode ═══════════ */

test('ARC-5: GetOrderWithIntegrationCode proven zarf ve SOAPAction ile gider', async () => {
  const VER = await import('./carriers/aras/arasVerification.ts')
  const built = VER.buildArasGetOrderWithIntegrationCodeEnvelope({
    credentials,
    integrationCode: 'ARAS:org:1:CREATE',
  })
  assert.equal(built.ok, true)
  let sentBody = null
  let sentAction = null
  const fetchImpl = async (_url, init) => {
    sentBody = init.body
    sentAction = init.headers.SOAPAction
    return {
      ok: true, status: 200,
      text: async () => '<Envelope><IntegrationCode>ARAS:org:1:CREATE</IntegrationCode></Envelope>',
    }
  }
  const outcome = await CLIENT.callArasVerification({
    credentials,
    integrationCode: 'ARAS:org:1:CREATE',
    fetchImpl,
  })
  assert.equal(outcome.networkCalled, true)
  assert.equal(sentBody, built.envelope)
  assert.equal(sentAction, 'http://tempuri.org/GetOrderWithIntegrationCode')
  assert.match(sentBody, /<userName>aras-user<\/userName>/)
  assert.match(sentBody, /<password>aras-pass<\/password>/)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.IntegrationCode, 'ARAS:org:1:CREATE')
})

/* ═══ ARC-6: GetBarcode — on kosul + zarf kanitsizligi ══════════════════ */

test('ARC-6: registered=false iken GetBarcode agdan HIC CIKMAZ', async () => {
  let called = false
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, text: async () => '' } }
  const outcome = await CLIENT.callArasGetBarcode({
    integrationCode: 'x', registered: false, fetchImpl,
  })
  assert.equal(called, false)
  assert.equal(outcome.errorCode, 'ARAS_LABEL_PRECONDITION_NOT_MET')
})

test('ARC-6b: registered=true iken GetBarcode proven Username/Password zarfini gonderir', async () => {
  const LBL = await import('./carriers/aras/arasLabelArtifact.ts')
  const built = LBL.buildArasGetBarcodeEnvelope({
    credentials,
    integrationCode: 'ARAS:org:1:CREATE',
  })
  assert.equal(built.ok, true)
  let sentBody = null
  const fetchImpl = async (_url, init) => {
    sentBody = init.body
    return {
      ok: true, status: 200,
      text: async () => '<Envelope><ZebraZpl>^XA^XZ</ZebraZpl></Envelope>',
    }
  }
  const outcome = await CLIENT.callArasGetBarcode({
    credentials,
    integrationCode: 'ARAS:org:1:CREATE',
    registered: true,
    fetchImpl,
  })
  assert.equal(outcome.networkCalled, true)
  assert.equal(sentBody, built.envelope)
  assert.match(sentBody, /<Username>aras-user<\/Username>/)
  assert.match(sentBody, /<Password>aras-pass<\/Password>/)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.raw.ZebraZpl, '^XA^XZ')
})

/* ═══ ARC-7: reprint icin ag cagrisi yapan bir disa aktarim YOK ═════════ */

test('ARC-7: istemci modulunde ag tabanli bir reprint fonksiyonu YOK', () => {
  const exportNames = Object.keys(CLIENT)
  const reprintLike = exportNames.filter((name) => /reprint/i.test(name))
  assert.deepEqual(reprintLike, [])
})
