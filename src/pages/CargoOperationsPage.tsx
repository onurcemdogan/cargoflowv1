import type { ReactNode } from 'react'
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
import { canActivateLabelWorkflow } from '../utils/labelWorkflowActivation'
import { verifySuratShipment } from '../utils/suratVerification'
import { mapOperationStatus } from '../utils/statusPresentation'
import { Card, EmptyState, Spinner } from '../ui/primitives'

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
  // "Barkod Oluştur" ARTIK yalnız taşıyıcı create demek DEĞİLDİR: arka planda
  // hazırlanmış etiketi kullanıcı iş akışına ALMAK da bu butonun işidir.
  // `canCreateShipment` o siparişte false döner (ikinci create AÇILMAZ) — bu
  // yüzden aktivasyon yeteneği AYRICA sorulur; yoksa buton pasif kalır ve
  // kullanıcı siparişi hiçbir şekilde ilerletemezdi.
  const hasShipmentCreatableSelection = selectedOrders.some(
    (order) => canCreateShipment(order) || canActivateLabelWorkflow(order),
  )
  const hasTrackableSelection = selectedOrders.some((order) => order.shipment)
  const hasPrintableSelection = selectedOrders.some(canMarkPrinted)
  const hasZplDownloadableSelection = selectedOrders.some(canDownloadZpl)

  const noSelection = selectedIds.length === 0
  const steps: Array<{
    key: string
    index: number
    title: string
    description: string
    hint: string
    actions: ReactNode
  }> = [
    {
      key: 'shipment',
      index: 1,
      title: 'Gönderi oluştur',
      description: 'Seçili siparişler için Sürat Kargo gönderi kaydı açılır.',
      hint: noSelection
        ? 'Önce Siparişler ekranından sipariş seçin.'
        : hasShipmentCreatableSelection
          ? 'Seçimde gönderisi açılabilecek sipariş var.'
          : 'Seçimdeki siparişlerin gönderisi zaten açık.',
      actions: (
        <button
          type="button"
          className="secondary-button"
          onClick={onCreateShipments}
          disabled={busy || noSelection || !hasShipmentCreatableSelection}
        >
          <PackagePlus size={16} />
          Sürat gönderisi oluştur
        </button>
      ),
    },
    {
      key: 'label',
      index: 2,
      title: 'Etiketi bas',
      description: 'Gönderisi açılan siparişin etiketi yazıcıya gönderilir ya da ZPL olarak indirilir.',
      hint: noSelection
        ? 'Etiket, gönderi oluşturulduktan sonra açılır.'
        : hasPrintableSelection || hasZplDownloadableSelection
          ? 'Seçimde basılabilir etiket var.'
          : 'Seçimde henüz basılabilir etiket yok.',
      actions: (
        <>
          <button
            type="button"
            className="secondary-button"
            onClick={onPrintLabels}
            disabled={busy || noSelection || !hasPrintableSelection}
          >
            <Barcode size={16} />
            Barkod Bas
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onDownloadZpl}
            disabled={busy || noSelection || !hasZplDownloadableSelection}
          >
            <Download size={16} />
            ZPL indir
          </button>
        </>
      ),
    },
    {
      key: 'track',
      index: 3,
      title: 'Takibi sorgula',
      description: 'Sürat Kargo üzerinden gönderinin güncel hareketleri alınır.',
      hint: noSelection
        ? 'Takip, gönderisi olan siparişlerde açılır.'
        : hasTrackableSelection
          ? 'Seçimde takip edilebilir gönderi var.'
          : 'Seçimde gönderisi olan sipariş yok.',
      actions: (
        <button
          type="button"
          className="secondary-button"
          onClick={onTrackShipments}
          disabled={busy || noSelection || !hasTrackableSelection}
        >
          <SearchCheck size={16} />
          Kargo takip sorgula
        </button>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        tourId="cargo-operations"
        title="Kargo İşlemleri"
        description="Seçili siparişler için gönderi oluşturun, etiketi basın ve kargo takibini sorgulayın."
        actions={
          <button type="button" className="secondary-button" onClick={onNavigateOrders}>
            Sipariş seçimine git
          </button>
        }
      />

      <section className="cargo-flow" aria-label="Kargo akışı">
        <header className="cargo-flow-head">
          <div>
            <strong>{selectedIds.length} sipariş seçili</strong>
            <span>Seçim Siparişler ekranından yapılır.</span>
          </div>
          {busy ? (
            <span className="cargo-flow-busy">
              <Spinner /> İşleniyor
            </span>
          ) : null}
        </header>
        <ol className="cargo-flow-steps">
          {steps.map((step) => (
            <li key={step.key} className="cargo-flow-step">
              <span className="cargo-flow-index" aria-hidden="true">
                {step.index}
              </span>
              <div className="cargo-flow-copy">
                <b>{step.title}</b>
                <p>{step.description}</p>
                <small>{step.hint}</small>
              </div>
              <div className="cargo-flow-actions">{step.actions}</div>
            </li>
          ))}
        </ol>
      </section>

      <ActionResult result={result} />

      <Card
        className="cargo-shipments"
        title="Gönderiler"
        subtitle={shippedOrders.length > 0 ? `${shippedOrders.length} gönderi` : undefined}
        labelledBy="cargo-shipments-title"
      >
        {shippedOrders.length === 0 ? (
          <EmptyState
            kind="package"
            title="Henüz Sürat gönderisi oluşturulmadı."
            body="Siparişler ekranında sipariş seçip gönderi oluşturduğunuzda kayıtlar burada listelenir."
            action={
              <button type="button" className="secondary-button" onClick={onNavigateOrders}>
                Siparişlere git
              </button>
            }
          />
        ) : (
          <div className="table-shell">
            <table className="data-table cargo-shipments-table">
              <thead>
                <tr>
                  <th>Sipariş</th>
                  <th>Müşteri</th>
                  <th>Takip No</th>
                  <th>Gönderi Kodu</th>
                  <th>Barkod</th>
                  <th>Etiket Kaynağı</th>
                  <th>Kaynak</th>
                  <th>Durum</th>
                  <th>Ham Yanıt</th>
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
                        <StatusBadge status={operationStatus.label} tone={operationStatus.color} />
                        <span>Kaynak: {operationStatus.sourceLabel || 'CargoFlow'}</span>
                        {verification.verifiedShipment ? (
                          <span className="surat-verified-badge">Sürat doğrulandı</span>
                        ) : null}
                        {(order.label?.printCount ?? 0) > 1 ? (
                          <span>Tekrar baskı: {(order.label?.printCount ?? 1) - 1} kez</span>
                        ) : null}
                      </td>
                      <td>
                        <details className="cargo-raw">
                          <summary>Göster</summary>
                          <code className="inline-code">
                            {JSON.stringify(order.shipment?.rawResponse ?? {}).slice(0, 180)}
                          </code>
                        </details>
                      </td>
                      <td>
                        {order.shipment?.createdAt ? formatDisplayDate(order.shipment.createdAt) : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
