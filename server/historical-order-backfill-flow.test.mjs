import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// Historical order backfill: TÜM statüleri tam aralıkta READ-ONLY çeker; YALNIZ
// hedef marketplaceAccountId'ye idempotent upsert; operationStatus/LABEL korunur;
// complete=false → reconcile/arşiv yok; başka account/tenant'a dokunmaz.

const here = dirname(fileURLToPath(import.meta.url))
const host = '127.0.0.1'
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const fetchMod = await import('./trendyol/historicalOrderFetch.ts')
const backfill = await import('./orders/historicalOrderBackfill.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(...readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean))
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
function listen(server) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)))
}
const RANGE = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
const scopeOf = (org, accountId) => ({ organizationId: org, marketplaceAccountId: accountId, ...RANGE })

// Sahte Trendyol: her statü icin 1 paket dondurur (Delivered 2 sayfa).
function makeMock() {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (!url.pathname.endsWith('/orders')) {
      response.writeHead(404); response.end('{}'); return
    }
    const status = url.searchParams.get('status')
    const page = Number(url.searchParams.get('page') ?? 0)
    const pkg = (id, st) => ({
      shipmentPackageId: `${st}-${id}`, orderNumber: `ORD-${st}-${id}`, status: st,
      orderDate: Date.parse('2026-07-10T08:00:00Z'), grossAmount: 100,
      customerFirstName: 'Ada', shipmentAddress: { city: 'İstanbul', district: 'Kadıköy', phone: '5550000000' },
      lines: [{ id: `L-${st}-${id}`, barcode: `B-${id}`, merchantSku: `S-${id}`, productName: 'Ürün', quantity: 2, price: 50 }],
    })
    // Delivered: 2 sayfa (pagination testi). Digerleri: 1 paket.
    let content = []
    let totalPages = 1
    if (status === 'Delivered') { totalPages = 2; content = page < 2 ? [pkg(page, 'Delivered')] : [] }
    else if (page === 0) { content = [pkg(0, status)] }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ content, page, size: 200, totalPages, totalElements: content.length }))
  })
}

// ── 1: fetch tum statuleri + pagination + normalize ─────────────────────────
test('HOB-1: fetchHistoricalOrders tum statuleri + pagination ceker, normalize eder', async (t) => {
  const server = makeMock()
  const port = await listen(server)
  t.after(() => server.close())
  const res = await fetchMod.fetchHistoricalOrders(
    { sellerId: '2777221', apiKey: 'k', apiSecret: 's', environment: 'prod' },
    { startMs: RANGE.startMs, endMs: RANGE.endMs, baseUrl: `http://${host}:${port}`, retryDelaysMs: [1], windowMs: 40 * 24 * 60 * 60 * 1000 },
  )
  // 10 statu × 1 paket, Delivered 2 sayfa (2 paket) → 11 paket.
  assert.equal(res.complete, true)
  assert.equal(res.failedWindows, 0)
  assert.equal(res.fetchedPackageCount, 11, '10 statu + Delivered 2. sayfa')
  const sample = res.orders.find((o) => o.marketplaceStatus === 'Cancelled')
  assert.ok(sample, 'Cancelled paketi cekildi')
  assert.equal(sample.marketplace, 'Trendyol')
  assert.equal(Number(sample.totalAmount), 100)
  assert.equal(sample.items.length, 1)
  assert.equal(sample.items[0].quantity, 2)
  assert.match(String(sample.orderDate), /2026-07-10/, 'orderDate ISO')
})

// ── 2: PARTIAL — bir statu penceresi basarisiz → complete=false ─────────────
test('HOB-2: pencere basarisiz olursa complete=false + failedWindows>0 (sessizce COMPLETE degil)', async (t) => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    const status = url.searchParams.get('status')
    if (status === 'Returned') { response.writeHead(500); response.end('{}'); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ content: [], page: 0, totalPages: 1 }))
  })
  const port = await listen(server)
  t.after(() => server.close())
  const res = await fetchMod.fetchHistoricalOrders(
    { sellerId: '2777221', apiKey: 'k', apiSecret: 's' },
    { startMs: RANGE.startMs, endMs: RANGE.endMs, baseUrl: `http://${host}:${port}`, retryDelaysMs: [1, 1], windowMs: 40 * 24 * 60 * 60 * 1000 },
  )
  assert.equal(res.complete, false)
  assert.ok(res.failedWindows >= 1, 'Returned penceresi basarisiz')
})

// ── 3: dry-run plan (provider vs local, missing, token, willModify:false) ───
test('HOB-3: planBackfill dry-run DB degistirmez; provider vs local farki', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'hob-3')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  // Local'de 1 paket zaten var.
  await orderService.persistSyncResult(db, org, [{ marketplace: 'Trendyol', packageId: 'Delivered-0', orderNumber: 'X', marketplaceStatus: 'Delivered', orderDate: '2026-07-10T08:00:00Z', totalAmount: 100, items: [] }], { complete: false, marketplaceAccountId: a.id })
  const provider = [
    { packageId: 'Delivered-0', marketplaceStatus: 'Delivered' },
    { packageId: 'Delivered-1', marketplaceStatus: 'Delivered' },
    { packageId: 'Cancelled-0', marketplaceStatus: 'Cancelled' },
  ]
  const plan = await backfill.planBackfill(db, scopeOf(org, a.id), provider)
  assert.equal(plan.willModify, false)
  assert.equal(plan.providerPackageCount, 3)
  assert.equal(plan.localPackageCount, 1, 'Delivered-0 zaten var')
  assert.equal(plan.missingCount, 2, 'Delivered-1, Cancelled-0 eksik')
  assert.ok(plan.confirmationToken)
})

// ── 4: apply idempotent + operationStatus/LABEL korunur ─────────────────────
test('HOB-4: apply idempotent; LABEL_PRINTED/operationStatus EZILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'hob-4')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  // Var olan sipariş LABEL_PRINTED.
  await orderService.persistSyncResult(db, org, [{ marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'ORD-P1', marketplaceStatus: 'Invoiced', operationStatus: 'LABEL_PRINTED', orderDate: '2026-07-10T08:00:00Z', totalAmount: 100, items: [{ id: 'l1', quantity: 1, price: 100 }] }], { complete: false, marketplaceAccountId: a.id })
  const provider = [
    { packageId: 'P1', orderNumber: 'ORD-P1', marketplaceStatus: 'Delivered', orderDate: '2026-07-10T08:00:00Z', totalAmount: 100, items: [{ id: 'l1', quantity: 1, price: 100 }] },
    { packageId: 'P2', orderNumber: 'ORD-P2', marketplaceStatus: 'Delivered', orderDate: '2026-07-11T08:00:00Z', totalAmount: 200, items: [{ id: 'l2', quantity: 1, price: 200 }] },
  ]
  const opts = (scope) => ({ ...scope, confirmationToken: backfill.computeConfirmationToken(scope), batchId: randomUUID(), appliedAt: new Date().toISOString(), providerComplete: true, failedWindows: 0 })
  const m1 = await backfill.applyBackfill(db, opts(scopeOf(org, a.id)), provider)
  assert.equal(m1.after.insertedCount, 1, 'yalniz P2 yeni')
  assert.equal(m1.after.updatedCount, 1, 'P1 guncellendi')
  // P1 marketplace status Delivered'a guncellendi AMA operationStatus LABEL_PRINTED korunur.
  const [p1] = await db.select().from(schema.orders).where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'P1')))
  assert.equal(p1.operationStatus, 'LABEL_PRINTED', 'operationStatus EZILMEZ')
  assert.equal(p1.marketplaceStatus, 'Delivered', 'marketplaceStatus guncellenir')
  // Ikinci apply → 0 yeni (idempotent).
  const m2 = await backfill.applyBackfill(db, opts(scopeOf(org, a.id)), provider)
  assert.equal(m2.after.insertedCount, 0, 'idempotent: yeni yok')
})

// ── 5: yalniz hedef account; baska account/tenant dokunulmaz ────────────────
test('HOB-5: apply yalniz hedef marketplaceAccountId; baska account/tenant korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'hob-5')
  const orgB = await makeOrg(db, 'hob-5b')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  const other = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'OTHER')
  const bAcc = await accounts.resolveOrCreateActiveAccount(db, orgB, 'Trendyol', '2777221')
  await orderService.persistSyncResult(db, org, [{ marketplace: 'Trendyol', packageId: 'OTH', orderNumber: 'O', marketplaceStatus: 'Delivered', orderDate: '2026-07-10T08:00:00Z', totalAmount: 5, items: [] }], { complete: false, marketplaceAccountId: other.id })
  await orderService.persistSyncResult(db, orgB, [{ marketplace: 'Trendyol', packageId: 'BORD', orderNumber: 'B', marketplaceStatus: 'Delivered', orderDate: '2026-07-10T08:00:00Z', totalAmount: 5, items: [] }], { complete: false, marketplaceAccountId: bAcc.id })
  const scope = scopeOf(org, a.id)
  await backfill.applyBackfill(db, { ...scope, confirmationToken: backfill.computeConfirmationToken(scope), batchId: randomUUID(), appliedAt: new Date().toISOString(), providerComplete: true, failedWindows: 0 }, [
    { packageId: 'NEW', orderNumber: 'N', marketplaceStatus: 'Delivered', orderDate: '2026-07-12T08:00:00Z', totalAmount: 100, items: [] },
  ])
  // other account + orgB dokunulmadi; NEW yalniz a.id'ye yazildi.
  const [newRow] = await db.select().from(schema.orders).where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'NEW')))
  assert.equal(newRow.marketplaceAccountId, a.id)
  const listOther = await orderService.listOrders(db, org, {}, other.id)
  assert.deepEqual(listOther.orders.map((o) => o.packageId), ['OTH'])
  const listB = await orderService.listOrders(db, orgB, {}, bAcc.id)
  assert.deepEqual(listB.orders.map((o) => o.packageId), ['BORD'])
})

// ── 6: yanlis token reddedilir ──────────────────────────────────────────────
test('HOB-6: yanlis onay token\'i apply\'i reddeder', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'hob-6')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  const scope = scopeOf(org, a.id)
  await assert.rejects(
    () => backfill.applyBackfill(db, { ...scope, confirmationToken: 'WRONG', batchId: randomUUID(), appliedAt: new Date().toISOString(), providerComplete: true, failedWindows: 0 }, []),
    /Onay token/,
  )
})

// ── 7: orderDate ile filtre; backfill sonrasi analitik bu hesabi gorur ──────
test('HOB-7: backfill sonrasi listOrdersForAnalytics eksik siparisleri gorur (Delivered dahil)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'hob-7')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '2777221')
  const before = await orderService.listOrdersForAnalytics(db, org, RANGE, a.id)
  assert.equal(before.length, 0)
  const scope = scopeOf(org, a.id)
  await backfill.applyBackfill(db, { ...scope, confirmationToken: backfill.computeConfirmationToken(scope), batchId: randomUUID(), appliedAt: new Date().toISOString(), providerComplete: true, failedWindows: 0 }, [
    { packageId: 'D1', orderNumber: 'D1', marketplaceStatus: 'Delivered', orderDate: '2026-07-10T08:00:00Z', totalAmount: 300, items: [{ id: 'x', quantity: 1, price: 300 }] },
  ])
  const after = await orderService.listOrdersForAnalytics(db, org, RANGE, a.id)
  assert.equal(after.length, 1, 'Delivered siparis artik yerel analitikte gorunur')
  assert.equal(String(after[0].marketplaceStatus), 'Delivered')
})

// ── 8: Dashboard hala local-only (provider fetch geri eklenmedi) ────────────
test('HOB-8: Dashboard analitigi hala provider CAGIRMAZ (backfill ayri CLI)', () => {
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Analytics auth branch listOrdersForAnalytics kullanir (local).
  assert.match(server, /listOrdersForAnalytics/)
  const cli = readFileSync(join(here, 'orders/reconcileOrdersCli.ts'), 'utf8')
  // Backfill CLI provider'dan ceker (Dashboard route DEGIL).
  assert.match(cli, /fetchHistoricalOrders/)
})
