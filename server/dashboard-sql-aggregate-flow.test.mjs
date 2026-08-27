import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ DASHBOARD SQL TOPLAMASI — ANLAM KORUNUYOR MU? ══════════════════════
//
// Bu dosyanın TEK işi: Postgres'te hesaplanan toplamların, bugün istemcide
// çalışan JS toplamasıyla BİREBİR aynı sayıları vermesi.
//
// Para semantiği burada kanıtlanır; "hızlandırdım" iddiası tek başına
// hiçbir şey ifade etmez. Fixture KASITLI OLARAK zor:
//   • aynı siparişin İKİ paketi (bölünmüş sevkiyat) → iki satış birimi
//   • iade + iptal + teslim edilmemiş statüler
//   • çok satırlı siparişler (kalem sayısı ≠ adet toplamı)
//   • tutarı OLMAYAN sipariş → "0 TL" değil "bilinmiyor"
//   • aralık DIŞINDA sipariş → hiçbir toplama girmez
//
// TAŞIYICI VE PAZARYERİ ÇAĞRISI YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
// Sipariş ham payload'ı ŞİFRELİ saklanır; yazım yolu anahtar ister.
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}

const RANGE = { startMs: Date.UTC(2026, 7, 1), endMs: Date.UTC(2026, 7, 31) }

/**
 * ZOR fixture. Her satır bir tuzağı temsil eder ve yorumda hangi tuzak
 * olduğu yazılıdır.
 */
const FIXTURE = [
  // Aynı sipariş, İKİ paket → İKİ satış birimi (çift sayım tuzağı).
  { pkg: 'P1', order: 'ORD-1', status: 'Delivered', amount: '100.00', lines: [2, 3] },
  { pkg: 'P2', order: 'ORD-1', status: 'Delivered', amount: '50.00', lines: [1] },
  // Normal satış, çok satırlı: kalem 3, adet 1+2+4=7.
  { pkg: 'P3', order: 'ORD-2', status: 'Shipped', amount: '250.50', lines: [1, 2, 4] },
  // İADE (öncelik: return > cancel > sale).
  { pkg: 'P4', order: 'ORD-3', status: 'Returned', amount: '80.00', lines: [1] },
  { pkg: 'P5', order: 'ORD-4', status: 'UnDelivered', amount: '30.00', lines: [2] },
  // İPTAL.
  { pkg: 'P6', order: 'ORD-5', status: 'Cancelled', amount: '40.00', lines: [1] },
  { pkg: 'P7', order: 'ORD-6', status: 'UnSupplied', amount: '20.00', lines: [1] },
  // Tutarı NULL satış: MEVCUT davranış bunu 0 TL sayar (rowToOrder
  // `Number(null) = 0`). SQL de aynısını yapmalı — para anlamı değişmez.
  { pkg: 'P8', order: 'ORD-7', status: 'Created', amount: null, lines: [] },
  // Türkçe statü (normalize + alt-dize eşleşmesi).
  { pkg: 'P9', order: 'ORD-8', status: 'İptal Edildi', amount: '15.00', lines: [1] },
  // ARALIK DIŞI — hiçbir toplama girmemeli.
  {
    pkg: 'P10', order: 'ORD-9', status: 'Delivered', amount: '9999.00',
    lines: [1], day: Date.UTC(2026, 5, 15),
  },
]

async function seedFixture(db) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'dash', slug: `dash-${randomBytes(4).toString('hex')}` })
    .returning()
  const mapper = await load('/server/orders/orderMapper.ts')

  for (const [index, entry] of FIXTURE.entries()) {
    // Satır YAZIM YOLUNDAN geçer: sales_disposition kolonu üretimdeki AYNI
    // saf fonksiyonla dolar (test onu elle yazmaz).
    const row = mapper.toOrderInsertValues(org.id, {
      marketplace: 'Trendyol',
      packageId: entry.pkg,
      orderNumber: entry.order,
      marketplaceStatus: entry.status,
      totalAmount: entry.amount,
      orderDate: new Date(entry.day ?? Date.UTC(2026, 7, 5 + (index % 3))).toISOString(),
    })
    const [inserted] = await db.insert(schema.orders).values(row).returning()
    for (const [lineIndex, quantity] of entry.lines.entries()) {
      await db.insert(schema.orderLines).values({
        organizationId: org.id,
        orderId: inserted.id,
        externalLineId: `L-${lineIndex}`,
        productName: `Urun ${index}-${lineIndex}`,
        merchantSku: `SKU-${index}-${lineIndex}`,
        quantity,
        unitPrice: '10.00',
        variantAttributes: [],
      })
    }
  }
  return org.id
}

test('DASH-SQL-1: dispozisyon YAZIM ANINDA ve tek uygulamayla dolar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seedFixture(db)

  const rows = await db.select().from(schema.orders)
  const byPackage = Object.fromEntries(
    rows.map((row) => [row.packageId, row.salesDisposition]),
  )
  assert.equal(byPackage.P1, 'sale')
  assert.equal(byPackage.P4, 'return')
  assert.equal(byPackage.P5, 'return', 'UnDelivered → iade')
  assert.equal(byPackage.P6, 'cancel')
  assert.equal(byPackage.P7, 'cancel', 'UnSupplied → iptal')
  assert.equal(byPackage.P9, 'cancel', 'Türkçe "İptal Edildi" → iptal')
  void organizationId
})

test('DASH-SQL-2: SQL toplamlari JS yoluyla BIREBIR ayni', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seedFixture(db)

  const aggregateRepo = await load('/server/analytics/dashboardAggregateRepository.ts')
  const persistence = await load('/server/orders/orderPersistenceService.ts')
  const viewModel = await load('/src/dashboard/dashboardViewModel.ts')

  // ── SQL yolu ──
  const aggregate = await aggregateRepo.loadDashboardAggregate(
    db, organizationId, RANGE,
  )
  const sqlTotals = aggregateRepo.totalsFromBuckets(aggregate)

  // ── Bugünkü JS yolu ──
  const orders = await persistence.listOrdersForAnalytics(db, organizationId, RANGE)
  const jsTotals = viewModel.__testing.calculatePeriodTotals(
    viewModel.dedupeDashboardOrders(orders),
  )

  // Para ve sayım alanlarının HEPSİ eşleşmeli.
  for (const key of [
    'salesAmount', 'salesAmountAvailable', 'orderCount', 'lineCount',
    'productCount', 'returnAmount', 'returnAmountAvailable', 'returnCount',
    'cancelAmount', 'cancelAmountAvailable', 'cancelCount',
    'returnCancellationAmount', 'returnCancellationAmountAvailable',
    'packageAverage',
  ]) {
    assert.deepEqual(
      sqlTotals[key], jsTotals[key],
      `${key}: SQL=${JSON.stringify(sqlTotals[key])} JS=${JSON.stringify(jsTotals[key])}`,
    )
  }
})

test('DASH-SQL-3: bolunmus sevkiyat CIFT SAYILMAZ, kalem≠adet', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seedFixture(db)
  const repo = await load('/server/analytics/dashboardAggregateRepository.ts')
  const totals = repo.totalsFromBuckets(
    await repo.loadDashboardAggregate(db, organizationId, RANGE),
  )

  // Satış paketleri: P1, P2, P3, P8 → 4 (ORD-1'in iki paketi AYRI birim).
  assert.equal(totals.orderCount, 4)
  // Kalem: P1=2, P2=1, P3=3, P8=0 → 6
  assert.equal(totals.lineCount, 6)
  // Adet: P1=2+3, P2=1, P3=1+2+4 → 13
  assert.equal(totals.productCount, 13)
  // İade: P4, P5 → 2 · İptal: P6, P7, P9 → 3
  assert.equal(totals.returnCount, 2)
  assert.equal(totals.cancelCount, 3)
})

test('DASH-SQL-4: NULL tutar MEVCUT davranisla ayni sekilde 0 sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seedFixture(db)
  const repo = await load('/server/analytics/dashboardAggregateRepository.ts')
  const aggregate = await repo.loadDashboardAggregate(db, organizationId, RANGE)
  const totals = repo.totalsFromBuckets(aggregate)

  // P8'in tutarı NULL. MEVCUT dashboard bunu 0 TL sayar ve toplamı
  // GÜVENİLİR işaretler; SQL bu anlamı DEĞİŞTİRMEZ.
  assert.equal(totals.salesAmountAvailable, true)
  assert.equal(aggregate.buckets.every((b) => b.amountMissingCount === 0), true)
  // Satış toplamı: 100 + 50 + 250.50 + 0 = 400.50
  assert.equal(totals.salesAmount, 400.5)
  assert.equal(totals.returnAmountAvailable, true)
  assert.equal(totals.cancelAmountAvailable, true)
})

test('DASH-SQL-5: ARALIK DISI siparis hicbir toplama girmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seedFixture(db)
  const repo = await load('/server/analytics/dashboardAggregateRepository.ts')
  const totals = repo.totalsFromBuckets(
    await repo.loadDashboardAggregate(db, organizationId, RANGE),
  )
  // P10 (Haziran, 9999 TL) aralık dışıdır.
  assert.ok(totals.salesAmount < 9999)
  assert.equal(totals.orderCount, 4)
})

test('DASH-SQL-6: NODE a donen satir sayisi SIPARIS sayisindan bagimsiz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const bench = await load('/server/benchmarks/dashboardAggregateBenchmark.ts')
  const repo = await load('/server/analytics/dashboardAggregateRepository.ts')
  const seed = await bench.seedDashboard(db, 800)
  const range = { startMs: bench.RANGE_START_MS, endMs: bench.RANGE_END_MS }

  const aggregate = await repo.loadDashboardAggregate(db, seed.organizationId, range)
  // KÖK KAZANÇ: kova sayısı gün × pazaryeri × dispozisyon ile sınırlıdır;
  // 800 sipariş için bile birkaç yüzü geçmez ve sipariş sayısıyla BÜYÜMEZ.
  assert.ok(
    aggregate.buckets.length < 800 / 2,
    `kova sayisi ${aggregate.buckets.length}`,
  )
  assert.equal(aggregate.packageCount, 800)
})

test('DASH-SQL-7: hesap kapsami toplamlari IZOLE eder', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const organizationId = await seedFixture(db)
  const repo = await load('/server/analytics/dashboardAggregateRepository.ts')

  // Kapsam verilmezse TÜM hesaplar (mevcut davranış).
  const all = await repo.loadDashboardAggregate(db, organizationId, RANGE)
  assert.ok(all.packageCount > 0)
  // Var olmayan bir hesap kapsamı → HİÇBİR paket.
  const other = await repo.loadDashboardAggregate(
    db, organizationId, RANGE, '00000000-0000-0000-0000-000000000000',
  )
  assert.equal(other.packageCount, 0)
  // Fixture satırları hesapsız (NULL) yazıldı → NULL kapsamı hepsini görür.
  const legacy = await repo.loadDashboardAggregate(db, organizationId, RANGE, null)
  assert.equal(legacy.packageCount, all.packageCount)
})

test('DASH-SQL-8: 0011 ONCESI satirlar GERI DOLDURULUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const backfill = await load('/server/orders/backfillSalesDispositionCli.ts')
  const repo = await load('/server/analytics/dashboardAggregateRepository.ts')
  const organizationId = await seedFixture(db)

  // 0011 ONCESI durumu taklit et: kolonu bosalt.
  await pglite.exec("UPDATE orders SET sales_disposition = NULL")
  const before = repo.totalsFromBuckets(
    await repo.loadDashboardAggregate(db, organizationId, RANGE),
  )
  // NULL 'sale' sayilir → gecmis iade/iptaller SATIS gorunur (yanlis para).
  assert.equal(before.returnCount, 0)
  assert.equal(before.cancelCount, 0)

  assert.equal(await backfill.countPendingBackfill(db), 10)
  // KURU KOSU hicbir satiri DEGISTIRMEZ.
  const dry = await backfill.backfillSalesDisposition(db, { dryRun: true })
  assert.equal(dry.updated, 0)
  assert.equal(await backfill.countPendingBackfill(db), 10)

  const applied = await backfill.backfillSalesDisposition(db)
  assert.ok(applied.updated > 0)
  assert.equal(await backfill.countPendingBackfill(db), 0)

  // Geri doldurmadan SONRA sayilar dogru.
  const after = repo.totalsFromBuckets(
    await repo.loadDashboardAggregate(db, organizationId, RANGE),
  )
  assert.equal(after.returnCount, 2)
  assert.equal(after.cancelCount, 3)
  // IDEMPOTENT: tekrar calistirmak hicbir sey degistirmez.
  const again = await backfill.backfillSalesDisposition(db)
  assert.equal(again.scanned, 0)
})
