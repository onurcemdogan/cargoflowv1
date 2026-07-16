import type {
  CargoOrder,
  LabelPreviewOverrides,
  LabelTemplate,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import { buildLabelData, type LabelData } from '../utils/labelData'
import { LabelHtmlPreview } from './LabelHtmlPreview'

interface LabelPreviewCardProps {
  order?: CargoOrder
  labelData?: LabelData
  template?: LabelTemplate
  mappingConfig?: SuratLabelMappingConfig
  overrides?: LabelPreviewOverrides
  compact?: boolean
}

export function LabelPreviewCard({
  order,
  labelData,
  template,
  mappingConfig,
  overrides,
  compact = false,
}: LabelPreviewCardProps) {
  const data =
    labelData ??
    buildLabelData(order, order?.shipment, template, mappingConfig)

  return (
    <div className={compact ? 'label-preview-card compact' : 'label-preview-card'}>
      <LabelHtmlPreview
        order={order}
        labelData={data}
        template={template}
        mappingConfig={mappingConfig}
        overrides={overrides}
        compact={compact}
      />
    </div>
  )
}
