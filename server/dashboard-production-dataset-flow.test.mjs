import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'
import {
  DATASET_NOW,
  DATASET_ROWS,
  dispositionOf,
  expectedReceivedToday,
  expectedSales,
  seedProductionDataset,
  summarizeViewModel,
} from './testing/dashboardProductionDataset.mjs'

// ═══ DASHBOARD — ÜRETİM BENZERİ VERİ SETİYLE UÇTAN UCA DOĞRULUK ═════════
//
// Kök neden (Ana Sayfa istatistikleri "çalışmıyor"):
//   1. Seçili dönemin özeti (`salesSummary`) sunucuda dönemle DEĞİŞİYORDU ama
//      ekrana basılmıyordu; yalnız sabit Bugün/Dün/Bu Ay/Geçen Ay kartları
//      görünüyordu → filtre "çalışmıyor" gibi görünüyordu.
//   2. Sunucu özeti yüklenirken / hata verdiğinde ekran, istemcinin KISMİ
//      sipariş havuzundan hesaplanan modele düşüyordu (yanlış sayı, gizli hata).
//   3. "Bugün gelen" UTC rapor günü + yalnız satış dispozisyonu ile sayılıyordu
//      (TSİ 00:00–03:00 ve iptal paketleri kaçıyordu).
//
// Bu dosya sunucu modelini (`/api/dashboard/operational` arkasındaki AYNI
// fonksiyon) PGlite üzerinde gerçek şemayla, BAĞIMSIZ bir kâhine karşı
// doğrular. Taşıyıcı / pazaryeri çağrısı YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

let vite
let pglite
let db
let schema
let service
let seeded

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const statements = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    statements.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return statements
}

before(async () => {
  vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  schema = await vite.ssrLoadModule('/server/db/schema.ts')
  service = await vite.ssrLoadModule('/server/dashboard/dashboardOperationalService.ts')
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  db = drizzle(pglite, { schema })
  seeded = await seedProductionDataset(db, schema)
})

after(async () => {
  if (pglite) await pglite.close()
  if (vite) await vite.close()
})

async function snapshot(selection) {
  const result = await service.buildDashboardViewModelSnapshot(
    db,
    seeded.org.id,
    selection,
    seeded.account.id,
    { now: DATASET_NOW },
  )
  return result.viewModel
}

const PERIODS = ['today', 'yesterday', 'last7', 'last30', 'month']
const CUSTOM = { key: 'custom', startDate: '2026-09-01', endDate: '2026-09-15' }

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.005, `${label}: ${actual} ≠ ${expected}`)
}

test('DASH-PROD-1: her dönemde satış adedi, net/brüt satış, iade, iptal ve ortalama kâhinle BİREBİR', async () => {
  for (const selection of [...PERIODS.map((key) => ({ key })), CUSTOM]) {
    const vm = await snapshot(selection)
    const expected = expectedSales(selection.key, selection)
    const s = vm.salesSummary
    const label = selection.key
    assert.equal(s.orderCount.value, expected.orderCount, `${label} satış adedi`)
    close(s.salesAmount.value, expected.salesAmount, `${label} net satış`)
    assert.equal(s.returnCount.value, expected.returnCount, `${label} iade adedi`)
    close(s.returnAmount.value, expected.returnAmount, `${label} iade tutarı`)
    assert.equal(s.cancelCount.value, expected.cancelCount, `${label} iptal adedi`)
    close(s.cancelAmount.value, expected.cancelAmount, `${label} iptal tutarı`)
    close(s.grossAmount.value, expected.grossAmount, `${label} brüt satış`)
    close(s.averageOrderAmount.value, expected.averageOrderAmount, `${label} ortalama`)
    for (const metric of ['salesAmount', 'returnAmount', 'cancelAmount', 'grossAmount']) {
      assert.equal(s[metric].available, true, `${label} ${metric} mevcut`)
    }
    assert.equal(s.averageOrderAmount.available, expected.orderCount > 0, `${label} ortalama mevcut`)
    // Trend grafiği aynı kohortun satışını taşır.
    const trend = vm.salesChart.current.reduce((total, bucket) => total + bucket.amount, 0)
    close(trend, expected.salesAmount, `${label} trend toplamı`)
  }
})

test('DASH-PROD-2: dönem filtresi sayıları ve tutarları GERÇEKTEN değiştirir', async () => {
  const results = new Map()
  for (const key of PERIODS) results.set(key, summarizeViewModel(await snapshot({ key })))
  const custom = summarizeViewModel(await snapshot(CUSTOM))
  const today = results.get('today')
  const last7 = results.get('last7')
  const last30 = results.get('last30')
  assert.ok(today.orderCount > 0, 'bugün satış var')
  assert.ok(last7.orderCount > today.orderCount, 'son 7 gün > bugün')
  assert.ok(last30.orderCount > last7.orderCount, 'son 30 gün > son 7 gün')
  assert.ok(last30.salesAmount > last7.salesAmount && last7.salesAmount > today.salesAmount)
  assert.notDeepEqual(
    [results.get('today').salesAmount, results.get('yesterday').salesAmount],
    [results.get('yesterday').salesAmount, results.get('today').salesAmount],
    'bugün ve dün aynı tutarı döndürmez',
  )
  assert.notEqual(custom.salesAmount, results.get('month').salesAmount, 'özel aralık ayrı hesaplanır')
  // Dönemden BAĞIMSIZ anlık operasyon sayaçları değişmez.
  const operational = new Set(
    await Promise.all(
      PERIODS.map(async (key) => JSON.stringify({ ...(await snapshot({ key })).operationalSummary, snapshotLabel: null })),
    ),
  )
  assert.equal(operational.size, 1, 'operasyon sayaçları dönemle oynamaz')
})

test('DASH-PROD-3: "Bugün gelen" TSİ günüdür — 00:30 TSİ siparişi bugündür, iade/iptal statülü paket de sayılır', async () => {
  const vm = await snapshot({ key: 'today' })
  const expected = expectedReceivedToday()
  assert.equal(vm.operationalSummary.receivedToday, expected)
  // Veri setinde 11.10 21:30 UTC (= 12.10 00:30 TSİ) siparişi VAR ve satış
  // raporunda DÜNE (UTC günü) yazılır; operasyon girişinde BUGÜNE.
  const midnight = DATASET_ROWS.filter((row) => {
    const iso = row.orderDate.toISOString()
    return iso.startsWith('2026-10-11T21:') || iso.startsWith('2026-10-11T22:')
  })
  assert.ok(midnight.length > 0, 'gece yarısı siparişi veri setinde mevcut')
  // Statüden bağımsız giriş: bugün gelen paketlerden biri satış DEĞİL.
  assert.ok(
    midnight.some((row) => dispositionOf(row.status) !== 'sale'),
    'satış dışı statülü paket de bugün gelenlere dahil',
  )
  assert.ok(expected > expectedSales('today').orderCount, 'TSİ girişleri UTC satış kohortundan geniş')
})

test('DASH-PROD-4: pazaryeri dağılımı, şehir dağılımı ve en çok satanlar kâhinle aynı; izolasyon korunur', async () => {
  const vm = await snapshot({ key: 'last30' })
  const expected = expectedSales('last30')
  assert.deepEqual(
    vm.marketplaceDistribution.map((row) => [row.label, row.orderCount]),
    [['Trendyol', expected.orderCount]],
  )
  close(vm.marketplaceDistribution[0].amount, expected.salesAmount, 'pazaryeri tutarı')
  assert.deepEqual(
    Object.fromEntries(vm.cityDistribution.map((row) => [row.label, row.orderCount])),
    Object.fromEntries(expected.cityCounts),
  )
  assert.deepEqual(
    Object.fromEntries(vm.topProducts.map((row) => [row.barcode, row.quantity])),
    Object.fromEntries(expected.productQuantities),
  )
  for (let index = 1; index < vm.topProducts.length; index += 1) {
    assert.ok(vm.topProducts[index - 1].quantity >= vm.topProducts[index].quantity, 'adet sırası')
  }
  // Diğer hesap (9999 TL) ve diğer kiracı (7777 TL) hiçbir toplama sızmaz.
  const today = await snapshot({ key: 'today' })
  close(today.salesSummary.salesAmount.value, expectedSales('today').salesAmount, 'izolasyon')
})

test('DASH-PROD-5: sunucu modeli süreç saat diliminden BAĞIMSIZ (New York / Kiritimati vs bu süreç)', async () => {
  const inProcess = {}
  for (const key of PERIODS) inProcess[key] = summarizeViewModel(await snapshot({ key }))
  const child = join(here, 'dashboard-production-dataset-child.mjs')
  // Bu süreç CI'da UTC, geliştirici makinesinde İstanbul'dur; child'lar iki
  // uç ofseti (-4/-5 ve +14) ekler.
  for (const tz of ['America/New_York', 'Pacific/Kiritimati']) {
    const run = spawnSync(process.execPath, [child], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(run.status, 0, `${tz}: ${run.stderr}`)
    const parsed = JSON.parse(run.stdout.trim().split('\n').at(-1))
    assert.equal(parsed.tz, tz)
    assert.deepEqual(parsed.out, inProcess, `${tz} sonuçları ayrıştı`)
  }
})

test('DASH-PROD-6: uç nokta dönem parametresini modele geçirir; istemci hata durumunda kısmi veriye düşmez', () => {
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const route = index.slice(index.indexOf("app.get('/api/dashboard/operational'"))
  assert.match(route.slice(0, 1500), /key: strOrUndef\(query\.periodKey\)/)
  assert.match(route.slice(0, 1500), /startDate: strOrUndef\(query\.periodStartDate\)/)
  const client = readFileSync(join(here, '..', 'src', 'services', 'dashboardAnalyticsService.ts'), 'utf8')
  assert.match(client, /new URLSearchParams\(\{ periodKey: period\.key \}\)/)
  const dashboard = readFileSync(join(here, '..', 'src', 'pages', 'DashboardPage.tsx'), 'utf8')
  assert.match(dashboard, /const statsBlocked = useServerOperationalSnapshot && serverViewModel === null/)
  assert.match(dashboard, /data-testid="dashboard-period-summary"/)
  const home = readFileSync(join(here, '..', 'src', 'pages', 'HomePage.tsx'), 'utf8')
  assert.match(home, /const serverMissing = useServerOperationalSnapshot && !server/)
})
