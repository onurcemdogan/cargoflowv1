// CLI: TRENDYOL `order_date` KAYMA KAPSAMI — TAMAMEN SALT OKUNUR.
//
//   npm run orders:orderdate:range
//   npm run orders:orderdate:range -- --org <uuid> --batch-size 500
//   npm run orders:orderdate:range -- --all-marketplaces
//
// YAPAR : TÜM erişilebilir veri setini keyset ile tarar; organizasyon, ay,
//         takvim günü, pazaryeri ve HAM DEĞER BİÇİMİ kırılımlarını, kaymış
//         ve doğru satırların EN ESKİ/EN YENİ sınırlarını raporlar.
// YAPMAZ: DB update/insert/delete · onarım · pazaryeri/taşıyıcı çağrısı.
//
// PII YOK: müşteri alanları ASLA okunmaz; ham yükten YALNIZ `orderDate`.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  auditTrendyolOrderDateRange,
  interpretRangeAudit,
} from './trendyolOrderDateRangeAudit.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[orderdate:range] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = parseArg('org') ?? null
  const result = await auditTrendyolOrderDateRange(getDb(), {
    organizationId,
    batchSize: positiveInt(parseArg('batch-size'), 500),
    startAfterId: parseArg('start-after') ?? null,
    allMarketplaces: hasFlag('all-marketplaces'),
  })
  console.info(
    JSON.stringify(
      {
        mode: 'DRY_RUN_READ_ONLY',
        mutation: 'NONE',
        organizationId: organizationId ?? '(tümü)',
        TOTAL: result.totals.total,
        DRIFTED: result.totals.drifted,
        CORRECT: result.totals.correct,
        RAW_MISSING: result.totals.rawMissing,
        RAW_UNPARSEABLE: result.totals.rawUnparseable,
        AMBIGUOUS: result.totals.ambiguous,
        // KARAR BURADA: kusur biçime mi bağlı, gerçek bir tarih kesmesi mi var?
        interpretation: interpretRangeAudit(result),
        byRawShape: result.byRawShape,
        byOrganization: result.byOrganization,
        byMarketplace: result.byMarketplace,
        byMonth: result.byMonth,
        byCalendarDate: result.byCalendarDate,
        earliestDrifted: result.earliestDrifted,
        latestDrifted: result.latestDrifted,
        earliestCorrect: result.earliestCorrect,
        latestCorrect: result.latestCorrect,
        scanned: result.scanned,
        batches: result.batches,
      },
      null,
      2,
    ),
  )
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    '[orderdate:range] Hata:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
