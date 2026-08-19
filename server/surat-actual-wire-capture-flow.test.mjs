import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// GERÇEK TEL (ACTUAL WIRE) YAKALAMA.
//
// ═══ NEDEN ════════════════════════════════════════════════════════════════
// "Telde ne gitti?" sorusu şimdiye kadar YENİDEN KURGULANARAK yanıtlanıyordu
// ve üretimde YANLIŞ çıktı: legacy debug `ReferansNo = 7270036062402465` ve
// `CariKod/FirmaId = 1537690944` gösterdi, oysa o değerler telde öyle
// gitmemişti — hatta bazı denemelerde ağa HİÇ çıkılmamıştı.
//
// Yakalama artık NİHAİ istek nesnesinden, `JSON.stringify`den HEMEN ÖNCE
// alınır. Kurgu YOK.
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK.
assert.notEqual(process.env.REAL_CARRIER_NETWORK, '1')
assert.notEqual(process.env.LIVE_CREATE, '1')

const here = dirname(fileURLToPath(import.meta.url))
const WIRE = await import('./shipments/suratActualWireCapture.ts')
const SNAP = await import('./shipments/suratCredentialSnapshot.ts')

const read = (...p) => readFileSync(join(here, ...p), 'utf8')
const CLIENT = read('shipments', 'suratWebApiClient.ts')
const ADAPTER = read('shipments', 'suratCanonicalCreateAdapter.ts')
const SERVICE = read('shipments', 'suratCanonicalShipmentService.ts')
const stripComments = (src) => src
  .split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n')

/** Üretim şekliyle NİHAİ istek gövdesi (kanonik sözleşme). */
const finalizedRequest = (over = {}) => ({
  KullaniciAdi: '1234562622',
  Sifre: 'tenant-secret',
  Gonderi: {
    KisiKurum: 'Ad Soyad',
    AliciAdresi: 'Gizli adres',
    Il: 'İstanbul', Ilce: 'Kadıköy',
    Email: 'gizli@example.invalid',
    KargoTuru: 3,
    OdemeTipi: 1,
    ReferansNo: '4088678590',
    OzelKargoTakipNo: '7270036060751541',
    Adet: 1,
    Pazaryerimi: 1,
    EntegrasyonFirmasi: 'Trendyol',
    Iademi: 0,
    ...over,
  },
})

/* ═══ WIRE-1 — NİHAİ GÖVDEDEN, AĞDAN ÖNCE ══════════════════════════ */

test('WIRE-1: ACTUAL_WIRE_READY NIHAI govdeden, fetchten ONCE uretilir', () => {
  const live = stripComments(CLIENT)
  const buildAt = live.indexOf('const request: SuratOrtakBarkodRequest = {')
  const captureAt = live.indexOf('params.onWireReady(')
  const fetchAt = live.indexOf('await doFetch(')
  assert.ok(buildAt > 0 && captureAt > 0 && fetchAt > 0, 'sinirlar bulunamadi')
  // Sira: govde kurulur → yakalanir → AG.
  assert.ok(buildAt < captureAt, 'yakalama govde kurulmadan calisiyor')
  assert.ok(captureAt < fetchAt, 'yakalama AGDAN SONRA calisiyor')
  // Adaptor bu geri cagriyi baglar ve asamayi ekler.
  assert.match(ADAPTER, /onWireReady: \(capture\) => \{ actualWire = capture \}/)
  assert.match(ADAPTER, /stage: 'ACTUAL_WIRE_READY'/)
})

test('WIRE-1b: yakalama KURGU kaynaklarina BAKMAZ', () => {
  const capture = stripComments(
    read('shipments', 'suratActualWireCapture.ts'),
  )
  for (const forbidden of [
    'localStorage', 'shipment_operations', 'orderRepository',
    'request.body', 'process.env',
  ]) {
    assert.equal(
      capture.includes(forbidden), false,
      `yakalama kurgu kaynagi okuyor: ${forbidden}`,
    )
  }
})

/* ═══ WIRE-2/3/4 — PARMAK İZİ AĞ SINIRINDAN ═══════════════════════ */

test('WIRE-2: ag sinir parmak izi NIHAI govdedeki kimlikten hesaplanir', () => {
  const capture = WIRE.captureActualWire(finalizedRequest())
  const expected = SNAP.buildSuratCredentialSnapshot({
    storedSuratConfig: { canonicalPrimaryKullaniciAdi: '1234562622',
      canonicalPrimarySifre: 'x' },
    role: 'PRIMARY_MARKETPLACE',
  }).accountFingerprint
  assert.equal(capture.credential.networkBoundaryAccountFingerprint, expected)
  assert.equal(capture.credential.kullaniciAdiPresent, true)
  assert.equal(capture.credential.sifrePresent, true)
})

test('WIRE-3: DORT parmak izi esitse ag UYGUN', () => {
  const fp = 'LEN10:****2622'
  const verdict = WIRE.verifyWireFingerprints({
    resolverAccountFingerprint: fp,
    snapshotAccountFingerprint: fp,
    requestBuilderAccountFingerprint: fp,
    networkBoundaryAccountFingerprint: fp,
  })
  assert.equal(verdict.credentialFingerprintMatch, true)
  assert.deepEqual(verdict.divergentBoundaries, [])
})

test('WIRE-4: anlik goruntuden SONRA kimlik degistiyse AG 0', () => {
  const fp = 'LEN10:****2622'
  const mutated = WIRE.verifyWireFingerprints({
    resolverAccountFingerprint: fp,
    snapshotAccountFingerprint: fp,
    requestBuilderAccountFingerprint: fp,
    // Tel sinirinda BASKA hesap belirdi.
    networkBoundaryAccountFingerprint: 'LEN10:****0944',
  })
  assert.equal(mutated.credentialFingerprintMatch, false)
  assert.deepEqual(mutated.divergentBoundaries, ['networkBoundary'])

  // Servis kapisi bu durumda AGA CIKMAZ.
  const service = stripComments(SERVICE)
  const guardAt = service.indexOf('assertSuratWireCredentialParity({')
  const fetchAt = service.indexOf('await createOrtakBarkodShipment({')
  assert.ok(guardAt > 0 && guardAt < fetchAt, 'kapi fetchi domine etmiyor')
})

/* ═══ WIRE-5 — KİMLİK ALANLARI BAĞIMSIZ ═══════════════════════════ */

test('WIRE-5: ReferansNo ile OzelKargoTakipNo AYRI kaynaklardir', () => {
  const capture = WIRE.captureActualWire(finalizedRequest())
  // Uretim degerleri: paket referansi vs saglayici kargo takip no.
  assert.equal(capture.safeValues.ReferansNo, '4088678590')
  assert.equal(capture.safeValues.OzelKargoTakipNo, '7270036060751541')
  assert.notEqual(capture.safeValues.ReferansNo, capture.safeValues.OzelKargoTakipNo)

  // Model, OzelKargoTakipNo icin ReferansNo fallback'ini ACIKCA yasaklar.
  const model = read('shipments', 'suratCanonicalGonderiModel.ts')
  assert.match(model, /fallback YOKTUR/)
  const liveModel = stripComments(model)
  assert.equal(
    /ozelKargoTakipNo[^\n]*\breferansNo\b/i.test(liveModel), false,
    'OzelKargoTakipNo ReferansNodan turetiliyor',
  )
})

/* ═══ WIRE-6/7 — TİPLER ve SÖZLEŞME DIŞI ALANLAR ══════════════════ */

test('WIRE-6: Gonderi calisma zamani tipi NESNEDIR', () => {
  const capture = WIRE.captureActualWire(finalizedRequest())
  assert.equal(capture.rootRuntimeType, 'object')
  assert.equal(capture.gonderiRuntimeType, 'object')
  // HER alanin tipi yakalanir.
  assert.equal(capture.gonderiFieldTypes.OdemeTipi, 'number')
  assert.equal(capture.gonderiFieldTypes.EntegrasyonFirmasi, 'string')
  assert.equal(capture.gonderiFieldTypes.Pazaryerimi, 'number')
  assert.ok(Object.keys(capture.gonderiFieldTypes).length >= 10)

  // Gonderi DIZEYE cevrilirse bu YAKALANIR.
  const stringified = WIRE.captureActualWire({
    KullaniciAdi: 'x', Sifre: 'y', Gonderi: '{"OdemeTipi":1}',
  })
  assert.equal(stringified.gonderiRuntimeType, 'string')
})

test('WIRE-7: WhoPays/KimOder/FirmaId GERCEK varligi yansitir', () => {
  // Kanonik sozlesmede WhoPays/KimOder YOKTUR → absent, UYDURULMAZ.
  const plain = WIRE.captureActualWire(finalizedRequest())
  assert.equal(plain.optionalContractFields.WhoPays.present, false)
  assert.equal(plain.optionalContractFields.WhoPays.runtimeType, 'absent')
  assert.equal(plain.optionalContractFields.KimOder.present, false)
  assert.equal(plain.presence.FirmaId.present, false)
  assert.equal(plain.presence.KapidanOdemeTutari.present, false)

  // GERCEKTEN varsa dogru raporlanir.
  const withFields = WIRE.captureActualWire(finalizedRequest({
    WhoPays: 3, KimOder: 1, FirmaId: '1537690944', KapidanOdemeTutari: 250,
  }))
  assert.equal(withFields.optionalContractFields.WhoPays.present, true)
  assert.equal(withFields.optionalContractFields.WhoPays.runtimeType, 'number')
  assert.equal(withFields.optionalContractFields.WhoPays.value, 3)
  assert.equal(withFields.presence.FirmaId.present, true)
  assert.equal(withFields.presence.FirmaId.runtimeType, 'string')
  // FirmaId DEGERI tasinmaz (hesap kimligi).
  assert.equal(
    JSON.stringify(withFields.presence).includes('1537690944'), false,
    'FirmaId degeri sizdi',
  )
  assert.equal(withFields.presence.KapidanOdemeTutari.runtimeType, 'number')
})

/* ═══ WIRE-8 — SIR ve PII SIZMAZ ══════════════════════════════════ */

test('WIRE-8: kimlik ve musteri verisi SIZMAZ', () => {
  const capture = WIRE.captureActualWire(finalizedRequest())
  const serialized = JSON.stringify(capture)
  for (const secret of [
    'tenant-secret',      // parola
    '1234562622',         // ham kullanici adi
    'Ad Soyad',           // alici adi
    'Gizli adres',        // adres
    'gizli@example.invalid', // e-posta
  ]) {
    assert.equal(
      serialized.includes(secret), false,
      `yakalamada sizinti: ${secret}`,
    )
  }
  // Alan ADLARI gorunur (sozlesme denetimi), DEGERLERI degil.
  assert.equal(capture.gonderiFieldTypes.AliciAdresi, 'string')
  assert.equal(capture.gonderiFieldTypes.Email, 'string')
  // Parola yalniz VARLIK.
  assert.equal(capture.credential.sifrePresent, true)
  assert.equal(Object.prototype.hasOwnProperty.call(capture.credential, 'sifre'), false)
})

/* ═══ WIRE-9 — AYRIŞTIRMA PATLASA DA İZ AYNI ══════════════════════ */

test('WIRE-9: tasiyici ayristirma hatasi AYNI ize bagli kalir', () => {
  const live = stripComments(ADAPTER)
  // Firlatma dalinda da ACTUAL_WIRE asamasi KORUNUR.
  const catchAt = live.indexOf('catch (carrierError)')
  assert.ok(catchAt > 0)
  const region = live.slice(catchAt, catchAt + 2000)
  assert.match(region, /appendActualWireStage\(traceAttempt, actualWire/)
  // Bilinen satici hatasi SINIFLANDIRILIR.
  assert.match(region, /SURAT_CANONICAL_VENDOR_ERROR/)
  assert.match(live, /function isCanonicalVendorError/)
})

test('WIRE-9b: satici hata imzasi TANINIR', () => {
  const live = stripComments(ADAPTER)
  assert.match(live, /text\.includes\('KargoBarkod'\)/)
  assert.match(live, /text\.includes\('OrtakBarkodOlusturSonuc'\)/)
})

/* ═══ WIRE-13 — BLOKLU ÖN KONTROLDE SAHTE AŞAMA YOK ═══════════════ */

test('WIRE-13: bloklu on kontrol SAHTE ACTUAL_WIRE_READY uretmez', () => {
  // Anlik goruntu YOKSA asama EKLENMEZ.
  const live = stripComments(ADAPTER)
  assert.match(live, /if \(!capture\) return attempt/)
  // Preflight blok dalinda ACTUAL_WIRE_READY YOKTUR.
  const blockedAt = live.indexOf("outcome: 'BLOCKED_BY_PREFLIGHT'")
  assert.ok(blockedAt > 0)
  const region = live.slice(Math.max(0, blockedAt - 1500), blockedAt + 500)
  assert.equal(
    /ACTUAL_WIRE_READY/.test(region), false,
    'bloklu denemeye sahte tel asamasi eklenmis',
  )
  assert.match(region, /carrierCalled: false/)
})

test('WIRE-13b: bos/gecersiz govde COKMEZ', () => {
  for (const body of [null, undefined, {}, { Gonderi: null }]) {
    const capture = WIRE.captureActualWire(body)
    assert.equal(typeof capture.rootRuntimeType, 'string')
    assert.equal(capture.credential.kullaniciAdiPresent, false)
  }
})

/* ═══ WIRE-11/12 — KURGU ve İSTEMCİ ETKİLEYEMEZ ══════════════════ */

test('WIRE-11: legacy debug gercek teli KIRLETEMEZ', () => {
  // Yakalama TEK girdi alir: nihai govde. Baska parametre YOK.
  const src = stripComments(read('shipments', 'suratActualWireCapture.ts'))
  assert.match(src, /export function captureActualWire\(\s*request/)
  // Uretimdeki legacy degerler yakalamaya GIREMEZ.
  const capture = WIRE.captureActualWire(finalizedRequest())
  assert.notEqual(capture.safeValues.ReferansNo, '7270036062402465')
})

test('WIRE-12: istemci kimligi gercek teli DEGISTIREMEZ', () => {
  const server = stripComments(read('index.mjs'))
  // Kimlik kiraci deposundan; istek govdesinden DEGIL.
  assert.match(server, /normalizeAuthoritativeSuratStore\(tenantIntegration\?\.surat\)/)
  assert.match(server, /storedSuratConfig: authoritativeSuratStore/)
  assert.equal(
    /storedSuratConfig:\s*request\.body/.test(server), false,
    'istek govdesi kimlik kaynagi oldu',
  )
  // Adaptor kimlik degerini ANLIK GORUNTUDEN alir.
  const live = stripComments(ADAPTER)
  assert.match(live, /kullaniciAdi: snapshot\.kullaniciAdi/)
  assert.equal(
    live.includes('resolveCanonicalTenantSuratAccount(params.config'), false,
    'ikinci kimlik cozumlemesi geri geldi',
  )
})

/* ═══ WIRE-10 — YANIT İZİ ve YENİDEN OKUMA ════════════════════════ */

test('WIRE-10: yanit izi gerekli alanlari TASIR', () => {
  const live = stripComments(ADAPTER)
  const at = live.indexOf("stage: 'CARRIER_RESPONSE'")
  assert.ok(at > 0, 'CARRIER_RESPONSE asamasi yok')
  const region = live.slice(at, at + 1400)
  for (const field of [
    'carrierCalled', 'createCallCount', 'businessResult',
    'carrierCode', 'carrierMessage',
    'trackingPresent', 'barcodePresent', 'zplPresent', 'zplLength',
    'responseBodyType', 'verificationStage',
  ]) {
    assert.ok(region.includes(field), `yanit izinde eksik alan: ${field}`)
  }
  // CARRIER_CALL_STARTED asamasi da var.
  assert.match(live, /stage: 'CARRIER_CALL_STARTED'/)
})

test('WIRE-10b: ZPL uzunlugu GERCEK artefakttan turer, icerik TASINMAZ', () => {
  const live = stripComments(ADAPTER)
  assert.match(live, /function canonicalZplLength/)
  // Uydurma `result.zpl` alani OKUNMAZ.
  assert.equal(
    /result\.zpl\b/.test(live), false,
    'var olmayan result.zpl alani okunuyor',
  )
  // Icerik degil UZUNLUK.
  assert.match(live, /zplLength: canonicalZplLength\(result\.barcode\)/)
})

test('WIRE-10c: iz kalicilastirma sozlesmesi KORUNUR (reload)', async () => {
  // Kalicilastirma yolu ayri testle kanitli; burada BAGLANTI dogrulanir.
  const server = stripComments(read('index.mjs'))
  assert.match(server, /withSuratTracePersistence\(createSuratShipment\)/)
  assert.match(server, /repository\.persistTraceAttempt\(/)
  // Basari VE basarisizlik yollarinin ikisi de yanit sinirindan gecer.
  const at = server.indexOf('const withSuratTracePersistence')
  const region = server.slice(at, at + 900)
  assert.match(region, /if \(pending\) await pending/)
})
