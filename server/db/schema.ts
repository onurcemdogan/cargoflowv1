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
  unique,
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

// Pazaryeri hesapları (organization bazlı). Bir organization aynı marketplace'te
// (ör. Trendyol) BİRDEN FAZLA satıcı hesabı bağlayabilir; her hesap ayrı veri
// kapsamıdır. providerAccountId = provider'ın kalıcı, GİZLİ OLMAYAN hesap
// kimliği (Trendyol için sellerId; API key/secret DEĞİL, hash DEĞİL). Aynı
// (org, marketplace, providerAccountId) tekrar kaydedilirse yeni hesap
// OLUŞMAZ. Bir (org, marketplace) için EN FAZLA bir aktif hesap (partial unique).
// Hesap değişince eski hesap SİLİNMEZ; yalnız isActive=false yapılır (veriler
// korunur, kullanıcı geri bağlarsa yeniden görünür).
export const marketplaceAccounts = pgTable(
  'marketplace_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    marketplace: text('marketplace').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    displayName: text('display_name'),
    isActive: boolean('is_active').notNull().default(false),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', {
      withTimezone: true,
    }),
    lastSyncStatus: text('last_sync_status'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Aynı provider hesap kimliği tekrar kaydedilemez (yeni hesap oluşmaz).
    uniqueIndex('marketplace_accounts_org_marketplace_provider_unique').on(
      table.organizationId,
      table.marketplace,
      table.providerAccountId,
    ),
    // Bir (org, marketplace) için tek aktif hesap: partial unique (is_active).
    uniqueIndex('marketplace_accounts_single_active_unique')
      .on(table.organizationId, table.marketplace)
      .where(sql`${table.isActive}`),
    index('marketplace_accounts_org_marketplace_idx').on(
      table.organizationId,
      table.marketplace,
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
    // Pazaryeri hesabı kapsamı. Yeni sync HER kaydı aktif hesapla damgalar.
    // Legacy (izolasyon öncesi) kayıtlarda NULL olabilir → quarantined (aktif
    // UI'da görünmez). Hesap silinmez; hesap satırı düşerse set null.
    marketplaceAccountId: uuid('marketplace_account_id').references(
      () => marketplaceAccounts.id,
      { onDelete: 'set null' },
    ),
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
    // RETENTION SAATİ. YALNIZ gerçek CargoFlow operasyon geçişleri yazar
    // (LABEL_READY / LABEL_PRINTED). Rutin Trendyol sync'i (marketplaceUpdateSet)
    // bu alana DOKUNMAZ — bu yüzden updatedAt'in aksine gerçek operasyonel
    // hareketsizliği temsil eder. NULL = güvenilir aktivite bilgisi YOK →
    // otomatik arşiv ADAYI DEĞİLDİR (bkz. orderRetention.ts).
    lastOperationalActivityAt: timestamp('last_operational_activity_at', {
      withTimezone: true,
    }),
    rawPayloadEncrypted: text('raw_payload_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Kapsam: (org, marketplace, marketplaceAccountId, packageId). NULLS NOT
    // DISTINCT → legacy NULL-hesap kayıtları eskisi gibi (org, marketplace,
    // packageId) ile tekilleşir; İKİ FARKLI hesap AYNI packageId'yi taşıyabilir
    // (çakışma yok, iki ayrı kayıt). Aynı hesapta duplicate packageId engellenir.
    unique('orders_org_marketplace_account_package_unique')
      .on(
        table.organizationId,
        table.marketplace,
        table.marketplaceAccountId,
        table.packageId,
      )
      .nullsNotDistinct(),
    index('orders_org_account_idx').on(
      table.organizationId,
      table.marketplaceAccountId,
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
    // Pazaryeri hesabı kapsamı (bkz. orders.marketplaceAccountId). Legacy NULL.
    marketplaceAccountId: uuid('marketplace_account_id').references(
      () => marketplaceAccounts.id,
      { onDelete: 'set null' },
    ),
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
    // Kapsam: (org, marketplace, marketplaceAccountId, externalProductId).
    // NULLS NOT DISTINCT → legacy NULL-hesap ürünleri eskisi gibi tekilleşir;
    // iki hesap aynı externalProductId'yi ayrı kayıt olarak taşıyabilir.
    unique('products_org_marketplace_account_external_unique')
      .on(
        table.organizationId,
        table.marketplace,
        table.marketplaceAccountId,
        table.externalProductId,
      )
      .nullsNotDistinct(),
    index('products_org_account_idx').on(
      table.organizationId,
      table.marketplaceAccountId,
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

// Organization onboarding/kurulum durumu. organization_id primary key (1:1).
// onboarding_completed frontend'te DEĞİL, burada kaynak-of-truth'tur; her
// yenilemede backend'den yeniden hesaplanır. settings_json opsiyonel esnek alan.
export const organizationSettings = pgTable('organization_settings', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
  onboardingCompletedAt: timestamp('onboarding_completed_at', {
    withTimezone: true,
  }),
  settingsJson: jsonb('settings_json'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// Sağlayıcı/kaynak bazlı son başarılı senkron durumu (organization bazlı).
// Onboarding tamamlanma kriteri "kayıt sayısı > 0"a değil, başarılı sync
// metadata'sına dayanır (ilk sync boş sonuç dönebilir). Dashboard analytics
// sync'leri BURAYA YAZILMAZ (onboarding kriteri sayılmaz).
export const integrationSyncState = pgTable(
  'integration_sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Sync metadata + single-flight lock kapsamı: pazaryeri hesabı da dahil.
    // Legacy/hesapsız akışta NULL (nullsNotDistinct → eski (org, provider,
    // resource) davranışı). Farklı hesaplar birbirinin lock'unu paylaşmaz.
    marketplaceAccountId: uuid('marketplace_account_id').references(
      () => marketplaceAccounts.id,
      { onDelete: 'set null' },
    ),
    provider: text('provider').notNull(),
    resource: text('resource').notNull(),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', {
      withTimezone: true,
    }),
    lastSyncStatus: text('last_sync_status'),
    lastFetchedCount: integer('last_fetched_count'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('integration_sync_state_org_provider_resource_account_unique')
      .on(
        table.organizationId,
        table.provider,
        table.resource,
        table.marketplaceAccountId,
      )
      .nullsNotDistinct(),
    index('integration_sync_state_org_resource_idx').on(
      table.organizationId,
      table.resource,
    ),
  ],
)

// Platform yöneticileri: organization kullanıcılarından TAMAMEN AYRI model.
// Bu tablo organizations/users ile ilişkili DEĞİLDİR; platform genelinde
// hesap yönetimi yetkisi taşır. İlk admin yalnız CLI ile oluşturulur (public
// bootstrap YOK). Parola argon2id hash; düz parola asla saklanmaz.
export const platformAdmins = pgTable('platform_admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  status: text('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// Platform admin oturumları. Organization session'larından AYRI tablo ve AYRI
// cookie (cargoflow_admin_session). Cookie'ye ham token; DB'de yalnız SHA-256
// token_hash. expired/revoked kabul edilmez.
export const platformAdminSessions = pgTable('platform_admin_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id')
    .notNull()
    .references(() => platformAdmins.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

// Platform admin denetim günlüğü. Parola/credential/müşteri verisi/secret
// BURAYA YAZILMAZ — yalnız aksiyon ve hedef kimlikleri (id) + güvenli metadata.
export const platformAdminAuditLogs = pgTable(
  'platform_admin_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id'),
    action: text('action').notNull(),
    targetOrganizationId: uuid('target_organization_id'),
    targetUserId: uuid('target_user_id'),
    metadataJson: jsonb('metadata_json'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('platform_admin_audit_logs_admin_idx').on(table.adminId),
    index('platform_admin_audit_logs_created_at_idx').on(table.createdAt),
  ],
)

// KANONİK FİLTRE PROJEKSİYONU (B2-1b).
//
// Sipariş başına 1:1 türev. Okuma yolunda 10.000 kaydı JS'te normalize
// etmek yerine kanonik token'lar YAZMA anında bir kez üretilir.
//
// NORMALİZASYON BURADA YAPILMAZ: değerler uygulamada `normalizedToken` /
// `normalizedSearch` ile üretilir (bkz. orderFilterProjectionBuilder).
// Generated column / SQL normalization YOKTUR — ikinci doğruluk kaynağı
// oluşmaz.
//
// Sipariş silindiğinde projeksiyon da silinir (ON DELETE CASCADE).
// Gizli veri TAŞIMAZ; `customer_search_token` yalnız arama için gereken
// müşteri alanlarını içerir (ARANABİLİR PII — bu alanlar zaten `orders`
// tablosunda düz kolondur).
export const orderFilterProjection = pgTable(
  'order_filter_projection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    marketplaceToken: text('marketplace_token'),
    operationStatusToken: text('operation_status_token'),
    marketplaceStatus: text('marketplace_status'),
    shippingCityToken: text('shipping_city_token'),
    shippingDistrictToken: text('shipping_district_token'),
    customerSearchToken: text('customer_search_token'),
    // ARAMA PARÇALARI KAYNAK YAŞAM DÖNGÜSÜNE GÖRE AYRIDIR.
    // Her yazan YALNIZ kendi parçasını günceller; böylece sipariş yazımı
    // shipment payload'ı açmak zorunda kalmaz ve eşzamanlı yazımlar
    // birbirinin parçasını EZMEZ (lost-update yapısal olarak çözülür).
    orderNumberOrderToken: text('order_number_order_token'),
    orderNumberShipmentToken: text('order_number_shipment_token'),
    cargoSlipOrderToken: text('cargo_slip_order_token'),
    cargoSlipShipmentToken: text('cargo_slip_shipment_token'),
    cargoSlipOperationToken: text('cargo_slip_operation_token'),
    orderDate: timestamp('order_date', { withTimezone: true }),
    projectionVersion: integer('projection_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 1:1 — tenant kapsamı zorunlu.
    uniqueIndex('order_filter_projection_org_order_unique').on(
      table.organizationId,
      table.orderId,
    ),
    // Index kararı EXPLAIN ile B2-1b-B'de verilecek; burada yalnız
    // tenant+sürüm taraması için asgari yardımcı.
    index('order_filter_projection_org_version_idx').on(
      table.organizationId,
      table.projectionVersion,
    ),
  ],
)
