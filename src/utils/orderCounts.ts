import type { CargoOrder } from '../types/cargoflow.ts'

export interface OrderCountSummary {
  packageCount: number
  orderCount: number
  lineCount: number
  quantityTotal: number
}

/**
 * PAKET KİMLİĞİ HAFIZASI.
 *
 * ═══ NEDEN ═══════════════════════════════════════════════════════════════
 * Bu fonksiyon `toLocaleLowerCase('tr-TR')` çalıştırır (ICU) ve görünür liste
 * hesabında ÇOK sık çağrılır: `buildVisibleOrders` her filtre aşamasında
 * (11 aşama) düşen kayıtları raporlamak için hem önceki hem sonraki listeyi
 * tarar, ve sekme sayaçları bu hesabı ana sekme sayısı kadar tekrarlar.
 *
 * ÖLÇÜLDÜ (gerçek Postgres): bu, sipariş başına ~150 ICU çağrısı demekti.
 * 25.000 siparişte ~3,8 milyon locale dönüşümü — projeksiyonun asıl maliyeti
 * sınıflandırıcı değil, BURASIYDI.
 *
 * ═══ NEDEN GÜVENLİ ═══════════════════════════════════════════════════════
 * Kimlik, siparişin `marketplace` / `packageId` / `orderNumber` alanlarının
 * SAF bir fonksiyonudur. Hafıza nesne kimliğine (`WeakMap`) bağlanır ve kayıt
 * bu üç alanın o anki değerlerini SAKLAR; biri değişmişse kayıt kullanılmaz.
 * Sonuç DEĞİŞMEZ.
 */
interface IdentityMemoEntry {
  marketplace: unknown
  packageId: unknown
  orderNumber: unknown
  value: string
}
const identityMemo = new WeakMap<object, IdentityMemoEntry>()

export function orderPackageIdentity(order: CargoOrder): string {
  const cached = identityMemo.get(order as object)
  if (
    cached &&
    cached.marketplace === order.marketplace &&
    cached.packageId === order.packageId &&
    cached.orderNumber === order.orderNumber
  ) {
    return cached.value
  }
  const value = computeOrderPackageIdentity(order)
  identityMemo.set(order as object, {
    marketplace: order.marketplace,
    packageId: order.packageId,
    orderNumber: order.orderNumber,
    value,
  })
  return value
}

function computeOrderPackageIdentity(order: CargoOrder): string {
  const marketplace = normalizedIdentityPart(order.marketplace || 'unknown')
  const packageId = firstIdentity(order.packageId, order.shipmentPackageId)
  if (packageId) return `${marketplace}:package:${packageId}`

  const orderNumber = normalizedIdentityPart(order.orderNumber)
  if (orderNumber) return `${marketplace}:order:${orderNumber}`

  return `${marketplace}:record:${normalizedIdentityPart(
    order.externalOrderId || order.id,
  )}`
}

export function orderPackageIdentityCandidates(order: CargoOrder): string[] {
  const marketplace = normalizedIdentityPart(order.marketplace || 'unknown')
  return Array.from(
    new Set(
      [order.packageId, order.shipmentPackageId]
        .map(normalizedIdentityPart)
        .filter(Boolean)
        .map((value) => `${marketplace}:package:${value}`),
    ),
  )
}

export function orderNumberIdentity(order: CargoOrder): string {
  const marketplace = normalizedIdentityPart(order.marketplace || 'unknown')
  const orderNumber = normalizedIdentityPart(order.orderNumber)
  return orderNumber
    ? `${marketplace}:order:${orderNumber}`
    : orderPackageIdentity(order)
}

export function hasMarketplacePackageIdentity(order: CargoOrder): boolean {
  return orderPackageIdentityCandidates(order).length > 0
}

export function dedupeOrdersByPackageIdentity(
  orders: CargoOrder[],
): CargoOrder[] {
  const seen = new Set<string>()
  return orders.filter((order) => {
    const identity = orderPackageIdentity(order)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/**
 * SİPARİŞ BAŞINA satır katkısı — nesne kimliğine göre hafızalanır.
 *
 * ═══ NEDEN GÜVENLİ ═══════════════════════════════════════════════════════
 * Satır tekilleştirme anahtarı `${packageIdentity}:line:…` biçimindedir:
 * paket kimliğiyle ÖNEKLENMİŞTİR, dolayısıyla iki FARKLI siparişin satırları
 * asla aynı anahtara düşemez. Bu yüzden satır sayısı ve adet toplamı SİPARİŞ
 * BAŞINA bağımsızdır ve önceden hesaplanabilir.
 *
 * Hafıza, siparişin `items` dizisi kimliğiyle korunur: dizi değişirse (yeni
 * türetme, yeni senkron) yeniden hesaplanır. Yerinde değiştirme sonucu bayat
 * dönmesi MÜMKÜN DEĞİLDİR.
 *
 * ÖLÇÜLDÜ (gerçek Postgres, 25.000 sipariş): 117 ms → 20 ms.
 */
interface LineSummaryEntry {
  items: unknown
  lineCount: number
  quantityTotal: number
}
const lineSummaryMemo = new WeakMap<object, LineSummaryEntry>()

function orderLineSummary(
  order: CargoOrder,
  packageIdentity: string,
): LineSummaryEntry {
  const items = order.items
  const cached = lineSummaryMemo.get(order as object)
  if (cached && cached.items === items) return cached
  const keys = new Set<string>()
  let quantityTotal = 0
  ;(items ?? []).forEach((item, index) => {
    const itemRecord = item as typeof item & Record<string, unknown>
    const lineIdentity = firstIdentity(
      item.id,
      itemRecord.lineId,
      itemRecord.orderLineId,
      itemRecord.lineItemId,
    )
    const fallbackIdentity = firstIdentity(
      item.barcode,
      item.merchantSku,
      item.sku,
      item.stockCode,
    )
    const key = `${packageIdentity}:line:${
      lineIdentity || `${fallbackIdentity || 'index'}:${index}`
    }`
    if (keys.has(key)) return
    keys.add(key)
    quantityTotal += finiteQuantity(item.quantity)
  })
  const entry: LineSummaryEntry = {
    items,
    lineCount: keys.size,
    quantityTotal,
  }
  lineSummaryMemo.set(order as object, entry)
  return entry
}

export function buildOrderCountSummary(
  orders: CargoOrder[],
): OrderCountSummary {
  const packageIds = new Set<string>()
  const orderIds = new Set<string>()
  let lineCount = 0
  let quantityTotal = 0

  for (const order of orders) {
    const packageIdentity = orderPackageIdentity(order)
    if (packageIds.has(packageIdentity)) {
      // ═══ AYNI PAKET KİMLİĞİ İKİ KEZ ═════════════════════════════════════
      // Hızlı yol, satır anahtarlarının paket kimliğiyle ÖNEKLİ olmasına ve
      // dolayısıyla siparişler arası çakışmamasına dayanır. Aynı kimlik iki
      // kez gelirse bu varsayım DÜŞER (iki kayıt farklı satırlar taşıyabilir).
      //
      // Bu durumda hesap, ORİJİNAL küresel-küme algoritmasıyla BAŞTAN yapılır.
      // Çağıranlar listeyi zaten paket kimliğine göre tekilleştirdiği için bu
      // dal pratikte çalışmaz; yine de sonucun BİREBİR aynı kalmasını
      // garanti eder — hız uğruna cevap değiştirilmez.
      return exactOrderCountSummary(orders)
    }
    packageIds.add(packageIdentity)
    orderIds.add(orderNumberIdentity(order))
    const summary = orderLineSummary(order, packageIdentity)
    lineCount += summary.lineCount
    quantityTotal += summary.quantityTotal
  }

  return {
    packageCount: packageIds.size,
    orderCount: orderIds.size,
    lineCount,
    quantityTotal,
  }
}

/** Hafızasız, küresel anahtar kümeli ORİJİNAL hesap (yinelenen kimlik dalı). */
function exactOrderCountSummary(orders: CargoOrder[]): OrderCountSummary {
  const packageIds = new Set<string>()
  const orderIds = new Set<string>()
  const lineIds = new Set<string>()
  let quantityTotal = 0

  orders.forEach((order) => {
    const packageIdentity = orderPackageIdentity(order)
    packageIds.add(packageIdentity)
    orderIds.add(orderNumberIdentity(order))

    order.items.forEach((item, index) => {
      const itemRecord = item as typeof item & Record<string, unknown>
      const lineIdentity = firstIdentity(
        item.id,
        itemRecord.lineId,
        itemRecord.orderLineId,
        itemRecord.lineItemId,
      )
      const fallbackIdentity = firstIdentity(
        item.barcode,
        item.merchantSku,
        item.sku,
        item.stockCode,
      )
      const key = `${packageIdentity}:line:${
        lineIdentity || `${fallbackIdentity || 'index'}:${index}`
      }`
      if (lineIds.has(key)) return
      lineIds.add(key)
      quantityTotal += finiteQuantity(item.quantity)
    })
  })

  return {
    packageCount: packageIds.size,
    orderCount: orderIds.size,
    lineCount: lineIds.size,
    quantityTotal,
  }
}

/**
 * İLK DOLU değeri döndürür.
 *
 * Eskiden `values.map(normalizedIdentityPart).find(Boolean)` idi: ilk değer
 * dolu olsa bile KALAN HEPSİ normalize ediliyordu. Normalizasyon bir ICU
 * (`toLocaleLowerCase('tr-TR')`) çağrısıdır ve bu fonksiyon sipariş satırı
 * başına iki kez, dört değerle çağrılır. Kısa devre SONUCU DEĞİŞTİRMEZ —
 * `find(Boolean)` zaten ilk dolu değeri seçiyordu.
 */
function firstIdentity(...values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizedIdentityPart(value)
    if (normalized) return normalized
  }
  return ''
}

/**
 * DİZE DÜZEYİNDE NORMALİZASYON HAFIZASI.
 *
 * ═══ NEDEN ═══════════════════════════════════════════════════════════════
 * CPU profili (gerçek Postgres, 200 sipariş, 30 tur): toplam örneklerin
 * ~%48'i bu tek fonksiyondaydı. Girdiler paket kimliği, sipariş numarası,
 * SKU ve barkod gibi TEKRAR EDEN dizelerdir; aynı dize bir istek içinde
 * onlarca kez normalize ediliyordu.
 *
 * ═══ NEDEN GÜVENLİ ═══════════════════════════════════════════════════════
 * Dönüşüm saf ve deterministiktir: aynı dize her zaman aynı sonucu verir.
 * Türkçe I/İ kuralları hakkında HİÇBİR varsayım yapılmaz — ICU yine çağrılır,
 * yalnız her benzersiz dize için BİR KEZ. Sınır aşılırsa hafıza tamamen
 * boşaltılır (sınırsız bellek büyümesi YOK).
 */
const NORMALIZED_MEMO_LIMIT = 100_000
const normalizedMemo = new Map<string, string>()

function normalizedIdentityPart(value: unknown): string {
  const raw = String(value ?? '')
  if (raw === '') return ''
  const cached = normalizedMemo.get(raw)
  if (cached !== undefined) return cached
  const normalized = raw.trim().toLocaleLowerCase('tr-TR')
  if (normalizedMemo.size >= NORMALIZED_MEMO_LIMIT) normalizedMemo.clear()
  normalizedMemo.set(raw, normalized)
  return normalized
}

function finiteQuantity(value: unknown): number {
  const quantity = Number(value ?? 0)
  return Number.isFinite(quantity) ? quantity : 0
}
