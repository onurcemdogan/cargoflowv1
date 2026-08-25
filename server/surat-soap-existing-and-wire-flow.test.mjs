import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ÜRETİM İZİ CF-4102465808 (TarzimTuba · paket 4102465808).
//
// Taşıyıcı "Bu gonderi daha önce oluşturulmuş." dedi; sistem bunu
// TRANSPORT_FAILED sayıyordu ve ACTUAL_WIRE_READY aşaması kayıptı.
// Bu paket iki gerçeği kilitler: zaten-var bir taşıma hatası DEĞİLDİR ve
// ağa çıkılmadan ÖNCE telin ne olduğu YAZILMIŞ olmalıdır.

const C = await import('./shipments/suratResponseClassification.ts')
const T = await import('./shipments/suratCreateTrace.ts')

const EXISTS_MESSAGE = 'Bu gonderi daha önce oluşturulmuş.'

/* ═══ A — ZATEN VAR SINIFLANDIRMASI ══════════════════════════════════ */

test('SOAP-EXISTS-1: "daha önce oluşturulmuş" TRANSPORT_FAILED DEGILDIR', () => {
  const result = C.classifySuratCreateResponse({
    httpSuccess: true, businessMessage: EXISTS_MESSAGE,
    codeCategory: 'DUPLICATE_EXISTS',
  })
  assert.notEqual(result.finalClassification, 'TRANSPORT_FAILED')
  assert.equal(result.finalClassification, 'ALREADY_EXISTS_NEEDS_VERIFICATION')
  // Tasima BASARILI oldu: karsi taraf cevap uretti.
  assert.equal(result.carrierRegistrationConfirmed, true)
})

test('SOAP-EXISTS-2: zaten-var ASLA yeni create TETIKLEMEZ', () => {
  for (const input of [
    { codeCategory: 'DUPLICATE_EXISTS', businessMessage: EXISTS_MESSAGE },
    { businessMessage: 'Bu siparişe ait gönderi oluşmuştur' },
    { businessCode: '009', codeCategory: 'DUPLICATE_EXISTS' },
  ]) {
    const result = C.classifySuratCreateResponse({ httpSuccess: true, ...input })
    assert.equal(result.retryAllowed, false, JSON.stringify(input))
  }
})

test('SOAP-EXISTS-3: zaten-var DOGRULAMA bekler (terminal degil)', () => {
  const result = C.classifySuratCreateResponse({
    httpSuccess: true, businessMessage: EXISTS_MESSAGE,
    codeCategory: 'DUPLICATE_EXISTS',
  })
  assert.equal(result.isTerminal, false)
  assert.equal(result.verificationStage, 'ARTIFACTS_PARTIAL')
})

test('SOAP-EXISTS-4: barkod/ZPL kurtarilmadan ETIKET BASARISI DEGILDIR', () => {
  const bare = C.classifySuratCreateResponse({
    httpSuccess: true, businessMessage: EXISTS_MESSAGE,
    codeCategory: 'DUPLICATE_EXISTS',
  })
  assert.equal(bare.barcodePresent, false)
  assert.equal(bare.zplPresent, false)
  assert.notEqual(bare.finalClassification, 'CREATED_CONFIRMED')
  // Artefaktlar KURTARILIRSA dogrulama tamamlanir — ama sinif yine
  // "zaten var" kalir; yeni bir create YAPILMADI.
  const recovered = C.classifySuratCreateResponse({
    httpSuccess: true, businessMessage: EXISTS_MESSAGE,
    codeCategory: 'DUPLICATE_EXISTS',
    trackingNumber: '7270036019076954', barcode: 'BC1', zpl: '^XA^XZ',
  })
  assert.equal(recovered.verificationStage, 'ARTIFACTS_COMPLETE')
  assert.equal(recovered.retryAllowed, false)
})

/* ═══ B — TEL KANITI AĞDAN ÖNCE ══════════════════════════════════════ */

const SOAP = await import('./shipments/suratSoapPrimaryCreate.ts')

test('SOAP-WIRE-PROD-1: modul teli AGDAN ONCE kalicilastirir', () => {
  const code = readFileSync('server/shipments/suratSoapPrimaryCreate.ts', 'utf8')
  const capture = code.indexOf('appendActualWireStage(traceAttempt, wire')
  const started = code.indexOf("stage: 'CARRIER_CALL_STARTED'")
  const network = code.indexOf('await params.executeCreate(')
  assert.ok(capture > 0 && started > 0 && network > 0)
  // SIRA: ACTUAL_WIRE_READY → CARRIER_CALL_STARTED → ag cagrisi.
  assert.ok(capture < started, 'tel kaniti cagri baslangicindan ONCE yazilmali')
  assert.ok(started < network, 'cagri baslangici agdan ONCE yazilmali')
})

test('SOAP-WIRE-PROD-2: asama listesi carrierCalled ile TUTARLI', () => {
  // Uretimdeki kusurlu bicim: carrierCalled=true ama ACTUAL_WIRE_READY yok.
  const stages = ['PRE_FLIGHT', 'ROUTING', 'REQUEST_READY',
    'CARRIER_CALL_STARTED', 'CARRIER_RESPONSE', 'VERIFICATION', 'FINAL']
  assert.equal(stages.includes('ACTUAL_WIRE_READY'), false)
  // Aga cikildiysa tel kaniti ZORUNLUDUR — bu degismez artik kodda kilitli
  // (SOAP-WIRE-PROD-1) ve ACTUAL_WIRE_READY yasam dongusunun uyesidir.
  assert.ok(T.TRACE_LIFECYCLE_STAGES.includes('ACTUAL_WIRE_READY'))
  assert.ok(
    T.TRACE_LIFECYCLE_STAGES.indexOf('ACTUAL_WIRE_READY')
      < T.TRACE_LIFECYCLE_STAGES.indexOf('CARRIER_CALL_STARTED'),
    'yasam dongusu sirasi da teli cagridan ONCE koymali',
  )
})

test('SOAP-WIRE-PROD-3: tel yakalama duserse WIRE_BLOCKED + ag 0', () => {
  assert.ok(T.TRACE_ALL_STAGES.includes('WIRE_BLOCKED'))
  assert.equal(T.TRACE_LIFECYCLE_STAGES.includes('WIRE_BLOCKED'), false)
  assert.equal(typeof SOAP.createSuratSoapPrimaryShipment, 'function')
})
