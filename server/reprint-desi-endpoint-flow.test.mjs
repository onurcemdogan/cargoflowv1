import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// REPRINT desi korunumu — backend.
// Kök neden: orders tablosunda desi KOLONU YOK; order.desi yalnız bellekte
// (create-time hesap). Sayfa yenilemesinde order.desi kaybolur → reprint HTML
// etiketi "Top Ds/Kg" alanı "-" basar. Düzeltme: kalıcı operation payload.desi
// (ilk create girişi) ve ham ZPL'e gömülü desi read-time olarak order.desi'ye
// ve label endpoint'ine geri yansıtılır (YENİ KOLON YOK).

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
async function makeOrg(db, name, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, slug })
    .returning()
  return org.id
}
let seq = 0
function makeOrder(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? '11452948259',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'Ada',
    customerLastName: 'L',
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 100,
    currency: 'TRY',
    orderDate: '2026-07-26T08:00:00Z',
    rawOrder: {},
    items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}
function productionRecord(org, order, over = {}) {
  return {
    idempotencyKey: `SURAT:org_${org}:${order.orderNumber}:CREATE`,
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: order.packageId,
    orderNumber: order.orderNumber,
    orderId: order.orderNumber,
    provider: 'surat',
    operation: 'OrtakBarkodOlustur',
    status: 'UNKNOWN',
    createCallCount: 1,
    completedAt: '2026-07-26T09:00:00Z',
    candidateTrackingNumber: '11820824092123',
    candidateBarcodeNumber: '01252765588',
    ozelKargoTakipNo: '7270034994447844',
    technicalZpl: '^XA^FD01252765588^FS^XZ',
    technicalZplSha256: 'a'.repeat(64),
    technicalZplLength: 24,
    // İlk create'te kullanıcının girdiği desi kalıcı payload'da tutulur.
    desi: 2,
    desiSource: 'MANUAL_USER_CONFIRMED',
    verificationStatus: 'LABEL_CREATED_UNVERIFIED',
    ...over,
  }
}
async function seedLabelReady(db, org, order, recordOver = {}) {
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(
    db,
    org,
    productionRecord(org, order, recordOver),
  )
  const [row] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.packageId, order.packageId))
  await orderService.markLabelReady(db, org, row.id)
  return row.id
}

test('RDP-1: payload.desi=2 → GET order.desi=2 (reload korunur) ve resolvePersistedLabel.desi=2', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org A', 'desi-a')
  const order = makeOrder({ packageId: 'A-1', orderNumber: '11452948259' })
  const orderId = await seedLabelReady(db, org, order)

  const view = await orderService.getOrder(db, org, orderId)
  assert.equal(view.desi, 2, 'reload sonrası order.desi kalıcı payload’dan gelir')

  const label = await orderService.resolvePersistedLabel(db, org, orderId)
  assert.equal(label.eligible, true)
  assert.equal(label.desi, 2)
  assert.ok(label.zpl)
})

test('RDP-2: payload.desi yok fakat ham ZPL "Top Ds/Kg 2.00" → desi=2 (ZPL ekstraksiyon)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org B', 'desi-b')
  const order = makeOrder({ packageId: 'B-1', orderNumber: '11452948260' })
  const orderId = await seedLabelReady(db, org, order, {
    desi: 0,
    technicalZpl: '^XA^FDTop Ds/Kg^FS^FD2.00^FS^FD01252765588^FS^XZ',
  })
  const label = await orderService.resolvePersistedLabel(db, org, orderId)
  assert.equal(label.desi, 2)
})

test('RDP-3: ham ZPL yok + payload.desi=2.5 → kontrollü legacy fallback desiyi korur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org C', 'desi-c')
  const order = makeOrder({ packageId: 'C-1', orderNumber: '11452948261' })
  const orderId = await seedLabelReady(db, org, order, {
    desi: 2.5,
    technicalZpl: '', // ham ZPL yok
    technicalZplSha256: 'c'.repeat(64), // hasPrintableLabel yine true
    technicalZplLength: 100,
  })
  const label = await orderService.resolvePersistedLabel(db, org, orderId)
  assert.equal(label.hasPrintableLabel, true)
  assert.equal(label.zpl, null)
  assert.equal(label.desi, 2.5)
})

test('RDP-4: ham ZPL ve desi yok → zpl=null, desi=null (sessiz "-" üretmez; kontrollü)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org D', 'desi-d')
  const order = makeOrder({ packageId: 'D-1', orderNumber: '11452948262' })
  const orderId = await seedLabelReady(db, org, order, {
    desi: 0,
    technicalZpl: '',
    technicalZplSha256: 'd'.repeat(64),
    technicalZplLength: 100,
  })
  const label = await orderService.resolvePersistedLabel(db, org, orderId)
  assert.equal(label.zpl, null)
  assert.equal(label.desi, null)
})

test('RDP-5: tenant izolasyonu — Tenant B, Tenant A siparişinin desisini/etiketini ALAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A2', 'desi-a2')
  const orgB = await makeOrg(db, 'Org B2', 'desi-b2')
  const order = makeOrder({ packageId: 'X-1', orderNumber: '11452948263' })
  const orderId = await seedLabelReady(db, orgA, order)

  const label = await orderService.resolvePersistedLabel(db, orgB, orderId)
  assert.equal(label.found, false)
  assert.equal(label.zpl, null)
  assert.equal(label.desi, null)
})
