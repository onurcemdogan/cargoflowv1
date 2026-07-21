// CLI: npm run db:verify
// Uygulamanın GERÇEKTEN hangi veritabanına bağlandığını ve hesapların durumunu
// güvenli biçimde raporlar. Parola, hash veya connection string ASLA yazılmaz;
// yalnız kullanıcı adı, durum ve hash UZUNLUĞU gösterilir.
import { closePool, getPool, isDatabaseConfigured } from '../db/client.ts'
import { describeDatabaseTarget } from './dbTarget.ts'

if (!isDatabaseConfigured()) {
  console.error(
    '[db:verify] DATABASE_URL tanımlı değil. Proje kökündeki .env dosyasını kontrol edin.',
  )
  process.exit(1)
}

try {
  const target = await describeDatabaseTarget()
  console.info(
    `[db:verify] Bağlantı: database=${target.database} user=${target.user} ` +
      `host=${target.host}:${target.port}`,
  )

  const pool = getPool()

  // Tablolar mevcut mu (migration çalıştı mı)?
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  )
  const names = tables.rows.map((row: { table_name: string }) => row.table_name)
  console.info(`[db:verify] Tablo sayısı: ${names.length}`)
  for (const required of ['organizations', 'users', 'sessions', 'platform_admins']) {
    console.info(`[db:verify]   ${names.includes(required) ? '✓' : '✗'} ${required}`)
  }

  // Platform adminler (hash UZUNLUĞU — hash'in kendisi DEĞİL).
  if (names.includes('platform_admins')) {
    const admins = await pool.query(
      'SELECT username, status, length(password_hash) AS hash_length FROM platform_admins ORDER BY username',
    )
    console.info(`[db:verify] platform_admins kayıt sayısı: ${admins.rowCount}`)
    for (const row of admins.rows) {
      const ok = Number(row.hash_length) === 97 ? 'GEÇERLİ' : 'BOZUK'
      console.info(
        `[db:verify]   username=${row.username} status=${row.status} ` +
          `hashUzunluk=${row.hash_length} (${ok}; argon2id=97)`,
      )
    }
  }

  // Organization kullanıcıları.
  if (names.includes('users')) {
    const users = await pool.query(
      'SELECT username, status, length(password_hash) AS hash_length FROM users ORDER BY username',
    )
    console.info(`[db:verify] users kayıt sayısı: ${users.rowCount}`)
    for (const row of users.rows) {
      const ok = Number(row.hash_length) === 97 ? 'GEÇERLİ' : 'BOZUK'
      console.info(
        `[db:verify]   username=${row.username} status=${row.status} ` +
          `hashUzunluk=${row.hash_length} (${ok}; argon2id=97)`,
      )
    }
  }

  await closePool()
  process.exit(0)
} catch (error) {
  console.error(
    '[db:verify] Doğrulanamadı:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
