import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// PHASE2-E — ENTEGRASYON DURUM PANOSU (hermetik: pglite + gerçek migration).
//
// Uygulama aşaması, yayın aşaması ve bağlantı sağlığı AYRI alanlardır. Panoda
// "Canlı" yalnız üretimde kanıtlanmış + canlı yayındaki sağlayıcıya verilir;
// rozet yalnız BU çalışma alanının kalıcı kayıtlarından türer.

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const status = await import('./connectors/integrationStatus.ts')
const carriers = await import('./carriers/carrierAccounts.ts')
const credentials = await import('./integrations/credentialService.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')

const DIR = join(here, '..', 'drizzle')
const FILES = readdirSync(DIR).filter((file) => file.endsWith('.sql')).sort()
const NOW = Date.parse('2026-10-12T10:00:00.000Z')

async function makeDb() {
  const pglite = new PGlite()
  for (const file of FILES) {
    for (const statement of readFileSync(join(DIR, file), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await pglite.exec(statement)
    }
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db, slug) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

const byKey = (board) => Object.fromEntries(board.map((entry) => [entry.providerKey, entry]))

test('IS-1: "Canlı" yalnız üretimde kanıtlanmış + canlı yayın; uygulanmış bağlayıcı ASLA canlı görünmez', () => {
  assert.equal(status.resolveAvailability('production', 'ga'), 'live')
  // Yayın politikası canlıya çekilse bile üretim doğrulaması yoksa canlı DEĞİL.
  assert.equal(status.resolveAvailability('implemented', 'ga'), 'internal_test')
  assert.equal(status.resolveAvailability('implemented', 'internal_test'), 'internal_test')
  assert.equal(status.resolveAvailability('implemented', 'off'), 'hidden')
  assert.equal(status.resolveAvailability('in_development', 'ga'), 'in_development')
  assert.equal(status.resolveAvailability('production', 'internal_test'), 'internal_test')
})

test('IS-2: boş çalışma alanı — üç kavram ayrı alanlarda; yalnız Trendyol ve Sürat canlı', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bos')
  const board = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: org, nowMs: NOW }))

  const live = Object.values(board).filter((entry) => entry.availability === 'live').map((entry) => entry.providerKey)
  assert.deepEqual(live.sort(), ['surat', 'trendyol'])
  // HEPSIBURADA-LIVE-001: Hepsiburada uygulandı → iç test (canlı DEĞİL).
  for (const key of ['woocommerce', 'ikas', 'aras', 'hepsiburada']) {
    assert.equal(board[key].availability, 'internal_test', key)
    assert.equal(board[key].implementationStage, 'implemented', key)
    assert.equal(board[key].rolloutStage, 'internal_test', key)
  }
  for (const key of ['n11', 'ticimax']) {
    assert.equal(board[key].availability, 'in_development', key)
    assert.equal(board[key].health.state, 'not_available', key)
  }
  // Hiçbir şey kurulmamış: sağlık uydurulmaz.
  for (const key of ['trendyol', 'surat', 'woocommerce', 'ikas', 'aras', 'hepsiburada']) {
    assert.equal(board[key].health.state, 'not_configured', key)
    assert.equal(board[key].health.verified, false, key)
  }
  await assert.rejects(status.loadIntegrationStatusBoard(db, { organizationId: '  ' }), /organizationId zorunludur/)
})

test('IS-3: taşıyıcı sağlığı kalıcı doğrulamadan gelir ve kiracıya özeldir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'a')
  const orgB = await makeOrg(db, 'b')
  await credentials.saveIntegrationCredential(db, orgA, 'surat', { kullaniciAdi: 'cari-a', sifre: 'GIZLI-SURAT-A' })
  await credentials.saveIntegrationCredential(db, orgB, 'surat', { kullaniciAdi: 'cari-b', sifre: 'GIZLI-SURAT-B' })
  const carrierA = await carriers.syncSuratCarrierAccount(db, orgA)
  await carriers.syncSuratCarrierAccount(db, orgB)

  // Kayıtlı ama doğrulanmamış → "kayıtlı, doğrulanmadı"; doğrulandı DENMEZ.
  let a = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: orgA, nowMs: NOW }))
  assert.equal(a.surat.health.state, 'configured')
  assert.equal(a.surat.health.verified, false)

  const verifiedAt = new Date(NOW - 60_000)
  await carriers.recordCarrierVerification(db, { organizationId: orgA, carrierAccountId: carrierA.id, status: 'verified', now: verifiedAt })
  a = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: orgA, nowMs: NOW }))
  const b = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: orgB, nowMs: NOW }))
  assert.equal(a.surat.health.state, 'verified')
  assert.equal(a.surat.health.lastVerifiedAt, verifiedAt.toISOString())
  // B'nin hesabı A'nın doğrulamasından ETKİLENMEZ.
  assert.equal(b.surat.health.state, 'configured')
  assert.equal(b.surat.health.lastVerifiedAt, null)

  await carriers.recordCarrierVerification(db, { organizationId: orgA, carrierAccountId: carrierA.id, status: 'auth_failed', now: new Date(NOW) })
  a = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: orgA, nowMs: NOW }))
  assert.equal(a.surat.health.state, 'auth_error')

  // Hesap kapatılınca → "devre dışı"; canlılık (grup) DEĞİŞMEZ.
  await pglite.query('UPDATE carrier_accounts SET enabled = false WHERE id = $1', [carrierA.id])
  a = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: orgA, nowMs: NOW }))
  assert.equal(a.surat.health.state, 'disabled')
  assert.equal(a.surat.availability, 'live')

  // Yanıtta sır YOK.
  const dump = JSON.stringify([a, b])
  assert.ok(!dump.includes('GIZLI-SURAT'), 'pano yanıtı sır taşımamalı')
})

test('IS-4: pazaryeri sağlığı — kayıtlı / doğrulandı / reddedildi ayrımı', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ty')
  await credentials.saveIntegrationCredential(db, org, 'trendyol', { sellerId: '100', apiKey: 'GIZLI-KEY', apiSecret: 'GIZLI-SECRET' })
  const account = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '100')

  let board = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: org, nowMs: NOW }))
  assert.equal(board.trendyol.health.state, 'configured')

  const verifiedAt = new Date(NOW - 5 * 60_000)
  await carriers.recordMarketplaceVerification(db, { organizationId: org, marketplaceAccountId: account.id, status: 'verified', now: verifiedAt })
  board = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: org, nowMs: NOW }))
  assert.equal(board.trendyol.health.state, 'verified')
  assert.equal(board.trendyol.health.lastVerifiedAt, verifiedAt.toISOString())

  await carriers.recordMarketplaceVerification(db, { organizationId: org, marketplaceAccountId: account.id, status: 'auth_failed', now: new Date(NOW) })
  board = byKey(await status.loadIntegrationStatusBoard(db, { organizationId: org, nowMs: NOW }))
  assert.equal(board.trendyol.health.state, 'auth_error')
  assert.ok(!JSON.stringify(board).includes('GIZLI-'), 'pano yanıtı sır taşımamalı')
})

test('IS-5: eski senkron hatası sonradan başarılı bağlantıyı "hatalı" GÖSTERMEZ', () => {
  const entry = (over) => ({
    providerKey: 'trendyol',
    connection: 'CONNECTED',
    sync: 'HEALTHY',
    lastSuccessfulSyncAt: '2026-10-12T09:00:00.000Z',
    lastErrorClass: null,
    ...over,
  })
  const active = [{ isActive: true, verificationStatus: 'unverified', lastVerifiedAt: null }]
  // Son senkron başarılı; eski sınıf kalıntısı sayılmaz.
  assert.equal(status.connectionHealthFromIntegrationHealth([entry({ lastErrorClass: 'AUTH' })], active).state, 'verified')
  assert.equal(status.connectionHealthFromIntegrationHealth([entry({ sync: 'FAILED', lastErrorClass: 'RATE_LIMIT' })], active).state, 'rate_limited')
  assert.equal(status.connectionHealthFromIntegrationHealth([entry({ sync: 'FAILED', lastErrorClass: 'PROVIDER_5XX' })], active).state, 'provider_unavailable')
  assert.equal(status.connectionHealthFromIntegrationHealth([entry({ sync: 'FAILED', lastErrorClass: 'AUTH' })], active).state, 'auth_error')
  assert.equal(status.connectionHealthFromIntegrationHealth([entry({ connection: 'DISCONNECTED' })], active).state, 'auth_error')
  assert.equal(
    status.connectionHealthFromIntegrationHealth([entry({})], [{ isActive: true, verificationStatus: 'permission_denied' }]).state,
    'permission_error',
  )
  assert.equal(status.connectionHealthFromIntegrationHealth([entry({})], [{ isActive: false }]).state, 'disabled')
  assert.equal(status.connectionHealthFromIntegrationHealth([entry({ connection: 'NOT_CONFIGURED' })], active).state, 'not_configured')
})

test('IS-6: uç kiracı kapsamlıdır ve yayın aşaması tek kaynaktan okunur', () => {
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const paths = index.slice(index.indexOf('const TENANT_AUTH_PATHS'), index.indexOf(']', index.indexOf('const TENANT_AUTH_PATHS')))
  assert.match(paths, /'\/api\/integrations\/catalog'/)
  const start = index.indexOf("app.get('/api/integrations/catalog'")
  assert.ok(start > 0, 'durum ucu bulunamadı')
  const block = index.slice(start, index.indexOf('\n})', start))
  assert.match(block, /requireOnboardingContext/)
  assert.match(block, /organizationId: context\.organizationId/)

  const source = readFileSync(join(here, 'connectors', 'integrationStatus.ts'), 'utf8')
  // Yayın aşaması kopyalanmaz: providerCatalog + Aras yayın sabiti.
  assert.match(source, /resolveRolloutStage\('woocommerce'\)/)
  assert.match(source, /ARAS_ROLLOUT_STAGE/)
  assert.equal(/ROLLOUT_STAGE_POLICY\s*[:=]/.test(source), false)
})
