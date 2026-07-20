// Normalized Trendyol siparişi ↔ DB satır eşlemesi. MARKETPLACE alanları
// (fresh sync günceller) ile OPERASYONEL alanlar (operation_status, archived —
// korunur) AÇIKÇA ayrılır. PII/adres ve raw payload şifreli tutulur.
import { encryptOrderPayload, decryptOrderPayload } from './orderEncryption.ts'

function str(value: unknown): string {
  return String(value ?? '').trim()
}
function num(value: unknown): string | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(parsed) : null
}
function toDate(value: unknown): Date {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? new Date(time) : new Date(0)
}
function optionalDate(value: unknown): Date | null {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? new Date(time) : null
}

// Sipariş INSERT değerleri (ilk görülme). operation_status başlangıçta
// marketplace'ten türetilir; sonraki sync'lerde EZİLMEZ (bkz. marketplaceSet).
export function toOrderInsertValues(
  organizationId: string,
  order: Record<string, unknown>,
): Record<string, unknown> {
  const address = (order.shipmentAddress ?? order.address ?? null) as unknown
  return {
    organizationId,
    marketplace: str(order.marketplace) || 'Trendyol',
    packageId: str(order.packageId ?? order.shipmentPackageId),
    orderNumber: str(order.orderNumber) || str(order.packageId),
    externalOrderId: str(order.externalOrderId) || null,
    marketplaceStatus: str(order.marketplaceStatus) || null,
    operationStatus: str(order.operationStatus) || null,
    customerFirstName: str(order.customerFirstName) || null,
    customerLastName: str(order.customerLastName) || null,
    customerEmail: str(order.customerEmail) || null,
    customerPhone: str(order.customerPhone) || null,
    shippingAddressEncrypted: encryptOrderPayload(address),
    shippingCity: str(order.city) || null,
    shippingDistrict: str(order.district) || null,
    cargoProviderName: str(order.cargoProviderName) || null,
    cargoTrackingNumber: str(order.cargoTrackingNumber) || null,
    cargoSenderNumber: str(order.cargoSenderNumber) || null,
    cargoTrackingLink: str(order.cargoTrackingLink) || null,
    totalAmount: num(order.totalAmount ?? order.totalPrice),
    currency: str(order.currency) || null,
    orderDate: toDate(order.orderDate ?? order.createdAt),
    marketplaceLastModifiedAt: optionalDate(
      order.lastModifiedDate ?? order.marketplaceLastModifiedAt,
    ),
    rawPayloadEncrypted: encryptOrderPayload(order.rawOrder ?? order),
  }
}

// Conflict UPDATE: YALNIZ marketplace kaynaklı alanlar güncellenir. operation_
// status, archived_at, first_seen_at, created_at KORUNUR (operasyonel state).
export function marketplaceUpdateSet(
  order: Record<string, unknown>,
): Record<string, unknown> {
  return {
    orderNumber: str(order.orderNumber) || str(order.packageId),
    externalOrderId: str(order.externalOrderId) || null,
    marketplaceStatus: str(order.marketplaceStatus) || null,
    customerFirstName: str(order.customerFirstName) || null,
    customerLastName: str(order.customerLastName) || null,
    customerEmail: str(order.customerEmail) || null,
    customerPhone: str(order.customerPhone) || null,
    shippingAddressEncrypted: encryptOrderPayload(
      (order.shipmentAddress ?? order.address ?? null) as unknown,
    ),
    shippingCity: str(order.city) || null,
    shippingDistrict: str(order.district) || null,
    cargoProviderName: str(order.cargoProviderName) || null,
    cargoTrackingNumber: str(order.cargoTrackingNumber) || null,
    cargoSenderNumber: str(order.cargoSenderNumber) || null,
    cargoTrackingLink: str(order.cargoTrackingLink) || null,
    totalAmount: num(order.totalAmount ?? order.totalPrice),
    currency: str(order.currency) || null,
    orderDate: toDate(order.orderDate ?? order.createdAt),
    marketplaceLastModifiedAt: optionalDate(
      order.lastModifiedDate ?? order.marketplaceLastModifiedAt,
    ),
    rawPayloadEncrypted: encryptOrderPayload(order.rawOrder ?? order),
    lastSeenAt: new Date(),
    // Tekrar görülen sipariş arşivden çıkarılır (kanıtlı fresh görülme).
    archivedAt: null,
    updatedAt: new Date(),
  }
}

export function toLineInsertValues(
  organizationId: string,
  orderId: string,
  order: Record<string, unknown>,
): Record<string, unknown>[] {
  const items = Array.isArray(order.items) ? order.items : []
  return items.map((raw, index) => {
    const item = raw as Record<string, unknown>
    return {
      organizationId,
      orderId,
      externalLineId:
        str(item.id) || str(item.orderLineId) || str(item.barcode) || `line-${index}`,
      productId: str(item.productContentId ?? item.productCode) || null,
      merchantSku: str(item.merchantSku ?? item.sku ?? item.stockCode) || null,
      barcode: str(item.barcode) || null,
      productName: str(item.productName) || 'Ürün',
      variantAttributes: item.variantAttributes ?? null,
      quantity: Math.max(0, Math.trunc(Number(item.quantity ?? 1))),
      unitPrice: num(item.price),
      lineTotal: num(
        Number(item.price ?? 0) * Math.max(0, Number(item.quantity ?? 0)),
      ),
      discountTotal: num(item.discount ?? item.discountTotal),
      lineStatus: str(item.lineStatus ?? item.orderLineItemStatusName) || null,
      imageUrl: str(item.imageUrl ?? item.productImageUrl) || null,
      rawPayloadEncrypted: encryptOrderPayload(item),
    }
  })
}

// DB satırları → frontend order view-model (CargoOrder benzeri). Adres/raw
// çözülür; shipment linkage çağıran tarafından eklenir.
export function rowToOrder(
  orderRow: Record<string, unknown>,
  lineRows: Record<string, unknown>[],
): Record<string, unknown> {
  const address = decryptOrderPayload(
    orderRow.shippingAddressEncrypted as string | null,
  ) as Record<string, unknown> | string | null
  const rawOrder = decryptOrderPayload(
    orderRow.rawPayloadEncrypted as string | null,
  )
  const addressText =
    typeof address === 'string'
      ? address
      : str(
          (address as Record<string, unknown> | null)?.fullAddress ??
            (address as Record<string, unknown> | null)?.address,
        )
  return {
    id: str(orderRow.id),
    marketplace: str(orderRow.marketplace),
    externalOrderId: str(orderRow.externalOrderId) || str(orderRow.packageId),
    packageId: str(orderRow.packageId),
    shipmentPackageId: str(orderRow.packageId),
    orderNumber: str(orderRow.orderNumber),
    customerFirstName: str(orderRow.customerFirstName),
    customerLastName: str(orderRow.customerLastName),
    customerName:
      `${str(orderRow.customerFirstName)} ${str(orderRow.customerLastName)}`.trim() ||
      'Müşteri',
    customerPhone: str(orderRow.customerPhone),
    customerEmail: str(orderRow.customerEmail),
    marketplaceStatus: str(orderRow.marketplaceStatus),
    operationStatus: str(orderRow.operationStatus),
    status: 'Yeni',
    source: 'real_api',
    shipmentAddress: (address as Record<string, unknown>) ?? {},
    address: addressText,
    city: str(orderRow.shippingCity),
    district: str(orderRow.shippingDistrict),
    cargoProviderName: str(orderRow.cargoProviderName),
    cargoTrackingNumber: str(orderRow.cargoTrackingNumber),
    cargoSenderNumber: str(orderRow.cargoSenderNumber),
    cargoTrackingLink: str(orderRow.cargoTrackingLink),
    totalAmount: Number(orderRow.totalAmount ?? 0),
    totalPrice: Number(orderRow.totalAmount ?? 0),
    orderDate: orderRow.orderDate
      ? new Date(String(orderRow.orderDate)).toISOString()
      : new Date(0).toISOString(),
    createdAt: orderRow.orderDate
      ? new Date(String(orderRow.orderDate)).toISOString()
      : new Date(0).toISOString(),
    archived: Boolean(orderRow.archivedAt),
    archivedAt: orderRow.archivedAt
      ? new Date(String(orderRow.archivedAt)).toISOString()
      : undefined,
    rawOrder: rawOrder ?? undefined,
    items: lineRows.map((raw) => {
      const line = raw as Record<string, unknown>
      return {
        id: str(line.externalLineId),
        orderId: str(orderRow.orderNumber),
        productName: str(line.productName),
        barcode: str(line.barcode),
        sku: str(line.merchantSku),
        merchantSku: str(line.merchantSku),
        stockCode: str(line.merchantSku),
        productContentId: str(line.productId),
        quantity: Number(line.quantity ?? 1),
        price: Number(line.unitPrice ?? 0),
        imageUrl: str(line.imageUrl),
        productImageUrl: str(line.imageUrl),
        lineStatus: str(line.lineStatus),
        variantAttributes: line.variantAttributes ?? [],
      }
    }),
  }
}
