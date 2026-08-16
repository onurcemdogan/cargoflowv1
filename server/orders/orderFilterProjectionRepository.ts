// KANONİK FİLTRE PROJEKSİYONU — TEK YAZMA SINIRI (B2-1b-B1).
//
// "Projeksiyon NASIL yazılır" sorusu YALNIZ burada çözülür. Sipariş yazan
// modüller yalnız ETKİLENEN SİPARİŞ KİMLİKLERİNİ bildirir; token türetimi
// saf builder'da (buildOrderFilterProjection), kalıcılık burada olur.
//
// TASARIM SINIRI (bilinçli): bu yenileyici YALNIZ `orders` tablosundaki
// ilişkisel kolonlardan okur. Şifreli payload AÇILMAZ — sırf projeksiyon
// üretmek için her sipariş güncellemesinde decrypt zinciri kurmayız.
// Bu yüzden shipment kaynaklı arama alanları (ozelKargoTakipNo,
// trendyolCargoTrackingNumber ve kargo fişi değerleri) BU yolda üretilmez;
// onlar shipment yazma sınırının/backfill'in sorumluluğudur.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { orderFilterProjection, orders } from '../db/schema.ts'
import {
  buildOrderFilterProjection,
  ORDER_FILTER_PROJECTION_VERSION,
} from './orderFilterProjectionBuilder.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Tek sipariş satırından projeksiyon satırı üretir (ilişkisel kaynaklar). */
function projectionValuesFromOrderRow(row: Record<string, unknown>) {
  const projection = buildOrderFilterProjection({
    organizationId: String(row.organizationId),
    orderId: String(row.id),
    marketplace: row.marketplace,
    operationStatus: row.operationStatus,
    marketplaceStatus: row.marketplaceStatus,
    shippingCity: row.shippingCity,
    shippingDistrict: row.shippingDistrict,
    orderDate: row.orderDate,
    customerName: [row.customerFirstName, row.customerLastName]
      .filter(Boolean)
      .join(' '),
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail,
    orderNumber: row.orderNumber,
    externalOrderId: row.externalOrderId,
    cargoTrackingNumber: row.cargoTrackingNumber,
  })
  return {
    organizationId: projection.organizationId,
    orderId: projection.orderId,
    marketplaceToken: projection.marketplaceToken,
    operationStatusToken: projection.operationStatusToken,
    marketplaceStatus: projection.marketplaceStatus,
    shippingCityToken: projection.shippingCityToken,
    shippingDistrictToken: projection.shippingDistrictToken,
    customerSearchToken: projection.customerSearchToken,
    orderNumberSearchToken: projection.orderNumberSearchToken,
    cargoSlipSearchToken: projection.cargoSlipSearchToken,
    orderDate: row.orderDate ?? null,
    projectionVersion: ORDER_FILTER_PROJECTION_VERSION,
    updatedAt: new Date(),
  }
}

/**
 * ETKİLENEN SİPARİŞLERİN PROJEKSİYONUNU YENİLER.
 *
 * IDEMPOTENT: aynı girdi iki kez gelirse sonuç aynıdır (ON CONFLICT
 * DO UPDATE). TENANT GÜVENLİĞİ: hem okuma hem yazma `organizationId` ile
 * kapsanır; başka tenant'ın satırı okunamaz/yazılamaz.
 *
 * Sipariş kimliği verilmezse hiçbir şey yapmaz (no-op).
 */
export async function refreshOrderFilterProjections(
  db: Db,
  organizationId: string,
  orderIds: readonly string[],
): Promise<{ refreshed: number }> {
  const ids = [...new Set(orderIds.map((id) => String(id)).filter(Boolean))]
  if (ids.length === 0) return { refreshed: 0 }

  let refreshed = 0
  // Parametre tavanına takılmamak için parçalı işlenir.
  for (let index = 0; index < ids.length; index += 500) {
    const slice = ids.slice(index, index + 500)
    const rows = (await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, organizationId),
          inArray(orders.id, slice),
        ),
      )) as Record<string, unknown>[]
    if (rows.length === 0) continue
    const values = rows.map(projectionValuesFromOrderRow)
    await db
      .insert(orderFilterProjection)
      .values(values)
      .onConflictDoUpdate({
        target: [
          orderFilterProjection.organizationId,
          orderFilterProjection.orderId,
        ],
        set: {
          marketplaceToken: sqlExcluded('marketplace_token'),
          operationStatusToken: sqlExcluded('operation_status_token'),
          marketplaceStatus: sqlExcluded('marketplace_status'),
          shippingCityToken: sqlExcluded('shipping_city_token'),
          shippingDistrictToken: sqlExcluded('shipping_district_token'),
          customerSearchToken: sqlExcluded('customer_search_token'),
          orderNumberSearchToken: sqlExcluded('order_number_search_token'),
          cargoSlipSearchToken: sqlExcluded('cargo_slip_search_token'),
          orderDate: sqlExcluded('order_date'),
          projectionVersion: sqlExcluded('projection_version'),
          updatedAt: new Date(),
        },
      })
    refreshed += rows.length
  }
  return { refreshed }
}

/** `excluded.<col>` — ON CONFLICT DO UPDATE için gelen değeri yazar. */
function sqlExcluded(column: string) {
  // Sütun adı sabit literaldir; kullanıcı girdisi DEĞİLDİR.
  return sql.raw(`excluded.${column}`)
}
