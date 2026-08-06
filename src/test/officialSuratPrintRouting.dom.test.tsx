import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { OrderWorkflowService } from '../services/orderWorkflowService'
import { TrendyolProvider } from '../providers/marketplace/TrendyolProvider'
import { SuratKargoProvider } from '../providers/shipping/SuratKargoProvider'
import { ZebraZplLabelProvider } from '../providers/labels/ZebraZplLabelProvider'
import { BrowserDownloadPrintProvider } from '../providers/printing/BrowserDownloadPrintProvider'
import { AuditLogService } from '../services/auditLogService'
import { defaultLabelTemplate } from '../services/integrationConfigService'
import { runSuratCreateAndPrint } from '../services/suratCreateAndPrintOrchestrator'
import { buildPrintAdapter } from '../services/suratOrchestratorDeps'
import { SuratOfficialLabelPreview } from '../components/SuratOfficialLabelPreview'
import {
  clearSuratRenderCache,
  peekSuratRenderArtifact,
  SURAT_RENDER_ENDPOINT,
} from '../services/suratLabelRenderClient'
import { prepareSuratPrintHostSynchronously } from '../utils/browserLabelPrint'
import { SURAT_ONLY_TEMPLATE_MESSAGE } from '../utils/labelPrintTemplateRouting'
import type { CargoOrder, PrinterSettings } from '../types/cargoflow'

// RESMÎ SÜRAT BASKI YÖNLENDİRMESİ — REGRESYON.
//
// CANLI HATA (master 65b3f5e): READY bir Sürat siparişinde "Resmî Sürat
// Şablonuyla Yazdır" seçildiğinde baskı başlamıyor, sipariş
// "Yazdırılacak etiket bulunamadı." sebebiyle atlanıyordu.
//
// KÖK NEDEN: şablon kararından ÖNCE CargoFlow HTML yoluna ait içerik koşulları
// uygulanıyordu (istemci ham ZPL uygunluğu, CargoFlow etiket üretimi,
// `order.label` varlığı, HTML ürün-sığdırma). Ayrıca render ucu hata
// döndürdüğünde GERÇEK sebep generic mesajla EZİLİYORDU.
//
// Bu dosya zinciri GERÇEK servislerle sürer (orkestratör → adaptör →
// orderWorkflowService.printLabels → BrowserDownloadPrintProvider → koşucu →
// kalıcı gizli iframe). YALNIZ ağ ucu ve `window.print` stub'lanır.
// TÜM VERİLER SENTETİKTİR.

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

const RENDER_FAILURE = {
  ok: false,
  code: 'label_not_ready',
  message: 'Kayıtlı Sürat etiketi bulunamadı.',
}

const BROWSER_PRINTER: PrinterSettings = {
  mode: 'browser-print',
  printerName: 'Test',
  labelSize: '100x100',
} as unknown as PrinterSettings

const ZEBRA_PRINTER: PrinterSettings = {
  mode: 'local-agent',
  printerName: 'Zebra',
  labelSize: '100x100',
} as unknown as PrinterSettings

let fetchCalls: Array<{ url: string; body: unknown }> = []
let originalFetch: typeof globalThis.fetch
let printCallCount = 0

/** Tüm ağ uçlarını kaydeder; render ucu için yanıtı `responder` belirler. */
function stubFetch(responder?: (body: Record<string, unknown>) => unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    fetchCalls.push({ url: String(url), body })
    if (String(url).includes('/api/printing/zebra/raw')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          provider: 'zebra-local-agent',
          printJobId: 'zebra-1',
          jobs: [{ orderNumber: body.labels?.[0]?.orderNumber, ok: true }],
        }),
      } as unknown as Response
    }
    const payload = (responder ? responder(body) : ARTIFACT) as { ok?: boolean }
    return {
      ok: Boolean(payload.ok),
      status: payload.ok ? 200 : 409,
      json: async () => payload,
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
}

const renderCalls = () =>
  fetchCalls.filter((call) => call.url === SURAT_RENDER_ENDPOINT)
const zebraRawCalls = () =>
  fetchCalls.filter((call) => call.url.includes('/api/printing/zebra/raw'))

/** Kalıcı gizli iframe'i hazırlar ve `window.print`i gözler. */
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
  fetchCalls = []
  originalFetch = globalThis.fetch
  clearSuratRenderCache()
  document.body.innerHTML = ''
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

// READY Sürat siparişi. CANLI SENARYO: sipariş hazırdır (create GEREKMEZ).
function readyOrder(over: Record<string, unknown> = {}): CargoOrder {
  const base = {
    id: 'o-1',
    marketplace: 'Trendyol',
    orderNumber: '1000000000000001',
    packageId: 'PKG-1',
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
      ozelKargoTakipNo: '1000000000000001',
      barcodeRaw:
        '^XA^PW799^LL0799^FO60,150^BY3^BCN,130,Y,N,N^FD01200000001^FS^XZ',
      desi: 2,
    },
  } as Record<string, unknown>
  return { ...base, ...over } as unknown as CargoOrder
}

/**
 * CANLI KAYIT ŞEKLİ: sunucuda kayıtlı printZpl vardır, fakat istemcideki
 * sipariş nesnesi ham ZPL TAŞIMAZ ve CargoFlow etiketi ÜRETİLEMEZ. Resmî
 * şablon bu kaydı basabilmelidir.
 */
function readyOrderWithoutClientZpl(): CargoOrder {
  const order = readyOrder()
  return {
    ...order,
    label: undefined,
    shipment: { ...(order.shipment as object), barcodeRaw: '' },
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

/** App'in `callPrint` adaptörüyle AYNI çağrı: tek yönlendirme noktası. */
async function printWith(
  orders: CargoOrder[],
  template: 'cargoflow_html' | 'surat_official_zpl' | undefined,
  printerSettings: PrinterSettings = BROWSER_PRINTER,
) {
  return makeService().printLabels(
    orders,
    orders.map((order) => String(order.id)),
    printerSettings,
    defaultLabelTemplate,
    {},
    {
      confirmedAt: new Date().toISOString(),
      printedBy: 'test',
      ...(template ? { labelPrintTemplate: template } : {}),
    },
  )
}

// ── SR-1..SR-2: YÖNLENDİRME UCU ────────────────────────────────────────────

test('SR-1: READY Sürat + resmî şablon → render ucu BİR KEZ çağrılır', async () => {
  stubFetch()
  prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  expect(renderCalls()).toHaveLength(1)
  expect(renderCalls()[0].body).toEqual({ orderId: 'o-1' })
})

test('SR-2: resmî şablonda /api/printing/zebra/raw ÇAĞRILMAZ', async () => {
  stubFetch()
  prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  expect(zebraRawCalls()).toHaveLength(0)
})

// ── SR-3..SR-4: CARGOFLOW HTML ÖN KOŞULLARI RESMÎ MODDA ARANMAZ ────────────

test('SR-3: CargoFlow etiketi (labelHtml) bulunmasa bile ATLANMAZ', async () => {
  stubFetch()
  prepareHost()
  // `label` YOK: CargoFlow HTML yolu için gerekli taşıyıcı hiç üretilmemiş.
  const outcome = await printWith(
    [readyOrder({ label: undefined })],
    'surat_official_zpl',
  )
  expect(renderCalls()).toHaveLength(1)
  expect(outcome.printResult?.jobs?.[0].ok).toBe(true)
  expect(outcome.result.message).not.toContain('atlandı')
})

test('SR-4: istemci barcodeRaw koşulu ARANMAZ (ham ZPL istemciye inmez)', async () => {
  stubFetch()
  prepareHost()
  const outcome = await printWith(
    [readyOrderWithoutClientZpl()],
    'surat_official_zpl',
  )
  // Eski davranış: eleme + CargoFlow etiket üretiminde hata → uç HİÇ çağrılmaz.
  expect(renderCalls()).toHaveLength(1)
  expect(outcome.printResult?.jobs?.[0].ok).toBe(true)
  // İstemci hâlâ YALNIZ canonical kimlik gönderir.
  expect(renderCalls()[0].body).toEqual({ orderId: 'o-1' })
})

// ── SR-5..SR-7: BAŞARILI RENDER ────────────────────────────────────────────

test('SR-5: başarılı render resmî PNG baskı belgesi üretir', async () => {
  stubFetch()
  const frame = prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  const pages = frame.contentDocument?.querySelectorAll('.surat-official-page')
  expect(pages?.length).toBe(1)
  expect(
    frame.contentDocument
      ?.querySelector('.surat-official-page img')
      ?.getAttribute('src'),
  ).toBe(`data:image/png;base64,${PNG_BASE64}`)
  // CargoFlow HTML etiketi resmî modda YENİDEN ÇİZİLMEZ.
  expect(frame.contentDocument?.querySelector('.label-page')).toBe(null)
})

test('SR-6: başarılı render window.print ÇAĞIRIR', async () => {
  stubFetch()
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  expect(printCallCount).toBe(1)
  expect(outcome.printResult?.browserPrintDebug?.printCalled).toBe(true)
  expect(outcome.printResult?.browserPrintDebug?.printMode).toBe(
    'surat-official-png',
  )
})

test('SR-7: başarılı render jobs[0].ok === true', async () => {
  stubFetch()
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  expect(outcome.printResult?.jobs?.[0]).toMatchObject({
    orderNumber: '1000000000000001',
    ok: true,
  })
})

// ── SR-8..SR-11: RENDER HATASI ─────────────────────────────────────────────

test('SR-8: render hatasında jobs[0].ok === false', async () => {
  stubFetch(() => RENDER_FAILURE)
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  expect(outcome.printResult?.jobs?.[0].ok).toBe(false)
  expect(outcome.printResult?.ok).toBe(false)
  // window.print BOŞ belgeyle ÇAĞRILMAZ.
  expect(printCallCount).toBe(0)
})

test('SR-9: render hatasında sipariş READY KALIR (PRINTED olmaz)', async () => {
  stubFetch(() => RENDER_FAILURE)
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  const after = outcome.orders.find((order) => order.id === 'o-1')
  expect(after?.labelStatus).toBe('READY')
  expect(after?.operationStatus).toBe('LABEL_READY')
  expect(after?.label?.printedAt).toBe(undefined)
})

test('SR-10: render hatasında printCount ARTMAZ', async () => {
  stubFetch(() => RENDER_FAILURE)
  prepareHost()
  const before = readyOrder({
    label: { zplContent: '^XA^XZ', printCount: 3 },
  })
  const outcome = await printWith([before], 'surat_official_zpl')
  expect(outcome.orders.find((order) => order.id === 'o-1')?.label?.printCount).toBe(3)
})

test('SR-11: render hatasında "Yazdırılacak etiket bulunamadı" KULLANILMAZ', async () => {
  stubFetch(() => RENDER_FAILURE)
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  const reasons = [
    outcome.result.message ?? '',
    outcome.printResult?.errorMessage ?? '',
    ...(outcome.printResult?.jobs ?? []).map((job) => job.errorMessage ?? ''),
    ...((outcome.printResult?.browserPrintDebug?.skipped ?? []).map(
      (item) => item.reason,
    )),
  ].join(' | ')
  expect(reasons).not.toContain('Yazdırılacak etiket bulunamadı')
  // GERÇEK sebep korunur.
  expect(outcome.printResult?.jobs?.[0].errorMessage).toBe(
    'Kayıtlı Sürat etiketi bulunamadı.',
  )
})

// ── SR-12: YENİ CREATE + RENDER HATASI ─────────────────────────────────────

test('SR-12: create başarılı + render başarısız → READY kalır, PRINTED olmaz', async () => {
  stubFetch(() => RENDER_FAILURE)
  prepareHost()
  // Create ÖNCESİ sipariş: etiketi yok.
  const pending = readyOrder({
    id: 'o-new',
    hasPrintableLabel: false,
    label: undefined,
    labelStatus: undefined,
    operationStatus: 'CREATE_REQUIRED',
    shipment: undefined,
  })
  // Create SONRASI canonical READY sipariş (provider ÇAĞRILMAZ; stub).
  const created = readyOrder({ id: 'o-new' })
  let createCalls = 0
  const service = makeService()

  const outcome = await runSuratCreateAndPrint([pending], [pending], {
    preflight: {
      isSuratOrder: () => true,
      resolveDataBlock: () => null,
      resolveDesiBlock: () => null,
      resolveFitBlock: () => null,
      hasPrintableLabel: (order) => order.hasPrintableLabel === true,
      isPrinted: (order) =>
        order.labelStatus === 'PRINTED' && Boolean(order.label?.printedAt),
      isInFlight: () => false,
    },
    createShipments: async () => {
      createCalls += 1
      return { orders: [created], failedIds: [], reasons: {} }
    },
    printLabels: buildPrintAdapter({
      callPrint: async (list, ids) =>
        service.printLabels(list, ids, BROWSER_PRINTER, defaultLabelTemplate, {}, {
          confirmedAt: new Date().toISOString(),
          printedBy: 'test',
          labelPrintTemplate: 'surat_official_zpl',
        }),
    }),
  })

  expect(createCalls).toBe(1)
  expect(outcome.created).toBe(1)
  expect(outcome.printed).toBe(0)
  // İKİNCİ provider çağrısı YOK; create geri ALINMAZ.
  const after = outcome.orders.find((order) => order.id === 'o-new')
  expect(after?.labelStatus).toBe('READY')
  expect(after?.label?.printedAt).toBe(undefined)
  // Sebep GERÇEK render hatasıdır, generic "etiket bulunamadı" DEĞİL.
  const reason = [...outcome.skipped, ...outcome.failed][0]?.reason ?? ''
  expect(reason).toBe('Kayıtlı Sürat etiketi bulunamadı.')
})

// ── SR-13: CARGOFLOW HTML REGRESYONU ───────────────────────────────────────

test('SR-13: CargoFlow HTML modu DEĞİŞMEDEN çalışır (render ucu çağrılmaz)', async () => {
  stubFetch()
  prepareHost()
  // (a) Tarayıcı baskısı: mevcut HTML renderer, render ucu YOK.
  const browser = await printWith([readyOrder()], 'cargoflow_html')
  expect(renderCalls()).toHaveLength(0)
  expect(browser.printResult?.provider).toBe('browser-label-document')
  expect(browser.printResult?.browserPrintDebug?.printMode).not.toBe(
    'surat-official-png',
  )

  // (b) Zebra yolu: MEVCUT /api/printing/zebra/raw ucu aynen kullanılır.
  fetchCalls = []
  const zebra = await printWith([readyOrder()], 'cargoflow_html', ZEBRA_PRINTER)
  expect(zebraRawCalls()).toHaveLength(1)
  expect(renderCalls()).toHaveLength(0)
  expect(zebra.printResult?.provider).toBe('zebra-local-agent')

  // (c) Şablon HİÇ verilmediğinde de davranış CargoFlow HTML'dir.
  fetchCalls = []
  const legacy = await printWith([readyOrder()], undefined)
  expect(renderCalls()).toHaveLength(0)
  expect(legacy.printResult?.provider).toBe('browser-label-document')
})

// ── SR-14: SÜRAT DIŞI SAĞLAYICI ────────────────────────────────────────────

test('SR-14: Sürat dışı gönderide render ucu ÇAĞRILMAZ, güvenli mesaj döner', async () => {
  stubFetch()
  prepareHost()
  const foreign = readyOrder({
    id: 'o-foreign',
    orderNumber: '2000000000000002',
    // KANONİK kalıcı sağlayıcı alanı; UI satır metni DEĞİL.
    shipment: { ...(readyOrder().shipment as object), provider: 'baska-kargo' },
  })
  const outcome = await printWith([foreign], 'surat_official_zpl')
  expect(renderCalls()).toHaveLength(0)
  expect(outcome.printResult?.jobs?.[0].ok).toBe(false)
  expect(outcome.printResult?.jobs?.[0].errorMessage).toBe(
    SURAT_ONLY_TEMPLATE_MESSAGE,
  )
  expect(printCallCount).toBe(0)
})

// ── SR-15: TOPLU BASKI İZOLASYONU ──────────────────────────────────────────

test('SR-15: bir render hatası DİĞER başarılı etiketleri engellemez', async () => {
  stubFetch((body) => (body.orderId === 'o-bad' ? RENDER_FAILURE : ARTIFACT))
  const frame = prepareHost()
  const good = readyOrder({ id: 'o-good', orderNumber: '111' })
  const bad = readyOrder({ id: 'o-bad', orderNumber: '999' })
  const outcome = await printWith([bad, good], 'surat_official_zpl')

  const jobs = outcome.printResult?.jobs ?? []
  expect(jobs.find((job) => job.orderNumber === '111')?.ok).toBe(true)
  expect(jobs.find((job) => job.orderNumber === '999')?.ok).toBe(false)
  expect(jobs.find((job) => job.orderNumber === '999')?.errorMessage).toBe(
    'Kayıtlı Sürat etiketi bulunamadı.',
  )
  // Belgede YALNIZ sağlıklı sipariş var; sonda boş sayfa YOK.
  expect(
    frame.contentDocument?.querySelectorAll('.surat-official-page').length,
  ).toBe(1)
  // Yalnız başarılı sipariş PRINTED olur.
  expect(outcome.orders.find((order) => order.id === 'o-good')?.labelStatus).toBe(
    'PRINTED',
  )
  expect(outcome.orders.find((order) => order.id === 'o-bad')?.labelStatus).toBe(
    'READY',
  )
})

// ── SR-16: ÖNİZLEME → BASKI ARTEFAKT EŞİTLİĞİ ──────────────────────────────

test('SR-16: önizleme sonrası baskı AYNI imageBase64/renderSha256 kullanır', async () => {
  stubFetch()
  render(<SuratOfficialLabelPreview order={readyOrder()} />)
  await screen.findByTestId('surat-official-preview')
  const previewArtifact = peekSuratRenderArtifact('o-1')
  expect(previewArtifact?.renderSha256).toBe(ARTIFACT.renderSha256)

  const frame = prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  // İkinci render ÇALIŞTIRILMADI.
  expect(renderCalls()).toHaveLength(1)
  const printed = peekSuratRenderArtifact('o-1')
  expect(printed?.imageBase64).toBe(previewArtifact?.imageBase64)
  expect(printed?.renderSha256).toBe(previewArtifact?.renderSha256)
  expect(
    frame.contentDocument
      ?.querySelector('.surat-official-page img')
      ?.getAttribute('src'),
  ).toBe(`data:image/png;base64,${previewArtifact?.imageBase64}`)
})

// ── SR-17: BAŞARISIZ ÖNBELLEK GİRDİSİ SONRAKİ BASKIYI BOZMAZ ───────────────

test('SR-17: başarısız render önbelleğe YAZILMAZ; sonraki deneme başarılı olur', async () => {
  let failFirst = true
  stubFetch(() => {
    if (failFirst) {
      failFirst = false
      return RENDER_FAILURE
    }
    return ARTIFACT
  })
  prepareHost()
  const first = await printWith([readyOrder()], 'surat_official_zpl')
  expect(first.printResult?.jobs?.[0].ok).toBe(false)
  expect(peekSuratRenderArtifact('o-1')).toBe(undefined)

  const second = await printWith([readyOrder()], 'surat_official_zpl')
  expect(second.printResult?.jobs?.[0].ok).toBe(true)
  expect(renderCalls()).toHaveLength(2)
})

// ── SR-18: CANLI SENARYONUN BİREBİR FIXTURE'I ──────────────────────────────
//
// Ekrandaki değerler: Seçilen 1 / Yeni oluşturulan 0 / Hazır etiket 1 /
// Tekrar baskı 0 / Yazdırılan 0 / Atlanan 1 / Başarısız 0 —
// sebep "Yazdırılacak etiket bulunamadı." Beklenen: atlanan 0, render ucu
// 1 çağrı, baskı belgesi 1 dispatch.

async function runLiveScenario(order: CargoOrder) {
  const frame = prepareHost()
  const service = makeService()
  let createCalls = 0

  const outcome = await runSuratCreateAndPrint([order], [order], {
    preflight: {
      isSuratOrder: () => true,
      resolveDataBlock: () => null,
      resolveDesiBlock: () => null,
      // App ile AYNI: resmî şablonda HTML sığdırma koşulu uygulanmaz.
      resolveFitBlock: () => null,
      hasPrintableLabel: (item) => item.hasPrintableLabel === true,
      isPrinted: (item) =>
        item.labelStatus === 'PRINTED' && Boolean(item.label?.printedAt),
      isInFlight: () => false,
    },
    createShipments: async (orders) => {
      createCalls += 1
      return { orders, failedIds: [], reasons: {} }
    },
    printLabels: buildPrintAdapter({
      callPrint: async (list, ids) =>
        service.printLabels(list, ids, BROWSER_PRINTER, defaultLabelTemplate, {}, {
          confirmedAt: new Date().toISOString(),
          printedBy: 'test',
          labelPrintTemplate: 'surat_official_zpl',
        }),
    }),
  })

  return { outcome, createCalls, frame }
}

test('SR-18: canlı senaryo — selected 1, ready 1, override resmî şablon', async () => {
  // İKİ KAYIT ŞEKLİ de AYNI sonucu vermelidir:
  //  (a) istemcide ham ZPL taşıyan tam kayıt,
  //  (b) CANLI HATANIN kaydı: sunucuda kayıtlı printZpl var, istemcide ham ZPL
  //      ve CargoFlow etiketi YOK. (b) eskiden "Atlanan: 1 —
  //      Yazdırılacak etiket bulunamadı." üretiyordu.
  for (const order of [readyOrder(), readyOrderWithoutClientZpl()]) {
    fetchCalls = []
    clearSuratRenderCache()
    document.body.innerHTML = ''
    stubFetch()
    const { outcome, createCalls, frame } = await runLiveScenario(order)

    expect(outcome.selectedCount).toBe(1)
    expect(outcome.created).toBe(0)
    expect(createCalls).toBe(0)
    expect(outcome.existingReady).toBe(1)
    expect(outcome.reprinted).toBe(0)
    expect(outcome.printed).toBe(1)
    expect(outcome.skipped).toEqual([])
    expect(outcome.failed).toEqual([])
    // Render ucu 1 çağrı, baskı belgesi 1 dispatch.
    expect(renderCalls()).toHaveLength(1)
    expect(printCallCount).toBe(1)
    expect(
      frame.contentDocument?.querySelectorAll('.surat-official-page').length,
    ).toBe(1)
  }
}, 20000)
