import { Download, Printer, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  CargoOrder,
  LabelPreviewOverrides,
  LabelTemplate,
  PrinterSettings,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import {
  buildPrintableLabelData,
  resolvePrintableLabel,
} from '../utils/printableLabel'
import { LabelPreviewCard } from './LabelPreviewCard'
import {
  desiValuesDiffer,
  extractZplDesi,
  formatDesi,
  resolveNormalizedDesi,
} from '../utils/desi'

export type PrintPreviewMode = 'preview' | 'download' | 'print'

interface PrintPreviewModalProps {
  orders: CargoOrder[]
  canonicalOrders?: CargoOrder[]
  mode: PrintPreviewMode
  template: LabelTemplate
  mappingConfig: SuratLabelMappingConfig
  previewDrafts?: Record<string, LabelPreviewOverrides>
  printerSettings: PrinterSettings
  busy: boolean
  onClose: () => void
  onConfirm: (orderIds: string[], includePreviouslyPrinted: boolean) => void
  onModeChange?: (mode: Exclude<PrintPreviewMode, 'preview'>) => void
  onDesiChange: (
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) => void
}

export function PrintPreviewModal({
  orders,
  canonicalOrders = orders,
  mode,
  template,
  mappingConfig,
  previewDrafts = {},
  printerSettings,
  busy,
  onClose,
  onConfirm,
  onModeChange,
  onDesiChange,
}: PrintPreviewModalProps) {
  const [includePreviouslyPrinted, setIncludePreviouslyPrinted] = useState(
    () =>
      orders.length === 1 &&
      orders[0]?.labelStatus === 'PRINTED' &&
      Boolean(orders[0]?.label?.printedAt),
  )
  const [reprintRiskAccepted, setReprintRiskAccepted] = useState(false)
  const items = useMemo(
    () =>
      orders.map((order) => {
        const resolution = resolvePrintableLabel(order, {
          orders: canonicalOrders,
        })
        const previouslyPrinted = Boolean(
          resolution.labelStatus === 'PRINTED' && resolution.printedAt,
        )
        const normalizedDesi = resolveNormalizedDesi(resolution.order)
        return {
          order: resolution.order,
          resolution,
          previouslyPrinted,
          ready:
            resolution.canPreview && normalizedDesi.desi != null,
          warningReason:
            normalizedDesi.desi == null
              ? 'Desi bilgisi eksik.'
              : resolution.warningReason,
        }
      }),
    [canonicalOrders, orders],
  )
  const readyCount = items.filter((item) => item.ready).length
  const printReadyCount = items.filter(
    (item) => item.ready && item.resolution.canPrint,
  ).length
  const invalidCount = items.length - readyCount
  const printedCount = items.filter((item) => item.previouslyPrinted).length
  const selectedForAction = items.filter(
    (item) =>
      item.ready &&
      (mode === 'download'
        ? item.resolution.canPreview
        : item.resolution.canPrint) &&
      (!item.previouslyPrinted || includePreviouslyPrinted || mode !== 'print'),
  )
  const needsReprintConfirmation =
    mode === 'print' && includePreviouslyPrinted && printedCount > 0
  const canConfirm =
    selectedForAction.length > 0 &&
    (!needsReprintConfirmation || reprintRiskAccepted)

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="print-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={modalTitle(mode, items.length)}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">
              {items.length > 1 ? 'Toplu Etiket Önizleme' : 'Etiket Önizleme'}
            </span>
            <h2>{modalTitle(mode, items.length)}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <section className="print-preview-summary">
          <Summary label="Seçili etiket" value={items.length} />
          <Summary label="Basıma uygun" value={printReadyCount} />
          <Summary label="Daha önce basılmış" value={printedCount} warning />
          <Summary label="Uyarılı" value={invalidCount} danger />
        </section>

        {mode === 'print' ? (
          <div className="print-confirmation-copy">
            <strong>
              {printerSettings.mode === 'local-agent'
                ? `Bu işlem ${selectedForAction.length} adet Sürat etiketini ${printerSettings.printerName} yazıcısına RAW ZPL olarak gönderecek.`
                : printerSettings.mode === 'browser-print'
                  ? `Bu işlem ${selectedForAction.length} adet etiketi, uygulama arayüzünden bağımsız temiz bir baskı belgesinde açacak.`
                  : `${selectedForAction.length} etiket için ZPL dosyası hazırlanacak.`}
              Devam etmek istiyor musunuz?
            </strong>
            {printerSettings.mode === 'browser-print' ? (
              <span>
                Chrome yazdırma ekranında “Daha fazla ayar” bölümünden
                “Üstbilgiler ve altbilgiler” seçeneğinin kapalı olduğunu kontrol
                edin. Her sipariş tek etiket ve tek sayfa olarak hazırlanır.
              </span>
            ) : null}
          </div>
        ) : null}

        {mode === 'print' && printedCount > 0 ? (
          <section className="reprint-warning">
            <strong>
              {items.length === 1
                ? 'Bu etiket daha önce basıldı.'
                : `Seçili etiketlerden ${printedCount} tanesi daha önce basılmış.`}
            </strong>
            <span>
              Aynı barkodu tekrar yazdırmak mükerrer etiket kullanımına neden
              olabilir. Tekrar yazdırmak istediğinizden emin misiniz?
            </span>
            {items.length > 1 ? (
              <>
                <label>
                  <input
                    type="radio"
                    name="reprint-mode"
                    checked={!includePreviouslyPrinted}
                    onChange={() => {
                      setIncludePreviouslyPrinted(false)
                      setReprintRiskAccepted(false)
                    }}
                  />
                  Daha önce basılmışları hariç tut
                </label>
                <label>
                  <input
                    type="radio"
                    name="reprint-mode"
                    checked={includePreviouslyPrinted}
                    onChange={() => setIncludePreviouslyPrinted(true)}
                  />
                  Tümünü tekrar yazdır
                </label>
              </>
            ) : null}
            {includePreviouslyPrinted ? (
              <label className="reprint-risk-confirmation">
                <input
                  type="checkbox"
                  checked={reprintRiskAccepted}
                  onChange={(event) =>
                    setReprintRiskAccepted(event.target.checked)
                  }
                />
                Mükerrer barkod riskini anladım ve tekrar yazdırmayı onaylıyorum.
              </label>
            ) : null}
          </section>
        ) : null}

        <section className="bulk-label-preview-list">
          {items.map(({ order, resolution, previouslyPrinted, ready, warningReason }) => (
            <article
              key={order.id}
              className={`bulk-label-preview-item ${
                !ready ? 'invalid' : previouslyPrinted ? 'printed' : 'ready'
              }`}
            >
              <header className="bulk-label-preview-heading">
                <div>
                  <strong>Sipariş No: {order.orderNumber}</strong>
                  <span>{order.customerName || 'Müşteri bilgisi yok'}</span>
                </div>
                <span
                  className={`bulk-label-status-badge ${
                    !ready
                      ? 'invalid'
                      : previouslyPrinted
                        ? 'printed'
                        : 'ready'
                  }`}
                >
                  {!ready
                    ? 'Önizlenemedi'
                    : previouslyPrinted
                      ? 'Daha önce basıldı'
                      : !resolution.canPrint
                        ? 'Teknik ZPL'
                      : 'Basıma hazır'}
                </span>
              </header>
              <BulkDesiEditor
                order={order}
                onDesiChange={onDesiChange}
              />
              {ready ? (
                <section className="bulk-label-paper">
                  <LabelPreviewCard
                    order={order}
                    labelData={buildPrintableLabelData(
                      resolution,
                      template,
                      mappingConfig,
                    )}
                    template={template}
                    mappingConfig={mappingConfig}
                    overrides={previewDrafts[order.id]}
                  />
                </section>
              ) : (
                <section className="bulk-label-unavailable">
                  <strong>Bu etiket önizlenemedi</strong>
                  <span>Sebep: {warningReason}</span>
                </section>
              )}
              <footer className="bulk-label-preview-meta">
                <span>
                  Durum:{' '}
                  <strong>
                    {!ready
                      ? 'Uyarılı'
                      : previouslyPrinted
                        ? 'Tekrar baskı'
                        : 'Hazır'}
                  </strong>
                </span>
                <span>
                  Takip No:{' '}
                  <strong>{resolution.trackingNumber || '-'}</strong>
                </span>
                <span>
                  Barkod: <strong>{resolution.barcode || '-'}</strong>
                </span>
              </footer>
              <details className="bulk-label-debug">
                <summary>Etiket çözümleme detayı</summary>
                <pre>{JSON.stringify(resolution.debug, null, 2)}</pre>
              </details>
            </article>
          ))}
        </section>

        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            {mode === 'print' && printedCount > 0 && items.length === 1
              ? 'Vazgeç'
              : mode === 'print'
                ? 'İptal'
                : 'Kapat'}
          </button>
          {mode === 'preview' ? (
            <div className="modal-footer-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={readyCount === 0 || busy}
                onClick={() => onModeChange?.('download')}
              >
                <Download size={18} />
                ZPL İndir
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={printReadyCount === 0 || busy}
                onClick={() => onModeChange?.('print')}
              >
                <Printer size={18} />
                Yazdır
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={!canConfirm || busy}
              onClick={() =>
                onConfirm(
                  selectedForAction.map((item) => item.order.id),
                  includePreviouslyPrinted,
                )
              }
            >
              {mode === 'download' ? <Download size={18} /> : <Printer size={18} />}
              {mode === 'download'
                ? selectedForAction.some(
                    (item) => !item.resolution.canPrint,
                  )
                  ? 'Sürat ZPL İndir / Teknik Test'
                  : 'ZPL İndir'
                : printedCount === 1 &&
                    items.length === 1 &&
                    includePreviouslyPrinted
                  ? 'Tekrar Yazdır'
                  : 'Yazdırmayı Başlat'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

function BulkDesiEditor({
  order,
  onDesiChange,
}: {
  order: CargoOrder
  onDesiChange: PrintPreviewModalProps['onDesiChange']
}) {
  const normalized = resolveNormalizedDesi(order)
  const apiZplDesi = extractZplDesi(
    order.shipment?.barcodeRaw ||
      order.shipment?.suratCreateLog?.BarcodeRaw,
  )
  const mismatch = desiValuesDiffer(normalized.desi, apiZplDesi)

  return (
    <section className="bulk-label-preview-meta">
      <label>
        <span>Toplam koli desisi</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={normalized.desi ?? ''}
          placeholder="Desi girin"
          onChange={(event) => {
            const value = Number(event.target.value.replace(',', '.'))
            onDesiChange(
              order.id,
              Number.isFinite(value) && value > 0 ? value : null,
              Number.isFinite(value) && value > 0 ? 'manual_total' : null,
            )
          }}
        />
      </label>
      <span>
        Kaynak: <strong>{normalized.desiSource || 'eksik'}</strong>
      </span>
      <span>
        Değer: <strong>{formatDesi(normalized.desi)}</strong>
      </span>
      {mismatch ? (
        <span className="drawer-error">
          API ZPL desisi {formatDesi(apiZplDesi)}; indirilen ZPL{' '}
          {formatDesi(normalized.desi)} kullanacak.
        </span>
      ) : null}
    </section>
  )
}

function modalTitle(mode: PrintPreviewMode, count: number): string {
  if (mode === 'print') {
    return count > 1 ? 'Toplu Yazdırma Onayı' : 'Yazdırma Onayı'
  }
  if (mode === 'download') {
    return count > 1 ? 'Toplu ZPL Önizleme' : 'ZPL Önizleme'
  }
  return count > 1 ? 'Toplu Etiket Önizleme' : 'Etiket Önizleme'
}

function Summary({
  label,
  value,
  danger,
  warning,
}: {
  label: string
  value: number
  danger?: boolean
  warning?: boolean
}) {
  return (
    <div className={danger ? 'danger' : warning ? 'warning' : ''}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
