// CargoFlow çok kiracılı temel şema (faz 1): organizations, users,
// sessions, integration_credentials. Sipariş/ürün/shipment tabloları
// SONRAKİ fazdadır; bu dosya mevcut uygulama davranışını değiştirmez.
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
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
