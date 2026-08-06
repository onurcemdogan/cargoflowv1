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
import {
  clearSuratRenderCache,
  fetchSuratRenderArtifact,
  peekSuratRenderArtifact,
  SuratRenderRequestError,
  SURAT_RENDER_ENDPOINT,
} from '../services/suratLabelRenderClient'
import {
  AUTH_CREDENTIALS_MODE,
  AUTH_REQUIRED_MESSAGE,
  authenticatedApiRequest,
  isAuthFailureStatus,
} from '../services/authenticatedApiRequest'
import { prepareSuratPrintHostSynchronously } from '../utils/browserLabelPrint'
import type { CargoOrder, PrinterSettings } from '../types/cargoflow'

// RESMÎ SÜRAT RENDER — AUTH PROPAGATION REGRESYONU (İSTEMCİ TARAFI).
//
// Sunucu tarafı (mount + gerçek session + requireAuth) ayrı dosyada:
// server/surat-render-auth-flow.test.mjs
//
// Burada doğrulanan: render isteği CargoFlow'un ortak authenticated API
// sözleşmesinden geçer, yalnız canonical kimlik taşır, oturum reddinde
// güvenli mesaj üretir ve hiçbir statü/sayaç değişmez.
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

// Sunucunun oturum reddi (requireAuth).
const AUTH_DENIED = { ok: false, message: 'Oturum gerekli.' }

const BROWSER_PRINTER: PrinterSettings = {
  mode: 'browser-print',
  printerName: 'Test',
  labelSize: '100x100',
} as unknown as PrinterSettings

interface RecordedCall {
  url: string
  init: RequestInit | undefined
  body: Record<string, unknown>
}

let calls: RecordedCall[] = []
let originalFetch: typeof globalThis.fetch
let printCallCount = 0

/** `status` 200 dışındaysa gövde hata yanıtı olarak döner. */
function stubFetch(
  responder?: (body: Record<string, unknown>) => { status: number; payload: unknown },
) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), init, body })
    if (String(url).includes('/api/printing/zebra/raw')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, provider: 'zebra-local-agent', jobs: [] }),
      } as unknown as Response
    }
    const result = responder
      ? responder(body)
      : { status: 200, payload: ARTIFACT }
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.payload,
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
      barcodeRaw:
        '^XA^PW799^LL0799^FO60,150^BY3^BCN,130,Y,N,N^FD01200000001^FS^XZ',
      desi: 2,
    },
  } as Record<string, unknown>
  return { ...base, ...over } as unknown as CargoOrder
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

async function printWith(
  orders: CargoOrder[],
  template: 'cargoflow_html' | 'surat_official_zpl' | undefined,
) {
  return makeService().printLabels(
    orders,
    orders.map((order) => String(order.id)),
    BROWSER_PRINTER,
    defaultLabelTemplate,
    {},
    {
      confirmedAt: new Date().toISOString(),
      printedBy: 'test',
      ...(template ? { labelPrintTemplate: template } : {}),
    },
  )
}

// ── RA-C1..RA-C6: ORTAK AUTH SÖZLEŞMESİ ────────────────────────────────────

test('RA-C1: render client ortak authenticated helper üzerinden gider', async () => {
  stubFetch()
  await fetchSuratRenderArtifact('o-1')
  expect(renderCalls()).toHaveLength(1)
  // Sözleşme: oturum cookie'si taşınır.
  expect(renderCalls()[0].init?.credentials).toBe(AUTH_CREDENTIALS_MODE)
  expect(AUTH_CREDENTIALS_MODE).toBe('include')
  // Kök-göreli aynı-origin yol (mutlak URL YOK).
  expect(renderCalls()[0].url.startsWith('/api/')).toBe(true)
})

test('RA-C2: başarılı auth bağlamında render ucu çağrılır', async () => {
  stubFetch()
  prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  expect(renderCalls()).toHaveLength(1)
  expect(renderCalls()[0].url).toBe(SURAT_RENDER_ENDPOINT)
})

test('RA-C3: gövde YALNIZ { orderId } içerir', async () => {
  stubFetch()
  await fetchSuratRenderArtifact('o-1')
  expect(renderCalls()[0].body).toEqual({ orderId: 'o-1' })
  expect(Object.keys(renderCalls()[0].body)).toEqual(['orderId'])
})

test('RA-C4: istemci organizationId/marketplaceAccountId GÖNDERMEZ', async () => {
  stubFetch()
  await fetchSuratRenderArtifact('o-1')
  const body = renderCalls()[0].body
  for (const forbidden of ['organizationId', 'marketplaceAccountId', 'orgId']) {
    expect(forbidden in body).toBe(false)
  }
})

test('RA-C5: istemci ham ZPL alanı GÖNDERMEZ', async () => {
  stubFetch()
  await fetchSuratRenderArtifact('o-1')
  const body = renderCalls()[0].body
  for (const forbidden of [
    'zpl', 'printZpl', 'technicalZpl', 'barcodeRaw', 'customerName',
    'trackingNumber', 'barcode',
  ]) {
    expect(forbidden in body).toBe(false)
  }
})

test('RA-C6: helper sözleşmesi çalışan uçlarla AYNIDIR', async () => {
  stubFetch()
  // Aynı helper başka bir uçta da AYNI auth bilgisini taşır.
  await authenticatedApiRequest('/api/orders')
  await fetchSuratRenderArtifact('o-1')
  const ordersCall = calls.find((call) => call.url === '/api/orders')
  const renderCall = renderCalls()[0]
  expect(ordersCall?.init?.credentials).toBe(renderCall.init?.credentials)
  // Authorization header hiçbirinde YOK.
  for (const call of calls) {
    const headers = (call.init?.headers ?? {}) as Record<string, string>
    expect('Authorization' in headers).toBe(false)
  }
  // Mutlak URL reddedilir: oturum cookie'si başka origin'e sızmaz.
  expect(() => authenticatedApiRequest('https://baska-origin.example/api/x')).toThrow()
})

// ── RA-C7..RA-C9: AUTHENTICATED BAŞARI ─────────────────────────────────────

test('RA-C7: authenticated READY Sürat siparişi render EDİLİR', async () => {
  stubFetch()
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  expect(outcome.printResult?.browserPrintDebug?.printMode).toBe(
    'surat-official-png',
  )
  expect(outcome.printResult?.ok).toBe(true)
})

test('RA-C8: başarılı render sonrası window.print ÇAĞRILIR', async () => {
  stubFetch()
  const frame = prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  expect(printCallCount).toBe(1)
  expect(
    frame.contentDocument?.querySelectorAll('.surat-official-page').length,
  ).toBe(1)
})

test('RA-C9: başarılı render sonrası jobs[0].ok true', async () => {
  stubFetch()
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  expect(outcome.printResult?.jobs?.[0].ok).toBe(true)
})

// ── RA-C10..RA-C13: AUTH HATASI ────────────────────────────────────────────

test('RA-C10: auth hatasında jobs[0].ok false ve GÜVENLİ mesaj gösterilir', async () => {
  stubFetch(() => ({ status: 401, payload: AUTH_DENIED }))
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  expect(outcome.printResult?.jobs?.[0].ok).toBe(false)
  expect(outcome.printResult?.jobs?.[0].errorMessage).toBe(AUTH_REQUIRED_MESSAGE)
  expect(AUTH_REQUIRED_MESSAGE).toBe(
    'Oturum doğrulanamadı. Sayfayı yenileyip tekrar giriş yapın.',
  )
})

test('RA-C11: auth hatasında shipment READY KALIR', async () => {
  stubFetch(() => ({ status: 401, payload: AUTH_DENIED }))
  prepareHost()
  const outcome = await printWith([readyOrder()], 'surat_official_zpl')
  const after = outcome.orders.find((order) => order.id === 'o-1')
  expect(after?.labelStatus).toBe('READY')
  expect(after?.operationStatus).toBe('LABEL_READY')
  expect(after?.label?.printedAt).toBe(undefined)
})

test('RA-C12: auth hatasında printCount ARTMAZ', async () => {
  stubFetch(() => ({ status: 401, payload: AUTH_DENIED }))
  prepareHost()
  const outcome = await printWith(
    [readyOrder({ label: { zplContent: '^XA^XZ', printCount: 2 } })],
    'surat_official_zpl',
  )
  expect(
    outcome.orders.find((order) => order.id === 'o-1')?.label?.printCount,
  ).toBe(2)
})

test('RA-C13: auth hatasında window.print ÇAĞRILMAZ', async () => {
  stubFetch(() => ({ status: 401, payload: AUTH_DENIED }))
  const frame = prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  expect(printCallCount).toBe(0)
  expect(frame.contentDocument?.querySelector('.surat-official-page')).toBe(null)
})

test('RA-C13b: sunucunun teknik mesajı YALNIZ güvenli debug alanında kalır', async () => {
  stubFetch(() => ({ status: 401, payload: AUTH_DENIED }))
  await expect(fetchSuratRenderArtifact('o-1')).rejects.toThrowError(
    AUTH_REQUIRED_MESSAGE,
  )
  try {
    await fetchSuratRenderArtifact('o-1', { force: true })
  } catch (error) {
    const failure = error as SuratRenderRequestError
    expect(failure.code).toBe('auth_required')
    expect(failure.status).toBe(401)
    expect(failure.debugMessage).toBe('Oturum gerekli.')
    // Kullanıcıya giden metin teknik mesaj DEĞİL.
    expect(failure.message).toBe(AUTH_REQUIRED_MESSAGE)
  }
  expect(isAuthFailureStatus(401)).toBe(true)
  expect(isAuthFailureStatus(403)).toBe(true)
  expect(isAuthFailureStatus(409)).toBe(false)
})

// ── RA-C14..RA-C15: CACHE ──────────────────────────────────────────────────

test('RA-C14: auth hatası ÖNBELLEĞE YAZILMAZ', async () => {
  stubFetch(() => ({ status: 401, payload: AUTH_DENIED }))
  prepareHost()
  await printWith([readyOrder()], 'surat_official_zpl')
  expect(peekSuratRenderArtifact('o-1')).toBe(undefined)
})

test('RA-C15: yeniden giriş sonrası tekrar deneme ucu YENİDEN çağırır', async () => {
  let authenticated = false
  stubFetch(() =>
    authenticated
      ? { status: 200, payload: ARTIFACT }
      : { status: 401, payload: AUTH_DENIED },
  )
  prepareHost()
  const first = await printWith([readyOrder()], 'surat_official_zpl')
  expect(first.printResult?.jobs?.[0].ok).toBe(false)
  expect(renderCalls()).toHaveLength(1)

  // Kullanıcı yeniden giriş yaptı: aynı sipariş yeniden render edilebilmeli.
  authenticated = true
  prepareHost()
  const second = await printWith([readyOrder()], 'surat_official_zpl')
  expect(renderCalls()).toHaveLength(2)
  expect(second.printResult?.jobs?.[0].ok).toBe(true)
  expect(peekSuratRenderArtifact('o-1')?.renderSha256).toBe(ARTIFACT.renderSha256)
})

test('RA-C15b: başka order/oturum artefaktı PAYLAŞILMAZ', async () => {
  stubFetch((body) => ({
    status: 200,
    payload: {
      ...ARTIFACT,
      renderSha256: `${String(body.orderId)}`.padEnd(64, 'c'),
    },
  }))
  await fetchSuratRenderArtifact('o-1')
  await fetchSuratRenderArtifact('o-2')
  expect(peekSuratRenderArtifact('o-1')?.renderSha256).toBe(
    'o-1'.padEnd(64, 'c'),
  )
  expect(peekSuratRenderArtifact('o-2')?.renderSha256).toBe(
    'o-2'.padEnd(64, 'c'),
  )
  // Oturum temizliği önbelleği tamamen düşürür.
  clearSuratRenderCache()
  expect(peekSuratRenderArtifact('o-1')).toBe(undefined)
})

// ── RA-C16: CARGOFLOW HTML REGRESYONU ──────────────────────────────────────

test('RA-C16: CargoFlow HTML yolu DEĞİŞMEZ (render ucu çağrılmaz)', async () => {
  stubFetch()
  prepareHost()
  const outcome = await printWith([readyOrder()], 'cargoflow_html')
  expect(renderCalls()).toHaveLength(0)
  expect(outcome.printResult?.provider).toBe('browser-label-document')
  expect(outcome.printResult?.browserPrintDebug?.printMode).not.toBe(
    'surat-official-png',
  )
})

// ── RA-C17: CANLI SENARYO (create + authenticated session) ──────────────────

test('RA-C17: canlı senaryo — create başarılı, authenticated session, tam baskı', async () => {
  stubFetch()
  const frame = prepareHost()
  const pending = readyOrder({
    id: 'o-new',
    hasPrintableLabel: false,
    label: undefined,
    labelStatus: undefined,
    operationStatus: 'CREATE_REQUIRED',
    shipment: undefined,
  })
  const created = readyOrder({ id: 'o-new' })
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
    createShipments: async () => ({
      orders: [created],
      failedIds: [],
      reasons: {},
    }),
    printLabels: buildPrintAdapter({
      callPrint: async (list, ids) =>
        service.printLabels(list, ids, BROWSER_PRINTER, defaultLabelTemplate, {}, {
          confirmedAt: new Date().toISOString(),
          printedBy: 'test',
          labelPrintTemplate: 'surat_official_zpl',
        }),
    }),
  })

  expect(outcome.created).toBe(1)
  expect(outcome.printed).toBe(1)
  expect(outcome.skipped).toEqual([])
  expect(outcome.failed).toEqual([])
  expect(renderCalls()).toHaveLength(1)
  expect(printCallCount).toBe(1)
  expect(
    frame.contentDocument?.querySelectorAll('.surat-official-page').length,
  ).toBe(1)
}, 20000)
