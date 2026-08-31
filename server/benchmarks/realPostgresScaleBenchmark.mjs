// GERÇEK POSTGRES ÖLÇEK KIYASLAMASI — 2k / 10k / 25k.
//
// ═══ NE KANITLAR ═════════════════════════════════════════════════════════
// Tam sipariş hesabını tarayıcıdan sunucuya taşımak, ölçeği yalnızca YER
// DEĞİŞTİRMİŞ olabilir. Bu paket bunu ölçer:
//   · uç nokta süresi (soğuk / sıcak, p50 / p95)
//   · DB'de geçen süre ile Node projeksiyonunda geçen sürenin AYRIMI
//   · Node'a okunan satır sayısı
//   · yanıt boyutu (tarayıcıya inen)
//   · süreç RSS'i (öncesi / tepe / sonrası)
//
// ═══ PARİTE AYNI KOŞUDA ══════════════════════════════════════════════════
// Hız ölçmek yetmez: her senaryo, ESKİ istemci yolunun (sayfalanmış
// `/api/orders` + istemci türetmeleri + saf projeksiyon) sonucuyla
// karşılaştırılır. Cevap değişmişse hız anlamsızdır.
//
// ═══ GÜVENLİK ════════════════════════════════════════════════════════════
// Yalnız yerel izole veritabanı. Taşıyıcı/pazaryeri çağrısı YOK.

import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { assertLocalDatabase, seedScaleDataset } from './realPostgresScaleSeed.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const DATABASE_URL =
  process.env.SCALE_DATABASE_URL ??
  'postgres://postgres:cargoflow_scale@127.0.0.1:15433/cargoflow_scale'
const PORT = Number(process.env.SCALE_PORT ?? 8899)
const BASE = `http://127.0.0.1:${PORT}`
const SIZES = (process.env.SCALE_SIZES ?? '2000,10000,25000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter(Boolean)
const SAMPLES = Number(process.env.SCALE_SAMPLES ?? 15)

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[index]
}

function rssOf(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const match = out.match(/"([\d.,]+) K"/)
    if (!match) return null
    return Number(match[1].replace(/[.,]/g, '')) * 1024
  } catch {
    return null
  }
}

const BASE_QUERY = {
  tab: 'all', operationTab: 'all', marketplace: 'all', status: 'all',
  cargo: 'all', city: 'all', district: 'all', multiProduct: 'all',
  sameProduct: 'all', action: 'all', date: { preset: 'all' },
  search: '', customerQuery: '', productQuery: '', orderNumberQuery: '',
  cargoSlipQuery: '', sortKey: 'orderDate', sortDirection: 'desc',
  page: 1, pageSize: 25,
}

function toParams(query) {
  const params = new URLSearchParams()
  params.set('tab', query.tab)
  params.set('operationTab', query.operationTab)
  params.set('marketplace', String(query.marketplace))
  params.set('status', String(query.status))
  params.set('cargo', String(query.cargo))
  params.set('city', query.city)
  params.set('district', query.district)
  params.set('multiProduct', query.multiProduct)
  params.set('sameProduct', query.sameProduct)
  params.set('action', query.action)
  params.set('datePreset', query.date.preset)
  if (Number.isFinite(query.date.startTime)) {
    params.set('startTime', String(query.date.startTime))
  }
  if (Number.isFinite(query.date.endTime)) {
    params.set('endTime', String(query.date.endTime))
  }
  if (query.search) params.set('search', query.search)
  params.set('sortKey', query.sortKey)
  params.set('sortDirection', query.sortDirection)
  params.set('page', String(query.page))
  params.set('pageSize', String(query.pageSize))
  return params
}

async function startApi(log) {
  const env = {
    ...process.env,
    DATABASE_URL,
    NODE_ENV: 'development',
    PORT: String(PORT),
    CARGOFLOW_AUTH_BYPASS: 'true',
    SESSION_SECRET: randomBytes(32).toString('base64'),
    COOKIE_SECURE: 'false',
  }
  const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) {
        log(`API hazır (pid ${child.pid})`)
        return child
      }
    } catch {
      // henüz ayakta değil
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  child.kill('SIGKILL')
  throw new Error('[scale] API başlamadı.')
}

async function getJson(path) {
  const started = Date.now()
  const response = await fetch(`${BASE}${path}`)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`[scale] ${path} → HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  return {
    payload: JSON.parse(text),
    bytes: Buffer.byteLength(text),
    ms: Date.now() - started,
  }
}

/**
 * ESKİ istemci yolu — referans.
 *
 * Tarayıcı `/api/orders` sayfalarını tek tek indirir, istemci türetmelerini
 * uygular ve saf projeksiyonu TAM dizi üzerinde çalıştırırdı. Referans
 * BURADA da aynen kurulur; yeni sunucu yolunun fonksiyonları KULLANILMAZ
 * (aksi halde karşılaştırma döngüsel olurdu).
 */
async function buildLegacyReference(db, organizationId, modules, log) {
  const collected = []
  let page = 1
  for (;;) {
    const result = await modules.persistence.listOrders(
      db, organizationId, { page, pageSize: 100 }, undefined,
    )
    collected.push(...result.orders)
    if (collected.length >= result.total || result.orders.length === 0) break
    page += 1
  }
  log(`legacy referans: ${collected.length} sipariş, ${page} sayfa`)
  const derived = collected.map((order) =>
    modules.orderStatus.withDerivedOperationStatus(order),
  )
  const stamped = modules.externalProcessing.applyExternalProcessingState(derived, {
    entries: {},
  })
  return modules.orderCounts.dedupeOrdersByPackageIdentity(stamped)
}

function orderScenarios(datasetSize) {
  const lastPage25 = Math.max(1, Math.ceil(datasetSize / 25))
  const lastPage100 = Math.max(1, Math.ceil(datasetSize / 100))
  return [
    { name: 'p25-first', query: { pageSize: 25, page: 1 } },
    { name: 'p25-middle', query: { pageSize: 25, page: Math.max(1, Math.floor(lastPage25 / 2)) } },
    { name: 'p25-last', query: { pageSize: 25, page: lastPage25 } },
    { name: 'p100-first', query: { pageSize: 100, page: 1 } },
    { name: 'p100-middle', query: { pageSize: 100, page: Math.max(1, Math.floor(lastPage100 / 2)) } },
    { name: 'p100-last', query: { pageSize: 100, page: lastPage100 } },
    { name: 'search', query: { search: 'Şükrü', pageSize: 25, page: 1 } },
    { name: 'status', query: { status: 'Shipped', pageSize: 25, page: 1 } },
    { name: 'city', query: { city: 'İzmir', pageSize: 25, page: 1 } },
    {
      name: 'date',
      query: {
        pageSize: 25,
        page: 1,
        date: {
          preset: 'custom',
          startTime: Date.UTC(2026, 6, 5),
          endTime: Date.UTC(2026, 6, 20, 23, 59, 59, 999),
        },
      },
    },
    { name: 'sort-asc', query: { sortDirection: 'asc', pageSize: 25, page: 1 } },
    { name: 'sort-desc', query: { sortDirection: 'desc', pageSize: 25, page: 1 } },
  ]
}

async function measure(path, samples) {
  const cold = await getJson(path)
  const warmMs = []
  let lastWarm = cold
  for (let index = 0; index < samples; index += 1) {
    const sample = await getJson(path)
    warmMs.push(sample.ms)
    lastWarm = sample
  }
  return {
    coldMs: cold.ms,
    coldDiagnostics: cold.payload.diagnostics,
    warmP50: percentile(warmMs, 0.5),
    warmP95: percentile(warmMs, 0.95),
    bytes: lastWarm.bytes,
    diagnostics: lastWarm.diagnostics ?? lastWarm.payload.diagnostics,
    payload: lastWarm.payload,
  }
}

export async function runScaleBenchmark({ log = console.log } = {}) {
  assertLocalDatabase(DATABASE_URL)
  const results = []

  for (const size of SIZES) {
    log(`\n═══ VERİ SETİ: ${size.toLocaleString('tr-TR')} sipariş ═══`)
    const seedStarted = Date.now()
    const seed = await seedScaleDataset({
      databaseUrl: DATABASE_URL,
      orderCount: size,
      log: (message) => log(`  [seed] ${message}`),
    })
    log(`  [seed] tamamlandı (${Date.now() - seedStarted} ms)`)

    const api = await startApi((message) => log(`  [api] ${message}`))
    const rssBaseline = rssOf(api.pid)
    let rssPeak = rssBaseline ?? 0
    const rssSamples = []

    try {
      // ── Referans (eski istemci yolu) ───────────────────────────────
      const { drizzle } = await import('drizzle-orm/node-postgres')
      const schema = await import('../db/schema.ts')
      const pool = new pg.Pool({ connectionString: DATABASE_URL })
      const db = drizzle(pool, { schema })
      const modules = {
        persistence: await import('../orders/orderPersistenceService.ts'),
        orderStatus: await import('../../src/utils/orderStatus.ts'),
        externalProcessing: await import('../../src/utils/externalProcessing.ts'),
        orderCounts: await import('../../src/utils/orderCounts.ts'),
        projection: await import('../../src/utils/ordersWorkspaceQuery.ts'),
        viewModel: await import('../../src/dashboard/dashboardViewModel.ts'),
        products: await import('../products/productPersistenceService.ts'),
        analyticsCache: await import('../cache/analyticsCache.ts'),
      }
      const referenceStarted = Date.now()
      const reference = await buildLegacyReference(
        db, seed.organizationId, modules, (message) => log(`  [ref] ${message}`),
      )
      const referenceMs = Date.now() - referenceStarted
      log(`  [ref] legacy tam yükleme ${referenceMs} ms`)

      // ── SİPARİŞ SENARYOLARI ────────────────────────────────────────
      const orderMeasurements = []
      let parityFailures = 0
      for (const scenario of orderScenarios(size)) {
        const query = { ...BASE_QUERY, ...scenario.query }
        const path = `/api/orders/workspace?${toParams(query).toString()}`
        const measured = await measure(path, SAMPLES)
        rssSamples.push(measured.diagnostics?.rssBytes ?? 0)
        rssPeak = Math.max(rssPeak, measured.diagnostics?.rssBytes ?? 0)

        const expected = modules.projection.buildOrdersWorkspaceResult(
          reference, query, new Date(),
        )
        const actual = measured.payload.workspace
        const same =
          JSON.stringify(actual.items.map((order) => order.id)) ===
            JSON.stringify(expected.items.map((order) => order.id)) &&
          actual.totalItems === expected.totalItems &&
          actual.pageCount === expected.pageCount &&
          JSON.stringify(actual.tabCounts) === JSON.stringify(expected.tabCounts) &&
          JSON.stringify(actual.cityOptions) === JSON.stringify(expected.cityOptions) &&
          JSON.stringify(actual.listedCounts) === JSON.stringify(expected.listedCounts)
        if (!same) {
          parityFailures += 1
          log(`  [PARİTE HATASI] ${scenario.name}`)
        }
        orderMeasurements.push({
          scenario: scenario.name,
          parity: same,
          coldMs: measured.coldMs,
          p50: measured.warmP50,
          p95: measured.warmP95,
          bytes: measured.bytes,
          items: actual.items.length,
          totalItems: actual.totalItems,
          dbMs: measured.diagnostics?.dbMs ?? null,
          projectionMs: measured.diagnostics?.projectionMs ?? null,
          rowsReadIntoNode: measured.diagnostics?.rowsReadIntoNode ?? null,
          cacheHit: measured.diagnostics?.cacheHit ?? null,
        })
      }

      // ── DASHBOARD ──────────────────────────────────────────────────
      const dashPath =
        '/api/dashboard/operational?periodKey=last30&periodStartDate=2026-08-01&periodEndDate=2026-08-31'
      const dashMeasured = await measure(dashPath, SAMPLES)
      rssPeak = Math.max(rssPeak, dashMeasured.diagnostics?.rssBytes ?? 0)

      // Dashboard paritesi: eski istemci yolu (iki geçişli) referans.
      const products = await modules.products.listAllProducts(
        db, seed.organizationId, undefined,
      )
      const period = { key: 'last30', startDate: '2026-08-01', endDate: '2026-08-31' }
      const now = new Date()
      const draft = modules.viewModel.buildDashboardViewModel({
        orders: reference, products, selectedPeriod: period, now,
      })
      const ranges = [
        draft.period,
        draft.comparisonPeriod,
        ...draft.salesPeriodCards.map((card) => card.range),
      ]
      const analyticsRows = await modules.persistence.listOrdersForAnalytics(
        db,
        seed.organizationId,
        {
          startMs: Math.min(...ranges.map((range) => range.start.getTime())),
          endMs: Math.max(...ranges.map((range) => range.end.getTime())),
        },
        undefined,
      )
      const expectedModel = modules.viewModel.buildDashboardViewModel({
        orders: reference,
        analyticsOrders: modules.analyticsCache.sanitizeAnalyticsOrders(analyticsRows),
        analyticsClaims: [],
        claimsAvailable: false,
        products,
        selectedPeriod: period,
        now,
      })
      // `now` iki tarafta farklı milisaniyede oluştuğundan dönem SINIRLARI
      // (sabit takvim günleri) karşılaştırılır; tarih nesneleri ISO'ya çevrilir.
      const normalize = (model) =>
        JSON.parse(JSON.stringify({ ...model, latestSyncAt: null }))
      const dashboardParity =
        JSON.stringify(normalize(expectedModel)) ===
        JSON.stringify(normalize(dashMeasured.payload.viewModel))
      if (!dashboardParity) log('  [PARİTE HATASI] dashboard')

      await pool.end()
      const rssFinal = rssOf(api.pid)

      results.push({
        datasetSize: size,
        seed,
        legacyFullLoadMs: referenceMs,
        orders: orderMeasurements,
        ordersParityFailures: parityFailures,
        dashboard: {
          parity: dashboardParity,
          coldMs: dashMeasured.coldMs,
          p50: dashMeasured.warmP50,
          p95: dashMeasured.warmP95,
          bytes: dashMeasured.bytes,
          dbMs: dashMeasured.diagnostics?.dbMs ?? null,
          projectionMs: dashMeasured.diagnostics?.projectionMs ?? null,
          rowsReadIntoNode: dashMeasured.diagnostics?.rowsReadIntoNode ?? null,
          scannedOrders: dashMeasured.diagnostics?.scannedOrders ?? null,
          scannedAnalyticsOrders:
            dashMeasured.diagnostics?.scannedAnalyticsOrders ?? null,
        },
        memory: {
          baselineBytes: rssBaseline,
          peakBytes: rssPeak,
          finalBytes: rssFinal,
          deltaBytes:
            rssBaseline != null && rssFinal != null ? rssFinal - rssBaseline : null,
        },
      })
    } finally {
      api.kill('SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
  }

  return results
}

function mb(bytes) {
  return bytes == null ? '—' : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('realPostgresScaleBenchmark.mjs')) {
  const results = await runScaleBenchmark()
  console.log('\n═══ ÖZET ═══')
  for (const result of results) {
    const cold = result.orders.find((row) => row.scenario === 'p25-first')
    const warmRows = result.orders.filter((row) => row.scenario !== 'p25-first')
    console.log(
      `\n${result.datasetSize.toLocaleString('tr-TR')} sipariş  ` +
        `(satır ${result.seed.lines}, gönderi ${result.seed.shipments}, ` +
        `operasyon ${result.seed.operations}, varyant ${result.seed.variants})`,
    )
    console.log(
      `  ORDERS   cold=${cold?.coldMs}ms  p50=${percentile(warmRows.map((r) => r.p50), 0.5)}ms  ` +
        `p95=${percentile(warmRows.map((r) => r.p95), 0.95)}ms  ` +
        `bytes(p25-first)=${cold?.bytes}  parityFailures=${result.ordersParityFailures}`,
    )
    for (const row of result.orders) {
      console.log(
        `    ${row.scenario.padEnd(12)} p50=${String(row.p50).padStart(5)}ms ` +
          `p95=${String(row.p95).padStart(5)}ms bytes=${String(row.bytes).padStart(7)} ` +
          `items=${String(row.items).padStart(3)} total=${String(row.totalItems).padStart(6)} ` +
          `db=${row.dbMs}ms proj=${row.projectionMs}ms rows=${row.rowsReadIntoNode} ` +
          `cache=${row.cacheHit} parity=${row.parity ? 'OK' : 'FAIL'}`,
      )
    }
    console.log(
      `  DASHBOARD cold=${result.dashboard.coldMs}ms p50=${result.dashboard.p50}ms ` +
        `p95=${result.dashboard.p95}ms bytes=${result.dashboard.bytes} ` +
        `db=${result.dashboard.dbMs}ms proj=${result.dashboard.projectionMs}ms ` +
        `rows=${result.dashboard.rowsReadIntoNode} ` +
        `scanned=${result.dashboard.scannedOrders}/${result.dashboard.scannedAnalyticsOrders} ` +
        `parity=${result.dashboard.parity ? 'PASS' : 'FAIL'}`,
    )
    console.log(
      `  MEMORY   baseline=${mb(result.memory.baselineBytes)} ` +
        `peak=${mb(result.memory.peakBytes)} final=${mb(result.memory.finalBytes)} ` +
        `delta=${mb(result.memory.deltaBytes)}`,
    )
    console.log(`  LEGACY full client load: ${result.legacyFullLoadMs} ms`)
  }
  const failed =
    results.some((result) => result.ordersParityFailures > 0) ||
    results.some((result) => !result.dashboard.parity)
  console.log(`\nRESULT=${failed ? 'FAIL' : 'PASS'}`)
  process.exit(failed ? 1 : 0)
}
