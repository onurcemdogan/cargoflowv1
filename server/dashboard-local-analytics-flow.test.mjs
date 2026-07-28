import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// Dashboard SATIŞ analitiği (auth modu) YALNIZ yerel PostgreSQL'den, aktif
// pazaryeri hesabı kapsamında hesaplanır. Provider (Trendyol) API ÇAĞRILMAZ,
// /api/orders/sync tetiklenmez. refresh=true yalnız account-scoped cache'i
// bypass edip yerel DB'den yeniden hesaplar. Legacy modu (DB yok) mevcut
// Trendyol-fetch yolunu korur.

const here = dirname(fileURLToPath(import.meta.url))
function readSrc(rel) {
  return readFileSync(join(here, '..', rel), 'utf8')
}
function sliceBlock(src, anchor, length = 2400) {
  const idx = src.indexOf(anchor)
  assert.notEqual(idx, -1, `beklenen kod bulunamadı: ${anchor}`)
  return src.slice(idx, idx + length)
}

const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
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
    city: over.city ?? 'İstanbul', totalAmount: over.totalAmount ?? 100, currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-10T08:00:00Z', rawOrder: { secret: 'RAW' },
    customerFirstName: 'Ada', customerPhone: '5550000000',
    items: [{ id: `l-${packageId}`, barcode: 'B1', quantity: 1, price: 100, productName: 'X' }],
    ...over,
  }
}
const RANGE = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }

// ── 1: listOrdersForAnalytics account-scoped + date-range + cap'siz ─────────
test('DLA-1: listOrdersForAnalytics aktif hesap + tarih araligi (cap yok, provider yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dla-1')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-B')
  // A: 3 aralik-ici + 1 aralik-disi. B: 2 (gorunmemeli).
  await orderService.persistSyncResult(db, org, [
    order({ packageId: 'A1', orderDate: '2026-07-05T08:00:00Z' }),
    order({ packageId: 'A2', orderDate: '2026-07-20T08:00:00Z' }),
    order({ packageId: 'A3', orderDate: '2026-07-28T08:00:00Z' }),
    order({ packageId: 'A-OLD', orderDate: '2026-06-01T08:00:00Z' }),
  ], { complete: false, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org, [
    order({ packageId: 'B1', orderDate: '2026-07-10T08:00:00Z' }),
    order({ packageId: 'B2', orderDate: '2026-07-11T08:00:00Z' }),
  ], { complete: false, marketplaceAccountId: b.id })

  const forA = await orderService.listOrdersForAnalytics(db, org, RANGE, a.id)
  assert.deepEqual(forA.map((o) => o.packageId).sort(), ['A1', 'A2', 'A3'], 'yalniz A, aralik-ici')
  const forB = await orderService.listOrdersForAnalytics(db, org, RANGE, b.id)
  assert.deepEqual(forB.map((o) => o.packageId).sort(), ['B1', 'B2'], 'yalniz B (hesaplar karismaz)')
  // View-model alanlari mevcut (client viewModel bunlari okur).
  assert.ok(forA[0].orderDate)
  assert.equal(String(forA[0].marketplace), 'Trendyol')
  assert.ok(Array.isArray(forA[0].items))
})

// ── 2: iptal/iade statuleri dahil (client statuye gore siniflandirir) ───────
test('DLA-2: Cancelled/Returned siparisler analitige dahil (yerel statuden turetilir)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dla-2')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  await orderService.persistSyncResult(db, org, [
    order({ packageId: 'OK', marketplaceStatus: 'Delivered' }),
    order({ packageId: 'CANCEL', marketplaceStatus: 'Cancelled' }),
    order({ packageId: 'RETURN', marketplaceStatus: 'Returned' }),
  ], { complete: false, marketplaceAccountId: a.id })
  const rows = await orderService.listOrdersForAnalytics(db, org, RANGE, a.id)
  const byStatus = Object.fromEntries(rows.map((o) => [o.packageId, o.marketplaceStatus]))
  assert.equal(byStatus.CANCEL, 'Cancelled')
  assert.equal(byStatus.RETURN, 'Returned')
  assert.equal(rows.length, 3, 'iptal/iade dahil tum siparisler')
})

// ── 3: endpoint auth branch — yerel DB, provider YOK, cache account-scoped ──
test('DLA-3: /api/analytics/orders auth branch yerel DB kullanir; provider CAGRILMAZ', () => {
  const server = readSrc('server/index.mjs')
  const block = sliceBlock(server, 'satış analitiği YALNIZ yerel PostgreSQL', 2600)
  // Aktif hesap cozulur + yerel DB analitik cagrilir.
  assert.match(block, /resolveActiveMarketplaceAccountId/)
  assert.match(block, /listOrdersForAnalytics/)
  // Auth branch icinde Trendyol provider cagrisi YOK.
  assert.doesNotMatch(block, /callTrendyolOrdersAllPages|callTrendyolOrders\(/)
  // Cache anahtari hesap kapsamli (farkli hesap ayni cache'i paylasmaz).
  assert.match(block, /marketplaceAccountId: marketplaceAccountId \?\? 'none'/)
  // refresh=true yalniz cache bypass (yine provider yok).
  assert.match(block, /bypass: refresh/)
})

// ── 4: legacy modu Trendyol-fetch yolunu korur (dev/tek-tenant) ─────────────
test('DLA-4: legacy modu Trendyol-fetch yolu KORUNUR (auth branch disi)', () => {
  const server = readSrc('server/index.mjs')
  // Legacy dalinda hala provider fetch var (analytics-source-flow bu yolu test eder).
  assert.match(server, /LEGACY modu \(DATABASE_URL yok\)/)
  const legacy = sliceBlock(server, 'LEGACY modu (DATABASE_URL yok): yerel DB', 2600)
  assert.match(legacy, /callTrendyolOrdersAllPages/)
})

// ── 5: claims auth branch — provider YOK, guvenli bos sonuc ─────────────────
test('DLA-5: /api/analytics/claims auth branch provider CAGIRMAZ (bos, local-order-status)', () => {
  const server = readSrc('server/index.mjs')
  const block = sliceBlock(server, 'localClaimsUnavailable: true', 400)
  assert.match(block, /localClaimsUnavailable: true/)
  assert.match(block, /amountBasis: 'local-order-status'/)
  assert.doesNotMatch(block, /fetchTrendyolClaimsWindow/)
})

// ── 6: COMPLETE sync sonrasi tenant analytics cache invalidate edilir ───────
test('DLA-6: COMPLETE order sync sonrasi analytics cache invalidate edilir', () => {
  const server = readSrc('server/index.mjs')
  // Sync endpoint'i basari sonrasi tenant analitik cache'ini dusurur.
  assert.match(server, /invalidateTenantAnalyticsCache\(context\.organizationId\)/)
})

// ── 7: urun katalogu SINIRLI eszamanlilikla (bounded) cekilir; sinirsiz degil ─
test('DLA-7: loadProductsFromServer bounded paralel (60 seri istek KALDIRILDI)', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  const block = sliceBlock(svc, 'async loadProductsFromServer()', 1400)
  // Bounded eszamanlilik: CONCURRENCY + batch Promise.all.
  assert.match(block, /const CONCURRENCY = 4/)
  assert.match(block, /Promise\.all\(/)
  // Ilk sayfayla toplam ogrenilir; kalan sayfalar batch'ler halinde.
  assert.match(block, /const first = await this\.fetchProductsPage\(1, pageSize\)/)
  assert.match(block, /totalPages/)
  // Sinirsiz paralel DEGIL: MAX_PAGES guvenlik siniri + bounded batch.
  assert.match(block, /MAX_PAGES/)
})

// ── 8: yeni hesap yerel veri yoksa guvenli empty-state + otomatik sync YOK ──
test('DLA-8: yeni hesap yerel veri yoksa empty-state gosterir (mount otomatik sync yok)', () => {
  const page = readSrc('src/pages/DashboardPage.tsx')
  assert.match(page, /Bu hesap için henüz yerel veri bulunmuyor/)
  assert.match(page, /analyticsOrders && analyticsOrders\.length === 0 && orders\.length === 0/)
  // Dashboard mount provider sync tetiklemez (yalniz local analytics effect'leri).
  assert.doesNotMatch(page, /\/api\/orders\/sync/)
})
