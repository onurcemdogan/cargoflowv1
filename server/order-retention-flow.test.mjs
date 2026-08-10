import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, sql } from 'drizzle-orm'

// OPERASYON KAYDI YAŞAM DÖNGÜSÜ — hermetik (gerçek PostgreSQL motoru).
// ACTIVE → ARCHIVED → PURGED. Gerçek migration'lar, gerçek FK/cascade.
// ZPL/print/QR akışına DOKUNMAZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const retention = await import('./orders/orderRetention.ts')
const repo = await import('./orders/orderRepository.ts')
const mapper = await import('./orders/orderMapper.ts')

const { orders, orderLines, shipments, shipmentOperations, organizations } =
  schema

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
  return { db, organizationId: org.id }
}

const NOW = new Date('2026-08-11T09:00:00.000Z')
const daysAgo = (days, hours = 0) =>
  new Date(NOW.getTime() - (days * 24 + hours) * 60 * 60 * 1000)

let sequence = 0
async function insertOrder(db, organizationId, overrides = {}) {
  sequence += 1
  const [row] = await db
    .insert(orders)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      packageId: `PKG-${sequence}`,
      orderNumber: `ORD-${sequence}`,
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      orderDate: daysAgo(30),
      ...overrides,
    })
    .returning({ id: orders.id, packageId: orders.packageId })
  return row
}

const policy = () => retention.resolveRetentionPolicy({})

// ═══ ACTIVITY TIMESTAMP ═══════════════════════════════════════════════════

test('ACTIVITY-1: markOrderLabelReady lastOperationalActivityAt yazar', async () => {
  const { db, organizationId } = await makeDb()
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'NEW',
  })
  const before = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(before[0].value, null, 'başlangıçta NULL')

  const result = await repo.markOrderLabelReady(db, organizationId, order.id)
  assert.equal(result.updated, true)
  const after = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.ok(after[0].value, 'etiket hazır geçişi aktivite damgası yazmalı')
})

test('ACTIVITY-2: markOrderLabelPrinted damgayı GÜNCELLER', async () => {
  const { db, organizationId } = await makeDb()
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
    lastOperationalActivityAt: daysAgo(10),
  })
  const result = await repo.markOrderLabelPrinted(db, organizationId, order.id)
  assert.equal(result.updated, true)
  const after = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.ok(
    after[0].value.getTime() > daysAgo(1).getTime(),
    'baskı geçişi damgayı tazelemeli',
  )
})

test('ACTIVITY-3: rutin marketplace sync damgaya DOKUNMAZ', async () => {
  // marketplaceUpdateSet: rutin re-sync'te yazılan alan kümesi.
  const updateSet = mapper.marketplaceUpdateSet({
    orderNumber: 'ORD-1',
    packageId: 'PKG-1',
    marketplaceStatus: 'Picking',
    orderDate: NOW.toISOString(),
  })
  assert.ok(
    !('lastOperationalActivityAt' in updateSet),
    'rutin sync retention saatini YAZMAMALI',
  )
})

test('ACTIVITY-4: rutin marketplace sync archivedAt’i NULL YAPMAZ', async () => {
  const updateSet = mapper.marketplaceUpdateSet({
    orderNumber: 'ORD-1',
    packageId: 'PKG-1',
    marketplaceStatus: 'Shipped',
    orderDate: NOW.toISOString(),
  })
  assert.ok(
    !('archivedAt' in updateSet),
    'rutin sync arşivi geri AÇMAMALI (BLOCKER 2)',
  )
})

// ═══ MEVCUT BACKLOG ═══════════════════════════════════════════════════════

test('BACKLOG-2/3: aktivite damgası NULL olan eski kayıt OTOMATİK arşivlenmez', async () => {
  const { db, organizationId } = await makeDb()
  // 400 gün eski sipariş, damga YOK → kör "eski olmalı" çıkarımı YAPILMAZ.
  await insertOrder(db, organizationId, {
    orderDate: daysAgo(400),
    lastOperationalActivityAt: null,
  })
  const counts = await retention.inspectRetention(db, policy(), NOW)
  assert.equal(counts.archiveEligible, 0, 'NULL damga arşiv adayı DEĞİL')
  assert.equal(counts.nullActivityBacklog, 1, 'ama operatöre raporlanmalı')

  const result = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(result.archived, 0)
})

// ═══ ARCHIVE ══════════════════════════════════════════════════════════════

test('ARCHIVE-1: labelReady 3g23s → AKTİF kalır', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
    lastOperationalActivityAt: daysAgo(3, 23),
  })
  const result = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(result.archived, 0)
})

test('ARCHIVE-2: labelReady >=4g → arşivlenir', async () => {
  const { db, organizationId } = await makeDb()
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
    lastOperationalActivityAt: daysAgo(4),
  })
  const result = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(result.archived, 1)
  const rows = await db
    .select({ archivedAt: orders.archivedAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.ok(rows[0].archivedAt)
})

test('ARCHIVE-3: labelPrinted >=4g (5 gün) → arşivlenir', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: daysAgo(5),
  })
  const result = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(result.archived, 1)
})

test('ARCHIVE-4: barcodeWaiting >=4g → otomatik arşiv YOK', async () => {
  const { db, organizationId } = await makeDb()
  for (const operationStatus of ['NEW', 'BARCODE_WAITING']) {
    await insertOrder(db, organizationId, {
      operationStatus,
      lastOperationalActivityAt: daysAgo(30),
    })
  }
  const result = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(result.archived, 0, 'çözülmemiş kayıt sessizce gömülmez')
})

test('ARCHIVE-5: Trendyol Shipped → 4 günlük kural UYGULANMAZ', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Shipped',
    lastOperationalActivityAt: daysAgo(15),
  })
  const result = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(result.archived, 0, 'pazaryeri sınıflandırması üstündür')

  // Delivered / Cancelled / Returned de aynı korumaya sahiptir.
  for (const marketplaceStatus of ['Delivered', 'Cancelled', 'Returned']) {
    await insertOrder(db, organizationId, {
      operationStatus: 'LABEL_PRINTED',
      marketplaceStatus,
      lastOperationalActivityAt: daysAgo(15),
    })
  }
  const second = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(second.archived, 0)
})

test('ARCHIVE-6: tekrar çalıştırma IDEMPOTENT', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: daysAgo(9),
  })
  const first = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(first.archived, 1)
  const second = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(second.archived, 0, 'ikinci tur yan etki üretmemeli')
})

test('ARCHIVE-STARVATION: 1000 uygun / batch 200 → hepsi işlenir', async () => {
  const { db, organizationId } = await makeDb()
  const values = Array.from({ length: 1000 }, (_, index) => ({
    organizationId,
    marketplace: 'Trendyol',
    packageId: `BULK-${index}`,
    orderNumber: `BULK-ORD-${index}`,
    marketplaceStatus: 'Picking',
    operationStatus: 'LABEL_PRINTED',
    orderDate: daysAgo(30),
    lastOperationalActivityAt: daysAgo(10),
  }))
  await db.insert(orders).values(values)

  let total = 0
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const result = await retention.archiveEligibleOrders(db, policy(), NOW)
    total += result.archived
    if (result.archived === 0) break
  }
  assert.equal(total, 1000, 'ilk 200e takılıp kalmamalı')
  const remaining = await db
    .select({ value: sql`count(*)::int` })
    .from(orders)
    .where(sql`${orders.archivedAt} is null`)
  assert.equal(Number(remaining[0].value), 0)
})

// ═══ PURGE ════════════════════════════════════════════════════════════════

async function seedPurgeCandidate(db, organizationId, archivedDaysAgo) {
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: daysAgo(archivedDaysAgo + 4),
    archivedAt: daysAgo(archivedDaysAgo),
  })
  await db.insert(orderLines).values({
    organizationId,
    orderId: order.id,
    externalLineId: `line-${order.packageId}`,
    productName: 'Urun',
    quantity: 1,
  })
  await db.insert(shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: order.packageId,
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'CREATED',
    carrierPayloadEncrypted: 'ENCRYPTED-ARTIFACT',
  })
  await db.insert(shipmentOperations).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: order.packageId,
    provider: 'surat-kargo',
    operationType: 'create',
    idempotencyKey: `idem-${order.packageId}`,
    status: 'succeeded',
    responsePayloadEncrypted: 'ENCRYPTED-RESPONSE',
  })
  return order
}

test('PURGE-1: arşiv 89 gün → KALIR', async () => {
  const { db, organizationId } = await makeDb()
  await seedPurgeCandidate(db, organizationId, 89)
  const candidates = await retention.findPurgeCandidates(db, policy(), NOW)
  assert.equal(candidates.length, 0)
})

test('PURGE-2: arşiv >=90 gün → purge edilir', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedPurgeCandidate(db, organizationId, 90)
  const candidates = await retention.findPurgeCandidates(db, policy(), NOW)
  assert.equal(candidates.length, 1)
  const result = await retention.purgeOrderRecord(db, candidates[0], NOW)
  assert.equal(result.purged, true)
  const remaining = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(remaining.length, 0)
})

test('PURGE-3: arşivlenmemiş 180 günlük kayıt ASLA purge edilmez', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    orderDate: daysAgo(180),
    lastOperationalActivityAt: daysAgo(180),
    archivedAt: null,
  })
  const candidates = await retention.findPurgeCandidates(db, policy(), NOW)
  assert.equal(candidates.length, 0, 'archivedAt NULL → purge imkânsız')
})

test('PURGE-4/5/6/7: order_lines · shipments · shipment_operations · artifact ORPHAN = 0', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedPurgeCandidate(db, organizationId, 120)
  // Silinmemesi gereken KOMŞU kayıt (başka paket).
  const neighbour = await seedPurgeCandidate(db, organizationId, 1)

  const [candidate] = await retention.findPurgeCandidates(db, policy(), NOW)
  await retention.purgeOrderRecord(db, candidate, NOW)

  const lines = await db
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
  assert.equal(lines.length, 0, 'order_lines orphan = 0')

  const ship = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.packageId, order.packageId),
      ),
    )
  assert.equal(ship.length, 0, 'shipments orphan = 0 (artifact dahil)')

  const ops = await db
    .select({ id: shipmentOperations.id })
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, organizationId),
        eq(shipmentOperations.packageId, order.packageId),
      ),
    )
  assert.equal(ops.length, 0, 'shipment_operations orphan = 0')

  // KOMŞU kayıt DOKUNULMADAN durmalı.
  const neighbourShip = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.packageId, neighbour.packageId),
      ),
    )
  assert.equal(neighbourShip.length, 1, 'ilgisiz paket silinmemeli')
})

test('PURGE-8: aktif hale dönmüş kayıt purge EDİLMEZ (son güvenlik kontrolü)', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedPurgeCandidate(db, organizationId, 120)
  const [candidate] = await retention.findPurgeCandidates(db, policy(), NOW)
  // Aday bulunduktan SONRA sipariş arşivden çıkarılırsa purge iptal olmalı.
  await db
    .update(orders)
    .set({ archivedAt: null })
    .where(eq(orders.id, order.id))

  const result = await retention.purgeOrderRecord(db, candidate, NOW)
  assert.equal(result.purged, false)
  const remaining = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(remaining.length, 1, 'sipariş KORUNMALI')
  // Çocuk kayıtlar da silinmemeli (transaction bütünlüğü).
  const ship = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, organizationId),
        eq(shipments.packageId, order.packageId),
      ),
    )
  assert.equal(ship.length, 1, 'kısmi silme OLMAMALI')
})

test('PURGE-9: 1000 uygun / batch 200 → sınırlı turlarla hepsi işlenir', async () => {
  const { db, organizationId } = await makeDb()
  const values = Array.from({ length: 1000 }, (_, index) => ({
    organizationId,
    marketplace: 'Trendyol',
    packageId: `PURGE-${index}`,
    orderNumber: `PURGE-ORD-${index}`,
    marketplaceStatus: 'Picking',
    operationStatus: 'LABEL_PRINTED',
    orderDate: daysAgo(200),
    lastOperationalActivityAt: daysAgo(200),
    archivedAt: daysAgo(120),
  }))
  await db.insert(orders).values(values)

  let purged = 0
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const candidates = await retention.findPurgeCandidates(db, policy(), NOW)
    if (candidates.length === 0) break
    assert.ok(candidates.length <= 200, 'batch sınırı aşılmamalı')
    for (const candidate of candidates) {
      const result = await retention.purgeOrderRecord(db, candidate, NOW)
      if (result.purged) purged += 1
    }
  }
  assert.equal(purged, 1000)
  const remaining = await db.select({ id: orders.id }).from(orders)
  assert.equal(remaining.length, 0)
})

test('PURGE-RESTART: durum DB gerçeğinden yeniden keşfedilir', async () => {
  const { db, organizationId } = await makeDb()
  await seedPurgeCandidate(db, organizationId, 120)
  // "Restart": bellekte hiçbir kuyruk yok, aynı sorgu adayı yeniden bulur.
  const first = await retention.findPurgeCandidates(db, policy(), NOW)
  const second = await retention.findPurgeCandidates(db, policy(), NOW)
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(first[0].id, second[0].id)
})

// ═══ DRY-RUN / CYCLE ══════════════════════════════════════════════════════

test('DRYRUN: inspectRetention YAZMAZ ve PII döndürmez', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: daysAgo(10),
  })
  await seedPurgeCandidate(db, organizationId, 120)

  const before = await db.select({ id: orders.id }).from(orders)
  const counts = await retention.inspectRetention(db, policy(), NOW)
  const after = await db.select({ id: orders.id }).from(orders)
  assert.equal(after.length, before.length, 'salt okunur olmalı')

  assert.equal(counts.archiveEligible, 1)
  assert.equal(counts.purgeEligible, 1)
  assert.ok(counts.oldestArchiveCandidateAgeDays >= 10)
  assert.ok(counts.oldestPurgeCandidateAgeDays >= 120)
  // PII alanı YOK.
  for (const key of Object.keys(counts)) {
    assert.ok(
      !['customerName', 'customerPhone', 'address', 'orderNumber'].includes(key),
      `PII alanı sızmamalı: ${key}`,
    )
  }
})

test('CYCLE: housekeeping turu aggregate rapor üretir', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: daysAgo(10),
  })
  await seedPurgeCandidate(db, organizationId, 120)

  let tick = 0
  const report = await retention.runRetentionCycle(db, policy(), NOW, () => {
    tick += 5
    return tick
  })
  assert.equal(report.archived, 1)
  assert.equal(report.purged, 1)
  assert.equal(report.failed, 0)
  assert.ok(report.durationMs >= 0)
  for (const key of [
    'scanned',
    'archiveEligible',
    'archived',
    'purgeEligible',
    'purged',
    'failed',
    'durationMs',
  ]) {
    assert.ok(key in report, `rapor alanı eksik: ${key}`)
  }
})

test('POLICY: varsayılanlar 4 gün / 90 gün / 200 / 6 saat', async () => {
  const defaults = retention.resolveRetentionPolicy({})
  assert.equal(defaults.archiveAfterDays, 4)
  assert.equal(defaults.purgeAfterDays, 90)
  assert.equal(defaults.archiveBatchSize, 200)
  assert.equal(defaults.purgeBatchSize, 200)
  assert.equal(defaults.intervalMs, 6 * 60 * 60 * 1000)

  const custom = retention.resolveRetentionPolicy({
    ORDER_AUTO_ARCHIVE_DAYS: '7',
    ORDER_ARCHIVE_RETENTION_DAYS: '120',
    ORDER_ARCHIVE_BATCH_SIZE: '50',
    ORDER_PURGE_BATCH_SIZE: '25',
    ORDER_HOUSEKEEPING_INTERVAL_MS: '3600000',
  })
  assert.equal(custom.archiveAfterDays, 7)
  assert.equal(custom.purgeAfterDays, 120)
  assert.equal(custom.archiveBatchSize, 50)
  assert.equal(custom.purgeBatchSize, 25)
  assert.equal(custom.intervalMs, 3_600_000)
})
