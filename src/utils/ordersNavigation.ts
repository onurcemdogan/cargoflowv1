import type { MarketplaceName } from '../types/cargoflow'

export type OrdersDatePreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'last3'
  | 'last7'
  | 'last30'
  | 'custom'

export type OrdersActionFilter =
  | 'all'
  | 'createEligible'
  | 'printEligible'
  | 'critical'

export interface OrdersNavigationFilters {
  marketplace?: 'all' | MarketplaceName
  city?: string
  datePreset?: OrdersDatePreset
  customStartDate?: string
  customEndDate?: string
  actionFilter?: OrdersActionFilter
}
