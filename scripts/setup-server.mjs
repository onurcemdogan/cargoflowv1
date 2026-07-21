// npm run setup:server — self-hosted "clone-and-run" kurulum scripti.
//
// GÜVENLİ ve TEKRAR ÇALIŞTIRILABİLİR (idempotent):
//  - Veritabanını SIFIRLAMAZ, tablo/veri SİLMEZ
//  - Migration tekrar çalıştırılabilir (uygulanmış migration atlanır)
//  - Hesap OLUŞTURMAZ (ilk admin ayrı komutla: npm run platform-admin:create)
//  - Secret DEĞERLERİ yazdırmaz; yalnız değişken adı/durumu raporlar
//  - Auth, session, tenant izolasyonu, credential encryption, idempotency
//    davranışına DOKUNMAZ
//
// Adımlar: Node sürümü → .env/env doğrulama → DB bağlantısı → migration →
// production build → dizinler → hesap/hash doğrulama → health check.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// .env uygulama ile AYNI şekilde okunur (mevcut process.env ezilmez).
function loadEnvFile(path) {
  if (!existsSync(path)) return false
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim()
    if (!key || process.env[key] != null) continue
    process.env[key] = value.replace(/^['"]|['"]$/g, '')
  }
  return true
}

let stepNumber = 0
function step(title) {
  stepNumber += 1
  console.info(`\n[${stepNumber}/8] ${title}`)
}
function ok(message) {
  console.info(`   ✓ ${message}`)
}
function fail(message, hint) {
  console.error(`   ✗ ${message}`)
  if (hint) console.error(`     → ${hint}`)
  process.exit(1)
}
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

console.info('CargoFlow — self-hosted kurulum (setup:server)')
console.info('Bu script veri SİLMEZ ve hesap OLUŞTURMAZ; tekrar çalıştırılabilir.')

// ---- 1) Node sürümü -------------------------------------------------------
step('Node.js sürümü kontrol ediliyor')
{
  const [major, minor] = process.versions.node.split('.').map(Number)
  // Sunucu .ts dosyalarını doğrudan çalıştırır → flag'siz native type-stripping
  // gerekir: Node >= 22.18 (LTS backport) veya >= 23.6.
  const supported = major > 22 || (major === 22 && minor >= 18)
  if (!supported) {
    fail(
      `Node ${process.versions.node} desteklenmiyor (gereken: >=22.18 <25).`,
      'Kurulum: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs',
    )
  }
  if (major >= 25) {
    fail(`Node ${process.versions.node} test edilmedi (desteklenen: >=22.18 <25).`)
  }
  ok(`Node ${process.versions.node}`)
}

// ---- 2) .env ve zorunlu değişkenler --------------------------------------
step('.env ve zorunlu ortam değişkenleri doğrulanıyor')
const envPath = join(root, '.env')
if (!loadEnvFile(envPath)) {
  fail(
    '.env dosyası bulunamadı.',
    'cp .env.example .env  → ardından gerekli değerleri doldurun',
  )
}
ok('.env okundu')

const { findMissingProductionEnv, resolveCookieSecure, resolveTrustProxy } =
  await import('../server/env-requirements.mjs')

{
  const missing = findMissingProductionEnv()
  if (missing.length > 0) {
    console.error('   ✗ Eksik/doldurulmamış zorunlu değişkenler:')
    for (const entry of missing) {
      console.error(`     - ${entry.name}   (örn: ${entry.hint})`)
    }
    fail('Kurulum durduruldu.', '.env dosyasını doldurup tekrar çalıştırın.')
  }
  ok('Tüm zorunlu değişkenler dolu (değerler gösterilmez)')

  // Bilgilendirme: yanlış ayarlanınca login'i bozan iki kritik bayrak.
  const cookieSecure = resolveCookieSecure()
  const appUrl = String(process.env.APP_URL ?? '').trim()
  if (cookieSecure && appUrl.startsWith('http://')) {
    console.warn(
      '   ! UYARI: COOKIE_SECURE=true ama APP_URL http:// ile başlıyor. ' +
        'Düz HTTP üzerinde tarayıcı Secure cookie göndermez → login sonrası 401. ' +
        'HTTPS yoksa .env içinde COOKIE_SECURE=false yapın.',
    )
  }
  ok(`COOKIE_SECURE=${cookieSecure} · TRUST_PROXY=${resolveTrustProxy(process.env.TRUST_PROXY) ?? 'kapalı'}`)
}

// ---- 3) Veritabanı bağlantısı --------------------------------------------
step('PostgreSQL bağlantısı test ediliyor')
const { getPool, closePool } = await import('../server/db/client.ts')
let databaseName = ''
try {
  const result = await getPool().query('SELECT current_database() AS database, version() AS version')
  databaseName = String(result.rows[0].database)
  ok(`Bağlantı başarılı — database=${databaseName}`)
  ok(String(result.rows[0].version).split(',')[0])
} catch (error) {
  fail(
    `Veritabanına bağlanılamadı: ${error instanceof Error ? error.message : String(error)}`,
    'DATABASE_URL değerini ve PostgreSQL servisinin çalıştığını kontrol edin (sudo systemctl status postgresql).',
  )
}

// ---- 4) Migration (idempotent) -------------------------------------------
step('Migration çalıştırılıyor (mevcut veri korunur)')
if (!run('npm', ['run', 'db:migrate'])) {
  await closePool().catch(() => undefined)
  fail('Migration başarısız.', 'Yukarıdaki hata çıktısını inceleyin.')
}
ok('Migration tamamlandı')

// ---- 5) Şema doğrulama ----------------------------------------------------
step('Şema ve admin tabloları doğrulanıyor')
{
  const tables = await getPool().query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
  )
  const names = new Set(tables.rows.map((row) => row.table_name))
  const required = [
    'organizations',
    'users',
    'sessions',
    'platform_admins',
    'platform_admin_sessions',
    'organization_settings',
    'orders',
    'products',
    'shipments',
    'shipment_operations',
  ]
  const missingTables = required.filter((name) => !names.has(name))
  if (missingTables.length > 0) {
    await closePool().catch(() => undefined)
    fail(`Eksik tablolar: ${missingTables.join(', ')}`, 'npm run db:migrate çıktısını inceleyin.')
  }
  ok(`${names.size} tablo mevcut; zorunlu tabloların tamamı var`)
}

// ---- 6) Hesap ve hash formatı doğrulama ----------------------------------
step('Mevcut hesapların hash formatı doğrulanıyor')
{
  let brokenCount = 0
  for (const table of ['platform_admins', 'users']) {
    const rows = await getPool().query(
      `SELECT username, status, length(password_hash) AS hash_length FROM ${table} ORDER BY username`,
    )
    console.info(`   ${table}: ${rows.rowCount} kayıt`)
    for (const row of rows.rows) {
      const valid = Number(row.hash_length) === 97
      if (!valid) brokenCount += 1
      console.info(
        `     - ${row.username} status=${row.status} hashUzunluk=${row.hash_length} ` +
          `${valid ? '(GEÇERLİ)' : '(BOZUK — parola sıfırlanmalı)'}`,
      )
    }
    if (rows.rowCount === 0 && table === 'platform_admins') {
      console.info('     → Henüz platform admin yok: npm run platform-admin:create -- --username "admin"')
    }
  }
  if (brokenCount > 0) {
    console.warn(
      `   ! ${brokenCount} kayıtta hash bozuk (geçerli argon2id = 97 karakter). ` +
        'Düzeltme: npm run platform-admin:reset-password / npm run org-user:reset-password',
    )
  } else {
    ok('Hash formatları geçerli (argon2id, 97 karakter)')
  }
}
await closePool().catch(() => undefined)

// ---- 7) Production build + dizinler --------------------------------------
step('Production build alınıyor (Vite dev server KULLANILMAZ)')
for (const directory of [join(root, 'logs')]) {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
    ok(`Dizin oluşturuldu: ${directory}`)
  }
}
if (!run('npm', ['run', 'build'])) {
  fail('Build başarısız.', 'Yukarıdaki hata çıktısını inceleyin.')
}
if (!existsSync(join(root, 'dist', 'index.html'))) {
  fail('dist/index.html bulunamadı.', 'Build çıktısını kontrol edin.')
}
ok('dist/ hazır (Express tek porttan servis edecek)')

// ---- 8) Health check ------------------------------------------------------
step('Health check yapılıyor')
{
  const port = Number(process.env.PORT ?? 8787)
  // Port müsait mi? (Uygulama zaten çalışıyorsa doğrudan health'e vurulur.)
  const inUse = await new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(port, '127.0.0.1')
  })

  if (inUse) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      const payload = await response.json()
      if (response.ok && payload.ok) {
        ok(`Çalışan uygulama sağlıklı (port ${port}, db=${payload.db?.ok ? 'ok' : 'yok'})`)
      } else {
        console.warn(`   ! Port ${port} dolu ama /api/health beklenen yanıtı vermedi.`)
      }
    } catch {
      console.warn(
        `   ! Port ${port} başka bir süreç tarafından kullanılıyor (Vite dev server olabilir). ` +
          'Production için o süreci kapatın.',
      )
    }
  } else {
    ok(`Port ${port} müsait — uygulama "npm run start" ile başlatılabilir`)
  }
}

console.info('\n✅ Kurulum tamam.')
console.info('   1) İlk platform admin:  npm run platform-admin:create -- --username "admin"')
console.info('   2) Uygulamayı başlat:   npm run start')
console.info(`   3) Aç:                  ${process.env.APP_URL || `http://127.0.0.1:${process.env.PORT ?? 8787}`}`)
console.info('   Doğrulama:              npm run health   ·   npm run db:verify')
process.exit(0)
