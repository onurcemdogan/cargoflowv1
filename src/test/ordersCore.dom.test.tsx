import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { runSuratCreateAndPrint } from '../services/suratCreateAndPrintOrchestrator'
import { integrationConfigService, workflowService } from '../services/appServices'
import { defaultIntegrationConfig } from '../services/integrationConfigService'
import { buildOrdersWorkspaceResult, ORDERS_WORKSPACE_DEFAULT_QUERY } from '../utils/ordersWorkspaceQuery'
import type { OperationTabFilter, QuickTab } from '../utils/ordersTabs'
import type { IntegrationConfig } from '../types/cargoflow'
import type { CargoOrder } from '../types/cargoflow'
import { applyExternalProcessingState, type ExternalProcessingState } from '../utils/externalProcessing'

vi.mock('../pages/HomePage', () => ({ HomePage: () => <h1>Synthetic Home</h1> }))
vi.mock('../pages/IntegrationsPage', () => ({ IntegrationsPage: ({ config, onSave }: { config: IntegrationConfig; onSave: (config: IntegrationConfig) => void }) => <button onClick={() => onSave({ ...config, trendyol: { ...config.trendyol, sellerId: 'core-second-seller' } })}>Switch synthetic account</button> }))
vi.mock('../utils/localStorageMigration', () => ({ migrateAlternateLoopbackStorage: vi.fn(async () => {}) }))
vi.mock('../services/printCapabilityService', () => ({ fetchPrintCapabilities: vi.fn(async () => ({})), findRawCapability: vi.fn(() => null) }))
vi.mock('../services/labelDocumentService', () => ({ fetchLabelDocuments: vi.fn(async () => ({ activeLayer: { document: null } })) }))
vi.mock('../services/suratCreateAndPrintOrchestrator', () => ({ runSuratCreateAndPrint: vi.fn(() => { throw Error('No carrier create allowed') }) }))

const fresh = { id: 'core-synthetic', orderNumber: 'CORE-CURRENT', packageId: 'CORE-PACKAGE', marketplace: 'Trendyol',
  marketplaceStatus: 'Created', operationStatus: 'NEW', status: 'Yeni', customerName: 'Synthetic customer',
  orderDate: '2026-10-15T09:00:00Z', items: [{ id: 'core-line', productName: 'Synthetic product', barcode: 'CORE-BC', quantity: 1 }],
} as CargoOrder
const obsolete = { ...fresh, id: 'core-obsolete', packageId: 'CORE-OLD-PKG', orderNumber: 'CORE-OBSOLETE' }
let dbOrders: CargoOrder[]
let readGate: Promise<void> | undefined
let syncGate: Promise<void> | undefined
let failPersistence: boolean
let failWorkspace: boolean
let external: ExternalProcessingState
const calls: Array<{ url: string; method: string }> = []

beforeEach(() => {
  vi.mocked(runSuratCreateAndPrint).mockClear()
  localStorage.clear()
  workflowService.resetCanonicalOrderPool()
  workflowService.setAuthMode(true)
  calls.length = 0
  dbOrders = [fresh]
  readGate = undefined
  syncGate = undefined
  failPersistence = false
  failWorkspace = false
  external = { entries: {} }
  vi.spyOn(integrationConfigService, 'isAuthMode').mockReturnValue(true)
  vi.spyOn(integrationConfigService, 'hydrateIntegrationConfig').mockResolvedValue(structuredClone(defaultIntegrationConfig))
  vi.spyOn(integrationConfigService, 'fetchLabelTemplate').mockResolvedValue(null)
  vi.spyOn(workflowService, 'hydrateProductCatalog').mockResolvedValue({ products: [] })
  vi.spyOn(workflowService, 'peekCachedOrders').mockReturnValue([obsolete])
  vi.spyOn(workflowService, 'fetchProducts').mockImplementation(async () => { throw Error('Product sync forbidden') })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (url.startsWith('/api/orders/workspace?')) {
      const snapshot = [...dbOrders]
      const params = new URL(url, 'http://synthetic.invalid').searchParams
      await readGate
      if (failWorkspace) return Response.json({}, { status: 503 })
      return Response.json({ workspace: buildOrdersWorkspaceResult(applyExternalProcessingState(snapshot, external), { ...ORDERS_WORKSPACE_DEFAULT_QUERY, tab: params.get('tab') as QuickTab, operationTab: params.get('operationTab') as OperationTabFilter }), externalProcessing: external, diagnostics: { cacheHit: false, dbMs: 1, projectionMs: 1 } })
    }
    if (url === '/api/orders/sync' && method === 'POST') { await syncGate; return Response.json({ ok: true, persistedCount: 1 }) }
    if (url === '/api/orders/external-processing' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { orderKeys: string[]; processed: boolean }
      external = { entries: body.processed ? Object.fromEntries(body.orderKeys.map((key) => [key, { processedAt: '2026-10-15T09:00:00Z' }])) : {} }
      return Response.json({ ok: true, changed: 1, externalProcessing: external })
    }
    if (/\/api\/orders\/core-synthetic\/label-(ready|printed)$/.test(url) && method === 'POST') {
      if (failPersistence) return Response.json({ ok: false }, { status: 409 })
      dbOrders = [{ ...fresh, operationStatus: url.endsWith('label-printed') ? 'LABEL_PRINTED' : 'LABEL_READY',
        labelStatus: url.endsWith('label-printed') ? 'PRINTED' : 'READY', userLabelActivatedAt: '2026-10-15T09:01:00Z' }]
      return Response.json({ ok: true })
    }
    throw Error(`Unexpected transport: ${method} ${url}`)
  }))
})
afterEach(() => { expect(runSuratCreateAndPrint).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function openOrders() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Synthetic Home' })
  fireEvent.click(screen.getByRole('button', { name: 'Siparişler' }))
}

test('first paint and re-entry never expose obsolete SWR/pool membership while DB read is pending', async () => {
  workflowService.rememberPersistedOrder(obsolete, workflowService.getMarketplaceAccountGeneration())
  let release!: () => void
  readGate = new Promise<void>((resolve) => { release = resolve })
  await openOrders()
  await screen.findByText('Güncel siparişler yükleniyor…')
  expect(screen.queryByText(obsolete.orderNumber)).toBeNull()
  expect(screen.queryByText(fresh.orderNumber)).toBeNull()
  expect(screen.getByRole('button', { name: /^Yeni Siparişler/ }).textContent).toContain('—')
  expect(screen.queryByLabelText('Sipariş sayfalama')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Gelişmiş İşlemler' })).toBeNull()
  await act(async () => { release() })
  await screen.findByText(fresh.orderNumber)
  fireEvent.click(screen.getByRole('button', { name: 'Ana Sayfa' }))
  dbOrders = []
  readGate = new Promise<void>((resolve) => { release = resolve })
  fireEvent.click(screen.getByRole('button', { name: 'Siparişler' }))
  expect(screen.queryByText(fresh.orderNumber)).toBeNull()
  await screen.findByText('Güncel siparişler yükleniyor…')
  await act(async () => { release() })
  await waitFor(() => expect(screen.queryByText('Güncel siparişler yükleniyor…')).toBeNull())
  expect(screen.queryByText(fresh.orderNumber)).toBeNull()
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
})

test('manual refresh with missing images is one sync followed by one workspace GET, independent of catalog', async () => {
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  calls.length = 0
  fireEvent.click(screen.getByRole('button', { name: 'Şimdi Yenile' }))
  await waitFor(() => expect(calls.filter((call) => call.url.startsWith('/api/orders/workspace?'))).toHaveLength(1))
  await screen.findByRole('button', { name: 'Şimdi Yenile' })
  expect(calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual(['POST /api/orders/sync', 'GET /api/orders/workspace'])
  expect(workflowService.fetchProducts).not.toHaveBeenCalled()
})

test.each(['ready', 'printed'] as const)('canonical label-%s success reclassifies current tab/counts without provider/create or manual refresh', async (state) => {
  if (state === 'printed') dbOrders = [{ ...fresh, operationStatus: 'LABEL_READY', userLabelActivatedAt: '2026-10-15T09:01:00Z' }]
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  const operationFilter = screen.getByText('İşlem Durumu', { exact: true }).closest('label')!.querySelector('select')!
  fireEvent.change(operationFilter, { target: { value: state === 'ready' ? 'barcodePending' : 'labelReady' } })
  await screen.findByText(fresh.orderNumber)
  calls.length = 0
  await act(async () => {
    if (state === 'ready') await workflowService.persistLabelReady(fresh.id)
    else await workflowService.persistLabelPrinted(fresh.id)
  })
  await waitFor(() => expect(screen.queryByText(fresh.orderNumber)).toBeNull())
  fireEvent.change(operationFilter, { target: { value: state === 'ready' ? 'labelReady' : 'all' } })
  if (state === 'printed') {
    const tab = screen.getByRole('button', { name: /^Etiket Basıldı/ })
    await waitFor(() => expect(tab.textContent).toContain('1'))
    fireEvent.click(tab)
  }
  await screen.findByText(fresh.orderNumber)
  expect(calls.every((call) => call.url.startsWith('/api/orders/workspace?') || call.url.endsWith(`/label-${state}`))).toBe(true)
})

test('failed canonical persistence does not move a row or emit workspace revalidation', async () => {
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  calls.length = 0
  failPersistence = true
  await act(async () => { await expect(workflowService.persistLabelReady(fresh.id)).rejects.toThrow() })
  expect(screen.getByText(fresh.orderNumber)).toBeTruthy()
  expect(calls).toEqual([{ url: `/api/orders/${fresh.id}/label-ready`, method: 'POST' }])
})

test('failed fresh-entry DB read never falls back to an old workspace or pool', async () => {
  failWorkspace = true
  await openOrders()
  await screen.findByText('Sipariş verileri yüklenemedi. Bağlantıyı kontrol edip tekrar deneyin.')
  expect(screen.queryByText(obsolete.orderNumber)).toBeNull()
  expect(screen.queryByText(fresh.orderNumber)).toBeNull()
})

test('archive and restore canonical writes revalidate membership without provider sync', async () => {
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  calls.length = 0
  await act(async () => { await workflowService.setExternalProcessing([fresh], true) })
  await waitFor(() => expect(screen.queryByText(fresh.orderNumber)).toBeNull())
  await act(async () => { await workflowService.setExternalProcessing([fresh], false) })
  await screen.findByText(fresh.orderNumber)
  expect(calls.every((call) => call.url.startsWith('/api/orders/workspace?') || call.url === '/api/orders/external-processing')).toBe(true)
})

test('concurrent persisted changes coalesce into bounded DB reads with newest canonical counts', async () => {
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  calls.length = 0
  await act(async () => {
    await Promise.all([...Array.from({ length: 12 }, () => workflowService.persistLabelReady(fresh.id)), workflowService.persistLabelPrinted(fresh.id)])
  })
  await waitFor(() => expect(screen.getByRole('button', { name: /^Etiket Basıldı/ }).textContent).toContain('1'))
  expect(calls.filter((call) => call.url.startsWith('/api/orders/workspace?')).length).toBeLessThanOrEqual(2)
  expect(calls.every((call) => call.url.startsWith('/api/orders/workspace?') || /\/label-(ready|printed)$/.test(call.url))).toBe(true)
})


test('optional image enrichment failure does not block manual refresh or authoritative rows', async () => {
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  vi.spyOn(workflowService, 'enrichOrderImages').mockImplementation(() => { throw Error('Synthetic image failure') })
  calls.length = 0
  fireEvent.click(screen.getByRole('button', { name: 'Şimdi Yenile' }))
  await waitFor(() => expect(calls).toHaveLength(2))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Şimdi Yenile' }).hasAttribute('disabled')).toBe(false))
  expect(screen.getByText(fresh.orderNumber)).toBeTruthy()
  expect(screen.queryByText('Sipariş verileri yüklenemedi. Bağlantıyı kontrol edip tekrar deneyin.')).toBeNull()
  expect(workflowService.fetchProducts).not.toHaveBeenCalled()
})

test('actual manual cargo action warns without a memory-only move or a transport call', async () => {
  dbOrders = [{ ...fresh, operationStatus: 'LABEL_READY', userLabelActivatedAt: '2026-10-15T09:01:00Z', shipment: {
    provider: 'surat-kargo', serviceMode: 'ORTAK_BARKOD_SOAP', operationName: 'OrtakBarkodOlustur',
    dispatchRegistrationConfirmed: true, lifecycleStatus: 'LABEL_READY', operationalBarcodeVerified: true, serdendipVerified: true,
    suratTrackingLog: { gonderilerLength: 1, KargoTakipNo: '25220000000001', BarkodNo: '01230000001', WebSiparisKodu: fresh.packageId },
    suratCreateLog: { serviceMode: 'ORTAK_BARKOD_SOAP', parsedResponse: { KargoTakipNo: '25220000000001', Barcode: '01230000001' } },
  } } as CargoOrder]
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  fireEvent.click(screen.getByRole('checkbox', { name: fresh.orderNumber + ' seç' }))
  fireEvent.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  const action = screen.getByRole('menuitem', { name: 'Kargoya Verildi Yap' })
  expect(action.hasAttribute('disabled')).toBe(false)
  calls.length = 0
  fireEvent.click(action)
  await screen.findByText(/manuel durum değişikliği kullanılamıyor/)
  expect(screen.getByText(fresh.orderNumber)).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Kargoya Verildi/ }).textContent).toContain('0')
  expect(calls).toEqual([])
})

test('account switch clears old membership and discards its delayed workspace before new account entry', async () => {
  vi.spyOn(integrationConfigService, 'saveIntegrationConfig').mockImplementation((config) => config)
  vi.spyOn(integrationConfigService, 'waitForPendingPersistence').mockResolvedValue(true)
  let release!: () => void
  readGate = new Promise<void>((resolve) => { release = resolve })
  await openOrders()
  await screen.findByText('Güncel siparişler yükleniyor…')
  const previousGeneration = workflowService.getMarketplaceAccountGeneration()
  fireEvent.click(screen.getByRole('button', { name: 'Entegrasyonlar' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Switch synthetic account' }))
  await waitFor(() => expect(workflowService.getMarketplaceAccountGeneration()).toBeGreaterThan(previousGeneration))
  dbOrders = [{ ...fresh, id: 'core-second', packageId: 'CORE-SECOND-PKG', orderNumber: 'CORE-SECOND' }]
  await act(async () => { release() })
  readGate = undefined
  fireEvent.click(screen.getByRole('button', { name: 'Siparişler' }))
  expect(screen.queryByText(fresh.orderNumber)).toBeNull()
  await screen.findByText('CORE-SECOND')
  expect(screen.queryByText(fresh.orderNumber)).toBeNull()
  expect(workflowService.getCanonicalOrderPool().some((order) => order.id === fresh.id)).toBe(false)
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
})


test('unchanged initial search debounce during a pending manual sync cannot add a workspace GET', async () => {
  await openOrders()
  await screen.findByText(fresh.orderNumber)
  let release!: () => void
  syncGate = new Promise<void>((resolve) => { release = resolve })
  calls.length = 0
  fireEvent.click(screen.getByRole('button', { name: 'Şimdi Yenile' }))
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', url: '/api/orders/sync' }]))
  // Let the initial 300ms search debounce settle while the provider sync is held.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
  expect(calls).toEqual([{ method: 'POST', url: '/api/orders/sync' }])
  await act(async () => { release() })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Şimdi Yenile' }).hasAttribute('disabled')).toBe(false))
  expect(calls.map((call) => call.method + ' ' + call.url.split('?')[0])).toEqual(['POST /api/orders/sync', 'GET /api/orders/workspace'])
})
