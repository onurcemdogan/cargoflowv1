import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { OrdersTable } from '../components/OrdersTable'
import type { CargoOrder } from '../types/cargoflow'

function order(id: string): CargoOrder {
  return {
    id, orderNumber: `SYN-${id}`, packageId: `PKG-${id}`, marketplace: 'Trendyol',
    marketplaceStatus: 'Created', operationStatus: 'NEW', customerName: `Test customer ${id}`,
    city: 'İstanbul', district: 'Kadıköy', orderDate: '2026-10-15T09:00:00Z',
    createdAt: '2026-10-15T09:00:00Z',
    items: [{ id: `line-${id}`, productName: `Test product ${id}`, barcode: `BAR-${id}`,
      color: 'Mavi', size: 'M', quantity: 1, imageUrl: `https://example.invalid/synthetic-${id}.jpg` }],
  } as CargoOrder
}

const visibleOrders = [order('1'), order('2')]

function renderTable({ initialSelected = [], orders = visibleOrders }: {
  initialSelected?: string[]; orders?: CargoOrder[]
} = {}) {
  const toggle = vi.fn<(id: string) => void>()
  const toggleAll = vi.fn()
  const open = vi.fn()
  const expand = vi.fn()
  const sort = vi.fn()
  function Harness() {
    const [selected, setSelected] = useState(initialSelected)
    const [expanded, setExpanded] = useState<string>()
    return <>
      <OrdersTable orders={orders} products={[]} selectedIds={selected}
        onToggleOrder={(id) => {
          toggle(id)
          setSelected((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])
        }}
        onToggleAll={() => {
          toggleAll()
          const ids = orders.map((entry) => entry.id)
          setSelected((current) => ids.every((id) => current.includes(id))
            ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])])
        }}
        onOpenOrder={open} expandedOrderId={expanded}
        onToggleExpand={(id) => { expand(id); setExpanded((current) => current === id ? undefined : id) }}
        sortKey="orderDate" sortDirection="desc" onSortChange={sort} />
      <output aria-label="Test selection">{selected.join(',')}</output>
    </>
  }
  return { ...render(<Harness />), toggle, toggleAll, open, expand, sort }
}

function rowCheckbox(id = '1') {
  return screen.getByRole('checkbox', { name: `SYN-${id} seç` }) as HTMLInputElement
}

function productButton(id = '1') {
  return screen.getByRole('button', { name: `SYN-${id} siparişini seç` })
}

function headerCheckbox() {
  return screen.getByRole('checkbox', { name: 'Bu sayfadaki siparişleri seç' }) as HTMLInputElement
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

test.each(['image', 'name', 'variant', 'barcode'] as const)('product %s toggles selection exactly once and synchronizes checkbox, count and row theme', async (target) => {
  const user = userEvent.setup()
  const { toggle, expand, open } = renderTable()
  const content = productButton()
  const element = target === 'image' ? within(content).getByRole('img')
    : within(content).getByText(target === 'name' ? 'Test product 1' : target === 'variant' ? 'Mavi / M' : 'Barkod: BAR-1')
  await user.click(element)
  expect(rowCheckbox().checked).toBe(true)
  expect(content.getAttribute('aria-pressed')).toBe('true')
  expect(content.closest('tr')?.classList.contains('selected-row')).toBe(true)
  expect(screen.getByText('1/2 seçildi')).toBeTruthy()
  expect(headerCheckbox().indeterminate).toBe(true)
  expect(toggle.mock.calls).toEqual([['1']])
  await user.click(element)
  expect(rowCheckbox().checked).toBe(false)
  expect(content.getAttribute('aria-pressed')).toBe('false')
  expect(content.closest('tr')?.classList.contains('selected-row')).toBe(false)
  expect(screen.getByText('Tümünü seç')).toBeTruthy()
  expect(toggle.mock.calls).toEqual([['1'], ['1']])
  expect(expand).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

test('row checkbox selection is reflected by the product target; product click clears the same selection', async () => {
  const user = userEvent.setup()
  renderTable()
  await user.click(rowCheckbox())
  expect(productButton().getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('1/2 seçildi')).toBeTruthy()
  await user.click(productButton())
  expect(rowCheckbox().checked).toBe(false)
  expect(screen.getByText('Tümünü seç')).toBeTruthy()
})

test.each([false, true])('Detay preserves existing selection (initial selected=%s)', async (selected) => {
  const user = userEvent.setup()
  const { open, toggle } = renderTable({ initialSelected: selected ? ['1'] : [] })
  const row = productButton().closest('tr')!
  await user.click(within(row).getByRole('button', { name: 'Detay' }))
  expect(open.mock.calls).toEqual([['1']])
  expect(toggle).not.toHaveBeenCalled()
  expect(rowCheckbox().checked).toBe(selected)
})

test('overflow opens and its detail/expand actions never select', async () => {
  const user = userEvent.setup()
  const { open, expand, toggle } = renderTable()
  const summary = screen.getByLabelText('SYN-1 diğer işlemler')
  await user.click(summary)
  const menu = summary.closest('details')!
  expect(menu.open).toBe(true)
  expect(rowCheckbox().checked).toBe(false)
  await user.click(within(menu).getByRole('button', { name: 'Sipariş detayını aç' }))
  await user.click(within(menu).getByRole('button', { name: 'Satırı genişlet' }))
  expect(open.mock.calls).toEqual([['1']])
  expect(expand.mock.calls).toEqual([['1']])
  expect(toggle).not.toHaveBeenCalled()
  expect(rowCheckbox().checked).toBe(false)
  expect(within(menu).queryByRole('button', { name: /Siparişi seç|Seçimi kaldır/ })).toBeNull()
})

test.each([false, true])('chevron only expands/collapses and preserves selection (initial selected=%s)', async (selected) => {
  const user = userEvent.setup()
  const { expand, toggle, open } = renderTable({ initialSelected: selected ? ['1'] : [] })
  await user.click(screen.getByRole('button', { name: 'SYN-1 satırını aç' }))
  expect(screen.getByRole('button', { name: 'SYN-1 satırını kapat' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Sipariş Ürünleri (1)')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'SYN-1 satırını kapat' }))
  expect(screen.queryByText('Sipariş Ürünleri (1)')).toBeNull()
  expect(expand.mock.calls).toEqual([['1'], ['1']])
  expect(toggle).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(rowCheckbox().checked).toBe(selected)
})

test('customer/cargo cells and product sorting do not select a row', async () => {
  const user = userEvent.setup()
  const { toggle, toggleAll, sort } = renderTable()
  await user.click(screen.getByText('Test customer 1'))
  const row = productButton().closest('tr')!
  await user.click(within(row).getByText('Bekliyor'))
  await user.click(screen.getByRole('button', { name: 'Ürün sütununu sırala' }))
  expect(sort.mock.calls).toEqual([['orderDate']])
  expect(toggle).not.toHaveBeenCalled()
  expect(toggleAll).not.toHaveBeenCalled()
  expect(rowCheckbox().checked).toBe(false)
})

test('header text selects/deselects all visible rows and shows zero, partial and all counts', async () => {
  const user = userEvent.setup()
  const { toggleAll } = renderTable()
  await user.click(screen.getByText('Tümünü seç'))
  expect(screen.getByText('2/2 seçildi')).toBeTruthy()
  expect(headerCheckbox().checked).toBe(true)
  expect(headerCheckbox().indeterminate).toBe(false)
  expect(visibleOrders.every((order) => rowCheckbox(order.id).checked)).toBe(true)
  await user.click(productButton())
  expect(screen.getByText('1/2 seçildi')).toBeTruthy()
  expect(headerCheckbox().indeterminate).toBe(true)
  await user.click(screen.getByText('1/2 seçildi'))
  expect(screen.getByText('2/2 seçildi')).toBeTruthy()
  await user.click(screen.getByText('2/2 seçildi'))
  expect(screen.getByText('Tümünü seç')).toBeTruthy()
  expect(visibleOrders.every((order) => !rowCheckbox(order.id).checked)).toBe(true)
  expect(toggleAll).toHaveBeenCalledTimes(3)
})

test('header checkbox padding and checkbox itself use the same select-all action', async () => {
  const user = userEvent.setup()
  const { toggleAll } = renderTable()
  await user.click(headerCheckbox().closest('label')!)
  expect(headerCheckbox().checked).toBe(true)
  expect(toggleAll).toHaveBeenCalledTimes(1)
  await user.click(headerCheckbox())
  expect(headerCheckbox().checked).toBe(false)
  expect(toggleAll).toHaveBeenCalledTimes(2)
})

test('visible count ignores off-page selections and header toggle preserves them', async () => {
  const user = userEvent.setup()
  renderTable({ initialSelected: ['off-page'] })
  expect(screen.getByText('Tümünü seç')).toBeTruthy()
  await user.click(screen.getByText('Tümünü seç'))
  expect(screen.getByText('2/2 seçildi')).toBeTruthy()
  expect(screen.getByLabelText('Test selection').textContent).toBe('off-page,1,2')
  await user.click(screen.getByText('2/2 seçildi'))
  expect(screen.getByLabelText('Test selection').textContent).toBe('off-page')
  expect(screen.getByText('Tümünü seç')).toBeTruthy()
})

test('product target and header checkbox support keyboard selection', async () => {
  const user = userEvent.setup()
  renderTable()
  productButton().focus()
  await user.keyboard(' ')
  expect(rowCheckbox().checked).toBe(true)
  await user.keyboard('{Enter}')
  expect(rowCheckbox().checked).toBe(false)
  headerCheckbox().focus()
  await user.keyboard(' ')
  expect(screen.getByText('2/2 seçildi')).toBeTruthy()
})

test('empty table disables select-all and cannot trigger a bulk selection', async () => {
  const user = userEvent.setup()
  const { toggleAll } = renderTable({ orders: [], initialSelected: ['off-page'] })
  expect(headerCheckbox().disabled).toBe(true)
  await user.click(screen.getByText('Tümünü seç'))
  expect(toggleAll).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Test selection').textContent).toBe('off-page')
})
