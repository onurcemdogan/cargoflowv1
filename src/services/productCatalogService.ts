// ÜRÜN KATALOĞU TARAYICI KAYNAĞI.
//
// TARAYICI ≠ OPERASYONEL KATALOG: Ürünler ekranı yalnız GÖRÜNEN sayfayı
// sunucudan ister (`GET /api/products`). Uygulamanın tam katalog önbelleği
// (etiket meta verisi, görsel eşleşmesi, pano zenginleştirme) BU DOSYADAN
// ETKİLENMEZ ve ayrı yüklenmeye devam eder.
//
// KAPSAM İSTEMCİDEN GÖNDERİLMEZ: `organizationId` / `marketplaceAccountId`
// sorguya eklenmez; sunucu oturumdan ve aktif hesaptan çözer.
import type { CargoProduct } from '../types/cargoflow'

export type CatalogArchiveFilter = 'ACTIVE' | 'ARCHIVED' | 'ALL'
export type CatalogSort = 'titleAsc' | 'titleDesc' | 'recent'

export const CATALOG_PAGE_SIZES = [25, 50, 100] as const

export interface CatalogQuery {
  page: number
  pageSize: number
  search: string
  archive: CatalogArchiveFilter
  sort: CatalogSort
}

export interface CatalogSyncStatus {
  lastSyncStatus: string | null
  lastSuccessfulSyncAt: string | null
  lastFetchedCount: number | null
}

export interface CatalogSyncSource {
  available: boolean
  reason: string | null
}

export interface CatalogPage {
  products: CargoProduct[]
  total: number
  page: number
  pageSize: number
  /** Kalıcı senkron gerçeği; kaynak bilmiyorsa `null` (UYDURULMAZ). */
  catalogSync: CatalogSyncStatus | null
  syncSource: CatalogSyncSource | null
}

export type ProductCatalogSource = (query: CatalogQuery, signal: AbortSignal) => Promise<CatalogPage>

export class CatalogRequestError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Katalog yüklenemedi (${status}).`)
    this.name = 'CatalogRequestError'
    this.status = status
  }
}

export function buildCatalogSearchParams(query: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: query.sort,
  })
  const search = query.search.trim()
  if (search) params.set('search', search)
  // ARŞİV AÇIKÇA gönderilir: sunucu varsayılanı "hepsi"dir (operasyonel tam
  // katalog buna dayanır); tarayıcı etkin görünümü AÇIKÇA ister.
  params.set(
    'archived',
    query.archive === 'ACTIVE' ? 'false' : query.archive === 'ARCHIVED' ? 'true' : 'all',
  )
  return params
}

/** Sunucu (auth modu) kaynağı — yalnız TEK sayfa ister. */
export const serverCatalogSource: ProductCatalogSource = async (query, signal) => {
  const response = await fetch(`/api/products?${buildCatalogSearchParams(query).toString()}`, {
    credentials: 'include',
    signal,
  })
  if (!response.ok) throw new CatalogRequestError(response.status)
  const payload = (await response.json()) as Partial<CatalogPage> & { ok?: boolean }
  const products = Array.isArray(payload.products) ? payload.products : []
  return {
    products,
    total: Math.max(0, Number(payload.total ?? products.length) || 0),
    page: Math.max(1, Number(payload.page ?? query.page) || 1),
    pageSize: Math.max(1, Number(payload.pageSize ?? query.pageSize) || query.pageSize),
    catalogSync: payload.catalogSync ?? null,
    syncSource: payload.syncSource ?? null,
  }
}

/**
 * YEREL (legacy, veritabanısız geliştirme modu) kaynak.
 *
 * Bu modda sunucu kataloğu YOKTUR; tek kaynak zaten bellekteki yerel
 * katalogdur. Sözleşme sunucuyla AYNIDIR ve render yine yalnız bir sayfadır.
 * Üretimde (auth modu) BU KAYNAK KULLANILMAZ.
 */
export function createLocalCatalogSource(products: CargoProduct[]): ProductCatalogSource {
  return async (query) => {
    const term = query.search.trim().toLocaleLowerCase('tr-TR')
    const filtered = products.filter((product) => {
      const archived = Boolean((product as { archived?: boolean }).archived)
      if (query.archive === 'ACTIVE' && archived) return false
      if (query.archive === 'ARCHIVED' && !archived) return false
      if (!term) return true
      return [product.productName, product.barcode, product.sku, product.stockCode]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase('tr-TR').includes(term))
    })
    const sorted = [...filtered].sort((left, right) => {
      if (query.sort === 'recent') {
        return String(right.updatedAt).localeCompare(String(left.updatedAt)) ||
          left.id.localeCompare(right.id)
      }
      const byTitle = left.productName.localeCompare(right.productName, 'tr-TR')
      return (query.sort === 'titleDesc' ? -byTitle : byTitle) || left.id.localeCompare(right.id)
    })
    const start = (query.page - 1) * query.pageSize
    return {
      products: sorted.slice(start, start + query.pageSize),
      total: sorted.length,
      page: query.page,
      pageSize: query.pageSize,
      catalogSync: null,
      syncSource: null,
    }
  }
}
