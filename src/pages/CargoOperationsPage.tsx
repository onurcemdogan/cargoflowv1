import { Barcode, Download, PackagePlus, SearchCheck } from 'lucide-react'
import { ActionResult } from '../components/ActionResult'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge } from '../components/StatusBadge'
import type { CargoOrder, WorkflowResult } from '../types/cargoflow'
import { formatDisplayDate } from '../utils/formatters'
import {
  canCreateShipment,
  canDownloadZpl,
  canMarkPrinted,
  hasCarrierTracking,
} from '../utils/orderStatus'
import { verifySuratShipment } from '../utils/suratVerification'
import { mapOperationStatus } from '../utils/statusPresentation'

interface CargoOperationsPageProps {
  orders: CargoOrder[]
  selectedIds: string[]
  result?: WorkflowResult
  busy: boolean
  onNavigateOrders: () => void
  onCreateShipments: () => void
  onTrackShipments: () => void
  onPrintLabels: () => void
  onDownloadZpl: () => void
}

export function CargoOperationsPage({
  orders,
  selectedIds,
  result,
  busy,
  onNavigateOrders,
  onCreateShipments,
  onTrackShipments,
  onPrintLabels,
  onDownloadZpl,
}: CargoOperationsPageProps) {
  const shippedOrders = orders.filter(hasCarrierTracking)
  const selectedOrders = orders.filter((order) => selectedIds.includes(order.id))
  const hasShipmentCreatableSelection = selectedOrders.some(canCreateShipment)
  const hasTrackableSelection = selectedOrders.some((order) => order.shipment)
  const hasPrintableSelection = selectedOrders.some(canMarkPrinted)
  const hasZplDownloadableSelection = selectedOrders.some(canDownloadZpl)

  return (
    <>
      <PageHeader
        title="Kargo İşlemleri"
        description="Sürat gönderisi, trackingNumber, shipmentCode ve rawResponse bilgisini bu ekrandan kontrol et."
        actions={
          <button type="button" className="secondary-button" onClick={onNavigateOrders}>
            Sipariş seçimine git
          </button>
        }
      />

      <section className="toolbar">
        <div>
          <strong>{selectedIds.length} sipariş seçili</strong>
          <span>Seçim Siparişler ekranından yapılır.</span>
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onCreateShipments}
            disabled={
              busy || selectedIds.length === 0 || !hasShipmentCreatableSelection
            }
          >
            <PackagePlus size={18} />
            Sürat gönderisi oluştur
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onTrackShipments}
            disabled={busy || selectedIds.length === 0 || !hasTrackableSelection}
          >
            <SearchCheck size={18} />
            Kargo takip sorgula
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onPrintLabels}
            disabled={busy || selectedIds.length === 0 || !hasPrintableSelection}
          >
            <Barcode size={18} />
            Barkod Bas
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onDownloadZpl}
            disabled={
              busy || selectedIds.length === 0 || !hasZplDownloadableSelection
            }
          >
            <Download size={18} />
            ZPL indir
          </button>
        </div>
      </section>

      <ActionResult result={result} />

      <section className="panel">
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>Sipariş</th>
                <th>Müşteri</th>
                <th>Tracking</th>
                <th>Shipment Code</th>
                <th>Barcode</th>
                <th>ZPL Source</th>
                <th>Kaynak</th>
                <th>Durum</th>
                <th>Raw Response</th>
                <th>Tarih</th>
              </tr>
            </thead>
            <tbody>
              {shippedOrders.map((order) => {
                const verification = verifySuratShipment(order)
                const operationStatus = mapOperationStatus(order)
                return (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.orderNumber}</strong>
                      <span>{order.marketplace}</span>
                    </td>
                    <td>{order.customerName}</td>
                    <td>
                      {verification.suratKargoTakipNo ||
                        verification.extractedKargoTakipNo ||
                        order.shipment?.trackingNumber ||
                        '-'}
                    </td>
                    <td>{order.shipment?.shipmentCode || order.packageId || '-'}</td>
                    <td>{verification.barcode || order.shipment?.barcode || '-'}</td>
                    <td>{verification.zplSource}</td>
                    <td>
                      <span className={`source-pill ${order.shipment?.source ?? order.source}`}>
                        {order.shipment?.source === 'local' ? 'Yerel kayıt' : 'Gerçek API'}
                      </span>
                    </td>
                    <td>
                      <StatusBadge
                        status={operationStatus.label}
                        tone={operationStatus.color}
                      />
                      <span>Kaynak: {operationStatus.sourceLabel || 'CargoFlow'}</span>
                      {verification.verifiedShipment ? (
                        <span className="surat-verified-badge">Sürat doğrulandı</span>
                      ) : null}
                      {(order.label?.printCount ?? 0) > 1 ? (
                        <span>Tekrar baskı: {(order.label?.printCount ?? 1) - 1} kez</span>
                      ) : null}
                    </td>
                    <td>
                      <code className="inline-code">
                        {JSON.stringify(order.shipment?.rawResponse ?? {}).slice(0, 180)}
                      </code>
                    </td>
                    <td>
                      {order.shipment?.createdAt
                        ? formatDisplayDate(order.shipment.createdAt)
                        : '-'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {shippedOrders.length === 0 ? (
            <p className="empty-state">Henüz Sürat gönderisi oluşturulmadı.</p>
          ) : null}
        </div>
      </section>
    </>
  )
}
