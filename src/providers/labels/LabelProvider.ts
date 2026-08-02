import type {
  CargoOrder,
  CargoProduct,
  Label,
  LabelTemplate,
  Shipment,
  SuratLabelMappingConfig,
  TenantDesiConfig,
} from '../../types/cargoflow'

export interface GenerateLabelInput {
  order: CargoOrder
  shipment: Shipment
  template: LabelTemplate
  mappingConfig?: SuratLabelMappingConfig
  // Ayarlar → "Varsayılan Gönderi Desisi". YENİ etiketin desisi buradan
  // (mevcut çarpan sözleşmesiyle) hesaplanır; kullanıcı sipariş bazında desi
  // GİRMEZ. Verilmezse yalnız kayıtlı/geçmiş desi kullanılabilir.
  desiConfig?: TenantDesiConfig
  // Satır bazlı desi çözümü için ürün kataloğu (ürün/varyant desisi).
  products?: CargoProduct[]
}

export interface LabelProvider {
  generateSingle(input: GenerateLabelInput): Promise<Label>
  generateBatch(input: GenerateLabelInput[]): Promise<Label[]>
}
