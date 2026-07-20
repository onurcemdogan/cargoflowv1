import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// Shipment/idempotency tenant persistence (faz 4) hermetik testleri A-R.
// Gerçek PostgreSQL motoru (pglite) + gerçek transaction/unique constraint.
// SOAP/provider/mapping akışına dokunmaz; yalnız persistence katmanını sınar.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const service = await import('./shipments/shipmentPersistenceService.ts')
const opRepo = await import('./shipments/shipmentOperationRepository.ts')
const shipRepo = await import('./shipments/shipmentRepository.ts')
const { importLegacyShipments } = await import('./shipments/importLegacyShipments.ts')

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
function createRecord(over = {}) {
  return {
    idempotencyKey: 'SURAT:org:ORD-1:CREATE',
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: 'ORD-1',
    orderId: 'ORD-1',
    provider: 'surat',
    operation: 'OrtakBarkodOlustur',
    status: 'SUCCESS',
    createCallCount: 1,
    completedAt: new Date('2026-07-20T10:00:00Z').toISOString(),
    carrierTrackingNumber: '13177122192332',
    carrierBarcodeNumber: '012500001',
    shipment: { barcodeRaw: '^XA^XZ', senderNumber: '13177122192332' },
    ...over,
  }
}

test('shipment persistence A-R: izolasyon, idempotency, transaction, external', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A', 'ship-a')
  const orgB = await makeOrg(db, 'Org B', 'ship-b')

  // A) Org A shipment oluşturur, Org B göremez.
  await service.writeOperationRecord(db, orgA, createRecord())
  const readA = await service.readOperationRecord(db, orgA, 'SURAT:org:ORD-1:CREATE')
  assert.equal(readA.status, 'SUCCESS')
  assert.equal(readA.carrierTrackingNumber, '13177122192332')
  const readB = await service.readOperationRecord(db, orgB, 'SURAT:org:ORD-1:CREATE')
  assert.equal(readB, undefined, 'Org B, Org A kaydını göremez')
  // Q) çapraz org shipment lookup boş.
  assert.equal(await shipRepo.findShipment(db, orgB, 'Trendyol', 'PKG-1', 'surat'), null)
  const shipA = await shipRepo.findShipment(db, orgA, 'Trendyol', 'PKG-1', 'surat')
  assert.equal(shipA.source, 'local_create')
  assert.equal(shipA.trackingNumber, '13177122192332')

  // B) Aynı packageId farklı orglarda bağımsız create.
  await service.writeOperationRecord(db, orgB, createRecord({ carrierTrackingNumber: '99998888' }))
  assert.equal((await service.readOperationRecord(db, orgB, 'SURAT:org:ORD-1:CREATE')).carrierTrackingNumber, '99998888')
  assert.equal((await service.readOperationRecord(db, orgA, 'SURAT:org:ORD-1:CREATE')).carrierTrackingNumber, '13177122192332')

  // E) DB'de düz metin tracking değil? tracking AÇIK kolonda (sorgu için) —
  // ama payload (teknik ZPL/sender) ŞİFRELİ. barcodeRaw düz metin OLMAMALI.
  const rawRows = await db.select().from(schema.shipmentOperations)
  const dump = JSON.stringify(rawRows)
  assert.ok(!dump.includes('^XA^XZ'), 'teknik ZPL şifreli, düz metin değil')
  for (const row of rawRows) {
    assert.ok(String(row.responsePayloadEncrypted).startsWith('{"v":1'))
  }

  // C) Eşzamanlı iki reserve → yalnız biri kazanır.
  const orgC = await makeOrg(db, 'Org C', 'ship-c')
  const cols = {
    organizationId: orgC, marketplace: 'Trendyol', packageId: 'PKG-C',
    provider: 'surat', operationType: 'CREATE', idempotencyKey: 'SURAT:c:CREATE',
    status: 'pending', createCallCount: 1,
  }
  const [r1, r2] = await Promise.all([
    opRepo.reserveCreateOperation(db, cols),
    opRepo.reserveCreateOperation(db, cols),
  ])
  assert.equal([r1.won, r2.won].filter(Boolean).length, 1, 'yalnız bir reserve kazanır')
  assert.equal([r1.won, r2.won].filter((w) => !w).length, 1, 'diğeri kaybeder')

  // G) idempotency key organization scoped: aynı key farklı org'da çakışmaz.
  await opRepo.reserveCreateOperation(db, { ...cols, organizationId: orgA, packageId: 'PKG-C' })
  const cCount = (await db.select().from(schema.shipmentOperations)
    .where(eq(schema.shipmentOperations.idempotencyKey, 'SURAT:c:CREATE'))).length
  assert.equal(cCount, 2, 'aynı key iki org için ayrı kayıt')

  // D/E-flow) Başarılı operation sonrası read status SUCCESS (tekrar create'te
  // carrier çağrılmaz — index.mjs bunu SUCCESS görünce yapar; burada kalıcılık).
  // L) Restart simülasyonu: yeni db örneği aynı pglite üzerinden okur.
  const db2 = drizzle(pglite, { schema })
  const afterRestart = await service.readOperationRecord(db2, orgA, 'SURAT:org:ORD-1:CREATE')
  assert.equal(afterRestart.status, 'SUCCESS', 'restart sonrası idempotency korunur')

  // M) Transaction yarıda başarısız olursa sahte shipment oluşmaz.
  const orgM = await makeOrg(db, 'Org M', 'ship-m')
  const failingDb = {
    ...db,
    transaction: async (fn) => {
      await fn({
        insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { throw new Error('yarıda hata') } }) }),
      })
    },
  }
  await assert.rejects(
    service.writeOperationRecord(failingDb, orgM, createRecord({ packageId: 'PKG-M', idempotencyKey: 'SURAT:m:CREATE' })),
    /yarıda hata/,
  )
  assert.equal(await shipRepo.findShipment(db, orgM, 'Trendyol', 'PKG-M', 'surat'), null, 'transaction rollback: sahte shipment yok')
  assert.equal(await service.readOperationRecord(db, orgM, 'SURAT:m:CREATE'), undefined)

  // I) Harici shipment operation ÜRETMEZ; salt okunur upsert.
  const orgX = await makeOrg(db, 'Org X', 'ship-x')
  await service.upsertExternalShipment(db, {
    organizationId: orgX, marketplace: 'Trendyol', packageId: 'PKG-EXT',
    orderNumber: 'ORD-EXT', provider: 'surat', status: 'Shipped',
    trackingNumber: '7270034650648561', senderNumber: '13177122192332',
  })
  const ext = await shipRepo.findShipment(db, orgX, 'Trendyol', 'PKG-EXT', 'surat')
  assert.equal(ext.source, 'marketplace_external')
  assert.equal(ext.senderNumber, '13177122192332')
  const extOps = await db.select().from(schema.shipmentOperations)
    .where(eq(schema.shipmentOperations.organizationId, orgX))
  assert.equal(extOps.length, 0, 'harici shipment operation kaydı üretmez')

  // N) createCallCount/carrierCreateCalled semantiği korunur.
  const opRow = (await db.select().from(schema.shipmentOperations)
    .where(and(eq(schema.shipmentOperations.organizationId, orgA), eq(schema.shipmentOperations.idempotencyKey, 'SURAT:org:ORD-1:CREATE'))))[0]
  assert.equal(opRow.createCallCount, 1)
  assert.equal(opRow.carrierCreateCalled, true)
})

// P) legacy import dry-run dosyayı değiştirmez; kayıt yazmaz.
test('legacy import dry-run + commit (P)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Import Org', 'import-org')
  const dir = mkdtempSync(join(tmpdir(), 'cargoflow-import-'))
  const storePath = join(dir, 'surat-create-operations.json')
  const legacy = {
    version: 1,
    operations: {
      'SURAT:t:ORD-9:CREATE': {
        idempotencyKey: 'SURAT:t:ORD-9:CREATE',
        packageId: 'PKG-9', orderNumber: 'ORD-9', status: 'SUCCESS',
        createCallCount: 1, completedAt: '2026-07-01T00:00:00Z',
        carrierTrackingNumber: '55554444', shipment: { barcodeRaw: '^XA9^XZ' },
      },
    },
  }
  const original = JSON.stringify(legacy, null, 2)
  writeFileSync(storePath, original)

  // dry-run: yazmaz, dosya değişmez.
  const dry = await importLegacyShipments(db, org, { dryRun: true, storePath })
  assert.equal(dry.read, 1)
  assert.equal(dry.dryRun, true)
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 0, 'dry-run kayıt yazmaz')
  assert.equal(readFileSync(storePath, 'utf8'), original, 'dosya değişmez')

  // commit: yazar, source imported_legacy.
  const committed = await importLegacyShipments(db, org, { dryRun: false, storePath })
  assert.equal(committed.inserted, 1)
  const rows = await db.select().from(schema.shipmentOperations)
  assert.equal(rows.length, 1)
  const ship = await shipRepo.findShipment(db, org, 'Trendyol', 'PKG-9', 'surat')
  assert.equal(ship.source, 'imported_legacy')
  // Tekrar commit: duplicate güvenle atlanır.
  const again = await importLegacyShipments(db, org, { dryRun: false, storePath })
  assert.equal(again.skipped, 1)
  assert.equal(again.inserted, 0)
  // Dosya hâlâ değişmedi.
  assert.equal(readFileSync(storePath, 'utf8'), original)
})
