// UYGULAMA PERFORMANSI ÖLÇÜMÜ — kullanıcının GERÇEKTEN beklediği yollar.
//
// ═══ NEYİ ÖLÇER ══════════════════════════════════════════════════════════
//   1. Sipariş listesi   — sayfa 50 ve 100 (p50/p95)
//   2. Dashboard         — dönemsel satış toplamı (p50/p95)
//   3. Sipariş detayı    — tek sipariş + gönderi bağlama (p95)
//   4. Hazır etiket      — kalıcı baskı paketinin okunması (p95)
//   5. SORGU SAYISI      — sayfa başına; N+1 muhafızı
//
// ═══ NE ÖLÇMEZ (DÜRÜSTLÜK NOTU) ══════════════════════════════════════════
// Bu ölçüm HERMETİK PGlite üzerinde çalışır. Rakamlar üretim PostgreSQL'inin
// gecikmesi DEĞİLDİR: ağ, disk, bağlantı havuzu, eşzamanlı yük ve planlayıcı
// istatistikleri yoktur. Bu yüzden ÜRETİM SLA'sı olarak alıntılanamaz.
//
// ÜRETİME TAŞINABİLEN TEK ŞEY, ORTAMDAN BAĞIMSIZ OLAN SORGU SAYISIDIR:
// "100 satırlık sayfa, 50 satırlıkla AYNI sayıda sorgu üretir" ifadesi
// makineye göre değişmez ve N+1 regresyonunu yakalar. Gecikme rakamları
// yalnız GÖRELİ karşılaştırma (bu koşu vs. önceki koşu) içindir.
//
// TAŞIYICI VE PAZARYERİ ÇAĞRISI YOKTUR: ne Sürat ne Trendyol. Gerçek etiket
// ÜRETİLMEZ; hazır artefakt tohumlanır ve yalnız OKUNUR.
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

/* eslint-disable @typescript-eslint/no-explicit-any */
const schema: any = await import('../db/schema.ts')
const encryption: any = await import('../shipments/shipmentEncryption.ts')
const printRepo: any = await import('../shipments/printZplRepository.ts')
const persistence: any = await import('../orders/orderPersistenceService.ts')

const ZPL = readFileSync(join(root, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const NOW = '2026-08-27T00:00:00.000Z'

export const DEFAULT_ORDER_COUNT = 2000
export const DEFAULT_REPEATS = 30

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
 * Sorgu sayan ince sarmalayıcı.
 *
 * Drizzle'ın `db.select/insert/update/delete` girişleri sayılır. Sayaç
 * ORTAMDAN BAĞIMSIZDIR: aynı kod her makinede aynı sayıyı verir, bu yüzden
 * N+1 muhafızı gecikmeye değil BUNA dayanır.
 */
export function countingDb(db: any): { db: any; count: () => number; reset: () => void } {
  let queries = 0
  const wrapped = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (
        typeof value === 'function' &&
        ['select', 'insert', 'update', 'delete', 'execute'].includes(String(property))
      ) {
        return (...args: unknown[]) => {
          queries += 1
          return value.apply(target, args)
        }
      }
      return value
    },
  })
  return {
    db: wrapped,
    count: () => queries,
    reset: () => {
      queries = 0
    },
  }
}

export interface SeedResult {
  organizationId: string
  orderIds: string[]
  packageIds: string[]
}

export async function seedOrders(
  db: any,
  count: number,
): Promise<SeedResult> {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'perf', slug: `perf-${randomBytes(4).toString('hex')}` })
    .returning()

  const orderRows: any[] = []
  const shipmentRows: any[] = []
  const lineSpecs: Array<{ packageId: string; lines: any[] }> = []
  for (let index = 0; index < count; index += 1) {
    const packageId = `PERF-${index}`
    const lines = [
      {
        productName: `Urun ${index}`,
        quantity: 1 + (index % 3),
        color: ['Lacivert', 'Siyah', 'Ekru'][index % 3],
        size: ['38', '40', 'STD'][index % 3],
        sku: `SKU-${index}`,
      },
    ]
    orderRows.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `ORD-${index}`,
      // Dashboard aralık sorgusunun anlamlı olması için tarihler yayılır.
      orderDate: new Date(Date.UTC(2026, 7, 1 + (index % 27))),
      operationStatus: 'LABEL_READY',
    })
    shipmentRows.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `ORD-${index}`,
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      carrierPayloadEncrypted: encryption.encryptShipmentPayload(
        printRepo.attachPrintZplArtifact({ technicalZpl: ZPL }, lines, NOW),
      ),
    })
    lineSpecs.push({ packageId, lines })
  }

  const chunk = 250
  for (let index = 0; index < orderRows.length; index += chunk) {
    await db.insert(schema.orders).values(orderRows.slice(index, index + chunk))
  }
  const persisted = await db.select().from(schema.orders)
  const orderIdByPackage = new Map<string, string>(
    persisted.map((row: any) => [String(row.packageId), String(row.id)]),
  )
  const allLines: any[] = []
  for (const entry of lineSpecs) {
    const orderId = orderIdByPackage.get(entry.packageId)
    if (!orderId) continue
    for (const [lineIndex, line] of entry.lines.entries()) {
      allLines.push({
        organizationId: org.id,
        orderId,
        externalLineId: `L-${lineIndex}`,
        productName: line.productName,
        merchantSku: line.sku,
        quantity: line.quantity,
        variantAttributes: [],
      })
    }
  }
  for (let index = 0; index < allLines.length; index += chunk) {
    await db.insert(schema.orderLines).values(allLines.slice(index, index + chunk))
  }
  for (let index = 0; index < shipmentRows.length; index += chunk) {
    await db.insert(schema.shipments).values(shipmentRows.slice(index, index + chunk))
  }

  return {
    organizationId: org.id,
    orderIds: persisted.map((row: any) => String(row.id)),
    packageIds: lineSpecs.map((entry) => entry.packageId),
  }
}

export async function makeSeededDb(count: number) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const seed = await seedOrders(db, count)
  return { pglite, db, seed }
}

export interface Measurement {
  label: string
  p50: number
  p95: number
  runs: number
  /** Tek çağrının ürettiği DB sorgusu sayısı (ortamdan bağımsız). */
  queries: number
}

async function measure(
  label: string,
  repeats: number,
  db: any,
  run: (db: any) => Promise<unknown>,
): Promise<Measurement> {
  // Isınma turu: ilk çağrının modül yükleme ve plan maliyeti ölçüme girmez.
  await run(db)
  const counter = countingDb(db)
  await run(counter.db)
  const queries = counter.count()

  const samples: number[] = []
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now()
    await run(db)
    samples.push(performance.now() - started)
  }
  return {
    label,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    runs: repeats,
    queries,
  }
}

export interface BenchmarkReport {
  orderCount: number
  repeats: number
  measurements: Measurement[]
  /** 50 ve 100 satırlık sayfa AYNI sorgu sayısını üretmeli. */
  nPlusOneGuard: { pageSize50: number; pageSize100: number; constant: boolean }
  scopeCaveat: string
}

export async function runAppPerformanceBenchmark(options: {
  orderCount?: number
  repeats?: number
} = {}): Promise<BenchmarkReport> {
  const orderCount = options.orderCount ?? DEFAULT_ORDER_COUNT
  const repeats = options.repeats ?? DEFAULT_REPEATS
  const { pglite, db, seed } = await makeSeededDb(orderCount)
  try {
    const org = seed.organizationId
    const measurements: Measurement[] = []

    measurements.push(
      await measure('orders.list.pageSize50', repeats, db, (handle) =>
        persistence.listOrders(handle, org, { page: 1, pageSize: 50 }),
      ),
    )
    measurements.push(
      await measure('orders.list.pageSize100', repeats, db, (handle) =>
        persistence.listOrders(handle, org, { page: 1, pageSize: 100 }),
      ),
    )
    measurements.push(
      await measure('dashboard.salesRange', repeats, db, (handle) =>
        persistence.listOrdersForAnalytics(handle, org, {
          startMs: Date.UTC(2026, 7, 1),
          endMs: Date.UTC(2026, 7, 28),
        }),
      ),
    )
    measurements.push(
      await measure('orders.detail', repeats, db, (handle) =>
        persistence.getOrder(handle, org, seed.orderIds[0]),
      ),
    )
    measurements.push(
      await measure('labels.readyLookup', repeats, db, (handle) =>
        persistence.resolvePersistedLabel(handle, org, seed.orderIds[0]),
      ),
    )

    const page50 = measurements.find((m) => m.label === 'orders.list.pageSize50')
    const page100 = measurements.find((m) => m.label === 'orders.list.pageSize100')
    return {
      orderCount,
      repeats,
      measurements,
      nPlusOneGuard: {
        pageSize50: page50?.queries ?? -1,
        pageSize100: page100?.queries ?? -1,
        constant: (page50?.queries ?? -1) === (page100?.queries ?? -2),
      },
      scopeCaveat:
        'Hermetik PGlite ölçümü. Gecikme rakamları ÜRETİM SLA’sı DEĞİLDİR ' +
        '(ağ, disk, havuz, eşzamanlı yük yok). Üretime taşınabilen tek ' +
        'sonuç, ortamdan bağımsız SORGU SAYISIDIR.',
    }
  } finally {
    await pglite.close()
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const report = await runAppPerformanceBenchmark({
    orderCount: Number(process.env.PERF_ORDERS ?? DEFAULT_ORDER_COUNT),
    repeats: Number(process.env.PERF_REPEATS ?? DEFAULT_REPEATS),
  })
  console.log(`\nUYGULAMA PERFORMANSI — ${report.orderCount} sipariş, ${report.repeats} tekrar\n`)
  console.log(
    ['yol', 'p50 (ms)', 'p95 (ms)', 'sorgu'].join('\t'),
  )
  for (const row of report.measurements) {
    console.log([row.label, row.p50, row.p95, row.queries].join('\t'))
  }
  console.log(
    `\nN+1 MUHAFIZI: 50 satır → ${report.nPlusOneGuard.pageSize50} sorgu, ` +
      `100 satır → ${report.nPlusOneGuard.pageSize100} sorgu, ` +
      `sabit mi: ${report.nPlusOneGuard.constant ? 'EVET' : 'HAYIR'}`,
  )
  console.log(`\nKAPSAM: ${report.scopeCaveat}\n`)
}
