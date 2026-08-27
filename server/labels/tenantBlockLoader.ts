// KİRACI BLOKLARININ SUNUCU TARAFI ÇÖZÜMÜ.
//
// Kodsuz düzenleyicide açılan bloklar, baskı ZPL'i üretilirken BURADA
// gerçek sipariş verisiyle doldurulur. Değer çözümü istemciyle AYNI saf
// fonksiyondan (`resolveTenantBlockValues`) geçer; önizleme ile baskı
// ayrışamaz.
//
// ═══ VARYANT İÇİN İKİNCİ BİR ÇÖZÜCÜ YOK ══════════════════════════════════
// Renk/beden, ürün satırının kullandığı KANONİK zincirden gelir
// (`loadPrintLineItems` → `resolveSuratProductLineItems`): yapısal alan →
// variantAttributes → organizasyon kapsamlı katalog varyantı → çapalı
// başlık ayrıştırması.
//
// Burada elle `variantAttributes` okumak bir kusur ÜRETMİŞTİ: nitelikler
// `{name, value}` ile saklanırken kod `{attributeName, attributeValue}`
// arıyordu ve "Varyant" bloğu sunucuda HER ZAMAN boş kalıyordu. İkinci bir
// çözücü, birincisiyle sessizce ayrışır.
//
// TAŞIYICIYA ÇIKILMAZ: yalnız kendi veritabanımız okunur.

import { and, eq } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import {
  resolveProductLineParts,
  resolveTenantBlocks,
  resolveTenantBlockValues,
  type TenantBlock,
} from '../../src/utils/labelTenantBlocks.ts'
import {
  DEFAULT_PRODUCT_LINE_PARTS,
  type ProductLineParts,
} from '../../src/utils/suratZplProductLine.ts'
import { loadPrintLineItems } from '../shipments/printZplItems.ts'
import { loadLabelTemplate } from './labelTemplateRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

export interface TenantLabelConfig {
  readonly blocks: TenantBlock[]
  readonly productLineParts: ProductLineParts
}

/**
 * Bu paket için basılacak kiracı bloklarını ve ürün satırı parçalarını
 * döndürür.
 *
 * Şablon yoksa boş blok listesi ve BUGÜNKÜ parçalar döner; baskı yolu
 * eskisiyle birebir aynı çıktıyı üretir.
 */
export async function loadTenantLabelBlocks(
  db: Db,
  organizationId: string,
  marketplace: string,
  packageId: string,
): Promise<TenantLabelConfig> {
  const empty: TenantLabelConfig = {
    blocks: [],
    productLineParts: DEFAULT_PRODUCT_LINE_PARTS,
  }
  const template = await loadLabelTemplate(db, organizationId)
  if (!template || template.fields.length === 0) return empty
  const productLineParts = resolveProductLineParts({
    fields: template.fields as never,
  })

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
  if (!orderRow) return { blocks: [], productLineParts }

  // Ürün satırının KANONİK çözümü — renk/beden/SKU burada zaten çözülür.
  const items = await loadPrintLineItems(db, organizationId, marketplace, packageId)
  const totalQuantity = items.reduce(
    (total, item) => total + (Number(item.quantity) || 0),
    0,
  )

  const orderedAt =
    orderRow.orderDate instanceof Date
      ? orderRow.orderDate.toISOString()
      : str(orderRow.orderDate)

  const values = resolveTenantBlockValues(
    {
      orderNumber: str(orderRow.orderNumber),
      packageId: str(orderRow.packageId),
      marketplace: str(orderRow.marketplace),
      customerFirstName: str(orderRow.customerFirstName),
      customerLastName: str(orderRow.customerLastName),
      orderDate: orderedAt,
      createdAt: orderedAt,
    } as never,
    {
      items: items as never,
      totalQuantity,
      packageId: str(orderRow.packageId),
      marketplaceName: str(orderRow.marketplace),
    } as never,
  )
  return {
    blocks: resolveTenantBlocks({ fields: template.fields as never }, values),
    productLineParts,
  }
}
