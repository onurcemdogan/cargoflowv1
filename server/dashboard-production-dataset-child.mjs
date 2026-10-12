// TZ bağımsızlık kanıtı için child runner: süreç TZ'si ne olursa olsun
// AYNI veri setinde sunucu dashboard modeli AYNI sayıları üretmelidir.
// Çıktı: dönem anahtarı → özet (tek satır JSON). Zorla çıkış YOK — kaynaklar
// kapatılır ve süreç doğal olarak sonlanır.
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  DATASET_NOW,
  seedProductionDataset,
  summarizeViewModel,
} from './testing/dashboardProductionDataset.mjs'

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true, include: [] },
})
const schema = await vite.ssrLoadModule('/server/db/schema.ts')
const service = await vite.ssrLoadModule('/server/dashboard/dashboardOperationalService.ts')
const { PGlite } = await import('@electric-sql/pglite')
const { drizzle } = await import('drizzle-orm/pglite')
const pglite = new PGlite()
const dir = join(here, '..', 'drizzle')
for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
  for (const statement of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await pglite.exec(statement)
  }
}
const db = drizzle(pglite, { schema })
const { org, account } = await seedProductionDataset(db, schema)
const out = {}
for (const key of ['today', 'yesterday', 'last7', 'last30', 'month']) {
  const result = await service.buildDashboardViewModelSnapshot(db, org.id, { key }, account.id, {
    now: DATASET_NOW,
  })
  out[key] = summarizeViewModel(result.viewModel)
}
console.log(JSON.stringify({ tz: process.env.TZ ?? null, out }))
await pglite.close()
await vite.close()
