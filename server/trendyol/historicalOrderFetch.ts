// Historical order backfill için KENDİ İÇİNDE YETERLİ Trendyol sipariş çekici.
// TÜM gerekli statüleri, tam tarih aralığında, güvenli tarih pencereleriyle ve
// eksiksiz pagination ile READ-ONLY çeker. 429/5xx için bounded retry. HİÇBİR DB
// yazma yapmaz. Credential/PII/ham payload LOGLAMAZ (yalnız güvenli özet).
//
// NOT: Bu modül index.mjs'deki fetch/normalize'dan BAĞIMSIZDIR (o dosya
// koşulsuz app.listen ile server başlatır, CLI'dan import edilemez). Ancak
// UÇ NOKTA SÖZLEŞMESİ ortaktır ve `trendyolOrdersEndpoint.ts`ten gelir —
// bağımsızlık, emekli yolu ikinci kez elle yazmak için gerekçe DEĞİLDİR.
import {
  buildTrendyolOrdersV2Url,
  canSplitFurther,
  detectQueryWindowCap,
  maxReachablePageCount,
  planTrendyolDateSlices,
  TRENDYOL_V2_MAX_PAGE_SIZE,
  TRENDYOL_V2_MAX_RANGE_MS,
} from '../marketplaces/trendyolOrdersEndpoint.ts'
import { normalizeTrendyolOrderDate } from '../marketplaces/trendyolOrderDate.ts'

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
  /**
   * İPTAL EDİLEBİLİRLİK: her birim ÖNCESİNDE sorulur. `false` dönerse çekim
   * DURUR ve `cancelled: true` ile raporlanır — yarım sonuç "tamamlandı"
   * SAYILMAZ.
   */
  shouldContinue?: () => boolean
}

/** Tek (statü, tarih dilimi) biriminin sonucu — devam ettirilebilirlik için. */
export interface HistoricalWindowReport {
  status: string
  startMs: number
  endMs: number
  ok: boolean
  packageCount: number
  /** Erişim penceresi aşıldı ve daha ince bölünemedi. */
  queryWindowExhausted: boolean
  unreachableRecords: number
}

export interface HistoricalFetchResult {
  orders: Record<string, unknown>[]
  fetchedPackageCount: number
  requestedWindows: number
  failedWindows: number
  complete: boolean
  /**
   * DEVAM ETTİRİLEBİLİRLİK: her birim ayrı raporlanır. Çağıran başarısız veya
   * cap'e takılan birimleri işaretleyip YALNIZ onları tekrar çalıştırabilir;
   * tüm geçmiş baştan çekilmez.
   */
  windows: HistoricalWindowReport[]
  /** İptal edildiyse true — tamamlanmışlıkla KARIŞTIRILMAZ. */
  cancelled: boolean
}

// v2 SÖZLEŞMESİ: tek istekte en geniş aralık İKİ HAFTADIR. Varsayılan dilim
// tam o sınırdır; daha dar dilim GEREKTİĞİNDE cap tespitiyle türetilir.
const DEFAULT_WINDOW_MS = TRENDYOL_V2_MAX_RANGE_MS
const DEFAULT_PAGE_SIZE = TRENDYOL_V2_MAX_PAGE_SIZE
const DEFAULT_RETRY_DELAYS = [2000, 5000, 15000]

function baseUrlFor(options: HistoricalFetchOptions, credentials: TrendyolCredentials): string {
  if (options.baseUrl) return options.baseUrl
  // RESMÎ STAGE HOST'U `stageapigw.trendyol.com`'DUR. Buradaki varsayılan
  // `stageapi.trendyol.com` idi — resmî sunucu listesinde BÖYLE BİR HOST YOK;
  // stage geri-dolumu yapılandırma verilmediğinde sessizce çözümsüz bir adrese
  // gidiyordu. index.mjs zaten doğru varsayılanı kullanıyordu.
  return credentials.environment === 'stage'
    ? String(process.env.TRENDYOL_STAGE_BASE_URL ?? 'https://stageapigw.trendyol.com')
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
): Promise<{
  ok: boolean
  content: Record<string, unknown>[]
  totalPages: number
  totalElements: unknown
}> {
  const failed = { ok: false, content: [], totalPages: 1, totalElements: null }
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await wait(retryDelays[attempt - 1])
    let response: Response
    try {
      response = await fetchImpl(url, { headers: authHeaders(credentials) })
    } catch {
      if (attempt === retryDelays.length) return failed
      continue
    }
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      if (attempt === retryDelays.length) return failed
      continue
    }
    if (!response.ok) return failed
    const payload = (await response.json().catch(() => ({}))) as {
      content?: Record<string, unknown>[]
      totalPages?: number
      totalElements?: unknown
    }
    const content = Array.isArray(payload.content) ? payload.content : []
    const totalPages =
      Number.isFinite(Number(payload.totalPages)) && Number(payload.totalPages) > 0
        ? Math.ceil(Number(payload.totalPages))
        : 1
    return { ok: true, content, totalPages, totalElements: payload.totalElements }
  }
  return failed
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
    // SAĞLAYICIYA ÖZEL: `orderDate` GMT+3 epoch'tur (resmî sözleşme). Geri
    // doldurma yolu, canlı sync ile AYNI normalizasyonu kullanmak
    // ZORUNDADIR; aksi hâlde aynı sipariş hangi yoldan geldiğine göre
    // 3 saat farklı kaydedilirdi.
    orderDate:
      normalizeTrendyolOrderDate(item.orderDate) || new Date(0).toISOString(),
    lastModifiedDate: toIso(item.lastModifiedDate),
    rawOrder: item,
    // Satır id: yalnız GERÇEK provider satır id'si (line.id/orderLineId). Sentetik
    // `${packageId}-${index}` fallback KULLANILMAZ — id yoksa persistence
    // (canonicalLineKey) yol-bağımsız içerik hash'ine düşer; normal sync ile AYNI
    // canonical anahtar üretilir (cross-path duplicate önlenir).
    items: lines.map((line) => ({
      id: String(line.id ?? line.orderLineId ?? ''),
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
  const windows: HistoricalWindowReport[] = []
  let requestedWindows = 0
  let failedWindows = 0
  let cancelled = false

  // Erişilebilir sayfa adedi sözleşmeden türetilir; "10000 sayfa" gibi bir
  // güvenlik sayısı ARTIK GEREKMEZ — gerçek sınır erişim penceresidir.
  const reachablePages = maxReachablePageCount(pageSize)

  /** Tek (statü, dilim) birimini çeker; cap'e takılırsa BÖLEREK yeniden dener. */
  const fetchUnit = async (
    status: string,
    slice: { startMs: number; endMs: number },
  ): Promise<void> => {
    requestedWindows += 1
    let page = 0
    let unitOk = true
    let capped = false
    let unreachableRecords = 0
    let collected = 0
    const staged: Record<string, unknown>[] = []

    while (page < reachablePages) {
      const params = new URLSearchParams({
        status,
        startDate: String(slice.startMs),
        endDate: String(slice.endMs),
        page: String(page),
        size: String(pageSize),
        orderByField: 'PackageLastModifiedDate',
        orderByDirection: 'DESC',
      })
      const url = buildTrendyolOrdersV2Url({
        baseUrl: base,
        sellerId,
        search: params,
      })
      const result = await fetchPage(fetchImpl, url, credentials, retryDelays)
      if (!result.ok) {
        unitOk = false
        break
      }
      if (page === 0) {
        // SESSİZ BAŞARI YASAK: filtre erişim penceresini aşıyorsa bu birim
        // "tamam" SAYILAMAZ; bölünüp yeniden çekilir.
        const cap = detectQueryWindowCap({
          totalElements: result.totalElements,
          size: pageSize,
        })
        capped = cap.capped
        unreachableRecords = cap.unreachableRecords
        if (capped && canSplitFurther(slice)) {
          const sub = planTrendyolDateSlices({
            startMs: slice.startMs,
            endMs: slice.endMs,
            maxRangeMs: windowMs,
            sliceCount: Math.max(2, cap.requiredSliceCount),
          })
          if (sub.length > 1) {
            for (const child of sub) {
              if (options.shouldContinue && !options.shouldContinue()) {
                cancelled = true
                return
              }
              await fetchUnit(status, child)
            }
            return
          }
        }
      }
      for (const item of result.content) {
        staged.push(normalizeHistoricalPackage(item))
      }
      collected += result.content.length
      page += 1
      if (page >= result.totalPages) break
    }

    for (const normalized of staged) {
      const key = String(normalized.packageId)
      if (key) byPackage.set(key, normalized)
    }
    if (!unitOk) failedWindows += 1
    windows.push({
      status,
      startMs: slice.startMs,
      endMs: slice.endMs,
      ok: unitOk,
      packageCount: collected,
      // 1 ms'e kadar bölünüp hâlâ aşılıyorsa: GERÇEKTEN erişilemez.
      queryWindowExhausted: capped && !canSplitFurther(slice),
      unreachableRecords: capped ? unreachableRecords : 0,
    })
  }

  for (const status of statuses) {
    const slices = planTrendyolDateSlices({
      startMs: options.startMs,
      endMs: options.endMs,
      maxRangeMs: windowMs,
    })
    for (const slice of slices) {
      if (options.shouldContinue && !options.shouldContinue()) {
        cancelled = true
        break
      }
      await fetchUnit(status, slice)
      if (cancelled) break
    }
    if (cancelled) break
  }

  const exhausted = windows.some((entry) => entry.queryWindowExhausted)
  return {
    orders: [...byPackage.values()],
    fetchedPackageCount: byPackage.size,
    requestedWindows,
    failedWindows,
    // TAMAMLANMIŞLIK ÜÇ KOŞULA BAĞLI: düşen birim yok, iptal yok ve erişim
    // penceresi yüzünden ULAŞILAMAYAN kayıt yok.
    complete: failedWindows === 0 && !cancelled && !exhausted,
    windows,
    cancelled,
  }
}
