import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ÜRETİM İZİ CF-4102563548 (paket 4102563548).
//
// Sınıflandırma düzelmişti ama iz KENDİ İÇİNDE ÇELİŞİYORDU:
//   PRE_FLIGHT → ROUTING → REQUEST_READY → CARRIER_RESPONSE → VERIFICATION
//   → FINAL   ·   carrierCalled=true · attempts=1 · ACTUAL_WIRE eksik
//
// KÖK NEDEN: kayıtlı zincirin İLK ağ kenarı REST'tir ve `onWireReady`
// bağlanmamıştı; ayrıca `carrierCalled` kanıt yerine `!== false`
// varsayılanından geliyordu. Bu paket her ikisini de kilitler.

const SOAP = await import('./shipments/suratSoapPrimaryCreate.ts')
const T = await import('./shipments/suratCreateTrace.ts')
const WIRE = await import('./shipments/suratSoapWireCapture.ts')

/** Yorum satirlari ELENIR: aciklama metni kod kaniti DEGILDIR. */
const codeOf = (file) => readFileSync(file, 'utf8')
  .split(String.fromCharCode(10))
  .filter((line) => {
    const t = line.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join(String.fromCharCode(10))

const source = codeOf('server/shipments/suratSoapPrimaryCreate.ts')
const serverSource = codeOf('server/index.mjs')

/* ═══ TRUTH-1/2 — SIRA KODDA KİLİTLİ ═════════════════════════════════ */

test('TRUTH-1: carrierCalled kanittan turetilir, varsayilan DEGIL', () => {
  // Eski kusur: yoklugu onay saymak.
  assert.equal(
    source.includes('execution.carrierCalled !== false'), false,
    'carrierCalled artik `!== false` varsayilanindan GELMEMELI',
  )
  assert.ok(source.includes('const crossedNetwork'))
  assert.ok(source.includes('carrierCalled: crossedNetwork'))
})

test('TRUTH-2: CARRIER_CALL_STARTED tel kanitindan SONRA yazilir', () => {
  const wireStage = source.indexOf('appendActualWireStage(traceAttempt, wire')
  const started = source.indexOf("stage: 'CARRIER_CALL_STARTED'")
  const network = source.indexOf('await params.executeCreate(')
  assert.ok(wireStage > 0 && started > 0 && network > 0)
  assert.ok(wireStage < started, 'tel kaniti cagri baslangicindan ONCE')
  assert.ok(started < network, 'cagri baslangici agdan ONCE')
})

test('TRUTH-3: ag gecilmediyse deneme sayisi 0', () => {
  assert.ok(source.includes('crossedNetwork ? 1 : 0'))
  assert.equal(
    /carrierCreateAttempts:\s*1,/.test(source), false,
    'sabit attempts=1 KALMAMALI',
  )
})

/* ═══ TRUTH-4/6 — YEREL/ÖNCEKİ KANIT SAHTE ÇAĞRI ÜRETMEZ ════════════ */

test('TRUTH-4/6: yerel zaten-var kaniti CARRIER_RESPONSE UYDURMAZ', () => {
  // Ag gecilmediyse asama CARRIER_RESPONSE degil VERIFICATION olur.
  assert.ok(source.includes("crossedNetwork ? 'CARRIER_RESPONSE' : 'VERIFICATION'"))
  assert.ok(source.includes("'PRIOR_OR_LOCAL_EVIDENCE'"))
  assert.ok(source.includes("'CURRENT_CARRIER_RESPONSE'"))
})

/* ═══ REST KENARI ARTIK ENSTRÜMANTE ═════════════════════════════════ */

test('TRUTH-5: kayitli zincirin REST kenari onWireReady TASIYOR', () => {
  // Uretimdeki izsiz kenar tam olarak buydu.
  assert.ok(
    serverSource.includes("onWireReady(JSON.stringify(payload), 'REST')"),
    'REST kenari agdan once tel kaniti YAZMALI',
  )
  // Kenar ETIKETLI: yakalama evet, SOAP paritesi hayir.
  assert.ok(source.includes("if (edge !== 'SOAP') return"))
  const restCall = serverSource.indexOf('const dispatchRegistration = await createSuratLegacyRestJson(')
  const passed = serverSource.indexOf('{ onWireReady },', restCall)
  assert.ok(restCall > 0 && passed > restCall, 'zincir onWireReady GECIRMELI')
})

test('TRUTH-5b: JSON govde de yakalanir (REST ve SOAP ayni sekil)', () => {
  const captured = WIRE.captureSoapActualWire({
    envelope: JSON.stringify({
      KullaniciAdi: 'CARI0944', Sifre: 'SECRET',
      Gonderi: {
        Pazaryerimi: 1, EntegrasyonFirmasi: 'Trendyol', OdemeTipi: 1,
        OzelKargoTakipNo: '7270036019076954', ReferansNo: '4102563548',
      },
    }),
    operation: 'OrtakBarkodOlustur', serviceMode: 'ORTAK_BARKOD_SOAP',
  })
  assert.equal(captured.envelopePresent, true)
  assert.equal(captured.gonderiPresent, true)
  assert.ok(captured.gonderiFieldNames.includes('Pazaryerimi'))
  assert.equal(captured.gonderiFieldTypes.Pazaryerimi, 'number')
  // Ag siniri parmak izi URETILIR — uretimde ABSENT gorunuyordu.
  assert.ok(captured.credential.networkBoundaryAccountFingerprint)
  assert.equal(captured.credential.kullaniciAdiPresent, true)
  // SIR SIZMAZ.
  assert.equal(JSON.stringify(captured).includes('SECRET'), false)
})

/* ═══ TRUTH-7 — YAŞAM DÖNGÜSÜ SIRASI ════════════════════════════════ */

test('TRUTH-7: tel asamasi yasam dongusunde cagridan ONCE gelir', () => {
  const stages = [...T.TRACE_LIFECYCLE_STAGES]
  assert.ok(
    stages.indexOf('ACTUAL_WIRE_READY') < stages.indexOf('CARRIER_CALL_STARTED'),
  )
  assert.ok(
    stages.indexOf('CARRIER_CALL_STARTED') < stages.indexOf('CARRIER_RESPONSE'),
  )
  assert.equal(typeof SOAP.createSuratSoapPrimaryShipment, 'function')
})
