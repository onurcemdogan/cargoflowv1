// npm run health — çalışan uygulamanın /api/health ucunu doğrular.
// Secret yazmaz. Sağlıklıysa exit 0, değilse exit 1 (izleme/otomasyon için).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    if (!key || process.env[key] != null) continue
    process.env[key] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
  }
}

const port = Number(process.env.PORT ?? 8787)
const target =
  String(process.env.HEALTH_URL ?? '').trim() || `http://127.0.0.1:${port}/api/health`

try {
  const started = Date.now()
  const response = await fetch(target)
  const payload = await response.json().catch(() => ({}))
  const elapsed = Date.now() - started

  if (!response.ok || !payload.ok) {
    console.error(`[health] BAŞARISIZ — HTTP ${response.status} (${target})`)
    process.exit(1)
  }
  console.info(
    `[health] OK — ${target} · HTTP ${response.status} · ${elapsed}ms · ` +
      `build=${payload.buildRevision ?? 'n/a'}`,
  )
  if (payload.db) {
    console.info(
      `[health] veritabanı: configured=${payload.db.configured} ok=${payload.db.ok}` +
        (payload.db.ok ? '' : ` (${payload.db.message ?? 'hata'})`),
    )
    if (!payload.db.ok) process.exit(1)
  } else {
    console.warn('[health] UYARI: DATABASE_URL tanımlı değil (legacy mod).')
  }
  process.exit(0)
} catch (error) {
  console.error(
    `[health] BAŞARISIZ — ${target} adresine ulaşılamadı: ` +
      (error instanceof Error ? error.message : String(error)),
  )
  console.error('[health] Uygulama çalışıyor mu? "npm run start" ile başlatın.')
  process.exit(1)
}
