// RESMI SURAT BASKI BELGESI — motor PNG'sini 100 x 100 mm tek sayfaya koyar.
//
// KURAL: motor ciktisi DEGISTIRILMEZ. Goruntu uzerine metin, cizgi, barkod
// veya urun bilgisi overlay'i EKLENMEZ; urun satiri zaten printZpl icindeki
// ZPL komutlarindan gelir ve motor tarafindan cizilir.
//
// Olcu: PNG 799 x 799 px (203 dpi). Sayfa 100 mm; tarayici yeniden
// olceklemesini gorunur kilmamak icin image-rendering: pixelated kullanilir.
export function buildSuratPrintDocumentHtml(pages) {
  const body = pages
    .map(
      (page) =>
        `<section class="surat-page"><img alt="" src="data:image/png;base64,${page.imageBase64}"></section>`,
    )
    .join('')
  return [
    '<!doctype html><html lang="tr"><head><meta charset="utf-8" />',
    '<title>Surat Etiket</title><style>',
    '@page { size: 100mm 100mm; margin: 0; }',
    'html, body { width: 100mm; height: 100mm; margin: 0; padding: 0; background: #fff; }',
    '.surat-page { width: 100mm; height: 100mm; margin: 0; padding: 0; overflow: hidden;',
    '  page-break-inside: avoid; break-inside: avoid; }',
    // Son sayfadan SONRA break YOK: ikinci bos sayfa olusmaz.
    '.surat-page + .surat-page { page-break-before: always; break-before: page; }',
    '.surat-page img { display: block; width: 100mm; height: 100mm; image-rendering: pixelated; }',
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('')
}
