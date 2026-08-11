import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

// TARAYICI BASKI BELGESI — 10 × 10 CM FIZIKSEL SAYFA SOZLESMESI.
//
// Bu paket YALNIZ browser-print HTML/CSS'ini kilitler. ZPL, T.No, Code128,
// DataMatrix, QR, footer, composer, printBundle sirasi, immutable artifact,
// LABEL_PRINTED ve local-agent/download yollari KAPSAM DISIDIR.
//
// NOT (bkz. rapor §8): CSS sayfayi 100 × 100 mm olarak TANIMLAR. Chrome'un
// onizlemede hangi KAGIDI sectigi ayrica yazici surucusunun 100×100 mm kagit
// boyutunu bildirmesine baglidir; CSS bunu garantiyle override EDEMEZ.

let vite

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
})

after(async () => {
  await vite?.close()
})

const load = (path) => vite.ssrLoadModule(path)
const DOC = '/src/utils/officialSuratPrintDocument.ts'

const page = (orderNumber) => ({
  orderNumber,
  imageBase64: 'AAAA',
  mimeType: 'image/png',
})

async function buildHtml(count) {
  const { buildOfficialSuratPrintDocument } = await load(DOC)
  const pages = Array.from({ length: count }, (_, index) =>
    page(`ORD-${index + 1}`),
  )
  return buildOfficialSuratPrintDocument(pages).html
}

/** CSS'i bosluklardan bagimsiz karsilastirmak icin normalize eder. */
const squash = (value) => value.replace(/\s+/g, ' ')

test('PRINT-10X10-1: @page boyutu KESIN 100mm 100mm', async () => {
  const html = squash(await buildHtml(1))
  assert.ok(
    html.includes('@page { size: 100mm 100mm; margin: 0; }'),
    'kanonik @page tanimi bulunmali',
  )
  // "auto" / A4 / Letter / landscape cikarimi YOK.
  assert.equal(/size:\s*auto/i.test(html), false)
  assert.equal(/\bA4\b/i.test(html), false)
  assert.equal(/\bLetter\b/i.test(html), false)
  assert.equal(/landscape|portrait/i.test(html), false)
})

test('PRINT-10X10-2: sayfa kenar boslugu SIFIR', async () => {
  const html = squash(await buildHtml(1))
  assert.ok(html.includes('margin: 0;'))
  assert.ok(html.includes('html, body { width: 100mm; margin: 0; padding: 0;'))
})

test('PRINT-10X10-3: fiziksel sayfa ogesi TAM 100mm x 100mm', async () => {
  const html = squash(await buildHtml(1))
  assert.ok(
    html.includes(
      '.surat-official-page { width: 100mm; height: 100mm; margin: 0; padding: 0; overflow: hidden;',
    ),
    'sayfa kutusu 100 × 100 mm olmali',
  )
})

test('PRINT-10X10-4: gorsel sayfayi TAM doldurur, A4 sarmalayici YOK', async () => {
  const html = squash(await buildHtml(1))
  assert.ok(
    html.includes(
      '.surat-official-page img { display: block; width: 100mm; height: 100mm;',
    ),
  )
  // Etiketi kucultecek kurallar OLMAMALI.
  assert.equal(/max-width/i.test(html), false)
  assert.equal(/max-height/i.test(html), false)
  // Olcek hilesi YOK (100mm belge → 100mm sayfa → %100).
  assert.equal(/transform:\s*scale/i.test(html), false)
  assert.equal(/\bzoom:/i.test(html), false)
})

test('PRINT-10X10-5: uygulama uretimi ustbilgi/altbilgi YOK', async () => {
  const html = await buildHtml(2)
  for (const forbidden of ['<header', '<footer', 'page-number', 'Sayfa ']) {
    assert.equal(
      html.includes(forbidden),
      false,
      `belge kendi ust/alt bilgisini URETMEMELI: ${forbidden}`,
    )
  }
  // Gorunur tek icerik etiket gorselleridir.
  assert.equal((html.match(/<section/g) ?? []).length, 2)
  assert.equal((html.match(/<img/g) ?? []).length, 2)
})

test('PRINT-10X10-6: 3 etiket → TAM 3 fiziksel sayfa', async () => {
  const html = await buildHtml(3)
  assert.equal((html.match(/class="surat-official-page"/g) ?? []).length, 3)
  const squashed = squash(html)
  assert.ok(squashed.includes('page-break-after: always; break-after: page;'))
})

test('PRINT-10X10-7: SONDA bos dorduncu sayfa YOK', async () => {
  const html = squash(await buildHtml(3))
  const lastChild = html.match(
    /\.surat-official-page:last-child \{[^}]*\}/,
  )?.[0]
  assert.ok(lastChild, ':last-child kurali bulunmali')
  assert.ok(lastChild.includes('page-break-after: auto'))
  assert.ok(lastChild.includes('break-after: auto'))
})

test('PRINT-10X10-8: coklu sayfa kardinalitesi (1/3/100) KORUNUR', async () => {
  for (const count of [1, 3, 100]) {
    const html = await buildHtml(count)
    assert.equal(
      (html.match(/class="surat-official-page"/g) ?? []).length,
      count,
      `${count} etiket → ${count} sayfa`,
    )
  }
  // KIRPMA REGRESYONU: govde TEK etiket boyuna sabitlenmemeli.
  const squashed = squash(await buildHtml(3))
  assert.equal(
    /html,\s*body\s*\{[^}]*height:\s*100mm/.test(squashed),
    false,
    'govdeye tek sayfa yuksekligi verilmemeli (2..N sayfa kirpilir)',
  )
  assert.equal(
    /html,\s*body\s*\{[^}]*overflow:\s*hidden/.test(squashed),
    false,
    'govdede overflow:hidden OLMAMALI',
  )
})

test('PRINT-10X10-9/10: belge kurucusu ARTIFACT/ZPL/kimlik URETMEZ', async () => {
  const { readFileSync } = await import('node:fs')
  // Yorumlar ayiklanir: sozlesme KODA bakar, aciklamaya degil.
  const source = readFileSync('src/utils/officialSuratPrintDocument.ts', 'utf8')
    .split(/\r?\n/)
    .filter(
      (line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'),
    )
    .join('\n')
  for (const forbidden of [
    '^XA',
    '^FO',
    '^BC',
    '^BQ',
    '^BX',
    'technicalZpl',
    'printZpl',
    'carrierPayload',
    'sha256',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `baski belgesi etiket katmanina dokunmamali: ${forbidden}`,
    )
  }
  // Belge YALNIZ motor PNG'sini yerlestirir; overlay/yeniden cizim YOK.
  const html = await buildHtml(1)
  assert.ok(html.includes('data:image/png;base64,'))
  assert.equal(/<canvas|<svg/i.test(html), false)
})

test('PRINT-10X10-MM: belgede piksel/inc sayfa birimi KULLANILMAZ', async () => {
  const html = squash(await buildHtml(2))
  // Sayfa geometrisi YALNIZ mm cinsindendir.
  assert.equal(/size:\s*\d+(\.\d+)?(px|in|pt)/i.test(html), false)
  assert.equal(/width:\s*\d+(\.\d+)?px/i.test(html), false)
  assert.equal(/height:\s*\d+(\.\d+)?px/i.test(html), false)
})
