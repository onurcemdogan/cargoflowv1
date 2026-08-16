import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, and } from 'drizzle-orm'
import { createServer } from 'vite'

// "Etiket Basıldı" durum akışı regresyonu.
// Kök neden: rozet (mapOperationStatus) ve reload türetmesi (getOrderOperationStatus)
// shipment/verification sinyalinden türetiyor, canonical order.operationStatus'ü
// ÖNCELİKLE dikkate almıyordu → LABEL_READY rozeti "Barkod Bekliyor" görünüyor,
// LABEL_PRINTED yenilemede LABEL_READY'ye düşüyordu. Öncelik: operationStatus >
// shipment/label > legacy. NOT: tarayıcı fiziksel baskıyı kesin doğrulayamaz;
// LABEL_PRINTED kullanıcının yazdırma aksiyonunu başlattığını ifade eder.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
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
async function setOperationStatus(db, org, packageId, status) {
  await db.update(schema.orders)
    .set({ operationStatus: status })
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, packageId)))
}
async function orderIdFor(db, packageId) {
  const [row] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, packageId))
  return row.id
}
async function operationStatusFor(db, packageId) {
  const [row] = await db.select({ operationStatus: schema.orders.operationStatus }).from(schema.orders).where(eq(schema.orders.packageId, packageId))
  return row.operationStatus
}

// ---- Rozet (badge) ve reload türetmesi: canonical operationStatus önceliği ----
test('1,2,4,5: rozet canonical operationStatus önceliğini kullanır', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, })
  t.after(() => vite.close())
  const { mapOperationStatus } = await vite.ssrLoadModule('/src/utils/statusPresentation.ts')
  const { withDerivedOperationStatus } = await vite.ssrLoadModule('/src/utils/orderStatus.ts')

  // Ön-atanmış (verifiedShipment=false) ama canonical LABEL_READY sipariş.
  const labelReadyOrder = {
    id: 'o1', orderNumber: 'O1', marketplace: 'Trendyol', marketplaceStatus: 'Created',
    operationStatus: 'LABEL_READY', labelStatus: 'READY', items: [],
    shipment: {
      id: 's1', barcodeRaw: '^XA^FD01252765588^FS^XZ', printEnabled: true,
      verifiedShipment: false, dispatchRegistrationConfirmed: false,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    },
  }
  // (1) rozet "Etiket Hazır"; (2) "Barkod Bekliyor" DEĞİL.
  assert.equal(mapOperationStatus(labelReadyOrder).label, 'Etiket Hazır')
  assert.notEqual(mapOperationStatus(labelReadyOrder).label, 'Barkod Bekliyor')

  // (4) canonical LABEL_PRINTED → rozet "Etiket Basıldı" (label.printedAt olmasa bile).
  const printedOrder = { ...labelReadyOrder, id: 'o2', operationStatus: 'LABEL_PRINTED', labelStatus: 'PRINTED' }
  assert.equal(mapOperationStatus(printedOrder).label, 'Etiket Basıldı')

  // (5) Sayfa yenileme (DB reload) simülasyonu: withDerivedOperationStatus
  // LABEL_PRINTED'i shipment türetmesiyle LABEL_READY'ye DÜŞÜRMEZ.
  const reloaded = withDerivedOperationStatus(printedOrder)
  assert.equal(reloaded.operationStatus, 'LABEL_PRINTED', 'yenilemede LABEL_PRINTED korunur')
  assert.equal(mapOperationStatus(reloaded).label, 'Etiket Basıldı')
  // LABEL_READY sipariş de yenilemede korunur.
  assert.equal(withDerivedOperationStatus(labelReadyOrder).operationStatus, 'LABEL_READY')
})

// ---- Backend geçiş: markLabelPrinted (atomik, idempotent, no-regress, tenant) ----
test('3: LABEL_READY → yazdırma sonrası DB operationStatus=LABEL_PRINTED', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org P', 'printed-a')
  const order = makeOrder({ packageId: 'P-1', orderNumber: 'P-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await setOperationStatus(db, org, 'P-1', 'LABEL_READY')

  const result = await orderService.markLabelPrinted(db, org, await orderIdFor(db, 'P-1'))
  assert.equal(result.updated, true)
  assert.equal(result.operationStatus, 'LABEL_PRINTED')
  assert.equal(await operationStatusFor(db, 'P-1'), 'LABEL_PRINTED')
  // marketplaceStatus dokunulmaz.
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.packageId, 'P-1'))
  assert.equal(row.marketplaceStatus, 'Created')
})

test('6,7: tekrar yazdırma idempotent — duplicate/regress yok, shipment değişmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org I', 'printed-i')
  const order = makeOrder({ packageId: 'I-1', orderNumber: 'I-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await setOperationStatus(db, org, 'I-1', 'LABEL_READY')
  const id = await orderIdFor(db, 'I-1')

  const first = await orderService.markLabelPrinted(db, org, id)
  assert.equal(first.updated, true)
  const shipmentsBefore = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  // (6) tekrar çağrı: idempotent, updated=false ama ok, hâlâ LABEL_PRINTED.
  const second = await orderService.markLabelPrinted(db, org, id)
  assert.equal(second.found, true)
  assert.equal(second.updated, false)
  assert.equal(second.operationStatus, 'LABEL_PRINTED')
  assert.equal(await operationStatusFor(db, 'I-1'), 'LABEL_PRINTED')
  // (7) yazdırma geçişi shipment/barkod OLUŞTURMAZ/DEĞİŞTİRMEZ (provider çağrısı yok).
  const shipmentsAfter = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(shipmentsAfter.length, shipmentsBefore.length)
})

test('8: SHIPPED/DELIVERED gibi ileri statü LABEL_PRINTED ile GERİ DÜŞMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org S', 'printed-s')
  for (const [pkg, status] of [['S-1', 'HANDED_TO_CARGO'], ['S-2', 'DELIVERED'], ['S-3', 'SHIPPED']]) {
    const order = makeOrder({ packageId: pkg, orderNumber: pkg })
    await orderService.persistSyncResult(db, org, [order], { complete: true })
    await setOperationStatus(db, org, pkg, status)
    const result = await orderService.markLabelPrinted(db, org, await orderIdFor(db, pkg))
    assert.equal(result.updated, false, `${status} güncellenmez`)
    assert.equal(result.reason, undefined, `${status} idempotent kabul (label_required değil)`)
    assert.equal(await operationStatusFor(db, pkg), status, `${status} korunur (no-regress)`)
  }
})

test('label_required: yazdırılabilir etiket yoksa (LABEL_READY değil) 409 sinyali', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org R', 'printed-r')
  const order = makeOrder({ packageId: 'R-1', orderNumber: 'R-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true }) // NEW
  const result = await orderService.markLabelPrinted(db, org, await orderIdFor(db, 'R-1'))
  assert.equal(result.updated, false)
  assert.equal(result.reason, 'label_required')
  assert.equal(await operationStatusFor(db, 'R-1'), 'NEW', 'label yoksa status değişmez')
})

test('9: farklı tenant başka tenant siparişini LABEL_PRINTED yapamaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A', 'printed-tenant-a')
  const orgB = await makeOrg(db, 'Org B', 'printed-tenant-b')
  const order = makeOrder({ packageId: 'X-1', orderNumber: 'X-1' })
  await orderService.persistSyncResult(db, orgA, [order], { complete: true })
  await setOperationStatus(db, orgA, 'X-1', 'LABEL_READY')
  const idA = await orderIdFor(db, 'X-1')

  // Org B, org A'nın orderId'siyle → bulunamaz, org A değişmez.
  const cross = await orderService.markLabelPrinted(db, orgB, idA)
  assert.equal(cross.found, false)
  assert.equal(await operationStatusFor(db, 'X-1'), 'LABEL_READY', 'tenant izolasyonu: org A korunur')
})
