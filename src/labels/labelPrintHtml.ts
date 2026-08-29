// BASKI HTML'İ — İLKELLERDEN ÜRETİLİR.
//
// Bileşenden AYRI bir modüldür: baskı yolu React'a bağlı değildir ve bileşen
// dosyasının yanında durmak hızlı yenilemeyi bozardı. Daha önemlisi, yerleşim
// kararları BURADA VERİLMEZ; hepsi `renderLabelDocument` çıktısından gelir.
// Böylece tuvalde görülen ile basılan arasında yerleşim farkı OLUŞAMAZ.

import type { LabelPrimitive } from './labelDocumentRenderer.ts'
import { mmToPt, ptToMm } from './labelGeometry.ts'

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
        'overflow:hidden;'
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
