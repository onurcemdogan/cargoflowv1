import type {
  CargoOrder,
  LabelTemplate,
  Shipment,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import { buildLabelData, type LabelData } from './labelData'
import { resolveSuratBarcodeRawZpl } from './zpl'
import { verifySuratShipment } from './suratVerification'

export interface PrintableLabelContext {
  orders?: CargoOrder[]
  shipments?: unknown[]
  labels?: unknown[]
}

export interface PrintableLabelDebug {
  orderNumber: string
  packageId: string
  selectedRowHasBarcodeRaw: boolean
  canonicalOrderFound: boolean
  shipmentFound: boolean
  shipmentMatchKey: string
  verifiedShipmentBefore: boolean
  verifiedShipmentAfter: boolean
  dispatchRegistrationConfirmed: boolean
  trackingNumber: string
  barcode: string
  hasBarcodeRaw: boolean
  barcodeRawLength: number
  barcodeRawStartsWithXA: boolean
  barcodeRawEndsWithXZ: boolean
  canPreview: boolean
  canPrint: boolean
  warningReason: string
  dataSource: string
}

export interface PrintableLabelResolution {
  order: CargoOrder
  shipment?: Shipment
  trackingNumber: string
  barcode: string
  barcodeRaw: string
  verifiedShipment: boolean
  labelStatus?: string
  operationStatus: string
  printedAt?: string
  printCount: number
  serviceMode: string
  operationName: string
  zplSource: string
  canPreview: boolean
  canPrint: boolean
  warningReason: string
  debug: PrintableLabelDebug
}

export function resolvePrintableLabel(
  selectedOrder: CargoOrder,
  context: PrintableLabelContext = {},
): PrintableLabelResolution {
  const canonicalMatch = findCanonicalOrder(selectedOrder, context.orders ?? [])
  const order = mergeCanonicalOrder(selectedOrder, canonicalMatch.order)
  const relatedShipment = findRelatedRecord(
    order,
    context.shipments ?? [],
  )
  const relatedLabel = findRelatedRecord(order, context.labels ?? [])
  const shipment =
    (relatedShipment.record as Shipment | undefined) ||
    canonicalMatch.order?.shipment ||
    selectedOrder.shipment ||
    undefined
  const label =
    relatedLabel.record || canonicalMatch.order?.label || selectedOrder.label
  const rawCreateResponse = firstDefined(
    readPath(shipment, ['rawSuratCreateResponse']),
    readPath(order, ['rawSuratCreateResponse']),
    readPath(shipment, ['suratCreateLog', 'rawResponse']),
    readPath(shipment, ['rawResponse']),
  )
  const tracking = firstResolved([
    ['shipment.trackingNumber', readPath(shipment, ['trackingNumber'])],
    ['shipment.KargoTakipNo', readPath(shipment, ['KargoTakipNo'])],
    ['shipment.kargoTakipNo', readPath(shipment, ['kargoTakipNo'])],
    ['shipment.TakipNo', readPath(shipment, ['TakipNo'])],
    [
      'rawSuratCreateResponse.KargoTakipNo',
      readPath(rawCreateResponse, ['KargoTakipNo']),
    ],
    [
      'parsedResponse.KargoTakipNo',
      readPath(rawCreateResponse, ['parsedResponse', 'KargoTakipNo']),
    ],
    [
      'parsedResponse.TakipNo',
      readPath(rawCreateResponse, ['parsedResponse', 'TakipNo']),
    ],
  ])
  const barcode = firstResolved([
    ['shipment.barcode', readPath(shipment, ['barcode'])],
    ['shipment.Barcode', readPath(shipment, ['Barcode'])],
    ['shipment.Barkod', readPath(shipment, ['Barkod'])],
    ['shipment.BarkodNo', readPath(shipment, ['BarkodNo'])],
    [
      'rawSuratCreateResponse.Barcode',
      readPath(rawCreateResponse, ['Barcode']),
    ],
    [
      'parsedResponse.Barcode',
      readPath(rawCreateResponse, ['parsedResponse', 'Barcode']),
    ],
    [
      'parsedResponse.Barkod',
      readPath(rawCreateResponse, ['parsedResponse', 'Barkod']),
    ],
  ])
  const barcodeRaw = firstZpl([
    ['shipment.barcodeRaw', readPath(shipment, ['barcodeRaw'])],
    ['shipment.BarcodeRaw', readPath(shipment, ['BarcodeRaw'])],
    ['shipment.zpl', readPath(shipment, ['zpl'])],
    [
      'shipment.suratCreateLog.BarcodeRaw',
      readPath(shipment, ['suratCreateLog', 'BarcodeRaw']),
    ],
    [
      'shipment.suratCreateLog.parsedResponse.BarcodeRaw',
      readPath(shipment, [
        'suratCreateLog',
        'parsedResponse',
        'BarcodeRaw',
      ]),
    ],
    ['order.barcodeRaw', readPath(order, ['barcodeRaw'])],
    ['order.BarcodeRaw', readPath(order, ['BarcodeRaw'])],
    ['order.zpl', readPath(order, ['zpl'])],
    ['label.barcodeRaw', readPath(label, ['barcodeRaw'])],
    ['label.zplContent', readPath(label, ['zplContent'])],
    ['label.zpl', readPath(label, ['zpl'])],
    [
      'rawSuratCreateResponse.BarcodeRaw',
      readPath(rawCreateResponse, ['BarcodeRaw']),
    ],
    [
      'parsedResponse.BarcodeRaw',
      readPath(rawCreateResponse, ['parsedResponse', 'BarcodeRaw']),
    ],
    [
      'extractedFromRawXml',
      firstDefined(
        readPath(rawCreateResponse, ['parsedResponse', 'raw']),
        readPath(rawCreateResponse, ['rawResponse']),
        rawCreateResponse,
      ),
    ],
  ])
  const serviceMode = firstString(
    readPath(shipment, ['serviceMode']),
    readPath(shipment, ['suratCreateLog', 'serviceMode']),
    readPath(order, ['serviceMode']),
  )
  const operationName = firstString(
    readPath(shipment, ['operationName']),
    readPath(shipment, ['suratCreateLog', 'operationName']),
    readPath(order, ['operationName']),
  )
  const verification = verifySuratShipment(order, shipment)
  const resolvedTrackingNumber =
    verification.trackingNumber || tracking.value
  const resolvedBarcode =
    verification.finalSuratBarcode || barcode.value
  const verifiedBefore = Boolean(
    readBoolean(shipment, ['verifiedShipment']) ||
      readBoolean(order, ['verifiedShipment']) ||
      order.matchStatus,
  )
  const commonBarcodeEvidence = Boolean(
    tracking.value &&
      barcode.value &&
      barcodeRaw.value &&
      (serviceMode === 'ORTAK_BARKOD_SOAP' ||
        operationName === 'OrtakBarkodOlustur'),
  )
  const verifiedAfter = Boolean(
    verification.operationalBarcodeVerified ||
      (verifiedBefore &&
        commonBarcodeEvidence &&
        verification.operationalPrintAllowed),
  )
  const dispatchRegistrationConfirmed = readBoolean(shipment, [
    'dispatchRegistrationConfirmed',
  ])
  // Kanıt (17.07.2026): create/label yanıtındaki ön-atanmış T.No/barkod
  // fiziksel tesellümde birebir korunuyor; sunucu printEnabled verdiyse
  // kabul öncesi etiket bu kodlarla yazdırılabilir.
  const preassignedPrintReady = Boolean(
    readBoolean(shipment, ['printEnabled']) &&
      firstString(readPath(shipment, ['candidateVerificationStatus'])) ===
        'PREASSIGNED_AWAITING_ACCEPTANCE' &&
      tracking.value &&
      barcode.value &&
      barcodeRaw.value,
  )
  const canPreview = Boolean(
    (verifiedAfter || preassignedPrintReady) && resolvedBarcode,
  )
  const canPrint = Boolean(
    (canPreview &&
      resolvedTrackingNumber &&
      resolvedBarcode &&
      verifiedAfter &&
      dispatchRegistrationConfirmed &&
      verification.operationalPrintAllowed) ||
      (preassignedPrintReady && resolvedTrackingNumber && resolvedBarcode),
  )
  const warningReason = resolveWarningReason({
    shipmentFound: Boolean(shipment),
    trackingNumber: resolvedTrackingNumber,
    barcode: resolvedBarcode,
    barcodeRaw: barcodeRaw.value,
    serviceMode,
    operationName,
    dispatchRegistrationConfirmed,
  })
  const resolvedShipment = buildResolvedShipment({
    order,
    shipment,
    trackingNumber: resolvedTrackingNumber,
    barcode: resolvedBarcode,
    barcodeRaw: barcodeRaw.value,
    serviceMode,
    operationName,
    verifiedShipment: verifiedAfter,
  })
  const dataSources = Array.from(
    new Set(
      [tracking.source, barcode.source, barcodeRaw.source]
        .map((source) => source.split('.')[0])
        .filter(Boolean),
    ),
  ).join(', ')

  return {
    order,
    shipment: resolvedShipment,
    trackingNumber: resolvedTrackingNumber,
    barcode: resolvedBarcode,
    barcodeRaw: barcodeRaw.value,
    verifiedShipment: verifiedAfter,
    labelStatus:
      order.labelStatus ||
      firstString(readPath(label, ['labelStatus'])) ||
      firstString(readPath(resolvedShipment, ['labelStatus'])),
    operationStatus: order.operationStatus,
    printedAt:
      order.label?.printedAt ||
      firstString(readPath(label, ['printedAt'])) ||
      undefined,
    printCount:
      order.label?.printCount ??
      Number(readPath(label, ['printCount']) ?? 0),
    serviceMode,
    operationName,
    zplSource: barcodeRaw.value
      ? 'surat.ortakBarkod.BarcodeRaw'
      : 'generated',
    canPreview,
    canPrint,
    warningReason: canPrint ? '' : warningReason,
    debug: {
      orderNumber: order.orderNumber,
      packageId: String(order.packageId || order.shipmentPackageId || ''),
      selectedRowHasBarcodeRaw: Boolean(
        resolveSuratBarcodeRawZpl(
          readPath(selectedOrder.shipment, ['barcodeRaw']),
          readPath(selectedOrder, ['barcodeRaw']),
          readPath(selectedOrder, ['BarcodeRaw']),
        ),
      ),
      canonicalOrderFound: Boolean(canonicalMatch.order),
      shipmentFound: Boolean(shipment),
      shipmentMatchKey:
        relatedShipment.matchKey ||
        relatedLabel.matchKey ||
        canonicalMatch.matchKey ||
        '',
      verifiedShipmentBefore: verifiedBefore,
      verifiedShipmentAfter: verifiedAfter,
      dispatchRegistrationConfirmed,
      trackingNumber: tracking.value,
      barcode: barcode.value,
      hasBarcodeRaw: Boolean(barcodeRaw.value),
      barcodeRawLength: barcodeRaw.value.length,
      barcodeRawStartsWithXA: barcodeRaw.value.startsWith('^XA'),
      barcodeRawEndsWithXZ: barcodeRaw.value.endsWith('^XZ'),
      canPreview,
      canPrint,
      warningReason: canPrint ? '' : warningReason,
      dataSource: dataSources || 'none',
    },
  }
}

export function buildPrintableLabelData(
  resolution: PrintableLabelResolution,
  template?: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): LabelData {
  const data = buildLabelData(
    resolution.order,
    resolution.shipment,
    template,
    mappingConfig,
  )
  const shipmentReference =
    data.shipmentReference ||
    String(
      resolution.order.packageId ||
        resolution.order.shipmentPackageId ||
        resolution.order.orderNumber,
    )

  return {
    ...data,
    tNo: data.tNo,
    trackingNumber: resolution.trackingNumber || data.trackingNumber,
    shipmentReference,
    leftVerticalReference: data.leftVerticalReference || shipmentReference,
    barcodeValue: resolution.barcode || data.barcodeValue,
    mainBarcodeValue: resolution.barcode || data.mainBarcodeValue,
    barcodeSource: resolution.barcode
      ? 'resolvedPrintableLabel.Barcode'
      : data.barcodeSource,
    mainBarcodeSource: resolution.barcode
      ? 'resolvedPrintableLabel.Barcode'
      : data.mainBarcodeSource,
    hasShipment: Boolean(resolution.shipment),
    verifiedShipment: resolution.verifiedShipment,
    matchReason: resolution.verifiedShipment
      ? 'Ortak barkod alanları çözümlendi'
      : data.matchReason,
    hasOfficialTrackingNumber: Boolean(resolution.trackingNumber),
    serviceMode: resolution.serviceMode || data.serviceMode,
    operationName: resolution.operationName || data.operationName,
    kargoTakipNo: resolution.trackingNumber || data.kargoTakipNo,
    barcode: resolution.barcode || data.barcode,
    isLiveBarcodeReady: resolution.canPrint,
  }
}

function findCanonicalOrder(
  selectedOrder: CargoOrder,
  orders: CargoOrder[],
): { order?: CargoOrder; matchKey: string } {
  const keys = orderMatchKeys(selectedOrder)
  for (const [key, value] of keys) {
    if (!value) continue
    const found = orders.find((candidate) =>
      orderMatchKeys(candidate).some(
        ([candidateKey, candidateValue]) =>
          candidateKey === key && candidateValue === value,
      ),
    )
    if (found) return { order: found, matchKey: key }
  }
  return { matchKey: '' }
}

function findRelatedRecord(
  order: CargoOrder,
  records: unknown[],
): { record?: unknown; matchKey: string } {
  const keys = orderMatchKeys(order)
  for (const [key, value] of keys) {
    if (!value) continue
    const record = records.find((candidate) =>
      recordValuesForKey(candidate, key).includes(value),
    )
    if (record) return { record, matchKey: key }
  }
  return { matchKey: '' }
}

function orderMatchKeys(order: CargoOrder): Array<[string, string]> {
  return [
    ['packageId', firstString(order.packageId)],
    ['shipmentPackageId', firstString(order.shipmentPackageId)],
    ['shipmentReference', firstString(readPath(order, ['shipmentReference']))],
    ['packageNumber', firstString(readPath(order, ['packageNumber']))],
    ['orderNumber', firstString(order.orderNumber)],
    ['id', firstString(order.id, order.externalOrderId)],
  ]
}

function recordValuesForKey(record: unknown, key: string): string[] {
  const aliases: Record<string, string[]> = {
    packageId: ['packageId'],
    shipmentPackageId: ['shipmentPackageId'],
    shipmentReference: [
      'shipmentReference',
      'shipmentCode',
      'WebSiparisKodu',
      'SatisKodu',
      'ReferansNo',
    ],
    packageNumber: ['packageNumber'],
    orderNumber: ['orderNumber'],
    id: ['id', 'orderId', 'externalOrderId'],
  }
  return (aliases[key] ?? [key])
    .map((field) => firstString(readPath(record, [field])))
    .filter(Boolean)
}

function mergeCanonicalOrder(
  selectedOrder: CargoOrder,
  canonicalOrder?: CargoOrder,
): CargoOrder {
  if (!canonicalOrder) return selectedOrder
  return {
    ...selectedOrder,
    ...canonicalOrder,
    items:
      canonicalOrder.items?.length > 0
        ? canonicalOrder.items
        : selectedOrder.items,
    shipment: canonicalOrder.shipment || selectedOrder.shipment,
    label: canonicalOrder.label || selectedOrder.label,
  }
}

function buildResolvedShipment({
  order,
  shipment,
  trackingNumber,
  barcode,
  barcodeRaw,
  serviceMode,
  operationName,
  verifiedShipment,
}: {
  order: CargoOrder
  shipment?: Shipment
  trackingNumber: string
  barcode: string
  barcodeRaw: string
  serviceMode: string
  operationName: string
  verifiedShipment: boolean
}): Shipment | undefined {
  if (!shipment && !trackingNumber && !barcode && !barcodeRaw) return undefined
  return {
    ...(shipment ?? {}),
    id: shipment?.id || `resolved-${order.id}`,
    provider: 'surat-kargo',
    trackingNumber,
    trackingUrl: shipment?.trackingUrl || '',
    shipmentCode:
      shipment?.shipmentCode ||
      String(order.packageId || order.shipmentPackageId || order.orderNumber),
    barcodeValue: barcode,
    serviceMode:
      serviceMode === 'ORTAK_BARKOD_SOAP'
        ? 'ORTAK_BARKOD_SOAP'
        : shipment?.serviceMode,
    operationName: operationName || shipment?.operationName,
    kargoTakipNo: trackingNumber,
    barcode,
    barcodeRaw,
    zplSource: barcodeRaw
      ? 'surat.ortakBarkod.BarcodeRaw'
      : shipment?.zplSource,
    verifiedShipment,
    status: shipment?.status || 'created',
    source: shipment?.source || 'real',
    rawResponse: shipment?.rawResponse ?? {},
    createdAt: shipment?.createdAt || order.createdAt,
  }
}

function resolveWarningReason({
  shipmentFound,
  trackingNumber,
  barcode,
  barcodeRaw,
  serviceMode,
  operationName,
  dispatchRegistrationConfirmed,
}: {
  shipmentFound: boolean
  trackingNumber: string
  barcode: string
  barcodeRaw: string
  serviceMode: string
  operationName: string
  dispatchRegistrationConfirmed: boolean
}): string {
  if (!barcodeRaw) {
    if (!shipmentFound) {
      return 'Shipment state bulunamadı; BarcodeRaw mevcut değil.'
    }
    return 'BarcodeRaw bulunamadı.'
  }
  if (!trackingNumber) return 'Kargo takip no eksik.'
  if (!barcode) return 'Barkod değeri eksik.'
  if (!dispatchRegistrationConfirmed) {
    return 'Önce Sürat gönderisi gerçek API üzerinden oluşturulmalı.'
  }
  if (
    serviceMode !== 'ORTAK_BARKOD_SOAP' &&
    operationName !== 'OrtakBarkodOlustur'
  ) {
    return 'Bu sipariş için Sürat ortak barkod henüz doğrulanmamış.'
  }
  return 'Etiket önizleme verisi eksik.'
}

function firstResolved(
  candidates: Array<[string, unknown]>,
): { value: string; source: string } {
  for (const [source, value] of candidates) {
    const normalized = firstString(value)
    if (normalized) return { value: normalized, source }
  }
  return { value: '', source: '' }
}

function firstZpl(
  candidates: Array<[string, unknown]>,
): { value: string; source: string } {
  for (const [source, value] of candidates) {
    const zpl = resolveSuratBarcodeRawZpl(value)
    if (zpl) return { value: zpl, source }
  }
  return { value: '', source: '' }
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined
    const entry = Object.entries(current).find(
      ([key]) =>
        key.toLocaleLowerCase('tr-TR') ===
        segment.toLocaleLowerCase('tr-TR'),
    )
    if (!entry) return undefined
    current = entry[1]
  }
  return current
}

function readBoolean(value: unknown, path: string[]): boolean {
  return Boolean(readPath(value, path))
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value != null && value !== '')
}

function firstString(...values: unknown[]): string {
  return (
    values
      .map((value) =>
        typeof value === 'string' || typeof value === 'number'
          ? String(value).trim()
          : '',
      )
      .find(Boolean) ?? ''
  )
}
