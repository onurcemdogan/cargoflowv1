import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// REPRINT backend — KAYITLI etiket artifact çözümü (resolvePersistedLabel) +
// cross-operation ZPL tarama + tenant izolasyonu. Provider'a ÇIKMAZ, yeni
// shipment/barkod OLUŞTURMAZ, desi doğrulaması YAPMAZ. Org yalnız context'ten.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const orderService = await import('./orders/orderPersistenceService.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')
const operationRepo = await import('./shipments/shipmentOperationRepository.ts')

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
// GERÇEK ÜRETİM operation record'u — `shipment` alanı YOK; ZPL technicalZpl'de.
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

test('RLB-1: gerçek shape — LABEL_READY + technicalZpl → resolvePersistedLabel eligible, zpl döner', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org A', 'reprint-a')
  const order = makeOrder({ packageId: 'A-1', orderNumber: '11452948259' })
  const orderId = await seedLabelReady(db, org, order)

  const result = await orderService.resolvePersistedLabel(db, org, orderId)
  assert.equal(result.found, true)
  assert.equal(result.eligible, true)
  assert.equal(result.hasPrintableLabel, true)
  assert.equal(result.zpl, '^XA^FD01252765588^FS^XZ')
  assert.ok(result.zpl.startsWith('^XA'))
})

test('RLB-2: hasPrintableLabel=true fakat ham ZPL yok (yalnız sha256/length) → zpl=null (kontrollü)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org B', 'reprint-b')
  const order = makeOrder({ packageId: 'B-1', orderNumber: '11452948260' })
  // technicalZpl BOŞ; hasPrintableLabel yine true (sha256/length var).
  const orderId = await seedLabelReady(db, org, order, {
    technicalZpl: '',
    technicalZplSha256: 'b'.repeat(64),
    technicalZplLength: 100,
  })

  const result = await orderService.resolvePersistedLabel(db, org, orderId)
  assert.equal(result.found, true)
  assert.equal(result.eligible, true)
  assert.equal(result.hasPrintableLabel, true)
  // Ham ZPL gerçekten yok → null (çağıran "kayıtlı etiket alınamadı" gösterir),
  // "etiket yok" olarak fresh-create'e düşürülmez.
  assert.equal(result.zpl, null)
})

test('RLB-3: cross-operation — ham ZPL daha ESKİ operasyonda; findPrintableZplByPackage bulur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org C', 'reprint-c')
  const order = makeOrder({ packageId: 'C-1', orderNumber: '11452948261' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  // Op1: ZPL taşıyan create (succeeded).
  await shipmentService.writeOperationRecord(
    db,
    org,
    productionRecord(org, order, {
      idempotencyKey: `SURAT:org_${org}:${order.orderNumber}:CREATE`,
      status: 'SUCCESS',
      technicalZpl: '^XA^FDCROSS-OP^FS^XZ',
    }),
  )
  // Op2: sonraki operasyon (farklı key) — ham ZPL YOK, yalnız metadata.
  await shipmentService.writeOperationRecord(
    db,
    org,
    productionRecord(org, order, {
      idempotencyKey: `SURAT:org_${org}:${order.orderNumber}:RETRANSMIT`,
      operation: 'BarkodTekrarIlet',
      status: 'SUCCESS',
      technicalZpl: '',
      technicalZplSha256: 'c'.repeat(64),
      technicalZplLength: 42,
    }),
  )

  const found = await operationRepo.findPrintableZplByPackage(db, org, 'C-1')
  assert.ok(found, 'daha eski operasyondaki ZPL bulunur')
  assert.equal(found.zpl, '^XA^FDCROSS-OP^FS^XZ')
})

test('RLB-4: tenant izolasyonu — Tenant B, Tenant A siparişinin etiketini ALAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A2', 'reprint-a2')
  const orgB = await makeOrg(db, 'Org B2', 'reprint-b2')
  const order = makeOrder({ packageId: 'X-1', orderNumber: '11452948262' })
  const orderId = await seedLabelReady(db, orgA, order)

  // Org B, org A'nın orderId'siyle ister → getOrder org-scoped → found:false.
  const result = await orderService.resolvePersistedLabel(db, orgB, orderId)
  assert.equal(result.found, false)
  assert.equal(result.zpl, null)
})
