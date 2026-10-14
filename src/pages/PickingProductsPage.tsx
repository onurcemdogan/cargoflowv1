import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCcw,
  Search,
} from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { ProductImageThumb } from '../components/ProductImageThumb'
import {
  buildPickingWorkspace,
  type PickingWorkspaceResult,
} from '../dashboard/pickingWorkspace'
import { fetchPickingWorkspace } from '../services/pickingWorkspaceService'
import type { CargoOrder, CargoProduct } from '../types/cargoflow'
import { Alert, Badge, Card, EmptyState } from '../ui/primitives'

interface PickingProductsPageProps {
  orders: CargoOrder[]
  products?: CargoProduct[]
  useServerState: boolean
  dataSourceResolved: boolean
  lastSyncedAt?: string
  onOpenOrder: (orderId: string) => void
}

export function PickingProductsPage({
  orders,
  products = [],
  useServerState,
  dataSourceResolved,
  lastSyncedAt,
  onOpenOrder,
}: PickingProductsPageProps) {
  const [search, setSearch] = useState('')
  const [stage, setStage] = useState('')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const query = useMemo(() => ({ search, stage, page }), [search, stage, page])
  const key = JSON.stringify([query, lastSyncedAt, refresh])
  const [response, setResponse] = useState<{
    key: string
    result?: PickingWorkspaceResult
    error?: string
  }>()
  useEffect(() => {
    if (!dataSourceResolved || !useServerState) return
    let active = true
    // Debounce search; filtering only reads persisted state, with no provider operation.
    const timer = setTimeout(() => {
      fetchPickingWorkspace(query).then(
        (result) => {
          if (active) setResponse({ key, result })
        },
        () => {
          if (active)
            setResponse({ key, error: 'Toplama listesi yüklenemedi.' })
        },
      )
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [dataSourceResolved, useServerState, key, query])
  const local = useMemo(
    () =>
      !useServerState && dataSourceResolved
        ? buildPickingWorkspace(orders, products, query)
        : undefined,
    [useServerState, dataSourceResolved, orders, products, query],
  )
  const result = useServerState
    ? response?.key === key
      ? response.result
      : undefined
    : local
  const error =
    useServerState && response?.key === key ? response.error : undefined
  const loading = !result && !error
  // Keep available filter choices while a new request is in flight.
  const stages =
    result?.stages ??
    (useServerState ? response?.result?.stages : local?.stages) ??
    []
  return (
    <div className="picking-workspace" data-testid="picking-workspace">
      <PageHeader
        tourId="picking-workspace"
        title="Toplanacak Ürünler"
        description="Baskıya gönderilmeyi bekleyen siparişlerin ürün listesi. Tüm tarihlerdeki kalan işler."
        actions={
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCcw size={15} /> Yenile
          </button>
        }
      />
      <div className="picking-workspace-summary" aria-label="Toplama özeti">
        {[
          ['Kalan adet', result?.totalQuantity],
          ['Ürün ailesi', result?.totalFamilyCount],
          ['İlgili sipariş', result?.orderCount],
        ].map(([label, value]) => (
          <Card key={label} className="picking-kpi">
            <small>{label}</small>
            <strong>
              {typeof value === 'number' ? value.toLocaleString('tr-TR') : '—'}
            </strong>
          </Card>
        ))}
      </div>
      <p className="picking-state-note">
        Baskıya gönderilen siparişler listeden çıkar. Toplama tamamlama kaydı
        bulunmadığı için yalnız kalan adet gösterilir.
      </p>
      <Card className="picking-workspace-list">
        <div className="picking-toolbar">
          <label className="picking-search">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="Toplanacak ürünlerde ara"
              placeholder="Ürün, SKU, barkod veya sipariş ara…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(0)
                setExpanded(undefined)
              }}
            />
          </label>
          <label className="picking-stage-filter">
            İçerdiği aşama
            <select
              aria-label="Operasyon aşaması"
              value={stage}
              onChange={(event) => {
                setStage(event.target.value)
                setPage(0)
                setExpanded(undefined)
              }}
            >
              <option value="">Tüm aşamalar</option>
              {stages.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? (
          <Alert tone="danger" title={error} role="alert">
            <button
              type="button"
              className="text-button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Tekrar dene
            </button>
          </Alert>
        ) : loading ? (
          <div
            className="ui-skeleton-list"
            role="status"
            aria-label="Toplama listesi yükleniyor"
          >
            <i />
            <i />
            <i />
          </div>
        ) : result ? (
          <>
            <div className="picking-result-count" role="status">
              {result.filteredFamilyCount} ürün ailesi · Sayfa {result.page + 1}{' '}
              / {result.pageCount}
            </div>
            {result.products.length === 0 ? (
              <EmptyState
                compact
                kind={search || stage ? 'search' : 'done'}
                title={
                  search || stage
                    ? 'Eşleşen ürün yok'
                    : 'Toplanacak ürün kalmadı'
                }
                body={
                  search || stage
                    ? 'Arama veya aşama filtresini değiştirin.'
                    : 'Yeni bekleyen siparişler geldiğinde burada görünür.'
                }
              />
            ) : (
              result.products.map((product) => (
                <article
                  key={product.key}
                  className="picking-product"
                  data-testid="picking-product"
                >
                  <div className="picking-product-main">
                    <ProductImageThumb
                      candidates={product.imageCandidates}
                      alt={product.productName}
                      className="picking-product-image"
                      placeholderClassName="picking-product-image"
                    />
                    <div className="picking-product-identity">
                      <h2>{product.productName}</h2>
                      {product.color ? <span>{product.color}</span> : null}
                      <small>
                        SKU: {product.sku || '—'} · Barkod:{' '}
                        {product.barcode || '—'}
                      </small>
                    </div>
                    <div className="picking-product-quantity">
                      <strong>
                        {product.quantity.toLocaleString('tr-TR')}{' '}
                        <small>adet</small>
                      </strong>
                      <span>{product.orderCount} sipariş · kalan</span>
                    </div>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      aria-expanded={expanded === product.key}
                      aria-controls={`picking-orders-${encodeURIComponent(product.key)}`}
                      onClick={() =>
                        setExpanded(
                          expanded === product.key ? undefined : product.key,
                        )
                      }
                    >
                      Siparişler <ChevronDown size={15} />
                    </button>
                  </div>
                  <div className="picking-product-meta">
                    <div className="picking-variants">
                      {product.variants.map((variant) => (
                        <Badge key={variant.sizeKey}>
                          {variant.size} · {variant.quantity} adet
                        </Badge>
                      ))}
                    </div>
                    <div className="picking-stages">
                      {product.stageBreakdown.map((entry) => (
                        <span key={entry.stage}>
                          {entry.label}: <b>{entry.count}</b>
                        </span>
                      ))}
                    </div>
                  </div>
                  {expanded === product.key ? (
                    <div
                      className="picking-related-orders"
                      id={`picking-orders-${encodeURIComponent(product.key)}`}
                    >
                      <dl
                        className="picking-variant-details"
                        aria-label="Beden ve ürün kodları"
                      >
                        {product.variants.map((variant) => (
                          <div key={variant.sizeKey}>
                            <dt>
                              {variant.size} · {variant.quantity} adet
                            </dt>
                            <dd>
                              SKU: {variant.skus?.join(', ') || '—'}
                              <br />
                              Barkod: {variant.barcodes?.join(', ') || '—'}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {product.orders.map((order) => (
                        <button
                          key={order.orderId}
                          type="button"
                          className="picking-order-link"
                          onClick={() => onOpenOrder(order.orderId)}
                        >
                          <span>
                            <b>{order.displayOrderNumber}</b>
                            <small>
                              {order.size} · {order.quantity} adet
                            </small>
                          </span>
                          <span>{order.operationStatusLabel}</span>
                          <ArrowRight size={15} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))
            )}
            <div className="picking-pagination">
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={result.page === 0}
                onClick={() => {
                  setPage(result.page - 1)
                  setExpanded(undefined)
                }}
              >
                <ChevronLeft size={14} /> Önceki
              </button>
              <span>{result.filteredFamilyCount} sonuç</span>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={result.page + 1 >= result.pageCount}
                onClick={() => {
                  setPage(result.page + 1)
                  setExpanded(undefined)
                }}
              >
                Sonraki <ChevronRight size={14} />
              </button>
            </div>
          </>
        ) : null}
      </Card>
    </div>
  )
}
