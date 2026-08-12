// CLI: YÜKSEK HACİM OKUMA BENCHMARK'I — HERMETİK, ÜRETİM DB'SİNE DOKUNMAZ.
//
//   npm run perf:orders:bench
//   npm run perf:orders:bench -- --scales 1000,10000,50000
//   npm run perf:orders:bench -- --scales 100000 --repeats 3
//
// Kendi PGlite örneğini kurar (migration dosyalarından), sentetik sipariş
// üretir ve GERÇEK üretim okuma yollarını ölçer. DATABASE_URL OKUMAZ, üretim
// verisine YAZMAZ, hiçbir provider/marketplace çağrısı YAPMAZ.
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

function migrationStatements(): string[] {
  const dir = join(here, '..', '..', 'drizzle')
  const out: string[] = []
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function main(): Promise<void> {
  // Şifreleme anahtarları YALNIZ bu süreç için üretilir; hiçbir yere yazılmaz.
  process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
  process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

  const scales = (parseArg('scales') ?? '1000,10000,50000')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  const repeats = Number(parseArg('repeats') ?? 5)
  const uiPageSize = Number(parseArg('uiPageSize') ?? 25)
  const loadPageSize = Number(parseArg('loadPageSize') ?? 100)

  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../db/schema.ts')
  const bench = await import('./orderReadBenchmark.ts')

  const report: Record<string, unknown>[] = []

  for (const scale of scales) {
    const raw = new PGlite()
    for (const statement of migrationStatements()) await raw.exec(statement)
    const { client, counter } = bench.withQueryCounter(raw)
    const db = drizzle(client as never, { schema }) as never
    const rawDb = drizzle(raw as never, { schema }) as never

    const orgRows = (await (rawDb as never as {
      execute: (q: unknown) => Promise<{ rows?: Record<string, string>[] }>
    }).execute(
      (await import('drizzle-orm')).sql.raw(
        `insert into organizations (name, slug) values ('Perf','perf-${scale}') returning id`,
      ),
    )) as { rows?: Record<string, string>[] } | Record<string, string>[]
    const organizationId = String(
      (Array.isArray(orgRows) ? orgRows[0] : orgRows.rows?.[0])?.id,
    )
    const accountRows = (await (rawDb as never as {
      execute: (q: unknown) => Promise<{ rows?: Record<string, string>[] }>
    }).execute(
      (await import('drizzle-orm')).sql.raw(
        `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
         values ('${organizationId}','Trendyol','277221',true) returning id`,
      ),
    )) as { rows?: Record<string, string>[] } | Record<string, string>[]
    const marketplaceAccountId = String(
      (Array.isArray(accountRows) ? accountRows[0] : accountRows.rows?.[0])?.id,
    )

    const seedStart = Date.now()
    await bench.seedOrders(rawDb as never, {
      organizationId,
      marketplaceAccountId,
      count: scale,
    })
    const seedMs = Date.now() - seedStart

    // ── 1) Orders sayfası (UI'da görünen 25 satır) ─────────────────────────
    const uiSamples = []
    for (let run = 0; run < repeats; run += 1) {
      uiSamples.push(
        await bench.measureOrdersPage(db, counter, organizationId, marketplaceAccountId, {
          page: 1,
          pageSize: uiPageSize,
        }),
      )
    }
    // ── 2) DERİN sayfa (büyük OFFSET etkisi) ──────────────────────────────
    const deepPage = Math.max(1, Math.floor(scale / loadPageSize))
    const deepSamples = []
    for (let run = 0; run < repeats; run += 1) {
      deepSamples.push(
        await bench.measureOrdersPage(db, counter, organizationId, marketplaceAccountId, {
          page: deepPage,
          pageSize: loadPageSize,
        }),
      )
    }
    // ── 3) Frontend'in GERÇEK yükü: tüm sayfalar ──────────────────────────
    const fullLoad = await bench.measureFullClientLoad(
      db,
      counter,
      organizationId,
      marketplaceAccountId,
      { pageSize: loadPageSize, maxPages: 200 },
    )
    // ── 4) Dashboard analitiği: cap'siz aralık ────────────────────────────
    // Ölçek büyüdükçe bu çağrı HATA verebilir (bind parametre sınırı). Hata
    // gizlenmez: ölçüm sonucu olarak RAPORLANIR.
    let analytics: Awaited<ReturnType<typeof bench.measureAnalyticsRange>> | null =
      null
    let analyticsError: string | null = null
    try {
      analytics = await bench.measureAnalyticsRange(
        db,
        counter,
        organizationId,
        marketplaceAccountId,
        { startMs: Date.UTC(2025, 0, 1), endMs: Date.UTC(2027, 0, 1) },
      )
    } catch (error) {
      analyticsError = String((error as Error).message).slice(0, 200)
    }
    const countMs = await bench.measureCountOnly(
      rawDb as never,
      organizationId,
      marketplaceAccountId,
    )

    // ── 5) EXPLAIN ANALYZE (en ağır okumalar) ─────────────────────────────
    const listSql =
      `select * from orders where organization_id = '${organizationId}' ` +
      `and marketplace_account_id = '${marketplaceAccountId}' ` +
      `order by order_date desc, id desc limit ${loadPageSize} offset ${(deepPage - 1) * loadPageSize}`
    const countSql =
      `select count(*)::int from orders where organization_id = '${organizationId}' ` +
      `and marketplace_account_id = '${marketplaceAccountId}'`
    const rangeSql =
      `select * from orders where organization_id = '${organizationId}' ` +
      `and marketplace_account_id = '${marketplaceAccountId}' ` +
      `and order_date >= '2025-01-01' and order_date <= '2027-01-01' order by order_date desc`
    const plans = {
      ordersListDeepPage: await bench.explain(rawDb as never, listSql),
      ordersCount: await bench.explain(rawDb as never, countSql),
      analyticsRange: await bench.explain(rawDb as never, rangeSql),
    }

    report.push({
      scale,
      seedMs,
      ordersPageUi: {
        pageSize: uiPageSize,
        totalMs: bench.stats(uiSamples.map((sample) => sample.totalMs)),
        dbMs: bench.stats(uiSamples.map((sample) => sample.dbMs)),
        serializeMs: bench.stats(uiSamples.map((sample) => sample.serializeMs)),
        queryCount: uiSamples[0]?.queryCount ?? 0,
        rowCount: uiSamples[0]?.rowCount ?? 0,
        payloadBytes: uiSamples[0]?.payloadBytes ?? 0,
      },
      ordersPageDeep: {
        page: deepPage,
        pageSize: loadPageSize,
        totalMs: bench.stats(deepSamples.map((sample) => sample.totalMs)),
        queryCount: deepSamples[0]?.queryCount ?? 0,
        payloadBytes: deepSamples[0]?.payloadBytes ?? 0,
      },
      fullClientLoad: {
        pageCount: fullLoad.pageCount,
        capExceeded: fullLoad.capExceeded,
        totalMs: fullLoad.totalMs,
        queryCount: fullLoad.queryCount,
        rowsFetched: fullLoad.rowCount,
        payloadBytes: fullLoad.payloadBytes,
        payloadMB: Math.round((fullLoad.payloadBytes / 1_048_576) * 100) / 100,
      },
      analyticsRange: analytics
        ? {
            totalMs: analytics.totalMs,
            dbMs: analytics.dbMs,
            serializeMs: analytics.serializeMs,
            rowCount: analytics.rowCount,
            payloadMB:
              Math.round((analytics.payloadBytes / 1_048_576) * 100) / 100,
            queryCount: analytics.queryCount,
          }
        : { failed: true, error: analyticsError },
      countOnlyMs: countMs,
      plans,
    })
    await raw.close()
  }

  // ── SERT SINIR: findLinesForOrders bind parametre eşiği ───────────────────
  // Ölçekten bağımsız, TEK kez ölçülür. Kimliklerin var olması gerekmez;
  // belirleyici olan parametre SAYISIDIR.
  const limitProbeDb = new PGlite()
  for (const statement of migrationStatements()) await limitProbeDb.exec(statement)
  const probeDb = drizzle(limitProbeDb as never, { schema }) as never
  const probeOrgRows = (await (probeDb as never as {
    execute: (q: unknown) => Promise<{ rows?: Record<string, string>[] }>
  }).execute(
    (await import('drizzle-orm')).sql.raw(
      `insert into organizations (name, slug) values ('Probe','probe') returning id`,
    ),
  )) as { rows?: Record<string, string>[] } | Record<string, string>[]
  const probeOrgId = String(
    (Array.isArray(probeOrgRows) ? probeOrgRows[0] : probeOrgRows.rows?.[0])?.id,
  )
  const inArrayProbe = await bench.probeInArrayLimit(
    probeDb,
    probeOrgId,
    [1000, 10_000, 30_000, 60_000, 65_000, 70_000, 100_000],
  )
  await limitProbeDb.close()

  console.log(
    JSON.stringify(
      {
        mode: 'hermetic_read_only',
        engine: 'PGlite (WASM PostgreSQL) — gerçek planlayıcı, ağ turu YOK',
        caveat:
          'MUTLAK ms üretimle birebir değildir; ÖLÇEKLENME, SORGU SAYISI ve ' +
          'PAYLOAD BOYUTU taşınabilir. Ağ turu maliyeti üretimde AYRICA vardır ' +
          've N+1 etkisini büyütür.',
        productionDatabaseTouched: false,
        results: report,
        // findLinesForOrders(inArray) sert sınırı: dashboard analitiği
        // aralıktaki TÜM sipariş id'lerini TEK sorguya koyar.
        inArrayHardLimitProbe: inArrayProbe,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error('benchmark başarısız:', (error as Error).message)
  process.exitCode = 1
})
