import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ ÇAPRAZ SİPARİŞ KİMLİK SIZINTISI — İMKÂNSIZ OLMALI ═══════════════════
//
// Bir destek paketinde iki farklı paketin kimlikleri karışmıştı
// (`ReferansNo` bir paketten, `OzelKargoTakipNo` başkasından). O olay ELLE
// yazılmış bir rapordan doğdu, ama aynı karışım TELDE olsaydı taşıyıcıda
// YANLIŞ gönderi demekti.
//
// Bu paket iki şeyi kilitler:
//   1. kanonik istek kurucusu SAF bir istek-başına dönüşümdür,
//   2. eşzamanlı iki paket birbirinin kimliğini ASLA taşımaz.

const MODEL = await import('./shipments/suratCanonicalGonderiModel.ts')
const ADAPTER = await import('./shipments/suratCanonicalCreateAdapter.ts')
const SNAPSHOT = await import('./shipments/suratCredentialSnapshot.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')

const store = (suffix) => ({
  serviceMode: 'SURAT_CANONICAL_API',
  liveKullaniciAdi: `CARI_${suffix}`, liveSifre: `SECRET_${suffix}`,
})

const makeOrder = (suffix) => ({
  marketplace: 'Trendyol',
  orderNumber: `115000000${suffix}`,
  packageId: `41000000${suffix}`,
  cargoTrackingNumber: `72700000000000${suffix}`,
  customerName: `Alici ${suffix}`, address: `Mah ${suffix}`,
  city: 'Istanbul', district: 'Kadikoy', customerPhone: '5551112233',
  desi: 2, items: [{ productName: 'Urun', quantity: 1 }],
})

// TEK bir gonderici stub'i. HER kosu icin `globalThis.fetch` degistirmek
// kosularin birbirinin cagrisini yakalamasina yol acar — bu harness'in ilk
// hali tam da test ettigi kusuru tasiyordu. Stub BIR KEZ kurulur, cagrilar
// `ReferansNo` ile eslestirilir.
function installDispatcher() {
  const captured = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    captured.push(body)
    const suffix = String(body?.Gonderi?.ReferansNo ?? '').slice(-1)
    // Gecikme istegin KENDISINDEN turetilir: tamamlanma sirasi baslama
    // sirasindan FARKLI olur.
    const delay = (7 * Number(suffix || 0)) % 23
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    return {
      ok: true, status: 200,
      json: async () => ({
        isError: false, Message: '013', KargoTakipNo: `TN${suffix}`,
        Barcode: ['^XA^XZ'], BarcodeNo: [`BC${suffix}`],
      }),
      text: async () => '',
    }
  }
  return { captured, restore: () => { globalThis.fetch = original } }
}

async function runCreate(suffix) {
  const config = store(suffix)
  const order = makeOrder(suffix)
  const role = ROUTING.resolveSuratCredentialContext({
    config,
    billingParty: ROUTING.resolveBillingPartyV2({}).billingParty,
    cod: ROUTING.resolveCodContext({ enabled: false }),
    codPolicy: ROUTING.resolveCodCredentialPolicy(),
  }).role
  await ADAPTER.createCanonicalSuratShipmentForRequest({
    organizationId: `org-${suffix}`,
    credentialSnapshot: SNAPSHOT.buildSuratCredentialSnapshot({
      storedSuratConfig: config, role,
    }),
    config, order, reference: order.packageId, cashOnDelivery: false,
  })
  return order
}

/** Telde giden govdeyi paketin KENDI ReferansNo'su ile bulur. */
const wireFor = (captured, order) => {
  const found = captured.filter(
    (body) => body?.Gonderi?.ReferansNo === order.packageId,
  )
  assert.equal(found.length, 1, `${order.packageId} icin TEK cagri OLMALI`)
  return found[0]
}

/* ═══ IDENTITY-PURE-1 — KURUCU SAF BİR DÖNÜŞÜMDÜR ══════════════════ */

test('IDENTITY-PURE-1: kanonik kurucu paylasilan mutable durum TASIMAZ', () => {
  const files = [
    'shipments/suratCanonicalGonderiModel.ts',
    'shipments/suratCanonicalCreateAdapter.ts',
    'shipments/suratWebApiClient.ts',
    'shipments/suratCredentialSnapshot.ts',
  ]
  for (const file of files) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    for (const line of source.split(String.fromCharCode(10))) {
      // Modul kapsaminda `let`/`var` ya da paylasilan Map/Set/dizi YOK.
      assert.equal(
        /^(let|var)[ ]/.test(line), false,
        `${file}: modul kapsaminda mutable baglam: ${line.trim()}`,
      )
      assert.equal(
        /^const [A-Za-z_$]+ = new (Map|Set|WeakMap)\(/.test(line), false,
        `${file}: modul kapsaminda paylasilan onbellek: ${line.trim()}`,
      )
    }
  }
})

test('IDENTITY-PURE-2: ayni girdi HER CAGRIDA YENI nesne uretir', () => {
  const context = {
    pazaryerimi: 1, entegrasyonFirmasi: 'Trendyol',
    ozelKargoTakipNo: '7270000000000001',
  }
  const input = { order: makeOrder('1'), context, desi: 2 }
  const first = MODEL.buildSuratCanonicalGonderiModel(input)
  const second = MODEL.buildSuratCanonicalGonderiModel(input)
  assert.notEqual(first, second, 'ayni nesne YENIDEN KULLANILIYOR')
  // Birini kirletmek digerini ETKILEMEZ.
  first.OzelKargoTakipNo = 'KIRLETILDI'
  assert.notEqual(second.OzelKargoTakipNo, 'KIRLETILDI')
  // Varsayilan sabitler de tasinmaz.
  assert.notEqual(first, MODEL.SURAT_SERVICE_DEFAULTS)
})

/* ═══ IDENTITY-ISOLATION — EŞZAMANLI PAKETLER ══════════════════════ */

test('IDENTITY-ISOLATION-1: eszamanli iki paket kimlik DEGISTIRMEZ', async () => {
  const { captured, restore } = installDispatcher()
  try {
    const [a, b] = await Promise.all([runCreate('1'), runCreate('2')])
    const wireA = wireFor(captured, a)
    const wireB = wireFor(captured, b)

    assert.equal(wireA.Gonderi.OzelKargoTakipNo, a.cargoTrackingNumber)
    assert.equal(wireB.Gonderi.OzelKargoTakipNo, b.cargoTrackingNumber)

    // A, B'nin HICBIR kimligini TASIMAZ ve tersi.
    const aJson = JSON.stringify(wireA)
    const bJson = JSON.stringify(wireB)
    assert.equal(aJson.includes(b.cargoTrackingNumber), false)
    assert.equal(aJson.includes(b.packageId), false)
    assert.equal(bJson.includes(a.cargoTrackingNumber), false)
    assert.equal(bJson.includes(a.packageId), false)
    // Kimlik bilgileri de karismaz.
    assert.equal(wireA.KullaniciAdi, 'CARI_1')
    assert.equal(wireB.KullaniciAdi, 'CARI_2')
  } finally {
    restore()
  }
})

test('IDENTITY-ISOLATION-2: sekiz eszamanli pakette de sizinti YOK', async () => {
  const { captured, restore } = installDispatcher()
  try {
    // Gecikme her istegin KENDI ReferansNo'sundan turer; tamamlanma sirasi
    // baslama sirasiyla AYNI DEGILDIR. `Math.random` KULLANILMAZ.
    const orders = await Promise.all(
      Array.from({ length: 8 }, (_, index) => runCreate(String(index + 1))),
    )
    const trackings = orders.map((order) => order.cargoTrackingNumber)
    for (const [index, order] of orders.entries()) {
      const wire = wireFor(captured, order)
      assert.equal(wire.Gonderi.OzelKargoTakipNo, trackings[index])
      assert.equal(wire.Gonderi.ReferansNo, order.packageId)
      const json = JSON.stringify(wire)
      for (const [other, tracking] of trackings.entries()) {
        if (other === index) continue
        assert.equal(
          json.includes(tracking), false,
          `paket ${index + 1} → paket ${other + 1} kimligi SIZDI`,
        )
      }
    }
  } finally {
    restore()
  }
})

/* ═══ DESTEK PAKETİ ELLE YAZILMAZ ══════════════════════════════════ */

test('SUPPORT-PACKET-1: destek paketi KALICI KANITTAN uretilir', () => {
  const cli = readFileSync(
    new URL('./shipments/suratIdentityEvidenceCli.ts', import.meta.url), 'utf8',
  )
  // Telde GERCEKTEN serilesen degerler okunur — karar asamasi DEGIL.
  assert.ok(cli.includes("'ACTUAL_WIRE_READY'"))
  assert.ok(cli.includes('safeValues.ReferansNo'))
  assert.ok(cli.includes('safeValues.OzelKargoTakipNo'))
  // Kiracinin KENDI kaydiyla karsilastirilir.
  assert.ok(cli.includes('orders.packageId'))
  assert.ok(cli.includes('CROSS_ORDER_IDENTITY_LEAK'))
  // Kanit yoksa "eslesti" DENMEZ.
  assert.ok(cli.includes('UNKNOWN_NO_WIRE_EVIDENCE'))
  // SALT OKUNUR.
  assert.equal(/\binsert\(|\bupdate\(|\bdelete\(/.test(cli), false)
  assert.ok(cli.includes('NETWORK_CALLS 0'))
})

test('SUPPORT-PACKET-2: yeni test dosyalari test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(new URL('.', import.meta.url))
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  const orphans = onDisk.filter((f) => !listed.has(f))
  assert.deepEqual(orphans, [], `test:surat icinde OLMAYAN: ${orphans.join(', ')}`)
})

/* ═══ TY-SURAT-17 — WebSiparisKodu KANITA BAĞLI ════════════════════ */

test('TY-SURAT-17: WebSiparisKodu SIPARIS NUMARASI DEGILDIR', () => {
  // Bu varsayim YANLISTI ve teyit sorgusunu HER ZAMAN bos donduruyordu.
  // Dogru kaynak `createRequest.OzelKargoTakipNo` = cargoTrackingNumber.
  //
  // KANIT (dort bagimsiz depo kaynagi):
  //   docs/surat-service-map.md:31,34   sorgu anahtari kaynagi
  //   docs/surat-service-map.md:83,88   727... -> OzelKargoTakipNo -> WebSiparisKodu
  //   docs/surat-service-map.md:93-104  canli ornek WebSiparisKodu=727...
  //   outputs/surat-e2e-final-report-2026-07-17.md:46 (uretim kosusu)
  const server = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
  assert.ok(
    server.includes('webSiparisKodu: order?.cargoTrackingNumber'),
    'teyit sorgusu takip numarasi ile yapilmali',
  )
  assert.equal(
    server.includes('webSiparisKodu: order?.orderNumber'), false,
    'siparis numarasi ile sorgu HICBIR satir dondurmez',
  )
  assert.equal(server.includes("webSiparisKoduSource: 'orderNumber'"), false)

  // Sozlesme kaydi bu duzeltmeyi ve kanit seviyesini TASIR.
  const registry = readFileSync(
    new URL('../docs/contracts/TRENDYOL-SURAT.md', import.meta.url), 'utf8',
  )
  assert.ok(registry.includes('DÜZELTİLMİŞ VARSAYIM'))
  assert.ok(registry.includes('PRODUCTION_PROVEN'))
  // Host sorusu 2026-08-26 salt-okunur fingerprinting ile COZULDU:
  // api01 origin'i 522, api02 canli "Sürat Kargo Web API" servis ediyor ve
  // /api/OrtakBarkodOlustur orada tanimli. Bu satir eskiden 'CONFLICTING'
  // pinliyordu; kanit degistigi icin GUNCELLENDI.
  assert.ok(registry.includes('API02_LIVE_FOR_THIS_ACCOUNT'))
  // Kimlikler AYRI kalir.
  assert.ok(registry.includes('`packageId` | `ReferansNo`'))
})
