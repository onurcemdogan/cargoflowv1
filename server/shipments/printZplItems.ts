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
