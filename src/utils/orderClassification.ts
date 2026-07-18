import type { CargoOrder } from '../types/cargoflow'
import type { QuickTab } from './ordersTabs'
import { hasCarrierTracking } from './orderStatus'
import { resolveOrderStatus } from './shipmentStatus'
import {
  isPreassignedAwaitingAcceptance,
  resolveSuratPrintEligibility,
} from './suratPrintEligibility'
import { verifySuratShipment } from './suratVerification'

export interface OrderTabClassification {
  isOpenOperation: boolean
  isBarcodeWaiting: boolean
  isShipmentCreateRequired: boolean
  isSuratVerificationWaiting: boolean
  isLabelReady: boolean
  isLabelPrinted: boolean
  isReadyForCargo: boolean
  isHandedToCargo: boolean
  isDelivered: boolean
  isCanceledOrReturned: boolean
  isArchived: boolean
  hasError: boolean
  operationStatusLabel: string
}

export interface VisibleOrdersDateFilter {
  preset: string
  startTime?: number
  endTime?: number
}

export interface BuildVisibleOrdersInput {
  persistentOrders: CargoOrder[]
  selectedTab: QuickTab
  marketplaceFilter: string
  operationStatusFilter: string
  cargoFilter: string
  dateFilter: VisibleOrdersDateFilter
  searchQuery: string
}

export interface VisibleOrdersDebug {
  initialCount: number
  latestSyncAt?: string
  latestSyncCount: number
  afterTabFilter: number
  afterMarketplaceFilter: number
  afterOperationStatusFilter: number
  afterCargoFilter: number
  afterDateFilter: number
  afterSearch: number
}

export interface VisibleOrdersResult {
  visibleOrders: CargoOrder[]
  debug: VisibleOrdersDebug
}

export function classifyOrderForTabs(
  order: CargoOrder,
): OrderTabClassification {
  const record = order as CargoOrder & Record<string, unknown>
  const shipment = order.shipment as
    | (NonNullable<CargoOrder['shipment']> & Record<string, unknown>)
    | undefined
  const verification = verifySuratShipment(order)
  const operationStatus = normalizedToken(order.operationStatus)
  const marketplaceStatus = String(order.marketplaceStatus ?? '').trim()
  const marketplaceDelivered = marketplaceStatus === 'Delivered'
  const marketplaceHandedToCargo = ['Shipped', 'AtCollectionPoint'].includes(
    marketplaceStatus,
  )
  const marketplaceCanceledOrReturned = [
    'Cancelled',
    'Returned',
    'UnDelivered',
    'UnSupplied',
  ].includes(marketplaceStatus)
  const resolvedStatus = resolveOrderStatus(order)
  const isCanceledOrReturned = Boolean(
    resolvedStatus.canceledOrReturned || marketplaceCanceledOrReturned,
  )
  const isDelivered = Boolean(resolvedStatus.delivered || marketplaceDelivered)
  const isHandedToCargo = Boolean(
    resolvedStatus.shipped || marketplaceHandedToCargo,
  )
  const isArchived = Boolean(
    readBoolean(record, 'archived') ||
      readBoolean(record, 'isArchived') ||
      readString(record, 'archivedAt'),
  )
  const explicitlyClosed = Boolean(
    readBoolean(record, 'closed') ||
      readBoolean(record, 'completed') ||
      readString(record, 'closedAt') ||
      readString(record, 'completedAt'),
  )
  const labelStatus = normalizedToken(order.labelStatus)
  const isLabelPrinted = Boolean(
    (shipment?.dispatchRegistrationConfirmed === true ||
      isPreassignedAwaitingAcceptance(order.shipment)) &&
      labelStatus === 'printed' &&
      order.label?.printedAt,
  )
  const dispatchRegistrationConfirmed =
    shipment?.dispatchRegistrationConfirmed === true
  const verifiedShipment = Boolean(
    dispatchRegistrationConfirmed && verification.verifiedShipment,
  )
  // LABEL_READY_AWAITING_ACCEPTANCE: ön-atanmış kodlarla etiket hazır;
  // fiziksel tesellüm bekleniyor. Barkod Bekleyen DEĞİLDİR, Etiket Hazır
  // grubundadır, Kargoya Verilen değildir (bölüm 5 lifecycle sözleşmesi).
  const preassignedReady = Boolean(
    isPreassignedAwaitingAcceptance(order.shipment) &&
      resolveSuratPrintEligibility(order).canPrint,
  )
  const printableShipment = verifiedShipment || preassignedReady
  const barcodeRaw = String(
    verification.barcodeRaw || shipment?.barcodeRaw || '',
  ).trim()
  const printableBarcode = String(
    verification.barcode ||
      verification.finalSuratBarcode ||
      shipment?.barcode ||
      shipment?.barcodeValue ||
      '',
  ).trim()
  const printError = firstString(
    readString(order.label?.printDebug, 'printError'),
    readString(record, 'printError'),
  )
  const wrongServiceCalled = Boolean(
    readBoolean(shipment, 'wrongServiceCalled') ||
      findNestedBoolean(shipment, 'wrongServiceCalled'),
  )
  const providerResponseError = firstString(
    findNestedString(shipment, 'errorMessage'),
    findNestedBoolean(shipment, 'isError') ? 'provider-error' : '',
  )
  const noTrackingReason = firstString(
    order.noTrackingReason,
    shipment?.noTrackingReason,
  )
  const hasError = Boolean(
    !isCanceledOrReturned &&
      (operationStatus === 'error' ||
        operationStatus.includes('dispatchrejected') ||
        operationStatus.includes('barcodefailed') ||
        printError ||
        (verifiedShipment && !printableBarcode) ||
        wrongServiceCalled ||
        // Ön-atanmış hazır etiketin "fiziksel kabul bekleniyor" bilgi metni
        // hata değildir; sayaçlara hata olarak sızmaz.
        (!preassignedReady && noTrackingReason) ||
        (!preassignedReady && providerResponseError)),
  )
  const processClosed = Boolean(
    isCanceledOrReturned ||
      isDelivered ||
      isArchived ||
      isHandedToCargo ||
      explicitlyClosed,
  )
  const isOpenOperation = !processClosed
  const isBarcodeWaiting = Boolean(
    isOpenOperation &&
      !printableShipment &&
      (!dispatchRegistrationConfirmed || !barcodeRaw) &&
      !isLabelPrinted,
  )
  const isShipmentCreateRequired = Boolean(
    isBarcodeWaiting &&
      (!order.shipment ||
        !dispatchRegistrationConfirmed ||
        ['new', 'shipmentpending', 'suratbarcodefailed'].includes(
          operationStatus,
        )),
  )
  const isSuratVerificationWaiting = Boolean(
    isOpenOperation &&
      order.shipment &&
      !verifiedShipment &&
      !isLabelPrinted,
  )
  const isLabelReady = Boolean(
    isOpenOperation &&
      printableShipment &&
      printableBarcode &&
      !isLabelPrinted &&
      (['ready', 'generated'].includes(labelStatus) ||
        ['labelready', 'trackingconfirmed'].includes(operationStatus)),
  )
  const isReadyForCargo = Boolean(
    isOpenOperation && printableShipment && printableBarcode,
  )

  return {
    isOpenOperation,
    isBarcodeWaiting,
    isShipmentCreateRequired,
    isSuratVerificationWaiting,
    isLabelReady,
    isLabelPrinted,
    isReadyForCargo,
    isHandedToCargo,
    isDelivered,
    isCanceledOrReturned,
    isArchived,
    hasError,
    operationStatusLabel: resolveOperationStatusLabel({
      isOpenOperation,
      isBarcodeWaiting,
      isLabelReady,
      isLabelPrinted,
      isHandedToCargo,
      isDelivered,
      isCanceledOrReturned,
      isArchived,
      hasError,
    }),
  }
}

export function orderMatchesQuickTab(
  classification: OrderTabClassification,
  tab: QuickTab,
): boolean {
  switch (tab) {
    case 'currentSync':
      return true
    case 'open':
      return classification.isOpenOperation
    case 'barcodePending':
      return classification.isBarcodeWaiting
    case 'shipmentPending':
      return classification.isShipmentCreateRequired
    case 'suratVerificationPending':
      return classification.isSuratVerificationWaiting
    case 'labelReady':
      return classification.isLabelReady
    case 'labelPrinted':
      return classification.isLabelPrinted
    case 'handedToCargo':
      return classification.isHandedToCargo
    case 'delivered':
      return classification.isDelivered
    case 'cancelReturn':
      return classification.isCanceledOrReturned
    case 'archive':
      return classification.isArchived
    case 'all':
    default:
      return true
  }
}

export function buildVisibleOrders({
  persistentOrders,
  selectedTab,
  marketplaceFilter,
  operationStatusFilter,
  cargoFilter,
  dateFilter,
  searchQuery,
}: BuildVisibleOrdersInput): VisibleOrdersResult {
  let current = [...persistentOrders]
  const latestSyncAt = resolveLatestMarketplaceSyncAt(current)
  const debug: VisibleOrdersDebug = {
    initialCount: current.length,
    latestSyncAt,
    latestSyncCount: latestSyncAt
      ? current.filter((order) =>
          orderBelongsToCurrentSyncDay(order, latestSyncAt),
        ).length
      : 0,
    afterTabFilter: 0,
    afterMarketplaceFilter: 0,
    afterOperationStatusFilter: 0,
    afterCargoFilter: 0,
    afterDateFilter: 0,
    afterSearch: 0,
  }

  if (selectedTab === 'currentSync') {
    current = latestSyncAt
      ? current.filter((order) =>
          orderBelongsToCurrentSyncDay(order, latestSyncAt),
        )
      : current.filter((order) =>
          orderMatchesQuickTab(classifyOrderForTabs(order), 'open'),
        )
  } else if (selectedTab !== 'all') {
    current = current.filter((order) =>
      orderMatchesQuickTab(classifyOrderForTabs(order), selectedTab),
    )
  }
  debug.afterTabFilter = current.length

  if (!isAllFilter(marketplaceFilter)) {
    current = current.filter(
      (order) =>
        normalizedToken(order.marketplace) ===
        normalizedToken(marketplaceFilter),
    )
  }
  debug.afterMarketplaceFilter = current.length

  if (!isAllFilter(operationStatusFilter)) {
    const expectedStatus = normalizedToken(operationStatusFilter)
    current = current.filter((order) =>
      [
        order.status,
        order.marketplaceStatus,
        order.operationStatus,
        order.labelStatus,
      ]
        .map(normalizedToken)
        .includes(expectedStatus),
    )
  }
  debug.afterOperationStatusFilter = current.length

  if (!isAllFilter(cargoFilter)) {
    const cargoToken = normalizedToken(cargoFilter)
    current = current.filter((order) => {
      if (cargoToken.includes('surat')) {
        return Boolean(order.shipment || hasCarrierTracking(order))
      }
      if (cargoToken.includes('bekliyor')) {
        return !hasCarrierTracking(order)
      }
      if (cargoToken.includes('hatal')) {
        return classifyOrderForTabs(order).hasError
      }
      return normalizedToken(order.cargoProviderName).includes(cargoToken)
    })
  }
  debug.afterCargoFilter = current.length

  if (!isAllFilter(dateFilter.preset)) {
    const startTime = dateFilter.startTime ?? Number.NEGATIVE_INFINITY
    const endTime = dateFilter.endTime ?? Number.POSITIVE_INFINITY
    current = current.filter((order) => {
      const orderTime = new Date(order.orderDate || order.createdAt).getTime()
      return (
        !Number.isNaN(orderTime) &&
        orderTime >= startTime &&
        orderTime <= endTime
      )
    })
  }
  debug.afterDateFilter = current.length

  const query = searchQuery.trim().toLocaleLowerCase('tr-TR')
  if (query) {
    current = current.filter((order) =>
      [
        order.orderNumber,
        order.externalOrderId,
        order.customerName,
        order.customerPhone,
        order.customerEmail,
        order.city,
        order.district,
        ...order.items.flatMap((item) => [
          item.productName,
          item.sku,
          item.merchantSku,
          item.stockCode,
          item.barcode,
        ]),
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('tr-TR')
        .includes(query),
    )
  }
  debug.afterSearch = current.length

  return { visibleOrders: current, debug }
}

function resolveOperationStatusLabel(
  state: Pick<
    OrderTabClassification,
    | 'isOpenOperation'
    | 'isBarcodeWaiting'
    | 'isLabelReady'
    | 'isLabelPrinted'
    | 'isHandedToCargo'
    | 'isDelivered'
    | 'isCanceledOrReturned'
    | 'isArchived'
    | 'hasError'
  >,
): string {
  if (state.isArchived) return 'Arşiv'
  if (state.isCanceledOrReturned) return 'İptal / İade'
  if (state.isDelivered) return 'Teslim Edildi'
  if (state.isHandedToCargo) return 'Kargoya Verildi'
  if (state.hasError) return 'Kontrol Gerekli'
  if (state.isLabelPrinted) return 'Etiket Basıldı'
  if (state.isLabelReady) return 'Etiket Hazır'
  if (state.isBarcodeWaiting) return 'Barkod Bekliyor'
  if (state.isOpenOperation) return 'Açık Operasyon'
  return 'Bilinmiyor'
}

function isAllFilter(value?: string): boolean {
  return ['all', 'tumu', 'tumtarihler', ''].includes(normalizedToken(value))
}

function normalizedToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  return String((value as Record<string, unknown>)[key] ?? '').trim()
}

function readBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>)[key] === true
}

function findNestedString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    return value.map((item) => findNestedString(item, key)).find(Boolean) ?? ''
  }
  const record = value as Record<string, unknown>
  if (record[key] != null && typeof record[key] !== 'object') {
    return String(record[key]).trim()
  }
  return (
    Object.values(record)
      .map((item) => findNestedString(item, key))
      .find(Boolean) ?? ''
  )
}

function findNestedBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item) => findNestedBoolean(item, key))
  }
  const record = value as Record<string, unknown>
  if (record[key] != null) return record[key] === true
  return Object.values(record).some((item) => findNestedBoolean(item, key))
}

function firstString(...values: Array<string | undefined>): string {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? ''
}

function resolveLatestMarketplaceSyncAt(orders: CargoOrder[]): string | undefined {
  const dated = orders
    .map((order) => String(order.lastMarketplaceSyncedAt ?? '').trim())
    .filter(Boolean)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((item) => !Number.isNaN(item.time))
    .sort((a, b) => b.time - a.time)

  return dated[0]?.value
}

function orderBelongsToCurrentSyncDay(
  order: CargoOrder,
  syncBatchAt: string,
): boolean {
  const orderDate = String(order.orderDate || order.createdAt || '').trim()
  const orderTime = new Date(orderDate)
  const syncTime = new Date(syncBatchAt)
  if (Number.isNaN(orderTime.getTime()) || Number.isNaN(syncTime.getTime())) {
    return false
  }

  return (
    orderTime.getFullYear() === syncTime.getFullYear() &&
    orderTime.getMonth() === syncTime.getMonth() &&
    orderTime.getDate() === syncTime.getDate()
  )
}
