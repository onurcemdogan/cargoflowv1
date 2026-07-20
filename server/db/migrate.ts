// Migration runner: `npm run db:migrate` ile AYRI (pre-deploy) adım olarak
// çalıştırılır. Production server başlangıcında OTOMATİK çağrılmaz.
// DATABASE_URL zorunludur; secret loglanmaz.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { closePool, getDb, isDatabaseConfigured } from './client.ts'

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
)

if (!isDatabaseConfigured()) {
  console.error(
    '[db:migrate] DATABASE_URL tanımlı değil; migration çalıştırılamadı.',
  )
  process.exit(1)
}

try {
  await migrate(getDb(), { migrationsFolder })
  console.info('[db:migrate] Migration tamamlandı.')
  await closePool()
  process.exit(0)
} catch (error) {
  console.error(
    '[db:migrate] Migration başarısız:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
