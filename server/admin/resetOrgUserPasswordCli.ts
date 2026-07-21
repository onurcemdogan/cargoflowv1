// CLI: npm run admin:reset-org-user-password -- --username "<kullanici>"
// Organization kullanıcısının parolasını login akışıyla AYNI argon2id biçiminde
// sıfırlar ve aktif oturumlarını sonlandırır. Parola GİZLİ prompt ile alınır
// (argümanla verilmez; shell geçmişine düşmez). Düz parola/hash loglanmaz.
// Auth bypass EKLEMEZ, giriş ekranını DEĞİŞTİRMEZ, tenant kurallarına dokunmaz.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { resetOrganizationUserPassword } from './orgUserPassword.ts'
import { resolveCliPassword } from './promptSecret.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return undefined
}

const username = parseArg('username') || String(process.env.ORG_USERNAME ?? '').trim()

if (!isDatabaseConfigured()) {
  console.error('[org-user] DATABASE_URL tanımlı değil; parola sıfırlanamadı.')
  process.exit(1)
}
if (!username) {
  console.error('[org-user] Kullanıcı adı zorunlu: --username "<kullanici>".')
  process.exit(1)
}

try {
  const password = await resolveCliPassword({
    question: `'${username}' için yeni parola: `,
    confirmQuestion: 'Yeni parolayı tekrar girin: ',
  })
  const result = await resetOrganizationUserPassword(getDb(), username, password)
  console.info(`[org-user] '${result.username}' parolası güncellendi.`)
  // Yalnız UZUNLUK gösterilir (hash değil): geçerli argon2id hash 97 karakterdir.
  console.info(
    `[org-user] önceki hash uzunluğu=${result.previousHashLength} ` +
      `yeni hash uzunluğu=${result.newHashLength} ` +
      `(geçerli argon2id = 97) kullanıcı durumu=${result.userStatus} ` +
      `sonlandırılan oturum=${result.revokedSessions}`,
  )
  if (result.previousHashLength !== 97) {
    console.info(
      '[org-user] NOT: önceki hash 97 karakter değildi — bozuk/kesik hash nedeniyle ' +
        'login 401 dönüyordu. Artık düzeltildi.',
    )
  }
  await closePool()
  process.exit(0)
} catch (error) {
  console.error(
    '[org-user] Sıfırlanamadı:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
