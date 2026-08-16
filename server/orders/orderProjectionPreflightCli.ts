// PROJEKSİYON ÖN KONTROLÜ (CLI) — SALT OKUNUR.
//
// Kullanım:
//   npm run projection:preflight
//   npm run projection:preflight -- --org <organizationId>
//
// Hiçbir yazma, migration, backfill veya taşıyıcı çağrısı YAPMAZ.
// Şema beklenenden farklıysa FAIL-CLOSED (çıkış kodu 1).
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  buildProjectionPreflightReport,
  formatPreflightReport,
} from './orderProjectionPreflight.ts'

function readArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : ''
}

export async function runProjectionPreflight(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[projection:preflight] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = readArg('org')
  const report = await buildProjectionPreflightReport(getDb(), {
    organizationId: organizationId || undefined,
  })
  for (const line of formatPreflightReport(report)) console.info(line)
  if (!report.schemaOk) {
    console.error(
      '[projection:preflight] Şema beklenen sözleşmeyi karşılamıyor; hazırlık YOK.',
    )
    return 1
  }
  return 0
}

const invokedDirectly = process.argv[1]?.includes('orderProjectionPreflightCli')
if (invokedDirectly) {
  runProjectionPreflight()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(
        '[projection:preflight] Ön kontrol başarısız:',
        error instanceof Error ? error.message : error,
      )
      process.exitCode = 2
    })
    .finally(() => closePool().catch(() => undefined))
}
