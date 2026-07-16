import { Maximize2, Minimize2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CargoOrder, CargoProduct } from '../types/cargoflow'
import { formatCurrency, formatDisplayDate } from '../utils/formatters'
import { BarcodePreview } from './BarcodePreview'
import { LabelHtmlPreview } from './LabelHtmlPreview'

interface ProductDetailDrawerProps {
  product: CargoProduct
  relatedOrder?: CargoOrder
  onClose: () => void
}

type ProductTab = 'details' | 'label'

export function ProductDetailDrawer({
  product,
  relatedOrder,
  onClose,
}: ProductDetailDrawerProps) {
  const images = useMemo(() => {
    const values = [product.imageUrl, ...(product.images ?? [])].filter(Boolean)
    return Array.from(new Set(values)) as string[]
  }, [product.imageUrl, product.images])
  const [activeImage, setActiveImage] = useState(images[0] ?? '')
  const [zoomed, setZoomed] = useState(false)
  const [activeTab, setActiveTab] = useState<ProductTab>('details')
  const selectedImage = images.includes(activeImage)
    ? activeImage
    : images[0] ?? ''

  return (
    <div className="drawer-backdrop" role="presentation">
      <aside className="detail-drawer product-drawer" aria-label="Ürün detayı">
        <div className="drawer-header">
          <div>
            <span className="eyebrow">{product.marketplace}</span>
            <h2>{product.productName}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="drawer-tabs">
          <button
            type="button"
            className={activeTab === 'details' ? 'active' : ''}
            onClick={() => setActiveTab('details')}
          >
            Ürün Bilgisi
          </button>
          <button
            type="button"
            className={activeTab === 'label' ? 'active' : ''}
            onClick={() => setActiveTab('label')}
          >
            Etiket Önizleme
          </button>
        </div>

        {activeTab === 'details' ? (
          <div className="drawer-content">
            <section className="product-visual-panel">
              <div className={zoomed ? 'product-main-image zoomed' : 'product-main-image'}>
                {selectedImage ? (
                  <img src={selectedImage} alt={product.productName} />
                ) : (
                  <div className="image-placeholder">Fotoğraf yok</div>
                )}
                {selectedImage ? (
                  <button
                    type="button"
                    className="image-zoom-button"
                    onClick={() => setZoomed((current) => !current)}
                  >
                    {zoomed ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                    {zoomed ? 'Küçült' : 'Zoom'}
                  </button>
                ) : null}
              </div>
              {images.length > 1 ? (
                <div className="thumbnail-row">
                  {images.map((image) => (
                    <button
                      type="button"
                      key={image}
                      className={image === selectedImage ? 'active' : ''}
                      onClick={() => setActiveImage(image)}
                    >
                      <img src={image} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="detail-section">
              <h3>Ürün Bilgileri</h3>
              <div className="detail-grid">
                <Detail label="Trendyol Ürün ID" value={product.externalProductId} />
                <Detail label="Barkod" value={product.barcode} />
                <Detail label="SKU" value={product.sku} />
                <Detail label="Stok Kodu" value={product.stockCode} />
                <Detail label="Kategori" value={product.category} />
                <Detail label="Marka" value={product.brand} />
                <Detail label="Renk" value={product.color} />
                <Detail label="Beden" value={product.size} />
                <Detail label="Fiyat" value={formatCurrency(product.price)} />
                <Detail label="Stok" value={String(product.stock)} />
                <Detail label="Durum" value={product.productStatus} />
                <Detail label="Desi" value={formatNumber(product.desi)} />
                <Detail label="Kg" value={formatNumber(product.kg)} />
                <Detail
                  label="Oluşturulma Tarihi"
                  value={formatOptionalDate(product.createdAt)}
                />
                <Detail
                  label="Son Senkronizasyon Tarihi"
                  value={formatOptionalDate(product.updatedAt)}
                />
              </div>
            </section>

            <section className="barcode-card">
              <div className="panel-heading compact">
                <h3>Barkod Önizleme</h3>
                <span>Code128</span>
              </div>
              <div className="barcode-meta">
                <span>Barkod değeri</span>
                <strong>{product.barcode || '-'}</strong>
                <span>Barkod tipi</span>
                <strong>Code128</strong>
              </div>
              <BarcodePreview value={product.barcode} />
            </section>
          </div>
        ) : (
          <div className="drawer-content">
            <section className="detail-section">
              <h3>Etiket Önizleme</h3>
              <LabelHtmlPreview order={relatedOrder} productName={product.productName} />
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}

function Detail({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  )
}

function formatNumber(value?: number): string {
  if (value == null || Number.isNaN(value)) return '-'
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(value)
}

function formatOptionalDate(value?: string): string {
  if (!value) return '-'
  return formatDisplayDate(value)
}
