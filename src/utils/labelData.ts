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
  // Üst bölümdeki GÖNDERİCİ adı (alıcı adı ASLA buraya düşmez).
  senderName?: string
  // Kayıpsız sarılmış tam alıcı adresi satırları + font kademesi.
  fullAddressLines?: string[]
  addressFontScale?: 'normal' | 'long' | 'xlong'
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

  const fullAddress = resolveFullRecipientAddress(order, effectiveShipment)
  const addressLayout = buildAddressLayout(fullAddress)
  const recipientPhoneResolution = resolveRecipientPhone(
    order,
    effectiveShipment,
  )

  return {
    recipientName: String(order?.customerName ?? '').trim(),
    recipientPhone:
      recipientPhoneResolution.phone ||
      String(order?.customerPhone ?? '').trim(),
    senderName: resolveSuratSenderName(order, effectiveShipment, mappingConfig),
    fullAddressLines: addressLayout.lines,
    addressFontScale: addressLayout.fontScale,
    address: fullAddress || String(order?.address ?? '').trim(),
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

// ---------------------------------------------------------------------------
// Gönderici / alıcı telefonu / tam adres çözücüleri (yalnız etiket sunumu).
// ---------------------------------------------------------------------------

// Bu kurulumun Sürat cari GonderenUnvan değeri; canlı WebSiparisKodu
// satırlarının tamamında bu ad dönüyor. mappingConfig.senderName ile
// geçersiz kılınabilir. Alıcı adı hiçbir zaman fallback DEĞİLDİR.
const DEFAULT_SURAT_SENDER_NAME = 'HASAN GÜREL'

export function resolveSuratSenderName(
  order?: CargoOrder,
  shipment?: Shipment,
  mappingConfig: SuratLabelMappingConfig = {},
): string {
  const effectiveShipment = shipment ?? order?.shipment
  return firstNonEmpty(
    readUnknown(effectiveShipment?.suratTrackingLog, ['GonderenUnvan']),
    readUnknown(effectiveShipment?.rawResponse, ['GonderenUnvan']),
    readUnknown(effectiveShipment, ['senderName']),
    mappingConfig.senderName,
    DEFAULT_SURAT_SENDER_NAME,
  )
}

const PHONE_PLACEHOLDERS = new Set([
  '',
  '-',
  '0',
  'null',
  'undefined',
  'none',
  'yok',
  '0000000000',
  '00000000000',
  '5000000000',
  '5555555555',
])

// Alıcı telefonu tek sözleşme: shipment adresi → normalize müşteri telefonu
// → ham Trendyol shipment/invoice adresi → create isteğindeki TelefonCep.
// Maskeli değer (yıldızlı) güvenli biçimde olduğu gibi korunur. Geçerli
// telefon yoksa '' döner — SAHTE numara üretilmez.
export function resolveRecipientPhone(
  order?: CargoOrder,
  shipment?: Shipment,
): { phone: string; source: string; reason: string } {
  const effectiveShipment = shipment ?? order?.shipment
  const rawOrder = (order as CargoOrder & { rawOrder?: unknown })?.rawOrder
  const rawPackage = (order as CargoOrder & { rawPackage?: unknown })
    ?.rawPackage
  const candidates: Array<[string, unknown]> = [
    [
      'order.shipmentAddress.phone',
      readUnknown(order?.shipmentAddress, ['phone']),
    ],
    [
      'order.shipmentAddress.phoneNumber',
      readUnknown(order?.shipmentAddress, ['phoneNumber']),
    ],
    [
      'order.shipmentAddress.gsm',
      readUnknown(order?.shipmentAddress, ['gsm']),
    ],
    ['order.customerPhone', order?.customerPhone],
    [
      'rawOrder.shipmentAddress.phone',
      readUnknown(readUnknown(rawOrder, ['shipmentAddress']), [
        'phone',
        'phoneNumber',
        'gsm',
      ]),
    ],
    [
      'rawPackage.shipmentAddress.phone',
      readUnknown(readUnknown(rawPackage, ['shipmentAddress']), [
        'phone',
        'phoneNumber',
        'gsm',
      ]),
    ],
    [
      'rawOrder.invoiceAddress.phone',
      readUnknown(readUnknown(rawOrder, ['invoiceAddress']), ['phone']),
    ],
    [
      'create.TelefonCep',
      extractTelefonCepFromRawRequest(
        effectiveShipment?.suratCreateLog?.rawRequest,
      ),
    ],
  ]
  for (const [source, value] of candidates) {
    const normalized = normalizeRecipientPhone(value)
    if (normalized) return { phone: normalized, source, reason: '' }
  }
  return { phone: '', source: 'none', reason: 'PHONE_NOT_PROVIDED_BY_MARKETPLACE' }
}

export function normalizeRecipientPhone(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  // Maskeli telefon (örn. 542*******) güvenli biçimde olduğu gibi gösterilir.
  if (raw.includes('*')) {
    const compact = raw.replace(/[\s()-]/g, '')
    return /\d/.test(compact) ? compact : ''
  }
  let digits = raw.replace(/\D/g, '')
  if (PHONE_PLACEHOLDERS.has(raw.toLocaleLowerCase('tr-TR'))) return ''
  if (digits.startsWith('0090')) digits = digits.slice(4)
  else if (digits.startsWith('90') && digits.length === 12) {
    digits = digits.slice(2)
  }
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1)
  if (PHONE_PLACEHOLDERS.has(digits)) return ''
  if (digits.length === 10 && digits.startsWith('5')) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`
  }
  // 10 haneli sabit hat vb. — okunur ama biçimlenmemiş bırak.
  return digits.length >= 7 ? digits : ''
}

function extractTelefonCepFromRawRequest(rawRequest: unknown): string {
  const text = typeof rawRequest === 'string' ? rawRequest : ''
  const match = text.match(/<TelefonCep>([^<]*)<\/TelefonCep>/i)
  return match?.[1]?.trim() ?? ''
}

// Tam alıcı adresi: liste görünümündeki kısaltma helper'ları KULLANILMAZ;
// canonical adres kaynaklarından en zengini seçilir.
export function resolveFullRecipientAddress(
  order?: CargoOrder,
  shipment?: Shipment,
): string {
  const effectiveShipment = shipment ?? order?.shipment
  const asString = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : ''
  const candidates = [
    asString(readUnknown(order?.shipmentAddress, ['fullAddress'])),
    [
      asString(readUnknown(order?.shipmentAddress, ['address1'])),
      asString(readUnknown(order?.shipmentAddress, ['address2'])),
      asString(readUnknown(order?.shipmentAddress, ['neighborhood'])),
    ]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' '),
    asString(readUnknown(effectiveShipment, ['recipientAddress'])),
    asString(order?.address),
  ]
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  // En zengin (en uzun) canonical adres kazanır; kısaltılmış kopya seçilmez.
  return candidates.sort((left, right) => right.length - left.length)[0] ?? ''
}

export interface AddressLayout {
  lines: string[]
  fontScale: 'normal' | 'long' | 'xlong'
}

// Kayıpsız sarma: hiçbir kelime atılmaz, '...' eklenmez, kelime ortasından
// kesilmez. Satır sayısı yetmezse font kademesi küçültülüp daha geniş
// satırlarla yeniden denenir.
export function buildAddressLayout(address: string): AddressLayout {
  const text = String(address ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { lines: ['-'], fontScale: 'normal' }
  const attempts: Array<{
    maxChars: number
    maxLines: number
    fontScale: AddressLayout['fontScale']
  }> = [
    { maxChars: 38, maxLines: 3, fontScale: 'normal' },
    { maxChars: 46, maxLines: 3, fontScale: 'long' },
    { maxChars: 54, maxLines: 4, fontScale: 'xlong' },
  ]
  for (const attempt of attempts) {
    const lines = wrapWordsLossless(text, attempt.maxChars)
    if (lines.length <= attempt.maxLines) {
      return { lines, fontScale: attempt.fontScale }
    }
  }
  // Son çare: en küçük fontta kaç satır gerekiyorsa o kadar satır — içerik
  // asla atılmaz.
  return { lines: wrapWordsLossless(text, 54), fontScale: 'xlong' }
}

function wrapWordsLossless(text: string, maxChars: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}
