// İLKEL KATMANI — DÜZENLEYİCİ TUVALİ VE ÖNİZLEME AYNI BİLEŞENİ KULLANIR.
//
// Yerleşim kararları burada VERİLMEZ; hepsi `renderLabelDocument` tarafından
// verilmiş ve `LabelPrimitive[]` olarak gelmiştir. Bu bileşen yalnız o
// kararları piksele çevirir. Böylece tuvalde görülen ile basılan arasında
// yerleşim farkı OLUŞAMAZ.

import { BarcodePreview } from '../BarcodePreview'
import { QrCodeSvg } from '../QrCodeSvg'
import type { LabelPrimitive } from '../../labels/labelDocumentRenderer'
import { mmToPx, ptToMm } from '../../labels/labelGeometry'

interface LabelPrimitiveLayerProps {
  primitives: LabelPrimitive[]
  zoom: number
  /** Seçili öğe kimliği — YALNIZ düzenleyicide doludur. */
  selectedId?: string
}

export function LabelPrimitiveLayer({
  primitives,
  zoom,
  selectedId,
}: LabelPrimitiveLayerProps) {
  return (
    <>
      {primitives.map((primitive) => {
        const style = {
          position: 'absolute' as const,
          left: `${mmToPx(primitive.rect.x, zoom)}px`,
          top: `${mmToPx(primitive.rect.y, zoom)}px`,
          width: `${mmToPx(primitive.rect.width, zoom)}px`,
          height: `${mmToPx(primitive.rect.height, zoom)}px`,
          overflow: 'hidden' as const,
        }
        const selected = selectedId === primitive.elementId
        const className = `label-primitive${selected ? ' is-selected' : ''}`

        if (primitive.kind === 'barcode') {
          return (
            <div
              key={primitive.elementId}
              className={`${className} label-primitive-barcode`}
              style={style}
              data-element-id={primitive.elementId}
              data-element-type="barcode"
            >
              <BarcodePreview
                value={primitive.value || '0'}
                height={Math.max(
                  20,
                  mmToPx(primitive.rect.height, zoom) -
                    (primitive.humanReadable ? 14 : 0),
                )}
                displayValue={primitive.humanReadable !== null}
                fontSize={Math.max(8, mmToPx(ptToMm(primitive.fontSizePt), zoom))}
                className="label-primitive-barcode-svg"
              />
            </div>
          )
        }

        if (primitive.kind === 'qr') {
          return (
            <div
              key={primitive.elementId}
              className={`${className} label-primitive-qr`}
              style={style}
              data-element-id={primitive.elementId}
              data-element-type="qr"
            >
              <QrCodeSvg
                value={primitive.value || '-'}
                title="Kargo QR kodu"
                className="label-primitive-qr-svg"
              />
            </div>
          )
        }

        return (
          <div
            key={primitive.elementId}
            className={`${className} label-primitive-text`}
            style={{
              ...style,
              fontSize: `${mmToPx(ptToMm(primitive.fontSizePt), zoom)}px`,
              fontWeight: primitive.bold ? 700 : 400,
              textAlign: primitive.align,
              lineHeight: primitive.lineHeight,
            }}
            data-element-id={primitive.elementId}
            data-element-type={primitive.type}
            data-font-pt={primitive.fontSizePt}
            data-lines={primitive.lines.length}
          >
            {primitive.lines.map((line, index) => (
              <div key={`${primitive.elementId}-${index}`}>{line || ' '}</div>
            ))}
          </div>
        )
      })}
    </>
  )
}
