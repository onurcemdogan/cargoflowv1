import { ChevronLeft, ChevronRight, RefreshCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { PageHeader } from '../components/PageHeader'
import { ProductDetailDrawer } from '../components/ProductDetailDrawer'
import {
  CATALOG_PAGE_SIZES,
  type CatalogArchiveFilter,
  type CatalogPage,
  type CatalogSort,
  type ProductCatalogSource,
} from '../services/productCatalogService'
import type {
  CargoOrder,
  ProductCatalogCacheMetadata,
  TrendyolProductSyncDebug,
  WorkflowResult,
} from '../types/cargoflow'
import {
  buildRevisionMismatch,
  FRONTEND_BUILD_REVISION,
} from '../utils/buildRevision'
import { formatCurrency, formatDisplayDate } from '../utils/formatters'

// ═══ ÜRÜN KATALOĞU TARAYICISI (CATALOG-001) ══════════════════════════════
//
// ÖLÇÜLEN KUSUR: ekran bellekteki TÜM katalogu (`products.map`) render
// ediyordu; sunucunun arama/arşiv/sıralama/sayfalama yetenekleri ekranın
// tarama sözleşmesi DEĞİLDİ. Artık ekran yalnız GÖRÜNEN sayfayı ister ve DOM
// boyutu sayfa boyutuyla SINIRLIDIR.
//
// Uygulamanın OPERASYONEL tam katalog önbelleği (etiket meta verisi, görsel
// eşleşmesi) bu ekrandan BAĞIMSIZDIR ve değişmedi.

/** Arama yazımı bitmeden sunucuya gidilmez. */
export const CATALOG_SEARCH_DEBOUNCE_MS = 300

const ARCHIVE_LABELS: Record<CatalogArchiveFilter, string> = {
  ACTIVE: 'Etkin',
  ARCHIVED: 'Arşivlenmiş',
  ALL: 'Tümü',
}

const SORT_LABELS: Record<CatalogSort, string> = {
  titleAsc: 'Ada göre (A–Z)',
  titleDesc: 'Ada göre (Z–A)',
  recent: 'Son güncellenen',
}

const SYNC_RESULT_LABELS: Record<string, string> = {
  success: 'Başarılı',
  partial: 'Kısmi',
  failed: 'Başarısız',
  running: 'Sürüyor',
}

interface ProductsPageProps {
  /** Tarama kaynağı (auth: sunucu; legacy geliştirme modu: yerel). */
  catalogSource: ProductCatalogSource
  /**
   * AKTİF HESAP NESLİ. Değişince önceki hesabın satırları BİR KARE BİLE
   * gösterilmez; sorgu ilk sayfadan yeniden başlar.
   */
  scopeKey: number | string
  /** Yalnız ilgili siparişi EN İYİ ÇABAYLA bulmak için yüklü siparişler. */
  orders: CargoOrder[]
  result?: WorkflowResult
  debug?: TrendyolProductSyncDebug
  metadata?: ProductCatalogCacheMetadata
  /** Açık kullanıcı aksiyonuyla ürün senkronu sürüyor mu? */
  syncBusy: boolean
  onSyncProducts: () => void | Promise<void>
}

type BrowserState =
  | { phase: 'loading'; scopeKey: number | string; data: null }
  | { phase: 'ready'; scopeKey: number | string; data: CatalogPage }
  | { phase: 'error'; scopeKey: number | string; data: null }

export function ProductsPage({
  catalogSource,
  scopeKey,
  orders,
  result,
  debug,
  metadata,
  syncBusy,
  onSyncProducts,
}: ProductsPageProps) {
  // Sayfa ve açık detay HESAP NESLİNE bağlıdır: nesil değişince türetilen
  // değer kendiliğinden ilk sayfaya / kapalı detaya döner (efekt GEREKMEZ).
  const [pageState, setPageState] = useState({ scopeKey, page: 1 })
  const page = pageState.scopeKey === scopeKey ? pageState.page : 1
  const setPage = (next: number) => setPageState({ scopeKey, page: next })
  const [pageSize, setPageSize] = useState<number>(CATALOG_PAGE_SIZES[0])
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [archive, setArchive] = useState<CatalogArchiveFilter>('ACTIVE')
  const [sort, setSort] = useState<CatalogSort>('titleAsc')
  const [reloadToken, setReloadToken] = useState(0)
  const [browser, setBrowser] = useState<BrowserState>({
    phase: 'loading',
    scopeKey,
    data: null,
  })
  const [activeState, setActiveState] = useState<{
    scopeKey: number | string
    id?: string
  }>({ scopeKey })
  const activeProductId = activeState.scopeKey === scopeKey ? activeState.id : undefined
  const setActiveProductId = (id?: string) => setActiveState({ scopeKey, id })
  const [localSyncing, setLocalSyncing] = useState(false)
  // İSTEK NESLİ: yalnız EN SON başlatılan isteğin yanıtı uygulanır. Yavaş
  // gelen eski bir arama ("abc") yeni aramanın ("abcd") sonucunu EZEMEZ.
  const generation = useRef(0)
  const syncInFlight = useRef(false)

  // Arama sunucu tarafındadır; yazım durulunca TEK istek atılır.
  useEffect(() => {
    const next = searchInput.trim()
    if (next === search) return
    const handle = setTimeout(() => {
      setSearch(next)
      // Arama değişti → ilk sayfa.
      setPageState({ scopeKey, page: 1 })
    }, CATALOG_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [searchInput, search, scopeKey])

  useEffect(() => {
    const requestGeneration = ++generation.current
    const controller = new AbortController()
    // Aynı hesapta mevcut sayfa yenisi gelene kadar görünür kalır; hesap
    // değiştiyse `visible` eski veriyi zaten GİZLER (aşağıda).
    catalogSource({ page, pageSize, search, archive, sort }, controller.signal)
      .then((data) => {
        if (requestGeneration !== generation.current) return
        const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize))
        if (page > pageCount) {
          // Filtre/senkron sonucu küçüldü: geçerli son sayfaya DETERMİNİSTİK iniş.
          setPageState({ scopeKey, page: pageCount })
          return
        }
        setBrowser({ phase: 'ready', scopeKey, data })
      })
      .catch(() => {
        if (requestGeneration !== generation.current) return
        setBrowser({ phase: 'error', scopeKey, data: null })
      })
    return () => controller.abort()
  }, [catalogSource, scopeKey, page, pageSize, search, archive, sort, reloadToken])

  // Başka bir hesabın verisi ASLA bu hesabın verisi gibi gösterilmez.
  const visible = browser.scopeKey === scopeKey ? browser : null
  const data = visible?.phase === 'ready' ? visible.data : null
  const rows = data?.products ?? []
  const activeProduct = rows.find((product) => product.id === activeProductId)
  const relatedOrder = useMemo(() => {
    if (!activeProduct) return undefined
    return orders.find((order) =>
      order.items.some(
        (item) =>
          item.barcode === activeProduct.barcode || item.sku === activeProduct.sku,
      ),
    )
  }, [activeProduct, orders])

  const backendRevision = debug?.backendBuildRevision ?? metadata?.backendBuildRevision
  const revisionMismatch = buildRevisionMismatch(FRONTEND_BUILD_REVISION, backendRevision)

  const total = data?.total ?? 0
  const effectivePageSize = data?.pageSize ?? pageSize
  const pageCount = Math.max(1, Math.ceil(total / effectivePageSize))
  const currentPage = data?.page ?? page
  const rangeStart = total === 0 ? 0 : (currentPage - 1) * effectivePageSize + 1
  const rangeEnd = Math.min(total, rangeStart + rows.length - 1)
  const syncUnavailable = data?.syncSource?.available === false
  const syncing = syncBusy || localSyncing

  const changeFilter = (apply: () => void) => {
    apply()
    setPage(1)
  }

  const runSync = async () => {
    // Çift tıklama: aynı anda YALNIZ BİR senkron (render beklemeden kilit).
    if (syncInFlight.current || syncBusy || syncUnavailable) return
    syncInFlight.current = true
    setLocalSyncing(true)
    try {
      await onSyncProducts()
    } finally {
      syncInFlight.current = false
      setLocalSyncing(false)
      // Görünen sayfa ve durum yenilenir; filtreler KORUNUR.
      setReloadToken((token) => token + 1)
    }
  }

  const emptyCopy = search
    ? 'Bu filtrelerle eşleşen ürün yok.'
    : archive === 'ARCHIVED'
      ? 'Arşivlenmiş ürün yok.'
      : data?.catalogSync?.lastSuccessfulSyncAt
        ? 'Katalogda gösterilecek ürün yok.'
        : 'Henüz ürün senkronize edilmedi.'

  return (
    <>
      <PageHeader
        title="Ürünler"
        description="Bağlı satış kanalındaki ürün ve varyantları yönetin."
        actions={
          <button
            type="button"
            className="secondary-button"
            onClick={() => void runSync()}
            disabled={syncing || syncUnavailable}
          >
            <RefreshCcw size={18} />
            {syncing ? 'Senkronize ediliyor…' : 'Ürünleri Senkronize Et'}
          </button>
        }
      />

      <ActionResult result={result} />

      {syncUnavailable ? (
        <p className="empty-state" role="note">
          Ürün senkronu için önce satış kanalı bağlantısını kaydedin.
        </p>
      ) : null}

      <section className="panel sync-overview" data-testid="product-catalog-status">
        <div>
          <span>Görünen varyant</span>
          <b data-testid="catalog-total">{data ? total.toLocaleString('tr-TR') : '—'}</b>
        </div>
        <div>
          <span>Görünüm</span>
          <b>{ARCHIVE_LABELS[archive]}</b>
        </div>
        <div>
          <span>Son başarılı senkron</span>
          <b>
            {data?.catalogSync?.lastSuccessfulSyncAt
              ? formatDisplayDate(data.catalogSync.lastSuccessfulSyncAt)
              : data?.catalogSync
                ? 'Kayıt yok'
                : '—'}
          </b>
        </div>
        <div>
          <span>Son senkron sonucu</span>
          <b>
            {syncing
              ? 'Sürüyor'
              : data?.catalogSync?.lastSyncStatus
                ? (SYNC_RESULT_LABELS[data.catalogSync.lastSyncStatus] ??
                  data.catalogSync.lastSyncStatus)
                : data?.catalogSync
                  ? 'Kayıt yok'
                  : '—'}
          </b>
        </div>
      </section>

      {revisionMismatch ? (
        <div className="action-result warning">
          Frontend ile API farklı commit revizyonunda çalışıyor. Her iki dev
          serverı da yeniden başlatın.
        </div>
      ) : null}

      <section className="panel catalog-toolbar" aria-label="Katalog filtreleri">
        <label>
          <span>Ara</span>
          <input
            type="search"
            aria-label="Ürün ara (ad, barkod, SKU, stok kodu)"
            placeholder="Ad, barkod, SKU veya stok kodu"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
        <label>
          <span>Durum</span>
          <select
            aria-label="Arşiv durumu"
            value={archive}
            onChange={(event) =>
              changeFilter(() => setArchive(event.target.value as CatalogArchiveFilter))
            }
          >
            {(Object.keys(ARCHIVE_LABELS) as CatalogArchiveFilter[]).map((key) => (
              <option key={key} value={key}>
                {ARCHIVE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Sıralama</span>
          <select
            aria-label="Sıralama"
            value={sort}
            onChange={(event) => changeFilter(() => setSort(event.target.value as CatalogSort))}
          >
            {(Object.keys(SORT_LABELS) as CatalogSort[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel">
        {visible?.phase === 'error' ? (
          <div className="empty-state" role="alert">
            <p>Ürünler yüklenemedi.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setBrowser({ phase: 'loading', scopeKey, data: null })
                setReloadToken((token) => token + 1)
              }}
            >
              Tekrar Dene
            </button>
          </div>
        ) : !data ? (
          <p className="empty-state" role="status">
            Ürünler yükleniyor…
          </p>
        ) : rows.length === 0 ? (
          <p className="empty-state" data-testid="catalog-empty">
            {emptyCopy}
          </p>
        ) : (
          <div className="table-shell">
            <table className="data-table" aria-label="Ürün kataloğu">
              <thead>
                <tr>
                  <th>Fotoğraf</th>
                  <th>Kanal</th>
                  <th>Ürün</th>
                  <th>SKU / Barkod</th>
                  <th>Kategori</th>
                  <th>Marka</th>
                  <th>Stok</th>
                  <th>Fiyat</th>
                  <th>Durum</th>
                  <th>Güncelleme</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((product) => (
                  <tr
                    key={product.id}
                    className="clickable-row"
                    data-product-row={product.id}
                    tabIndex={0}
                    onClick={() => setActiveProductId(product.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setActiveProductId(product.id)
                      }
                    }}
                  >
                    <td>
                      {product.imageUrl ? (
                        <img
                          className="table-product-image"
                          src={product.imageUrl}
                          alt={product.productName}
                          loading="lazy"
                        />
                      ) : (
                        <span className="image-mini-placeholder">Yok</span>
                      )}
                    </td>
                    <td>{product.marketplace}</td>
                    <td>
                      <strong>{product.productName}</strong>
                      <span>{product.externalProductId || '-'}</span>
                    </td>
                    <td>
                      <strong>{product.sku}</strong>
                      <span>{product.barcode}</span>
                    </td>
                    <td>{product.category || '-'}</td>
                    <td>{product.brand || '-'}</td>
                    <td>{product.stock}</td>
                    <td>{formatCurrency(product.price)}</td>
                    <td>
                      {(product as { archived?: boolean }).archived
                        ? 'Arşivlenmiş'
                        : product.productStatus || 'Etkin'}
                    </td>
                    <td>{formatDisplayDate(product.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <footer className="orders-pagination" aria-label="Ürün sayfalama">
          <span aria-live="polite" data-testid="catalog-range">
            {total === 0
              ? '0 ürün'
              : `${rangeStart.toLocaleString('tr-TR')}–${rangeEnd.toLocaleString('tr-TR')} / ${total.toLocaleString('tr-TR')}`}
          </span>
          <div>
            <label>
              <span>Sayfa boyutu</span>
              <select
                aria-label="Sayfa boyutu"
                value={pageSize}
                onChange={(event) => changeFilter(() => setPageSize(Number(event.target.value)))}
              >
                {CATALOG_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} / sayfa
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label="Önceki sayfa"
              disabled={!data || currentPage <= 1}
              // İSTENEN sayfadan adımlanır: hızlı ardışık tıklama kaybolmaz.
              onClick={() => setPage(Math.max(1, page - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span aria-current="page" data-testid="catalog-page">
              Sayfa {currentPage.toLocaleString('tr-TR')} / {pageCount.toLocaleString('tr-TR')}
            </span>
            <button
              type="button"
              aria-label="Sonraki sayfa"
              disabled={!data || currentPage >= pageCount}
              onClick={() => setPage(Math.min(pageCount, page + 1))}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </footer>
      </section>

      {/* Mühendislik telemetrisi ANA yüzeyden çıkarıldı ama SİLİNMEDİ:
          varsayılan KAPALI "Teknik detaylar" altında durur. */}
      <details className="panel technical-details" data-testid="catalog-technical-details">
        <summary>Teknik detaylar</summary>
        <div className="sync-overview">
          <div>
            <span>Senkron durumu</span>
            <b>{debug?.status ?? metadata?.syncStatus ?? 'CACHE YOK'}</b>
          </div>
          <div>
            <span>API kayıtları</span>
            <b>{debug?.rawApiRecordsCount ?? metadata?.expectedTotal ?? 0}</b>
          </div>
          <div>
            <span>Normalize</span>
            <b>{debug?.normalizedProductsCount ?? '-'}</b>
          </div>
          <div>
            <span>Varyant tekilleştirme</span>
            <b>{debug?.afterDedupCount ?? '-'}</b>
          </div>
          <div>
            <span>Products store</span>
            <b data-testid="products-store-count">{debug?.productsStoreCount ?? '-'}</b>
          </div>
          <div>
            <span>Persist edilen</span>
            <b>{debug?.persistedProductsCount ?? metadata?.actualCount ?? 0}</b>
          </div>
          <div>
            <span>Katalog revizyonu</span>
            <b>{debug?.catalogRevision ?? metadata?.catalogRevision ?? '-'}</b>
          </div>
          <div>
            <span>Frontend / API</span>
            <b className={revisionMismatch ? 'debug-fail' : 'debug-ok'}>
              {FRONTEND_BUILD_REVISION} / {backendRevision ?? '-'}
            </b>
          </div>
        </div>
      </details>

      {activeProduct ? (
        <ProductDetailDrawer
          product={activeProduct}
          relatedOrder={relatedOrder}
          relatedOrderBestEffort
          onClose={() => setActiveProductId(undefined)}
        />
      ) : null}
    </>
  )
}
