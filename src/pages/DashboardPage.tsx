import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Download,
  Eye,
  MapPin,
  Minus,
  Printer,
  RefreshCcw,
  Store,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ProductImageThumb } from '../components/ProductImageThumb'
import { OrderDetailDrawer } from '../components/OrderDetailDrawer'
import { buildDashboardProviderHealth } from '../dashboard/dashboardSummary'
import {
  buildDashboardViewModel,
  resolveDashboardOrder,
  type DashboardComparison,
  type DashboardDateRange,
  type DashboardDistributionRow,
  type DashboardPeriodKey,
  type DashboardPeriodSelection,
  type DashboardSalesPeriodCard,
  type DashboardTimeBucket,
} from '../dashboard/dashboardViewModel'
import type {
  ApiDebugLog,
  CargoOrder,
  CargoProduct,
  IntegrationConfig,
  PageKey,
  PrinterSettings,
  TenantDesiConfig,
} from '../types/cargoflow'
import { formatDisplayDate } from '../utils/formatters'
import type { OrdersNavigationFilters } from '../utils/ordersNavigation'
import type { QuickTab } from '../utils/ordersTabs'
import {
  fetchDashboardAnalyticsClaims,
  fetchDashboardAnalyticsOrders,
} from '../services/dashboardAnalyticsService'
import type { AnalyticsClaim } from '../dashboard/analyticsClaims'

interface DashboardPageProps {
  orders: CargoOrder[]
  products?: CargoProduct[]
  integrationConfig: IntegrationConfig
  printerSettings: PrinterSettings
  apiDebugLogs: ApiDebugLog[]
  loading: boolean
  error?: string
  lastSyncedAt?: string
  onRefresh: () => void
  onNavigatePage: (page: PageKey) => void
  onNavigateOrders: (
    tab?: QuickTab,
    orderId?: string,
    filters?: OrdersNavigationFilters,
  ) => void
  onDownloadOrder: (orderId: string) => void
  onPrintOrder: (orderId: string) => void
  onCreateShipment: (orderId: string) => void
  onTrackShipment: (orderId: string) => void
  onDesiChange: (
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) => void
  desiConfig?: TenantDesiConfig
}

const periodOptions: Array<{ key: DashboardPeriodKey; label: string }> = [
  { key: 'today', label: 'Bugün' },
  { key: 'yesterday', label: 'Dün' },
  { key: 'last7', label: '7 Gün' },
  { key: 'last30', label: '30 Gün' },
  { key: 'month', label: 'Bu Ay' },
  { key: 'custom', label: 'Özel' },
]

const marketplaceColors = ['#2563eb', '#14b8a6', '#f59e0b', '#8b5cf6', '#64748b']

export function DashboardPage({
  orders,
  products = [],
  integrationConfig,
  printerSettings,
  apiDebugLogs,
  loading,
  error,
  lastSyncedAt,
  onRefresh,
  onNavigatePage,
  onNavigateOrders,
  onDownloadOrder,
  onPrintOrder,
  onCreateShipment,
  onTrackShipment,
  onDesiChange,
  desiConfig,
}: DashboardPageProps) {
  const todayInput = formatInputDate(new Date())
  const [periodKey, setPeriodKey] = useState<DashboardPeriodKey>('today')
  const [customStartDate, setCustomStartDate] = useState(todayInput)
  const [customEndDate, setCustomEndDate] = useState(todayInput)
  const [activeDashboardOperationId, setActiveDashboardOperationId] =
    useState<string>()
  const [dashboardDetailError, setDashboardDetailError] = useState<string>()
  const selectedPeriod = useMemo<DashboardPeriodSelection>(
    () => ({
      key: periodKey,
      startDate: customStartDate,
      endDate: customEndDate,
    }),
    [customEndDate, customStartDate, periodKey],
  )
  // SATIŞ analitiği: operational ordersState'ten bağımsız, cap'siz dönemsel
  // veri (analytics endpoint'i). Operasyon panelleri ordersState'i kullanmaya
  // devam eder. Loading/error render'da TÜRETİLİR (effect'te senkron setState
  // yok): sonuç, üretildiği istek anahtarıyla birlikte saklanır.
  const [analyticsResult, setAnalyticsResult] = useState<{
    key: string
    orders?: CargoOrder[]
    error?: string
  }>()
  const [analyticsRetryTick, setAnalyticsRetryTick] = useState(0)
  const analyticsOrders = analyticsResult?.orders ?? null
  // Kabul edilmiş iadeler; satış NET metriklerini düşürür. Orders'tan
  // bağımsız yüklenir: claims hatası satış panelini bloklamaz, yalnız
  // "net eksik olabilir" uyarısı gösterir.
  const [claimsResult, setClaimsResult] = useState<{
    key: string
    claims?: AnalyticsClaim[]
    error?: string
  }>()
  const analyticsClaims = claimsResult?.claims ?? null
  const viewModel = useMemo(
    () =>
      buildDashboardViewModel({
        orders,
        analyticsOrders: analyticsOrders ?? undefined,
        analyticsClaims: analyticsClaims ?? undefined,
        products,
        selectedPeriod,
        latestSyncAt: lastSyncedAt,
      }),
    [
      analyticsOrders,
      analyticsClaims,
      lastSyncedAt,
      orders,
      products,
      selectedPeriod,
    ],
  )
  // İlk açılışta kartların tamamını (Geçen Ay başı → Bugün sonu) kapsayan
  // TEK aralık çekilir; seçili dönem bu kapsamın dışına çıkarsa service
  // birleşik aralığı yeniden çeker, kapsam içindeyse cache'ten döner.
  const analyticsRangeKey = useMemo(() => {
    const ranges = [
      viewModel.period,
      viewModel.comparisonPeriod,
      ...viewModel.salesPeriodCards.map((card) => card.range),
    ]
    const start = Math.min(...ranges.map((range) => range.start.getTime()))
    const end = Math.max(...ranges.map((range) => range.end.getTime()))
    return `${start}|${end}`
  }, [viewModel.period, viewModel.comparisonPeriod, viewModel.salesPeriodCards])
  const analyticsRequestKey = `${analyticsRangeKey}#${analyticsRetryTick}`
  useEffect(() => {
    const [startMs, endMs] = analyticsRequestKey
      .split('#')[0]
      .split('|')
      .map(Number)
    let active = true
    fetchDashboardAnalyticsOrders(new Date(startMs), new Date(endMs))
      .then((result) => {
        if (active) {
          setAnalyticsResult({ key: analyticsRequestKey, orders: result.orders })
        }
      })
      .catch((error) => {
        if (active) {
          setAnalyticsResult({
            key: analyticsRequestKey,
            error:
              error instanceof Error
                ? error.message
                : 'Satış analitiği yüklenemedi.',
          })
        }
      })
    return () => {
      active = false
    }
  }, [analyticsRequestKey])
  // İade verisi orders ile aynı geniş kapsam için ayrı yüklenir.
  useEffect(() => {
    const [startMs, endMs] = analyticsRequestKey
      .split('#')[0]
      .split('|')
      .map(Number)
    let active = true
    fetchDashboardAnalyticsClaims(new Date(startMs), new Date(endMs))
      .then((result) => {
        if (active) {
          setClaimsResult({ key: analyticsRequestKey, claims: result.claims })
        }
      })
      .catch((error) => {
        if (active) {
          setClaimsResult({
            key: analyticsRequestKey,
            error:
              error instanceof Error
                ? error.message
                : 'İade verisi yüklenemedi.',
          })
        }
      })
    return () => {
      active = false
    }
  }, [analyticsRequestKey])
  // SSR/test render'ında effect çalışmaz; skeleton'da kilitlenmemek için
  // loading yalnız tarayıcıda türetilir (fallback: operasyon verisi).
  const analyticsLoading =
    typeof window !== 'undefined' && analyticsResult?.key !== analyticsRequestKey
  const analyticsError =
    analyticsResult?.key === analyticsRequestKey
      ? analyticsResult.error
      : undefined
  const analyticsPending = analyticsLoading && !analyticsOrders
  // İade verisi yüklenemediyse satış NET değerleri iade düşümü içermez.
  const claimsError =
    claimsResult?.key === analyticsRequestKey ? claimsResult.error : undefined
  const providerHealth = useMemo(
    () =>
      buildDashboardProviderHealth({
        config: integrationConfig,
        apiDebugLogs,
        orders,
        lastSyncedAt,
      }),
    [apiDebugLogs, integrationConfig, lastSyncedAt, orders],
  )
  const hasConfiguredMarketplace = providerHealth.marketplaceIntegrations.some(
    (provider) => provider.status !== 'not_configured',
  )
  const periodFilters = useMemo(
    () => navigationFiltersForPeriod(viewModel.period),
    [viewModel.period],
  )
  const activeDashboardOperation = viewModel.recentOperations.find(
    (operation) => operation.id === activeDashboardOperationId,
  )
  const activeDashboardOrder = activeDashboardOperation
    ? resolveDashboardOrder(orders, activeDashboardOperation)
    : undefined

  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.debug('DASHBOARD_MODEL_READY', {
      period: viewModel.period.key,
      periodOrderCount: viewModel.salesSummary.orderCount.value,
      openOperations: viewModel.operationalSummary.openOperations,
      cityCount: viewModel.cityDistribution.length,
      marketplaceCount: viewModel.marketplaceDistribution.length,
    })
    console.debug('DASHBOARD_COMPARISON_READY', {
      currentPeriod: viewModel.period.label,
      comparisonPeriod: viewModel.comparisonPeriod.label,
      comparable: viewModel.salesSummary.salesAmount.comparison.comparable,
    })
    console.debug('DASHBOARD_METRIC_COUNTS', {
      salesOrders: viewModel.salesSummary.orderCount.value,
      lines: viewModel.salesSummary.lineCount.value,
      quantity: viewModel.salesSummary.productCount.value,
      openOperations: viewModel.operationalSummary.openOperations,
      handedToCargo: viewModel.operationalSummary.handedToCargo,
    })
    console.debug('DASHBOARD_CITY_DISTRIBUTION', {
      cityCount: viewModel.cityDistribution.length,
      orderCount: viewModel.cityDistribution.reduce(
        (total, row) => total + row.orderCount,
        0,
      ),
    })
    console.debug('DASHBOARD_MARKETPLACE_DISTRIBUTION', {
      marketplaceCount: viewModel.marketplaceDistribution.length,
      orderCount: viewModel.marketplaceDistribution.reduce(
        (total, row) => total + row.orderCount,
        0,
      ),
    })
    console.debug('DASHBOARD_TOP_PRODUCTS', {
      groupCount: viewModel.topProducts.length,
    })
    console.debug('DASHBOARD_ACTION_REQUIRED', {
      rowCount: viewModel.actionRequired.length,
      totalCount: viewModel.actionRequired.reduce(
        (total, row) => total + row.count,
        0,
      ),
    })
  }, [viewModel])

  function choosePeriod(key: DashboardPeriodKey) {
    setPeriodKey(key)
    if (import.meta.env.DEV) {
      console.debug('DASHBOARD_PERIOD_CHANGED', { period: key })
    }
  }

  function navigateOrders(
    tab: QuickTab,
    filters?: OrdersNavigationFilters,
    orderId?: string,
  ) {
    if (import.meta.env.DEV) {
      console.debug('DASHBOARD_FILTER_NAVIGATION', {
        tab,
        datePreset: filters?.datePreset ?? 'all',
        marketplace: filters?.marketplace ?? 'all',
        city: filters?.city ? 'selected' : 'all',
      })
    }
    onNavigateOrders(tab, orderId, filters)
  }

  function openDashboardOrderDetail(operationId: string) {
    const operation = viewModel.recentOperations.find(
      (item) => item.id === operationId,
    )
    if (!operation) {
      setActiveDashboardOperationId(undefined)
      setDashboardDetailError('Sipariş detayı bulunamadı.')
      return
    }
    const order = resolveDashboardOrder(orders, operation)
    if (!order) {
      setActiveDashboardOperationId(undefined)
      setDashboardDetailError('Sipariş detayı bulunamadı.')
      return
    }
    setDashboardDetailError(undefined)
    setActiveDashboardOperationId(operation.id)
  }

  void printerSettings

  return (
    <div className="dashboard-page dashboard-analytics" data-testid="dashboard-analytics">
      <header className="dashboard-analytics-header">
        <div>
          <h1>Dashboard</h1>
          <p>Satış ve kargo operasyon verilerinizi tek ekrandan takip edin.</p>
        </div>
        <div className="dashboard-analytics-controls">
          <div className="dashboard-period-switch" aria-label="Dashboard dönemi">
            {periodOptions.map((period) => (
              <button
                key={period.key}
                type="button"
                className={periodKey === period.key ? 'active' : ''}
                aria-pressed={periodKey === period.key}
                onClick={() => choosePeriod(period.key)}
              >
                {period.label}
              </button>
            ))}
          </div>
          {periodKey === 'custom' ? (
            <div className="dashboard-custom-range">
              <label>
                <span>Başlangıç</span>
                <input
                  aria-label="Başlangıç tarihi"
                  type="date"
                  value={customStartDate}
                  onChange={(event) => setCustomStartDate(event.target.value)}
                  onInput={(event) =>
                    setCustomStartDate(event.currentTarget.value)
                  }
                />
              </label>
              <span>–</span>
              <label>
                <span>Bitiş</span>
                <input
                  aria-label="Bitiş tarihi"
                  type="date"
                  value={customEndDate}
                  onChange={(event) => setCustomEndDate(event.target.value)}
                  onInput={(event) =>
                    setCustomEndDate(event.currentTarget.value)
                  }
                />
              </label>
            </div>
          ) : (
            <div className="dashboard-period-range" title={viewModel.period.helper}>
              <CalendarDays size={15} />
              {formatDisplayDate(viewModel.period.start.toISOString())} –{' '}
              {formatDisplayDate(viewModel.period.end.toISOString())}
            </div>
          )}
          <button
            type="button"
            className="dashboard-refresh-button"
            onClick={onRefresh}
            disabled={loading || !hasConfiguredMarketplace}
          >
            <RefreshCcw size={16} className={loading ? 'spin-icon' : ''} />
            {loading ? 'Yenileniyor' : 'Yenile'}
          </button>
          <small>
            Son senkronizasyon:{' '}
            <strong>
              {viewModel.latestSyncAt
                ? formatDisplayDate(viewModel.latestSyncAt)
                : 'Bekleniyor'}
            </strong>
          </small>
        </div>
      </header>

      {error ? (
        <section className="dashboard-alert error">
          <XCircle size={20} />
          <div>
            <strong>Dashboard verileri yenilenemedi</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={onRefresh} disabled={loading}>
            Tekrar dene
          </button>
        </section>
      ) : null}

      {!hasConfiguredMarketplace ? (
        <section className="dashboard-alert warning">
          <AlertTriangle size={20} />
          <div>
            <strong>Pazaryeri bağlantısı bulunamadı</strong>
            <span>Gerçek satış verisini görmek için entegrasyon ayarlarını tamamlayın.</span>
          </div>
          <button type="button" onClick={() => onNavigatePage('integrations')}>
            Ayarlara git
          </button>
        </section>
      ) : null}

      <section className="dashboard-section-heading" aria-labelledby="sales-analytics-title">
        <div>
          <span>Satış Analitiği</span>
          <h2 id="sales-analytics-title">Dönemsel satış özeti</h2>
        </div>
        <p>Satış metrikleri yalnız sipariş, paket ve ürün satırı verilerinden hesaplanır.</p>
        <p
          className="dashboard-reporting-note"
          title="Durusoft satış raporlarıyla aynı gün sınırı kullanılır. Sipariş saatleri Türkiye saatiyle gösterilmeye devam eder."
        >
          Rapor günü UTC bazında hesaplanır.
        </p>
      </section>

      {analyticsError ? (
        <section className="dashboard-analytics-error" role="alert">
          <p>Satış analitiği yüklenemedi.</p>
          <small>{analyticsError}</small>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setAnalyticsRetryTick((tick) => tick + 1)}
          >
            Tekrar dene
          </button>
        </section>
      ) : analyticsPending ? (
        <section
          className="dashboard-analytics-loading"
          aria-busy="true"
          aria-label="Satış analitiği yükleniyor"
        >
          <div className="dashboard-skeleton dashboard-skeleton-cards" />
          <div className="dashboard-skeleton dashboard-skeleton-chart" />
          <span>Satış analitiği yükleniyor…</span>
        </section>
      ) : (
        <>
      {claimsError ? (
        <section className="dashboard-analytics-warning" role="status">
          <AlertTriangle size={16} />
          <span>İade verisi yüklenemedi; satış net değerleri eksik olabilir.</span>
        </section>
      ) : null}
      <section className="dashboard-sales-period-cards" aria-label="Dönemsel satış kartları">
        {viewModel.salesPeriodCards.map((card) => (
          <SalesPeriodCard key={card.key} card={card} />
        ))}
      </section>

      <section className="dashboard-analytics-grid dashboard-analytics-row-main">
        <article className="dashboard-analytics-card dashboard-sales-chart-card">
          <DashboardCardHeader
            title={viewModel.salesChart.title}
            helper="Satış tutarı"
          />
          <SalesLineChart
            current={viewModel.salesChart.current}
            comparison={viewModel.salesChart.comparison}
          />
        </article>

        <article className="dashboard-analytics-card dashboard-city-card">
          <DashboardCardHeader
            title="Türkiye Satış Dağılımı"
            helper="Teslimat iline göre gerçek siparişler"
            icon={<MapPin size={18} />}
          />
          <DistributionBars
            rows={viewModel.cityDistribution}
            emptyText="Bu dönem için şehir verisi bulunamadı."
            onSelect={(row) =>
              navigateOrders('all', { ...periodFilters, city: row.label })
            }
          />
        </article>

        <article className="dashboard-analytics-card dashboard-marketplace-card">
          <DashboardCardHeader
            title="Pazaryeri Satış Dağılımı"
            helper="Sipariş tutarı payı"
            icon={<Store size={18} />}
          />
          <MarketplaceDonut
            rows={viewModel.marketplaceDistribution}
            onSelect={(row) =>
              navigateOrders('all', {
                ...periodFilters,
                marketplace: row.label as OrdersNavigationFilters['marketplace'],
              })
            }
          />
        </article>
      </section>

      <section className="dashboard-analytics-grid dashboard-sales-products-row">
        <article className="dashboard-analytics-card dashboard-top-products-card">
          <DashboardCardHeader
            title="En Çok Satan Ürünler"
            helper={`${viewModel.period.label} · İlk 10 ürün`}
          />
          {viewModel.topProducts.length > 0 ? (
            <div className="dashboard-table-wrap">
              <table className="dashboard-compact-table dashboard-top-products-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Ürün</th>
                    <th>Satılan Adet</th>
                    <th>Toplam Ciro</th>
                  </tr>
                </thead>
                <tbody>
                  {viewModel.topProducts.map((product, index) => (
                    <tr key={product.key}>
                      <td>{index + 1}</td>
                      <td>
                        <div className="dashboard-product-cell-new">
                          <ProductImageThumb
                            candidates={product.imageCandidates}
                            alt={product.productName}
                            className="dashboard-mini-product-image"
                            placeholderClassName="dashboard-mini-product-placeholder"
                          />
                          <span>
                            <strong>{product.productName}</strong>
                            <small>{product.barcode || product.sku || 'Kod yok'}</small>
                          </span>
                        </div>
                      </td>
                      <td><strong>{product.quantity}</strong></td>
                      <td>{formatCurrency(product.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dashboard-empty-card">Bu dönem için ürün satışı bulunamadı.</div>
          )}
        </article>
      </section>
        </>
      )}

      <section className="dashboard-section-heading dashboard-operation-heading" aria-labelledby="operation-analytics-title">
        <div>
          <span>Operasyon Analitiği</span>
          <h2 id="operation-analytics-title">Kargo operasyon görünümü</h2>
        </div>
        <p>Mevcut CargoFlow operasyon sınıflandırması ve işlem bekleyen kayıtlar korunur.</p>
      </section>

      <section className="dashboard-analytics-grid dashboard-analytics-row-ops">
        <article className="dashboard-analytics-card dashboard-actions-card-new">
          <DashboardCardHeader
            title="Aksiyon Gerektirenler"
            icon={<AlertTriangle size={18} />}
          />
          <div className="dashboard-action-list-new">
            {viewModel.actionRequired
              .filter((item) => item.count > 0)
              .map((item) => (
                <button
                  type="button"
                  key={item.key}
                  className={`severity-${item.severity}`}
                  onClick={() =>
                    navigateOrders(
                      item.filterTarget,
                      item.actionFilter
                        ? { actionFilter: item.actionFilter }
                        : undefined,
                    )
                  }
                >
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  <b>{item.count}</b>
                  <ArrowRight size={14} />
                </button>
              ))}
            {viewModel.actionRequired.every((item) => item.count === 0) ? (
              <div className="dashboard-empty-compact">Aksiyon gerektiren işlem yok.</div>
            ) : null}
          </div>
        </article>

        <article className="dashboard-analytics-card dashboard-operation-flow-card">
          <DashboardCardHeader
            title="Operasyon Akışı"
            helper="Backlog alanları anlık, tamamlanan adımlar seçili dönemdir"
          />
          <div className="dashboard-operation-flow">
            {viewModel.operationFlow.map((step, index) => (
              <button
                type="button"
                key={step.key}
                onClick={() =>
                  navigateOrders(
                    step.filterTarget,
                    ['printed', 'cargo', 'delivered'].includes(step.key)
                      ? periodFilters
                      : undefined,
                  )
                }
              >
                <span>{index + 1}</span>
                <small>{step.label}</small>
                <strong>{step.count}</strong>
              </button>
            ))}
          </div>
        </article>

        <article className="dashboard-analytics-card dashboard-picking-card">
          <DashboardCardHeader
            title={viewModel.pickingLists.title}
            helper="Açık operasyonlardan salt okunur özet"
          />
          <div className="dashboard-picking-list">
            {viewModel.pickingLists.products.map((product) => (
              <div key={product.key}>
                <ProductImageThumb
                  candidates={product.imageCandidates}
                  alt={product.productName}
                  className="dashboard-mini-product-image"
                  placeholderClassName="dashboard-mini-product-placeholder"
                />
                <span>
                  <strong>{product.productName}</strong>
                  <small>{product.barcode || product.sku || 'Kod yok'}</small>
                </span>
                <b>{product.quantity} adet</b>
              </div>
            ))}
            {viewModel.pickingLists.products.length === 0 ? (
              <div className="dashboard-empty-compact">
                Açık operasyonlarda toplanacak ürün bulunamadı.
              </div>
            ) : null}
          </div>
        </article>
      </section>

      <section className="dashboard-analytics-grid dashboard-analytics-row-bottom">
        <article className="dashboard-analytics-card dashboard-recent-ops-card">
          <DashboardCardHeader
            title="Son Operasyonlar"
            action={
              <button
                type="button"
                className="dashboard-card-link"
                onClick={() => navigateOrders('all')}
              >
                Tümünü gör <ArrowRight size={14} />
              </button>
            }
          />
          {viewModel.recentOperations.length > 0 ? (
            <div className="dashboard-table-wrap">
              <table className="dashboard-compact-table dashboard-operations-table">
                <thead>
                  <tr>
                    <th>Sipariş No</th>
                    <th>Pazaryeri</th>
                    <th>Müşteri</th>
                    <th>Ürün</th>
                    <th>Durum</th>
                    <th>Kargo</th>
                    <th>İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {viewModel.recentOperations.map((operation) => (
                    <tr key={operation.id}>
                      <td><strong>{operation.orderNumber}</strong></td>
                      <td>{operation.marketplace}</td>
                      <td>{operation.customerName}</td>
                      <td>
                        <div className="dashboard-product-cell-new">
                          <ProductImageThumb
                            candidates={operation.imageCandidates}
                            alt={operation.productName}
                            className="dashboard-mini-product-image"
                            placeholderClassName="dashboard-mini-product-placeholder"
                          />
                          <span>
                            <strong>{operation.productName}</strong>
                            <small>
                              {operation.productVariant || 'Varyant bilgisi yok'}
                              {operation.additionalItemCount > 0
                                ? ` · +${operation.additionalItemCount} ürün`
                                : ''}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td><span className="dashboard-operation-status">{operation.status}</span></td>
                      <td>{operation.carrier}</td>
                      <td>
                        <div className="dashboard-row-actions">
                          <button
                            type="button"
                            aria-label="Sipariş detayını görüntüle"
                            title="Detayı Gör"
                            data-order-number={operation.orderNumber}
                            onClick={() => openDashboardOrderDetail(operation.id)}
                          >
                            <Eye size={15} />
                          </button>
                          <button
                            type="button"
                            aria-label={`${operation.orderNumber} etiketi yazdır`}
                            title={operation.canPrint ? 'Etiketi yazdır' : operation.printDisabledReason}
                            disabled={!operation.canPrint}
                            onClick={() => onPrintOrder(operation.id)}
                          >
                            <Printer size={15} />
                          </button>
                          <button
                            type="button"
                            aria-label={`${operation.orderNumber} ZPL indir`}
                            title={operation.canDownloadZpl ? 'ZPL indir' : operation.zplDisabledReason}
                            disabled={!operation.canDownloadZpl}
                            onClick={() => onDownloadOrder(operation.id)}
                          >
                            <Download size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dashboard-empty-card">Henüz operasyon kaydı bulunamadı.</div>
          )}
        </article>
      </section>
      {dashboardDetailError ? (
        <div className="dashboard-detail-error" role="status">
          {dashboardDetailError}
        </div>
      ) : null}
      {activeDashboardOrder ? (
        <OrderDetailDrawer
          order={activeDashboardOrder}
          products={products}
          busy={loading}
          onClose={() => {
            setActiveDashboardOperationId(undefined)
            setDashboardDetailError(undefined)
          }}
          onCreateShipment={onCreateShipment}
          onTrackShipment={onTrackShipment}
          onDownloadZpl={onDownloadOrder}
          onPrintLabel={onPrintOrder}
          onDesiChange={onDesiChange}
          desiConfig={desiConfig}
        />
      ) : null}
    </div>
  )
}

function SalesPeriodCard({ card }: { card: DashboardSalesPeriodCard }) {
  const trend = salesTrend(card.comparison)
  return (
    <article className={`dashboard-sales-period-card period-${card.key}`}>
      <header>
        <span>
          <strong>{card.label}</strong>
          <small>{card.dateLabel}</small>
        </span>
        <span className={`dashboard-sales-trend ${card.comparison.direction}`}>
          {trend.label} {trend.icon}
        </span>
      </header>
      <div className="dashboard-sales-period-primary">
        <div className="sales-net">
          <small>Satış (Net)</small>
          <strong>
            {card.salesAmountAvailable ? formatCurrency(card.salesAmount) : 'Veri yok'}
          </strong>
        </div>
        <div className="return-net">
          <small>İade / İptal (Net)</small>
          <strong>
            {card.returnCancellationAmountAvailable
              ? formatCurrency(card.returnCancellationAmount)
              : 'Veri yok'}
          </strong>
        </div>
      </div>
      <div className="dashboard-sales-period-details">
        <SalesPeriodValue label="Paket (Net)" value={formatNumber(card.packageCount)} />
        <SalesPeriodValue label="Kalem (Net)" value={formatNumber(card.lineCount)} />
        <SalesPeriodValue label="Ürün (Net)" value={formatNumber(card.productCount)} />
        <SalesPeriodValue label="Paket Ort." value={formatNumber(card.packageAverage)} tone="blue" />
        <SalesPeriodValue label="İade Paket" value={formatNumber(card.returnPackageCount)} tone="red" />
        <SalesPeriodValue label="İptal Paket" value={formatNumber(card.cancelPackageCount)} tone="red" />
      </div>
    </article>
  )
}

function SalesPeriodValue({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'blue' | 'red'
}) {
  return (
    <div className={`tone-${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  )
}

function salesTrend(comparison: DashboardComparison) {
  const icon =
    comparison.direction === 'up' ? (
      <ArrowUpRight size={13} />
    ) : comparison.direction === 'down' ? (
      <ArrowDownRight size={13} />
    ) : (
      <Minus size={13} />
    )
  const label = !comparison.comparable
    ? 'Yeni'
    : `${comparison.percentageChange >= 0 ? '+' : ''}${comparison.percentageChange.toLocaleString('tr-TR', {
        maximumFractionDigits: 1,
      })}%`
  return { icon, label }
}

function DashboardCardHeader({
  title,
  helper,
  icon,
  action,
}: {
  title: string
  helper?: string
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="dashboard-card-header-new">
      <div>
        <h2>{title}</h2>
        {helper ? <small>{helper}</small> : null}
      </div>
      {action || icon}
    </div>
  )
}

function SalesLineChart({
  current,
  comparison,
}: {
  current: DashboardTimeBucket[]
  comparison: DashboardTimeBucket[]
}) {
  const width = 700
  const height = 230
  const left = 54
  const right = 18
  const top = 18
  const bottom = 36
  const values = [...current, ...comparison].map((bucket) => bucket.amount)
  const max = Math.max(1, ...values)
  const xFor = (index: number, length: number) =>
    left + (index / Math.max(1, length - 1)) * (width - left - right)
  const yFor = (value: number) => top + (1 - value / max) * (height - top - bottom)
  const currentPoints = current.map((bucket, index) => `${xFor(index, current.length)},${yFor(bucket.amount)}`).join(' ')
  const comparisonPoints = comparison.map((bucket, index) => `${xFor(index, comparison.length)},${yFor(bucket.amount)}`).join(' ')
  const tickEvery = Math.max(1, Math.ceil(current.length / 8))

  return (
    <div className="dashboard-sales-chart" data-testid="dashboard-sales-chart">
      <div className="dashboard-chart-legend">
        <span><i className="current" />Seçili dönem</span>
        <span><i className="comparison" />Karşılaştırma</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Satış tutarı zaman grafiği">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = top + ratio * (height - top - bottom)
          return (
            <g key={ratio}>
              <line x1={left} y1={y} x2={width - right} y2={y} className="grid-line" />
              <text x={left - 8} y={y + 4} textAnchor="end">{compactCurrency(max * (1 - ratio))}</text>
            </g>
          )
        })}
        <polyline points={comparisonPoints} className="comparison-line" />
        <polyline points={currentPoints} className="current-line" />
        {current.map((bucket, index) => (
          <g key={bucket.key}>
            <circle cx={xFor(index, current.length)} cy={yFor(bucket.amount)} r="3" className="current-point">
              <title>{`${bucket.label}: ${formatCurrency(bucket.amount)} · ${bucket.orderCount} sipariş`}</title>
            </circle>
            {index % tickEvery === 0 || index === current.length - 1 ? (
              <text x={xFor(index, current.length)} y={height - 12} textAnchor="middle">{bucket.label}</text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  )
}

function DistributionBars({
  rows,
  emptyText,
  onSelect,
}: {
  rows: DashboardDistributionRow[]
  emptyText: string
  onSelect: (row: DashboardDistributionRow) => void
}) {
  const visibleRows = rows.slice(0, 7)
  if (visibleRows.length === 0) return <div className="dashboard-empty-card">{emptyText}</div>
  return (
    <div className="dashboard-distribution-bars">
      <div className="dashboard-distribution-head">
        <span>Şehir</span><span>Sipariş</span><span>Ciro</span><span>Pay</span>
      </div>
      {visibleRows.map((row) => (
        <button type="button" key={row.key} onClick={() => onSelect(row)}>
          <span className="dashboard-distribution-label">
            <strong>{row.label}</strong>
            <i style={{ width: `${Math.max(3, row.share)}%` }} />
          </span>
          <span>{row.orderCount}</span>
          <span>{formatCurrency(row.amount)}</span>
          <span>%{row.share.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</span>
        </button>
      ))}
    </div>
  )
}

function MarketplaceDonut({
  rows,
  onSelect,
}: {
  rows: DashboardDistributionRow[]
  onSelect: (row: DashboardDistributionRow) => void
}) {
  if (rows.length === 0) {
    return <div className="dashboard-empty-card">Bu dönem için pazaryeri satışı bulunamadı.</div>
  }
  const segments = rows.map((row, index) => {
    const start = rows
      .slice(0, index)
      .reduce((sum, item) => sum + item.share, 0)
    const end = start + row.share
    return `${marketplaceColors[index % marketplaceColors.length]} ${start}% ${end}%`
  })
  return (
    <div className="dashboard-marketplace-donut-wrap">
      <div className="dashboard-marketplace-donut" style={{ background: `conic-gradient(${segments.join(', ')})` }}>
        <span><strong>{rows.reduce((sum, row) => sum + row.orderCount, 0)}</strong><small>Sipariş</small></span>
      </div>
      <div className="dashboard-marketplace-legend">
        {rows.map((row, index) => (
          <button type="button" key={row.key} onClick={() => onSelect(row)}>
            <i style={{ background: marketplaceColors[index % marketplaceColors.length] }} />
            <span><strong>{row.label}</strong><small>{row.orderCount} sipariş · {formatCurrency(row.amount)}</small></span>
            <b>%{row.share.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</b>
          </button>
        ))}
      </div>
    </div>
  )
}

function navigationFiltersForPeriod(period: DashboardDateRange): OrdersNavigationFilters {
  if (['today', 'yesterday', 'last7', 'last30'].includes(period.key)) {
    return { datePreset: period.key as OrdersNavigationFilters['datePreset'] }
  }
  return {
    datePreset: 'custom',
    customStartDate: formatInputDate(period.start),
    customEndDate: formatInputDate(period.end),
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function compactCurrency(value: number): string {
  return new Intl.NumberFormat('tr-TR', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value)
}

function formatInputDate(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
