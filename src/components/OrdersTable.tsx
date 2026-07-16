import { useState } from 'react'
import type { CargoOrder, CargoProduct } from '../types/cargoflow'
import { resolveProductImage } from '../utils/productImage'
import { resolveNormalizedDesi } from '../utils/desi'
import {
  mapMarketplaceStatus,
  mapOperationStatus,
} from '../utils/statusPresentation'
import { verifySuratShipment } from '../utils/suratVerification'
import { StatusBadge } from './StatusBadge'

interface OrdersTableProps {
  orders: CargoOrder[]
  products: CargoProduct[]
  selectedIds: string[]
  onToggleOrder: (orderId: string) => void
  onToggleAll: () => void
  onOpenOrder: (orderId: string) => void
  onDesiChange?: (
    orderId: string,
    desi: number | null,
    desiSource: CargoOrder['desiSource'],
  ) => void
  emptyMessage?: string
  emptyDetails?: string[]
}

export function OrdersTable({
  orders,
  products,
  selectedIds,
  onToggleOrder,
  onToggleAll,
  onOpenOrder,
  onDesiChange,
  emptyMessage = 'Veri bulunamadı.',
  emptyDetails = [],
}: OrdersTableProps) {
  const allSelected =
    orders.length > 0 && orders.every((order) => selectedIds.includes(order.id))

  return (
    <div className="table-shell">
      <table className="data-table operations-table">
        <thead>
          <tr>
            <th className="checkbox-cell">
              <input
                type="checkbox"
                aria-label="Görünür siparişleri seç"
                checked={allSelected}
                onChange={onToggleAll}
                onClick={(event) => event.stopPropagation()}
              />
            </th>
            <th>Ürün</th>
            <th>Sipariş / Müşteri</th>
            <th>Durum</th>
            <th>Kargo</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const selected = selectedIds.includes(order.id)
            const firstItem = order.items[0]
            const imageResolution = firstItem
              ? resolveProductImage(firstItem, products)
              : undefined
            const suratVerification = verifySuratShipment(order)
            const operationStatus = mapOperationStatus(order)
            const marketplaceStatus = mapMarketplaceStatus(
              order.marketplace,
              order.marketplaceStatus,
            )
            const normalizedDesi = resolveNormalizedDesi(order)

            return (
              <tr
                key={order.id}
                className={selected ? 'selected-row clickable-row' : 'clickable-row'}
                onClick={() => onOpenOrder(order.id)}
              >
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    aria-label={`${order.orderNumber} seç`}
                    checked={selected}
                    onChange={() => onToggleOrder(order.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </td>
                <td>
                  <div className="order-product-cell">
                    <OrderProductImage
                      src={imageResolution?.url}
                      alt={firstItem?.productName ?? ''}
                    />
                    <div>
                      <strong>{productSummary(order)}</strong>
                      <span>
                        {order.items.length} kalem, {totalQuantity(order)} adet
                      </span>
                      <span>
                        {[
                          firstItem?.color,
                          firstItem?.size,
                          firstItem?.merchantSku || firstItem?.sku,
                        ]
                          .filter(Boolean)
                          .join(' / ') || '-'}
                      </span>
                      <span>
                        Barkod: {firstItem?.barcode || '-'}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <strong>{order.orderNumber}</strong>
                  <span>{order.customerName}</span>
                  <span>
                    {order.city || '-'} / {order.district || '-'}
                  </span>
                </td>
                <td>
                  <StatusBadge
                    status={operationStatus.label}
                    tone={operationStatus.color}
                    title={operationStatus.description}
                  />
                  <span
                    className="marketplace-status-copy"
                    title={marketplaceStatus.description}
                  >
                    Pazaryeri: {marketplaceStatus.label}
                  </span>
                  <span className="marketplace-status-copy">
                    Kaynak: {operationStatus.sourceLabel || 'CargoFlow'}
                  </span>
                </td>
                <td>
                  <strong>
                    {order.shipment
                      ? order.cargoProviderName || 'Sürat Kargo'
                      : order.cargoProviderName || 'Bekliyor'}
                  </strong>
                  <span>
                    Takip: {suratVerification.trackingNumber || 'yok'}
                  </span>
                  <span>
                    Barkod: {suratVerification.officialBarcodeValue || 'yok'}
                  </span>
                  <span>T.No: {suratVerification.tNo || '-'}</span>
                  {onDesiChange ? (
                    <label
                      className="order-desi-editor"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span>Top Ds/Kg</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        aria-label={`${order.orderNumber} Top Ds/Kg`}
                        value={normalizedDesi.desi ?? ''}
                        placeholder="Desi girin"
                        onChange={(event) => {
                          const value = Number(
                            event.target.value.replace(',', '.'),
                          )
                          onDesiChange(
                            order.id,
                            Number.isFinite(value) && value > 0 ? value : null,
                            Number.isFinite(value) && value > 0
                              ? 'manual'
                              : null,
                          )
                        }}
                      />
                      <small>
                        {normalizedDesi.desiSource
                          ? `Kaynak: ${normalizedDesi.desiSource}`
                          : 'Gönderi öncesi zorunlu'}
                      </small>
                    </label>
                  ) : null}
                  {suratVerification.verifiedShipment ? (
                    <span className="surat-verified-badge">Sürat doğrulandı</span>
                  ) : null}
                  {order.shipment?.carrierStatusLabel ? (
                    <span>{order.shipment.carrierStatusLabel}</span>
                  ) : null}
                  {(order.label?.printCount ?? 0) > 1 ? (
                    <span>Tekrar baskı: {(order.label?.printCount ?? 1) - 1} kez</span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {orders.length === 0 ? (
        <div className="empty-state">
          <strong>{emptyMessage}</strong>
          {emptyDetails.length > 0 ? (
            <ul>
              {emptyDetails.map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function OrderProductImage({
  src,
  alt,
}: {
  src?: string
  alt: string
}) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <span className="order-image-placeholder">Görsel yok</span>
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

function totalQuantity(order: CargoOrder): number {
  return order.items.reduce((total, item) => total + item.quantity, 0)
}

function productSummary(order: CargoOrder): string {
  if (order.items.length === 1) return order.items[0]?.productName || '-'
  return `${order.items.length} ürün`
}
