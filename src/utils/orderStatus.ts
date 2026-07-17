import type { CargoOrder, MarketplaceStatus, OperationStatus } from '../types/cargoflow'
import { verifySuratShipment } from './suratVerification'
import { resolveOrderStatus } from './shipmentStatus'

export const ACTIVE_MARKETPLACE_STATUSES: MarketplaceStatus[] = [
  'Created',
  'Picking',
  'Invoiced',
]

export const ARCHIVE_MARKETPLACE_STATUSES: MarketplaceStatus[] = [
  'Shipped',
  'Delivered',
  'AtCollectionPoint',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
]

export const LABEL_ACTION_OPERATION_STATUSES: OperationStatus[] = [
  'NEW',
  'SHIPMENT_PENDING',
  'SHIPMENT_CREATED',
  'SURAT_CREATED_NO_TRACKING',
  'SURAT_TRANSFERRED_BUT_NO_BARCODE',
  'SURAT_DISPATCH_REJECTED',
  'SURAT_BARCODE_FAILED',
  'SURAT_TRACKING_MISSING',
  'LABEL_CREATED_NOT_REGISTERED',
  'TECHNICAL_ZPL_RECEIVED',
  'ZPL_NOT_OPERATIONALLY_VERIFIED',
  'TRACKING_CONFIRMED',
  'LABEL_READY',
]

export function isActiveMarketplaceStatus(status?: string): boolean {
  return ACTIVE_MARKETPLACE_STATUSES.includes(status as MarketplaceStatus)
}

export function isArchiveMarketplaceStatus(status?: string): boolean {
  return ARCHIVE_MARKETPLACE_STATUSES.includes(status as MarketplaceStatus)
}

export function isCancelledOrReturnedStatus(status?: string): boolean {
  return ['Cancelled', 'Returned', 'UnDelivered', 'UnSupplied'].includes(
    String(status ?? ''),
  )
}

export function operationStatusFromMarketplaceStatus(
  marketplaceStatus: MarketplaceStatus,
): OperationStatus {
  if (marketplaceStatus === 'Delivered') return 'DELIVERED'
  if (
    marketplaceStatus === 'Shipped' ||
    marketplaceStatus === 'AtCollectionPoint'
  ) {
    return 'HANDED_TO_CARGO'
  }
  if (isCancelledOrReturnedStatus(marketplaceStatus)) return 'ERROR'
  return 'NEW'
}

export function getOrderOperationStatus(order: CargoOrder): OperationStatus {
  const resolvedStatus = resolveOrderStatus(order)
  if (resolvedStatus.statusSource !== 'localOperation') {
    return resolvedStatus.operationStatus
  }
  if (order.marketplaceStatus === 'Delivered') return 'DELIVERED'
  if (
    order.marketplaceStatus === 'Shipped' ||
    order.marketplaceStatus === 'AtCollectionPoint'
  ) {
    return 'HANDED_TO_CARGO'
  }
  if (isCancelledOrReturnedStatus(order.marketplaceStatus)) return 'ERROR'
  if (
    order.labelStatus === 'PRINTED' &&
    Boolean(order.label?.printedAt)
  ) {
    return 'LABEL_PRINTED'
  }
  if (hasLiveOrtakBarkodShipment(order)) return 'LABEL_READY'
  if (order.operationStatus) return order.operationStatus
  if (order.status === 'Hata') return 'ERROR'
  if (
    order.status === 'Etiket Hazır' ||
    order.status === 'Etiket Oluşturuldu' ||
    order.label
  ) {
    return 'LABEL_READY'
  }
  if (order.status === 'Kargo Oluşturuldu' || order.shipment) {
    return 'SHIPMENT_CREATED'
  }
  return operationStatusFromMarketplaceStatus(order.marketplaceStatus)
}

export function hasCarrierTracking(order: CargoOrder): boolean {
  return Boolean(
    order.shipment?.trackingNumber ||
      order.shipment?.shipmentCode ||
      order.shipment?.barcodeValue ||
      Object.values(order.shipment?.codeCandidates ?? {}).some(Boolean) ||
      order.shipment?.suratTrackingLog?.KargoTakipNo ||
      order.shipment?.suratTrackingLog?.TakipUrlTrackingNo ||
      order.shipment?.suratTrackingLog?.extractedKargoTakipNo,
  )
}

export function hasVerifiedSuratShipment(order: CargoOrder): boolean {
  return hasLiveOrtakBarkodShipment(order)
}

export function hasLiveOrtakBarkodShipment(order: CargoOrder): boolean {
  const shipment = order.shipment
  const verification = verifySuratShipment(order)
  return Boolean(
    shipment?.dispatchRegistrationConfirmed === true &&
      verification.verifiedShipment &&
      verification.operationalBarcodeVerified &&
      verification.barcode,
  )
}

export function withDerivedOperationStatus(order: CargoOrder): CargoOrder {
  const normalized = normalizeVerifiedOrtakBarkodState(order)
  return {
    ...normalized,
    operationStatus: getOrderOperationStatus(normalized),
  }
}

export function normalizeVerifiedOrtakBarkodState(
  order: CargoOrder,
): CargoOrder {
  const shipment = order.shipment
  const verification = verifySuratShipment(order)
  const isVerifiedCommonBarcode = Boolean(
    shipment &&
      shipment.dispatchRegistrationConfirmed === true &&
      verification.verifiedShipment &&
      verification.operationalBarcodeVerified &&
      verification.barcode,
  )
  if (!shipment || !isVerifiedCommonBarcode) return order

  const printed = Boolean(
    order.labelStatus === 'PRINTED' && order.label?.printedAt,
  )
  const previousErrorCleared = Boolean(
    shipment.previousErrorCleared ||
      order.error ||
      order.errorMessage ||
      order.noTrackingReason ||
      order.labelBlockedReason ||
      order.zplDisabledReason ||
      order.status === 'Hata' ||
      ['ERROR', 'SURAT_BARCODE_FAILED'].includes(order.operationStatus),
  )
  const nextOperationStatus: OperationStatus = printed
    ? 'LABEL_PRINTED'
    : 'LABEL_READY'
  const nextLabelStatus = printed ? 'PRINTED' : 'READY'
  const legacyMatchReason =
    'OrtakBarkodOlustur KargoTakipNo + Barcode doğrulandı'

  const matchReason =
    verification.serviceMode === 'ORTAK_BARKOD_SOAP'
      ? legacyMatchReason
      : verification.matchReason ||
        legacyMatchReason ||
        'Sürat gönderi kaydı ve barkod doğrulandı'
  const trackingNumber =
    verification.kargoTakipNo || verification.trackingNumber || verification.barcode

  return {
    ...order,
    shipment: {
      ...shipment,
      trackingNumber,
      kargoTakipNo: verification.kargoTakipNo || shipment.kargoTakipNo,
      barcode: verification.barcode,
      barcodeRaw: verification.barcodeRaw || shipment.barcodeRaw,
      barcodeValue: verification.barcode,
      barcodeSource:
        verification.barcodeSource || shipment.barcodeSource,
      trackingSource:
        verification.trackingNumberSource || shipment.trackingSource,
      serviceMode: shipment.serviceMode,
      operationName: shipment.operationName,
      verifiedShipment: true,
      verificationMatchReason: matchReason,
      lifecycleStatus: 'LABEL_READY',
      labelStatus: nextLabelStatus,
      shipmentStatus: 'VERIFIED',
      suratVerificationStatus: 'VERIFIED',
      zplReady: true,
      printEnabled: true,
      matchStatus: true,
      statusComputedFrom:
        verification.serviceMode === 'ORTAK_BARKOD_SOAP'
          ? 'ORTAK_BARKOD_SUCCESS'
          : 'SURAT_RESPONSE',
      previousStatus: shipment.previousStatus ?? order.operationStatus,
      newStatus: nextOperationStatus,
      previousErrorCleared,
      tabBucket: 'ETIKET_BASILACAKLAR',
      zplSource: verification.zplSource,
      diagnosticMessage: undefined,
      noTrackingReason: undefined,
      labelBlockedReason: undefined,
      zplDisabledReason: undefined,
    },
    status: printed ? 'Etiket Basıldı' : 'Etiket Hazır',
    operationStatus: nextOperationStatus,
    labelStatus: nextLabelStatus,
    shipmentStatus: 'VERIFIED',
    suratVerificationStatus: 'VERIFIED',
    zplReady: true,
    printEnabled: true,
    matchStatus: true,
    matchReason,
    error: undefined,
    errorMessage: undefined,
    noTrackingReason: undefined,
    labelBlockedReason: undefined,
    zplDisabledReason: undefined,
  }
}

export function isOrderOperationallyActive(order: CargoOrder): boolean {
  const resolvedStatus = resolveOrderStatus(order)
  return Boolean(
    isActiveMarketplaceStatus(order.marketplaceStatus) &&
      !resolvedStatus.delivered &&
      !resolvedStatus.shipped &&
      !resolvedStatus.canceledOrReturned,
  )
}

export function canCreateShipment(order: CargoOrder): boolean {
  const operationStatus = getOrderOperationStatus(order)
  const verification = verifySuratShipment(order)
  const commonBarcodeIncomplete = Boolean(
    order.shipment &&
      (order.shipment.dispatchRegistrationConfirmed !== true ||
        (order.labelStatus !== 'PRINTED' &&
          (!verification.verifiedShipment || !verification.barcodeRaw))),
  )
  return (
    isOrderOperationallyActive(order) &&
    (order.marketplace !== 'Trendyol' ||
      Boolean(String(order.cargoTrackingNumber ?? '').trim())) &&
    (!order.shipment ||
      isLegacyPreRegistration(order) ||
      isSuratBarcodeFailed(order) ||
      (commonBarcodeIncomplete && !isSuratDispatchRejected(order))) &&
    (!['LABEL_PRINTED', 'HANDED_TO_CARGO', 'DELIVERED'].includes(
      operationStatus,
    ) ||
      order.shipment?.dispatchRegistrationConfirmed !== true)
  )
}

export function isSuratBarcodeFailed(order: CargoOrder): boolean {
  return Boolean(
    order.operationStatus === 'SURAT_BARCODE_FAILED' ||
      order.shipment?.lifecycleStatus === 'SURAT_BARCODE_FAILED',
  )
}

export function isSuratDispatchRejected(order: CargoOrder): boolean {
  return Boolean(
    order.operationStatus === 'SURAT_DISPATCH_REJECTED' ||
      order.shipment?.lifecycleStatus === 'SURAT_DISPATCH_REJECTED' ||
      order.shipment?.errorCategory === 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  )
}

export function isLegacyPreRegistration(order: CargoOrder): boolean {
  const shipment = order.shipment
  if (!shipment || verifySuratShipment(order).verifiedShipment) return false
  return Boolean(
    shipment.serviceMode === 'PRE_REGISTRATION_REST' ||
      shipment.suratCreateLog?.serviceMode === 'PRE_REGISTRATION_REST' ||
      shipment.suratCreateLog?.serviceType ===
        'GonderiyiKargoyaGonderRestJson' ||
      shipment.suratCreateLog?.serviceType ===
        'GonderiyiKargoyaGonderLegacy',
  )
}

export function canPreviewLabel(order: CargoOrder): boolean {
  return isOrderOperationallyActive(order) && hasVerifiedSuratShipment(order)
}

export function canGenerateLabel(order: CargoOrder): boolean {
  return canPreviewLabel(order) && hasVerifiedSuratShipment(order)
}

export function canDownloadZpl(order: CargoOrder): boolean {
  const verification = verifySuratShipment(order)
  return (
    isOrderOperationallyActive(order) &&
    hasVerifiedSuratShipment(order) &&
    verification.operationalPrintAllowed &&
    verification.technicalZplReceived &&
    Boolean(verification.barcodeRaw)
  )
}

export function canMarkPrinted(order: CargoOrder): boolean {
  const operationStatus = getOrderOperationStatus(order)
  const verification = verifySuratShipment(order)
  return (
    isOrderOperationallyActive(order) &&
    ['TRACKING_CONFIRMED', 'LABEL_READY', 'LABEL_PRINTED'].includes(
      operationStatus,
    ) &&
    hasVerifiedSuratShipment(order) &&
    Boolean(verification.barcode || verification.finalSuratBarcode)
  )
}

export function canMarkHandedToCargo(order: CargoOrder): boolean {
  const operationStatus = getOrderOperationStatus(order)
  return (
    isOrderOperationallyActive(order) &&
    hasVerifiedSuratShipment(order) &&
    ['TRACKING_CONFIRMED', 'LABEL_READY', 'LABEL_PRINTED'].includes(operationStatus)
  )
}

export function isBarcodePending(order: CargoOrder): boolean {
  return (
    isOrderOperationallyActive(order) &&
    !hasPersistedVerifiedShipment(order) &&
    !isLabelPrinted(order)
  )
}

export function isShipmentPending(order: CargoOrder): boolean {
  return isOrderOperationallyActive(order) && !order.shipment
}

export function isSuratVerificationPending(order: CargoOrder): boolean {
  return (
    isOrderOperationallyActive(order) &&
    Boolean(order.shipment) &&
    !hasVerifiedSuratShipment(order) &&
    [
      'SHIPMENT_CREATED',
      'SURAT_CREATED_NO_TRACKING',
      'SURAT_TRANSFERRED_BUT_NO_BARCODE',
      'SURAT_BARCODE_FAILED',
      'SURAT_TRACKING_MISSING',
      'TECHNICAL_ZPL_RECEIVED',
      'ZPL_NOT_OPERATIONALLY_VERIFIED',
    ].includes(getOrderOperationStatus(order))
  )
}

export function isLabelReadyForPrint(order: CargoOrder): boolean {
  const verification = verifySuratShipment(order)
  return (
    isOrderOperationallyActive(order) &&
    hasPersistedVerifiedShipment(order) &&
    order.shipment?.dispatchRegistrationConfirmed === true &&
    Boolean(
      verification.barcode ||
        verification.finalSuratBarcode ||
        order.shipment?.barcode ||
        order.shipment?.barcodeValue,
    ) &&
    getOrderOperationStatus(order) === 'LABEL_READY' &&
    ['READY', 'GENERATED'].includes(String(order.labelStatus ?? 'READY')) &&
    !isLabelPrinted(order)
  )
}

function hasPersistedVerifiedShipment(order: CargoOrder): boolean {
  if (hasVerifiedSuratShipment(order)) return true
  const verification = verifySuratShipment(order)
  const shipment = order.shipment
  return Boolean(
    verification.verifiedShipment &&
      shipment?.verifiedShipment &&
      shipment.dispatchRegistrationConfirmed === true &&
      (order.matchStatus || verification.operationalBarcodeVerified) &&
      (verification.barcode || verification.finalSuratBarcode),
  )
}

export function isLabelPrinted(order: CargoOrder): boolean {
  return Boolean(
    order.labelStatus === 'PRINTED' &&
      order.label?.printedAt &&
      getOrderOperationStatus(order) === 'LABEL_PRINTED',
  )
}

export function migrateSuspiciousPrintedState(order: CargoOrder): CargoOrder {
  const verification = verifySuratShipment(order)
  const suspicious = Boolean(
    verification.verifiedShipment &&
      verification.barcodeRaw &&
      (order.labelStatus === 'PRINTED' ||
        order.operationStatus === 'LABEL_PRINTED' ||
        order.status === 'Etiket Basıldı') &&
      (!order.label?.printedAt || !order.label?.printJobId),
  )
  if (!suspicious) return order

  return {
    ...order,
    status: 'Etiket Hazır',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    shipment: order.shipment
      ? { ...order.shipment, labelStatus: 'READY' }
      : order.shipment,
    printMigrationNote:
      'Önceki otomatik basıldı durumu geri alındı; gerçek yazdırma kaydı bulunamadı.',
  }
}

export function migrateUnconfirmedSerendipState(
  order: CargoOrder,
): CargoOrder {
  const shipment = order.shipment
  const trackingLog = shipment?.suratTrackingLog
  const trackingRows = Math.max(
    Number(trackingLog?.gonderilerLength ?? 0),
    Array.isArray(trackingLog?.Gonderiler)
      ? trackingLog.Gonderiler.length
      : 0,
  )
  const hasSerendipEvidence = Boolean(
    shipment?.serdendipVerified === true ||
      String(shipment?.verificationStage ?? '') === 'serdendip_verified' ||
      (trackingRows > 0 && trackingLog?.KargoTakipNo),
  )
  const hasLegacySuccessState = Boolean(
    shipment &&
      (shipment.verifiedShipment === true ||
        shipment.operationalBarcodeVerified === true ||
        shipment.dispatchRegistrationConfirmed === true ||
        shipment.printEnabled === true ||
        ['READY', 'PRINTED'].includes(String(order.labelStatus ?? '')) ||
        ['LABEL_READY', 'LABEL_PRINTED', 'TRACKING_CONFIRMED'].includes(
          String(order.operationStatus ?? ''),
        ) ||
        [
          'carrier_label_verified',
          'operational_barcode_verified',
          'dispatch_registered_marketplace_barcode',
        ].includes(String(shipment.verificationStage ?? ''))),
  )
  const isUnconfirmedCarrierLabel = Boolean(
    shipment &&
      !hasSerendipEvidence &&
      (shipment.serdendipVerified === false || hasLegacySuccessState),
  )
  if (!shipment || !isUnconfirmedCarrierLabel) return order

  const reason =
    'Sürat etiketi/numarası alınmış olsa da KargoTakipHareketDetayi kaydı bulunamadı. Serendip doğrulaması olmadan etiket basılamaz.'
  return {
    ...order,
    status: 'Takip no/T.No Alınamadı',
    operationStatus: 'SURAT_TRACKING_MISSING',
    labelStatus: 'BLOCKED',
    shipment: {
      ...shipment,
      trackingNumber: '',
      kargoTakipNo: '',
      tNo: '',
      trackingUrl: '',
      trackingSource: '',
      barcode: '',
      barkodNo: '',
      barcodeValue: '',
      barcodeSource: '',
      finalSuratBarcode: '',
      barcodeRaw: '',
      verifiedShipment: false,
      dispatchRegistrationConfirmed: false,
      operationalBarcodeVerified: false,
      serdendipVerified: false,
      trackingConfirmationPending: true,
      verificationStage: 'tracking_confirmation_missing',
      lifecycleStatus: 'SURAT_TRACKING_MISSING',
      labelStatus: 'BLOCKED',
      printEnabled: false,
      zplReady: false,
      diagnosticMessage: reason,
      noTrackingReason: reason,
      labelBlockedReason: reason,
      zplDisabledReason: reason,
    },
    shipmentStatus: 'PENDING',
    suratVerificationStatus: 'PENDING',
    zplReady: false,
    printEnabled: false,
    matchStatus: false,
    matchReason: reason,
    errorMessage: reason,
    noTrackingReason: reason,
    labelBlockedReason: reason,
    zplDisabledReason: reason,
  }
}

export function isHandedToCargo(order: CargoOrder): boolean {
  return resolveOrderStatus(order).shipped
}

export function isDelivered(order: CargoOrder): boolean {
  return resolveOrderStatus(order).delivered
}
