import type {
  CargoOrder,
  Label,
  LabelTemplate,
  Shipment,
  SuratLabelMappingConfig,
} from '../../types/cargoflow'

export interface GenerateLabelInput {
  order: CargoOrder
  shipment: Shipment
  template: LabelTemplate
  mappingConfig?: SuratLabelMappingConfig
}

export interface LabelProvider {
  generateSingle(input: GenerateLabelInput): Promise<Label>
  generateBatch(input: GenerateLabelInput[]): Promise<Label[]>
}
