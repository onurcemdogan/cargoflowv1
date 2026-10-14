import { ArrowRight, ListChecks } from 'lucide-react'

export function PickingSummary({
  quantity,
  orderCount,
  onOpen,
}: {
  quantity?: number
  orderCount?: number
  onOpen: () => void
}) {
  return (
    <div
      className="ui-card picking-summary"
      data-testid="picking-compact-summary"
    >
      <span className="picking-summary-icon" aria-hidden="true">
        <ListChecks size={20} />
      </span>
      <div>
        <strong>
          Toplanacak{' '}
          {quantity === undefined ? '—' : quantity.toLocaleString('tr-TR')} ürün
        </strong>
        <small>
          {orderCount === undefined
            ? 'Toplama özeti bekleniyor'
            : `${orderCount.toLocaleString('tr-TR')} siparişte kalan adet · tüm tarihler`}
        </small>
      </div>
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-sm"
        onClick={onOpen}
      >
        Görüntüle <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
