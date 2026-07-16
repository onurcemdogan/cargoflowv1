import { RefreshCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ActionResult } from '../components/ActionResult'
import { PageHeader } from '../components/PageHeader'
import { ProductDetailDrawer } from '../components/ProductDetailDrawer'
import type { CargoOrder, CargoProduct, WorkflowResult } from '../types/cargoflow'
import { formatCurrency, formatDisplayDate } from '../utils/formatters'

interface ProductsPageProps {
  products: CargoProduct[]
  orders: CargoOrder[]
  result?: WorkflowResult
  busy: boolean
  onFetchProducts: () => void
}

export function ProductsPage({
  products,
  orders,
  result,
  busy,
  onFetchProducts,
}: ProductsPageProps) {
  const [activeProductId, setActiveProductId] = useState<string>()
  const activeProduct = products.find((product) => product.id === activeProductId)
  const relatedOrder = useMemo(() => {
    if (!activeProduct) return undefined

    return orders.find((order) =>
      order.items.some(
        (item) =>
          item.barcode === activeProduct.barcode || item.sku === activeProduct.sku,
      ),
    )
  }, [activeProduct, orders])

  return (
    <>
      <PageHeader
        title="Ürünler"
        description="Trendyol ürün kataloğunu canlı API verisiyle izle."
        actions={
          <button
            type="button"
            className="secondary-button"
            onClick={onFetchProducts}
            disabled={busy}
          >
            <RefreshCcw size={18} />
            Ürünleri Çek
          </button>
        }
      />

      <ActionResult result={result} />

      <section className="panel">
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>Fotoğraf</th>
                <th>Pazaryeri</th>
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
              {products.map((product) => (
                <tr
                  key={product.id}
                  className="clickable-row"
                  onClick={() => setActiveProductId(product.id)}
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
                  <td>{product.productStatus || '-'}</td>
                  <td>{formatDisplayDate(product.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {activeProduct ? (
        <ProductDetailDrawer
          product={activeProduct}
          relatedOrder={relatedOrder}
          onClose={() => setActiveProductId(undefined)}
        />
      ) : null}
      {products.length === 0 ? (
        <p className="empty-state">Veri bulunamadı. Ürünler canlı API senkronizasyonundan sonra listelenir.</p>
      ) : null}
    </>
  )
}
