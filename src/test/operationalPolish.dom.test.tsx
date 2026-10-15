import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { PickingProductsPage } from '../pages/PickingProductsPage'
import { CargoOperationsPage } from '../pages/CargoOperationsPage'
import type { CargoOrder } from '../types/cargoflow'
import type { ShippingPipeline } from '../services/shippingOverviewClient'

afterEach(() => { vi.unstubAllGlobals(); delete document.documentElement.dataset.theme })

function order(id: string, size: string): CargoOrder {
  return {
    id, orderNumber: `SYNTHETIC-${id}`, packageId: `SYNTHETIC-PKG-${id}`, marketplace: 'Trendyol', marketplaceStatus: 'Created',
    status: 'Yeni', operationStatus: 'NEW', customerName: 'Sentetik alıcı', orderDate: '2026-10-15T09:00:00Z',
    items: [{ id: `line-${id}`, productContentId: 'synthetic-family', productName: 'Pamuklu gömlek', color: 'Mavi', size, sku: `SKU-${size}`, barcode: `BC-${size}`, quantity: 2, imageUrl: 'https://example.invalid/synthetic-shirt.svg' }],
  } as CargoOrder
}

test.each(['light', 'dark'])('picking image/detail opens persisted variants and orders, closes with button/Escape and restores focus (%s)', async (theme) => {
  document.documentElement.dataset.theme = theme
  const fetchSpy = vi.fn(() => { throw Error('No request is allowed for detail inspection') })
  vi.stubGlobal('fetch', fetchSpy)
  const onOpenOrder = vi.fn()
  render(<PickingProductsPage orders={[order('m', 'M'), order('l', 'L')]} useServerState={false} dataSourceResolved onOpenOrder={onOpenOrder} />)
  const imageButton = screen.getByRole('button', { name: 'Pamuklu gömlek görselini büyüt' })
  await userEvent.click(imageButton)
  let dialog = screen.getByRole('dialog', { name: 'Ürün detayları' })
  for (const value of ['Pamuklu gömlek', 'Mavi', 'Kalan adet', 'İlgili sipariş', 'SKU-M', 'SKU-L', 'BC-M', 'BC-L', 'SYNTHETIC-m', 'SYNTHETIC-l']) {
    expect(dialog.textContent).toContain(value)
  }
  expect(within(dialog).getByLabelText('Aşama dağılımı')).toBeTruthy()
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe('https://example.invalid/synthetic-shirt.svg')
  fireEvent.error(within(dialog).getByRole('img'))
  expect(within(dialog).getByText('Görsel yok')).toBeTruthy()
  expect(screen.getByRole('dialog')).toBe(dialog)
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(imageButton)
  fireEvent.click(screen.getByRole('button', { name: 'Ürün detayları' }))
  dialog = screen.getByRole('dialog')
  const close = within(dialog).getByRole('button', { name: 'Ürün detaylarını kapat' })
  expect(document.activeElement).toBe(close)
  fireEvent.click(close)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(onOpenOrder).not.toHaveBeenCalled()
  await userEvent.click(imageButton)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /SYNTHETIC-l/ }))
  expect(onOpenOrder).toHaveBeenCalledWith('l')
  expect(screen.queryByRole('dialog')).toBeNull()
})

test.each([true, false])('background label information defaults collapsed and reflects persisted worker state enabled=%s', async (enabled) => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  const data: ShippingPipeline = {
    summary: { queued: 0, preparing: 0, labelReady: 0, needsAttention: 0, createdToday: 0, handedToday: 0 },
    worker: { backgroundEnabled: enabled, workspaceEnabled: enabled, counts: { QUEUED: 0, PREPARING: 0, READY: 0, BLOCKED: 0, UNKNOWN_AFTER_NETWORK: 0, FAILED_SAFE_TO_RETRY: 0 }, lastPreparedAt: null, averagePrepSeconds: null, sampleSize: 0 },
    attention: [], recent: [],
  }
  render(<CargoOperationsPage onOpenOrder={vi.fn()} onPrintLabel={vi.fn()} onOpenShipments={vi.fn()} onNavigateOrders={vi.fn()} load={async () => data} />)
  const summary = screen.getByText(/Gelişmiş · Arka planda etiket hazırlama/)
  await within(summary).findByText(enabled ? 'Açık' : 'Kapalı')
  const details = summary.closest('details') as HTMLDetailsElement
  expect(details.open).toBe(false)
  expect(screen.queryByText('Otomatik etiket hazırlama')).toBeNull()
  await userEvent.click(summary)
  expect(details.open).toBe(true)
  expect(details.textContent).toContain(enabled ? 'Etiket otomatik yazdırılmaz.' : 'Kapalı. Etiketler mevcut kullanıcı işlemi sırasında hazırlanır.')
  expect(within(details).queryByRole('button')).toBeNull()
  expect(within(details).queryByRole('switch')).toBeNull()
  expect(fetchSpy).not.toHaveBeenCalled()
})
