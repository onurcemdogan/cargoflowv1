import type { PrintInput, PrintProvider, PrintResult } from './PrintProvider'
import { defaultLabelTemplate } from '../../services/integrationConfigService'
import {
  BrowserLabelPrintError,
  printCleanLabelDocument,
} from '../../utils/browserLabelPrint'

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
        return {
          fileName,
          content,
          status: 'queued',
          ok: true,
          provider: 'browser-label-document',
          printerName: input.printerSettings.printerName,
          printJobId: `browser-${Date.now()}`,
          browserPrintDebug,
          jobs: printableOrders.map((order) => ({
            orderNumber: order.orderNumber,
            ok: true,
            printJobId: `browser-${order.orderNumber}-${Date.now()}`,
          })),
        }
      } catch (error) {
        const browserPrintDebug =
          error instanceof BrowserLabelPrintError ? error.debug : undefined
        return {
          fileName,
          content,
          status: 'failed',
          ok: false,
          provider: 'browser-label-document',
          printerName: input.printerSettings.printerName,
          browserPrintDebug,
          errorMessage:
            error instanceof Error
              ? error.message
              : 'Temiz etiket baskı belgesi oluşturulamadı.',
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
