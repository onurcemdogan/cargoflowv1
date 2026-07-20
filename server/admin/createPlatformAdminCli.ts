// CLI: npm run admin:create-platform-admin -- --username "<username>"
// Parola terminalde GİZLİ prompt ile alınır (argümanla verilmek zorunda değil).
// Düz parola/hash loglanmaz. Aynı username varsa hata. Session OLUŞTURMAZ.
// Organization kullanıcısı OLUŞTURMAZ.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { createPlatformAdmin } from './platformAdminAccount.ts'
import { promptHiddenPassword } from './promptSecret.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return undefined
}

const username = parseArg('username') || String(process.env.ADMIN_USERNAME ?? '').trim()

if (!isDatabaseConfigured()) {
  console.error('[admin] DATABASE_URL tanımlı değil; admin oluşturulamadı.')
  process.exit(1)
}
if (!username) {
  console.error('[admin] Kullanıcı adı zorunlu: --username "<username>".')
  process.exit(1)
}

try {
  const password = await promptHiddenPassword(`'${username}' için parola: `)
  const confirm = await promptHiddenPassword('Parolayı tekrar girin: ')
  if (password !== confirm) {
    console.error('[admin] Parolalar eşleşmiyor.')
    await closePool().catch(() => undefined)
    process.exit(1)
  }
  const created = await createPlatformAdmin(getDb(), username, password)
  console.info(`[admin] Platform admin oluşturuldu: ${created.username}`)
  await closePool()
  process.exit(0)
} catch (error) {
  // Hata mesajı parola/hash İÇERMEZ.
  console.error('[admin] Oluşturulamadı:', error instanceof Error ? error.message : String(error))
  await closePool().catch(() => undefined)
  process.exit(1)
}
