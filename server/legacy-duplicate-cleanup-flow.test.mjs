import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'

// FAZ 1 — LEGACY TEKRAR SATIRI TEMIZLIGI.
//
// URETIM DENETIMI: duplicatePackageCount=964 · duplicateRowCount=1929
//   null_shadow=334 · active_plus_legacy=630
//
// KAPSAM: YALNIZ active_plus_legacy. null_shadow bu fazda KOD DUZEYINDE
// SERT ENGELLI. Silinen tek sey pasif hesap kapsamindaki siparis satiri ve
// ona bagli order_lines; gonderi/operasyon/aktif satir ASLA silinmez.
//
// TOCTOU: her hedef silme ile AYNI transaction icinde bastan dogrulanir.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const cleanup = await import('./orders/legacyDuplicateCleanup.ts')

const {
  orders,
  orderLines,
  organizations,
  marketplaceAccounts,
  shipments,
  shipmentOperations,
} = schema
const MODULE_SOURCE = readFileSync(
  'server/orders/legacyDuplicateCleanup.ts',
  'utf8',
)
const CLI_SOURCE = readFileSync(
  'server/orders/legacyDuplicateCleanupCli.ts',
  'utf8',
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
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Org', slug: `org-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  const [active] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: 'active-277221',
      isActive: true,
    })
    .returning({ id: marketplaceAccounts.id })
  const [legacy] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: 'legacy-82505',
      isActive: false,
    })
    .returning({ id: marketplaceAccounts.id })
  return {
    db,
    organizationId: org.id,
    activeId: active.id,
    legacyId: legacy.id,
  }
}

let seq = 0
async function seedPair(ctx, overrides = {}) {
  seq += 1
  const packageId = overrides.packageId ?? `PKG-${seq}`
  const orderNumber = overrides.orderNumber ?? `ORD-${seq}`
  const base = {
    organizationId: ctx.organizationId,
    marketplace: 'Trendyol',
    packageId,
    orderNumber,
    orderDate: new Date('2026-07-26T10:00:00.000Z'),
  }
  const [active] = await ctx.db
    .insert(orders)
    .values({
      ...base,
      marketplaceAccountId: ctx.activeId,
      marketplaceStatus: 'Delivered',
      operationStatus: null,
    })
    .returning({ id: orders.id })
  const [legacy] = await ctx.db
    .insert(orders)
    .values({
      ...base,
      // DIKKAT: `??` null'da yedege duser; NULL golge satiri kurabilmek icin
      // anahtarin VARLIGINA bakilir.
      marketplaceAccountId:
        'legacyAccountId' in overrides ? overrides.legacyAccountId : ctx.legacyId,
      marketplaceStatus: 'Picking',
      operationStatus: 'NEW',
      archivedAt: overrides.legacyArchivedAt ?? null,
    })
    .returning({ id: orders.id })
  await ctx.db.insert(orderLines).values({
    organizationId: ctx.organizationId,
    orderId: legacy.id,
    externalLineId: `legacy-line-${seq}`,
    productName: 'urun',
    quantity: 1,
  })
  await ctx.db.insert(orderLines).values({
    organizationId: ctx.organizationId,
    orderId: active.id,
    externalLineId: `active-line-${seq}`,
    productName: 'urun',
    quantity: 1,
  })
  return { packageId, orderNumber, activeRowId: active.id, legacyRowId: legacy.id }
}

const accountsOf = (ctx) => ({
  activeAccountIds: [ctx.activeId],
  inactiveAccountIds: [ctx.legacyId],
})

const planOf = (ctx, extra = {}) =>
  cleanup.planPhase1Cleanup(ctx.db, {
    organizationId: ctx.organizationId,
    ...accountsOf(ctx),
    ...extra,
  })

const countRows = async (db, table, where) => {
  const [row] = await db
    .select({ total: sql`count(*)` })
    .from(table)
    .where(where ?? sql`true`)
  return Number(row?.total ?? 0)
}

// ═══ TEMEL AKIS ═══════════════════════════════════════════════════════════

test('LEGACY-CLEANUP-1: temiz active+legacy → legacy silinir, active KORUNUR', async () => {
  const ctx = await makeDb()
  const pair = await seedPair(ctx)
  const plan = await planOf(ctx)
  assert.equal(plan.activePlusLegacyTotal, 1)
  assert.equal(plan.activePlusLegacyEligible, 1)
  assert.equal(plan.expectedOrderDeletes, 1)
  assert.equal(plan.expectedOrderLineDeletes, 1)
  assert.equal(plan.nullShadowTouched, false)
  assert.equal(plan.targets[0].legacyRowId, pair.legacyRowId)

  const result = await cleanup.applyPhase1Target(
    ctx.db,
    plan.targets[0],
    accountsOf(ctx),
  )
  assert.equal(result.applied, true)
  assert.equal(result.deletedOrders, 1)
  assert.equal(result.deletedOrderLines, 1)

  const remaining = await ctx.db.select({ id: orders.id }).from(orders)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].id, pair.activeRowId, 'AKTIF satir korunur')
})

test('LEGACY-CLEANUP-2: pakette shipment varsa BLOCK', async () => {
  const ctx = await makeDb()
  const pair = await seedPair(ctx)
  await ctx.db.insert(shipments).values({
    organizationId: ctx.organizationId,
    marketplace: 'Trendyol',
    packageId: pair.packageId,
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const plan = await planOf(ctx)
  assert.equal(plan.activePlusLegacyEligible, 0)
  assert.equal(plan.blockedReasons.package_has_shipment, 1)
  assert.equal(await countRows(ctx.db, orders), 2, 'silme YOK')
})

test('LEGACY-CLEANUP-3: pakette shipment_operation varsa BLOCK', async () => {
  const ctx = await makeDb()
  const pair = await seedPair(ctx)
  await ctx.db.insert(shipmentOperations).values({
    organizationId: ctx.organizationId,
    marketplace: 'Trendyol',
    packageId: pair.packageId,
    provider: 'surat-kargo',
    operationType: 'create',
    idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
    status: 'succeeded',
  })
  const plan = await planOf(ctx)
  assert.equal(plan.activePlusLegacyEligible, 0)
  assert.equal(plan.blockedReasons.package_has_shipment_operation, 1)
})

test('LEGACY-CLEANUP-4: legacy satir ARSIVLI ise BLOCK', async () => {
  const ctx = await makeDb()
  await seedPair(ctx, { legacyArchivedAt: new Date('2026-08-01T00:00:00.000Z') })
  const plan = await planOf(ctx)
  assert.equal(plan.activePlusLegacyEligible, 0)
  assert.equal(plan.blockedReasons.archived_row, 1)
})

test('LEGACY-CLEANUP-5: null_shadow SERT ENGEL (plan ve transaction)', async () => {
  const ctx = await makeDb()
  const pair = await seedPair(ctx, { legacyAccountId: null })
  const plan = await planOf(ctx)
  assert.equal(plan.activePlusLegacyTotal, 0, 'sinif active_plus_legacy DEGIL')
  assert.equal(plan.expectedOrderDeletes, 0)

  // Hedef ELLE kurulsa bile transaction icinde ENGELLENIR.
  const forced = await cleanup.applyPhase1Target(
    ctx.db,
    {
      organizationId: ctx.organizationId,
      marketplace: 'Trendyol',
      packageId: pair.packageId,
      orderNumber: pair.orderNumber,
      legacyRowId: pair.legacyRowId,
      legacyAccountId: 'null',
      activeRowId: pair.activeRowId,
      activeAccountId: ctx.activeId,
      expectedOrderLineDeletes: 1,
    },
    accountsOf(ctx),
  )
  assert.equal(forced.applied, false)
  assert.equal(forced.reason, 'null_shadow_hard_block')
  assert.equal(await countRows(ctx.db, orders), 2, 'golge satir DURUYOR')

  // Saf yuklem de reddeder.
  assert.equal(
    cleanup.isPhase1Eligible({
      duplicateClass: 'null_shadow',
      cleanupEligible: true,
      rows: [
        { role: 'active', marketplaceAccountId: 'a' },
        { role: 'null_shadow', marketplaceAccountId: null },
      ],
    }),
    false,
  )
})

test('LEGACY-CLEANUP-6: 3 satirli grup BLOCK', async () => {
  const ctx = await makeDb()
  const pair = await seedPair(ctx)
  const [third] = await ctx.db
    .insert(orders)
    .values({
      organizationId: ctx.organizationId,
      marketplaceAccountId: null,
      marketplace: 'Trendyol',
      packageId: pair.packageId,
      orderNumber: pair.orderNumber,
      marketplaceStatus: 'Picking',
      orderDate: new Date('2026-07-26T10:00:00.000Z'),
    })
    .returning({ id: orders.id })
  assert.ok(third.id)
  const plan = await planOf(ctx)
  assert.equal(plan.expectedOrderDeletes, 0)
  assert.equal(await countRows(ctx.db, orders), 3)
})

// ═══ TOCTOU ═══════════════════════════════════════════════════════════════

test('LEGACY-CLEANUP-7: aktif hesap PASIFLESMISSE transaction BLOCK eder', async () => {
  const ctx = await makeDb()
  await seedPair(ctx)
  const plan = await planOf(ctx)
  // Denetimden SONRA aktif hesap pasiflesti.
  const result = await cleanup.applyPhase1Target(ctx.db, plan.targets[0], {
    activeAccountIds: [],
    inactiveAccountIds: [ctx.activeId, ctx.legacyId],
  })
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'class_changed')
  assert.equal(await countRows(ctx.db, orders), 2)
})

test('LEGACY-CLEANUP-8: legacy hesap tekrar AKTIF olmussa BLOCK', async () => {
  const ctx = await makeDb()
  await seedPair(ctx)
  const plan = await planOf(ctx)
  const result = await cleanup.applyPhase1Target(ctx.db, plan.targets[0], {
    activeAccountIds: [ctx.activeId, ctx.legacyId],
    inactiveAccountIds: [],
  })
  assert.equal(result.applied, false)
  // Iki satir da aktif kapsamda → sinif degisti.
  assert.ok(['class_changed', 'candidate_not_legacy_scope'].includes(result.reason))
  assert.equal(await countRows(ctx.db, orders), 2)
})

// ═══ SILME KAPSAMI ════════════════════════════════════════════════════════

test('LEGACY-CLEANUP-9/10: yalniz legacy satirlari silinir, aktif satirlar KALIR', async () => {
  const ctx = await makeDb()
  const pair = await seedPair(ctx)
  const plan = await planOf(ctx)
  await cleanup.applyPhase1Target(ctx.db, plan.targets[0], accountsOf(ctx))

  const legacyLines = await ctx.db
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(eq(orderLines.orderId, pair.legacyRowId))
  assert.equal(legacyLines.length, 0, 'legacy satirlari silindi')

  const activeLines = await ctx.db
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(eq(orderLines.orderId, pair.activeRowId))
  assert.equal(activeLines.length, 1, 'AKTIF satirlar AYNEN kalir')
})

test('LEGACY-CLEANUP-11: idempotent — ikinci calistirma not_found ile atlar', async () => {
  const ctx = await makeDb()
  await seedPair(ctx)
  const plan = await planOf(ctx)
  const first = await cleanup.applyPhase1Target(
    ctx.db,
    plan.targets[0],
    accountsOf(ctx),
  )
  assert.equal(first.applied, true)
  const second = await cleanup.applyPhase1Target(
    ctx.db,
    plan.targets[0],
    accountsOf(ctx),
  )
  assert.equal(second.applied, false)
  assert.ok(['not_found', 'row_count_changed'].includes(second.reason))
  // Yeni plan bos: grup artik tekrar DEGIL.
  const replan = await planOf(ctx)
  assert.equal(replan.activePlusLegacyTotal, 0)
})

test('LEGACY-CLEANUP-12: plan (dry-run) HICBIR yazma yapmaz', async () => {
  const ctx = await makeDb()
  await seedPair(ctx)
  const before = await countRows(ctx.db, orders)
  const beforeLines = await countRows(ctx.db, orderLines)
  await planOf(ctx)
  assert.equal(await countRows(ctx.db, orders), before)
  assert.equal(await countRows(ctx.db, orderLines), beforeLines)
  // CLI varsayilani KURU CALISMA.
  assert.ok(CLI_SOURCE.includes("const apply = process.argv.includes('--apply')"))
  assert.ok(CLI_SOURCE.includes("mode: 'dry_run'"))
  assert.ok(CLI_SOURCE.includes('cleanupPerformed: false'))
})

test('LEGACY-CLEANUP-13: tasiyici toplamlari apply sonrasi DEGISMEZ', async () => {
  const ctx = await makeDb()
  const clean = await seedPair(ctx)
  const withCarrier = await seedPair(ctx)
  await ctx.db.insert(shipments).values({
    organizationId: ctx.organizationId,
    marketplace: 'Trendyol',
    packageId: withCarrier.packageId,
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  await ctx.db.insert(shipmentOperations).values({
    organizationId: ctx.organizationId,
    marketplace: 'Trendyol',
    packageId: withCarrier.packageId,
    provider: 'surat-kargo',
    operationType: 'create',
    idempotencyKey: `idem-${randomBytes(4).toString('hex')}`,
    status: 'succeeded',
  })
  const shipBefore = await countRows(ctx.db, shipments)
  const opBefore = await countRows(ctx.db, shipmentOperations)

  const plan = await planOf(ctx)
  assert.equal(plan.expectedOrderDeletes, 1, 'yalniz TEMIZ grup hedef')
  assert.equal(plan.targets[0].packageId, clean.packageId)
  await cleanup.applyPhase1Target(ctx.db, plan.targets[0], accountsOf(ctx))

  assert.equal(await countRows(ctx.db, shipments), shipBefore)
  assert.equal(await countRows(ctx.db, shipmentOperations), opBefore)
})

test('LEGACY-CLEANUP-14: null_shadow sayisi DEGISMEZ', async () => {
  const ctx = await makeDb()
  const clean = await seedPair(ctx)
  const shadow = await seedPair(ctx, { legacyAccountId: null })
  const audit = await import('./orders/crossAccountDuplicateAudit.ts')
  const before = await audit.auditCrossAccountDuplicates(ctx.db, {
    organizationId: ctx.organizationId,
    activeAccountIds: [ctx.activeId],
  })
  assert.equal(before.classCounts.null_shadow, 1)

  const plan = await planOf(ctx)
  assert.equal(plan.targets.length, 1)
  assert.equal(plan.targets[0].packageId, clean.packageId)
  await cleanup.applyPhase1Target(ctx.db, plan.targets[0], accountsOf(ctx))

  const after = await audit.auditCrossAccountDuplicates(ctx.db, {
    organizationId: ctx.organizationId,
    activeAccountIds: [ctx.activeId],
  })
  assert.equal(after.classCounts.null_shadow, 1, 'golge sinifi DOKUNULMADI')
  const shadowRows = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.packageId, shadow.packageId))
  assert.equal(shadowRows.length, 2, 'golge grubun iki satiri da DURUYOR')
})

// ═══ KAPSAM ═══════════════════════════════════════════════════════════════

test('LEGACY-CLEANUP-SCOPE: silme yuzeyi YALNIZ order_lines + orders', () => {
  const code = MODULE_SOURCE.split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.ok(code.includes('.delete(orderLines)'))
  assert.ok(code.includes('.delete(orders)'))
  for (const forbidden of [
    '.delete(shipments)',
    '.delete(shipmentOperations)',
    '.delete(marketplaceAccounts)',
    'callTrendyol',
    'fetch(',
    'surat',
  ]) {
    assert.equal(
      code.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      forbidden,
    )
  }
  // Silme DAİMA transaction icinde.
  assert.ok(code.includes('database.transaction('))
  // Toplu tek transaction YOK: CLI hedef hedef ilerler.
  assert.ok(CLI_SOURCE.includes('for (const target of plan.targets)'))
  assert.ok(CLI_SOURCE.includes('batchSize'))
})
