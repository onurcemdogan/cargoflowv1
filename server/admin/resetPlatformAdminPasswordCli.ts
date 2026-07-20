// CLI: npm run admin:reset-platform-admin-password -- --username "<username>"
// Yeni parola GİZLİ prompt ile alınır; Argon2id ile güncellenir; TÜM admin
// session'ları revoke edilir. Düz parola/hash loglanmaz.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { resetPlatformAdminPassword } from './platformAdminAccount.ts'
import { promptHiddenPassword } from './promptSecret.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return undefined
}

const username = parseArg('username') || String(process.env.ADMIN_USERNAME ?? '').trim()

if (!isDatabaseConfigured()) {
  console.error('[admin] DATABASE_URL tanımlı değil; parola sıfırlanamadı.')
  process.exit(1)
}
if (!username) {
  console.error('[admin] Kullanıcı adı zorunlu: --username "<username>".')
  process.exit(1)
}

try {
  const password = await promptHiddenPassword(`'${username}' için yeni parola: `)
  const confirm = await promptHiddenPassword('Yeni parolayı tekrar girin: ')
  if (password !== confirm) {
    console.error('[admin] Parolalar eşleşmiyor.')
    await closePool().catch(() => undefined)
    process.exit(1)
  }
  const result = await resetPlatformAdminPassword(getDb(), username, password)
  console.info(
    `[admin] '${result.username}' parolası güncellendi; tüm admin oturumları sonlandırıldı.`,
  )
  await closePool()
  process.exit(0)
} catch (error) {
  console.error('[admin] Sıfırlanamadı:', error instanceof Error ? error.message : String(error))
  await closePool().catch(() => undefined)
  process.exit(1)
}
