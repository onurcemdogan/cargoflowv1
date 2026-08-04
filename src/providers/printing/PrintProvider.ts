import type {
  CargoOrder,
  LabelTemplate,
  PrinterSettings,
  SuratLabelMappingConfig,
} from '../../types/cargoflow'
import type { BrowserLabelPrintDebug } from '../../utils/browserLabelPrint'

// Bekleyen baskı doğrulaması — YALNIZ UI modeli. PII (müşteri adı/adres/
// telefon), ürün açıklaması, ZPL veya provider payload TAŞIMAZ. Yeni bir
// backend lifecycle/status DEĞİLDİR.
export interface PendingPrintConfirmationRequest {
  provider: 'browser-print'
  /** Baskıya gönderilen tüm sipariş numaraları. */
  orderNumbers: string[]
  /** Baskı belgesine GERÇEKTEN giren sipariş numaraları (doğrulama grubu). */
  documentOrderNumbers: string[]
  /** Render sırasında atlananlar (güvenli sebep). */
  skipped: Array<{ orderNumber: string; reason: string }>
}

export interface PrintInput {
  orders: CargoOrder[]
  /**
   * Browser-print yolunda baskı doğrulaması. BLOKLAYAN dialog DEĞİL: çağıran
   * katman inline panelden gelen cevabı bu söz ile çözer. Verilmezse onay
   * ALINMAMIŞ sayılır.
   */
  confirmBrowserPrint?: (
    request: PendingPrintConfirmationRequest,
  ) => Promise<boolean>
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
