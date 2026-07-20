// CargoFlow çok kiracılı temel şema (faz 1): organizations, users,
// sessions, integration_credentials. Sipariş/ürün/shipment tabloları
// SONRAKİ fazdadır; bu dosya mevcut uygulama davranışını değiştirmez.
import { sql } from 'drizzle-orm'
import {
  check,
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
