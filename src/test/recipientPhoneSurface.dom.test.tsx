import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { OrderDetailDrawer } from '../components/OrderDetailDrawer'
import type { CargoOrder } from '../types/cargoflow'

// ALICI TELEFONU — EKRAN İLE ETİKET AYNI CEVABI VERİR.
//
// ═══ ÜRETİM HATASI ═══════════════════════════════════════════════════════
// Sipariş detayında "Telefon: -" görünüyordu; aynı siparişin etiketinde ve
// taşıyıcıya giden create isteğinde telefon VARDI. Sebep, aynı verinin İKİ
// FARKLI yoldan çözülmesiydi:
//
//   · etiket / create : `resolveRecipientPhone` — yedi adaylık zincir
//     (shipmentAddress.phone, rawOrder.invoiceAddress.phone, …)
//   · sipariş ekranı  : DOĞRUDAN `order.customerPhone`
//
// Trendyol telefonu çoğu pakette `shipmentAddress` içinde döndürdüğü için
// ekran boş, etiket dolu görünüyordu. Operatör "telefon yok" sanıp müşteriye
// ulaşamıyordu.
//
// TÜM VERİLER SENTETİKTİR (gerçek telefon/PII yok).

const BASE = {
  id: 'o1',
  orderNumber: 'ORD-1',
  packageId: 'PKG-1',
  marketplace: 'Trendyol',
  customerName: 'SENTETIK ALICI',
  city: 'KOCAELI',
  district: 'GEBZE',
  orderDate: '2026-09-01T00:00:00.000Z',
  items: [],
} as unknown as CargoOrder

function renderDrawer(order: CargoOrder) {
  render(
    <OrderDetailDrawer
      order={order}
      products={[]}
      busy={false}
      onClose={() => {}}
      onCreateShipment={() => {}}
      onTrackShipment={() => {}}
      onDownloadZpl={() => {}}
      onPrintLabel={() => {}}
    />,
  )
}

function phoneValue(): string {
  const label = screen.getByText('Telefon')
  return label.parentElement?.querySelector('strong')?.textContent ?? ''
}

test('PHONE-UI-1: telefon YALNIZ shipmentAddress icindeyse ekranda GORUNUR', () => {
  // customerPhone BOŞ — eski kod burada "-" gösteriyordu.
  renderDrawer({
    ...BASE,
    shipmentAddress: { phone: '5440000000' },
  } as unknown as CargoOrder)
  expect(phoneValue()).toBe('544 000 00 00')
})

test('PHONE-UI-2: telefon ham siparis govdesinde ise de ekranda GORUNUR', () => {
  renderDrawer({
    ...BASE,
    rawOrder: { invoiceAddress: { phone: '5440000000' } },
  } as unknown as CargoOrder)
  expect(phoneValue()).toBe('544 000 00 00')
})

test('PHONE-UI-3: gercekten telefon yoksa "-" gosterilir, numara UYDURULMAZ', () => {
  renderDrawer(BASE)
  expect(phoneValue()).toBe('-')
})

test('PHONE-UI-4: ekran ile etiket AYNI zinciri kullanir', async () => {
  const { resolveRecipientPhone } = await import('../utils/labelData')
  const order = {
    ...BASE,
    shipmentAddress: { gsm: '5440000000' },
  } as unknown as CargoOrder
  renderDrawer(order)
  expect(phoneValue()).toBe(resolveRecipientPhone(order).phone)
})
