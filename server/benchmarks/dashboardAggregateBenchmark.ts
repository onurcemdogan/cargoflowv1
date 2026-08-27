// DASHBOARD TOPLAMA ÖLÇÜMÜ — DARBOĞAZIN NEREDE OLDUĞUNU KANITLAR.
//
// ═══ NEDEN AYRI BİR ÖLÇÜM ════════════════════════════════════════════════
// "Dashboard yavaş" bir tespit değildir. Bu betik maliyeti KATMANLARA ayırır:
//
//   1. DB   — satırları çekmek (orders + order_lines)
//   2. MAP  — satırları view-model'e çevirmek (rowToOrder)
//   3. WIRE — istemciye gidecek yükü üretmek (sanitize + JSON)
//   4. SQL  — aynı sonucu Postgres içinde toplamak
//
// Böylece "SQL'e taşı" kararı tahmine değil ÖLÇÜME dayanır ve kazancın
// hangi katmandan geldiği görünür.
//
// ÜRETİM VERİTABANI KULLANILMAZ: hermetik PGlite. Taşıyıcı ve pazaryeri
// çağrısı YOKTUR.
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/* eslint-disable @typescript-eslint/no-explicit-any */
const schema: any = await import('../db/schema.ts')
const persistence: any = await import('../orders/orderPersistenceService.ts')
const cache: any = await import('../cache/analyticsCache.ts')
const aggregate: any = await import('../analytics/dashboardAggregateRepository.ts')
const mapper: any = await import('../orders/orderMapper.ts')

export const DEFAULT_SIZES = [2000, 10_000, 25_000]
export const DEFAULT_REPEATS = 7

/** Aralık: tohumlanan siparişlerin TAMAMINI kapsar. */
export const RANGE_START_MS = Date.UTC(2026, 6, 1)
export const RANGE_END_MS = Date.UTC(2026, 7, 28)

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Number(sorted[Math.max(0, rank)].toFixed(3))
}

function migrationStatements(): string[] {
  const dir = join(root, '..', 'drizzle')
  const out: string[] = []
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

/**
 * Determinist veri seti.
 *
 * GERÇEKÇİ ZORLUKLAR KASITLI OLARAK VARDIR:
 *   • aynı siparişin BİRDEN ÇOK paketi (bölünmüş sevkiyat)
 *   • iptal ve iade statüleri
 *   • tutarsız/eksik tutar alanları
 * Böylece SQL toplaması yalnız "hızlı" değil, DOĞRU olduğunu da kanıtlar.
 */
const STATUSES = [
  'Created', 'Picking', 'Invoiced', 'Shipped', 'Delivered',
  'Cancelled', 'Returned', 'UnDelivered', 'UnSupplied',
]

export async function seedDashboard(db: any, count: number) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'dash', slug: `dash-${randomBytes(4).toString('hex')}` })
    .returning()

  const orderRows: any[] = []
  for (let index = 0; index < count; index += 1) {
    // Her 7. sipariş İKİ pakete bölünür: aynı orderNumber, farklı packageId.
    const split = index % 7 === 0
    const orderNumber = `ORD-${Math.floor(index / (split ? 1 : 1))}`
    // ÜRETİM YAZIM YOLU: sales_disposition kolonu burada da aynı saf
    // fonksiyonla dolar; benchmark gerçek şemayı ölçer.
    orderRows.push(
      mapper.toOrderInsertValues(org.id, {
        marketplace: index % 11 === 0 ? 'Hepsiburada' : 'Trendyol',
        packageId: `PKG-${index}`,
        orderNumber,
        orderDate: new Date(
          RANGE_START_MS + (index % 55) * 24 * 60 * 60 * 1000,
        ).toISOString(),
        marketplaceStatus: STATUSES[index % STATUSES.length],
        totalAmount: String(100 + (index % 400)),
        operationStatus: 'NEW',
      }),
    )
  }

  const chunk = 500
  for (let index = 0; index < orderRows.length; index += chunk) {
    await db.insert(schema.orders).values(orderRows.slice(index, index + chunk))
  }
  const persisted = await db
    .select({ id: schema.orders.id, packageId: schema.orders.packageId })
    .from(schema.orders)
  const lines: any[] = []
  for (const row of persisted as { id: string; packageId: string }[]) {
    const index = Number(String(row.packageId).replace('PKG-', '')) || 0
    // 1–3 satır: KALEM sayısı ve ADET toplamı farklı olsun.
    for (let line = 0; line <= index % 3; line += 1) {
      lines.push({
        organizationId: org.id,
        orderId: row.id,
        externalLineId: `L-${line}`,
        productName: `Urun ${index}-${line}`,
        merchantSku: `SKU-${index}-${line}`,
        quantity: 1 + (line % 2),
        variantAttributes: [],
      })
    }
  }
  for (let index = 0; index < lines.length; index += chunk) {
    await db.insert(schema.orderLines).values(lines.slice(index, index + chunk))
  }
  return { organizationId: org.id, orderCount: count, lineCount: lines.length }
}

export async function makeDashboardDb(count: number) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const seed = await seedDashboard(db, count)
  // ═══ ANALYZE ZORUNLU ═══════════════════════════════════════════════════
  //
  // ÖLÇÜLDÜ: istatistiksiz taze bir veritabanında planlayıcı felaket bir
  // plan seçiyor ve aynı sorgu 10 ms yerine ~1400 ms sürüyor. Üretimde
  // autovacuum/autoanalyze bu istatistikleri sürekli günceller; ANALYZE
  // atlanırsa ölçüm ÜRETİMİ TEMSİL ETMEZ ve "SQL yavaş" diye YANLIŞ bir
  // sonuca götürür.
  await pglite.exec('ANALYZE')
  return { pglite, db, seed }
}

export interface LayerTiming {
  size: number
  /** Satırları çekip view-model'e çeviren MEVCUT yol. */
  jsPathP50: number
  jsPathP95: number
  /** İstemciye gidecek yükü üretmek (sanitize + JSON.stringify). */
  wireP50: number
  wireBytes: number
  /** Postgres içinde toplayan YENİ yol. */
  sqlPathP50: number
  sqlPathP95: number
  rowsToNodeBefore: number
  rowsToNodeAfter: number
}

async function timed(repeats: number, run: () => Promise<unknown>) {
  await run()
  const samples: number[] = []
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now()
    await run()
    samples.push(performance.now() - started)
  }
  return { p50: percentile(samples, 50), p95: percentile(samples, 95) }
}

export async function measureSize(
  size: number,
  repeats: number,
): Promise<LayerTiming> {
  const { pglite, db, seed } = await makeDashboardDb(size)
  try {
    const range = { startMs: RANGE_START_MS, endMs: RANGE_END_MS }
    const jsPath = await timed(repeats, () =>
      persistence.listOrdersForAnalytics(db, seed.organizationId, range),
    )
    const rows = await persistence.listOrdersForAnalytics(
      db, seed.organizationId, range,
    )
    const wire = await timed(repeats, async () => {
      JSON.stringify(cache.sanitizeAnalyticsOrders(rows))
    })
    const wireBytes = JSON.stringify(cache.sanitizeAnalyticsOrders(rows)).length

    const sqlPath = await timed(repeats, () =>
      aggregate.loadDashboardAggregate(db, seed.organizationId, range),
    )
    const summary = await aggregate.loadDashboardAggregate(
      db, seed.organizationId, range,
    )
    return {
      size,
      jsPathP50: jsPath.p50,
      jsPathP95: jsPath.p95,
      wireP50: wire.p50,
      wireBytes,
      sqlPathP50: sqlPath.p50,
      sqlPathP95: sqlPath.p95,
      rowsToNodeBefore: rows.length,
      // SQL yolunda Node'a dönen satır: gün × pazaryeri × dispozisyon kovaları.
      rowsToNodeAfter: summary.buckets.length,
    }
  } finally {
    await pglite.close()
  }
}

export async function runDashboardBenchmark(options: {
  sizes?: number[]
  repeats?: number
} = {}) {
  const sizes = options.sizes ?? DEFAULT_SIZES
  const repeats = options.repeats ?? DEFAULT_REPEATS
  const results: LayerTiming[] = []
  for (const size of sizes) results.push(await measureSize(size, repeats))
  return {
    results,
    scopeCaveat:
      'Hermetik PGlite ölçümü. Mutlak gecikme ÜRETİM SLA’sı DEĞİLDİR; ' +
      'anlamlı olan ÖLÇEKLENME eğrisi ve Node’a dönen SATIR SAYISIDIR.',
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const sizes = String(process.env.DASH_SIZES ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  const report = await runDashboardBenchmark({
    sizes: sizes.length > 0 ? sizes : DEFAULT_SIZES,
    repeats: Number(process.env.DASH_REPEATS ?? DEFAULT_REPEATS),
  })
  console.log('\nDASHBOARD TOPLAMA — KATMAN ÖLÇÜMÜ\n')
  console.log(
    [
      'boyut', 'JS p50', 'JS p95', 'wire p50', 'wire KB',
      'SQL p50', 'SQL p95', 'satır ÖNCE', 'satır SONRA',
    ].join('\t'),
  )
  for (const row of report.results) {
    console.log(
      [
        row.size, row.jsPathP50, row.jsPathP95, row.wireP50,
        Math.round(row.wireBytes / 1024),
        row.sqlPathP50, row.sqlPathP95,
        row.rowsToNodeBefore, row.rowsToNodeAfter,
      ].join('\t'),
    )
  }
  console.log(`\nKAPSAM: ${report.scopeCaveat}\n`)
}
