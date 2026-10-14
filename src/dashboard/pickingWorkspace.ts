import {
  buildPickingLists,
  type DashboardPickingProduct,
} from './dashboardViewModel.ts'
import type { CargoOrder, CargoProduct } from '../types/cargoflow.ts'

export interface PickingQuery {
  search?: string
  stage?: string
  page?: number
}

export interface PickingWorkspaceResult {
  products: DashboardPickingProduct[]
  totalFamilyCount: number
  totalQuantity: number
  orderCount: number
  filteredFamilyCount: number
  page: number
  pageCount: number
  stages: Array<{ key: string; label: string }>
}

export const PICKING_PAGE_SIZE = 30

/** Same eligibility, dedupe and family grouping as Dashboard; filters are presentation only. */
export function buildPickingWorkspace(
  orders: CargoOrder[],
  products: CargoProduct[],
  query: PickingQuery = {},
): PickingWorkspaceResult {
  const picking = buildPickingLists(orders, products, Infinity)
  const stages = new Map<string, string>()
  for (const product of picking.products) {
    for (const stage of product.stageBreakdown)
      stages.set(stage.stage, stage.label)
  }
  const search = (query.search ?? '').trim().toLocaleLowerCase('tr-TR')
  const filtered = picking.products.filter((product) => {
    if (
      query.stage &&
      !product.stageBreakdown.some((entry) => entry.stage === query.stage)
    )
      return false
    return (
      !search ||
      [
        product.productName,
        product.color,
        product.sku,
        product.barcode,
        ...product.variants.map((variant) => variant.size),
        ...product.variants.flatMap((variant) => [
          ...(variant.skus ?? []),
          ...(variant.barcodes ?? []),
        ]),
        ...product.orders.map((order) => order.displayOrderNumber),
      ].some((value) => value.toLocaleLowerCase('tr-TR').includes(search))
    )
  })
  const pageCount = Math.max(1, Math.ceil(filtered.length / PICKING_PAGE_SIZE))
  const page = Math.min(
    pageCount - 1,
    Math.max(0, Math.floor(Number(query.page) || 0)),
  )
  return {
    products: filtered.slice(
      page * PICKING_PAGE_SIZE,
      (page + 1) * PICKING_PAGE_SIZE,
    ),
    totalFamilyCount: picking.totalFamilyCount,
    totalQuantity: picking.totalQuantity,
    orderCount: picking.orderCount,
    filteredFamilyCount: filtered.length,
    page,
    pageCount,
    stages: Array.from(stages, ([key, label]) => ({ key, label })),
  }
}
