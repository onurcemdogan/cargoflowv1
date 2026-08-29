// ÖZELLİK DENETÇİSİ — SEÇİLİ ÖĞENİN TÜRÜNE GÖRE DEĞİŞİR.
//
// ═══ NEDEN TÜRE GÖRE ═════════════════════════════════════════════════════
// Barkoda "satır yüksekliği", QR'a "kalın" sunmak kullanıcıyı yanıltır ve
// anlamsız durum üretir. Panel yalnız o öğe için GERÇEKTEN uygulanabilen
// ayarları gösterir.
//
// ═══ KİMLİK KİLİDİ GÖRÜNÜR ═══════════════════════════════════════════════
// Barkod/QR/takip öğelerinin DEĞERİ düzenlenemez. Bu, alanı sessizce gizleyerek
// değil, AÇIK bir kilit açıklamasıyla anlatılır: operatör neden
// değiştiremediğini bilir.
//
// Sayısal alanlar ile tuval SENKRONDUR: buradan yazılan değer tuvale, tuvalde
// sürüklenen öğe buraya YANSIR (tek kaynak: belge).

import type { LabelElement } from '../../labels/labelDocument'
import {
  MAX_FONT_PT,
  MAX_LINE_HEIGHT,
  MIN_FONT_PT,
  MIN_LINE_HEIGHT,
  isIdentityLocked,
  isRequiredElement,
  minimumSizeMm,
} from '../../labels/labelDocument'
import {
  LABEL_CANVAS_HEIGHT_MM,
  LABEL_CANVAS_WIDTH_MM,
} from '../../labels/labelGeometry'
import { labelElementLabel } from '../../labels/labelElementLabels'

const TEXT_TYPES = new Set([
  'recipientName', 'buyerName', 'address', 'cityDistrict', 'phone',
  'orderNumber', 'packageId', 'orderDate', 'orderTime', 'marketplace',
  'trackingText', 'productList', 'cargoMeta', 'staticText',
])

interface LabelElementInspectorProps {
  element?: LabelElement
  onChange: (patch: Partial<LabelElement>) => void
}

export function LabelElementInspector({
  element,
  onChange,
}: LabelElementInspectorProps) {
  if (!element) {
    return (
      <aside className="label-inspector" aria-label="Öğe özellikleri">
        <p className="label-inspector-empty" data-testid="inspector-empty">
          Düzenlemek için tuvalden bir öğe seçin.
        </p>
      </aside>
    )
  }

  const locked = isIdentityLocked(element.type)
  const required = isRequiredElement(element.type)
  const min = minimumSizeMm(element.type)
  const isText = TEXT_TYPES.has(element.type)

  const number = (
    id: string,
    label: string,
    value: number,
    min_: number,
    max: number,
    step: number,
    key: keyof LabelElement,
  ) => (
    <label className="label-inspector-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        data-testid={id}
        type="number"
        value={value}
        min={min_}
        max={max}
        step={step}
        onChange={(event) => {
          const parsed = Number(event.target.value)
          if (!Number.isFinite(parsed)) return
          onChange({ [key]: clamp(parsed, min_, max) } as Partial<LabelElement>)
        }}
      />
    </label>
  )

  return (
    <aside className="label-inspector" aria-label="Öğe özellikleri">
      <header className="label-inspector-header">
        <h3 data-testid="inspector-title">{labelElementLabel(element.type)}</h3>
        {locked ? (
          <p className="label-inspector-lock" data-testid="inspector-identity-lock">
            Bu öğenin <strong>değeri</strong> taşıyıcı kimliğidir ve
            değiştirilemez. Yalnız konum, boyut ve sunum ayarlanabilir.
          </p>
        ) : null}
      </header>

      <section className="label-inspector-group">
        <h4>Konum ve boyut (mm)</h4>
        <div className="label-inspector-grid">
          {number('inspector-x', 'X', element.x, 0, LABEL_CANVAS_WIDTH_MM, 0.5, 'x')}
          {number('inspector-y', 'Y', element.y, 0, LABEL_CANVAS_HEIGHT_MM, 0.5, 'y')}
          {number(
            'inspector-width', 'Genişlik', element.width,
            min.width, LABEL_CANVAS_WIDTH_MM, 0.5, 'width',
          )}
          {number(
            'inspector-height', 'Yükseklik', element.height,
            min.height, LABEL_CANVAS_HEIGHT_MM, 0.5, 'height',
          )}
        </div>
        <label className="label-inspector-toggle" htmlFor="inspector-visible">
          <input
            id="inspector-visible"
            data-testid="inspector-visible"
            type="checkbox"
            checked={element.visible !== false}
            disabled={required}
            onChange={(event) => onChange({ visible: event.target.checked })}
          />
          <span>
            Görünür
            {required ? ' (zorunlu öğe — gizlenemez)' : ''}
          </span>
        </label>
      </section>

      {isText ? (
        <section className="label-inspector-group">
          <h4>Tipografi</h4>
          <div className="label-inspector-grid">
            {number(
              'inspector-font-size', 'Punto', element.fontSize ?? 9,
              MIN_FONT_PT, MAX_FONT_PT, 0.5, 'fontSize',
            )}
            {number(
              'inspector-line-height', 'Satır yüks.', element.lineHeight ?? 1.2,
              MIN_LINE_HEIGHT, MAX_LINE_HEIGHT, 0.05, 'lineHeight',
            )}
            {number(
              'inspector-max-lines', 'En fazla satır', element.maxLines ?? 1,
              1, 20, 1, 'maxLines',
            )}
          </div>
          <label className="label-inspector-toggle" htmlFor="inspector-bold">
            <input
              id="inspector-bold"
              data-testid="inspector-bold"
              type="checkbox"
              checked={element.bold === true}
              onChange={(event) => onChange({ bold: event.target.checked })}
            />
            <span>Kalın</span>
          </label>
          <label className="label-inspector-toggle" htmlFor="inspector-wrap">
            <input
              id="inspector-wrap"
              data-testid="inspector-wrap"
              type="checkbox"
              checked={element.wrap !== false}
              onChange={(event) => onChange({ wrap: event.target.checked })}
            />
            <span>Satır kaydır</span>
          </label>
          <label className="label-inspector-field" htmlFor="inspector-align">
            <span>Hizalama</span>
            <select
              id="inspector-align"
              data-testid="inspector-align"
              value={element.align ?? 'left'}
              onChange={(event) =>
                onChange({
                  align: event.target.value as LabelElement['align'],
                })
              }
            >
              <option value="left">Sola</option>
              <option value="center">Ortala</option>
              <option value="right">Sağa</option>
            </select>
          </label>
        </section>
      ) : null}

      {element.type === 'barcode' ? (
        <section className="label-inspector-group">
          <h4>Barkod</h4>
          <label className="label-inspector-toggle" htmlFor="inspector-human-readable">
            <input
              id="inspector-human-readable"
              data-testid="inspector-human-readable"
              type="checkbox"
              checked={element.showHumanReadable !== false}
              onChange={(event) =>
                onChange({ showHumanReadable: event.target.checked })
              }
            />
            <span>Numarayı barkodun altında göster</span>
          </label>
          <p className="label-inspector-note">
            En küçük okunabilir ölçü: {min.width}×{min.height} mm. Daha küçüğü
            KAYDEDİLMEZ — okunmayan barkod, kaybolmuş pakettir.
          </p>
        </section>
      ) : null}

      {element.type === 'staticText' ? (
        <section className="label-inspector-group">
          <h4>Metin</h4>
          <label className="label-inspector-field" htmlFor="inspector-text">
            <span>İçerik</span>
            <textarea
              id="inspector-text"
              data-testid="inspector-text"
              rows={3}
              value={element.text ?? ''}
              onChange={(event) => onChange({ text: event.target.value })}
            />
          </label>
        </section>
      ) : null}
    </aside>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
