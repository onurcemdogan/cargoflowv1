import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// Ön-atanmış (preassigned) etiket = LABEL OLUŞTURMA başarısı. Gerçek üretim kanıtı
// (T.No 11820824092123 / barkod 01252765588, LABEL_READY_AWAITING_ACCEPTANCE,
// verifiedShipment=false). Bu durumda canonical shipment PERSIST edilmeli ki
// markLabelReady (findShipment) çalışsın ve sipariş kalıcı "Etiket Hazır" olsun.
// Fiziksel kabul doğrulaması (verifiedShipment) etiket-hazır için ŞART DEĞİLDİR.

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
  const [org] = await db.insert(schema.organizations).values({ name, slug }).returning()
  return org.id
}
let seq = 0
function makeOrder(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`, marketplaceStatus: 'Created',
    operationStatus: 'NEW', customerFirstName: 'Ada', customerLastName: 'L',
    city: 'İstanbul', district: 'Kadıköy', totalAmount: 100, currency: 'TRY',
    orderDate: '2026-07-26T08:00:00Z', rawOrder: {}, items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}
// Üretim kanıtına birebir: preassigned-ready operation record (status UNKNOWN).
function preassignedRecord(org, order) {
  return {
    idempotencyKey: `SURAT:org_${org}:${order.orderNumber}:CREATE`,
    organizationId: org, marketplace: 'Trendyol', packageId: order.packageId,
    orderNumber: order.orderNumber, orderId: order.orderNumber, provider: 'surat',
    operation: 'OrtakBarkodOlustur', status: 'UNKNOWN', createCallCount: 1,
    completedAt: '2026-07-26T09:00:00Z',
    // Ön-atanmış: carrier* BOŞ, T.No/barkod aday alanlarda; ZPL alındı.
    carrierTrackingNumber: '', carrierBarcodeNumber: '',
    candidateTrackingNumber: '11820824092123', candidateBarcodeNumber: '01252765588',
    technicalZpl: '^XA^FD01252765588^FS^XZ',
    verificationStatus: 'LABEL_CREATED_UNVERIFIED',
    shipment: {
      tNo: '11820824092123', barkodNo: '01252765588', barcodeRaw: '^XA^FD01252765588^FS^XZ',
      labelStatus: 'READY', printEnabled: true, verifiedShipment: false,
      dispatchRegistrationConfirmed: false,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    },
  }
}

test('isSuratRecordPreassignedReady: geçerli T.No+barkod+ZPL → true; FAILED_SAFE/kimliksiz → false', () => {
  const ok = shipmentService.isSuratRecordPreassignedReady(preassignedRecord('o', makeOrder({ packageId: 'X' })))
  assert.equal(ok, true)
  assert.equal(shipmentService.isSuratRecordPreassignedReady({ status: 'FAILED_SAFE', candidateTrackingNumber: '1', candidateBarcodeNumber: '2', technicalZpl: 'z' }), false)
  assert.equal(shipmentService.isSuratRecordPreassignedReady({ status: 'UNKNOWN', shipment: { lifecycleStatus: 'SURAT_CREATED_NO_TRACKING' } }), false)
  assert.equal(shipmentService.isSuratRecordPreassignedReady({ status: 'UNKNOWN', candidateTrackingNumber: '1', candidateBarcodeNumber: '2' }), false, 'ZPL yoksa false')
})

test('Preassigned create canonical shipment PERSIST eder → markLabelReady çalışır (LABEL_READY)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org P', 'preassign-a')
  const order = makeOrder({ packageId: 'P-1', orderNumber: 'P-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })

  // Preassigned create kaydı yazılır (verifiedShipment=false).
  await shipmentService.writeOperationRecord(db, org, preassignedRecord(org, order))

  // Canonical shipment satırı OLUŞTU (findShipment bulur).
  const shipmentRows = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(shipmentRows.length, 1, 'preassigned için shipment satırı yazılır')
  assert.equal(shipmentRows[0].trackingNumber, '11820824092123', 'canonical tracking = Sürat T.No')

  // markLabelReady artık çalışır (fiziksel doğrulama şart değil).
  const [row] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'P-1'))
  const result = await orderService.markLabelReady(db, org, row.id)
  assert.equal(result.found, true)
  assert.equal(result.updated, true)
  assert.equal(result.operationStatus, 'LABEL_READY')
  const [orderRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, row.id))
  assert.equal(orderRow.operationStatus, 'LABEL_READY')
  assert.equal(orderRow.marketplaceStatus, 'Created', 'marketplaceStatus dokunulmaz')
})

test('Gerçek business failure (kimliksiz/FAILED_SAFE) shipment YAZMAZ → markLabelReady reddeder', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org F', 'preassign-fail')
  const order = makeOrder({ packageId: 'F-1', orderNumber: 'F-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })

  await shipmentService.writeOperationRecord(db, org, {
    idempotencyKey: `SURAT:org_${org}:F-1:CREATE`, organizationId: org,
    marketplace: 'Trendyol', packageId: 'F-1', orderNumber: 'F-1', orderId: 'F-1',
    provider: 'surat', operation: 'OrtakBarkodOlustur', status: 'FAILED_SAFE',
    createCallCount: 1, completedAt: '2026-07-26T09:00:00Z',
    shipment: { lifecycleStatus: 'SURAT_DISPATCH_REJECTED', labelStatus: 'BLOCKED' },
  })
  const shipmentRows = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(shipmentRows.length, 0, 'business failure için shipment YAZILMAZ (sahte gönderi yok)')

  const [row] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'F-1'))
  const result = await orderService.markLabelReady(db, org, row.id)
  assert.equal(result.updated, false)
  assert.equal(result.reason, 'shipment_required')
})
