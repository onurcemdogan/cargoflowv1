import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// NULL-HESAP GOLGE SATIRI KOKEN/TEKRAR DENETIMI (SALT OKUNUR).
//
// URETIM: duplicatePackageCount=487 · null_shadow=334 · active_plus_legacy=153
//
// SORU: NULL satirlar tarihsel kalinti mi, yoksa hala yeniden mi olusuyor?
// KARAR yalniz IKI sinyal birlikte saglanirsa HISTORICAL_ONLY olur:
//   (a) duzeltme sinirindan SONRA olusmus NULL satir YOK,
//   (b) NULL yazabilen ULASILABILIR calisma zamani yolu YOK.
//
// KOD DENETIMI BULGUSU (kanitli): resolveActiveMarketplaceAccountId aktif
// hesap yoksa VE herhangi bir hata olusursa (`catch { return null }`) null
// doner; bu deger dogrudan persistSyncResult'a gider. Yani (b) SAGLANMIYOR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const audit = await import('./orders/nullShadowAudit.ts')

const { orders, orderLines, organizations, marketplaceAccounts, shipments } =
  schema
const ENTRY_SOURCE = readFileSync('server/index.mjs', 'utf8')
const MODULE_SOURCE = readFileSync('server/orders/nullShadowAudit.ts', 'utf8')
const CLI_SOURCE = readFileSync('server/orders/nullShadowAuditCli.ts', 'utf8')

const NOW = new Date('2026-08-12T09:00:00.000Z')
const FIX = new Date('2026-08-11T13:42:24.000Z')
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 60 * 60 * 1000)

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

async function makeCtx() {
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
  return { db, organizationId: org.id, activeId: active.id }
}

let seq = 0
async function seedShadowPair(ctx, overrides = {}) {
  seq += 1
  const packageId = overrides.packageId ?? `PKG-${seq}`
  const base = {
    organizationId: ctx.organizationId,
    marketplace: 'Trendyol',
    packageId,
    orderNumber: `ORD-${seq}`,
    orderDate: new Date('2026-07-26T10:00:00.000Z'),
  }
  const [active] = await ctx.db
    .insert(orders)
    .values({
      ...base,
      marketplaceAccountId: ctx.activeId,
      marketplaceStatus: overrides.activeStatus ?? 'Delivered',
      operationStatus: overrides.activeOperation ?? 'NEW',
      archivedAt: overrides.activeArchivedAt ?? null,
      createdAt: overrides.activeCreatedAt ?? hoursAgo(100),
    })
    .returning({ id: orders.id })
  const [shadow] = await ctx.db
    .insert(orders)
    .values({
      ...base,
      marketplaceAccountId: null,
      marketplaceStatus: overrides.shadowStatus ?? 'Delivered',
      operationStatus: overrides.shadowOperation ?? 'NEW',
      archivedAt: overrides.shadowArchivedAt ?? null,
      createdAt: overrides.shadowCreatedAt ?? hoursAgo(100),
      firstSeenAt: overrides.shadowCreatedAt ?? hoursAgo(100),
      lastSeenAt: overrides.shadowLastSeenAt ?? hoursAgo(100),
    })
    .returning({ id: orders.id })
  for (const [orderId, sku] of [
    [active.id, overrides.activeSku ?? 'SKU-1'],
    [shadow.id, overrides.shadowSku ?? 'SKU-1'],
  ]) {
    await ctx.db.insert(orderLines).values({
      organizationId: ctx.organizationId,
      orderId,
      externalLineId: `line-${randomBytes(3).toString('hex')}`,
      productName: 'urun',
      merchantSku: sku,
      quantity: 1,
    })
  }
  return { packageId, activeRowId: active.id, shadowRowId: shadow.id }
}

const runAudit = (ctx, extra = {}) =>
  audit.auditNullShadowRows(ctx.db, {
    organizationId: ctx.organizationId,
    activeAccountIds: [ctx.activeId],
    now: NOW,
    fixBoundary: FIX,
    ...extra,
  })

// ═══ ZAMAN CIZELGESI ══════════════════════════════════════════════════════

test('NULL-AUDIT-1: zaman pencereleri dogru sayilir', () => {
  const buckets = audit.bucketTimestamps(
    [hoursAgo(0.5), hoursAgo(3), hoursAgo(12), hoursAgo(40), hoursAgo(200), null],
    NOW,
  )
  assert.equal(buckets.countLast1h, 1)
  assert.equal(buckets.countLast6h, 2)
  assert.equal(buckets.countLast24h, 3)
  assert.equal(buckets.countLast3d, 4)
  assert.equal(buckets.latest, hoursAgo(0.5).toISOString())
  assert.equal(buckets.earliest, hoursAgo(200).toISOString())
  assert.deepEqual(audit.bucketTimestamps([], NOW), {
    earliest: null,
    latest: null,
    countLast1h: 0,
    countLast6h: 0,
    countLast24h: 0,
    countLast3d: 0,
  })
})

test('NULL-AUDIT-2: fix sinirindan once/sonra AYRILIR', async () => {
  const ctx = await makeCtx()
  await seedShadowPair(ctx, { shadowCreatedAt: hoursAgo(72) }) // fix ONCESI
  await seedShadowPair(ctx, { shadowCreatedAt: hoursAgo(2) }) // fix SONRASI
  const report = await runAudit(ctx)
  assert.equal(report.totalNullRows, 2)
  assert.equal(report.createdBeforeFix, 1)
  assert.equal(report.createdAfterFix, 1)
  assert.equal(report.latestNullRowCreatedAt, hoursAgo(2).toISOString())
})

test('NULL-AUDIT-3: sinir verilmezse ayrim YAPILMAZ (tahmin YOK)', async () => {
  const ctx = await makeCtx()
  await seedShadowPair(ctx)
  const report = await runAudit(ctx, { fixBoundary: null })
  assert.equal(report.createdBeforeFix, null)
  assert.equal(report.createdAfterFix, null)
  assert.equal(report.recurrenceVerdict, 'INCONCLUSIVE')
})

// ═══ SINIFLANDIRMA ════════════════════════════════════════════════════════

test('NULL-AUDIT-4: exact_semantic_match yalniz TAM eslesmede', () => {
  const facts = (overrides = {}) => ({
    marketplaceStatus: 'Delivered',
    operationStatus: 'NEW',
    archived: false,
    lineSignature: 'SKU-1||1',
    ...overrides,
  })
  assert.equal(
    audit.classifyNullShadowGroup({ rowCount: 2, active: facts(), shadow: facts() }),
    'exact_semantic_match',
  )
  assert.equal(
    audit.classifyNullShadowGroup({
      rowCount: 2,
      active: facts(),
      shadow: facts({ operationStatus: 'LABEL_PRINTED' }),
    }),
    'status_match_operation_diff',
  )
  assert.equal(
    audit.classifyNullShadowGroup({
      rowCount: 2,
      active: facts(),
      shadow: facts({ marketplaceStatus: 'Picking' }),
    }),
    'marketplace_status_diff',
  )
  assert.equal(
    audit.classifyNullShadowGroup({
      rowCount: 2,
      active: facts({ archived: true }),
      shadow: facts(),
    }),
    'active_archived_null_open',
  )
  assert.equal(
    audit.classifyNullShadowGroup({
      rowCount: 2,
      active: facts(),
      shadow: facts({ archived: true }),
    }),
    'null_archived_active_open',
  )
  assert.equal(
    audit.classifyNullShadowGroup({
      rowCount: 2,
      active: facts(),
      shadow: facts({ lineSignature: 'SKU-2||1' }),
    }),
    'other',
  )
  assert.equal(
    audit.classifyNullShadowGroup({ rowCount: 3, active: facts(), shadow: facts() }),
    'multi_row_group',
  )
})

test('NULL-AUDIT-5: sinif x tasiyici kirilimi uretilir', async () => {
  const ctx = await makeCtx()
  await seedShadowPair(ctx, { packageId: 'P-EXACT' })
  const withCarrier = await seedShadowPair(ctx, {
    packageId: 'P-CARRIER',
    shadowOperation: 'LABEL_PRINTED',
  })
  await ctx.db.insert(shipments).values({
    organizationId: ctx.organizationId,
    marketplace: 'Trendyol',
    packageId: withCarrier.packageId,
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
  })
  const report = await runAudit(ctx)
  assert.equal(report.nullShadowPackages, 2)
  assert.equal(report.classification.exact_semantic_match, 1)
  assert.equal(report.classification.status_match_operation_diff, 1)
  assert.equal(report.classDetail.exact_semantic_match.carrierFree, 1)
  assert.equal(report.classDetail.status_match_operation_diff.carrierDependent, 1)
})

test('NULL-AUDIT-6: satir icerigi CIKTIYA sizmaz', async () => {
  const ctx = await makeCtx()
  await seedShadowPair(ctx, { activeSku: 'GIZLI-SKU', shadowSku: 'GIZLI-SKU' })
  const report = await runAudit(ctx)
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('GIZLI-SKU'), false, 'SKU sizmaz')
  assert.equal(serialized.includes('lineSignature'), false)
  assert.equal(serialized.includes('urun'), false)
  // Eslesen aktif satir bayragi RAPORLANIR.
  assert.equal(report.recentNullRows[0].matchingActiveAccountRowExists, true)
  assert.equal(report.recentNullRows[0].matchingActiveAccountId, ctx.activeId)
})

// ═══ KARAR ════════════════════════════════════════════════════════════════

test('NULL-AUDIT-7: fix sonrasi yeni satir varsa NEW_NULL_ROWS_STILL_CREATED', async () => {
  const ctx = await makeCtx()
  await seedShadowPair(ctx, { shadowCreatedAt: hoursAgo(2) })
  const report = await runAudit(ctx)
  assert.equal(report.recurrenceVerdict, 'NEW_NULL_ROWS_STILL_CREATED')
})

test('NULL-AUDIT-8: yeni satir YOK ama ULASILABILIR yazar VARSA INCONCLUSIVE', async () => {
  const ctx = await makeCtx()
  await seedShadowPair(ctx, { shadowCreatedAt: hoursAgo(72) })
  const report = await runAudit(ctx)
  assert.equal(report.createdAfterFix, 0)
  assert.ok(report.reachableNullWriterCount > 0, 'NULL yazabilen yol MEVCUT')
  assert.equal(
    report.recurrenceVerdict,
    'INCONCLUSIVE',
    'yalniz "yeni satir yok" HISTORICAL_ONLY icin YETMEZ',
  )
})

test('NULL-AUDIT-9: NULL yazabilen calisma zamani yolu KOD ile kanitli', () => {
  // Cozumleyici iki durumda null doner ve deger dogrudan persist'e gider.
  assert.ok(
    ENTRY_SOURCE.includes('return account ? account.id : null'),
    'aktif hesap yoksa null',
  )
  const lines = ENTRY_SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function resolveActiveMarketplaceAccountId'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('catch {'), 'hata yutuluyor')
  assert.ok(body.includes('return null'), 've null donuyor')

  // Ucu de ayni cozumleyiciyi kullanir.
  for (const writer of ['manual_sync', 'background_sync', 'stale_open_reconcile']) {
    const entry = audit.NULL_CAPABLE_WRITERS.find((item) => item.writer === writer)
    assert.ok(entry, writer)
    assert.equal(entry.canBeNull, true)
    assert.equal(entry.runtimeReachable, true)
    assert.equal(entry.accountSource, 'resolveActiveMarketplaceAccountId')
  }
  // Elle calistirilan CLI yollari runtime ULASILABILIR sayilmaz.
  for (const writer of ['historical_backfill_cli', 'legacy_import_cli']) {
    const entry = audit.NULL_CAPABLE_WRITERS.find((item) => item.writer === writer)
    assert.equal(entry.runtimeReachable, false)
  }
})

// ═══ KAPSAM ═══════════════════════════════════════════════════════════════

test('NULL-AUDIT-10: denetim SALT OKUNUR ve commit sinirini acikca bildirir', () => {
  for (const source of [MODULE_SOURCE, CLI_SOURCE]) {
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    for (const forbidden of [
      '.update(',
      '.insert(',
      '.delete(',
      'transaction(',
      'callTrendyol',
      'fetch(',
    ]) {
      assert.equal(code.includes(forbidden), false, forbidden)
    }
  }
  assert.ok(CLI_SOURCE.includes("cutoffBasis"))
  assert.ok(CLI_SOURCE.includes("'commit_boundary_only'"))
  assert.ok(CLI_SOURCE.includes('c34acbe'))
  assert.ok(CLI_SOURCE.includes('cleanupPerformed: false'))
})
