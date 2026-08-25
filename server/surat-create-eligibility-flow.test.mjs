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

/* ═══ DENETÇİ — GERÇEK YOLLA AYNI YORDAM ═════════════════════════════ */

const inspector = codeOf('server/shipments/suratCreateEligibilityInspectCli.ts')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

test('ELIG-INSPECT-1: denetci ve gercek create AYNI yordami kullanir', () => {
  // Paralel/simule bir kopya, uretimden farkli cevap verir ve denetim
  // YALAN SOYLER.
  assert.ok(inspector.includes(
    "import { resolveSuratCreateEligibility } from './suratCreateEligibility.ts'",
  ))
  assert.ok(inspector.includes('resolveSuratCreateEligibility({ order })'))
  assert.ok(server.includes('resolveSuratCreateEligibility({'))
})

test('ELIG-INSPECT-2: denetci SALT OKUNUR — yazma/create YOK', () => {
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'createSurat']) {
    assert.equal(inspector.includes(forbidden), false, forbidden)
  }
  assert.equal(/\bfetch\(/.test(inspector), false, 'ag cagrisi')
  assert.ok(inspector.includes('NETWORK_CALLS 0 · DB_WRITES 0 · CREATE_CALLS 0'))
})

test('ELIG-INSPECT-2b: npm script KAYITLI ve .env yukler', () => {
  const script = pkg.scripts?.['surat:create:eligibility:inspect']
  assert.ok(script, 'script tanimli OLMALI')
  assert.match(script, /--env-file-if-exists=\.env/)
})

test('ELIG-INSPECT-3: kimlik alanlari ROL AYRIMINI korur', () => {
  const result = E.resolveSuratCreateEligibility({ order: { ...base } })
  assert.equal(result.identity.orderNumber, '11529094251')
  assert.equal(result.identity.packageId, '4096209239')
  assert.equal(result.identity.cargoTrackingNumber, '7270036215917594')
})

test('ELIG-INSPECT-4: gorunen siparis numarasi denetciye SIZMAZ', () => {
  assert.equal(inspector.includes('displayOrderNumber'), false)
})

test('ELIG-INSPECT-5: YAS TEK BASINA uygunlugu BOZMAZ', () => {
  // Yas TANI kanitidir, durum DEGILDIR. Eski ama temiz paket UYGUNDUR.
  const old = E.resolveSuratCreateEligibility({
    order: { ...base, orderDate: '2026-08-22T09:00:00Z' },
  })
  assert.equal(old.eligible, true)
  // Denetci yasi RAPORLAR ama uygunluga KATMAZ.
  assert.ok(inspector.includes('AGE_HOURS'))
  assert.equal(inspector.includes('ageHours >'), false)
})

test('ELIG-INSPECT-6: mevcut tasiyici/etiket kaniti uygunlugu BLOKLAR', () => {
  const blocked = E.resolveSuratCreateEligibility({
    order: { ...base, shipment: { barcodeValue: 'Web00157962154' } },
  })
  assert.equal(blocked.eligible, false)
  assert.ok(blocked.reasons.includes('CARRIER_EVIDENCE_EXISTS'))
})

test('ELIG-INSPECT-7: olmayan sema alani UYDURULMAZ', () => {
  // Sema `ozelKargoTakipNo` / `printZpl` TASIMAZ; denetci bunlari
  // uydurmak yerine acikca bildirir.
  assert.ok(inspector.includes('UNAVAILABLE_IN_CURRENT_SCHEMA'))
  assert.equal(inspector.includes('shipmentRow.ozelKargoTakipNo'), false)
  assert.equal(inspector.includes('shipmentRow.printZpl'), false)
})

/* ═══ STALE — "YENİ" SEKMESİ SÖZLEŞMESİ ═════════════════════════════ */

const classification = codeOf('src/utils/orderClassification.ts')

test('STALE-1: Yeni/acik siniflandirmasi SAKLANAN duruma baglidir', () => {
  // Kaynak: marketplaceStatus + operationStatus + gonderi/etiket kaniti.
  assert.ok(classification.includes('const isOpenOperation = !processClosed'))
  assert.ok(classification.includes('isCanceledOrReturned'))
  assert.ok(classification.includes('isDelivered'))
  assert.ok(classification.includes('isArchived'))
  assert.ok(classification.includes('isHandedToCargo'))
})

test('STALE-2: terminal durum Yeni sekmesinde KALAMAZ', () => {
  const M = classification
  // processClosed olan hicbir siparis acik sayilmaz.
  assert.ok(M.includes('const processClosed = Boolean('))
  // Ve barkod-bekliyor yalniz ACIK operasyonlarda mumkundur.
  assert.ok(M.includes('isOpenOperation &&'))
})

test('STALE-3: YAS ya da senkron tazeligi siniflandirmaya GIRMEZ', () => {
  // Eski bir siparisi yasa gore gizlemek durumu DEGISTIRMEZ, sadece
  // gorunmez kilar. Saglayici hala hazirliyorsa gorunmeye DEVAM etmeli.
  assert.equal(classification.includes('lastSuccessfulSyncAt'), false)
  assert.equal(/ageHours|olderThanDays|staleAfter/.test(classification), false)
})
