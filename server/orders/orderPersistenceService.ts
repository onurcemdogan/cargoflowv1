// Auth modu sipariş persistence servisi. Sync sonucu organization bazında
// PostgreSQL'e yazar; okuma sırasında shipment linkage'i (aynı org + packageId)
// order view-model'ine bağlar. Partial sync sipariş SİLMEZ/ARŞİVLEMEZ.
import { randomUUID } from 'node:crypto'
import {
  archiveMissingOrders,
  countOrdersByOrganization,
  findLinesForOrders,
  findOrderById,
  findOrders,
  upsertMarketplaceOrders,
  type OrderFilters,
} from './orderRepository.ts'
import { rowToOrder } from './orderMapper.ts'
import { findShipment } from '../shipments/shipmentRepository.ts'
import { findLatestOperationByPackage } from '../shipments/shipmentOperationRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface SyncPersistResult {
  complete: boolean
  fetchedCount: number
  persistedCount: number
  updatedCount: number
  insertedCount: number
  failedCount: number
  archivedCount: number
  syncBatchId: string
}

// Başarılı ve TAM sync (complete=true) reconcile uygular (arşivleme). Partial/
// başarısız sync yalnız gördüğü siparişleri upsert eder; SİLME/ARŞİVLEME yok.
export async function persistSyncResult(
  db: Db,
  organizationId: string,
  normalizedOrders: Record<string, unknown>[],
  options: { complete: boolean; fetchedCount?: number },
): Promise<SyncPersistResult> {
  const result = await upsertMarketplaceOrders(db, organizationId, normalizedOrders)
  let archivedCount = 0
  if (options.complete) {
    archivedCount = await archiveMissingOrders(db, organizationId, result.packageIds)
  }
  return {
    complete: options.complete,
    fetchedCount: options.fetchedCount ?? normalizedOrders.length,
    persistedCount: result.persisted,
    updatedCount: result.updated,
    insertedCount: result.inserted,
    failedCount: result.failed,
    archivedCount,
    syncBatchId: randomUUID(),
  }
}

// Order view-model'ine shipment linkage ekler. Başka organization shipment'ı
// ASLA bağlanmaz (findShipment org-scoped). local_create → tam lifecycle
// (operation payload.shipment/label); marketplace_external → salt okunur.
async function attachShipment(
  db: Db,
  organizationId: string,
  order: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const packageId = String(order.packageId ?? '')
  if (!packageId) return order
  const shipment = await findShipment(db, organizationId, String(order.marketplace), packageId, 'surat')
  if (!shipment) return order
  if (shipment.source === 'local_create') {
    const operation = await findLatestOperationByPackage(db, organizationId, packageId)
    const payload = operation?.payload as Record<string, unknown> | undefined
    return {
      ...order,
      shipment: payload?.shipment ?? {
        trackingNumber: shipment.trackingNumber,
        barcode: shipment.barcode,
      },
      label: payload?.label,
      labelStatus: payload?.labelStatus,
      shipmentStatus: payload?.shipmentStatus,
      suratVerificationStatus: payload?.suratVerificationStatus,
    }
  }
  // marketplace_external: salt okunur shipment göstergesi.
  return {
    ...order,
    externalShipment: {
      source: 'marketplace_external',
      trackingNumber: shipment.trackingNumber,
      senderNumber: shipment.senderNumber,
      status: shipment.status,
    },
  }
}

export async function listOrders(
  db: Db,
  organizationId: string,
  filters: OrderFilters = {},
): Promise<{
  orders: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}> {
  const { orderRows, total, page, pageSize } = await findOrders(
    db,
    organizationId,
    filters,
  )
  const orderIds = orderRows.map((row) => String(row.id))
  const lineRows = await findLinesForOrders(db, organizationId, orderIds)
  const linesByOrder = new Map<string, Record<string, unknown>[]>()
  for (const line of lineRows) {
    const key = String(line.orderId)
    if (!linesByOrder.has(key)) linesByOrder.set(key, [])
    linesByOrder.get(key)!.push(line)
  }
  const viewModels = []
  for (const row of orderRows) {
    const base = rowToOrder(row, linesByOrder.get(String(row.id)) ?? [])
    viewModels.push(await attachShipment(db, organizationId, base))
  }
  return { orders: viewModels, total, page, pageSize }
}

export async function getOrder(
  db: Db,
  organizationId: string,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const row = await findOrderById(db, organizationId, orderId)
  if (!row) return null
  const lineRows = await findLinesForOrders(db, organizationId, [String(row.id)])
  const base = rowToOrder(row, lineRows)
  return attachShipment(db, organizationId, base)
}

export { countOrdersByOrganization }
