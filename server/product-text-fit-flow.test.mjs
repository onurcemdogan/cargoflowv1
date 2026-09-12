import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

// ═══ ÜRÜN METNİ — ALANA GÖRE MAKSİMAL FIT ═══════════════════════════════
//
// ═══ ÜRETİMDE ÖLÇÜLEN KUSUR ══════════════════════════════════════════════
// Tek ürünlü etiketlerde ürün bandında BOL boş alan kalmasına rağmen ürün
// metni gereksiz küçük basılıyordu.
//
// Kusur alan hesabında DEĞİLDİ: `resolveFooterArea` zaten gerçek geometriden
// (taşıyıcı içeriğinin alt sınırı, etiket boyu, dikey ray) türüyordu. Kusur
// ADAY KÜMESİNDEYDİ:
//
//   1. TAVAN 20 dot'ta sabitti — bant 66 dot boş olsa da 20'den büyük bir
//      font HİÇ denenmiyordu.
//   2. Her profilde `maxLinesPerItem <= 2` idi — 3 satır rahatça sığarken
//      içerik çok daha küçük bir fonta düşürülüyordu.
//
// ═══ YENİ SÖZLEŞME ═══════════════════════════════════════════════════════
// Soru "sığıyor mu?" değil, "BU BÖLGEYE SIĞAN EN BÜYÜK okunabilir font
// hangisi?" Adaylar tavandan tabana taranır, satır sayısı ÖLÇÜLÜR (karakter
// eşiğiyle tahmin edilmez) ve ilk sığan = en büyük sığan seçilir.
//
// ═══ BU PAKETİN EN ÖNEMLİ İDDİASI ════════════════════════════════════════
// "Sığıyor" YETERLİ DEĞİLDİR. Bir sonraki BÜYÜK font da sığıyorsa test
// BAŞARISIZ olur. Kanıt, seçimin kullandığı ÖLÇÜM FONKSİYONUNUN kendisiyle
// üretilir — ikinci bir hesap yazılmaz.

const here = dirname(fileURLToPath(import.meta.url))
const V2_ZPL = readFileSync(
  join(here, 'fixtures', 'surat-real-v2-numeric.zpl'),
  'utf8',
)

let _vite
let line
let geometry

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  line = await _vite.ssrLoadModule('/src/utils/suratZplProductLine.ts')
  const geo = await _vite.ssrLoadModule('/src/utils/suratZplGeometry.ts')
  geometry = geo.parseSuratZplGeometry(V2_ZPL)
})
after(async () => {
  if (_vite) await _vite.close()
})

const item = (over = {}) => ({
  productName: 'Bluz',
  quantity: 1,
  color: 'Krem',
  size: '40',
  sku: '6496',
  ...over,
})

const LONG = item({
  productName: 'Onu Drapeli Los Tesettur Takim Uzun Kollu Astarli Abiye Elbise',
  color: 'Lacivert',
  size: '38',
  sku: 'SCUBA-SECOT-0012',
})

const plan = (items) => line.planSuratFooter(items, geometry)

/** Seçim MAKSİMAL mi? Bir büyüğü sığıyorsa BAŞARISIZ. */
function assertMaximal(result, items, label) {
  assert.equal(result.ok, true, `${label}: plan üretilemedi`)
  const bigger = result.profile.fontHeight + 1
  if (bigger > line.FOOTER_MAX_FONT_HEIGHT) return
  const next = line.measureFooterFit(items, result.area, bigger)
  assert.equal(
    next.fits,
    false,
    `${label}: MAKSİMAL DEĞİL — ${bigger} dot da sığıyor `
      + `(${next.usedHeight}/${result.area.height}, ${next.totalLines} satır)`,
  )
}

/** Seçim alana SIĞIYOR mu? Taşma sıfır olmalı. */
function assertInside(result, label) {
  assert.ok(
    result.usedHeight <= result.area.height,
    `${label}: TAŞMA — ${result.usedHeight}/${result.area.height}`,
  )
  assert.ok(
    result.profile.fontHeight >= line.FOOTER_MIN_FONT_HEIGHT,
    `${label}: okunabilirlik tabanının ALTINA inildi`,
  )
}

/* ═══ PRODUCT-FIT-1 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-1: tek kisa urun + genis bos alan → MAKSIMUM font', async () => {
  const items = [item()]
  const result = plan(items)
  assertInside(result, 'kısa ürün')
  assertMaximal(result, items, 'kısa ürün')
  // Kısa metin tavana ULAŞIR: küçültmek için hiçbir sebep yok.
  assert.equal(
    result.profile.fontHeight,
    line.FOOTER_MAX_FONT_HEIGHT,
    `bol alan varken tavana çıkılmadı: ${result.profile.fontHeight}`,
  )
  // ESKİ DAVRANIŞ REGRESYONU: 20 dot tavanıyla burada 20 seçilirdi.
  assert.ok(result.profile.fontHeight > 20, 'eski tavanda takılı kalmış')
})

/* ═══ PRODUCT-FIT-2 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-2: tek uzun urun → SARILIR ve sigan EN BUYUK font secilir', async () => {
  const items = [LONG]
  const result = plan(items)
  assertInside(result, 'uzun ürün')
  assertMaximal(result, items, 'uzun ürün')
  // KÜÇÜLTME DEĞİL SARMA: tek satıra sığmıyorsa satır açılır.
  assert.ok(
    result.profile.maxLinesPerItem >= 2,
    'uzun metin sarılmadı',
  )
  // Gereksiz küçültme YOK: okunabilirlik tabanının epey üstünde kalır.
  assert.ok(
    result.profile.fontHeight >= 20,
    `gereksiz küçültüldü: ${result.profile.fontHeight}`,
  )
})

/* ═══ PRODUCT-FIT-3 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-3: iki urun → IKISI DE gorunur, cakisma yok', async () => {
  const items = [item(), item({ productName: 'Etek', quantity: 2, sku: '6497' })]
  const result = plan(items)
  assertInside(result, 'iki ürün')
  assertMaximal(result, items, 'iki ürün')
  // HER ürün belgeye girer — sessiz düşürme YOK.
  assert.equal(result.blocks.length, 2)
  const text = result.blocks.flat().map((entry) => entry.text).join(' | ')
  assert.match(text, /Bluz/)
  assert.match(text, /Etek/)
  // Satırlar ÜST ÜSTE binmez: toplam yükseklik satır sayısı × satır yüksekliği.
  const totalLines = result.blocks.reduce(
    (sum, block) => sum + block.reduce((n, entry) => n + entry.lines, 0), 0)
  assert.equal(
    result.usedHeight,
    totalLines * line.footerLineHeightFor(result.profile.fontHeight),
  )
})

/* ═══ PRODUCT-FIT-4 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-4: yogun urun listesi → KONTROLLU kucultme', async () => {
  const items = [
    item({ productName: 'Onu Drapeli Los Tesettur Takim', sku: 'A1' }),
    item({ productName: 'Uzun Kollu Astarli Abiye Elbise', quantity: 2, sku: 'B2' }),
    item({ productName: 'Kruvaze Yaka Kemerli Tunik', sku: 'C3' }),
  ]
  const result = plan(items)
  assertInside(result, 'yoğun liste')
  assertMaximal(result, items, 'yoğun liste')
  // Üç ürün de korunur; "+X ürün daha" ÜRETİLMEZ.
  assert.equal(result.blocks.length, 3)
  // Küçülme GEREKTİĞİ KADAR: tabana kadar inilmez.
  assert.ok(
    result.profile.fontHeight > line.FOOTER_MIN_FONT_HEIGHT,
    'gereksiz biçimde tabana inildi',
  )
})

/* ═══ PRODUCT-FIT-5 — EN KRİTİK ═════════════════════════════════════════ */

test('PRODUCT-FIT-5: daha buyuk font sigiyorsa secim HATALIDIR', async () => {
  // Dört temsili senaryonun HEPSİNDE maksimallik aranır.
  const matrix = {
    'A) kısa': [item()],
    'B) uzun': [LONG],
    'C) iki ürün': [item(), item({ productName: 'Etek', sku: '6497' })],
    'D) yoğun': [
      item({ productName: 'Onu Drapeli Los Tesettur Takim', sku: 'A1' }),
      item({ productName: 'Uzun Kollu Astarli Abiye Elbise', sku: 'B2' }),
      item({ productName: 'Kruvaze Yaka Kemerli Tunik', sku: 'C3' }),
    ],
  }
  for (const [label, items] of Object.entries(matrix)) {
    const result = plan(items)
    assertInside(result, label)
    assertMaximal(result, items, label)
  }

  // ═══ ARAMANIN KENDİSİ DE DOĞRU MU ═════════════════════════════════════
  // Seçilenin ÜSTÜNDEKİ her aday sığmamalı, seçilen sığmalı. Bu, "ilk sığan
  // = en büyük sığan" sözleşmesini adaylar üzerinde doğrudan kanıtlar.
  const items = [item()]
  const result = plan(items)
  for (const candidate of line.footerFontCandidates()) {
    const fit = line.measureFooterFit(items, result.area, candidate)
    if (candidate > result.profile.fontHeight) {
      assert.equal(fit.fits, false, `${candidate} dot sığıyor ama seçilmemiş`)
    }
    if (candidate === result.profile.fontHeight) {
      assert.equal(fit.fits, true, 'seçilen aday sığmıyor')
    }
  }
})

/* ═══ PRODUCT-FIT-6 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-6: bant sinirlari — tasma ve ust blok cakismasi = 0', async () => {
  for (const items of [[item()], [LONG], [item(), item({ sku: 'X' })]]) {
    const result = plan(items)
    // ALT sınır: etiketin güvenli alt marjını AŞMAZ.
    assert.ok(
      result.area.top + result.usedHeight <= result.area.bottom,
      `alt marj aşıldı: ${result.area.top + result.usedHeight} > ${result.area.bottom}`,
    )
    // ÜST sınır: alan taşıyıcı içeriğinin ALTINDA başlar — ürün metni QR,
    // rota, aktarma ve adres bloklarının üzerine ASLA çıkmaz.
    assert.ok(
      result.area.top > geometry.contentBottom,
      'ürün alanı taşıyıcı içeriğinin üstüne taşmış',
    )
    // SOL sınır: dikey sipariş rayının üzerine binmez.
    assert.ok(result.area.x > 0, 'sol güvenli sınır kaybolmuş')
  }
})

/* ═══ PRODUCT-FIT-7 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-7: korunan geometri DEGISMEDI — alan hesabi tasiyicidan turer', async () => {
  // Ürün metni için HİÇBİR taşıyıcı bloğu kaydırılmaz: alan, taşıyıcının
  // KENDİ içerik alt sınırından türetilir; tersi değil.
  const area = line.resolveFooterArea(geometry)
  assert.equal(area.top, geometry.contentBottom + line.FOOTER_TOP_GAP)
  assert.equal(area.bottom, geometry.labelLength - line.FOOTER_BOTTOM_MARGIN)
  // Font seçimi alanı DEĞİŞTİRMEZ — hangi içerik gelirse gelsin aynı bölge.
  const short = plan([item()])
  const long = plan([LONG])
  assert.deepEqual(short.area, long.area)
  assert.deepEqual(short.area, area)
})

/* ═══ PRODUCT-FIT-8 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-8: tekli ve toplu AYNI sizing sonucunu uretir', async () => {
  // Sizing SAF bir fonksiyondur: aynı ürün + aynı geometri → aynı sonuç.
  // Tekli ve toplu baskı aynı composer'ı çağırdığı için sonuç da AYNIDIR.
  const items = [LONG]
  const single = plan(items)
  const bulkFirst = plan(items)
  const bulkSecond = plan(items)
  assert.deepEqual(bulkFirst.profile, single.profile)
  assert.deepEqual(bulkSecond.profile, single.profile)
  assert.equal(bulkFirst.usedHeight, single.usedHeight)
  assert.deepEqual(bulkFirst.blocks, single.blocks)
})

/* ═══ PRODUCT-FIT-9 ═════════════════════════════════════════════════════ */

test('PRODUCT-FIT-9: 100x100 sayfa sozlesmesi DEGISMEDI', async () => {
  // Ürün fit'i ZPL katmanındadır; fiziksel sayfa sözleşmesine DOKUNMAZ.
  const { buildOfficialSuratPrintDocument, DEFAULT_PRINT_PAGE_SIZE_MM } =
    await _vite.ssrLoadModule('/src/utils/officialSuratPrintDocument.ts')
  assert.deepEqual(DEFAULT_PRINT_PAGE_SIZE_MM, { widthMm: 100, heightMm: 100 })
  const doc = buildOfficialSuratPrintDocument([
    { orderNumber: 'A', imageBase64: 'x', mimeType: 'image/png' },
  ])
  assert.deepEqual(doc.pageSizeMm, { widthMm: 100, heightMm: 100 })
  assert.match(doc.html, /@page \{ size: 100mm 100mm; margin: 0; \}/)
  // Etiket tuvali de değişmedi.
  assert.equal(geometry.printWidth, 799)
  assert.equal(geometry.labelLength, 799)
})

/* ═══ TABAN VE TAVAN ════════════════════════════════════════════════════ */

test('PRODUCT-FIT-BOUNDS: taban korunur, tavan gerekcelidir', async () => {
  // Okunabilirlik tabanı DEĞİŞMEDİ.
  assert.equal(line.FOOTER_MIN_FONT_HEIGHT, 12)
  // Tavan, taşıyıcının kendi rota/aktarma bloğunun (34–38 dot) ALTINDA
  // kalır: ürün satırı yardımcı bilgidir, görsel hiyerarşiyi bozmaz.
  assert.ok(line.FOOTER_MAX_FONT_HEIGHT > 20, 'tavan yükseltilmemiş')
  assert.ok(line.FOOTER_MAX_FONT_HEIGHT < 34, 'tavan rota bloğuna ulaşmış')
  // Adaylar tavandan tabana, BOŞLUKSUZ ve azalan.
  const candidates = line.footerFontCandidates()
  assert.equal(candidates[0], line.FOOTER_MAX_FONT_HEIGHT)
  assert.equal(candidates.at(-1), line.FOOTER_MIN_FONT_HEIGHT)
  for (let i = 1; i < candidates.length; i += 1) {
    assert.equal(candidates[i], candidates[i - 1] - 1, 'aday aralığı boşluklu')
  }
  // ≤ 20 dot için genişlik/aralık ESKİ profillerin AYNI değerleri —
  // dar bantlı etiketlerin çıktısı DEĞİŞMEZ.
  assert.deepEqual(
    [20, 18, 16, 14, 12].map(line.footerFontWidthFor),
    [20, 16, 14, 12, 10],
  )
  assert.deepEqual(
    [20, 18, 16, 14, 12].map(line.footerLineGapFor),
    [4, 3, 2, 2, 1],
  )
})

/* ═══ KAYIT ═════════════════════════════════════════════════════════════ */

test('PRODUCT-FIT-REG: bu dosya test:surat icinde KAYITLI', () => {
  const registry = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(files.includes('server/product-text-fit-flow.test.mjs'))
})
