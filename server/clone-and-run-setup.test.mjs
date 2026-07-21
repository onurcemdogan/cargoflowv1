import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// "clone-and-run" kurulum sözleşmesi testleri (madde 13 statik doğrulaması).
// Uçtan uca çalışma akışı (admin → organizasyon → kullanıcı login)
// production-scenario.test.mjs içinde canlı olarak doğrulanır; burada kurulum
// yüzeyi ve güvenlik kuralları sabitlenir.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('kurulum dosyaları repoda mevcut', () => {
  for (const file of [
    '.env.example',
    'SERVER_INSTALL.md',
    'scripts/setup-server.mjs',
    'scripts/health-check.mjs',
    'ecosystem.config.cjs',
    'deploy/nginx/cargoflow.conf',
  ]) {
    assert.ok(existsSync(join(root, file)), `${file} mevcut`)
  }
})

test('npm komutları tanımlı: setup/health/db doğrulama/admin', () => {
  for (const script of [
    'setup:server',
    'health',
    'db:verify',
    'db:migrate',
    'db:check',
    'start',
    'build',
    'platform-admin:create',
    'platform-admin:reset-password',
    'org-user:reset-password',
  ]) {
    assert.ok(packageJson.scripts[script], `npm run ${script} tanımlı`)
  }
  // Production başlatma Express'tir; Vite dev server DEĞİL.
  assert.equal(packageJson.scripts.start, 'node server/index.mjs')
  assert.doesNotMatch(packageJson.scripts.start, /vite/)
  // Node sürümü sözleşmesi (native TS type-stripping gerekir).
  assert.equal(packageJson.engines.node, '>=22.18 <25')
})

test('.env.example: istenen tüm alanlar var, gerçek secret yok', () => {
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  for (const key of [
    'NODE_ENV=production',
    'HOST=0.0.0.0',
    'PORT=8787',
    'DATABASE_URL=',
    'APP_URL=',
    'TRUST_PROXY=false',
    'COOKIE_SECURE=false',
    'SESSION_SECRET=',
    'CREDENTIAL_ENCRYPTION_KEY=',
    'SHIPMENT_ENCRYPTION_KEY=',
    'ORDER_DATA_ENCRYPTION_KEY=',
    'PRODUCT_DATA_ENCRYPTION_KEY=',
  ]) {
    assert.ok(env.includes(key), `.env.example içinde: ${key}`)
  }
  // Anahtarlar placeholder olmalı (gerçek base64 secret sızmamalı).
  assert.doesNotMatch(env, /ENCRYPTION_KEY=[A-Za-z0-9+/=]{20,}/)
  assert.doesNotMatch(env, /SESSION_SECRET=[A-Za-z0-9+/=]{20,}/)
  // Gerçek parolalı connection string olmamalı.
  assert.doesNotMatch(env, /postgresql:\/\/[^\s:]+:(?!PAROLA)[^\s@]{8,}@/)
})

test('zorunlu env sözleşmesi: eksikse tespit edilir, şablon değer dolu sayılmaz', async () => {
  const { findMissingProductionEnv, REQUIRED_PRODUCTION_ENV } = await import(
    './env-requirements.mjs'
  )
  const names = REQUIRED_PRODUCTION_ENV.map((entry) => entry.name)
  for (const expected of [
    'DATABASE_URL',
    'SESSION_SECRET',
    'CREDENTIAL_ENCRYPTION_KEY',
    'SHIPMENT_ENCRYPTION_KEY',
    'ORDER_DATA_ENCRYPTION_KEY',
    'PRODUCT_DATA_ENCRYPTION_KEY',
  ]) {
    assert.ok(names.includes(expected), `zorunlu: ${expected}`)
  }
  // Tamamen boş ortam → hepsi eksik.
  assert.equal(findMissingProductionEnv({}).length, names.length)
  // .env.example şablon değeri (<...>) DOLU SAYILMAZ.
  const templated = Object.fromEntries(names.map((n) => [n, '<32-byte-base64-or-hex-key>']))
  assert.equal(findMissingProductionEnv(templated).length, names.length)
  // Gerçek değerler → eksik yok.
  const filled = Object.fromEntries(names.map((n) => [n, 'gercek-deger']))
  assert.equal(findMissingProductionEnv(filled).length, 0)
})

test('COOKIE_SECURE ve TRUST_PROXY çözümü doğru', async () => {
  const { resolveCookieSecure, resolveTrustProxy } = await import('./env-requirements.mjs')
  // COOKIE_SECURE açıkça verilirse ona uyulur.
  assert.equal(resolveCookieSecure({ COOKIE_SECURE: 'false', NODE_ENV: 'production' }), false)
  assert.equal(resolveCookieSecure({ COOKIE_SECURE: 'true', NODE_ENV: 'development' }), true)
  // Verilmezse production'da true, aksi halde false.
  assert.equal(resolveCookieSecure({ NODE_ENV: 'production' }), true)
  assert.equal(resolveCookieSecure({ NODE_ENV: 'development' }), false)

  // TRUST_PROXY: "false"/0/off/boş → KAPALI (string "false" truthy tuzağı).
  for (const value of ['false', '0', 'off', 'no', '', undefined]) {
    assert.equal(resolveTrustProxy(value), null, `TRUST_PROXY=${value} kapalı`)
  }
  assert.equal(resolveTrustProxy('1'), 1)
  assert.equal(resolveTrustProxy('loopback'), 'loopback')
})

test('uygulama production\'da eksik env ile SESSİZCE başlamaz', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(source, /assertProductionEnvironment/)
  assert.match(source, /findMissingProductionEnv/)
  // Eksik değişken adları yazılır ve süreç durur.
  assert.match(source, /process\.exit\(1\)/)
  // Secret DEĞERİ yazılmaz (yalnız entry.name ve hint).
  assert.doesNotMatch(source, /console\.error\(.*process\.env\[/)
})

test('setup scripti güvenli: veri silmez, hesap oluşturmaz, secret yazmaz', () => {
  const setup = readFileSync(join(root, 'scripts', 'setup-server.mjs'), 'utf8')
  // Yıkıcı SQL/komut YOK.
  for (const forbidden of [
    /DROP\s+TABLE/i,
    /TRUNCATE/i,
    /DELETE\s+FROM/i,
    /DROP\s+DATABASE/i,
    /db:push/,
    /--force/,
  ]) {
    assert.doesNotMatch(setup, forbidden, `yasak işlem: ${forbidden}`)
  }
  // Hesap oluşturmaz (ilk admin ayrı komut).
  assert.doesNotMatch(setup, /createPlatformAdmin\(/)
  assert.match(setup, /platform-admin:create/)
  // Idempotent migration + build kullanır.
  assert.match(setup, /'db:migrate'/)
  assert.match(setup, /'build'/)
  // Health check ve hash doğrulaması yapar.
  assert.match(setup, /api\/health/)
  assert.match(setup, /hash_length/)
})

test('SERVER_INSTALL.md üç akışı ve HTTPS/cookie uyarısını içerir', () => {
  const doc = readFileSync(join(root, 'SERVER_INSTALL.md'), 'utf8')
  assert.match(doc, /A\. İlk kurulum/)
  assert.match(doc, /B\. GitHub güncellemesi sonrası deploy/)
  assert.match(doc, /C\. Parola sıfırlama/)
  assert.match(doc, /npm run setup:server/)
  assert.match(doc, /npm run platform-admin:create/)
  assert.match(doc, /COOKIE_SECURE=false/)
  // Gerçek secret içermemeli.
  assert.doesNotMatch(doc, /ENCRYPTION_KEY=[A-Za-z0-9+/=]{20,}/)
})
