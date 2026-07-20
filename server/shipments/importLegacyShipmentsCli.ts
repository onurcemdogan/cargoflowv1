// CLI: npm run db:import:legacy-shipments -- --org <uuid> [--commit]
// Varsayılan DRY-RUN (yalnız özet); gerçek yazım için --commit gerekir.
// organizationId açık verilmek zorunda (env CARGOFLOW_IMPORT_ORG_ID veya --org).
// Gerçek JSON dosyasını DEĞİŞTİRMEZ. Secret/tam payload loglanmaz.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { importLegacyShipments } from './importLegacyShipments.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return undefined
}

const organizationId =
  parseArg('org') || String(process.env.CARGOFLOW_IMPORT_ORG_ID ?? '').trim()
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

try {
  const summary = await importLegacyShipments(
    getDb() as unknown as Parameters<typeof importLegacyShipments>[0],
    organizationId,
    { dryRun },
  )
  console.info(
    `[import] mode=${dryRun ? 'DRY-RUN' : 'COMMIT'} org=${organizationId}`,
  )
  console.info(
    `[import] okunan=${summary.read} eklenen=${summary.inserted} atlanan=${summary.skipped} hatalı=${summary.failed}`,
  )
  if (dryRun) {
    console.info('[import] DRY-RUN: hiçbir kayıt yazılmadı. Gerçek import için --commit ekleyin.')
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
