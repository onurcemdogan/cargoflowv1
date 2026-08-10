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
// runRetentionCycle ACTIVATION GUARD'a tabidir: otomatik yazma varsayilan
// olarak KAPALIDIR (HOUSEKEEPING-GATE-2). Cycle DAVRANISINI sinayan testler
// bayragi ACIKCA acar; guvenli varsayilan ayri testte kilitlenir.
const enabledPolicy = () =>
  retention.resolveRetentionPolicy({ ORDER_HOUSEKEEPING_ENABLED: 'true' })

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
  const report = await retention.runRetentionCycle(db, enabledPolicy(), NOW, () => {
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

// ═══ GÜVENLİ BASELINE ═════════════════════════════════════════════════════

test('BASELINE-1: tarihsel labelPrinted + NULL saat → baseline adayı', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    orderDate: daysAgo(30),
    lastOperationalActivityAt: null,
  })
  const counts = await retention.inspectRetention(db, policy(), NOW)
  assert.equal(counts.baselineEligible, 1)
  const result = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(result.baselined, 1)
  const rows = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
  assert.equal(rows[0].value.getTime(), NOW.getTime(), 'baseline = simdi')
})

test('BASELINE-2: tarihsel labelReady + NULL saat → baseline adayı', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
    lastOperationalActivityAt: null,
  })
  const result = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(result.baselined, 1)
})

test('BASELINE-3: Shipped/handedToCargo + NULL → baseline adayı DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  for (const marketplaceStatus of ['Shipped', 'AtCollectionPoint', 'Delivered']) {
    await insertOrder(db, organizationId, {
      operationStatus: 'LABEL_PRINTED',
      marketplaceStatus,
      lastOperationalActivityAt: null,
    })
  }
  const counts = await retention.inspectRetention(db, policy(), NOW)
  assert.equal(counts.baselineEligible, 0, 'pazaryeri ileri durumu baseline almaz')
  const result = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(result.baselined, 0)
})

test('BASELINE-4: barcodeWaiting/new + NULL → baseline adayı DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  for (const operationStatus of ['NEW', 'BARCODE_WAITING']) {
    await insertOrder(db, organizationId, {
      operationStatus,
      lastOperationalActivityAt: null,
    })
  }
  const result = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(result.baselined, 0, 'cozulmemis kayit baseline almaz')
})

test('BASELINE-4b: zaten arsivli kayit baseline ALMAZ', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: null,
    archivedAt: daysAgo(5),
  })
  const result = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(result.baselined, 0)
})

test('BASELINE-5: T0 baseline → T0+3g23s AKTIF kalir', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    orderDate: daysAgo(400),
    lastOperationalActivityAt: null,
  })
  const t0 = new Date(NOW.getTime())
  await retention.applyActivityBaseline(db, policy(), t0)
  const almost = new Date(t0.getTime() + (3 * 24 + 23) * 60 * 60 * 1000)
  const result = await retention.archiveEligibleOrders(db, policy(), almost)
  assert.equal(result.archived, 0, 'saat baselineden sayilir, orderDateten DEGIL')
})

test('BASELINE-6: T0 baseline → T0+4g arsiv adayi', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    orderDate: daysAgo(400),
    lastOperationalActivityAt: null,
  })
  const t0 = new Date(NOW.getTime())
  await retention.applyActivityBaseline(db, policy(), t0)
  const later = new Date(t0.getTime() + 4 * 24 * 60 * 60 * 1000)
  const result = await retention.archiveEligibleOrders(db, policy(), later)
  assert.equal(result.archived, 1)
})

test('BASELINE-CYCLE: baseline alan kayit AYNI turda arsivlenmez', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    orderDate: daysAgo(400),
    lastOperationalActivityAt: null,
  })
  const report = await retention.runRetentionCycle(db, enabledPolicy(), NOW)
  assert.equal(report.baselined, 1)
  assert.equal(report.archived, 0, 'eski orderDate arsiv gerekcesi DEGIL')
  const rows = await db.select({ archivedAt: orders.archivedAt }).from(orders)
  assert.equal(rows[0].archivedAt, null)
})

test('BASELINE-7: 1000 uygun / batch 200 → hepsi baseline, starvation 0', async () => {
  const { db, organizationId } = await makeDb()
  await db.insert(orders).values(
    Array.from({ length: 1000 }, (_, index) => ({
      organizationId,
      marketplace: 'Trendyol',
      packageId: `BASE-${index}`,
      orderNumber: `BASE-ORD-${index}`,
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      orderDate: daysAgo(60),
      lastOperationalActivityAt: null,
    })),
  )
  let total = 0
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const result = await retention.applyActivityBaseline(db, policy(), NOW)
    total += result.baselined
    if (result.baselined === 0) break
  }
  assert.equal(total, 1000)
})

test('BASELINE-8: turlar arasi restart → DB gercedinden devam, idempotent', async () => {
  const { db, organizationId } = await makeDb()
  await db.insert(orders).values(
    Array.from({ length: 300 }, (_, index) => ({
      organizationId,
      marketplace: 'Trendyol',
      packageId: `RS-${index}`,
      orderNumber: `RS-ORD-${index}`,
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      orderDate: daysAgo(60),
      lastOperationalActivityAt: null,
    })),
  )
  const first = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(first.baselined, 200)
  // "Restart": cursor UNUTULUR, bellek bayragi YOK.
  const second = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(second.baselined, 100, 'kalanlar DB gercedinden bulunur')
  const third = await retention.applyActivityBaseline(db, policy(), NOW)
  assert.equal(third.baselined, 0, 'idempotent')
})

test('BASELINE-POLICY: ORDER_ACTIVITY_BASELINE_BATCH_SIZE yapilandirilabilir', async () => {
  assert.equal(retention.resolveRetentionPolicy({}).baselineBatchSize, 200)
  assert.equal(
    retention.resolveRetentionPolicy({
      ORDER_ACTIVITY_BASELINE_BATCH_SIZE: '25',
    }).baselineBatchSize,
    25,
  )
})

// ═══ AKTIVITE SAATI RESET KONTROLU ════════════════════════════════════════

test('CLOCK-1: ilk gercek LABEL_READY gecisi saati yazar', async () => {
  const { db, organizationId } = await makeDb()
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'BARCODE_WAITING',
  })
  const result = await repo.markOrderLabelReady(db, organizationId, order.id)
  assert.equal(result.updated, true)
  const rows = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.ok(rows[0].value)
})

test('CLOCK-2: LABEL_READY → LABEL_READY reconciliation saati DEGISTIRMEZ', async () => {
  const { db, organizationId } = await makeDb()
  const stale = daysAgo(10)
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
    lastOperationalActivityAt: stale,
  })
  const result = await repo.markOrderLabelReady(db, organizationId, order.id)
  assert.equal(result.updated, false, 'no-regress: yazma OLMAMALI')
  const rows = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(
    rows[0].value.getTime(),
    stale.getTime(),
    '4 gunluk saat reconciliation ile RESETLENMEZ',
  )
})

test('CLOCK-3: rutin marketplace sync saati DEGISTIRMEZ', async () => {
  const updateSet = mapper.marketplaceUpdateSet({
    orderNumber: 'ORD-1',
    packageId: 'PKG-1',
    marketplaceStatus: 'Picking',
    orderDate: NOW.toISOString(),
  })
  assert.ok(!('lastOperationalActivityAt' in updateSet))
})

test('CLOCK-4: LABEL_READY → LABEL_PRINTED basarili baski saati TAZELER', async () => {
  const { db, organizationId } = await makeDb()
  const stale = daysAgo(10)
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
    lastOperationalActivityAt: stale,
  })
  const result = await repo.markOrderLabelPrinted(db, organizationId, order.id)
  assert.equal(result.updated, true)
  const rows = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.ok(rows[0].value.getTime() > stale.getTime())
})

test('CLOCK-5: zaten LABEL_PRINTED iken tekrar baski saati TAZELEMEZ', async () => {
  // MEVCUT URUN SOZLESMESI: markOrderLabelPrinted YALNIZ LABEL_READY'den yazar.
  // Tekrar yazdirma kanonik bir durum GECISI degildir → saat tazelenmez.
  // Bu ayni zamanda arsivin suresiz ertelenmesini onler.
  const { db, organizationId } = await makeDb()
  const stale = daysAgo(10)
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: stale,
  })
  const result = await repo.markOrderLabelPrinted(db, organizationId, order.id)
  assert.equal(result.updated, false)
  const rows = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(rows[0].value.getTime(), stale.getTime())
})

test('CLOCK-6: arka plan hazirlik/reconciliation saati RESETLEMEZ', async () => {
  // Kanit: arka plan hazirlayici orders tablosuna HIC yazmaz.
  const preparer = readFileSync(
    join(here, 'shipments', 'labelBundlePreparer.ts'),
    'utf8',
  )
  assert.ok(
    !preparer.includes('markOrderLabelReady'),
    'arka plan hazirlik LABEL_READY gecisi tetiklemez',
  )
  assert.ok(!preparer.includes('lastOperationalActivityAt'))
})

// ═══ BASARILI MANUEL TEKRAR BASKI = GERCEK OPERASYONEL AKTIVITE ═══════════
//
// Kaynak: POST /api/orders/:id/label-printed → markLabelPrinted servisi.
// Bu uc YALNIZ baski belgesine GERCEKTEN giren siparisler icin cagrilir;
// atlanan/basarisiz siparis icin istemci istegi HIC gondermez.

const service = await import('./orders/orderPersistenceService.ts')

test('CLOCK-REPRINT-1: basarili manuel tekrar baski saati YENILER', async () => {
  const { db, organizationId } = await makeDb()
  const t0 = daysAgo(4)
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: t0,
  })
  // T0 + 3g23s: kullanici etiketi GERCEKTEN yeniden basti.
  const reprintAt = new Date(t0.getTime() + (3 * 24 + 23) * 60 * 60 * 1000)
  await repo.touchOrderOperationalActivity(db, organizationId, order.id, reprintAt)

  const rows = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(rows[0].value.getTime(), reprintAt.getTime())

  // Orijinal T0+4g aninda ARSIVLENMEZ (son aktivite 1 saat once).
  const originalDeadline = new Date(t0.getTime() + 4 * 24 * 60 * 60 * 1000)
  const early = await retention.archiveEligibleOrders(db, policy(), originalDeadline)
  assert.equal(early.archived, 0, 'yeni aktiviteden sonra arsiv OLMAMALI')

  // Yeni aktiviteden 4 gun sonra arsivlenir.
  const later = new Date(reprintAt.getTime() + 4 * 24 * 60 * 60 * 1000)
  const result = await retention.archiveEligibleOrders(db, policy(), later)
  assert.equal(result.archived, 1)
})

test('CLOCK-REPRINT-2: basarisiz/atlanan baski saati YENILEMEZ', async () => {
  const { db, organizationId } = await makeDb()
  const stale = daysAgo(10)
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: stale,
  })
  // Atlanan/basarisiz siparis icin label-printed ucu HIC cagrilmaz →
  // hicbir dokunma olmaz. Saat DEGISMEZ.
  const rows = await db
    .select({ value: orders.lastOperationalActivityAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(rows[0].value.getTime(), stale.getTime())
  const result = await retention.archiveEligibleOrders(db, policy(), NOW)
  assert.equal(result.archived, 1, 'basarisiz deneme saati uzatmaz')
})

test('CLOCK-REPRINT-3: arka plan hazirlik/reconciliation saati YENILEMEZ', async () => {
  const preparer = readFileSync(
    join(here, 'shipments', 'labelBundlePreparer.ts'),
    'utf8',
  )
  assert.ok(!preparer.includes('touchOrderOperationalActivity'))
  assert.ok(!preparer.includes('markOrderLabelPrinted'))
  assert.ok(!preparer.includes('lastOperationalActivityAt'))
})

test('CLOCK-REPRINT-4: toplu 97 basarili / 3 atlanan → TAM 97 damga yenilenir', async () => {
  const { db, organizationId } = await makeDb()
  const stale = daysAgo(10)
  const created = []
  for (let index = 0; index < 100; index += 1) {
    created.push(
      await insertOrder(db, organizationId, {
        operationStatus: 'LABEL_PRINTED',
        marketplaceStatus: 'Picking',
        lastOperationalActivityAt: stale,
      }),
    )
  }
  // Muhasebe mevcut basarili-baski kumesiyle AYNI: yalniz belgeye giren
  // siparisler icin uc cagrilir.
  const successful = created.slice(0, 97)
  const skipped = created.slice(97)
  const printedAt = new Date(NOW.getTime())
  for (const order of successful) {
    await repo.touchOrderOperationalActivity(
      db,
      organizationId,
      order.id,
      printedAt,
    )
  }

  const rows = await db
    .select({ id: orders.id, value: orders.lastOperationalActivityAt })
    .from(orders)
  const refreshed = rows.filter(
    (row) => row.value.getTime() === printedAt.getTime(),
  )
  assert.equal(refreshed.length, 97)
  const untouched = rows.filter(
    (row) => row.value.getTime() === stale.getTime(),
  )
  assert.equal(untouched.length, 3)
  const skippedIds = new Set(skipped.map((order) => order.id))
  for (const row of untouched) {
    assert.ok(skippedIds.has(row.id), 'yalniz atlananlar degismemis olmali')
  }
})

test('CLOCK-REPRINT-5: dokunus operationStatus / marketplaceStatus DEGISTIRMEZ', async () => {
  const { db, organizationId } = await makeDb()
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: daysAgo(10),
  })
  await repo.touchOrderOperationalActivity(db, organizationId, order.id, NOW)
  const rows = await db
    .select({
      operationStatus: orders.operationStatus,
      marketplaceStatus: orders.marketplaceStatus,
    })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(rows[0].operationStatus, 'LABEL_PRINTED', 'statu DEGISMEZ')
  assert.equal(rows[0].marketplaceStatus, 'Picking')
})

test('CLOCK-REPRINT-6: dokunus ORTUK UNARCHIVE yapmaz', async () => {
  const { db, organizationId } = await makeDb()
  const archivedAt = daysAgo(5)
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: daysAgo(10),
    archivedAt,
  })
  await repo.touchOrderOperationalActivity(db, organizationId, order.id, NOW)
  const rows = await db
    .select({ archivedAt: orders.archivedAt })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.ok(rows[0].archivedAt, 'arsiv bayragi KORUNMALI')
  assert.equal(rows[0].archivedAt.getTime(), archivedAt.getTime())
})

test('CLOCK-REPRINT-7: markLabelPrinted servisi basarili baskida saati yeniler', async () => {
  const { db, organizationId } = await makeDb()
  const stale = daysAgo(10)
  // Zaten LABEL_PRINTED: no-regress nedeniyle statu GECISI olmaz.
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: stale,
  })
  const result = await service.markLabelPrinted(db, organizationId, order.id)
  assert.equal(result.found, true)
  assert.equal(result.updated, false, 'statu gecisi YOK (idempotent)')

  const rows = await db
    .select({
      value: orders.lastOperationalActivityAt,
      operationStatus: orders.operationStatus,
    })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.ok(
    rows[0].value.getTime() > stale.getTime(),
    'basarili tekrar baski saati YENILEMELI',
  )
  assert.equal(rows[0].operationStatus, 'LABEL_PRINTED')
})

// ═══ HOUSEKEEPING ACTIVATION GUARD ════════════════════════════════════════
//
// PRODUCTION-SAFE VARSAYILAN: otomatik yazma KAPALI. Bayrak yalniz acik
// onayla ('true'/'1') etkinlesir. Salt okunur denetim bayraktan BAGIMSIZDIR.

async function countRows(db) {
  const rows = await db
    .select({
      id: orders.id,
      archivedAt: orders.archivedAt,
      activity: orders.lastOperationalActivityAt,
    })
    .from(orders)
  return rows
}

test('HOUSEKEEPING-GATE-1: env false → boot/periyodik writer YAZMAZ', async () => {
  const { db, organizationId } = await makeDb()
  // Uygun aday: baseline + archive + purge her uc kategoriye de aday uret.
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: null,
  })
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: daysAgo(10),
  })
  await seedPurgeCandidate(db, organizationId, 120)
  const before = await countRows(db)

  const disabled = retention.resolveRetentionPolicy({
    ORDER_HOUSEKEEPING_ENABLED: 'false',
  })
  assert.equal(disabled.housekeepingEnabled, false)
  const report = await retention.runRetentionCycle(db, disabled, NOW)

  assert.equal(report.baselined, 0, 'baseline yazmasi YOK')
  assert.equal(report.archived, 0, 'archive yazmasi YOK')
  assert.equal(report.purged, 0, 'purge yazmasi YOK')
  // Uygunluk sayilari yine de raporlanir (gorunurluk kaybolmaz).
  assert.ok(report.baselineEligible >= 1)
  assert.ok(report.archiveEligible >= 1)
  assert.ok(report.purgeEligible >= 1)

  const after = await countRows(db)
  assert.equal(after.length, before.length, 'kayit SILINMEDI')
  assert.deepEqual(
    after.map((row) => [
      row.id,
      row.archivedAt ? row.archivedAt.getTime() : null,
      row.activity ? row.activity.getTime() : null,
    ]),
    before.map((row) => [
      row.id,
      row.archivedAt ? row.archivedAt.getTime() : null,
      row.activity ? row.activity.getTime() : null,
    ]),
    'hicbir alan DEGISMEDI',
  )
})

test('HOUSEKEEPING-GATE-2: env unset → production-safe varsayilan FALSE', async () => {
  assert.equal(retention.isHousekeepingEnabled({}), false)
  assert.equal(retention.resolveRetentionPolicy({}).housekeepingEnabled, false)
  // Bos string / 0 / rastgele deger de KAPALI kabul edilir.
  for (const value of ['', '0', 'no', 'off', 'yes', 'TRUE ']) {
    const expected = value.trim().toLowerCase() === 'true'
    assert.equal(
      retention.isHousekeepingEnabled({ ORDER_HOUSEKEEPING_ENABLED: value }),
      expected,
      `deger: ${JSON.stringify(value)}`,
    )
  }

  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    lastOperationalActivityAt: daysAgo(10),
  })
  const report = await retention.runRetentionCycle(
    db,
    retention.resolveRetentionPolicy({}),
    NOW,
  )
  assert.equal(report.archived, 0, 'varsayilan olarak yazma YOK')
})

test('HOUSEKEEPING-GATE-3: env true → mevcut sinirli housekeeping calisir', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: null,
  })
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: daysAgo(10),
  })
  await seedPurgeCandidate(db, organizationId, 120)

  const enabled = retention.resolveRetentionPolicy({
    ORDER_HOUSEKEEPING_ENABLED: 'true',
  })
  assert.equal(enabled.housekeepingEnabled, true)
  const report = await retention.runRetentionCycle(db, enabled, NOW)
  assert.equal(report.baselined, 1)
  assert.equal(report.archived, 1)
  assert.equal(report.purged, 1)
  assert.equal(report.failed, 0)

  // '1' de etkinlestirir.
  assert.equal(
    retention.resolveRetentionPolicy({ ORDER_HOUSEKEEPING_ENABLED: '1' })
      .housekeepingEnabled,
    true,
  )
})

test('HOUSEKEEPING-GATE-4: bayrak false iken dry-run CALISIR ve DB write = 0', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: null,
  })
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: daysAgo(10),
  })
  await seedPurgeCandidate(db, organizationId, 120)
  const before = await countRows(db)

  const disabled = retention.resolveRetentionPolicy({
    ORDER_HOUSEKEEPING_ENABLED: 'false',
  })
  // inspectRetention (CLI'nin kullandigi tek fonksiyon) bayraktan BAGIMSIZ.
  const counts = await retention.inspectRetention(db, disabled, NOW)
  assert.ok(counts.scanned >= 3)
  assert.equal(counts.baselineEligible, 1)
  assert.equal(counts.archiveEligible, 1)
  assert.equal(counts.purgeEligible, 1)
  assert.ok(counts.nullActivityBacklog >= 1)

  const after = await countRows(db)
  assert.deepEqual(
    after.map((row) => [
      row.id,
      row.archivedAt ? row.archivedAt.getTime() : null,
      row.activity ? row.activity.getTime() : null,
    ]),
    before.map((row) => [
      row.id,
      row.archivedAt ? row.archivedAt.getTime() : null,
      row.activity ? row.activity.getTime() : null,
    ]),
    'salt okunur: DB write 0',
  )
})

test('HOUSEKEEPING-GATE-5: normal sipariş/sync/print akislari bayraktan ETKILENMEZ', async () => {
  // 1) Bayrak YALNIZ retention modulunde okunur; baska hicbir kod yolunda yok.
  const roots = ['orders', 'shipments', 'integrations', 'labels', 'analytics']
  for (const dir of roots) {
    let entries = []
    try {
      entries = readdirSync(join(here, dir))
    } catch {
      continue
    }
    for (const file of entries.filter((name) => name.endsWith('.ts'))) {
      // Retention modulleri bayragi OKUMAKLA gorevlidir; disindakiler OKUMAZ.
      if (
        file === 'orderRetention.ts' ||
        file === 'retentionCheckCli.ts' ||
        file === 'retentionScheduler.ts'
      ) {
        continue
      }
      const source = readFileSync(join(here, dir, file), 'utf8')
      assert.ok(
        !source.includes('ORDER_HOUSEKEEPING_ENABLED'),
        `${dir}/${file} bayragi okumamali`,
      )
      assert.ok(
        !source.includes('housekeepingEnabled'),
        `${dir}/${file} bayragi okumamali`,
      )
    }
  }
  const serverEntry = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Boot yolu bayragi KENDISI OKUMAZ; karari zamanlayiciya devreder
  // (tek karar noktasi). Aciklama satirinda gecmesi okuma degildir.
  assert.ok(!serverEntry.includes('process.env.ORDER_HOUSEKEEPING_ENABLED'))
  // 2) Boot yolu YAZMA ilkellerini DOGRUDAN cagirmaz; yalniz KAPILI
  //    zamanlayiciyi kurar (bayrak kapaliysa zamanlayici da kurulmaz).
  assert.ok(!serverEntry.includes('runRetentionCycle'))
  assert.ok(!serverEntry.includes('archiveEligibleOrders'))
  assert.ok(!serverEntry.includes('applyActivityBaseline'))
  assert.ok(!serverEntry.includes('purgeOrderRecord'))

  // 3) Normal akislar bayrak KAPALI iken de calisir.
  const { db, organizationId } = await makeDb()
  const order = await insertOrder(db, organizationId, {
    operationStatus: 'BARCODE_WAITING',
  })
  const ready = await repo.markOrderLabelReady(db, organizationId, order.id)
  assert.equal(ready.updated, true, 'etiket hazir gecisi calismali')
  const printed = await repo.markOrderLabelPrinted(db, organizationId, order.id)
  assert.equal(printed.updated, true, 'baski gecisi calismali')
  const sync = mapper.marketplaceUpdateSet({
    orderNumber: 'ORD-X',
    packageId: 'PKG-X',
    marketplaceStatus: 'Picking',
    orderDate: NOW.toISOString(),
  })
  assert.ok(sync.lastSeenAt, 'marketplace sync alanlari uretilmeli')
})

test('HOUSEKEEPING-GATE-6: dry-run CLI yalniz SALT OKUNUR fonksiyon kullanir', async () => {
  const cli = readFileSync(join(here, 'orders', 'retentionCheckCli.ts'), 'utf8')
  for (const forbidden of [
    'applyActivityBaseline',
    'archiveEligibleOrders',
    'purgeOrderRecord',
    'runRetentionCycle',
  ]) {
    assert.ok(!cli.includes(forbidden), `CLI ${forbidden} CAGIRMAMALI`)
  }
  assert.ok(cli.includes('inspectRetention'))
})

// ═══ RETENTION HOUSEKEEPING ZAMANLAYICISI ═════════════════════════════════
//
// Bu blok YALNIZ calisma-zamani baglantisini kilitler. Is kurallari
// (baseline/archive/purge yuklemleri, 4/90 gun, batch) orderRetention.ts'te
// kalir ve zamanlayici tarafindan OLDUGU GIBI kullanilir.

const schedulerModule = await import('./orders/retentionScheduler.ts')

/** Gercek DB'ye dokunmayan sahte tur; cagri sayimi ve gecikme kontrolu. */
function makeCycleSpy({ fail = false, delayMs = 0 } = {}) {
  const calls = []
  let resolveGate = null
  const spy = async () => {
    calls.push(Date.now())
    if (delayMs > 0) {
      await new Promise((resolve) => {
        resolveGate = resolve
        setTimeout(resolve, delayMs)
      })
    }
    if (fail) throw new Error('sentetik tur hatasi')
    return {
      scanned: 0,
      baselineEligible: 0,
      baselined: 0,
      archiveEligible: 0,
      archived: 0,
      purgeEligible: 0,
      purged: 0,
      failed: 0,
      durationMs: 1,
    }
  }
  return { spy, calls, release: () => resolveGate?.() }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('SCHEDULER-1: bayrak unset → zamanlayici KURULMAZ, tur cagrisi = 0', async () => {
  const { spy, calls } = makeCycleSpy()
  const handle = schedulerModule.startRetentionScheduler(
    {},
    {
      policy: retention.resolveRetentionPolicy({}),
      runCycle: spy,
      log: () => {},
    },
  )
  assert.equal(handle.started, false)
  assert.equal(handle.reason, 'disabled')
  assert.equal(schedulerModule.isRetentionSchedulerActive(), false)
  await wait(30)
  assert.equal(calls.length, 0, 'boot yazmasi YOK')
  handle.stop()
})

test('SCHEDULER-2: bayrak false → tur cagrisi = 0', async () => {
  const { spy, calls } = makeCycleSpy()
  const handle = schedulerModule.startRetentionScheduler(
    {},
    {
      policy: retention.resolveRetentionPolicy({
        ORDER_HOUSEKEEPING_ENABLED: 'false',
      }),
      runCycle: spy,
      log: () => {},
    },
  )
  assert.equal(handle.started, false)
  await wait(30)
  assert.equal(calls.length, 0)
  handle.stop()
})

test('SCHEDULER-3: bayrak true → boot sonrasi TAM 1 initial tur', async () => {
  const { spy, calls } = makeCycleSpy()
  const handle = schedulerModule.startRetentionScheduler(
    {},
    {
      policy: {
        ...retention.resolveRetentionPolicy({
          ORDER_HOUSEKEEPING_ENABLED: 'true',
        }),
        intervalMs: 60_000,
      },
      runCycle: spy,
      log: () => {},
    },
  )
  assert.equal(handle.started, true)
  assert.equal(schedulerModule.isRetentionSchedulerActive(), true)
  await wait(40)
  assert.equal(calls.length, 1, 'tam bir initial tur')
  handle.stop()
})

test('SCHEDULER-4: interval tick → sonraki tur calisir', async () => {
  const { spy, calls } = makeCycleSpy()
  const handle = schedulerModule.startRetentionScheduler(
    {},
    {
      policy: {
        ...retention.resolveRetentionPolicy({
          ORDER_HOUSEKEEPING_ENABLED: 'true',
        }),
        intervalMs: 25,
      },
      runCycle: spy,
      log: () => {},
    },
  )
  await wait(120)
  handle.stop()
  assert.ok(calls.length >= 2, `periyodik tur beklenir, gorulen: ${calls.length}`)
})

test('SCHEDULER-5: tur devam ederken tick ORTUSME uretmez', async () => {
  const { spy, calls, release } = makeCycleSpy({ delayMs: 200 })
  const handle = schedulerModule.startRetentionScheduler(
    {},
    {
      policy: {
        ...retention.resolveRetentionPolicy({
          ORDER_HOUSEKEEPING_ENABLED: 'true',
        }),
        intervalMs: 20,
      },
      runCycle: spy,
      log: () => {},
    },
  )
  // Ilk tur 200ms surerken ~9 tick gecer; hicbiri yeni tur BASLATMAMALI.
  await wait(140)
  assert.equal(calls.length, 1, 'ortusen tur YOK')
  release()
  handle.stop()
})

test('SCHEDULER-6: tur hata firlatsa da zamanlayici YASAR, sonraki tick dener', async () => {
  const { spy, calls } = makeCycleSpy({ fail: true })
  const errors = []
  const handle = schedulerModule.startRetentionScheduler(
    {},
    {
      policy: {
        ...retention.resolveRetentionPolicy({
          ORDER_HOUSEKEEPING_ENABLED: 'true',
        }),
        intervalMs: 25,
      },
      runCycle: spy,
      log: () => {},
      onError: (error) => errors.push(error),
    },
  )
  await wait(120)
  assert.ok(calls.length >= 2, 'hata sonrasi yeniden denenmeli')
  assert.ok(errors.length >= 2, 'hata yakalanip raporlanmali')
  assert.equal(
    schedulerModule.isRetentionSchedulerActive(),
    true,
    'zamanlayici hayatta',
  )
  handle.stop()
})

test('SCHEDULER-7: bayrak false iken retention:check yine SALT OKUNUR calisir', async () => {
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: daysAgo(10),
  })
  const disabled = retention.resolveRetentionPolicy({
    ORDER_HOUSEKEEPING_ENABLED: 'false',
  })
  const before = await db.select({ id: orders.id, a: orders.archivedAt }).from(orders)
  const counts = await retention.inspectRetention(db, disabled, NOW)
  const after = await db.select({ id: orders.id, a: orders.archivedAt }).from(orders)
  assert.equal(counts.archiveEligible, 1)
  assert.deepEqual(
    after.map((r) => [r.id, r.a]),
    before.map((r) => [r.id, r.a]),
    'DB write 0',
  )
})

test('SCHEDULER-8: zamanlayici MEVCUT runRetentionCycle/batch/predicate kullanir', async () => {
  // Kanit 1: modul kendi is kurali TASIMAZ (yukleme/limit tanimlamaz).
  const source = readFileSync(
    join(here, 'orders', 'retentionScheduler.ts'),
    'utf8',
  )
  for (const forbidden of [
    'LABEL_READY',
    'archived_at',
    'archiveAfterDays =',
    'purgeAfterDays =',
    'BATCH_SIZE =',
  ]) {
    assert.ok(!source.includes(forbidden), `zamanlayici ${forbidden} TASIMAMALI`)
  }
  assert.ok(source.includes('runRetentionCycle'))

  // Kanit 2: gercek DB ile uctan uca tur mevcut davranisi uretir.
  const { db, organizationId } = await makeDb()
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: null,
  })
  await insertOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Picking',
    lastOperationalActivityAt: daysAgo(10),
  })
  await seedPurgeCandidate(db, organizationId, 120)

  const reports = []
  const handle = schedulerModule.startRetentionScheduler(db, {
    policy: {
      ...retention.resolveRetentionPolicy({
        ORDER_HOUSEKEEPING_ENABLED: 'true',
      }),
      intervalMs: 60_000,
    },
    log: (report) => reports.push(report),
  })
  assert.equal(handle.started, true)
  await wait(400)
  handle.stop()
  assert.equal(reports.length, 1)
  assert.equal(reports[0].baselined, 1)
  assert.equal(reports[0].archived, 1)
  assert.equal(reports[0].purged, 1)
})

test('SCHEDULER-9: stop() zamanlayiciyi temizler, yeni tur BASLAMAZ', async () => {
  const { spy, calls } = makeCycleSpy()
  const handle = schedulerModule.startRetentionScheduler(
    {},
    {
      policy: {
        ...retention.resolveRetentionPolicy({
          ORDER_HOUSEKEEPING_ENABLED: 'true',
        }),
        intervalMs: 20,
      },
      runCycle: spy,
      log: () => {},
    },
  )
  await wait(50)
  const seen = calls.length
  handle.stop()
  assert.equal(schedulerModule.isRetentionSchedulerActive(), false)
  await wait(80)
  assert.equal(calls.length, seen, 'durdurulduktan sonra yeni tur YOK')
})

test('SCHEDULER-BOOT-WIRING: boot yolu bayrak KAPILI zamanlayiciyi cagirir', async () => {
  const entry = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.ok(
    entry.includes('startRetentionHousekeepingOnBoot'),
    'boot yolu baglanmali',
  )
  assert.ok(entry.includes('startRetentionScheduler'))
  // Boot yolu is kurali fonksiyonlarini DOGRUDAN cagirmaz.
  assert.ok(!entry.includes('applyActivityBaseline'))
  assert.ok(!entry.includes('archiveEligibleOrders'))
  assert.ok(!entry.includes('purgeOrderRecord'))
  // Kapanista temizlik.
  assert.ok(entry.includes('stopRetentionScheduler'))
  assert.ok(entry.includes('SIGTERM'))
})
