// SUNUCU TARAFI SEKME SINIFLANDIRMASI VE SAYAÇLARI.
//
// ÜRETİM HATASI (ölçüldü): OrdersPage TÜM sipariş kütlesini indirip 6 hızlı
// sekme + görünür liste için 7 kez tam tarama yapıyordu (1k'da 682 ms,
// 10k'da 12,7 s ana iş parçacığı donması).
//
// SEMANTİK GARANTİSİ — İKİNCİ BİR UYGULAMA YAZILMADI:
// bu modül frontend'in kullandığı KANONİK `classifyOrderForTabs` /
// `orderMatchesQuickTab` fonksiyonlarını AYNEN import eder. Sekme kuralları
// tek kaynaktadır; sunucu ile istemci ayrışamaz çünkü aynı koddur.
//
// KAPSAM: organizasyon + aktif pazaryeri hesabı her sorguda zorunludur
// (tenant izolasyonu gevşetilmez). Provider/marketplace çağrısı YAPILMAZ.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import { findShipmentsByPackageIds } from '../shipments/shipmentRepository.ts'
import { findLatestOperationsByPackageIds } from '../shipments/shipmentOperationRepository.ts'
import { SURAT_PERSISTENCE_PROVIDER } from '../shipments/suratProvider.ts'
import {
  attachShipmentFromLoaded,
  listOrders,
} from './orderPersistenceService.ts'
import {
  buildOrderWhere,
  findLinesForOrders,
  resolvePageSize,
  type OrderFilters,
} from './orderRepository.ts'
import { rowToOrder } from './orderMapper.ts'
import {
  classifyOrderForTabs,
  orderMatchesQuickTab,
} from '../../src/utils/orderClassification.ts'
import { applyExternalProcessingState } from '../../src/utils/externalProcessing.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * OrdersPage'in gösterdiği hızlı sekmeler. SIRA ve KÜME frontend'deki
 * `quickTabs` ile birebir aynıdır; sözleşme testle kilitlenir.
 */
export const QUICK_TAB_KEYS = [
  'newOrders',
  'labelStage',
  'handedToCargo',
  'delivered',
  'cancelReturn',
  'all',
] as const

export type QuickTabKey = (typeof QUICK_TAB_KEYS)[number]

/** Sekme sınıflandırması için gereken EN DAR sipariş izdüşümü. */
const PROJECTION_COLUMNS = {
  id: orders.id,
  marketplace: orders.marketplace,
  packageId: orders.packageId,
  orderNumber: orders.orderNumber,
  marketplaceStatus: orders.marketplaceStatus,
  operationStatus: orders.operationStatus,
  archivedAt: orders.archivedAt,
  orderDate: orders.orderDate,
}

export interface TabProjection {
  /** Sıralı sipariş kimlikleri (istenen sekme uygulanmış hâlde). */
  orderIds: string[]
  /** Sekme başına sayaç — sekme filtresi UYGULANMADAN önceki kümeden. */
  counts: Record<QuickTabKey, number>
  /** Sekme filtresi uygulanmadan önceki toplam (SQL filtreleri dahil). */
  scannedCount: number
}

/**
 * SQL ile daraltılabilen filtreleri uygular, kalan kümeyi kanonik
 * sınıflandırıcıdan geçirir ve hem sekme sayaçlarını hem de istenen sekmenin
 * sıralı kimlik listesini üretir.
 *
 * MALİYET: hesap kapsamındaki satır sayısı kadar DAR bir tarama (şifre çözme
 * YOK) + gönderisi olan paketler için sınırlı bir toplu okuma. Üretimde
 * ~15.000 sipariş karşısında yalnız ~589 gönderi vardır.
 */
export async function loadTabProjection(
  db: Db,
  organizationId: string,
  filters: OrderFilters & { tab?: string } = {},
  marketplaceAccountId?: string | null,
  externalProcessing?: { entries?: Record<string, unknown> } | null,
): Promise<TabProjection> {
  const where = buildOrderWhere(organizationId, filters, marketplaceAccountId)
  const orderBy =
    filters.sort === 'orderDateAsc'
      ? [asc(orders.orderDate), asc(orders.id)]
      : [desc(orders.orderDate), desc(orders.id)]
  const rows = (await db
    .select(PROJECTION_COLUMNS)
    .from(orders)
    .where(where)
    .orderBy(...orderBy)) as Record<string, unknown>[]

  // Gönderi/operasyon YALNIZ paketi olan siparişler için, TOPLU okunur.
  const byMarketplace = new Map<string, string[]>()
  for (const row of rows) {
    const packageId = String(row.packageId ?? '')
    if (!packageId) continue
    const marketplace = String(row.marketplace ?? '')
    if (!byMarketplace.has(marketplace)) byMarketplace.set(marketplace, [])
    byMarketplace.get(marketplace)!.push(packageId)
  }
  const shipmentsByKey = new Map<string, Record<string, unknown>>()
  for (const [marketplace, packageIds] of byMarketplace) {
    const loaded = await findShipmentsByPackageIds(
      db,
      organizationId,
      marketplace,
      packageIds,
      SURAT_PERSISTENCE_PROVIDER,
    )
    for (const [packageId, shipment] of loaded) {
      shipmentsByKey.set(`${marketplace}::${packageId}`, shipment)
    }
  }
  const localCreatePackageIds: string[] = []
  for (const shipment of shipmentsByKey.values()) {
    if (shipment.source === 'local_create') {
      localCreatePackageIds.push(String(shipment.packageId))
    }
  }
  const operationsByPackage = await findLatestOperationsByPackageIds(
    db,
    organizationId,
    localCreatePackageIds,
  )

  // Sınıflandırıcının okuduğu alanları taşıyan minimal görünüm nesnesi.
  let views = rows.map((row) => {
    const packageId = String(row.packageId ?? '')
    const base: Record<string, unknown> = {
      id: String(row.id),
      marketplace: String(row.marketplace ?? ''),
      packageId,
      shipmentPackageId: packageId,
      externalOrderId: packageId,
      orderNumber: String(row.orderNumber ?? ''),
      marketplaceStatus: String(row.marketplaceStatus ?? ''),
      operationStatus: String(row.operationStatus ?? ''),
      archivedAt: row.archivedAt
        ? new Date(String(row.archivedAt)).toISOString()
        : undefined,
      items: [],
    }
    const shipment = shipmentsByKey.get(
      `${String(row.marketplace ?? '')}::${packageId}`,
    )
    if (!shipment) return base
    const operation =
      shipment.source === 'local_create'
        ? operationsByPackage.get(packageId)
        : null
    return attachShipmentFromLoaded(base, shipment, operation)
  })
  // YEREL harici-işlem arşivi istemcideki ile AYNI saf yardımcıyla damgalanır.
  if (externalProcessing) {
    views = applyExternalProcessingState(
      views as never,
      externalProcessing as never,
    ) as never
  }

  const counts = Object.fromEntries(
    QUICK_TAB_KEYS.map((key) => [key, 0]),
  ) as Record<QuickTabKey, number>
  const orderIds: string[] = []
  const requestedTab = String(filters.tab ?? 'all')
  for (const view of views) {
    const classification = classifyOrderForTabs(view as never)
    for (const key of QUICK_TAB_KEYS) {
      if (orderMatchesQuickTab(classification, key)) counts[key] += 1
    }
    if (orderMatchesQuickTab(classification, requestedTab as never)) {
      orderIds.push(String((view as Record<string, unknown>).id))
    }
  }
  return { orderIds, counts, scannedCount: rows.length }
}

/**
 * Sekme filtreli sipariş sayfası için kimlik dilimi. Sıralama izdüşümde
 * uygulandığı için dilimleme SIRAYI KORUR.
 */
export function sliceOrderIds(
  orderIds: string[],
  page: number,
  pageSize: number,
): string[] {
  const start = Math.max(0, (page - 1) * pageSize)
  return orderIds.slice(start, start + pageSize)
}

/**
 * SEKME FİLTRELİ SUNUCU TARAFI SAYFA.
 *
 * `tab` yok veya 'all' ise HIZLI YOL: doğrudan SQL LIMIT/OFFSET (`listOrders`).
 * Aksi hâlde sekme sınıflandırması gerektiği için izdüşüm alınır, istenen
 * sayfanın kimlikleri dilimlenir ve YALNIZ o kimlikler için tam satırlar
 * okunur. İstemciye hiçbir durumda sayfa boyutundan fazla sipariş dönmez.
 */
export async function listOrdersForTab(
  db: Db,
  organizationId: string,
  filters: OrderFilters & { tab?: string } = {},
  marketplaceAccountId?: string | null,
  externalProcessing?: { entries?: Record<string, unknown> } | null,
): Promise<{
  orders: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}> {
  const tab = String(filters.tab ?? 'all')
  if (!filters.tab || tab === 'all') {
    return listOrders(db, organizationId, filters, marketplaceAccountId)
  }
  const pageSize = resolvePageSize(filters.pageSize)
  const page = Math.max(1, Math.trunc(Number(filters.page ?? 1)) || 1)
  const projection = await loadTabProjection(
    db,
    organizationId,
    filters,
    marketplaceAccountId,
    externalProcessing,
  )
  const pageIds = sliceOrderIds(projection.orderIds, page, pageSize)
  const orderRows = await findOrdersByIds(
    db,
    organizationId,
    pageIds,
    marketplaceAccountId,
  )
  const lineRows = await findLinesForOrders(
    db,
    organizationId,
    orderRows.map((row) => String(row.id)),
  )
  const linesByOrder = new Map<string, Record<string, unknown>[]>()
  for (const line of lineRows) {
    const key = String(line.orderId)
    if (!linesByOrder.has(key)) linesByOrder.set(key, [])
    linesByOrder.get(key)!.push(line)
  }
  const baseOrders = orderRows.map((row) =>
    rowToOrder(row, linesByOrder.get(String(row.id)) ?? []),
  )
  const viewModels = await attachPageShipments(db, organizationId, baseOrders)
  return {
    orders: viewModels,
    total: projection.orderIds.length,
    page,
    pageSize,
  }
}

/** Sayfa için gönderi/operasyon TOPLU birleştirme (N+1 yok). */
async function attachPageShipments(
  db: Db,
  organizationId: string,
  pageOrders: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (pageOrders.length === 0) return pageOrders
  const byMarketplace = new Map<string, string[]>()
  for (const order of pageOrders) {
    const packageId = String(order.packageId ?? '')
    if (!packageId) continue
    const marketplace = String(order.marketplace ?? '')
    if (!byMarketplace.has(marketplace)) byMarketplace.set(marketplace, [])
    byMarketplace.get(marketplace)!.push(packageId)
  }
  const shipmentsByKey = new Map<string, Record<string, unknown>>()
  for (const [marketplace, packageIds] of byMarketplace) {
    const loaded = await findShipmentsByPackageIds(
      db,
      organizationId,
      marketplace,
      packageIds,
      SURAT_PERSISTENCE_PROVIDER,
    )
    for (const [packageId, shipment] of loaded) {
      shipmentsByKey.set(`${marketplace}::${packageId}`, shipment)
    }
  }
  const localCreatePackageIds: string[] = []
  for (const shipment of shipmentsByKey.values()) {
    if (shipment.source === 'local_create') {
      localCreatePackageIds.push(String(shipment.packageId))
    }
  }
  const operationsByPackage = await findLatestOperationsByPackageIds(
    db,
    organizationId,
    localCreatePackageIds,
  )
  return pageOrders.map((order) => {
    const packageId = String(order.packageId ?? '')
    if (!packageId) return order
    const shipment = shipmentsByKey.get(
      `${String(order.marketplace ?? '')}::${packageId}`,
    )
    if (!shipment) return order
    const operation =
      shipment.source === 'local_create'
        ? operationsByPackage.get(packageId)
        : null
    return attachShipmentFromLoaded(order, shipment, operation)
  })
}

/** Verilen kimlikler için sipariş satırlarını getirir (kapsam zorunlu). */
export async function findOrdersByIds(
  db: Db,
  organizationId: string,
  orderIds: string[],
  marketplaceAccountId?: string | null,
): Promise<Record<string, unknown>[]> {
  if (orderIds.length === 0) return []
  const clauses = [
    eq(orders.organizationId, organizationId),
    inArray(orders.id, orderIds),
  ]
  if (marketplaceAccountId !== undefined) {
    clauses.push(
      marketplaceAccountId === null
        ? sql`${orders.marketplaceAccountId} is null`
        : eq(orders.marketplaceAccountId, marketplaceAccountId),
    )
  }
  const rows = (await db
    .select()
    .from(orders)
    .where(and(...clauses))) as Record<string, unknown>[]
  // Girdi SIRASI korunur (izdüşümdeki sıralama otoritedir).
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  return orderIds
    .map((id) => byId.get(id))
    .filter((row): row is Record<string, unknown> => Boolean(row))
}
