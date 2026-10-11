// ANA SAYFA — önce bugünün operasyonu, ardından istatistikler.
//
// Üstte bugün yapılması gerekenler, kontrol gereken işlemler ve bağlantı
// sağlığı; altında satış ve kargo istatistikleri (DashboardPage) TAM haliyle
// durur. İstatistik paneli Ana Sayfa'nın parçasıdır, ayrı bir ekrana taşınmaz.
//
// Bütün sayılar GERÇEK kaynaktan gelir: auth modunda sunucunun operasyon
// anlık görüntüsü, legacy modda aynı `buildDashboardViewModel` fonksiyonu.
// Bağlantı sağlığı yalnız saklanmış durumdan okunur; sağlayıcı yoklanmaz.
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { AuthContext } from '../auth/AuthProvider'
import { PageHeader } from '../components/PageHeader'
import {
  buildDashboardViewModel,
  type DashboardOperationalSnapshot,
  type DashboardPeriodSelection,
  type DashboardViewModel,
} from '../dashboard/dashboardViewModel'
import {
  presentIntegrationHealth,
  type PresentedHealth,
} from '../integrations/integrationHealthView'
import { fetchDashboardOperationalSnapshot } from '../services/dashboardAnalyticsService'
import { fetchIntegrationHealth } from '../services/integrationHealthClient'
import type { CargoOrder, CargoProduct, PageKey } from '../types/cargoflow'
import type { OrdersNavigationFilters } from '../utils/ordersNavigation'
import type { QuickTab } from '../utils/ordersTabs'
import { Alert, Badge, Card, EmptyState, type Tone } from '../ui/primitives'

interface HomePageProps {
  orders: CargoOrder[]
  products?: CargoProduct[]
  useServerOperationalSnapshot: boolean
  dataSourceResolved: boolean
  loading: boolean
  error?: string
  lastSyncedAt?: string
  onRefresh: () => void
  onNavigatePage: (page: PageKey) => void
  onNavigateOrders: (tab?: QuickTab, orderId?: string, filters?: OrdersNavigationFilters) => void
  /** İstatistik paneli; `refresh` hem siparişleri hem bu sayfanın özetlerini yeniler. */
  renderStatistics?: (refresh: () => void) => ReactNode
}

const TODAY: DashboardPeriodSelection = { key: 'today' }

const SEVERITY_TONE: Record<PresentedHealth['severity'], Tone> = {
  ok: 'success',
  info: 'info',
  warning: 'warning',
  critical: 'danger',
  muted: 'neutral',
}

function greeting(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', hour12: false }).format(now),
  )
  if (hour < 6) return 'İyi geceler'
  if (hour < 12) return 'Günaydın'
  if (hour < 18) return 'İyi günler'
  return 'İyi akşamlar'
}

function formatTime(value?: string | null): string {
  if (!value) return 'Henüz yok'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return 'Henüz yok'
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

export function HomePage({
  orders,
  products = [],
  useServerOperationalSnapshot,
  dataSourceResolved,
  loading,
  error,
  lastSyncedAt,
  onRefresh,
  onNavigatePage,
  onNavigateOrders,
  renderStatistics,
}: HomePageProps) {
  const auth = useContext(AuthContext)
  const username = auth?.user?.username
  const [refreshTick, setRefreshTick] = useState(0)

  // ── Operasyon anlık görüntüsü ─────────────────────────────────────────
  const [server, setServer] = useState<{
    viewModel: DashboardViewModel
    snapshot: DashboardOperationalSnapshot
  } | null>(null)
  const [serverError, setServerError] = useState<string>()
  useEffect(() => {
    if (!useServerOperationalSnapshot) return
    let active = true
    fetchDashboardOperationalSnapshot(TODAY, { refresh: refreshTick > 0, latestSyncAt: lastSyncedAt })
      .then((result) => {
        if (!active) return
        setServer({ viewModel: result.viewModel, snapshot: result.snapshot })
        setServerError(undefined)
      })
      .catch((reason) => {
        if (!active) return
        setServerError(reason instanceof Error ? reason.message : 'Operasyon özeti yüklenemedi.')
      })
    return () => {
      active = false
    }
  }, [lastSyncedAt, refreshTick, useServerOperationalSnapshot])

  const localViewModel = useMemo(
    () =>
      buildDashboardViewModel({
        orders,
        operationalSnapshot: useServerOperationalSnapshot ? server?.snapshot : undefined,
        products,
        selectedPeriod: TODAY,
        latestSyncAt: lastSyncedAt,
      }),
    [lastSyncedAt, orders, products, server, useServerOperationalSnapshot],
  )
  const viewModel = server?.viewModel ?? localViewModel
  const waitingForData = !dataSourceResolved || (useServerOperationalSnapshot && !server && !serverError)

  // ── Bağlantı sağlığı (yalnız auth modunda uç vardır) ──────────────────
  const [health, setHealth] = useState<{ items: PresentedHealth[]; error?: string } | null>(null)
  useEffect(() => {
    if (!useServerOperationalSnapshot) return
    let active = true
    fetchIntegrationHealth()
      .then((items) => {
        if (active) setHealth({ items: items.map(presentIntegrationHealth) })
      })
      .catch(() => {
        if (active) setHealth({ items: [], error: 'Bağlantı durumu alınamadı.' })
      })
    return () => {
      active = false
    }
  }, [refreshTick, useServerOperationalSnapshot])

  const summary = viewModel.operationalSummary
  const operations: Array<{
    key: string
    label: string
    count: number
    tone: Tone
    onOpen: () => void
  }> = [
    {
      key: 'today',
      label: 'Bugün gelen',
      count: viewModel.salesSummary.orderCount.value,
      tone: 'neutral',
      onOpen: () => onNavigateOrders('all', undefined, { datePreset: 'today' }),
    },
    {
      key: 'attention',
      label: 'Hatalı işlem',
      count: summary.errors,
      tone: 'danger',
      onOpen: () => document.getElementById('home-attention')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    },
    {
      key: 'barcode',
      label: 'Barkod bekliyor',
      count: summary.barcodeWaiting,
      tone: 'warning',
      onOpen: () => onNavigateOrders('barcodePending'),
    },
    {
      key: 'ready',
      label: 'Etiket hazır',
      count: summary.labelReady,
      tone: 'label',
      onOpen: () => onNavigateOrders('labelReady'),
    },
    {
      key: 'cargo',
      label: 'Kargoya verildi',
      count: summary.handedToCargo,
      tone: 'success',
      onOpen: () => onNavigateOrders('handedToCargo'),
    },
  ]

  const refresh = () => {
    setRefreshTick((tick) => tick + 1)
    onRefresh()
  }

  const attention = viewModel.actionRequired.filter((item) => item.count > 0)
  const latestSync = viewModel.latestSyncAt ?? lastSyncedAt

  return (
    <div className="home">
      <PageHeader
        tourId="dashboard-overview"
        title={username ? `${greeting(new Date())}, ${username}` : 'Ana Sayfa'}
        description="Bugünün operasyonu, bağlantılarınız ve satış istatistikleriniz tek ekranda."
      />

      {/* İstatistik paneli aynı hatayı kendi başlığında gösterir. */}
      {error && !renderStatistics ? (
        <Alert tone="danger" title="Siparişler yenilenemedi" role="alert">
          {error}
        </Alert>
      ) : null}
      {serverError ? (
        <Alert tone="warning" title="Operasyon özeti güncellenemedi" role="status">
          Gösterilen sayılar son başarılı özetten. {serverError}
        </Alert>
      ) : null}

      <section className="home-ops" aria-label="Operasyon durumu" aria-busy={waitingForData || loading || undefined}>
        {operations.map((item) => (
          <button key={item.key} type="button" className={`home-op tone-${item.tone}`} onClick={item.onOpen}>
            <span className="home-op-label">
              <i aria-hidden="true" />
              {item.label}
            </span>
            <strong>{waitingForData ? '—' : item.count.toLocaleString('tr-TR')}</strong>
          </button>
        ))}
      </section>

      <div className="home-grid">
          <Card title="Kontrol gereken işlemler" labelledBy="home-attention" className="home-attention">
            {waitingForData ? (
              <div className="ui-skeleton-list" aria-hidden="true">
                <i />
                <i />
              </div>
            ) : attention.length === 0 ? (
              <EmptyState
                kind="done"
                compact
                title="Bekleyen sorun yok"
                body="Kontrol gerektiren bir işlem olduğunda burada görünür."
              />
            ) : (
              <ul className="home-list">
                {attention.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      className="home-list-row is-compact"
                      onClick={() =>
                        onNavigateOrders(
                          item.filterTarget,
                          undefined,
                          item.actionFilter ? { actionFilter: item.actionFilter } : undefined,
                        )
                      }
                    >
                      <span className="home-row-main">
                        <b>{item.label}</b>
                        <small>{item.description}</small>
                      </span>
                      <Badge tone={item.severity === 'danger' ? 'danger' : item.severity === 'warning' ? 'warning' : 'info'}>
                        {item.count.toLocaleString('tr-TR')}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Bağlantı sağlığı"
            labelledBy="home-health-title"
            actions={
              <button type="button" className="text-button" onClick={() => onNavigatePage('integrations')}>
                Entegrasyonlar <ArrowRight size={14} />
              </button>
            }
          >
            {!dataSourceResolved ? (
              <div className="ui-skeleton-list" aria-hidden="true">
                <i />
                <i />
              </div>
            ) : !useServerOperationalSnapshot ? (
              <EmptyState
                kind="connection"
                compact
                title="Yerel çalışma modu"
                body="Bağlantı sağlığı oturum açılmış organizasyon modunda izlenir."
              />
            ) : health === null ? (
              <div className="ui-skeleton-list" aria-hidden="true">
                <i />
                <i />
              </div>
            ) : health.error ? (
              <EmptyState kind="error" compact title="Bağlantı durumu alınamadı" body="Biraz sonra yeniden deneyin." />
            ) : health.items.length === 0 ? (
              <EmptyState
                kind="connection"
                compact
                title="Henüz bağlantı yok"
                body="Pazaryeri ve kargo hesaplarınızı Entegrasyonlar ekranından bağlayın."
              />
            ) : (
              <ul className="home-health">
                {health.items.map((item) => (
                  <li key={item.connectionKey}>
                    <span className={`home-health-dot tone-${SEVERITY_TONE[item.severity]}`} aria-hidden="true" />
                    <span className="home-row-main">
                      <b>{item.title}</b>
                      <small>{item.actionText ?? `${item.facts[0]?.value ?? ''} · ${item.stageText}`}</small>
                    </span>
                    <Badge tone={SEVERITY_TONE[item.severity]}>{item.headline}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Son senkronizasyon" labelledBy="home-sync-title">
            <dl className="home-sync">
              <div>
                <dt>Sipariş senkronu</dt>
                <dd>{formatTime(latestSync)}</dd>
              </div>
              {health && !health.error
                ? health.items
                    .filter((item) => item.facts[1])
                    .map((item) => (
                      <div key={item.connectionKey}>
                        <dt>{item.title}</dt>
                        <dd>{item.facts[1].value}</dd>
                      </div>
                    ))
                : null}
            </dl>
          </Card>
      </div>

      {renderStatistics ? (
        <section className="home-statistics" aria-label="İstatistikler">
          {renderStatistics(refresh)}
        </section>
      ) : null}
    </div>
  )
}
