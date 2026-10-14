import { ArrowRight } from 'lucide-react'
import type {
  DashboardMetric,
  DashboardViewModel,
} from '../dashboard/dashboardViewModel'
import { Card, EmptyState } from '../ui/primitives'

const money = (value: number) =>
  value.toLocaleString('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    maximumFractionDigits: 2,
  })

/** Home's compact sales view. Operational counts live in the upper summary only. */
export function HomeStatistics({
  model,
  hidden,
  onReports,
}: {
  model: DashboardViewModel
  hidden: boolean
  onReports: () => void
}) {
  const sales = model.salesSummary
  const metrics: Array<{
    label: string
    metric: DashboardMetric
    detail: string
  }> = [
    {
      label: 'Net satış',
      metric: sales.salesAmount,
      detail: 'İade ve iptal sonrası',
    },
    {
      label: 'Ortalama sipariş',
      metric: sales.averageOrderAmount,
      detail: 'Net satış / satış adedi',
    },
    {
      label: 'İade tutarı',
      metric: {
        ...sales.returnAmount,
        available:
          sales.returnAmount.available &&
          sales.refundDataSource !== 'unavailable',
      },
      detail:
        sales.refundDataSource === 'persisted_claims'
          ? 'Kabul edilmiş iadeler'
          : sales.refundDataSource === 'unavailable'
            ? 'İade verisi yok'
            : 'İade statüsündeki siparişler',
    },
    {
      label: 'İptal tutarı',
      metric: sales.cancelAmount,
      detail: 'İptal statüsündeki siparişler',
    },
  ]
  const buckets = model.salesChart.current
  const channelSales = model.marketplaceDistribution.reduce(
    (sum, channel) => sum + channel.orderCount,
    0,
  )
  const max = Math.max(1, ...buckets.map((bucket) => bucket.amount))
  const points = buckets
    .map(
      (bucket, index) =>
        `${(index / Math.max(1, buckets.length - 1)) * 500},${70 - (bucket.amount / max) * 62}`,
    )
    .join(' ')
  return (
    <section className="home-statistics" aria-label="Satış özeti">
      <div className="home-statistics-heading">
        <div>
          <h2>Satışa kısa bakış</h2>
          <p>Bugün · UTC rapor günü · sipariş tarihine göre</p>
        </div>
        <button type="button" className="text-button" onClick={onReports}>
          Ayrıntılı raporlar <ArrowRight size={14} />
        </button>
      </div>
      <div className="home-sales-metrics">
        {metrics.map(({ label, metric, detail }) => (
          <Card key={label} className="home-sales-metric">
            <span>{label}</span>
            <strong>
              {hidden || !metric.available ? '—' : money(metric.value)}
            </strong>
            <small>{detail}</small>
          </Card>
        ))}
      </div>
      <div className="home-sales-detail">
        <Card
          title="Gün içi satış"
          subtitle="Satış siparişlerinin saatlik tutarı · Türkiye saati"
          labelledBy="home-trend-title"
          className="home-sales-trend"
        >
          {hidden ? (
            <EmptyState
              compact
              title="Satış özeti bekleniyor"
              body="Veriler sunucu özetinden okunur."
            />
          ) : !sales.salesAmount.available ? (
            <EmptyState
              compact
              title="Satış tutarı eksik"
              body="Tutarı bilinmeyen siparişler var; grafik gösterilemiyor."
            />
          ) : buckets.some((bucket) => bucket.orderCount > 0) ? (
            <>
              <svg
                className="home-sparkline"
                viewBox="0 0 500 80"
                role="img"
                aria-label={`Bugünün saatlik satış tutarı; sipariş tarihine göre`}
              >
                <line x1="0" y1="74" x2="500" y2="74" />
                <polyline points={points} />
              </svg>
              <div className="home-trend-axis">
                <span>{buckets[0]?.label}</span>
                <span>{buckets.at(-1)?.label}</span>
              </div>
            </>
          ) : (
            <EmptyState
              compact
              title="Bugün satış yok"
              body="Satış geldikçe saatlik dağılım burada görünür."
            />
          )}
        </Card>
        <Card
          title="Satış kanalları"
          subtitle="Bugünkü satış adetlerinin dağılımı"
          labelledBy="home-channels-title"
        >
          {hidden ? (
            <EmptyState compact title="Kanal özeti bekleniyor" />
          ) : model.marketplaceDistribution.length ? (
            <ul className="home-channel-list">
              {model.marketplaceDistribution.map((channel) => (
                <li key={channel.key}>
                  <span>{channel.label}</span>
                  <b>{channel.orderCount.toLocaleString('tr-TR')} satış</b>
                  <span className="home-channel-track" aria-hidden="true">
                    <i
                      style={{
                        width: `${Math.max(0, Math.min(100, channelSales > 0 ? (channel.orderCount / channelSales) * 100 : 0))}%`,
                      }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              compact
              title="Kanal satışı yok"
              body="Bu rapor gününde satış kaydı bulunamadı."
            />
          )}
        </Card>
      </div>
    </section>
  )
}
