// Normalized Trendyol siparişi ↔ DB satır eşlemesi. MARKETPLACE alanları
// (fresh sync günceller) ile OPERASYONEL alanlar (operation_status, archived —
// korunur) AÇIKÇA ayrılır. PII/adres ve raw payload şifreli tutulur.
import { createHash } from 'node:crypto'
import { encryptOrderPayload, decryptOrderPayload } from './orderEncryption.ts'
import { orderDispositionOf } from '../../src/dashboard/dashboardSalesMetricDefinition.ts'

/**
 * Satış dispozisyonu YAZIM ANINDA hesaplanır.
 *
 * İSTEMCİYLE AYNI FONKSİYON kullanılır (`orderDispositionOf`). Kural SQL'de
 * yeniden yazılsaydı ikinci bir uygulama doğar ve Türkçe-katlamalı normalize,
 * RETURN>CANCEL>SALE önceliği ve alt-dize eşleşmesi zamanla ayrışırdı. Ayrıca
 * sinyallerden biri (`rawOrder.status`) ŞİFRELİ payload'dadır; SQL onu
 * okuyamaz.
 */
function resolveSalesDisposition(order: Record<string, unknown>): string {
  return orderDispositionOf({
    marketplaceStatus: order.marketplaceStatus,
    packageStatus: order.packageStatus,
    shipmentStatusName: order.shipmentStatusName,
    rawOrder: order.rawOrder ?? order,
  })
}

function str(value: unknown): string {
  return String(value ?? '').trim()
}

// Frontend ile AYNI ön ek stripleme: normal sync satır id'sini `ty_line_<rawId>`
// olarak üretir (index.mjs), historical backfill ise `<rawId>` üretir. AYNI
// Trendyol satırı iki farklı externalLineId'ye düşerse (kohort vs backfill) satır
// DUPLICATE olur. Ön eki soyarak iki yol AYNI canonical anahtara iner.
const TY_LINE_PREFIX = 'ty_line_'
function stripLinePrefix(id: string): string {
  return id.startsWith(TY_LINE_PREFIX) ? id.slice(TY_LINE_PREFIX.length) : id
}

// variantAttributes → deterministik string (sıralı; hem dizi hem nesne biçimi).
function stableVariant(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        const attribute = entry as Record<string, unknown> | null
        return `${str(attribute?.name ?? attribute?.key)}=${str(attribute?.value)}`
      })
      .sort()
      .join(',')
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => `${key}=${str(val)}`)
      .sort()
      .join(',')
  }
  return str(value)
}

// CANONICAL, YOL-BAĞIMSIZ satır kimliği. Öncelik: gerçek provider satır id'si
// (ty_line_ ön eki soyulmuş item.id / orderLineId) → yoksa içerik hash'i
// (productId|sku|barcode|unitPrice|variant|index). YALNIZ barcode'a göre
// deduplike ETMEZ (aynı üründen iki gerçek satır index ile ayrışır → korunur).
// Aynı provider satırı hangi yoldan gelirse gelsin AYNI anahtara iner → idempotent.
export function canonicalLineKey(
  item: Record<string, unknown>,
  index: number,
): string {
  const providerId = stripLinePrefix(str(item.id) || str(item.orderLineId))
  if (providerId) return providerId
  const basis = [
    str(item.productContentId ?? item.productCode ?? item.productId),
    str(item.merchantSku ?? item.sku ?? item.stockCode),
    str(item.barcode),
    str(item.price ?? item.unitPrice),
    stableVariant(item.variantAttributes),
    String(index),
  ].join('|')
  return `ck_${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`
}

// Bir DB satırından canonical anahtar (repair grubu için). externalLineId ön eki
// soyulur; ck_ / gerçek provider id doğrudan kullanılır.
export function canonicalLineKeyFromRow(row: {
  externalLineId?: unknown
  productId?: unknown
  merchantSku?: unknown
  barcode?: unknown
  unitPrice?: unknown
  variantAttributes?: unknown
}): string {
  const stripped = stripLinePrefix(str(row.externalLineId))
  if (stripped) return stripped
  const basis = [
    str(row.productId),
    str(row.merchantSku),
    str(row.barcode),
    str(row.unitPrice),
    stableVariant(row.variantAttributes),
  ].join('|')
  return `ck_${createHash('sha256').update(basis).digest('hex').slice(0, 24)}`
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
  marketplaceAccountId: string | null = null,
): Record<string, unknown> {
  const address = (order.shipmentAddress ?? order.address ?? null) as unknown
  return {
    organizationId,
    // Aktif pazaryeri hesabı kapsamı (null → legacy/hesapsız).
    marketplaceAccountId: marketplaceAccountId ?? null,
    marketplace: str(order.marketplace) || 'Trendyol',
    packageId: str(order.packageId ?? order.shipmentPackageId),
    orderNumber: str(order.orderNumber) || str(order.packageId),
    externalOrderId: str(order.externalOrderId) || null,
    marketplaceStatus: str(order.marketplaceStatus) || null,
    salesDisposition: resolveSalesDisposition(order),
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
    salesDisposition: resolveSalesDisposition(order),
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
    // BLOCKER 2 DÜZELTMESİ: rutin marketplace sync `archivedAt`e DOKUNMAZ.
    // Eskiden burada `archivedAt: null` vardı; sync penceresinde duran her
    // sipariş HER sync'te arşivden çıkıyordu → zaman tabanlı otomatik arşiv
    // sürekli geri alınırdı. Arşivden çıkarma artık YALNIZ explicit
    // restore/unarchive kod yolunun işidir. Pazaryeri statüsünün değişmesi
    // (ör. Picking → Shipped) TEK BAŞINA unarchive sebebi DEĞİLDİR; arşiv
    // görünümünde güncel statü zaten görülür.
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
      // CANONICAL yol-bağımsız anahtar (ty_line_ ön eki soyulur; yoksa içerik
      // hash'i). Aynı provider satırı normal sync ve backfill'de AYNI anahtara
      // iner → cross-path duplicate önlenir.
      externalLineId: canonicalLineKey(item, index),
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
    // SON SENKRONİZASYON DAMGASI. `lastSeenAt` kolonu, siparişin EN SON
    // başarılı pazaryeri sync'inde görüldüğü andır (marketplaceUpdateSet her
    // sync'te yazar). Bu alan okuma yolunda ÜRETİLMEDİĞİ için auth modunda
    // sipariş listesi hiçbir sync damgası taşımıyordu → Dashboard/Siparişler
    // sayfa yenilendiğinde kalıcı veri dolu olmasına rağmen "Bekleniyor"
    // gösteriyordu. Yeni kolon/endpoint GEREKMEZ; mevcut kolon yansıtılır.
    lastMarketplaceSyncedAt: orderRow.lastSeenAt
      ? new Date(String(orderRow.lastSeenAt)).toISOString()
      : undefined,
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
      // ÜRETİM HATASI DÜZELTMESİ: satır DB'den kurulurken `size`/`color`
      // ÜRETİLMİYORDU ve Trendyol'da beden çoğunlukla `variantAttributes`ta
      // DEĞİL `productSize` alanında gelir → Toplanacak Ürünler'de tüm
      // bedenler "Bedensiz" görünüyordu. Kalemin TAM normalize hâli zaten
      // `rawPayloadEncrypted` içinde SAKLI; yeni kolon/migration GEREKMEZ,
      // yalnız okuma yolunda geri çözülür. Eşleştirme SATIR BAZINDA olduğu
      // için çok ürünlü siparişte bedenler KARIŞMAZ.
      const rawItem = (decryptOrderPayload(
        line.rawPayloadEncrypted as string | null,
      ) ?? {}) as Record<string, unknown>
      const variantAttributes =
        line.variantAttributes ?? rawItem.variantAttributes ?? []
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
        variantAttributes,
        size: str(rawItem.size ?? rawItem.productSize),
        color: str(rawItem.color ?? rawItem.productColor),
        productMainId: str(rawItem.productMainId),
        productCode: str(rawItem.productCode),
        rawLine: rawItem.rawLine ?? undefined,
      }
    }),
  }
}
