import type {
  CargoOrder,
  CarrierStatusKey,
  OperationStatus,
} from '../types/cargoflow'

export type OrderStatusSource =
  | 'suratTracking'
  | 'marketplace'
  | 'localOperation'

export interface CarrierStatusMapping {
  key: CarrierStatusKey
  label: string
  operationStatus: OperationStatus
  delivered: boolean
  shipped: boolean
  returning: boolean
}

export interface ResolvedOrderStatus {
  label: string
  operationStatus: OperationStatus
  statusSource: OrderStatusSource
  sourceLabel: string
  delivered: boolean
  shipped: boolean
  canceledOrReturned: boolean
  carrierStatusKey?: CarrierStatusKey
  carrierStatusCode?: string
  carrierStatusLabel?: string
  deliveredDetectedFrom?: string
  shippedDetectedFrom?: string
  plannedDeliveryDateIgnoredForStatus: boolean
}

const suratStatusMap: Record<string, CarrierStatusMapping> = {
  '1': status('PREPARING', 'Gönderi Hazırlanıyor', 'SHIPMENT_CREATED'),
  '2': status('TRANSFER_CENTER', 'Transfer Merkezinde', 'SHIPPED', false, true),
  '3': status('IN_TRANSIT', 'Gönderi Yolda', 'SHIPPED', false, true),
  '4': status('DELIVERY_BRANCH', 'Teslimat Şubesinde', 'SHIPPED', false, true),
  '5': status('OUT_FOR_DELIVERY', 'Kurye Dağıtımda', 'SHIPPED', false, true),
  '6': status('DELIVERED', 'Teslim Edildi', 'DELIVERED', true, false),
  '7': status('REDIRECTING', 'Yönlendirme Sürecinde', 'SHIPPED', false, true),
  '9': status('RETURNING', 'İade Sürecinde', 'RETURNING', false, false, true),
  '11': status('COLLECTION_POINT', 'Teslimat Noktasında', 'SHIPPED', false, true),
  '13': status(
    'RETURN_DELIVERED',
    'Teslim Edildi (İade)',
    'DELIVERED_SPECIAL',
    true,
    false,
  ),
  '14': status(
    'MGT_DELIVERED',
    'Teslim Edildi (MGT)',
    'DELIVERED_SPECIAL',
    true,
    false,
  ),
}

export function mapSuratCarrierStatus(
  value?: string | number,
): CarrierStatusMapping | undefined {
  return suratStatusMap[String(value ?? '').trim()]
}

export function resolveOrderStatus(order: CargoOrder): ResolvedOrderStatus {
  const trackingLog = order.shipment?.suratTrackingLog
  const gonderilerCount = Number(
    trackingLog?.gonderilerLength ??
      (Array.isArray(trackingLog?.Gonderiler)
        ? trackingLog.Gonderiler.length
        : 0),
  )
  const mappedCarrierStatus =
    gonderilerCount > 0
      ? mapSuratCarrierStatus(
          trackingLog?.KargonunDurumuSayi ||
            order.shipment?.carrierStatusCode,
        )
      : undefined
  const marketplace = resolveMarketplaceStatus(order.marketplaceStatus)
  const plannedDeliveryDateIgnoredForStatus = hasPlannedDeliveryDate(order)

  if (
    mappedCarrierStatus &&
    (!marketplace || mappedCarrierStatus.delivered || mappedCarrierStatus.returning)
  ) {
    return {
      label: mappedCarrierStatus.label,
      operationStatus: mappedCarrierStatus.operationStatus,
      statusSource: 'suratTracking',
      sourceLabel: 'Sürat Kargo Takip',
      delivered: mappedCarrierStatus.delivered,
      shipped: mappedCarrierStatus.shipped,
      canceledOrReturned: mappedCarrierStatus.returning,
      carrierStatusKey: mappedCarrierStatus.key,
      carrierStatusCode: String(trackingLog?.KargonunDurumuSayi ?? ''),
      carrierStatusLabel: mappedCarrierStatus.label,
      deliveredDetectedFrom: mappedCarrierStatus.delivered
        ? 'suratTracking.KargonunDurumuSayi'
        : undefined,
      shippedDetectedFrom: mappedCarrierStatus.shipped
        ? 'suratTracking.KargonunDurumuSayi'
        : undefined,
      plannedDeliveryDateIgnoredForStatus,
    }
  }

  if (marketplace) {
    return {
      ...marketplace,
      statusSource: 'marketplace',
      sourceLabel: order.marketplace || 'Pazaryeri',
      plannedDeliveryDateIgnoredForStatus,
    }
  }

  return {
    label: localOperationLabel(order),
    operationStatus: normalizeLocalOperationStatus(order.operationStatus),
    statusSource: 'localOperation',
    sourceLabel: 'CargoFlow',
    delivered: false,
    shipped: false,
    canceledOrReturned: false,
    plannedDeliveryDateIgnoredForStatus,
  }
}

function resolveMarketplaceStatus(
  rawStatus: string,
): Omit<
  ResolvedOrderStatus,
  'statusSource' | 'sourceLabel' | 'plannedDeliveryDateIgnoredForStatus'
> | undefined {
  switch (rawStatus) {
    case 'Delivered':
      return {
        label: 'Teslim Edildi',
        operationStatus: 'DELIVERED',
        delivered: true,
        shipped: false,
        canceledOrReturned: false,
        deliveredDetectedFrom: 'marketplaceStatus.Delivered',
      }
    case 'Shipped':
      return {
        label: 'Kargoya Verildi',
        operationStatus: 'SHIPPED',
        delivered: false,
        shipped: true,
        canceledOrReturned: false,
        shippedDetectedFrom: 'marketplaceStatus.Shipped',
      }
    case 'AtCollectionPoint':
      return {
        label: 'Teslimat Noktasında',
        operationStatus: 'SHIPPED',
        delivered: false,
        shipped: true,
        canceledOrReturned: false,
        shippedDetectedFrom: 'marketplaceStatus.AtCollectionPoint',
      }
    case 'Cancelled':
      return {
        label: 'İptal',
        operationStatus: 'ERROR',
        delivered: false,
        shipped: false,
        canceledOrReturned: true,
      }
    case 'Returned':
      return {
        label: 'İade',
        operationStatus: 'RETURNING',
        delivered: false,
        shipped: false,
        canceledOrReturned: true,
      }
    case 'UnDelivered':
      return {
        label: 'Teslim Edilemedi',
        operationStatus: 'ERROR',
        delivered: false,
        shipped: false,
        canceledOrReturned: true,
      }
    case 'UnSupplied':
      return {
        label: 'Tedarik Edilemedi',
        operationStatus: 'ERROR',
        delivered: false,
        shipped: false,
        canceledOrReturned: true,
      }
    default:
      return undefined
  }
}

function localOperationLabel(order: CargoOrder): string {
  if (order.status === 'Hata' || order.operationStatus === 'ERROR') {
    return 'Hatalı'
  }
  if (order.labelStatus === 'PRINTED' && order.label?.printedAt) {
    return 'Etiket Basıldı'
  }
  if (
    order.labelStatus === 'READY' ||
    order.operationStatus === 'LABEL_READY'
  ) {
    return 'Etiket Hazır'
  }
  if (order.shipment) return 'Sürat Doğrulama Bekliyor'
  return 'Barkod Bekliyor'
}

function normalizeLocalOperationStatus(
  value: OperationStatus,
): OperationStatus {
  if (
    ['DELIVERED', 'DELIVERED_SPECIAL', 'SHIPPED', 'HANDED_TO_CARGO'].includes(
      value,
    )
  ) {
    return 'NEW'
  }
  return value || 'NEW'
}

function hasPlannedDeliveryDate(order: CargoOrder): boolean {
  const record = order as CargoOrder & Record<string, unknown>
  return [
    order.deliveryDate,
    record.estimatedDeliveryDate,
    record.agreedDeliveryDate,
    record.plannedDeliveryDate,
    record.deliveryDueDate,
    record.shipmentDueDate,
  ].some((value) => Boolean(String(value ?? '').trim()))
}

function status(
  key: CarrierStatusKey,
  label: string,
  operationStatus: OperationStatus,
  delivered = false,
  shipped = false,
  returning = false,
): CarrierStatusMapping {
  return { key, label, operationStatus, delivered, shipped, returning }
}
