import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ TRENDYOL × SÜRAT — PAZARYERİ UCU UÇTAN UCA ══════════════════════════
//
// ÜRETİM KANITI (CF-4104179900): `Pazaryerimi=1` + `EntegrasyonFirmasi=
// Trendyol` taşıyan gönderi GENEL uca (`/api/OrtakBarkodOlustur`) gidince
// taşıyıcı kendi sonuç kurucusunda düştü:
//   System.InvalidCastException: String → KargoBarkod  (…:1836)
//
// CANLI SÖZLEŞME (api02 OpenAPI 3): `/api/PazaryeriGonderi` ile
// `/api/OrtakBarkodOlustur` AYNI istek modelini (`OrtakBarkodOlusturParam`)
// ve AYNI yanıt modelini (`ResultMesaj`) kullanır. Yani DEĞİŞEN TEK ŞEY YOL.
//
// Bu paket, pazaryeri gönderisinin pazaryeri ucuna gittiğini ve barkod/ZPL
// üretiminin bozulmadığını kilitler. Ağ SINIRI taklit edilir; canlı paket
// TÜKETİLMEZ.

const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')
const CLIENT = await import('./shipments/suratWebApiClient.ts')
const SNAPSHOT = await import('./shipments/suratCredentialSnapshot.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')

const here = new URL('.', import.meta.url)

const STORE = {
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: 'PRIMARY_CARI', liveSifre: 'PRIMARY_SECRET',
  sellerPaysKullaniciAdi: 'SELLER_CARI', sellerPaysSifre: 'SELLER_SECRET',
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

async function runCreate({ rawOrder = {} } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return {
      ok: true, status: 200, json: async () => CARRIER_OK, text: async () => '',
    }
  }
  try {
    const billingV2 = ROUTING.resolveBillingPartyV2(rawOrder)
    const billing = {
      ...billingV2,
      expectedSuratWhoPays: ROUTING.expectedSuratWhoPays(billingV2.billingParty),
    }
    const role = ROUTING.resolveSuratCredentialContext({
      config: STORE,
      billingParty: billing.billingParty,
      cod: ROUTING.resolveCodContext({ enabled: false }),
      codPolicy: ROUTING.resolveCodCredentialPolicy(),
    }).role
    const result = await ADAPTER.createCanonicalSuratShipmentForRequest({
      organizationId: 'org-pg-1',
      credentialSnapshot: SNAPSHOT.buildSuratCredentialSnapshot({
        storedSuratConfig: STORE, role,
      }),
      config: STORE, order: { ...ORDER, rawOrder },
      reference: ORDER.packageId, cashOnDelivery: false,
    })
    return { result, calls, role, billing }
  } finally {
    globalThis.fetch = original
  }
}

/* ═══ TRENDYOL_SURAT_PAZARYERI_GONDERI_E2E ═════════════════════════ */

test('TRENDYOL_SURAT_PAZARYERI_GONDERI_E2E', async () => {
  const { result, calls, role, billing } = await runCreate()

  // ── TAM OLARAK BİR TAŞIYICI ÇAĞRISI ─────────────────────────────────
  assert.equal(calls.length, 1, 'tek tasiyici cagrisi OLMALI')
  const { url, body } = calls[0]

  // ── HOST + UÇ ───────────────────────────────────────────────────────
  assert.equal(new URL(url).hostname, 'api02.suratkargo.com.tr')
  assert.equal(new URL(url).pathname, '/api/PazaryeriGonderi')
  // GENEL uc HIC cagrilmaz.
  assert.equal(url.includes('/api/OrtakBarkodOlustur'), false)
  // Legacy yollarin HICBIRI cagrilmaz.
  const allUrls = calls.map((c) => c.url).join(' ')
  for (const legacy of [
    'GonderiyiKargoyaGonder', 'KargoTakipHareketDetayi',
    'PazaryeriOrtakBarkod', 'CreateCommonBarcode', 'services.asmx',
  ]) {
    assert.equal(allUrls.includes(legacy), false, `legacy cagri: ${legacy}`)
  }

  // ── İSTEK MODELİ DEĞİŞMEDİ (OrtakBarkodOlusturParam) ────────────────
  assert.deepEqual(Object.keys(body).sort(), ['Gonderi', 'KullaniciAdi', 'Sifre'])
  assert.equal(body.Gonderi.ReferansNo, ORDER.packageId)
  assert.equal(body.Gonderi.OzelKargoTakipNo, ORDER.cargoTrackingNumber)
  assert.equal(body.Gonderi.Pazaryerimi, 1)
  assert.equal(body.Gonderi.EntegrasyonFirmasi, 'Trendyol')
  // Canli sozlesme: GonderiModel.Iademi = boolean.
  assert.equal(typeof body.Gonderi.Iademi, 'boolean')

  // ── FATURALAMA ──────────────────────────────────────────────────────
  assert.equal(billing.billingParty, 'TRENDYOL_PAYS')
  assert.equal(billing.expectedSuratWhoPays, '3')
  assert.equal(role, 'PRIMARY_MARKETPLACE')
  assert.equal(body.KullaniciAdi, 'PRIMARY_CARI')
  // Satici kimligi TELE ULASAMAZ.
  assert.equal(JSON.stringify(body).includes('SELLER_'), false)
  // Kanonik sozlesmede WhoPays/KimOder alani YOKTUR; UYDURULMAZ.
  assert.equal('WhoPays' in body.Gonderi, false)
  assert.equal('KimOder' in body.Gonderi, false)

  // ── SONUÇ: BARKOD + ZPL + YAZDIRILABİLİR ────────────────────────────
  assert.equal(result.ok, true)
  assert.equal(result.canonicalCreate.carrierCreateStatus, 'SUCCESS')
  assert.equal(result.canonicalCreate.carrierCreateAttempts, 1)
  assert.equal(result.canonicalCreate.printArtifactStatus, 'RESOLVED')
  assert.equal(result.canonicalCreate.artifactDetectedFormat, 'ZPL')
  assert.ok(result.canonicalCreate.artifactByteLength > 0)
  assert.equal(result.shipment.printEnabled, true)
  assert.equal(result.shipment.trackingNumber, '24446119471462')

  // ── TRACE V2 GERÇEKTEN ÇAĞRILAN UCU GÖSTERİR ────────────────────────
  assert.equal(result.canonicalCreate.host, 'api02.suratkargo.com.tr')
  assert.equal(result.canonicalCreate.endpoint, '/api/PazaryeriGonderi')
  assert.equal(result.canonicalCreate.operation, 'PazaryeriGonderi')
})

/* ═══ GENEL UÇ REGRESYONU ══════════════════════════════════════════ */

test('PG-ROUTE-1: yol GONDERININ KENDISINDEN turetilir', () => {
  // Cagiran ayri bir bayrakla ezemez: `Pazaryerimi` ile yol AYRILAMAZ.
  assert.equal(
    CLIENT.resolveSuratCanonicalCreatePath({ Pazaryerimi: 1 }),
    '/api/PazaryeriGonderi',
  )
  // Pazaryeri OLMAYAN gonderi GENEL ucta KALIR — mevcut davranis korunur.
  assert.equal(
    CLIENT.resolveSuratCanonicalCreatePath({ Pazaryerimi: 0 }),
    '/api/OrtakBarkodOlustur',
  )
  assert.equal(
    CLIENT.resolveSuratCanonicalCreatePath(null),
    '/api/OrtakBarkodOlustur',
  )
  assert.equal(CLIENT.SURAT_MARKETPLACE_CREATE_PATH, '/api/PazaryeriGonderi')
  assert.equal(CLIENT.SURAT_CANONICAL_CREATE_PATH, '/api/OrtakBarkodOlustur')
})

test('PG-ROUTE-2: pazaryeri gonderisi GENEL uca SESSIZCE donemez', () => {
  // Yol secimi tek bir yordamdan gecer; ikinci bir sabit kullanim YOK.
  const client = readFileSync(
    new URL('./shipments/suratWebApiClient.ts', here), 'utf8',
  )
  assert.ok(client.includes('resolveSuratCanonicalCreatePath(params.gonderi)'))
  // Uc, sabitin dogrudan birlestirilmesiyle KURULMAZ.
  assert.equal(
    client.includes('${baseUrl}${SURAT_CANONICAL_CREATE_PATH}'), false,
    'genel uc sabiti dogrudan birlestiriliyor',
  )
})

test('PG-ROUTE-3: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  const orphans = onDisk.filter((f) => !listed.has(f))
  assert.deepEqual(orphans, [], `test:surat icinde OLMAYAN: ${orphans.join(', ')}`)
})
