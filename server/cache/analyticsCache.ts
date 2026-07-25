// Tenant bazlı, sınırlı (bounded LRU) + TTL'li satış analitiği cache'i.
//
// Amaç: Dashboard satış özeti ve iade verisi her sayfa açılışında ağır bir
// Trendyol pencereli çekimini (statü × tarih penceresi × sayfalama) yeniden
// tetikliyordu. Bu modül aynı (organization, tarih aralığı, timezone, filtre,
// rapor sürümü) için sonucu RAM'de tutar; tekrar istek geldiğinde hesaplamayı
// atlar.
//
// Güvenlik / sınırlar:
//   - Anahtar HER ZAMAN tenantId içerir; global/tenant-bilgisiz kayıt YOK.
//   - Bounded LRU: maxEntries aşılınca en eski (en az kullanılan) çıkarılır;
//     bellek sınırsız büyümez.
//   - TTL: süresi dolan kayıt normal cache-miss üretir.
//   - Single-flight: aynı anahtar için eşzamanlı N istek TEK ağır hesaplama
//     çalıştırır (promise deduplication).
//   - Başarısız hesaplama (throw) cache'e YAZILMAZ; promise/hata nesnesi kalıcı
//     kayıt olarak bırakılmaz.
//   - Aggregate/PII-azaltılmış sonuç saklanır (bkz. sanitizeAnalytics*).
//
// PM2 mimari notu: Bu cache PROCESS-LOCAL'dir (in-memory). Mevcut production
// PM2 yapılandırması tek instance + fork modudur (ecosystem.config.cjs:
// instances=1, exec_mode='fork'); bu nedenle in-memory cache tutarlıdır.
// Cluster/çoklu instance'a geçilirse HER process kendi cache'ini tutar (paylaşımlı
// olmaz); tutarlı paylaşımlı cache için AnalyticsCacheBackend arayüzünü uygulayan
// bir Redis adapter'ı takılmalıdır (getOrCompute zaten backend get/set'i await
// eder; sync in-memory veya async Redis backend fark etmeksizin çalışır).

export const ANALYTICS_REPORT_VERSION = 'v1'

const DEFAULT_MAX_ENTRIES = clampInt(process.env.ANALYTICS_CACHE_MAX_ENTRIES, 200, 1, 5000)
const DEFAULT_TTL_MS = clampInt(
  process.env.ANALYTICS_CACHE_TTL_MS,
  5 * 60 * 1000,
  1000,
  60 * 60 * 1000,
)

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(String(raw ?? '').trim())
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export interface CacheEntry<T = unknown> {
  value: T
  generatedAt: number
}

// Redis adapter'ının uygulayacağı seam. In-memory sürüm senkron döner; bir Redis
// adapter'ı Promise dönebilir (getOrCompute her çağrıyı await eder).
export interface AnalyticsCacheBackend {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>
  set(key: string, entry: CacheEntry): void | Promise<void>
  delete(key: string): void | Promise<void>
  deleteWhere(predicate: (key: string) => boolean): number | Promise<number>
  clear(): void | Promise<void>
  size(): number | Promise<number>
}

// Erişim-sıralı (access-order) LRU: get/set kaydı "en yeni" konuma taşır; kapasite
// aşılınca Map'in ilk (en eski) anahtarı çıkarılır.
export function createInMemoryLruBackend(maxEntries: number): AnalyticsCacheBackend {
  const store = new Map<string, CacheEntry>()
  return {
    get(key) {
      const entry = store.get(key)
      if (entry === undefined) return undefined
      // LRU touch
      store.delete(key)
      store.set(key, entry)
      return entry
    },
    set(key, entry) {
      if (store.has(key)) store.delete(key)
      store.set(key, entry)
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value
        if (oldest === undefined) break
        store.delete(oldest)
      }
    },
    delete(key) {
      store.delete(key)
    },
    deleteWhere(predicate) {
      let removed = 0
      for (const key of [...store.keys()]) {
        if (predicate(key)) {
          store.delete(key)
          removed += 1
        }
      }
      return removed
    },
    clear() {
      store.clear()
    },
    size() {
      return store.size
    },
  }
}

export interface GetOrComputeResult<T> {
  value: T
  cached: boolean
  generatedAt: number
  cacheAgeMs: number
}

export interface AnalyticsCacheOptions {
  maxEntries?: number
  ttlMs?: number
  backend?: AnalyticsCacheBackend
  now?: () => number
}

export class AnalyticsCache {
  private readonly backend: AnalyticsCacheBackend
  private readonly ttlMs: number
  private readonly now: () => number
  // Single-flight: aynı anahtar için devam eden hesaplamalar paylaşılır.
  private readonly inFlight = new Map<string, Promise<CacheEntry>>()

  constructor(options: AnalyticsCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.backend = options.backend ?? createInMemoryLruBackend(maxEntries)
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  // Cache'ten döner; yoksa/expired/bypass ise computeFn ile TEK sefer hesaplar,
  // BAŞARILIYSA yazar. computeFn throw ederse cache'e yazılmaz ve hata iletilir.
  async getOrCompute<T>(
    key: string,
    computeFn: () => Promise<T>,
    options: { bypass?: boolean } = {},
  ): Promise<GetOrComputeResult<T>> {
    const bypass = options.bypass === true
    if (!bypass) {
      const entry = await this.backend.get(key)
      if (entry) {
        const age = this.now() - entry.generatedAt
        if (age <= this.ttlMs) {
          return {
            value: entry.value as T,
            cached: true,
            generatedAt: entry.generatedAt,
            cacheAgeMs: Math.max(0, age),
          }
        }
        // TTL doldu → normal cache-miss (kaydı temizle).
        await this.backend.delete(key)
      }
    }

    // Single-flight: eşzamanlı istekler (bypass dahil) tek hesaplamayı paylaşır.
    let pending = this.inFlight.get(key)
    if (!pending) {
      pending = (async () => {
        const value = await computeFn()
        const entry: CacheEntry = { value, generatedAt: this.now() }
        await this.backend.set(key, entry) // yalnız BAŞARIDA yazılır
        return entry
      })()
      this.inFlight.set(key, pending)
      // Hata da başarı da in-flight kaydını temizler; hata cache'e YAZILMAZ.
      pending
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
        })
    }

    const entry = await pending
    return {
      value: entry.value as T,
      cached: false,
      generatedAt: entry.generatedAt,
      cacheAgeMs: Math.max(0, this.now() - entry.generatedAt),
    }
  }

  // Bir tenant'ın TÜM analitik kayıtlarını (tüm resource/aralık/filtre) düşürür.
  // Sipariş sync'i veya durum/tutar/iptal/iade değişiminden sonra çağrılır.
  async invalidateTenant(tenantId: string): Promise<number> {
    const token = `|t=${tenantId}|`
    return this.backend.deleteWhere((key) => key.includes(token))
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(key)
  }

  async clear(): Promise<void> {
    this.inFlight.clear()
    await this.backend.clear()
  }

  async size(): Promise<number> {
    return this.backend.size()
  }

  // Test/gözlem için: bir anahtarın TAZE (TTL içinde) kaydı var mı?
  async hasFresh(key: string): Promise<boolean> {
    const entry = await this.backend.get(key)
    if (!entry) return false
    return this.now() - entry.generatedAt <= this.ttlMs
  }
}

// Filtreleri sıralı-anahtarlı, deterministik bir stringe çevirir (aynı filtre
// kümesi her zaman aynı anahtarı üretsin).
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return String(value)
}

// Cache anahtarı: rapor sürümü + resource + tenant + aralık + timezone + filtre.
// tenantId '|t=...|' formatında gömülür ki invalidateTenant prefix'siz eşleşsin.
export function buildAnalyticsCacheKey(input: {
  resource: 'orders' | 'claims'
  tenantId: string
  startMs: number
  endMs: number
  timezone?: string
  filters?: Record<string, unknown>
  version?: string
}): string {
  const version = input.version ?? ANALYTICS_REPORT_VERSION
  const tz = String(input.timezone ?? '').trim() || 'Europe/Istanbul'
  const filters = stableStringify(input.filters ?? {})
  return [
    `v=${version}`,
    `r=${input.resource}`,
    `t=${input.tenantId}`,
    `s=${input.startMs}`,
    `e=${input.endMs}`,
    `tz=${tz}`,
    `f=${filters}`,
  ].join('|')
}

// PII azaltma (denylist): satış analitiği aggregate'i için müşteri iletişim ve
// açık adres verisi GEREKMEZ; bunlar cache'e YAZILMAZ ve yanıttan da düşer.
// Denylist tercih edilir çünkü dashboard view-model'i çok sayıda satır (item)
// alanını okur (color/size/variantAttributes/stockCode/productCode/time…);
// allowlist bunları sessizce düşürüp ürün kırılımını bozardı. Şehir/ilçe
// (coarse), customerName (kartlarda gösterilir) ve tüm satır alanları KORUNUR.
// Kaldırılan alanlar: ham Trendyol payload'ı (rawOrder — telefon/adres/kimlik
// dahil her şeyi taşır), açık adres nesnesi ve ad/telefon/e-posta.
const ANALYTICS_ORDER_PII_KEYS = [
  'rawOrder',
  'shipmentAddress',
  'address',
  'customerFirstName',
  'customerLastName',
  'customerPhone',
  'customerEmail',
] as const

export function sanitizeAnalyticsOrder(order: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...order }
  for (const key of ANALYTICS_ORDER_PII_KEYS) {
    delete clean[key]
  }
  return clean
}

export function sanitizeAnalyticsOrders(
  orders: Record<string, unknown>[],
): Record<string, unknown>[] {
  return (Array.isArray(orders) ? orders : []).map((order) =>
    sanitizeAnalyticsOrder(order ?? {}),
  )
}

// Uygulama genelinde tek örnek (process-local). Test için ayrı örnekler
// (new AnalyticsCache({...})) kurulabilir.
export const analyticsCache = new AnalyticsCache()
