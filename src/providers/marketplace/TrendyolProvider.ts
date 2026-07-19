import type {
  CargoOrder,
  IntegrationTestResult,
  MarketplaceStatus,
  TrendyolIntegrationConfig,
} from '../../types/cargoflow'
import { apiDebugService } from '../../services/apiDebugService'
import type {
  FetchOrdersInput,
  FetchOrdersResult,
  FetchProductsResult,
  MarketplaceProvider,
} from './MarketplaceProvider'

const MANUAL_UPDATE_STATUSES: MarketplaceStatus[] = ['Created', 'Picking', 'Invoiced']

export class TrendyolProvider implements MarketplaceProvider {
  async testConnection(
    credentials: TrendyolIntegrationConfig,
  ): Promise<IntegrationTestResult> {
    const startedAt = performance.now()
    try {
      const response = await fetch('/api/integrations/trendyol/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials }),
      })
      const data = (await response.json()) as IntegrationTestResult
      appendTrendyolDebug({
        operation: 'Bağlantı Testi',
        credentials,
        data,
        responseStatus: response.status,
        durationMs: performance.now() - startedAt,
      })
      return data
    } catch (error) {
      appendTrendyolDebug({
        operation: 'Bağlantı Testi',
        credentials,
        data: { error: error instanceof Error ? error.message : 'Ağ hatası' },
        responseStatus: 0,
        durationMs: performance.now() - startedAt,
      })
      return {
        provider: 'trendyol',
        ok: false,
        source: 'real',
        message:
          error instanceof Error
            ? `API proxy erişilemedi: ${error.message}`
            : 'API proxy erişilemedi.',
        checkedAt: new Date().toISOString(),
      }
    }
  }

  async fetchOrders(input: FetchOrdersInput): Promise<FetchOrdersResult> {
    const startedAt = performance.now()
    try {
      const response = await fetch('/api/trendyol/orders/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentials: input.credentials,
          query: {
            startDate: input.startDate?.getTime(),
            endDate: input.endDate?.getTime(),
            page: input.page,
            size: input.size,
            status: input.status,
            statuses: input.statuses,
            orderNumber: input.orderNumber,
          },
        }),
      })
      const data = await response.json()
      appendTrendyolDebug({
        operation: 'Get Orders',
        credentials: input.credentials,
        data,
        responseStatus: response.status,
        durationMs: performance.now() - startedAt,
        requestBody: {
          startDate: input.startDate?.getTime(),
          endDate: input.endDate?.getTime(),
          page: input.page,
          size: input.size,
          status: input.status,
          statuses: input.statuses,
          orderNumber: input.orderNumber,
        },
      })

      if (data.ok === false) {
        return emptyOrdersResult(input, data.message ?? 'Trendyol siparişi bulunamadı.', data.debug)
      }

      if (Array.isArray(data.orders)) {
        return {
          orders: data.orders,
          complete: true,
          page: input.page ?? 0,
          size: Math.min(input.size ?? 200, 200),
          totalPages: data.totalPages ?? 1,
          hasNextPage: Boolean(data.hasNextPage),
          source: 'real',
          message: data.orders.length > 0 ? data.message : 'Veri bulunamadı.',
          debug: data.debug,
        }
      }

      return emptyOrdersResult(input, 'Trendyol yanıtında sipariş verisi bulunamadı.')
    } catch (error) {
      appendTrendyolDebug({
        operation: 'Get Orders',
        credentials: input.credentials,
        data: { error: error instanceof Error ? error.message : 'Ağ hatası' },
        responseStatus: 0,
        durationMs: performance.now() - startedAt,
      })
      return emptyOrdersResult(
        input,
        error instanceof Error
          ? `API proxy erişilemedi: ${error.message}`
          : 'API proxy erişilemedi.',
      )
    }
  }

  async fetchProducts(
    credentials: TrendyolIntegrationConfig,
  ): Promise<FetchProductsResult> {
    const startedAt = performance.now()
    try {
      const response = await fetch('/api/trendyol/products/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials }),
      })
      const data = await response.json()
      appendTrendyolDebug({
        operation: 'Get Products',
        credentials,
        data,
        responseStatus: response.status,
        durationMs: performance.now() - startedAt,
      })

      if (data.ok === false) {
        return {
          products: [],
          source: 'real',
          message: data.message ?? 'Trendyol ürün API isteği başarısız.',
          debug: data.debug,
        }
      }

      if (Array.isArray(data.products)) {
        return {
          products: data.products,
          source: 'real',
          message: data.products.length > 0 ? data.message : 'Veri bulunamadı.',
          debug: data.debug,
        }
      }

      return {
        products: [],
        source: 'real',
        message: 'Trendyol yanıtında ürün verisi bulunamadı.',
        debug: data.debug,
      }
    } catch (error) {
      appendTrendyolDebug({
        operation: 'Get Products',
        credentials,
        data: { error: error instanceof Error ? error.message : 'Ağ hatası' },
        responseStatus: 0,
        durationMs: performance.now() - startedAt,
      })
      return {
        products: [],
        source: 'real',
        message:
          error instanceof Error
            ? `API proxy erişilemedi: ${error.message}`
            : 'API proxy erişilemedi.',
      }
    }
  }

  async fetchOrderById(): Promise<CargoOrder | null> {
    return null
  }

  async updateOrderStatus(
    externalOrderId: string,
    status: MarketplaceStatus,
  ): Promise<void> {
    if (!MANUAL_UPDATE_STATUSES.includes(status)) {
      throw new Error(
        `${externalOrderId} için Trendyol status güncellemesi desteklenmiyor.`,
      )
    }
  }
}

function appendTrendyolDebug({
  operation,
  credentials,
  data,
  responseStatus,
  durationMs,
  requestBody,
}: {
  operation: string
  credentials: TrendyolIntegrationConfig
  data: unknown
  responseStatus: number
  durationMs: number
  requestBody?: unknown
}) {
  const payload = asRecord(data)
  const debug = asRecord(payload.debug)
  const rawPreview = asRecord(payload.rawPreview)
  const statusRequests = Array.isArray(debug.statusRequests)
    ? debug.statusRequests.map(asRecord)
    : [Object.keys(debug).length > 0 ? debug : rawPreview]

  for (const item of statusRequests) {
    const requestUrl =
      String(item.requestUrl ?? rawPreview.requestUrl ?? '') ||
      `/integration/order/sellers/${credentials.sellerId}`
    apiDebugService.append({
      provider: 'Trendyol',
      operation:
        item?.status && operation === 'Get Orders'
          ? `${operation} / ${item.status}`
          : operation,
      endpoint: endpointFromUrl(requestUrl),
      requestUrl,
      requestHeaders: {
        Authorization: 'Basic ***',
        'User-Agent': `${credentials.sellerId} - ${
          credentials.userAgentName || 'CargoFlow'
        }`,
        Accept: 'application/json',
      },
      requestBody,
      responseStatus: Number(item.statusCode ?? payload.statusCode ?? responseStatus),
      responseBody:
        item.rawResponsePreview ??
        rawPreview.rawResponsePreview ??
        payload.rawPreview ??
        data,
      status:
        payload.ok === false || item.ok === false || responseStatus >= 400
          ? 'ERROR'
          : 'SUCCESS',
      durationMs: Math.round(durationMs),
      fields: {
        sellerId: credentials.sellerId,
        contentType: item.contentType ?? rawPreview.contentType,
        parsedError: item.parsedError ?? rawPreview.parsedError,
      },
      errorMessage:
        payload.ok === false || item.ok === false
          ? String(item.message ?? payload.message ?? '')
          : undefined,
    })
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function endpointFromUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.pathname}${url.search}`
  } catch {
    return value
  }
}

function emptyOrdersResult(
  input: FetchOrdersInput,
  message: string,
  debug?: FetchOrdersResult['debug'],
): FetchOrdersResult {
  return {
    orders: [],
    complete: false,
    page: input.page ?? 0,
    size: Math.min(input.size ?? 200, 200),
    totalPages: 1,
    hasNextPage: false,
    source: 'real',
    message,
    debug,
  }
}
