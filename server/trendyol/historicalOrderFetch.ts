// Historical order backfill için KENDİ İÇİNDE YETERLİ Trendyol sipariş çekici.
// TÜM gerekli statüleri, tam tarih aralığında, güvenli tarih pencereleriyle ve
// eksiksiz pagination ile READ-ONLY çeker. 429/5xx için bounded retry. HİÇBİR DB
// yazma yapmaz. Credential/PII/ham payload LOGLAMAZ (yalnız güvenli özet).
//
// NOT: Bu modül index.mjs'deki fetch/normalize'dan BAĞIMSIZDIR (o dosya
// koşulsuz app.listen ile server başlatır, CLI'dan import edilemez). Trendyol
// sözleşmesi: GET /integration/order/sellers/{sellerId}/orders, Basic auth.

// Analitik/backfill için gerekli TÜM statüler (aktif + arşiv).
export const HISTORICAL_ORDER_STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'Delivered',
  'AtCollectionPoint',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
] as const

export interface TrendyolCredentials {
  sellerId: string
  apiKey: string
  apiSecret: string
  environment?: string
  storeFrontCode?: string
}

export interface HistoricalFetchOptions {
  startMs: number
  endMs: number
  statuses?: readonly string[]
  windowMs?: number
  pageSize?: number
  retryDelaysMs?: number[]
  // Test enjeksiyonu: gerçek fetch yerine (mock). Verilmezse global fetch.
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export interface HistoricalFetchResult {
  orders: Record<string, unknown>[]
  fetchedPackageCount: number
  requestedWindows: number
  failedWindows: number
  complete: boolean
}

const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000 // Trendyol 30 gün sınırının altı
const DEFAULT_PAGE_SIZE = 200
const DEFAULT_RETRY_DELAYS = [2000, 5000, 15000]

function baseUrlFor(options: HistoricalFetchOptions, credentials: TrendyolCredentials): string {
  if (options.baseUrl) return options.baseUrl
  return credentials.environment === 'stage'
    ? String(process.env.TRENDYOL_STAGE_BASE_URL ?? 'https://stageapi.trendyol.com')
    : String(process.env.TRENDYOL_PROD_BASE_URL ?? 'https://apigw.trendyol.com')
}

function authHeaders(credentials: TrendyolCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(
      `${credentials.apiKey}:${credentials.apiSecret}`,
    ).toString('base64')}`,
    'User-Agent': `${String(credentials.sellerId).trim() || 'CargoFlow'} - CargoFlow`,
    Accept: 'application/json',
  }
  if (credentials.storeFrontCode) headers.storeFrontCode = String(credentials.storeFrontCode)
  return headers
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Tek (status, window, page) isteği; 429/5xx için bounded retry.
async function fetchPage(
  fetchImpl: typeof fetch,
  url: string,
  credentials: TrendyolCredentials,
  retryDelays: number[],
): Promise<{ ok: boolean; content: Record<string, unknown>[]; totalPages: number }> {
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await wait(retryDelays[attempt - 1])
    let response: Response
    try {
      response = await fetchImpl(url, { headers: authHeaders(credentials) })
    } catch {
      if (attempt === retryDelays.length) return { ok: false, content: [], totalPages: 1 }
      continue
    }
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      if (attempt === retryDelays.length) return { ok: false, content: [], totalPages: 1 }
      continue
    }
    if (!response.ok) return { ok: false, content: [], totalPages: 1 }
    const payload = (await response.json().catch(() => ({}))) as {
      content?: Record<string, unknown>[]
      totalPages?: number
    }
    const content = Array.isArray(payload.content) ? payload.content : []
    const totalPages =
      Number.isFinite(Number(payload.totalPages)) && Number(payload.totalPages) > 0
        ? Math.ceil(Number(payload.totalPages))
        : 1
    return { ok: true, content, totalPages }
  }
  return { ok: false, content: [], totalPages: 1 }
}

function num(value: unknown): string | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(parsed) : null
}
function toIso(value: unknown): string | null {
  if (value == null || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  if (Number.isFinite(ms)) return new Date(ms).toISOString()
  const asNum = Number(value)
  return Number.isFinite(asNum) ? new Date(asNum).toISOString() : null
}

// FOCUSED normalize: Trendyol paketi → persist-ready sipariş (toOrderInsertValues'un
// okuduğu alanlar). UI-özel alanlar (görsel/kargo detayları) satış persistansı
// için gerekmez; backfill esas olarak Delivered/terminal siparişleri getirir.
export function normalizeHistoricalPackage(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const address = (item.shipmentAddress ?? item.invoiceAddress ?? {}) as Record<string, unknown>
  const packageId = String(item.shipmentPackageId ?? item.packageId ?? item.id ?? '')
  const lines = Array.isArray(item.lines) ? (item.lines as Record<string, unknown>[]) : []
  return {
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: String(item.orderNumber ?? item.id ?? packageId),
    marketplaceStatus: String(item.status ?? item.shipmentPackageStatus ?? '') || null,
    customerFirstName: String(item.customerFirstName ?? ''),
    customerLastName: String(item.customerLastName ?? ''),
    customerEmail: String(item.customerEmail ?? ''),
    customerPhone: String(address.phone ?? item.customerPhone ?? ''),
    shipmentAddress: address,
    city: String(address.city ?? ''),
    district: String(address.district ?? ''),
    cargoProviderName: String(item.cargoProviderName ?? ''),
    cargoTrackingNumber: String(item.cargoTrackingNumber ?? ''),
    totalAmount: num(item.grossAmount ?? item.totalPrice ?? item.totalAmount ?? item.amount),
    currency: String(item.currencyCode ?? 'TRY'),
    orderDate: toIso(item.orderDate) ?? new Date(0).toISOString(),
    lastModifiedDate: toIso(item.lastModifiedDate),
    rawOrder: item,
    items: lines.map((line, index) => ({
      id: String(line.id ?? line.orderLineId ?? `${packageId}-${index}`),
      barcode: String(line.barcode ?? ''),
      merchantSku: String(line.merchantSku ?? line.sku ?? ''),
      productId: String(line.productContentId ?? line.productCode ?? ''),
      productName: String(line.productName ?? 'Ürün'),
      quantity: Number(line.quantity ?? 1) || 1,
      price: num(line.price ?? line.amount ?? line.unitPrice),
    })),
  }
}

// TÜM statüler × tarih pencereleri × tüm sayfalar. Paketler packageId ile
// deduplike edilir. Bir pencere/statü başarısız olursa complete=false + failed
// sayısı raporlanır (sessizce COMPLETE sayılmaz).
export async function fetchHistoricalOrders(
  credentials: TrendyolCredentials,
  options: HistoricalFetchOptions,
): Promise<HistoricalFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const statuses = options.statuses ?? HISTORICAL_ORDER_STATUSES
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const base = baseUrlFor(options, credentials)
  const sellerId = encodeURIComponent(String(credentials.sellerId))

  const byPackage = new Map<string, Record<string, unknown>>()
  let requestedWindows = 0
  let failedWindows = 0

  for (const status of statuses) {
    let cursor = options.startMs
    while (cursor <= options.endMs) {
      const windowEnd = Math.min(options.endMs, cursor + windowMs)
      requestedWindows += 1
      let page = 0
      let windowOk = true
      // Eksiksiz pagination: totalPages ilk sayfadan öğrenilir; son sayfaya
      // kadar gidilir (güvenlik: 10000 sayfa üst sınırı).
      while (page < 10000) {
        const params = new URLSearchParams({
          status,
          startDate: String(cursor),
          endDate: String(windowEnd),
          page: String(page),
          size: String(pageSize),
          orderByField: 'PackageLastModifiedDate',
          orderByDirection: 'DESC',
        })
        const url = `${base}/integration/order/sellers/${sellerId}/orders?${params}`
        const result = await fetchPage(fetchImpl, url, credentials, retryDelays)
        if (!result.ok) {
          windowOk = false
          break
        }
        for (const item of result.content) {
          const normalized = normalizeHistoricalPackage(item)
          const key = String(normalized.packageId)
          if (key) byPackage.set(key, normalized)
        }
        page += 1
        if (page >= result.totalPages) break
      }
      if (!windowOk) failedWindows += 1
      if (windowEnd === options.endMs) break
      cursor = windowEnd + 1
    }
  }

  return {
    orders: [...byPackage.values()],
    fetchedPackageCount: byPackage.size,
    requestedWindows,
    failedWindows,
    complete: failedWindows === 0,
  }
}
