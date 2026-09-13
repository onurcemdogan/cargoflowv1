import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { OrdersPage } from '../pages/OrdersPage'
import type { CargoOrder } from '../types/cargoflow'

// ═══ FILTER-AUDIT-C — "FİLTRELERİ TEMİZLE" GERÇEKTEN TEMİZLER ════════════
//
// ÖLÇÜLEN KUSUR: `clearFilters` on altı filtreyi sıfırlıyor ama "Aynı Ürün
// Siparişi"ni ATLIYORDU. Temizlemeden sonra liste sessizce daraltılmış
// kalıyor ve kullanıcı nedenini göremiyordu.
//
// Bu test kaynak taraması DEĞİL, GERÇEK ETKİLEŞİMDİR: select değiştirilir,
// butona basılır, DOM'daki değer okunur.

afterEach(cleanup)

function order(id: string): CargoOrder {
  return {
    id,
    orderNumber: `ORD-${id}`,
    packageId: `PKG-${id}`,
    marketplace: 'Trendyol',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerName: 'Ada Lovelace',
    city: 'İstanbul',
    district: 'Kadıköy',
    orderDate: '2026-09-01T08:00:00.000Z',
    createdAt: '2026-09-01T08:00:00.000Z',
    items: [
      { id: `i-${id}`, productName: 'Ürün', barcode: 'BRC', quantity: 1 },
    ],
  } as unknown as CargoOrder
}

function renderOrders() {
  const noop = vi.fn()
  return render(
    <OrdersPage
      orders={[order('a'), order('b')]}
      products={[]}
      selectedIds={[]}
      busy={false}
      onToggleOrder={noop}
      onToggleAll={noop}
      onFetchOrders={noop}
      onCreateShipments={noop}
      onCreateShipmentForOrder={noop}
      onTrackShipments={noop}
      onTrackShipmentForOrder={noop}
      onDownloadZpl={noop}
      onDownloadZplForOrder={noop}
      onDesiChange={noop}
      onMarkPrinted={noop}
      onMarkPrintedForOrder={noop}
      onMarkHandedToCargo={noop}
    />,
  )
}

// Bazı başlıklar ekranda birden çok yerde geçer ("Kargo" hem filtre hem tablo
// sütunu). Bu yüzden AYNI metni taşıyan düğümler arasından, içinde gerçekten
// bir `<select>` bulunan filtre etiketi seçilir.
function selectByLabel(label: string): HTMLSelectElement {
  const owner = screen
    .getAllByText(label, { exact: true })
    .map((node) => node.closest('label'))
    .find((node): node is HTMLLabelElement =>
      Boolean(node?.querySelector('select')),
    )
  if (!owner) throw new Error(`${label} filtresi bulunamadı`)
  return within(owner).getByRole('combobox') as HTMLSelectElement
}

test('FILTER-AUDIT-C: "Filtreleri Temizle" Ayni Urun Siparisi filtresini de SIFIRLAR', async () => {
  const user = userEvent.setup()
  renderOrders()

  const sameProduct = selectByLabel('Aynı Ürün Siparişi')
  const multiProduct = selectByLabel('Çok Çeşitli Sipariş')
  const status = selectByLabel('Statü')

  expect(sameProduct.value).toBe('all')

  await user.selectOptions(sameProduct, 'repeated')
  await user.selectOptions(multiProduct, 'multi')
  await user.selectOptions(status, 'Picking')
  expect(sameProduct.value).toBe('repeated')

  await user.click(screen.getByRole('button', { name: /Filtreleri Temizle/i }))

  // KUSURUN TA KENDİSİ: bu satır eskiden 'repeated' kalıyordu.
  expect(selectByLabel('Aynı Ürün Siparişi').value).toBe('all')
  // Komşu filtrelerin sıfırlanması BOZULMADI.
  expect(selectByLabel('Çok Çeşitli Sipariş').value).toBe('all')
  expect(selectByLabel('Statü').value).toBe('all')
})

test('FILTER-AUDIT-C2: temizleme diger filtreleri de SIFIRLAR (regresyon)', async () => {
  const user = userEvent.setup()
  renderOrders()

  await user.selectOptions(selectByLabel('İşlem Durumu'), 'labelPrinted')
  await user.selectOptions(selectByLabel('Pazaryeri'), 'Trendyol')
  await user.selectOptions(selectByLabel('Kargo'), 'Bekliyor')
  await user.selectOptions(selectByLabel('Tarih'), 'last7')

  await user.click(screen.getByRole('button', { name: /Filtreleri Temizle/i }))

  expect(selectByLabel('İşlem Durumu').value).toBe('all')
  expect(selectByLabel('Pazaryeri').value).toBe('all')
  expect(selectByLabel('Kargo').value).toBe('all')
  expect(selectByLabel('Tarih').value).toBe('all')
})
