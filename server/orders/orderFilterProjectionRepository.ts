// KANONİK FİLTRE PROJEKSİYONU — TEK YAZMA SINIRI (B2-1b-B1).
//
// "Projeksiyon NASIL yazılır" sorusu YALNIZ burada çözülür.
//
// PARÇA SAHİPLİĞİ: her yaşam döngüsü YALNIZ kendi kolonlarını SET eder.
//   ORDER      → marketplace/status/şehir/ilçe/müşteri/orderNumber(order)/
//                cargoSlip(order)/orderDate
//   SHIPMENT   → orderNumber(shipment), cargoSlip(shipment)
//   OPERATION  → cargoSlip(operation)
// Böylece eşzamanlı yazımlar birbirinin parçasını EZEMEZ (lost-update
// yapısal olarak çözülür) ve sipariş yazımı shipment payload'ı AÇMAZ.
//
// SINIR: bu modül decrypt/ağ YAPMAZ. Şifreli kaynaklardan gelen değerler
// çağıran tarafından ÇÖZÜLMÜŞ olarak verilir (write-time resolved values).
import { and, eq, inArray, sql } from 'drizzle-orm'
import { orderFilterProjection, orders } from '../db/schema.ts'
import {
  buildOperationProjectionFragment,
  buildOrderProjectionFragment,
  buildShipmentProjectionFragment,
  ORDER_FILTER_PROJECTION_VERSION,
  type OperationProjectionFragmentInput,
  type ShipmentProjectionFragmentInput,
} from './orderFilterProjectionBuilder.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Sipariş satırından ORDER parçasını üretir (yalnız ilişkisel kolonlar). */
function orderFragmentFromRow(row: Record<string, unknown>) {
  return buildOrderProjectionFragment({
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
}

/** `excluded.<col>` — çakışmada gelen değeri yazar (yalnız sabit literal). */
function excluded(column: string) {
  return sql.raw(`excluded.${column}`)
}

/**
 * ORDER PARÇASI — etkilenen siparişleri `orders` satırından yeniler.
 *
 * DECRYPT YOK: yalnız ilişkisel kolonlar okunur. Shipment/operation
 * kolonlarına DOKUNULMAZ.
 * IDEMPOTENT · TENANT KAPSAMLI.
 */
export async function refreshOrderProjectionFragment(
  db: Db,
  organizationId: string,
  orderIds: readonly string[],
): Promise<{ refreshed: number }> {
  const ids = [...new Set(orderIds.map((id) => String(id)).filter(Boolean))]
  if (ids.length === 0) return { refreshed: 0 }
  let refreshed = 0
  for (let index = 0; index < ids.length; index += 500) {
    const slice = ids.slice(index, index + 500)
    const rows = (await db
      .select()
      .from(orders)
      .where(
        and(eq(orders.organizationId, organizationId), inArray(orders.id, slice)),
      )) as Record<string, unknown>[]
    if (rows.length === 0) continue
    const values = rows.map((row) => ({
      organizationId,
      orderId: String(row.id),
      ...orderFragmentFromRow(row),
      updatedAt: new Date(),
    }))
    await db
      .insert(orderFilterProjection)
      .values(values)
      .onConflictDoUpdate({
        target: [
          orderFilterProjection.organizationId,
          orderFilterProjection.orderId,
        ],
        // YALNIZ ORDER kolonları — shipment/operation parçaları KORUNUR.
        set: {
          marketplaceToken: excluded('marketplace_token'),
          operationStatusToken: excluded('operation_status_token'),
          marketplaceStatus: excluded('marketplace_status'),
          shippingCityToken: excluded('shipping_city_token'),
          shippingDistrictToken: excluded('shipping_district_token'),
          customerSearchToken: excluded('customer_search_token'),
          orderNumberOrderToken: excluded('order_number_order_token'),
          cargoSlipOrderToken: excluded('cargo_slip_order_token'),
          orderDate: excluded('order_date'),
          projectionVersion: excluded('projection_version'),
          updatedAt: new Date(),
        },
      })
    refreshed += rows.length
  }
  return { refreshed }
}

/**
 * SHIPMENT PARÇASI — çağıran ÇÖZÜLMÜŞ değerleri verir.
 * ORDER/OPERATION kolonlarına DOKUNULMAZ; decrypt/ağ YOK.
 */
export async function updateShipmentProjectionFragment(
  db: Db,
  organizationId: string,
  orderId: string,
  input: ShipmentProjectionFragmentInput,
): Promise<{ updated: boolean }> {
  if (!organizationId || !orderId) return { updated: false }
  const fragment = buildShipmentProjectionFragment(input)
  await db
    .insert(orderFilterProjection)
    .values({
      organizationId,
      orderId: String(orderId),
      ...fragment,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        orderFilterProjection.organizationId,
        orderFilterProjection.orderId,
      ],
      set: {
        orderNumberShipmentToken: excluded('order_number_shipment_token'),
        cargoSlipShipmentToken: excluded('cargo_slip_shipment_token'),
        updatedAt: new Date(),
      },
    })
  return { updated: true }
}

/**
 * OPERATION PARÇASI — create/verification sonucu ÇÖZÜLMÜŞ değerlerden.
 * ORDER/SHIPMENT kolonlarına DOKUNULMAZ; decrypt/ağ YOK.
 */
export async function updateOperationProjectionFragment(
  db: Db,
  organizationId: string,
  orderId: string,
  input: OperationProjectionFragmentInput,
): Promise<{ updated: boolean }> {
  if (!organizationId || !orderId) return { updated: false }
  const fragment = buildOperationProjectionFragment(input)
  await db
    .insert(orderFilterProjection)
    .values({
      organizationId,
      orderId: String(orderId),
      ...fragment,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        orderFilterProjection.organizationId,
        orderFilterProjection.orderId,
      ],
      set: {
        cargoSlipOperationToken: excluded('cargo_slip_operation_token'),
        updatedAt: new Date(),
      },
    })
  return { updated: true }
}

export { ORDER_FILTER_PROJECTION_VERSION }
