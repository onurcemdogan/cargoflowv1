import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import {
  REQUIRED_TRANSPORT_ORDER, TRANSPORT_LEG_CONTRACT,
  readCarrierCallEvidence, resolveCreateResumeAction, resolveReconciliation,
} from './shipments/suratCrashRecovery.ts'
import { resolveSuratCreateEligibility } from './shipments/suratCreateEligibility.ts'
import { projectCarrierTruth } from './shipments/suratTraceProjection.ts'

// ÜRETİM OLAYI — CF-4103661055.
//
// carrierCallStarted=true · carrierCalled=true · İŞ YANITI YOK.
// Uygulama istisnası: "Cannot access 'verifyRegistrationReadOnly' before
// initialization". Bu paket ARTIK yeni create adayı DEĞİLDİR.

const serverSource = readFileSync('server/index.mjs', 'utf8')
const soapSource = readFileSync(
  'server/shipments/suratSoapPrimaryCreate.ts', 'utf8',
)

const stage = (name, data = {}) => ({ stage: name, section: 'X', at: 'x', data })

/* ═══ FLOW-LEG — GERÇEK TAŞIMA SIRASI ═══════════════════════════════ */

test('FLOW-LEG-1: kayit REST bacagi teyitten ONCE gelir', () => {
  assert.deepEqual([...REQUIRED_TRANSPORT_ORDER], [
    'REGISTRATION_REST', 'REGISTRATION_VERIFY', 'BARCODE_SOAP',
  ])
  assert.ok(
    REQUIRED_TRANSPORT_ORDER.indexOf('REGISTRATION_REST')
      < REQUIRED_TRANSPORT_ORDER.indexOf('REGISTRATION_VERIFY'),
  )
  // Yalniz REST bacagi tasiyici durumunu degistirir ve TEK adimdir.
  assert.equal(TRANSPORT_LEG_CONTRACT.REGISTRATION_REST.readOnly, false)
  assert.equal(
    TRANSPORT_LEG_CONTRACT.REGISTRATION_REST.operation,
    'GonderiyiKargoyaGonder',
  )
})

test('FLOW-LEG-2: teyit bacagi SOAP barkoddan ONCE gelir ve SALT-OKUNURDUR', () => {
  assert.ok(
    REQUIRED_TRANSPORT_ORDER.indexOf('REGISTRATION_VERIFY')
      < REQUIRED_TRANSPORT_ORDER.indexOf('BARCODE_SOAP'),
  )
  const verify = TRANSPORT_LEG_CONTRACT.REGISTRATION_VERIFY
  assert.equal(verify.readOnly, true)
  assert.equal(verify.carrierStateMutated, false)
  assert.equal(verify.operation, 'KargoTakipHareketDetayi')
  // Bacak nitelikleri IZDE de sozlesmeden damgalanir; cagiran EZEMEZ.
  assert.ok(soapSource.includes("legMetadata('REGISTRATION_VERIFY'"))
  assert.ok(soapSource.includes('transportLeg: leg'))
})

test('FLOW-LEG-3: Gonderiler=0 SOAP barkodu ACMAZ', () => {
  const decision = resolveReconciliation({
    query: { ok: true, gonderilerLength: 0 },
    identityMatch: true,
    registeredAtMs: null,
    nowMs: Date.now(),
  })
  assert.equal(decision.resumeToBarcode, false)
  // Ve ASLA ikinci kayit create'ine donusmez.
  assert.equal(decision.replayRegistration, false)
})

test('FLOW-LEG-4: SOAP yalniz Gonderiler>=1 VE kimlik eslesince acilir', () => {
  const now = Date.now()
  const good = resolveReconciliation({
    query: { ok: true, gonderilerLength: 1 },
    identityMatch: true, registeredAtMs: now, nowMs: now,
  })
  assert.equal(good.outcome, 'RESUME_AT_BARCODE_SOAP')
  assert.equal(good.resumeToBarcode, true)
  assert.equal(good.registrationExists, true)

  // Kayit VAR ama kimlik uyusmuyor: baska bir gonderi olabilir → FAIL-CLOSED.
  const mismatch = resolveReconciliation({
    query: { ok: true, gonderilerLength: 1 },
    identityMatch: false, registeredAtMs: now, nowMs: now,
  })
  assert.equal(mismatch.outcome, 'FAIL_CLOSED')
  assert.equal(mismatch.resumeToBarcode, false)
  assert.equal(mismatch.registrationExists, false)
})

test('FLOW-LEG-5: WebSiparisKodu SIPARIS NUMARASIDIR', () => {
  assert.equal(
    TRANSPORT_LEG_CONTRACT.REGISTRATION_VERIFY.identitySource, 'orderNumber',
  )
  // Gercek sorgu da siparis numarasini kullanir; paket kimligini DEGIL.
  assert.ok(serverSource.includes('webSiparisKodu: order?.orderNumber'))
  assert.ok(serverSource.includes('webSiparisKodu: orderRow.orderNumber'))
  assert.ok(serverSource.includes("webSiparisKoduSource: 'orderNumber'"))
})

/* ═══ CRASH-RECOVER — AG BASLADI, SONUC BILINMIYOR ══════════════════ */

test('CRASH-RECOVER-1: cagri basladi + yanit yok = IKINCI CREATE YOK', () => {
  const resume = resolveCreateResumeAction({
    carrierCallStarted: true,
    carrierBusinessResponseReceived: false,
  })
  assert.equal(resume.action, 'REQUIRES_READ_ONLY_RECONCILIATION')
  assert.notEqual(resume.action, 'SAFE_TO_CREATE')

  // Ve bu, GERCEK create kapisini KAPATIR.
  const eligibility = resolveSuratCreateEligibility({
    order: {
      orderNumber: '11538296497',
      packageId: '4103661055',
      cargoTrackingNumber: '7270036359838267',
    },
    carrierCallEvidence: {
      known: true,
      carrierCallStarted: true,
      carrierBusinessResponseReceived: false,
    },
  })
  assert.equal(eligibility.eligible, false)
  assert.ok(eligibility.reasons.includes('REQUIRES_READ_ONLY_RECONCILIATION'))
})

test('CRASH-RECOVER-1b: kanit CF-4103661055 iz sekliyle IZLERDEN okunur', () => {
  const traces = [{
    traceId: 'CF-4103661055',
    packageId: '4103661055',
    stages: [
      stage('ACTUAL_WIRE_READY'),
      stage('CARRIER_CALL_STARTED'),
      // Uygulama istisnasi — tasiyici IS YANITI DEGIL.
      stage('APPLICATION_EXCEPTION', {
        carrierCalled: true,
        carrierCreateStatus: 'UNKNOWN',
        carrierBusinessResponseReceived: false,
      }),
      stage('FINAL', { carrierCreateStatus: 'UNKNOWN', carrierCalled: true }),
    ],
  }]
  const evidence = readCarrierCallEvidence(traces, '4103661055')
  assert.equal(evidence.known, true)
  assert.equal(evidence.carrierCallStarted, true)
  assert.equal(evidence.carrierBusinessResponseReceived, false)
  assert.equal(evidence.traceId, 'CF-4103661055')

  // BASKA paket bu kanittan ETKILENMEZ.
  const other = readCarrierCallEvidence(traces, '4096209239')
  assert.equal(other.known, true)
  assert.equal(other.carrierCallStarted, false)

  // Izler OKUNAMADIYSA "cagri yapilmadi" DIYE SUNULMAZ.
  const unreadable = readCarrierCallEvidence(null, '4103661055')
  assert.equal(unreadable.known, false)
  assert.equal(unreadable.carrierCallStarted, false)
})

test('CRASH-RECOVER-2: teyit edilmis kayit REST TEKRARLANMADAN barkoda gecer', () => {
  const now = Date.now()
  const decision = resolveReconciliation({
    query: { ok: true, gonderilerLength: 2 },
    identityMatch: true, registeredAtMs: now, nowMs: now,
  })
  assert.equal(decision.resumeToBarcode, true)
  assert.equal(decision.replayRegistration, false)
  assert.equal(decision.outcome, 'RESUME_AT_BARCODE_SOAP')
})

test('CRASH-RECOVER-3: Gonderiler=0 kaydi OTOMATIK TEKRAR ETMEZ', () => {
  const now = Date.now()
  // Esik DOLMADI: "gorunmuyor" ile "yok" ayni sey degildir.
  const early = resolveReconciliation({
    query: { ok: true, gonderilerLength: 0 },
    identityMatch: true, registeredAtMs: now, nowMs: now,
  })
  assert.equal(early.outcome, 'PENDING_REGISTRATION_VERIFICATION')
  assert.equal(early.replayRegistration, false)

  // Esik DOLDU: yine de otomatik replay YOK — terminal durum.
  const late = resolveReconciliation({
    query: { ok: true, gonderilerLength: 0 },
    identityMatch: true,
    registeredAtMs: now - (31 * 60 * 1000), nowMs: now,
  })
  assert.equal(late.outcome, 'LABEL_CREATED_NOT_REGISTERED')
  assert.equal(late.replayRegistration, false)
  assert.equal(late.resumeToBarcode, false)

  // Sorgu BASARISIZ: bilinmezlik ikinci create'e DONUSMEZ.
  const failed = resolveReconciliation({
    query: null, identityMatch: true, registeredAtMs: now, nowMs: now,
  })
  assert.equal(failed.outcome, 'FAIL_CLOSED')
  assert.equal(failed.replayRegistration, false)
})

test('CRASH-RECOVER-4: mutabakat ucu HIC create CAGIRMAZ', () => {
  const start = serverSource.indexOf(
    "'/api/shipments/surat/reconcile-registration'",
  )
  assert.ok(start > 0, 'salt-okunur mutabakat ucu VAR OLMALI')
  const body = serverSource.slice(start, start + 5000)
  assert.equal(body.includes('GonderiyiKargoyaGonder'), false)
  assert.equal(body.includes('OrtakBarkodOlustur'), false)
  assert.ok(body.includes('KargoTakipHareketDetayi'))
  assert.ok(body.includes('createCalls: 0'))
})

/* ═══ TRACE-1 — ISTISNA, TASIYICI YANITI DEGILDIR ═══════════════════ */

test('TRACE-1: uygulama istisnasi tasiyici is yanitindan AYIRT EDILIR', () => {
  const crashed = projectCarrierTruth([
    stage('CARRIER_CALL_STARTED'),
    stage('APPLICATION_EXCEPTION', {
      carrierCalled: true,
      carrierCreateStatus: 'UNKNOWN',
      carrierBusinessResponseReceived: false,
      carrierExceptionSummary: 'init hatasi',
    }),
  ])
  assert.equal(crashed.carrierCallStarted, true)
  assert.equal(crashed.carrierCalled, true)
  // TASIYICI KONUSMADI.
  assert.equal(crashed.carrierBusinessResponseReceived, false)
  assert.equal(crashed.applicationException, true)
  assert.equal(crashed.carrierCreateStatus, 'UNKNOWN')

  const answered = projectCarrierTruth([
    stage('CARRIER_CALL_STARTED'),
    stage('CARRIER_RESPONSE', {
      carrierCalled: true, carrierCreateStatus: 'CREATED',
    }),
  ])
  assert.equal(answered.carrierBusinessResponseReceived, true)
  assert.equal(answered.applicationException, false)

  // Kaynak: istisna dali artik CARRIER_RESPONSE diye YAZMAZ.
  assert.ok(soapSource.includes("'CARRIER_RESPONSE' : 'APPLICATION_EXCEPTION'"))
})

/* ═══ SUITE-1 — KAYITSIZ TEST DOSYASI SESSIZCE ATLANAMAZ ═══════════ */

test('SUITE-1: server/*.test.mjs dosyalarinin HEPSI test:surat icinde', () => {
  // `test:surat` bir GLOB DEGIL, elle yazilmis dosya listesidir. Bu oturumda
  // iki yeni test dosyasi yazildi ve paket "2164 pass" dedi — YENI DOSYALAR
  // HIC CALISMADAN. Yesil bir paket, calismayan testi gizleyebilir.
  const listed = new Set(
    JSON.parse(readFileSync('package.json', 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync('server')
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  const orphans = onDisk.filter((f) => !listed.has(f))
  assert.deepEqual(orphans, [], `test:surat icinde OLMAYAN test dosyalari: ${orphans.join(', ')}`)
})
