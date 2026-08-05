import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import {
  buildSyntheticSuratZpl,
  buildSyntheticSuratOrder,
  FIXTURE_DATA,
  FIXTURE_LAYOUT,
} from './fixtures/suratOfficialZplFixture.mjs'

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
// TEK KAYNAK: server/fixtures/suratOfficialZplFixture.mjs. Şablon artık
// gerçek etikette olduğu gibi ^GB YATAY/DİKEY bölüm çizgileri, ^FT taban
// çizgisi alanları, ^FB sarma/hizalama ve ^A0B dikey ray içerir.
const officialZpl = (options = {}) => buildSyntheticSuratZpl(options)
const order = (over = {}) => buildSyntheticSuratOrder(over)

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
    // Dış çerçeve — ZPL kutu kenarlığı İÇERİ çizilir, dış ölçü w×h kalır.
    const frame = FIXTURE_LAYOUT.frame
    assert.ok(
      svg.includes(
        `width="${frame.width - frame.thickness}" height="${frame.height - frame.thickness}" ` +
          `fill="none" stroke="#000" stroke-width="${frame.thickness}"`,
      ),
      'dış çerçeve mevcut',
    )
    // BÖLÜM ÇİZGİLERİ: ^GBw,0 yatay + ^GB0,h dikey (sıfır boyut düşürülmez).
    for (const lineY of FIXTURE_LAYOUT.sectionLines) {
      assert.ok(
        svg.includes(
          `<rect x="20" y="${lineY}" width="760" height="${FIXTURE_LAYOUT.sectionLineThickness}" fill="#000"/>`,
        ),
        `yatay bölüm çizgisi eksik (y=${lineY})`,
      )
    }
    const rail = FIXTURE_LAYOUT.railLine
    assert.ok(
      svg.includes(
        `<rect x="${rail.x}" y="${rail.y}" width="${rail.thickness}" height="${rail.height}" fill="#000"/>`,
      ),
      'dikey ray çizgisi eksik',
    )
    // 1D barkod + insan-okur numara
    assert.ok(
      new RegExp(`height="${FIXTURE_LAYOUT.barcode.height}" fill="#000"`).test(svg),
      '1D barkod çubukları',
    )
    assert.ok(svg.includes(`>${FIXTURE_DATA.barcode}<`), 'barkod altı numara')
    // Rota, aktarma, dikey sipariş numarası
    assert.ok(/ORNEKSEHIR/.test(svg), 'rota mevcut')
    assert.ok(/AKTARMA/.test(svg), 'aktarma mevcut')
    assert.ok(
      svg.includes(
        `rotate(270 ${FIXTURE_LAYOUT.verticalOrderBaseline.x} ${FIXTURE_LAYOUT.verticalOrderBaseline.y})`,
      ),
      'dikey sipariş numarası mevcut',
    )
    // Matris kodlar: fixture'a göre en az biri (modül ölçüsü KAYNAK ZPL'den).
    const dmModule = FIXTURE_LAYOUT.dataMatrix.module
    const qrModule = FIXTURE_LAYOUT.qr.magnification
    const hasMatrix =
      new RegExp(`width="${dmModule}" height="${dmModule}" fill="#000"`).test(svg) ||
      new RegExp(`width="${qrModule}" height="${qrModule}" fill="#000"`).test(svg)
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

// ═══ FİZİKSEL DOĞRULAMA HAZIRLIĞI ══════════════════════════════════════════
//
// İki dosya üretilir ve REPODA tutulur:
//   fixtures/surat-svg/sentetik-reference.svg        → tek etiketin SVG'si
//   fixtures/surat-svg/sentetik-reference-print.html → Chrome'dan doğrudan
//                                                      yazdırılabilir belge
// Print HTML @page { size: 100mm 100mm; margin: 0; } içerir; tarayıcıda
// açılıp Ctrl+P ile 100 × 100 mm etikete basılabilir.
//
// UYARI: bu dosyalar YALNIZ fiziksel testi KOLAYLAŞTIRIR. Bu turda gerçek
// yazıcı veya tarayıcı baskı testi YAPILMAMIŞTIR.
test('SNAP-REFERENCE: Chrome print test dosyaları üretilir ve güncel kalır', async () => {
  const { page, html } = await renderFixture(
    FIXTURES.find((item) => item.name === '01-single-short-product'),
  )
  const svgFile = join(SNAPSHOT_DIR, 'sentetik-reference.svg')
  const htmlFile = join(SNAPSHOT_DIR, 'sentetik-reference-print.html')
  if (UPDATE) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true })
    writeFileSync(svgFile, page.render.svg, 'utf8')
    writeFileSync(htmlFile, html, 'utf8')
    return
  }
  assert.ok(existsSync(svgFile), `referans SVG yok: ${svgFile}`)
  assert.ok(existsSync(htmlFile), `referans print HTML yok: ${htmlFile}`)
  assert.equal(readFileSync(svgFile, 'utf8'), page.render.svg, 'referans SVG bayat')
  const printHtml = readFileSync(htmlFile, 'utf8')
  assert.equal(printHtml, html, 'referans print HTML bayat')
  assert.ok(printHtml.includes('@page { size: 100mm 100mm; margin: 0; }'))
  assert.ok(printHtml.includes('viewBox="0 0 799 799"'))
  // Tek sayfa, sonda page-break YOK.
  assert.equal((printHtml.match(/class="surat-official-page"/g) ?? []).length, 1)
})
