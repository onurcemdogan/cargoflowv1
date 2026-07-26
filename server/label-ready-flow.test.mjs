import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// Etiket-hazır (LABEL_READY) durum geçişinin KALICI persistlenmesi regresyon
// testleri (1-10). Kök neden: auth modda persistOrders yalnız in-memory snapshot
// günceller; operationStatus=LABEL_READY DB'ye yazılmadığından sayfa yenilenince
// sipariş "Etiket Hazır" sekmesinde görünmüyordu. Fix: backend markLabelReady
// (atomik, tenant-scoped, idempotent, no-regress) + canonical operationStatus'ü
// otoriter sayan classifier.

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
  for (const statement of migrationStatements()) await pglite.exec(statement)
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
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`,
    marketplaceStatus: over.marketplaceStatus ?? 'Created',
    operationStatus: over.operationStatus ?? 'NEW',
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerPhone: '5550000000',
    shipmentAddress: { fullAddress: 'Gizli Mah. 1', city: 'İstanbul', district: 'Kadıköy' },
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 149.9,
    currency: 'TRY',
    orderDate: '2026-07-10T08:00:00Z',
    rawOrder: { secretField: 'RAW' },
    items: [{ id: `line-${packageId}`, barcode: 'BRC-1', productName: 'Ürün', quantity: 1, price: 149.9 }],
    ...over,
  }
}
// Sürat gönderisi (local_create) yazar: markLabelReady'nin backend ön-koşulu.
async function writeShipment(db, org, order) {
  await shipmentService.writeOperationRecord(db, org, {
    idempotencyKey: `SURAT:${org}:${order.orderNumber}:CREATE`,
    marketplace: 'Trendyol',
    packageId: order.packageId,
    orderNumber: order.orderNumber,
    orderId: order.orderNumber,
    provider: 'surat',
    operation: 'OrtakBarkodOlustur',
    status: 'SUCCESS',
    createCallCount: 1,
    completedAt: '2026-07-11T00:00:00Z',
    carrierTrackingNumber: '2512361562501',
    carrierBarcodeNumber: '0123990557601',
    shipment: { barcodeRaw: '^XA^XZ', senderNumber: '13177122192332' },
  })
}
async function orderIdByPackage(db, org, packageId) {
  const rows = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.packageId, packageId))
  return rows[0]?.id
}

test('1 & 2) Etiket başarıyla oluşturulur → DB operasyon durumu LABEL_READY olur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org A', 'lbl-a')
  const order = makeOrder({ packageId: 'L-1', orderNumber: 'L-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await writeShipment(db, org, order)
  const id = await orderIdByPackage(db, org, 'L-1')

  const result = await orderService.markLabelReady(db, org, id)
  assert.equal(result.found, true)
  assert.equal(result.updated, true)
  assert.equal(result.operationStatus, 'LABEL_READY')
  // (2) DB satırı canonical LABEL_READY.
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id))
  assert.equal(row.operationStatus, 'LABEL_READY')
  // Pazaryeri status'ü DEĞİŞMEDİ (ayrı alan korunur).
  assert.equal(row.marketplaceStatus, 'Created')
})

test('5) Sayfa yenilendiğinde (DB re-read) durum korunur ve re-sync EZMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org B', 'lbl-b')
  const order = makeOrder({ packageId: 'L-2', orderNumber: 'L-2' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await writeShipment(db, org, order)
  const id = await orderIdByPackage(db, org, 'L-2')
  await orderService.markLabelReady(db, org, id)

  // DB re-read (yeni bağlantı) canonical durumu korur.
  const reread = await orderService.getOrder(drizzle(pglite, { schema }), org, id)
  assert.equal(reread.operationStatus, 'LABEL_READY')

  // Marketplace re-sync (status değişse bile) operationStatus'ü EZMEZ.
  await orderService.persistSyncResult(
    db,
    org,
    [makeOrder({ packageId: 'L-2', orderNumber: 'L-2', marketplaceStatus: 'Picking' })],
    { complete: false },
  )
  const [afterSync] = await db.select().from(schema.orders).where(eq(schema.orders.id, id))
  assert.equal(afterSync.operationStatus, 'LABEL_READY', 're-sync LABEL_READY ezmez')
  assert.equal(afterSync.marketplaceStatus, 'Picking', 'marketplace alanı güncellenir')
})

test('6) Provider/gönderi yokken status DEĞİŞMEZ (shipment_required)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org C', 'lbl-c')
  const order = makeOrder({ packageId: 'L-3', orderNumber: 'L-3', operationStatus: 'NEW' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  const id = await orderIdByPackage(db, org, 'L-3')

  // Gönderi (shipment) yok → geçiş yapılmaz.
  const result = await orderService.markLabelReady(db, org, id)
  assert.equal(result.found, true)
  assert.equal(result.updated, false)
  assert.equal(result.reason, 'shipment_required')
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id))
  assert.equal(row.operationStatus, 'NEW', 'önceki durum korunur')
})

test('7) Hatalı geçişte kısmi yazma olmaz (no-regress + tenant guard)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org D', 'lbl-d')
  // Var olmayan sipariş → found=false, hiçbir yazma olmaz.
  const missing = await orderService.markLabelReady(db, org, '00000000-0000-0000-0000-000000000000')
  assert.equal(missing.found, false)
  assert.equal(missing.updated, false)

  // No-regress: teslim edilmiş sipariş LABEL_READY'ye GERİ DÖNMEZ.
  const order = makeOrder({ packageId: 'L-4', orderNumber: 'L-4', operationStatus: 'DELIVERED' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await writeShipment(db, org, order)
  const id = await orderIdByPackage(db, org, 'L-4')
  const result = await orderService.markLabelReady(db, org, id)
  assert.equal(result.updated, false, 'ileri durumdan geri yazma yok')
  assert.equal(result.operationStatus, 'DELIVERED')
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id))
  assert.equal(row.operationStatus, 'DELIVERED', 'durum bozulmadı (kısmi yazma yok)')
})

test('8) Tekrar tıklamada duplicate label/shipment oluşmaz (idempotent)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org E', 'lbl-e')
  const order = makeOrder({ packageId: 'L-5', orderNumber: 'L-5' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await writeShipment(db, org, order)
  const id = await orderIdByPackage(db, org, 'L-5')

  const first = await orderService.markLabelReady(db, org, id)
  const second = await orderService.markLabelReady(db, org, id)
  assert.equal(first.updated, true)
  assert.equal(second.updated, false, 'ikinci çağrı idempotent (no-op)')
  assert.equal(second.operationStatus, 'LABEL_READY')

  // Sipariş kaydı TEK; markLabelReady yeni shipment/barkod OLUŞTURMAZ.
  const orderRows = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))
  assert.equal(orderRows.length, 1, 'duplicate sipariş yok')
  const shipmentRows = await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))
  assert.equal(shipmentRows.length, 1, 'duplicate shipment/barkod yok')
})

test('1b) Persist hatasından sonra tekrar deneme: mevcut shipment üzerinden LABEL_READY onarılır, yeni shipment OLUŞMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org R', 'lbl-repair')
  // İlk denemede persist BAŞARISIZ olmuş gibi: shipment persistli ama sipariş
  // etiket-öncesi bir durumda (rollback sonucu) kalmış.
  const order = makeOrder({ packageId: 'L-7', orderNumber: 'L-7', operationStatus: 'LABEL_CREATED_UNVERIFIED' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await writeShipment(db, org, order)
  const id = await orderIdByPackage(db, org, 'L-7')
  const shipmentsBefore = (await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))).length

  // Tekrar deneme (state repair): mevcut gönderi bulunur, yalnız geçiş tamamlanır.
  const result = await orderService.markLabelReady(db, org, id)
  assert.equal(result.found, true)
  assert.equal(result.updated, true)
  assert.equal(result.operationStatus, 'LABEL_READY')
  const shipmentsAfter = (await db.select().from(schema.shipments).where(eq(schema.shipments.organizationId, org))).length
  assert.equal(shipmentsAfter, shipmentsBefore, 'tekrar denemede yeni shipment/barkod oluşmaz')
})

test('9) Farklı tenant siparişi DEĞİŞTİRİLEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'A', 'lbl-iso-a')
  const orgB = await makeOrg(db, 'B', 'lbl-iso-b')
  const order = makeOrder({ packageId: 'L-6', orderNumber: 'L-6' })
  await orderService.persistSyncResult(db, orgA, [order], { complete: true })
  await writeShipment(db, orgA, order)
  const id = await orderIdByPackage(db, orgA, 'L-6')

  // Org B, Org A'nın siparişini göremez/değiştiremez.
  const cross = await orderService.markLabelReady(db, orgB, id)
  assert.equal(cross.found, false)
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id))
  assert.equal(row.operationStatus, 'NEW', 'çapraz tenant siparişi değişmedi')
})

// (3, 4, 10) Classifier: canonical LABEL_READY → Etiket Hazır (kısmi shipment
// payload'ıyla bile) + sekme sayacı + fresh liste türetmesi.
test('3 & 4 & 10) Canonical LABEL_READY sipariş Etiket Hazır sekmesinde görünür ve sayaç artar', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false } })
  t.after(() => vite.close())
  const { buildVisibleOrders, classifyOrderForTabs, orderMatchesQuickTab } =
    await vite.ssrLoadModule('/src/utils/orderClassification.ts')

  // Sayfa yenilendikten SONRA DB'den okunan sipariş şekli: canonical
  // operationStatus='LABEL_READY' + minimal shipment (attachShipment fallback;
  // dispatchRegistrationConfirmed/labelStatus persist EDİLMEMİŞ olabilir).
  const base = {
    marketplace: 'Trendyol',
    marketplaceStatus: 'Created',
    city: 'İstanbul',
    district: 'Kadıköy',
    customerName: 'Ada',
    orderDate: '2026-07-10T08:00:00.000Z',
    createdAt: '2026-07-10T08:00:00.000Z',
    items: [{ id: 'i1', productName: 'Ürün', barcode: 'BRC', quantity: 1 }],
  }
  const readyOrder = {
    ...base,
    id: 'o-ready',
    orderNumber: 'RDY-1',
    packageId: 'PKG-RDY',
    operationStatus: 'LABEL_READY',
    shipment: { trackingNumber: '2512361562501', barcode: '0123990557601' },
  }
  const cls = classifyOrderForTabs(readyOrder)
  // (3) Etiket Hazır grubunda; barkod-bekleyen DEĞİL (çelişkili çift sayım yok:
  // bir sipariş aynı anda hem "barkod bekliyor" hem "etiket hazır" olamaz).
  assert.equal(cls.isLabelReady, true, 'canonical LABEL_READY → isLabelReady')
  assert.equal(cls.isBarcodeWaiting, false, 'barkod bekleyen değil')
  assert.equal(orderMatchesQuickTab(cls, 'labelStage'), true)

  // Kontrast: canonical durumu olmayan (SHIPMENT_CREATED) aynı minimal shipment
  // Etiket Hazır DEĞİLDİR (fix'in canonical durumu otoriter saydığını kanıtlar).
  const notReady = { ...readyOrder, id: 'o-nr', packageId: 'PKG-NR', orderNumber: 'NR-1', operationStatus: 'SHIPMENT_CREATED' }
  assert.equal(classifyOrderForTabs(notReady).isLabelReady, false)

  // (4 & 10) DB'den okunan liste TÜRETİLEREK sayaç güncellenir (stale cache yok).
  const list = [readyOrder, notReady]
  const before = buildVisibleOrders({
    persistentOrders: list, selectedTab: 'labelStage', marketplaceFilter: 'all',
    operationStatusFilter: 'all', cargoFilter: 'all', dateFilter: { preset: 'all' },
    searchQuery: '', now: new Date('2026-07-12T00:00:00.000Z'),
  })
  assert.equal(before.debug.uniquePackageCount, 1, 'Etiket Hazır sayacı yalnız canonical ready siparişi içerir')
  assert.equal(before.visibleOrders[0].id, 'o-ready')
})
