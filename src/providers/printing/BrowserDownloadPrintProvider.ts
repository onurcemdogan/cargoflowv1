import type { PrintInput, PrintProvider, PrintResult } from './PrintProvider'
import { defaultLabelTemplate } from '../../services/integrationConfigService'
import {
  BrowserLabelPrintError,
  printCleanLabelDocument,
} from '../../utils/browserLabelPrint'
import {
  NOT_IN_PRINT_DOCUMENT_MESSAGE,
  PRINT_CONFIRMATION_QUESTION,
  PRINT_NOT_CONFIRMED_MESSAGE,
} from '../../utils/suratPrintFailureReasons'

// Baskı onayı: browser-print yolunda print dialog kapandıktan SONRA sorulur.
// Enjekte edilebilir olmasının tek nedeni testlerde gerçek dialog açmamaktır;
// varsayılan davranış tarayıcının kendi onayıdır.
export type PrintConfirmFn = (question: string) => boolean

export interface BrowserPrintJobDecision {
  jobs: NonNullable<PrintResult['jobs']>
  confirmed: boolean
}

// Browser-print job sonuçları — SAF karar. Başarı üç koşulun HEPSİNİ ister:
//   (1) print gerçekten çağrıldı, (2) sipariş belgeye GERÇEKTEN girdi,
//   (3) kullanıcı çıktıyı onayladı.
// Dialog açılması / printCalled TEK BAŞINA başarı DEĞİLDİR.
export function resolveBrowserPrintJobs(
  debug:
    | {
        printCalled?: boolean
        printedOrderNumbers?: string[]
        skipped?: Array<{ orderNumber: string; reason: string }>
        rejectionReason?: string
      }
    | undefined,
  orderNumbers: string[],
  confirm: PrintConfirmFn,
): BrowserPrintJobDecision {
  const rendered = new Set(debug?.printedOrderNumbers ?? [])
  const skipReason = new Map(
    (debug?.skipped ?? []).map((item) => [item.orderNumber, item.reason]),
  )
  const anyRendered = orderNumbers.some((orderNumber) =>
    rendered.has(orderNumber),
  )
  const confirmed = Boolean(debug?.printCalled) && anyRendered
    ? confirm(PRINT_CONFIRMATION_QUESTION)
    : false
  const jobs = orderNumbers.map((orderNumber) => {
    const inDocument = rendered.has(orderNumber)
    const ok = inDocument && confirmed
    if (ok) {
      return {
        orderNumber,
        ok: true,
        printJobId: `browser-${orderNumber}-${Date.now()}`,
      }
    }
    return {
      orderNumber,
      ok: false,
      errorMessage: inDocument
        ? PRINT_NOT_CONFIRMED_MESSAGE
        : skipReason.get(orderNumber) ??
          debug?.rejectionReason ??
          NOT_IN_PRINT_DOCUMENT_MESSAGE,
    }
  })
  return { jobs, confirmed }
}

function defaultPrintConfirm(question: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    // Onay soramıyorsak baskıyı BAŞARILI SAYMAYIZ.
    return false
  }
  return window.confirm(question)
}

export class BrowserDownloadPrintProvider implements PrintProvider {
  private readonly confirmPrint: PrintConfirmFn

  constructor(confirmPrint: PrintConfirmFn = defaultPrintConfirm) {
    this.confirmPrint = confirmPrint
  }

  async print(input: PrintInput): Promise<PrintResult> {
    const printableOrders = input.orders.filter((order) => order.label)
    const content = printableOrders
      .map((order) => order.label?.zplContent)
      .filter(Boolean)
      .join('\n')
    const suffix =
      printableOrders.length === 1 ? printableOrders[0].orderNumber : 'toplu'
    const fileName = `cargoflow-${suffix}.zpl`

    if (input.action === 'download') {
      return {
        fileName,
        content,
        status: 'download_required',
        ok: true,
        provider: 'browser-download',
        printerName: input.printerSettings.printerName,
      }
    }

    if (input.printerSettings.mode === 'browser-print') {
      try {
        const browserPrintDebug = await printCleanLabelDocument(
          printableOrders,
          input.labelTemplate ?? defaultLabelTemplate,
          input.mappingConfig,
        )
        const decision = resolveBrowserPrintJobs(
          browserPrintDebug,
          printableOrders.map((order) => order.orderNumber),
          this.confirmPrint,
        )
        return {
          fileName,
          content,
          status: decision.confirmed ? 'queued' : 'failed',
          ok: decision.confirmed,
          provider: 'browser-label-document',
          printerName: input.printerSettings.printerName,
          printJobId: `browser-${Date.now()}`,
          browserPrintDebug,
          jobs: decision.jobs,
        }
      } catch (error) {
        const browserPrintDebug =
          error instanceof BrowserLabelPrintError ? error.debug : undefined
        const reason =
          error instanceof Error
            ? error.message
            : 'Temiz etiket baskı belgesi oluşturulamadı.'
        return {
          fileName,
          content,
          status: 'failed',
          ok: false,
          provider: 'browser-label-document',
          printerName: input.printerSettings.printerName,
          browserPrintDebug,
          errorMessage: reason,
          // Hata dalinda da SIPARIS BAZINDA sebep tasinir; bos jobs[] her
          // siparisi generic "Baski dogrulanmadi" mesajina dusuruyordu.
          jobs: printableOrders.map((order) => ({
            orderNumber: order.orderNumber,
            ok: false,
            errorMessage: reason,
          })),
        }
      }
    }

    if (input.printerSettings.mode === 'download') {
      return {
        fileName,
        content,
        status: 'download_required',
        ok: true,
        provider: 'browser-download',
        printerName: input.printerSettings.printerName,
      }
    }

    try {
      const response = await fetch('/api/printing/zebra/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerName: input.printerSettings.printerName,
          labels: printableOrders.map((order) => ({
            orderNumber: order.orderNumber,
            zpl: order.label?.zplContent,
          })),
        }),
      })
      const data = await response.json()
      return {
        fileName,
        content,
        status: data.ok ? 'printed' : 'failed',
        ok: Boolean(response.ok && data.ok),
        provider: data.provider ?? 'zebra-local-agent',
        printerName: input.printerSettings.printerName,
        printJobId: data.printJobId,
        errorMessage: data.ok ? undefined : data.message,
        jobs: data.jobs,
      }
    } catch (error) {
      return {
        fileName,
        content,
        status: 'failed',
        ok: false,
        provider: 'zebra-local-agent',
        printerName: input.printerSettings.printerName,
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Zebra yazdırma servisine erişilemedi.',
      }
    }
  }
}
