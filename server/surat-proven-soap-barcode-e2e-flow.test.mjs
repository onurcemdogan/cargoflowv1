import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ TRENDYOL × SÜRAT — KANITLANMIŞ SOAP BARKOD TAŞIMASI ═════════════════
//
// SEÇİM GEREKÇESİ (tek gerçek üretim kanıtı):
//   host       webservices.suratkargo.com.tr/services.asmx
//   protokol   SOAP/XML
//   operasyon  OrtakBarkodOlustur · serviceType OrtakBarkodOlusturSoap
//   sonuç      013 · gerçek barkod · 2049 baytlık gerçek ZPL · yazdırıldı
//   çağrı      1
//
// KANONİK REST AİLESİ KAPANDI — iki kontrollü canlı deneme, barkod YOK:
//   4104179900 · POST /api/OrtakBarkodOlustur → String → KargoBarkod
//   4105268542 · POST /api/PazaryeriGonderi   → "Result is null!"
//
// Bu bir FALLBACK DEĞİLDİR: Trendyol pazaryeri akışı için BİRİNCİL taşımadır.
// Ağ SINIRI taklit edilir; canlı paket TÜKETİLMEZ.

const SOAP = await import('./shipments/suratSoapPrimaryCreate.ts')
const SNAP = await import('./shipments/suratCredentialSnapshot.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')
const MODEL = await import('./shipments/suratCanonicalGonderiModel.ts')
const TRANSPORT = await import('./shipments/suratLabelTransportRoute.ts')

const here = new URL('.', import.meta.url)
const INDEX_SOURCE = readFileSync(new URL('./index.mjs', here), 'utf8')

/** 2026-07-16 üretim koşusunun GERÇEK ZPL'i (PII redakte, uzunluk korunmuş). */
const REAL_ZPL = readFileSync(
  new URL('./fixtures/surat-real-success-11415535074.zpl', here), 'utf8',
)

const TENANT_STORE = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: '1537690944', liveSifre: 'TENANT_SECRET',
  sellerPaysKullaniciAdi: 'SELLER_CARI', sellerPaysSifre: 'SELLER_SECRET',
}

const snapshotFor = (role) => SNAP.buildSuratCredentialSnapshot({
  storedSuratConfig: SNAP.normalizeAuthoritativeSuratStore(TENANT_STORE),
  role,
})

let clock = 0
const stamp = () => `2026-08-26T09:00:${String(clock++).padStart(2, '0')}.000Z`

const ENVELOPE = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <OrtakBarkodOlustur xmlns="http://tempuri.org/">
      <KullaniciAdi>1537690944</KullaniciAdi>
      <Sifre>TENANT_SECRET</Sifre>
      <Gonderi>
        <KisiKurum>Test Alici</KisiKurum>
        <AliciAdresi>Ornek Mah. 1</AliciAdresi>
        <Il>Istanbul</Il>
        <Ilce>Kadikoy</Ilce>
        <TelefonCep>5551112233</TelefonCep>
        <KargoTuru>3</KargoTuru>
        <OdemeTipi>1</OdemeTipi>
        <ReferansNo>4190000001</ReferansNo>
        <OzelKargoTakipNo>7270099999999999</OzelKargoTakipNo>
        <Adet>1</Adet>
        <BirimDesi>2</BirimDesi>
        <BirimKg>2</BirimKg>
        <KapidanOdemeTahsilatTipi>0</KapidanOdemeTahsilatTipi>
        <TasimaSekli>1</TasimaSekli>
        <TeslimSekli>1</TeslimSekli>
        <GonderiSekli>0</GonderiSekli>
        <Pazaryerimi>1</Pazaryerimi>
        <EntegrasyonFirmasi>Trendyol</EntegrasyonFirmasi>
        <Iademi>0</Iademi>
      </Gonderi>
    </OrtakBarkodOlustur>
  </soap:Body>
</soap:Envelope>`

/** TARİHSEL BAŞARIYLA aynı biçimde yürütme sonucu. */
const provenExecution = () => ({
  ok: true,
  carrierCalled: true,
  networkCrossed: true,
  businessCode: '013',
  zpl: REAL_ZPL,
  barcode: 'Web00157962154',
  trackingNumber: '24446119471462',
  verifiedShipment: true,
  operationName: 'OrtakBarkodOlustur',
  serviceType: 'OrtakBarkodOlusturSoap',
})

async function runProvenSoap({ role = 'PRIMARY_MARKETPLACE' } = {}) {
  const calls = []
  const outcome = await SOAP.createSuratSoapPrimaryShipment({
    traceId: 'CF-PROVEN-SOAP-1',
    stamp,
    credentialSnapshot: snapshotFor(role),
    financialContext: {
      billingParty: 'TRENDYOL_PAYS', expectedSuratWhoPays: '3',
      odemeTipi: 1, codEnabled: false,
      pazaryerimi: 1, entegrasyonFirmasi: 'Trendyol',
    },
    marketplace: 'Trendyol',
    wireAccountPreview: '1537690944',
    credentialRecordIdentity: {
      organizationIdMasked: '****f4ad', integrationIdMasked: '****8c4f',
    },
    executeCreate: async ({ onWireReady }) => {
      calls.push('soap')
      onWireReady(ENVELOPE)
      return provenExecution()
    },
  })
  return { outcome, calls }
}

/* ═══ TRENDYOL_SURAT_PROVEN_SOAP_BARCODE_E2E ═══════════════════════ */

test('TRENDYOL_SURAT_PROVEN_SOAP_BARCODE_E2E', async () => {
  const { outcome, calls } = await runProvenSoap()

  // ── TAM OLARAK BİR MUTASYON ÇAĞRISI ─────────────────────────────────
  assert.equal(calls.length, 1, 'TEK SOAP cagrisi OLMALI')
  assert.equal(outcome.carrierCreateAttempts, 1)

  // ── GERÇEK BARKOD + GERÇEK ZPL ──────────────────────────────────────
  const stages = outcome.traceAttempt.stages
  const response = stages.find((entry) => entry.stage === 'CARRIER_RESPONSE')
  assert.ok(response, 'CARRIER_RESPONSE asamasi OLMALI')
  assert.equal(response.data.barcodePresent, true)
  assert.equal(response.data.zplPresent, true)
  assert.equal(response.data.zplLength, REAL_ZPL.length)
  assert.equal(REAL_ZPL.length, 2049)

  // ── TRACE V2 TAŞIMA GERÇEĞİ ─────────────────────────────────────────
  const wire = stages.find((entry) => entry.stage === 'ACTUAL_WIRE_READY')
  assert.ok(wire, 'ACTUAL_WIRE_READY OLMALI')
  assert.equal(wire.data.operation, 'OrtakBarkodOlustur')
  assert.equal(wire.data.credentialFingerprintMatch, true)
  assert.ok(stages.some((entry) => entry.stage === 'CARRIER_CALL_STARTED'))
  // Kimlik telde: paket ve takip numarasi AYRI alanlarda.
  assert.equal(wire.data.safeValues.ReferansNo, '4190000001')
  assert.equal(wire.data.safeValues.OzelKargoTakipNo, '7270099999999999')
  assert.equal(wire.data.safeValues.Pazaryerimi, '1')
  assert.equal(wire.data.safeValues.EntegrasyonFirmasi, 'Trendyol')
})

/* ═══ DİSPATCH: KANONİK TRENDYOL → KANITLANMIŞ SOAP ════════════════ */

test('SOAP-PROVEN-1: kanonik Trendyol dali SOAP tasimasini secer', () => {
  const at = INDEX_SOURCE.indexOf(
    'if (usesProvenSoapLabelTransport({',
  )
  assert.ok(at > 0, 'Trendyol pazaryeri dali OLMALI')
  const block = INDEX_SOURCE.slice(
    at, INDEX_SOURCE.indexOf('const { createCanonicalSuratShipmentForRequest }', at),
  )
  assert.ok(block.includes('createSuratSoapPrimaryShipment'))
  assert.ok(block.includes("operationName: 'OrtakBarkodOlustur'"))
  assert.ok(block.includes("serviceType: 'OrtakBarkodOlusturSoap'"))
  // TEK cagri.
  assert.equal(
    (block.match(/createSuratCommonBarcodeSoap\(/g) ?? []).length, 1,
  )
})

test('SOAP-PROVEN-2: bu dalda REST/kayit/zincir YOKTUR', () => {
  const at = INDEX_SOURCE.indexOf(
    'if (usesProvenSoapLabelTransport({',
  )
  const block = INDEX_SOURCE.slice(
    at, INDEX_SOURCE.indexOf('const { createCanonicalSuratShipmentForRequest }', at),
  )
  for (const forbidden of [
    'createSuratRegisteredCommonBarcode', // kayit → dogrulama → SOAP zinciri
    'labelOnlyChain',                     // servis stringinden zincir cikarimi
    'createSuratLegacyRestJson',          // legacy REST kaydi
    'createCanonicalSuratShipmentForRequest', // kanonik REST
    'KargoTakipHareketDetayi',            // kayit dogrulama
  ]) {
    assert.equal(block.includes(forbidden), false, `yasak: ${forbidden}`)
  }
})

test('SOAP-PROVEN-3: pazaryeri OLMAYAN gonderi kanonik REST te KALIR', () => {
  // Degisiklik YALNIZ Trendyol icindir; digerleri icin uretim kaniti YOK.
  // Karar TEK OTORITEDEDIR: `suratLabelTransportRoute.ts`. Denetci de AYNI
  // fonksiyonu cagirir; satir ici kopya YOKTUR.
  assert.ok(INDEX_SOURCE.includes('suratLabelTransportRoute.ts'))
  assert.equal(INDEX_SOURCE.includes('function isTrendyolMarketplaceOrder'), false)
  assert.ok(INDEX_SOURCE.includes('createCanonicalSuratShipmentForRequest'))
})

/* ═══ FATURALAMA KORUNDU ═══════════════════════════════════════════ */

test('SOAP-PROVEN-4: WhoPays ve kimlik izolasyonu DEGISMEDI', () => {
  const trendyol = ROUTING.resolveBillingPartyV2({})
  assert.equal(trendyol.billingParty, 'TRENDYOL_PAYS')
  assert.equal(ROUTING.expectedSuratWhoPays('TRENDYOL_PAYS'), '3')

  const seller = ROUTING.resolveBillingPartyV2({ whoPays: 1 })
  assert.equal(seller.billingParty, 'SELLER_PAYS')
  assert.equal(ROUTING.expectedSuratWhoPays('SELLER_PAYS'), '1')

  const roleFor = (billingParty) => ROUTING.resolveSuratCredentialContext({
    config: TENANT_STORE, billingParty,
    cod: ROUTING.resolveCodContext({ enabled: false }),
    codPolicy: ROUTING.resolveCodCredentialPolicy(),
  }).role
  assert.equal(roleFor('TRENDYOL_PAYS'), 'PRIMARY_MARKETPLACE')
  assert.equal(roleFor('SELLER_PAYS'), 'SELLER_PAYS')
  // Iki taraf AYNI kimlige COKMEZ.
  assert.notEqual(
    snapshotFor('PRIMARY_MARKETPLACE').accountFingerprint,
    snapshotFor('SELLER_PAYS').accountFingerprint,
  )
})

test('SOAP-PROVEN-5: SOAP uygun pazaryeri kayit defteriyle AYNI', () => {
  // Karar TEK OTORITEDEDIR; index.mjs artik satir ici sabit TUTMAZ.
  // Uygun pazaryeri adi, model kayit defteriyle AYNI olmali — aksi halde
  // Trendyol siparisleri sessizce kanonik REST'e duserdi.
  assert.deepEqual([...TRANSPORT.SURAT_SOAP_LABEL_MARKETPLACES], ['trendyol'])
  assert.equal(
    MODEL.SURAT_MARKETPLACE_REGISTRY.TRENDYOL.entegrasyonFirmasi.toLowerCase(),
    TRANSPORT.SURAT_SOAP_LABEL_MARKETPLACES[0],
  )
  // Kanitlanmis uc degerleri de sabit.
  assert.equal(
    TRANSPORT.SURAT_SOAP_LABEL_HOST, 'webservices.suratkargo.com.tr/services.asmx',
  )
  assert.equal(TRANSPORT.SURAT_SOAP_LABEL_OPERATION, 'OrtakBarkodOlustur')
  assert.equal(TRANSPORT.SURAT_SOAP_LABEL_SERVICE_TYPE, 'OrtakBarkodOlusturSoap')

  // Trendyol + kanonik kayitli mod -> KANITLANMIS SOAP.
  const trendyol = TRANSPORT.resolveSuratLabelTransport({
    configuredServiceMode: 'SURAT_CANONICAL_API', marketplace: 'Trendyol',
  })
  assert.equal(trendyol.transport, 'SOAP')
  assert.equal(trendyol.effectiveHost, TRANSPORT.SURAT_SOAP_LABEL_HOST)
  // Pazaryeri OLMAYAN gonderi kanonik REST'te KALIR.
  const own = TRANSPORT.resolveSuratLabelTransport({
    configuredServiceMode: 'SURAT_CANONICAL_API', marketplace: '',
  })
  assert.equal(own.transport, 'CANONICAL_REST')
  // Karar ONCEKI SONUCU girdi olarak ALMAZ (geri dusus olamaz).
  assert.equal(TRANSPORT.resolveSuratLabelTransport.length, 1)
})

test('SOAP-PROVEN-6: yeni test test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  const orphans = onDisk.filter((f) => !listed.has(f))
  assert.deepEqual(orphans, [], `test:surat icinde OLMAYAN: ${orphans.join(', ')}`)
})
