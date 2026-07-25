import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// Entegrasyon credential persist + güvenli hydrate regresyon testleri.
// Kök neden: auth modda maskeli GET secret döndürmez; frontend formu doğru
// hydrate etmeli, gerçek secret istemciye gitmemeli, boş secret eski değeri
// korumalı, maske DB'ye yazılmamalı, tenant izolasyonu bozulmamalı.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const cred = await import('./integrations/credentialService.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, name, slug) {
  const [org] = await db.insert(schema.organizations).values({ name, slug }).returning()
  return org.id
}

test('Trendyol: kaydet → maskeli hydrate → secret sızmaz → boş secret korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org A', 'org-a')

  // 1) Trendyol credential kaydedilir.
  await cred.saveIntegrationCredential(db, org, 'trendyol', {
    sellerId: '696196',
    apiKey: 'REAL-API-KEY-123',
    apiSecret: 'REAL-API-SECRET-456',
    environment: 'prod',
    userAgentName: 'CargoFlow',
  })

  // 2-3) Sayfa yenileme simülasyonu: maskeli status doğru döner.
  const status = await cred.getMaskedIntegrationStatus(db, org)
  assert.equal(status.trendyol.sellerId, '696196')
  assert.equal(status.trendyol.hasApiKey, true)
  assert.equal(status.trendyol.hasApiSecret, true)
  assert.equal(status.trendyol.configured, true)
  assert.equal(status.trendyol.connected, true)
  assert.equal(status.trendyol.environment, 'prod')
  assert.equal(status.trendyol.userAgent, '696196 - CargoFlow')

  // 4) Gerçek secret response içinde YOK.
  const dump = JSON.stringify(status)
  assert.ok(!dump.includes('REAL-API-KEY-123'), 'apiKey sızmaz')
  assert.ok(!dump.includes('REAL-API-SECRET-456'), 'apiSecret sızmaz')

  // 5-6) Secret alanları boş göndererek güncelle (yalnız sellerId değişir);
  // eski secret korunur.
  await cred.saveIntegrationCredential(db, org, 'trendyol', {
    sellerId: '696196',
    apiKey: '',
    apiSecret: '',
  })
  const after = await cred.getIntegrationCredential(db, org, 'trendyol')
  assert.equal(after.apiKey, 'REAL-API-KEY-123', 'boş secret eski değeri korur')
  assert.equal(after.apiSecret, 'REAL-API-SECRET-456')

  // 9) Maskeli placeholder credential olarak KAYDEDİLMEZ (eski değer korunur).
  await cred.saveIntegrationCredential(db, org, 'trendyol', {
    apiKey: '•••••••• (kayıtlı)',
    apiSecret: '••••4567',
  })
  const afterMask = await cred.getIntegrationCredential(db, org, 'trendyol')
  assert.equal(afterMask.apiKey, 'REAL-API-KEY-123', 'maske yazılmaz')
  assert.equal(afterMask.apiSecret, 'REAL-API-SECRET-456')

  // Yeni gerçek secret gönderilince GÜNCELLENİR.
  await cred.saveIntegrationCredential(db, org, 'trendyol', { apiKey: 'NEW-KEY-999' })
  assert.equal(
    (await cred.getIntegrationCredential(db, org, 'trendyol')).apiKey,
    'NEW-KEY-999',
  )

  // DB'de düz metin secret yok (şifreli envelope).
  const rows = await db.select().from(schema.integrationCredentials)
  const raw = JSON.stringify(rows)
  assert.ok(!raw.includes('NEW-KEY-999'), 'DB payload şifreli')
  for (const row of rows) {
    assert.ok(String(row.encryptedPayload).startsWith('{"v":1'))
  }
})

test('Sürat: kaydet → maskeli hydrate → secret sızmaz → boş secret korunur (8)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org S', 'org-s')

  await cred.saveIntegrationCredential(db, org, 'surat', {
    kullaniciAdi: '1551267127',
    sifre: 'REAL-SURAT-PASS',
    webPassword: 'REAL-WEB-PASS',
    firmaId: '1551267127',
    ortam: 'live',
  })

  const status = await cred.getMaskedIntegrationStatus(db, org)
  assert.equal(status.surat.cariKod, '1551267127')
  assert.equal(status.surat.customerCode, '1551267127')
  assert.equal(status.surat.firmaId, '1551267127')
  assert.equal(status.surat.hasPassword, true)
  assert.equal(status.surat.hasWebPassword, true)
  assert.equal(status.surat.configured, true)
  assert.equal(status.surat.connected, true)
  assert.equal(status.surat.environment, 'live')

  const dump = JSON.stringify(status)
  assert.ok(!dump.includes('REAL-SURAT-PASS'), 'sifre sızmaz')
  assert.ok(!dump.includes('REAL-WEB-PASS'), 'webPassword sızmaz')

  // Boş secret ile güncelle → korunur.
  await cred.saveIntegrationCredential(db, org, 'surat', {
    kullaniciAdi: '1551267127',
    sifre: '',
    webPassword: '',
  })
  const after = await cred.getIntegrationCredential(db, org, 'surat')
  assert.equal(after.sifre, 'REAL-SURAT-PASS')
  assert.equal(after.webPassword, 'REAL-WEB-PASS')

  // Maske yazılmaz.
  await cred.saveIntegrationCredential(db, org, 'surat', {
    sifre: '•••••••• (kayıtlı)',
    webPassword: '•••••••• (saved)',
  })
  const afterMask = await cred.getIntegrationCredential(db, org, 'surat')
  assert.equal(afterMask.sifre, 'REAL-SURAT-PASS')
  assert.equal(afterMask.webPassword, 'REAL-WEB-PASS')
})

test('7) İkinci tenant birinci tenant credential\'ını GÖREMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'A', 'iso-a')
  const orgB = await makeOrg(db, 'B', 'iso-b')

  await cred.saveIntegrationCredential(db, orgA, 'trendyol', {
    sellerId: 'AAA-111',
    apiKey: 'A-KEY',
    apiSecret: 'A-SECRET',
  })
  await cred.saveIntegrationCredential(db, orgA, 'surat', {
    kullaniciAdi: 'A-CARI',
    sifre: 'A-PASS',
  })

  // Org B boş görür.
  const bStatus = await cred.getMaskedIntegrationStatus(db, orgB)
  assert.equal(bStatus.trendyol.configured, false)
  assert.equal(bStatus.trendyol.sellerId, '')
  assert.equal(bStatus.surat.configured, false)
  assert.equal(await cred.getIntegrationCredential(db, orgB, 'trendyol'), null)
  assert.equal(await cred.getIntegrationCredential(db, orgB, 'surat'), null)

  // Org A kendi verisini görür (secret yalnız sunucu içi getIntegrationCredential ile).
  const aStatus = await cred.getMaskedIntegrationStatus(db, orgA)
  assert.equal(aStatus.trendyol.sellerId, 'AAA-111')
  assert.equal(aStatus.surat.cariKod, 'A-CARI')
})

test('isMaskedPlaceholder: yalnız maske değerlerini yakalar, gerçek secret\'ı yakalamaz', () => {
  for (const masked of ['•••••••• (kayıtlı)', '••••1234', '••••4567', '•••••••• (saved)', '****']) {
    assert.equal(cred.isMaskedPlaceholder(masked), true, `maske: ${masked}`)
  }
  for (const real of ['REAL-KEY', 'abc123', 'p•ssword', '1551267127', '']) {
    assert.equal(cred.isMaskedPlaceholder(real), false, `gerçek: "${real}"`)
  }
})
