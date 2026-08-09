// ETİKET PAKETİ ÜRETİM HAZIRLIK ÖLÇÜMÜ — AŞAMA 4.
//
// ═══ KAPSAM ══════════════════════════════════════════════════════════════
//
// İKİ İŞ YÜKÜ AYRI ÖLÇÜLÜR ve BİRBİRİNE KARIŞTIRILMAZ:
//   A) HAZIRLAMA  — taşıyıcı hazır, artefakt üretilecek
//   B) HAZIR BASKI — artefakt zaten kalıcı, yalnız iş kurulacak
//
// GERÇEK SÜRAT API ÇAĞRISI YOKTUR. Sağlayıcı gecikmesi ölçüme KARIŞMAZ:
// bu betik yalnız iç mimariyi ölçer (DB, toplama, composer, ek sayfa
// planlayıcı, doğrulama, kalıcılık, iş kurucu).
//
// ÜRETİM VERİTABANI KULLANILMAZ: hermetik PGlite. Betik salt ölçümdür;
// üretim şemasına, kayıtlara veya sağlayıcıya DOKUNMAZ.
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

/* eslint-disable @typescript-eslint/no-explicit-any */
const schema: any = await import('../db/schema.ts')
const encryption: any = await import('../shipments/shipmentEncryption.ts')
const repo: any = await import('../shipments/printZplRepository.ts')
const preparer: any = await import('../shipments/labelBundlePreparer.ts')
const readiness: any = await import('../shipments/printReadinessService.ts')
const jobBuilder: any = await import('../../src/utils/printableLabelJob.ts')
const { sha256Hex }: any = await import('../../src/utils/augmentedSuratZpl.ts')

const ZPL = readFileSync(join(root, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const NOW = '2026-08-09T00:00:00.000Z'

const ORDER_COUNT = Number(process.env.BENCH_ORDERS ?? 4000)
const INJECTION_CONCURRENCIES = (process.env.BENCH_CONCURRENCY ?? '10,25,50')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const READY_BATCHES = [25, 50, 100, 250]
const READINESS_BATCHES = [25, 50, 100]

// ── DETERMİNİSTİK VERİ SETİ ───────────────────────────────────────────────
//
// Tohumlu (seeded) üretici: aynı komut AYNI veri setini üretir. Rastgelelik
// yok → koşular karşılaştırılabilir.
function makeRng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const LONG_NAME = Array.from({ length: 14 }, (_, i) => `CokUzunUrunAdi${i}`).join(
  ' ',
)

/** Gerçekçi karışım: tek ürün ağırlıklı, 8 ürünlü sınıf ANLAMLI oranda. */
const PROFILES = [
  { key: '1-product', weight: 34, lines: 1, distinct: 1, quantity: 1 },
  { key: '2-different', weight: 20, lines: 2, distinct: 2, quantity: 1 },
  { key: 'same-variant-qty', weight: 12, lines: 1, distinct: 1, quantity: 4 },
  { key: '3-different', weight: 12, lines: 3, distinct: 3, quantity: 1 },
  { key: '4-different', weight: 9, lines: 4, distinct: 4, quantity: 1 },
  { key: '8-different', weight: 10, lines: 8, distinct: 8, quantity: 1 },
  { key: 'long-names', weight: 3, lines: 3, distinct: 3, quantity: 1, long: true },
]

function pickProfile(rng: () => number) {
  const total = PROFILES.reduce((sum, p) => sum + p.weight, 0)
  let roll = rng() * total
  for (const profile of PROFILES) {
    roll -= profile.weight
    if (roll <= 0) return profile
  }
  return PROFILES[0]
}

const COLORS = ['Lacivert', 'Ekru', 'Siyah', 'Vizon', 'Bordo']
const SIZES = ['36', '38', '40', '42', 'STD']

function buildLines(profile: (typeof PROFILES)[number], index: number) {
  return Array.from({ length: profile.lines }, (_, line) => ({
    productName: profile.long
      ? `${LONG_NAME} ${index}-${line}`
      : `Urun ${index}-${line}`,
    quantity: profile.quantity,
    color: COLORS[(index + line) % COLORS.length],
    size: SIZES[(index + line) % SIZES.length],
    sku: `SKU-${index}-${line}`,
  }))
}

/** Geometri hatası üreten KALICI hata sınıfı (madde 12). */
function permanentFailureLines(index: number) {
  return Array.from({ length: 3 }, (_, line) => ({
    productName: Array.from({ length: 220 }, (_, w) => `Sozcuk${w}`).join(' '),
    quantity: 1,
    color: 'Lacivert',
    size: '40',
    sku: `PERMFAIL-${index}-${line}`,
  }))
}

// ── ÖLÇÜM YARDIMCILARI ────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Number(sorted[Math.max(0, rank)].toFixed(3))
}
const mb = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(1))
const rss = () => process.memoryUsage().rss

/** Event-loop gecikmesi örnekleyici — donma/blokaj görünür olsun. */
function startLagSampler() {
  const samples: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    samples.push(Math.max(0, now - last - 20))
    last = now
  }, 20)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      return {
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        max: Number(Math.max(0, ...samples).toFixed(3)),
        samples: samples.length,
      }
    },
  }
}

function migrationStatements(): string[] {
  const dir = join(root, '..', 'drizzle')
  const out: string[] = []
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

/** Sorgu sayan sarmalayıcı — N+1 kanıtı için. */
function countingDb(db: any) {
  const counters = { select: 0, update: 0, insert: 0, transaction: 0 }
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (
        property === 'select' ||
        property === 'update' ||
        property === 'insert' ||
        property === 'transaction'
      ) {
        counters[property as keyof typeof counters] += 1
        return (target as any)[property].bind(target)
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { proxy, counters }
}

async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}

interface SeedResult {
  organizationId: string
  keys: Array<{
    organizationId: string
    marketplace: string
    packageId: string
    provider: string
  }>
  distribution: Record<string, number>
  permanentFailureCount: number
}

/**
 * Veri setini yazar. `withArtifact` true ise artefakt DA üretilir
 * (HAZIR BASKI iş yükü için başlangıç durumu).
 */
async function seedDataset(
  db: any,
  count: number,
  options: { withArtifact?: boolean; permanentFailures?: number; seed?: number } = {},
): Promise<SeedResult> {
  const rng = makeRng(options.seed ?? 20260809)
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'bench', slug: `bench-${randomBytes(4).toString('hex')}` })
    .returning()
  const distribution: Record<string, number> = {}
  const keys: SeedResult['keys'] = []
  const permanentFailures = options.permanentFailures ?? 0

  const orderRows: any[] = []
  const shipmentRows: any[] = []
  const lineRows: Array<{ packageId: string; lines: any[] }> = []

  for (let index = 0; index < count; index += 1) {
    const packageId = `BENCH-${index}`
    const isPermanentFailure = index < permanentFailures
    const profile = isPermanentFailure
      ? { key: 'permanent-failure' }
      : pickProfile(rng)
    distribution[profile.key] = (distribution[profile.key] ?? 0) + 1
    const lines = isPermanentFailure
      ? permanentFailureLines(index)
      : buildLines(profile as (typeof PROFILES)[number], index)

    const basePayload = {
      technicalZpl: ZPL,
      orderNumber: `ORD-${index}`,
      packageId,
      aliciAdi: 'SENTETIK ALICI',
    }
    const payload = options.withArtifact
      ? repo.attachPrintZplArtifact(basePayload, lines, NOW)
      : basePayload

    orderRows.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `ORD-${index}`,
      orderDate: new Date('2026-08-01T00:00:00.000Z'),
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
      carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
    })
    lineRows.push({ packageId, lines })
    keys.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      provider: 'surat',
    })
  }

  // Toplu yazım — seed süresi ölçüme dahil DEĞİL.
  const chunk = 250
  for (let index = 0; index < orderRows.length; index += chunk) {
    await db.insert(schema.orders).values(orderRows.slice(index, index + chunk))
  }
  const persistedOrders = await db.select().from(schema.orders)
  const orderIdByPackage = new Map(
    persistedOrders.map((row: any) => [String(row.packageId), String(row.id)]),
  )
  const allLines: any[] = []
  for (const entry of lineRows) {
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
    await db
      .insert(schema.shipments)
      .values(shipmentRows.slice(index, index + chunk))
  }
  return {
    organizationId: org.id,
    keys,
    distribution,
    permanentFailureCount: permanentFailures,
  }
}

/** Kalıcı artefaktları okuyup doğruluk denetimi yapar. */
async function auditArtifacts(db: any) {
  const rows = await db.select().from(schema.shipments)
  const audit = {
    total: rows.length,
    withArtifact: 0,
    withoutArtifact: 0,
    supplementalPages: 0,
    duplicateArtifact: 0,
    partialBundle: 0,
    missingProductBlock: 0,
    pageOrderViolation: 0,
    hashMismatch: 0,
    carrierOnlyAboveThreshold: 0,
  }
  const seen = new Set<string>()
  for (const row of rows) {
    const payload =
      encryption.decryptShipmentPayload(row.carrierPayloadEncrypted) ?? {}
    const artifact = payload.printZplArtifact
    if (!artifact) {
      audit.withoutArtifact += 1
      continue
    }
    audit.withArtifact += 1
    const identity = `${row.organizationId} ${row.packageId}`
    if (seen.has(identity)) audit.duplicateArtifact += 1
    seen.add(identity)

    const labels = artifact.supplementalLabels ?? []
    audit.supplementalPages += labels.length
    const lineCount = artifact.productSnapshot?.aggregatedLineCount ?? 0
    if (lineCount > repo.SUPPLEMENTAL_REQUIRED_ABOVE) {
      if (artifact.supplementalStatus !== 'ready' || labels.length === 0) {
        audit.carrierOnlyAboveThreshold += 1
      }
    }
    const verdict = repo.verifyBundleInvariants(artifact)
    if (!verdict.ok) audit.partialBundle += 1
    for (const [index, label] of labels.entries()) {
      if (label.page !== index + 1 || label.totalPages !== labels.length) {
        audit.pageOrderViolation += 1
      }
    }
    // Sayfa hash'leri ve taşıyıcı hash'i.
    const job = jobBuilder.buildPrintableJob({
      carrierZpl: artifact.printZpl,
      supplementalLabels: labels,
      hash: sha256Hex,
    })
    if (!job.printReady) audit.partialBundle += 1
    const blocks = labels.reduce(
      (total: number, label: any) =>
        total + (String(label.zpl).match(/\^FO\d+,\d+\^GB/g) ?? []).length,
      0,
    )
    if (lineCount > repo.SUPPLEMENTAL_REQUIRED_ABOVE && blocks === 0) {
      audit.missingProductBlock += 1
    }
  }
  return audit
}

// ── A) HAZIRLAMA İŞ YÜKÜ ──────────────────────────────────────────────────

async function runPreparation(injectionConcurrency: number) {
  const { pglite, db } = await makeDb()
  const seeded = await seedDataset(db, ORDER_COUNT, { permanentFailures: 20 })
  preparer.__resetBundlePreparer()

  const rssBefore = rss()
  let rssPeak = rssBefore
  const durations: number[] = []
  let maxQueueDepth = 0
  let rejected = 0
  const lag = startLagSampler()
  // HTTP-BENZERİ PROBE: 50 ms'de bir çalışması BEKLENEN bir zamanlayıcı.
  // Kaçırılan tik sayısı, sunucunun cevap veremediği süreyi temsil eder.
  const probe = { ticks: 0, gaps: [] as number[] }
  let probeLast = performance.now()
  const probeTimer = setInterval(() => {
    const now = performance.now()
    probe.ticks += 1
    probe.gaps.push(now - probeLast)
    probeLast = now
  }, 50)
  probeTimer.unref?.()
  const started = performance.now()

  // ÜRETİCİ: kuyruk sınırına saygı duyar. Kuyruk doluysa iş DÜŞÜRÜLMEZ;
  // yer açılana kadar beklenir (geri-basınç). Bu, üretimdeki doğru
  // producer davranışının ta kendisidir ve ölçülen şey de budur.
  let cursor = 0
  const producers = Array.from({ length: injectionConcurrency }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= seeded.keys.length) return
      const key = seeded.keys[index]
      const enqueueStart = performance.now()
      for (;;) {
        const stats = preparer.bundlePrepareStats()
        maxQueueDepth = Math.max(maxQueueDepth, stats.pending)
        if (preparer.enqueueBundlePreparation(db, key)) break
        const after = preparer.bundlePrepareStats()
        if (after.rejected > rejected) {
          rejected = after.rejected
          // GERİ BASINÇ: kuyruk dolu → bir tur bekle, İŞ KAYBETME.
          await new Promise((resolve) => setImmediate(resolve))
          continue
        }
        break // dedupe → bu anahtar zaten kuyrukta
      }
      durations.push(performance.now() - enqueueStart)
      rssPeak = Math.max(rssPeak, rss())
    }
  })
  await Promise.all(producers)
  await preparer.drainBundlePreparation()
  const totalMs = performance.now() - started
  clearInterval(probeTimer)
  const lagResult = lag.stop()
  rssPeak = Math.max(rssPeak, rss())

  const stats = preparer.bundlePrepareStats()
  const audit = await auditArtifacts(db)
  const rssAfter = rss()
  await pglite.close()

  return {
    injectionConcurrency,
    workerConcurrency: preparer.PREPARE_CONCURRENCY,
    orders: ORDER_COUNT,
    totalSeconds: Number((totalMs / 1000).toFixed(2)),
    ordersPerSecond: Number((ORDER_COUNT / (totalMs / 1000)).toFixed(1)),
    labelsPerSecond: Number(
      ((audit.withArtifact + audit.supplementalPages) / (totalMs / 1000)).toFixed(1),
    ),
    enqueueP50: percentile(durations, 50),
    enqueueP95: percentile(durations, 95),
    enqueueP99: percentile(durations, 99),
    maxQueueDepth,
    queueLimit: preparer.PREPARE_QUEUE_LIMIT,
    rejectedEvents: stats.rejected,
    dedupedJobs: stats.deduped,
    preparedArtifacts: stats.prepared,
    alreadyReady: stats.alreadyReady,
    failedJobs: stats.failed,
    eventLoopLag: lagResult,
    responsivenessProbe: {
      expectedTicks: Math.floor(totalMs / 50),
      actualTicks: probe.ticks,
      maxGapMs: Number(Math.max(0, ...probe.gaps).toFixed(2)),
      p95GapMs: percentile(probe.gaps, 95),
      p50GapMs: percentile(probe.gaps, 50),
    },
    rssBeforeMb: mb(rssBefore),
    rssPeakMb: mb(rssPeak),
    rssAfterMb: mb(rssAfter),
    audit,
    distribution: seeded.distribution,
    permanentFailureFixtures: seeded.permanentFailureCount,
  }
}

// ── B) HAZIR BASKI İŞ YÜKÜ ────────────────────────────────────────────────

async function runReadyPrint() {
  const { pglite, db } = await makeDb()
  const seeded = await seedDataset(db, Math.min(ORDER_COUNT, 1000), {
    withArtifact: true,
    seed: 777,
  })
  const results: any[] = []
  const rows = await db.select().from(schema.shipments)
  const artifacts = rows
    .map((row: any) => {
      const payload =
        encryption.decryptShipmentPayload(row.carrierPayloadEncrypted) ?? {}
      return payload.printZplArtifact
    })
    .filter(Boolean)

  for (const batchSize of READY_BATCHES) {
    if (artifacts.length < batchSize) continue
    const durationsRaw: number[] = []
    const durationsBrowser: number[] = []
    let pages = 0
    let bytes = 0
    const rssStart = rss()
    let rssPeak = rssStart
    const rounds = 20
    for (let round = 0; round < rounds; round += 1) {
      const slice = artifacts.slice(
        (round * batchSize) % Math.max(1, artifacts.length - batchSize),
        ((round * batchSize) % Math.max(1, artifacts.length - batchSize)) + batchSize,
      )
      // HAM ZPL İŞİ (local-agent yolu).
      const rawStart = performance.now()
      const batch = jobBuilder.buildBatchPrintableJob(
        slice.map((artifact: any) => ({
          carrierZpl: artifact.printZpl,
          supplementalLabels: artifact.supplementalLabels ?? [],
        })),
      )
      durationsRaw.push(performance.now() - rawStart)
      pages = batch.labelPageCount
      bytes = batch.combinedZpl.length

      // TARAYICI YOLU yükü: sayfa başına ayrı iş kurulur (PNG render
      // BENCHMARK DIŞI — sunucu render ucu ayrı ölçülür).
      const browserStart = performance.now()
      for (const artifact of slice) {
        jobBuilder.buildPrintableJob({
          carrierZpl: artifact.printZpl,
          supplementalLabels: artifact.supplementalLabels ?? [],
        })
      }
      durationsBrowser.push(performance.now() - browserStart)
      rssPeak = Math.max(rssPeak, rss())
    }
    results.push({
      batchSize,
      rawZplJob: {
        p50: percentile(durationsRaw, 50),
        p95: percentile(durationsRaw, 95),
        p99: percentile(durationsRaw, 99),
      },
      browserPayload: {
        p50: percentile(durationsBrowser, 50),
        p95: percentile(durationsBrowser, 95),
        p99: percentile(durationsBrowser, 99),
      },
      pagesPerJob: pages,
      bytesPerJob: bytes,
      rssPeakMb: mb(rssPeak),
    })
  }

  // HAZIR BASKI YOLUNDA YAZMA / ÜRETİM OLMADIĞI KANITI.
  const { proxy, counters } = countingDb(db)
  const key = seeded.keys[0]
  await repo.resolvePrintableLabelForServing(proxy, key, {
    loadItems: async () => {
      throw new Error('HAZIR yolda ürün toplama ÇAĞRILMAMALI')
    },
  })
  await pglite.close()
  return {
    batches: results,
    readyPathQueries: counters,
  }
}

// ── HAZIRLIK DURUMU UCU ───────────────────────────────────────────────────

async function runReadiness() {
  const { pglite, db } = await makeDb()
  await seedDataset(db, 300, { withArtifact: true, seed: 555 })
  const rows = await db.select().from(schema.shipments)
  const ids = rows.map((row: any) => String(row.id))
  const results: any[] = []
  for (const batchSize of READINESS_BATCHES) {
    const slice = ids.slice(0, batchSize)
    const { proxy, counters } = countingDb(db)
    const started = performance.now()
    const entries = await readiness.loadPrintReadiness(
      proxy,
      String(rows[0].organizationId),
      slice,
    )
    const durationMs = performance.now() - started
    results.push({
      ids: batchSize,
      durationMs: Number(durationMs.toFixed(2)),
      selectQueries: counters.select,
      writes: counters.update + counters.insert,
      decryptCount: batchSize,
      responseBytes: JSON.stringify(entries).length,
      allReady: entries.every((entry: any) => entry.carrierPrintReady),
    })
  }
  await pglite.close()
  return { maxIds: readiness.MAX_READINESS_IDS, results }
}

// ── EN KÖTÜ DURUM: 8 FARKLI ÜRÜN ──────────────────────────────────────────

async function runWorstCase() {
  const { pglite, db } = await makeDb()
  const count = Math.min(500, ORDER_COUNT)
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'worst', slug: `worst-${randomBytes(4).toString('hex')}` })
    .returning()
  const keys: any[] = []
  for (let index = 0; index < count; index += 1) {
    const packageId = `WORST-${index}`
    const [order] = await db
      .insert(schema.orders)
      .values({
        organizationId: org.id,
        marketplace: 'Trendyol',
        packageId,
        orderNumber: `W-${index}`,
        orderDate: new Date('2026-08-01T00:00:00.000Z'),
        operationStatus: 'LABEL_READY',
      })
      .returning()
    await db.insert(schema.orderLines).values(
      Array.from({ length: 8 }, (_, line) => ({
        organizationId: org.id,
        orderId: order.id,
        externalLineId: `L-${line}`,
        productName: `${LONG_NAME} ${index}-${line}`,
        merchantSku: `WSKU-${index}-${line}`,
        quantity: 1,
        variantAttributes: [],
      })),
    )
    await db.insert(schema.shipments).values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `W-${index}`,
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      carrierPayloadEncrypted: encryption.encryptShipmentPayload({
        technicalZpl: ZPL,
        orderNumber: `W-${index}`,
        packageId,
        aliciAdi: 'SENTETIK ALICI',
      }),
    })
    keys.push({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      provider: 'surat',
    })
  }
  preparer.__resetBundlePreparer()
  const rssBefore = rss()
  let rssPeak = rssBefore
  const started = performance.now()
  for (const key of keys) {
    for (;;) {
      if (preparer.enqueueBundlePreparation(db, key)) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    rssPeak = Math.max(rssPeak, rss())
  }
  await preparer.drainBundlePreparation()
  const totalMs = performance.now() - started
  const audit = await auditArtifacts(db)
  await pglite.close()
  return {
    orders: count,
    totalSeconds: Number((totalMs / 1000).toFixed(2)),
    ordersPerSecond: Number((count / (totalMs / 1000)).toFixed(1)),
    supplementalPagesPerOrder: Number(
      (audit.supplementalPages / Math.max(1, audit.withArtifact)).toFixed(2),
    ),
    rssPeakMb: mb(rssPeak),
    audit,
  }
}

// ── DEĞİŞMEZLİK ÖRNEKLEMESİ ───────────────────────────────────────────────

async function runImmutabilitySample() {
  const { pglite, db } = await makeDb()
  const seeded = await seedDataset(db, 120, { withArtifact: true, seed: 999 })
  const sample = seeded.keys.slice(0, 100)
  const before = new Map<string, any>()
  for (const key of sample) {
    const [row] = await db
      .select()
      .from(schema.shipments)
      .where(eq(schema.shipments.packageId, key.packageId))
    const artifact = encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
      ?.printZplArtifact
    before.set(key.packageId, {
      printZplSha256: artifact?.printZplSha256,
      supplementalCount: (artifact?.supplementalLabels ?? []).length,
    })
  }
  // KAYNAK ÜRÜN VERİSİ DEĞİŞTİRİLİR: yeniden compose edilseydi hash değişirdi.
  await db
    .update(schema.orderLines)
    .set({ productName: 'MUTASYONA UGRAMIS URUN ADI' })
  let recomposed = 0
  let hashChanged = 0
  for (const key of sample) {
    await repo.resolvePersistedPrintableLabel(db, key, {
      loadItems: async () => {
        recomposed += 1
        return []
      },
    })
    const [row] = await db
      .select()
      .from(schema.shipments)
      .where(eq(schema.shipments.packageId, key.packageId))
    const artifact = encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
      ?.printZplArtifact
    const snapshot = before.get(key.packageId)
    if (
      artifact?.printZplSha256 !== snapshot.printZplSha256 ||
      (artifact?.supplementalLabels ?? []).length !== snapshot.supplementalCount
    ) {
      hashChanged += 1
    }
  }
  await pglite.close()
  return { sampled: sample.length, recomposed, hashChanged }
}

// ── KUYRUK DOYMASI (üretici geri basınç UYGULAMAZSA) ──────────────────────

async function runQueueSaturation() {
  const { pglite, db } = await makeDb()
  const seeded = await seedDataset(db, Math.min(ORDER_COUNT, 4000), { seed: 4242 })
  preparer.__resetBundlePreparer()
  const rssBefore = rss()
  // NAİF ÜRETİCİ: 4000 işi TEK SEFERDE, geri basınç UYGULAMADAN kuyruğa atar.
  let accepted = 0
  let refused = 0
  for (const key of seeded.keys) {
    if (preparer.enqueueBundlePreparation(db, key)) accepted += 1
    else refused += 1
  }
  const statsAtPeak = preparer.bundlePrepareStats()
  await preparer.drainBundlePreparation()
  const auditAfterBurst = await auditArtifacts(db)
  // GERİ KAZANIM: reddedilen adaylar DB'de "taşıyıcı hazır + artefakt yok"
  // olarak durur. Periyodik mutabakatın sınırlı turları onları alır.
  const recovery = await preparer.reconcileUntilDrained(db)
  const auditAfterRecovery = await auditArtifacts(db)
  const rssAfter = rss()
  await pglite.close()
  return {
    injected: seeded.keys.length,
    accepted,
    refused,
    rejectedCounter: statsAtPeak.rejected,
    dedupedCounter: statsAtPeak.deduped,
    preparedAfterBurst: auditAfterBurst.withArtifact,
    unpreparedAfterBurst: auditAfterBurst.withoutArtifact,
    recoveryCycles: recovery.cycles,
    preparedAfterRecovery: auditAfterRecovery.withArtifact,
    remainingEligibleAfterRecovery: auditAfterRecovery.withoutArtifact,
    permanentFailureFixtures: 0,
    lostPreparationCandidates:
      seeded.keys.length -
      auditAfterRecovery.withArtifact -
      auditAfterRecovery.withoutArtifact,
    audit: auditAfterRecovery,
    rssBeforeMb: mb(rssBefore),
    rssAfterMb: mb(rssAfter),
  }
}

// ── MUTABAKAT SINIRI ──────────────────────────────────────────────────────

async function runReconciliationLimit() {
  const results: any[] = []
  for (const pending of [260, 1000]) {
    const { pglite, db } = await makeDb()
    await seedDataset(db, pending, { seed: 31337 + pending })
    preparer.__resetBundlePreparer()
    const first = await preparer.reconcilePendingBundles(db)
    await preparer.drainBundlePreparation()
    const afterFirst = await auditArtifacts(db)
    // Sonraki SINIRLI turlar imleçle ilerler; aynı ilk 200'e takılmaz.
    const drained = await preparer.reconcileUntilDrained(db)
    const afterDrain = await auditArtifacts(db)
    await pglite.close()
    results.push({
      pendingRecords: pending,
      scanLimit: preparer.RECONCILE_SCAN_LIMIT,
      firstCycle: first,
      remainingAfterFirstCycle: afterFirst.withoutArtifact,
      cyclesToDrain: drained.cycles,
      remainingAfterDrain: afterDrain.withoutArtifact,
      preparedTotal: afterDrain.withArtifact,
      audit: afterDrain,
    })
  }
  return {
    periodicIntervalMs: preparer.RECONCILE_INTERVAL_MS,
    bootOnly: false,
    results,
  }
}

// ── KALICI HATA DÖNGÜSÜ ───────────────────────────────────────────────────

async function runPermanentFailure() {
  const { pglite, db } = await makeDb()
  const seeded = await seedDataset(db, 40, { permanentFailures: 40, seed: 606 })
  preparer.__resetBundlePreparer()
  const rounds = 5
  const started = performance.now()
  for (let round = 0; round < rounds; round += 1) {
    for (const key of seeded.keys) preparer.enqueueBundlePreparation(db, key)
    await preparer.drainBundlePreparation()
  }
  const totalMs = performance.now() - started
  const stats = preparer.bundlePrepareStats()
  // MUTABAKAT DÖNGÜSÜ HOT-LOOP YARATIYOR MU? Sınırlı turlar kalıcı hatalı
  // kayıtları görür ama tur sayısı ÜST SINIRLIDIR ve turlar arasında
  // periyot beklenir; sürekli CPU/DB dövülmez.
  preparer.__resetBundlePreparer()
  const cycleStart = performance.now()
  const drained = await preparer.reconcileUntilDrained(db, { maxCycles: 10 })
  const cycleMs = performance.now() - cycleStart
  const cycleStats = preparer.bundlePrepareStats()
  const audit = await auditArtifacts(db)
  await pglite.close()
  return {
    records: seeded.keys.length,
    rounds,
    attempts: stats.failed,
    backoff: 'YOK — kalıcı hatalı kayıt her mutabakat turunda yeniden denenir',
    msPerAttempt: Number((totalMs / Math.max(1, stats.failed)).toFixed(2)),
    totalSeconds: Number((totalMs / 1000).toFixed(2)),
    persistedArtifacts: audit.withArtifact,
    reconcileCycles: drained.cycles,
    reconcileAttempts: cycleStats.failed,
    reconcileSeconds: Number((cycleMs / 1000).toFixed(2)),
    hotLoop: drained.cycles >= 10,
  }
}

// ── KOŞU ──────────────────────────────────────────────────────────────────

async function main() {
  const report: any = {
    generatedAtNote: 'zaman damgası çağıran katmandan; betik saat okumaz',
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: (await import('node:os')).cpus().length,
      totalMemMb: mb((await import('node:os')).totalmem()),
      database: 'PGlite (hermetik, üretim DB kullanılmaz)',
      providerCalls: 0,
    },
    config: {
      orders: ORDER_COUNT,
      injectionConcurrencies: INJECTION_CONCURRENCIES,
      workerConcurrency: preparer.PREPARE_CONCURRENCY,
      queueLimit: preparer.PREPARE_QUEUE_LIMIT,
      reconcileScanLimit: preparer.RECONCILE_SCAN_LIMIT,
    },
    preparation: [] as any[],
  }

  for (const concurrency of INJECTION_CONCURRENCIES) {
    process.stderr.write(`[bench] hazırlama · injection=${concurrency}\n`)
    report.preparation.push(await runPreparation(concurrency))
  }
  process.stderr.write('[bench] hazır baskı\n')
  report.readyPrint = await runReadyPrint()
  process.stderr.write('[bench] hazırlık durumu ucu\n')
  report.readiness = await runReadiness()
  process.stderr.write('[bench] en kötü durum (8 ürün)\n')
  report.worstCase = await runWorstCase()
  process.stderr.write('[bench] değişmezlik örneklemesi\n')
  report.immutability = await runImmutabilitySample()
  process.stderr.write('[bench] kuyruk doyması\n')
  report.queueSaturation = await runQueueSaturation()
  process.stderr.write('[bench] mutabakat sınırı\n')
  report.reconciliation = await runReconciliationLimit()
  process.stderr.write('[bench] kalıcı hata döngüsü\n')
  report.permanentFailure = await runPermanentFailure()

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
