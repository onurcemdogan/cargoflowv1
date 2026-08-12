import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// YÜKSEK HACİM PERFORMANS DENETİMİ — BULGULARI KİLİTLEYEN TESTLER.
//
// Bu paket OPTİMİZASYON YAPMAZ. Ölçülen darboğazların GERÇEK olduğunu ve
// hangi kod yolundan geldiğini kanıtlar; ileride biri "N+1 yok" ya da
// "sayfalama sunucu tarafında" derse test DÜŞER.
//
// Ölçüm araçlarının SALT OKUNUR olduğu da burada kilitlenir.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const schema = await import('./db/schema.ts')
const bench = await import('./perf/orderReadBenchmark.ts')

const nl = (value) => value.split('\r\n').join('\n')
const REPOSITORY_SOURCE = nl(readFileSync('server/orders/orderRepository.ts', 'utf8'))
const SERVICE_SOURCE = nl(
  readFileSync('server/orders/orderPersistenceService.ts', 'utf8'),
)
const SCHEMA_SOURCE = nl(readFileSync('server/db/schema.ts', 'utf8'))
const WORKFLOW_SOURCE = nl(
  readFileSync('src/services/orderWorkflowService.ts', 'utf8'),
)
const ORDERS_PAGE_SOURCE = nl(readFileSync('src/pages/OrdersPage.tsx', 'utf8'))
const APP_SOURCE = nl(readFileSync('src/App.tsx', 'utf8'))
const DASHBOARD_SOURCE = nl(readFileSync('src/pages/DashboardPage.tsx', 'utf8'))
const BENCH_CLI_SOURCE = nl(
  readFileSync('server/perf/ordersPerfBenchmarkCli.ts', 'utf8'),
)
const EXPLAIN_CLI_SOURCE = nl(
  readFileSync('server/perf/explainProductionReadsCli.ts', 'utf8'),
)

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function makeSeededDb(count) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const { client, counter } = bench.withQueryCounter(pglite)
  const db = drizzle(client, { schema })
  const rawDb = drizzle(pglite, { schema })
  const orgResult = await rawDb.execute(
    sql.raw(
      `insert into organizations (name, slug) values ('Perf','perf-${count}-${randomBytes(3).toString('hex')}') returning id`,
    ),
  )
  const organizationId = String(
    (Array.isArray(orgResult) ? orgResult[0] : orgResult.rows?.[0]).id,
  )
  const accountResult = await rawDb.execute(
    sql.raw(
      `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
       values ('${organizationId}','Trendyol','277221',true) returning id`,
    ),
  )
  const marketplaceAccountId = String(
    (Array.isArray(accountResult) ? accountResult[0] : accountResult.rows?.[0]).id,
  )
  await bench.seedOrders(rawDb, {
    organizationId,
    marketplaceAccountId,
    count,
    shipmentRatio: 1,
    operationsPerPackage: 2,
  })
  return { pglite, db, rawDb, counter, organizationId, marketplaceAccountId }
}

// ═══ N+1 (ÇALIŞMA ZAMANI KANITI) ══════════════════════════════════════════

test('PERF-N1-1: listOrders sipariş BASINA ek sorgu calistirir', async () => {
  const ctx = await makeSeededDb(60)
  const small = await bench.measureOrdersPage(
    ctx.db,
    ctx.counter,
    ctx.organizationId,
    ctx.marketplaceAccountId,
    { page: 1, pageSize: 10 },
  )
  const large = await bench.measureOrdersPage(
    ctx.db,
    ctx.counter,
    ctx.organizationId,
    ctx.marketplaceAccountId,
    { page: 1, pageSize: 50 },
  )
  // Sabit sorgu sayisi OLSAYDI ikisi ESIT olurdu. Degil: sayfa buyudukce
  // sorgu sayisi de buyuyor → N+1.
  assert.ok(
    large.queryCount > small.queryCount,
    `N+1 yok gibi gorunuyor: ${small.queryCount} vs ${large.queryCount}`,
  )
  // Tum siparislerde gonderi VAR (shipmentRatio 1) → sipariş basina 2 ek
  // sorgu: findShipment + findLatestOperationByPackage.
  const perOrder =
    (large.queryCount - small.queryCount) / (large.rowCount - small.rowCount)
  assert.equal(perOrder, 2, `sipariş basina ek sorgu: ${perOrder}`)
  await ctx.pglite.close()
})

test('PERF-N1-2: N+1 kaynagi attachShipment DONGUSUDUR', () => {
  // Toplu (batch) yukleme YOK: dongu icinde await.
  assert.ok(SERVICE_SOURCE.includes('for (const row of orderRows) {'))
  assert.ok(SERVICE_SOURCE.includes('await attachShipment(db, organizationId, base)'))
  assert.ok(SERVICE_SOURCE.includes('const shipment = await findShipment('))
  assert.ok(
    SERVICE_SOURCE.includes('await findLatestOperationByPackage(db, organizationId, packageId)'),
  )
  // order_lines ise TOPLU yuklenir (inArray) — bu yol N+1 DEGIL.
  assert.ok(REPOSITORY_SOURCE.includes('inArray(orderLines.orderId, orderIds)'))
})

// ═══ SAYFA BASINA COUNT(*) ════════════════════════════════════════════════

test('PERF-COUNT-1: her sayfa isteginde COUNT(*) yeniden calisir', () => {
  assert.ok(REPOSITORY_SOURCE.includes('const totalRows = await db'))
  assert.ok(REPOSITORY_SOURCE.includes('count(*)::int'))
  // Kesme (keyset) sayfalama DEGIL: OFFSET kullaniliyor.
  assert.ok(REPOSITORY_SOURCE.includes('.offset((page - 1) * pageSize)'))
  assert.equal(REPOSITORY_SOURCE.includes('cursor'), false)
})

// ═══ ARŞİV FİLTRESİ ═══════════════════════════════════════════════════════

test('PERF-ARCHIVE-1: liste sorgusu ARSIVLI kayitlari DISLAMIYOR', async () => {
  const ctx = await makeSeededDb(20)
  await ctx.rawDb.execute(
    sql.raw(
      `update orders set archived_at = now() where organization_id = '${ctx.organizationId}'`,
    ),
  )
  const { listOrders } = await import('./orders/orderPersistenceService.ts')
  const result = await listOrders(
    ctx.db,
    ctx.organizationId,
    { page: 1, pageSize: 25 },
    ctx.marketplaceAccountId,
  )
  // TUMU arsivli olmasina ragmen liste hepsini donuyor.
  assert.equal(result.total, 20)
  // Kaynak sozlesmesi: buildWhere'de archived kosulu YOK.
  const buildWhere = REPOSITORY_SOURCE.slice(
    REPOSITORY_SOURCE.indexOf('function buildWhere('),
    REPOSITORY_SOURCE.indexOf('export async function findOrders('),
  )
  assert.equal(buildWhere.includes('archivedAt'), false)
  await ctx.pglite.close()
})

// ═══ SERT SINIR: inArray BIND PARAMETRE TAVANI ════════════════════════════

test('PERF-LIMIT-1: findLinesForOrders TEK sorguda tum id leri gonderir', async () => {
  const ctx = await makeSeededDb(5)
  // 65.535 PostgreSQL genisletilmis protokol tavanidir. Testin hizli kalmasi
  // icin tavanin HEMEN ALTI ve USTU denenir.
  const probe = await bench.probeInArrayLimit(ctx.db, ctx.organizationId, [
    65_000,
    70_000,
  ])
  assert.equal(probe[0].ok, true, '65.000 id gecmeli')
  assert.equal(probe[1].ok, false, '70.000 id bind tavanini asmali')
  // Dashboard analitigi bu yolu CAP SIZ kullanir.
  assert.ok(SERVICE_SOURCE.includes('export async function listOrdersForAnalytics'))
  assert.ok(
    SERVICE_SOURCE.includes('const lineRows = await findLinesForOrders(db, organizationId, orderIds)'),
  )
  await ctx.pglite.close()
})

// ═══ INDEX KAPSAMI ════════════════════════════════════════════════════════

test('PERF-INDEX-1: liste sorgusunun siralamasini KAPSAYAN index YOK', () => {
  // Sorgu: where (org, account) order by order_date desc, id desc.
  // Mevcut index'ler bu kombinasyonu KAPSAMIYOR → filtre + ayri SORT gerekir.
  assert.ok(SCHEMA_SOURCE.includes("index('orders_org_account_idx')"))
  assert.ok(SCHEMA_SOURCE.includes("index('orders_org_order_date_idx')"))
  const hasCovering =
    /orders_org_account_order_date|organizationId,\s*table\.marketplaceAccountId,\s*table\.orderDate/.test(
      SCHEMA_SOURCE,
    )
  assert.equal(
    hasCovering,
    false,
    'kapsayan index EKLENMIS: bu denetimin bulgusu guncellenmeli',
  )
})

test('PERF-INDEX-2: sirali sayfa sorgusu SIRALAMA adimi gerektirir', async () => {
  const ctx = await makeSeededDb(400)
  const plan = await bench.explain(
    ctx.rawDb,
    `select * from orders where organization_id = '${ctx.organizationId}' ` +
      `and marketplace_account_id = '${ctx.marketplaceAccountId}' ` +
      `order by order_date desc, id desc limit 100 offset 300`,
  )
  const joined = plan.join('\n')
  // Kapsayan index olsaydi plan Sort ICERMEZDI.
  assert.ok(joined.includes('Sort'), joined.slice(0, 300))
  await ctx.pglite.close()
})

// ═══ SAYFALAMA TİPİ ═══════════════════════════════════════════════════════

test('PERF-PAGE-1: frontend TUM sayfalari indirir (client-side sayfalama)', () => {
  // Backend server-side sayfalama SUNAR...
  assert.ok(REPOSITORY_SOURCE.includes('const pageSize = resolvePageSize(filters.pageSize)'))
  // ...fakat istemci hepsini dolasip birlestirir.
  assert.ok(WORKFLOW_SOURCE.includes('const ORDERS_LOAD_PAGE_SIZE = 100'))
  assert.ok(WORKFLOW_SOURCE.includes('const MAX_ORDER_PAGES = 200'))
  assert.ok(WORKFLOW_SOURCE.includes('for (let start = 2; start <= totalPages;'))
  assert.ok(WORKFLOW_SOURCE.includes('const collectedRows = collected.flat()'))
  // SERT TAVAN: 200 sayfa x 100 = 20.000 siparis. Asilirsa ACIK hata.
  assert.ok(WORKFLOW_SOURCE.includes('sayfa sayisi guvenlik sinirini asti'))
})

test('PERF-PAGE-2: OrdersPage sayfalamayi ISTEMCIDE yapar', () => {
  assert.ok(ORDERS_PAGE_SOURCE.includes('paginateOrders(displayOrders, currentPage, pageSize)'))
  // Sayfa/filtre degisimi sunucuya YENI istek ATMAZ (yalniz yerel memo).
  assert.equal(ORDERS_PAGE_SOURCE.includes('loadOrdersFromServer'), false)
})

test('PERF-PAGE-3: sekme sayaclari TUM listeyi sekme basina yeniden tarar', () => {
  const start = ORDERS_PAGE_SOURCE.indexOf('const tabCounts = useMemo(')
  assert.ok(start > 0)
  const block = ORDERS_PAGE_SOURCE.slice(start, start + 1600)
  assert.ok(block.includes('quickTabs.map('))
  assert.ok(block.includes('buildVisibleOrders({'))
  // 6 hizli sekme + gorunur liste = tam tarama sayisi.
  const tabsBlock = ORDERS_PAGE_SOURCE.slice(
    ORDERS_PAGE_SOURCE.indexOf('const quickTabs'),
    ORDERS_PAGE_SOURCE.indexOf('const operationTabOptions'),
  )
  assert.equal((tabsBlock.match(/key: '/g) ?? []).length, 6)
})

// ═══ GEZİNME / YENİDEN YÜKLEME ════════════════════════════════════════════

test('PERF-NAV-1: sayfa gecisi bilesenleri SOKER ve tam yeniden yukleme tetikler', () => {
  // Kosullu render → unmount: tum yerel state (filtre, sayfa, memo) SIFIRLANIR.
  assert.ok(APP_SOURCE.includes("{effectivePage === 'dashboard' ? ("))
  assert.ok(APP_SOURCE.includes("{activePage === 'orders' ? ("))
  // Siparisler'e her gecis TUM listeyi yeniden indirir.
  assert.ok(APP_SOURCE.includes("if (page === 'orders') {"))
  assert.ok(APP_SOURCE.includes('void handleReloadOrders()'))
  // Dashboard kartindan gecis AYRICA remount zorlar (key degisir).
  assert.ok(APP_SOURCE.includes('key={ordersNavigationRequest?.id ?? '))
  // SWR cache TAZE olsa bile arkada TAM yeniden indirme yapilir.
  assert.ok(WORKFLOW_SOURCE.includes('private static readonly ORDERS_CACHE_TTL_MS = 30_000'))
})

// ═══ DASHBOARD AGGREGATE ══════════════════════════════════════════════════

test('PERF-DASH-1: analitik ucu TAM siparis nesnelerini doner (aggregate DEGIL)', () => {
  const ENTRY = nl(readFileSync('server/index.mjs', 'utf8'))
  const block = ENTRY.slice(
    ENTRY.indexOf("app.get('/api/analytics/orders'"),
    ENTRY.indexOf("app.get('/api/analytics/claims'"),
  )
  assert.ok(block.includes('listOrdersForAnalytics('))
  assert.ok(block.includes('orders: sanitizeAnalyticsOrders(localOrders)'))
  // Sunucu tarafinda SUM/GROUP BY YOK: tum satirlar tele verilir.
  assert.equal(block.includes('group by'), false)
  assert.equal(block.includes('sum('), false)
})

test('PERF-DASH-2: dashboard acilista GENIS aralik ister ve kartlari bekletir', () => {
  // Tek istek TUM kartlarin birlesik araligini kapsar (gecen ay basi → bugun).
  assert.ok(DASHBOARD_SOURCE.includes('const analyticsRangeKey = useMemo(()'))
  assert.ok(DASHBOARD_SOURCE.includes('...viewModel.salesPeriodCards.map((card) => card.range)'))
  assert.ok(DASHBOARD_SOURCE.includes('Math.min(...ranges.map((range) => range.start.getTime()))'))
  // viewModel HER render'da operasyon listesi + analitik listesi uzerinde
  // yeniden hesaplanir (iki ayri kutle).
  assert.ok(DASHBOARD_SOURCE.includes('buildDashboardViewModel({'))
  assert.ok(DASHBOARD_SOURCE.includes('analyticsOrders: analyticsOrders ?? undefined'))
})

// ═══ ÖLÇÜM ARAÇLARI SALT OKUNUR ═══════════════════════════════════════════

test('PERF-TOOL-1: explain araci YAZMAYI MOTOR seviyesinde engeller', () => {
  assert.ok(EXPLAIN_CLI_SOURCE.includes("sql.raw('set transaction read only')"))
  assert.ok(EXPLAIN_CLI_SOURCE.includes('migrationsRun: 0'))
  assert.ok(EXPLAIN_CLI_SOURCE.includes('indexesCreated: 0'))
  // Kimlikler plan metninden maskelenir (PII/kimlik sizintisi yok).
  assert.ok(EXPLAIN_CLI_SOURCE.includes('function maskUuids('))
  const code = EXPLAIN_CLI_SOURCE.split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of ['create index', 'drop ', 'alter table', 'delete from']) {
    assert.equal(code.toLowerCase().includes(forbidden), false, forbidden)
  }
})

test('PERF-TOOL-2: benchmark HERMETIKTIR (uretim DB sine baglanmaz)', () => {
  assert.ok(BENCH_CLI_SOURCE.includes('new PGlite()'))
  // Yorumlar haric KOD: uretim baglantisi hicbir yerde kurulmaz.
  const benchCode = BENCH_CLI_SOURCE.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.equal(benchCode.includes('DATABASE_URL'), false)
  assert.equal(benchCode.includes("from '../db/client.ts'"), false)
  assert.equal(benchCode.includes('getDb('), false)
  assert.ok(BENCH_CLI_SOURCE.includes('productionDatabaseTouched: false'))
})

// ═══ MEVCUT DAVRANIŞ KORUNDU ══════════════════════════════════════════════

test('PERF-SAFE-1: bu denetim CALISMA ZAMANI davranisini DEGISTIRMEDI', () => {
  const ENTRY = nl(readFileSync('server/index.mjs', 'utf8'))
  // Hesap kapsami, tek-ucus, retry, complete:false ve stale reconcile YERINDE.
  assert.ok(ENTRY.includes('resolveActiveMarketplaceAccountId('))
  assert.ok(ENTRY.includes('async function reconcileStaleOpenForOrganization'))
  assert.ok(ENTRY.includes('beginSyncFlight(flightKey)'))
  assert.ok(ENTRY.includes('async function retryTrendyolStatusPass'))
  assert.ok(ENTRY.includes('complete: false'))
  // Okuma yolu sozlesmesi DEGISMEDI (sayfa boyutu tavani korunur).
  assert.ok(REPOSITORY_SOURCE.includes('const MAX_PAGE_SIZE = 100'))
  assert.ok(REPOSITORY_SOURCE.includes('const DEFAULT_PAGE_SIZE = 25'))
})
