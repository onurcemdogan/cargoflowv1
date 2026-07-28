import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, isNull } from 'drizzle-orm'

// FAZ 0 temel katmanı: marketplace_accounts tablosu + orders/products/
// integration_sync_state hesap kapsamı (marketplaceAccountId) + NULLS NOT
// DISTINCT unique sözleşmesi + aktif hesap çözümü.
//   - Gerçek Trendyol hesap kimliği: sellerId (apiKey/secret DEĞİL).
//   - Aynı hesap tekrar → yeni hesap OLUŞMAZ; farklı hesap → yeni + tek aktif.
//   - İki hesap AYNI packageId'yi taşıyabilir (çakışma yok); aynı hesapta
//     duplicate engellenir. Legacy NULL-hesap eskisi gibi tekilleşir.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, slug) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}
let seq = 0
function order(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    city: 'İstanbul',
    totalAmount: 100,
    currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-24T08:00:00Z',
    rawOrder: {},
    items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}

// ── Migration boş DB'de çalışır (marketplace_accounts + kolonlar + constraint) ──
test('FND-1: migration boş DB\'de marketplace_accounts + hesap kolonlarını kurar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const tableRows = await pglite.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='marketplace_accounts'`,
  )
  assert.equal(tableRows.rows.length, 1, 'marketplace_accounts tablosu var')
  for (const table of ['orders', 'products', 'integration_sync_state']) {
    const col = await pglite.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name='marketplace_account_id'`,
      [table],
    )
    assert.equal(col.rows.length, 1, `${table}.marketplace_account_id kolonu var`)
  }
  // Aktif hesap için insert edilebilir (org FK).
  const org = await makeOrg(db, 'fnd-1')
  const [row] = await db
    .insert(schema.marketplaceAccounts)
    .values({ organizationId: org, marketplace: 'Trendyol', providerAccountId: 'S-1', isActive: true })
    .returning()
  assert.ok(row.id)
})

// ── Gerçek hesap kimliği: sellerId (apiKey/secret DEĞİL) ────────────────────
test('FND-2: resolveProviderAccountId Trendyol için sellerId kullanır; secret kullanmaz', () => {
  assert.equal(
    accounts.resolveProviderAccountId('Trendyol', {
      sellerId: '123456',
      apiKey: 'KEY',
      apiSecret: 'SECRET',
    }),
    '123456',
    'sellerId hesap kimliğidir',
  )
  // apiKey/secret asla hesap kimliği olmaz; sellerId yoksa null.
  assert.equal(
    accounts.resolveProviderAccountId('Trendyol', { apiKey: 'KEY', apiSecret: 'SECRET' }),
    null,
    'sellerId yoksa hesap kimliği yok (secret kullanılmaz)',
  )
  assert.equal(accounts.resolveProviderAccountId('Trendyol', null), null)
  // displayName ham secret içermez.
  const label = accounts.buildAccountDisplayName('Trendyol', '123456')
  assert.match(label, /123456/)
  assert.doesNotMatch(label, /SECRET|KEY/)
})

// ── Aynı hesap tekrar → yeni oluşmaz; farklı hesap → tek aktif ──────────────
test('FND-3: resolveOrCreateActiveAccount idempotent + tek aktif hesap', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'fnd-3')
  const a1 = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  assert.equal(a1.isActive, true)
  // Aynı hesap tekrar kaydedilir → YENİ hesap oluşmaz (aynı id).
  const a1b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  assert.equal(a1b.id, a1.id, 'aynı providerAccountId yeni hesap açmaz')
  const listAfterA = await accounts.listAccounts(db, org, 'Trendyol')
  assert.equal(listAfterA.length, 1)
  // Farklı hesap → yeni kayıt, A pasif, B aktif (tek aktif garantisi).
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-B')
  assert.notEqual(b.id, a1.id)
  const active = await accounts.getActiveAccount(db, org, 'Trendyol')
  assert.equal(active.id, b.id, 'yeni hesap aktif')
  assert.equal(active.providerAccountId, 'SELLER-B')
  const aReloaded = await accounts.getAccountById(db, org, a1.id)
  assert.equal(aReloaded.isActive, false, 'eski hesap pasif (silinmez)')
  const list = await accounts.listAccounts(db, org, 'Trendyol')
  assert.equal(list.length, 2, 'iki hesap da DB\'de durur')
  assert.equal(list.filter((r) => r.isActive).length, 1, 'yalnız bir aktif hesap')
})

// ── İki hesap aynı packageId'yi taşıyabilir; aynı hesapta duplicate engellenir ─
test('FND-4: aynı packageId iki hesapta ayrı kayıt; aynı hesapta tekilleşir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'fnd-4')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-B')
  // A ve B'de AYNI packageId → iki ayrı kayıt (çakışma yok).
  await orderService.persistSyncResult(db, org, [order({ packageId: 'SHARED' })], {
    complete: false,
    marketplaceAccountId: a.id,
  })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'SHARED' })], {
    complete: false,
    marketplaceAccountId: b.id,
  })
  const rows = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'SHARED')))
  assert.equal(rows.length, 2, 'iki hesap için iki ayrı SHARED kaydı')
  // Aynı hesapta tekrar upsert → UPDATE (yeni satır yok).
  await orderService.persistSyncResult(db, org, [order({ packageId: 'SHARED' })], {
    complete: false,
    marketplaceAccountId: a.id,
  })
  const rowsAfter = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'SHARED')))
  assert.equal(rowsAfter.length, 2, 'aynı hesapta duplicate oluşmaz (tekilleşir)')
})

// ── Legacy NULL-hesap kayıtları eskisi gibi tekilleşir (NULLS NOT DISTINCT) ──
test('FND-5: legacy NULL-hesap upsert eskisi gibi (org, packageId) ile tekilleşir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'fnd-5')
  // Hesapsız (null) upsert iki kez → tek kayıt (eski davranış korunur).
  await orderService.persistSyncResult(db, org, [order({ packageId: 'LEG-1' })], { complete: false })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'LEG-1' })], { complete: false })
  const rows = await db
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.organizationId, org),
        isNull(schema.orders.marketplaceAccountId),
        eq(schema.orders.packageId, 'LEG-1'),
      ),
    )
  assert.equal(rows.length, 1, 'null-hesap duplicate oluşmaz')
})

// ── Hesap sync metadata no-regress ─────────────────────────────────────────
test('FND-6: updateAccountSyncMeta yalnız success son başarılı zamanı ilerletir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'fnd-6')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  await accounts.updateAccountSyncMeta(db, org, a.id, { status: 'partial' })
  let row = await accounts.getAccountById(db, org, a.id)
  assert.equal(row.lastSyncStatus, 'partial')
  assert.equal(row.lastSuccessfulSyncAt ?? null, null, 'partial son başarılı zamanı yazmaz')
  await accounts.updateAccountSyncMeta(db, org, a.id, { status: 'success' })
  row = await accounts.getAccountById(db, org, a.id)
  assert.ok(row.lastSuccessfulSyncAt, 'success son başarılı zamanı yazar')
})

// ── Tenant izolasyonu: getAccountById başka org'un hesabını dönmez ──────────
test('FND-7: getAccountById tenant-scoped (başka org hesabı dönmez)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'fnd-7a')
  const orgB = await makeOrg(db, 'fnd-7b')
  const a = await accounts.resolveOrCreateActiveAccount(db, orgA, 'Trendyol', 'SELLER-A')
  assert.equal(await accounts.getAccountById(db, orgB, a.id), null, 'çapraz-org hesap görünmez')
  assert.equal(await accounts.getActiveAccount(db, orgB, 'Trendyol'), null, 'B\'nin aktif hesabı yok')
})
