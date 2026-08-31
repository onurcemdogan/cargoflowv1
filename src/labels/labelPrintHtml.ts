// BASKI HTML'İ — İLKELLERDEN ÜRETİLİR.
//
// Bileşenden AYRI bir modüldür: baskı yolu React'a bağlı değildir ve bileşen
// dosyasının yanında durmak hızlı yenilemeyi bozardı. Daha önemlisi, yerleşim
// kararları BURADA VERİLMEZ; hepsi `renderLabelDocument` çıktısından gelir.
// Böylece tuvalde görülen ile basılan arasında yerleşim farkı OLUŞAMAZ.

import type { LabelPrimitive } from './labelDocumentRenderer.ts'
import type { LabelBaseLayer } from './labelBaseLayer.ts'
import { mmToPt, ptToMm } from './labelGeometry.ts'

/**
 * TABAN KATMAN HTML'İ — taşıyıcının GERÇEK etiketi, ilkellerin ALTINDA.
 *
 * ═══ NEDEN GÖRÜNTÜ ═══════════════════════════════════════════════════════
 * Taşıyıcı etiketinin gövdesi CargoFlow tarafından ÇİZİLMEZ. Taban, taşıyıcı
 * ZPL'inin render edilmiş PNG'sidir ve baskıda AYNEN kullanılır. Tuval de
 * AYNI base64'ü gösterir; iki yol arasında yeniden çizim YOKTUR, dolayısıyla
 * ayrışma da olamaz.
 *
 * Görüntü fiziksel milimetreye sabitlenir (100×100 mm) ve `z-index` ile en
 * altta kalır: kiracı öğeleri her zaman ÜSTÜNE çizilir.
 */
export function baseLayerToPrintHtml(baseLayer: LabelBaseLayer): string {
  const style =
    'position:absolute;left:0;top:0;' +
    `width:${baseLayer.widthMm}mm;height:${baseLayer.heightMm}mm;` +
    'z-index:0;'
  return (
    `<img class="lp-base" alt="" data-render-sha="${baseLayer.renderSha256}" ` +
    `src="data:image/png;base64,${baseLayer.imageBase64}" style="${style}">`
  )
}

/**
 * Baskı belgesi için AYNI ilkellerden HTML üretir.
 *
 * React ağacı yerine dize döndürür çünkü baskı, gizli iframe'e yazılan bir
 * belgedir. Yerleşim değerleri TUVALDEKİYLE AYNI ilkellerden gelir; birim
 * milimetredir (yakınlaştırmadan bağımsız, fiziksel).
 */
export interface PrintPrimitiveRenderers {
  /** CODE128 SVG üretici. Verilmezse yalnız veri taşıyan yer tutucu yazılır. */
  barcode?: (value: string) => string
  /** QR SVG üretici. */
  qr?: (value: string) => string
}

export function primitivesToPrintHtml(
  primitives: LabelPrimitive[],
  renderers: PrintPrimitiveRenderers = {},
): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  return primitives
    .map((primitive) => {
      const box =
        `position:absolute;left:${primitive.rect.x}mm;top:${primitive.rect.y}mm;` +
        `width:${primitive.rect.width}mm;height:${primitive.rect.height}mm;` +
        // Kiracı öğeleri taban görüntünün DAİMA üstünde kalır.
        'overflow:hidden;z-index:1;'
      if (primitive.kind === 'barcode') {
        const inner = renderers.barcode ? renderers.barcode(primitive.value) : ''
        return (
          `<div class="lp lp-barcode" data-element-id="${escape(primitive.elementId)}" ` +
          `data-barcode-value="${escape(primitive.value)}" style="${box}">${inner}</div>`
        )
      }
      if (primitive.kind === 'qr') {
        const inner = renderers.qr ? renderers.qr(primitive.value) : ''
        return (
          `<div class="lp lp-qr" data-element-id="${escape(primitive.elementId)}" ` +
          `data-qr-value="${escape(primitive.value)}" style="${box}">${inner}</div>`
        )
      }
      const text =
        `${box}font-size:${primitive.fontSizePt}pt;` +
        `font-weight:${primitive.bold ? 700 : 400};` +
        `text-align:${primitive.align};line-height:${primitive.lineHeight};`
      const lines = primitive.lines
        .map((line) => `<div>${escape(line) || '&nbsp;'}</div>`)
        .join('')
      return (
        `<div class="lp lp-text" data-element-id="${escape(primitive.elementId)}" ` +
        `data-font-pt="${mmToPt(ptToMm(primitive.fontSizePt))}" style="${text}">${lines}</div>`
      )
    })
    .join('')
}
