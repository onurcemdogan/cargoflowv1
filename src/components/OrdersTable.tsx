import {
  ChevronDown,
  ChevronRight,
  MoreVertical,
  MoveDown,
  MoveUp,
} from 'lucide-react'
import { Fragment, useState } from 'react'
import type { CargoOrder, CargoProduct, OrderItem } from '../types/cargoflow'
import { resolveNormalizedDesi } from '../utils/desi'
import { formatCurrency } from '../utils/formatters'
import {
  buildProductMatchDebug,
  resolveProductImageCandidates,
} from '../utils/productImage'
import {
  mapMarketplaceStatus,
  mapOperationStatus,
} from '../utils/statusPresentation'
import type {
  OrdersSortDirection,
  OrdersSortKey,
} from '../utils/ordersWorkspace'
import { verifySuratShipment } from '../utils/suratVerification'
import { ProductImageThumb } from './ProductImageThumb'
import { StatusBadge } from './StatusBadge'

interface OrdersTableProps {
  orders: CargoOrder[]
  products: CargoProduct[]
  selectedIds: string[]
  onToggleOrder: (orderId: string) => void
  onToggleAll: () => void
  onOpenOrder: (orderId: string) => void
  expandedOrderId?: string
  onToggleExpand: (orderId: string) => void
  sortKey: OrdersSortKey
  sortDirection: OrdersSortDirection
  onSortChange: (sortKey: OrdersSortKey) => void
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
  expandedOrderId,
  onToggleExpand,
  sortKey,
  sortDirection,
  onSortChange,
  onDesiChange,
  emptyMessage = 'Veri bulunamadı.',
  emptyDetails = [],
}: OrdersTableProps) {
  const [desiEditorOrderId, setDesiEditorOrderId] = useState<string>()
  const allSelected =
    orders.length > 0 && orders.every((order) => selectedIds.includes(order.id))

  return (
    <div className="orders-table-shell">
      <div className="orders-table-scroll">
        <table className="data-table operations-table orders-workspace-table">
          <thead>
            <tr>
              <th className="checkbox-cell">
                <input
                  type="checkbox"
                  aria-label="Bu sayfadaki siparişleri seç"
                  checked={allSelected}
                  onChange={onToggleAll}
                />
              </th>
              <SortableHeader
                label="Ürün"
                sortKey="orderDate"
                activeKey={sortKey}
                direction={sortDirection}
                onSortChange={onSortChange}
              />
              <SortableHeader
                label="Sipariş / Müşteri"
                sortKey="orderNumber"
                activeKey={sortKey}
                direction={sortDirection}
                onSortChange={onSortChange}
              />
              <SortableHeader
                label="Durum"
                sortKey="status"
                activeKey={sortKey}
                direction={sortDirection}
                onSortChange={onSortChange}
              />
              <SortableHeader
                label="Kargo"
                sortKey="cargo"
                activeKey={sortKey}
                direction={sortDirection}
                onSortChange={onSortChange}
              />
              <th>İşlemler</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const selected = selectedIds.includes(order.id)
              const expanded = expandedOrderId === order.id
              const firstItem = order.items[0]
              const imageCandidates = firstItem
                ? imageUrls(firstItem, products)
                : []
              logUnresolvedImage(order, firstItem, imageCandidates, products)
              const suratVerification = verifySuratShipment(order)
              const operationStatus = mapOperationStatus(order)
              const marketplaceStatus = mapMarketplaceStatus(
                order.marketplace,
                order.marketplaceStatus,
              )
              const normalizedDesi = resolveNormalizedDesi(order)
              const editingDesi = desiEditorOrderId === order.id

              return (
                <Fragment key={order.id}>
                  <tr className={selected ? 'selected-row' : undefined}>
                    <td className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label={`${order.orderNumber} seç`}
                        checked={selected}
                        onChange={() => onToggleOrder(order.id)}
                      />
                    </td>
                    <td>
                      <div className="order-product-cell orders-product-summary">
                        <button
                          type="button"
                          className="orders-expand-button"
                          aria-label={`${order.orderNumber} satırını ${expanded ? 'kapat' : 'aç'}`}
                          aria-expanded={expanded}
                          onClick={() => onToggleExpand(order.id)}
                        >
                          {expanded ? (
                            <ChevronDown size={17} />
                          ) : (
                            <ChevronRight size={17} />
                          )}
                        </button>
                        <ProductImageThumb
                          candidates={imageCandidates}
                          alt={firstItem?.productName ?? ''}
                        />
                        <div>
                          <strong>{productSummary(order)}</strong>
                          <span>
                            {order.items.length} kalem, {totalQuantity(order)} adet
                          </span>
                          <span>
                            {[firstItem?.color, firstItem?.size]
                              .filter(Boolean)
                              .join(' / ') || '-'}
                          </span>
                          <span>Barkod: {firstItem?.barcode || '-'}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <strong>{order.orderNumber}</strong>
                      <span>{order.customerName || '-'}</span>
                      <span>
                        {order.city || '-'} / {order.district || '-'}
                      </span>
                      <span>{order.customerPhone || '-'}</span>
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
                        {order.cargoProviderName ||
                          (order.shipment ? 'Sürat Kargo' : 'Bekliyor')}
                      </strong>
                      <span>Takip: {suratVerification.trackingNumber || '-'}</span>
                      <span>T.No: {suratVerification.tNo || '-'}</span>
                      <span>
                        Desi:{' '}
                        {normalizedDesi.desi != null
                          ? normalizedDesi.desi.toLocaleString('tr-TR', {
                              maximumFractionDigits: 2,
                            })
                          : '-'}
                      </span>
                      {editingDesi && onDesiChange ? (
                        <label className="orders-inline-desi-editor">
                          <span>Toplam koli desisi</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            autoFocus
                            aria-label={`${order.orderNumber} Toplam koli desisi`}
                            value={normalizedDesi.desi ?? ''}
                            placeholder="Desi girin"
                            onChange={(event) => {
                              const value = Number(
                                event.target.value.replace(',', '.'),
                              )
                              onDesiChange(
                                order.id,
                                Number.isFinite(value) && value > 0
                                  ? value
                                  : null,
                                Number.isFinite(value) && value > 0
                                  ? 'manual_total'
                                  : null,
                              )
                            }}
                          />
                        </label>
                      ) : null}
                    </td>
                    <td>
                      <div className="orders-row-actions">
                        <button
                          type="button"
                          className="orders-compact-button"
                          onClick={() => onOpenOrder(order.id)}
                        >
                          Detay
                        </button>
                        {onDesiChange ? (
                          <button
                            type="button"
                            className="orders-compact-button"
                            aria-label={`${order.orderNumber} Toplam koli desisi`}
                            aria-expanded={editingDesi}
                            onClick={() =>
                              setDesiEditorOrderId(
                                editingDesi ? undefined : order.id,
                              )
                            }
                          >
                            Desi Gir
                          </button>
                        ) : null}
                        <details className="orders-more-menu">
                          <summary aria-label={`${order.orderNumber} diğer işlemler`}>
                            <MoreVertical size={17} />
                          </summary>
                          <div>
                            <button
                              type="button"
                              onClick={() => onOpenOrder(order.id)}
                            >
                              Sipariş detayını aç
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleExpand(order.id)}
                            >
                              {expanded ? 'Satırı kapat' : 'Satırı genişlet'}
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleOrder(order.id)}
                            >
                              {selected ? 'Seçimi kaldır' : 'Siparişi seç'}
                            </button>
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="orders-expanded-row">
                      <td colSpan={6}>
                        <ExpandedOrderSummary order={order} products={products} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {orders.length === 0 ? (
        <div className="empty-state">
          <strong>{emptyMessage}</strong>
          {emptyDetails.length > 0 ? (
            <ul>
              {emptyDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSortChange,
}: {
  label: string
  sortKey: OrdersSortKey
  activeKey: OrdersSortKey
  direction: OrdersSortDirection
  onSortChange: (key: OrdersSortKey) => void
}) {
  const active = activeKey === sortKey
  return (
    <th>
      <button
        type="button"
        className={active ? 'orders-sort-button active' : 'orders-sort-button'}
        aria-label={`${label} sütununu sırala`}
        onClick={() => onSortChange(sortKey)}
      >
        {label}
        {active && direction === 'asc' ? (
          <MoveUp size={13} />
        ) : active ? (
          <MoveDown size={13} />
        ) : null}
      </button>
    </th>
  )
}

function ExpandedOrderSummary({
  order,
  products,
}: {
  order: CargoOrder
  products: CargoProduct[]
}) {
  const subtotal = calculateSubtotal(order)
  const payment = [order.paymentType, order.paymentMode].filter(Boolean).join(' / ')
  const neighborhood = readAddressValue(order.shipmentAddress, [
    'neighborhood',
    'neighborhoodName',
  ])
  const postalCode = readAddressValue(order.shipmentAddress, [
    'postalCode',
    'zipCode',
  ])

  return (
    <div className="orders-expanded-layout">
      <section className="orders-expanded-products">
        <h3>Sipariş Ürünleri ({order.items.length})</h3>
        <div className="orders-item-table-scroll">
          <table className="orders-item-table">
            <thead>
              <tr>
                <th>Ürün</th>
                <th>Varyant</th>
                <th>SKU</th>
                <th>Barkod</th>
                <th>Adet</th>
                <th>Birim Fiyat</th>
                <th>Toplam</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => {
                const lineTotal =
                  item.price != null
                    ? item.price * Math.max(1, Number(item.quantity) || 1)
                    : undefined
                return (
                  <tr key={item.id}>
                    <td>
                      <div className="orders-expanded-product">
                        <ProductImageThumb
                          candidates={imageUrls(item, products)}
                          alt={item.productName}
                        />
                        <strong>{item.productName || '-'}</strong>
                      </div>
                    </td>
                    <td>{variantSummary(item)}</td>
                    <td>{item.merchantSku || item.sku || '-'}</td>
                    <td>{item.barcode || '-'}</td>
                    <td>{Math.max(1, Number(item.quantity) || 1)}</td>
                    <td>
                      {item.price != null ? formatCurrency(item.price) : '-'}
                    </td>
                    <td>{lineTotal != null ? formatCurrency(lineTotal) : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="orders-expanded-card">
        <h3>Sipariş Özeti</h3>
        <SummaryLine label="Ara Toplam" value={currencyOrDash(subtotal)} />
        <SummaryLine label="Kargo" value="-" />
        <SummaryLine label="İndirim" value="-" />
        <SummaryLine
          label="Toplam Tutar"
          value={currencyOrDash(finiteNumber(order.totalAmount))}
          strong
        />
        <SummaryLine label="Ödeme" value={payment || '-'} />
      </section>
      <section className="orders-expanded-card">
        <h3>Teslimat Bilgisi</h3>
        <SummaryLine label="Alıcı" value={order.customerName || '-'} />
        <SummaryLine label="Telefon" value={order.customerPhone || '-'} />
        <SummaryLine label="Adres" value={order.address || '-'} />
        <SummaryLine label="İl" value={order.city || '-'} />
        <SummaryLine label="İlçe" value={order.district || '-'} />
        <SummaryLine label="Mahalle" value={neighborhood || '-'} />
        <SummaryLine label="Posta Kodu" value={postalCode || '-'} />
      </section>
    </div>
  )
}

function SummaryLine({
  label,
  value,
  strong = false,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className={strong ? 'orders-summary-line strong' : 'orders-summary-line'}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

function imageUrls(item: OrderItem, products: CargoProduct[]): string[] {
  return resolveProductImageCandidates(item, products).map(
    (candidate) => candidate.url,
  )
}

function logUnresolvedImage(
  order: CargoOrder,
  item: OrderItem | undefined,
  candidates: string[],
  products: CargoProduct[],
) {
  if (!import.meta.env.DEV || !item || candidates.length > 0) return
  const debug = buildProductMatchDebug(item, products)
  console.info('[orders] ORDER_IMAGE_UNRESOLVED', {
    orderNumber: order.orderNumber,
    lineId: item.id,
    barcode: item.barcode,
    productName: item.productName,
    catalogRevision: products.length,
    matchedBy: debug.matchedBy,
    failureReason: debug.finalFailureReason,
  })
}

function totalQuantity(order: CargoOrder): number {
  return order.items.reduce(
    (total, item) => total + Math.max(0, Number(item.quantity) || 0),
    0,
  )
}

function productSummary(order: CargoOrder): string {
  const firstName = order.items[0]?.productName || '-'
  return order.items.length > 1
    ? `${firstName} +${order.items.length - 1} ürün`
    : firstName
}

function variantSummary(item: OrderItem): string {
  const values = [item.color, item.size].filter(Boolean)
  if (values.length > 0) return values.join(' / ')
  return (
    item.variantAttributes
      ?.map((attribute) => `${attribute.name}: ${attribute.value}`)
      .join(' / ') || '-'
  )
}

function calculateSubtotal(order: CargoOrder): number | undefined {
  if (!order.items.length || order.items.some((item) => item.price == null)) {
    return undefined
  }
  return order.items.reduce(
    (total, item) =>
      total + Number(item.price) * Math.max(1, Number(item.quantity) || 1),
    0,
  )
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function currencyOrDash(value?: number): string {
  return value == null ? '-' : formatCurrency(value)
}

function readAddressValue(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  return keys
    .map((key) => String(record[key] ?? '').trim())
    .find(Boolean) ?? ''
}
