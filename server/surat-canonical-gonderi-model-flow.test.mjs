import assert from 'node:assert/strict'
import test from 'node:test'

// SURAT WEB API KANONIK ALAN CEKIRDEGI — SOZLESME TESTLERI.
//
// Kaynak: Surat Kargo Web API OpenAPI 3.0.0, POST /api/OrtakBarkodOlustur
//   request  = OrtakBarkodOlusturParam { KullaniciAdi, Sifre, Gonderi }
//   Gonderi  = GonderiModel (31 alan)
// Ayni $ref /api/GonderiyiKargoyaGonder tarafindan da kullanilir.
//
// AG YOK. Bu paket yalniz saf fonksiyonlari dogrular; uretim create akisi
// bu unitede DEGISTIRILMEDI.

const M = await import('./shipments/suratCanonicalGonderiModel.ts')

/** Swagger GonderiModel alan kumesi (contract'tan birebir). */
const SWAGGER_FIELDS = [
  'KisiKurum', 'SahisBirim', 'AliciAdresi', 'Il', 'Ilce',
  'TelefonEv', 'TelefonIs', 'TelefonCep', 'Email', 'AliciKodu',
  'KargoTuru', 'OdemeTipi', 'IrsaliyeSeriNo', 'IrsaliyeSiraNo',
  'ReferansNo', 'OzelKargoTakipNo', 'Adet', 'BirimDesi', 'BirimKg',
  'KargoIcerigi', 'KapidanOdemeTahsilatTipi', 'KapidanOdemeTutari',
  'EkHizmetler', 'TasimaSekli', 'TeslimSekli', 'SevkAdresi',
  'GonderiSekli', 'TeslimSubeKodu', 'Pazaryerimi', 'EntegrasyonFirmasi',
  'Iademi',
]

const trendyolOrder = {
  marketplace: 'Trendyol',
  customerName: 'Test Alici',
  address: 'Ornek Mah. Ornek Cad. No 1',
  city: 'Istanbul',
  district: 'Kadikoy',
  customerPhone: '5551112233',
  customerEmail: 'alici@ornek.test',
  cargoTrackingNumber: '727TEST123',
  orderNumber: '1141234567',
  packageId: 'PKG-1',
}

const shipmentInput = (order, context, extra = {}) => ({
  order,
  context,
  referansNo: 'REF-1',
  adet: 1,
  birimDesi: '2',
  birimKg: '1.5',
  kargoIcerigi: 'CargoFlow gonderisi',
  ...extra,
})

// ═══ 1-2. ALAN KUMESI VE CASING ═══════════════════════════════════════════

test('CANON-1: kanonik alan listesi Swagger ile BIREBIR', () => {
  assert.deepEqual([...M.CANONICAL_GONDERI_FIELDS], SWAGGER_FIELDS)
})

test('CANON-2: uretilen model YALNIZ contract alanlarini tasir (casing dahil)', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  const model = M.buildSuratCanonicalGonderiModel(shipmentInput(trendyolOrder, ctx))
  for (const key of Object.keys(model)) {
    assert.ok(SWAGGER_FIELDS.includes(key), `contract disi alan: ${key}`)
  }
})

// ═══ 3. TIP SOZLESMESI ════════════════════════════════════════════════════

test('CANON-3: Pazaryerimi SAYIDIR ve tam sayi alanlari number', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  const model = M.buildSuratCanonicalGonderiModel(shipmentInput(trendyolOrder, ctx))
  assert.strictEqual(model.Pazaryerimi, 1)
  assert.equal(typeof model.Pazaryerimi, 'number')
  assert.notStrictEqual(model.Pazaryerimi, '1')
  for (const key of [
    'KargoTuru', 'OdemeTipi', 'Adet',
    'KapidanOdemeTahsilatTipi', 'TasimaSekli', 'TeslimSekli', 'GonderiSekli',
  ]) {
    assert.equal(typeof model[key], 'number', key)
  }
  // SOZLESME: `byte Iademi` — Enum(numerik), ZORUNLU (0/1). Resmi ornek
  // request `"Iademi": 0` gonderir. Bu satir eskiden `boolean` PINLIYORDU,
  // yani sozlesme ihlalini SART kosuyordu (CF-4104179900 denetimi).
  assert.equal(typeof model.Iademi, 'number')
  assert.equal(model.Iademi, 0)
  assert.equal(JSON.stringify(model).includes('"Iademi":false'), false)
  // Swagger'da string olanlar string kalir.
  assert.equal(typeof model.BirimDesi, 'string')
  assert.equal(typeof model.BirimKg, 'string')
})

// ═══ 4-6. TRENDYOL ════════════════════════════════════════════════════════

test('CANON-4: Trendyol faturalama baglami', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  assert.equal(ctx.isMarketplace, true)
  assert.equal(ctx.marketplace, 'TRENDYOL')
  assert.equal(ctx.pazaryerimi, 1)
  assert.equal(ctx.entegrasyonFirmasi, 'Trendyol')
  assert.equal(ctx.ozelKargoTakipNo, '727TEST123')
  assert.equal(M.validateSuratBillingContext(ctx).valid, true)
})

test('CANON-5: OzelKargoTakipNo YALNIZ gercek kargo no kaynagindan gelir', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  assert.equal(ctx.trackingSource, 'cargoTrackingNumber')
  const model = M.buildSuratCanonicalGonderiModel(shipmentInput(trendyolOrder, ctx))
  assert.equal(model.OzelKargoTakipNo, '727TEST123')
  // orderNumber / packageId / ReferansNo ASLA bu alana sizmaz.
  assert.notEqual(model.OzelKargoTakipNo, trendyolOrder.orderNumber)
  assert.notEqual(model.OzelKargoTakipNo, trendyolOrder.packageId)
  assert.notEqual(model.OzelKargoTakipNo, model.ReferansNo)
})

test('CANON-6: kargo no YOKSA fail-closed (fallback YOK)', () => {
  const ctx = M.resolveSuratMarketplaceContext({
    ...trendyolOrder,
    cargoTrackingNumber: '',
  })
  assert.equal(ctx.ozelKargoTakipNo, '')
  const v = M.validateSuratBillingContext(ctx)
  assert.equal(v.valid, false)
  assert.equal(v.errorCode, 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING')
})

// ═══ 7-9. DIGER PAZARYERLERI ══════════════════════════════════════════════

for (const [key, marketplace, firm] of [
  ['HEPSIBURADA', 'Hepsiburada', 'Hepsiburada'],
  ['IDEFIX', 'İdefix', 'İdefix'],
  ['PAZARAMA', 'Pazarama', 'Pazarama'],
]) {
  test(`CANON-7/8/9: ${key} eslemesi tanimli, kaynak YOKSA acikca bildirilir`, () => {
    assert.equal(M.SURAT_MARKETPLACE_REGISTRY[key].entegrasyonFirmasi, firm)
    const ctx = M.resolveSuratMarketplaceContext({ marketplace })
    assert.equal(ctx.marketplace, key)
    assert.equal(ctx.pazaryerimi, 1)
    assert.equal(ctx.entegrasyonFirmasi, firm)
    // CargoFlow'da bu pazaryeri icin dogrulanmis kargo-no kaynagi YOK.
    assert.equal(ctx.unresolvedReason, 'UNRESOLVED_MARKETPLACE_TRACKING_SOURCE')
    const v = M.validateSuratBillingContext(ctx)
    assert.equal(v.valid, false)
    assert.equal(v.errorCode, 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING')
  })
}

// ═══ 10-11. KENDI PLATFORM + GECERSIZ BAGLAM ══════════════════════════════

test('CANON-10: kendi platform gonderisi Pazaryerimi=0, EntegrasyonFirmasi=""', () => {
  const ctx = M.resolveSuratMarketplaceContext(
    { customerName: 'X' },
    { ownPlatformReference: 'CF-REF-001' },
  )
  assert.equal(ctx.isMarketplace, false)
  assert.strictEqual(ctx.pazaryerimi, 0)
  assert.strictEqual(ctx.entegrasyonFirmasi, '')
  assert.equal(ctx.ozelKargoTakipNo, 'CF-REF-001')
  assert.equal(M.validateSuratBillingContext(ctx).valid, true)
  const model = M.buildSuratCanonicalGonderiModel(
    shipmentInput({ customerName: 'X' }, ctx),
  )
  assert.strictEqual(model.Pazaryerimi, 0)
  // Bos string SEMANTIKTIR; atlanmaz.
  assert.strictEqual(model.EntegrasyonFirmasi, '')
  assert.ok('EntegrasyonFirmasi' in model)
})

test('CANON-11: gecersiz baglam reddedilir', () => {
  const noRef = M.resolveSuratMarketplaceContext({ customerName: 'X' })
  assert.equal(M.validateSuratBillingContext(noRef).valid, false)
  const broken = {
    isMarketplace: true, marketplace: 'TRENDYOL',
    pazaryerimi: 0, entegrasyonFirmasi: 'Trendyol',
    ozelKargoTakipNo: '727X', trackingSource: 'cargoTrackingNumber',
  }
  const v = M.validateSuratBillingContext(broken)
  assert.equal(v.valid, false)
  assert.equal(v.errorCode, 'SURAT_MARKETPLACE_BILLING_CONTEXT_INVALID')
})

// ═══ 12. CONTRACT DISI ALANLAR ════════════════════════════════════════════

test('CANON-12: contract disi ve fiyat alanlari URETILMEZ (structural)', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  const req = M.buildSuratOrtakBarkodRequest({
    credentials: { kullaniciAdi: 'TEST_CUSTOMER', sifre: 'TEST_SECRET' },
    shipment: shipmentInput(trendyolOrder, ctx),
  })
  // Uretilen NESNE uzerinde dogrudan kontrol — kaynak metni taranmaz.
  for (const field of M.FORBIDDEN_CANONICAL_FIELDS) {
    assert.equal(field in req.Gonderi, false, `Gonderi.${field} olmamali`)
    assert.equal(field in req, false, `root.${field} olmamali`)
  }
  // Legacy SOAP'tan tasinabilecek alanlar acikca YOK.
  assert.equal('WebSiparisKodu' in req.Gonderi, false)
  assert.equal('SatisKodu' in req.Gonderi, false)
  assert.equal('MarketplaceIntegrationCode' in req.Gonderi, false)
  assert.equal('CariKodu' in req.Gonderi, false)
  assert.equal('GonderenCariKodu' in req.Gonderi, false)
  // Uretilen alan kumesi Swagger kumesinin ALT KUMESIDIR.
  const produced = new Set(Object.keys(req.Gonderi))
  for (const key of produced) assert.ok(SWAGGER_FIELDS.includes(key), key)
})

// ═══ 13-14. KOK DTO + GOLDEN ══════════════════════════════════════════════

test('CANON-13: kok DTO KullaniciAdi/Sifre/Gonderi', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  const req = M.buildSuratOrtakBarkodRequest({
    credentials: { kullaniciAdi: 'TEST_CUSTOMER', sifre: 'TEST_SECRET' },
    shipment: shipmentInput(trendyolOrder, ctx),
  })
  assert.deepEqual(Object.keys(req), ['KullaniciAdi', 'Sifre', 'Gonderi'])
  assert.equal(req.KullaniciAdi, 'TEST_CUSTOMER')
  assert.equal(req.Sifre, 'TEST_SECRET')
})

test('CANON-14: GOLDEN Trendyol DTO', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  const req = M.buildSuratOrtakBarkodRequest({
    credentials: { kullaniciAdi: 'TEST_CUSTOMER', sifre: 'TEST_SECRET' },
    shipment: shipmentInput(trendyolOrder, ctx),
  })
  assert.deepEqual(req, {
    KullaniciAdi: 'TEST_CUSTOMER',
    Sifre: 'TEST_SECRET',
    Gonderi: {
      KisiKurum: 'Test Alici',
      AliciAdresi: 'Ornek Mah. Ornek Cad. No 1',
      Il: 'Istanbul',
      Ilce: 'Kadikoy',
      TelefonCep: '5551112233',
      Email: 'alici@ornek.test',
      KargoTuru: 3,
      OdemeTipi: 1,
      ReferansNo: 'REF-1',
      OzelKargoTakipNo: '727TEST123',
      Adet: 1,
      BirimDesi: '2',
      BirimKg: '1.5',
      KargoIcerigi: 'CargoFlow gonderisi',
      KapidanOdemeTahsilatTipi: 0,
      TasimaSekli: 1,
      TeslimSekli: 1,
      SevkAdresi: 'Test Alici',
      GonderiSekli: 0,
      Pazaryerimi: 1,
      EntegrasyonFirmasi: 'Trendyol',
      Iademi: 0,
    },
  })
  // Baska tenant kimligi SIZMAZ.
  assert.equal(JSON.stringify(req).includes('GonderenCariKodu'), false)
})

// ═══ 15. NULL / UNDEFINED STRATEJISI ══════════════════════════════════════

test('CANON-15: bos/tanimsiz alanlar ATLANIR (null doldurma YOK)', () => {
  const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
  const model = M.buildSuratCanonicalGonderiModel(shipmentInput(trendyolOrder, ctx))
  for (const key of ['SahisBirim', 'TelefonEv', 'TelefonIs', 'AliciKodu',
    'IrsaliyeSeriNo', 'IrsaliyeSiraNo', 'KapidanOdemeTutari',
    'EkHizmetler', 'TeslimSubeKodu']) {
    assert.equal(key in model, false, `${key} atlanmali`)
  }
  assert.equal(JSON.stringify(model).includes('null'), false, 'null uretilmemeli')
})

// ═══ IZOLASYON ════════════════════════════════════════════════════════════

test('CANON-ISOLATION: modul AG/ORTAM/CREDENTIAL DEPOSU bilmez', () => {
  // Saf domain: disari acilan API yalniz bu fonksiyonlardir.
  assert.equal(typeof M.resolveSuratMarketplaceContext, 'function')
  assert.equal(typeof M.validateSuratBillingContext, 'function')
  assert.equal(typeof M.buildSuratCanonicalGonderiModel, 'function')
  assert.equal(typeof M.buildSuratOrtakBarkodRequest, 'function')
  // Ag/ortam/host/credential-store yardimcisi EXPORT EDILMEZ.
  for (const forbidden of [
    'createClient', 'postOrtakBarkod', 'resolveBaseUrl', 'resolveHost',
    'loadCredentials', 'resolveTenantAccount',
  ]) {
    assert.equal(forbidden in M, false, forbidden)
  }
  // Credential YALNIZ cagiranin verdigi degerdir; global okuma YOK.
  const previous = process.env.SURAT_LIVE_KULLANICI_ADI
  process.env.SURAT_LIVE_KULLANICI_ADI = 'ENV_SHOULD_NOT_LEAK'
  try {
    const ctx = M.resolveSuratMarketplaceContext(trendyolOrder)
    const req = M.buildSuratOrtakBarkodRequest({
      credentials: { kullaniciAdi: 'TENANT_ONLY', sifre: 'TENANT_SECRET' },
      shipment: shipmentInput(trendyolOrder, ctx),
    })
    assert.equal(req.KullaniciAdi, 'TENANT_ONLY')
    assert.equal(JSON.stringify(req).includes('ENV_SHOULD_NOT_LEAK'), false)
  } finally {
    if (previous === undefined) delete process.env.SURAT_LIVE_KULLANICI_ADI
    else process.env.SURAT_LIVE_KULLANICI_ADI = previous
  }
})
