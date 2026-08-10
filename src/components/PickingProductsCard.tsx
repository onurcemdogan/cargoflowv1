import { Fragment } from 'react'
import { ProductImageThumb } from './ProductImageThumb'
import type { DashboardViewModel } from '../dashboard/dashboardViewModel'

// TOPLANACAK ÜRÜNLER — SALT SUNUM.
//
// Bu bileşen HİÇBİR iş kuralı içermez: uygunluk (isPickingEligible), ürün
// ailesi anahtarı, beden kırılımı ve aşama özeti view-model'de HESAPLANMIŞ
// olarak gelir. Burada yeniden gruplama/filtreleme YAPILMAZ — hazır
// `pickingLists` yapısı olduğu gibi tüketilir (yeni O(N²) tarama yok).

interface PickingProductsCardProps {
  picking: DashboardViewModel['pickingLists']
  expandedKey?: string
  onToggleExpand: (key: string) => void
}

export function PickingProductsCard({
  picking,
  expandedKey,
  onToggleExpand,
}: PickingProductsCardProps) {
  return (
    <article
      className="dashboard-analytics-card dashboard-picking-card"
      data-testid="picking-card"
    >
      <div className="dashboard-card-header-new">
        <div>
          <h2>{picking.title}</h2>
          <small data-testid="picking-summary">
            {picking.orderCount} sipariş · {picking.totalQuantity} adet ·{' '}
            {picking.totalFamilyCount} ürün ailesi
          </small>
        </div>
      </div>

      <div className="dashboard-picking-list">
        {picking.products.map((product) => {
          const expanded = expandedKey === product.key
          return (
            <Fragment key={product.key}>
              <div className="picking-row" data-testid="picking-row">
                <ProductImageThumb
                  candidates={product.imageCandidates}
                  alt={product.productName}
                  className="picking-row-image"
                  placeholderClassName="picking-row-image-placeholder"
                />

                <div className="picking-row-identity">
                  <strong>{product.productName}</strong>
                  {product.color ? <small>{product.color}</small> : null}
                </div>

                <div className="picking-row-totals">
                  <b>{product.quantity} adet</b>
                  <small>{product.orderCount} sipariş</small>
                </div>

                <div className="picking-row-sizes">
                  {product.variants.map((variant) => (
                    <span key={variant.sizeKey} className="picking-size-chip">
                      <b>{variant.size}</b>
                      <i>{variant.quantity} adet</i>
                    </span>
                  ))}
                </div>

                <div className="picking-row-stages">
                  {product.stageBreakdown.map((entry) => (
                    <span key={entry.stage}>
                      {entry.label}: <b>{entry.count}</b>
                    </span>
                  ))}
                </div>

                <button
                  type="button"
                  className="dashboard-card-link picking-row-action"
                  onClick={() => onToggleExpand(product.key)}
                >
                  {expanded ? 'Gizle' : 'Siparişleri Gör'}
                </button>
              </div>

              {expanded ? (
                <div className="picking-row-orders dashboard-table-wrap">
                  <table className="dashboard-compact-table">
                    <thead>
                      <tr>
                        <th>Sipariş No</th>
                        <th>Müşteri</th>
                        <th>Beden</th>
                        <th>Adet</th>
                        <th>Tarih</th>
                        <th>Durum</th>
                        <th>Kargo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {product.orders.map((entry) => (
                        <tr key={entry.orderId}>
                          <td>
                            <strong>{entry.displayOrderNumber}</strong>
                          </td>
                          <td>{entry.customerName || '—'}</td>
                          <td>{entry.size}</td>
                          <td>{entry.quantity}</td>
                          <td>{formatOrderDate(entry.orderDate)}</td>
                          <td>{entry.operationStatusLabel}</td>
                          <td>{entry.carrier || 'Bekliyor'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </Fragment>
          )
        })}

        {picking.hiddenFamilyCount > 0 ? (
          // SESSİZ KIRPMA YOK: kullanıcı verinin devam ettiğini açıkça görür.
          <div className="picking-more-notice" data-testid="picking-more">
            Bu kartta {picking.products.length} ürün ailesi gösteriliyor.{' '}
            <strong>+{picking.hiddenFamilyCount} ürün ailesi daha</strong>{' '}
            bekliyor (toplam {picking.totalFamilyCount}). Tam liste için
            Siparişler ekranını kullanın.
          </div>
        ) : null}

        {picking.products.length === 0 ? (
          <div className="dashboard-empty-compact">
            Baskıya gönderilmeyi bekleyen ürün bulunamadı.
          </div>
        ) : null}
      </div>
    </article>
  )
}

function formatOrderDate(value?: string): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleDateString('tr-TR')
}
