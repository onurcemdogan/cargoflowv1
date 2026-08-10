import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CargoOrder } from '../types/cargoflow'

// BASKI SONRASI DURUM GEÇİŞİ + TANI DEPOLAMA GÜVENLİĞİ.
//
// ÜRETİM HATASI: fiziksel etiket basıldığı hâlde sipariş "Etiket Hazır"da
// kalıyordu ve UI'da şu görülüyordu:
//   Failed to execute 'setItem' on 'Storage': ... quota
//
// KÖK NEDEN (ölçüldü): `printLabels` içinde tanı kaydı (apiDebugService /
// auditLogService) `persistLabelPrinted`ten ÖNCE yazılıyor. `saveToStorage`
// korumasızdı; QuotaExceededError `printLabels`'ı terk ettiriyor ve
// POST /api/orders/:id/label-printed HİÇ GÖNDERİLMİYORDU.
//
// SÖZLEŞME: tanı kaydı ASLA iş akışını kesmez.

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const RENDER_ENDPOINT = '/api/labels/render/surat'

let labelPrintedCalls: string[] = []

function stubFetch(renderable: (orderId: string) => boolean) {
  labelPrintedCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) : {}

      if (href.includes('/label-printed')) {
        const orderId = href.split('/api/orders/')[1]?.split('/')[0] ?? ''
        labelPrintedCalls.push(orderId)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            order: { id: orderId, operationStatus: 'LABEL_PRINTED' },
            operationStatus: 'LABEL_PRINTED',
          }),
        } as unknown as Response
      }

      if (href.includes(RENDER_ENDPOINT)) {
        const orderId = String(body.orderId ?? '')
        if (!renderable(orderId)) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              ok: false,
              code: 'label_not_ready',
              message: 'Etiket yok.',
            }),
          } as unknown as Response
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
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
            printArtifactStatus: 'ready',
            productDetailStatus: 'none',
            missingPages: [],
            pages: [
              {
                kind: 'carrier',
                page: 1,
                totalPages: 1,
                imageBase64: PNG_BASE64,
                mimeType: 'image/png',
              },
            ],
          }),
        } as unknown as Response
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response
    }),
  )
}

const order = (id: string, orderNumber: string): CargoOrder =>
  ({
    id,
    orderNumber,
    marketplace: 'Trendyol',
    packageId: `PKG-${id}`,
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    address: 'Sentetik Mahalle 1',
    customerName: 'SENTETIK ALICI',
    items: [
      { id: 'l1', productName: `Urun ${id}`, quantity: 1, merchantSku: `SKU-${id}` },
    ],
    shipment: {
      provider: 'surat-kargo',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      barcodeRaw: `^XA^FD${id}^FS^XZ`,
      zplReady: true,
      printEnabled: true,
    },
  }) as unknown as CargoOrder

let frame: HTMLIFrameElement

beforeEach(async () => {
  document.body.innerHTML = ''
  window.localStorage.clear()
  const { prepareSuratPrintHostSynchronously } = await import(
    '../utils/browserLabelPrint'
  )
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  frame = document.querySelector('[data-surat-print-frame]') as HTMLIFrameElement
  ;(frame.contentWindow as unknown as { print: unknown }).print = vi.fn()
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}
  const { clearSuratRenderCache } = await import(
    '../services/suratLabelRenderClient'
  )
  clearSuratRenderCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function makeService() {
  const { OrderWorkflowService } = await import('../services/orderWorkflowService')
  const { BrowserDownloadPrintProvider } = await import(
    '../providers/printing/BrowserDownloadPrintProvider'
  )
  const { AuditLogService } = await import('../services/auditLogService')
  const service = new OrderWorkflowService(
    {} as never,
    {} as never,
    {
      generateSingle: async () => ({ id: 'l', labelType: 'zpl', zplContent: '' }),
    } as never,
    new BrowserDownloadPrintProvider() as never,
    new AuditLogService() as never,
  )
  service.setAuthMode(true)
  return service
}

async function runPrint(orders: CargoOrder[]) {
  const service = await makeService()
  return service.printLabels(
    orders,
    orders.map((entry) => String(entry.id)),
    { mode: 'browser-print', printerName: 'x' } as never,
    { id: 't' } as never,
    {},
    {
      confirmedAt: '2026-08-10T00:00:00.000Z',
      labelPrintTemplate: 'surat_official_zpl',
    },
  )
}

/** Gerçek tarayıcı davranışı: kota dolduğunda setItem FIRLATIR. */
function stubQuotaExceeded() {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    const error = new Error(
      "Failed to execute 'setItem' on 'Storage': Setting the value of 'cargoflow.apiDebugLogs.v1' exceeded the quota.",
    )
    error.name = 'QuotaExceededError'
    throw error
  })
}

test('PRINT-STATUS-1: tek başarılı baskı → label-printed TAM 1 kez', async () => {
  stubFetch(() => true)
  const orders = [order('o-a', 'A')]
  const response = await runPrint(orders)

  expect(labelPrintedCalls).toEqual(['o-a'])
  const printedOrder = response.orders.find((entry) => entry.id === 'o-a')
  expect(printedOrder?.labelStatus).toBe('PRINTED')
}, 30000)

test('PRINT-STATUS-2: 3 seçili / 2 başarılı / 1 atlanan → TAM 2 çağrı', async () => {
  // C render edilemiyor → belgeye girmez → atlanır.
  stubFetch((orderId) => orderId !== 'o-c')
  const orders = [order('o-a', 'A'), order('o-b', 'B'), order('o-c', 'C')]
  const response = await runPrint(orders)

  expect([...labelPrintedCalls].sort()).toEqual(['o-a', 'o-b'])
  expect(labelPrintedCalls).toHaveLength(2)
  // ATLANAN sipariş DURUMUNU KORUR.
  const skipped = response.orders.find((entry) => entry.id === 'o-c')
  expect(skipped?.labelStatus).not.toBe('PRINTED')
}, 30000)

test('PRINT-STATUS-3: tanı depolaması kota hatası verse de label-printed ÇAĞRILIR', async () => {
  stubFetch(() => true)
  stubQuotaExceeded()
  const orders = [order('o-a', 'A')]

  // İŞ AKIŞI KESİLMEZ: fırlatmamalı.
  const response = await runPrint(orders)
  expect(labelPrintedCalls).toEqual(['o-a'])
  const printedOrder = response.orders.find((entry) => entry.id === 'o-a')
  expect(printedOrder?.labelStatus).toBe('PRINTED')
}, 30000)

test('DEBUG-STORAGE-1: tanı kaydı sınırlıdır ve başka anahtarlara DOKUNMAZ', async () => {
  const { apiDebugService } = await import('../services/apiDebugService')
  window.localStorage.setItem('cargoflow.other.key', 'korunmali')

  // Büyük geçmiş: her kayıt hacimli bir gövde taşır.
  const big = 'x'.repeat(20_000)
  for (let index = 0; index < 120; index += 1) {
    expect(() =>
      apiDebugService.append({
        provider: 'Sürat',
        operation: 'test',
        endpoint: '/test',
        requestUrl: '/test',
        responseStatus: 200,
        responseBody: `${big}-${index}`,
        status: 'SUCCESS',
        durationMs: 1,
      } as never),
    ).not.toThrow()
  }

  // Depolanan hacim SINIRLI kalır.
  const raw = window.localStorage.getItem('cargoflow.apiDebugLogs.v1') ?? ''
  expect(raw.length).toBeLessThanOrEqual(600_000)
  // En yeni kayıt korunur (FIFO: eskiler atılır).
  expect(raw).toContain('-119')
  // İLGİSİZ anahtar DEĞİŞMEZ.
  expect(window.localStorage.getItem('cargoflow.other.key')).toBe('korunmali')
}, 30000)

test('DEBUG-STORAGE-2: setItem sürekli fırlatsa bile append FIRLATMAZ', async () => {
  const { apiDebugService } = await import('../services/apiDebugService')
  const { AuditLogService } = await import('../services/auditLogService')
  const auditLogService = new AuditLogService()
  stubQuotaExceeded()

  expect(() =>
    apiDebugService.append({
      provider: 'Sürat',
      operation: 'test',
      endpoint: '/test',
      requestUrl: '/test',
      responseStatus: 200,
      status: 'SUCCESS',
      durationMs: 1,
    } as never),
  ).not.toThrow()
  expect(() =>
    auditLogService.append({
      action: 'test',
      level: 'success',
      details: 'test',
    } as never),
  ).not.toThrow()
}, 30000)
