import assert from 'node:assert/strict'
import test from 'node:test'

// FAZ B — YANIT SINIFLANDIRMASI.
// Merkezî iddia: HTTP 200 tek başına "gönderi oluştu" DEMEK DEĞİLDİR.

const C = await import('./shipments/suratResponseClassification.ts')

const classify = (over = {}) => C.classifySuratCreateResponse({
  httpSuccess: true,
  businessCode: '016',
  businessMessage: 'Barkod gönderilmiştir',
  codeCategory: 'BARCODE_SUCCESS',
  trackingNumber: '7270035942963454',
  barcode: 'BC-1',
  zpl: '^XA^XZ',
  ...over,
})

/* ═══ HTTP 200 != BAŞARI ═══════════════════════════════════════════════ */

test('RESP-1: HTTP 200 + is katmani reddi BASARI DEGILDIR', () => {
  const result = classify({ businessCode: '018', codeCategory: 'ERROR',
    businessMessage: 'Sözleşme bulunamadı',
    trackingNumber: '', barcode: '', zpl: '' })
  assert.equal(result.httpSuccess, true)
  assert.equal(result.carrierRegistrationConfirmed, false)
  assert.equal(result.finalClassification, 'REJECTED_BUSINESS_RULE')
  assert.equal(result.isTerminal, true)
  assert.equal(result.retryAllowed, false)
})

test('RESP-2: HTTP 200 ama is kodu YOK → basari VARSAYILMAZ', () => {
  const result = classify({ businessCode: null })
  assert.equal(result.finalClassification, 'UNKNOWN')
  assert.equal(result.carrierRegistrationConfirmed, false)
  assert.equal(result.retryAllowed, false, 'kor tekrar YOK')
})

test('RESP-3: tasima katmani duserse is sonucu BILINMEZ', () => {
  const result = classify({ httpSuccess: false })
  assert.equal(result.finalClassification, 'TRANSPORT_FAILED')
  assert.equal(result.verificationStage, 'NOT_STARTED')
  assert.equal(result.carrierRegistrationConfirmed, false)
})

/* ═══ 016 — ARTEFAKTA GÖRE İKİ AYRI SONUÇ ═════════════════════════════ */

test('RESP-4: 016 + takip + barkod → DOGRULANMIS', () => {
  const result = classify()
  assert.equal(result.finalClassification, 'CREATED_CONFIRMED')
  assert.equal(result.verificationStage, 'ARTIFACTS_COMPLETE')
  assert.equal(result.carrierRegistrationConfirmed, true)
  assert.equal(result.isTerminal, true)
})

test('RESP-5: 016 + barkod ama TAKIP YOK → AYRI sinif', () => {
  const result = classify({ trackingNumber: '' })
  assert.equal(result.finalClassification, 'CREATED_VERIFICATION_INCOMPLETE')
  assert.equal(result.verificationStage, 'ARTIFACTS_PARTIAL')
  // Tam basari SAYILMAZ.
  assert.equal(result.carrierRegistrationConfirmed, false)
  assert.equal(result.isTerminal, false)
})

test('RESP-6: iki 016 vakasi AYNI sinifa DUSMEZ', () => {
  const complete = classify().finalClassification
  const partial = classify({ trackingNumber: '' }).finalClassification
  assert.notEqual(complete, partial, '016 tek basina yeterli DEGIL')
})

/* ═══ 039 — KAYDEDİLDİ / BARKOD ÜRETİLEMEDİ ═══════════════════════════ */

test('RESP-7: 039 explicit SAVED_BARCODE_FAILED', () => {
  const result = classify({
    businessCode: '039', codeCategory: 'PARTIAL',
    businessMessage: 'Sipariş kaydedildi, barkod oluşturulamadı',
    barcode: '', zpl: '',
  })
  assert.equal(result.finalClassification, 'SAVED_BARCODE_FAILED')
  // Kayit OLUSTU — bu yuzden kor tekrar mukerrer gonderi riskidir.
  assert.equal(result.carrierRegistrationConfirmed, true)
  assert.equal(result.retryAllowed, false, '039 KOR RETRY DEGIL')
  // Tam basari da DEGIL.
  assert.notEqual(result.finalClassification, 'CREATED_CONFIRMED')
})

test('RESP-8: 038 denetimli tekrar EDILEBILIR', () => {
  const result = classify({ businessCode: '038', codeCategory: 'RETRY',
    trackingNumber: '', barcode: '', zpl: '' })
  assert.equal(result.finalClassification, 'RETRYABLE_CARRIER_BUSY')
  assert.equal(result.retryAllowed, true)
  assert.equal(result.isTerminal, false)
})

/* ═══ İŞ MESAJI KORUNUR ════════════════════════════════════════════════ */

test('RESP-9: tasiyici is mesaji KAYBOLMAZ', () => {
  const message = 'Sipariş kaydedildi, barkod oluşturulamadı'
  const result = classify({ businessCode: '039', codeCategory: 'PARTIAL',
    businessMessage: message })
  assert.equal(result.businessMessage, message)
  assert.equal(result.businessCode, '039')
})

test('RESP-10: kullanici mesaji KISA ve IZLENEBILIR', () => {
  const result = classify({ businessCode: '039', codeCategory: 'PARTIAL',
    businessMessage: 'Object reference not set to an instance of an object.' })
  const shown = C.buildClassificationUserMessage(result, 'CF-ABC123')
  assert.match(shown, /039/)
  assert.match(shown, /CF-ABC123/)
  // Ham taşıyıcı iç hatası kullanıcıya SIZMAZ.
  assert.equal(shown.includes('Object reference'), false)
  // Ama iz üzerinden erisilebilir KALIR.
  assert.match(result.businessMessage, /Object reference/)
})

test('RESP-11: basarili create mesaji hata gibi gorunmez', () => {
  const shown = C.buildClassificationUserMessage(classify(), 'CF-1')
  assert.match(shown, /oluşturuldu/)
})

/* ═══ SÖZLEŞME BÜTÜNLÜĞÜ ══════════════════════════════════════════════ */

test('RESP-12: her sinif bilinen enum icinde', () => {
  const cases = [
    classify(), classify({ trackingNumber: '' }),
    classify({ businessCode: '039', codeCategory: 'PARTIAL' }),
    classify({ businessCode: '038', codeCategory: 'RETRY' }),
    classify({ businessCode: '018', codeCategory: 'ERROR' }),
    classify({ httpSuccess: false }), classify({ businessCode: null }),
  ]
  for (const result of cases) {
    assert.ok(
      C.FINAL_CLASSIFICATIONS.includes(result.finalClassification),
      result.finalClassification,
    )
    assert.ok(C.VERIFICATION_STAGES.includes(result.verificationStage))
    // Terminal olan ASLA retry edilebilir olamaz.
    assert.equal(result.isTerminal && result.retryAllowed, false)
  }
})
