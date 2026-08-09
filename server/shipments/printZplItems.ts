// BASKI ÜRÜN SATIRLARININ SUNUCU TARAFI ÇÖZÜMÜ — org kapsamlı.
//
// Etiket footer'ı için ürün satırları, HTML etiketiyle AYNI ortak zincirden
// (src/utils/suratProductLineItems.ts) üretilir: yapısal color/size →
// variantAttributes → organizasyon + pazaryeri kapsamlı KESİN katalog
// varyantı → çapalı başlık ayrıştırması → "Belirtilmemiş".
//
// KATALOG YÜKLEME: tüm katalog DEĞİL, yalnız bu siparişin satırlarındaki
// kesin kimliklerle (barcode / merchantSku / stockCode) eşleşen varyantlar
// hedefli olarak çekilir. Fuzzy ad eşleşmesi YOKTUR.
import { and, eq, inArray, or } from 'drizzle-orm'
import { orderLines, orders, productVariants } from '../db/schema.ts'
import { resolveSuratProductLineItems } from '../../src/utils/suratProductLineItems.ts'
import type { SuratProductLineItem } from '../../src/utils/suratZplProductLine.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function uniqueNonEmpty(values: unknown[]): string[] {
  return Array.from(
    new Set(values.map((value) => str(value).trim()).filter(Boolean)),
  )
}

/**
 * Siparişin satırlarını ve YALNIZ o satırlarla kesin eşleşen katalog
 * varyantlarını yükleyip ortak resolver'dan geçirir.
 * Sipariş veya satır yoksa boş dizi döner (çağıran katman artifact üretmez).
 */
export async function loadPrintLineItems(
  db: Db,
  organizationId: string,
  marketplace: string,
  packageId: string,
): Promise<SuratProductLineItem[]> {
  const orderRows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        eq(orders.marketplace, marketplace),
        eq(orders.packageId, packageId),
      ),
    )
    .limit(1)
  const orderRow = orderRows[0]
  if (!orderRow) return []

  const lineRows = await db
    .select()
    .from(orderLines)
    .where(
      and(
        eq(orderLines.organizationId, organizationId),
        eq(orderLines.orderId, orderRow.id),
      ),
    )
  if (lineRows.length === 0) return []

  const items: Array<Record<string, unknown>> = lineRows.map(
    (row: Record<string, unknown>) => ({
    id: str(row.externalLineId),
    productName: str(row.productName),
    barcode: str(row.barcode),
    sku: str(row.merchantSku),
    merchantSku: str(row.merchantSku),
    stockCode: str(row.merchantSku),
    quantity: Number(row.quantity ?? 1),
      variantAttributes: (row.variantAttributes ?? []) as unknown,
    }),
  )

  // HEDEFLİ katalog sorgusu: yalnız bu satırların kesin kimlikleri.
  const barcodes = uniqueNonEmpty(items.map((item) => item.barcode))
  const merchantSkus = uniqueNonEmpty(items.map((item) => item.merchantSku))
  const conditions = []
  if (barcodes.length > 0) {
    conditions.push(inArray(productVariants.barcode, barcodes))
  }
  if (merchantSkus.length > 0) {
    conditions.push(inArray(productVariants.merchantSku, merchantSkus))
    conditions.push(inArray(productVariants.stockCode, merchantSkus))
  }
  const variantRows =
    conditions.length === 0
      ? []
      : await db
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.organizationId, organizationId),
              eq(productVariants.archived, false),
              conditions.length === 1 ? conditions[0] : or(...conditions),
            ),
          )

  // Ortak katalog çözümleyicisinin beklediği biçim (CargoProduct benzeri).
  const products = variantRows.map((row: Record<string, unknown>) => ({
    id: str(row.id),
    marketplace,
    productName: '',
    sku: str(row.merchantSku),
    stockCode: str(row.stockCode),
    barcode: str(row.barcode),
    color: str(row.color),
    size: str(row.size),
    stock: 0,
    price: 0,
    source: 'real',
    updatedAt: '',
  }))

  return resolveSuratProductLineItems(
    { marketplace, items } as never,
    products as never,
  )
}

/** Ayraç: pazaryeri veya paket kimliğinde GÖRÜNEMEZ bir kontrol karakteri. */
const KEY_SEPARATOR = '\u0000'

/** Toplu sonuç haritasının canonical anahtarı. */
export function printLineItemKeyOf(
  marketplace: unknown,
  packageId: unknown,
): string {
  return `${str(marketplace)}${KEY_SEPARATOR}${str(packageId)}`
}

export interface PrintLineItemKey {
  marketplace: string
  packageId: string
}

/**
 * TOPLU ürün satırı çözümü — sorgu sayısı GÖNDERİ SAYISINDAN BAĞIMSIZ.
 *
 * `loadPrintLineItems` paket başına 3 sorgu yapar; 25 gönderi için bu 75
 * sorgu (N+1) demektir. Bu sürüm AYNI çözümleyiciyi kullanır ama sorguları
 * TEK sette toplar: siparişler, satırlar, hedefli katalog varyantları.
 * Sonuç `marketplace+packageId` anahtarıyla döner.
 */
export async function loadPrintLineItemsBatch(
  db: Db,
  organizationId: string,
  keys: readonly PrintLineItemKey[],
): Promise<Map<string, SuratProductLineItem[]>> {
  const result = new Map<string, SuratProductLineItem[]>()
  const wanted = new Set(
    keys.map((key) => printLineItemKeyOf(key.marketplace, key.packageId)),
  )
  if (wanted.size === 0) return result

  const marketplaces = uniqueNonEmpty(keys.map((key) => key.marketplace))
  const packageIds = uniqueNonEmpty(keys.map((key) => key.packageId))
  // 1/3: siparişler. Çapraz çarpım DB'den gelebilir; İSTENEN çiftler
  // bellekte süzülür (marketplace+packageId ikilisi TAM eşleşmeli).
  const orderRows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, organizationId),
        inArray(orders.marketplace, marketplaces),
        inArray(orders.packageId, packageIds),
      ),
    )
  const byOrderId = new Map<string, string>()
  for (const row of orderRows as Array<Record<string, unknown>>) {
    const key = printLineItemKeyOf(row.marketplace, row.packageId)
    if (wanted.has(key)) byOrderId.set(str(row.id), key)
  }
  if (byOrderId.size === 0) return result

  // 2/3: satırlar.
  const lineRows = await db
    .select()
    .from(orderLines)
    .where(
      and(
        eq(orderLines.organizationId, organizationId),
        inArray(orderLines.orderId, Array.from(byOrderId.keys())),
      ),
    )
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const row of lineRows as Array<Record<string, unknown>>) {
    const key = byOrderId.get(str(row.orderId))
    if (!key) continue
    const bucket = grouped.get(key) ?? []
    bucket.push({
      id: str(row.externalLineId),
      productName: str(row.productName),
      barcode: str(row.barcode),
      sku: str(row.merchantSku),
      merchantSku: str(row.merchantSku),
      stockCode: str(row.merchantSku),
      quantity: Number(row.quantity ?? 1),
      variantAttributes: (row.variantAttributes ?? []) as unknown,
    })
    grouped.set(key, bucket)
  }

  // 3/3: HEDEFLİ katalog — tüm paketlerin kesin kimlikleri TEK sorguda.
  const allItems = Array.from(grouped.values()).flat()
  const barcodes = uniqueNonEmpty(allItems.map((item) => item.barcode))
  const merchantSkus = uniqueNonEmpty(allItems.map((item) => item.merchantSku))
  const conditions = []
  if (barcodes.length > 0) {
    conditions.push(inArray(productVariants.barcode, barcodes))
  }
  if (merchantSkus.length > 0) {
    conditions.push(inArray(productVariants.merchantSku, merchantSkus))
    conditions.push(inArray(productVariants.stockCode, merchantSkus))
  }
  const variantRows =
    conditions.length === 0
      ? []
      : await db
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.organizationId, organizationId),
              eq(productVariants.archived, false),
              conditions.length === 1 ? conditions[0] : or(...conditions),
            ),
          )

  for (const [key, items] of grouped) {
    const marketplace = key.slice(0, key.indexOf(KEY_SEPARATOR))
    const products = (variantRows as Array<Record<string, unknown>>).map(
      (row) => ({
        id: str(row.id),
        marketplace,
        productName: '',
        sku: str(row.merchantSku),
        stockCode: str(row.stockCode),
        barcode: str(row.barcode),
        color: str(row.color),
        size: str(row.size),
        stock: 0,
        price: 0,
        source: 'real',
        updatedAt: '',
      }),
    )
    result.set(
      key,
      resolveSuratProductLineItems(
        { marketplace, items } as never,
        products as never,
      ),
    )
  }
  return result
}
