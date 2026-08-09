import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CargoOrder } from '../types/cargoflow'

// GERÇEK TOPLU BASKI ZİNCİRİ — üretim caller'ının KULLANDIĞI modüller.
//
// Helper taklidi DEĞİL: App.tsx'in çağırdığı `persistedLabelHydration` →
// gerçek `OrderWorkflowService.printLabels` → gerçek
// `BrowserDownloadPrintProvider` → `officialSuratPrintRunner` → tek belge
// zinciri koşulur.
//
// ÖNCEKİ HARNESS NEDEN YANLIŞTI:
//   (a) servis `setAuthMode(true)` yapılmadığı için `fetchPersistedLabel`
//       her siparişte `null` dönüyordu → eligible=0,
//   (b) fetch stub'ı `/label` ile eşleştiği için resmî render ucunu
//       (`/api/labels/render/surat`) de kayıtlı-etiket yanıtıyla
//       cevaplıyordu.
// İkisi de bu dosyada düzeltildi.

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const RENDER_ENDPOINT = '/api/labels/render/surat'

interface OrderPlan {
  /** Kayıtlı etiket ucu bu siparişi basılabilir sayıyor mu. */
  carrierPrintReady: boolean
  /** Resmî render ucunun döndüreceği ürün detay sayfası sayısı. */
  detailPages: number
  /** Render yanıtı HİÇ sayfa üretmiyor (sessiz kayıp senaryosu). */
  noPages?: boolean
}

let renderRequests: string[] = []

/**
 * İKİ UCU KESİN AYIRAN stub. Render ucu ÖNCE eşleştirilir; aksi hâlde
 * `/api/labels/render/surat` de `/label` içerdiği için yanlış yanıt alır.
 */
function stubFetch(plans: Record<string, OrderPlan>) {
  renderRequests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) : {}

      if (href.includes(RENDER_ENDPOINT)) {
        const orderId = String(body.orderId ?? '')
        renderRequests.push(orderId)
        const plan = plans[orderId]
        if (!plan) {
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
          json: async () => renderArtifact(plan),
        } as unknown as Response
      }

      if (href.includes('/api/orders/')) {
        const orderId = href.split('/api/orders/')[1]?.split('/')[0] ?? ''
        const plan = plans[orderId]
        const ready = plan?.carrierPrintReady !== false
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            hasPrintableLabel: true,
            zpl: ready ? `^XA^FD${orderId}^FS^XZ` : null,
            source: 'shipment.printZplArtifact',
            desi: 2,
            print: {
              carrierPrintReady: ready,
              printArtifactStatus: ready ? 'ready' : 'failed',
              productDetailStatus: 'none',
              labelPageCount: ready ? 1 : 0,
              productDetailPageCount: 0,
              supplementalLabels: [],
            },
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

const renderArtifact = (plan: OrderPlan) => {
  const base = {
    ok: true,
    mimeType: 'image/png',
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
    missingPages: [],
  }
  if (plan.noPages) {
    // Ne `pages[]` ne de geriye uyumlu tek görüntü → hiç sayfa yok.
    return { ...base, imageBase64: '', pages: [], productDetailStatus: 'failed' }
  }
  return {
    ...base,
    imageBase64: PNG_BASE64,
    productDetailStatus: plan.detailPages > 0 ? 'ready' : 'none',
    pages: [
      {
        kind: 'carrier',
        page: 1,
        totalPages: plan.detailPages + 1,
        imageBase64: PNG_BASE64,
        mimeType: 'image/png',
      },
      ...Array.from({ length: plan.detailPages }, (_, index) => ({
        kind: 'product_detail',
        page: index + 2,
        totalPages: plan.detailPages + 1,
        imageBase64: PNG_BASE64,
        mimeType: 'image/png',
      })),
    ],
  }
}

const order = (id: string, orderNumber: string): CargoOrder =>
  ({
    id,
    orderNumber,
    marketplace: 'Trendyol',
    packageId: `PKG-${id}`,
    operationStatus: 'LABEL_READY',
    hasPrintableLabel: true,
    address: 'Sentetik Mahalle 1',
    customerName: 'SENTETIK ALICI',
    items: [
      { id: 'l1', productName: `Urun ${id}`, quantity: 1, merchantSku: `SKU-${id}` },
    ],
    shipment: {
      provider: 'surat-kargo',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      barcodeRaw: '^XA^FDESKI-KAYNAK^FS^XZ',
      zplReady: true,
      printEnabled: true,
    },
  }) as unknown as CargoOrder

const ORDERS = [order('o-a', 'A'), order('o-b', 'B'), order('o-c', 'C')]

let printSpy: ReturnType<typeof vi.fn>
let frame: HTMLIFrameElement

beforeEach(async () => {
  document.body.innerHTML = ''
  const { prepareSuratPrintHostSynchronously } = await import(
    '../utils/browserLabelPrint'
  )
  const host = prepareSuratPrintHostSynchronously()
  expect(host.ready).toBe(true)
  frame = document.querySelector('[data-surat-print-frame]') as HTMLIFrameElement
  printSpy = vi.fn()
  ;(frame.contentWindow as unknown as { print: unknown }).print = printSpy
  ;(frame.contentWindow as unknown as { focus: () => void }).focus = () => {}
  const { clearSuratRenderCache } = await import(
    '../services/suratLabelRenderClient'
  )
  clearSuratRenderCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const pageSections = () =>
  Array.from(frame.contentDocument?.querySelectorAll('.surat-official-page') ?? [])

async function makeService() {
  const { OrderWorkflowService } = await import('../services/orderWorkflowService')
  const { BrowserDownloadPrintProvider } = await import(
    '../providers/printing/BrowserDownloadPrintProvider'
  )
  const service = new OrderWorkflowService(
    {} as never,
    {} as never,
    {
      generateSingle: async () => ({ id: 'l', labelType: 'zpl', zplContent: '' }),
    } as never,
    new BrowserDownloadPrintProvider() as never,
    { append: () => undefined } as never,
  )
  // ÜRETİM YAPILANDIRMASI: auth modu açık olmadan kayıtlı etiket ucu
  // çağrılmaz ve hidrasyon hiçbir siparişi uygun bulmaz.
  service.setAuthMode(true)
  return service
}

/** ÜRETİM ZİNCİRİ: hidrasyon → printLabels → sağlayıcı → resmî koşucu. */
async function runBulk(orders: CargoOrder[]) {
  const { hydratePersistedLabels } = await import(
    '../services/persistedLabelHydration'
  )
  const service = await makeService()
  const printIds = orders.map((entry) => String(entry.id))

  const hydrated = await hydratePersistedLabels(printIds, orders, {
    fetchPersistedLabel: (id) => service.fetchPersistedLabel(id),
  })
  const response = await service.printLabels(
    hydrated.effectiveOrders,
    printIds,
    { mode: 'browser-print', printerName: 'x' } as never,
    { id: 't' } as never,
    {},
    {
      confirmedAt: '2026-08-09T00:00:00.000Z',
      labelPrintTemplate: 'surat_official_zpl',
    },
  )
  const sections = pageSections()
  const debug = response.printResult?.browserPrintDebug
  return {
    requested: printIds.length,
    cardinality: hydrated.cardinality,
    providerInput: hydrated.effectiveOrders.filter((entry) =>
      printIds.includes(String(entry.id)),
    ).length,
    renderRequested: renderRequests.length,
    domPages: sections.length,
    orderAttrs: sections.map((section) => section.getAttribute('data-order')),
    uniqueOrders: new Set(
      sections.map((section) => section.getAttribute('data-order')),
    ).size,
    printCalls: printSpy.mock.calls.length,
    skipped: (debug?.skipped ?? []) as Array<{ orderNumber: string; reason: string }>,
    printedOrderNumbers: debug?.printedOrderNumbers ?? [],
  }
}

const allReady = (detail = 0): Record<string, OrderPlan> => ({
  'o-a': { carrierPrintReady: true, detailPages: detail },
  'o-b': { carrierPrintReady: true, detailPages: detail },
  'o-c': { carrierPrintReady: true, detailPages: detail },
})

test('REAL-BULK-WIRING-1: 3 tek-ürünlü sipariş → 3 sayfa, 3 sipariş, TEK print', async () => {
  stubFetch(allReady(0))
  const result = await runBulk(ORDERS)

  // HİDRASYON KARDİNALİTEYİ KORUR.
  expect(result.requested).toBe(3)
  expect(result.cardinality.eligible).toBe(3)
  expect(result.cardinality.contracts).toBe(3)
  expect(result.cardinality.blocked).toBe(0)
  expect(result.cardinality.effectiveOrders).toBe(3)
  expect(result.providerInput).toBe(3)
  // RENDER + BELGE.
  expect(result.renderRequested).toBe(3)
  expect(result.domPages).toBe(3)
  expect(result.orderAttrs).toEqual(['A', 'B', 'C'])
  expect(result.uniqueOrders).toBe(3)
  expect(result.printedOrderNumbers).toEqual(['A', 'B', 'C'])
  expect(result.skipped).toHaveLength(0)
  // TEK BASKI ÇAĞRISI.
  expect(result.printCalls).toBe(1)
}, 30000)

test('REAL-BULK-WIRING-2: 1+2+3 sayfa → 6 fiziksel sayfa, gönderi bazında sıra', async () => {
  stubFetch({
    'o-a': { carrierPrintReady: true, detailPages: 0 },
    'o-b': { carrierPrintReady: true, detailPages: 1 },
    'o-c': { carrierPrintReady: true, detailPages: 2 },
  })
  const result = await runBulk(ORDERS)

  expect(result.domPages).toBe(6)
  // Ek sayfalar işin SONUNA toplanmaz; her taşıyıcı KENDİ detaylarından önce.
  expect(result.orderAttrs).toEqual(['A', 'B', 'B', 'C', 'C', 'C'])
  expect(result.uniqueOrders).toBe(3)
  expect(result.printCalls).toBe(1)
}, 30000)

test('REAL-BULK-WIRING-3: sayfa üretmeyen sipariş SESSİZCE kaybolmaz', async () => {
  stubFetch({
    'o-a': { carrierPrintReady: true, detailPages: 0 },
    'o-b': { carrierPrintReady: true, detailPages: 0, noPages: true },
    'o-c': { carrierPrintReady: true, detailPages: 0 },
  })
  const result = await runBulk(ORDERS)

  expect(result.requested).toBe(3)
  expect(result.domPages).toBe(2)
  expect(result.orderAttrs).toEqual(['A', 'C'])
  expect(result.uniqueOrders).toBe(2)
  // AÇIK ATLAMA — sessiz düşme İMKÂNSIZ.
  expect(result.skipped.map((item) => item.orderNumber)).toContain('B')
  expect(result.uniqueOrders + result.skipped.length).toBe(3)
  expect(result.printCalls).toBe(1)
}, 30000)

test('REAL-BULK-WIRING-4: basılamaz sipariş diğerlerini DÜŞÜRMEZ', async () => {
  stubFetch({
    'o-a': { carrierPrintReady: true, detailPages: 0 },
    'o-b': { carrierPrintReady: false, detailPages: 0 },
    'o-c': { carrierPrintReady: true, detailPages: 0 },
  })
  const { hydratePersistedLabels } = await import(
    '../services/persistedLabelHydration'
  )
  const service = await makeService()
  const printIds = ORDERS.map((entry) => String(entry.id))
  const hydrated = await hydratePersistedLabels(printIds, ORDERS, {
    fetchPersistedLabel: (id) => service.fetchPersistedLabel(id),
  })

  // KARDİNALİTE KORUNUR: B elenmez, yalnız kaynağı temizlenir.
  expect(hydrated.effectiveOrders).toHaveLength(3)
  expect(hydrated.cardinality.contracts).toBe(2)
  expect(hydrated.cardinality.blocked).toBe(1)

  const blocked = hydrated.effectiveOrders.find((entry) => entry.id === 'o-b')
  expect(blocked?.shipment?.barcodeRaw).toBeUndefined()
  // İSTEMCİ KAYNAK FALLBACK'İ AÇILMAZ.
  expect(JSON.stringify(blocked)).not.toContain('ESKI-KAYNAK')

  // Geçerli siparişler sunucu baytlarını aldı.
  for (const id of ['o-a', 'o-c']) {
    const ok = hydrated.effectiveOrders.find((entry) => entry.id === id)
    expect(ok?.shipment?.barcodeRaw).toBe(`^XA^FD${id}^FS^XZ`)
  }
}, 30000)
