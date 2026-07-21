// CLI: npm run platform-admin:create -- --username "<kullanici>"
// Etkileşimsiz:  printf '%s' 'PAROLA' | npm run platform-admin:create -- --username "<ad>" --password-stdin
//
// - Parola gizli prompt veya stdin ile alınır (argv'ye/shell geçmişine YAZILMAZ)
// - hashPassword (argon2id) kullanılır; parola/hash ASLA loglanmaz
// - Aynı kullanıcı adı varsa AÇIK hata verir (sessiz başarısızlık yok)
// - status=active yazılır
// - Hangi veritabanına yazdığı doğrulanır ve raporlanır
// - Sonuçta yalnız kullanıcı adı + durum + hash uzunluğu gösterilir
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  createPlatformAdmin,
  describePlatformAdmin,
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
    '[platform-admin] DATABASE_URL tanımlı değil. Proje kökündeki .env dosyasını ' +
      'kontrol edin (uygulama .env dosyasını kendisi okur).',
  )
  process.exit(1)
}
if (!username) {
  console.error('[platform-admin] Kullanıcı adı zorunlu: -- --username "<kullanici>".')
  process.exit(1)
}

try {
  // 1) Hangi veritabanına yazacağımızı ÖNCE doğrula (yanlış DB'ye yazma riski).
  const target = await describeDatabaseTarget()
  console.info(
    `[platform-admin] Veritabanı: ${target.database} (user=${target.user}, host=${target.host}:${target.port})`,
  )

  // 2) Zaten var mı? Açık hata ver (409 benzeri).
  const existing = await describePlatformAdmin(getDb(), username)
  if (existing) {
    console.error(
      `[platform-admin] HATA: '${existing.username}' zaten var ` +
        `(status=${existing.status}, hash uzunluğu=${existing.hashLength}). ` +
        'Parolayı değiştirmek için: npm run platform-admin:reset-password -- --username "' +
        existing.username +
        '"',
    )
    await closePool().catch(() => undefined)
    process.exit(1)
  }

  // 3) Parola (gizli prompt veya --password-stdin).
  const password = await resolveCliPassword({
    question: `'${username}' için parola: `,
    confirmQuestion: 'Parolayı tekrar girin: ',
  })

  const created = await createPlatformAdmin(getDb(), username, password)

  // 4) Gerçekten yazıldı mı? DB'den tekrar oku ve doğrula.
  const verified = await describePlatformAdmin(getDb(), created.username)
  if (!verified) {
    console.error('[platform-admin] HATA: kayıt yazıldıktan sonra doğrulanamadı.')
    await closePool().catch(() => undefined)
    process.exit(1)
  }
  if (verified.hashLength !== 97) {
    console.error(
      `[platform-admin] HATA: hash uzunluğu beklenmedik (${verified.hashLength}, beklenen 97). ` +
        'Kayıt bozuk olabilir.',
    )
    await closePool().catch(() => undefined)
    process.exit(1)
  }

  console.info(
    `[platform-admin] BAŞARILI — kullanıcı="${verified.username}" ` +
      `status=${verified.status} hashUzunluk=${verified.hashLength} (argon2id)`,
  )
  console.info('[platform-admin] Giriş: <sunucu-adresi>/admin/login')
  await closePool()
  process.exit(0)
} catch (error) {
  // Hata mesajı parola/hash İÇERMEZ; hata YUTULMAZ.
  console.error(
    '[platform-admin] Oluşturulamadı:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
