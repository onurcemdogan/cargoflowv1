import type { CargoOrder } from '../types/cargoflow'

// ═══ SON BAŞARILI SENKRONİZASYON DAMGASI — TEK KAYNAK ═════════════════════
//
// ÜRETİM HATASI (kanıtlandı): "Son senkronizasyon: Bekleniyor" sayfa
// yenilendikten sonra kalıcı veri DOLU olmasına rağmen kalıyordu.
//
// Sebep: damga YALNIZ bellek içi React state'indeydi (App.tsx ordersState.
// lastSyncedAt, sadece handleFetchOrders başarısında yazılıyor) ve reload'da
// undefined'a dönüyordu. Dashboard'un kalıcı-veri fallback'i
// `order.lastMarketplaceSyncedAt` okuyor; auth modunda rowToOrder bu alanı
// HİÇ ÜRETMEDİĞİ için fallback de boş kalıyordu.
//
// Bu helper TEK kanonik çözümü verir ve HEM Dashboard HEM Siparişler
// ekranına aynı değeri besler:
//   1. bu oturumda gerçekleşen başarılı sync (varsa, en tazedir)
//   2. kalıcı sipariş verisindeki en yeni pazaryeri sync damgası
//
// Yeni localStorage cache, yeni DB kolonu veya yeni endpoint YOKTUR.
// BAŞARISIZ sync bu değeri SİLMEZ: son başarılı damga korunur.
export function resolveLastSuccessfulSyncAt(
  orders: CargoOrder[],
  sessionSyncedAt?: string,
): string | undefined {
  const candidates: string[] = []
  const session = String(sessionSyncedAt ?? '').trim()
  if (session) candidates.push(session)
  for (const order of orders ?? []) {
    const value = String(
      (order as unknown as Record<string, unknown>).lastMarketplaceSyncedAt ??
        '',
    ).trim()
    if (value) candidates.push(value)
  }
  return candidates
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => right.time - left.time)[0]?.value
}
