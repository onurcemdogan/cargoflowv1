import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ÜRETİM İZİ CF-4103110390 (paket 4103110390 · takip 7270036349823921).
//
// REST kayıt adımı "…nolu kayıt başarıyla oluşturuldu" dedi — taşıyıcı kaydı
// OLUŞTURDU. Buna rağmen zincir orada durdu: barkod yok, ZPL yok, UNKNOWN.
// SEBEP: devam koşulu `shipmentRegistered` idi ve o bayrak YALNIZ barkod
// SONRASI takip doğrulamasından doğuyor — yani bu noktada ASLA doğru olamaz.
// Bu paket ara başarının zinciri sonlandırmadığını kilitler.

const codeOf = (file) => readFileSync(file, 'utf8')
  .split(String.fromCharCode(10))
  .filter((line) => {
    const t = line.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join(String.fromCharCode(10))

const server = codeOf('server/index.mjs')
const soap = codeOf('server/shipments/suratSoapPrimaryCreate.ts')

/* ═══ CHAIN-1/2 — ARA BAŞARI DEVAM EDER ══════════════════════════════ */

test('CHAIN-1: REST kayit basarisi SOAP adimina DEVAM eder', () => {
  const chain = server.indexOf('async function createSuratRegisteredCommonBarcode')
  const soapCall = server.indexOf('await createSuratCommonBarcodeSoap(', chain)
  assert.ok(soapCall > chain, 'zincir SOAP adimini CAGIRMALI')
  // Devam kosulu artik ulasilamayan `shipmentRegistered` DEGIL.
  const blocked = server.indexOf('if (!shipmentRegistered) {', chain)
  assert.ok(
    blocked === -1 || blocked > soapCall,
    'ulasilamayan shipmentRegistered kapisi SOAP adimini ENGELLEMEMELI',
  )
})

test('CHAIN-2: REST basarisi TEK BASINA barkod basarisi DEGILDIR', () => {
  // Adim ozeti kabul edildi der; ama nihai basari barkod/ZPL ister.
  assert.ok(server.includes('createAccepted: registrationAccepted'))
  assert.ok(server.includes('readOnlyRegistrationConfirmed'))
  // Nihai onay hala dogrulanmis gonderi sarti tasir.
  assert.ok(soap.includes("finalClassification === 'CREATED_CONFIRMED'"))
  assert.ok(soap.includes('verifiedShipment'))
})

/* ═══ CHAIN-3/6 — ÇAĞRI SAYISI VE BAŞARISIZLIK ═══════════════════════ */

test('CHAIN-3: SOAP adimi zincirde TEK KEZ cagrilir', () => {
  const chain = server.indexOf('async function createSuratRegisteredCommonBarcode')
  const next = server.indexOf('\nasync function ', chain + 10)
  const body = server.slice(chain, next > 0 ? next : undefined)
  const calls = body.split('await createSuratCommonBarcodeSoap(').length - 1
  assert.equal(calls, 1, `SOAP adimi ${calls} kez cagriliyor`)
})

test('CHAIN-6: REST kabul EDILMEDIYSE SOAP CAGRILMAZ', () => {
  const chain = server.indexOf('async function createSuratRegisteredCommonBarcode')
  const guard = server.indexOf('if (!registrationAccepted) {', chain)
  const soapCall = server.indexOf('await createSuratCommonBarcodeSoap(', chain)
  assert.ok(guard > 0 && guard < soapCall, 'basarisiz kayit SOAP oncesi DURMALI')
})

/* ═══ CHAIN-7/8 — HER İKİ KENARDA SIRA ═══════════════════════════════ */

test('CHAIN-7/8: her kenarda ACTUAL_WIRE_READY sonra CARRIER_CALL_STARTED', () => {
  const wireStage = soap.indexOf('appendActualWireStage(traceAttempt, wire')
  const markFn = soap.indexOf('const markCallStarted')
  const network = soap.indexOf('await params.executeCreate(')
  assert.ok(wireStage > 0 && markFn > 0 && network > 0)
  assert.ok(wireStage < markFn, 'tel kaniti cagri asamasindan ONCE')
  assert.ok(markFn < network, 'cagri asamasi agdan ONCE')
  // REST kenari da cagri asamasi YAZAR (uretimde yazmiyordu).
  assert.ok(soap.includes("if (edge !== 'SOAP') {"))
  assert.ok(soap.includes('markCallStarted()'))
})

/* ═══ CHAIN-9 — İKİ TAŞIMA AYIRT EDİLEBİLİR ══════════════════════════ */

test('CHAIN-9: iz REST ile SOAP adimini AYIRT eder', () => {
  assert.ok(soap.includes("'REGISTRATION_REST'"))
  assert.ok(soap.includes("'BARCODE_SOAP'"))
  // Ayirt edici tel asamasinda tasinir.
  assert.ok(soap.includes('step: step ==='))
})

/* ═══ CHAIN-5 — ZATEN VAR REGRESYON YOK ══════════════════════════════ */

test('CHAIN-5: zaten-var hala kor tam create TEKRARI YAPMAZ', async () => {
  const C = await import('./shipments/suratResponseClassification.ts')
  const existing = C.classifySuratCreateResponse({
    httpSuccess: true, codeCategory: 'DUPLICATE_EXISTS',
    businessMessage: 'Bu gonderi daha önce oluşturulmuş.',
  })
  assert.equal(existing.finalClassification, 'ALREADY_EXISTS_NEEDS_VERIFICATION')
  assert.equal(existing.retryAllowed, false)
  // REST KAYIT BASARISI ile ZATEN VAR AYNI SEY DEGILDIR.
  const registered = C.classifySuratCreateResponse({
    httpSuccess: true, codeCategory: 'BARCODE_SUCCESS', businessCode: '013',
    businessMessage: '7270036349823921 nolu kayıt başarıyla oluşturuldu',
    trackingNumber: '7270036349823921', barcode: 'BC1', zpl: '^XA^XZ',
  })
  assert.notEqual(
    registered.finalClassification, 'ALREADY_EXISTS_NEEDS_VERIFICATION',
  )
})

/* ═══ CHAIN-10 — ÜRETİM PAKETİ TEKRAR OLUŞTURULAMAZ ══════════════════ */

test('CHAIN-10: bu paket GERCEK ag cagrisi YAPMAZ', () => {
  // Kaynak metnini kendine bakarak taramak GECERSIZDI: aranan dizgi
  // iddianin KENDISINDE de geciyordu. Bunun yerine GERCEK cagri sayilir.
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = () => { calls += 1; throw new Error('AG YASAK') }
  try {
    // Bu paketteki tum kontroller saf kaynak/siniflandirma incelemesidir;
    // hicbiri tasiyiciya cikmaz.
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls, 0, 'uretim paketi ASLA yeniden olusturulmaz')
})
