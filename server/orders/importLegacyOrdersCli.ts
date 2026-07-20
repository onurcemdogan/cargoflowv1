// CLI: npm run db:import:legacy-orders -- --org <uuid> --file <path> [--seller <id>] [--commit]
// Varsayılan DRY-RUN (yalnız özet); gerçek yazım için --commit gerekir.
// organizationId açık verilmek zorunda (env CARGOFLOW_IMPORT_ORG_ID veya --org).
// Export JSON dosyasını DEĞİŞTİRMEZ. Secret/PII loglanmaz. Sunucu başlangıcında
// ÇALIŞMAZ — yalnız açık çağrıyla. Bu tur gerçek production verisine karşı
// çalıştırılmamalıdır.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { importLegacyOrders } from './importLegacyOrders.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return undefined
}

const organizationId =
  parseArg('org') || String(process.env.CARGOFLOW_IMPORT_ORG_ID ?? '').trim()
const storePath =
  parseArg('file') || String(process.env.CARGOFLOW_IMPORT_ORDERS_FILE ?? '').trim()
const sellerId = parseArg('seller')
const dryRun = !process.argv.includes('--commit')

if (!isDatabaseConfigured()) {
  console.error('[import] DATABASE_URL tanımlı değil; import çalıştırılamadı.')
  process.exit(1)
}
if (!organizationId) {
  console.error(
    '[import] organizationId zorunlu: --org <uuid> veya CARGOFLOW_IMPORT_ORG_ID.',
  )
  process.exit(1)
}
if (!storePath) {
  console.error(
    '[import] export dosyası zorunlu: --file <path> veya CARGOFLOW_IMPORT_ORDERS_FILE.',
  )
  process.exit(1)
}

try {
  const summary = await importLegacyOrders(getDb(), organizationId, {
    dryRun,
    storePath,
    sellerId,
  })
  console.info(
    `[import] mode=${dryRun ? 'DRY-RUN' : 'COMMIT'} org=${organizationId}${sellerId ? ` seller=${sellerId}` : ''}`,
  )
  console.info(
    `[import] okunan=${summary.read} eklenen=${summary.inserted} atlanan=${summary.skipped} hatalı=${summary.failed} satır=${summary.linesInserted}`,
  )
  if (dryRun) {
    console.info(
      '[import] DRY-RUN: hiçbir kayıt yazılmadı. Gerçek import için --commit ekleyin.',
    )
  }
  await closePool()
  process.exit(0)
} catch (error) {
  console.error(
    '[import] başarısız:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
