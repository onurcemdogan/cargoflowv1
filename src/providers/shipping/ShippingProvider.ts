import type {
  CargoOrder,
  IntegrationConfig,
  Label,
  LabelTemplate,
  Shipment,
  SuratTrackingLog,
} from '../../types/cargoflow'

export interface CreateShipmentInput {
  order: CargoOrder
  config: IntegrationConfig
}

export interface TrackingResult {
  trackingNumber: string
  status: string
  movements: Array<{
    date: string
    location: string
    description: string
  }>
}

export interface TrackShipmentInput {
  order: CargoOrder
  shipment: Shipment
  config: IntegrationConfig
}

export interface SuratTrackingFields {
  [key: string]: unknown
  KargoTakipNo?: string
  extractedKargoTakipNo?: string
  TakipUrlTrackingNo?: string
  TakipUrlTrackingSource?: string
  TakipNo?: string
  TNo?: string
  BarkodNo?: string
  Barkod?: string
  TakipUrl?: string
  KargonunDurumu?: string
  KargonunDurumuSayi?: string
  KargonunBulunduguYer?: string
  SonHareketTarihi?: string
  TeslimatSubesi?: string
  TeslimatSubeTel?: string
  IadeDurum?: string
  DevirDurum?: string
}

export interface TrackShipmentResponse {
  trackingReference: string
  responseStatus: number
  data: {
    ok?: boolean
    message?: string
    errorSource?: 'Trendyol' | 'Sürat' | 'Frontend'
    providerMethod?: string
    endpoint?: string
    statusCode?: number
    rawRequest?: unknown
    rawResponse?: unknown
    tracking?: SuratTrackingFields
    suratTrackingLog?: SuratTrackingLog
    trackingState?: string
    gonderilerLength?: number
    trackingAttempts?: unknown[]
    trackingReference?: string
    verificationPersistence?: {
      verificationStatus?:
        | 'VERIFIED'
        | 'LABEL_CREATED_UNVERIFIED'
        | 'LABEL_CREATED_NOT_REGISTERED'
      status?: 'SUCCESS' | 'FAILED_SAFE' | 'UNKNOWN' | 'IN_PROGRESS'
      lastCheckedAt?: string
      lastGonderilerLength?: number
      verificationReferenceType?: 'WEB_SIPARIS_KODU'
      candidateTrackingNumber?: string
      candidateBarcodeNumber?: string
      carrierTrackingNumber?: string
      carrierBarcodeNumber?: string
    }
    carrierStatus?: {
      key?: string
      label?: string
      operationStatus?: string
    }
  }
}

export interface ShippingProvider {
  createShipment(input: CreateShipmentInput): Promise<Shipment>
  trackShipment(input: TrackShipmentInput): Promise<TrackShipmentResponse>
  getTracking(trackingNumber: string): Promise<TrackingResult>
  cancelShipment(shipment: Shipment): Promise<Shipment>
  generateLabel(
    order: CargoOrder,
    shipment: Shipment,
    template: LabelTemplate,
  ): Promise<Label>
}
