// ÖĞE ADLARI — TEK KAYNAK.
//
// Bileşen dosyasından ayrı tutulur: bir modül hem bileşen hem sabit ihraç
// ederse hızlı yenileme (fast refresh) bozulur ve düzenleyicide her küçük
// değişiklik tam sayfa yenilemesine döner.

import type { LabelElementType } from './labelDocument.ts'

const ELEMENT_LABELS: Record<string, string> = {
  recipientName: 'Alıcı adı',
  buyerName: 'Satın alan',
  address: 'Adres',
  cityDistrict: 'İl / İlçe',
  phone: 'Telefon',
  orderNumber: 'Sipariş no',
  packageId: 'Paket no',
  orderDate: 'Sipariş tarihi',
  orderTime: 'Sipariş saati',
  marketplace: 'Pazaryeri',
  trackingText: 'Takip numarası',
  barcode: 'Barkod',
  qr: 'QR kod',
  productList: 'Ürün listesi',
  cargoMeta: 'Kargo bilgisi',
  staticText: 'Serbest metin',
}

export function labelElementLabel(type: LabelElementType | string): string {
  return ELEMENT_LABELS[type] ?? String(type)
}
