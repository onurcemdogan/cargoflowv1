import type {
  CargoOrder,
  CargoProduct,
  LabelTemplate,
  PrinterSettings,
  SuratLabelMappingConfig,
} from '../../types/cargoflow'
import type { BrowserLabelPrintDebug } from '../../utils/browserLabelPrint'
import type { LabelPrintTemplate } from '../../utils/labelPrintTemplateRouting'
import type { LabelDocument } from '../../labels/labelDocument'

export interface PrintInput {
  orders: CargoOrder[]
  printerSettings: PrinterSettings
  action: 'download' | 'print'
  requestedAt?: string
  confirmedAt?: string
  labelTemplate?: LabelTemplate
  mappingConfig?: SuratLabelMappingConfig
  // Bu çalışmada kullanılacak baskı şablonu. Verilmezse mevcut davranış:
  // CargoFlow HTML. Yalnız browser-print modunda anlamlıdır.
  labelPrintTemplate?: LabelPrintTemplate
  /**
   * Kiracının YAYINLADIĞI yerleşim belgesi (CargoFlow HTML etiketi).
   *
   * Verilmezse yerleşik sabit yerleşim kullanılır — bir sürüm yükseltmesi
   * hiçbir kiracının etiketini kendiliğinden değiştirmez. Resmî Sürat ZPL
   * yolunu ETKİLEMEZ: onun gövdesini taşıyıcı basar.
   */
  labelDocument?: LabelDocument
  // Organizasyon kapsamli urun katalogu (etiket renk/beden tamamlama icin).
  // Saglanmazsa davranis eskisi gibidir: yalniz siparis satiri verisi kullanilir.
  products?: CargoProduct[]
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
