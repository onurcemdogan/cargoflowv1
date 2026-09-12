// RESMÎ SÜRAT BASKI BELGESİ — motor PNG'sini 100 × 100 mm sayfaya koyar.
//
// KURAL: motor çıktısı DEĞİŞTİRİLMEZ. Görüntü üzerine metin, çizgi, barkod,
// matris kod veya ürün bilgisi OVERLAY'i EKLENMEZ; ürün satırı zaten
// printZpl içindeki ZPL komutlarından gelir ve zebrash tarafından çizilir.
// HTML/CSS ile Sürat etiketi YENİDEN TASARLANMAZ.

import {
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
} from '../labels/labelGeometry'

// ═══ SAYFA BOYUTU: TEK KAYNAK ════════════════════════════════════════════
//
// ÖLÇÜLEN KUSUR: `100mm` bu dosyada ÜÇ KEZ düz sabit olarak yazılıydı
// (@page, .surat-official-page, img). Aynı ölçü `labelGeometry` içinde
// KANONİK olarak zaten tanımlıydı. Üç literalden biri değişse belge
// sessizce tutarsızlaşırdı.
//
// ═══ RENDER ARTEFAKTININ mm DEĞERİ SAYFA KUTUSUNU BELİRLEMEZ ═════════════
// Sunucu render artefaktı `widthMm`/`heightMm` döndürür ve bunu baskı
// belgesine bağlamak İLK BAKIŞTA doğru görünür. DEĞİLDİR:
//
//   · Sayfa kutusu FİZİKSEL ETİKET STOĞUDUR — 10 × 10 cm. Bu bir üründür,
//     ölçülen bir değer değil.
//   · Artefaktın mm'si nokta sayısından TÜREYEN bir render ayrıntısıdır
//     (799 dot @ 203 dpi ≈ 99.9 mm) ve stoğa birebir eşit DEĞİLDİR.
//
// Türetilmiş değeri sayfa kutusuna yazmak, belgeyi fiziksel stoktan
// milimetrenin altında KAYDIRIRDI. Görüntü zaten `object-fit: fill` ile
// sayfayı TAM doldurur; doğru davranış, render'ı stoğa yaymaktır — stoğu
// render'a değil.
export const DEFAULT_PRINT_PAGE_SIZE_MM = Object.freeze({
  widthMm: LABEL_CANVAS_WIDTH_MM,
  heightMm: LABEL_CANVAS_HEIGHT_MM,
})

export interface PrintPageSizeMm {
  readonly widthMm: number
  readonly heightMm: number
}

export interface OfficialSuratPage {
  orderNumber: string
  imageBase64: string
  mimeType: string
}

export interface OfficialSuratSkip {
  orderNumber: string
  reason: string
}

export interface OfficialSuratDocument {
  html: string
  pages: OfficialSuratPage[]
  skipped: OfficialSuratSkip[]
  /** Belgenin GERÇEKTEN kullandığı sayfa ölçüsü — @page ile AYNI değer. */
  pageSizeMm: PrintPageSizeMm
}

function escapeAttribute(value: string): string {
  return String(value ?? '').replace(/[<>"&]/g, '')
}

/**
 * Tek belge, sayfa başına bir etiket. Sayfalar ARASINDA page-break vardır,
 * SONDA yoktur — ikinci boş sayfa oluşmaz.
 */
export function buildOfficialSuratPrintDocument(
  pages: OfficialSuratPage[],
  skipped: OfficialSuratSkip[] = [],
): OfficialSuratDocument {
  const { widthMm, heightMm } = DEFAULT_PRINT_PAGE_SIZE_MM
  const body = pages
    .map(
      (page) =>
        `<section class="surat-official-page" data-order="${escapeAttribute(
          page.orderNumber,
        )}"><img alt="" src="data:${escapeAttribute(
          page.mimeType || 'image/png',
        )};base64,${page.imageBase64}"></section>`,
    )
    .join('')
  const html = [
    '<!doctype html><html lang="tr"><head><meta charset="utf-8" />',
    '<title>Surat Etiket</title><style>',
    `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }`,
    // KÖK NEDEN (üretim, "2 sipariş seçtim 1 sayfa çıktı"):
    // `body` TEK etiket boyunda (height:100mm) ve `overflow:hidden` idi.
    // İlk `.surat-official-page` gövdeyi tamamen dolduruyor, 2..N sayfalar
    // gövdenin DIŞINA taşıp KIRPILIYORDU. Render, DOM ve muhasebe N
    // gösterirken Chrome yalnız 1 fiziksel sayfa basıyordu. jsdom layout
    // uygulamadığı için DOM sayan testler bunu GÖREMİYORDU.
    //
    // Gövde artık sayfa sayısına göre BÜYÜR; kırpma YOKTUR. Etiket
    // geometrisi (100 × 100 mm) DEĞİŞMEDİ — o `.surat-official-page`
    // ve `@page` üzerinde durur.
    'html, body {',
    `  width: ${widthMm}mm; margin: 0; padding: 0; background: #fff;`,
    '}',
    '.surat-official-page {',
    `  width: ${widthMm}mm; height: ${heightMm}mm; margin: 0; padding: 0; overflow: hidden;`,
    '  display: block; position: static;',
    '  page-break-inside: avoid; break-inside: avoid;',
    // HER etiket KENDİ fiziksel sayfasıdır.
    '  page-break-after: always; break-after: page;',
    '}',
    // SONDA boş sayfa üretilmez.
    '.surat-official-page:last-child {',
    '  page-break-after: auto; break-after: auto;',
    '}',
    '.surat-official-page img {',
    `  display: block; width: ${widthMm}mm; height: ${heightMm}mm;`,
    '  object-fit: fill; image-rendering: pixelated;',
    '}',
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('')
  return { html, pages, skipped, pageSizeMm: { widthMm, heightMm } }
}
