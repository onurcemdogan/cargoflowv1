import JsBarcode from 'jsbarcode'
import qrcode from 'qrcode-generator'
import type {
  CargoOrder,
  LabelTemplate,
  SuratLabelMappingConfig,
} from '../types/cargoflow'
import { buildLabelData, type LabelData } from './labelData'
import { formatDesi } from './desi'

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

let reservedPrintWindow: Window | null = null

export function reserveCleanLabelPrintWindow(): Window | null {
  if (typeof window === 'undefined') return null
  const printWindow = openPrintWindow()
  if (!printWindow) return null
  reservedPrintWindow = printWindow
  writePrintDocument(
    printWindow.document,
    '<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>CargoFlow Etiket</title></head><body style="font-family:Arial,sans-serif;padding:16px">Etiket hazırlanıyor...</body></html>',
  )
  return printWindow
}

export function cancelReservedCleanLabelPrintWindow(): void {
  try {
    reservedPrintWindow?.close()
  } catch {
    // ignore
  } finally {
    reservedPrintWindow = null
  }
}

export async function printCleanLabelDocument(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): Promise<BrowserLabelPrintDebug> {
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

  if (typeof document === 'undefined') {
    return failPrint(
      debug,
      'Tarayıcı baskı belgesi yalnızca kullanıcı arayüzünde açılabilir.'
    )
  }
  if (orders.length === 0) {
    return failPrint(debug, 'Yazdırılacak etiket bulunamadı.')
  }

  const printHtml = buildCleanLabelHtml(orders, template, mappingConfig)
  debug.labelHtmlGenerated = Boolean(printHtml.trim())
  debug.labelHtmlLength = printHtml.length
  debug.barcodeValue = firstString(
    orders[0]?.shipment?.barcode,
    orders[0]?.shipment?.barcodeValue,
    orders[0]?.label?.barcodeValue,
  )
  debug.printableContentPreview = previewPrintableContent(printHtml)

  if (!isPrintableLabelHtml(printHtml)) {
    return failPrint(debug, 'Yazdırılacak etiket içeriği oluşturulamadı.')
  }

  const printWindow = consumeReservedPrintWindow() || openPrintWindow()
  if (printWindow) {
    debug.printWindowOpened = true
    writePrintDocument(printWindow.document, printHtml)
    await waitForPrintDocument(printWindow.document)
    printWindow.focus()
    printWindow.print()
    debug.printCalled = true
    return debug
  }

  await printWithIframe(printHtml, debug)
  return debug
}

function consumeReservedPrintWindow(): Window | null {
  const printWindow = reservedPrintWindow
  reservedPrintWindow = null
  return printWindow && !printWindow.closed ? printWindow : null
}

export function buildCleanLabelHtml(
  orders: CargoOrder[],
  template: LabelTemplate,
  mappingConfig: SuratLabelMappingConfig = {},
): string {
  const widthMm = template.widthMm || 100
  const heightMm = template.heightMm || 100
  const pages = orders.map((order) => {
    const shipment = order.shipment
    if (
      !shipment?.dispatchRegistrationConfirmed
    ) {
      throw new Error(
        `${order.orderNumber}: Önce Sürat gönderisi gerçek API üzerinden oluşturulmalı.`,
      )
    }
    const data = buildLabelData(order, shipment, template, mappingConfig)
    if (!data.verifiedShipment || !data.barcodeValue) {
      throw new Error(`${order.orderNumber}: Sürat barkod değeri bulunamadı.`)
    }
    return renderPrintableLabelHtml(data)
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
      overflow: hidden;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .surat-address-copy b,
    .surat-address-copy strong { font-size: 8.5pt; font-weight: 900; }
    .surat-address-copy span { font-size: 7pt; font-weight: 800; }
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
    .surat-delivery-copy {
      min-width: 0;
      overflow: hidden;
      font-weight: 900;
    }
    .surat-delivery-copy span,
    .surat-delivery-copy b,
    .surat-delivery-copy strong,
    .surat-delivery-copy em {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .surat-delivery-copy span { font-size: 7pt; }
    .surat-delivery-copy b { font-size: 15pt; }
    .surat-delivery-copy strong { font-size: 13pt; }
    .surat-delivery-copy em { font-size: 14pt; font-style: normal; }
    .surat-transfer { font-size: 12pt !important; }
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
  const addressLines = splitAddress(data.address)
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
              <b>${escapeHtml(data.recipientName)}</b>
              <span>MUST.IRS.NO: ${escapeHtml(data.orderNumber)}</span>
            </div>
            <div class="surat-header-right">
              <span>T.No: <strong>${escapeHtml(data.tNo || data.trackingNumber || '-')}</strong></span>
              <span>TEL: ${escapeHtml(maskPhone(data.recipientPhone))}</span>
            </div>
          </header>
          <section class="surat-section surat-barcode">${barcodeSvg}</section>
          <section class="surat-section surat-address">
            <div class="surat-address-copy">
              <b>${escapeHtml(data.recipientName)}</b>
              ${addressLines.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}
              <strong>${escapeHtml(routeCenter)}</strong>
              <span>TEL: ${escapeHtml(maskPhone(data.recipientPhone))}</span>
            </div>
            <div class="surat-route">${escapeHtml(routeCenter)}</div>
          </section>
          <section class="surat-section surat-cargo">
            <div><span>OdemeTipi</span><strong>POCH</strong></div>
            <div><span>Birim</span><strong>KOLI</strong></div>
            <div><span>Top Ds/Kg</span><strong>${formatDesi(data.desi)}</strong></div>
          </section>
          <section class="surat-section surat-delivery">
            ${renderQrSvg(`${data.orderNumber}|${data.barcodeValue}`, 'surat-qr-large')}
            <div class="surat-delivery-copy">
              <span>Parca Adedi</span>
              <b>1 / 1</b>
              <strong>Adrese Teslim</strong>
              <em>${escapeHtml(routeCenter)}</em>
              <strong class="surat-transfer">${escapeHtml(transferCenter)}</strong>
            </div>
            ${renderQrSvg(data.barcodeValue, 'surat-qr-small')}
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

function openPrintWindow(): Window | null {
  try {
    return window.open('', '_blank', 'width=460,height=720')
  } catch {
    return null
  }
}

async function printWithIframe(
  printHtml: string,
  debug: BrowserLabelPrintDebug,
): Promise<void> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.left = '-10000px'
  iframe.style.top = '0'
  iframe.style.width = '100mm'
  iframe.style.height = '100mm'
  iframe.style.border = '0'
  iframe.style.opacity = '1'
  iframe.style.pointerEvents = 'none'
  iframe.style.background = '#fff'

  const cleanup = () => {
    window.setTimeout(() => iframe.remove(), 1000)
  }

  document.body.appendChild(iframe)
  const frameDocument = iframe.contentDocument
  const frameWindow = iframe.contentWindow
  if (!frameDocument || !frameWindow) {
    cleanup()
    failPrint(debug, 'Baskı iframe belgesi oluşturulamadı.')
  }

  writePrintDocument(frameDocument, printHtml)
  await waitForPrintDocument(frameDocument)
  frameWindow.onafterprint = cleanup
  frameWindow.focus()
  frameWindow.print()
  debug.printCalled = true
}

function failPrint(
  debug: BrowserLabelPrintDebug,
  message: string,
): never {
  debug.rejectionReason = message
  throw new BrowserLabelPrintError(message, debug)
}

function renderBarcodeSvg(value: string): string {
  if (typeof document === 'undefined') {
    return `<svg xmlns="http://www.w3.org/2000/svg" aria-label="${escapeHtml(
      value,
    )}"></svg>`
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

  return `<svg class="${className}" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#fff" />${cells.join('')}</svg>`
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
      targetDocument.defaultView?.addEventListener('load', () => resolve(), {
        once: true,
      })
      window.setTimeout(resolve, 250)
    })
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, 180))
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
