// CargoFlow çok kiracılı temel şema (faz 1): organizations, users,
// sessions, integration_credentials. Sipariş/ürün/shipment tabloları
// SONRAKİ fazdadır; bu dosya mevcut uygulama davranışını değiştirmez.
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// Her şirket = 1 organization. Yeni organization tamamen boş başlar.
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// Şimdilik organization başına TEK kullanıcı: unique(organization_id).
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: text('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('users_username_unique').on(table.username),
    uniqueIndex('users_organization_id_unique').on(table.organizationId),
  ],
)

// Sunucu taraflı oturumlar; token asla düz saklanmaz (token_hash).
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

// Org başına provider'a tek kayıt; payload uygulama katmanında şifrelenir
// (AES-GCM), DB düz credential görmez. provider yalnız trendyol | surat.
export const integrationCredentials = pgTable(
  'integration_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    provider: text('provider').notNull(),
    encryptedPayload: text('encrypted_payload').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('integration_credentials_org_provider_unique').on(
      table.organizationId,
      table.provider,
    ),
    check(
      'integration_credentials_provider_check',
      sql`${table.provider} in ('trendyol', 'surat')`,
    ),
  ],
)

// Shipment sonuçları (organization bazlı). Tracking/sender/barcode sorgu ve
// UI için AÇIK kolonlarda; hassas carrier payload şifreli kolonda. source:
// local_create | marketplace_external | imported_legacy. Organization
// silinirse cascade ile temizlenir.
export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    marketplace: text('marketplace').notNull(),
    packageId: text('package_id').notNull(),
    orderNumber: text('order_number'),
    provider: text('provider').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull(),
    trackingNumber: text('tracking_number'),
    senderNumber: text('sender_number'),
    barcode: text('barcode'),
    trackingLink: text('tracking_link'),
    carrierPayloadEncrypted: text('carrier_payload_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('shipments_org_marketplace_package_provider_unique').on(
      table.organizationId,
      table.marketplace,
      table.packageId,
      table.provider,
    ),
    index('shipments_org_package_idx').on(
      table.organizationId,
      table.packageId,
    ),
    check(
      'shipments_source_check',
      sql`${table.source} in ('local_create', 'marketplace_external', 'imported_legacy')`,
    ),
  ],
)

// Sürat create idempotency kayıtları (organization bazlı). Atomik create
// koruması unique(organization_id, idempotency_key) üzerinden. Hassas response
// payload (teknik ZPL, replay verisi) şifreli kolonda; tracking/sender sorgu
// için açık kolonlarda.
export const shipmentOperations = pgTable(
  'shipment_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    marketplace: text('marketplace').notNull(),
    packageId: text('package_id').notNull(),
    orderNumber: text('order_number'),
    provider: text('provider').notNull(),
    operationType: text('operation_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    requestFingerprint: text('request_fingerprint'),
    responsePayloadEncrypted: text('response_payload_encrypted'),
    trackingNumber: text('tracking_number'),
    senderNumber: text('sender_number'),
    createCallCount: integer('create_call_count').notNull().default(0),
    carrierCreateCalled: boolean('carrier_create_called').notNull().default(false),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('shipment_operations_org_idempotency_unique').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index('shipment_operations_org_package_idx').on(
      table.organizationId,
      table.packageId,
    ),
    index('shipment_operations_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
    index('shipment_operations_created_at_idx').on(table.createdAt),
    check(
      'shipment_operations_status_check',
      sql`${table.status} in ('pending', 'succeeded', 'failed', 'blocked')`,
    ),
  ],
)

// Siparişler (organization bazlı). Auth modda source-of-truth. Marketplace
// alanları (fresh sync) ve operasyonel alanlar (operation_status vb.) ayrı;
// PII/adres ve raw payload şifreli kolonlarda. Organization silinirse cascade.
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    marketplace: text('marketplace').notNull(),
    packageId: text('package_id').notNull(),
    orderNumber: text('order_number').notNull(),
    externalOrderId: text('external_order_id'),
    marketplaceStatus: text('marketplace_status'),
    operationStatus: text('operation_status'),
    customerFirstName: text('customer_first_name'),
    customerLastName: text('customer_last_name'),
    customerEmail: text('customer_email'),
    customerPhone: text('customer_phone'),
    shippingAddressEncrypted: text('shipping_address_encrypted'),
    shippingCity: text('shipping_city'),
    shippingDistrict: text('shipping_district'),
    cargoProviderName: text('cargo_provider_name'),
    cargoTrackingNumber: text('cargo_tracking_number'),
    cargoSenderNumber: text('cargo_sender_number'),
    cargoTrackingLink: text('cargo_tracking_link'),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }),
    currency: text('currency'),
    orderDate: timestamp('order_date', { withTimezone: true }).notNull(),
    marketplaceLastModifiedAt: timestamp('marketplace_last_modified_at', {
      withTimezone: true,
    }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    rawPayloadEncrypted: text('raw_payload_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('orders_org_marketplace_package_unique').on(
      table.organizationId,
      table.marketplace,
      table.packageId,
    ),
    index('orders_org_order_date_idx').on(table.organizationId, table.orderDate),
    index('orders_org_marketplace_status_idx').on(
      table.organizationId,
      table.marketplaceStatus,
    ),
    index('orders_org_operation_status_idx').on(
      table.organizationId,
      table.operationStatus,
    ),
    index('orders_org_order_number_idx').on(
      table.organizationId,
      table.orderNumber,
    ),
    index('orders_org_archived_at_idx').on(
      table.organizationId,
      table.archivedAt,
    ),
  ],
)

// Sipariş satırları (organization bazlı). Barcode/sku/product_id açık (arama);
// raw payload şifreli. Order silinirse cascade.
export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    externalLineId: text('external_line_id').notNull(),
    productId: text('product_id'),
    merchantSku: text('merchant_sku'),
    barcode: text('barcode'),
    productName: text('product_name').notNull(),
    variantAttributes: jsonb('variant_attributes'),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }),
    discountTotal: numeric('discount_total', { precision: 14, scale: 2 }),
    lineStatus: text('line_status'),
    imageUrl: text('image_url'),
    rawPayloadEncrypted: text('raw_payload_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('order_lines_org_order_line_unique').on(
      table.organizationId,
      table.orderId,
      table.externalLineId,
    ),
    index('order_lines_org_barcode_idx').on(table.organizationId, table.barcode),
    index('order_lines_org_merchant_sku_idx').on(
      table.organizationId,
      table.merchantSku,
    ),
    index('order_lines_org_product_id_idx').on(
      table.organizationId,
      table.productId,
    ),
  ],
)

// Ürün kataloğu ana kayıtları (organization bazlı). Başlık/marka/kategori açık
// (arama); raw payload şifreli. Yeni organization boş katalogla başlar.
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    marketplace: text('marketplace').notNull(),
    externalProductId: text('external_product_id').notNull(),
    title: text('title').notNull(),
    brand: text('brand'),
    categoryName: text('category_name'),
    productMainId: text('product_main_id'),
    approved: boolean('approved'),
    archived: boolean('archived').notNull().default(false),
    rawPayloadEncrypted: text('raw_payload_encrypted'),
    marketplaceCreatedAt: timestamp('marketplace_created_at', {
      withTimezone: true,
    }),
    marketplaceLastModifiedAt: timestamp('marketplace_last_modified_at', {
      withTimezone: true,
    }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('products_org_marketplace_external_unique').on(
      table.organizationId,
      table.marketplace,
      table.externalProductId,
    ),
    index('products_org_title_idx').on(table.organizationId, table.title),
    index('products_org_product_main_id_idx').on(
      table.organizationId,
      table.productMainId,
    ),
    index('products_org_archived_idx').on(
      table.organizationId,
      table.archived,
    ),
  ],
)

// Ürün varyantları (organization bazlı). Barcode/sku/stock_code açık (arama);
// raw payload şifreli. Product silinirse cascade. Düz varyant listesi (4293
// varyant koruması) buradan reconstruct edilir.
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    externalVariantId: text('external_variant_id').notNull(),
    merchantSku: text('merchant_sku'),
    barcode: text('barcode'),
    stockCode: text('stock_code'),
    color: text('color'),
    size: text('size'),
    attributes: jsonb('attributes'),
    imageUrls: jsonb('image_urls'),
    primaryImageUrl: text('primary_image_url'),
    quantity: integer('quantity'),
    salePrice: numeric('sale_price', { precision: 14, scale: 2 }),
    listPrice: numeric('list_price', { precision: 14, scale: 2 }),
    approved: boolean('approved'),
    archived: boolean('archived').notNull().default(false),
    rawPayloadEncrypted: text('raw_payload_encrypted'),
    marketplaceLastModifiedAt: timestamp('marketplace_last_modified_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('product_variants_org_product_variant_unique').on(
      table.organizationId,
      table.productId,
      table.externalVariantId,
    ),
    index('product_variants_org_barcode_idx').on(
      table.organizationId,
      table.barcode,
    ),
    index('product_variants_org_merchant_sku_idx').on(
      table.organizationId,
      table.merchantSku,
    ),
    index('product_variants_org_stock_code_idx').on(
      table.organizationId,
      table.stockCode,
    ),
    index('product_variants_org_archived_idx').on(
      table.organizationId,
      table.archived,
    ),
  ],
)
