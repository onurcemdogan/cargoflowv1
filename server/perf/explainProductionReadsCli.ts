// CLI: ÜRETİM OKUMA PLANLARI — SALT OKUNUR, YAZMA MOTOR SEVİYESİNDE ENGELLİ.
//
//   npm run perf:explain
//   npm run perf:explain -- --org <uuid> --pageSize 100 --page 200
//   npm run perf:explain -- --analyzeOff        (yalnız plan, çalıştırma yok)
//
// Orders ekranı ve Dashboard'ın kullandığı EN AĞIR okumalar için gerçek
// üretim verisi üzerinde EXPLAIN (ANALYZE, BUFFERS) çalıştırır.
//
// GÜVENLİK: tüm sorgular `SET TRANSACTION READ ONLY` altında çalışır → motor
// herhangi bir yazmayı REDDEDER. EXPLAIN yalnız SELECT'lere uygulanır.
// Migration YOK · index create YOK · cleanup YOK · sipariş mutasyonu YOK.
//
// PII: hiçbir sipariş/müşteri alanı yazdırılmaz; yalnız plan metni, satır
// sayıları ve süreler raporlanır. Organizasyon/hesap kimlikleri plan metninde
// görünebileceği için maskelenir.
import { sql } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

type Executor = { execute: (query: unknown) => Promise<unknown> }

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const rows = (result as { rows?: Record<string, unknown>[] })?.rows
  return Array.isArray(rows) ? rows : []
}

/** UUID'leri plan metninden temizler (kimlik sızıntısı yok). */
function maskUuids(line: string): string {
  return line.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '<uuid>',
  )
}

interface PlanReport {
  name: string
  planLines: string[]
  scanTypes: string[]
  indexesUsed: string[]
  sequentialScans: number
  actualRows: number | null
  rowsRemovedByFilter: number | null
  executionTimeMs: number | null
  planningTimeMs: number | null
  sortMethod: string | null
  sortMemory: string | null
  estimatedRows: number | null
}

function summarizePlan(name: string, planLines: string[]): PlanReport {
  const lines = planLines.map(maskUuids)
  const joined = lines.join('\n')
  const scanTypes = Array.from(
    new Set(
      lines
        .map((line) => /(\w[\w ]*?(?:Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Bitmap Index Scan))/.exec(line)?.[1]?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const indexesUsed = Array.from(
    new Set(
      lines
        .map((line) => /using (\w+)/i.exec(line)?.[1])
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const number = (pattern: RegExp): number | null => {
    const match = pattern.exec(joined)
    return match ? Number(match[1]) : null
  }
  const text = (pattern: RegExp): string | null => pattern.exec(joined)?.[1] ?? null
  return {
    name,
    planLines: lines,
    scanTypes,
    indexesUsed,
    sequentialScans: lines.filter((line) => line.includes('Seq Scan')).length,
    actualRows: number(/actual time=[\d.]+\.\.[\d.]+ rows=([\d.]+)/),
    rowsRemovedByFilter: number(/Rows Removed by Filter: (\d+)/),
    executionTimeMs: number(/Execution Time: ([\d.]+) ms/),
    planningTimeMs: number(/Planning Time: ([\d.]+) ms/),
    sortMethod: text(/Sort Method: ([^\n]+?)(?:\s{2,}|$)/),
    sortMemory: text(/Memory: (\d+kB)/),
    estimatedRows: number(/rows=(\d+) width=/),
  }
}

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }
  const analyze = !hasFlag('analyzeOff')
  const pageSize = Number(parseArg('pageSize') ?? 100)
  const page = Number(parseArg('page') ?? 1)
  const offset = Math.max(0, (page - 1) * pageSize)
  const db = getDb()

  const reports: PlanReport[] = []
  let context: Record<string, unknown> = {}

  await (db as unknown as {
    transaction: (fn: (tx: Executor) => Promise<void>) => Promise<void>
  }).transaction(async (tx) => {
    // MOTOR SEVİYESİNDE YAZMA KİLİDİ: bundan sonra herhangi bir
    // INSERT/UPDATE/DELETE/DDL PostgreSQL tarafından REDDEDİLİR.
    await tx.execute(sql.raw('set transaction read only'))

    // Ölçülecek kapsam: en çok siparişi olan organizasyon + aktif hesabı.
    const scopeRows = rowsOf(
      await tx.execute(
        sql.raw(
          `select organization_id, marketplace_account_id, count(*)::int as total
             from orders group by 1, 2 order by total desc limit 1`,
        ),
      ),
    )
    const organizationId =
      parseArg('org') ?? String(scopeRows[0]?.organization_id ?? '')
    const accountId = scopeRows[0]?.marketplace_account_id
      ? String(scopeRows[0].marketplace_account_id)
      : null
    if (!organizationId) {
      console.error('orders tablosunda ölçülecek kapsam bulunamadı.')
      return
    }
    const accountClause = accountId
      ? `and marketplace_account_id = '${accountId}'`
      : 'and marketplace_account_id is null'

    // Tablo/index boyutları ve kullanım istatistikleri (yalnız katalog okuması).
    const sizes = rowsOf(
      await tx.execute(
        sql.raw(
          `select relname as table, n_live_tup as live_rows,
                  pg_size_pretty(pg_total_relation_size(relid)) as total_size
             from pg_stat_user_tables
            where relname in ('orders','order_lines','shipments','shipment_operations')
            order by n_live_tup desc`,
        ),
      ),
    )
    const indexUsage = rowsOf(
      await tx.execute(
        sql.raw(
          `select indexrelname as index, idx_scan as scans,
                  pg_size_pretty(pg_relation_size(indexrelid)) as size
             from pg_stat_user_indexes
            where relname in ('orders','order_lines','shipments','shipment_operations')
            order by idx_scan asc`,
        ),
      ),
    )
    context = {
      scopeOrderCount: Number(scopeRows[0]?.total ?? 0),
      accountScoped: accountId !== null,
      tableSizes: sizes,
      indexUsage,
      explainMode: analyze ? 'ANALYZE + BUFFERS' : 'plan only',
      pageProbed: page,
      pageSizeProbed: pageSize,
    }

    const prefix = analyze ? 'explain (analyze, buffers, timing)' : 'explain'
    const queries: Array<{ name: string; sql: string }> = [
      {
        // 1) Orders listesi — sayfa sorgusu (sıralama + OFFSET).
        name: 'ordersList',
        sql:
          `select * from orders where organization_id = '${organizationId}' ${accountClause} ` +
          `order by order_date desc, id desc limit ${pageSize} offset ${offset}`,
      },
      {
        // 2) Orders toplamı — HER sayfa isteğinde tekrar çalışır.
        name: 'ordersCount',
        sql:
          `select count(*)::int from orders where organization_id = '${organizationId}' ${accountClause}`,
      },
      {
        // 3) Sekme/durum sayaçları için statü kırılımı.
        name: 'ordersStatusBreakdown',
        sql:
          `select marketplace_status, count(*)::int from orders ` +
          `where organization_id = '${organizationId}' ${accountClause} group by 1`,
      },
      {
        // 4) Dashboard analitiği — cap'siz tarih aralığı (son 60 gün).
        name: 'analyticsRange60d',
        sql:
          `select * from orders where organization_id = '${organizationId}' ${accountClause} ` +
          `and order_date >= now() - interval '60 days' order by order_date desc`,
      },
      {
        // 5) Sipariş satırları — sayfa başına toplu getirme.
        name: 'orderLinesForPage',
        sql:
          `select * from order_lines where organization_id = '${organizationId}' ` +
          `and order_id in (select id from orders where organization_id = '${organizationId}' ` +
          `${accountClause} order by order_date desc, id desc limit ${pageSize})`,
      },
      {
        // 6) N+1'in TEK adımı: sipariş başına gönderi araması.
        name: 'shipmentLookupSingle',
        sql:
          `select * from shipments where organization_id = '${organizationId}' ` +
          `and marketplace = 'Trendyol' and package_id = ` +
          `(select package_id from orders where organization_id = '${organizationId}' ` +
          `${accountClause} order by order_date desc limit 1) and provider = 'surat'`,
      },
      {
        // 7) N+1'in ikinci adımı: pakete ait TÜM operasyonlar (LIMIT YOK).
        name: 'shipmentOperationsSingle',
        sql:
          `select * from shipment_operations where organization_id = '${organizationId}' ` +
          `and package_id = (select package_id from orders where organization_id = ` +
          `'${organizationId}' ${accountClause} order by order_date desc limit 1)`,
      },
    ]

    for (const query of queries) {
      try {
        const rows = rowsOf(await tx.execute(sql.raw(`${prefix} ${query.sql}`)))
        reports.push(
          summarizePlan(
            query.name,
            rows.map((row) => String(Object.values(row)[0] ?? '')),
          ),
        )
      } catch (error) {
        reports.push({
          name: query.name,
          planLines: [`HATA: ${String((error as Error).message).slice(0, 200)}`],
          scanTypes: [],
          indexesUsed: [],
          sequentialScans: 0,
          actualRows: null,
          rowsRemovedByFilter: null,
          executionTimeMs: null,
          planningTimeMs: null,
          sortMethod: null,
          sortMemory: null,
          estimatedRows: null,
        })
      }
    }
  })

  console.log(
    JSON.stringify(
      {
        mode: 'read_only_transaction',
        writesBlockedBy: 'SET TRANSACTION READ ONLY',
        migrationsRun: 0,
        indexesCreated: 0,
        context,
        plans: reports,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((error) => {
    console.error('explain başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
