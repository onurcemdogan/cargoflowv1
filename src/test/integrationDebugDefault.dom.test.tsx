import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { IntegrationDebugPage } from '../pages/IntegrationDebugPage'

// VARSAYILAN CANLI DEBUG EKRANI.
//
// Eskiden ~242 geçmiş gönderi satırı (DELIVERED / TEKNİK ZPL / BARKOD BEKLİYOR)
// açılışta basılıyor ve güncel create hata ayıklamasını boğuyordu.

const order = (index: number) => ({
  id: `o${index}`,
  orderNumber: `1151664118${index}`,
  packageId: `40857912${index}`,
  status: 'Created',
  customerName: 'Ad Soyad',
  shipment: {
    trackingNumber: `72700360190769${index}`,
    barcodeValue: `BC${index}`,
    createdAt: '2026-08-18T00:00:00.000Z',
  },
})

const orders = Array.from({ length: 42 }, (_, index) => order(index)) as never[]

const renderPage = () => render(
  <IntegrationDebugPage
    orders={orders}
    logs={[] as never[]}
    onClear={() => {}}
  />,
)

test('DEBUG-1: acilista eski tani satiri RENDER EDILMEZ', () => {
  renderPage()
  // Legacy satirlar DOM'a HIC girmez — gizlenmez, uretilmez.
  expect(screen.queryAllByText('BARKOD BEKLİYOR')).toHaveLength(0)
  expect(screen.queryAllByText('TEKNİK ZPL')).toHaveLength(0)
})

test('DEBUG-2: varsayilan bolum Canli Debug (Trace V2)', () => {
  renderPage()
  // Baslik + ipucu metninde birden fazla gecebilir; VARLIGI yeterli.
  expect(screen.getAllByText('Canlı Debug').length).toBeGreaterThan(0)
  // Eski bolum ARTIK birincil baslik degil.
  expect(screen.queryByText('Sürat Ortak Barkod Tanı')).toBeNull()
  expect(screen.getByText('Eski Teknik Tanı')).toBeTruthy()
})

test('DEBUG-3: eski tani ancak ACIKCA istenince gelir', async () => {
  renderPage()
  const toggle = screen.getByRole('button', { name: /Eski teknik tanıyı göster/ })
  expect(toggle.textContent).toContain('42')
  await userEvent.click(toggle)
  expect(screen.queryAllByText('BARKOD BEKLİYOR').length).toBeGreaterThan(0)
})

test('DEBUG-4: genis silme dugmesi BIRINCIL ekranda YOK', () => {
  renderPage()
  // Karma operasyonel/debug veriyi etkileyebilecek toplu silme sunulmaz.
  expect(screen.queryByText('Debug Kayıtlarını Temizle')).toBeNull()
})
