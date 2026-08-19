import assert from 'node:assert/strict'
import test from 'node:test'

// FAZ 5C.1 — FİNANSAL GUARD: HER BOZUK BAĞLAMDA TAŞIYICI ÇAĞRISI = 0.
//
// Bu paketin tek işi: yanlış faturalama üretebilecek her senaryoda GERÇEK
// ağ fonksiyonunun HİÇ çağrılmadığını saymakla kanıtlamak. Yanlış cariye
// yazılan bir gönderi geri alınamaz; bu yüzden guard fail-closed olmalı.

const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')

// KIMLIK ARTIK OTORITER ANLIK GORUNTUDEN gelir. Bu testler `config` ile KIRACI
// hesabini temsil ediyordu; ayni degerler artik KIRACI DEPOSU olarak anlik
// goruntuye verilir. Guard GEVSETILMEDI — yalniz kaynak duzeltildi.
const __SNAP = await import('./shipments/suratCredentialSnapshot.ts')
const __ROUTING = await import('./shipments/suratRoutingModel.ts')
const callCanonicalCreate = (p) =>
  ADAPTER.createCanonicalSuratShipmentForRequest({
    ...p,
    credentialSnapshot: __SNAP.buildSuratCredentialSnapshot({
      storedSuratConfig: p.config ?? {},
      role: __ROUTING.resolveSuratCredentialContext({
        config: p.config ?? {},
        billingParty: __ROUTING.resolveBillingPartyV2(
          p.order?.rawOrder ?? {},
        ).billingParty,
        cod: __ROUTING.resolveCodContext({
          enabled: p.cashOnDelivery === true,
          collectionType: p.config?.kapidanOdemeTahsilatTipi,
          amount: p.order?.cashOnDeliveryAmount,
        }),
        codPolicy: __ROUTING.resolveCodCredentialPolicy(
          p.config?.codCredentialPolicy,
        ),
      }).role,
    }),
  })

function installFetchSpy() {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const CONFIG = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: 'PRIMARY_1111',
  liveSifre: 'PRIMARY_SECRET',
  sellerPaysKullaniciAdi: 'SELLER_2222',
  sellerPaysSifre: 'SELLER_SECRET',
  codKullaniciAdi: 'COD_3333',
  codSifre: 'COD_SECRET',
}

const ORDER = {
  marketplace: 'Trendyol',
  orderNumber: '1141234567',
  packageId: 'PKG-1',
  cargoTrackingNumber: '7270035942963454',
  customerName: 'Ad Soyad',
  address: 'Adres 1',
  city: 'İstanbul',
  district: 'Kadıköy',
  customerPhone: '5551112233',
  desi: 2,
  items: [{ productName: 'Ürün', quantity: 1 }],
  rawOrder: {},
}

async function run(overrides = {}) {
  const spy = installFetchSpy()
  try {
    const result = await callCanonicalCreate({
      organizationId: 'org-A',
      config: { ...CONFIG, ...(overrides.config ?? {}) },
      order: { ...ORDER, ...(overrides.order ?? {}) },
      reference: 'PKG-1',
      cashOnDelivery: overrides.cashOnDelivery === true,
    })
    return { result, networkCalls: spy.calls.length }
  } finally {
    spy.restore()
  }
}

/* ═══ SAĞLIKLI TABAN ═══════════════════════════════════════════════════ */

test('GUARD-0: saglikli TRENDYOL_PAYS baglami GECER ve tasiyiciya gider', async () => {
  const { result, networkCalls } = await run()
  assert.equal(networkCalls, 1, 'saglikli baglamda create YAPILMALI')
  assert.equal(result.suratCreateTrace.billingParty, 'TRENDYOL_PAYS')
  assert.equal(result.suratCreateTrace.expectedSuratWhoPays, '3')
  assert.equal(result.suratCreateTrace.credentialRole, 'PRIMARY_MARKETPLACE')
  assert.equal(result.suratCreateTrace.odemeTipi, '1')
  assert.equal(result.suratCreateTrace.odemeTipiMeaning, 'PESIN')
  assert.equal(result.suratCreateTrace.codEnabled, false)
  assert.equal(result.suratCreateTrace.pazaryerimi, 1)
  assert.equal(result.suratCreateTrace.entegrasyonFirmasi, 'Trendyol')
  assert.equal(result.suratCreateTrace.wireWhoPaysPresent, false)
  assert.equal(
    result.suratCreateTrace.wireWhoPaysReason, 'CONTRACT_HAS_NO_WHO_PAYS_FIELD',
  )
  assert.equal(result.suratCreateTrace.preflightValid, true)
  assert.ok(String(result.suratCreateTrace.traceId).startsWith('CF-'))
})

/* ═══ MUTASYONLAR — HEPSİNDE AĞ ÇAĞRISI 0 ═════════════════════════════ */

const BLOCKED = [
  {
    name: 'GUARD-1: UNKNOWN billing party',
    overrides: { order: { rawOrder: { whoPays: null } } },
    failure: 'BILLING_PARTY_UNKNOWN',
  },
  {
    name: 'GUARD-2: pazaryeri DEGIL (Pazaryerimi != 1)',
    overrides: { order: { marketplace: 'KendiSitem' } },
    failure: 'MARKETPLACE_NOT_TRENDYOL',
  },
  {
    name: 'GUARD-4: saglayici cargoTrackingNumber YOK',
    overrides: { order: { cargoTrackingNumber: '' } },
    failure: 'OZEL_KARGO_TAKIP_NO_MISSING',
  },
  {
    name: 'GUARD-5: SELLER_PAYS kimligi YOK',
    overrides: {
      order: { rawOrder: { whoPays: 1 } },
      config: { sellerPaysKullaniciAdi: '', sellerPaysSifre: '' },
    },
    failure: 'SELLER_PAYS_CREDENTIAL_NOT_CONFIGURED',
  },
  {
    name: 'GUARD-6: COD kimligi YOK',
    overrides: { cashOnDelivery: true, config: { codKullaniciAdi: '', codSifre: '' } },
    failure: 'COD_CREDENTIAL_NOT_CONFIGURED',
  },
  {
    name: 'GUARD-7: birincil kimlik YOK',
    overrides: { config: { liveKullaniciAdi: '', liveSifre: '' } },
    failure: 'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
  },
  {
    name: 'GUARD-8: bos config',
    overrides: {
      config: {
        serviceMode: 'SURAT_CANONICAL_API',
        liveKullaniciAdi: '', liveSifre: '',
        sellerPaysKullaniciAdi: '', sellerPaysSifre: '',
        codKullaniciAdi: '', codSifre: '',
      },
    },
    failure: 'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
  },
]

for (const testCase of BLOCKED) {
  test(testCase.name, async () => {
    const { result, networkCalls } = await run(testCase.overrides)
    assert.equal(networkCalls, 0, 'TASIYICIYA GIDILMEMELI')
    assert.equal(result.ok, false)
    assert.ok(
      result.suratCreateTrace.preflightFailures.includes(testCase.failure),
      `beklenen sebep: ${testCase.failure} · gercek: ${JSON.stringify(
        result.suratCreateTrace.preflightFailures,
      )}`,
    )
  })
}

/* ═══ KİMLİK KAYNAĞI GUARD'I ══════════════════════════════════════════ */

test('GUARD-9: 727 IKAME EDILEMEZ — kaynak saglayici alani OLMALI', async () => {
  const routing = await import('./shipments/suratRoutingModel.ts')
  const credential = routing.resolveSuratCredentialContext({
    config: CONFIG,
    billingParty: 'TRENDYOL_PAYS',
    cod: routing.resolveCodContext({ enabled: false }),
  })
  // İç barkod/orderNumber/packageId ikamesi REDDEDILIR.
  const substituted = routing.evaluateSuratCreatePreflight({
    marketplace: 'Trendyol', pazaryerimi: 1, entegrasyonFirmasi: 'Trendyol',
    ozelKargoTakipNo: 'PKG-1', orderCargoTrackingNumber: 'PKG-1',
    trackingSource: 'ownPlatformReference',
    billingParty: 'TRENDYOL_PAYS', credential,
  })
  assert.equal(substituted.valid, false)
  assert.ok(
    substituted.failures.includes('OZEL_KARGO_TAKIP_NO_SOURCE_NOT_PROVIDER'),
  )
  // Sağlayıcı alanından gelirse GEÇER.
  assert.equal(
    routing.evaluateSuratCreatePreflight({
      marketplace: 'Trendyol', pazaryerimi: 1, entegrasyonFirmasi: 'Trendyol',
      ozelKargoTakipNo: '7270035942963454',
      orderCargoTrackingNumber: '7270035942963454',
      trackingSource: 'cargoTrackingNumber',
      billingParty: 'TRENDYOL_PAYS', credential,
    }).valid,
    true,
  )
  // Ve numara siparistekinden FARKLIYSA yine reddedilir.
  assert.ok(
    routing.evaluateSuratCreatePreflight({
      marketplace: 'Trendyol', pazaryerimi: 1, entegrasyonFirmasi: 'Trendyol',
      ozelKargoTakipNo: '7270000000000001',
      orderCargoTrackingNumber: '7270035942963454',
      trackingSource: 'cargoTrackingNumber',
      billingParty: 'TRENDYOL_PAYS', credential,
    }).failures.includes('OZEL_KARGO_TAKIP_NO_SOURCE_MISMATCH'),
  )
})

test('GUARD-10: bloklanan denemede IZ ve kullanici mesaji URETILIR', async () => {
  const { result, networkCalls } = await run({
    config: { liveKullaniciAdi: '', liveSifre: '' },
  })
  assert.equal(networkCalls, 0)
  // Dis yanit sozlesmesi KORUNDU.
  assert.equal(result.errorCode, 'SURAT_ACCOUNT_NOT_CONFIGURED')
  assert.ok(String(result.message).includes(result.suratCreateTrace.traceId))
  assert.equal(result.canonicalCreate.carrierCreateStatus, 'NOT_STARTED')
  assert.equal(result.canonicalCreate.carrierCreateAttempts, 0)
  // Iz SIR TASIMAZ.
  const text = JSON.stringify(result.suratCreateTrace)
  for (const secret of ['PRIMARY_SECRET', 'COD_SECRET', 'SELLER_SECRET']) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
})
