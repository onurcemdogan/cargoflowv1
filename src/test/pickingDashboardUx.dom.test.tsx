import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { PickingProductsCard } from '../components/PickingProductsCard'
import { buildDashboardViewModel } from '../dashboard/dashboardViewModel'
import type { CargoOrder } from '../types/cargoflow'

// TOPLANACAK ÜRÜNLER — SUNUM TESTLERİ.
//
// Bu paket YALNIZ yerleşim/sunumu kilitler. İş kuralları (uygunluk, ürün
// ailesi anahtarı, LABEL_PRINTED) view-model testlerinde (PICKING-1..10)
// doğrulanır ve BURADAN etkilenmez: kart, view-model'in ÜRETTİĞİ veriyi
// olduğu gibi gösterir.

afterEach(cleanup)

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    productName: 'Scuba Secil Detayli Tesettur Elbise',
    sku: 'SKU-1',
    merchantSku: 'SKU-1',
    barcode: 'BC-1',
    quantity: 1,
    color: 'Lacivert',
    size: '36',
    productContentId: 'C-100',
    imageUrl: 'https://example.invalid/a.jpg',
    ...overrides,
  }
}

function order(
  id: string,
  items: ReturnType<typeof line>[],
  overrides: Record<string, unknown> = {},
): CargoOrder {
  return {
    id,
    orderNumber: `ORD-${id}`,
    marketplace: 'Trendyol',
    packageId: `PKG-${id}`,
    customerName: 'SENTETIK ALICI',
    orderDate: '2026-08-01T10:00:00.000Z',
    status: 'Created',
    marketplaceStatus: 'Created',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    items,
    shipment: {
      provider: 'surat-kargo',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      dispatchRegistrationConfirmed: true,
      barcodeRaw: `^XA^FD${id}^FS^XZ`,
      barcode: `BARCODE-${id}`,
      zplReady: true,
      printEnabled: true,
    },
    ...overrides,
  } as unknown as CargoOrder
}

/** Kart, view-model'in GERÇEK çıktısıyla beslenir (elde uydurulmuş veri yok). */
function pickingOf(orders: CargoOrder[]) {
  return buildDashboardViewModel({
    orders,
    products: [],
    selectedPeriod: { key: 'today' },
    now: new Date('2026-08-10T09:00:00.000Z'),
  }).pickingLists
}

function renderCard(orders: CargoOrder[], onToggle = vi.fn()) {
  const picking = pickingOf(orders)
  const result = render(
    <PickingProductsCard picking={picking} onToggleExpand={onToggle} />,
  )
  return { picking, onToggle, ...result }
}

// NOT: CSS/yerleşim sözleşmesi (span 12, dar kolon yok) node tarafında
// PICKING-UX-LAYOUT testinde kilitlenir; burada DOM yapısı doğrulanır.
test('PICKING-UX-1: kart tek parça, geniş satır düzeniyle render olur', () => {
  const { container } = renderCard([order('a', [line()])])
  const card = container.querySelector('[data-testid="picking-card"]')
  expect(card).not.toBeNull()
  expect(card?.className).toContain('dashboard-picking-card')
  // Geniş yatay satır düzeni: kimlik · toplam · beden · aşama · aksiyon.
  const row = container.querySelector('[data-testid="picking-row"]')
  expect(row?.className).toBe('picking-row')
  expect(row?.querySelector('.picking-row-identity')).not.toBeNull()
  expect(row?.querySelector('.picking-row-totals')).not.toBeNull()
  expect(row?.querySelector('.picking-row-sizes')).not.toBeNull()
  expect(row?.querySelector('.picking-row-stages')).not.toBeNull()
  expect(row?.querySelector('.picking-row-action')).not.toBeNull()
})

test('PICKING-UX-2: ürün adı + görsel + adet + sipariş sayısı görünür', () => {
  renderCard([
    order('a', [line({ quantity: 4 })]),
    order('b', [line({ quantity: 6, size: '40' })]),
  ])
  expect(
    screen.getByText('Scuba Secil Detayli Tesettur Elbise'),
  ).toBeTruthy()
  expect(screen.getByAltText('Scuba Secil Detayli Tesettur Elbise')).toBeTruthy()
  expect(screen.getByText('10 adet')).toBeTruthy()
  expect(screen.getByText('2 sipariş')).toBeTruthy()
  // Üst özet: sipariş · adet · ürün ailesi
  expect(screen.getByTestId('picking-summary').textContent).toBe(
    '2 sipariş · 10 adet · 1 ürün ailesi',
  )
})

test('PICKING-UX-3: 36/40/42 AYNI kartta beden kırılımı olarak görünür', () => {
  const { container } = renderCard([
    order('a', [line({ size: '36', quantity: 2 })]),
    order('b', [line({ size: '40', quantity: 3 })]),
    order('c', [line({ size: '42', quantity: 5 })]),
  ])
  expect(container.querySelectorAll('[data-testid="picking-row"]')).toHaveLength(
    1,
  )
  const chips = Array.from(
    container.querySelectorAll('.picking-size-chip'),
  ).map((chip) => chip.textContent)
  expect(chips).toEqual(['425 adet', '403 adet', '362 adet'])
})

test('PICKING-UX-4: farklı renkler AYRI kartlar', () => {
  const { container } = renderCard([
    order('a', [line({ color: 'Lacivert', size: '36' })]),
    order('b', [line({ color: 'Bordo', size: '40' })]),
  ])
  expect(container.querySelectorAll('[data-testid="picking-row"]')).toHaveLength(
    2,
  )
  expect(screen.getByText('Lacivert')).toBeTruthy()
  expect(screen.getByText('Bordo')).toBeTruthy()
})

test('PICKING-UX-5: "Siparişleri Gör" mevcut handler’ı çağırır', async () => {
  const onToggle = vi.fn()
  const { picking } = renderCard([order('a', [line()])], onToggle)
  await userEvent.click(screen.getByRole('button', { name: 'Siparişleri Gör' }))
  expect(onToggle).toHaveBeenCalledTimes(1)
  expect(onToggle).toHaveBeenCalledWith(picking.products[0].key)
})

test('PICKING-UX-5b: açık kartta sipariş listesi görünür (yeni API çağrısı yok)', () => {
  const picking = pickingOf([order('a', [line()])])
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  render(
    <PickingProductsCard
      picking={picking}
      expandedKey={picking.products[0].key}
      onToggleExpand={vi.fn()}
    />,
  )
  expect(screen.getByText('ORD-a')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Gizle' })).toBeTruthy()
  expect(fetchSpy).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

test('PICKING-UX-6: sunum katmanı uygunluğu DEĞİŞTİRMEZ (LABEL_PRINTED gösterilmez)', () => {
  const orders = [
    order('a', [line({ size: '36', quantity: 1 })]),
    order('b', [line({ size: '40', quantity: 1 })], {
      operationStatus: 'LABEL_PRINTED',
      labelStatus: 'PRINTED',
    }),
  ]
  const picking = pickingOf(orders)
  // View-model zaten yalnız 'a'yı verir; kart bunu OLDUĞU GİBİ gösterir.
  expect(picking.orderCount).toBe(1)
  const { container } = render(
    <PickingProductsCard picking={picking} onToggleExpand={vi.fn()} />,
  )
  expect(container.querySelector('.picking-row-totals b')?.textContent).toBe(
    '1 adet',
  )
  expect(screen.getByTestId('picking-summary').textContent).toContain(
    '1 sipariş',
  )
})

test('PICKING-UX-7: SESSİZ first-10 kırpma YOK', () => {
  const orders = Array.from({ length: 60 }, (_, index) =>
    order(`o${index}`, [
      line({
        productContentId: `C-${index}`,
        productName: `Urun ${index}`,
        quantity: 60 - index,
      }),
    ]),
  )
  const { container, picking } = renderCard(orders)
  const rows = container.querySelectorAll('[data-testid="picking-row"]')
  expect(rows.length).toBe(picking.products.length)
  expect(rows.length).toBeGreaterThan(10)
  // Gizlenen aile sayısı KULLANICIYA açıkça bildirilir.
  const notice = screen.getByTestId('picking-more').textContent ?? ''
  expect(notice).toContain(`+${picking.hiddenFamilyCount} ürün ailesi daha`)
  expect(notice).toContain(`toplam ${picking.totalFamilyCount}`)
})

test('PICKING-UX-8: operasyon aşama özeti kanonik etiketlerden gelir', () => {
  renderCard([
    order('ready', [line({ size: '36' })]),
    order('waiting', [line({ size: '40' })], {
      operationStatus: 'NEW',
      labelStatus: 'NONE',
      shipment: undefined,
    }),
  ])
  const stages = document.querySelector('.picking-row-stages')?.textContent ?? ''
  expect(stages).toContain('Etiket Hazır: 1')
  // Yeni/uydurma iş durumu YOK.
  expect(stages).not.toContain('Toplandı')
  expect(stages).not.toContain('SDP')
})
