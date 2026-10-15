import { useEffect, useId, useRef } from 'react'
import { ArrowRight, X } from 'lucide-react'
import type { DashboardPickingProduct } from '../dashboard/dashboardViewModel'
import { Badge } from '../ui/primitives'
import { ProductImageThumb } from './ProductImageThumb'

/** Inspection of the existing picking projection only; no extra reads or operational action. */
export function PickingProductDetail({ product, onClose, onOpenOrder }: {
  product: DashboardPickingProduct
  onClose: () => void
  onOpenOrder: (orderId: string) => void
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const close = dialog?.querySelector<HTMLButtonElement>('button')
    close?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'Tab' && dialog) {
        const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [onClose])

  return (
    <div className="picking-detail-overlay" onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="ui-card picking-detail-dialog">
        <header className="picking-detail-header">
          <h2 id={titleId}>Ürün detayları</h2>
          <button type="button" className="ui-btn ui-btn-ghost" aria-label="Ürün detaylarını kapat" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="picking-detail-main">
          <div>
            <ProductImageThumb candidates={product.imageCandidates} alt={product.productName} className="picking-detail-image" placeholderClassName="picking-detail-image order-image-placeholder" />
            <p className="picking-state-note">Mevcut kayıtlı görsel gösterilir; çözünürlüğü kaynağa bağlıdır.</p>
          </div>
          <div className="picking-detail-facts">
            <h3>{product.productName}</h3>
            <dl>
              <div><dt>Renk</dt><dd>{product.color || '—'}</dd></div>
              <div><dt>Kalan adet</dt><dd>{product.quantity}</dd></div>
              <div><dt>İlgili sipariş</dt><dd>{product.orderCount}</dd></div>
              <div><dt>SKU</dt><dd>{product.sku || '—'}</dd></div>
              <div><dt>Barkod</dt><dd>{product.barcode || '—'}</dd></div>
            </dl>
            <div className="picking-stages" aria-label="Aşama dağılımı">
              {product.stageBreakdown.map((entry) => <Badge key={entry.stage}>{entry.label}: {entry.count}</Badge>)}
            </div>
          </div>
        </div>
        <h3>Varyantlar / bedenler</h3>
        <dl className="picking-variant-details">
          {product.variants.map((variant) => <div key={variant.sizeKey}>
            <dt>{variant.size} · {variant.quantity} adet</dt>
            <dd>SKU: {variant.skus?.join(', ') || '—'}<br />Barkod: {variant.barcodes?.join(', ') || '—'}</dd>
          </div>)}
        </dl>
        <h3>İlgili siparişler</h3>
        <div className="picking-detail-orders">
          {product.orders.map((order) => <button key={order.orderId} type="button" className="picking-order-link" onClick={() => { onClose(); onOpenOrder(order.orderId) }}>
            <span><b>{order.displayOrderNumber}</b><small>{order.size} · {order.quantity} adet</small></span>
            <span>{order.operationStatusLabel}</span><ArrowRight size={15} aria-hidden="true" />
          </button>)}
        </div>
      </div>
    </div>
  )
}
