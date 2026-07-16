import type {
  ApiDataSource,
  CargoOrder,
  CargoProduct,
  IntegrationTestResult,
  MarketplaceStatus,
  TrendyolOrderDebug,
  TrendyolIntegrationConfig,
} from '../../types/cargoflow'

export interface FetchOrdersInput {
  credentials: TrendyolIntegrationConfig
  startDate?: Date
  endDate?: Date
  page?: number
  size?: number
  status?: MarketplaceStatus
  statuses?: MarketplaceStatus[]
  orderNumber?: string
}

export interface FetchOrdersResult {
  orders: CargoOrder[]
  page: number
  size: number
  totalPages: number
  hasNextPage: boolean
  source: ApiDataSource
  message: string
  debug?: TrendyolOrderDebug
}

export interface FetchProductsResult {
  products: CargoProduct[]
  source: ApiDataSource
  message: string
}

export interface MarketplaceProvider {
  testConnection(
    credentials: TrendyolIntegrationConfig,
  ): Promise<IntegrationTestResult>
  fetchOrders(input: FetchOrdersInput): Promise<FetchOrdersResult>
  fetchProducts(
    credentials: TrendyolIntegrationConfig,
  ): Promise<FetchProductsResult>
  fetchOrderById(externalOrderId: string): Promise<CargoOrder | null>
  updateOrderStatus(
    externalOrderId: string,
    status: MarketplaceStatus,
  ): Promise<void>
}
