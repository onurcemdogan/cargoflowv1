import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { buildDashboardViewModel } from '../dashboard/dashboardViewModel'
import { buildPickingWorkspace } from '../dashboard/pickingWorkspace'
import { PickingProductsPage } from '../pages/PickingProductsPage'
import type { CargoOrder } from '../types/cargoflow'
import pageSource from '../pages/PickingProductsPage.tsx?raw'
import appSource from '../App.tsx?raw'

afterEach(() => vi.unstubAllGlobals())

function order(id: string, overrides: Partial<CargoOrder> = {}): CargoOrder {
  return {
    id,
    packageId: `PKG-${id}`,
    orderNumber: `ORD-${id}`,
    marketplace: 'Trendyol',
    customerName: 'Sentetik',
    orderDate: '2026-10-14T09:00:00.000Z',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    labelStatus: 'NONE',
    items: [
      {
        id: `line-${id}`,
        productContentId: 'family-a',
        productName: 'Pamuklu gömlek',
        color: 'Mavi',
        size: 'M',
        sku: `SKU-${id}`,
        barcode: `BC-${id}`,
        quantity: 2,
      },
    ],
    ...overrides,
  } as CargoOrder
}

test('workspace uses canonical eligibility, distinct packages and all dates; printed orders disappear on reload', () => {
  const pending = order('a')
  const printed = order('printed', {
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
  })
  const cancelled = order('cancelled', { marketplaceStatus: 'Cancelled' })
  const orders = [pending, pending, printed, cancelled]
  const canonical = buildDashboardViewModel({
    orders,
    selectedPeriod: { key: 'today' },
  }).pickingLists
  const result = buildPickingWorkspace(orders, [])
  expect(result.products).toEqual(canonical.products)
  expect(result.orderCount).toBe(1)
  expect(result.totalQuantity).toBe(2)
  const { rerender } = render(
    <PickingProductsPage
      orders={orders}
      useServerState={false}
      dataSourceResolved
      onOpenOrder={vi.fn()}
    />,
  )
  expect(screen.getAllByTestId('picking-product')).toHaveLength(1)
  rerender(
    <PickingProductsPage
      orders={[
        {
          ...pending,
          operationStatus: 'LABEL_PRINTED',
          labelStatus: 'PRINTED',
        },
      ]}
      useServerState={false}
      dataSourceResolved
      onOpenOrder={vi.fn()}
    />,
  )
  expect(screen.getByText('Toplanacak ürün kalmadı')).toBeTruthy()
})

test('full-list search and paging reach families beyond Dashboard cap; secondary variant SKU/barcode remains searchable', () => {
  const orders = Array.from({ length: 65 }, (_, i) =>
    order(`o${i}`, {
      items: [
        {
          ...order(`o${i}`).items[0],
          productContentId: `family-${i}`,
          productName: `Ürün ${i}`,
          quantity: 100 - i,
        },
      ],
    }),
  )
  const first = buildPickingWorkspace(orders, [])
  expect(first.products).toHaveLength(30)
  expect(first.totalFamilyCount).toBe(65)
  expect(first.totalQuantity).toBe(
    orders.reduce((sum, entry) => sum + entry.items[0].quantity, 0),
  )
  const last = buildPickingWorkspace(orders, [], { page: 2 })
  expect(last.products).toHaveLength(5)
  expect(
    buildPickingWorkspace(orders, [], { search: 'SKU-o64' }).products[0]
      .productName,
  ).toBe('Ürün 64')
  const variants = [
    order('a'),
    order('b', { items: [{ ...order('b').items[0], size: 'XL' }] }),
  ]
  expect(
    buildPickingWorkspace(variants, [], { search: 'BC-b' }).products[0]
      .quantity,
  ).toBe(4)
  expect(
    buildPickingWorkspace(variants, [], { stage: 'delivered' }).products,
  ).toHaveLength(0)
})

test('view, expand, search, filter and paginate are local presentation; opening an order is explicit', () => {
  const fetchSpy = vi.fn(() => {
    throw new Error('Unexpected network operation')
  })
  vi.stubGlobal('fetch', fetchSpy)
  const orders = [order('a'), order('b')]
  const before = JSON.stringify(orders)
  const onOpenOrder = vi.fn()
  render(
    <PickingProductsPage
      orders={orders}
      useServerState={false}
      dataSourceResolved
      onOpenOrder={onOpenOrder}
    />,
  )
  const product = screen.getByTestId('picking-product')
  expect(
    within(product).getByRole('heading', { name: 'Pamuklu gömlek' }),
  ).toBeTruthy()
  fireEvent.click(within(product).getByRole('button', { name: 'Siparişler' }))
  expect(product.textContent).toContain('SKU-b')
  expect(product.textContent).toContain('BC-b')
  expect(onOpenOrder).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /ORD-b/ }))
  expect(onOpenOrder).toHaveBeenCalledExactlyOnceWith('b')
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Toplanacak ürünlerde ara' }),
    { target: { value: 'missing' } },
  )
  expect(screen.getByText('Eşleşen ürün yok')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'barcodeWaiting' },
  })
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(JSON.stringify(orders)).toBe(before)
  expect(pageSource).not.toMatch(
    /persistOrders|createShipment|createLabel|markPrinted|localStorage|syncOrders/,
  )
})

test('server navigation and filtering call only persisted GET; failed requests never expose partial client pool', async () => {
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET')
    expect(url).toMatch(/^\/api\/picking\/products\?/)
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: buildPickingWorkspace([order('server')], []),
      }),
    }
  })
  vi.stubGlobal('fetch', fetchSpy)
  const { rerender } = render(
    <PickingProductsPage
      orders={[order('partial')]}
      useServerState
      dataSourceResolved={false}
      onOpenOrder={vi.fn()}
    />,
  )
  expect(fetchSpy).not.toHaveBeenCalled()
  rerender(
    <PickingProductsPage
      orders={[order('partial')]}
      useServerState
      dataSourceResolved
      onOpenOrder={vi.fn()}
    />,
  )
  await screen.findByTestId('picking-product')
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'server' } })
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
  fetchSpy.mockRejectedValue(new Error('offline'))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'fail' } })
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByTestId('picking-product')).toBeNull()
})

test('App wires first-class picking navigation without write handlers', () => {
  expect(appSource).toMatch(
    /effectivePage === 'picking'[\s\S]*?<PickingProductsPage/,
  )
  expect(appSource).toMatch(
    /onOpenOrder=\{\(orderId\) => void requestOrderAction\('open', orderId\)\}/,
  )
  expect(pageSource).not.toMatch(/style=\{/)
  expect(appSource).toMatch(
    /orderActionError && \(activePage === 'cargo' \|\| activePage === 'shipments' \|\| activePage === 'picking'\)/,
  )
})
