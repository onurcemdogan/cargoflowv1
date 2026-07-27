import type { CargoOrder } from '../types/cargoflow'

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? ''
}

// Kullanıcıya gösterilen "Sipariş No". Trendyol entegrasyon/sipariş referansı
// (727... ile başlar) mevcutsa o gösterilir; yoksa canonical orderNumber (114...).
//
// ÖNEMLİ: Bu YALNIZ görünümü değiştirir. DB'deki canonical orderNumber (114...)
// API çağrıları, eşleştirme ve idempotency için DEĞİŞMEDEN korunur; Sürat request
// mapping'i etkilenmez. OzelKargoTakipNo Trendyol entegrasyon referansıdır — Sürat
// T.No'su veya Sürat barkodu DEĞİLDİR.
export function displayOrderNumber(order: CargoOrder): string {
  return firstNonEmpty(
    order.shipment?.ozelKargoTakipNo,
    order.shipment?.trendyolCargoTrackingNumber,
    order.cargoTrackingNumber,
    order.orderNumber,
  )
}

// Detayda ikincil gösterilebilen "Kaynak Sipariş No" (114...). Görünen değer zaten
// orderNumber ise (727 referansı yoksa) tekrarı önlemek için boş döner.
export function sourceOrderNumber(order: CargoOrder): string {
  const display = displayOrderNumber(order)
  const source = String(order.orderNumber ?? '').trim()
  return source && source !== display ? source : ''
}

// Arama eşleşmesi için hem görünen (727...) hem kaynak (114...) referansları döner;
// kullanıcı her iki değerle de siparişi bulabilsin diye.
export function orderNumberSearchValues(order: CargoOrder): string[] {
  return [
    order.orderNumber,
    order.externalOrderId,
    order.cargoTrackingNumber,
    order.shipment?.ozelKargoTakipNo,
    order.shipment?.trendyolCargoTrackingNumber,
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
}
