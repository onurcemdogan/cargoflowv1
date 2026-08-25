import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// SUNUCU TARAFI UYGUNLUK KAPISI.
//
// ÖLÇÜLEN KUSUR: bu yordam `src/utils/` altındaydı ve HİÇBİR sunucu çağıranı
// yoktu — yani hiçbir şeyi korumuyordu. Tarayıcıda duran bir kontrol,
// geri alınamaz bir taşıyıcı create'ini engelleyemez.

const E = await import('./shipments/suratCreateEligibility.ts')

const codeOf = (file) => readFileSync(file, 'utf8')
  .split(String.fromCharCode(10))
  .filter((line) => {
    const t = line.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join(String.fromCharCode(10))

const server = codeOf('server/index.mjs')

const base = {
  orderNumber: '11529094251',
  packageId: '4096209239',
  cargoTrackingNumber: '7270036215917594',
  operationStatus: 'NEW',
}

/* ═══ ELIG-REAL-1/2 — SUNUCUDA VE ERKEN ══════════════════════════════ */

test('ELIG-REAL-1: gercek create yolu uygunlugu TASIYICIDAN ONCE cagirir', () => {
  const call = server.indexOf('resolveSuratCreateEligibility({')
  const financialGate = server.indexOf('evaluateSuratFinancialGate({')
  const restCreate = server.indexOf('const dispatchRegistration = await createSuratLegacyRestJson(')
  assert.ok(call > 0, 'SUNUCU cagirani OLMALI')
  assert.ok(call < financialGate, 'uygunluk finansal kapidan ONCE')
  assert.ok(financialGate < restCreate, 'finansal kapi create agindan ONCE')
})

test('ELIG-REAL-2: karar SUNUCUDA verilir, tarayici EZEMEZ', () => {
  // Modul sunucu agacinda; istemcinin gonderdigi hicbir alan kapiyi acmaz.
  assert.ok(
    server.includes("await import('./shipments/suratCreateEligibility.ts')"),
  )
  // Uygun degilse DERHAL donulur; asagi akis YOK.
  const call = server.indexOf('resolveSuratCreateEligibility({')
  const block = server.slice(call, call + 700)
  assert.ok(block.includes('if (!eligibility.eligible) {'))
  assert.ok(block.includes("errorCode: 'SURAT_CREATE_NOT_ELIGIBLE'"))
  assert.ok(block.includes('return'))
})

/* ═══ ELIG-REAL-5/7 — KANIT BLOKLAR ══════════════════════════════════ */

test('ELIG-REAL-5: tasiyici artefakti yeni create ACMAZ', () => {
  for (const shipment of [
    { trackingNumber: '41176176501029' }, { barcodeValue: 'Web00157962154' },
    { printZpl: '^XA^XZ' }, { technicalZpl: '^XA^XZ' },
    { ozelKargoTakipNo: '7270036215917594' },
  ]) {
    const result = E.resolveSuratCreateEligibility({
      order: { ...base, shipment },
    })
    assert.equal(result.eligible, false)
    assert.ok(result.reasons.includes('CARRIER_EVIDENCE_EXISTS'))
  }
})

test('ELIG-REAL-7: 727 siparis numarasi olarak gelirse BLOKLANIR', () => {
  // UI "Siparis No" alaninda 727 gosteriyor; o deger create'e sizarsa
  // WebSiparisKodu yanlis olur ve kayit dogrulamasi bosa cikar.
  const collided = E.resolveSuratCreateEligibility({
    order: { ...base, orderNumber: base.cargoTrackingNumber },
  })
  assert.equal(collided.eligible, false)
  assert.ok(collided.reasons.includes('IDENTITY_INCONSISTENT'))
})

test('ELIG-REAL-7b: eksik kimlik create ACMAZ', () => {
  for (const missing of [
    { orderNumber: '' }, { packageId: '' }, { cargoTrackingNumber: '' },
  ]) {
    const result = E.resolveSuratCreateEligibility({
      order: { ...base, ...missing },
    })
    assert.equal(result.eligible, false)
    assert.ok(result.reasons.includes('IDENTITY_INCOMPLETE'))
  }
})

test('ELIG-REAL-5b: mevcut etiket yeni create ACMAZ', () => {
  for (const operationStatus of ['LABEL_READY', 'LABEL_PRINTED']) {
    const result = E.resolveSuratCreateEligibility({
      order: { ...base, operationStatus },
    })
    assert.equal(result.eligible, false)
    assert.ok(result.reasons.includes('LABEL_ALREADY_CREATED'))
  }
})

/* ═══ ELIG-REAL-3/4 — DENEME GEÇMİŞİ ════════════════════════════════ */

test('ELIG-REAL-3: bilinen onceki deneme BLOKLAR', () => {
  const result = E.resolveSuratCreateEligibility({
    order: { ...base }, attemptEvidence: { known: true, count: 1 },
  })
  assert.equal(result.eligible, false)
  assert.ok(result.reasons.includes('PREVIOUS_CREATE_ATTEMPT_EXISTS'))
})

test('ELIG-REAL-4: mukerrer koruma idempotency katmaninda KALIR', () => {
  // Bu kapi ikinci, farkli kapsamli bir sayim YAPMAZ; idempotency anahtari
  // zaten ag sinirinda mukerrer create'i engelliyor. Iki farkli kapsam
  // cakisirsa gecerli siparisler yanlislikla bloklanir.
  // Idempotency rezervasyonu kalici katmandadir (shipmentPersistenceService
  // -> shipmentOperationRepository.reserveCreateOperation).
  assert.ok(
    codeOf('server/shipments/shipmentPersistenceService.ts')
      .includes('reserveCreateOperation'),
  )
  const call = server.indexOf('resolveSuratCreateEligibility({')
  const block = server.slice(call, call + 400)
  assert.equal(block.includes('attemptEvidence'), false)
})

/* ═══ ELIG-REAL-8/9 — TEMİZ PAKET GEÇER ═════════════════════════════ */

test('ELIG-REAL-8/9: temiz paket GECER, uygunsuzda ag 0', () => {
  const clean = E.resolveSuratCreateEligibility({ order: { ...base } })
  assert.equal(clean.eligible, true)
  assert.deepEqual(clean.reasons, [])
  // Uygunsuz karar tasiyiciya GITMEZ: donus finansal kapidan da once.
  const call = server.indexOf('resolveSuratCreateEligibility({')
  const restCreate = server.indexOf('const dispatchRegistration = await createSuratLegacyRestJson(')
  assert.ok(call < restCreate)
})

/* ═══ ELIG-REAL-10 — KAPI YAZMA/AG YAPMAZ ═══════════════════════════ */

test('ELIG-REAL-10: uygunluk yordami saf — ag/DB yazma YOK', () => {
  const policy = codeOf('server/shipments/suratCreateEligibility.ts')
  assert.equal(/\bfetch\(/.test(policy), false)
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'getDb(']) {
    assert.equal(policy.includes(forbidden), false, forbidden)
  }
})

test('ELIG-REAL-11: eski istemci tarafi kopyasi KALDIRILDI', () => {
  // Iki kaynak dogruluk kaymasi uretir; yetkili olan SUNUCUDUR.
  let clientCopyExists = true
  try {
    readFileSync('src/utils/suratCreateEligibility.ts', 'utf8')
  } catch {
    clientCopyExists = false
  }
  assert.equal(clientCopyExists, false, 'istemci kopyasi OLMAMALI')
})
