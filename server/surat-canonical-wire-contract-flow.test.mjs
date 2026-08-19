import assert from 'node:assert/strict'
import test from 'node:test'

// AĞ SINIRI SÖZLEŞMESİ.
//
// 2026-08-18 canlı denemesi (paket 4085791254) HTTP 200 aldı ama Sürat
// `System.InvalidCastException: String -> KargoBarkod` döndürdü. Bu paket,
// isteğin telde GERÇEKTEN hangi biçimde gittiğini kilitler: yapısal bir
// bozulma (ör. nesne yerine JSON string) sessizce üretime gidemez.

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

const ORDER = {
  marketplace: 'Trendyol',
  orderNumber: '11516641186',
  packageId: '4085791254',
  cargoTrackingNumber: '7270036019076954',
  customerName: 'Ad Soyad', address: 'Adres 1',
  city: 'İstanbul', district: 'Kadıköy', customerPhone: '5551112233',
  desi: 2, items: [{ productName: 'Ürün', quantity: 1 }], rawOrder: {},
}

/** Gerçek adaptörü koşar, TELE giden gövdeyi yakalar. */
async function captureWireBody(overrides = {}) {
  const original = globalThis.fetch
  let body = null
  globalThis.fetch = async (_url, init) => {
    body = init?.body
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  }
  try {
    await callCanonicalCreate({
      organizationId: 'org-A',
      config: {
        serviceMode: 'SURAT_CANONICAL_API',
        liveKullaniciAdi: 'CARI', liveSifre: 'SECRET_VALUE',
        ...(overrides.config ?? {}),
      },
      order: { ...ORDER, ...(overrides.order ?? {}) },
      reference: overrides.reference ?? ORDER.packageId,
    })
  } catch { /* ağ sahte; sonuç ayrıştırma bu paketin konusu değil */ }
  globalThis.fetch = original
  assert.ok(body, 'tasiyiciya gövde GONDERILMELI')
  return JSON.parse(body)
}

const typeOf = (value) =>
  Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value

/* ═══ KÖK GÖVDE ══════════════════════════════════════════════════════ */

test('WIRE-1: kok govde nesnedir ve TAM UC alan tasir', async () => {
  const request = await captureWireBody()
  assert.equal(typeOf(request), 'object')
  assert.deepEqual(Object.keys(request), ['KullaniciAdi', 'Sifre', 'Gonderi'])
  assert.equal(typeOf(request.KullaniciAdi), 'string')
  assert.equal(typeOf(request.Sifre), 'string')
})

/* ═══ GÖNDERİ NESNE OLMALI — STRINGIFIED OLAMAZ ══════════════════════ */

test('WIRE-2: Gonderi NESNEDIR, JSON string DEGILDIR', async () => {
  const request = await captureWireBody()
  assert.equal(typeOf(request.Gonderi), 'object',
    'Gonderi stringlesirse tasiyici tarafinda cast hatasi olusur')
  // Tel gövdesinde HİÇBİR alan gizlice JSON stringine dönmemeli.
  for (const [key, value] of Object.entries(request.Gonderi)) {
    if (typeof value !== 'string') continue
    assert.equal(
      /^\s*[[{]/.test(value), false,
      `${key} JSON stringine donusmus — nesne beklenen yerde string`,
    )
  }
})

/* ═══ ALAN TİPLERİ ═══════════════════════════════════════════════════ */

test('WIRE-3: pazaryeri ve odeme alanlari DOGRU TIPTE', async () => {
  const g = (await captureWireBody()).Gonderi
  assert.equal(typeOf(g.Pazaryerimi), 'number')
  assert.equal(g.Pazaryerimi, 1)
  assert.equal(typeOf(g.EntegrasyonFirmasi), 'string')
  assert.equal(g.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(typeOf(g.OdemeTipi), 'number')
  assert.equal(g.OdemeTipi, 1)
  assert.equal(typeOf(g.KapidanOdemeTahsilatTipi), 'number')
  assert.equal(g.KapidanOdemeTahsilatTipi, 0)
})

test('WIRE-4: kimlik alanlari saglayici kaynakli ve DOGRU ESLESIR', async () => {
  const g = (await captureWireBody()).Gonderi
  // Saglayicidan gelen 727 numarasi — ikame EDILEMEZ.
  assert.equal(typeOf(g.OzelKargoTakipNo), 'string')
  assert.equal(g.OzelKargoTakipNo, ORDER.cargoTrackingNumber)
  // ReferansNo bizim paket kimligimizdir; takip numarasi DEGILDIR.
  assert.equal(typeOf(g.ReferansNo), 'string')
  assert.equal(g.ReferansNo, ORDER.packageId)
  assert.notEqual(g.ReferansNo, g.OzelKargoTakipNo)
})

/* ═══ YASAK ALANLAR ══════════════════════════════════════════════════ */

test('WIRE-5: sozlesmede olmayan WhoPays/KimOder ENJEKTE EDILMEZ', async () => {
  const request = await captureWireBody()
  for (const forbidden of ['WhoPays', 'KimOder']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(request.Gonderi, forbidden), false,
      `${forbidden} kanonik sozlesmede YOK`,
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(request, forbidden), false,
    )
  }
})

test('WIRE-6: SELLER_PAYS siparisi de tel sozlesmesini DEGISTIRMEZ', async () => {
  const request = await captureWireBody({
    config: { sellerPaysKullaniciAdi: 'S', sellerPaysSifre: 'SS' },
    order: { rawOrder: { whoPays: 1 } },
  })
  // Fatura tarafi degisir ama TEL sozlesmesi aynidir.
  assert.deepEqual(Object.keys(request), ['KullaniciAdi', 'Sifre', 'Gonderi'])
  assert.equal(
    Object.prototype.hasOwnProperty.call(request.Gonderi, 'WhoPays'), false,
  )
})

/* ═══ SIR SIZMAZ ═════════════════════════════════════════════════════ */

test('WIRE-7: gövde sifreyi yalniz kendi alaninda tasir', async () => {
  const request = await captureWireBody()
  // Sifre tasiyiciya gitmek ZORUNDA; ama baska hicbir alana SIZMAMALI.
  assert.equal(request.Sifre, 'SECRET_VALUE')
  assert.equal(
    JSON.stringify(request.Gonderi).includes('SECRET_VALUE'), false,
    'sir Gonderi icine SIZMIS',
  )
})
