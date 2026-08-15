import assert from 'node:assert/strict'
import test from 'node:test'

// UNITE 3B — ARTIFACT SEMANTIGI + CREDENTIAL PRECEDENCE SOZLESMESI.
//
// Resmi kaynak: api02 /swagger/v2/swagger.json · ResultMesaj
//   BarcodeNo : array<string>   (TIPLI  → barkod NUMARASI)
//   Barcode   : array items:{}  (TIPSIZ → format dokumante EDILMEMIS)
// Bu yuzden format TAHMIN EDILMEZ; yalnizca yapisal kanit kabul edilir.

const ART = await import('./shipments/suratPrintableArtifact.ts')
const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')

const INDEX_SOURCE = await (async () => {
  const { readFile } = await import('node:fs/promises')
  return readFile(new URL('./index.mjs', import.meta.url), 'utf8')
})()

function installFetchSpy(responder) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return responder(calls.length)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const jsonResponse = (body) => ({
  ok: true, status: 200, json: async () => body, text: async () => '',
})

const okBody = (extra = {}) => ({
  isError: false, Message: 'OK', KargoTakipNo: '41176176501029',
  Barcode: ['opaque-vendor-value'], BarcodeNo: ['1234567890'], ...extra,
})

const ZPL = '^XA^FO50,50^A0N,40,40^FDTEST^FS^XZ'

// Tenant config: TUM kumeler ayri deger tasir ki sizinti gorunur olsun.
const fullConfig = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: 'PRIMARY_LIVE_1111',
  liveSifre: 'PRIMARY_LIVE_SECRET',
  sellerPaysKullaniciAdi: 'SELLERPAYS_2222',
  sellerPaysSifre: 'SELLERPAYS_SECRET',
  codKullaniciAdi: 'COD_3333',
  codSifre: 'COD_SECRET',
  // ENV'in EZDIGI taban alanlar.
  kullaniciAdi: 'ENV_POISONED',
  sifre: 'ENV_POISONED_SECRET',
}

const baseOrder = {
  marketplace: 'Trendyol',
  orderNumber: '1141234567',
  packageId: 'PKG-1',
  cargoTrackingNumber: '727TEST123',
  customerName: 'Test Alici',
  address: 'Ornek Mah. 1',
  city: 'Istanbul',
  district: 'Kadikoy',
  customerPhone: '5551112233',
  desi: 2,
  items: [{ productName: 'Urun', quantity: 1 }],
}

async function runCanonical(overrides = {}) {
  return ADAPTER.createCanonicalSuratShipmentForRequest({
    organizationId: overrides.organizationId ?? 'org-A',
    config: overrides.config ?? fullConfig,
    order: { ...baseOrder, ...(overrides.order ?? {}) },
    reference: 'PKG-1',
    cashOnDelivery: overrides.cashOnDelivery === true,
  })
}

// ═══ 1-6. CREDENTIAL PRECEDENCE MATRISI ═══════════════════════════════════

test('3B-1: normal gonderi BIRINCIL canli tenant hesabini kullanir', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical()
    const body = JSON.parse(spy.calls[0].init.body)
    assert.equal(body.KullaniciAdi, 'PRIMARY_LIVE_1111')
    assert.equal(body.Sifre, 'PRIMARY_LIVE_SECRET')
    assert.equal(result.canonicalCreate.billingParty, 'PRIMARY')
  } finally { spy.restore() }
})

test('3B-2: sellerPays NORMAL gonderiyi ELE GECIREMEZ', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical()
    const body = spy.calls[0].init.body
    assert.equal(body.includes('SELLERPAYS_2222'), false)
    assert.equal(body.includes('SELLERPAYS_SECRET'), false)
  } finally { spy.restore() }
})

test('3B-3: COD NORMAL gonderiyi ELE GECIREMEZ', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical()
    const body = spy.calls[0].init.body
    assert.equal(body.includes('COD_3333'), false)
    assert.equal(body.includes('COD_SECRET'), false)
  } finally { spy.restore() }
})

test('3B-4: ACIK gonderici-oder siparisi sellerPays hesabina gider', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical({ order: { payer: 'SELLER' } })
    assert.equal(JSON.parse(spy.calls[0].init.body).KullaniciAdi, 'SELLERPAYS_2222')
    assert.equal(result.canonicalCreate.billingParty, 'SELLER_PAYS')
  } finally { spy.restore() }
})

test('3B-5: kapida odeme siparisi COD hesabina gider', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical({ cashOnDelivery: true })
    assert.equal(JSON.parse(spy.calls[0].init.body).KullaniciAdi, 'COD_3333')
    assert.equal(result.canonicalCreate.billingParty, 'CASH_ON_DELIVERY')
  } finally { spy.restore() }
})

test('3B-6: birincil hesap eksikse sellerPays/COD-a SESSIZ DUSUS YOK', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical({
      config: {
        serviceMode: 'SURAT_CANONICAL_API',
        sellerPaysKullaniciAdi: 'SELLERPAYS_2222',
        sellerPaysSifre: 'SELLERPAYS_SECRET',
        codKullaniciAdi: 'COD_3333',
        codSifre: 'COD_SECRET',
        kullaniciAdi: 'ENV_POISONED',
        sifre: 'ENV_POISONED_SECRET',
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'SURAT_ACCOUNT_NOT_CONFIGURED')
    assert.equal(spy.calls.length, 0, 'tasiyiciya GIDILMEMELI')
  } finally { spy.restore() }
})

test('3B-7: tenant izolasyonu — capraz hesap YOK', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical({ organizationId: 'org-A' })
    await runCanonical({
      organizationId: 'org-B',
      config: {
        serviceMode: 'SURAT_CANONICAL_API',
        liveKullaniciAdi: 'PRIMARY_B_9999', liveSifre: 'PRIMARY_B_SECRET',
      },
    })
    assert.equal(JSON.parse(spy.calls[0].init.body).KullaniciAdi, 'PRIMARY_LIVE_1111')
    assert.equal(JSON.parse(spy.calls[1].init.body).KullaniciAdi, 'PRIMARY_B_9999')
    assert.equal(spy.calls[1].init.body.includes('PRIMARY_LIVE'), false)
  } finally { spy.restore() }
})

test('3B-ENV: kanonik yol ENV taban alanlarini OKUMAZ', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical()
    assert.equal(spy.calls[0].init.body.includes('ENV_POISONED'), false)
  } finally { spy.restore() }
  // Yalnizca env-poisoned taban alan varsa hesap COZULMEZ.
  assert.equal(
    ADAPTER.resolveCanonicalTenantSuratAccount(
      { kullaniciAdi: 'ENV_POISONED', sifre: 'ENV_POISONED_SECRET' }, 'PRIMARY',
    ),
    null,
  )
})

// ═══ 8-9. RESMI SEMA ══════════════════════════════════════════════════════

test('3B-8: Barcode[] eleman tipi TIPSIZ → tahmin YOK', () => {
  // Resmi Swagger `items: {}` verir. Uzun/rastgele string yazdirilabilir
  // KABUL EDILMEZ.
  const long = 'A'.repeat(5000)
  assert.equal(ART.classifySuratVendorArtifact(long).printable, false)
  assert.equal(ART.classifySuratVendorArtifact('opaque-vendor-value').printable, false)
  assert.equal(ART.classifySuratVendorArtifact(12345).printable, false)
  assert.equal(ART.classifySuratVendorArtifact(null).printable, false)
})

test('3B-9: BarcodeNo ASLA yazdirilabilir artifact DEGILDIR', () => {
  // Resmi semada array<string> = barkod NUMARASI.
  const resolution = ART.resolveSuratPrintableArtifact({
    barcode: [], barcodeNo: ['1234567890', '0987654321'],
  })
  assert.equal(resolution.status, 'UNRESOLVED')
  assert.equal(resolution.artifact, null)
  assert.equal(resolution.barcodeNoCount, 2)
})

// ═══ 10-11. FORMAT TESPITI ════════════════════════════════════════════════

test('3B-10: yapisal olarak dogrulanan formatlar kabul edilir', () => {
  assert.equal(ART.classifySuratVendorArtifact(ZPL).format, 'ZPL')
  assert.equal(ART.classifySuratVendorArtifact(ZPL).printable, true)
  // Base64 ZPL: COZULDUKTEN sonra dogrulanir.
  const encoded = Buffer.from(ZPL, 'utf8').toString('base64')
  const b64 = ART.classifySuratVendorArtifact(encoded)
  assert.equal(b64.format, 'ZPL')
  assert.equal(b64.base64Decoded, true)
  // PDF / PNG imzalari.
  assert.equal(
    ART.classifySuratVendorArtifact(
      Buffer.from('%PDF-1.4 test').toString('base64'),
    ).format, 'PDF',
  )
  // EPL2: N ile baslar, P1 ile biter.
  assert.equal(ART.classifySuratVendorArtifact('N\nA50,50,0,3,1,1,N,"X"\nP1').format, 'EPL')
})

test('3B-11: dogrulanamayan base64 yazdirilabilir SAYILMAZ', () => {
  const garbage = Buffer.from('bu bir etiket degildir').toString('base64')
  const classification = ART.classifySuratVendorArtifact(garbage)
  assert.equal(classification.format, 'UNKNOWN')
  assert.equal(classification.printable, false)
  // Cozulmus icerik dogrulanmadan printable olmaz.
  const resolution = ART.resolveSuratPrintableArtifact({ barcode: [garbage] })
  assert.equal(resolution.status, 'UNRESOLVED')
})

// ═══ 12-14. CREATE + ARTIFACT DAVRANISI ═══════════════════════════════════

test('3B-12: SUCCESS + artifact unresolved → ikinci POST 0', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    const result = await runCanonical()
    assert.equal(result.ok, true)
    assert.equal(result.canonicalCreate.carrierCreateStatus, 'SUCCESS')
    assert.equal(result.canonicalCreate.printArtifactStatus, 'UNRESOLVED')
    assert.equal(result.shipment.printReady, false)
    assert.equal(result.shipment.printEnabled, false)
    assert.equal(spy.calls.length, 1)
  } finally { spy.restore() }
})

test('3B-13: gercek ZPL donerse artifact COZULUR ve print-ready olur', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody({ Barcode: [ZPL] })))
  try {
    const result = await runCanonical()
    assert.equal(result.canonicalCreate.printArtifactStatus, 'RESOLVED')
    assert.equal(result.canonicalCreate.artifactDetectedFormat, 'ZPL')
    assert.equal(result.shipment.printReady, true)
    assert.equal(result.shipment.printableFormat, 'ZPL')
    assert.equal(result.shipment.printableArtifact, ZPL)
    assert.equal(spy.calls.length, 1)
  } finally { spy.restore() }
})

test('3B-14: ham vendor cikisi HER durumda korunur', async () => {
  const spy = installFetchSpy(() =>
    jsonResponse(okBody({ Barcode: ['a', 'b'], BarcodeNo: ['N1', 'N2'] })))
  try {
    const result = await runCanonical()
    assert.deepEqual(result.shipment.canonicalVendorBarcode, ['a', 'b'])
    assert.deepEqual(result.shipment.canonicalVendorBarcodeNo, ['N1', 'N2'])
  } finally { spy.restore() }
})

// ═══ 15. IMMUTABLE PERSISTENCE + REPRINT ══════════════════════════════════

test('3B-15: ham artifact mevcut SIFRELI operasyon payloadina yazilir', () => {
  // Yeni tablo/migration YOK: kayit responsePayloadEncrypted'e sifrelenir.
  assert.match(INDEX_SOURCE, /canonicalVendorArtifact: canonical/)
  assert.match(INDEX_SOURCE, /barcodeNo: result\?\.shipment\?\.canonicalVendorBarcodeNo/)
  // Credential ASLA kaydedilmez: yalnizca canonicalVendorArtifact govdesi.
  const start = INDEX_SOURCE.indexOf('canonicalVendorArtifact: canonical')
  const block = INDEX_SOURCE.slice(start, INDEX_SOURCE.indexOf(': undefined,', start))
  assert.ok(block.length > 0)
  for (const secret of [
    'KullaniciAdi', 'Sifre', 'kullaniciAdi', 'sifre', 'rawRequest', 'credential',
  ]) {
    assert.equal(block.includes(secret), false, secret)
  }
})

test('3B-16: kalici kayit tekrari create CAGIRMAZ ve yalan print-ready DEMEZ', () => {
  const replay = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('function buildPersistedSuratCreateResponse'),
    INDEX_SOURCE.indexOf('function buildPersistedSuratCreateResponse') + 3000,
  )
  assert.match(replay, /const canonicalArtifact = record\?\.canonicalVendorArtifact/)
  // Cozulmemis artifact → printEnabled false.
  assert.match(replay, /printEnabled: resolved/)
  assert.match(replay, /carrierCreateCalled: false/)
  // Tekrar yolunda taşıyıcı cagrisi yok.
  assert.equal(replay.includes('createCanonicalSuratShipmentForRequest'), false)
})

// ═══ 17-18. BILLING CONTEXT + FIYAT ═══════════════════════════════════════

test('3B-17: faturalama baglami credential secimine BAGLI DEGIL', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    // Ayni siparis, farkli odeyen taraf → billing context AYNI kalir.
    await runCanonical()
    await runCanonical({ cashOnDelivery: true })
    const [normal, cod] = spy.calls.map((c) => JSON.parse(c.init.body))
    assert.notEqual(normal.KullaniciAdi, cod.KullaniciAdi)
    assert.equal(normal.Gonderi.OzelKargoTakipNo, cod.Gonderi.OzelKargoTakipNo)
    assert.equal(normal.Gonderi.Pazaryerimi, cod.Gonderi.Pazaryerimi)
    assert.equal(normal.Gonderi.EntegrasyonFirmasi, cod.Gonderi.EntegrasyonFirmasi)
  } finally { spy.restore() }
})

test('3B-18: istekte FIYAT alani YOK', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical()
    const gonderi = JSON.parse(spy.calls[0].init.body).Gonderi
    for (const field of [
      'Price', 'Tarife', 'TarifeId', 'Discount', 'ContractPrice',
      'EntegrasyonSozlesme', 'EntegrasyonMusteri', 'WhoPays', 'KimOder',
    ]) {
      assert.equal(field in gonderi, false, field)
    }
  } finally { spy.restore() }
})

// ═══ 19. GOLDEN REQUEST ═══════════════════════════════════════════════════

test('3B-19: kanonik golden request (normal Trendyol gonderisi)', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody()))
  try {
    await runCanonical()
    assert.equal(spy.calls.length, 1)
    assert.equal(
      spy.calls[0].url,
      'https://api02.suratkargo.com.tr/api/OrtakBarkodOlustur',
    )
    assert.equal(spy.calls[0].init.method, 'POST')
    const body = JSON.parse(spy.calls[0].init.body)
    assert.deepEqual(Object.keys(body).sort(), ['Gonderi', 'KullaniciAdi', 'Sifre'])
    assert.equal(body.KullaniciAdi, 'PRIMARY_LIVE_1111')
    assert.equal(body.Sifre, 'PRIMARY_LIVE_SECRET')
    assert.equal(body.Gonderi.OzelKargoTakipNo, '727TEST123')
    assert.strictEqual(body.Gonderi.Pazaryerimi, 1)
    assert.equal(body.Gonderi.EntegrasyonFirmasi, 'Trendyol')
    // sellerPays/COD SIZMAZ.
    assert.equal(spy.calls[0].init.body.includes('SELLERPAYS'), false)
    assert.equal(spy.calls[0].init.body.includes('COD_'), false)
  } finally { spy.restore() }
})

// ═══ 20. GOZLEMLENEBILIRLIK ═══════════════════════════════════════════════

test('3B-20: canary telemetrisi sir icermez, icerik loglamaz', async () => {
  const spy = installFetchSpy(() => jsonResponse(okBody({ Barcode: [ZPL] })))
  try {
    const result = await runCanonical()
    const context = result.canonicalCreate
    assert.equal(context.adapter, 'SURAT_WEB_API')
    assert.equal(context.accountFingerprint, '****1111')
    assert.equal(context.artifactDetectedFormat, 'ZPL')
    assert.equal(context.barcodeCount, 1)
    assert.equal(context.barcodeNoCount, 1)
    assert.equal(typeof context.artifactSha256, 'string')
    const json = JSON.stringify(context)
    // Ne credential ne de etiket ICERIGI telemetride bulunur.
    for (const secret of ['PRIMARY_LIVE_1111', 'PRIMARY_LIVE_SECRET', '^XA', '727TEST123']) {
      assert.equal(json.includes(secret), false, secret)
    }
  } finally { spy.restore() }
})
