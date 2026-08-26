import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// ═══ KANONİK BARKOD UÇTAN UCA REGRESYON ══════════════════════════════════
//
// ÜRETİM REGRESYONU: kiracı (TarzimTuba) kayıtlı olarak `SURAT_CANONICAL_API`
// seçmiştir — Sürat entegrasyon ekibinin bu müşteri için verdiği RESMÎ servis
// (api02 · POST /api/OrtakBarkodOlustur). `bfcf7b8` bu seçimi ÇALIŞMA
// ZAMANINDA `ORTAK_BARKOD_SOAP` + `serviceType='OrtakBarkodOlusturSoap'`
// olarak yeniden yazıyordu. Sonuç:
//
//   · resmî kanonik dal HİÇ ULAŞILMAZ oldu,
//   · yazılan `serviceType` `labelOnlyChain`'i tetikleyip legacy İKİ ÇAĞRILI
//     zinciri (GonderiyiKargoyaGonder → SOAP OrtakBarkodOlustur) seçti,
//   · sonraki tüm "düzeltmeler" o zincirin hasar kontrolü oldu.
//
// Bu test GERÇEK orkestrasyonu çalıştırır; YALNIZ Sürat HTTP sınırı taklit
// edilir. Canlı paket TÜKETİLMEZ.

const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')
const SNAPSHOT = await import('./shipments/suratCredentialSnapshot.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')
const ROUTE = await import('./shipments/suratPrimaryCreateRoute.ts')
const MODE = await import('./shipments/suratCanonicalServiceMode.mjs')

const INDEX_SOURCE = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')

const STORE = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: 'PRIMARY_CARI', liveSifre: 'PRIMARY_SECRET',
  sellerPaysKullaniciAdi: 'SELLER_CARI', sellerPaysSifre: 'SELLER_SECRET',
  codKullaniciAdi: 'COD_CARI', codSifre: 'COD_SECRET',
}

// Sentetik — canlı paket DEĞİL.
const ORDER = {
  marketplace: 'Trendyol',
  orderNumber: '11900000001', packageId: '4190000001',
  cargoTrackingNumber: '7270099999999999',
  customerName: 'Test Alici', address: 'Ornek Mah 1',
  city: 'Istanbul', district: 'Kadikoy', customerPhone: '5551112233',
  desi: 2, items: [{ productName: 'Urun', quantity: 1 }],
}

const CARRIER_OK = {
  isError: false, Message: '013', KargoTakipNo: '24446119471462',
  Barcode: ['^XA^FO50,50^A0N,40,40^FDT^FS^XZ'], BarcodeNo: ['01249704068'],
}

/** GERÇEK zinciri çalıştırır; yalnız `fetch` taklit edilir. */
async function runCanonicalCreate({ rawOrder = {}, cashOnDelivery = false } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true, status: 200, json: async () => CARRIER_OK, text: async () => '',
    }
  }
  try {
    const order = { ...ORDER, rawOrder }
    // Yönlendirme kararı GERÇEK çözücüden gelir — kopya mantık YOK.
    const billingV2 = ROUTING.resolveBillingPartyV2(rawOrder)
    // `expectedSuratWhoPays` GERÇEK üretim eşlemesidir (kanonik adaptör de
    // aynı fonksiyonu kullanır); testte kopyası ÜRETİLMEZ.
    const billing = {
      ...billingV2,
      expectedSuratWhoPays:
        ROUTING.expectedSuratWhoPays(billingV2.billingParty),
    }
    const role = ROUTING.resolveSuratCredentialContext({
      config: STORE,
      billingParty: billing.billingParty,
      cod: ROUTING.resolveCodContext({ enabled: cashOnDelivery }),
      codPolicy: ROUTING.resolveCodCredentialPolicy(STORE.codCredentialPolicy),
    }).role
    const credentialSnapshot = SNAPSHOT.buildSuratCredentialSnapshot({
      storedSuratConfig: STORE, role,
    })
    const result = await ADAPTER.createCanonicalSuratShipmentForRequest({
      organizationId: 'org-canonical-1',
      credentialSnapshot, config: STORE, order,
      reference: ORDER.packageId, cashOnDelivery,
    })
    const body = calls[0] ? JSON.parse(String(calls[0].init?.body ?? '{}')) : {}
    return { result, calls, body, role, billing }
  } finally {
    globalThis.fetch = original
  }
}

/* ═══ SURAT-CANONICAL-BARCODE-E2E-REGRESSION-1 ═════════════════════ */

test('SURAT-CANONICAL-BARCODE-E2E-REGRESSION-1', async () => {
  // ── KAYITLI MOD ÇALIŞMA ZAMANINDA KORUNUR ───────────────────────────
  const route = ROUTE.resolveSuratPrimaryCreateRoute({
    configuredServiceMode: 'SURAT_CANONICAL_API', marketplace: 'Trendyol',
  })
  assert.equal(route.serviceMode, 'SURAT_CANONICAL_API', 'kayitli mod EZILDI')
  assert.equal(route.soapPrimarySelected, false)
  assert.equal(route.overrodeConfiguredMode, false)
  assert.equal(MODE.SURAT_CANONICAL_SERVICE_MODE, 'SURAT_CANONICAL_API')

  const { result, calls, body, role } = await runCanonicalCreate()

  // ── AĞ: TAM OLARAK BİR KANONİK ÇAĞRI ────────────────────────────────
  assert.equal(calls.length, 1, 'kanonik create TEK cagri OLMALI')
  const url = calls[0].url
  assert.ok(url.startsWith('https://api02.suratkargo.com.tr/'), url)
  assert.ok(url.endsWith('/api/OrtakBarkodOlustur'), url)
  assert.equal(String(calls[0].init?.method ?? '').toUpperCase(), 'POST')

  // ── LEGACY ZİNCİR TAMAMEN YOK ───────────────────────────────────────
  const allUrls = calls.map((c) => c.url).join(' ')
  const allBodies = calls.map((c) => String(c.init?.body ?? '')).join(' ')
  assert.equal(allUrls.includes('GonderiyiKargoyaGonder'), false)
  assert.equal(allBodies.includes('GonderiyiKargoyaGonder'), false)
  assert.equal(allUrls.includes('KargoTakipHareketDetayi'), false)
  assert.equal(allBodies.includes('KargoTakipHareketDetayi'), false)
  assert.equal(allBodies.includes('soap'), false)
  assert.equal(allBodies.includes('Envelope'), false)

  // ── FATURALAMA / KİMLİK ─────────────────────────────────────────────
  assert.equal(role, 'PRIMARY_MARKETPLACE')
  assert.equal(body.KullaniciAdi, 'PRIMARY_CARI')
  // SATICI-ÖDER kimliği normal gönderiyi ELE GEÇİREMEZ.
  assert.equal(body.KullaniciAdi === 'SELLER_CARI', false)
  assert.equal(String(calls[0].init?.body).includes('SELLER_'), false)

  // ── PAZARYERİ FATURALAMA BAĞLAMI ────────────────────────────────────
  assert.equal(body.Gonderi.Pazaryerimi, 1)
  assert.equal(body.Gonderi.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(body.Gonderi.ReferansNo, ORDER.packageId)
  assert.equal(body.Gonderi.OzelKargoTakipNo, ORDER.cargoTrackingNumber)
  assert.equal(body.Gonderi.OdemeTipi, 1)

  // ── YASAKLI ALANLAR TELDE YOK ───────────────────────────────────────
  // İş kuralı olarak WhoPays KORUNUR; kanonik sözleşmede ALAN YOKTUR.
  for (const forbidden of [
    'WhoPays', 'KimOder', 'Price', 'Tarife', 'TarifeId', 'ContractPrice',
    'EntegrasyonSozlesme',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(body.Gonderi, forbidden), false,
      `${forbidden} kanonik telde BULUNMAMALI`,
    )
  }

  // ── SONUÇ: BARKOD + ZPL + YAZDIRILABİLİR ────────────────────────────
  assert.equal(result.ok, true)
  assert.equal(result.serviceType, 'SuratCanonicalWebApi')
  assert.equal(result.operationName, 'OrtakBarkodOlustur')
  assert.equal(result.canonicalCreate.host, 'api02.suratkargo.com.tr')
  assert.equal(result.canonicalCreate.carrierCreateStatus, 'SUCCESS')
  assert.equal(result.canonicalCreate.carrierCreateAttempts, 1)
  assert.equal(result.canonicalCreate.printArtifactStatus, 'RESOLVED')
  assert.equal(result.canonicalCreate.artifactDetectedFormat, 'ZPL')
  assert.ok(result.canonicalCreate.barcodeNoCount > 0, 'barkod YOK')
  assert.equal(result.shipment.printEnabled, true)
  assert.equal(result.shipment.trackingNumber, '24446119471462')
})

/* ═══ BILLING-E2E — WHOPAYS İŞ MANTIĞI KORUNUR ═════════════════════ */

test('BILLING-E2E-1/2: TRENDYOL_PAYS birincil pazaryeri kimligini kullanir', async () => {
  const { billing, role, body } = await runCanonicalCreate()
  assert.equal(billing.billingParty, 'TRENDYOL_PAYS')
  assert.equal(billing.expectedSuratWhoPays, '3')
  assert.equal(role, 'PRIMARY_MARKETPLACE')
  // BILLING-E2E-2 — satici kimligine ASLA ulasmaz.
  assert.equal(body.KullaniciAdi, 'PRIMARY_CARI')
  assert.notEqual(body.KullaniciAdi, 'SELLER_CARI')
})

test('BILLING-E2E-3/4: SELLER_PAYS AYRI faturalama kimligi kullanir', async () => {
  const { billing, role, body } = await runCanonicalCreate({
    rawOrder: { whoPays: 1 },
  })
  assert.equal(billing.billingParty, 'SELLER_PAYS')
  assert.equal(billing.expectedSuratWhoPays, '1')
  assert.equal(role, 'SELLER_PAYS')
  assert.equal(body.KullaniciAdi, 'SELLER_CARI')

  // BILLING-E2E-4 — iki karar telde AYIRT EDILEBILIR olmali. Kanonik
  // sozlesmede WhoPays alani YOK; ayrim FATURALAMA KIMLIGI (cari) uzerinden
  // yapilir. Ayni cari cikarsa Surat dogru tarafa faturalayamaz.
  const trendyol = await runCanonicalCreate()
  assert.notEqual(
    body.KullaniciAdi, trendyol.body.KullaniciAdi,
    'TRENDYOL_PAYS ve SELLER_PAYS faturalama acisindan AYNI istegi uretiyor',
  )
})

test('BILLING-E2E-5: OdemeTipi WhoPays yerine GECMEZ', async () => {
  const trendyol = await runCanonicalCreate()
  const seller = await runCanonicalCreate({ rawOrder: { whoPays: 1 } })
  // Iki taraf da OdemeTipi=1 gonderir; yani OdemeTipi faturalama tarafini
  // AYIRT ETMEZ ve "OdemeTipi=1 demek Trendyol oduyor" cikarimi GECERSIZDIR.
  assert.equal(trendyol.body.Gonderi.OdemeTipi, 1)
  assert.equal(seller.body.Gonderi.OdemeTipi, 1)
  assert.notEqual(
    trendyol.billing.billingParty, seller.billing.billingParty,
    'ayni OdemeTipi farkli faturalama tarafi ile birlikte VAR OLABILMELI',
  )
})

test('BILLING-E2E-6: COD ayri eksendir, faturalama tarafini DEGISTIRMEZ', async () => {
  const { billing } = await runCanonicalCreate({ cashOnDelivery: true })
  // COD acik olsa da faturalama tarafi hala Trendyol'dur.
  assert.equal(billing.billingParty, 'TRENDYOL_PAYS')
  assert.equal(billing.expectedSuratWhoPays, '3')
})

test('BILLING-E2E-7: tek tiklama ikinci bir gonderi URETEMEZ', async () => {
  const { calls } = await runCanonicalCreate()
  assert.equal(calls.length, 1)
  // Kanonik zincirde ikinci create dali YOKTUR.
  assert.equal(
    calls.filter((c) => c.url.includes('OrtakBarkodOlustur')).length, 1,
  )
})

/* ═══ SUNUCU GERÇEKTEN BU YOLU KULLANIYOR ══════════════════════════ */

test('E2E-WIRING: index.mjs kayitli modu calisma zamaninda EZMEZ', () => {
  // Rota cozucusu hala VAR (gercekten ORTAK_BARKOD_SOAP secmis kiracilar
  // icin), ama artik hicbir kayitli modu degistiremez.
  assert.deepEqual([...ROUTE.SOAP_PRIMARY_REPLACEABLE_MODES], [])
  for (const mode of [
    'SURAT_CANONICAL_API', 'PRE_REGISTRATION_REST', 'GONDERI_YENI_SOAP',
    'ORTAK_BARKOD_SOAP', 'KARGO_BARKODU_SIPARIS_SOAP',
  ]) {
    const route = ROUTE.resolveSuratPrimaryCreateRoute({
      configuredServiceMode: mode, marketplace: 'Trendyol',
    })
    assert.equal(route.serviceMode, mode, `${mode} calisma zamaninda EZILDI`)
    assert.equal(route.soapPrimarySelected, false)
  }
  // Kanonik dal create zincirinde DURUYOR.
  assert.match(INDEX_SOURCE, /config\.serviceMode === SURAT_CANONICAL_SERVICE_MODE/)
  assert.match(INDEX_SOURCE, /createCanonicalSuratShipmentForRequest/)
})

/* ═══ CONTRACT-IADEMI-1 — ZORUNLU ALAN TİPİ ════════════════════════ */

test('CONTRACT-IADEMI-1: telde giden tipler CANLI SOZLESMEYE uyar', async () => {
  // TEK OTORITE: api02'nin canli OpenAPI 3 sozlesmesi
  // (docs/contracts/surat-web-api-swagger-v2.json).
  //
  //   GonderiModel.Iademi = {"type":"boolean"}
  //
  // DUZELTME NOTU: bu test kisa sure `Iademi`'nin SAYISAL olmasini sart
  // kosuyordu; gerekce 2024 tarihli `GonderiyiKargoyaGonder` PDF'iydi. O PDF
  // farkli bir urune aittir ve bu ucu BAGLAMAZ. Canli sozlesme boolean der.
  const { body, calls } = await runCanonicalCreate()
  const raw = String(calls[0].init?.body ?? '')

  assert.equal(typeof body.Gonderi.Iademi, 'boolean')
  assert.equal(raw.includes('"Iademi":false'), true)

  for (const key of [
    'KargoTuru', 'OdemeTipi', 'Adet', 'KapidanOdemeTahsilatTipi',
    'TasimaSekli', 'TeslimSekli', 'GonderiSekli', 'Pazaryerimi',
  ]) {
    assert.equal(typeof body.Gonderi[key], 'number', `${key} sayisal OLMALI`)
  }
  for (const key of ['BirimDesi', 'BirimKg', 'ReferansNo', 'OzelKargoTakipNo']) {
    assert.equal(typeof body.Gonderi[key], 'string', `${key} string OLMALI`)
  }
  // Boş string / null KAÇAĞI YOK: builder opsiyonel alanları ATLAR.
  for (const [key, value] of Object.entries(body.Gonderi)) {
    assert.notEqual(value, '', `${key} bos string gonderiyor`)
    assert.notEqual(value, null, `${key} null gonderiyor`)
  }
})
