import { afterEach, beforeEach, expect, test } from 'vitest'
import { OrderWorkflowService } from '../services/orderWorkflowService'
import { TrendyolProvider } from '../providers/marketplace/TrendyolProvider'
import { SuratKargoProvider } from '../providers/shipping/SuratKargoProvider'
import { ZebraZplLabelProvider } from '../providers/labels/ZebraZplLabelProvider'
import { BrowserDownloadPrintProvider } from '../providers/printing/BrowserDownloadPrintProvider'
import { AuditLogService } from '../services/auditLogService'
import { defaultLabelTemplate } from '../services/integrationConfigService'
import {
  clearSuratRenderCache,
  peekSuratRenderArtifact,
  SURAT_RENDER_ENDPOINT,
} from '../services/suratLabelRenderClient'
import { prepareSuratPrintHostSynchronously } from '../utils/browserLabelPrint'
import {
  resolveLabelPrintTemplateDecision,
  SURAT_ONLY_TEMPLATE_MESSAGE,
} from '../utils/labelPrintTemplateRouting'
import type { CargoOrder, PrinterSettings } from '../types/cargoflow'

// GÖRÜNEN SAĞLAYICI ALIAS'I — UÇTAN UCA İSTEMCİ ZİNCİRİ.
//
// Sunucu tarafı (kanonik DB anahtarı) ayrı dosyada:
// server/surat-canonical-provider-flow.test.mjs
//
// Burada doğrulanan: sipariş görünümü 'Sürat Kargo Marketplace' /
// 'surat-kargo' gibi bir ALIAS taşıdığında istemci zinciri siparişi
// ENGELLEMEZ, render ucunu çağırır ve baskıyı tamamlar. İstemci hiçbir
// sağlayıcı/kapsam alanı GÖNDERMEZ. TÜM VERİLER SENTETİKTİR.

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const ARTIFACT = {
  ok: true,
  mimeType: 'image/png',
  imageBase64: PNG_BASE64,
  widthPx: 799,
  heightPx: 799,
  widthMm: 99.875,
  heightMm: 99.875,
  printZplSha256: 'a'.repeat(64),
  renderSha256: 'b'.repeat(64),
  renderEngine: 'zpl-renderer-js',
  renderEngineVersion: '4.0.0',
  zebrashVersion: 'v1.38.0',
  augmentationStatus: 'success',
}

const BROWSER_PRINTER: PrinterSettings = {
  mode: 'browser-print',
  printerName: 'Test',
  labelSize: '100x100',
} as unknown as PrinterSettings

// Canlıda görülen / görülebilecek GÖRÜNEN sağlayıcı adları.
const SURAT_ALIASES = [
  'Sürat',
  'Sürat Kargo',
  'Sürat Kargo Marketplace',
  'surat-kargo',
  'surat',
]
const FOREIGN_PROVIDERS = ['Aras', 'Yurtiçi', 'MNG']

let calls: Array<{ url: string; body: Record<string, unknown> }> = []
let originalFetch: typeof globalThis.fetch
let printCallCount = 0

function stubFetch() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), body })
    return {
      ok: true,
      status: 200,
      json: async () => ARTIFACT,
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
}

const renderCalls = () => calls.filter((call) => call.url === SURAT_RENDER_ENDPOINT)

function prepareHost() {
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  const frame = document.querySelector(
    '[data-surat-print-frame]',
  ) as HTMLIFrameElement
  printCallCount = 0
  ;(frame.contentWindow as unknown as { print: () => void }).print = () => {
    printCallCount += 1
  }
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}
  return frame
}

beforeEach(() => {
  calls = []
  originalFetch = globalThis.fetch
  clearSuratRenderCache()
  document.body.innerHTML = ''
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

function readyOrder(over: Record<string, unknown> = {}): CargoOrder {
  const base = {
    id: 'o-1',
    marketplace: 'Trendyol',
    orderNumber: '1000000000000001',
    packageId: '4056494300',
    customerName: 'SENTETIK ALICI',
    address: 'ORNEK MAH 1',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    desi: 2,
    items: [{ id: 'l-1', productName: 'Ornek Elbise', quantity: 1 }],
    city: 'ORNEKSEHIR',
    district: 'ORNEKILCE',
    label: { zplContent: '^XA^XZ' },
    // Sunucu görünümünün ürettiği hâl: provider alanı GÖRÜNEN değerdir.
    cargoProviderName: 'Sürat Kargo Marketplace',
    shipment: {
      provider: 'surat-kargo',
      printEnabled: true,
      zplReady: true,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      trackingNumber: '10000000000001',
      tNo: '10000000000001',
      barcode: '01200000001',
      barkodNo: '01200000001',
      barcodeValue: '01200000001',
      barcodeRaw:
        '^XA^PW799^LL0799^FO60,150^BY3^BCN,130,Y,N,N^FD01200000001^FS^XZ',
      desi: 2,
    },
  } as Record<string, unknown>
  return { ...base, ...over } as unknown as CargoOrder
}

function withProvider(provider: string): CargoOrder {
  const order = readyOrder()
  return {
    ...order,
    cargoProviderName: provider,
    shipment: { ...(order.shipment as object), provider },
  } as unknown as CargoOrder
}

function makeService() {
  return new OrderWorkflowService(
    new TrendyolProvider(),
    new SuratKargoProvider(),
    new ZebraZplLabelProvider(),
    new BrowserDownloadPrintProvider(),
    new AuditLogService(),
  )
}

async function printOfficial(orders: CargoOrder[]) {
  return makeService().printLabels(
    orders,
    orders.map((order) => String(order.id)),
    BROWSER_PRINTER,
    defaultLabelTemplate,
    {},
    {
      confirmedAt: new Date().toISOString(),
      printedBy: 'test',
      labelPrintTemplate: 'surat_official_zpl',
    },
  )
}

// ── PA-1: CANLI ŞEKİL — alias görünüm, resmî şablon ────────────────────────

test('PA-1: alias sağlayıcılı READY sipariş TAM olarak basılır', async () => {
  stubFetch()
  const frame = prepareHost()
  const outcome = await printOfficial([readyOrder()])

  expect(renderCalls()).toHaveLength(1)
  expect(outcome.printResult?.browserPrintDebug?.printMode).toBe(
    'surat-official-png',
  )
  expect(outcome.printResult?.browserPrintDebug?.printWindowOpened).toBe(true)
  expect(outcome.printResult?.browserPrintDebug?.printCalled).toBe(true)
  expect(outcome.printResult?.jobs?.[0].ok).toBe(true)
  expect(outcome.printResult?.browserPrintDebug?.skipped ?? []).toEqual([])
  expect(printCallCount).toBe(1)
  expect(
    frame.contentDocument?.querySelectorAll('.surat-official-page').length,
  ).toBe(1)
})

test('PA-2: istemci gövdesi YALNIZ orderId — sağlayıcı GÖNDERİLMEZ', async () => {
  stubFetch()
  prepareHost()
  await printOfficial([readyOrder()])
  expect(renderCalls()[0].body).toEqual({ orderId: 'o-1' })
  for (const forbidden of [
    'provider', 'cargoProviderName', 'organizationId', 'marketplaceAccountId',
    'zpl', 'printZpl', 'technicalZpl', 'barcodeRaw',
  ]) {
    expect(forbidden in renderCalls()[0].body).toBe(false)
  }
})

// ── PA-3: TÜM ALIAS DEĞERLERİ ──────────────────────────────────────────────

test('PA-3: TÜM Sürat alias değerlerinde uç çağrılır ve baskı tamamlanır', async () => {
  for (const alias of SURAT_ALIASES) {
    calls = []
    clearSuratRenderCache()
    document.body.innerHTML = ''
    stubFetch()
    prepareHost()
    const outcome = await printOfficial([withProvider(alias)])
    expect(renderCalls(), alias).toHaveLength(1)
    expect(outcome.printResult?.jobs?.[0].ok, alias).toBe(true)
    expect(printCallCount, alias).toBe(1)
    // Şablon kararı da alias'ı Sürat sayar (aksi hâlde baskı bloklanırdı).
    expect(
      resolveLabelPrintTemplateDecision({
        templateOverride: 'surat_official_zpl',
        orders: [withProvider(alias)],
      }).template,
      alias,
    ).toBe('surat_official_zpl')
  }
}, 30000)

// ── PA-4: SÜRAT OLMAYAN SAĞLAYICI ──────────────────────────────────────────

test('PA-4: Sürat olmayan sağlayıcıda uç ÇAĞRILMAZ, güvenli mesaj döner', async () => {
  for (const foreign of FOREIGN_PROVIDERS) {
    calls = []
    clearSuratRenderCache()
    document.body.innerHTML = ''
    stubFetch()
    prepareHost()
    const outcome = await printOfficial([withProvider(foreign)])
    expect(renderCalls(), foreign).toHaveLength(0)
    expect(outcome.printResult?.jobs?.[0].ok, foreign).toBe(false)
    expect(outcome.printResult?.jobs?.[0].errorMessage, foreign).toBe(
      SURAT_ONLY_TEMPLATE_MESSAGE,
    )
    expect(printCallCount, foreign).toBe(0)
    // Açık kullanıcı seçimi de güvenli HATA verir (sessiz şablon değişimi yok).
    expect(
      resolveLabelPrintTemplateDecision({
        templateOverride: 'surat_official_zpl',
        orders: [withProvider(foreign)],
      }).blockedReason,
      foreign,
    ).toBe(SURAT_ONLY_TEMPLATE_MESSAGE)
  }
}, 30000)

// ── PA-5: TEKRAR BASKI DETERMİNİZMİ ────────────────────────────────────────

test('PA-5: aynı gönderi tekrar basıldığında AYNI artefakt kullanılır', async () => {
  stubFetch()
  prepareHost()
  const first = await printOfficial([readyOrder()])
  expect(first.printResult?.jobs?.[0].ok).toBe(true)
  const artifact = peekSuratRenderArtifact('o-1')

  // Tekrar baskı: PRINTED sipariş + includePreviouslyPrinted sözleşmesi.
  prepareHost()
  const printed = readyOrder({
    labelStatus: 'PRINTED',
    label: { zplContent: '^XA^XZ', printedAt: '2026-01-01T00:00:00.000Z' },
  })
  const second = await makeService().printLabels(
    [printed],
    ['o-1'],
    BROWSER_PRINTER,
    defaultLabelTemplate,
    {},
    {
      confirmedAt: new Date().toISOString(),
      printedBy: 'test',
      includePreviouslyPrinted: true,
      labelPrintTemplate: 'surat_official_zpl',
    },
  )
  expect(second.printResult?.jobs?.[0].ok).toBe(true)
  // Önbellek nedeniyle İKİNCİ render çalıştırılmadı; artefakt BİREBİR aynı.
  expect(renderCalls()).toHaveLength(1)
  const after = peekSuratRenderArtifact('o-1')
  expect(after?.printZplSha256).toBe(artifact?.printZplSha256)
  expect(after?.renderSha256).toBe(artifact?.renderSha256)
  expect(after?.imageBase64).toBe(artifact?.imageBase64)
}, 20000)
