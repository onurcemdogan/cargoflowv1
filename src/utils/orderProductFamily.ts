import type { CargoOrder, OrderItem } from '../types/cargoflow'

/**
 * "Aynı Ürün Siparişi" filtre değeri.
 * repeated → aynı üründen 2+ DISTINCT sipariş · unique → tekil ürünler.
 */
export type SameProductFilter = 'all' | 'repeated' | 'unique'

// ═══ ÜRÜN AİLESİ (PRODUCT FAMILY) — YALNIZ OPERASYON GÖRÜNÜRLÜĞÜ ═══════════
//
// KAPSAM UYARISI: bu modül YALNIZ
//   · Toplanacak Ürünler ekranı
//   · "Aynı Ürün Siparişi" filtresi
// içindir. Sürat etiket/footer aggregation'ı DEĞİŞMEZ ve buradan BESLENMEZ;
// orada kimlik strict kalır: ürün + SKU + renk + BEDEN.
//
// Buradaki fark tek bir kuraldır: BEDEN aile anahtarına GİRMEZ.
// Depocu rafa gittiğinde "bu modelden kaç tane" sorusunu sorar; beden yalnız
// alt kırılımdır. Renk ise AYRI üründür (ayrı rafta durur), bu yüzden anahtara
// GİRER.

/** Aile kimliğinin hangi kanonik alandan türetildiği (tanı/test içindir). */
export type ProductFamilyIdentitySource =
  | 'productContentId'
  | 'productCode'
  | 'productMainId'
  | 'nameColorFallback'

export interface ProductFamilyVariant {
  /** Ham beden değeri (görüntülenecek). Boşsa 'Bedensiz'. */
  size: string
  sizeKey: string
  quantity: number
  orderIds: string[]
}

export interface ProductFamilyOrderRef {
  orderId: string
  size: string
  quantity: number
}

export interface ProductFamilyGroup {
  key: string
  productName: string
  color: string
  identitySource: ProductFamilyIdentitySource
  totalQuantity: number
  /** DISTINCT logical order sayısı (quantity DEĞİL). */
  orderCount: number
  orderIds: string[]
  variants: ProductFamilyVariant[]
  /** Bu aileyi bekleyen siparişlerin canonical aşama dağılımı. */
  stageCounts: Record<string, number>
  /** Görsel/SKU gibi sunum detayları için temsilci satır. */
  sampleItem: OrderItem
  orderRefs: ProductFamilyOrderRef[]
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function firstToken(...values: unknown[]): string {
  for (const value of values) {
    const token = String(value ?? '').trim()
    if (token) return token
  }
  return ''
}

/**
 * BEDEN BAĞIMSIZ ürün ailesi anahtarı.
 *
 * Öncelik (bölüm 9): beden varyantından bağımsız pazaryeri kimliği önce gelir.
 *   1. productContentId
 *   2. productCode
 *   3. productMainId
 *   4. normalize(ürün adı)          ← yalnız kanonik kimlik YOKKEN
 *
 * SKU / merchantSku / stockCode / barcode BİLE BİLE kullanılmaz: bunlar beden
 * bazında farklılaşır, eşitlik anahtarı yapılırsa aynı model 3 ayrı aileye
 * bölünür. (Sunumda varyant detayı olarak gösterilebilirler.)
 *
 * Renk HER ZAMAN anahtarın parçasıdır (bölüm 10): aynı contentId altında
 * Lacivert ve Bordo AYRI gruptur.
 *
 * Fuzzy isim benzerliği YOKTUR. Normalizasyon deterministiktir: yalnız
 * büyük/küçük harf, Türkçe katlama ve boşluk gibi anlamsız farkları eler.
 */
export function resolveProductFamilyIdentity(item: OrderItem): {
  key: string
  source: ProductFamilyIdentitySource
} {
  const color = normalizeToken(item.color)
  const contentId = firstToken(item.productContentId)
  if (contentId) {
    return {
      key: `content:${normalizeToken(contentId)}|color:${color}`,
      source: 'productContentId',
    }
  }
  const productCode = firstToken(item.productCode)
  if (productCode) {
    return {
      key: `code:${normalizeToken(productCode)}|color:${color}`,
      source: 'productCode',
    }
  }
  const mainId = firstToken(item.productMainId)
  if (mainId) {
    return {
      key: `main:${normalizeToken(mainId)}|color:${color}`,
      source: 'productMainId',
    }
  }
  // Kanonik kimlik yok: ürün adı + renk. Beden yine ANAHTARA GİRMEZ.
  return {
    key: `name:${normalizeToken(item.productName)}|color:${color}`,
    source: 'nameColorFallback',
  }
}

export function resolveProductFamilyKey(item: OrderItem): string {
  return resolveProductFamilyIdentity(item).key
}

function orderIdentity(order: CargoOrder): string {
  return String(order.id || order.orderNumber || '')
}

/**
 * TEK GEÇİŞ index'i: sipariş × kalem. O(N·I).
 * Ürün başına sipariş listesi için ikinci tarama YAPILMAZ (eski kodda
 * ürün × sipariş × kalem iç içe taranıyordu).
 */
export function buildProductFamilyIndex(
  orders: CargoOrder[],
  // Aşama çözümleyici DIŞARIDAN verilir: bu modül kanonik sınıflandırmaya
  // bağımlı değildir (döngüsel import olmaz, test edilmesi kolaydır).
  stageOf: (order: CargoOrder) => string = () => 'unknown',
): ProductFamilyGroup[] {
  const groups = new Map<
    string,
    Omit<ProductFamilyGroup, 'variants' | 'orderIds' | 'orderCount'> & {
      orderIds: Set<string>
      variants: Map<
        string,
        { size: string; quantity: number; orderIds: Set<string> }
      >
    }
  >()
  for (const order of orders) {
    const orderId = orderIdentity(order)
    if (!orderId) continue
    const stage = stageOf(order)
    // Aynı sipariş aynı aileyi birden çok kalemle içerebilir; aşama sayımı
    // sipariş başına BİR KEZ artmalıdır.
    const stageCountedFamilies = new Set<string>()
    for (const item of order.items ?? []) {
      const identity = resolveProductFamilyIdentity(item)
      const quantity = Math.max(0, Number(item.quantity) || 0)
      const size = String(item.size ?? '').trim()
      const sizeKey = normalizeToken(size) || 'bedensiz'
      let group = groups.get(identity.key)
      if (!group) {
        group = {
          key: identity.key,
          productName: item.productName || 'Ürün bilgisi yok',
          color: String(item.color ?? '').trim(),
          identitySource: identity.source,
          totalQuantity: 0,
          orderIds: new Set<string>(),
          variants: new Map(),
          stageCounts: {},
          sampleItem: item,
          orderRefs: [],
        }
        groups.set(identity.key, group)
      }
      group.totalQuantity += quantity
      group.orderIds.add(orderId)
      const variant = group.variants.get(sizeKey) ?? {
        size: size || 'Bedensiz',
        quantity: 0,
        orderIds: new Set<string>(),
      }
      variant.quantity += quantity
      variant.orderIds.add(orderId)
      group.variants.set(sizeKey, variant)
      group.orderRefs.push({ orderId, size: size || 'Bedensiz', quantity })
      if (!stageCountedFamilies.has(identity.key)) {
        stageCountedFamilies.add(identity.key)
        group.stageCounts[stage] = (group.stageCounts[stage] ?? 0) + 1
      }
    }
  }
  return Array.from(groups.values())
    .map((group) => ({
      key: group.key,
      productName: group.productName,
      color: group.color,
      identitySource: group.identitySource,
      totalQuantity: group.totalQuantity,
      orderCount: group.orderIds.size,
      orderIds: Array.from(group.orderIds),
      stageCounts: group.stageCounts,
      sampleItem: group.sampleItem,
      orderRefs: group.orderRefs,
      variants: Array.from(group.variants.entries())
        .map(([sizeKey, variant]) => ({
          sizeKey,
          size: variant.size,
          quantity: variant.quantity,
          orderIds: Array.from(variant.orderIds),
        }))
        // Stabil sıralama: adet çok olan üstte, eşitlikte beden adı.
        .sort(
          (left, right) =>
            right.quantity - left.quantity ||
            left.size.localeCompare(right.size, 'tr-TR'),
        ),
    }))
    .sort(
      (left, right) =>
        right.totalQuantity - left.totalQuantity ||
        left.productName.localeCompare(right.productName, 'tr-TR'),
    )
}

/**
 * "Aynı üründen 2+ sipariş": DISTINCT LOGICAL ORDER sayısına göre çalışır,
 * quantity'ye göre DEĞİL. Tek siparişte adet 5 olması tekrar SAYILMAZ.
 *
 * Dönen küme: verilen scope içinde, en az bir ürün ailesi BAŞKA bir distinct
 * sipariş tarafından da beklenen siparişlerin id'leri. Sipariş kimliğiyle
 * dedupe edilir → çok ürünlü bir sipariş birden çok ailede eşleşse bile
 * listede BİR KEZ görünür.
 */
export function buildRepeatedProductOrderIds(
  orders: CargoOrder[],
): Set<string> {
  const familyOrders = new Map<string, Set<string>>()
  for (const order of orders) {
    const orderId = orderIdentity(order)
    if (!orderId) continue
    for (const item of order.items ?? []) {
      const key = resolveProductFamilyKey(item)
      const bucket = familyOrders.get(key) ?? new Set<string>()
      bucket.add(orderId)
      familyOrders.set(key, bucket)
    }
  }
  const repeated = new Set<string>()
  for (const bucket of familyOrders.values()) {
    if (bucket.size < 2) continue
    for (const orderId of bucket) repeated.add(orderId)
  }
  return repeated
}

// ═══ AYNI ÜRÜN SİPARİŞİ — GÖRÜNÜM GRUPLAMASI ══════════════════════════════
//
// YALNIZ SUNUM. Filtre SEMANTİĞİ ve KAPSAMI DEĞİŞMEZ: hangi siparişlerin
// görüneceğine `buildRepeatedProductOrderIds` karar verir, burada yalnız
// SIRALAMA yapılır ki aynı ürün ailesinin farklı bedenleri yan yana dursun.
//
// Sipariş TEK gruba atanır (çok ürünlü sipariş listede bir kez görünür):
// kendi aileleri arasında kapsamda EN ÇOK siparişi olan aile birincil kabul
// edilir; eşitlikte aile anahtarı artan sırada. Bu kural kalem sırasından
// BAĞIMSIZDIR → deterministiktir.

export interface SameProductGroupHeader {
  key: string
  productName: string
  color: string
  /** Gruptaki DISTINCT sipariş sayısı. */
  orderCount: number
  /** Grubun bu ailedeki toplam adedi. */
  totalQuantity: number
  /** Artan sıralı beden listesi (beden GRUP ANAHTARINA girmez). */
  sizes: string[]
}

export interface SameProductGroupingResult {
  /** Aynı aile bitişik olacak şekilde YENİDEN SIRALANMIŞ liste. */
  orders: CargoOrder[]
  /** orderId → ait olduğu grup başlığı (her sipariş için doludur). */
  headerByOrderId: Map<string, SameProductGroupHeader>
  groups: SameProductGroupHeader[]
}

export function groupOrdersBySameProductFamily(
  orders: CargoOrder[],
): SameProductGroupingResult {
  const familyOrderIds = new Map<string, Set<string>>()
  for (const order of orders) {
    const orderId = orderIdentity(order)
    if (!orderId) continue
    for (const item of order.items ?? []) {
      const key = resolveProductFamilyKey(item)
      const bucket = familyOrderIds.get(key) ?? new Set<string>()
      bucket.add(orderId)
      familyOrderIds.set(key, bucket)
    }
  }

  const primaryKeyByOrderId = new Map<string, string>()
  for (const order of orders) {
    const orderId = orderIdentity(order)
    if (!orderId) continue
    let bestKey = ''
    let bestCount = -1
    for (const item of order.items ?? []) {
      const key = resolveProductFamilyKey(item)
      const count = familyOrderIds.get(key)?.size ?? 0
      if (count > bestCount || (count === bestCount && key < bestKey)) {
        bestKey = key
        bestCount = count
      }
    }
    primaryKeyByOrderId.set(orderId, bestKey || `order:${orderId}`)
  }

  const buckets = new Map<
    string,
    {
      header: SameProductGroupHeader
      orders: CargoOrder[]
      sizes: Set<string>
    }
  >()
  for (const order of orders) {
    const orderId = orderIdentity(order)
    if (!orderId) continue
    const key = primaryKeyByOrderId.get(orderId) ?? ''
    const matching = (order.items ?? []).filter(
      (item) => resolveProductFamilyKey(item) === key,
    )
    const sample = matching[0] ?? order.items?.[0]
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        header: {
          key,
          productName: sample?.productName || 'Ürün bilgisi yok',
          color: String(sample?.color ?? '').trim(),
          orderCount: 0,
          totalQuantity: 0,
          sizes: [],
        },
        orders: [],
        sizes: new Set<string>(),
      }
      buckets.set(key, bucket)
    }
    bucket.orders.push(order)
    bucket.header.orderCount += 1
    for (const item of matching) {
      bucket.header.totalQuantity += Math.max(0, Number(item.quantity) || 0)
      const size = String(item.size ?? '').trim()
      if (size) bucket.sizes.add(size)
    }
  }

  const ordered = Array.from(buckets.values()).sort(
    (left, right) =>
      right.header.orderCount - left.header.orderCount ||
      right.header.totalQuantity - left.header.totalQuantity ||
      left.header.productName.localeCompare(right.header.productName, 'tr-TR') ||
      left.header.key.localeCompare(right.header.key),
  )

  const result: CargoOrder[] = []
  const headerByOrderId = new Map<string, SameProductGroupHeader>()
  const groups: SameProductGroupHeader[] = []
  for (const bucket of ordered) {
    bucket.header.sizes = Array.from(bucket.sizes).sort((left, right) =>
      left.localeCompare(right, 'tr-TR', { numeric: true }),
    )
    groups.push(bucket.header)
    for (const order of bucket.orders) {
      // Giriş sırası (mevcut sıralama) grup İÇİNDE korunur → stabil.
      result.push(order)
      headerByOrderId.set(orderIdentity(order), bucket.header)
    }
  }
  return { orders: result, headerByOrderId, groups }
}
