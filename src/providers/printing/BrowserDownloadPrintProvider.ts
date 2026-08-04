import type { PrintInput, PrintProvider, PrintResult } from './PrintProvider'
import { defaultLabelTemplate } from '../../services/integrationConfigService'
import {
  BrowserLabelPrintError,
  printCleanLabelDocument,
} from '../../utils/browserLabelPrint'
import {
  NOT_IN_PRINT_DOCUMENT_MESSAGE,
  PRINT_NOT_CONFIRMED_MESSAGE,
} from '../../utils/suratPrintFailureReasons'

// Baskı onayı browser-print yolunda print dialogu kapandıktan SONRA istenir.
// BLOKLAYAN window.confirm/alert KULLANILMAZ: onay, çağıran katmanın verdiği
// asenkron bir söz (inline UI paneli) ile alınır. Onay sağlanmazsa baskı
// BAŞARILI SAYILMAZ — sessiz "evet" YOKTUR.
export interface BrowserPrintJobDecision {
  jobs: NonNullable<PrintResult['jobs']>
  confirmed: boolean
}

export interface BrowserPrintDebugLike {
  printCalled?: boolean
  printedOrderNumbers?: string[]
  skipped?: Array<{ orderNumber: string; reason: string }>
  rejectionReason?: string
}

// Onay YALNIZ gerçekten belgeye giren iş varsa istenir. Hiçbir sipariş belgeye
// girmediyse kullanıcıya soru SORULMAZ (ve hiçbir şey başarılı olmaz).
export function shouldRequestPrintConfirmation(
  debug: BrowserPrintDebugLike | undefined,
  orderNumbers: string[],
): boolean {
  const rendered = new Set(debug?.printedOrderNumbers ?? [])
  return (
    Boolean(debug?.printCalled) &&
    orderNumbers.some((orderNumber) => rendered.has(orderNumber))
  )
}

// Belgeye GERÇEKTEN giren sipariş numaraları (doğrulama grubu).
export function resolvePrintDocumentOrderNumbers(
  debug: BrowserPrintDebugLike | undefined,
  orderNumbers: string[],
): string[] {
  const rendered = new Set(debug?.printedOrderNumbers ?? [])
  return orderNumbers.filter((orderNumber) => rendered.has(orderNumber))
}

// Browser-print job sonuçları — SAF karar. Başarı üç koşulun HEPSİNİ ister:
//   (1) print gerçekten çağrıldı, (2) sipariş belgeye GERÇEKTEN girdi,
//   (3) kullanıcı çıktıyı onayladı.
// Dialog açılması / printCalled TEK BAŞINA başarı DEĞİLDİR.
export function resolveBrowserPrintJobs(
  debug: BrowserPrintDebugLike | undefined,
  orderNumbers: string[],
  userConfirmed: boolean,
): BrowserPrintJobDecision {
  const rendered = new Set(debug?.printedOrderNumbers ?? [])
  const skipReason = new Map(
    (debug?.skipped ?? []).map((item) => [item.orderNumber, item.reason]),
  )
  const confirmed =
    shouldRequestPrintConfirmation(debug, orderNumbers) && userConfirmed
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

export class BrowserDownloadPrintProvider implements PrintProvider {
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
        const orderNumbers = printableOrders.map((order) => order.orderNumber)
        // Onay: BLOKLAMAYAN inline panel. Çağıran katman sağlamazsa onay
        // ALINMAMIŞ sayılır; hiçbir sipariş sessizce PRINTED olmaz.
        const userConfirmed =
          shouldRequestPrintConfirmation(browserPrintDebug, orderNumbers) &&
          typeof input.confirmBrowserPrint === 'function'
            ? await input.confirmBrowserPrint({
                provider: 'browser-print',
                orderNumbers,
                documentOrderNumbers: resolvePrintDocumentOrderNumbers(
                  browserPrintDebug,
                  orderNumbers,
                ),
                skipped: browserPrintDebug.skipped ?? [],
              })
            : false
        const decision = resolveBrowserPrintJobs(
          browserPrintDebug,
          orderNumbers,
          userConfirmed,
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
