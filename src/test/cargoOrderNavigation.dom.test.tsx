import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../App'
import { integrationConfigService, workflowService } from '../services/appServices'
import { defaultIntegrationConfig } from '../services/integrationConfigService'
import { buildOrdersWorkspaceResult, ORDERS_WORKSPACE_DEFAULT_QUERY } from '../utils/ordersWorkspaceQuery'
import type { CargoOrder } from '../types/cargoflow'

vi.mock('../pages/HomePage', () => ({ HomePage: ({ loading }: { loading: boolean }) => <h1>{loading ? 'Sentetik başlangıç yükleniyor' : 'Ana Sayfa'}</h1> }))
vi.mock('../utils/localStorageMigration', () => ({ migrateAlternateLoopbackStorage: vi.fn(async () => {}) }))
vi.mock('../services/printCapabilityService', () => ({ fetchPrintCapabilities: vi.fn(async () => ({})), findRawCapability: vi.fn(() => null) }))
vi.mock('../services/labelDocumentService', () => ({ fetchLabelDocuments: vi.fn(async () => ({ activeLayer: { document: null } })) }))
vi.mock('../services/suratCreateAndPrintOrchestrator', () => ({ runSuratCreateAndPrint: vi.fn(() => { throw Error('Create is forbidden in navigation') }) }))

const target = {
  id: 'synthetic-attention-order', orderNumber: 'SYNTHETIC-ATTENTION', packageId: 'SYNTHETIC-PACKAGE',
  marketplace: 'Trendyol', marketplaceStatus: 'Created', operationStatus: 'ERROR', status: 'Yeni',
  customerName: 'Sentetik alıcı', city: 'İstanbul', district: 'Kadıköy', orderDate: '2026-10-15T09:00:00Z',
  items: [{ id: 'synthetic-line', productName: 'Sentetik ürün', quantity: 1, barcode: 'SYNTHETIC-BC' }],
} as CargoOrder
const other = { ...target, id: 'synthetic-other', orderNumber: 'SYNTHETIC-OTHER', packageId: 'SYNTHETIC-OTHER-PACKAGE' }
let includeTarget = false
let failDetail = false
let detailOrder = target
let detailGate: Promise<void> | undefined
const calls: Array<{ url: string; method: string }> = []
const pipeline = {
  summary: { queued: 0, preparing: 0, labelReady: 0, needsAttention: 1, createdToday: 0, handedToday: 0 },
  worker: { backgroundEnabled: false, workspaceEnabled: false, counts: { QUEUED: 0, PREPARING: 0, READY: 0, BLOCKED: 0, UNKNOWN_AFTER_NETWORK: 1, FAILED_SAFE_TO_RETRY: 0 }, lastPreparedAt: null, averagePrepSeconds: null, sampleSize: 0 },
  attention: [{ kind: 'UNKNOWN_AFTER_NETWORK', orderId: target.id, orderNumber: target.orderNumber, packageId: target.packageId, marketplace: 'Trendyol', reason: 'Sentetik belirsiz işlem; otomatik tekrar yok.', updatedAt: null }],
  recent: [],
}

beforeEach(() => {
  calls.length = 0
  includeTarget = false
  failDetail = false
  detailOrder = target
  detailGate = undefined
  localStorage.clear()
  workflowService.resetCanonicalOrderPool()
  vi.spyOn(integrationConfigService, 'isAuthMode').mockReturnValue(true)
  vi.spyOn(integrationConfigService, 'hydrateIntegrationConfig').mockResolvedValue(structuredClone(defaultIntegrationConfig))
  vi.spyOn(integrationConfigService, 'fetchLabelTemplate').mockResolvedValue(null)
  vi.spyOn(workflowService, 'hydrateProductCatalog').mockResolvedValue({ products: [] })
  vi.spyOn(workflowService, 'peekCachedOrders').mockReturnValue(null)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (method !== 'GET') throw Error(`Forbidden mutation: ${method}`)
    if (url === '/api/shipping/pipeline') return new Response(JSON.stringify(pipeline))
    if (url === `/api/orders/${target.id}`) { await detailGate; return new Response(JSON.stringify(failDetail ? {} : { order: detailOrder }), { status: failDetail ? 404 : 200 }) }
    if (url.startsWith('/api/orders/workspace?')) {
      return new Response(JSON.stringify({ workspace: buildOrdersWorkspaceResult(includeTarget ? [target, other] : [other], { ...ORDERS_WORKSPACE_DEFAULT_QUERY, tab: 'all' }) }))
    }
    throw Error(`Unexpected GET: ${url}`)
  }))
  vi.spyOn(window, 'print').mockImplementation(() => { throw Error('Print forbidden') })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function openFromAttention() {
  render(<App />)
  await screen.findByRole('heading', { name: 'Ana Sayfa' })
  if (includeTarget) {
    fireEvent.click(screen.getByRole('button', { name: 'Siparişler' }))
    await screen.findByText(target.orderNumber)
    await waitFor(() => expect(workflowService.getCanonicalOrderPool().some((order) => order.id === target.id)).toBe(true))
  }
  fireEvent.click(screen.getByRole('button', { name: 'Kargo Operasyonları' }))
  const attention = await screen.findByRole('region', { name: 'Kontrol gereken işlemler' })
  fireEvent.click(await within(attention).findByRole('button', { name: `${target.orderNumber} siparişini aç` }))
}

test.each([true, false])('cargo → Orders opens the exact visible drawer and keeps it after workspace refresh; pooled=%s', async (pooled) => {
  includeTarget = pooled
  await openFromAttention()
  const drawer = await screen.findByRole('complementary', { name: 'Sipariş detayı' })
  expect(within(drawer).getByRole('heading', { name: `#${target.orderNumber}` })).toBeTruthy()
  // The subsequent page read excludes the clicked record: detail must survive this read.
  includeTarget = false
  await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/orders/workspace?'))).toBe(true))
  await screen.findByText(other.orderNumber)
  await waitFor(() => expect(screen.getByRole('complementary', { name: 'Sipariş detayı' })).toBe(drawer))
  expect(screen.getByRole('button', { name: 'Siparişler' }).getAttribute('aria-current')).toBe('page')
  expect(calls.filter((call) => call.url === `/api/orders/${target.id}`)).toHaveLength(pooled ? 0 : 1)
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
  expect(window.print).not.toHaveBeenCalled()
})

test('failed detail GET shows an error on cargo and cannot create, print, track or reconcile', async () => {
  failDetail = true
  await openFromAttention()
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sipariş yüklenemedi; Siparişler ekranından açmayı deneyin.')
  expect(screen.getByTestId('cargo-operations-page')).toBeTruthy()
  expect(screen.queryByRole('complementary', { name: 'Sipariş detayı' })).toBeNull()
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
  expect(window.print).not.toHaveBeenCalled()
})

test('mismatched detail identity cannot open the wrong order', async () => {
  detailOrder = other
  await openFromAttention()
  await screen.findByRole('alert')
  expect(screen.queryByRole('complementary', { name: 'Sipariş detayı' })).toBeNull()
  expect(workflowService.getCanonicalOrderPool()).not.toContainEqual(other)
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
})
test('late detail read after account generation changes is discarded', async () => {
  let release!: () => void
  detailGate = new Promise<void>((resolve) => { release = resolve })
  await openFromAttention()
  workflowService.setMarketplaceAccount('synthetic-new-scope')
  release()
  expect((await screen.findByRole('alert')).textContent).toContain('Hesap değişti')
  expect(workflowService.getCanonicalOrderPool()).toEqual([])
  expect(screen.queryByRole('complementary', { name: 'Sipariş detayı' })).toBeNull()
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
})
