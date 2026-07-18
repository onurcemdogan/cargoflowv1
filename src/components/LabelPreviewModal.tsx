import { Download, Pencil, Printer, RotateCcw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  CargoOrder,
  LabelPreviewOverrides,
  LabelTemplate,
  SuratBarcodeSourceOption,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import { formatDisplayDate } from '../utils/formatters'
import { buildLabelData, validateLabelData } from '../utils/labelData'
import {
  desiValuesDiffer,
  extractZplDesi,
  formatDesi,
  resolveNormalizedDesi,
} from '../utils/desi'
import { LabelPreviewCard } from './LabelPreviewCard'

interface LabelPreviewModalProps {
  order?: CargoOrder
  template?: LabelTemplate
  mappingConfig: SuratLabelMappingConfig
  previewOverrides?: LabelPreviewOverrides
  busy: boolean
  onClose: () => void
  onMappingConfigChange: (mappingConfig: SuratLabelMappingConfig) => void
  onPreviewOverridesChange: (
    orderId: string,
    overrides: LabelPreviewOverrides,
  ) => void
  onDesiChange: (
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) => void
  onDownloadZpl: (orderId: string, mappingConfig?: SuratLabelMappingConfig) => void
  onPrint: (orderId: string) => void
}

export function LabelPreviewModal({
  order,
  template,
  mappingConfig,
  previewOverrides = {},
  busy,
  onClose,
  onMappingConfigChange,
  onPreviewOverridesChange,
  onDesiChange,
  onDownloadZpl,
  onPrint,
}: LabelPreviewModalProps) {
  const [editorOpen, setEditorOpen] = useState(false)
  const labelData = useMemo(
    () => buildLabelData(order, order?.shipment, template, mappingConfig),
    [mappingConfig, order, template],
  )
  const validation = useMemo(
    () => validateLabelData(order, order?.shipment, template, mappingConfig),
    [mappingConfig, order, template],
  )
  const normalizedDesi = useMemo(
    () => resolveNormalizedDesi(order),
    [order],
  )
  const apiZplDesi = useMemo(
    () =>
      extractZplDesi(
        order?.shipment?.barcodeRaw ||
          order?.shipment?.suratCreateLog?.BarcodeRaw,
      ),
    [order],
  )
  const desiMismatch = desiValuesDiffer(
    normalizedDesi.desi,
    apiZplDesi,
  )
  const displayWarnings = validation.warnings.filter(
    (warning) => !warning.startsWith('Önce Sürat gönderisi oluşturup'),
  )
  const canDownload = Boolean(
    order &&
      validation.errors.length === 0 &&
      labelData.serviceMode === 'ORTAK_BARKOD_SOAP' &&
      labelData.verifiedShipment &&
      labelData.kargoTakipNo &&
      labelData.barcode &&
      Boolean(
        order.shipment?.barcodeRaw ||
          order.shipment?.suratCreateLog?.BarcodeRaw,
      ),
  )

  if (validation.errors.length > 0) {
    console.error('CargoFlow label preview error', {
      orderId: order?.id,
      orderNumber: order?.orderNumber,
      errors: validation.errors,
      labelData,
    })
  } else if (validation.warnings.length > 0) {
    console.warn('CargoFlow label preview warning', {
      orderId: order?.id,
      orderNumber: order?.orderNumber,
      warnings: validation.warnings,
      labelData,
    })
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="label-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Etiket önizleme"
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">10x10 cm Zebra Code128</span>
            <h2>{order?.orderNumber || 'Etiket Önizleme'}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {validation.errors.length > 0 ? (
          <div className="modal-error">
            {validation.errors.map((error) => (
              <strong key={error}>{error}</strong>
            ))}
          </div>
        ) : null}

        {!labelData.verifiedShipment ? (
          <div className="modal-error">
            <strong>
              Bu etiket Sürat tarafından doğrulanmış gönderiye ait değil. Canlı
              baskı için Ortak Barkod SOAP cevabında KargoTakipNo + Barcode
              birlikte dönmelidir.
            </strong>
            <span>
              Sipariş detayındaki raw SOAP response ve parse edilen alanları
              kontrol edin.
            </span>
          </div>
        ) : null}

        {displayWarnings.length > 0 ? (
          <div className="modal-warning">
            {displayWarnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </div>
        ) : null}

        <section className="label-inline-editor desi-editor">
          <header>
            <div>
              <span className="eyebrow">Gönderi ölçüsü</span>
              <h3>Toplam koli desisi</h3>
            </div>
            <span className="preview-only-badge">
              Kaynak: {desiSourceLabel(normalizedDesi.desiSource)}
            </span>
          </header>
          <div className="label-editor-grid">
            <label>
              <span>Toplam koli desisi</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={normalizedDesi.desi ?? ''}
                placeholder="Desi girin"
                onChange={(event) => {
                  if (!order) return
                  const value = parseDesiInput(event.target.value)
                  onDesiChange(
                    order.id,
                    value,
                    value == null ? null : 'manual_total',
                  )
                }}
              />
            </label>
            <div className="label-preview-edit-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={normalizedDesi.productDesi == null}
                onClick={() =>
                  order &&
                  onDesiChange(
                    order.id,
                    normalizedDesi.productDesi,
                    'product',
                  )
                }
              >
                Üründen al
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={normalizedDesi.calculatedDesi == null}
                onClick={() =>
                  order &&
                  onDesiChange(
                    order.id,
                    normalizedDesi.calculatedDesi,
                    'calculated',
                  )
                }
              >
                Hesapla
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  order && onDesiChange(order.id, null, null)
                }
              >
                Temizle
              </button>
            </div>
          </div>
          <p>
            Önizleme, Sürat isteği ve indirilen ZPL aynı normalize desiyi
            kullanır. Mevcut değer: {formatDesi(normalizedDesi.desi)}
          </p>
        </section>

        {desiMismatch ? (
          <div className="modal-warning">
            <strong>
              API’den dönen etiket desisi, CargoFlow önizlemesinden farklı.
            </strong>
            <span>
              API ZPL: {formatDesi(apiZplDesi)} · CargoFlow:{' '}
              {formatDesi(normalizedDesi.desi)}. İndirilen yeni ZPL CargoFlow
              değerini kullanacaktır.
            </span>
          </div>
        ) : null}

        <div className="label-preview-grid">
          <div className="label-preview-visual">
            <LabelPreviewCard
              order={order}
              labelData={labelData}
              template={template}
              overrides={previewOverrides}
            />
            <div className="label-preview-edit-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditorOpen((current) => !current)}
              >
                <Pencil size={17} />
                {editorOpen ? 'Düzenlemeyi Kapat' : 'Etiketi Düzenle'}
              </button>
              {Object.keys(previewOverrides).length > 0 ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    order && onPreviewOverridesChange(order.id, {})
                  }
                >
                  <RotateCcw size={17} />
                  Varsayılana Dön
                </button>
              ) : null}
            </div>
            {editorOpen && order ? (
              <section className="label-inline-editor">
                <header>
                  <div>
                    <span className="eyebrow">Kullanıcı etiketi</span>
                    <h3>Görünüm alanlarını düzenle</h3>
                  </div>
                  <span className="preview-only-badge">Önizleme</span>
                </header>
                <p>
                  Bu alanlar kullanıcı önizlemesini düzenler. Canlı baskıda
                  Sürat’in imzalı BarcodeRaw ZPL verisi değiştirilmeden kullanılır.
                </p>
                <div className="label-editor-grid">
                  <EditableField
                    label="Şube"
                    value={previewOverrides.branchName ?? labelData.branchName}
                    onChange={(value) =>
                      updateOverride('branchName', value)
                    }
                  />
                  <EditableField
                    label="Alıcı"
                    value={
                      previewOverrides.recipientName ?? labelData.recipientName
                    }
                    onChange={(value) =>
                      updateOverride('recipientName', value)
                    }
                  />
                  <ReadOnlyField label="T.No" value={labelData.tNo} />
                  <ReadOnlyField
                    label="Sürat Barkod No"
                    value={labelData.barcodeValue}
                  />
                  <EditableField
                    label="Sol referans"
                    value={
                      previewOverrides.leftReference ??
                      labelData.leftVerticalReference
                    }
                    onChange={(value) =>
                      updateOverride('leftReference', value)
                    }
                  />
                  <EditableField
                    label="İl / İlçe"
                    value={
                      previewOverrides.routeCenter ?? labelData.routeCenter
                    }
                    onChange={(value) =>
                      updateOverride('routeCenter', value)
                    }
                  />
                  <EditableField
                    label="Aktarma merkezi"
                    value={
                      previewOverrides.transferCenter ??
                      labelData.transferCenter
                    }
                    onChange={(value) =>
                      updateOverride('transferCenter', value)
                    }
                  />
                  <EditableField
                    label="Ürün satırı"
                    value={
                      previewOverrides.productTitle ??
                      `${labelData.items[0]?.quantity || 1} x ${
                        labelData.items[0]?.productName || ''
                      }`
                    }
                    onChange={(value) =>
                      updateOverride('productTitle', value)
                    }
                    wide
                  />
                  <EditableField
                    label="Ürün detayları"
                    value={
                      previewOverrides.productMeta ??
                      [
                        labelData.items[0]?.color
                          ? `Renk: ${labelData.items[0].color}`
                          : '',
                        labelData.items[0]?.size
                          ? `Beden: ${labelData.items[0].size}`
                          : '',
                        labelData.items[0]?.sku
                          ? `SKU: ${labelData.items[0].sku}`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' | ')
                    }
                    onChange={(value) =>
                      updateOverride('productMeta', value)
                    }
                    wide
                  />
                </div>
              </section>
            ) : null}
          </div>
          <aside className="label-preview-meta">
            <h3>Etiket Verisi</h3>
            <label className="label-source-selector">
              <span>Ana barkod kaynağı</span>
              <select
                value={mappingConfig.barcodeSourceOverride ?? 'auto'}
                onChange={(event) =>
                  onMappingConfigChange({
                    barcodeSourceOverride: event.target
                      .value as SuratBarcodeSourceOption,
                  })
                }
              >
                <option value="auto">Otomatik</option>
                <option value="BarkodNo">BarkodNo</option>
                <option value="Barkod">Barkod</option>
                <option value="Barcode">Barcode (API/ZPL)</option>
              </select>
            </label>
            <Detail label="Alıcı" value={labelData.recipientName} />
            <Detail label="Telefon" value={labelData.recipientPhone} />
            <Detail label="İl / İlçe" value={`${labelData.city} / ${labelData.district}`} />
            <Detail label="Adres" value={labelData.address} />
            <Detail label="Sipariş No" value={labelData.orderNumber} />
            <Detail label="Müşteri" value={order?.customerName} />
            <Detail
              label="İl / İlçe"
              value={`${labelData.city} / ${labelData.district}`}
            />
            <Detail
              label="Ürün"
              value={order?.items[0]?.productName}
            />
            <Detail
              label="Renk / Beden / SKU"
              value={[
                order?.items[0]?.color,
                order?.items[0]?.size,
                order?.items[0]?.sku,
              ]
                .filter(Boolean)
                .join(' / ')}
            />
            <Detail
              label="Takip No"
              value={labelData.trackingNumber || 'Henüz oluşmadı'}
            />
            <Detail label="T.No" value={labelData.tNo} />
            <Detail label="T.No kaynağı" value={labelData.tNoSource} />
            <Detail label="Shipment Reference" value={labelData.shipmentReference} />
            <Detail label="Sol Dikey Referans" value={labelData.leftVerticalReference} />
            <Detail
              label="Sol dikey referans kaynağı"
              value={labelData.leftVerticalReferenceSource}
            />
            <Detail label="Ana barkod değeri" value={labelData.barcodeValue} />
            <Detail label="Ana barkod kaynağı" value={labelData.mainBarcodeSource} />
            <Detail label="verifiedShipment" value={String(labelData.verifiedShipment)} />
            <Detail label="serviceMode" value={labelData.serviceMode} />
            <Detail label="operationName" value={labelData.operationName} />
            <Detail label="KargoTakipNo" value={labelData.kargoTakipNo} />
            <Detail label="Barcode" value={labelData.barcode} />
            <Detail
              label="ZPL source"
              value={order?.shipment?.zplSource || 'generated'}
            />
            <Detail label="labelStatus" value={order?.labelStatus} />
            <Detail
              label="printedAt"
              value={formatDisplayDate(order?.label?.printedAt)}
            />
            <Detail
              label="printCount"
              value={String(order?.label?.printCount ?? 0)}
            />
            <Detail
              label="trendyolCargoTrackingNumber"
              value={labelData.trendyolCargoTrackingNumber}
            />
            <Detail label="suratKargoTakipNo" value={labelData.suratKargoTakipNo} />
            <Detail
              label="extractedKargoTakipNo"
              value={labelData.extractedKargoTakipNo}
            />
            <Detail label="takipUrl" value={labelData.suratTakipUrl} />
            <Detail label="barcodeValue" value={labelData.barcodeValue} />
            <Detail label="barcodeSource" value={labelData.barcodeSource} />
            <Detail label="TNoSource" value={labelData.tNoSource} />
            <Detail label="matchReason" value={labelData.matchReason} />
            <Detail label="Toplam Adet" value={String(labelData.totalQuantity)} />
            <Detail label="Top Ds/Kg" value={formatDesi(labelData.desi)} />
            <Detail
              label="Desi Kaynağı"
              value={desiSourceLabel(normalizedDesi.desiSource)}
            />
            <Detail label="Kargo" value={labelData.cargoProviderName} />
            <section className="label-debug-panel barcode-source-analysis">
              <h3>Barkod Kaynağı</h3>
              <Detail label="Aktif Barkod" value={labelData.barcodeValue} />
              <Detail label="Kaynak" value={labelData.barcodeSource} />
              <SourceCheck
                label="Sürat Takip No"
                active={
                  labelData.barcodeSource.includes('surat') &&
                  !labelData.barcodeSource.includes('temporary')
                }
              />
              <SourceCheck
                label="Trendyol CargoTrackingNumber"
                active={labelData.barcodeSource.includes('trendyol')}
              />
              <SourceCheck
                label="Shipment Reference"
                active={labelData.barcodeSource.includes('shipmentReference')}
              />
              <SourceCheck
                label="Fallback"
                active={
                  labelData.barcodeSource.includes('temporary') ||
                  labelData.barcodeSource.includes('fallback')
                }
              />
            </section>
            <section className="label-debug-panel">
              <h3>Sürat Gönderi Doğrulama</h3>
              <span
                className={
                  labelData.suratShipmentValidation.isMatched
                    ? 'surat-verified-badge'
                    : 'surat-unverified-badge'
                }
              >
                {labelData.suratShipmentValidation.statusText}
              </span>
              <Detail
                label="Trendyol orderNumber"
                value={labelData.suratShipmentValidation.trendyolOrderNumber}
              />
              <Detail
                label="Trendyol packageId"
                value={labelData.suratShipmentValidation.trendyolPackageId}
              />
              <Detail
                label="SatisKodu"
                value={labelData.suratShipmentValidation.SatisKodu}
              />
              <Detail
                label="WebSiparisKodu"
                value={labelData.suratShipmentValidation.WebSiparisKodu}
              />
              <Detail
                label="OzelKargoTakipNo"
                value={labelData.suratShipmentValidation.OzelKargoTakipNo}
              />
              <Detail
                label="KargoTakipNo"
                value={labelData.suratShipmentValidation.KargoTakipNo}
              />
              <Detail label="TakipNo" value={labelData.suratShipmentValidation.TakipNo} />
              <Detail label="TNo" value={labelData.suratShipmentValidation.TNo} />
              <Detail
                label="BarkodNo"
                value={labelData.suratShipmentValidation.BarkodNo}
              />
              <Detail label="Barkod" value={labelData.suratShipmentValidation.Barkod} />
              <Detail label="TakipUrl" value={labelData.suratShipmentValidation.TakipUrl} />
              <Detail
                label="TakipUrl kaynagi"
                value={labelData.suratShipmentValidation.TakipUrlSource}
              />
              <Detail
                label="TakipUrl icindeki takip no"
                value={labelData.suratShipmentValidation.TakipUrlTrackingNo}
              />
              <Detail
                label="TakipUrl takip no kaynagi"
                value={labelData.suratShipmentValidation.TakipUrlTrackingSource}
              />
              <Detail
                label="Satiskodu"
                value={labelData.suratShipmentValidation.Satiskodu}
              />
              <Detail label="SeriNo" value={labelData.suratShipmentValidation.SeriNo} />
              <Detail label="SiraNo" value={labelData.suratShipmentValidation.SiraNo} />
              <Detail
                label="KargoObjId"
                value={labelData.suratShipmentValidation.KargoObjId}
              />
              <Detail
                label="verifiedShipment"
                value={String(labelData.suratShipmentValidation.verifiedShipment)}
              />
              <Detail
                label="matchReason"
                value={labelData.suratShipmentValidation.matchReason}
              />
              <Detail
                label="trendyolCargoTrackingNumber"
                value={labelData.suratShipmentValidation.trendyolCargoTrackingNumber}
              />
              <Detail
                label="suratKargoTakipNo"
                value={labelData.suratShipmentValidation.suratKargoTakipNo}
              />
              <Detail
                label="extractedKargoTakipNo"
                value={labelData.suratShipmentValidation.extractedKargoTakipNo}
              />
            </section>
            <section className="label-debug-panel">
              <h3>Sürat Alan Eşleştirme</h3>
              <Detail label="orderNumber" value={labelData.suratFieldMapping.orderNumber} />
              <Detail label="T.No" value={labelData.suratFieldMapping.TNo} />
              <Detail
                label="Ana Barkod Değeri"
                value={labelData.suratFieldMapping.anaBarkodDegeri}
              />
              <Detail
                label="Sol Dikey Referans"
                value={labelData.suratFieldMapping.solDikeyReferans}
              />
              <Detail
                label="shipmentReference"
                value={labelData.suratFieldMapping.shipmentReference}
              />
              <Detail label="TakipNo" value={labelData.suratFieldMapping.TakipNo} />
              <Detail label="TNo" value={labelData.suratFieldMapping.TNoField} />
              <Detail label="BarkodNo" value={labelData.suratFieldMapping.BarkodNo} />
              <Detail label="Barkod" value={labelData.suratFieldMapping.Barkod} />
              <Detail
                label="Barcode"
                value={labelData.suratFieldMapping.Barcode}
              />
              <Detail
                label="BarkodDegeri"
                value={labelData.suratFieldMapping.BarkodDegeri}
              />
              <Detail
                label="GonderiKodu"
                value={labelData.suratFieldMapping.GonderiKodu}
              />
              <Detail label="SatisKodu" value={labelData.suratFieldMapping.SatisKodu} />
              <Detail
                label="WebSiparisKodu"
                value={labelData.suratFieldMapping.WebSiparisKodu}
              />
              <Detail
                label="KargoTakipNo"
                value={labelData.suratFieldMapping.KargoTakipNo}
              />
              <Detail
                label="OzelKargoTakipNo"
                value={labelData.suratFieldMapping.OzelKargoTakipNo}
              />
              <Detail label="ReferansNo" value={labelData.suratFieldMapping.ReferansNo} />
              <Detail label="KargoObjId" value={labelData.suratFieldMapping.KargoObjId} />
              <Detail label="SeriNo" value={labelData.suratFieldMapping.SeriNo} />
              <Detail label="SiraNo" value={labelData.suratFieldMapping.SiraNo} />
              <Detail label="TakipUrl" value={labelData.suratFieldMapping.TakipUrl} />
              <Detail
                label="TakipUrlSource"
                value={labelData.suratFieldMapping.TakipUrlSource}
              />
              <Detail
                label="TakipUrlTrackingNo"
                value={labelData.suratFieldMapping.TakipUrlTrackingNo}
              />
              <Detail
                label="TakipUrlTrackingSource"
                value={labelData.suratFieldMapping.TakipUrlTrackingSource}
              />
              <Detail
                label="selectedBarcodeValue"
                value={labelData.suratFieldMapping.selectedBarcodeValue}
              />
              <Detail
                label="selectedBarcodeSource"
                value={labelData.suratFieldMapping.selectedBarcodeSource}
              />
              <Detail
                label="trendyolCargoTrackingNumber"
                value={labelData.suratFieldMapping.trendyolCargoTrackingNumber}
              />
              <Detail
                label="suratKargoTakipNo"
                value={labelData.suratFieldMapping.suratKargoTakipNo}
              />
              <Detail
                label="extractedKargoTakipNo"
                value={labelData.suratFieldMapping.extractedKargoTakipNo}
              />
              <Detail label="packageId" value={labelData.suratFieldMapping.packageId} />
              <Detail
                label="matchReason"
                value={labelData.suratFieldMapping.matchReason}
              />
              <Detail
                label="verifiedShipment"
                value={labelData.suratFieldMapping.verifiedShipment}
              />
            </section>
            <JsonDetails title="rawSuratResponse" value={labelData.rawSuratResponse} />
            <JsonDetails
              title="Sürat raw response görüntüle"
              value={labelData.suratCreateLog}
            />
            <details className="label-json-details">
              <summary>Sürat ZPL ham çıktısı</summary>
              <pre>
                {order?.shipment?.barcodeRaw ||
                  order?.shipment?.suratCreateLog?.BarcodeRaw ||
                  'BarcodeRaw bulunamadı'}
              </pre>
            </details>
            <JsonDetails
              title="Sürat takip response görüntüle"
              value={labelData.suratTrackingLog}
            />
          </aside>
        </div>

        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Kapat
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canDownload || busy}
            onClick={() => order && onDownloadZpl(order.id, mappingConfig)}
          >
            <Download size={18} />
            ZPL İndir
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canDownload || busy}
            onClick={() => order && onPrint(order.id)}
          >
            <Printer size={18} />
            {order?.labelStatus === 'PRINTED'
              ? 'Tekrar Yazdır'
              : 'Etiketi Yazdır'}
          </button>
        </footer>
      </section>
    </div>
  )

  function updateOverride(
    key: keyof LabelPreviewOverrides,
    value: string,
  ) {
    if (!order) return
    onPreviewOverridesChange(order.id, {
      ...previewOverrides,
      [key]: value,
    })
  }
}

function parseDesiInput(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function desiSourceLabel(
  source: CargoOrder['desiSource'],
): string {
  if (source === 'manual') return 'Manuel'
  if (source === 'manual_total') return 'Manuel toplam koli desisi'
  if (source === 'product') return 'Ürün'
  if (source === 'product_lines') return 'Ürün satırları (adet × birim desi)'
  if (source === 'calculated') return 'Hesaplanan'
  if (source === 'api') return 'API'
  if (source === 'default') return 'Varsayılan'
  return 'Eksik'
}

function EditableField({
  label,
  value,
  onChange,
  wide,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  wide?: boolean
}) {
  return (
    <label className={wide ? 'wide' : ''}>
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function ReadOnlyField({
  label,
  value,
}: {
  label: string
  value?: string
}) {
  return (
    <label>
      <span>{label}</span>
      <input value={value || '-'} readOnly aria-readonly="true" />
    </label>
  )
}

function Detail({ label, value }: { label: string; value?: string }) {
  return (
    <div className="label-meta-row">
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  )
}

function SourceCheck({ label, active }: { label: string; active: boolean }) {
  return (
    <div className={active ? 'barcode-source-row active' : 'barcode-source-row'}>
      <strong>{active ? '✓' : '✗'}</strong>
      <span>{label}</span>
    </div>
  )
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="label-json-details">
      <summary>{title}</summary>
      <pre>{value ? JSON.stringify(value, null, 2) : 'Veri bulunamadı'}</pre>
    </details>
  )
}
