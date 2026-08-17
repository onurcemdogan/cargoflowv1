import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { createServer } from 'vite'

// Dashboard SATIŞ mutabakatı — GERÇEK davranış testleri. Kanıtlanan temel
// semantik fark: Dashboard satış dönemi = orderDate KOHORTU; provider
// historical fetch/backfill penceresi = marketplaceLastModifiedAt AKTİVİTESİ.
// Bu iki eksen aynı isimle karşılaştırılmamalıdır. Testler GERÇEK frontend
// buildDashboardSalesPeriodCards/buildDashboardViewModel'i (vite ssrLoadModule),
// GERÇEK yerel DB mutabakatını (pglite) ve canonical tek-kaynak tanımı doğrular.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')
const recon = await import('./analytics/orderReconciliation.ts')
const metrics = await import('./analytics/orderMetricDefinitions.ts')
const canonical = await import('../src/dashboard/dashboardSalesMetricDefinition.ts')
const backfill = await import('./orders/historicalOrderBackfill.ts')
const fetchMod = await import('./trendyol/historicalOrderFetch.ts')
const mapper = await import('./orders/orderMapper.ts')
const reportMod = await import('./analytics/dashboardReconcileReport.ts')
const projection = await import('./analytics/dashboardProjectionReconcile.ts')

// ── Ortak vite (frontend gerçek fonksiyonları) — bir kez, sonda kapanır ──────
let _vite
async function frontend() {
  if (!_vite) {
    _vite = await createServer({
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
  }
  return _vite.ssrLoadModule('/src/dashboard/dashboardViewModel.ts')
}
after(async () => {
  if (_vite) await _vite.close()
})

// ── pglite yardımcıları ──────────────────────────────────────────────────────
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
// DB persist için normalize sipariş (persistSyncResult girdisi).
function dbOrder(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`,
    marketplaceStatus: over.marketplaceStatus ?? 'Delivered',
    operationStatus: over.operationStatus ?? 'DELIVERED',
    city: 'İstanbul', totalAmount: over.totalAmount ?? 100, currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-10T08:00:00Z',
    lastModifiedDate: over.lastModifiedDate,
    rawOrder: {},
    items: over.items ?? [{ id: `l-${packageId}`, barcode: 'B1', quantity: over.qty ?? 1, price: 100, productName: 'X' }],
    ...over,
  }
}
// Frontend viewModel için sentetik CargoOrder (totalAmount/totalPrice BİLEREK
// atlanabilir → resolveOrderAmount fallback zinciri test edilir).
function frontOrder(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `FP-${seq}`
  return {
    id: over.id ?? `id-${packageId}`,
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `FON-${packageId}`,
    marketplaceStatus: over.marketplaceStatus ?? 'Delivered',
    customerName: 'Müşteri',
    orderDate: over.orderDate ?? '2026-07-10T08:00:00Z',
    items: over.items ?? [{ id: `l-${packageId}`, productName: 'X', quantity: 1, price: 100, barcode: 'B' }],
    ...over,
  }
}

const AS_OF = '2026-07-28T20:00:00Z'
const WIDE = { startMs: Date.UTC(2026, 4, 1), endMs: Date.parse(AS_OF) } // May..asOf

// Ana senaryo verisini seed eder ve gerçek kartlar + rapor + reconcile döner.
async function seedScenario(db, org, accountId) {
  await orderService.persistSyncResult(db, org, [
    // Temmuz satış kohortu
    dbOrder({ packageId: 'J1', orderDate: '2026-07-05T08:00:00Z', totalAmount: 100, marketplaceStatus: 'Delivered' }),
    dbOrder({ packageId: 'J2', orderDate: '2026-07-06T09:00:00Z', totalAmount: 200, marketplaceStatus: 'Delivered', qty: 3 }),
    dbOrder({ packageId: 'J3', orderDate: '2026-07-20T08:00:00Z', totalAmount: 50, marketplaceStatus: 'Cancelled' }),
    // asOf SONRASI (ay kartı dışı: 07-29 > 07-28)
    dbOrder({ packageId: 'J4', orderDate: '2026-07-29T08:00:00Z', totalAmount: 300, marketplaceStatus: 'Delivered' }),
    // Haziran kohortu
    dbOrder({ packageId: 'JUN1', orderDate: '2026-06-10T08:00:00Z', totalAmount: 500, marketplaceStatus: 'Delivered' }),
    dbOrder({ packageId: 'JUN2', orderDate: '2026-06-15T08:00:00Z', totalAmount: 40, marketplaceStatus: 'Returned' }),
    // ÇAPRAZ: Haziran orderDate ama Temmuz modifiedAt → kohort Haziran, aktivite Temmuz
    dbOrder({ packageId: 'X', orderDate: '2026-06-25T08:00:00Z', totalAmount: 777, marketplaceStatus: 'Delivered', lastModifiedDate: '2026-07-15T08:00:00Z' }),
  ], { complete: false, marketplaceAccountId: accountId })
}

// ═══ FAZ 1 — diagnostic + gerçek kartlar ════════════════════════════════════

test('DSR-1/8: dashboard:reconcile GERÇEK buildDashboardSalesPeriodCards kullanır; iki eksen modeli AYRI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-1')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await seedScenario(db, org, a.id)
  const { buildDashboardSalesPeriodCards } = await frontend()
  const asOf = new Date(AS_OF)
  const salesSource = await orderService.listOrdersForAnalytics(db, org, WIDE, a.id)
  const cards = buildDashboardSalesPeriodCards(salesSource, asOf)
  const monthCard = cards.find((c) => c.key === 'month')
  const lastMonthCard = cards.find((c) => c.key === 'lastMonth')

  const report = await reportMod.buildDashboardReconciliationReport({
    providerAccountId: '277221',
    marketplaceAccountId: a.id,
    asOf: asOf.toISOString(),
    salesDateBasisLabel: metrics.SALES_DATE_BASIS_LABEL,
    monthCard, lastMonthCard,
    refundDataSource: 'order_status',
    orders: salesSource,
    reconcile: (args) =>
      recon.reconcileLocalOrders(db, {
        organizationId: org, marketplaceAccountId: a.id,
        startMs: args.startMs, endMs: args.endMs, dateBasis: args.dateBasis,
      }),
  })

  // Kart GERÇEK fonksiyondan: Temmuz satış = J1+J2 (Cancelled J3 hariç, J4 asOf sonrası hariç)
  assert.equal(report.currentPeriod.salesAmount, 300, 'Temmuz satış 100+200')
  assert.equal(report.currentPeriod.packageCount, 2)
  assert.equal(report.currentPeriod.cancelCount, 1, 'J3 Cancelled')
  assert.equal(report.currentPeriod.returnCount, 0)
  assert.equal(report.currentPeriod.salesAmount, monthCard.salesAmount, 'rapor GERÇEK kart değerini taşır')
  // Haziran kartı: JUN1 + X (ikisi de Haziran orderDate, Delivered)
  assert.equal(report.comparisonPeriod.salesAmount, 1277, 'Haziran satış 500+777')
  assert.equal(report.comparisonPeriod.returnCount, 1, 'JUN2 Returned')
  assert.equal(report.salesDateBasis, 'order_date')
  assert.equal(report.salesDateBasisLabel, 'Sipariş Tarihine Göre Satış')

  // İKİ EKSEN AYRI: Temmuz penceresi
  const cur = report.currentPeriod.dateBasisModels
  assert.equal(cur.orderDateCohort.dateBasis, 'order_date')
  assert.equal(cur.orderDateCohort.packageCount, 3, 'orderDate=Temmuz: J1,J2,J3 (J4 07-29 dışı)')
  assert.equal(cur.modifiedActivity.dateBasis, 'marketplace_last_modified_at')
  assert.equal(cur.modifiedActivity.packageCount, 1, 'modifiedAt=Temmuz: yalnız X')
  assert.notEqual(cur.orderDateCohort.packageCount, cur.modifiedActivity.packageCount, 'iki eksen KARIŞMAZ')
})

test('DSR-2: --as-of sabitlendiğinde sonuç DETERMİNİSTİK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-2')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await seedScenario(db, org, a.id)
  const { buildDashboardSalesPeriodCards } = await frontend()
  const asOf = new Date(AS_OF)
  const salesSource = await orderService.listOrdersForAnalytics(db, org, WIDE, a.id)
  const build = async () => {
    const cards = buildDashboardSalesPeriodCards(salesSource, asOf)
    return reportMod.buildDashboardReconciliationReport({
      providerAccountId: '277221', marketplaceAccountId: a.id, asOf: asOf.toISOString(),
      salesDateBasisLabel: metrics.SALES_DATE_BASIS_LABEL,
      monthCard: cards.find((c) => c.key === 'month'),
      lastMonthCard: cards.find((c) => c.key === 'lastMonth'),
      refundDataSource: 'order_status',
      orders: salesSource,
      reconcile: (args) => recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, ...args }),
    })
  }
  assert.deepEqual(await build(), await build(), 'aynı as-of → aynı rapor')
})

test('DSR-3: Europe/Istanbul ay sınırı (anchor İstanbul, bucket UTC)', async () => {
  const { buildDashboardSalesPeriodCards } = await frontend()
  // 2026-06-30T22:00Z = 2026-07-01 01:00 İstanbul → İstanbul TEMMUZ der
  const julyByIst = buildDashboardSalesPeriodCards([], new Date('2026-06-30T22:00:00Z'))
    .find((c) => c.key === 'month')
  assert.equal(julyByIst.range.start.toISOString(), '2026-07-01T00:00:00.000Z', 'İstanbul anchor Temmuz')
  // 2026-06-30T20:00Z = 2026-06-30 23:00 İstanbul → hâlâ HAZİRAN
  const juneByIst = buildDashboardSalesPeriodCards([], new Date('2026-06-30T20:00:00Z'))
    .find((c) => c.key === 'month')
  assert.equal(juneByIst.range.start.toISOString(), '2026-06-01T00:00:00.000Z', 'İstanbul anchor Haziran')
})

test('DSR-4/5/6: mevcut ay + önceki ayın aynı dönemi + tam önceki ay', async () => {
  const { buildDashboardSalesPeriodCards, buildDashboardViewModel } = await frontend()
  const asOf = new Date(AS_OF)
  const cards = buildDashboardSalesPeriodCards([], asOf)
  const monthCard = cards.find((c) => c.key === 'month')
  const lastMonthCard = cards.find((c) => c.key === 'lastMonth')
  // 4: mevcut ay = [Temmuz 1, bugün sonu]
  assert.equal(monthCard.range.start.toISOString(), '2026-07-01T00:00:00.000Z')
  assert.equal(monthCard.range.end.toISOString(), '2026-07-28T23:59:59.999Z')
  // 6: tam önceki ay = [Haziran 1, Haziran 30 sonu]
  assert.equal(lastMonthCard.range.start.toISOString(), '2026-06-01T00:00:00.000Z')
  assert.equal(lastMonthCard.range.end.toISOString(), '2026-06-30T23:59:59.999Z')
  // 5: 'month' seçiminde comparison = önceki ayın AYNI gün sayısı (28 gün)
  const model = buildDashboardViewModel({ orders: [], analyticsOrders: [], selectedPeriod: { key: 'month' }, now: asOf, claimsAvailable: false })
  assert.equal(model.comparisonPeriod.start.toISOString(), '2026-06-01T00:00:00.000Z')
  const spanDays = Math.round((model.comparisonPeriod.end.getTime() + 1 - model.comparisonPeriod.start.getTime()) / 86_400_000)
  assert.equal(spanDays, 28, 'önceki ayın aynı 28 günlük dönemi')
})

test('DSR-7: orderDate ve marketplaceLastModifiedAt farklı aylardaysa KARIŞMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-7')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await seedScenario(db, org, a.id)
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-28T23:59:59.999Z') }
  const byOrder = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, ...july, dateBasis: 'order_date' })
  const byMod = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, ...july, dateBasis: 'marketplace_last_modified_at' })
  assert.equal(byOrder.distinctPackageIds, 3, 'orderDate=Temmuz: J1,J2,J3')
  assert.equal(byMod.distinctPackageIds, 1, 'modifiedAt=Temmuz: yalnız X (orderDate Haziran)')
  assert.equal(byOrder.dateBasis, 'order_date')
  assert.equal(byMod.dateBasis, 'marketplace_last_modified_at')
})

// ═══ FAZ — disposition (canonical, tek kaynak) ══════════════════════════════

test('DSR-9..12: statü → disposition (Delivered sale; Cancelled/UnSupplied cancel; Returned/UnDelivered return)', () => {
  const sale = ['Delivered', 'Created', 'Picking', 'Invoiced', 'Shipped', 'AtCollectionPoint']
  for (const s of sale) assert.equal(canonical.classifyCanonicalDisposition(s), 'sale', s)
  for (const s of ['Cancelled', 'UnSupplied']) assert.equal(canonical.classifyCanonicalDisposition(s), 'cancel', s)
  for (const s of ['Returned', 'UnDelivered']) assert.equal(canonical.classifyCanonicalDisposition(s), 'return', s)
})

test('DSR-13: çelişkili statülerde RETURN > CANCEL > SALE (deterministik) — frontend ile aynı', async () => {
  // canonical (tek kaynak)
  assert.equal(canonical.classifyCanonicalDisposition('Delivered', 'Returned'), 'return', 'return önce')
  assert.equal(canonical.classifyCanonicalDisposition('Cancelled', undefined, 'Returned'), 'return', 'return > cancel')
  assert.equal(canonical.classifyCanonicalDisposition('Delivered', 'Cancelled'), 'cancel', 'cancel > sale')
  // GERÇEK frontend salesDisposition aynı sonucu üretir (kartlarda)
  const { buildDashboardSalesPeriodCards } = await frontend()
  const now = new Date(AS_OF)
  const returnCard = buildDashboardSalesPeriodCards(
    [frontOrder({ packageId: 'C1', marketplaceStatus: 'Delivered', packageStatus: 'Returned' })], now,
  ).find((c) => c.key === 'month')
  assert.equal(returnCard.returnPackageCount, 1, 'Delivered+packageStatus=Returned → return')
  assert.equal(returnCard.packageCount, 0, 'satış sayılmaz')
})

// ═══ FAZ — paket/split/amount ═══════════════════════════════════════════════

test('DSR-14: packageId ile tekilleştirme (aynı paket iki kez → tek)', async () => {
  const { buildDashboardSalesPeriodCards } = await frontend()
  const now = new Date(AS_OF)
  const o = frontOrder({ packageId: 'DUP', totalAmount: 100 })
  const card = buildDashboardSalesPeriodCards([o, { ...o, id: 'other-id' }], now).find((c) => c.key === 'month')
  assert.equal(card.packageCount, 1, 'aynı packageId tek sayılır')
})

test('DSR-15: split package (aynı orderNumber, farklı packageId) → 2 paket, tutar çift SAYILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-15')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await orderService.persistSyncResult(db, org, [
    dbOrder({ packageId: 'SPLIT-A', orderNumber: 'ORD-SPLIT', totalAmount: 100, orderDate: '2026-07-10T08:00:00Z' }),
    dbOrder({ packageId: 'SPLIT-B', orderNumber: 'ORD-SPLIT', totalAmount: 150, orderDate: '2026-07-10T08:00:00Z' }),
  ], { complete: false, marketplaceAccountId: a.id })
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
  const rep = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, ...july })
  assert.equal(rep.distinctPackageIds, 2, 'iki paket')
  assert.equal(rep.distinctOrderNumbers, 1, 'tek sipariş no')
  assert.equal(Math.round(rep.totalAmount), 250, 'her paket kendi tutarı (100+150), çift değil')
})

test('DSR-16..19: amount source order.totalAmount → totalPrice → item price×qty; lineTotal DEĞİL', async () => {
  const { buildDashboardSalesPeriodCards } = await frontend()
  const now = new Date(AS_OF)
  const amountOf = (over) =>
    buildDashboardSalesPeriodCards([frontOrder(over)], now).find((c) => c.key === 'month').salesAmount
  // 16 + 19: totalAmount kazanır; item toplamı (75*2=150) DEĞİL
  assert.equal(amountOf({ packageId: 'AM1', totalAmount: 100, totalPrice: 999, items: [{ id: 'l1', quantity: 2, price: 75, productName: 'X' }] }), 100)
  // 17: totalAmount yoksa totalPrice
  assert.equal(amountOf({ packageId: 'AM2', totalPrice: 250, items: [{ id: 'l2', quantity: 1, price: 10, productName: 'X' }] }), 250)
  // 18: ikisi yoksa item price×quantity
  assert.equal(amountOf({ packageId: 'AM3', items: [{ id: 'l3', quantity: 2, price: 50, productName: 'X' }, { id: 'l4', quantity: 1, price: 30, productName: 'X' }] }), 130)
})

test('DSR-19b: order-seviyesi totalAmount ile satır lineTotal toplamı FARKLIDIR (line amount kaynağı değil)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-19b')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  // order.totalAmount=100 ama satır price×qty=150 (Trendyol liste fiyatı)
  await orderService.persistSyncResult(db, org, [
    dbOrder({ packageId: 'LT', totalAmount: 100, orderDate: '2026-07-10T08:00:00Z', items: [{ id: 'l', barcode: 'B', quantity: 2, price: 75, productName: 'X' }] }),
  ], { complete: false, marketplaceAccountId: a.id })
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
  const rep = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, ...july })
  const [line] = await db.select().from(schema.orderLines)
  assert.equal(Math.round(rep.totalAmount), 100, 'order.totalAmount kullanılır')
  assert.equal(Number(line.lineTotal), 150, 'lineTotal=price×qty ayrıdır; satış kaynağı DEĞİL')
})

test('DSR-20: discount mapping — normalizeHistoricalPackage discount DÜŞÜRÜR → order_lines.discountTotal null', () => {
  const raw = {
    shipmentPackageId: 'D1', orderNumber: 'OD1', status: 'Delivered', grossAmount: 100,
    orderDate: '2026-07-10T08:00:00Z',
    lines: [{ id: 'l1', barcode: 'B', quantity: 1, price: 100, discount: 15, totalDiscount: 15, productName: 'X' }],
  }
  const normalized = fetchMod.normalizeHistoricalPackage(raw)
  const item = normalized.items[0]
  assert.equal('discount' in item, false, 'normalize discount alanını taşımaz (kök neden)')
  assert.equal('discountTotal' in item, false)
  const lineValues = mapper.toLineInsertValues('org', 'oid', normalized)
  assert.equal(lineValues[0].discountTotal, null, 'discount kaynağı olmadığından discountTotal null → daima 0')
})

// ═══ FAZ — claims / mount no-provider ═══════════════════════════════════════

test('DSR-21: claims unavailable → kesin ₺0 GÖSTERİLMEZ (provider çağrılmaz)', async () => {
  const { buildDashboardViewModel } = await frontend()
  const asOf = new Date(AS_OF)
  // Yerel veri YOK → refundDataSource unavailable → iade tutarı "available:false"
  const empty = buildDashboardViewModel({ orders: [], analyticsOrders: [], selectedPeriod: { key: 'month' }, now: asOf, claimsAvailable: false })
  assert.equal(empty.salesSummary.refundDataSource, 'unavailable')
  assert.equal(empty.salesSummary.returnAmount.available, false, 'kesin ₺0 gösterilmez')
  // Satış verisi VAR ama claim tablosu yok → order_status (yine provider yok)
  const withOrders = buildDashboardViewModel({
    orders: [], analyticsOrders: [frontOrder({ packageId: 'S1', totalAmount: 100, orderDate: '2026-07-10T08:00:00Z' })],
    selectedPeriod: { key: 'month' }, now: asOf, claimsAvailable: false,
  })
  assert.equal(withOrders.salesSummary.refundDataSource, 'order_status')
})

test('DSR-22..24: /api/analytics/orders ve /claims AUTH modu provider ÇAĞIRMAZ (mount + refresh)', () => {
  const src = readFileSync(join(here, 'index.mjs'), 'utf8')
  const between = (a, b) => {
    const s = src.indexOf(a)
    assert.notEqual(s, -1, `anchor yok: ${a}`)
    const e = src.indexOf(b, s + a.length)
    assert.notEqual(e, -1, `bitiş anchor yok: ${b}`)
    return src.slice(s, e)
  }
  // Orders AUTH bloğu: yerel DB'den, provider yok, refresh yalnız cache bypass
  const ordersAuth = between("app.get('/api/analytics/orders'", '// LEGACY modu (DATABASE_URL yok): yerel DB yoktur')
  assert.match(ordersAuth, /listOrdersForAnalytics/, 'yerel DB okuması')
  assert.match(ordersAuth, /Provider API ÇAĞRILMAZ/, 'provider yok sözleşmesi')
  assert.match(ordersAuth, /bypass: refresh/, 'refresh yalnız cache bypass')
  assert.equal(/getRequestIntegrationConfig|\/integration\/order/.test(ordersAuth), false, 'AUTH dalında provider fetch YOK')
  // Claims AUTH bloğu: unavailable + boş, provider yok
  const claimsAuth = between("app.get('/api/analytics/claims'", '// LEGACY modu (DATABASE_URL yok): mevcut Trendyol getClaims')
  assert.match(claimsAuth, /source: 'unavailable'/, 'claims unavailable')
  assert.match(claimsAuth, /localClaimsUnavailable: true/)
  assert.match(claimsAuth, /claims: \[\]/, 'boş claims')
  assert.equal(/getRequestIntegrationConfig|getClaims/.test(claimsAuth), false, 'AUTH dalında provider claim fetch YOK')
})

// ═══ FAZ — izolasyon ════════════════════════════════════════════════════════

test('DSR-25: account + tenant isolation (reconcile yalnız hedef hesap/org)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org1 = await makeOrg(db, 'dsr-25-a')
  const org2 = await makeOrg(db, 'dsr-25-b')
  const a = await accounts.resolveOrCreateActiveAccount(db, org1, 'Trendyol', '277221')
  const b = await accounts.resolveOrCreateActiveAccount(db, org1, 'Trendyol', 'OTHER')
  const c = await accounts.resolveOrCreateActiveAccount(db, org2, 'Trendyol', '277221')
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
  await orderService.persistSyncResult(db, org1, [dbOrder({ packageId: 'A1', totalAmount: 100 })], { complete: false, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org1, [dbOrder({ packageId: 'B1', totalAmount: 500 })], { complete: false, marketplaceAccountId: b.id })
  await orderService.persistSyncResult(db, org2, [dbOrder({ packageId: 'C1', totalAmount: 900 })], { complete: false, marketplaceAccountId: c.id })
  const repA = await recon.reconcileLocalOrders(db, { organizationId: org1, marketplaceAccountId: a.id, ...july })
  assert.equal(repA.orderCount, 1, 'yalnız hesap A (B ve diğer tenant hariç)')
  assert.equal(Math.round(repA.totalAmount), 100)
})

// ═══ FAZ 3 — backfill date basis ════════════════════════════════════════════

test('DSR-26: historical CLI eski --start/--end ve açık --modified-* davranışı (kaynak sözleşmesi)', () => {
  const cli = readFileSync(join(here, 'orders', 'reconcileOrdersCli.ts'), 'utf8')
  assert.match(cli, /--modified-start/, 'açık isim desteklenir')
  assert.match(cli, /--modified-end/)
  assert.match(cli, /UYARI: --start\/--end bir MODIFIED aktivite penceresidir/, 'legacy isimde uyarı')
  assert.match(cli, /modifiedStart \?\? legacyStart/, 'modified-* önceliklidir')
})

test('DSR-27/28: manifest & plan dateBasis=marketplace_last_modified_at + fetchedModifiedWindow + orderDate buckets', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-27')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  // MODIFIED penceresi = Haziran; çekilen paketlerin orderDate'i Mayıs+Haziran
  // (modified penceresi ≠ sipariş ayı — kanıtlanan davranış).
  const providerOrders = [
    fetchMod.normalizeHistoricalPackage({ shipmentPackageId: 'P-MAY', orderNumber: 'OM', status: 'Delivered', grossAmount: 100, orderDate: '2026-05-20T08:00:00Z', lines: [] }),
    fetchMod.normalizeHistoricalPackage({ shipmentPackageId: 'P-JUN', orderNumber: 'OJ', status: 'Delivered', grossAmount: 200, orderDate: '2026-06-10T08:00:00Z', lines: [] }),
  ]
  const scope = { organizationId: org, marketplaceAccountId: a.id, startMs: Date.parse('2026-06-01T00:00:00Z'), endMs: Date.parse('2026-06-30T23:59:59Z') }
  const plan = await backfill.planBackfill(db, scope, providerOrders)
  assert.equal(plan.dateBasis, 'marketplace_last_modified_at')
  assert.equal(plan.fetchedModifiedWindow.start, new Date(scope.startMs).toISOString())
  const months = plan.resultingOrderDateBuckets.map((b) => b.month)
  assert.deepEqual(months, ['2026-05', '2026-06'], 'modified Haziran penceresi Mayıs+Haziran orderDate çeker')
  assert.equal(plan.resultingOrderDateMinMax.min, '2026-05-20T08:00:00.000Z')

  const token = backfill.computeConfirmationToken(scope)
  const manifest = await backfill.applyBackfill(db, { ...scope, confirmationToken: token, batchId: 'b1', appliedAt: '2026-07-29T00:00:00Z', providerComplete: true, failedWindows: 0 }, providerOrders)
  assert.equal(manifest.dateBasis, 'marketplace_last_modified_at')
  assert.equal(manifest.fetchedModifiedWindow.start, new Date(scope.startMs).toISOString())
  assert.deepEqual(manifest.resultingOrderDateBuckets.map((b) => b.month), ['2026-05', '2026-06'])
  assert.equal(manifest.after.insertedCount, 2)
})

test('DSR-29/30: backfill idempotent + LABEL_PRINTED/operationStatus KORUNUR; PARTIAL (complete=false) korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-29')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  // Mevcut LABEL_PRINTED sipariş
  await orderService.persistSyncResult(db, org, [dbOrder({ packageId: 'LBL', operationStatus: 'LABEL_PRINTED', marketplaceStatus: 'Created', orderDate: '2026-06-10T08:00:00Z' })], { complete: false, marketplaceAccountId: a.id })
  const providerOrders = [fetchMod.normalizeHistoricalPackage({ shipmentPackageId: 'LBL', orderNumber: 'ORD-LBL', status: 'Delivered', grossAmount: 100, orderDate: '2026-06-10T08:00:00Z', lines: [] })]
  const scope = { organizationId: org, marketplaceAccountId: a.id, startMs: Date.parse('2026-06-01T00:00:00Z'), endMs: Date.parse('2026-06-30T23:59:59Z') }
  const token = backfill.computeConfirmationToken(scope)
  const opts = { ...scope, confirmationToken: token, batchId: 'b', appliedAt: '2026-07-29T00:00:00Z', providerComplete: true, failedWindows: 0 }
  const m1 = await backfill.applyBackfill(db, opts, providerOrders)
  const m2 = await backfill.applyBackfill(db, { ...opts, batchId: 'b2' }, providerOrders)
  assert.equal(m1.after.insertedCount + m1.after.updatedCount, 1)
  assert.equal(m2.after.insertedCount, 0, 'idempotent: ikinci kez ekleme yok')
  const [row] = await db.select().from(schema.orders)
  assert.equal(row.operationStatus, 'LABEL_PRINTED', 'operasyonel durum EZİLMEZ')
  assert.equal(row.marketplaceStatus, 'Delivered', 'marketplace alanı güncellenir')

  // PARTIAL: bir pencere başarısız → complete=false (sessizce COMPLETE değil)
  const partial = await fetchMod.fetchHistoricalOrders(
    { sellerId: '277221', apiKey: 'k', apiSecret: 's' },
    {
      startMs: Date.parse('2026-06-01T00:00:00Z'), endMs: Date.parse('2026-06-02T00:00:00Z'),
      statuses: ['Delivered'], retryDelaysMs: [], baseUrl: 'http://x',
      fetchImpl: async () => ({ status: 500, ok: false, json: async () => ({}) }),
    },
  )
  assert.equal(partial.complete, false, 'başarısız pencere → PARTIAL')
  assert.ok(partial.failedWindows > 0)
})

// ═══ FAZ — projeksiyon mutabakatı + UnDelivered iade + invaryantlar ══════════

test('DSR-31: UnDelivered returnAmount\'a girer; UnSupplied cancelAmount\'a (canonical, tek kaynak)', () => {
  const orders = [
    frontOrder({ packageId: 'U1', marketplaceStatus: 'Delivered', totalAmount: 1000, orderDate: '2026-07-10T08:00:00Z' }),
    frontOrder({ packageId: 'U2', marketplaceStatus: 'UnDelivered', totalAmount: 120, orderDate: '2026-07-11T08:00:00Z' }),
    frontOrder({ packageId: 'U3', marketplaceStatus: 'UnSupplied', totalAmount: 80, orderDate: '2026-07-12T08:00:00Z' }),
    frontOrder({ packageId: 'U4', marketplaceStatus: 'Returned', totalAmount: 40, orderDate: '2026-07-13T08:00:00Z' }),
    frontOrder({ packageId: 'U5', marketplaceStatus: 'Cancelled', totalAmount: 60, orderDate: '2026-07-14T08:00:00Z' }),
  ]
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
  const m = projection.buildProjectionModel(orders, july, 5)
  assert.equal(m.projectedDashboardModel.returnPackageCount, 2, 'UnDelivered + Returned')
  assert.equal(Math.round(m.projectedDashboardModel.returnAmount), 160, 'UnDelivered 120 + Returned 40')
  assert.equal(m.projectedDashboardModel.cancelPackageCount, 2, 'UnSupplied + Cancelled')
  assert.equal(Math.round(m.projectedDashboardModel.cancelAmount), 140, 'UnSupplied 80 + Cancelled 60')
  assert.equal(m.projectedDashboardModel.salePackageCount, 1)
})

test('DSR-32: projeksiyon INVARYANTLARI (raw = sale+cancel+return+dropped; para 0,01; line)', () => {
  const orders = [
    frontOrder({ packageId: 'P1', marketplaceStatus: 'Delivered', totalAmount: 100, orderDate: '2026-07-10T08:00:00Z', items: [{ id: 'a', quantity: 1, price: 100, productName: 'X' }] }),
    frontOrder({ packageId: 'P1', marketplaceStatus: 'Delivered', totalAmount: 100, orderDate: '2026-07-10T08:00:00Z', items: [{ id: 'a', quantity: 1, price: 100, productName: 'X' }] }), // dup packageId
    frontOrder({ packageId: 'P2', marketplaceStatus: 'Cancelled', totalAmount: 30, orderDate: '2026-07-11T08:00:00Z', items: [{ id: 'b', quantity: 1, price: 30, productName: 'X' }, { id: 'c', quantity: 1, price: 0, productName: 'Y' }] }),
    frontOrder({ packageId: 'P3', marketplaceStatus: 'UnDelivered', totalAmount: 50, orderDate: '2026-07-12T08:00:00Z', items: [{ id: 'd', quantity: 1, price: 50, productName: 'X' }] }),
  ]
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
  const m = projection.buildProjectionModel(orders, july, 4)
  const p = m.projectedDashboardModel
  const d = m.projectionDiff
  // raw rowCount = sale + cancel + return + dropped
  assert.equal(m.rawDatabaseModel.rowCount, p.salePackageCount + p.cancelPackageCount + p.returnPackageCount + d.droppedPackageCount)
  assert.equal(d.droppedPackageCount, 1, 'P1 duplicate düşer')
  assert.equal(d.droppedBuckets.duplicate_package_id, 1)
  // para: raw = projected + dropped (0,01 tol)
  assert.ok(Math.abs(m.rawDatabaseModel.totalAmount - (p.totalAmount + d.droppedAmount)) <= 0.01)
  // line: raw = projected + dropped
  assert.equal(m.rawDatabaseModel.lineCount, p.lineCount + d.droppedLineCount)
  assert.deepEqual(d.invariants, { packageOk: true, amountOk: true, lineOk: true, loaderComplete: true })
})

test('DSR-33: dropped bucket — kimliksiz kayıt missing_identifier; loaderComplete DB satırıyla', () => {
  const orders = [
    // Aynı orderNumber, packageId YOK → dedupe missing_identifier
    frontOrder({ packageId: '', shipmentPackageId: '', orderNumber: 'SAMEORD', marketplaceStatus: 'Delivered', totalAmount: 10, orderDate: '2026-07-10T08:00:00Z' }),
    frontOrder({ id: 'x2', packageId: '', shipmentPackageId: '', orderNumber: 'SAMEORD', marketplaceStatus: 'Delivered', totalAmount: 10, orderDate: '2026-07-10T08:00:00Z' }),
  ]
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
  // databaseRowCount 3 > yüklenen 2 → loaderComplete=false, notLoadedCount=1
  const m = projection.buildProjectionModel(orders, july, 3)
  assert.equal(m.projectionDiff.droppedBuckets.missing_identifier, 1, 'kimliksiz eşleşme')
  assert.equal(m.projectionDiff.notLoadedCount, 1)
  assert.equal(m.projectionDiff.loaderComplete, false)
  assert.equal(m.projectionDiff.invariants.loaderComplete, false)
})

test('DSR-34: yükleyici pencere düzeltmesi — as-of SAAT truncation kart penceresini eksik yükler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dsr-34')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const { buildDashboardSalesPeriodCards } = await frontend()
  const asOf = new Date(AS_OF) // 2026-07-28T20:00:00Z
  // as-of gününün GEÇ saatinde (20:00Z sonrası) 2 sipariş → kart penceresinde
  // (gün sonu 23:59:59.999Z) ama as-of saatinde truncate edilirse yüklenmez.
  await orderService.persistSyncResult(db, org, [
    dbOrder({ packageId: 'DAY-EARLY', orderDate: '2026-07-28T08:00:00Z', totalAmount: 100 }),
    dbOrder({ packageId: 'LATE-1', orderDate: '2026-07-28T21:30:00Z', totalAmount: 200 }),
    dbOrder({ packageId: 'LATE-2', orderDate: '2026-07-28T22:45:00Z', totalAmount: 300 }),
  ], { complete: false, marketplaceAccountId: a.id })
  const monthRange = buildDashboardSalesPeriodCards([], asOf).find((c) => c.key === 'month').range
  // YANLIŞ (eski) yükleme: endMs = asOf saati → geç saat siparişleri kaçar
  const truncated = await orderService.listOrdersForAnalytics(db, org, { startMs: monthRange.start.getTime(), endMs: asOf.getTime() }, a.id)
  // DOĞRU (yeni) yükleme: endMs = ay kartı gün sonu → hepsi gelir
  const full = await orderService.listOrdersForAnalytics(db, org, { startMs: monthRange.start.getTime(), endMs: monthRange.end.getTime() }, a.id)
  assert.equal(truncated.length, 1, 'as-of saati truncation: yalnız erken sipariş')
  assert.equal(full.length, 3, 'gün sonu penceresi: geç saat siparişleri dahil')
  // Kart geç saat siparişleri gün sonu penceresiyle sayar (truncation ile eksik).
  const truncatedCard = buildDashboardSalesPeriodCards(truncated, asOf).find((c) => c.key === 'month')
  const fullCard = buildDashboardSalesPeriodCards(full, asOf).find((c) => c.key === 'month')
  assert.equal(truncatedCard.packageCount, 1, 'truncation: 6-paket açığının kaynağı')
  assert.equal(fullCard.packageCount, 3, 'düzeltme: tam gün yüklenir')
})
