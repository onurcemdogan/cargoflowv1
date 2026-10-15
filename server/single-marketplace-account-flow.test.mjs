import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import * as schema from './db/schema.ts'
import * as accounts from './integrations/marketplaceAccountRepository.ts'
import * as payer from './shipments/marketplacePayerConfig.ts'
import * as carriers from './carriers/carrierAccounts.ts'
import { listOrganizationMarketplaceAccounts, recordSyncState } from './onboarding/onboardingRepository.ts'
import { loadOnboardingSnapshot } from './onboarding/onboardingService.ts'
import { loadIntegrationHealthForOrganization } from './connectors/integrationHealthService.ts'
import { loadIntegrationStatusBoard } from './connectors/integrationStatus.ts'
import { saveIntegrationCredential } from './integrations/credentialService.ts'
import { persistSyncResult, getOrder } from './orders/orderPersistenceService.ts'

// Synthetic local DB only. No provider transport is supplied or called.
for (const key of ['CREDENTIAL_ENCRYPTION_KEY', 'ORDER_DATA_ENCRYPTION_KEY', 'SHIPMENT_ENCRYPTION_KEY']) {
  process.env[key] = randomBytes(32).toString('hex')
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
const statements = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()
  .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean))
const NOW = Date.parse('2026-10-15T09:00:00Z')

async function fixture(t) {
  const pglite = new PGlite()
  t.after(() => pglite.close())
  for (const sql of statements) await pglite.exec(sql)
  const queries = []
  let failActivation = false
  const db = drizzle(pglite, { schema, logger: { logQuery(sql, params) {
    queries.push({ sql, params })
    if (failActivation && sql.startsWith('update "marketplace_accounts"') && params[0] === true) {
      throw new Error('synthetic activation failure')
    }
  } } })
  const [org] = await db.insert(schema.organizations).values({ name: 'Synthetic org', slug: 'single-account' }).returning()
  const [otherOrg] = await db.insert(schema.organizations).values({ name: 'Other org', slug: 'other-org' }).returning()
  return { db, org: org.id, otherOrg: otherOrg.id, queries, failNextActivation: () => { failActivation = true } }
}

test('SMA-A/C: payer + current settings expose active seller only; other providers and historical rows survive', async (t) => {
  const { db, org, otherOrg } = await fixture(t)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '111')
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '222')
  await db.update(schema.marketplaceAccounts).set({ displayName: null }).where(eq(schema.marketplaceAccounts.id, b.id))
  const n11 = await accounts.ensureAccount(db, org, 'n11', 'synthetic-n11')
  await accounts.resolveOrCreateActiveAccount(db, otherOrg, 'Trendyol', '333')
  const before = await accounts.listAccounts(db, org, 'Trendyol')
  const view = await payer.loadAccountPayerView(db, org)
  assert.deepEqual(view.map((row) => row.marketplaceAccountId).sort(), [b.id, n11.id].sort())
  assert.equal(view.find((row) => row.marketplaceAccountId === b.id).configurable, false)
  assert.equal(view.find((row) => row.marketplaceAccountId === b.id).payer, 'UNKNOWN')
  assert.equal(view.find((row) => row.marketplaceAccountId === b.id).displayName, 'Trendyol · 222', 'seller identity remains clear without a display name')
  const settings = await listOrganizationMarketplaceAccounts(db, org)
  assert.deepEqual(settings.map((row) => row.id).sort(), [b.id, n11.id].sort())
  assert.equal(settings.find((row) => row.id === b.id).displayName, 'Trendyol · 222')
  assert.deepEqual(await accounts.listAccounts(db, org, 'Trendyol'), before, 'views never delete/mutate source rows')
  assert.equal((await accounts.getAccountById(db, org, a.id)).isActive, false)
  assert.equal(before.length, 2)
})

test('SMA-B: same seller id is idempotent; concurrent replacements serialize inside a tenant transaction', async (t) => {
  const { db, org, queries } = await fixture(t)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '111')
  assert.equal((await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '111')).id, a.id)
  assert.equal((await accounts.listAccounts(db, org, 'Trendyol')).length, 1)
  queries.length = 0
  await Promise.all(['222', '333'].map((seller) => accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', seller)))
  const rows = await accounts.listAccounts(db, org, 'Trendyol')
  assert.equal(rows.length, 3)
  assert.equal(rows.filter((row) => row.isActive).length, 1)
  const locks = queries.filter(({ sql }) => sql.includes('from "organizations"') && sql.endsWith('for update'))
  assert.equal(locks.length, 2, 'both transitions lock the existing org, including first connections')
  assert.ok(locks.every(({ params }) => params.includes(org)), 'tenant-scoped lock')
  assert.ok(queries.findIndex(({ sql }) => sql.endsWith('for update')) < queries.findIndex(({ sql }) => sql.startsWith('insert into "marketplace_accounts"')))
})

test('SMA-C: failed activation rolls back both replacement and deactivation', async (t) => {
  const { db, org, failNextActivation } = await fixture(t)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '111')
  const before = await accounts.listAccounts(db, org, 'Trendyol')
  failNextActivation()
  await assert.rejects(accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '222'))
  assert.deepEqual(await accounts.listAccounts(db, org, 'Trendyol'), before)
  assert.equal((await accounts.getActiveAccount(db, org, 'Trendyol')).id, a.id)
})

test('SMA-D: replacement preserves historical order identity, contents and original account reads', async (t) => {
  const { db, org, otherOrg } = await fixture(t)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '111')
  await persistSyncResult(db, org, [{ marketplace: 'Trendyol', packageId: 'SYNTHETIC-PKG', orderNumber: 'SYNTHETIC-ORDER', marketplaceStatus: 'Created', operationStatus: 'NEW', totalAmount: 100, currency: 'TRY', orderDate: '2026-10-14T09:00:00Z', rawOrder: {}, items: [{ id: 'line-1', quantity: 1, price: 100 }] }], { complete: false, marketplaceAccountId: a.id })
  const before = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))
  const readableBefore = await getOrder(db, org, before[0].id, a.id)
  assert.ok(readableBefore)
  await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '222')
  assert.deepEqual(await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org)), before)
  assert.deepEqual(await getOrder(db, org, before[0].id, a.id), readableBefore)
  assert.equal((await accounts.getAccountById(db, org, a.id)).providerAccountId, '111')
  assert.equal(await getOrder(db, otherOrg, before[0].id, a.id), null)
})

test('SMA-E: current carrier settings hide retired seller; direct new mappings rejected; historical routing unchanged', async (t) => {
  const { db, org, otherOrg } = await fixture(t)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '111')
  const [carrier] = await db.insert(schema.carrierAccounts).values({ organizationId: org, provider: 'surat', displayName: 'Synthetic carrier', credentialRef: 'synthetic-ref', enabled: true }).returning()
  await carriers.setCarrierMapping(db, { organizationId: org, marketplaceAccountId: a.id, carrierAccountId: carrier.id })
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '222')
  const before = await carriers.listCarrierMappings(db, org)
  const view = await carriers.loadCarrierAccountSettings(db, org)
  assert.deepEqual(view.marketplaceAccounts.map((row) => row.id), [b.id])
  assert.deepEqual(view.mappings, [])
  for (const marketplaceAccountId of [a.id]) {
    for (const carrierAccountId of [carrier.id, null]) {
      await assert.rejects(carriers.setCarrierMapping(db, { organizationId: org, marketplaceAccountId, carrierAccountId }), { code: 'MARKETPLACE_ACCOUNT_NOT_FOUND' })
    }
  }
  await assert.rejects(carriers.setCarrierMapping(db, { organizationId: otherOrg, marketplaceAccountId: b.id, carrierAccountId: carrier.id }), { code: 'MARKETPLACE_ACCOUNT_NOT_FOUND' })
  assert.deepEqual(await carriers.listCarrierMappings(db, org), before, 'historical mapping remains stored')
  const historical = await carriers.resolveCarrierAccount(db, { organizationId: org, provider: 'surat', marketplaceAccountId: a.id })
  assert.equal(historical.ok, true)
  assert.equal(historical.source, 'EXPLICIT_MAPPING')
  await carriers.setCarrierMapping(db, { organizationId: org, marketplaceAccountId: b.id, carrierAccountId: carrier.id })
  const inactiveOther = await accounts.ensureAccount(db, org, 'woocommerce', 'synthetic-woo')
  await carriers.setCarrierMapping(db, { organizationId: org, marketplaceAccountId: inactiveOther.id, carrierAccountId: carrier.id })
  assert.ok((await carriers.loadCarrierAccountSettings(db, org)).marketplaceAccounts.some((row) => row.id === inactiveOther.id), 'other providers retain behavior')
})

test('SMA-health: old seller sync/error cannot reappear in health, catalog or onboarding; records remain', async (t) => {
  const { db, org } = await fixture(t)
  await saveIntegrationCredential(db, org, 'trendyol', { sellerId: '222', apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' })
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '111')
  await recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'failed', marketplaceAccountId: a.id, errorCode: 'AUTH_ERROR' })
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '222')
  await recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'success', marketplaceAccountId: b.id })
  const before = await db.select().from(schema.integrationSyncState)
  const entries = (await loadIntegrationHealthForOrganization(db, { organizationId: org, nowMs: NOW })).filter((entry) => entry.providerKey === 'trendyol')
  assert.deepEqual(entries.map((entry) => entry.marketplaceAccountId), [b.id])
  const board = (await loadIntegrationStatusBoard(db, { organizationId: org, nowMs: NOW })).find((entry) => entry.providerKey === 'trendyol')
  assert.equal(board.health.accountCount, 1)
  assert.equal(board.health.state, 'verified')
  const snapshot = await loadOnboardingSnapshot(db, org, { nowMs: NOW })
  assert.deepEqual(snapshot.accounts.filter((row) => row.marketplace.toLowerCase() === 'trendyol').map((row) => row.id), [b.id])
  assert.deepEqual(await db.select().from(schema.integrationSyncState), before)
  assert.equal((await accounts.listAccounts(db, org, 'Trendyol')).length, 2)
})

test('SMA-none: no active Trendyol means no current account; inactive non-Trendyol remains', async (t) => {
  const { db, org } = await fixture(t)
  const retired = await accounts.ensureAccount(db, org, 'Trendyol', '111')
  const other = await accounts.ensureAccount(db, org, 'n11', 'synthetic-n11')
  await recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'success', marketplaceAccountId: retired.id })
  assert.deepEqual((await payer.loadAccountPayerView(db, org)).map((row) => row.marketplaceAccountId), [other.id])
  const entries = (await loadIntegrationHealthForOrganization(db, { organizationId: org, nowMs: NOW })).filter((entry) => entry.providerKey === 'trendyol')
  assert.ok(entries.every((entry) => entry.marketplaceAccountId === null))
  assert.equal((await accounts.listAccounts(db, org, 'Trendyol')).length, 1)
})
