// Seçili sipariş anlık görüntüsü — SAF (IO/DOM YOK).
//
// KÖK NEDEN (canlı): OrdersPage'de "20 sipariş seçildi" metni ile yanındaki
// "paket / kalem / ürün" sayıları FARKLI kaynaklardan geliyordu:
//   selectionText  -> selectedIds.length          (seçim)
//   listedCounts   -> buildOrderCountSummary(filteredOrders)  (GÖRÜNÜR liste)
// Sürat create sonrası siparişler "Yeni Siparişler" sekmesinden "Etiket Hazır"
// sekmesine geçince, kullanıcı hâlâ eski sekmedeyken filteredOrders BOŞALIYOR
// ve özet 0 paket / 0 kalem / 0 ürün'e düşüyordu; seçim ise 20 kalıyordu.
//
// ÇÖZÜM: seçim özeti GÖRÜNÜR listeden değil, seçimin TÜM yüklenmiş
// persistentOrders üzerinde çözülmesinden hesaplanır. Sekme/filtre/statü
// değişimi seçimi ve özetini DÜŞÜRMEZ.
//
// GİZLİLİK: snapshot müşteri adı/adres/telefon TAŞIMAZ; yalnız kimlik,
// sipariş numarası ve sayımlar.
import type { CargoOrder } from '../types/cargoflow'
import { buildOrderCountSummary, orderPackageIdentity } from './orderCounts'

export interface SelectedOrderSnapshotEntry {
  orderId: string
  orderNumber: string
  /** Canonical paket kimliği (marketplace:package:<id>). */
  identity: string
  packageCount: number
  lineCount: number
  quantityTotal: number
  /** Seçim sırasındaki başlangıç sırası (deterministik baskı sırası). */
  order: number
}

export interface SelectedOrderSnapshot {
  entries: SelectedOrderSnapshotEntry[]
  selectedCount: number
  packageCount: number
  lineCount: number
  quantityTotal: number
  /** Seçili olup GÖRÜNÜR listede bulunmayan sipariş sayısı. */
  outsideCurrentViewCount: number
}

// Seçimi TÜM yüklenmiş siparişler üzerinden çözer. `visibleOrders` yalnız
// "kaçı şu an görünür" bilgisini üretmek için kullanılır; sayımları ETKİLEMEZ.
export function buildSelectedOrderSnapshot(
  allOrders: CargoOrder[],
  selectedIds: string[],
  visibleOrders: CargoOrder[] = [],
): SelectedOrderSnapshot {
  const wanted = new Set((selectedIds ?? []).map((id) => String(id)))
  const visibleIds = new Set(
    (visibleOrders ?? []).map((order) => String(order?.id ?? '')),
  )
  const seenIdentity = new Set<string>()
  const selected: CargoOrder[] = []
  const entries: SelectedOrderSnapshotEntry[] = []

  for (const order of allOrders ?? []) {
    if (!order) continue
    const id = String(order.id ?? '')
    if (!wanted.has(id)) continue
    const identity = orderPackageIdentity(order)
    // Aynı paket kimliği iki kayıtla gelirse TEK sayılır.
    if (seenIdentity.has(identity)) continue
    seenIdentity.add(identity)
    selected.push(order)
    const single = buildOrderCountSummary([order])
    entries.push({
      orderId: id,
      orderNumber: String(order.orderNumber ?? id),
      identity,
      packageCount: single.packageCount,
      lineCount: single.lineCount,
      quantityTotal: single.quantityTotal,
      order: entries.length,
    })
  }

  const summary = buildOrderCountSummary(selected)
  const outside = entries.filter((entry) => !visibleIds.has(entry.orderId)).length

  return {
    entries,
    selectedCount: entries.length,
    packageCount: summary.packageCount,
    lineCount: summary.lineCount,
    quantityTotal: summary.quantityTotal,
    outsideCurrentViewCount: outside,
  }
}

// "20 seçili siparişten 20'si artık başka sekmede." bilgi metni.
// Hepsi görünürse boş string döner (gereksiz uyarı yok).
export function describeSelectionOutsideView(
  snapshot: SelectedOrderSnapshot,
  tabLabel: string,
): string {
  if (snapshot.selectedCount === 0) return ''
  if (snapshot.outsideCurrentViewCount === 0) return ''
  return (
    `${snapshot.selectedCount} seçili siparişten ` +
    `${snapshot.outsideCurrentViewCount}'si artık ${tabLabel} sekmesinde.`
  )
}

// İşlem sonrası seçim: yalnız BAŞARIYLA yazdırıldığı doğrulanan siparişler
// seçimden çıkar. Başarısız / atlanan / iptal edilenler SEÇİLİ KALIR ki
// kullanıcı yeniden deneyebilsin.
export function resolveSelectionAfterBatch(
  selectedIds: string[],
  printedOrderIds: string[],
): string[] {
  const printed = new Set((printedOrderIds ?? []).map((id) => String(id)))
  return (selectedIds ?? [])
    .map((id) => String(id))
    .filter((id) => !printed.has(id))
}
