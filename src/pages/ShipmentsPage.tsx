// GÖNDERİLER VE TAKİP — gönderi merkezli defter.
//
// Siparişler = ne satıldı / ne hazırlanacak (oluşturmanın kaynağı).
// Gönderiler = kargoya çıktıktan sonra ne oldu.
//
// Bu ekran gönderi OLUŞTURMAZ. Satır aksiyonları mevcut akışlara gider:
// takibi sorgula, kayıtlı etiketi aç / yeniden yazdır (create YOK), sipariş
// detayını aç. Sonucu belirsiz (kontrol gerekli) gönderide yeniden yazdırma
// da sunulmaz. Kaynak: `/api/shipping/shipments` (shipments + sipariş
// projeksiyonu + kargo hesabı); veri alınamazsa hata açıkça yazılır.
import { useEffect, useMemo, useState } from 'react'
import { Eye, Printer, RefreshCcw, SearchCheck } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Alert, Badge, EmptyState, type Tone } from '../ui/primitives'
import {
  fetchShipmentLedger,
  type ShipmentLedgerQuery,
  type ShipmentLedgerResult,
  type ShipmentLedgerRow,
  type ShipmentTab,
} from '../services/shippingOverviewClient'

interface ShipmentsPageProps {
  onOpenOrder: (orderId: string) => void
  /** Kayıtlı etiketi yeniden yazdırır — mevcut baskı akışı, create YOK. */
  onPrintLabel: (orderId: string) => void
  onTrackShipment: (orderId: string) => void
  /** Kargo Operasyonları'ndan gelindiyse ön doldurulmuş arama. */
  initialSearch?: string
  /** Değiştiğinde liste filtreler korunarak yeniden okunur (yazdır/takip sonrası). */
  refreshToken?: number
  load?: (query: ShipmentLedgerQuery) => Promise<ShipmentLedgerResult>
}

const TABS: Array<{ key: ShipmentTab; label: string }> = [
  { key: 'all', label: 'Tümü' },
  { key: 'label_ready', label: 'Etiketi Hazır' },
  { key: 'in_transit', label: 'Kargoda' },
  { key: 'delivered', label: 'Teslim Edildi' },
  { key: 'attention', label: 'Kontrol Gerekli' },
]

const LIFECYCLE_TONE: Record<ShipmentLedgerRow['lifecycle'], Tone> = {
  created: 'neutral',
  label_ready: 'label',
  in_transit: 'info',
  delivered: 'success',
  attention: 'danger',
}

const LABEL_STATE: Record<ShipmentLedgerRow['labelState'], { label: string; tone: Tone }> = {
  ready: { label: 'Hazır', tone: 'label' },
  printed: { label: 'Basıldı', tone: 'success' },
  none: { label: 'Yok', tone: 'neutral' },
}

const YEAR_FORMAT = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', year: 'numeric' })

/** Bu yılın tarihleri yılsız yazılır (tablo genişliği); eski yıllar yıllı. */
function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const sameYear = YEAR_FORMAT.format(date) === YEAR_FORMAT.format(new Date())
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' as const }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

const PAGE_SIZE = 25

export function ShipmentsPage({
  onOpenOrder,
  onPrintLabel,
  onTrackShipment,
  initialSearch = '',
  refreshToken = 0,
  load = fetchShipmentLedger,
}: ShipmentsPageProps) {
  const [tab, setTab] = useState<ShipmentTab>('all')
  const [provider, setProvider] = useState('')
  const [marketplace, setMarketplace] = useState('')
  const [labelState, setLabelState] = useState<'' | 'ready' | 'printed' | 'none'>('')
  const [searchInput, setSearchInput] = useState(initialSearch)
  const [search, setSearch] = useState(initialSearch)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [tick, setTick] = useState(0)
  const [result, setResult] = useState<ShipmentLedgerResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const query = useMemo<ShipmentLedgerQuery>(
    () => ({ tab, provider, marketplace, labelState, search, from, to, page, pageSize: PAGE_SIZE }),
    [tab, provider, marketplace, labelState, search, from, to, page],
  )

  useEffect(() => {
    let active = true
    load(query)
      .then((next) => {
        if (!active) return
        setResult(next)
        setError(null)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Gönderiler yüklenemedi.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [load, query, tick, refreshToken])

  const reload = () => {
    setLoading(true)
    setTick((value) => value + 1)
  }
  const resetPage = () => setPage(1)
  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1

  return (
    <div className="shipments-page" data-testid="shipments-page">
      <PageHeader
        tourId="shipments-ledger"
        title="Gönderiler ve Takip"
        description="Kargoya çıkan gönderilerin durumu. Yeni gönderi Siparişler ekranından oluşturulur."
        actions={
          <button type="button" className="ui-btn ui-btn-secondary" onClick={reload} disabled={loading}>
            <RefreshCcw size={15} className={loading ? 'spin-icon' : ''} aria-hidden="true" />
            Yenile
          </button>
        }
      />

      <nav className="quick-tabs shipments-tabs" aria-label="Gönderi durumu">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? 'active' : ''}
            aria-pressed={tab === item.key}
            onClick={() => {
              setTab(item.key)
              resetPage()
            }}
          >
            {item.label}
            <span className="shipments-tab-count">{result ? result.counts[item.key].toLocaleString('tr-TR') : '—'}</span>
          </button>
        ))}
      </nav>

      <form
        className="filter-panel shipments-filters"
        aria-label="Gönderi filtreleri"
        onSubmit={(event) => {
          event.preventDefault()
          setSearch(searchInput.trim())
          resetPage()
        }}
      >
        <label>
          <span>Ara</span>
          <input
            type="search"
            value={searchInput}
            placeholder="Takip no, sipariş no veya paket no"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
        <label>
          <span>Kargo firması</span>
          <select value={provider} onChange={(event) => { setProvider(event.target.value); resetPage() }}>
            <option value="">Tümü</option>
            <option value="surat">Sürat Kargo</option>
            <option value="aras">Aras Kargo</option>
          </select>
        </label>
        <label>
          <span>Pazaryeri</span>
          <select value={marketplace} onChange={(event) => { setMarketplace(event.target.value); resetPage() }}>
            <option value="">Tümü</option>
            <option value="Trendyol">Trendyol</option>
            <option value="woocommerce">WooCommerce</option>
          </select>
        </label>
        <label>
          <span>Etiket durumu</span>
          <select value={labelState} onChange={(event) => { setLabelState(event.target.value as typeof labelState); resetPage() }}>
            <option value="">Tümü</option>
            <option value="ready">Hazır</option>
            <option value="printed">Basıldı</option>
            <option value="none">Yok</option>
          </select>
        </label>
        <label>
          <span>Başlangıç</span>
          <input type="date" value={from} onChange={(event) => { setFrom(event.target.value); resetPage() }} />
        </label>
        <label>
          <span>Bitiş</span>
          <input type="date" value={to} onChange={(event) => { setTo(event.target.value); resetPage() }} />
        </label>
        <div className="shipments-filters-submit">
          <button type="submit" className="ui-btn ui-btn-secondary">Ara</button>
        </div>
      </form>

      {error ? (
        <Alert tone="danger" title="Gönderiler alınamadı" role="alert">
          {error}{' '}
          <button type="button" className="text-button" onClick={reload}>
            Tekrar dene
          </button>
        </Alert>
      ) : null}

      {!result && !error ? (
        <div className="ui-skeleton-list" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      ) : result && result.rows.length === 0 ? (
        <EmptyState
          kind="package"
          title="Bu filtrelerle gönderi yok"
          body={
            tab === 'attention'
              ? 'Gönderi kaydı oluşmamış engellenen veya sonucu belirsiz işlemler Kargo Operasyonları > Kontrol gereken işlemler altında izlenir.'
              : 'Siparişler ekranından oluşturulan gönderiler burada izlenir.'
          }
        />
      ) : result ? (
        <>
          <div className="table-shell">
            <table className="data-table shipments-table" aria-label="Gönderiler">
              <thead>
                <tr>
                  <th>Sipariş No</th>
                  <th>Paket No</th>
                  <th>Pazaryeri</th>
                  <th>Kargo</th>
                  <th>Takip No</th>
                  <th>Gönderi durumu</th>
                  <th>Etiket</th>
                  <th>Ödeyen</th>
                  <th>Kargo hesabı</th>
                  <th>Oluşturulma</th>
                  <th>Son takip</th>
                  <th aria-label="İşlem" />
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.shipmentId} data-lifecycle={row.lifecycle}>
                    <td><strong>{row.orderNumber}</strong></td>
                    <td>{row.packageId}</td>
                    <td>{row.marketplace}</td>
                    <td>{row.carrier}</td>
                    <td>{row.trackingNumber ?? '—'}</td>
                    <td><Badge tone={LIFECYCLE_TONE[row.lifecycle]} dot>{row.lifecycleLabel}</Badge></td>
                    <td><Badge tone={LABEL_STATE[row.labelState].tone}>{LABEL_STATE[row.labelState].label}</Badge></td>
                    <td>{row.payer}</td>
                    <td>{row.carrierAccount ?? '—'}</td>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{formatDateTime(row.lastActivityAt)}</td>
                    <td>
                      <div className="table-row-actions">
                        {row.orderId && row.lifecycle !== 'attention' ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="Takibi sorgula"
                            aria-label={`${row.orderNumber} takibini sorgula`}
                            onClick={() => onTrackShipment(row.orderId as string)}
                          >
                            <SearchCheck size={15} />
                          </button>
                        ) : null}
                        {row.canReprint && row.orderId ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="Etiketi aç / tekrar yazdır"
                            aria-label={`${row.orderNumber} etiketini tekrar yazdır`}
                            onClick={() => onPrintLabel(row.orderId as string)}
                          >
                            <Printer size={15} />
                          </button>
                        ) : null}
                        {row.orderId ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="Sipariş detayını aç"
                            aria-label={`${row.orderNumber} sipariş detayını aç`}
                            onClick={() => onOpenOrder(row.orderId as string)}
                          >
                            <Eye size={15} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="shipments-pager">
            <span>
              {result.total.toLocaleString('tr-TR')} gönderiden {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, result.total)} arası
            </span>
            <div>
              <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                Önceki
              </button>
              <span>{page} / {totalPages}</span>
              <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
                Sonraki
              </button>
            </div>
          </footer>
        </>
      ) : null}
    </div>
  )
}
