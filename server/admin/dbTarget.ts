// Hangi PostgreSQL veritabanına bağlanıldığını GÜVENLİ biçimde raporlar.
// Yalnız veritabanı/kullanıcı/host adı döner — parola veya connection string
// ASLA loglanmaz/döndürülmez.
import { getPool } from '../db/client.ts'

export interface DatabaseTarget {
  database: string
  user: string
  host: string
  port: string
}

export async function describeDatabaseTarget(): Promise<DatabaseTarget> {
  const result = await getPool().query(
    'SELECT current_database() AS database, current_user AS "user", ' +
      "coalesce(inet_server_addr()::text, 'local') AS host, " +
      "coalesce(inet_server_port()::text, 'local') AS port",
  )
  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>
  return {
    database: String(row.database ?? 'bilinmiyor'),
    user: String(row.user ?? 'bilinmiyor'),
    host: String(row.host ?? 'bilinmiyor'),
    port: String(row.port ?? 'bilinmiyor'),
  }
}
