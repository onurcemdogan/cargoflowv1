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

// ═══ CHROME ÇOK SAYFALI BASKI BELGESİ ════════════════════════════════════
//
// ÜRETİM HATASI: N PNG render ediliyor, DOM'da N bölüm var, N sipariş
// "basıldı" sayılıyor — ama Chrome TEK sayfa basıyordu.
//
// KÖK NEDEN: belge CSS'inde `html, body { height: 100mm; overflow: hidden }`.
// İlk etiket gövdeyi dolduruyor, 2..N sayfalar taşıp KIRPILIYORDU.
// jsdom layout uygulamadığı için DOM sayan testler bunu göremiyordu; bu
// yüzden aşağıdaki testler CSS SÖZLEŞMESİNİ doğrudan kilitler.

async function buildDoc(pageCount: number) {
  const { buildOfficialSuratPrintDocument } = await import(
    '../utils/officialSuratPrintDocument'
  )
  return buildOfficialSuratPrintDocument(
    Array.from({ length: pageCount }, (_, index) => ({
      orderNumber: `ORD-${index}`,
      imageBase64: PNG_BASE64,
      mimeType: 'image/png',
    })),
  )
}

function styleOf(html: string): string {
  return html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
}

test('CHROME-BULK-DOCUMENT-1: gövde sayfaları KIRPMAZ (kök neden regresyonu)', async () => {
  const doc = await buildDoc(2)
  const style = styleOf(doc.html)

  // GÖVDE artık tek etiket boyunda DEĞİL ve kırpmıyor.
  const bodyRule = style.slice(style.indexOf('html, body'), style.indexOf('.surat-official-page'))
  expect(bodyRule).not.toContain('height: 100mm')
  expect(bodyRule).not.toContain('overflow: hidden')

  // Etiket geometrisi KORUNDU.
  expect(style).toContain('@page { size: 100mm 100mm; margin: 0; }')
  expect(style).toContain('width: 100mm; height: 100mm')

  // Sayfalar normal akışta, üst üste bindirilmiyor.
  expect(style).toContain('position: static')
  expect(style).not.toContain('position: absolute')
  expect(style).not.toContain('position: fixed')

  // HER etiket kendi fiziksel sayfası; SONDA boş sayfa yok.
  expect(style).toContain('page-break-after: always')
  expect(style).toContain('break-after: page')
  expect(style).toContain('.surat-official-page:last-child')
  expect(style).toContain('break-after: auto')

  // İkinci sayfayı gizleyebilecek kural YOK.
  expect(style).not.toContain('display: none')
  expect(style).not.toContain(':not(:first-child)')
})

test('CHROME-BULK-DOCUMENT-2: 2 ve 3 sipariş → 2 ve 3 fiziksel bölüm', async () => {
  for (const count of [2, 3]) {
    const doc = await buildDoc(count)
    expect(doc.pages).toHaveLength(count)
    const sections = doc.html.match(/class="surat-official-page"/g) ?? []
    expect(sections).toHaveLength(count)
    const images = doc.html.match(/<img /g) ?? []
    expect(images).toHaveLength(count)
    // Her bölüm KENDİ siparişini taşır.
    for (let index = 0; index < count; index += 1) {
      expect(doc.html).toContain(`data-order="ORD-${index}"`)
    }
  }
})

test('CHROME-BULK-DOCUMENT-3: 6 fiziksel sayfa tek belgede ve SIRADA', async () => {
  const { buildOfficialSuratPrintDocument } = await import(
    '../utils/officialSuratPrintDocument'
  )
  const plan = [
    ['A', 'A'],
    ['B', 'B'],
    ['B', 'B-detail'],
    ['C', 'C'],
    ['C', 'C-detail1'],
    ['C', 'C-detail2'],
  ]
  const doc = buildOfficialSuratPrintDocument(
    plan.map(([orderNumber]) => ({
      orderNumber,
      imageBase64: PNG_BASE64,
      mimeType: 'image/png',
    })),
  )
  expect(doc.pages).toHaveLength(6)
  expect((doc.html.match(/class="surat-official-page"/g) ?? [])).toHaveLength(6)
  // Gönderi bazında sıra korunur: ek sayfalar sona TOPLANMAZ.
  const orders = Array.from(doc.html.matchAll(/data-order="([^"]+)"/g)).map(
    (match) => match[1],
  )
  expect(orders).toEqual(['A', 'B', 'B', 'C', 'C', 'C'])
})

test('CHROME-BULK-DOCUMENT-4: eksik sayfa belgeye sızmaz, kalanlar basılır', async () => {
  const { buildOfficialSuratPrintDocument } = await import(
    '../utils/officialSuratPrintDocument'
  )
  const doc = buildOfficialSuratPrintDocument(
    [
      { orderNumber: 'A', imageBase64: PNG_BASE64, mimeType: 'image/png' },
      { orderNumber: 'C', imageBase64: PNG_BASE64, mimeType: 'image/png' },
    ],
    [{ orderNumber: 'B', reason: 'render_pages_missing' }],
  )
  expect(doc.pages).toHaveLength(2)
  expect((doc.html.match(/class="surat-official-page"/g) ?? [])).toHaveLength(2)
  // Atlanan sipariş AÇIKÇA taşınır.
  expect(doc.skipped.map((item) => item.orderNumber)).toEqual(['B'])
})

test('CHROME-BULK-DOCUMENT-5: baskı öncesi kardinalite kilidi var', async () => {
  const module = await import('../utils/browserLabelPrint?raw')
  const source = String((module as { default: string }).default)
  // Beklenen ve gerçekleşen fiziksel sayfa sayısı KARŞILAŞTIRILIR.
  expect(source).toContain('PRINT_DOCUMENT_CARDINALITY')
  expect(source).toContain('actualPhysicalPages !== expectedPhysicalPages')
  // Görüntüler yüklenmeden print çağrılmaz.
  expect(source).toContain('waitForLabelImages')
  // Belge iframe'e TEK kez yazılır; sipariş/sayfa döngüsü içinde write YOK.
  // (host hazirligindaki placeholder yazimi ayridir ve sayfa uretmez.)
  expect(source.match(/writePrintDocument\(frameDocument, printHtml\)/g) ?? []).toHaveLength(1)
  // Tek baskı çağrısı noktası.
  expect((source.match(/frameWindow\.print\(\)/g) ?? []).length).toBeLessThanOrEqual(1)
})
