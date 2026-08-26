import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ GERÇEK ÜRETİM ZPL'İ — BUGÜNKÜ HATTAN GEÇİRME ════════════════════════
//
// SORU: iki canlı canary de barkod/ZPL üretmedi. Kusur taşıyıcıda mı, yoksa
// CargoFlow'un YENİ yanıt/ayrıştırma hattında mı?
//
// Bu paket soruyu KANITLA yanıtlar: 2026-07-16'da GERÇEKTEN üretilmiş, 2049
// baytlık, yazdırılmış bir Sürat ZPL'i (`outputs/` → `server/fixtures/`)
// bugünkü ayrıştırıcıdan geçirilir.
//
//   sipariş  11415535074 · paket 4001749648
//   operasyon `OrtakBarkodOlustur` · serviceType `OrtakBarkodOlusturSoap`
//   yanıt kodu `013` · barkod `Web00157962154`
//
// GEÇERSE: ayrıştırıcı SAĞLAMDIR ve kusur taşıyıcının yanıt üretmemesindedir.
// KALIRSA: kusur en azından kısmen BİZDEDİR ve canlı denemeden ÖNCE düzelir.
//
// AĞ YOK · CANLI PAKET YOK.

const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')
const ARTIFACT = await import('./shipments/suratPrintableArtifact.ts')
const SNAPSHOT = await import('./shipments/suratCredentialSnapshot.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')

const here = new URL('.', import.meta.url)

/**
 * 2026-07-16 üretim koşusunun GERÇEK çıktısı — sentetik DEĞİL.
 *
 * PII REDAKTE EDİLDİ: alıcı/gönderici adları, sokak adresi ve mahalle AYNI
 * UZUNLUKTA yer tutucularla değiştirildi (telefonlar zaten Sürat tarafından
 * maskeliydi). Bayt uzunluğu (2049) ve ZPL komut yapısı DEĞİŞMEDİ — testin
 * ölçtüğü şey budur. Gerçek müşteri verisi depoya GİRMEZ.
 */
const REAL_ZPL = readFileSync(
  new URL('./fixtures/surat-real-success-11415535074.zpl', here), 'utf8',
)

const REAL_SUCCESS = {
  orderNumber: '11415535074', packageId: '4001749648',
  cargoTrackingNumber: '7270034422363739',
  barcodeNo: 'Web00157962154', responseCode: '013',
  zplLength: 2049,
}

/* ═══ SURAT_HISTORICAL_REAL_ZPL_REPLAY ═════════════════════════════ */

test('ZPL-REPLAY-1: gercek uretim ZPL fixture BOZULMAMIS', () => {
  assert.equal(REAL_ZPL.length, REAL_SUCCESS.zplLength)
  // Yazdirilabilir ZPL belgesi: acilis ve kapanis komutlari.
  assert.ok(REAL_ZPL.trimStart().startsWith('^XA'))
  assert.ok(REAL_ZPL.trimEnd().endsWith('^XZ'))
})

test('ZPL-REPLAY-2: bugunku artefakt cozucusu GERCEK ZPL i kabul eder', () => {
  const resolved = ARTIFACT.resolveSuratPrintableArtifact({
    barcode: [REAL_ZPL], barcodeNo: [REAL_SUCCESS.barcodeNo],
  })
  assert.equal(resolved.status, 'RESOLVED')
  assert.equal(resolved.format, 'ZPL')
  assert.equal(resolved.byteLength, REAL_SUCCESS.zplLength)
  assert.equal(resolved.base64Decoded, false)
  // TEK BAYT bile degismez: etiket ham hâliyle yazicıya gider.
  assert.equal(resolved.artifact, REAL_ZPL)
})

test('ZPL-REPLAY-3: TAM hat gercek ZPL ile yazdirilabilir sonuc uretir', async () => {
  const store = {
    serviceMode: 'SURAT_CANONICAL_API',
    liveKullaniciAdi: 'PRIMARY_CARI', liveSifre: 'PRIMARY_SECRET',
  }
  const order = {
    marketplace: 'Trendyol',
    orderNumber: REAL_SUCCESS.orderNumber,
    packageId: REAL_SUCCESS.packageId,
    cargoTrackingNumber: REAL_SUCCESS.cargoTrackingNumber,
    customerName: 'Test Alici', address: 'Ornek Mah 1',
    city: 'Istanbul', district: 'Kadikoy', customerPhone: '5551112233',
    desi: 2, items: [{ productName: 'Urun', quantity: 1 }],
  }
  const original = globalThis.fetch
  // Tasiyici, TARIHSEL BASARIDAKI gibi ZPL tasiyan bir yanit dondurur.
  globalThis.fetch = async () => ({
    ok: true, status: 200, text: async () => '',
    json: async () => ({
      isError: false, Message: REAL_SUCCESS.responseCode,
      KargoTakipNo: '24446119471462',
      Barcode: [REAL_ZPL], BarcodeNo: [REAL_SUCCESS.barcodeNo],
    }),
  })
  try {
    const role = ROUTING.resolveSuratCredentialContext({
      config: store,
      billingParty: ROUTING.resolveBillingPartyV2({}).billingParty,
      cod: ROUTING.resolveCodContext({ enabled: false }),
      codPolicy: ROUTING.resolveCodCredentialPolicy(),
    }).role
    const result = await ADAPTER.createCanonicalSuratShipmentForRequest({
      organizationId: 'org-replay',
      credentialSnapshot: SNAPSHOT.buildSuratCredentialSnapshot({
        storedSuratConfig: store, role,
      }),
      config: store, order, reference: REAL_SUCCESS.packageId,
      cashOnDelivery: false,
    })
    assert.equal(result.ok, true)
    assert.equal(result.canonicalCreate.carrierCreateStatus, 'SUCCESS')
    assert.equal(result.canonicalCreate.printArtifactStatus, 'RESOLVED')
    assert.equal(result.canonicalCreate.artifactDetectedFormat, 'ZPL')
    // ZPL uzunlugu KORUNUR — kirpilma/yeniden kodlama YOK.
    assert.equal(
      result.canonicalCreate.artifactByteLength, REAL_SUCCESS.zplLength,
    )
    // Operator yazdirabilir.
    assert.equal(result.shipment.printEnabled, true)
  } finally {
    globalThis.fetch = original
  }
})

test('ZPL-REPLAY-4: ayristirici KUSURLU DEGIL — kanit kaydi', () => {
  // Bu testin varlik sebebi: iki canli canary de barkod uretmedi.
  //   4104179900 · /api/OrtakBarkodOlustur → String -> KargoBarkod (istisna)
  //   4105268542 · /api/PazaryeriGonderi   → "Result is null!"
  //
  // Ikisi de TASIYICI yaniti uretmedi. Yukaridaki testler, tasiyici GERCEK
  // bir ZPL dondurdugunde bugunku hattin onu yazdirilabilir hale getirdigini
  // gosterir. Dolayisiyla "ayristirici uyumsuzlugu" kok neden DEGILDIR.
  //
  // `Result is null!` metni bizim kod tabanimizda HIC gecmez → Surat'in
  // kendi is mesajidir, CargoFlow uretimi degildir.
  // KAYNAK dosyalar taranir; test dosyalari HARIC (bu dosyanin KENDI
  // yorumu o metni icerir — kendine referansli tarama yanlis pozitif verir).
  const sourceDir = new URL('./shipments/', here)
  const own = readdirSync(sourceDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.mjs'))
    .some((f) => readFileSync(new URL(f, sourceDir), 'utf8')
      .includes('Result is null'))
  assert.equal(own, false, '"Result is null!" bizim uretimimiz OLMAMALI')
})

test('ZPL-REPLAY-5: fixture ve test test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  const orphans = onDisk.filter((f) => !listed.has(f))
  assert.deepEqual(orphans, [], `test:surat icinde OLMAYAN: ${orphans.join(', ')}`)
})
