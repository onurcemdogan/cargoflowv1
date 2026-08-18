import assert from 'node:assert/strict'
import test from 'node:test'

// P5 — ARAS TAŞIYICI SÖZLEŞMESİ.
//
// Fixture'lar YALNIZ resmî genel TEST web servisinin dokümante şekillerinden
// türetildi (customerservicestest.araskargo.com.tr, 2026-08-19).
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK.
assert.notEqual(
  process.env.REAL_CARRIER_NETWORK, '1',
  'REAL_CARRIER_NETWORK=1 ile calistirilamaz',
)

const C = await import('./carriers/aras/arasContract.ts')
const SO = await import('./carriers/aras/arasSetOrder.ts')
const LBL = await import('./carriers/aras/arasLabelArtifact.ts')
const VER = await import('./carriers/aras/arasVerification.ts')
const IDS = await import('./shipments/suratIdempotencySemantics.ts')

const credentials = { userName: 'aras-user', password: 'aras-pass' }

/* ═══ UÇ NOKTA — ÜRETİM TÜRETİLMEZ ══════════════════════════════════ */

test('AR-1: test uc noktasi kanitli sabittir', () => {
  const test1 = C.resolveArasEndpoint({ environment: 'TEST' })
  assert.equal(test1.ok, true)
  assert.equal(
    test1.url,
    'https://customerservicestest.araskargo.com.tr/arascargoservice/arascargoservice.asmx',
  )
})

test('AR-2: uretim adresi TEST adresinden TURETILMEZ', () => {
  const missing = C.resolveArasEndpoint({ environment: 'PRODUCTION' })
  assert.equal(missing.ok, false)
  assert.equal(missing.errorCode, 'ARAS_PRODUCTION_ENDPOINT_UNVERIFIED')
  assert.equal(missing.url, null)
  // Test host'unun hicbir parcasi uretim adresine SIZMAMALI.
  assert.equal(/customerservicestest/.test(String(missing.url)), false)

  const configured = C.resolveArasEndpoint({
    environment: 'PRODUCTION',
    productionUrl: 'https://kurumsal.example.invalid/service.asmx',
  })
  assert.equal(configured.ok, true)
  assert.equal(configured.environment, 'PRODUCTION')
})

/* ═══ SetOrder — ALAN BEYAZ LİSTESİ ═════════════════════════════════ */

test('AR-3: SURAT alanlari Aras istegine SIZAMAZ', () => {
  for (const foreign of [
    'Pazaryerimi', 'EntegrasyonFirmasi', 'OzelKargoTakipNo', 'KimOder',
  ]) {
    const built = SO.buildArasSetOrder({
      credentials,
      integrationCode: 'ARAS:org:1:CREATE',
      fields: { ReceiverName: 'A B', [foreign]: 'X' },
    })
    assert.equal(built.ok, false, foreign)
    assert.equal(built.errorCode, 'ARAS_UNKNOWN_FIELD', foreign)
    assert.match(built.reason, new RegExp(foreign))
  }
})

test('AR-4: sozlesmede OLAN alanlar kabul edilir', () => {
  const built = SO.buildArasSetOrder({
    credentials,
    integrationCode: 'ARAS:org:1:CREATE',
    fields: {
      ReceiverName: 'A B', ReceiverAddress: 'Adres',
      ReceiverCityName: 'İstanbul', ReceiverTownName: 'Kadıköy',
      Weight: 1, PieceCount: 1, Description: 'Test',
    },
  })
  assert.equal(built.ok, true)
  assert.equal(built.order.ReceiverName, 'A B')
  assert.equal(built.order.IntegrationCode, 'ARAS:org:1:CREATE')
})

test('AR-5: IntegrationCode ZORUNLU', () => {
  const built = SO.buildArasSetOrder({ credentials, fields: { ReceiverName: 'A' } })
  assert.equal(built.ok, false)
  assert.equal(built.errorCode, 'ARAS_INTEGRATION_CODE_REQUIRED')
})

test('AR-6: kimlik REDACTED gorunumde maskelenir', () => {
  const built = SO.buildArasSetOrder({
    credentials, integrationCode: 'ARAS:org:1:CREATE',
    fields: { ReceiverName: 'A B' },
  })
  assert.equal(built.ok, true)
  assert.equal(built.redactedOrder.UserName, '***')
  assert.equal(built.redactedOrder.Password, '***')
  assert.equal(
    JSON.stringify(built.redactedOrder).includes('aras-pass'), false,
    'parola denetim gorunumune sizdi',
  )
  // Ham gövde teli besler; orada kimlik BULUNUR (Basic sozlesmesi geregi).
  assert.equal(built.order.Password, 'aras-pass')
})

test('AR-7: eksik kimlik fail-closed', () => {
  const built = SO.buildArasSetOrder({
    credentials: { userName: 'u' }, integrationCode: 'X',
  })
  assert.equal(built.ok, false)
  assert.equal(built.errorCode, 'ARAS_CREDENTIALS_INCOMPLETE')
})

/* ═══ SOAP ZARFI ════════════════════════════════════════════════════ */

test('AR-8: SetOrder zarfi SOAP 1.1 seklindedir ve DETERMINISTIKTIR', () => {
  const built = SO.buildArasSetOrder({
    credentials, integrationCode: 'ARAS:org:1:CREATE',
    fields: { ReceiverName: 'A B', Weight: 2, PieceCount: 1 },
  })
  const envelope = SO.buildArasSetOrderEnvelope(built.order)
  assert.match(envelope, /^<\?xml version="1\.0" encoding="utf-8"\?>/)
  assert.match(envelope, /<soap:Envelope[^>]*schemas\.xmlsoap\.org\/soap\/envelope/)
  assert.match(envelope, /<SetOrder xmlns="http:\/\/tempuri\.org\/">/)
  assert.match(envelope, /<IntegrationCode>ARAS:org:1:CREATE<\/IntegrationCode>/)
  // Ayni girdi AYNI zarfi uretmeli (parmak izi bunun uzerine kurulur).
  assert.equal(envelope, SO.buildArasSetOrderEnvelope(built.order))
})

test('AR-9: zarf XML kacisi uygular', () => {
  const built = SO.buildArasSetOrder({
    credentials, integrationCode: 'X',
    fields: { ReceiverName: 'A & B <test>' },
  })
  const envelope = SO.buildArasSetOrderEnvelope(built.order)
  assert.match(envelope, /A &amp; B &lt;test&gt;/)
  assert.equal(envelope.includes('<test>'), false)
})

/* ═══ IDEMPOTENCY — P3 DESENİ ═══════════════════════════════════════ */

test('AR-10: IntegrationCode ayni siparis icin KARARLI', () => {
  const first = SO.buildArasIntegrationCode({ organizationId: 'org1', orderId: 'O-1' })
  const second = SO.buildArasIntegrationCode({ organizationId: 'org1', orderId: 'O-1' })
  assert.equal(first, second)
  assert.equal(first, 'ARAS:org1:O-1:CREATE')
  // Farkli siparis → farkli kod.
  assert.notEqual(
    first, SO.buildArasIntegrationCode({ organizationId: 'org1', orderId: 'O-2' }),
  )
  // Siparis kimligi yoksa kod URETILMEZ.
  assert.equal(SO.buildArasIntegrationCode({ organizationId: 'org1' }), '')
})

test('AR-11: semantik degisirse NE replay NE create (P3 kurali)', () => {
  // Ayni IntegrationCode, DEGISMIS finansal semantik.
  const comparison = IDS.compareCreateSemantics({
    stored: {
      requestFingerprint: 'aras-fp-1',
      financialFingerprint: { billingParty: 'SENDER_PAYS', codEnabled: false },
    },
    current: {
      requestFingerprint: 'aras-fp-1',
      financialFingerprint: { billingParty: 'RECEIVER_PAYS', codEnabled: false },
    },
  })
  assert.equal(comparison.match, false)
  assert.ok(comparison.changedAxes.includes('billingParty'))

  // Ayni semantik → replay guvenli.
  const same = IDS.compareCreateSemantics({
    stored: { requestFingerprint: 'aras-fp-1' },
    current: { requestFingerprint: 'aras-fp-1' },
  })
  assert.equal(same.match, true)
})

/* ═══ COD — DEĞER TABLOSU DOĞRULANMADI ══════════════════════════════ */

test('AR-12: COD OLMAYAN gonderi tam desteklenir', () => {
  const cod = C.resolveArasCod({ isCod: false })
  assert.equal(cod.ok, true)
  assert.equal(cod.isCod, false)
  const built = SO.buildArasSetOrder({
    credentials, integrationCode: 'X',
    fields: { ReceiverName: 'A' }, cod: { isCod: false },
  })
  assert.equal(built.ok, true)
  assert.equal(built.order.IsCod, 0)
})

test('AR-13: COD gonderi DOGRULANMAMIS deger tablosuyla ACILMAZ', () => {
  const cod = C.resolveArasCod({ isCod: true, codAmount: 250 })
  assert.equal(cod.ok, false)
  assert.equal(cod.errorCode, 'ARAS_COD_VALUE_TABLE_UNVERIFIED')
  assert.equal(cod.codCollectionType.known, false)
  assert.equal(cod.codBillingType.known, false)

  const built = SO.buildArasSetOrder({
    credentials, integrationCode: 'X', fields: { ReceiverName: 'A' },
    cod: { isCod: true, codAmount: 250 },
  })
  assert.equal(built.ok, false, 'COD gonderi uydurma kodla acildi')
  assert.equal(built.errorCode, 'ARAS_COD_VALUE_TABLE_UNVERIFIED')
})

test('AR-14: DOGRULANMIS COD degerleri enjekte edilirse gecer', () => {
  const built = SO.buildArasSetOrder({
    credentials, integrationCode: 'X', fields: { ReceiverName: 'A' },
    cod: {
      isCod: true, codAmount: 250,
      verifiedCollectionType: 1, verifiedBillingType: 2,
    },
  })
  assert.equal(built.ok, true)
  assert.equal(built.order.IsCod, 1)
  assert.equal(built.order.CodAmount, 250)
  assert.equal(built.order.CodCollectionType, 1)
  assert.equal(built.order.CodBillingType, 2)
})

test('AR-15: gecersiz COD tutari REDDEDILIR', () => {
  for (const codAmount of [0, -5, 'abc', null]) {
    const cod = C.resolveArasCod({ isCod: true, codAmount })
    assert.equal(cod.ok, false, String(codAmount))
    assert.equal(cod.errorCode, 'ARAS_COD_AMOUNT_INVALID', String(codAmount))
  }
})

/* ═══ SetOrder SONUCU ═══════════════════════════════════════════════ */

test('AR-16: sonuc kodu/mesaji KORUNUR ve 0 disi basari SAYILMAZ', () => {
  const ok = C.classifyArasSetOrderResult({
    ResultCode: '0', ResultMessage: 'Basarili',
    InvoiceKey: 'INV-1', OrgReceiverCustId: 'CUST-9',
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.invoiceKey, 'INV-1')
  assert.equal(ok.orgReceiverCustId, 'CUST-9')

  const rejected = C.classifyArasSetOrderResult({
    ResultCode: '17', ResultMessage: 'Hata',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.errorCode, 'ARAS_SET_ORDER_REJECTED')
  // Ham kod/mesaj KAYBOLMAZ.
  assert.equal(rejected.resultCode, '17')
  assert.equal(rejected.resultMessage, 'Hata')

  const missing = C.classifyArasSetOrderResult(null)
  assert.equal(missing.ok, false)
  assert.equal(missing.errorCode, 'ARAS_SET_ORDER_RESULT_MISSING')
})

/* ═══ GetBarcode — ARTEFAKTLAR BAĞIMSIZ ═════════════════════════════ */

test('AR-17: ZPL/EPL/IMAGE BAGIMSIZ ayristirilir', () => {
  const all = LBL.resolveArasLabelArtifacts({
    ZebraZpl: '^XA^XZ', ZebraEpl: 'N\nA10,10', Images: ['aW1n'],
    BarcodeModelLst: [{ Barcode: 'B1' }],
  })
  assert.equal(all.ok, true)
  assert.equal(all.artifacts.length, 3)
  assert.equal(all.preferred.type, 'ZPL')
  assert.equal(all.barcodeModels.length, 1)
})

test('AR-18: ZPL YOKSA akis DURMAZ', () => {
  const eplOnly = LBL.resolveArasLabelArtifacts({ ZebraEpl: 'N\nA10,10' })
  assert.equal(eplOnly.ok, true)
  assert.equal(eplOnly.preferred.type, 'EPL')

  const imageOnly = LBL.resolveArasLabelArtifacts({ Images: ['aW1n'] })
  assert.equal(imageOnly.ok, true)
  assert.equal(imageOnly.preferred.type, 'IMAGE')
  assert.equal(imageOnly.preferred.encoding, 'base64')
})

test('AR-19: hicbir artefakt yoksa fail-closed', () => {
  for (const raw of [null, {}, { ZebraZpl: '', ZebraEpl: '', Images: [] }]) {
    const result = LBL.resolveArasLabelArtifacts(raw)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'ARAS_LABEL_ARTIFACT_MISSING')
  }
})

test('AR-20: yeniden baski KAYITLI artefakttan yapilir', () => {
  const stored = { type: 'ZPL', content: '^XA^XZ', encoding: 'text' }
  const reprint = LBL.resolveArasReprintArtifact(stored)
  assert.equal(reprint.ok, true)
  assert.equal(reprint.artifact.content, '^XA^XZ')

  // Kayit yoksa tasiyicidan YENIDEN URETILMEZ; eksiklik bildirilir.
  const missing = LBL.resolveArasReprintArtifact(null)
  assert.equal(missing.ok, false)
  assert.equal(missing.errorCode, 'ARAS_STORED_ARTIFACT_MISSING')
})

/* ═══ DOĞRULAMA DURUM MAKİNESİ ══════════════════════════════════════ */

test('AR-21: kabul edilen create HENUZ kayitli DEGILDIR', () => {
  const state = VER.startArasVerification({
    integrationCode: 'ARAS:org:1:CREATE', setOrderOk: true, resultCode: '0',
  })
  assert.equal(state.state, 'CREATE_SUBMITTED')
  assert.equal(state.registered, false, 'gonderilmis kayit "kayitli" sayildi')
})

test('AR-22: reddedilen create dogrulamaya GIRMEZ', () => {
  const state = VER.startArasVerification({
    integrationCode: 'X', setOrderOk: false, resultCode: '17',
  })
  assert.equal(state.state, 'CREATE_REJECTED')
  assert.equal(state.registered, false)
  // Sonraki sorgu bunu DEGISTIREMEZ.
  const after = VER.applyArasVerificationLookup({
    current: state, lookupOk: true, found: true,
  })
  assert.equal(after.state, 'CREATE_REJECTED')
  assert.equal(after.registered, false)
})

test('AR-23: BILINMIYOR kayitli SAYILMAZ', () => {
  const submitted = VER.startArasVerification({
    integrationCode: 'X', setOrderOk: true, resultCode: '0',
  })
  const unknown = VER.applyArasVerificationLookup({
    current: submitted, lookupOk: false,
  })
  assert.equal(unknown.state, 'VERIFICATION_UNKNOWN')
  assert.equal(unknown.registered, false)

  const pending = VER.applyArasVerificationLookup({
    current: submitted, lookupOk: true, found: false,
  })
  assert.equal(pending.state, 'VERIFICATION_PENDING')
  assert.equal(pending.registered, false)

  const verified = VER.applyArasVerificationLookup({
    current: submitted, lookupOk: true, found: true,
  })
  assert.equal(verified.state, 'VERIFIED_REGISTERED')
  assert.equal(verified.registered, true)
})

test('AR-24: dogrulama TEK korelasyon anahtari kullanir', () => {
  // "Ne olur ne olmaz" diye tum okuma uclarini cagirmak YASAK.
  assert.equal(VER.ARAS_VERIFICATION_OPERATION, 'GetOrderWithIntegrationCode')
})

/* ═══ SAĞLAYICI İZOLASYONU ══════════════════════════════════════════ */

test('AR-25: ARAS kaydi SURAT olarak okunamaz', async () => {
  const provider = await import('./shipments/suratProvider.ts')
  assert.equal(provider.isSuratProviderName('Aras Kargo'), false)
  assert.equal(provider.isSuratProviderName('aras'), false)
  assert.equal(provider.SURAT_PERSISTENCE_PROVIDER, 'surat')
  // Aras kanonik anahtari Surat anahtarindan FARKLIDIR.
  assert.notEqual('aras', provider.SURAT_PERSISTENCE_PROVIDER)
})
