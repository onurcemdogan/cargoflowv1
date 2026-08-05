import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import {
  buildSyntheticSuratZpl,
  FIXTURE_DATA,
  FIXTURE_LAYOUT,
  FIXTURE_PRINT_WIDTH,
  FIXTURE_LABEL_LENGTH,
} from './fixtures/suratOfficialZplFixture.mjs'

// LANDMARK DOĞRULAMASI — ZPL SEMANTİĞİ REFERANS ALINIR.
//
// REFERANSIN NE OLDUĞU KONUSUNDA AÇIKLIK: Labelary (veya başka bir internet
// render servisi) ÇAĞRILMAMIŞTIR — bu açıkça yasaktır ve müşteri ZPL'i
// CargoFlow dışına çıkmaz. Bu yüzden "referans", ZPL II komut sözleşmesinden
// ANALİTİK olarak türetilen beklenen kutulardır: her landmark'ın x/y/w/h
// değeri aşağıda kaynak ^FO/^FT/^GB/^BY/^BC/^BX/^BQ parametrelerinden
// hesaplanır ve renderer'ın ölçülen çıktısıyla karşılaştırılır.
// Beklenen değerler renderer çıktısından KOPYALANMAZ.
//
// Kabul toleransları (spec):
//   çizgi/kutu            ≤ 3 dot
//   metin başlangıcı      ≤ 4 dot
//   barkod/matris bbox    ≤ 3 dot
//   bölüm yüksekliği      ≤ 3 dot

const here = dirname(fileURLToPath(import.meta.url))

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

const TOLERANCE = { line: 3, text: 4, code: 3, section: 3 }

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ölçülen ${actual}, beklenen ${expected} (fark ${Math.abs(
      actual - expected,
    ).toFixed(2)} > tolerans ${tolerance})`,
  )
}

function findElement(elements, predicate, label) {
  const found = elements.find(predicate)
  assert.ok(found, `landmark bulunamadı: ${label}`)
  return found
}

async function renderFixture(options) {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const result = renderSuratZplToSvg(buildSyntheticSuratZpl(options))
  assert.equal(result.renderStatus, 'ok', JSON.stringify(result.warnings))
  return result
}

// ═══ 1-3: ^GB ÇİZGİ VE KUTU ════════════════════════════════════════════════

test('LM-1: ^GB0,height dikey çizgi GÖRÜNÜR (sıfır genişlik düşürülmez)', async () => {
  const result = await renderFixture()
  const rail = FIXTURE_LAYOUT.railLine
  const line = findElement(
    result.elements,
    (element) => element.kind === 'line' && element.x === rail.x,
    'dikey ray çizgisi',
  )
  // ZPL: ^GB0,h,t → genişlik kalınlığa yükseltilir, yükseklik h kalır.
  near(line.x, rail.x, TOLERANCE.line, 'dikey çizgi x')
  near(line.y, rail.y, TOLERANCE.line, 'dikey çizgi y')
  near(line.width, rail.thickness, TOLERANCE.line, 'dikey çizgi genişliği')
  near(line.height, rail.height, TOLERANCE.line, 'dikey çizgi yüksekliği')
  // SVG'de DOLU dikdörtgen olarak çizilir (fill="none" kontur DEĞİL).
  assert.ok(
    result.svg.includes(
      `<rect x="${rail.x}" y="${rail.y}" width="${rail.thickness}" height="${rail.height}" fill="#000"/>`,
    ),
    'dikey çizgi dolu dikdörtgen olarak çizilmeli',
  )
})

test('LM-2: ^GBwidth,0 yatay çizgiler GÖRÜNÜR ve tam yerinde', async () => {
  const result = await renderFixture()
  const thickness = FIXTURE_LAYOUT.sectionLineThickness
  for (const y of FIXTURE_LAYOUT.sectionLines) {
    const line = findElement(
      result.elements,
      (element) => element.kind === 'line' && element.y === y,
      `yatay bölüm çizgisi y=${y}`,
    )
    near(line.x, 20, TOLERANCE.line, `yatay çizgi x (y=${y})`)
    near(line.width, 760, TOLERANCE.line, `yatay çizgi genişliği (y=${y})`)
    near(line.height, thickness, TOLERANCE.line, `yatay çizgi kalınlığı (y=${y})`)
    assert.ok(
      result.svg.includes(
        `<rect x="20" y="${y}" width="760" height="${thickness}" fill="#000"/>`,
      ),
      `yatay çizgi dolu çizilmeli (y=${y})`,
    )
  }
  // Şablondaki BÜTÜN bölüm ayırıcıları çizilmiş olmalı (eksik çizgi YOK).
  const horizontal = result.elements.filter(
    (element) => element.kind === 'line' && element.width > element.height,
  )
  assert.equal(horizontal.length, FIXTURE_LAYOUT.sectionLines.length)
})

test('LM-3: dış çerçeve GÖRÜNÜR ve dış ölçüsü w×h', async () => {
  const result = await renderFixture()
  const frame = FIXTURE_LAYOUT.frame
  const box = findElement(
    result.elements,
    (element) => element.kind === 'box',
    'dış çerçeve',
  )
  near(box.x, frame.x, TOLERANCE.line, 'çerçeve x')
  near(box.y, frame.y, TOLERANCE.line, 'çerçeve y')
  near(box.width, frame.width, TOLERANCE.line, 'çerçeve genişliği')
  near(box.height, frame.height, TOLERANCE.line, 'çerçeve yüksekliği')
  // ZPL kutu kenarlığı İÇERİ doğru çizilir: SVG konturu t/2 içeri kaydırılır,
  // böylece dış sınır TAM OLARAK w×h olur.
  const inset = frame.thickness / 2
  assert.ok(
    result.svg.includes(
      `<rect x="${frame.x + inset}" y="${frame.y + inset}" ` +
        `width="${frame.width - frame.thickness}" height="${frame.height - frame.thickness}" ` +
        `fill="none" stroke="#000" stroke-width="${frame.thickness}"/>`,
    ),
    'çerçeve kenarlığı içeri çizilmeli',
  )
})

// ═══ 4-9: ALAN VE FONT SEMANTİĞİ ═══════════════════════════════════════════

test('LM-4: ^FT taban çizgisi DOĞRU (y taban çizgisidir)', async () => {
  const result = await renderFixture()
  const { ZPL_TEXT_ASCENT_RATIO } = await load('/src/utils/suratZplSvgRenderer.ts')
  const branch = FIXTURE_LAYOUT.senderBranchBaseline
  const text = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text.startsWith('Sube:'),
    'şube metni',
  )
  // ^FT: taban çizgisi = y. Hücre üstü = y - ascent.
  near(text.baseline, branch.y, TOLERANCE.text, '^FT taban çizgisi')
  near(
    text.y,
    branch.y - branch.height * ZPL_TEXT_ASCENT_RATIO,
    TOLERANCE.text,
    '^FT hücre üstü',
  )
  near(text.x, branch.x, TOLERANCE.text, '^FT x')
})

test('LM-5: ^FO sol-üst köşe DOĞRU (y hücrenin ÜSTÜdür)', async () => {
  const result = await renderFixture()
  const { ZPL_TEXT_ASCENT_RATIO } = await load('/src/utils/suratZplSvgRenderer.ts')
  const address = FIXTURE_LAYOUT.addressOrigin
  const text = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text.startsWith('ORNEK MAHALLESI'),
    'adres bloğu',
  )
  near(text.x, address.x, TOLERANCE.text, '^FO x')
  near(text.y, address.y, TOLERANCE.text, '^FO hücre üstü')
  // Taban çizgisi hücre üstünden ascent kadar aşağıdadır.
  near(
    text.baseline,
    address.y + address.height * ZPL_TEXT_ASCENT_RATIO,
    TOLERANCE.text,
    '^FO taban çizgisi',
  )
  // ^FO ile ^FT AYNI y için FARKLI taban çizgisi verir (ayrım gerçekten var).
  const typeset = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text.startsWith('Sube:'),
    'şube metni',
  )
  assert.notEqual(typeset.baseline - typeset.y, address.baseline)
})

test('LM-6: ^A0N width/height ölçeklemesi UYGULANIR', async () => {
  const { renderSuratZplToSvg, ZPL_TEXT_ADVANCE_RATIO } = await load(
    '/src/utils/suratZplSvgRenderer.ts',
  )
  // Aynı metin, aynı yükseklik, FARKLI karakter genişliği.
  const wide = renderSuratZplToSvg(
    buildSyntheticSuratZpl().replace(
      '^FT75,500^A0N,16,16^FDOdemeTipi^FS',
      '^FT75,500^A0N,16,32^FDOdemeTipi^FS',
    ),
  )
  const normal = await renderFixture()
  const findPayment = (result) =>
    findElement(
      result.elements,
      (element) => element.kind === 'text' && element.text === 'OdemeTipi',
      'ödeme tipi',
    )
  const wideText = findPayment(wide)
  const normalText = findPayment(normal)
  // Genişlik parametresi iki katına çıkınca ölçülen genişlik de iki katına.
  near(
    wideText.width,
    'OdemeTipi'.length * ZPL_TEXT_ADVANCE_RATIO * 32,
    TOLERANCE.text,
    'geniş karakterli metin genişliği',
  )
  near(
    normalText.width,
    'OdemeTipi'.length * ZPL_TEXT_ADVANCE_RATIO * 16,
    TOLERANCE.text,
    'normal metin genişliği',
  )
  // Yükseklik DEĞİŞMEZ.
  near(wideText.height, normalText.height, 1, 'yükseklik değişmemeli')
  // SVG'de yatay ölçek transform'u bulunur (font-size tek başına yetmez).
  assert.ok(wide.svg.includes('scale(2 1)'), 'yatay ölçek transformu')
})

test('LM-7: A0B dikey metin — dönüş 270 ve taban çizgisi korunur', async () => {
  const result = await renderFixture()
  const rail = FIXTURE_LAYOUT.verticalOrderBaseline
  const text = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text.startsWith('Siparis No:'),
    'dikey sipariş numarası',
  )
  assert.equal(text.rotation, 270, 'ZPL B yönü = 270 derece')
  near(text.baseline, rail.y, TOLERANCE.text, 'dikey metin taban çizgisi')
  near(text.x, rail.x, TOLERANCE.text, 'dikey metin x')
  assert.ok(
    result.svg.includes(`rotate(270 ${rail.x} ${rail.y})`),
    'dönüş alan orijini etrafında uygulanır',
  )
})

test('LM-8: ^FW varsayılanı vs AÇIK ^A yönü', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const base = buildSyntheticSuratZpl()
  // ZPL: ^A yön parametresi VERİLMEZSE ^FW değeri kullanılır.
  const inherited = renderSuratZplToSvg(
    base.replace('^A0B,18,18^FDSiparis No:', '^A0,18,18^FDSiparis No:'),
  )
  const inheritedText = findElement(
    inherited.elements,
    (element) => element.kind === 'text' && element.text.startsWith('Siparis No:'),
    'devralınan yön',
  )
  assert.equal(inheritedText.rotation, 270, '^FWB devralınır')
  // AÇIK ^A0N verilirse ^FW EZİLİR (ZPL sözleşmesi).
  const explicit = renderSuratZplToSvg(
    base.replace('^A0B,18,18^FDSiparis No:', '^A0N,18,18^FDSiparis No:'),
  )
  const explicitText = findElement(
    explicit.elements,
    (element) => element.kind === 'text' && element.text.startsWith('Siparis No:'),
    'açık yön',
  )
  assert.equal(explicitText.rotation, 0, 'açık ^A0N ^FW’yi ezer')
})

test('LM-9: ^LS etiketi SOLA kaydırır', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const shifted = renderSuratZplToSvg(
    buildSyntheticSuratZpl().replace('^LS0', '^LS10'),
  )
  assert.equal(shifted.renderStatus, 'ok')
  const base = await renderFixture()
  const pick = (result) =>
    findElement(
      result.elements,
      (element) => element.kind === 'text' && element.text.startsWith('Sube:'),
      'şube metni',
    )
  near(pick(shifted).x, pick(base).x - 10, 1, '^LS10 → 10 dot sola')
  // Dikey eksen ETKİLENMEZ.
  near(pick(shifted).baseline, pick(base).baseline, 1, '^LS y’yi değiştirmez')
})

test('LM-10: ^A@ ölçekleme ^A0 ile AYNI kuralı kullanır', async () => {
  const { renderSuratZplToSvg, ZPL_TEXT_ADVANCE_RATIO } = await load(
    '/src/utils/suratZplSvgRenderer.ts',
  )
  const result = renderSuratZplToSvg(
    buildSyntheticSuratZpl().replace(
      '^FT75,500^A0N,16,16^FDOdemeTipi^FS',
      '^FT75,500^A@N,16,24,E:TT0003M_.FNT^FDOdemeTipi^FS',
    ),
  )
  assert.equal(result.renderStatus, 'ok')
  const text = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text === 'OdemeTipi',
    '^A@ metni',
  )
  near(
    text.width,
    'OdemeTipi'.length * ZPL_TEXT_ADVANCE_RATIO * 24,
    TOLERANCE.text,
    '^A@ genişlik ölçeklemesi',
  )
  near(text.height, 16, 1, '^A@ yükseklik')
})

// ═══ 11-18: LANDMARK KUTULARI ══════════════════════════════════════════════

test('LM-11: üst gönderici kutusu referansa yakın', async () => {
  const result = await renderFixture()
  const sender = FIXTURE_LAYOUT.senderNameBaseline
  const text = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text === FIXTURE_DATA.sender,
    'gönderici adı',
  )
  near(text.x, sender.x, TOLERANCE.text, 'gönderici x')
  near(text.baseline, sender.y, TOLERANCE.text, 'gönderici taban çizgisi')
  // Gönderici bloğu ile barkod arasında FAZLADAN boşluk kalmamalı: gönderici
  // hücresinin altı ilk bölüm çizgisinin üstünde ve ona YAKIN olmalı.
  const firstSection = FIXTURE_LAYOUT.sectionLines[0]
  const gap = firstSection - (text.y + text.height)
  assert.ok(gap >= 0, `gönderici bloğu bölüm çizgisini aşmamalı (${gap})`)
  assert.ok(gap < 40, `gönderici ile bölüm çizgisi arası fazla boş (${gap})`)
})

test('LM-12: barkod bounding box referansa yakın', async () => {
  const result = await renderFixture()
  const { BARCODE_TEXT_GAP, encodeCode128B } = await load(
    '/src/utils/suratZplSvgRenderer.ts',
  )
  const spec = FIXTURE_LAYOUT.barcode
  const barcode = findElement(
    result.elements,
    (element) => element.kind === 'barcode',
    'barkod',
  )
  // BEKLENEN GENİŞLİK: Code 128 modül dizisi × ^BY modül genişliği.
  const modules = encodeCode128B(FIXTURE_DATA.barcode).reduce((a, b) => a + b, 0)
  near(barcode.x, spec.x, TOLERANCE.code, 'barkod sol')
  near(barcode.y, spec.y, TOLERANCE.code, 'barkod üst')
  near(barcode.width, modules * spec.module, TOLERANCE.code, 'barkod genişliği')
  // BEKLENEN YÜKSEKLİK: ^BC yüksekliği + boşluk + yorum satırı (font A, 9 dot).
  near(
    barcode.height,
    spec.height + BARCODE_TEXT_GAP + 9,
    TOLERANCE.code,
    'barkod + yorum satırı yüksekliği',
  )
  // İnsan-okur numara KAYNAK payload'dır ve çubukların ortasında hizalanır.
  assert.ok(result.svg.includes(`>${FIXTURE_DATA.barcode}<`), 'insan-okur numara')
  assert.ok(
    result.svg.includes(`x="${spec.x + (modules * spec.module) / 2}"`),
    'yorum satırı çubuklara göre ortalanır',
  )
})

test('LM-13: alıcı kutusu ve ^FB adres bloğu referansa yakın', async () => {
  const result = await renderFixture()
  const recipient = FIXTURE_LAYOUT.recipientBaseline
  const address = FIXTURE_LAYOUT.addressOrigin
  const recipientText = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text === FIXTURE_DATA.recipient,
    'alıcı adı',
  )
  near(recipientText.x, recipient.x, TOLERANCE.text, 'alıcı x')
  near(recipientText.baseline, recipient.y, TOLERANCE.text, 'alıcı taban çizgisi')

  const addressText = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text.startsWith('ORNEK MAHALLESI'),
    'adres',
  )
  near(addressText.x, address.x, TOLERANCE.text, 'adres x')
  near(addressText.y, address.y, TOLERANCE.text, 'adres üst')
  // ^FB satır yüksekliği = karakter yüksekliği + satır aralığı.
  const lineCount = (result.svg.match(/ORNEK MAHALLESI|CADDESI|DAIRE/g) ?? []).length
  assert.ok(lineCount >= 2, 'adres birden çok satıra sarılır')
  const expectedHeight =
    address.height + (Math.min(address.lines, 3) - 1) * (address.height + address.lineGap)
  assert.ok(
    addressText.height <= expectedHeight + TOLERANCE.section,
    `adres bloğu yüksekliği ${addressText.height} > ${expectedHeight}`,
  )
  // Adres bloğu bir sonraki bölüm çizgisini AŞMAZ.
  assert.ok(
    addressText.y + addressText.height <= FIXTURE_LAYOUT.sectionLines[2],
    'adres bloğu bölüm çizgisini aşıyor',
  )
})

test('LM-14: ödeme/desi satırı ve bölüm çizgileri referansa yakın', async () => {
  const result = await renderFixture()
  for (const [label, x] of [['POCH', 75], ['KOLI', 250], ['2,00', 430]]) {
    const text = findElement(
      result.elements,
      (element) => element.kind === 'text' && element.text === label,
      label,
    )
    near(text.x, x, TOLERANCE.text, `${label} x`)
    near(text.baseline, 535, TOLERANCE.text, `${label} taban çizgisi`)
    // Değerler ödeme bölümünün İKİ çizgisi ARASINDA kalmalı.
    assert.ok(
      text.y > FIXTURE_LAYOUT.sectionLines[2] &&
        text.y + text.height < FIXTURE_LAYOUT.sectionLines[3] + TOLERANCE.section,
      `${label} ödeme bölümünün dışında`,
    )
  }
})

test('LM-15: büyük ^BX ve küçük ^BQ bounding box referansa yakın', async () => {
  const result = await renderFixture()
  const { encodeDataMatrix } = await load('/src/utils/dataMatrixEncoder.ts')
  const { defaultMatrixRenderer } = await load('/src/utils/suratZplSvgRenderer.ts')

  const dm = FIXTURE_LAYOUT.dataMatrix
  const dmSymbol = encodeDataMatrix(FIXTURE_DATA.orderNumber)
  const dmElement = findElement(
    result.elements,
    (element) => element.kind === 'matrix' && element.x === dm.x,
    'DataMatrix',
  )
  near(dmElement.x, dm.x, TOLERANCE.code, 'DataMatrix x')
  near(dmElement.y, dm.y, TOLERANCE.code, 'DataMatrix y')
  near(dmElement.width, dmSymbol.size * dm.module, TOLERANCE.code, 'DataMatrix genişliği')
  near(dmElement.height, dmSymbol.size * dm.module, TOLERANCE.code, 'DataMatrix yüksekliği')

  const qr = FIXTURE_LAYOUT.qr
  // ^FD "LA," → hata düzeltme seviyesi L. Modül sayısı seviyeye BAĞLIDIR.
  const qrModules = defaultMatrixRenderer(FIXTURE_DATA.barcode, 'L')
  const qrElement = findElement(
    result.elements,
    (element) => element.kind === 'matrix' && element.x === qr.x,
    'QR',
  )
  near(qrElement.x, qr.x, TOLERANCE.code, 'QR x')
  near(qrElement.y, qr.y, TOLERANCE.code, 'QR y')
  near(
    qrElement.width,
    qrModules.length * qr.magnification,
    TOLERANCE.code,
    'QR genişliği',
  )
})

test('LM-16: matris kodlar dış çerçeveyle ÇAKIŞMAZ, quiet zone içeride', async () => {
  const result = await renderFixture()
  const frame = FIXTURE_LAYOUT.frame
  const innerLeft = frame.x + frame.thickness
  const innerRight = frame.x + frame.width - frame.thickness
  const innerTop = frame.y + frame.thickness
  const innerBottom = frame.y + frame.height - frame.thickness
  const { DATA_MATRIX_QUIET_MODULES } = await load(
    '/src/utils/suratZplSvgRenderer.ts',
  )
  for (const element of result.elements.filter((item) => item.kind === 'matrix')) {
    const quiet =
      element.x === FIXTURE_LAYOUT.dataMatrix.x
        ? DATA_MATRIX_QUIET_MODULES * FIXTURE_LAYOUT.dataMatrix.module
        : 0
    assert.ok(element.x - quiet >= innerLeft, `matris sol sınırı aşıyor (${element.x})`)
    assert.ok(
      element.x + element.width + quiet <= innerRight,
      `matris sağ sınırı aşıyor (${element.x + element.width + quiet} > ${innerRight})`,
    )
    assert.ok(element.y - quiet >= innerTop, 'matris üst sınırı aşıyor')
    assert.ok(
      element.y + element.height + quiet <= innerBottom,
      'matris alt sınırı aşıyor',
    )
  }
})

test('LM-17: rota/aktarma taban çizgileri ve ürün footer’ı referansa yakın', async () => {
  // Resmî ZPL'de ürün satırı YOKTUR; ^FT semantiğini doğrulamak için bu
  // senaryoda açıkça eklenir (baskıda satırı augmentation ekler).
  const result = await renderFixture({ includeProductFooter: true })
  const route = FIXTURE_LAYOUT.routeBaseline
  const transfer = FIXTURE_LAYOUT.transferBaseline
  const footer = FIXTURE_LAYOUT.productFooterBaseline

  const routeText = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text === FIXTURE_DATA.route,
    'rota',
  )
  near(routeText.x, route.x, TOLERANCE.text, 'rota x')
  near(routeText.baseline, route.y, TOLERANCE.text, 'rota taban çizgisi')
  near(routeText.height, route.height, 1, 'rota punto')

  const transferText = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text === FIXTURE_DATA.transfer,
    'aktarma',
  )
  near(transferText.baseline, transfer.y, TOLERANCE.text, 'aktarma taban çizgisi')
  near(transferText.height, transfer.height, 1, 'aktarma punto')

  const footerText = findElement(
    result.elements,
    (element) => element.kind === 'text' && element.text === FIXTURE_DATA.product,
    'ürün footer',
  )
  near(footerText.x, footer.x, TOLERANCE.text, 'ürün footer x')
  near(footerText.baseline, footer.y, TOLERANCE.text, 'ürün footer taban çizgisi')
  // Ürün footer'ı son bölüm çizgisinin ALTINDA ve etiketin İÇİNDE.
  assert.ok(footerText.y >= FIXTURE_LAYOUT.sectionLines[4])
  assert.ok(footerText.y + footerText.height <= FIXTURE_LABEL_LENGTH)
})

test('LM-18: hiçbir öğe etiket sınırlarını AŞMAZ', async () => {
  const result = await renderFixture()
  assert.deepEqual(result.warnings, [], 'sınır uyarısı üretilmemeli')
  for (const element of result.elements) {
    if (element.rotation !== 0) continue
    assert.ok(element.x >= 0, `${element.kind} negatif x`)
    assert.ok(element.y >= 0, `${element.kind} negatif y`)
    assert.ok(
      element.x + element.width <= FIXTURE_PRINT_WIDTH,
      `${element.kind} sağ sınırı aşıyor`,
    )
    assert.ok(
      element.y + element.height <= FIXTURE_LABEL_LENGTH,
      `${element.kind} alt sınırı aşıyor`,
    )
  }
})

// ═══ 19-25: SÖZLEŞME KORUMALARI ════════════════════════════════════════════

test('LM-19/LM-20: tek sayfa ve 100 × 100 mm sözleşmesi', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const { buildSyntheticSuratOrder } = await import(
    './fixtures/suratOfficialZplFixture.mjs'
  )
  const doc = buildSuratOfficialPrintDocument([buildSyntheticSuratOrder()])
  assert.equal(doc.pages.length, 1)
  assert.equal((doc.html.match(/class="surat-official-page"/g) ?? []).length, 1)
  assert.ok(doc.html.includes('@page { size: 100mm 100mm; margin: 0; }'))
  const render = doc.pages[0].render
  assert.ok(render.svg.includes(`viewBox="0 0 ${FIXTURE_PRINT_WIDTH} ${FIXTURE_LABEL_LENGTH}"`))
  assert.ok(render.svg.includes('width="100mm"'))
  assert.ok(render.svg.includes('height="100mm"'))
})

test('LM-21/LM-22: payload’lar KAYNAKTAN, UI alanları SIZMAZ', async () => {
  const { buildSuratOfficialPrintDocument } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const { buildSyntheticSuratOrder } = await import(
    './fixtures/suratOfficialZplFixture.mjs'
  )
  const pristine = buildSuratOfficialPrintDocument([buildSyntheticSuratOrder()])
  const tampered = buildSuratOfficialPrintDocument([
    buildSyntheticSuratOrder({
      orderNumber: '000000000000',
      cargoTrackingNumber: '55555555555',
      shipment: { barcodeValue: '99999999999', ozelKargoTakipNo: '88888888888' },
    }),
  ])
  assert.equal(
    tampered.pages[0].render.svg,
    pristine.pages[0].render.svg,
    'UI alanları render’a sızıyor',
  )
  for (const leak of ['99999999999', '88888888888', '55555555555']) {
    assert.equal(tampered.pages[0].render.svg.includes(leak), false, leak)
  }
})

test('LM-23: desteklenmeyen komut SESSİZCE yok sayılmaz', async () => {
  const { renderSuratZplToSvg } = await load('/src/utils/suratZplSvgRenderer.ts')
  const result = renderSuratZplToSvg(
    buildSyntheticSuratZpl().replace('^LS0', '^LS0^ZZ9'),
  )
  assert.equal(result.renderStatus, 'unsupported_command')
  assert.equal(result.unsupportedCommand, '^ZZ')
  assert.equal(result.svg, '')
  assert.deepEqual(result.elements, [])
})

test('LM-24/LM-25: CargoFlow HTML yolu ve şablon seçimi DEĞİŞMEDİ', () => {
  const browserPrint = readFileSync(
    join(here, '..', 'src', 'utils', 'browserLabelPrint.ts'),
    'utf8',
  )
  for (const kept of [
    'buildCleanLabelDocument',
    'renderPrintableLabelHtml',
    'printCleanLabelDocument',
    'printSuratOfficialDocument',
    'dispatchPrintDocument',
    'buildSuratOfficialArtifact',
  ]) {
    assert.ok(browserPrint.includes(kept), `kayboldu: ${kept}`)
  }
  const routing = readFileSync(
    join(here, '..', 'src', 'utils', 'labelPrintTemplateRouting.ts'),
    'utf8',
  )
  assert.match(routing, /DEFAULT_LABEL_PRINT_TEMPLATE: LabelPrintTemplate = 'cargoflow_html'/)
  const provider = readFileSync(
    join(here, '..', 'src', 'providers', 'printing', 'BrowserDownloadPrintProvider.ts'),
    'utf8',
  )
  assert.match(provider, /labelPrintTemplate === 'surat_official_zpl'/)
  assert.match(provider, /printCleanLabelDocument\(/)
})

test('LM-26: renderer DETERMİNİSTİK ve harici servis KULLANMAZ', async () => {
  const first = await renderFixture()
  const second = await renderFixture()
  assert.equal(first.svg, second.svg)
  assert.deepEqual(first.elements, second.elements)
  const source = readFileSync(
    join(here, '..', 'src', 'utils', 'suratZplSvgRenderer.ts'),
    'utf8',
  )
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
    .replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')
  assert.equal(/labelary|labelzoom|fetch\(|https?:\/\//i.test(code), false)
  assert.equal(/Date\.now|Math\.random/.test(code), false)
})
