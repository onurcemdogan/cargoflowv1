// PROJEKSİYON GERİ DOLDURMA (CLI).
//
// Kullanım:
//   npm run projection:backfill -- --org <organizationId> --dry-run
//   npm run projection:backfill -- --org <organizationId> --batch-size 500
//   npm run projection:backfill -- --org <organizationId> --resume
//   npm run projection:backfill -- --org <organizationId> --cursor <orderId>
//   npm run projection:backfill -- --org <organizationId> --max-batches 5
//
// `--org` ZORUNLUDUR: kazara tüm-tenant koşumu mümkün değildir.
// Taşıyıcı/pazaryeri çağrısı YAPMAZ. Yalnız projeksiyon tablosuna yazar.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  countUncoveredOrders,
  resolveResumeCursor,
  runProjectionBackfill,
} from './orderProjectionBackfill.ts'

function readArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)

const mask = (value: string): string =>
  value.length <= 4 ? '****' : `****${value.slice(-4)}`

export async function runProjectionBackfillCli(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[projection:backfill] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = readArg('org')
  if (!organizationId) {
    console.error(
      '[projection:backfill] --org ZORUNLU. Tüm tenantlar için tek komut YOKTUR.',
    )
    return 1
  }
  const db = getDb()
  const dryRun = hasFlag('dry-run')
  const from = hasFlag('resume')
    ? ((await resolveResumeCursor(db, organizationId)) ?? undefined)
    : undefined

  if (hasFlag('resume')) {
    console.info(
      `[projection:backfill] devam noktası ${from ? mask(from) : '(kapsama TAM)'}`,
    )
  }

  const summary = await runProjectionBackfill(db, {
    organizationId,
    batchSize: Number(readArg('batch-size')) || undefined,
    maxBatches: Number(readArg('max-batches')) || undefined,
    cursor: readArg('cursor') || undefined,
    from,
    dryRun,
  })

  console.info(`ORGANIZATION      ${mask(summary.organizationId)}`)
  console.info(`MODE              ${dryRun ? 'DRY_RUN' : 'WRITE'}`)
  console.info(`SCANNED           ${summary.scanned}`)
  console.info(`WRITTEN           ${summary.written}`)
  console.info(`SKIPPED_STALE     ${summary.skippedStale}`)
  console.info(`BATCHES           ${summary.batches}`)
  console.info(`DONE              ${summary.done ? 'YES' : 'NO'}`)
  if (!summary.done && summary.nextCursor) {
    console.info(`NEXT_CURSOR       ${summary.nextCursor}`)
  }
  const uncovered = await countUncoveredOrders(db, organizationId)
  console.info(`UNCOVERED_ORDERS  ${uncovered}`)
  if (summary.skippedStale > 0) {
    console.info(
      '[projection:backfill] Bazı satırlar canlı yazım daha yeni olduğu için',
    )
    console.info('  atlandı (doğru davranış). Kapsama için koşumu tekrarlayın.')
  }
  return 0
}

const invokedDirectly = process.argv[1]?.includes('orderProjectionBackfillCli')
if (invokedDirectly) {
  runProjectionBackfillCli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(
        '[projection:backfill] Geri doldurma başarısız:',
        error instanceof Error ? error.message : error,
      )
      process.exitCode = 2
    })
    .finally(() => closePool().catch(() => undefined))
}
