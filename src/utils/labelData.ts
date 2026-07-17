import type {
  CargoOrder,
  LabelTemplate,
  OrderItem,
  OrderVariantAttribute,
  Shipment,
  SuratBarcodeSourceOption,
  SuratCreateLog,
  SuratLabelMappingConfig,
  SuratTrackingLog,
} from '../types/cargoflow'
import {
  extractTrackingNumberFromTakipUrl,
  verifySuratShipment,
} from './suratVerification'
import { resolveNormalizedDesi } from './desi'

export interface LabelDataItem {
  productName: string
  barcode: string
  sku: string
  merchantSku: string
  stockCode: string
  color: string
  size: string
  quantity: number
  variantAttributes: OrderVariantAttribute[]
}

export interface SuratFieldMapping {
  orderNumber: string
  shipmentReference: string
  TNo: string
  anaBarkodDegeri: string
  solDikeyReferans: string
  barcodeSource: string
  KargoTakipNo: string
  TakipNo: string
  TNoField: string
  BarkodNo: string
  Barkod: string
  Barcode: string
  BarkodDegeri: string
  GonderiKodu: string
  SatisKodu: string
  WebSiparisKodu: string
  OzelKargoTakipNo: string
  ReferansNo: string
  KargoObjId: string
  SeriNo: string
  SiraNo: string
  TakipUrl: string
  TakipUrlSource: string
  TakipUrlTrackingNo: string
  TakipUrlTrackingSource: string
  selectedBarcodeValue: string
  selectedBarcodeSource: string
  trendyolCargoTrackingNumber: string
  suratKargoTakipNo: string
  extractedKargoTakipNo: string
  packageId: string
  matchReason: string
  verifiedShipment: string
}

export interface SuratShipmentValidation {
  trendyolOrderNumber: string
  trendyolPackageId: string
  SatisKodu: string
  WebSiparisKodu: string
  OzelKargoTakipNo: string
  KargoTakipNo: string
  TakipNo: string
  TNo: string
  BarkodNo: string
  Barkod: string
  TakipUrl: string
  TakipUrlSource: string
  TakipUrlTrackingNo: string
  TakipUrlTrackingSource: string
  Satiskodu: string
  SeriNo: string
  SiraNo: string
  KargoObjId: string
  isMatched: boolean
  verifiedShipment: boolean
  matchReason: string
  trendyolCargoTrackingNumber: string
  suratKargoTakipNo: string
  extractedKargoTakipNo: string
  suratTakipUrl: string
  shipmentReference: string
  packageId: string
  statusText: 'Eşleşti' | 'Eşleşmedi'
}

export interface LabelData {
  recipientName: string
  recipientPhone: string
  address: string
  city: string
  district: string
  orderNumber: string
  tNo: string
  trackingNumber: string
  shipmentReference: string
  leftVerticalReference: string
  barcodeValue: string
  mainBarcodeValue: string
  // QR payload'ı müşteri referansıdır (OzelKargoTakipNo); barkod/T.No değildir.
  qrPayload?: string
  barcodeSource: string
  tNoSource: string
  mainBarcodeSource: string
  leftVerticalReferenceSource: string
  barcodeSourceOverride: SuratBarcodeSourceOption
  hasShipment: boolean
  verifiedShipment: boolean
  matchReason: string
  trendyolCargoTrackingNumber: string
  suratKargoTakipNo: string
  extractedKargoTakipNo: string
  suratTakipUrl: string
  packageId: string
  hasOfficialTrackingNumber: boolean
  serviceMode: string
  operationName: string
  kargoTakipNo: string
  barcode: string
  isLiveBarcodeReady: boolean
  items: LabelDataItem[]
  totalQuantity: number
  desi: number | null
  desiSource: string | null
  kg: number | null
  packageCount: number
  marketplaceName: string
  cargoProviderName: string
  branchName: string
  routeCenter: string
  transferCenter: string
  templateId: string
  suratFieldMapping: SuratFieldMapping
  suratShipmentValidation: SuratShipmentValidation
  suratCreateLog?: SuratCreateLog
  suratTrackingLog?: SuratTrackingLog
  rawSuratResponse?: unknown
}

export interface LabelDataValidation {
  errors: string[]
  warnings: string[]
}

interface BarcodeSelection {
  value: string
  source: string
}

export function buildSuratLabelData(
  order?: CargoOrder,
  shipment?: Shipment,
  template?: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): LabelData {
  const effectiveShipment = shipment ?? order?.shipment
  const extracted = extractSuratFields(order, effectiveShipment)
  const verification = verifySuratShipment(order, effectiveShipment)
  const items = normalizeItems(order?.items ?? [])
  const tNo = verification.tNo
  const shipmentReference = selectShipmentReference(order, effectiveShipment, extracted)
  const barcodeSelection = selectMainBarcodeValue(
    extracted,
    mappingConfig,
    verification,
  )
  const leftVerticalSelection = selectLeftVerticalReference(
    order,
    effectiveShipment,
    extracted,
  )
  const leftVerticalReference = leftVerticalSelection.value
  const hasOfficialTrackingNumber = Boolean(verification.trackingNumber)
  const validation = buildSuratShipmentValidation(
    order,
    effectiveShipment,
    extracted,
    verification,
  )
  const hasShipment = Boolean(effectiveShipment)
  const normalizedDesi = resolveNormalizedDesi(order, effectiveShipment)
  const fieldMapping: SuratFieldMapping = {
    ...extracted,
    orderNumber: String(order?.orderNumber ?? ''),
    shipmentReference,
    TNo: tNo,
    anaBarkodDegeri: barcodeSelection.value,
    solDikeyReferans: leftVerticalReference,
    barcodeSource: barcodeSelection.source,
    selectedBarcodeValue: barcodeSelection.value,
    selectedBarcodeSource: barcodeSelection.source,
    trendyolCargoTrackingNumber: verification.trendyolCargoTrackingNumber,
    suratKargoTakipNo: verification.suratKargoTakipNo,
    extractedKargoTakipNo: verification.extractedKargoTakipNo,
    packageId: verification.packageId,
    matchReason: verification.matchReason,
    verifiedShipment: String(verification.verifiedShipment),
  }

  return {
    recipientName: String(order?.customerName ?? '').trim(),
    recipientPhone: String(order?.customerPhone ?? '').trim(),
    address: String(order?.address ?? '').trim(),
    city: String(order?.city ?? '').trim(),
    district: String(order?.district ?? '').trim(),
    orderNumber: String(order?.orderNumber ?? '').trim(),
    tNo,
    trackingNumber: verification.trackingNumber,
    shipmentReference,
    leftVerticalReference,
    barcodeValue: barcodeSelection.value,
    mainBarcodeValue: barcodeSelection.value,
    barcodeSource: barcodeSelection.source,
    tNoSource: verification.tNoSource,
    mainBarcodeSource: barcodeSelection.source,
    leftVerticalReferenceSource: leftVerticalSelection.source,
    barcodeSourceOverride: mappingConfig.barcodeSourceOverride ?? 'auto',
    hasShipment,
    verifiedShipment: verification.verifiedShipment,
    matchReason: verification.matchReason,
    trendyolCargoTrackingNumber: verification.trendyolCargoTrackingNumber,
    suratKargoTakipNo: verification.suratKargoTakipNo,
    extractedKargoTakipNo: verification.extractedKargoTakipNo,
    suratTakipUrl: verification.suratTakipUrl,
    packageId: verification.packageId,
    hasOfficialTrackingNumber,
    serviceMode: verification.serviceMode ?? '',
    operationName: verification.operationName,
    kargoTakipNo: verification.kargoTakipNo,
    barcode: verification.barcode,
    isLiveBarcodeReady: verification.isLiveBarcodeReady,
    items,
    totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
    desi: normalizedDesi.desi,
    desiSource: normalizedDesi.desiSource,
    kg: normalizedDesi.weightKg,
    packageCount: normalizedDesi.packageCount,
    marketplaceName: String(order?.marketplace ?? '').trim(),
    cargoProviderName: String(
      hasShipment ? 'Sürat Kargo' : order?.cargoProviderName || 'Sürat Kargo',
    ),
    branchName: resolveBranchName(order),
    routeCenter: formatRouteCenter(order?.city, order?.district),
    transferCenter: resolveTransferCenter(order?.city, order?.district),
    templateId: String(template?.id ?? ''),
    suratFieldMapping: fieldMapping,
    suratShipmentValidation: validation,
    suratCreateLog: effectiveShipment?.suratCreateLog,
    suratTrackingLog: effectiveShipment?.suratTrackingLog,
    rawSuratResponse: resolveRawSuratResponse(effectiveShipment),
  }
}

export function buildLabelData(
  order?: CargoOrder,
  shipment?: Shipment,
  template?: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): LabelData {
  return buildSuratLabelData(order, shipment, template, mappingConfig)
}

export function validateLabelData(
  order?: CargoOrder,
  shipment?: Shipment,
  template?: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): LabelDataValidation {
  const labelData = buildSuratLabelData(order, shipment, template, mappingConfig)
  const errors: string[] = []
  const warnings: string[] = []

  if (!order) errors.push('Sipariş bulunamadı')
  if (!template) errors.push('Etiket şablonu bulunamadı')
  if (order && (!labelData.address || !labelData.city || !labelData.district)) {
    errors.push('Sipariş adres bilgisi eksik')
  }
  if (!labelData.barcodeValue) {
    errors.push('Sürat API response içinde geçerli barkod kodu bulunamadı')
  }
  if (order && !labelData.hasShipment) {
    warnings.push('Sürat gönderisi bulunamadı')
  }
  if (order && !labelData.hasOfficialTrackingNumber) {
    warnings.push('Resmi Sürat takip numarası bulunamadı. Etiket basılamaz.')
  }
  if (order && !labelData.verifiedShipment) {
    warnings.push(
      'Canlı ZPL için OrtakBarkodOlustur response içinde KargoTakipNo + Barcode birlikte bulunmalıdır.',
    )
  }
  if (order && labelData.desi == null) {
    errors.push(
      'Desi bilgisi eksik. Etiket veya Sürat gönderisi oluşturmadan önce desi girin.',
    )
  }
  return { errors: unique(errors), warnings: unique(warnings) }
}

function extractSuratFields(
  order?: CargoOrder,
  shipment?: Shipment,
): Omit<
  SuratFieldMapping,
  | 'orderNumber'
  | 'shipmentReference'
  | 'TNo'
  | 'anaBarkodDegeri'
  | 'solDikeyReferans'
  | 'barcodeSource'
  | 'selectedBarcodeValue'
  | 'selectedBarcodeSource'
  | 'trendyolCargoTrackingNumber'
  | 'suratKargoTakipNo'
  | 'extractedKargoTakipNo'
  | 'packageId'
  | 'matchReason'
  | 'verifiedShipment'
> {
  const createLog = shipment?.suratCreateLog
  const trackingLog = shipment?.suratTrackingLog
  const createParsed = firstObject(
    createLog?.parsedResponse,
    readUnknown(shipment?.rawResponse, ['parsedResponse']),
    readUnknown(shipment?.rawResponse, ['suratCreateLog', 'parsedResponse']),
  )
  const trackingParsed = firstObject(
    trackingLog?.parsedResponse,
    readUnknown(shipment?.rawResponse, ['suratTrackingLog', 'parsedResponse']),
    readUnknown(shipment?.rawResponse, ['tracking']),
  )
  const allSources = [
    trackingLog,
    trackingParsed,
    createLog,
    createParsed,
    shipment?.rawResponse,
  ]
  const takipUrlSelection = selectTakipUrl(order, shipment, allSources)
  const takipUrlTracking = extractTrackingNumberFromTakipUrl(
    takipUrlSelection.value,
  )

  return {
    KargoTakipNo: firstField(allSources, [
      'KargoTakipNo',
      'KargoTakipNumarasi',
      'KargoTakipNumarası',
    ]),
    TakipNo: firstField(allSources, ['TakipNo']),
    TNoField: firstField(allSources, ['TNo', 'T.No']),
    BarkodNo: firstField(allSources, ['BarkodNo']),
    Barkod: firstField(allSources, ['Barkod']),
    Barcode: firstField(allSources, ['Barcode']),
    BarkodDegeri: firstNonEmpty(
      firstField(allSources, ['BarkodDegeri', 'BarkodDeğeri']),
      shipment?.barcodeValue,
    ),
    GonderiKodu: firstField(allSources, [
      'GonderiKodu',
      'GönderiKodu',
      'GonderiNo',
      'GönderiNo',
    ]),
    SatisKodu: firstField(allSources, [
      'SatisKodu',
      'Satiskodu',
      'SatışKodu',
    ]),
    WebSiparisKodu: firstNonEmpty(
      firstField(allSources, ['WebSiparisKodu', 'webSiparisKodu']),
      shipment?.shipmentCode,
    ),
    OzelKargoTakipNo: firstField(allSources, ['OzelKargoTakipNo']),
    ReferansNo: firstField(allSources, ['ReferansNo']),
    KargoObjId: firstField(allSources, ['KargoObjId']),
    SeriNo: firstField(allSources, ['SeriNo']),
    SiraNo: firstField(allSources, ['SiraNo', 'SıraNo']),
    TakipUrl: takipUrlSelection.value,
    TakipUrlSource: takipUrlSelection.source,
    TakipUrlTrackingNo: takipUrlTracking.value,
    TakipUrlTrackingSource: takipUrlTracking.source,
  }
}

function selectTakipUrl(
  _order: CargoOrder | undefined,
  shipment: Shipment | undefined,
  sources: unknown[],
): BarcodeSelection {
  const responseUrl = firstField(sources, ['TakipUrl', 'TakipURL'])
  if (responseUrl) return { value: responseUrl, source: 'surat.TakipUrl' }

  if (shipment?.trackingUrl) {
    return { value: shipment.trackingUrl, source: 'shipment.trackingUrl' }
  }

  return { value: '', source: '' }
}

function selectShipmentReference(
  order: CargoOrder | undefined,
  shipment: Shipment | undefined,
  fields: ReturnType<typeof extractSuratFields>,
): string {
  return firstNonEmpty(
    fields.WebSiparisKodu,
    fields.SatisKodu,
    fields.OzelKargoTakipNo,
    fields.ReferansNo,
    shipment?.shipmentCode,
    order?.packageId,
    order?.orderNumber,
  )
}

function selectLeftVerticalReference(
  order: CargoOrder | undefined,
  shipment: Shipment | undefined,
  fields: ReturnType<typeof extractSuratFields>,
): BarcodeSelection {
  if (shipment) {
    const value = firstNonEmpty(
      order?.packageId,
      fields.WebSiparisKodu,
      fields.OzelKargoTakipNo,
      fields.SatisKodu,
      shipment.shipmentCode,
      order?.orderNumber,
    )
    return {
      value,
      source: order?.packageId
        ? 'trendyol.packageId'
        : fields.WebSiparisKodu
          ? 'surat.WebSiparisKodu'
          : fields.OzelKargoTakipNo
            ? 'surat.OzelKargoTakipNo'
            : fields.SatisKodu
              ? 'surat.SatisKodu'
              : shipment.shipmentCode
                ? 'shipment.shipmentCode'
                : 'order.orderNumber',
    }
  }

  return {
    value: String(order?.orderNumber ?? ''),
    source: 'order.orderNumber',
  }
}

function buildSuratShipmentValidation(
  order: CargoOrder | undefined,
  shipment: Shipment | undefined,
  fields: ReturnType<typeof extractSuratFields>,
  verification: ReturnType<typeof verifySuratShipment>,
): SuratShipmentValidation {
  const trackingParsed = firstObject(
    shipment?.suratTrackingLog?.parsedResponse,
    readUnknown(shipment?.rawResponse, ['suratTrackingLog', 'parsedResponse']),
    readUnknown(shipment?.rawResponse, ['tracking']),
  )
  const sentReference = firstNonEmpty(
    fields.WebSiparisKodu,
    fields.SatisKodu,
    fields.OzelKargoTakipNo,
    order?.packageId,
    order?.orderNumber,
  )
  const satiskodu = firstNonEmpty(
    readString(shipment?.suratTrackingLog, ['Satiskodu', 'SatisKodu']),
    readString(trackingParsed, ['Satiskodu', 'SatisKodu']),
  )
  const webSiparisKodu = firstNonEmpty(fields.WebSiparisKodu, sentReference)
  const isMatched = verification.verifiedShipment

  return {
    trendyolOrderNumber: String(order?.orderNumber ?? ''),
    trendyolPackageId: String(order?.packageId ?? ''),
    SatisKodu: sentReference,
    WebSiparisKodu: webSiparisKodu,
    OzelKargoTakipNo: firstNonEmpty(fields.OzelKargoTakipNo, sentReference),
    KargoTakipNo: fields.KargoTakipNo,
    TakipNo: fields.TakipNo,
    TNo: fields.TNoField,
    BarkodNo: fields.BarkodNo,
    Barkod: fields.Barkod,
    TakipUrl: fields.TakipUrl,
    TakipUrlSource: fields.TakipUrlSource,
    TakipUrlTrackingNo: fields.TakipUrlTrackingNo,
    TakipUrlTrackingSource: fields.TakipUrlTrackingSource,
    Satiskodu: satiskodu,
    SeriNo: fields.SeriNo,
    SiraNo: fields.SiraNo,
    KargoObjId: fields.KargoObjId,
    isMatched,
    verifiedShipment: verification.verifiedShipment,
    matchReason: verification.matchReason,
    trendyolCargoTrackingNumber: verification.trendyolCargoTrackingNumber,
    suratKargoTakipNo: verification.suratKargoTakipNo,
    extractedKargoTakipNo: verification.extractedKargoTakipNo,
    suratTakipUrl: verification.suratTakipUrl,
    shipmentReference: verification.shipmentReference,
    packageId: verification.packageId,
    statusText: isMatched ? 'Eşleşti' : 'Eşleşmedi',
  }
}

function selectMainBarcodeValue(
  fields: ReturnType<typeof extractSuratFields>,
  mappingConfig: SuratLabelMappingConfig,
  verification?: ReturnType<typeof verifySuratShipment>,
): BarcodeSelection {
  const option = mappingConfig.barcodeSourceOverride ?? 'auto'

  if (option !== 'auto') {
    const manualValueByOption: Record<Exclude<SuratBarcodeSourceOption, 'auto'>, string> = {
      BarkodNo: fields.BarkodNo,
      Barkod: fields.Barkod,
      Barcode: fields.Barcode,
    }
    return {
      value: manualValueByOption[option],
      source: `manual.${option}`,
    }
  }

  if (verification && !verification.operationalBarcodeVerified) {
    return { value: '', source: '' }
  }

  const automaticCandidates: Array<[string, string]> = [
    [
      verification?.officialBarcodeValue ?? '',
      verification?.officialBarcodeSource ?? '',
    ],
    [fields.Barcode, 'surat.ortakBarkod.Barcode'],
    [fields.BarkodNo, 'surat.BarkodNo'],
    [fields.Barkod, 'surat.Barkod'],
  ]
  const automatic = automaticCandidates.find(([value]) => value)
  if (automatic) return { value: automatic[0], source: automatic[1] }

  return { value: '', source: '' }
}

function normalizeItems(items: OrderItem[]): LabelDataItem[] {
  return items.map((item) => ({
    productName: String(item.productName ?? '').trim(),
    barcode: String(item.barcode ?? '').trim(),
    sku: String(item.merchantSku || item.sku || item.stockCode || '').trim(),
    merchantSku: String(item.merchantSku || '').trim(),
    stockCode: String(item.stockCode || '').trim(),
    color: String(item.color || readVariant(item.variantAttributes, 'Renk')).trim(),
    size: String(item.size || readVariant(item.variantAttributes, 'Beden')).trim(),
    quantity: Number(item.quantity ?? 0),
    variantAttributes: item.variantAttributes ?? [],
  }))
}

function resolveRawSuratResponse(shipment?: Shipment): unknown {
  if (!shipment) return undefined
  return {
    shipmentRawResponse: shipment.rawResponse,
    createRawResponse: shipment.suratCreateLog?.rawResponse,
    trackingRawResponse:
      shipment.suratTrackingLog?.rawSuratResponse ??
      shipment.suratTrackingLog?.rawResponse,
    createLog: shipment.suratCreateLog,
    trackingLog: shipment.suratTrackingLog,
  }
}

function resolveBranchName(order?: CargoOrder): string {
  const rawBranch =
    readString(order?.shipment?.rawResponse, [
      'Sube',
      'SubeAdi',
      'TeslimatSubesi',
      'CikisSubesi',
    ]) ||
    readString(order?.shipmentAddress, ['Sube', 'SubeAdi']) ||
    ''

  return rawBranch || 'FERAH'
}

function formatRouteCenter(city?: string, district?: string): string {
  return [city, district]
    .map((item) => String(item ?? '').trim().toLocaleUpperCase('tr-TR'))
    .filter(Boolean)
    .join(' / ')
}

function resolveTransferCenter(city?: string, district?: string): string {
  const normalizedCity = String(city ?? '').trim().toLocaleUpperCase('tr-TR')
  const knownTransfers: Record<string, string> = {
    KASTAMONU: 'GEREDE AKTARMA',
    ISTANBUL: 'ISTANBUL AKTARMA',
    ANKARA: 'ANKARA AKTARMA',
    IZMIR: 'IZMIR AKTARMA',
    BURSA: 'BURSA AKTARMA',
  }

  if (knownTransfers[normalizedCity]) return knownTransfers[normalizedCity]
  const fallback = String(district || city || 'AKTARMA')
    .trim()
    .toLocaleUpperCase('tr-TR')
  return `${fallback} AKTARMA`
}

function readVariant(
  attributes: OrderVariantAttribute[] | undefined,
  name: string,
): string {
  const normalized = name.toLocaleLowerCase('tr-TR')
  return (
    attributes?.find(
      (attribute) =>
        attribute.name.toLocaleLowerCase('tr-TR') === normalized,
    )?.value ?? ''
  )
}

function firstField(sources: unknown[], keys: string[]): string {
  for (const source of sources) {
    const found = readString(source, keys)
    if (found) return found
  }
  return ''
}

function readString(value: unknown, keys: string[]): string {
  const found = readUnknown(value, keys)
  if (found == null) return ''
  if (typeof found === 'object') return JSON.stringify(found)
  return String(found).trim()
}

function readUnknown(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readUnknown(item, keys)
      if (found != null && found !== '') return found
    }
    return undefined
  }

  const normalizedKeys = keys.map((key) => key.toLocaleLowerCase('tr-TR'))
  for (const [key, item] of Object.entries(value)) {
    if (
      normalizedKeys.includes(key.toLocaleLowerCase('tr-TR')) &&
      item != null
    ) {
      return item
    }
    const nested = readUnknown(item, keys)
    if (nested != null && nested !== '') return nested
  }

  return undefined
}

function firstObject(...values: unknown[]): unknown {
  return values.find(
    (value) => value && typeof value === 'object' && !Array.isArray(value),
  )
}

function firstNonEmpty(...values: unknown[]): string {
  return values
    .map((value) => String(value ?? '').trim())
    .find(Boolean) ?? ''
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}
