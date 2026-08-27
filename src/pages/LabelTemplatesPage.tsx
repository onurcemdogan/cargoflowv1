import { Check, Eye, GripVertical, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { LabelHtmlPreview } from '../components/LabelHtmlPreview'
import { PageHeader } from '../components/PageHeader'
import { defaultLabelTypography } from '../services/integrationConfigService'
import {
  DEFAULT_ADDRESS_STYLE,
  ADDRESS_STYLE_LIMITS,
  resolveAddressBlockLayout,
} from '../utils/labelAddressBlock'
import {
  isProductLinePart,
  isTenantRenderableBlock,
  resolveTenantBlocks,
  resolveTenantBlockValues,
  tenantBlocksHeight,
  TENANT_BAND_NOMINAL_HEIGHT,
} from '../utils/labelTenantBlocks'
import {
  IDENTITY_LOCKED_LABEL_FIELDS,
} from '../types/cargoflow'
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

/**
 * Düzenleyicide görünen blok kataloğu.
 *
 * `defaultVisible: false` olan bloklar YENİ eklenen bloklardır: mevcut
 * kiracıların etiketi bir sürüm yükseltmesiyle KENDİLİĞİNDEN değişmesin
 * diye kapalı doğarlar. Operatör açtığında kod değişikliği gerekmez.
 */
const editorFields: Array<{
  key: LabelFieldKey
  label: string
  defaultVisible: boolean
}> = [
  { key: 'customerName', label: 'Alıcı Adı', defaultVisible: true },
  // ── Ürün satırının parçaları — bugünkü çıktıyı korumak için AÇIK. ──
  { key: 'productName', label: 'Ürün Adı', defaultVisible: true },
  { key: 'quantity', label: 'Adet', defaultVisible: true },
  { key: 'variant', label: 'Varyant', defaultVisible: true },
  { key: 'sku', label: 'SKU', defaultVisible: true },
  // ── Ayrı satır olarak basılan bloklar — KAPALI doğarlar. ──
  // Bunlar bugüne kadar KOD DEĞİŞİKLİĞİ gerektiren alanlardır; açık
  // doğsalardı mevcut kiracıların etiketi kendiliğinden değişirdi.
  { key: 'buyerName', label: 'Satın Alan Adı', defaultVisible: false },
  { key: 'orderDate', label: 'Sipariş Tarihi', defaultVisible: false },
  { key: 'orderTime', label: 'Sipariş Saati', defaultVisible: false },
  { key: 'packageId', label: 'Paket No', defaultVisible: false },
  { key: 'orderNumber', label: 'Sipariş No', defaultVisible: false },
  { key: 'marketplace', label: 'Pazaryeri', defaultVisible: false },
  // ── Taşıyıcının bastığı metinler — bilgi amaçlı listelenir. ──
  { key: 'customerPhone', label: 'Telefon', defaultVisible: true },
  { key: 'address', label: 'Adres', defaultVisible: true },
  { key: 'cityDistrict', label: 'İl / İlçe', defaultVisible: true },
  { key: 'trackingNumber', label: 'Takip No', defaultVisible: true },
  { key: 'shipmentCode', label: 'Barkod', defaultVisible: true },
  { key: 'shippingProvider', label: 'QR', defaultVisible: true },
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
  // ── ADRES SUNUMU ──────────────────────────────────────────────────────
  // COMPOSED şablonlarda adres bloğu BİZİM alanımızdır; taşıyıcının ^FD
  // gövdesi boşaltılır ve adres bu ayarlarla yeniden basılır.
  const [addressStyle, setAddressStyle] = useState(() => ({
    ...DEFAULT_ADDRESS_STYLE,
    ...(template.addressStyle ?? {}),
  }))
  function updateAddress(patch: Partial<typeof addressStyle>) {
    setAddressStyle((current) => ({ ...current, ...patch }))
  }

  // GEOMETRİ DOĞRULAMASI — ÜRETİME ALMADAN ÖNCE.
  //
  // Gerçek üretim etiketinden ÖLÇÜLDÜ: adres satırları 417..458 arasında,
  // bir sonraki taşıyıcı içeriği 476'da başlar. Korunan kutular barkod
  // bandı ve alt makine-okunur bölgedir.
  const addressPreview = useMemo(() => {
    const lines = [
      previewOrder?.address,
      [previewOrder?.district, previewOrder?.city].filter(Boolean).join(' '),
    ].filter((line): line is string => Boolean(String(line ?? '').trim()))
    return resolveAddressBlockLayout({
      lines: lines.length > 0 ? lines : ['Ornek Mahallesi Ornek Caddesi No 12'],
      style: addressStyle,
      band: { left: 63, right: 700, top: 400, bottom: 470 },
      protectedBoxes: [
        { left: 48, top: 120, right: 700, bottom: 300 },
        { left: 48, top: 476, right: 775, bottom: 780 },
      ],
    })
  }, [addressStyle, previewOrder])

  // ÖN UYARI: etikete gerçekten yazılacak blokların isteyeceği dikey alan.
  // KESİN karar baskı anında verilir (bant etiketten etikete değişir); bu
  // yalnız operatörü sığmayacak bir şablonu üretime almaktan alıkoyar.
  const requestedBandHeight = useMemo(() => {
    const resolved = resolveTenantBlocks(
      { fields },
      resolveTenantBlockValues(previewOrder, undefined),
    )
    // Değeri boş bloklar basılmaz; yine de operatörün AÇTIĞI her blok
    // hesaba katılır, aksi halde uyarı canlı veride sürpriz olurdu.
    const visibleCount = fields.filter(
      (field) => field.visible && isTenantRenderableBlock(field.key),
    ).length
    if (resolved.length === 0) return visibleCount * 19
    return Math.round(
      (tenantBlocksHeight(resolved) / resolved.length) * visibleCount,
    )
  }, [fields, previewOrder])
  const bandOverflow = requestedBandHeight > TENANT_BAND_NOMINAL_HEIGHT

  function applyTemplate(id: string, name: string) {
    const nextTemplate = {
      ...buildTemplate(previewTemplate, id, name, fields),
      addressStyle,
    }
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

  /** Blok başına SUNUM ayarı. Kimlik bloklarının DEĞERİ değişmez. */
  function updateField(key: LabelFieldKey, patch: Partial<LabelFieldConfig>) {
    setFields((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)))
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
                <h2>Yazı Boyutları (yalnız ekran önizlemesi)</h2>
                <span>
                  Bu ayarlar ekrandaki önizlemeyi biçimlendirir. Sürat
                  etiketinin adres, alıcı ve barkod metinlerini TAŞIYICI basar;
                  o metinlerin puntosu buradan değiştirilemez. Etikete gerçekten
                  yazdırmak istediğin bilgiler için aşağıdaki blok listesini
                  kullan.
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
                {/* SUNUM AYARLARI YALNIZ BİZİM BASTIĞIMIZ BLOKLARDA.
                    Taşıyıcının bastığı metnin (adres, alıcı, barkod, takip no)
                    puntosunu değiştiremeyiz; oraya düğme koymak operatöre
                    YALAN bir yetki gösterirdi. */}
                {isTenantRenderableBlock(field.key) ? (
                  <>
                <label className="field-style-control">
                  <span>Punto</span>
                  <input
                    type="number"
                    min={6}
                    max={72}
                    value={field.fontSize ?? ''}
                    placeholder="oto"
                    onChange={(event) =>
                      updateField(field.key, {
                        fontSize: event.target.value === ''
                          ? undefined
                          : Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={field.bold === true}
                    onChange={(event) =>
                      updateField(field.key, { bold: event.target.checked })
                    }
                  />
                  <span>Kalın</span>
                </label>
                <label className="field-style-control">
                  <span>Konum</span>
                  <select
                    value={field.placement ?? 'body'}
                    onChange={(event) =>
                      updateField(field.key, {
                        placement: event.target.value as LabelFieldConfig['placement'],
                      })
                    }
                  >
                    <option value="top">Üst</option>
                    <option value="body">Orta</option>
                    <option value="bottom">Alt</option>
                  </select>
                </label>
                  </>
                ) : isProductLinePart(field.key) ? (
                  // Ürün satırı KENDİ punto merdivenine sahiptir (sığdırma
                  // otomatiktir); ayrı bir punto düğmesi o merdiveni bozardı.
                  <span className="field-locked-note" title="Ürün satırı parçası">
                    ürün satırında
                  </span>
                ) : field.key === 'address' || field.key === 'cityDistrict' ? (
                  // Adres artık COMPOSED bandda BİZİM kontrolümüzdedir;
                  // ayarları yukarıdaki "Teslimat Adresi" bölümündedir.
                  <span className="field-locked-note" title="Adres ayarları">
                    yukarıdaki adres bölümünden
                  </span>
                ) : (
                  <span
                    className="field-locked-note"
                    title={
                      IDENTITY_LOCKED_LABEL_FIELDS.includes(field.key)
                        ? 'Taşıyıcı kimliği'
                        : 'Taşıyıcının bastığı metin'
                    }
                  >
                    {IDENTITY_LOCKED_LABEL_FIELDS.includes(field.key)
                      ? 'değeri kilitli — taşıyıcı basar'
                      : 'taşıyıcı basar'}
                  </span>
                )}
              </div>
            ))}
          </div>
          {/* ═══ ADRES SUNUMU — KODSUZ ═══════════════════════════════════
              Adres, COMPOSED şablonlarda BİZİM bandımızdadır: taşıyıcının
              ^FD gövdesi boşaltılır ve adres bu ayarlarla yeniden basılır.
              Ham (RAW_SURAT_FALLBACK) modda bu bölüm devre dışıdır ve
              taşıyıcı biçimi AYNEN korunur. */}
          <section className="address-style-editor">
            <div className="panel-heading compact">
              <div>
                <h2>Teslimat Adresi</h2>
                <span>
                  Punto, kalınlık, satır aralığı, satır sınırı ve hizalama
                  kodsuz ayarlanır. Sığmayan yapılandırma ÜRETİME ALINMADAN
                  reddedilir; sessizce kırpılmaz.
                </span>
              </div>
            </div>
            <div className="address-style-controls">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={addressStyle.visible !== false}
                  onChange={(event) =>
                    updateAddress({ visible: event.target.checked })
                  }
                />
                <span>Adresi göster</span>
              </label>
              <label className="field-style-control">
                <span>Punto</span>
                <input
                  type="number"
                  min={ADDRESS_STYLE_LIMITS.minFontSize}
                  max={ADDRESS_STYLE_LIMITS.maxFontSize}
                  value={addressStyle.fontSize}
                  onChange={(event) =>
                    updateAddress({ fontSize: Number(event.target.value) })
                  }
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={addressStyle.bold === true}
                  onChange={(event) => updateAddress({ bold: event.target.checked })}
                />
                <span>Kalın</span>
              </label>
              <label className="field-style-control">
                <span>Satır aralığı</span>
                <input
                  type="number"
                  step={0.05}
                  min={ADDRESS_STYLE_LIMITS.minLineHeight}
                  max={ADDRESS_STYLE_LIMITS.maxLineHeight}
                  value={addressStyle.lineHeight}
                  onChange={(event) =>
                    updateAddress({ lineHeight: Number(event.target.value) })
                  }
                />
              </label>
              <label className="field-style-control">
                <span>Satır sayısı</span>
                <input
                  type="number"
                  min={ADDRESS_STYLE_LIMITS.minMaxLines}
                  max={ADDRESS_STYLE_LIMITS.maxMaxLines}
                  value={addressStyle.maxLines}
                  onChange={(event) =>
                    updateAddress({ maxLines: Number(event.target.value) })
                  }
                />
              </label>
              <label className="field-style-control">
                <span>Hizalama</span>
                <select
                  value={addressStyle.align}
                  onChange={(event) =>
                    updateAddress({
                      align: event.target.value as typeof addressStyle.align,
                    })
                  }
                >
                  <option value="left">Sola</option>
                  <option value="center">Ortala</option>
                  <option value="right">Sağa</option>
                </select>
              </label>
            </div>
            {/* SESSİZ KIRPMA YOK: sığmayan yapılandırma AÇIKÇA reddedilir ve
                operatöre ne yapacağı söylenir. */}
            {addressPreview.ok ? (
              <p className="address-style-ok" role="status">
                Adres {addressPreview.lineCount} satır sürüyor;{' '}
                {addressPreview.requiredHeight}/{addressPreview.availableHeight}{' '}
                dot kullanılıyor. Bu boyut etikete sığıyor.
              </p>
            ) : (
              <p className="address-style-error" role="alert">
                {addressPreview.message}
              </p>
            )}
          </section>

          {bandOverflow ? (
            <p className="template-band-warning" role="status">
              Seçilen bloklar yaklaşık {requestedBandHeight} dot yer istiyor;
              taşıyıcı etiketinde tipik olarak {TENANT_BAND_NOMINAL_HEIGHT} dot
              boş alan kalır. Sığmayan bloklar BASILMAZ (kırpılmaz, küçültülmez)
              ve baskı sonucunda açıkça bildirilir. Punto düşür veya blok sayısını
              azalt.
            </p>
          ) : null}
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
          {/* CANLI ÖNİZLEME: blok ayarları KAYDETMEDEN de görünür. Operatör
              "kaydet → bak → geri al" döngüsüne zorlanmaz; ayrıca kaydetmeden
              önce sonucu gördüğü için yanlış şablonu üretime almaz.
              Bu görünüm YERELDİR: taşıyıcı veya pazaryeri çağrısı YOKTUR. */}
          <LabelHtmlPreview
            order={previewOrder}
            template={{ ...previewTemplate, fields }}
          />
        </div>
      </section>
    </>
  )
}

/**
 * Kayıtlı şablonu düzenleyici kataloğuyla birleştirir.
 *
 * Kayıtlı şablon OTORİTERDİR: görünürlük, sunum ayarları (punto/kalın/konum)
 * ve operatörün sürükleyerek verdiği SIRA korunur. Katalogda olup şablonda
 * bulunmayan bloklar kendi varsayılanıyla, listenin sonunda eklenir.
 */
function normalizeEditorFields(fields: LabelFieldConfig[]): LabelFieldConfig[] {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const merged = editorFields.map((field, index) => {
    const stored = byKey.get(field.key)
    return {
      key: field.key,
      label: field.label,
      visible: stored?.visible ?? field.defaultVisible,
      // Kayıtlı sıra yoksa katalog sırasının ARDINA düşer.
      order: stored?.order ?? editorFields.length + index + 1,
      fontSize: stored?.fontSize,
      bold: stored?.bold,
      placement: stored?.placement,
    }
  })
  merged.sort((left, right) => left.order - right.order)
  return reindexFields(merged)
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
