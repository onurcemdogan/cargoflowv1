import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Self-hosted (Ubuntu + PM2 + Nginx) dağıtım regresyon testleri.
// Railway'e özel varsayımların kalmadığını ve proxy arkası davranışını doğrular.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

test('Railway kalıntısı yok: railway.json/nixpacks.toml ve kod içi Railway hostları', () => {
  assert.equal(existsSync(join(root, 'railway.json')), false, 'railway.json kaldırıldı')
  assert.equal(existsSync(join(root, 'nixpacks.toml')), false, 'nixpacks.toml kaldırıldı')
  const client = readFileSync(join(here, 'db', 'client.ts'), 'utf8')
  assert.doesNotMatch(client, /railway\.internal/, 'DB SSL mantığı Railway hostuna bağlı değil')
  assert.doesNotMatch(client, /proxy\.rlwy\.net/)
})

test('DB SSL: localhost SSL istemez, sslmode=require doğrulamalı SSL açar', async () => {
  const client = readFileSync(join(here, 'db', 'client.ts'), 'utf8')
  // Localhost URL'de sslmode yoksa SSL undefined döner (kaynak sözleşmesi).
  assert.match(client, /sslmode=disable/)
  assert.match(client, /sslmode=require/)
  // Güvenli varsayılan: sertifika doğrulanır; opt-out bilinçli env ile.
  assert.match(client, /PGSSL_REJECT_UNAUTHORIZED/)
  assert.match(client, /rejectUnauthorized:\s*\n?\s*String\(process\.env\.PGSSL_REJECT_UNAUTHORIZED/)
})

test('trust proxy: varsayılan KAPALI, TRUST_PROXY ile opt-in', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(source, /const trustProxySetting = String\(process\.env\.TRUST_PROXY/)
  // Koşulsuz app.set('trust proxy', true) OLMAMALI (XFF spoof riski).
  assert.doesNotMatch(source, /app\.set\(\s*'trust proxy',\s*true\s*\)/)
  // Yalnız değer verilmişse etkinleşir.
  assert.match(source, /if \(trustProxySetting\)/)
})

test('PORT/HOST: env ile yönetilir (Nginx arkasında 127.0.0.1 bağlanabilir)', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(source, /process\.env\.PORT\s*\?\?/)
  assert.match(source, /process\.env\.HOST\s*\?\?\s*'0\.0\.0\.0'/)
  assert.match(source, /app\.listen\(port, host/)
})

test('PM2/Nginx config dosyaları mevcut ve secret içermez', () => {
  const pm2Path = join(root, 'ecosystem.config.cjs')
  const nginxPath = join(root, 'deploy', 'nginx', 'cargoflow.conf')
  assert.ok(existsSync(pm2Path), 'ecosystem.config.cjs mevcut')
  assert.ok(existsSync(nginxPath), 'nginx config mevcut')
  const pm2 = readFileSync(pm2Path, 'utf8')
  const nginx = readFileSync(nginxPath, 'utf8')
  // Tek instance zorunlu (idempotency in-process kilitleri).
  assert.match(pm2, /instances:\s*1/)
  assert.match(pm2, /exec_mode:\s*'fork'/)
  // Secret sızıntısı yok.
  for (const content of [pm2, nginx]) {
    assert.doesNotMatch(content, /ENCRYPTION_KEY\s*[:=]\s*['"][A-Za-z0-9+/=]{10,}/)
    assert.doesNotMatch(content, /postgres(ql)?:\/\/[^\s'"]*:[^\s'"@]+@/)
  }
  // Nginx gerçek IP + şema header'larını iletmeli (TRUST_PROXY ile eşleşir).
  assert.match(nginx, /X-Forwarded-For\s+\$proxy_add_x_forwarded_for/)
  assert.match(nginx, /X-Forwarded-Proto\s+\$scheme/)
  assert.match(nginx, /proxy_pass\s+http:\/\/127\.0\.0\.1:8787/)
})

test('.env.example self-hosted şablonu: gerçek secret yok', () => {
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  for (const key of [
    'DATABASE_URL',
    'NODE_ENV',
    'CREDENTIAL_ENCRYPTION_KEY',
    'SHIPMENT_ENCRYPTION_KEY',
    'ORDER_DATA_ENCRYPTION_KEY',
    'PRODUCT_DATA_ENCRYPTION_KEY',
    'AUTH_SESSION_DAYS',
    'HOST',
    'TRUST_PROXY',
  ]) {
    assert.ok(env.includes(key), `.env.example ${key} içerir`)
  }
  // Anahtarlar placeholder olmalı.
  assert.doesNotMatch(env, /ENCRYPTION_KEY=[A-Za-z0-9+/=]{20,}/)
})

test('frontend mutlak API URL kullanmaz (domain değişimi frontend config gerektirmez)', () => {
  const services = ['orderWorkflowService.ts', 'onboardingService.ts', 'appServices.ts']
  for (const file of services) {
    const path = join(root, 'src', 'services', file)
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8')
    assert.doesNotMatch(content, /https?:\/\/[a-z0-9.-]+\/api/i, `${file} mutlak API URL içermez`)
  }
})
