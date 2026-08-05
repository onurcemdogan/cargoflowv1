import type {
  CargoOrder,
  LabelTemplate,
  PrinterSettings,
  SuratLabelMappingConfig,
} from '../../types/cargoflow'
import type { BrowserLabelPrintDebug } from '../../utils/browserLabelPrint'

export interface PrintInput {
  orders: CargoOrder[]
  printerSettings: PrinterSettings
  action: 'download' | 'print'
  requestedAt?: string
  confirmedAt?: string
  labelTemplate?: LabelTemplate
  mappingConfig?: SuratLabelMappingConfig
}

export interface PrintResult {
  fileName: string
  content: string
  status: 'download_required' | 'queued' | 'printed' | 'failed'
  ok: boolean
  provider: string
  printerName: string
  printJobId?: string
  errorMessage?: string
  browserPrintDebug?: BrowserLabelPrintDebug
  jobs?: Array<{
    orderNumber: string
    printJobId?: string
    ok: boolean
    errorMessage?: string
  }>
}

export interface PrintProvider {
  print(input: PrintInput): Promise<PrintResult>
}
