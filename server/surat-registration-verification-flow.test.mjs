import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// KAYIT DOĞRULAMA KAPISI.
//
// Kanıt: docs/surat-service-map.md — 17 Temmuz 2026 canlı ayrım testi.
// Tek başına `OrtakBarkodOlustur` 013 + aday T.No + aday BarkodNo + teknik ZPL
// dondurdu; AYNI OzelKargoTakipNo icin dort salt-okunur sorgu da kayit
// BULAMADI. Yani barkod adimi, tasiyicida KAYIT OLMADAN etiket uretebilir.
// Bu paket, barkodun yalniz salt-okunur teyitten SONRA cagrilmasini kilitler.

const V = await import('./shipments/suratRegistrationVerification.ts')

const codeOf = (file) => readFileSync(file, 'utf8')
  .split(String.fromCharCode(10))
  .filter((line) => {
    const t = line.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join(String.fromCharCode(10))

const server = codeOf('server/index.mjs')
const NOW = Date.parse('2026-08-19T12:00:00Z')
const MIN = 60 * 1000

/* ═══ VERIFY-1 — KABUL TEK BASINA BARKOD ACMAZ ═══════════════════════ */

test('VERIFY-1: REST kabulu TEK BASINA SOAP acmaz', () => {
  // Sorgu henuz kayit gormediyse barkod adimi KAPALI.
  const decision = V.resolveRegistrationVerification({
    registrationAccepted: true,
    query: { ok: true, gonderilerLength: 0 },
    registeredAtMs: NOW, nowMs: NOW + MIN,
  })
  assert.equal(decision.continueToBarcode, false)
  // Kod tarafinda da kapi VAR: ZINCIRDEKI barkod cagrisindan ONCE.
  // (Dosyada baska cagri yerleri de var; kapsam zincir govdesidir.)
  const chain = server.indexOf('async function createSuratRegisteredCommonBarcode')
  const gate = server.indexOf('if (!verification.continueToBarcode) {', chain)
  const soapCall = server.indexOf('await createSuratCommonBarcodeSoap(', chain)
  assert.ok(gate > chain, 'kapi zincir icinde OLMALI')
  assert.ok(gate < soapCall, 'kapi barkod cagrisindan ONCE olmali')
})

/* ═══ VERIFY-2 — TEYIT EDILINCE ACILIR ══════════════════════════════ */

test('VERIFY-2: Gonderiler=1 barkod adimini ACAR', () => {
  const decision = V.resolveRegistrationVerification({
    registrationAccepted: true,
    query: { ok: true, gonderilerLength: 1 },
    registeredAtMs: NOW, nowMs: NOW + MIN,
  })
  assert.equal(decision.state, 'VERIFIED_CONTINUE')
  assert.equal(decision.continueToBarcode, true)
  assert.equal(decision.shipmentRegistered, true)
})

/* ═══ VERIFY-3/4 — ESIK ═══════════════════════════════════════════════ */

test('VERIFY-3: Gonderiler=0 ve esik dolmadi → BEKLEMEDE, SOAP 0', () => {
  const decision = V.resolveRegistrationVerification({
    registrationAccepted: true,
    query: { ok: true, gonderilerLength: 0 },
    registeredAtMs: NOW, nowMs: NOW + 29 * MIN,
  })
  assert.equal(decision.state, 'PENDING_REGISTRATION_VERIFICATION')
  assert.equal(decision.continueToBarcode, false)
  // Kayit YOKLUGU kanitlanmadi — yeniden create de YAPILMAZ.
  assert.equal(decision.shipmentRegistered, false)
})

test('VERIFY-4: Gonderiler=0 ve esik doldu → terminal, SOAP 0', () => {
  const decision = V.resolveRegistrationVerification({
    registrationAccepted: true,
    query: { ok: true, gonderilerLength: 0 },
    registeredAtMs: NOW, nowMs: NOW + 31 * MIN,
  })
  assert.equal(decision.state, 'LABEL_CREATED_NOT_REGISTERED')
  assert.equal(decision.continueToBarcode, false)
  assert.equal(V.REGISTRATION_VISIBILITY_THRESHOLD_MS, 30 * MIN)
})

/* ═══ VERIFY-5/6 — FAIL CLOSED ═══════════════════════════════════════ */

test('VERIFY-5: sorgu basarisiz → FAIL CLOSED, SOAP 0', () => {
  for (const query of [null, { ok: false, gonderilerLength: 1 }]) {
    const decision = V.resolveRegistrationVerification({
      registrationAccepted: true, query,
      registeredAtMs: NOW, nowMs: NOW + MIN,
    })
    assert.equal(decision.state, 'VERIFICATION_FAILED_CLOSED')
    assert.equal(decision.continueToBarcode, false)
  }
})

test('VERIFY-6: kimlik uyusmazsa SOAP 0', () => {
  // WebSiparisKodu SIPARIS NUMARASIDIR; packageId DEGILDIR.
  assert.equal(
    V.registrationIdentityMatches({
      expectedOrderNumber: '11537749548', queriedWebSiparisKodu: '4103294752',
    }),
    false,
  )
  assert.equal(
    V.registrationIdentityMatches({
      expectedOrderNumber: '11537749548', queriedWebSiparisKodu: '11537749548',
    }),
    true,
  )
  // Bos kimlik ESLESME SAYILMAZ.
  assert.equal(
    V.registrationIdentityMatches({
      expectedOrderNumber: '', queriedWebSiparisKodu: '',
    }),
    false,
  )
})

/* ═══ VERIFY-9 — KAYITSIZ 013 BASARI DEGILDIR ════════════════════════ */

test('VERIFY-9: teyitsiz 013/ZPL dogrulanmis basari SAYILMAZ', () => {
  // Canli ayrim testinin ta kendisi: barkod var, kayit yok.
  const decision = V.resolveRegistrationVerification({
    registrationAccepted: true,
    query: { ok: true, gonderilerLength: 0 },
    registeredAtMs: NOW, nowMs: NOW + 31 * MIN,
  })
  assert.equal(decision.shipmentRegistered, false)
  assert.notEqual(decision.state, 'VERIFIED_CONTINUE')
})

/* ═══ VERIFY-10/11 — ÇAĞRI SAYILARI ═════════════════════════════════ */

test('VERIFY-10/11: zincirde tek REST kaydi ve tek barkod cagrisi', () => {
  const chain = server.indexOf('async function createSuratRegisteredCommonBarcode')
  const next = server.indexOf('\nasync function ', chain + 10)
  const body = server.slice(chain, next > 0 ? next : undefined)
  assert.equal(body.split('await createSuratLegacyRestJson(').length - 1, 1)
  assert.equal(body.split('await createSuratCommonBarcodeSoap(').length - 1, 1)
})

/* ═══ VERIFY-12 — DOĞRULAMA YAZMA YAPMAZ ════════════════════════════ */

test('VERIFY-12: dogrulama SALT OKUNUR — tasiyici durumu YAZMAZ', () => {
  const policy = codeOf('server/shipments/suratRegistrationVerification.ts')
  assert.equal(/\bfetch\(/.test(policy), false, 'politika ag cagirmaz')
  for (const forbidden of ['.insert(', '.update(', '.delete(']) {
    assert.equal(policy.includes(forbidden), false, forbidden)
  }
})

/* ═══ VERIFY-13 — FINANSAL KAPI ÖNCE ════════════════════════════════ */

test('VERIFY-13: finansal kapi TUM create aglarindan ONCE', () => {
  const gate = server.indexOf('evaluateSuratFinancialGate({')
  const restCall = server.indexOf('const dispatchRegistration = await createSuratLegacyRestJson(')
  assert.ok(gate > 0 && restCall > 0 && gate < restCall)
})

/* ═══ VERIFY-7/8 — ZATEN VAR DALI DA TEYİT EDER ══════════════════════ */
//
// ÜRETİM İZİ CF-4103216452: taşıyıcı "Bu gonderi daha önce oluşturulmuş."
// dedi. `duplicateShipment` → `registrationAccepted=false` → zincir ERKEN
// dönüyordu ve salt-okunur teyit HİÇ ÇALIŞMIYORDU. Kayıt gerçekten var
// olabilir; doğrulamadan ne barkod istenir ne "oluşturulamadı" denir.

test('VERIFY-7: ZATEN VAR ikinci REST create YAPMAZ ama TEYIT eder', () => {
  const chain = server.indexOf('async function createSuratRegisteredCommonBarcode')
  const next = server.indexOf('\nasync function ', chain + 10)
  const body = server.slice(chain, next > 0 ? next : undefined)
  // Zaten-var dali VAR ve erken donusten ONCE gelir.
  const already = body.indexOf('if (!registrationAccepted && registrationAlreadyExists) {')
  const plainReject = body.indexOf('if (!registrationAccepted) {')
  assert.ok(already > 0, 'zaten-var dali OLMALI')
  assert.ok(already < plainReject, 'zaten-var dali duz reddin ONUNDE olmali')
  // O dalda salt-okunur teyit CAGRILIR.
  const branch = body.slice(already, plainReject)
  assert.ok(branch.includes('await verifyRegistrationReadOnly()'))
  // IKINCI REST create YOK.
  assert.equal(branch.includes('createSuratLegacyRestJson('), false)
  // BARKOD da CAGRILMAZ.
  assert.equal(branch.includes('createSuratCommonBarcodeSoap('), false)
})

test('VERIFY-8: zaten-var karari YALNIZ salt-okunur sonuca dayanir', () => {
  // Gonderiler=1 → mevcut kayit DOGRULANDI.
  const verified = V.resolveRegistrationVerification({
    registrationAccepted: true,
    query: { ok: true, gonderilerLength: 1 },
    registeredAtMs: NOW, nowMs: NOW + MIN,
  })
  assert.equal(verified.shipmentRegistered, true)
  // Gonderiler=0 → beklemede; barkod YOK, tekrar create YOK.
  const pending = V.resolveRegistrationVerification({
    registrationAccepted: true,
    query: { ok: true, gonderilerLength: 0 },
    registeredAtMs: NOW, nowMs: NOW + MIN,
  })
  assert.equal(pending.continueToBarcode, false)
})

/* ═══ VERIFY-15 — İZDE AYRI BACAK ════════════════════════════════════ */

test('VERIFY-15: iz REGISTRATION_VERIFY bacagini AYRI gosterir', () => {
  const soap = codeOf('server/shipments/suratSoapPrimaryCreate.ts')
  assert.ok(soap.includes("step: 'REGISTRATION_VERIFY'"))
  assert.ok(soap.includes('readOnly: true'))
  assert.ok(soap.includes('carrierStateMutated: false'))
  // Teyit bacagi tasiyici YANITI olarak yazilmaz.
  assert.ok(soap.includes("stage: 'VERIFICATION'"))
  // Kimlik ve sayim gorunur.
  assert.ok(soap.includes('gonderilerLength'))
  assert.ok(soap.includes('identityMatch'))
})

/* ═══ KİMLİK SIZINTISI — GÖRÜNEN DEĞER OTORİTE DEĞİL ═════════════════ */
//
// Üretim UI'ı "Sipariş No" alanında 727… takip numarasını gösteriyor
// (bilerek: operatörün tanıdığı kimlik). Bu değer create/doğrulama
// yollarına SIZARSA `WebSiparisKodu` yanlış olur ve teyit sessizce boşa
// çıkar. Görünen değer YALNIZ sunum katmanında kalmalıdır.

test('VERIFY-16: gorunen siparis numarasi sunum DISINA sizmaz', () => {
  for (const file of [
    'server/index.mjs',
    'server/shipments/suratRegistrationVerification.ts',
    'server/shipments/suratSoapPrimaryCreate.ts',
  ]) {
    assert.equal(
      codeOf(file).includes('displayOrderNumber'), false,
      `${file} gorunen degeri KULLANMAMALI`,
    )
  }
})

test('VERIFY-17: WebSiparisKodu kaynagi CREATE REFERANSIDIR', () => {
  const chain = server.indexOf('async function createSuratRegisteredCommonBarcode')
  const next = server.indexOf('\nasync function ', chain + 10)
  const body = server.slice(chain, next > 0 ? next : undefined)
  // DUZELTILDI. Bu test "SIPARIS NUMARASIDIR" diye pinliyordu; yanlisti ve
  // teyit sorgusunu HER ZAMAN bos donduruyordu.
  //
  // BIRLESTIRICI KURAL (docs/surat-service-map.md:31,34): okuma anahtari
  // `createRequest.OzelKargoTakipNo`'dur — create sirasinda NE gonderildiyse
  // O. Bu zincir (Trendyol pazaryeri) OzelKargoTakipNo olarak
  // `cargoTrackingNumber` (727...) gonderir; okuma anahtari da odur.
  //
  // Kanit: service-map:83,88 ve :93-104 (canli ornek WebSiparisKodu=727...),
  // outputs/surat-e2e-final-report-2026-07-17.md:46 (uretim kosusu).
  //
  // NOT: SSP/Serendip mutabakati AYRI akistir; orada create referansi
  // orderNumber oldugu icin okuma anahtari da orderNumber'dir
  // (surat-tracking-reconcile-flow SSP-QUERY-1). Iki akis CELISMEZ.
  assert.ok(body.includes('webSiparisKodu: order?.cargoTrackingNumber'))
  assert.equal(body.includes('webSiparisKodu: order?.packageId'), false)
  assert.equal(body.includes('webSiparisKodu: order?.orderNumber'), false)
})
