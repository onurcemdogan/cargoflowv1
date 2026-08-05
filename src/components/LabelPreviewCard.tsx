import type {
  CargoOrder,
  CargoProduct,
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
  // Organizasyon kapsamli urun katalogu. Baski tarafiyla AYNI veriyi
  // kullanmak icin verilir; onizleme ve etiket ASLA farkli renk/beden
  // gosteremez.
  products?: CargoProduct[]
}

export function LabelPreviewCard({
  order,
  labelData,
  template,
  mappingConfig,
  overrides,
  compact = false,
  products = [],
}: LabelPreviewCardProps) {
  const data =
    labelData ??
    buildLabelData(order, order?.shipment, template, mappingConfig, products)

  return (
    <div className={compact ? 'label-preview-card compact' : 'label-preview-card'}>
      <LabelHtmlPreview
        order={order}
        labelData={data}
        template={template}
        mappingConfig={mappingConfig}
        overrides={overrides}
        compact={compact}
        products={products}
      />
    </div>
  )
}
