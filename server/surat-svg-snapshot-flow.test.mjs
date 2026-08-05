import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// RESMÎ SÜRAT SVG — GÖRSEL REGRESYON (SNAPSHOT) TESTLERİ.
//
// Snapshot'lar server/fixtures/surat-svg/*.svg altında REPODA tutulur ve
// BİREBİR karşılaştırılır. Renderer'daki her görsel değişiklik burada diff
// olarak görünür.
//
// Snapshot güncelleme (kasıtlı görsel değişiklikte):
//   SURAT_SNAPSHOT_UPDATE=1 node --test server/surat-svg-snapshot-flow.test.mjs
// Güncellenen dosyalar commit'e GİRMELİ ve diff gözden geçirilmelidir.
//
// TÜM FİXTURE'LAR SENTETİKTİR: gerçek müşteri adı, adresi, telefonu, gerçek
// sipariş numarası veya gerçek provider ZPL'i İÇERMEZ.
// Çıktı DETERMİNİSTİKTİR: timestamp, rastgele id veya sıraya bağlı olmayan
// attribute üretilmez (bu dosya bunu ayrıca doğrular).

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_DIR = join(here, 'fixtures', 'surat-svg')
const UPDATE = process.env.SURAT_SNAPSHOT_UPDATE === '1'

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

// ── SENTETİK resmî Sürat şablonu ───────────────────────────────────────────
function officialZpl(options = {}) {
  const {
    recipient = 'SENTETIK ALICI',
    address = 'ORNEK MAH ORNEK SOK NO 1 ORNEK ILCE',
    route = 'ORNEKSEHIR/01',
    transfer = 'ORNEKSEHIR AKTARMA',
    barcodeModule = 3,
    includeCode128 = true,
    includeDataMatrix = true,
    includeQr = true,
  } = options
  return [
    '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
    '^FO20,15^GB760,770,3^FS',
    '^FO60,20^A0N,28,28^FDSube: ORNEK^FS',
    '^FO470,20^A0N,26,26^FDT.No: 10000000000001^FS',
    includeCode128
      ? `^FO60,150^BY${barcodeModule}^BCN,150,Y,N,N^FD01200000001^FS`
      : '',
    `^FO60,345^A0N,24,24^FD${recipient}^FS`,
    `^FO60,375^A0N,18,18^FB700,3,0,L,0^FD${address}^FS`,
    '^FO60,480^A0N,20,20^FDOdemeTipi Birim Top Ds/Kg^FS',
    '^FO60,510^A0N,30,30^FDPOCH KOLI 2,00^FS',
    includeDataMatrix ? '^FO60,560^BXN,6,200^FD1000000000000001^FS' : '',
    `^FO240,630^A0N,34,34^FD${route}^FS`,
    `^FO240,672^A0N,38,38^FD${transfer}^FS`,
    includeQr ? '^FO660,560^BQN,2,6^FDLA,01200000001^FS' : '',
    '^FWB', '^FO24,340^A0N,18,18^FDSiparis No: 1000000000000001^FS', '^FWN',
    '^PQ1,0,1,Y',
    '^XZ',
  ]
    .filter(Boolean)
    .join('\n')
}

function order(over = {}) {
  return {
    id: 'snap-1',
    marketplace: 'Trendyol',
    orderNumber: '1000000000000001',
    packageId: 'PKG-SNAP-1',
    customerName: 'SENTETIK ALICI',
    address: 'ORNEK MAH ORNEK SOK NO 1 ORNEK ILCE',
    city: 'ORNEKSEHIR',
    district: 'ORNEKILCE',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    desi: 2,
    desiSource: 'manual_total',
    items: [
      {
        id: 'snap-l-1',
        productName: 'Ornek Elbise',
        quantity: 1,
        color: 'Siyah',
        size: '42',
        merchantSku: 'ORN-001',
      },
    ],
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: '10000000000001',
      tNo: '10000000000001',
      barcode: '01200000001',
      barkodNo: '01200000001',
      barcodeValue: '01200000001',
      ozelKargoTakipNo: '1000000000000001',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true,
      printEnabled: true,
      barcodeRaw: officialZpl(),
      desi: 2,
    },
    ...over,
  }
}

const LONG_NAME =
  'Ornek Uzun Urun Adi Premium Koleksiyon Ekstra Detayli Seri Numara Bir'

const FIXTURES = [
  {
    name: '01-single-short-product',
    build: () => order(),
  },
  {
    name: '02-single-long-product',
    build: () =>
      order({
        items: [
          {
            id: 'snap-l-1',
            productName: LONG_NAME,
            quantity: 1,
            color: 'Krem',
            size: 'XXL',
            merchantSku: 'ORN-LONG-0001',
          },
        ],
      }),
  },
  {
    name: '03-two-products',
    build: () =>
      order({
        items: [
          {
            id: 'snap-l-1', productName: 'Ornek Elbise', quantity: 2,
            color: 'Siyah', size: '42', merchantSku: 'ORN-001',
          },
          {
            id: 'snap-l-2', productName: 'Ornek Tunik', quantity: 1,
            color: 'Bej', size: '40', merchantSku: 'ORN-002',
          },
        ],
      }),
  },
  {
    name: '04-long-address',
    build: () => {
      const base = order()
      return {
        ...base,
        shipment: {
          ...base.shipment,
          barcodeRaw: officialZpl({
            address:
              'ORNEK MAHALLESI ORNEK CADDESI ORNEK SOKAK NUMARA 123 DAIRE 45 KAT 6 ORNEK SITESI B BLOK ORNEK ILCE ORNEKSEHIR',
          }),
        },
      }
    },
  },
  {
    name: '05-long-route',
    build: () => {
      const base = order()
      return {
        ...base,
        shipment: {
          ...base.shipment,
          barcodeRaw: officialZpl({
            route: 'ORNEKSEHIR BUYUK AKTARMA MERKEZI/99',
            transfer: 'ORNEKSEHIR BOLGE AKTARMA MERKEZI SUBE 99',
          }),
        },
      }
    },
  },
  {
    name: '06-augmentation-overflow',
    build: () =>
      order({
        items: Array.from({ length: 40 }, (_, index) => ({
          id: `snap-of-${index}`,
          productName: `${LONG_NAME} ${index}`,
          quantity: 1,
          color: 'Krem',
          size: '40',
          merchantSku: `ORN-OF-${index}`,
        })),
      }),
  },
  {
    name: '07-legacy-technical-zpl-only-ready',
    build: () => order({ items: [] }),
  },
  {
    name: '08-persisted-augmented-printed-reprint',
    build: () =>
      order({
        operationStatus: 'LABEL_PRINTED',
        labelStatus: 'PRINTED',
        label: { printedAt: '2026-01-01T00:00:00.000Z', printCount: 1 },
      }),
  },
  {
    name: '09-datamatrix-only',
    build: () => {
      const base = order()
      return {
        ...base,
        shipment: {
          ...base.shipment,
          barcodeRaw: officialZpl({ includeQr: false }),
        },
      }
    },
  },
  {
    name: '10-qr-only',
    build: () => {
      const base = order()
      return {
        ...base,
        shipment: {
          ...base.shipment,
          barcodeRaw: officialZpl({ includeDataMatrix: false }),
        },
      }
    },
  },
  {
    name: '11-code128-wide-module',
    build: () => {
      const base = order()
      return {
        ...base,
        shipment: {
          ...base.shipment,
          barcodeRaw: officialZpl({ barcodeModule: 4 }),
        },
      }
    },
  },
]

async function renderFixture(fixture) {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const doc = buildSuratOfficialPrintDocument([fixture.build()])
  assert.equal(
    doc.pages.length,
    1,
    `render edilemedi (${fixture.name}): ${doc.skipped.map((s) => s.reason).join('; ')}`,
  )
  return { page: doc.pages[0], html: doc.html }
}

for (const fixture of FIXTURES) {
  test(`SNAP-${fixture.name}: SVG snapshot ve yapısal sözleşme`, async () => {
    const { page, html } = await renderFixture(fixture)
    const svg = page.render.svg

    // ── Yapısal sözleşme (snapshot'tan bağımsız) ─────────────────────────
    assert.ok(svg.includes('viewBox="0 0 799 799"'), 'viewBox 0 0 799 799')
    assert.ok(svg.includes('width="100mm"'), 'genişlik 100mm')
    assert.ok(svg.includes('height="100mm"'), 'yükseklik 100mm')
    assert.ok(svg.includes('shape-rendering="crispEdges"'), 'crispEdges')
    // Dış çerçeve
    assert.ok(
      svg.includes('width="760" height="770" fill="none" stroke="#000"'),
      'dış çerçeve mevcut',
    )
    // 1D barkod + insan-okur numara
    assert.ok(/height="150" fill="#000"/.test(svg), '1D barkod çubukları')
    assert.ok(svg.includes('>01200000001<'), 'barkod altı numara')
    // Rota, aktarma, dikey sipariş numarası
    assert.ok(/ORNEKSEHIR/.test(svg), 'rota mevcut')
    assert.ok(/AKTARMA/.test(svg), 'aktarma mevcut')
    assert.ok(
      /transform="rotate\(-90 24 340\)"/.test(svg),
      'dikey sipariş numarası mevcut',
    )
    // Matris kodlar: fixture'a göre en az biri
    const hasMatrix = /width="6" height="6" fill="#000"/.test(svg)
    assert.ok(hasMatrix, 'QR/DataMatrix modülleri mevcut')
    // Ürün footer'ı: overflow ve ürünsüz fixture'lar hariç
    if (!/06-augmentation-overflow|07-legacy/.test(fixture.name)) {
      assert.ok(/Ornek/.test(svg), 'ürün footer mevcut')
    }
    // KIRPMA YOK: içerik viewBox dışına taşan negatif koordinat almaz.
    assert.equal(/[xy]="-\d/.test(svg), false, 'clip/negatif koordinat yok')
    // İKİNCİ SAYFA YOK.
    assert.equal((html.match(/class="surat-official-page"/g) ?? []).length, 1)
    assert.equal(html.trim().endsWith('</body></html>'), true)

    // ── Determinizm ──────────────────────────────────────────────────────
    const again = await renderFixture(fixture)
    assert.equal(again.page.render.svg, svg, 'render deterministik değil')
    assert.equal(
      /\b(?:id="[^"]*\d{6,}"|data-generated|timestamp|Date\.now)/.test(svg),
      false,
      'nondeterministik attribute',
    )

    // ── Snapshot karşılaştırması ─────────────────────────────────────────
    const file = join(SNAPSHOT_DIR, `${fixture.name}.svg`)
    if (UPDATE) {
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
      writeFileSync(file, svg, 'utf8')
      return
    }
    assert.ok(
      existsSync(file),
      `snapshot dosyası yok: ${file} (SURAT_SNAPSHOT_UPDATE=1 ile üret)`,
    )
    assert.equal(
      svg,
      readFileSync(file, 'utf8'),
      `SVG snapshot değişti: ${fixture.name}`,
    )
  })
}

test('SNAP-META: snapshot fixture kapsamı ve gizlilik', async () => {
  // 11 zorunlu senaryo (spec §13).
  assert.equal(FIXTURES.length, 11)
  // Snapshot DOSYALARINDA gerçek üretim tanımlayıcısı bulunmamalı; tüm
  // değerler sentetik önekli olmalıdır (0120…, 1000…, ORNEK…).
  const forbidden = ['727003', '012545', '210129']
  for (const fixture of FIXTURES) {
    const file = join(SNAPSHOT_DIR, `${fixture.name}.svg`)
    if (!existsSync(file)) continue
    const svg = readFileSync(file, 'utf8')
    for (const needle of forbidden) {
      assert.equal(
        svg.includes(needle),
        false,
        `gerçek üretim tanımlayıcısı snapshot'ta (${fixture.name}): ${needle}`,
      )
    }
    assert.equal(/FERAH|DIYARBAKIR|KARACADAG/.test(svg), false, fixture.name)
  }
})

test('SNAP-OVERFLOW: augmentation sığmasa da resmî etiket render edilir', async () => {
  const { buildSuratPrintPageModel } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const fixture = FIXTURES.find((item) => item.name === '06-augmentation-overflow')
  const { model } = buildSuratPrintPageModel(fixture.build())
  assert.equal(model.augmentationStatus, 'overflow')
  assert.equal(
    model.augmentationWarning,
    'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.',
  )
  const { page } = await renderFixture(fixture)
  assert.equal(page.render.renderStatus, 'ok')
})

test('SNAP-REPRINT: PRINTED reprint AYNI artefaktı verir (immutable)', async () => {
  const ready = await renderFixture(
    FIXTURES.find((item) => item.name === '01-single-short-product'),
  )
  const reprint = await renderFixture(
    FIXTURES.find((item) => item.name === '08-persisted-augmented-printed-reprint'),
  )
  assert.equal(
    reprint.page.printZplSha256,
    ready.page.printZplSha256,
    'reprint yeni bir baskı artefaktı ÜRETMEZ',
  )
  assert.equal(reprint.page.render.svg, ready.page.render.svg)
})
