export type PageKey =
  | 'dashboard'
  | 'orders'
  | 'products'
  | 'cargo'
  | 'labelTemplates'
  | 'integrations'
  | 'debug'
  | 'printers'
  | 'logs'

export type ApiDataSource = 'real' | 'real_api' | 'local'

export type MarketplaceName =
  | 'Trendyol'
  | 'Hepsiburada'
  | 'N11'
  | 'Shopify'
  | 'Manuel'

export type MarketplaceStatus =
  | 'Created'
  | 'Picking'
  | 'Invoiced'
  | 'Shipped'
  | 'Delivered'
  | 'Cancelled'
  | 'Returned'
  | 'UnDelivered'
  | 'UnSupplied'
  | 'AtCollectionPoint'

export type OperationStatus =
  | 'NEW'
  | 'SHIPMENT_PENDING'
  | 'SHIPMENT_CREATED'
  | 'SURAT_CREATED_NO_TRACKING'
  | 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
  | 'SURAT_DISPATCH_REJECTED'
  | 'SURAT_BARCODE_FAILED'
  | 'SURAT_TRACKING_MISSING'
  | 'TECHNICAL_ZPL_RECEIVED'
  | 'ZPL_NOT_OPERATIONALLY_VERIFIED'
  | 'TRACKING_CONFIRMED'
  | 'LABEL_READY'
  | 'LABEL_PRINTED'
  | 'SHIPPED'
  | 'HANDED_TO_CARGO'
  | 'DELIVERED'
  | 'RETURNING'
  | 'DELIVERED_SPECIAL'
  | 'ERROR'

export type CarrierStatusKey =
  | 'PREPARING'
  | 'TRANSFER_CENTER'
  | 'IN_TRANSIT'
  | 'DELIVERY_BRANCH'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'REDIRECTING'
  | 'RETURNING'
  | 'COLLECTION_POINT'
  | 'RETURN_DELIVERED'
  | 'MGT_DELIVERED'

export type SuratServiceMode =
  | 'KARGO_BARKODU_SIPARIS_SOAP'
  | 'ORTAK_BARKOD_SOAP'
  | 'PRE_REGISTRATION_REST'
  | 'TRENDYOL_MARKETPLACE'
  | 'GONDERI_OLUSTUR_V2_EXPERIMENTAL'

export type LabelStatus = 'READY' | 'GENERATED' | 'PRINTED' | 'BLOCKED'
export type DesiSource =
  | 'manual'
  | 'product'
  | 'calculated'
  | 'api'
  | 'default'

export type OrderStatus =
  | 'Yeni'
  | 'Ön Kayıt Yapıldı'
  | 'Kargo Oluşturuldu'
  | 'Takip no/T.No Alınamadı'
  | 'Etiket Hazır'
  | 'Etiket Oluşturuldu'
  | 'Etiket Basıldı'
  | 'Arşiv'
  | 'Hata'

export type OrderStatusFilter = OrderStatus | MarketplaceStatus | 'all'

export type CargoFilter = 'all' | 'Sürat Kargo' | 'Bekliyor' | 'Hatalı'

export type AuditAction =
  | 'Siparişler çekildi'
  | 'Ürünler çekildi'
  | 'Bağlantı test edildi'
  | 'Gönderi oluşturuldu'
  | 'Takip sorgulandı'
  | 'Kargoya verildi'
  | 'Etiket oluşturuldu'
  | 'Etiket basıldı'
  | 'ZPL indirildi'
  | 'Hata oluştu'
  | 'Entegrasyon kaydedildi'
  | 'Yazıcı ayarı kaydedildi'
  | 'Etiket şablonu kaydedildi'

export type AuditLevel = 'info' | 'success' | 'warning' | 'error'

export interface OrderItem {
  id: string
  orderId?: string
  productName: string
  sku: string
  merchantSku?: string
  barcode: string
  quantity: number
  price?: number
  imageUrl?: string
  productImageUrl?: string
  imageSource?: string
  imageResolvedFrom?: 'orderLine' | 'productCache' | 'listingApi' | 'none'
  imageLoadError?: boolean
  matchedProductId?: string
  matchedBy?:
    | 'orderLine'
    | 'productContentId'
    | 'productMainId'
    | 'barcode'
    | 'merchantSku'
    | 'sku'
    | 'stockCode'
    | 'productCode'
    | 'none'
  color?: string
  size?: string
  variantAttributes?: OrderVariantAttribute[]
  productContentId?: string
  productMainId?: string
  productCode?: string
  stockCode?: string
  desi?: number | null
  weightKg?: number | null
  lengthCm?: number | null
  widthCm?: number | null
  heightCm?: number | null
  rawLine?: unknown
}

export interface OrderVariantAttribute {
  name: string
  value: string
}

export interface Shipment {
  id: string
  provider: 'surat-kargo'
  trackingNumber: string
  trackingUrl: string
  shipmentCode: string
  satisKodu?: string
  webSiparisKodu?: string
  ozelKargoTakipNo?: string
  barcodeValue: string
  barcodeSource?: string
  serviceMode?: SuratServiceMode
  operationName?: string
  kargoTakipNo?: string
  tNo?: string
  barcode?: string
  barkodNo?: string
  gonderiNo?: string
  waybillNo?: string
  irsaliyeNo?: string
  cargoKey?: string
  codeCandidates?: SuratCodeCandidates
  codeMapping?: SuratCodeMapping
  verificationStage?: SuratVerificationStage
  errorCategory?: SuratErrorCategory
  technicalZplReceived?: boolean
  operationalBarcodeVerified?: boolean
  finalSuratBarcode?: string
  internalWebBarcode?: string
  zplAnalysis?: SuratZplAnalysis
  requestValidation?: SuratRequestValidation
  trendyolPreflight?: TrendyolShipmentPreflight
  addressNormalization?: AddressNormalizationDebug
  barcodeRaw?: string
  zplSource?:
    | 'surat.ortakBarkod.BarcodeRaw'
    | 'surat.KargoBarkoduSiparis.PdfBarkod'
    | 'generated'
  labelPdfBase64?: string
  pdfBarkodBase64?: string
  pdfLabelSource?: string
  hasPdfBarkod?: boolean
  pdfReady?: boolean
  trackingSource?: string
  carrierStatusKey?: CarrierStatusKey
  carrierStatusLabel?: string
  carrierStatusSource?: 'suratTracking' | 'carrierTracking'
  carrierStatusCode?: string
  carrierStatusUpdatedAt?: string
  statusSource?: 'suratTracking' | 'marketplace' | 'localOperation'
  deliveredAt?: string
  shippedAt?: string
  desi?: number | null
  desiSource?: DesiSource | null
  weightKg?: number | null
  packageCount?: number
  apiRequestDesi?: number | null
  apiResponseDesi?: number | null
  dispatchRegistrationConfirmed?: boolean
  providerRegistrationConfirmed?: boolean
  serdendipVerified?: boolean
  trackingConfirmationPending?: boolean
  dispatchRegistration?: SuratDispatchRegistration
  labelStatus?: LabelStatus
  shipmentStatus?: 'VERIFIED' | 'PENDING' | 'FAILED'
  suratVerificationStatus?: 'VERIFIED' | 'PENDING' | 'FAILED'
  zplReady?: boolean
  printEnabled?: boolean
  matchStatus?: boolean
  statusComputedFrom?:
    | 'ORTAK_BARKOD_SUCCESS'
    | 'SURAT_RESPONSE'
    | 'SURAT_REJECTED'
    | 'TRENDYOL_MARKETPLACE'
  previousStatus?: OperationStatus
  newStatus?: OperationStatus
  previousErrorCleared?: boolean
  tabBucket?:
    | 'ETIKET_BASILACAKLAR'
    | 'BARKOD_BEKLEYENLER'
    | 'SORUNLU_GONDERILER'
    | 'DURUM_UYGUN_DEGIL'
  noTrackingReason?: string
  labelBlockedReason?: string
  zplDisabledReason?: string
  shipmentReference?: string
  status: 'created' | 'cancelled' | 'failed'
  lifecycleStatus?:
    | 'SHIPMENT_CREATED'
    | 'SURAT_CREATED_NO_TRACKING'
    | 'SURAT_TRANSFERRED_BUT_NO_BARCODE'
    | 'SURAT_DISPATCH_REJECTED'
    | 'SURAT_BARCODE_FAILED'
    | 'SURAT_TRACKING_MISSING'
    | 'TECHNICAL_ZPL_RECEIVED'
    | 'ZPL_NOT_OPERATIONALLY_VERIFIED'
    | 'TRACKING_CONFIRMED'
    | 'LABEL_READY'
    | 'FAILED'
  source: ApiDataSource
  rawResponse: unknown
  rawSuratCreateResponse?: unknown
  rawSuratTrackingResponse?: unknown
  suratCreateLog?: SuratCreateLog
  suratTrackingLog?: SuratTrackingLog
  suratOperationalBarcodeLog?: SuratOperationalBarcodeLog
  verifiedShipment?: boolean
  verificationMatchReason?: string
  trendyolCargoTrackingNumber?: string
  suratKargoTakipNo?: string
  extractedKargoTakipNo?: string
  suratTakipUrl?: string
  diagnosticMessage?: string
  createdAt: string
}

export interface SuratOperationalBarcodeLog {
  ok?: boolean
  source?: ApiDataSource
  operationType?: string
  endpoint?: string
  serviceType?: string
  payloadFormat?: 'SOAP/XML'
  statusCode?: number
  responseStatus?: number
  contentType?: string
  orderId?: string
  shipmentId?: string
  queryValue?: string
  KargoTakipNo?: string
  BarkodNo?: string
  BarkodNoList?: string[]
  OzelKargoTakipNo?: string
  Aciklama?: string
  hasPdfBarkod?: boolean
  operationalBarcodeVerified?: boolean
  rawRequest?: unknown
  rawResponse?: unknown
  parsedResponse?: unknown
  attempts?: SuratOperationalBarcodeLog[]
  message?: string
}

export interface SuratDispatchRegistration {
  ok: boolean
  providerRegistrationConfirmed?: boolean
  serdendipVerified?: boolean
  source?: string
  endpoint?: string
  serviceType?: string
  responseStatus?: number
  responseCode?: string
  responseMessage?: string
  duplicateShipment?: boolean
  rawRequest?: unknown
  rawResponse?: unknown
}

export type SuratVerificationStage =
  | 'dispatch_rejected'
  | 'dispatch_registered'
  | 'dispatch_registered_marketplace_barcode'
  | 'technical_zpl_received'
  | 'operational_barcode_verified'
  | 'serdendip_verified'
  | 'tracking_confirmation_missing'
  | 'operational_barcode_missing'
  | 'zpl_received_but_not_operationally_verified'
  | 'failed'

export type SuratErrorCategory =
  | 'TRENDYOL_INTEGRATION_CODE_NOT_FOUND'
  | 'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS'
  | 'TRENDYOL_PICKING_UPDATE_FAILED'
  | 'BAD_REQUEST'
  | 'SURAT_REJECTED'
  | 'MISSING_TRACKING_CODE'
  | 'MISSING_BARCODE'
  | 'TECHNICAL_ZPL_ONLY'
  | 'WEB_BARCODE_NOT_FINAL'
  | 'MISSING_NUMERIC_SURAT_BARCODE'
  | 'MISSING_TNO'
  | 'AUTH_OR_CONTRACT_MISMATCH'
  | 'OPERATIONAL_VERIFICATION_FAILED'
  | 'SURAT_OPERATIONAL_BARCODE_MISSING'
  | 'SURAT_WEB_PASSWORD_INVALID_OR_PERMISSION_MISSING'
  | ''

export interface SuratZplAnalysis {
  hasBarcodeRaw: boolean
  allFdValues: string[]
  mainCode128Candidates: string[]
  qrCandidates: string[]
  dataMatrixCandidates: string[]
  numericBarcodeCandidates: string[]
  webBarcodeCandidates: string[]
  tNoCandidates: string[]
  siparisNoCandidates: string[]
  referenceNoCandidates: string[]
  routeTransferText: string[]
  destinationText: string[]
  acceptedFinalBarcode: string
  acceptedTNo: string
  internalWebBarcode: string
  rejectionReason: string
}

export interface SuratValidationItem {
  field: string
  status: 'OK' | 'EMPTY' | 'FALLBACK' | 'SUSPICIOUS' | 'ERROR' | 'WARNING'
  message: string
  value?: string | number | boolean | null
}

export interface SuratRequestValidation {
  ok: boolean
  items: SuratValidationItem[]
}

export interface AddressNormalizationDebug {
  originalAddress: string
  normalizedAddress: string
  duplicateDetected: boolean
}

export interface TrendyolShipmentPreflight {
  ok: boolean
  canCallSurat: boolean
  reason: string
  orderNumber: string
  packageId: string
  shipmentPackageId: string
  cargoTrackingNumber: string
  cargoProviderName: string
  cargoProviderId: string
  cargoCompanyId: string
  marketplaceStatus: string
  packageStatus: string
  orderLineItemStatusName: string
  cargoTrackingLink: string
  existingCargoTrackingNumber: string
  shipmentStatus: string
  isCancelled: boolean
  isDelivered: boolean
  isShipped: boolean
  isReadyToShip: boolean | null
  suratAssigned: boolean | null
  hasCargoTrackingNumber: boolean
  existingShipmentDetected: boolean
  canCallGonderiyiKargoyaGonder: boolean
  requiresPickingUpdate?: boolean
  pickingUpdatePerformed?: boolean
  pickingUpdate?: unknown
  diagnostics: string[]
}

export interface SuratCodeCandidates {
  takipNo?: string
  kargoTakipNo?: string
  barkod?: string
  barkodNo?: string
  gonderiNo?: string
  waybillNo?: string
  irsaliyeNo?: string
  cargoKey?: string
  trackingNumber?: string
  barcode?: string
  TNo?: string
  [field: string]: string | undefined
}

export interface SuratCodeMapping {
  trackingField: string
  barcodeField: string
  tNoField: string
  trackingValue: string
  barcodeValue: string
  tNoValue: string
}

export interface SuratCreateLog {
  rawRequest: unknown
  rawResponse: unknown
  responseStatus: number
  status?: number
  contentType: string
  parsedResponse: unknown
  createdAt: string
  orderId: string
  shipmentId: string
  serviceType?: string
  serviceMode?: SuratServiceMode
  operationName?: string
  endpoint?: string
  payloadFormat?: 'JSON' | 'SOAP/XML'
  responseCode?: string
  responseMessage?: string
  barcodeResponseCodeDetected?: boolean
  hasTrackingNumber?: boolean
  hasBarcode?: boolean
  verifiedShipment?: boolean
  KargoTakipNo?: string
  Barcode?: string
  BarcodeRaw?: string
  barcodeSource?: string
  trackingSource?: string
  codeCandidates?: SuratCodeCandidates
  codeMapping?: SuratCodeMapping
  verificationStage?: SuratVerificationStage
  errorCategory?: SuratErrorCategory
  zplAnalysis?: SuratZplAnalysis
  requestValidation?: SuratRequestValidation
  trendyolPreflight?: TrendyolShipmentPreflight
  addressNormalization?: AddressNormalizationDebug
  rawRequestIncludesOrtakBarkodOlustur?: boolean
  rawRequestIncludesGonderiyiKargoyaGonder?: boolean
  rawRequestContainsExpectedOperation?: boolean
  rawRequestContainsLegacyOperation?: boolean
  wrongServiceCalled?: boolean
  preRegistrationOnly?: boolean
  duplicateShipment?: boolean
  noTrackingReason?: string
  requestReference?: string
  phoneWarning?: string
}

export interface SuratTrackingLog {
  rawRequest: unknown
  rawResponse: unknown
  rawSuratResponse?: unknown
  parsedResponse: unknown
  KargoTakipNo: string
  TakipNo?: string
  TNo?: string
  BarkodNo?: string
  Barkod?: string
  GonderiNo?: string
  WaybillNo?: string
  IrsaliyeNo?: string
  CargoKey?: string
  TakipUrl: string
  TakipUrlTrackingNo?: string
  TakipUrlTrackingSource?: string
  extractedKargoTakipNo?: string
  KargonunDurumu: string
  KargonunDurumuSayi?: string
  KargonunBulunduguYer?: string
  SonHareketTarihi?: string
  TeslimatSubesi?: string
  TeslimatSubeTel?: string
  IadeDurum?: string
  DevirDurum?: string
  carrierStatusKey?: CarrierStatusKey
  carrierStatusLabel?: string
  Satiskodu: string
  SatisKodu?: string
  WebSiparisKodu?: string
  OzelKargoTakipNo?: string
  KargoObjId: string
  SeriNo: string
  SiraNo: string
  Hareketler: unknown
  Gonderiler?: unknown[]
  responseStatus?: number
  status?: number
  contentType?: string
  createdAt?: string
  orderId?: string
  shipmentId?: string
  serviceType?: string
  endpoint?: string
  payloadFormat?: 'JSON' | 'SOAP/XML'
  gonderilerLength?: number
  isError?: boolean
  errorMessage?: string
  trackingState?: OperationStatus
  trackingAttempts?: unknown[]
}

export type SuratBarcodeSourceOption =
  | 'auto'
  | 'BarkodNo'
  | 'Barkod'
  | 'Barcode'

export interface SuratLabelMappingConfig {
  barcodeSourceOverride?: SuratBarcodeSourceOption
}

export interface LabelPreviewOverrides {
  branchName?: string
  recipientName?: string
  trackingNumber?: string
  barcodeValue?: string
  leftReference?: string
  routeCenter?: string
  transferCenter?: string
  productTitle?: string
  productMeta?: string
  desi?: number | null
  desiSource?: DesiSource | null
}

export interface LabelTypographyConfig {
  headerName: number
  address: number
  route: number
  cargoValue: number
  deliveryTitle: number
  deliveryRoute: number
  transfer: number
  productTitle: number
  productMeta: number
}

export interface Label {
  id: string
  labelType: 'zpl' | 'pdf'
  barcodeFormat: 'Code128'
  barcodeValue: string
  templateId: string
  zplContent: string
  zplSource?: 'surat.ortakBarkod.BarcodeRaw' | 'generated'
  createdAt: string
  printedAt?: string
  printedBy?: string
  lastPrintedAt?: string
  lastPrintedBy?: string
  printJobId?: string
  lastPrintJobId?: string
  printSource?: 'surat.ortakBarkod.BarcodeRaw' | 'generated'
  printCount?: number
  printHistory?: PrintHistoryEntry[]
  printDebug?: PrintDebug
  desi?: number | null
  desiSource?: DesiSource | null
  desiDebug?: DesiDebug
  desiMismatchWarning?: string
}

export interface DesiDebug {
  orderId: string
  productDesi: number | null
  calculatedDesi: number | null
  manualDesi: number | null
  apiRequestDesi: number | null
  apiResponseDesi: number | null
  finalNormalizedDesi: number | null
  zplPrintedDesi: number | null
  desiSource: DesiSource | null
}

export interface PrintHistoryEntry {
  type: 'PRINT' | 'REPRINT'
  printedAt: string
  printedBy: string
  printJobId?: string
  printerName: string
  zplSource: 'surat.ortakBarkod.BarcodeRaw' | 'generated'
  reason: string
}

export interface PrintDebug {
  printRequestedAt: string
  printConfirmedAt?: string
  printProvider: string
  printerName: string
  printJobId?: string
  printResult?: unknown
  printError?: string
  zplSource: 'surat.ortakBarkod.BarcodeRaw' | 'generated'
  zplLength: number
  labelStatusBefore?: LabelStatus
  labelStatusAfter?: LabelStatus
  isReprint: boolean
  printCountBefore: number
  printCountAfter: number
  printedAt?: string
  lastPrintedAt?: string
  printHistory: PrintHistoryEntry[]
  browserPrintDebug?: {
    printRequested: boolean
    printMode: 'chrome-html' | 'zpl-native' | 'test-label'
    labelHtmlGenerated: boolean
    labelHtmlLength: number
    barcodeValue: string
    zplAvailable: boolean
    printableContentPreview: string
    printWindowOpened: boolean
    printCalled: boolean
    rejectionReason?: string
  }
}

export interface CargoOrder {
  id: string
  marketplace: MarketplaceName
  externalOrderId: string
  orderNumber: string
  packageId?: string
  shipmentPackageId?: string
  customerFirstName?: string
  customerLastName?: string
  marketplaceStatus: MarketplaceStatus
  operationStatus: OperationStatus
  labelStatus?: LabelStatus
  source: ApiDataSource
  status: OrderStatus
  customerName: string
  customerPhone: string
  customerEmail: string
  shipmentAddress?: unknown
  address: string
  city: string
  district: string
  cargoProviderName?: string
  cargoProviderId?: string
  cargoCompanyId?: string
  cargoTrackingNumber?: string
  cargoTrackingLink?: string
  packageStatus?: string
  shipmentStatusName?: string
  isReadyToShip?: boolean | null
  paymentType?: string
  paymentMode?: string
  isCashOnDelivery?: boolean
  cashOnDeliveryAmount?: number | null
  codAmount?: number | null
  rawOrder?: unknown
  totalAmount: number
  totalPrice?: number
  createdAt: string
  orderDate?: string
  lastMarketplaceSyncedAt?: string
  lastMarketplaceSyncBatchId?: string
  deliveryDate?: string
  desi?: number | null
  desiSource?: DesiSource | null
  weightKg?: number | null
  packageCount?: number
  items: OrderItem[]
  shipment?: Shipment
  label?: Label
  shipmentStatus?: 'VERIFIED' | 'PENDING' | 'FAILED'
  suratVerificationStatus?: 'VERIFIED' | 'PENDING' | 'FAILED'
  zplReady?: boolean
  printEnabled?: boolean
  matchStatus?: boolean
  matchReason?: string
  error?: string
  errorMessage?: string
  noTrackingReason?: string
  labelBlockedReason?: string
  zplDisabledReason?: string
  printMigrationNote?: string
  archived?: boolean
  archivedAt?: string
  archivedReason?: string
}

export interface CargoProduct {
  id: string
  marketplace: MarketplaceName
  externalProductId?: string
  productContentId?: string
  productMainId?: string
  productCode?: string
  productName: string
  sku: string
  stockCode?: string
  barcode: string
  category?: string
  brand?: string
  color?: string
  size?: string
  desi?: number
  kg?: number
  weightKg?: number
  lengthCm?: number
  widthCm?: number
  heightCm?: number
  imageUrl?: string
  productImageUrl?: string
  images?: string[]
  stock: number
  price: number
  productStatus?: string
  source: ApiDataSource
  createdAt?: string
  updatedAt: string
}

export interface TrendyolIntegrationConfig {
  sellerId: string
  apiKey: string
  apiSecret: string
  environment: 'prod' | 'stage'
  userAgentName: string
  storeFrontCode?: string
}

export interface SuratIntegrationConfig {
  kullaniciAdi: string
  sifre: string
  webPassword?: string
  sellerPaysKullaniciAdi?: string
  sellerPaysSifre?: string
  sellerPaysWebPassword?: string
  codKullaniciAdi?: string
  codSifre?: string
  codWebPassword?: string
  firmaId: string
  testKullaniciAdi?: string
  testSifre?: string
  testWebPassword?: string
  testFirmaId?: string
  liveKullaniciAdi?: string
  liveSifre?: string
  liveWebPassword?: string
  liveFirmaId?: string
  entegrasyonSozlesme?: string
  entegrasyonMusteri?: string
  entegrasyonFirmasi?: string
  whoPays?: string
  odemeTipi?: string
  kWebGonderiGirisiKaynak?: string
  ortam: 'test' | 'live'
  serviceMode: SuratServiceMode
  serviceType:
    | 'KargoBarkoduSiparisSoap'
    | 'OrtakBarkodOlusturSoap'
    | 'GonderiyiKargoyaGonderRestJson'
    | 'GonderiOlusturV2'
    | 'GonderiyiKargoyaGonderLegacy'
  createShipmentPath:
    | '/api/KargoBarkoduSiparis'
    | '/api/OrtakBarkodOlustur'
    | '/api/GonderiyiKargoyaGonder'
    | '/api/Gonderi/GonderiOlustur'
  trackingServiceType:
    | 'KargoTakipHareketDetayiSoap'
    | 'KargoTakipHareketDetayiRest'
  trackingPath: '/api/KargoTakipHareketDetayi'
  trackingCodeField: string
  barcodeCodeField: string
  tNoCodeField: string
  trackingVerificationDelaysMs?: number[]
}

export interface IntegrationConfig {
  trendyol: TrendyolIntegrationConfig
  surat: SuratIntegrationConfig
}

export interface PrinterSettings {
  printerName: string
  mode: 'browser-print' | 'download' | 'local-agent'
  labelSize: '100x100' | '100x150'
  defaultFormat: 'zpl' | 'pdf'
}

export type LabelFieldKey =
  | 'marketplace'
  | 'orderNumber'
  | 'shippingProvider'
  | 'customerName'
  | 'customerPhone'
  | 'cityDistrict'
  | 'address'
  | 'productName'
  | 'quantity'
  | 'trackingNumber'
  | 'shipmentCode'

export interface LabelFieldConfig {
  key: LabelFieldKey
  label: string
  visible: boolean
  order: number
}

export interface LabelTemplate {
  id: string
  name: string
  widthMm: number
  heightMm: number
  widthDots: number
  heightDots: number
  barcodeX: number
  barcodeY: number
  barcodeModuleWidth: number
  barcodeHeight: number
  fontSize: number
  lineGap: number
  fieldStartX: number
  fieldStartY: number
  typography?: LabelTypographyConfig
  fields: LabelFieldConfig[]
  updatedAt: string
}

export interface AuditLog {
  id: string
  action: AuditAction
  level: AuditLevel
  details: string
  orderNumber?: string
  createdAt: string
}

export type ApiDebugProvider = 'Trendyol' | 'Sürat'
export type ApiDebugStatus = 'SUCCESS' | 'ERROR'

export interface ApiDebugLog {
  id: string
  timestamp: string
  provider: ApiDebugProvider
  operation: string
  button?: 'Sürat Gönderisi Oluştur' | 'Takip Sorgula' | string
  buttonName?: 'Sürat Gönderisi Oluştur' | 'Takip Sorgula' | string
  providerMethod?: string
  endpoint: string
  requestUrl: string
  requestHeaders?: unknown
  requestBody?: unknown
  responseStatus: number
  responseBody?: unknown
  rawResponse?: unknown
  status: ApiDebugStatus
  durationMs: number
  orderNumber?: string
  shipmentId?: string
  fields?: Record<string, unknown>
  errorMessage?: string
  errorSource?: 'Trendyol' | 'Sürat' | 'Frontend'
}

export interface WorkflowResult {
  message: string
  level: AuditLevel
  source?: ApiDataSource
  debug?: TrendyolOrderDebug
  bulkActionDebug?: BulkActionDebug
}

export interface BulkActionDebug {
  actionType: string
  selectedCount: number
  readyCount: number
  missingBarcodeCount: number
  printedCount: number
  reprintCount: number
  errorCount: number
  labelsWithBarcodeRaw: number
  labelsWithoutBarcodeRaw: number
  processedOrderNumbers: string[]
  failedOrderNumbers: string[]
  skippedOrderNumbers: string[]
  skippedReasons: string[]
}

export interface TrendyolOrderDebug {
  rawOrdersCount: number
  normalizedOrdersCount: number
  duplicateRemovedCount: number
  totalLineCount: number
  totalQuantity: number
}

export interface IntegrationTestResult {
  provider: 'trendyol' | 'surat-kargo'
  ok: boolean
  source: ApiDataSource
  message: string
  checkedAt: string
  statusCode?: number
  rawPreview?: unknown
}
