import {
  AlertTriangle,
  ArrowRight,
  Barcode,
  Box,
  CheckCircle2,
  Download,
  PackageCheck,
  Plug,
  Printer,
  RefreshCcw,
  RotateCcw,
  Settings,
  ShoppingBag,
  Truck,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MetricTile } from '../components/MetricTile'
import { ProductImageThumb } from '../components/ProductImageThumb'
import {
  buildDashboardProviderHealth,
  buildDashboardSummary,
  type DashboardPeriod,
  type DashboardProviderHealth,
} from '../dashboard/dashboardSummary'
import type {
  ApiDebugLog,
  CargoOrder,
  CargoProduct,
  IntegrationConfig,
  PageKey,
  PrinterSettings,
} from '../types/cargoflow'
import { formatDisplayDate } from '../utils/formatters'
import type { QuickTab } from '../utils/ordersTabs'

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
  onNavigateOrders: (tab?: QuickTab, orderId?: string) => void
  onDownloadOrder: (orderId: string) => void
  onPrintOrder: (orderId: string) => void
}

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
}: DashboardPageProps) {
  const autoRefreshAttempted = useRef(false)
  const [selectedPeriod, setSelectedPeriod] =
    useState<DashboardPeriod>('today')
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
  const summary = useMemo(
    () =>
      buildDashboardSummary({
        orders,
        products,
        marketplaceIntegrations: providerHealth.marketplaceIntegrations,
        carrierIntegrations: providerHealth.carrierIntegrations,
        printerSettings,
        selectedPeriod,
      }),
    [orders, printerSettings, products, providerHealth, selectedPeriod],
  )
  const hasConfiguredMarketplace = summary.marketplaceHealth.some(
    (provider) => provider.status !== 'not_configured',
  )

  useEffect(() => {
    if (autoRefreshAttempted.current || loading || !hasConfiguredMarketplace) {
      return
    }
    autoRefreshAttempted.current = true
    onRefresh()
  }, [hasConfiguredMarketplace, loading, onRefresh])

  return (
    <div className="dashboard-page dashboard-v2">
      <section className="dashboard-topbar">
        <div>
          <span className="dashboard-kicker">
            <span className={loading ? 'pulse-dot loading' : 'pulse-dot'} />
            Operasyon ve dönem özeti
          </span>
          <h1>Bugünkü Kargo Operasyonu</h1>
          <p>
            Açık operasyon yükünü ve seçili dönemdeki sipariş hareketlerini
            birlikte takip edin.
          </p>
          <div className="dashboard-secondary-stats">
            <span>
              Bugün gelen <strong>{summary.todayOrders}</strong>
            </span>
            <span>
              Bu ay alınan <strong>{summary.monthlyOrders}</strong>
            </span>
            <span>
              Açık operasyon <strong>{summary.openOperations}</strong>
            </span>
          </div>
        </div>
        <div className="dashboard-topbar-actions">
          <div className="dashboard-period-filter" aria-label="Dashboard dönemi">
            {dashboardPeriods.map((period) => (
              <button
                key={period.key}
                type="button"
                className={selectedPeriod === period.key ? 'active' : ''}
                onClick={() => setSelectedPeriod(period.key)}
              >
                {period.label}
              </button>
            ))}
          </div>
          <span>
            {lastSyncedAt || summary.lastSyncAt
              ? `Son senkronizasyon ${formatDisplayDate(
                  lastSyncedAt || summary.lastSyncAt || '',
                )}`
              : 'Henüz senkronizasyon yapılmadı'}
          </span>
          <div>
            <button
              type="button"
              className="primary-button"
              onClick={onRefresh}
              disabled={loading || !hasConfiguredMarketplace}
            >
              <RefreshCcw className={loading ? 'spin-icon' : ''} size={17} />
              {loading ? 'Yenileniyor' : 'Verileri yenile'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onNavigateOrders('all')}
            >
              Siparişlere git <ArrowRight size={17} />
            </button>
          </div>
        </div>
      </section>

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
          <WifiOff size={20} />
          <div>
            <strong>Henüz pazaryeri bağlantısı kurulmadı</strong>
            <span>
              Entegrasyon ayarlarından bir pazaryeri bağlayıp siparişleri
              yenileyin.
            </span>
          </div>
          <button type="button" onClick={() => onNavigatePage('integrations')}>
            Ayarlara git
          </button>
        </section>
      ) : null}

      <section className="metrics-grid dashboard-metrics-grid dashboard-kpis">
        <MetricTile
          label="Açık Operasyon"
          value={summary.openOperations}
          helper="Tamamlanmamış aktif işler"
          icon={<ShoppingBag size={20} />}
          tone="blue"
          onClick={() => onNavigateOrders('open')}
        />
        <MetricTile
          label="Barkod Bekleyen"
          value={summary.barcodeWaiting}
          helper="Kargo barkodu oluşturulacak"
          icon={<Barcode size={20} />}
          tone="amber"
          onClick={() => onNavigateOrders('barcodePending')}
        />
        <MetricTile
          label="Etiket Hazır"
          value={summary.labelReady}
          helper="Yazdırmaya hazır"
          icon={<PackageCheck size={20} />}
          tone="teal"
          onClick={() => onNavigateOrders('labelReady')}
        />
        <MetricTile
          label="Etiket Basıldı"
          value={summary.labelPrinted}
          helper={`${periodLabel(selectedPeriod)} başarıyla basılan`}
          icon={<Printer size={20} />}
          tone="violet"
          onClick={() => onNavigateOrders('labelPrinted')}
        />
        <MetricTile
          label="Hatalı / Aksiyon Gerekli"
          value={summary.errors}
          helper="Kontrol gereken işlem"
          icon={<AlertTriangle size={20} />}
          tone="red"
          onClick={() => onNavigateOrders('all')}
        />
        <MetricTile
          label="İptal / İade"
          value={summary.canceledOrReturned}
          helper={`${periodLabel(selectedPeriod)} iptal, iade veya teslim edilemeyen`}
          icon={<RotateCcw size={20} />}
          tone="red"
          onClick={() => onNavigateOrders('cancelReturn')}
        />
      </section>

      <section className="dashboard-v2-main">
        <article className="panel dashboard-flow-card">
          <DashboardHeading
            eyebrow="Operasyon Akışı"
            title="Siparişten kargoya"
            icon={<Truck size={19} />}
          />
          <div className="dashboard-flow-steps">
            {summary.flowSteps.map((step, index) => (
              <div key={step.key} className="dashboard-flow-step">
                <span>{index + 1}</span>
                <div>
                  <strong>{step.count}</strong>
                  <small>{step.label}</small>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel dashboard-system-card">
          <DashboardHeading
            eyebrow="Sistem Durumu"
            title="Aktif bağlantılar"
            icon={<Wifi size={19} />}
          />
          <div className="dashboard-health-list">
            {summary.marketplaceHealth.map((provider) => (
              <HealthRow key={provider.providerKey} provider={provider} />
            ))}
            {summary.carrierHealth.map((provider) => (
              <HealthRow key={provider.providerKey} provider={provider} />
            ))}
            <HealthRow
              provider={{
                providerKey: 'printer',
                providerName: summary.printerHealth.name,
                status: summary.printerHealth.status,
                errorCount: 0,
                detail: summary.printerHealth.detail,
              }}
            />
            {summary.marketplaceHealth.length === 0 &&
            summary.carrierHealth.length === 0 ? (
              <p className="empty-state">
                Henüz kargo veya pazaryeri sağlayıcısı bağlanmadı.
              </p>
            ) : null}
          </div>
        </article>
      </section>

      <section className="dashboard-v2-main">
        <article className="panel dashboard-actions-card">
          <DashboardHeading
            eyebrow="Kontrol Listesi"
            title="Aksiyon Gerektirenler"
            icon={<AlertTriangle size={19} />}
          />
          <div className="dashboard-action-list">
            {summary.actionItems.filter((item) => item.count > 0).map((item) => (
              <div key={item.key} className="dashboard-action-row">
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </div>
                <b>{item.count}</b>
                <button
                  type="button"
                  onClick={() =>
                    item.target === 'integrations'
                      ? onNavigatePage('integrations')
                      : onNavigateOrders(item.target)
                  }
                >
                  Git <ArrowRight size={14} />
                </button>
              </div>
            ))}
            {summary.actionItems.every((item) => item.count === 0) ? (
              <div className="dashboard-compact-empty">
                <CheckCircle2 size={22} />
                <div>
                  <strong>Aksiyon gerektiren işlem yok.</strong>
                  <span>Mevcut sipariş ve sağlayıcı state’leri temiz görünüyor.</span>
                </div>
              </div>
            ) : null}
          </div>
        </article>

        <article className="panel dashboard-quick-card">
          <DashboardHeading
            eyebrow="Kısayollar"
            title="Hızlı İşlemler"
            icon={<Box size={19} />}
          />
          <div className="dashboard-quick-grid">
            <QuickAction icon={<RefreshCcw />} label="Siparişleri Yenile" onClick={onRefresh} />
            <QuickAction icon={<Barcode />} label="Toplu Barkod Oluştur" onClick={() => onNavigateOrders('barcodePending')} />
            <QuickAction icon={<Printer />} label="Barkod Bas" onClick={() => onNavigateOrders('labelReady')} />
            <QuickAction icon={<Download />} label="ZPL İndir" onClick={() => onNavigateOrders('labelReady')} />
            <QuickAction icon={<Printer />} label="Yazdırma Kuyruğu" onClick={() => onNavigateOrders('labelReady')} />
            <QuickAction icon={<Plug />} label="Entegrasyon Ayarları" onClick={() => onNavigatePage('integrations')} />
            <QuickAction icon={<Settings />} label="Yazıcı Ayarları" onClick={() => onNavigatePage('printers')} />
          </div>
        </article>
      </section>

      <article className="panel dashboard-recent-table-card">
        <DashboardHeading
          eyebrow="Son Siparişler"
          title="Güncel operasyon kayıtları"
          action={
            <button type="button" className="text-button" onClick={() => onNavigateOrders('all')}>
              Tümünü gör <ArrowRight size={15} />
            </button>
          }
        />
        {summary.recentOrders.length > 0 ? (
          <div className="dashboard-table-scroll">
            <table className="dashboard-recent-table">
              <thead>
                <tr>
                  <th>Sipariş No</th>
                  <th>Pazaryeri</th>
                  <th>Müşteri / Ürün</th>
                  <th>Durum</th>
                  <th>Kargo Firması</th>
                  <th>Sürat Takip / Barkod</th>
                  <th>Aksiyonlar</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentOrders.map((order) => {
                  const zplAvailable = Boolean(order.barcodeRaw)
                  const printAvailable = Boolean(order.barcode)
                  return (
                    <tr key={order.id}>
                      <td><strong>{order.orderNumber}</strong></td>
                      <td>{order.marketplaceProviderName}</td>
                      <td>
                        <div className="dashboard-product-cell">
                          <ProductImageThumb
                            candidates={
                              order.productImageCandidates.length > 0
                                ? order.productImageCandidates
                                : order.productImageUrl
                                  ? [order.productImageUrl]
                                  : []
                            }
                            alt={order.productSummary}
                            className="dashboard-product-image"
                            placeholderClassName="dashboard-product-placeholder"
                          />
                          <div>
                            <strong>{order.customerName}</strong>
                            <span>{order.productSummary}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="dashboard-status-pill">{order.status}</span>
                        <span>Kaynak: {order.statusSource}</span>
                      </td>
                      <td>{order.carrierProviderName}</td>
                      <td>
                        <strong>Sürat takip: {order.trackingNumber || '-'}</strong>
                        <span>Sürat barkod: {order.barcode || '-'}</span>
                        {order.trendyolCargoTrackingNumber ? (
                          <span>Trendyol kodu: {order.trendyolCargoTrackingNumber}</span>
                        ) : null}
                      </td>
                      <td>
                        <div className="dashboard-order-actions">
                          <button type="button" onClick={() => onNavigateOrders('all', order.id)}>
                            Detay
                          </button>
                          <button
                            type="button"
                            disabled={!zplAvailable}
                            title={zplAvailable ? 'ZPL indir' : 'ZPL verisi yok; Chrome yazdırma kullanılabilir.'}
                            onClick={() => onDownloadOrder(order.id)}
                          >
                            ZPL
                          </button>
                          <button
                            type="button"
                            disabled={!printAvailable}
                            title={printAvailable ? 'Yazdır' : 'Önce kargo barkodu oluşturulmalı.'}
                            onClick={() => onPrintOrder(order.id)}
                          >
                            {order.labelStatus === 'PRINTED' ? 'Tekrar Yazdır' : 'Yazdır'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dashboard-empty-state">
            <ShoppingBag size={30} />
            <strong>Henüz sipariş çekilmedi.</strong>
            <span>Pazaryeri bağlantısını kurup siparişleri yenileyin.</span>
          </div>
        )}
      </article>
    </div>
  )
}

const dashboardPeriods: Array<{
  key: DashboardPeriod
  label: string
}> = [
  { key: 'today', label: 'Bugün' },
  { key: 'last7', label: 'Son 7 Gün' },
  { key: 'month', label: 'Bu Ay' },
  { key: 'all', label: 'Tümü' },
]

function periodLabel(period: DashboardPeriod): string {
  if (period === 'today') return 'Bugün'
  if (period === 'last7') return 'Son 7 günde'
  if (period === 'month') return 'Bu ay'
  return 'Tüm dönemde'
}

function DashboardHeading({
  eyebrow,
  title,
  icon,
  action,
}: {
  eyebrow: string
  title: string
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="dashboard-card-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {action || icon}
    </div>
  )
}

function HealthRow({ provider }: { provider: DashboardProviderHealth }) {
  const online = provider.status === 'connected'
  const statusText =
    provider.status === 'connected'
      ? 'Bağlı'
      : provider.status === 'error'
        ? 'Hata'
        : 'Ayarlanmadı'
  return (
    <div className="dashboard-connection-row">
      <div className={online ? 'connection-icon online' : 'connection-icon'}>
        {online ? <Wifi size={17} /> : <WifiOff size={17} />}
      </div>
      <div>
        <strong>{provider.providerName}</strong>
        <span>{provider.detail}</span>
      </div>
      <small>{statusText}</small>
    </div>
  )
}

function QuickAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

