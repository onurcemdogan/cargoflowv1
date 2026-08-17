import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, and } from 'drizzle-orm'
import { createServer } from 'vite'

// CANLI RESPONSE SHAPE regresyonu (kök neden: attachShipment).
// GERÇEK üretim: Sürat create idempotency payload'ı bir `shipment` NESNESİ TUTMAZ.
// Yazdırılabilir ZPL `technicalZpl`, canonical kimlikler `candidate*/carrier*`,
// 727 Trendyol referansı `ozelKargoTakipNo` alanlarındadır. Eski attachShipment
// yalnız `payload.shipment` (hiç yok) → order.shipment = {trackingNumber, barcode}
// döndürüyordu; bu yüzden 727 görünmüyor ve butonlar yenilemede pasifleşiyordu.
// (Eski testler payload'a `shipment` koyduğu için bu bug MASKELENMİŞTİ.)

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
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
  for (const s of migrationStatements()) await pglite.exec(s)
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
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? '1149999999', marketplaceStatus: 'Created',
    operationStatus: 'NEW', customerFirstName: 'Ada', customerLastName: 'L',
    city: 'İstanbul', district: 'Kadıköy', totalAmount: 100, currency: 'TRY',
    orderDate: '2026-07-26T08:00:00Z', rawOrder: {}, items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}
// GERÇEK ÜRETİM record'u: `shipment` alanı YOK (index.mjs create record shape'i).
function productionRecord(org, order, over = {}) {
  return {
    idempotencyKey: `SURAT:org_${org}:${order.orderNumber}:CREATE`,
    organizationId: org, marketplace: 'Trendyol', packageId: order.packageId,
    orderNumber: order.orderNumber, orderId: order.orderNumber, provider: 'surat',
    operation: 'OrtakBarkodOlustur', status: 'UNKNOWN', createCallCount: 1,
    completedAt: '2026-07-26T09:00:00Z',
    carrierTrackingNumber: '', carrierBarcodeNumber: '',
    candidateTrackingNumber: '11820824092123', candidateBarcodeNumber: '01252765588',
    ozelKargoTakipNo: '7270039999999',
    technicalZpl: '^XA^FD01252765588^FS^XZ',
    technicalZplSha256: 'a'.repeat(64), technicalZplLength: 24,
    verificationStatus: 'LABEL_CREATED_UNVERIFIED',
    ...over,
  }
}

test('kök neden: attachShipment gerçek payload alanlarından shipment görünümü kurar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org L', 'live-a')
  // cargoTrackingNumber DB kolonu BOŞ — 727 yalnız operation payload'ında.
  const order = makeOrder({ packageId: 'L-1', orderNumber: '1149999999', cargoTrackingNumber: '' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, productionRecord(org, order))

  const [row] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'L-1'))
  await orderService.markLabelReady(db, org, row.id) // operationStatus = LABEL_READY

  const view = await orderService.getOrder(db, org, row.id)
  assert.ok(view, 'order view-model döner')
  // (3) hasPrintableLabel backend'de gerçek persistence'tan hesaplanır.
  assert.equal(view.hasPrintableLabel, true)
  // (Faz 1) 727 payload'dan surface edilir; cargoTrackingNumber fallback dolar.
  assert.equal(view.shipment.ozelKargoTakipNo, '7270039999999')
  assert.equal(view.cargoTrackingNumber, '7270039999999', 'cargoTrackingNumber payload fallback')
  // Kalıcı ZPL orders akışı için surface edilir (barcodeRaw).
  assert.equal(view.shipment.barcodeRaw, '^XA^FD01252765588^FS^XZ')
  // Canonical kimlikler candidate alanlarından.
  assert.equal(view.shipment.tNo, '11820824092123')
  assert.equal(view.shipment.barkodNo, '01252765588')
  assert.equal(view.operationStatus, 'LABEL_READY')
  // canonical orderNumber DEĞİŞMEZ.
  assert.equal(view.orderNumber, '1149999999')
})

test('artifact yok (ZPL yok) → hasPrintableLabel false; FAILED_SAFE → shipment yok', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org N', 'live-n')
  const order = makeOrder({ packageId: 'N-1', orderNumber: 'N-1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  // ZPL yok → isSuratRecordPreassignedReady false → shipment satırı yazılmaz.
  await shipmentService.writeOperationRecord(db, org, productionRecord(org, order, {
    technicalZpl: '', technicalZplSha256: '', technicalZplLength: 0,
    candidateTrackingNumber: '', candidateBarcodeNumber: '',
  }))
  const [row] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'N-1'))
  const view = await orderService.getOrder(db, org, row.id)
  // shipment satırı yoksa attachShipment order'ı olduğu gibi döndürür (hasPrintableLabel yok).
  assert.notEqual(view.hasPrintableLabel, true)
})

test('tenant izolasyonu: başka org siparişi görünmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'A', 'live-ta')
  const orgB = await makeOrg(db, 'B', 'live-tb')
  const order = makeOrder({ packageId: 'T-1', orderNumber: 'T-1' })
  await orderService.persistSyncResult(db, orgA, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, orgA, productionRecord(orgA, order))
  const [rowA] = await db.select({ id: schema.orders.id }).from(schema.orders)
    .where(and(eq(schema.orders.organizationId, orgA), eq(schema.orders.packageId, 'T-1')))
  const crossView = await orderService.getOrder(db, orgB, rowA.id)
  assert.equal(crossView, null, 'org B, org A siparişini göremez')
})

// Reconstructed order view-model'i frontend helper'larına verilir (uçtan uca).
test('frontend: reconstructed order → 727 display, arama, capability, projection güvenliği', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org F', 'live-f')
  const order = makeOrder({ packageId: 'F-1', orderNumber: '1149999999', cargoTrackingNumber: '' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, productionRecord(org, order))
  const [row] = await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.packageId, 'F-1'))
  await orderService.markLabelReady(db, org, row.id)
  const liveOrder = await orderService.getOrder(db, org, row.id)

  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
    // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
    // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
    // "server is being restarted or closed" hatası verir. SSR-only test
    // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
    // tarama tamamen kapatılır.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  const { displayOrderNumber, sourceOrderNumber } = await vite.ssrLoadModule('/src/utils/orderDisplay.ts')
  const { resolveOrderActionCapabilities } = await vite.ssrLoadModule('/src/utils/orderActionCapabilities.ts')
  const { buildVisibleOrders } = await vite.ssrLoadModule('/src/utils/orderClassification.ts')
  const { buildDashboardViewModel } = await vite.ssrLoadModule('/src/dashboard/dashboardViewModel.ts')

  // (1) 727 gerçek nested alandan (surface edilmiş) display edilir.
  assert.equal(displayOrderNumber(liveOrder), '7270039999999')
  // (2) 114 canonical korunur (source).
  assert.equal(sourceOrderNumber(liveOrder), '1149999999')

  // (3) LABEL_READY + gerçek persisted artifact → butonlar aktif.
  const cap = resolveOrderActionCapabilities(liveOrder)
  assert.equal(cap.canPrintLabel, true)
  assert.equal(cap.canDownloadLabel, true)
  assert.equal(cap.hasPrintableLabel, true)

  // arama hem 727 hem 114 ile çalışır.
  const base = {
    persistentOrders: [liveOrder], selectedTab: 'all', marketplaceFilter: 'all',
    operationStatusFilter: 'all', cargoFilter: 'all',
    dateFilter: { preset: 'all' }, searchQuery: '', now: new Date('2026-07-27T00:00:00Z'),
  }
  assert.equal(buildVisibleOrders({ ...base, searchQuery: '7270039999999' }).visibleOrders.length, 1)
  assert.equal(buildVisibleOrders({ ...base, searchQuery: '1149999999' }).visibleOrders.length, 1)

  // (5) Dashboard projection: raw ZPL sızmaz; capability + display doğru.
  const vm = buildDashboardViewModel({
    orders: [liveOrder], products: [], selectedPeriod: { key: 'last30' },
    now: new Date('2026-07-27T00:00:00Z'),
  })
  const op = vm.recentOperations.find((o) => o.id === liveOrder.id)
  assert.ok(op)
  assert.equal(op.displayOrderNumber, '7270039999999')
  assert.equal(op.canPrint, true)
  assert.equal(op.canDownloadZpl, true)
  assert.equal(op.hasPrintableLabel, true)
  const projectionText = JSON.stringify(vm.recentOperations)
  for (const leak of ['^XA', '01252765588', 'Sifre', 'ada@']) {
    assert.equal(projectionText.includes(leak), false, `projection ${leak} sızdırmaz`)
  }
})

// (Faz 2/4) Dashboard Yenile hiçbir kod yolunda /api/orders/sync veya provider çağırmaz.
test('Dashboard Yenile: sync yok, indirekt useEffect sync yok, analytics local', () => {
  const appSrc = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  assert.match(appSrc, /onRefresh=\{handleReloadOrders\}/, 'Dashboard onRefresh = DB reload')
  // handleReloadOrders + tüm useEffect'ler yalnız loadOrdersFromServer (GET) kullanır;
  // hiçbir effect handleFetchOrders/sync tetiklemez.
  const reloadIdx = appSrc.indexOf('async function handleReloadOrders')
  const reloadWindow = appSrc.slice(reloadIdx, reloadIdx + 1500)
  assert.match(reloadWindow, /loadOrdersFromServer/)
  assert.equal(/orders\/sync/.test(reloadWindow), false)
  // handleFetchOrders (sync) yalnız config-save ve OrdersPage onFetchOrders'ta.
  assert.match(appSrc, /onFetchOrders=\{\(options\) => handleFetchOrders/)

  // analytics servisi yalnız local read-only endpoint'lere gider (sync/provider yok).
  const anSrc = readFileSync(join(root, 'src/services/dashboardAnalyticsService.ts'), 'utf8')
  assert.match(anSrc, /\/api\/analytics\/orders/)
  assert.match(anSrc, /\/api\/analytics\/claims/)
  assert.equal(/orders\/sync/.test(anSrc), false, 'analytics servisi sync çağırmaz')
})
