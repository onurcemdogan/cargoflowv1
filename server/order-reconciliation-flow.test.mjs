import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// READ-ONLY yerel sipariş mutabakatı (Dashboard satış tutarsızlığı tanısı).
// organizationId + marketplaceAccountId + tarih araligi kapsaminda hesap-scoped
// metrikler; provider'a cikmaz, yazma yok. Canonical metrik tanimlari + provider
// karsilastirma diff (ID sizdirmadan).

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const recon = await import('./analytics/orderReconciliation.ts')
const metrics = await import('./analytics/orderMetricDefinitions.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
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
async function makeOrg(db, slug) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}
let seq = 0
function order(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`,
    marketplaceStatus: over.marketplaceStatus ?? 'Delivered',
    operationStatus: over.operationStatus ?? 'DELIVERED',
    city: 'İstanbul', totalAmount: over.totalAmount ?? 100, currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-10T08:00:00Z', rawOrder: {},
    items: over.items ?? [{ id: `l-${packageId}`, barcode: 'B1', quantity: over.qty ?? 1, price: 100, productName: 'X' }],
    ...over,
  }
}
const JULY = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }

test('REC-1: hesap-scoped + tarih-araligi metrikler (paket/kalem/quantity/tutar/status/gun)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rec-1')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'OTHER')
  await orderService.persistSyncResult(db, org, [
    order({ packageId: 'A1', orderDate: '2026-07-05T08:00:00Z', totalAmount: 100, marketplaceStatus: 'Delivered' }),
    order({ packageId: 'A2', orderDate: '2026-07-05T09:00:00Z', totalAmount: 200, marketplaceStatus: 'Delivered', qty: 3 }),
    order({ packageId: 'A3', orderDate: '2026-07-20T08:00:00Z', totalAmount: 50, marketplaceStatus: 'Cancelled' }),
    order({ packageId: 'A4', orderDate: '2026-07-21T08:00:00Z', totalAmount: 40, marketplaceStatus: 'Returned' }),
    order({ packageId: 'A-JUN', orderDate: '2026-06-10T08:00:00Z', totalAmount: 999, marketplaceStatus: 'Delivered' }),
  ], { complete: false, marketplaceAccountId: a.id })
  // Baska hesap (gorunmemeli).
  await orderService.persistSyncResult(db, org, [order({ packageId: 'B1', orderDate: '2026-07-06T08:00:00Z', totalAmount: 500 })], { complete: false, marketplaceAccountId: b.id })

  const rep = await recon.reconcileLocalOrders(db, {
    organizationId: org, marketplaceAccountId: a.id, startMs: JULY.startMs, endMs: JULY.endMs,
  })
  assert.equal(rep.orderCount, 4, 'yalniz A, Temmuz (A-JUN haric)')
  assert.equal(rep.distinctPackageIds, 4)
  assert.equal(rep.orderLineCount, 4, 'kalem = order_line satir sayisi')
  assert.equal(rep.lineQuantityTotal, 6, 'quantity toplam (1+3+1+1)')
  assert.equal(Math.round(rep.totalAmount), 390, 'gross 100+200+50+40')
  const statusMap = Object.fromEntries(rep.byMarketplaceStatus.map((r) => [r.key, r]))
  assert.equal(statusMap.Delivered.count, 2)
  assert.equal(Math.round(statusMap.Cancelled.amount), 50)
  assert.equal(Math.round(statusMap.Returned.amount), 40)
  assert.equal(rep.byDay.length, 3, '05, 20, 21 Temmuz')
  assert.equal(rep.ordersWithoutLines, 0)
  assert.equal(rep.duplicatePackageIdCount, 0)
  assert.equal(rep.nullAccountCountOrgWide, 0)
})

test('REC-2: canonical metrik ozeti — iptal/iade statuden, net = gross - (iptal+iade)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rec-2')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  await orderService.persistSyncResult(db, org, [
    order({ packageId: 'S1', totalAmount: 1000, marketplaceStatus: 'Delivered' }),
    order({ packageId: 'S2', totalAmount: 300, marketplaceStatus: 'Cancelled' }),
    order({ packageId: 'S3', totalAmount: 200, marketplaceStatus: 'Returned' }),
  ], { complete: false, marketplaceAccountId: a.id })
  const rep = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, startMs: JULY.startMs, endMs: JULY.endMs })
  const summary = metrics.toCanonicalSummary({
    distinctPackageIds: rep.distinctPackageIds,
    orderLineCount: rep.orderLineCount,
    lineQuantityTotal: rep.lineQuantityTotal,
    totalAmount: rep.totalAmount,
    byMarketplaceStatus: rep.byMarketplaceStatus,
  })
  assert.equal(Math.round(summary.grossSales), 1500)
  assert.equal(Math.round(summary.cancelAmount), 300)
  assert.equal(Math.round(summary.returnAmount), 200)
  assert.equal(Math.round(summary.netSales), 1000, 'net = 1500 - (300+200)')
  assert.equal(summary.packageCount, 3)
})

test('REC-3: duplicate packageId ve satirsiz siparis tespiti', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rec-3')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  // Satirsiz siparis (items: []).
  await orderService.persistSyncResult(db, org, [
    order({ packageId: 'NOLINE', items: [] }),
    order({ packageId: 'HASLINE' }),
  ], { complete: false, marketplaceAccountId: a.id })
  const rep = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, startMs: JULY.startMs, endMs: JULY.endMs })
  assert.equal(rep.ordersWithoutLines, 1, 'NOLINE satirsiz')
})

test('REC-4: provider vs local diff — eksik sayi + status bucket (ID sizdirmadan)', () => {
  const provider = {
    packageIds: new Set(['P1', 'P2', 'P3', 'P4']),
    orderCount: 4, lineQuantityTotal: 4, grossAmount: 400,
    byStatus: new Map(), byDay: new Map(),
  }
  const localIds = new Set(['P1', 'P2'])
  const localReport = { orderCount: 2, lineQuantityTotal: 2, totalAmount: 200 }
  const statusOf = (id) => (id === 'P3' ? 'Delivered' : 'Cancelled')
  const diff = recon.diffProviderVsLocal(provider, localIds, localReport, statusOf)
  assert.equal(diff.providerPackageCount, 4)
  assert.equal(diff.localPackageCount, 2)
  assert.equal(diff.missingInLocalCount, 2, 'P3, P4 eksik')
  assert.equal(diff.orderCountDiff, 2)
  assert.equal(Math.round(diff.grossAmountDiff), 200)
  // Guvenli ozet: yalniz status bucket sayilari (ham ID YOK).
  const buckets = Object.fromEntries(diff.missingByStatus.map((r) => [r.key, r.count]))
  assert.equal(buckets.Delivered, 1)
  assert.equal(buckets.Cancelled, 1)
  assert.equal(JSON.stringify(diff).includes('P3'), false, 'ham packageId diff\'te sizmaz')
})

// ── Canonical tanimlar acikca kodda ─────────────────────────────────────────
test('REC-5: canonical metrik tanimlari acikca belgeli (paket/kalem/urun/net)', () => {
  assert.equal(metrics.METRIC_PACKAGE, 'distinct_package_id')
  assert.equal(metrics.METRIC_LINE, 'order_line_count')
  assert.equal(metrics.METRIC_UNIT_QUANTITY, 'order_line_quantity_sum')
  // İptal/iade statüleri canonical disposition ile katlanır (UnDelivered→return,
  // UnSupplied→cancel); Dashboard ile TEK kaynak.
  assert.deepEqual([...metrics.CANCEL_STATUSES], ['Cancelled', 'UnSupplied'])
  assert.deepEqual([...metrics.RETURN_STATUSES], ['Returned', 'UnDelivered'])
  assert.match(metrics.NET_SALES_FORMULA, /gross - \(cancel_amount \+ return_amount\)/)
  // toCanonicalSummary UnDelivered'ı returnAmount'a, UnSupplied'ı cancelAmount'a yazar.
  const folded = metrics.toCanonicalSummary({
    distinctPackageIds: 4, orderLineCount: 4, lineQuantityTotal: 4, totalAmount: 400,
    byMarketplaceStatus: [
      { key: 'Delivered', count: 1, amount: 100 },
      { key: 'UnDelivered', count: 1, amount: 120 },
      { key: 'UnSupplied', count: 1, amount: 80 },
      { key: 'Cancelled', count: 1, amount: 100 },
    ],
  })
  assert.equal(Math.round(folded.returnAmount), 120, 'UnDelivered → returnAmount')
  assert.equal(Math.round(folded.cancelAmount), 180, 'Cancelled+UnSupplied → cancelAmount')
})
