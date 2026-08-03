import {
  Barcode,
  Download,
  PackagePlus,
  RefreshCcw,
  Stamp,
} from 'lucide-react'
import { useMemo } from 'react'
import type { CargoOrder } from '../types/cargoflow'
import type { OrderCountSummary } from '../utils/orderCounts'
import {
  buildSelectedOrderSnapshot,
  describeSelectionOutsideView,
} from '../utils/selectedOrderSnapshot'
import {
  resolveSuratPhaseText,
  type SuratCreatePrintProgress,
} from '../utils/suratPhaseText'
export type { SuratCreatePrintProgress }

// OrdersPage'ten DAVRANIŞ DEĞİŞTİRMEDEN ayrılan tek-buton bölümü.
// Burada İŞ KURALI YOKTUR: seçim/uygunluk kararları prop olarak gelir, seçim
// özeti mevcut saf yardımcılardan (selectedOrderSnapshot) hesaplanır.
// Ayrılma nedeni: gerçek DOM/tıklama testini OrdersPage'in onlarca ilgisiz
// prop'unu uydurmadan yapabilmek.

export interface SuratCreatePrintResult {
  selectedCount: number
  created: number
  existingReady: number
  reprinted: number
  printed: number
  skipped: Array<{ orderNumber: string; reason: string }>
  failed: Array<{ orderNumber: string; reason: string }>
}

export interface SuratCreatePrintControlsProps {
  orders: CargoOrder[]
  visibleOrders: CargoOrder[]
  selectedIds: string[]
  listedCounts: OrderCountSummary
  activeTabLabel: string
  busy: boolean
  suratCreatePrintRunning: boolean
  suratCreatePrintProgress?: SuratCreatePrintProgress
  suratCreatePrintResult?: SuratCreatePrintResult
  onSuratCreateAndPrint?: () => void
  onMarkPrinted: () => void
  onCreateShipments: () => void
  onTrackShipments: () => void
  onDownloadZpl: () => void
  onMarkHandedToCargo: () => void
  hasPrintableSelection: boolean
  hasShipmentCreatableSelection: boolean
  hasZplDownloadableSelection: boolean
  hasHandedToCargoSelection: boolean
  printableDisabledReason?: string
  createDisabledReason?: string
  zplDisabledReason?: string
  handedDisabledReason?: string
}

export function SuratCreatePrintControls({
  orders,
  visibleOrders,
  selectedIds,
  listedCounts,
  activeTabLabel,
  busy,
  suratCreatePrintRunning,
  suratCreatePrintProgress,
  suratCreatePrintResult,
  onSuratCreateAndPrint,
  onMarkPrinted,
  onCreateShipments,
  onTrackShipments,
  onDownloadZpl,
  onMarkHandedToCargo,
  hasPrintableSelection,
  hasShipmentCreatableSelection,
  hasZplDownloadableSelection,
  hasHandedToCargoSelection,
  printableDisabledReason,
  createDisabledReason,
  zplDisabledReason,
  handedDisabledReason,
}: SuratCreatePrintControlsProps) {
  const selectionText =
    selectedIds.length === 0
      ? 'Seçili sipariş yok'
      : `${selectedIds.length} sipariş seçildi`
  // Seçim özeti GÖRÜNÜR listeden hesaplanmaz: sekme/filtre değişince (ör.
  // create sonrası siparişler Etiket Hazır'a geçince) 0 paket/0 kalem/0 ürün'e
  // düşüyordu. Seçim TÜM yüklenmiş siparişler üzerinden çözülür.
  const selectionSnapshot = useMemo(
    () => buildSelectedOrderSnapshot(orders, selectedIds, visibleOrders),
    [orders, selectedIds, visibleOrders],
  )
  // Seçim varsa özet SEÇİMDEN, yoksa (mevcut davranış) listeden gelir.
  const selectionCounts =
    selectedIds.length > 0 ? selectionSnapshot : listedCounts
  const selectionOutsideNote = describeSelectionOutsideView(
    selectionSnapshot,
    activeTabLabel,
  )
  const suratPhaseText = resolveSuratPhaseText(
    suratCreatePrintRunning,
    suratCreatePrintProgress,
  )

  return (
    <>
      {suratCreatePrintResult ? (
        <section className="surat-batch-result">
          <strong>
            {suratCreatePrintResult.failed.length === 0 &&
            suratCreatePrintResult.skipped.length === 0
              ? 'Tamamlandı'
              : suratCreatePrintResult.printed > 0
                ? 'Kısmi başarı'
                : 'İşlem tamamlanamadı'}
          </strong>
          <span>Seçilen: {suratCreatePrintResult.selectedCount}</span>
          <span>Yeni oluşturulan: {suratCreatePrintResult.created}</span>
          <span>Hazır etiket: {suratCreatePrintResult.existingReady}</span>
          <span>Tekrar baskı: {suratCreatePrintResult.reprinted}</span>
          <span>Yazdırılan: {suratCreatePrintResult.printed}</span>
          <span>Atlanan: {suratCreatePrintResult.skipped.length}</span>
          <span>Başarısız: {suratCreatePrintResult.failed.length}</span>
          {suratCreatePrintResult.skipped.length +
            suratCreatePrintResult.failed.length >
          0 ? (
            <details>
              <summary>Detaylar</summary>
              <ul>
                {[
                  ...suratCreatePrintResult.skipped.map((item) => ({
                    ...item, stage: 'Atlandı',
                  })),
                  ...suratCreatePrintResult.failed.map((item) => ({
                    ...item, stage: 'Başarısız',
                  })),
                ].map((item) => (
                  <li key={`${item.stage}-${item.orderNumber}`}>
                    <code>{item.orderNumber}</code> — {item.stage} —{' '}
                    {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <section className="toolbar">
        <div>
          <strong>{selectionText}</strong>
          <span>{selectionCounts.packageCount} paket</span>
          <span>{selectionCounts.lineCount} kalem</span>
          <span>{selectionCounts.quantityTotal} ürün</span>
          {selectionOutsideNote ? (
            <span className="toolbar-note">{selectionOutsideNote}</span>
          ) : null}
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="primary-button surat-one-click-button"
            onClick={onSuratCreateAndPrint}
            disabled={
              busy ||
              suratCreatePrintRunning ||
              selectedIds.length === 0 ||
              !onSuratCreateAndPrint
            }
            title={
              selectedIds.length === 0
                ? 'Önce en az bir sipariş seçin.'
                : 'Seçili siparişler için Sürat etiketi oluşturur ve yazdırır.'
            }
          >
            {suratCreatePrintRunning
              ? suratPhaseText || 'İşleniyor…'
              : 'Sürat Etiketi Oluştur ve Yazdır'}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkPrinted}
            title={printableDisabledReason}
            disabled={busy || suratCreatePrintRunning || selectedIds.length === 0 || !hasPrintableSelection}
          >
            <Barcode size={18} />
            Barkod Bas
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onCreateShipments}
            title={createDisabledReason}
            disabled={
              busy ||
              suratCreatePrintRunning ||
              selectedIds.length === 0 ||
              !hasShipmentCreatableSelection
            }
          >
            <PackagePlus size={18} />
            Ortak Barkod Oluştur / Tamamla
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onTrackShipments}
            title={
              busy
                ? 'İşlem devam ediyor.'
                : selectedIds.length === 0
                  ? 'Önce en az bir sipariş seçin.'
                  : undefined
            }
            disabled={busy || suratCreatePrintRunning || selectedIds.length === 0}
          >
            <RefreshCcw size={18} />
            Seçilenleri Yenile / Doğrula
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onDownloadZpl}
            title={zplDisabledReason}
            disabled={
              busy ||
              suratCreatePrintRunning ||
              selectedIds.length === 0 ||
              !hasZplDownloadableSelection
            }
          >
            <Download size={18} />
            ZPL İndir
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkPrinted}
            title={printableDisabledReason}
            disabled={busy || suratCreatePrintRunning || selectedIds.length === 0 || !hasPrintableSelection}
          >
            <Stamp size={18} />
            Yazdır / Tekrar Yazdır
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onMarkHandedToCargo}
            title={handedDisabledReason}
            disabled={busy || suratCreatePrintRunning || selectedIds.length === 0 || !hasHandedToCargoSelection}
          >
            <PackagePlus size={18} />
            Kargoya Verildi Yap
          </button>
        </div>
      </section>
    </>
  )
}
