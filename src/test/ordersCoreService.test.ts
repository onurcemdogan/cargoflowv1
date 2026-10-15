import { afterEach, expect, test, vi } from 'vitest'
import { OrderWorkflowService } from '../services/orderWorkflowService'
import { buildOrdersWorkspaceResult, ORDERS_WORKSPACE_DEFAULT_QUERY } from '../utils/ordersWorkspaceQuery'
import type { CargoOrder } from '../types/cargoflow'

function service() {
  const instance = new OrderWorkflowService({} as never, {} as never, {} as never, {} as never, { append: vi.fn() } as never)
  instance.setAuthMode(true)
  return instance
}
afterEach(() => vi.unstubAllGlobals())
const item = { id: 'synthetic-late', packageId: 'synthetic-pkg', orderNumber: 'SYNTHETIC', marketplace: 'Trendyol', items: [] } as unknown as CargoOrder

test('late previous-account response cannot populate canonical pool or current workspace', async () => {
  const instance = service()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async () => { await gate; return Response.json({ workspace: buildOrdersWorkspaceResult([item], { ...ORDERS_WORKSPACE_DEFAULT_QUERY, tab: 'all' }) }) }))
  const read = instance.fetchOrdersWorkspace(ORDERS_WORKSPACE_DEFAULT_QUERY)
  instance.setMarketplaceAccount('new-synthetic-seller')
  release()
  expect((await read).stale).toBe(true)
  expect(instance.getCanonicalOrderPool()).toEqual([])
})

test('canonical commit invalidates an older in-flight read before its pool side effects', async () => {
  const instance = service()
  const event = vi.fn()
  instance.subscribeCanonicalOrderChanges(event)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/workspace?')) { await gate; return Response.json({ workspace: buildOrdersWorkspaceResult([item], { ...ORDERS_WORKSPACE_DEFAULT_QUERY, tab: 'all' }) }) }
    return Response.json({ ok: true })
  }))
  const read = instance.fetchOrdersWorkspace(ORDERS_WORKSPACE_DEFAULT_QUERY)
  await instance.persistLabelReady(item.id)
  release()
  expect(event).toHaveBeenCalledTimes(1)
  expect((await read).stale).toBe(true)
  expect(instance.getCanonicalOrderPool()).toEqual([])
})

test('manual sync uses no count or collection GET even for an empty cache', async () => {
  const instance = service()
  const fetchMock = vi.fn(async () => Response.json({ ok: true, persistedCount: 0 }))
  vi.stubGlobal('fetch', fetchMock)
  await instance.fetchOrders({} as never)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith('/api/orders/sync', expect.objectContaining({ method: 'POST' }))
})

test('auth-mode manual cargo handoff cannot claim a memory-only operational transition', () => {
  const instance = service()
  const fetchMock = vi.fn()
  const changed = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  instance.subscribeCanonicalOrderChanges(changed)
  const result = instance.markSelectedHandedToCargo([item], [item.id])
  expect(result.orders).toEqual([item])
  expect(result.result.level).toBe('warning')
  expect(result.result.message).toContain('manuel durum değişikliği kullanılamıyor')
  expect(changed).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})


test.each(['ready', 'printed'] as const)('physical print with failed canonical label-%s persistence warns and retains prior operational state', async (failure) => {
  const print = vi.fn(async () => ({ ok: true, provider: 'synthetic', printJobId: 'synthetic-job' }))
  const instance = new OrderWorkflowService({} as never, {} as never, {} as never, { print } as never, { append: vi.fn() } as never)
  instance.setAuthMode(true)
  const before = { ...item, operationStatus: 'LABEL_READY', labelStatus: 'READY' } as CargoOrder
  const changed = vi.fn()
  instance.subscribeCanonicalOrderChanges(changed)
  const transport = vi.fn(async (url: string) => Response.json({ ok: !url.endsWith('/label-' + failure) }, { status: url.endsWith('/label-' + failure) ? 409 : 200 }))
  vi.stubGlobal('fetch', transport)
  const response = await instance.printLabels([before], [before.id], { mode: 'browser-print' } as never, { id: 'synthetic-template' } as never, {}, { confirmedAt: '2026-10-15T09:00:00Z', labelPrintTemplate: 'surat_official_zpl' })
  expect(print).toHaveBeenCalledTimes(1)
  expect(response.printResult?.ok).toBe(true)
  expect(response.orders).toEqual([before])
  expect(response.result.level).toBe('warning')
  expect(response.result.message).toContain('baskı durumu kaydedilemedi')
  expect(changed).toHaveBeenCalledTimes(failure === 'ready' ? 0 : 1)
  expect(transport.mock.calls.map(([url]) => url)).toEqual(failure === 'ready' ? ['/api/orders/' + item.id + '/label-ready'] : ['/api/orders/' + item.id + '/label-ready', '/api/orders/' + item.id + '/label-printed'])
})

test('late archive persistence cannot apply the previous account state or notify the new account', async () => {
  const instance = service()
  const changed = vi.fn()
  instance.subscribeCanonicalOrderChanges(changed)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async () => { await gate; return Response.json({ ok: true, externalProcessing: { entries: { 'old-account': { processedAt: '2026-10-15T09:00:00Z' } } } }) }))
  const write = instance.setExternalProcessing([item], true)
  instance.setMarketplaceAccount('second-archive-account')
  release()
  expect((await write).orders).toEqual([])
  expect(changed).not.toHaveBeenCalled()
})
