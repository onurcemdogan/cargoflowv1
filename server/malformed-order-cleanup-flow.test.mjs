import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// TEK BOZUK SIPARIS SATIRI GUVENLI TEMIZLIGI.
//
// URETIM VAKASI (PII YOK):
//   BOZUK   id 2e45b831-… · packageId "0"        · orderNumber 11496311967
//   GECERLI              · packageId 4068544739 · orderNumber 11496311967
//
// Sozlesme: YALNIZ hedef satir silinir; gecerli karsilik DOKUNULMAZ; tasiyici
// kaydi (shipment / shipment_operation) varsa islem YAPILMAZ; her sey TEK
// transaction icinde son bir kez dogrulanir.
//
// Surat/SSP, ZPL/etiket, retention, senkron mantigi KAPSAM DISIDIR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const cleanup = await import('./orders/malformedOrderCleanup.ts')

const {
  orders,
  orderLines,
  organizations,
  marketplaceAccounts,
  shipments,
  shipmentOperations,
} = schema

const ORDER_NUMBER = '11496311967'
const VALID_PACKAGE_ID = '4068544739'
const MALFORMED_PACKAGE_ID = '0'

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
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Test Org', slug: `org-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  const [account] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: '277221',
      isActive: true,
    })
    .returning({ id: marketplaceAccounts.id })
  return { db, organizationId: org.id, accountId: account.id }
}

async function seedPair(db, organizationId, accountId, overrides = {}) {
  const [malformed] = await db
    .insert(orders)
    .values({
      organizationId,
      marketplaceAccountId: accountId,
      marketplace: 'Trendyol',
      packageId: MALFORMED_PACKAGE_ID,
      orderNumber: ORDER_NUMBER,
      marketplaceStatus: 'Unknown',
      operationStatus: 'NEW',
      orderDate: new Date('2026-08-11T14:00:00.000Z'),
      ...overrides,
    })
    .returning({ id: orders.id })
  const [valid] = await db
    .insert(orders)
    .values({
      organizationId,
      marketplaceAccountId: accountId,
      marketplace: 'Trendyol',
      packageId: VALID_PACKAGE_ID,
      orderNumber: ORDER_NUMBER,
      marketplaceStatus: 'Created',
      operationStatus: 'NEW',
      orderDate: new Date('2026-08-11T14:00:00.000Z'),
    })
    .returning({ id: orders.id })
  // Bozuk satirin bir urun satiri var (UI'da urun gorunuyordu).
  await db.insert(orderLines).values({
    organizationId,
    orderId: malformed.id,
    externalLineId: 'ty_line_malformed_1',
    productName: 'urun',
    quantity: 1,
  })
  return { malformedId: malformed.id, validId: valid.id }
}

const targetFor = (id) => ({
  id,
  malformedPackageId: MALFORMED_PACKAGE_ID,
  orderNumber: ORDER_NUMBER,
  validPackageId: VALID_PACKAGE_ID,
})

const allOrders = (db) =>
  db
    .select({
      id: orders.id,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      marketplaceStatus: orders.marketplaceStatus,
    })
    .from(orders)

// ═══ ON DENETIM ═══════════════════════════════════════════════════════════

test('CLEANUP-1: gecerli karsilik VARSA hedef guvenli sayilir', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { malformedId } = await seedPair(db, organizationId, accountId)
  const inspection = await cleanup.inspectCleanupTarget(db, targetFor(malformedId))
  assert.equal(inspection.safe, true)
  assert.deepEqual(inspection.violations, [])
  assert.equal(inspection.target.packageId, MALFORMED_PACKAGE_ID)
  assert.equal(inspection.valid.packageId, VALID_PACKAGE_ID)
  assert.deepEqual(inspection.childCounts, {
    orderLines: 1,
    shipments: 0,
    shipmentOperations: 0,
  })
})

test('CLEANUP-2: gecerli karsilik YOKSA islem YAPILMAZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const [malformed] = await db
    .insert(orders)
    .values({
      organizationId,
      marketplaceAccountId: accountId,
      marketplace: 'Trendyol',
      packageId: MALFORMED_PACKAGE_ID,
      orderNumber: ORDER_NUMBER,
      marketplaceStatus: 'Unknown',
      operationStatus: 'NEW',
      orderDate: new Date('2026-08-11T14:00:00.000Z'),
    })
    .returning({ id: orders.id })

  const inspection = await cleanup.inspectCleanupTarget(
    db,
    targetFor(malformed.id),
  )
  assert.equal(inspection.safe, false)
  assert.ok(inspection.violations.includes('valid_counterpart_missing'))

  const result = await cleanup.cleanupMalformedOrder(db, targetFor(malformed.id))
  assert.equal(result.applied, false)
  assert.equal((await allOrders(db)).length, 1, 'satir DURUYOR')
})

test('CLEANUP-3: kimlik parametreleri UYUSMAZSA islem YAPILMAZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { malformedId } = await seedPair(db, organizationId, accountId)

  const wrongOrderNumber = await cleanup.cleanupMalformedOrder(db, {
    ...targetFor(malformedId),
    orderNumber: '99999999999',
  })
  assert.equal(wrongOrderNumber.applied, false)
  assert.ok(
    wrongOrderNumber.violations.includes('target_order_number_mismatch'),
  )

  const wrongPackage = await cleanup.cleanupMalformedOrder(db, {
    ...targetFor(malformedId),
    malformedPackageId: '123',
  })
  assert.equal(wrongPackage.applied, false)
  assert.ok(wrongPackage.violations.includes('target_package_id_mismatch'))

  assert.equal((await allOrders(db)).length, 2, 'iki satir da DURUYOR')
})

test('CLEANUP-4: GERCEK kimlikli satir ASLA silinmez', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { validId } = await seedPair(db, organizationId, accountId)
  // Gecerli satir hedef gosterilse bile korunur.
  const result = await cleanup.cleanupMalformedOrder(db, {
    id: validId,
    malformedPackageId: VALID_PACKAGE_ID,
    orderNumber: ORDER_NUMBER,
    validPackageId: VALID_PACKAGE_ID,
  })
  assert.equal(result.applied, false)
  assert.ok(result.violations.includes('target_identity_is_valid'))
  assert.equal((await allOrders(db)).length, 2)
})

test('CLEANUP-5: TASIYICI kaydi varsa islem YAPILMAZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { malformedId } = await seedPair(db, organizationId, accountId)
  await db.insert(shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: MALFORMED_PACKAGE_ID,
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const inspection = await cleanup.inspectCleanupTarget(db, targetFor(malformedId))
  assert.equal(inspection.safe, false)
  assert.ok(inspection.violations.includes('target_has_shipment'))

  const result = await cleanup.cleanupMalformedOrder(db, targetFor(malformedId))
  assert.equal(result.applied, false)
  assert.equal((await allOrders(db)).length, 2, 'silme YOK')
})

test('CLEANUP-5b: shipment_operation varsa islem YAPILMAZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { malformedId } = await seedPair(db, organizationId, accountId)
  await db.insert(shipmentOperations).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: MALFORMED_PACKAGE_ID,
    provider: 'surat-kargo',
    operationType: 'create',
    idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
    status: 'succeeded',
  })
  const result = await cleanup.cleanupMalformedOrder(db, targetFor(malformedId))
  assert.equal(result.applied, false)
  assert.ok(result.violations.includes('target_has_shipment_operation'))
  assert.equal((await allOrders(db)).length, 2)
})

// ═══ UYGULAMA ═════════════════════════════════════════════════════════════

test('CLEANUP-6: YALNIZ bozuk satir ve satirlari silinir', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { malformedId, validId } = await seedPair(db, organizationId, accountId)

  const result = await cleanup.cleanupMalformedOrder(db, targetFor(malformedId))
  assert.equal(result.applied, true)
  assert.equal(result.deletedOrders, 1)
  assert.equal(result.deletedOrderLines, 1)

  const rows = await allOrders(db)
  assert.equal(rows.length, 1, 'tek satir kalir')
  assert.equal(rows[0].id, validId)
  assert.equal(rows[0].packageId, VALID_PACKAGE_ID)
  assert.equal(rows[0].marketplaceStatus, 'Created', 'gecerli satir DOKUNULMAZ')

  // Bagli satirlar da gitti.
  const lines = await db
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(eq(orderLines.orderId, malformedId))
  assert.equal(lines.length, 0)
})

test('CLEANUP-7: ikinci calistirma IDEMPOTENT (hedef yok)', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { malformedId } = await seedPair(db, organizationId, accountId)
  await cleanup.cleanupMalformedOrder(db, targetFor(malformedId))
  const again = await cleanup.cleanupMalformedOrder(db, targetFor(malformedId))
  assert.equal(again.applied, false)
  assert.deepEqual(again.violations, ['target_not_found'])
})

test('CLEANUP-8: BASKA bozuk satirlara DOKUNULMAZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  const { malformedId } = await seedPair(db, organizationId, accountId)
  // Ayni organizasyonda BASKA bir bozuk satir. (packageId tekilligi
  // (org, marketplace, account, package_id) oldugu icin farkli bir yer
  // tutucu deger kullanilir.)
  await db.insert(orders).values({
    organizationId,
    marketplaceAccountId: accountId,
    marketplace: 'Trendyol',
    packageId: 'null',
    orderNumber: '11400000000',
    marketplaceStatus: 'Unknown',
    operationStatus: 'NEW',
    orderDate: new Date('2026-08-10T14:00:00.000Z'),
  })
  await cleanup.cleanupMalformedOrder(db, targetFor(malformedId))
  const rows = await allOrders(db)
  assert.equal(rows.length, 2, 'yalniz hedef silindi')
  assert.ok(rows.some((row) => row.orderNumber === '11400000000'))
})

// ═══ KAPSAM VE GUVENLIK ═══════════════════════════════════════════════════

test('CLEANUP-9: modul tasiyici/pazaryeri yazma yuzeyi ICERMEZ', () => {
  const source = readFileSync('server/orders/malformedOrderCleanup.ts', 'utf8')
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of [
    'callTrendyol',
    'fetch(',
    'surat',
    'zpl',
    'persistSyncResult',
    'delete(shipments)',
    'delete(shipmentOperations)',
  ]) {
    assert.equal(
      code.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      forbidden,
    )
  }
  // Silme YALNIZ iki tabloda ve TEK transaction icinde.
  assert.ok(code.includes('database.transaction('))
  assert.ok(code.includes('.delete(orderLines)'))
  assert.ok(code.includes('.delete(orders)'))
})

test('CLEANUP-10: CLI varsayilan KURU CALISMA ve guard sarti', () => {
  const cli = readFileSync('server/orders/malformedOrderCleanupCli.ts', 'utf8')
  // Silme YALNIZ acik --apply ile.
  assert.ok(cli.includes("process.argv.includes('--apply')"))
  assert.ok(cli.includes('apply && guardDeployed && inspection.safe'))
  // Dort kimlik parametresi de ZORUNLU.
  assert.ok(
    cli.includes('!id || !malformedPackageId || !orderNumber || !validPackageId'),
  )
  // Guard deploy edilmemisse uygulama YOK.
  assert.ok(cli.includes('isIdentityGuardDeployed'))
  // Toplu temizlik yuzeyi YOK.
  for (const forbidden of ['--all', 'deleteMany', 'inArray(']) {
    assert.equal(cli.includes(forbidden), false, forbidden)
  }
})

test('CLEANUP-11: kimlik guard\'i kaynakta DURUYOR', () => {
  const entry = readFileSync('server/index.mjs', 'utf8')
  assert.ok(entry.includes('function resolveTrendyolPackageIdentity'))
  assert.ok(entry.includes('PLACEHOLDER_PACKAGE_IDENTITIES'))
  // Calisan sistemler degismedi.
  assert.ok(entry.includes('resolveActiveMarketplaceAccountId('))
  assert.ok(entry.includes('incomingIsNewer'))
  assert.ok(entry.includes('startStaleOpenReconcileOnBoot'))
})
