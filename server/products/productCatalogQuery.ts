// ÜRÜN KATALOĞU TARAYICISI — `GET /api/products` UCUNUN TAM DAVRANIŞI.
//
// `server/index.mjs` yalnız kiracı + aktif hesap kapsamını çözer ve buraya
// devreder; sorgu ayrıştırma, sayfa sınırları ve katalog durumu burada
// yaşar ve DOĞRUDAN test edilir (satır içi uç davranışı test EDİLEMİYORDU).
//
// KAPSAM İSTEMCİDEN ALINMAZ: sorgudaki `organizationId` / `marketplaceAccountId`
// YOK SAYILIR; yalnız çağıranın çözdüğü kapsam kullanılır.
//
// ARŞİV VARSAYILANI: uç `archived` verilmezse TÜM varyantları döndürür. Bu
// BİLİNÇLİDİR: istemcinin OPERASYONEL tam kataloğu (`loadProductsFromServer`
// — etiket/görsel eşleşmesi) bu davranışa dayanır. Ürünler ekranı ETKİN
// görünümü AÇIKÇA `archived=false` ile ister.
import { getMaskedIntegrationStatus } from '../integrations/credentialService.ts'
import { getSyncState } from '../onboarding/onboardingRepository.ts'
import { buildProviderCatalog } from '../connectors/providerCatalog.ts'
import { capabilityIsLive } from '../connectors/connectorKernel.ts'
import { listProducts } from './productPersistenceService.ts'
import type { ProductFilters } from './productRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

function text(value: unknown): string | undefined {
  if (Array.isArray(value)) return text(value[0])
  if (value === undefined || value === null) return undefined
  const trimmed = String(value).trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * `archived` üç durumludur:
 *   'true' | '1'  → yalnız arşivlenmiş
 *   'false' | '0' → yalnız etkin
 *   yok | 'all'   → hepsi (operasyonel tam katalog davranışı)
 * Tanınmayan değer ESKİ davranışı korur: tanımlı ama `true` değilse etkin.
 */
export function parseArchivedParam(value: unknown): boolean | undefined {
  const raw = text(value)
  if (raw === undefined || raw.toLowerCase() === 'all') return undefined
  return raw === 'true' || raw === '1'
}

export function parseProductListQuery(query: Record<string, unknown> = {}): ProductFilters {
  return {
    search: text(query.search),
    barcode: text(query.barcode),
    merchantSku: text(query.merchantSku),
    archived: parseArchivedParam(query.archived),
    page: query.page as number | undefined,
    pageSize: query.pageSize as number | undefined,
    sort:
      query.sort === 'titleDesc' || query.sort === 'recent' ? query.sort : 'titleAsc',
  }
}

/**
 * Ürün senkronu kaynağı. Bugünkü CANLI ürün kaynağı Trendyol'dur ve senkron
 * ucu yalnız onu çalıştırır; kaynak katalogdan (`capabilityIsLive`) ve kimlik
 * VARLIĞINDAN türetilir — kullanılamıyorsa buton DÜRÜSTÇE kapanır.
 */
const PRODUCT_SYNC_PROVIDER = 'trendyol'

export async function resolveProductSyncAvailability(
  db: Db,
  organizationId: string,
): Promise<{ available: boolean; reason: 'SOURCE_NOT_LIVE' | 'NOT_CONFIGURED' | null }> {
  const descriptor = buildProviderCatalog().get(PRODUCT_SYNC_PROVIDER)
  if (!descriptor || !capabilityIsLive(descriptor, 'products.read')) {
    return { available: false, reason: 'SOURCE_NOT_LIVE' }
  }
  const masked = await getMaskedIntegrationStatus(db, organizationId)
  return masked?.trendyol?.configured
    ? { available: true, reason: null }
    : { available: false, reason: 'NOT_CONFIGURED' }
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (value == null || value === '') return null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** KALICI senkron gerçeği (aktif hesap). Zaman damgası UYDURULMAZ. */
export async function loadCatalogSyncStatus(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string | null,
): Promise<{
  lastSyncStatus: string | null
  lastSuccessfulSyncAt: string | null
  lastFetchedCount: number | null
}> {
  const row = await getSyncState(db, organizationId, 'products', marketplaceAccountId)
  return {
    lastSyncStatus: row?.lastSyncStatus ? String(row.lastSyncStatus) : null,
    lastSuccessfulSyncAt: toIso(row?.lastSuccessfulSyncAt),
    lastFetchedCount:
      row?.lastFetchedCount == null ? null : Number(row.lastFetchedCount),
  }
}

export async function handleProductListRequest(params: {
  db: Db
  organizationId: string
  /** Sunucunun çözdüğü AKTİF hesap (`null` = hesapsız/eski kapsam). */
  marketplaceAccountId: string | null
  query: Record<string, unknown>
}): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const filters = parseProductListQuery(params.query)
  const [result, catalogSync, syncSource] = await Promise.all([
    listProducts(params.db, params.organizationId, filters, params.marketplaceAccountId),
    loadCatalogSyncStatus(params.db, params.organizationId, params.marketplaceAccountId),
    resolveProductSyncAvailability(params.db, params.organizationId),
  ])
  return {
    httpStatus: 200,
    body: {
      ok: true,
      products: result.products,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      archived: filters.archived === undefined ? 'all' : filters.archived,
      catalogSync,
      syncSource,
    },
  }
}
