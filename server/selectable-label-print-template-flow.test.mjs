import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// SEÇİLEBİLİR ETİKET BASKI ŞABLONU.
//
//   cargoflow_html     → mevcut CargoFlow HTML/CSS etiketi (VARSAYILAN)
//   surat_official_zpl → Sürat'in resmî ZPL düzeni, YEREL SVG render
//
// Mevcut HTML şablonu KALDIRILMADI; iki yol yan yana yaşar. Harici render
// servisi (Labelary vb.) KULLANILMAZ.
//
// Fixture'lar SENTETİKTİR: gerçek müşteri verisi, adres, telefon veya gerçek
// provider ZPL'i İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const shipmentDefaults = await import(
  './onboarding/shipmentDefaultsRepository.ts'
)

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

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

// SENTETİK resmî Sürat şablonu (dış çerçeveli, gerçekçi).
const OFFICIAL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO20,15^GB760,770,3^FS',
  '^FO60,20^A0N,28,28^FDSube: FERAH^FS',
  '^FO470,20^A0N,26,26^FDT.No: 21012920014311^FS',
  '^FO60,150^BY3^BCN,150,Y,N,N^FD01254596670^FS',
  '^FO60,345^A0N,24,24^FDALICI AD^FS',
  '^FO60,375^A0N,18,18^FB700,3,0,L,0^FDMAHALLE SOKAK NO ILCE IL^FS',
  '^FO60,480^A0N,20,20^FDOdemeTipi Birim Top Ds/Kg^FS',
  '^FO60,510^A0N,30,30^FDPOCH KOLI 2,00^FS',
  '^FO60,560^BXN,6,200^FD7270035184060553^FS',
  '^FO240,630^A0N,34,34^FDKARACADAG/04^FS',
  '^FO240,672^A0N,38,38^FDDIYARBAKIR AKTARMA^FS',
  '^FO660,560^BQN,2,6^FDLA,01254596670^FS',
  '^FWB', '^FO24,340^A0N,18,18^FDSiparis No: 7270035184060553^FS', '^FWN',
  '^PQ1,0,1,Y',
  '^XZ',
].join('\n')

function printableOrder(over = {}) {
  return {
    id: 'o-1',
    marketplace: 'Trendyol',
    orderNumber: '7270035184060553',
    packageId: 'PKG-1',
    customerName: 'TEST ALICI',
    address: 'TEST MAH 1',
    city: 'DIYARBAKIR',
    district: 'KAYAPINAR',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    desi: 2,
    desiSource: 'manual_total',
    items: [
      {
        id: 'l-1',
        productName: 'Scuba Seçil Detaylı Tesettür Siyah Elbise',
        quantity: 1,
        color: 'Siyah',
        size: '42',
        merchantSku: 'SCUBA-SEC01',
        barcode: 'BC-1',
      },
    ],
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: '21012920014311',
      tNo: '21012920014311',
      barcode: '01254596670',
      barkodNo: '01254596670',
      barcodeValue: '01254596670',
      ozelKargoTakipNo: '7270035184060553',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true,
      printEnabled: true,
      barcodeRaw: OFFICIAL,
      desi: 2,
    },
    ...over,
  }
}

// ═══ AYAR (21) ═════════════════════════════════════════════════════════════

test('LT-1/LT-8: ayar yoksa cargoflow_html; migration eklenmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'lt-1')
  // Alanı OLMAYAN eski kayıt.
  await db.insert(schema.organizationSettings).values({
    organizationId: org,
    settingsJson: { shipmentDefaults: { defaultUnitDesi: 2 } },
  })
  const read = await shipmentDefaults.getShipmentDefaults(db, org)
  assert.equal(read.labelPrintTemplate, 'cargoflow_html')
  assert.equal(shipmentDefaults.DEFAULT_LABEL_PRINT_TEMPLATE, 'cargoflow_html')
  // Bilinmeyen değer de güvenli varsayılana düşer.
  assert.equal(shipmentDefaults.normalizeLabelPrintTemplate('saçma'), 'cargoflow_html')
  assert.equal(shipmentDefaults.normalizeLabelPrintTemplate(undefined), 'cargoflow_html')
  assert.equal(
    shipmentDefaults.normalizeLabelPrintTemplate('surat_official_zpl'),
    'surat_official_zpl',
  )
  // Migration YOK.
  const sql = readdirSync(join(here, '..', 'drizzle'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'))
    .join('\n')
  assert.equal(/label_print_template|labelPrintTemplate/i.test(sql), false)
})

test('LT-2..LT-6: her iki şablon kaydedilir, korunur, org izole, diğer alanlar ezilmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const a = await makeOrg(db, 'lt-2-a')
  const b = await makeOrg(db, 'lt-2-b')
  await db.insert(schema.organizationSettings).values({
    organizationId: a,
    settingsJson: { onboarding: { completed: true } },
  })

  await shipmentDefaults.saveShipmentDefaults(db, a, {
    defaultUnitDesi: 2,
    multiplyByItemQuantity: false,
    labelPrintTemplate: 'surat_official_zpl',
  })
  const saved = await shipmentDefaults.getShipmentDefaults(db, a)
  assert.equal(saved.labelPrintTemplate, 'surat_official_zpl')
  // Reload sonrası korunur; diğer desi ayarları ezilmez.
  assert.equal(saved.defaultUnitDesi, 2)
  assert.equal(saved.multiplyByItemQuantity, false)
  // Diğer settings alanları korunur.
  const [row] = await db
    .select()
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, a))
  assert.equal(row.settingsJson.onboarding.completed, true)
  // Başka organizasyon ETKİLENMEZ.
  assert.equal(
    (await shipmentDefaults.getShipmentDefaults(db, b)).labelPrintTemplate,
    'cargoflow_html',
  )
  // Geri CargoFlow şablonuna dönülebilir.
  await shipmentDefaults.saveShipmentDefaults(db, a, {
    defaultUnitDesi: 2,
    multiplyByItemQuantity: false,
    labelPrintTemplate: 'cargoflow_html',
  })
  assert.equal(
    (await shipmentDefaults.getShipmentDefaults(db, a)).labelPrintTemplate,
    'cargoflow_html',
  )
})

test('LT-7: frontend normalize eksik/bilinmeyen değeri cargoflow_html yapar', async () => {
  const { normalizeTenantDesiConfig } = await load('/src/utils/orderDesi.ts')
  assert.equal(normalizeTenantDesiConfig(null).labelPrintTemplate, 'cargoflow_html')
  assert.equal(normalizeTenantDesiConfig({}).labelPrintTemplate, 'cargoflow_html')
  assert.equal(
    normalizeTenantDesiConfig({ labelPrintTemplate: 'surat_official_zpl' })
      .labelPrintTemplate,
    'surat_official_zpl',
  )
})

// ═══ CARGOFLOW HTML ŞABLONU KORUNDU (22) ═══════════════════════════════════

test('CH-1..CH-3: mevcut HTML baskı yolu ve fit zinciri KALDIRILMADI', async () => {
  const src = readFileSync(join(here, '..', 'src', 'utils', 'browserLabelPrint.ts'), 'utf8')
  for (const kept of [
    'buildCleanLabelDocument',
    'renderPrintableLabelHtml',
    'printCleanLabelDocument',
    'resolveLabelLayout',
    'ensurePersistentPrintFrame',
  ]) {
    assert.ok(src.includes(kept), `HTML yolu parçası kayboldu: ${kept}`)
  }
  // Layout profilleri yerinde.
  const profiles = readFileSync(
    join(here, '..', 'src', 'utils', 'labelLayoutProfile.ts'),
    'utf8',
  )
  for (const key of ['standard', 'compact-multi', 'dense-multi']) {
    assert.ok(profiles.includes(key), key)
  }
})

test('CH-4: HTML modu resmî ZPL renderer\'ı ÇAĞIRMAZ', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const { defaultLabelTemplate } = await load(
    '/src/services/integrationConfigService.ts',
  )
  const doc = buildCleanLabelDocument([printableOrder()], defaultLabelTemplate)
  assert.ok(doc.html.length > 0)
  // HTML çıktısı SVG render sözleşmesini İÇERMEZ.
  assert.equal(doc.html.includes('viewBox="0 0 799 799"'), false)
  assert.equal(doc.printable.length, 1)
})

// ═══ RESMÎ SÜRAT SVG RENDER (23) ═══════════════════════════════════════════

test('SV-1..SV-5: SVG sözleşmesi — viewBox, 100×100 mm, tek sayfa', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const doc = buildSuratOfficialPrintDocument([printableOrder()])
  assert.equal(doc.pages.length, 1)
  assert.equal(doc.skipped.length, 0)
  const { render } = doc.pages[0]
  assert.equal(render.renderStatus, 'ok')
  assert.ok(render.svg.includes('viewBox="0 0 799 799"'))
  assert.ok(render.svg.includes('width="100mm"'))
  assert.ok(render.svg.includes('height="100mm"'))
  assert.ok(render.svg.includes('preserveAspectRatio="none"'))
  assert.equal(render.widthDots, 799)
  assert.equal(render.heightDots, 799)
  assert.equal(render.widthMm, 100)
  assert.equal(render.heightMm, 100)
  assert.equal(render.renderVersion, 'surat-zpl-svg-v1')
  assert.ok(render.templateFingerprint)
  // @page 100mm ve tek sayfa (son sayfadan sonra break YOK).
  assert.ok(doc.html.includes('@page { size: 100mm 100mm; margin: 0; }'))
  assert.equal(
    (doc.html.match(/class="surat-official-page"/g) ?? []).length,
    1,
  )
})

test('SV-6..SV-20: resmî alanlar ve ürün bilgisi SVG\'de görünür', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const svg = buildSuratOfficialPrintDocument([printableOrder()]).pages[0].render.svg
  // 6) dış çerçeve çizilir
  assert.ok(svg.includes('width="760" height="770"'), 'dış çerçeve')
  // 7-15) resmî alanlar
  for (const [name, needle] of [
    ['gönderici şubesi', 'Sube: FERAH'],
    ['T.No', 'T.No: 21012920014311'],
    ['alıcı', 'ALICI AD'],
    ['adres', 'MAHALLE'],
    ['ödeme/birim/desi', 'POCH KOLI 2,00'],
    ['rota', 'KARACADAG/04'],
    ['aktarma', 'DIYARBAKIR AKTARMA'],
    ['dikey sipariş no', 'Siparis No: 7270035184060553'],
  ]) {
    assert.ok(svg.includes(needle), `resmî alan yok: ${name}`)
  }
  // 8/9) 1D barkod çubukları + altındaki insan-okur sayı
  assert.ok((svg.match(/<rect/g) ?? []).length > 20, '1D barkod çubukları')
  assert.ok(svg.includes('>01254596670<'), 'barkod altı sayı')
  // 12) büyük QR (yerel üreteç ile gerçek modüller)
  assert.ok((svg.match(/<rect/g) ?? []).length > 100, 'QR modülleri')
  // 16-20) ürün adı, adet, renk, beden, SKU
  for (const needle of [
    '1 x Scuba Seçil Detaylı Tesettür Siyah Elbise',
    'Renk: Siyah',
    'Beden: 42',
    'SCUBA-SEC01',
  ]) {
    assert.ok(svg.includes(needle), `ürün bilgisi yok: ${needle}`)
  }
})

test('SV-BARCODE: barkod ve QR payload KAYNAKTAN gelir, yeniden üretilmez', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  // Sipariş alanları FARKLI olsa bile ZPL payload'ı kullanılır.
  const order = printableOrder({
    shipment: {
      ...printableOrder().shipment,
      // UI alanları değişti; kaynak ZPL AYNI kaldı.
      barcodeValue: '99999999999',
    },
  })
  const svg = buildSuratOfficialPrintDocument([order]).pages[0].render.svg
  assert.ok(svg.includes('>01254596670<'), 'kaynak ZPL barkodu korunur')
  assert.equal(svg.includes('99999999999'), false, 'UI alanı barkoda sızmaz')
})

test('SV-TR: Türkçe karakterler bozulmaz, font eşlemesi TEK yerdedir', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const { ZPL_FONT_STACK } = await load('/src/utils/suratZplSvgRenderer.ts')
  const svg = buildSuratOfficialPrintDocument([printableOrder()]).pages[0].render.svg
  assert.ok(svg.includes('Seçil'), 'ç korunur')
  assert.ok(svg.includes('Detaylı'), 'ı korunur')
  assert.ok(svg.includes('Tesettür'), 'ü korunur')
  assert.ok(svg.includes(ZPL_FONT_STACK), 'merkezî font yığını kullanılır')
})

test('SV-UNSUPPORTED: desteklenmeyen komut SESSİZCE yok sayılmaz', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const result = renderSuratZplToSvg(OFFICIAL.replace('^LS0', '^LS0^ZZ9'))
  assert.equal(result.renderStatus, 'unsupported_command')
  assert.equal(result.unsupportedCommand, '^ZZ')
  assert.equal(result.svg, '')
  assert.ok(result.warnings.length > 0)
  // Bilinmeyen şablon da açık durum döndürür.
  const foreign = ['^XA', '^PW600', '^LL400', '^FO10,10^A0N,20,20^FDX^FS', '^XZ'].join('\n')
  assert.equal(renderSuratZplToSvg(foreign).renderStatus, 'unsupported_template')
})

// ═══ TOPLU BASKI VE İZOLASYON (18/24) ══════════════════════════════════════

test('BATCH-1: her sipariş ayrı 100×100 mm sayfa; boş sayfa yok', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const doc = buildSuratOfficialPrintDocument([
    printableOrder({ id: 'a', packageId: 'PKG-A', orderNumber: '111' }),
    printableOrder({ id: 'b', packageId: 'PKG-B', orderNumber: '222' }),
  ])
  assert.equal(doc.pages.length, 2)
  assert.equal((doc.html.match(/class="surat-official-page"/g) ?? []).length, 2)
  // Sayfalar ARASINDA break var, SONUNDA yok (ikinci boş sayfa oluşmaz).
  assert.ok(doc.html.includes('.surat-official-page + .surat-official-page'))
  assert.equal(doc.html.trim().endsWith('</body></html>'), true)
})

test('BATCH-2: bir siparişin render hatası diğerlerini DURDURMAZ', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const broken = printableOrder({
    id: 'broken',
    packageId: 'PKG-X',
    orderNumber: '333',
    shipment: {
      ...printableOrder().shipment,
      // Bilinmeyen şablon → render edilemez.
      barcodeRaw: ['^XA', '^PW600', '^LL400', '^FO10,10^A0N,20,20^FDX^FS', '^XZ'].join('\n'),
    },
  })
  const healthy = printableOrder({ id: 'ok', packageId: 'PKG-OK', orderNumber: '444' })
  const doc = buildSuratOfficialPrintDocument([broken, healthy])
  assert.equal(doc.pages.length, 1, 'sağlıklı sipariş basılır')
  assert.equal(doc.pages[0].orderNumber, '444')
  assert.equal(doc.skipped.length, 1)
  assert.match(
    doc.skipped[0].reason,
    /Resmî Sürat etiketi tarayıcıda görüntülenemedi/,
  )
})

// ═══ AUGMENTATION FALLBACK (16) ════════════════════════════════════════════

test('AUG-1: ürün satırı sığmasa da resmî ZPL render edilir', async () => {
  const { buildSuratOfficialPrintDocument, buildSuratPrintPageModel } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const impossible = Array.from({ length: 40 }, (_, index) => ({
    id: `l-${index}`,
    productName: `Cok Uzun Urun Adi ${index} Ekstra Detay Serisi Premium Koleksiyon`,
    quantity: 1,
    merchantSku: `SKU-${index}`,
    variantAttributes: [
      { name: 'Renk', value: 'Krem' },
      { name: 'Beden', value: '40' },
    ],
  }))
  const order = printableOrder({ items: impossible })
  const { model } = buildSuratPrintPageModel(order)
  assert.equal(model.augmentationStatus, 'overflow')
  assert.equal(
    model.augmentationWarning,
    'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.',
  )
  // Baskı YİNE mümkün: resmî ZPL render edilir.
  const doc = buildSuratOfficialPrintDocument([order])
  assert.equal(doc.pages.length, 1)
  assert.equal(doc.pages[0].render.renderStatus, 'ok')
  assert.ok(doc.pages[0].render.svg.includes('T.No: 21012920014311'))
})

test('AUG-2: eski technicalZpl-only kayıt (ürün satırı yok) render edilir', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const legacy = printableOrder({
    id: 'legacy',
    items: [],
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
  })
  const doc = buildSuratOfficialPrintDocument([legacy])
  assert.equal(doc.pages.length, 1)
  assert.equal(doc.pages[0].render.renderStatus, 'ok')
  assert.ok(doc.pages[0].render.svg.includes('01254596670'))
})

// ═══ GÜVENLİK ══════════════════════════════════════════════════════════════

test('SEC-1: harici render servisi ve PII/ham ZPL logu YOK', () => {
  const src = readFileSync(
    join(here, '..', 'src', 'utils', 'suratZplSvgRenderer.ts'),
    'utf8',
  )
  // Yorumlar ölçümden çıkarılır: dosyanın başlığı zaten 'Labelary
  // KULLANILMAZ' diyor ve bu yanlış pozitif üretiyordu. SVG namespace
  // (xmlns) de bir TANIMLAYICIDIR, ağ çağrısı değildir.
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')
  assert.equal(/labelary|labelzoom|fetch\(|https?:\/\//i.test(code), false)
  assert.equal(/console\.(log|info|warn|error)/.test(src), false)
  for (const field of ['customerName', 'customerPhone', 'apiKey', 'sifre']) {
    assert.equal(src.includes(field), false, field)
  }
})

test('SEC-2: yeni dependency EKLENMEDİ (mevcut qrcode-generator kullanılır)', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies['qrcode-generator'], 'mevcut bağımlılık')
  const src = readFileSync(
    join(here, '..', 'src', 'utils', 'suratZplSvgRenderer.ts'),
    'utf8',
  )
  assert.match(src, /from 'qrcode-generator'/)
})
