// PostgreSQL bağlantı katmanı (faz 1). Tek Pool; her istek için yeni pool
// OLUŞTURULMAZ. DATABASE_URL yoksa uygulama mevcut yerel (dosya/localStorage)
// davranışıyla çalışmaya devam eder; bu modül kontrollü "disabled" durumu
// döner. Secret değerler asla loglanmaz.
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.ts'

let pool: Pool | null = null
let db: NodePgDatabase<typeof schema> | null = null

export function isDatabaseConfigured(): boolean {
  return Boolean(String(process.env.DATABASE_URL ?? '').trim())
}

function resolveSsl(url: string): { rejectUnauthorized: boolean } | undefined {
  // Self-hosted varsayılan: PostgreSQL aynı sunucuda (localhost) → SSL YOK.
  // Uzak DB için yalnız sslmode=require / PGSSLMODE=require ile SSL açılır ve
  // sertifika DOĞRULANIR. Self-signed zincir için bilinçli opt-out:
  // PGSSL_REJECT_UNAUTHORIZED=false.
  const sslMode = String(process.env.PGSSLMODE ?? '').trim().toLowerCase()
  if (url.includes('sslmode=disable') || sslMode === 'disable') return undefined
  if (url.includes('sslmode=require') || sslMode === 'require') {
    return {
      rejectUnauthorized:
        String(process.env.PGSSL_REJECT_UNAUTHORIZED ?? '').toLowerCase() !== 'false',
    }
  }
  return undefined
}

export function getPool(): Pool {
  const url = String(process.env.DATABASE_URL ?? '').trim()
  if (!url) {
    // Açıklayıcı, secret içermeyen hata; production dışında beklenen durum.
    throw new Error(
      'DATABASE_URL tanımlı değil. PostgreSQL özellikleri devre dışı; ' +
        'yerel geliştirme mevcut dosya/localStorage akışıyla devam eder.',
    )
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: resolveSsl(url),
      max: Number(process.env.PGPOOL_MAX ?? 5),
    })
  }
  return pool
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    db = drizzle(getPool(), { schema })
  }
  return db
}

export interface DatabaseHealth {
  configured: boolean
  ok: boolean
  message?: string
}

// İsteğe bağlı sağlık kontrolü: basit SELECT 1. Credential/tablo verisi
// DÖNDÜRMEZ, dış API çağrısı yapmaz. DB yapılandırılmamışsa hata değil
// "configured:false" döner (mevcut /api/health davranışı bozulmaz).
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  if (!isDatabaseConfigured()) {
    return { configured: false, ok: false, message: 'DATABASE_URL tanımlı değil.' }
  }
  try {
    await getPool().query('SELECT 1')
    return { configured: true, ok: true }
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message:
        error instanceof Error ? error.message : 'PostgreSQL erişilemedi.',
    }
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}
