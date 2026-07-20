import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// Sipariş/sipariş satırı tenant persistence (faz 5) hermetik testleri A-V.
// Gerçek PostgreSQL motoru (pglite) + gerçek unique constraint/index.
// Trendyol normalize/desi/print/package-identity akışına DOKUNMAZ; yalnız
// organization bazlı persistence + okuma + shipment linkage'i sınar.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const service = await import('./orders/orderPersistenceService.ts')
const repo = await import('./orders/orderRepository.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')
const { importLegacyOrders, extractLegacyOrders } = await import(
  './orders/importLegacyOrders.ts'
)

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
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerPhone: '5550000000',
    customerEmail: 'ada@example.com',
    shipmentAddress: { fullAddress: 'Gizli Mah. 1', city: 'İstanbul', district: 'Kadıköy' },
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 149.9,
    currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-10T08:00:00Z',
    rawOrder: { secretField: 'TOP-SECRET-RAW' },
    items: [
      {
        id: `line-${packageId}-1`,
        barcode: 'BRC-1',
        merchantSku: 'SKU-1',
        productContentId: 'CID-1',
        productName: 'Kablosuz Kulaklık',
        quantity: 2,
        price: 74.95,
        variantAttributes: [{ key: 'Renk', value: 'Siyah' }],
      },
    ],
    ...over,
  }
}

test('sipariş persistence A-V: izolasyon, sayfalama, operasyon koruması, şifreleme', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A', 'ord-a')
  const orgB = await makeOrg(db, 'Org B', 'ord-b')

  // A) Org A upsert eder; Org B göremez (izolasyon).
  const oA = makeOrder({ packageId: 'PA-1', orderNumber: 'A-1' })
  const r1 = await service.persistSyncResult(db, orgA, [oA], { complete: true })
  assert.equal(r1.insertedCount, 1)
  assert.equal(r1.persistedCount, 1)
  const listA = await service.listOrders(db, orgA, {})
  assert.equal(listA.total, 1)
  const listB = await service.listOrders(db, orgB, {})
  assert.equal(listB.total, 0, 'Org B, Org A siparişini görmez')

  // B) Aynı packageId farklı org'da bağımsız kayıt.
  await service.persistSyncResult(db, orgB, [makeOrder({ packageId: 'PA-1', orderNumber: 'B-1' })], { complete: true })
  assert.equal((await service.listOrders(db, orgB, {})).total, 1)
  assert.equal((await service.listOrders(db, orgA, {})).total, 1)

  // C) insert vs update sayımı: aynı paketi tekrar upsert → update.
  const r2 = await service.persistSyncResult(db, orgA, [oA], { complete: false })
  assert.equal(r2.updatedCount, 1)
  assert.equal(r2.insertedCount, 0)

  // D) Operasyonel state korunur: DB'de operationStatus ilerlet, sonra
  // marketplace sync gelsin — operationStatus EZİLMEZ.
  const rowA = (await service.listOrders(db, orgA, {})).orders[0]
  await db.update(schema.orders)
    .set({ operationStatus: 'LABEL_READY', archivedAt: null })
    .where(eq(schema.orders.id, rowA.id))
  await service.persistSyncResult(db, orgA, [{ ...oA, operationStatus: 'NEW', marketplaceStatus: 'Picking' }], { complete: false })
  const afterResync = await repo.findOrderById(db, orgA, rowA.id)
  assert.equal(afterResync.operationStatus, 'LABEL_READY', 'operationStatus korunur')
  assert.equal(afterResync.marketplaceStatus, 'Picking', 'marketplace alanı güncellenir')

  // E) Şifreleme at-rest: adres/raw düz metin DEĞİL.
  const rawRows = await db.select().from(schema.orders)
  const dump = JSON.stringify(rawRows)
  assert.ok(!dump.includes('TOP-SECRET-RAW'), 'raw payload şifreli')
  assert.ok(!dump.includes('Gizli Mah'), 'adres şifreli')
  for (const row of rawRows) {
    assert.ok(String(row.rawPayloadEncrypted).startsWith('{"v":1'))
    assert.ok(String(row.shippingAddressEncrypted).startsWith('{"v":1'))
  }
  // Okuma sırasında çözülür.
  assert.equal(rowA.city, 'İstanbul')
  assert.ok(rowA.rawOrder, 'raw okuma sırasında çözülür')

  // F) Satır upsert: duplicate externalLineId oluşmaz.
  const lineRows = await db.select().from(schema.orderLines).where(eq(schema.orderLines.organizationId, orgA))
  const lineIds = lineRows.map((l) => l.externalLineId)
  assert.equal(new Set(lineIds).size, lineIds.length, 'satırlar duplicate olmaz')

  // G) Sayfalama: 30 sipariş ekle, default pageSize 25.
  const orgP = await makeOrg(db, 'Org P', 'ord-p')
  const many = Array.from({ length: 30 }, (_, i) =>
    makeOrder({ packageId: `PP-${i}`, orderNumber: `P-${i}`, orderDate: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z` }))
  await service.persistSyncResult(db, orgP, many, { complete: true })
  const page1 = await service.listOrders(db, orgP, {})
  assert.equal(page1.pageSize, 25)
  assert.equal(page1.orders.length, 25)
  assert.equal(page1.total, 30)
  const page2 = await service.listOrders(db, orgP, { page: 2 })
  assert.equal(page2.orders.length, 5)

  // H) pageSize max 100 clamp.
  const clamped = await service.listOrders(db, orgP, { pageSize: 999 })
  assert.equal(clamped.pageSize, 100)

  // I) Filtreler: status + search + city.
  await service.persistSyncResult(db, orgP, [makeOrder({ packageId: 'PF-1', orderNumber: 'FIND-ME', marketplaceStatus: 'Shipped', city: 'Ankara' })], { complete: false })
  const byStatus = await service.listOrders(db, orgP, { status: 'Shipped' })
  assert.ok(byStatus.orders.every((o) => o.marketplaceStatus === 'Shipped'))
  const bySearch = await service.listOrders(db, orgP, { search: 'FIND-ME' })
  assert.equal(bySearch.orders.length, 1)
  const byCity = await service.listOrders(db, orgP, { city: 'Ankara' })
  assert.equal(byCity.orders.length, 1)

  // J) getOrder çapraz org 404 (null).
  const own = await service.getOrder(db, orgA, rowA.id)
  assert.ok(own, 'kendi siparişini görür')
  const cross = await service.getOrder(db, orgB, rowA.id)
  assert.equal(cross, null, 'çapraz org null döner')

  // K) Kısmi/başarısız sync ARŞİVLEMEZ (complete=false → archiveMissing çağrılmaz).
  const orgR = await makeOrg(db, 'Org R', 'ord-r')
  await service.persistSyncResult(db, orgR, [makeOrder({ packageId: 'R-1' }), makeOrder({ packageId: 'R-2' })], { complete: true })
  const partial = await service.persistSyncResult(db, orgR, [makeOrder({ packageId: 'R-1' })], { complete: false })
  assert.equal(partial.archivedCount, 0, 'partial sync arşivlemez')
  const stillTwo = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, orgR))
  assert.equal(stillTwo.filter((o) => o.archivedAt == null).length, 2, 'partial sync sipariş silmez/arşivlemez')

  // L) Tam sync reconcile: fresh sette olmayan arşivlenir (SİLİNMEZ).
  const full = await service.persistSyncResult(db, orgR, [makeOrder({ packageId: 'R-1' })], { complete: true })
  assert.equal(full.archivedCount, 1, 'tam sync eksik siparişi arşivler')
  const rRows = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, orgR))
  assert.equal(rRows.length, 2, 'arşivlenen kayıt SİLİNMEZ')
  const archived = rRows.find((o) => o.packageId === 'R-2')
  assert.ok(archived.archivedAt, 'R-2 arşivlendi')

  // M) Tekrar görülen sipariş arşivden çıkar (unarchive).
  await service.persistSyncResult(db, orgR, [makeOrder({ packageId: 'R-1' }), makeOrder({ packageId: 'R-2' })], { complete: true })
  const unarchived = (await db.select().from(schema.orders).where(eq(schema.orders.packageId, 'R-2')))[0]
  assert.equal(unarchived.archivedAt, null, 'tekrar görülen sipariş arşivden çıkar')

  // N) Restart kalıcılığı: yeni db örneği aynı veriyi okur.
  const db2 = drizzle(pglite, { schema })
  const afterRestart = await service.listOrders(db2, orgA, {})
  assert.equal(afterRestart.total, 1, 'restart sonrası veri korunur')

  // O) Shipment linkage: local_create → order.shipment eklenir.
  await shipmentService.writeOperationRecord(db, orgA, {
    idempotencyKey: 'SURAT:a:A-1:CREATE',
    marketplace: 'Trendyol', packageId: 'PA-1', orderNumber: 'A-1',
    orderId: 'A-1', provider: 'surat', operation: 'OrtakBarkodOlustur',
    status: 'SUCCESS', createCallCount: 1,
    completedAt: '2026-07-11T00:00:00Z', carrierTrackingNumber: '13177122192332',
    carrierBarcodeNumber: '012500001', shipment: { barcodeRaw: '^XA^XZ', senderNumber: '13177122192332' },
  })
  const linked = (await service.listOrders(db, orgA, {})).orders.find((o) => o.packageId === 'PA-1')
  assert.ok(linked.shipment, 'local_create shipment order view-model\'ine bağlanır')

  // P) marketplace_external → externalShipment (salt okunur), başka org görmez.
  await shipmentService.upsertExternalShipment(db, {
    organizationId: orgB, marketplace: 'Trendyol', packageId: 'PA-1',
    orderNumber: 'B-1', provider: 'surat', status: 'Shipped',
    trackingNumber: '7270034650648561', senderNumber: '13177122192332',
  })
  const extLinked = (await service.listOrders(db, orgB, {})).orders.find((o) => o.packageId === 'PA-1')
  assert.equal(extLinked.externalShipment?.source, 'marketplace_external')
  // Q) Çapraz org shipment ASLA bağlanmaz: Org A'nın external shipment'ı yok.
  const aOrder = (await service.listOrders(db, orgA, {})).orders.find((o) => o.packageId === 'PA-1')
  assert.ok(!aOrder.externalShipment, 'başka org shipment\'ı bağlanmaz')
})

// R-V) Legacy import: dry-run, commit, duplicate skip, format çözümleme, seller.
test('legacy sipariş import R-V: dry-run/commit/duplicate/format', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Import Org', 'ord-import')
  const dir = mkdtempSync(join(tmpdir(), 'cargoflow-orders-import-'))
  const storePath = join(dir, 'orders-export.json')
  const legacyOrder = makeOrder({ packageId: 'LEG-1', orderNumber: 'LEG-1' })
  const original = JSON.stringify({ '123456': [legacyOrder] }, null, 2)
  writeFileSync(storePath, original)

  // R) extractLegacyOrders üç biçimi de çözer.
  assert.equal(extractLegacyOrders([legacyOrder]).length, 1)
  assert.equal(extractLegacyOrders({ orders: [legacyOrder] }).length, 1)
  assert.equal(extractLegacyOrders({ '123456': [legacyOrder] }).length, 1)
  assert.equal(extractLegacyOrders({ '123456': [legacyOrder] }, '999').length, 0, 'seller filtresi eşleşmezse boş')
  assert.equal(extractLegacyOrders({ '123456': [legacyOrder] }, '123456').length, 1)

  // S) dry-run: yazmaz, dosya değişmez.
  const dry = await importLegacyOrders(db, org, { dryRun: true, storePath })
  assert.equal(dry.read, 1)
  assert.equal(dry.dryRun, true)
  assert.equal((await db.select().from(schema.orders)).length, 0, 'dry-run kayıt yazmaz')
  assert.equal(readFileSync(storePath, 'utf8'), original, 'export dosyası değişmez')

  // T) commit: yazar + satır ekler.
  const committed = await importLegacyOrders(db, org, { dryRun: false, storePath })
  assert.equal(committed.inserted, 1)
  assert.equal(committed.linesInserted, 1)
  assert.equal((await db.select().from(schema.orders)).length, 1)

  // U) tekrar commit: duplicate güvenle atlanır (mevcut kayıt ezilmez).
  const again = await importLegacyOrders(db, org, { dryRun: false, storePath })
  assert.equal(again.skipped, 1)
  assert.equal(again.inserted, 0)

  // V) seller filtresi: eşleşmeyen seller → hiç okunmaz.
  const noneForSeller = await importLegacyOrders(db, org, { dryRun: false, storePath, sellerId: '999' })
  assert.equal(noneForSeller.read, 0)
  // Dosya hâlâ değişmedi.
  assert.equal(readFileSync(storePath, 'utf8'), original)
})
