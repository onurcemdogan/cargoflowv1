import { Check, Eye, GripVertical, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { LabelHtmlPreview } from '../components/LabelHtmlPreview'
import { PageHeader } from '../components/PageHeader'
import { defaultLabelTypography } from '../services/integrationConfigService'
import type {
  CargoOrder,
  LabelFieldConfig,
  LabelFieldKey,
  LabelTemplate,
  LabelTypographyConfig,
  WorkflowResult,
} from '../types/cargoflow'

interface LabelTemplatesPageProps {
  template: LabelTemplate
  orders: CargoOrder[]
  result?: WorkflowResult
  onSave: (template: LabelTemplate) => void
}

const templateCards = [
  {
    id: 'surat-classic-100x100',
    name: 'Sürat Kargo Klasik 10x10',
    description: 'Ortak barkod referans etiketine en yakın operasyon şablonu.',
  },
  {
    id: 'surat-large-barcode',
    name: 'Sürat Kargo Büyük Barkod',
    description: 'Ana Code128 barkodu ve takip numarasını öne çıkarır.',
  },
  {
    id: 'minimal-ecommerce',
    name: 'Minimal E-Ticaret',
    description: 'Adres, barkod ve ürün satırını sade tutan depo etiketi.',
  },
  {
    id: 'trendyol-compatible',
    name: 'Trendyol Uyumlu',
    description: 'Pazaryeri sipariş no, SKU ve ürün satırını vurgular.',
  },
  {
    id: 'custom',
    name: 'Özel Şablon',
    description: 'Alan sırası ve görünürlüğü operasyon ihtiyacına göre düzenlenir.',
  },
]

const editorFields: Array<{ key: LabelFieldKey; label: string }> = [
  { key: 'customerName', label: 'Alıcı Adı' },
  { key: 'customerPhone', label: 'Telefon' },
  { key: 'address', label: 'Adres' },
  { key: 'productName', label: 'Ürün Adı' },
  { key: 'trackingNumber', label: 'Takip No' },
  { key: 'shipmentCode', label: 'Barkod' },
  { key: 'shippingProvider', label: 'QR' },
  { key: 'orderNumber', label: 'Sipariş No' },
  { key: 'marketplace', label: 'Pazaryeri' },
]

const typographyFields: Array<{
  key: keyof LabelTypographyConfig
  label: string
  min: number
  max: number
}> = [
  { key: 'headerName', label: 'Alıcı adı', min: 10, max: 18 },
  { key: 'address', label: 'Adres satırları', min: 8, max: 13 },
  { key: 'route', label: 'İl / ilçe kutusu', min: 11, max: 16 },
  { key: 'cargoValue', label: 'Ödeme / birim / desi', min: 15, max: 22 },
  { key: 'deliveryTitle', label: 'Adrese Teslim', min: 12, max: 16 },
  { key: 'deliveryRoute', label: 'Teslimat bölgesi', min: 13, max: 20 },
  { key: 'transfer', label: 'Aktarma merkezi', min: 12, max: 18 },
  { key: 'productTitle', label: 'Ürün adı', min: 9, max: 14 },
  { key: 'productMeta', label: 'Renk / beden / SKU', min: 8, max: 12 },
]

export function LabelTemplatesPage({
  template,
  orders,
  result,
  onSave,
}: LabelTemplatesPageProps) {
  const previewOrder = useMemo(
    () => orders.find((order) => order.items.length > 0) ?? orders[0],
    [orders],
  )
  const [previewTemplate, setPreviewTemplate] = useState<LabelTemplate>(template)
  const [fields, setFields] = useState<LabelFieldConfig[]>(
    () => normalizeEditorFields(template.fields),
  )
  const [draggedKey, setDraggedKey] = useState<LabelFieldKey>()

  function applyTemplate(id: string, name: string) {
    const nextTemplate = buildTemplate(previewTemplate, id, name, fields)
    setPreviewTemplate(nextTemplate)
    onSave(nextTemplate)
  }

  function updateTypography(
    key: keyof LabelTypographyConfig,
    value: number,
  ) {
    setPreviewTemplate((current) => ({
      ...current,
      typography: {
        ...defaultLabelTypography,
        ...current.typography,
        [key]: value,
      },
    }))
  }

  function moveField(targetKey: LabelFieldKey) {
    if (!draggedKey || draggedKey === targetKey) return
    const current = fields.slice()
    const from = current.findIndex((field) => field.key === draggedKey)
    const to = current.findIndex((field) => field.key === targetKey)
    if (from < 0 || to < 0) return
    const [item] = current.splice(from, 1)
    current.splice(to, 0, item)
    setFields(reindexFields(current))
  }

  return (
    <>
      <PageHeader
        title="Etiket Şablonları"
        description="Hazır 10x10 Zebra etiket şablonlarını seç ve canlı baskı önizlemesini gerçek sipariş verisiyle kontrol et."
      />

      <ActionResult result={result} />

      <section className="template-gallery">
        {templateCards.map((card) => (
          <article key={card.id} className="template-card">
            <div>
              <span className="eyebrow">Şablon</span>
              <h2>{card.name}</h2>
              <p>{card.description}</p>
            </div>
            <div className="template-card-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  setPreviewTemplate(buildTemplate(template, card.id, card.name, fields))
                }
              >
                <Eye size={18} />
                Önizleme
              </button>
              {card.id === 'custom' ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setPreviewTemplate(buildTemplate(template, card.id, card.name, fields))
                  }
                >
                  <Pencil size={18} />
                  Düzenle
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => applyTemplate(card.id, card.name)}
                >
                  <Check size={18} />
                  Kullan
                </button>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="template-editor-grid">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>Etiket Düzenleyici</h2>
              <span>Değişiklikler sağdaki önizlemeye anında uygulanır.</span>
            </div>
          </div>
          <section className="typography-editor prominent">
            <div className="panel-heading compact">
              <div>
                <h2>Yazı Boyutları</h2>
                <span>
                  Teslimat bölgesi ve aktarma satırları artık etikete otomatik
                  sığdırılır.
                </span>
              </div>
            </div>
            {typographyFields.map((field) => {
              const value =
                previewTemplate.typography?.[field.key] ??
                defaultLabelTypography[field.key]
              return (
                <label key={field.key}>
                  <span>{field.label}</span>
                  <input
                    type="range"
                    min={field.min}
                    max={field.max}
                    value={value}
                    onChange={(event) =>
                      updateTypography(field.key, Number(event.target.value))
                    }
                  />
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={value}
                    onChange={(event) =>
                      updateTypography(field.key, Number(event.target.value))
                    }
                  />
                </label>
              )
            })}
            <div className="button-row">
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  applyTemplate(previewTemplate.id, previewTemplate.name)
                }
              >
                <Check size={18} />
                Yazı Ayarlarını Kaydet
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  setPreviewTemplate((current) => ({
                    ...current,
                    typography: defaultLabelTypography,
                  }))
                }
              >
                Dengeli Boyutlara Dön
              </button>
            </div>
          </section>
          <details className="template-fields-details">
            <summary>
              <span>Etikette Görünecek Alanlar</span>
              <strong>
                {fields.filter((field) => field.visible).length} aktif alan
              </strong>
            </summary>
          <div className="template-field-list">
            {fields.map((field) => (
              <div
                key={field.key}
                className="template-field-row"
                draggable
                onDragStart={() => setDraggedKey(field.key)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => moveField(field.key)}
              >
                <GripVertical size={18} />
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={field.visible}
                    onChange={(event) =>
                      setFields((current) =>
                        current.map((item) =>
                          item.key === field.key
                            ? { ...item, visible: event.target.checked }
                            : item,
                        ),
                      )
                    }
                  />
                  <span>{field.label}</span>
                </label>
              </div>
            ))}
          </div>
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                applyTemplate('custom', 'Özel Şablon')
              }
            >
              <Check size={18} />
              Özel Şablonu Kullan
            </button>
          </div>
          </details>
        </div>

        <div className="panel live-label-panel">
          <div className="panel-heading">
            <h2>Canlı Etiket Önizleme</h2>
            <span>{previewTemplate.name}</span>
          </div>
          <LabelHtmlPreview order={previewOrder} template={previewTemplate} />
        </div>
      </section>
    </>
  )
}

function normalizeEditorFields(fields: LabelFieldConfig[]): LabelFieldConfig[] {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  return editorFields.map((field, index) => ({
    key: field.key,
    label: field.label,
    visible: byKey.get(field.key)?.visible ?? true,
    order: index + 1,
  }))
}

function reindexFields(fields: LabelFieldConfig[]): LabelFieldConfig[] {
  return fields.map((field, index) => ({ ...field, order: index + 1 }))
}

function buildTemplate(
  base: LabelTemplate,
  id: string,
  name: string,
  fields: LabelFieldConfig[],
): LabelTemplate {
  return {
    ...base,
    id,
    name,
    widthMm: 100,
    heightMm: 100,
    widthDots: 799,
    heightDots: 799,
    fields: reindexFields(fields),
    updatedAt: new Date().toISOString(),
  }
}
