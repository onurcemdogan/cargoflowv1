import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// TAM BAŞARILI (complete) sync sonrası aktif liste reconciliation.
// Kural: provider'ın güncel aktif paketlerinde BULUNMAYAN kayıtlardan YALNIZ
// güçlü operasyon kanıtı OLMAYANLAR (NEW/BARCODE_WAITING + etiketsiz + shipmentsız)
// arşivlenir. LABEL_READY/PRINTED/SHIPPED/DELIVERED/terminal-marketplace/shipment
// KORUNUR. complete=false (kısmi/başarısız) sync HİÇBİR kaydı arşivlemez.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const orderService = await import('./orders/orderPersistenceService.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')

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
function order(over = {}) {
  const packageId = over.packageId
  return {
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `114${packageId}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'A',
    customerLastName: 'B',
    city: 'İstanbul',
    totalAmount: 100,
    currency: 'TRY',
    orderDate: '2026-07-26T08:00:00Z',
    rawOrder: {},
    items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}
async function archivedAtOf(db, packageId) {
  const [row] = await db
    .select({ archivedAt: schema.orders.archivedAt })
    .from(schema.orders)
    .where(eq(schema.orders.packageId, packageId))
  return row?.archivedAt ?? null
}

test('RCN-1: complete sync — bayat NEW/etiketsiz sipariş aktif kuyruktan çıkar (arşivlenir)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rcn-1')
  // İlk sync: STALE-1 (bayat NEW) DB'ye girer.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'STALE-1' })], { complete: true })
  // İkinci TAM sync: yalnız ACTIVE-1 gelir; STALE-1 artık aktif değil.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'ACTIVE-1' })], { complete: true })
  assert.ok(await archivedAtOf(db, 'STALE-1'), 'bayat NEW arşivlendi')
  assert.equal(await archivedAtOf(db, 'ACTIVE-1'), null, 'aktif sipariş korunur')
})

test('RCN-2: complete sync — LABEL_READY ve LABEL_PRINTED korunur (arşivlenmez)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rcn-2')
  // Canonical güçlü operationStatus (persist edilmiş DB durumu).
  await orderService.persistSyncResult(
    db,
    org,
    [
      order({ packageId: 'READY-1', operationStatus: 'LABEL_READY' }),
      order({ packageId: 'PRINTED-1', operationStatus: 'LABEL_PRINTED' }),
    ],
    { complete: true },
  )
  // Sonraki tam sync'te ikisi de aktif set'te YOK.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'OTHER' })], { complete: true })
  assert.equal(await archivedAtOf(db, 'READY-1'), null, 'LABEL_READY korunur')
  assert.equal(await archivedAtOf(db, 'PRINTED-1'), null, 'LABEL_PRINTED korunur')
})

test('RCN-3: complete sync — terminal marketplace (Shipped/Delivered) korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rcn-3')
  await orderService.persistSyncResult(
    db,
    org,
    [
      order({ packageId: 'SHIPPED-1', marketplaceStatus: 'Shipped', operationStatus: 'HANDED_TO_CARGO' }),
      order({ packageId: 'DELIVERED-1', marketplaceStatus: 'Delivered', operationStatus: 'DELIVERED' }),
    ],
    { complete: true },
  )
  await orderService.persistSyncResult(db, org, [order({ packageId: 'ACTIVE' })], { complete: true })
  assert.equal(await archivedAtOf(db, 'SHIPPED-1'), null, 'Shipped korunur')
  assert.equal(await archivedAtOf(db, 'DELIVERED-1'), null, 'Delivered korunur')
})

test('RCN-4: complete sync — shipment taşıyan kayıt korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rcn-4')
  const o = order({ packageId: 'SHIP-1' })
  await orderService.persistSyncResult(db, org, [o], { complete: true })
  await shipmentService.writeOperationRecord(db, org, {
    idempotencyKey: `SURAT:org_${org}:${o.orderNumber}:CREATE`,
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'SHIP-1',
    orderNumber: o.orderNumber,
    orderId: o.orderNumber,
    provider: 'surat',
    operation: 'OrtakBarkodOlustur',
    status: 'SUCCESS',
    createCallCount: 1,
    technicalZpl: '^XA^FD01^FS^XZ',
  })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'ACTIVE' })], { complete: true })
  assert.equal(await archivedAtOf(db, 'SHIP-1'), null, 'shipmentli kayıt korunur')
})

test('RCN-5: PARTIAL (complete=false) — hiçbir kayıt arşivlenmez, mevcut liste korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rcn-5')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'STALE-1' })], { complete: true })
  // Kısmi sync: farklı aktif liste gelse bile reconcile YAPILMAZ.
  const result = await orderService.persistSyncResult(db, org, [order({ packageId: 'ACTIVE-1' })], { complete: false })
  assert.equal(result.archivedCount, 0)
  assert.equal(await archivedAtOf(db, 'STALE-1'), null, 'kısmi sync bayat kaydı silmez')
})

test('RCN-6: gerçek örnek 727 kayıtları — zayıf ise arşivlenir, güçlü ise korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rcn-6')
  await orderService.persistSyncResult(
    db,
    org,
    [
      order({ packageId: 'PKG-58784725', cargoTrackingNumber: '7270034958784725' }),
      order({ packageId: 'PKG-52601608', cargoTrackingNumber: '7270034952601608', operationStatus: 'LABEL_PRINTED' }),
    ],
    { complete: true },
  )
  // İki örnek de güncel aktif set'te YOK.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'ACTIVE' })], { complete: true })
  // Zayıf (NEW, etiketsiz) → arşiv.
  assert.ok(await archivedAtOf(db, 'PKG-58784725'), 'zayıf 727 arşivlendi')
  // Güçlü (LABEL_PRINTED) → korunur.
  assert.equal(await archivedAtOf(db, 'PKG-52601608'), null, 'güçlü 727 korunur')
})

test('RCN-7: güncel aktif set içindeki sipariş arşivlenmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rcn-7')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'KEEP-1' })], { complete: true })
  // Aynı paket tekrar aktif gelir → korunur.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'KEEP-1' })], { complete: true })
  assert.equal(await archivedAtOf(db, 'KEEP-1'), null)
})

test('RCN-8: tenant izolasyonu — reconcile yalnız kendi org kayıtlarını etkiler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'rcn-a')
  const orgB = await makeOrg(db, 'rcn-b')
  await orderService.persistSyncResult(db, orgA, [order({ packageId: 'A-STALE' })], { complete: true })
  await orderService.persistSyncResult(db, orgB, [order({ packageId: 'B-KEEP' })], { complete: true })
  // Org A tam sync: A-STALE aktif değil → arşiv. Org B'ye DOKUNMAZ.
  await orderService.persistSyncResult(db, orgA, [order({ packageId: 'A-ACTIVE' })], { complete: true })
  assert.ok(await archivedAtOf(db, 'A-STALE'))
  assert.equal(await archivedAtOf(db, 'B-KEEP'), null, 'diğer tenant etkilenmez')
})
