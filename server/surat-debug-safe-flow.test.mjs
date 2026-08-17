import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// KRİTİK güvenlik regresyonu (area #8): Debug Merkezi'ne ham SOAP isteği (müşteri
// adı/açık adres/telefon/e-posta), ham SOAP yanıtı, tam ZPL veya parola YAZILMAZ.
// Yalnız güvenli metadata (uzunluk/varlık bayrakları + iş sonucu) görünür.

test('suratDebugSafe: ham SOAP/ZPL/PII/parola debug gövdesine sızmaz', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
    // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
    // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
    // "server is being restarted or closed" hatası verir. SSR-only test
    // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
    // tarama tamamen kapatılır.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  const { buildSuratSafeRequestBody, summarizeSuratRawResponse, stripSuratSensitiveFields } =
    await vite.ssrLoadModule('/src/utils/suratDebugSafe.ts')

  // (1) İstek gövdesi: yalnız PII olmayan referanslar; müşteri/adres/parola yok.
  const reqBody = buildSuratSafeRequestBody({
    orderNumber: 'ORD-1',
    packageId: 'PKG-1',
    marketplaceIntegrationCode: '727003123',
    serviceType: 'STANDART',
  })
  const reqText = JSON.stringify(reqBody)
  assert.equal(reqBody.orderNumber, 'ORD-1')
  assert.match(reqText, /gizlendi/, 'ham SOAP gizlendi notu var')
  for (const leak of ['Sifre', 'sifre', 'password', 'AliciAdi', 'AliciAdresi', 'AliciTelefon']) {
    assert.equal(reqText.includes(leak), false, `istek gövdesi ${leak} sızdırmaz`)
  }

  // (2) Yanıt özeti: ham SOAP/ZPL yok; yalnız uzunluk/varlık + iş sonucu.
  const rawSoap =
    '<Sifre>SECRET123</Sifre><AliciAdi>Ada Lovelace</AliciAdi><AliciAdresi>Kadıköy açık adres</AliciAdresi>'
  const summary = summarizeSuratRawResponse(rawSoap, {
    responseStatus: 200,
    isError: false,
    labelCreationOk: true,
    carrierAcceptanceConfirmed: false,
    businessResult: 'LABEL_READY_AWAITING_ACCEPTANCE',
    trackingPresent: true,
    barcodePresent: true,
    zpl: '^XA^FD01252765588^FS^XZ',
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    verificationStage: 'preassigned_awaiting_acceptance',
  })
  const sumText = JSON.stringify(summary)
  assert.equal(summary.responseReceived, true)
  assert.equal(summary.responseLength, rawSoap.length, 'yalnız uzunluk ifşa edilir')
  assert.equal(summary.zplPresent, true)
  assert.ok(summary.zplLength > 0)
  assert.equal(summary.businessResult, 'LABEL_READY_AWAITING_ACCEPTANCE')
  assert.equal(summary.carrierAcceptanceConfirmed, false)
  for (const leak of ['SECRET123', 'Ada Lovelace', 'açık adres', '01252765588', '^XA']) {
    assert.equal(sumText.includes(leak), false, `yanıt özeti ${leak} sızdırmaz`)
  }

  // (3) İç içe alan stripper: BarcodeRaw/rawRequest/PII anahtarları içerik yerine
  // *Present bayrağına indirgenir.
  const stripped = stripSuratSensitiveFields({
    KargoTakipNo: '11820824092123',
    Barcode: '01252765588',
    BarcodeRaw: '^XA^FD01252765588^FS^XZ',
    rawRequest: '<Sifre>SECRET123</Sifre>',
    customerName: 'Ada Lovelace',
    nested: { rawResponse: '<AliciAdresi>gizli</AliciAdresi>', code: 'X' },
  })
  const strippedText = JSON.stringify(stripped)
  assert.equal(stripped.KargoTakipNo, '11820824092123', 'güvenli kod korunur')
  assert.equal(stripped.BarcodeRawPresent, true, 'ZPL varlık bayrağına indirgenir')
  assert.equal(stripped.rawRequestPresent, true)
  assert.equal(stripped.customerNamePresent, true)
  assert.equal(stripped.nested.code, 'X', 'iç içe güvenli alan korunur')
  assert.equal(stripped.nested.rawResponsePresent, true)
  for (const leak of ['SECRET123', 'Ada Lovelace', '^XA', 'gizli']) {
    assert.equal(strippedText.includes(leak), false, `stripper ${leak} sızdırmaz`)
  }
})
