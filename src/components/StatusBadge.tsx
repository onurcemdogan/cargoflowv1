import type { AuditLevel, OrderStatus } from '../types/cargoflow'
import type { StatusTone } from '../utils/statusPresentation'

interface StatusBadgeProps {
  status: OrderStatus | AuditLevel | string
  tone?: StatusTone
  title?: string
}

export function StatusBadge({ status, tone, title }: StatusBadgeProps) {
  const className = `status-badge ${tone ? toneClass(tone) : statusClass(status)}`
  return (
    <span className={className} title={title}>
      {status}
    </span>
  )
}

function toneClass(tone: StatusTone): string {
  if (tone === 'blue') return 'info'
  if (tone === 'yellow') return 'warning'
  if (tone === 'teal') return 'label'
  if (tone === 'green') return 'success'
  if (tone === 'red') return 'error'
  return 'neutral'
}

function statusClass(status: string): string {
  switch (status) {
    case 'Yeni':
    case 'Created':
    case 'info':
      return 'info'
    case 'Picking':
    case 'Ön Kayıt Yapıldı':
    case 'Kargo Oluşturuldu':
    case 'warning':
      return 'warning'
    case 'Invoiced':
    case 'Etiket Hazır':
    case 'Etiket Oluşturuldu':
      return 'label'
    case 'Etiket Basıldı':
    case 'success':
    case 'Delivered':
      return 'success'
    case 'Shipped':
      return 'neutral'
    case 'Hata':
    case 'Cancelled':
    case 'Returned':
    case 'UnDelivered':
    case 'UnSupplied':
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
}
