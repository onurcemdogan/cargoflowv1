// KARGO OPERASYONLARI — "Kargo üretim hattında şu anda ne oluyor?"
//
// Bu ekran gönderi OLUŞTURMAZ: sipariş seçimi ve tekil/toplu oluşturma
// Siparişler ekranındadır. Burada yalnız hattın durumu (kuyruk, hazırlama,
// hazır etiket, istisnalar) ve son işlemler okunur. Kaynak sunucudaki
// gerçek kayıtlardır (`/api/shipping/pipeline`); veri alınamazsa SAHTE "0"
// gösterilmez, hata açıkça yazılır.
//
// Satır aksiyonları mevcut akışlara gider: siparişi aç, HAZIR etiketi yeniden
// yazdır (create YOK), gönderiyi görüntüle. Sonucu belirsiz (UNKNOWN) bir
// işlem için hiçbir oluşturma aksiyonu sunulmaz.
import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Eye, Printer, RefreshCcw, Route } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import type { PageKey } from '../types/cargoflow'
import type { QuickTab } from '../utils/ordersTabs'
import { Alert, Badge, Card, EmptyState, type Tone } from '../ui/primitives'
import {
  fetchShippingPipeline,
  type PipelineAttentionRow,
  type ShippingPipeline,
} from '../services/shippingOverviewClient'

interface CargoOperationsPageProps {
  /** Siparişi Siparişler ekranında (detay çekmecesiyle) açar. */
  onOpenOrder: (orderId: string) => void
  /** HAZIR etiketi yeniden yazdırır — mevcut baskı akışı, create YOK. */
  onPrintLabel: (orderId: string) => void
  /** Gönderiler ekranını (isteğe bağlı aramayla) açar. */
  onOpenShipments: (search?: string) => void
  onNavigateOrders: (tab?: QuickTab) => void
  onNavigate?: (page: PageKey) => void
  /** Testler için enjekte edilebilir yükleyici. */
  load?: () => Promise<ShippingPipeline>
  /** Değiştiğinde özet yeniden okunur (yazdır sonrası). */
  refreshToken?: number
}

const ATTENTION_LABEL: Record<PipelineAttentionRow['kind'], { label: string; tone: Tone }> = {
  BLOCKED: { label: 'Engellendi', tone: 'warning' },
  UNKNOWN_AFTER_NETWORK: { label: 'Sonucu belirsiz', tone: 'danger' },
  OPERATION_UNCERTAIN: { label: 'Sonucu belirsiz', tone: 'danger' },
  OPERATION_FAILED: { label: 'Taşıyıcı reddetti', tone: 'danger' },
  UNVERIFIED: { label: 'Doğrulanamadı', tone: 'warning' },
}

const LABEL_STATE: Record<'ready' | 'printed' | 'none', { label: string; tone: Tone }> = {
  ready: { label: 'Hazır', tone: 'label' },
  printed: { label: 'Basıldı', tone: 'success' },
  none: { label: 'Yok', tone: 'neutral' },
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return '—'
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} sn`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} dk ${rest} sn` : `${minutes} dk`
}

export function CargoOperationsPage({
  onOpenOrder,
  onPrintLabel,
  onOpenShipments,
  onNavigateOrders,
  load = fetchShippingPipeline,
  refreshToken = 0,
}: CargoOperationsPageProps) {
  const [pipeline, setPipeline] = useState<ShippingPipeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let active = true
    load()
      .then((result) => {
        if (!active) return
        setPipeline(result)
        setError(null)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Kargo operasyon özeti yüklenemedi.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [load, tick, refreshToken])

  const refresh = useCallback(() => {
    setLoading(true)
    setTick((value) => value + 1)
  }, [])

  const summary = pipeline?.summary
  const kpis: Array<{ key: string; label: string; value: number | undefined; tone: Tone; onOpen?: () => void }> = [
    { key: 'queued', label: 'Kuyrukta', value: summary?.queued, tone: 'neutral' },
    { key: 'preparing', label: 'Hazırlanıyor', value: summary?.preparing, tone: 'warning' },
    { key: 'ready', label: 'Etiket hazır', value: summary?.labelReady, tone: 'label', onOpen: () => onNavigateOrders('labelReady') },
    {
      key: 'attention',
      label: 'Kontrol gerekli',
      value: summary?.needsAttention,
      tone: 'danger',
      onOpen: () => document.getElementById('cargo-attention')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    },
    { key: 'created', label: 'Bugün oluşturulan', value: summary?.createdToday, tone: 'success', onOpen: () => onOpenShipments() },
    { key: 'handed', label: 'Bugün kargoya verilen', value: summary?.handedToday, tone: 'success', onOpen: () => onOpenShipments() },
  ]

  const worker = pipeline?.worker
  const automationOn = Boolean(worker?.backgroundEnabled && worker?.workspaceEnabled)
  const automationText = !worker
    ? ''
    : automationOn
      ? 'Yeni siparişlerin etiketi arka planda önceden hazırlanır; butona basıldığında yeniden oluşturulmaz.'
      : worker.backgroundEnabled
        ? 'Bu çalışma alanında kapalı: etiketler siz butona bastığınızda hazırlanır.'
        : 'Kapalı: etiketler siz butona bastığınızda hazırlanır.'

  return (
    <div className="cargo-ops" data-testid="cargo-operations-page">
      <PageHeader
        tourId="cargo-operations"
        title="Kargo Operasyonları"
        description="Kargo hattında şu anda ne olduğunu gösterir. Gönderi oluşturma Siparişler ekranından yapılır."
        actions={
          <>
            <button type="button" className="ui-btn ui-btn-secondary" onClick={refresh} disabled={loading}>
              <RefreshCcw size={15} className={loading ? 'spin-icon' : ''} aria-hidden="true" />
              Yenile
            </button>
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => onNavigateOrders('newOrders')}>
              Siparişlere git
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </>
        }
      />

      {error ? (
        <Alert tone="danger" title="Kargo operasyon özeti alınamadı" role="alert">
          {error}{' '}
          <button type="button" className="text-button" onClick={refresh}>
            Tekrar dene
          </button>
        </Alert>
      ) : null}

      <section className="home-ops cargo-ops-kpis" aria-label="Kargo hattı özeti" aria-busy={loading || undefined}>
        {kpis.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`home-op tone-${item.tone}`}
            onClick={item.onOpen}
            disabled={!item.onOpen}
            data-kpi={item.key}
          >
            <span className="home-op-label">
              <i aria-hidden="true" />
              {item.label}
            </span>
            <strong>{item.value === undefined ? '—' : item.value.toLocaleString('tr-TR')}</strong>
          </button>
        ))}
      </section>

      <div className="cargo-ops-grid">
        <Card title="Otomatik etiket hazırlama" labelledBy="cargo-worker-title" className="cargo-ops-worker">
          {!worker ? (
            <div className="ui-skeleton-list" aria-hidden="true">
              <i />
              <i />
            </div>
          ) : (
            <>
              <p className="cargo-ops-worker-state">
                <Badge tone={automationOn ? 'success' : 'neutral'} dot>
                  {automationOn ? 'Açık' : 'Kapalı'}
                </Badge>
                <span>{automationText}</span>
              </p>
              <dl className="cargo-ops-facts">
                <div><dt>Son hazırlanan etiket</dt><dd>{formatDateTime(worker.lastPreparedAt)}</dd></div>
                <div>
                  <dt>Ortalama hazırlama süresi</dt>
                  <dd>
                    {formatDuration(worker.averagePrepSeconds)}
                    {worker.sampleSize > 0 ? <small> · son 7 gün, {worker.sampleSize} etiket</small> : null}
                  </dd>
                </div>
              </dl>
              <ul className="cargo-ops-queue" aria-label="Hazırlama kuyruğu">
                <li><span>Sırada</span><b>{worker.counts.QUEUED + worker.counts.FAILED_SAFE_TO_RETRY}</b></li>
                <li><span>Hazırlanıyor</span><b>{worker.counts.PREPARING}</b></li>
                <li><span>Hazır</span><b>{worker.counts.READY}</b></li>
                <li className="is-warning"><span>Engellendi</span><b>{worker.counts.BLOCKED}</b></li>
                <li className="is-danger"><span>Sonucu belirsiz</span><b>{worker.counts.UNKNOWN_AFTER_NETWORK}</b></li>
              </ul>
            </>
          )}
        </Card>

        <Card
          title="Kontrol gereken işlemler"
          labelledBy="cargo-attention"
          className="cargo-ops-attention"
          subtitle="Engellenen, sonucu belirsiz kalan veya doğrulanamayan gönderiler. Bu işlemler için yeni gönderi açılmaz."
        >
          {!pipeline ? (
            <div className="ui-skeleton-list" aria-hidden="true">
              <i />
              <i />
            </div>
          ) : pipeline.attention.length === 0 ? (
            <EmptyState kind="done" compact title="Kontrol gereken işlem yok" body="Engellenen veya sonucu belirsiz bir işlem olduğunda burada görünür." />
          ) : (
            <ul className="home-list cargo-ops-attention-list">
              {pipeline.attention.map((row) => (
                <li key={`${row.kind}-${row.packageId}`} data-kind={row.kind}>
                  <div className="home-list-row is-compact cargo-ops-attention-row">
                    <span className="home-row-main">
                      <b>{row.orderNumber}</b>
                      <small>{row.reason}</small>
                    </span>
                    <Badge tone={ATTENTION_LABEL[row.kind].tone}>{ATTENTION_LABEL[row.kind].label}</Badge>
                    {row.orderId ? (
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost ui-btn-sm"
                        onClick={() => onOpenOrder(row.orderId as string)}
                        aria-label={`${row.orderNumber} siparişini aç`}
                      >
                        <Eye size={14} aria-hidden="true" />
                        Siparişi aç
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Son işlemler" labelledBy="cargo-recent-title" subtitle="Son gönderi oluşturma kayıtları.">
        {!pipeline ? (
          <div className="ui-skeleton-list" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        ) : pipeline.recent.length === 0 ? (
          <EmptyState kind="package" compact title="Henüz gönderi işlemi yok" body="Siparişler ekranından oluşturulan gönderiler burada görünür." />
        ) : (
          <div className="table-shell">
            <table className="data-table cargo-ops-table" aria-label="Son kargo işlemleri">
              <thead>
                <tr>
                  <th>Sipariş No</th>
                  <th>Pazaryeri</th>
                  <th>Kargo</th>
                  <th>İşlem aşaması</th>
                  <th>Etiket</th>
                  <th>Takip No</th>
                  <th>Son güncelleme</th>
                  <th aria-label="İşlem" />
                </tr>
              </thead>
              <tbody>
                {pipeline.recent.map((row) => (
                  <tr key={`${row.packageId}-${row.updatedAt}`}>
                    <td><strong>{row.orderNumber}</strong></td>
                    <td>{row.marketplace}</td>
                    <td>{row.carrier}</td>
                    <td><Badge tone={row.stageTone === 'neutral' ? 'neutral' : row.stageTone}>{row.stage}</Badge></td>
                    <td><Badge tone={LABEL_STATE[row.labelState].tone}>{LABEL_STATE[row.labelState].label}</Badge></td>
                    <td>{row.trackingNumber ?? '—'}</td>
                    <td>{formatDateTime(row.updatedAt)}</td>
                    <td>
                      <div className="table-row-actions">
                        {row.orderId ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="Siparişi aç"
                            aria-label={`${row.orderNumber} siparişini aç`}
                            onClick={() => onOpenOrder(row.orderId as string)}
                          >
                            <Eye size={15} />
                          </button>
                        ) : null}
                        {row.canReprint && row.orderId ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="Hazır etiketi yazdır"
                            aria-label={`${row.orderNumber} hazır etiketi yazdır`}
                            onClick={() => onPrintLabel(row.orderId as string)}
                          >
                            <Printer size={15} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="icon-button"
                          title="Gönderiyi görüntüle"
                          aria-label={`${row.orderNumber} gönderisini görüntüle`}
                          onClick={() => onOpenShipments(row.orderNumber)}
                        >
                          <Route size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
