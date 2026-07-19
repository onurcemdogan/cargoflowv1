import type { CargoOrder } from '../types/cargoflow'
import { formatDisplayDate } from './formatters'
import { verifySuratShipment } from './suratVerification'
import {
  isPreassignedAwaitingAcceptance,
  resolveSuratPrintEligibility,
} from './suratPrintEligibility'
import { resolveOrderStatus } from './shipmentStatus'

// Salt-okunur zaman çizelgesi modeli: yalnız mevcut order/shipment verisinden
// üretilir. API çağrısı, create veya Serendip doğrulaması TETİKLEMEZ.
export type SuratTimelineStepStatus =
  | 'completed'
  | 'active'
  | 'pending'
  | 'error'

export interface SuratTimelineStep {
  key:
    | 'orderReceived'
    | 'labelCreated'
    | 'awaitingAcceptance'
    | 'trackingActive'
    | 'delivered'
  label: string
  status: SuratTimelineStepStatus
  timestamp?: string
  description: string
}

export function buildSuratShipmentTimeline(
  order: CargoOrder,
): SuratTimelineStep[] {
  const shipment = order.shipment
  const verification = verifySuratShipment(order)
  const eligibility = resolveSuratPrintEligibility(order)
  const resolved = resolveOrderStatus(order)

  const delivered = Boolean(
    resolved.delivered ||
      order.marketplaceStatus === 'Delivered' ||
      shipment?.deliveredAt,
  )
  const trackingActive = Boolean(
    delivered ||
      verification.verifiedShipment ||
      shipment?.verifiedShipment ||
      order.operationStatus === 'HANDED_TO_CARGO' ||
      ['TRACKING_ACTIVE', 'VERIFIED'].includes(
        String(shipment?.lifecycleStatus ?? ''),
      ),
  )
  // Safe replay: SURAT_CREATE_IDEMPOTENCY_BLOCKED + carrierCreateCalled=false
  // + LABEL_READY_AWAITING_ACCEPTANCE + canonical kodlar → HATA DEĞİLDİR.
  const awaitingAcceptance = Boolean(
    !trackingActive &&
      (isPreassignedAwaitingAcceptance(shipment) ||
        eligibility.awaitingAcceptance),
  )
  const labelCreated = Boolean(
    trackingActive || awaitingAcceptance || eligibility.canPrint,
  )
  const realCreateError = Boolean(
    !labelCreated &&
      (order.operationStatus === 'ERROR' ||
        order.status === 'Hata' ||
        order.errorMessage ||
        shipment?.labelStatus === 'BLOCKED'),
  )

  const cleanDate = (value: string): string =>
    value && value !== '-' ? value : ''
  const orderTimestamp = cleanDate(
    formatDisplayDate(order.orderDate || order.createdAt),
  )
  const labelTimestamp = shipment
    ? cleanDate(
        formatDisplayDate(
          readTimestamp(shipment.suratCreateLog) ?? readTimestamp(shipment),
        ),
      )
    : ''
  const deliveredTimestamp = shipment?.deliveredAt
    ? cleanDate(formatDisplayDate(shipment.deliveredAt))
    : ''

  return [
    {
      key: 'orderReceived',
      label: 'Sipariş Alındı',
      status: 'completed',
      timestamp: orderTimestamp || undefined,
      description: 'Sipariş sistemde oluşturuldu.',
    },
    {
      key: 'labelCreated',
      label: 'Etiket Oluşturuldu',
      status: labelCreated
        ? 'completed'
        : realCreateError
          ? 'error'
          : shipment
            ? 'active'
            : 'pending',
      timestamp: labelCreated ? labelTimestamp || undefined : undefined,
      description: labelCreated
        ? 'T.No ve barkod üretildi.'
        : realCreateError
          ? order.errorMessage ||
            'Sürat create hatası; kayıt incelenmeli.'
          : 'Sürat gönderisi henüz oluşturulmadı.',
    },
    {
      key: 'awaitingAcceptance',
      label: 'Fiziksel Kabul Bekleniyor',
      status: trackingActive
        ? 'completed'
        : awaitingAcceptance
          ? 'active'
          : 'pending',
      description: trackingActive
        ? 'Fiziksel Sürat kabulü tamamlandı.'
        : 'Etiket hazır — fiziksel Sürat kabulü bekleniyor.',
    },
    {
      key: 'trackingActive',
      label: 'Kargoya Verildi / Takip Aktif',
      status: delivered
        ? 'completed'
        : trackingActive
          ? 'active'
          : 'pending',
      description: trackingActive
        ? 'Sürat takip kaydı doğrulandı.'
        : 'Henüz aktif takip yok.',
    },
    {
      key: 'delivered',
      label: 'Teslim Edildi',
      status: delivered ? 'completed' : 'pending',
      timestamp: delivered ? deliveredTimestamp || undefined : undefined,
      description: delivered
        ? 'Gönderi teslim edildi.'
        : 'Teslim kaydı yok.',
    },
  ]
}

function readTimestamp(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['completedAt', 'timestamp', 'createdAt', 'startedAt']) {
    const found = record[key]
    if (typeof found === 'string' && found.trim()) return found
  }
  return undefined
}
