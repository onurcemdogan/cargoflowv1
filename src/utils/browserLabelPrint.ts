import JsBarcode from 'jsbarcode'
import qrcode from 'qrcode-generator'
import type {
  CargoOrder,
  LabelTemplate,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import { buildLabelData, type LabelData } from './labelData'
import { resolveSuratPrintEligibility } from './suratPrintEligibility'
import { formatDesi } from './desi'

// Her etiket sayfası kendi bağımsız (immutable) modelini kullanır; bir
// siparişin kodları başka siparişe sızamaz.
export interface SuratPrintPageModel {
  orderNumber: string
  trackingNumber: string
  barcodeNumber: string
  ozelKargoTakipNo: string
  zpl: string
  recipient: string
  address: string
  desi: number | null
  packageCount: number
}

export interface SuratPrintSkip {
  orderNumber: string
  reason: string
}

export interface SuratPrintSelection {
  printable: Array<{ order: CargoOrder; model: SuratPrintPageModel }>
  skipped: SuratPrintSkip[]
}

export interface SuratBulkPrintResult {
  printedOrderNumbers: string[]
  models: SuratPrintPageModel[]
  skipped: SuratPrintSkip[]
  printCalled: boolean
  debug?: BrowserLabelPrintDebug
}

export function buildSuratPrintPageModel(order: CargoOrder): {
  model?: SuratPrintPageModel
  reason?: string
} {
  const eligibility = resolveSuratPrintEligibility(order)
  if (!eligibility.canPrint) {
    return { reason: eligibility.reason }
  }
  const shipment = order.shipment
  const zplAnalysis =
    shipment?.zplAnalysis ?? shipment?.suratCreateLog?.zplAnalysis
  // T.No ve barkod bağımsız kaynak ailelerinden çözülür; birbirinin yerine
  // kullanılamaz. Kanıt (11424170556): eski parser 016 ZPL'indeki ilk numeric
  // ^FD'yi (T.No) üst seviye Barcode alanlarına da yazabiliyor. Bu yüzden
  // canonical barkod önceliği zplAnalysis.acceptedFinalBarcode'dadır ve
  // T.No ile çakışan barkod adayları reddedilir.
  const trackingNumber = firstString(
    shipment?.trackingNumber,
    shipment?.tNo,
    shipment?.kargoTakipNo,
    zplAnalysis?.acceptedTNo,
  )
  const collidesWithTracking = (value: string): boolean =>
    Boolean(
      value &&
        (value === trackingNumber ||
          value === firstString(zplAnalysis?.acceptedTNo)),
    )
  const barcodeCandidates = [
    zplAnalysis?.acceptedFinalBarcode,
    shipment?.codeMapping?.barcodeValue,
    shipment?.barkodNo,
    shipment?.barcode,
    shipment?.barcodeValue,
    shipment?.finalSuratBarcode,
  ]
  const barcodeNumber = firstString(
    ...barcodeCandidates.map((value) =>
      collidesWithTracking(firstString(value)) ? '' : value,
    ),
  )
  const ozelKargoTakipNo = firstString(
    shipment?.ozelKargoTakipNo,
    order.cargoTrackingNumber,
  )
  if (!trackingNumber || !barcodeNumber) {
    suratPrintTrace('PRINT_SKIPPED_REASON', {
      reason: 'FIELD_MAPPING_COLLISION',
      orderNumber: String(order.orderNumber ?? ''),
      trackingNumber,
      barcodeNumber,
      acceptedTNo: firstString(zplAnalysis?.acceptedTNo),
      acceptedFinalBarcode: firstString(zplAnalysis?.acceptedFinalBarcode),
    })
    return {
      reason:
        'Etiket yazdırılamadı: T.No ve barkod alanları yanlış eşleştirilmiş.',
    }
  }
  if (trackingNumber === barcodeNumber) {
    suratPrintTrace('PRINT_SKIPPED_REASON', {
      reason: 'FIELD_MAPPING_COLLISION',
      orderNumber: String(order.orderNumber ?? ''),
      trackingNumber,
      barcodeNumber,
      acceptedTNo: firstString(zplAnalysis?.acceptedTNo),
      acceptedFinalBarcode: firstString(zplAnalysis?.acceptedFinalBarcode),
    })
    return {
      reason:
        'Etiket yazdırılamadı: T.No ve barkod alanları yanlış eşleştirilmiş.',
    }
  }
  return {
    model: {
      orderNumber: String(order.orderNumber ?? ''),
      trackingNumber,
      barcodeNumber,
      ozelKargoTakipNo,
      zpl: eligibility.barcodeRaw,
      recipient: String(order.customerName ?? ''),
      address: String(order.address ?? ''),
      desi: order.desi ?? null,
      packageCount: order.packageCount ?? 1,
    },
  }
}

export function resolveSuratPrintableSelection(
  orders: CargoOrder[],
): SuratPrintSelection {
  const printable: SuratPrintSelection['printable'] = []
  const skipped: SuratPrintSkip[] = []
  const seen = new Set<string>()
  for (const order of orders) {
    const dedupeKey = String(order.id || order.orderNumber || '')
    if (dedupeKey && seen.has(dedupeKey)) continue
    if (dedupeKey) seen.add(dedupeKey)
    const { model, reason } = buildSuratPrintPageModel(order)
    suratPrintTrace('PAGE_RESOLUTION_RESULT', {
      orderNumber: String(order.orderNumber ?? order.id ?? '-'),
      lifecycleStatus: order.shipment?.lifecycleStatus ?? '',
      printEnabled: order.shipment?.printEnabled === true,
      canPrint: Boolean(model),
      trackingNumber: model?.trackingNumber ?? '',
      barcode: model?.barcodeNumber ?? '',
      hasZpl: Boolean(model?.zpl),
      reason: reason ?? '',
    })
    if (model) {
      printable.push({ order, model })
    } else {
      const skipReason = reason || 'Etiket yazdırmaya uygun değil.'
      suratPrintTrace('PRINT_SKIPPED_REASON', {
        orderNumber: String(order.orderNumber ?? order.id ?? '-'),
        reason: skipReason,
      })
      skipped.push({
        orderNumber: String(order.orderNumber ?? order.id ?? '-'),
        reason: skipReason,
      })
    }
  }
  return { printable, skipped }
}

export interface SuratZplDownload {
  fileName: string
  content: string
  models: SuratPrintPageModel[]
  skipped: SuratPrintSkip[]
}

// ZPL İndir: yalnız .zpl dosyası içeriğini çözer. Modal açmaz, window.print
// çağırmaz, create tetiklemez. Print ile aynı eligibility/seçim mantığını
// kullanır ki iki aksiyon tutarlı olsun.
export function buildSuratZplDownload(
  orders: CargoOrder[],
): SuratZplDownload | null {
  const selection = resolveSuratPrintableSelection(orders)
  if (selection.printable.length === 0) {
    return null
  }
  const models = selection.printable.map((item) => item.model)
  const content = models.map((model) => model.zpl).join('\n')
  const fileName =
    models.length === 1
      ? `surat-${sanitizeFilePart(models[0].orderNumber)}-${sanitizeFilePart(
          models[0].barcodeNumber,
        )}.zpl`
      : `surat-toplu-${models.length}.zpl`
  return { fileName, content, models, skipped: selection.skipped }
}

function sanitizeFilePart(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'label'
}

// Tekli ve toplu yazdırmanın tek giriş noktası. Uygun etiketleri tek print
// dokümanında toplar, window.print() yalnız bir kez çağrılır ve pencere
// otomatik kapatılmaz.
export async function printSuratLabels(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): Promise<SuratBulkPrintResult> {
  const selection = resolveSuratPrintableSelection(orders)
  if (selection.printable.length === 0) {
    return {
      printedOrderNumbers: [],
      models: [],
      skipped: selection.skipped,
      printCalled: false,
    }
  }
  try {
    const debug = await printCleanLabelDocument(
      selection.printable.map((item) => item.order),
      template,
      mappingConfig,
    )
    return {
      printedOrderNumbers: selection.printable.map(
        (item) => item.model.orderNumber,
      ),
      models: selection.printable.map((item) => item.model),
      skipped: selection.skipped,
      printCalled: debug.printCalled,
      debug,
    }
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : 'Yazdırma başlatılamadı.'
    return {
      printedOrderNumbers: [],
      models: [],
      skipped: [
        ...selection.skipped,
        ...selection.printable.map((item) => ({
          orderNumber: item.model.orderNumber,
          reason,
        })),
      ],
      printCalled: false,
      debug:
        error instanceof BrowserLabelPrintError ? error.debug : undefined,
    }
  }
}

export interface BrowserLabelPrintDebug {
  printRequested: boolean
  printMode: 'chrome-html' | 'zpl-native' | 'test-label'
  labelHtmlGenerated: boolean
  labelHtmlLength: number
  barcodeValue: string
  zplAvailable: boolean
  printableContentPreview: string
  printWindowOpened: boolean
  printCalled: boolean
  rejectionReason?: string
}

export class BrowserLabelPrintError extends Error {
  debug: BrowserLabelPrintDebug

  constructor(message: string, debug: BrowserLabelPrintDebug) {
    super(message)
    this.name = 'BrowserLabelPrintError'
    this.debug = debug
  }
}

// ---------------------------------------------------------------------------
// Print motoru: KALICI gizli iframe. Popup yaklaşımı tamamen kaldırıldı.
// Kurallar:
// - iframe DOM'da kalıcıdır; her print aynı iframe'i yeniden kullanır.
// - Başarılı print yolunda HİÇBİR cleanup yoktur: window.close yok,
//   iframe.remove yok, afterprint yalnız tanı logu üretir.
// - Tek click = tek execution: activePrintExecution guard'ı çift çağrıyı
//   (React StrictMode dahil) engeller.
// - Her yaşam döngüsü adımı timestamp + executionId ile console'a loglanır.
// ---------------------------------------------------------------------------

let printExecutionCounter = 0
let activePrintExecution: string | null = null
let persistentPrintFrame: HTMLIFrameElement | null = null

export function suratPrintTrace(
  event: string,
  details: Record<string, unknown> = {},
): void {
  try {
    console.info(`[surat-print] ${new Date().toISOString()} ${event}`, details)
  } catch {
    // console erişilemiyorsa akışı bozma
  }
}

function ensurePersistentPrintFrame(executionId: string): HTMLIFrameElement {
  if (
    persistentPrintFrame &&
    persistentPrintFrame.isConnected !== false &&
    persistentPrintFrame.contentWindow
  ) {
    suratPrintTrace('IFRAME_REUSED', { executionId })
    return persistentPrintFrame
  }
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('data-surat-print-frame', 'persistent')
  iframe.style.position = 'fixed'
  iframe.style.left = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.visibility = 'hidden'
  document.body.appendChild(iframe)
  persistentPrintFrame = iframe
  suratPrintTrace('WINDOW_REFERENCE_CREATED', {
    executionId,
    mode: 'persistent-iframe',
  })
  return iframe
}

// Geriye dönük uyumluluk: popup rezervasyonu kaldırıldı. Bu fonksiyonlar
// artık pencere AÇMAZ ve KAPATMAZ; yalnız tanı logu üretir.
export function reserveCleanLabelPrintWindow(): Window | null {
  suratPrintTrace('WINDOW_RESERVED', {
    deprecated: true,
    mode: 'persistent-iframe',
    note: 'Popup rezervasyonu kaldırıldı; kalıcı iframe kullanılıyor.',
  })
  return null
}

export function cancelReservedCleanLabelPrintWindow(): void {
  suratPrintTrace('CANCEL_RESERVED_CALLED', {
    deprecated: true,
    action: 'none',
    note: 'Kapatılacak popup yok; kalıcı iframe DOM\'da bırakılır.',
  })
}

export async function printCleanLabelDocument(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): Promise<BrowserLabelPrintDebug> {
  const executionId = `print-${++printExecutionCounter}`
  const orderNumbers = orders.map((order) => String(order.orderNumber ?? ''))
  const debug: BrowserLabelPrintDebug = {
    printRequested: true,
    printMode: 'chrome-html',
    labelHtmlGenerated: false,
    labelHtmlLength: 0,
    barcodeValue: '',
    zplAvailable: orders.some((order) =>
      Boolean(order.shipment?.barcodeRaw || order.label?.zplContent),
    ),
    printableContentPreview: '',
    printWindowOpened: false,
    printCalled: false,
  }
  suratPrintTrace('PRINT_FLOW_START', {
    executionId,
    orderNumbers,
    activePrintExecution,
  })

  if (activePrintExecution) {
    suratPrintTrace('PRINT_ERROR', {
      executionId,
      orderNumbers,
      reason: 'in-flight-guard',
      activePrintExecution,
    })
    return failPrint(
      debug,
      'Devam eden bir yazdırma işlemi var; aynı anda ikinci yazdırma başlatılmadı.',
    )
  }

  if (typeof document === 'undefined') {
    return failPrint(
      debug,
      'Tarayıcı baskı belgesi yalnızca kullanıcı arayüzünde açılabilir.'
    )
  }
  if (orders.length === 0) {
    return failPrint(debug, 'Yazdırılacak etiket bulunamadı.')
  }

  activePrintExecution = executionId
  try {
    suratPrintTrace('HTML_BUILD_START', { executionId, orderNumbers })
    const printHtml = buildCleanLabelHtml(orders, template, mappingConfig)
    debug.labelHtmlGenerated = Boolean(printHtml.trim())
    debug.labelHtmlLength = printHtml.length
    debug.barcodeValue = firstString(
      orders[0]?.shipment?.barcode,
      orders[0]?.shipment?.barcodeValue,
      orders[0]?.label?.barcodeValue,
    )
    debug.printableContentPreview = previewPrintableContent(printHtml)
    suratPrintTrace('HTML_BUILD_SUCCESS', {
      executionId,
      htmlLength: printHtml.length,
    })

    if (!isPrintableLabelHtml(printHtml)) {
      return failPrint(debug, 'Yazdırılacak etiket içeriği oluşturulamadı.')
    }

    const iframe = ensurePersistentPrintFrame(executionId)
    const frameDocument = iframe.contentDocument
    const frameWindow = iframe.contentWindow
    if (!frameDocument || !frameWindow) {
      suratPrintTrace('PRINT_ERROR', {
        executionId,
        reason: 'iframe-content-unavailable',
      })
      return failPrint(debug, 'Baskı iframe belgesi oluşturulamadı.')
    }
    debug.printWindowOpened = true

    suratPrintTrace('DOCUMENT_WRITE_START', { executionId })
    writePrintDocument(frameDocument, printHtml)
    suratPrintTrace('DOCUMENT_WRITE_END', { executionId })
    await waitForPrintDocument(frameDocument)

    // Tanı: afterprint/beforeunload yalnız LOGLANIR; hiçbir cleanup yapılmaz.
    try {
      frameWindow.onafterprint = () =>
        suratPrintTrace('AFTERPRINT_FIRED', {
          executionId,
          action: 'none',
          windowClosed: false,
        })
      frameWindow.onbeforeunload = () =>
        suratPrintTrace('WINDOW_BEFOREUNLOAD', { executionId })
    } catch {
      // bazı ortamlarda listener atanamayabilir; kritik değil
    }

    const frameFonts = (
      frameDocument as Document & { fonts?: { ready?: Promise<unknown> } }
    ).fonts
    if (frameFonts?.ready) {
      await frameFonts.ready
    }
    suratPrintTrace('FONTS_READY', { executionId })

    // Kritik (canlı enstrümantasyonla doğrulandı): gizli/0x0 iframe'in kendi
    // rAF'i Chrome'da HİÇ tetiklenmez; arka plan sekmelerde PARENT rAF de
    // duraklatılır. Akış RAF beklemesinde asılı kalıyordu. Bu yüzden rAF her
    // zaman kısa bir timeout ile YARIŞTIRILIR — hangisi önce gelirse akış
    // ilerler, asla asılı kalmaz.
    const raf =
      typeof window !== 'undefined' &&
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : typeof frameWindow.requestAnimationFrame === 'function'
          ? frameWindow.requestAnimationFrame.bind(frameWindow)
          : null
    const nextPaintTick = (): Promise<'raf' | 'timeout'> =>
      new Promise((resolve) => {
        let settled = false
        const settle = (source: 'raf' | 'timeout') => {
          if (settled) return
          settled = true
          resolve(source)
        }
        if (raf) raf(() => settle('raf'))
        setTimeout(() => settle('timeout'), 100)
      })
    suratPrintTrace('RAF_1', { executionId, source: await nextPaintTick() })
    suratPrintTrace('RAF_2', { executionId, source: await nextPaintTick() })
    await new Promise<void>((resolve) => setTimeout(resolve, 250))

    frameWindow.focus()
    suratPrintTrace('PRINT_CALL_START', {
      executionId,
      orderNumbers,
      printTriggered: true,
    })
    frameWindow.print()
    debug.printCalled = true
    suratPrintTrace('PRINT_CALL_END', {
      executionId,
      orderNumbers,
      printTriggered: true,
      cleanup: 'none',
    })
    // Print sonrası HİÇBİR cleanup yok: iframe DOM'da kalır, pencere
    // kapatılmaz; Chrome dialogunu kullanıcı kapatır.
    return debug
  } catch (error) {
    if (!(error instanceof BrowserLabelPrintError)) {
      suratPrintTrace('PRINT_ERROR', {
        executionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    activePrintExecution = null
  }
}

export function buildCleanLabelHtml(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): string {
  const widthMm = template.widthMm || 100
  const heightMm = template.heightMm || 100
  const selection = resolveSuratPrintableSelection(orders)
  if (selection.printable.length === 0) {
    const reasons = selection.skipped
      .map((item) => `${item.orderNumber}: ${item.reason}`)
      .join(' | ')
    throw new Error(reasons || 'Yazdırılacak etiket içeriği oluşturulamadı.')
  }
  const pages = selection.printable.map(({ order, model }) => {
    const data = buildLabelData(order, order.shipment, template, mappingConfig)
    return renderPrintableLabelHtml({
      ...data,
      tNo: model.trackingNumber,
      trackingNumber: model.trackingNumber,
      kargoTakipNo: model.trackingNumber,
      barcodeValue: model.barcodeNumber,
      mainBarcodeValue: model.barcodeNumber,
      barcode: model.barcodeNumber,
      qrPayload: model.ozelKargoTakipNo,
    })
  })

  if (pages.length === 0 || !pages.join('').trim()) {
    throw new Error('Yazdırılacak etiket içeriği oluşturulamadı.')
  }

  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>CargoFlow Etiket</title>
  <style>
    @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: ${widthMm}mm;
      min-height: ${heightMm}mm;
      background: #fff;
    }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; }
    .label-page {
      width: ${widthMm}mm;
      height: ${heightMm}mm;
      overflow: hidden;
      display: grid;
      grid-template-columns: 8.5mm minmax(0, 1fr);
      border: .35mm solid #000;
      break-after: page;
      page-break-after: always;
      font-family: "Courier New", monospace;
      line-height: 1.05;
    }
    .label-page:last-child { break-after: auto; page-break-after: auto; }
    .surat-rail {
      display: grid;
      grid-template-rows: 1fr 1fr;
      place-items: center;
      overflow: hidden;
      border-right: .35mm solid #000;
    }
    .surat-rail strong,
    .surat-rail span {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      white-space: nowrap;
    }
    .surat-rail strong { font-size: 11pt; font-weight: 900; letter-spacing: .4mm; }
    .surat-rail span { max-height: 96%; font-size: 8pt; font-weight: 900; }
    .surat-body {
      display: grid;
      grid-template-rows: 11.5mm 20mm 24mm 10mm 21mm 1fr;
      min-width: 0;
      min-height: 0;
    }
    .surat-section {
      min-width: 0;
      overflow: hidden;
      border-bottom: .35mm solid #000;
    }
    .surat-section:last-child { border-bottom: 0; }
    .surat-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 35mm;
      gap: 2mm;
      padding: 1.5mm 2mm .8mm;
    }
    .surat-header div { min-width: 0; overflow: hidden; }
    .surat-header span,
    .surat-header b {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .surat-header span { font-size: 7pt; font-weight: 800; }
    .surat-header b { font-size: 10pt; font-weight: 900; text-transform: uppercase; }
    .surat-header-right { text-align: right; }
    .surat-barcode {
      display: grid;
      place-items: center;
      padding: .5mm 6mm 0;
    }
    .surat-barcode svg { width: 100%; height: 19mm; display: block; }
    .surat-address {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 35mm;
    }
    .surat-address-copy {
      min-width: 0;
      overflow: hidden;
      padding: 1.8mm 2mm;
      border-right: .35mm solid #000;
    }
    .surat-address-copy b,
    .surat-address-copy span,
    .surat-address-copy strong {
      display: block;
      text-transform: uppercase;
      white-space: normal;
      word-break: normal;
      overflow-wrap: break-word;
    }
    .surat-address-copy b,
    .surat-address-copy strong { font-size: 8.5pt; font-weight: 900; line-height: 1.15; }
    .surat-address-copy span { font-size: 7pt; font-weight: 800; line-height: 1.15; }
    /* Adres kayıpsız sarılır; uzunluk arttıkça font kademeli küçülür.
       Ellipsis/kesme YOKTUR. */
    .surat-address-normal .surat-address-line { font-size: 7pt; }
    .surat-address-long .surat-address-line { font-size: 6.2pt; }
    .surat-address-long .surat-recipient-name { font-size: 7.6pt; }
    .surat-address-xlong .surat-address-line { font-size: 5.6pt; line-height: 1.1; }
    .surat-address-xlong .surat-recipient-name { font-size: 7pt; }
    .surat-address-xlong .surat-address-phone { font-size: 5.6pt; }
    .surat-route {
      display: grid;
      place-items: center;
      padding: 1.5mm;
      font-size: 10pt;
      font-weight: 900;
      text-align: center;
      text-transform: uppercase;
    }
    .surat-cargo {
      display: grid;
      grid-template-columns: 1fr 1fr 1.2fr;
    }
    .surat-cargo div {
      display: grid;
      align-content: center;
      padding: .8mm 2mm;
      border-right: .35mm solid #000;
    }
    .surat-cargo div:last-child { border-right: 0; }
    .surat-cargo span { font-size: 7pt; font-weight: 800; }
    .surat-cargo strong { font-size: 13pt; font-weight: 900; }
    .surat-delivery {
      display: grid;
      grid-template-columns: 23mm minmax(0, 1fr) 15mm;
      align-items: center;
      gap: 2mm;
      padding: 1.2mm 2mm;
    }
    .surat-qr-large,
    .surat-qr-small {
      width: 100%;
      aspect-ratio: 1 / 1;
      display: block;
      border: .35mm solid #000;
    }
    /* Parça adedi bloğu: her bilgi AYRI satırda, sabit line-height ile.
       Metinler üst üste binmez, QR/DataMatrix alanına taşmaz. */
    .surat-delivery-copy {
      min-width: 0;
      display: grid;
      grid-template-rows: auto auto auto auto auto;
      align-content: center;
      row-gap: .2mm;
      font-weight: 900;
    }
    .surat-delivery-copy span,
    .surat-delivery-copy b,
    .surat-delivery-copy strong,
    .surat-delivery-copy em {
      display: block;
      min-width: 0;
      text-transform: uppercase;
      white-space: normal;
      word-break: normal;
      overflow-wrap: break-word;
      line-height: 1.05;
    }
    .surat-parcel-label { font-size: 6.5pt; }
    .surat-parcel-count { font-size: 11pt; }
    .surat-delivery-type { font-size: 9.5pt; }
    .surat-destination { font-style: normal; }
    .surat-destination-normal { font-size: 9.5pt; }
    .surat-destination-small { font-size: 7.5pt; }
    .surat-transfer { font-size: 8.5pt !important; }
    .surat-product {
      padding: 1.5mm 2mm;
    }
    .surat-product strong,
    .surat-product span {
      display: block;
      overflow: hidden;
      font-weight: 900;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .surat-product strong { font-size: 8pt; }
    .surat-product span { font-size: 7pt; margin-top: .5mm; }
    @media print {
      html, body {
        width: ${widthMm}mm;
        height: ${heightMm}mm;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
      }
      .label-page { margin: 0; box-shadow: none; }
    }
  </style>
</head>
<body>${pages.join('')}</body>
</html>`
}

export function renderPrintableLabelHtml(data: LabelData): string {
  const barcodeSvg = renderBarcodeSvg(data.barcodeValue)
  const item = data.items[0]
  const leftReference =
    data.leftVerticalReference || data.shipmentReference || data.orderNumber
  const routeCenter =
    data.routeCenter ||
    [data.city, data.district].filter(Boolean).join(' / ')
  const transferCenter = data.transferCenter || routeCenter
  // Adres KAYIPSIZ sarılır; '...' veya substring kesmesi yoktur. Uzun
  // adreslerde font kademesi küçülür.
  const addressLines =
    data.fullAddressLines && data.fullAddressLines.length > 0
      ? data.fullAddressLines
      : splitAddress(data.address)
  const addressScaleClass = `surat-address-${data.addressFontScale || 'normal'}`
  // Üst bölüm GÖNDERİCİ adıdır; alıcı adı yalnız adres bloğunda görünür.
  const senderName = data.senderName || ''
  const phoneDisplay = data.recipientPhone
    ? maskPhone(data.recipientPhone)
    : '-'
  const destinationScaleClass =
    routeCenter.length > 24
      ? 'surat-destination-small'
      : 'surat-destination-normal'
  const productTitle = item
    ? `${item.quantity || 1} x ${item.productName}`
    : 'Ürün bilgisi yok'
  const productMeta = [
    item?.color ? `Renk: ${item.color}` : '',
    item?.size ? `Beden: ${item.size}` : '',
    item?.sku ? `SKU: ${item.sku}` : '',
  ]
    .filter(Boolean)
    .join(' | ')

  return `
      <article class="label-page">
        <aside class="surat-rail">
          <strong>SURAT KARGO</strong>
          <span>Siparis No: ${escapeHtml(leftReference)}</span>
        </aside>
        <div class="surat-body">
          <header class="surat-section surat-header">
            <div>
              <span>Şube: <strong>${escapeHtml(data.branchName || 'FERAH')}</strong></span>
              <b class="surat-sender-name">${escapeHtml(senderName)}</b>
              <span>MUST.IRS.NO: ${escapeHtml(data.orderNumber)}</span>
            </div>
            <div class="surat-header-right">
              <span>T.No: <strong>${escapeHtml(data.tNo || data.trackingNumber || '-')}</strong></span>
              <span>TEL: ${escapeHtml(phoneDisplay)}</span>
            </div>
          </header>
          <section class="surat-section surat-barcode">${barcodeSvg}</section>
          <section class="surat-section surat-address ${addressScaleClass}">
            <div class="surat-address-copy">
              <b class="surat-recipient-name">${escapeHtml(data.recipientName)}</b>
              ${addressLines.map((line) => `<span class="surat-address-line">${escapeHtml(line)}</span>`).join('')}
              <strong>${escapeHtml(routeCenter)}</strong>
              <span class="surat-address-phone">TEL: ${escapeHtml(phoneDisplay)}</span>
            </div>
            <div class="surat-route">${escapeHtml(routeCenter)}</div>
          </section>
          <section class="surat-section surat-cargo">
            <div><span>OdemeTipi</span><strong>POCH</strong></div>
            <div><span>Birim</span><strong>KOLI</strong></div>
            <div><span>Top Ds/Kg</span><strong>${formatDesi(data.desi)}</strong></div>
          </section>
          <section class="surat-section surat-delivery">
            ${renderQrSvg(data.qrPayload || data.trendyolCargoTrackingNumber || data.shipmentReference, 'surat-qr-large')}
            <div class="surat-delivery-copy">
              <span class="surat-parcel-label">Parca Adedi</span>
              <b class="surat-parcel-count">1 / 1</b>
              <strong class="surat-delivery-type">Adrese Teslim</strong>
              <em class="surat-destination ${destinationScaleClass}">${escapeHtml(routeCenter)}</em>
              <strong class="surat-transfer">${escapeHtml(transferCenter)}</strong>
            </div>
            ${renderQrSvg(data.qrPayload || data.trendyolCargoTrackingNumber || data.shipmentReference, 'surat-qr-small')}
          </section>
          <footer class="surat-section surat-product">
            <strong>${escapeHtml(productTitle)}</strong>
            <span>${escapeHtml(productMeta)}</span>
          </footer>
        </div>
      </article>
    `
}

export function renderLegacyPrintableLabelHtml(data: LabelData): string {
  const barcodeSvg = renderBarcodeSvg(data.barcodeValue)
  const item = data.items[0]
  return `
      <article class="label-page">
        <header class="label-header">
          <div>
            <small>${escapeHtml(data.marketplaceName)}</small>
            <strong>${escapeHtml(data.orderNumber)}</strong>
          </div>
          <div class="tracking">
            <small>SÜRAT TAKİP NO</small>
            <strong>${escapeHtml(data.trackingNumber)}</strong>
          </div>
        </header>
        <section class="barcode">${barcodeSvg}</section>
        <section class="recipient">
          <strong>${escapeHtml(data.recipientName)}</strong>
          <p>${escapeHtml(data.address)}</p>
          <b>${escapeHtml([data.district, data.city].filter(Boolean).join(' / '))}</b>
          ${
            data.recipientPhone
              ? `<span>Tel: ${escapeHtml(data.recipientPhone)}</span>`
              : ''
          }
        </section>
        <section class="shipment-meta">
          <div><small>TOP DS/KG</small><strong>${formatDesi(data.desi)}</strong></div>
          <div><small>T.NO</small><strong>${escapeHtml(data.tNo || '-')}</strong></div>
          <div><small>SİPARİŞ REFERANSI</small><strong>${escapeHtml(data.shipmentReference)}</strong></div>
        </section>
        <footer>
          <strong>${escapeHtml(
            item ? `${item.quantity || 1} x ${item.productName}` : 'Ürün bilgisi yok',
          )}</strong>
          <span>${escapeHtml(
            [
              item?.color ? `Renk: ${item.color}` : '',
              item?.size ? `Beden: ${item.size}` : '',
              item?.sku ? `SKU: ${item.sku}` : '',
            ]
              .filter(Boolean)
              .join(' | '),
          )}</span>
        </footer>
      </article>
    `
}

function failPrint(
  debug: BrowserLabelPrintDebug,
  message: string,
): never {
  debug.rejectionReason = message
  throw new BrowserLabelPrintError(message, debug)
}

function renderBarcodeSvg(value: string): string {
  if (
    typeof document === 'undefined' ||
    typeof document.createElementNS !== 'function'
  ) {
    return `<svg xmlns="http://www.w3.org/2000/svg" data-barcode-value="${escapeHtml(
      value,
    )}" aria-label="${escapeHtml(value)}"></svg>`
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  JsBarcode(svg, value, {
    format: 'CODE128',
    height: 72,
    width: 2.2,
    margin: 0,
    displayValue: true,
    fontSize: 16,
    textMargin: 3,
  })
  svg.setAttribute('data-barcode-value', value)
  return svg.outerHTML
}

function renderQrSvg(value: string, className: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(value || '-')
  qr.make()

  const moduleCount = qr.getModuleCount()
  const quietZone = 3
  const viewBoxSize = moduleCount + quietZone * 2
  const cells: string[] = []
  for (let y = 0; y < moduleCount; y += 1) {
    for (let x = 0; x < moduleCount; x += 1) {
      if (qr.isDark(y, x)) {
        cells.push(
          `<rect x="${x + quietZone}" y="${y + quietZone}" width="1" height="1" fill="#111" />`,
        )
      }
    }
  }

  return `<svg class="${className}" data-qr-value="${escapeHtml(value)}" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#fff" />${cells.join('')}</svg>`
}

function splitAddress(address: string): string[] {
  const words = String(address || '-').split(/\s+/).filter(Boolean)
  const lines: string[] = []

  for (const word of words) {
    const current = lines[lines.length - 1] ?? ''
    if (!current || current.length + word.length > 42) {
      if (lines.length < 3) lines.push(word)
    } else {
      lines[lines.length - 1] = `${current} ${word}`
    }
  }

  return lines.length > 0 ? lines : ['-']
}

function maskPhone(phone: string): string {
  const normalized = String(phone ?? '').replace(/\s+/g, '')
  if (normalized.length < 7) return phone || '-'
  return `${normalized.slice(0, 3)}*****${normalized.slice(-2)}`
}

function writePrintDocument(targetDocument: Document, html: string): void {
  targetDocument.open()
  targetDocument.write(html)
  targetDocument.close()
}

async function waitForPrintDocument(targetDocument: Document): Promise<void> {
  if (targetDocument.readyState !== 'complete') {
    await new Promise<void>((resolve) => {
      targetDocument.defaultView?.addEventListener?.('load', () => resolve(), {
        once: true,
      })
      setTimeout(resolve, 250)
    })
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 180))
}

function isPrintableLabelHtml(html: string): boolean {
  return (
    html.includes('class="label-page"') &&
    html.includes('<body>') &&
    stripHtml(html).trim().length > 20
  )
}

function previewPrintableContent(html: string): string {
  return stripHtml(html).replace(/\s+/g, ' ').trim().slice(0, 500)
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function firstString(...values: unknown[]): string {
  return (
    values
      .map((value) =>
        typeof value === 'string' || typeof value === 'number'
          ? String(value).trim()
          : '',
      )
      .find(Boolean) ?? ''
  )
}

function escapeHtml(value: unknown): string {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
