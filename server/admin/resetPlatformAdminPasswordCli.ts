// CLI: npm run platform-admin:reset-password -- --username "<kullanici>"
// Etkileşimsiz:  printf '%s' 'PAROLA' | npm run platform-admin:reset-password -- --username "<ad>" --password-stdin
//
// Parolayı argon2id ile günceller ve TÜM admin oturumlarını sonlandırır.
// Parola/hash ASLA loglanmaz. Hangi veritabanına yazdığı doğrulanır.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  describePlatformAdmin,
  resetPlatformAdminPassword,
} from './platformAdminAccount.ts'
import { resolveCliPassword } from './promptSecret.ts'
import { describeDatabaseTarget } from './dbTarget.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return undefined
}

const username = parseArg('username') || String(process.env.ADMIN_USERNAME ?? '').trim()

if (!isDatabaseConfigured()) {
  console.error(
    '[platform-admin] DATABASE_URL tanımlı değil. Proje kökündeki .env dosyasını kontrol edin.',
  )
  process.exit(1)
}
if (!username) {
  console.error('[platform-admin] Kullanıcı adı zorunlu: -- --username "<kullanici>".')
  process.exit(1)
}

try {
  const target = await describeDatabaseTarget()
  console.info(
    `[platform-admin] Veritabanı: ${target.database} (user=${target.user}, host=${target.host}:${target.port})`,
  )

  const before = await describePlatformAdmin(getDb(), username)
  if (!before) {
    console.error(
      `[platform-admin] HATA: '${username}' bulunamadı. Önce oluşturun: ` +
        'npm run platform-admin:create -- --username "' + username + '"',
    )
    await closePool().catch(() => undefined)
    process.exit(1)
  }

  const password = await resolveCliPassword({
    question: `'${username}' için yeni parola: `,
    confirmQuestion: 'Yeni parolayı tekrar girin: ',
  })

  const result = await resetPlatformAdminPassword(getDb(), username, password)
  const after = await describePlatformAdmin(getDb(), result.username)

  console.info(
    `[platform-admin] BAŞARILI — kullanıcı="${after?.username}" ` +
      `status=${after?.status} önceki hashUzunluk=${before.hashLength} ` +
      `yeni hashUzunluk=${after?.hashLength} (geçerli argon2id = 97)`,
  )
  console.info('[platform-admin] Tüm admin oturumları sonlandırıldı.')
  await closePool()
  process.exit(0)
} catch (error) {
  console.error(
    '[platform-admin] Sıfırlanamadı:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
