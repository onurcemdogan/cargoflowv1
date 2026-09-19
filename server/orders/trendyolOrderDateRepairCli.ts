// CLI: TRENDYOL `orders.order_date` GEÇMİŞ ONARIMI. VARSAYILAN DRY-RUN.
//
//   # TAM KAPSAM DENETİMİ (yazma YOK) — önce bu çalıştırılır:
//   npm run orders:orderdate:repair -- --dry-run
//   npm run orders:orderdate:repair -- --org <uuid> --dry-run
//
//   # APPLY — AÇIK niyet şart; --org YOKSA BAŞLAMAZ:
//   npm run orders:orderdate:repair -- --org <uuid> --apply \
//     --confirm TRENDYOL_ORDERDATE_REPAIR
//
// ÇIPLAK KOMUT YAZMAZ: `--apply` VE birebir onay dizgisi VE `--org` üçü
// birden gerekir. Üçünden biri eksikse hiçbir yığın okunmaz.
//
// PII YOK: müşteri adı/adres/telefon/tutar ve ham şifreli yük ASLA yazdırılmaz;
// ham yükten YALNIZ `orderDate` okunur.
import { randomUUID } from 'node:crypto'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  applyTrendyolOrderDateRepair,
  scanTrendyolOrderDates,
  DEFAULT_BATCH_SIZE,
  TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION,
  TRENDYOL_MARKETPLACE,
} from './trendyolOrderDateRepair.ts'

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
    console.error('[orderdate:repair] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = parseArg('org')
  const batchSize = positiveInt(parseArg('batch-size'), DEFAULT_BATCH_SIZE)
  const startAfterId = parseArg('start-after') ?? null
  const apply = hasFlag('apply')
  const db = getDb()

  if (!apply) {
    const result = await scanTrendyolOrderDates(db, {
      organizationId: organizationId ?? null,
      batchSize,
      startAfterId,
      sampleSize: positiveInt(parseArg('sample'), 5),
    })
    console.info(
      JSON.stringify(
        {
          mode: 'DRY_RUN_READ_ONLY',
          mutation: 'NONE',
          marketplace: TRENDYOL_MARKETPLACE,
          organizationId: organizationId ?? '(tümü)',
          batchSize,
          batches: result.batches,
          totalInspected: result.tally.scanned,
          eligibleForRepair: result.tally.update,
          alreadyCorrect: result.tally.alreadyCorrect,
          rawUnavailable: result.tally.rawUnavailable,
          rawUnparseable: result.tally.rawUnparseable,
          unexpected: result.tally.unexpected,
          byOrganization: result.byOrganization,
          lastId: result.lastId,
          samples: result.samples.map((row) => ({
            orderId: row.orderId,
            organizationId: row.organizationId,
            packageId: row.packageId,
            orderNumber: row.orderNumber,
            current: row.currentOrderDate,
            corrected: row.correctedOrderDate,
            deltaMinutes: row.driftMinutes,
            classification: row.classification,
            action: row.action,
          })),
        },
        null,
        2,
      ),
    )
    if (result.tally.update > 0) {
      console.info(
        `[orderdate:repair] APPLY için: --org <uuid> --apply ` +
          `--confirm ${TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION}`,
      )
    }
    return 0
  }

  // ── APPLY ───────────────────────────────────────────────────────────────
  if (!organizationId) {
    console.error(
      '[orderdate:repair] APPLY için --org ZORUNLU. Tüm kiracı genelinde ' +
        'onarım bu ilk görevde yasaktır.',
    )
    return 1
  }
  const confirmation = parseArg('confirm')
  if (confirmation !== TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION) {
    console.error(
      `[orderdate:repair] APPLY için onay zorunlu: ` +
        `--confirm ${TRENDYOL_ORDERDATE_REPAIR_CONFIRMATION}`,
    )
    return 1
  }
  const summary = await applyTrendyolOrderDateRepair(db, {
    organizationId,
    confirmation,
    batchId: randomUUID(),
    batchSize,
    startAfterId,
  })
  console.info('[orderdate:repair] APPLY tamamlandı.')
  console.info(JSON.stringify(summary, null, 2))
  return summary.failed > 0 ? 1 : 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    '[orderdate:repair] Hata:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
