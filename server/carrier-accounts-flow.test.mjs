import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// PHASE2-C — TAŞIYICI HESAPLARI + EŞLEME (hermetik: pglite + gerçek migration).

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const carriers = await import('./carriers/carrierAccounts.ts')
const credentials = await import('./integrations/credentialService.ts')
const aras = await import('./connectors/aras/arasConnectionService.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const onboardingModel = await import('./onboarding/onboardingModel.ts')
const billing = await import('./shipments/shippingBillingParty.ts')

const DIR = join(here, '..', 'drizzle')
const FILES = readdirSync(DIR).filter((file) => file.endsWith('.sql')).sort()
const statementsOf = (file) =>
  readFileSync(join(DIR, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)

async function makeDb({ until } = {}) {
  const pglite = new PGlite()
  for (const file of FILES) {
    if (until && file >= until) break
    for (const statement of statementsOf(file)) await pglite.exec(statement)
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db, slug) {
  // Ham SQL: migration öncesi şemada da çalışır.
  const rows = await db.$client.query('INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id', [slug])
  return rows.rows[0].id
}

const record = (overrides) => ({
  id: 'ca', provider: 'surat', displayName: 'Sürat Kargo', externalAccountRef: null,
  credentialRef: 'integration_credentials:surat', verificationStatus: 'unverified',
  lastVerifiedAt: null, lastVerificationAttemptAt: null, enabled: true, ...overrides,
})

test('CA-1: 0017 backfill — mevcut Sürat kimliği ve Aras hesabı taşıyıcı hesabı olur; sır TAŞINMAZ; idempotent', async (t) => {
  const migration = FILES.find((file) => file.startsWith('0017_'))
  const { pglite, db } = await makeDb({ until: migration })
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'a')
  const orgB = await makeOrg(db, 'b')
  await credentials.saveIntegrationCredential(db, orgA, 'surat', { kullaniciAdi: 'cari-a', sifre: 'GIZLI-SURAT' })
  await credentials.saveIntegrationCredential(db, orgB, 'trendyol', { sellerId: '1', apiKey: 'k', apiSecret: 's' })
  // Migration ÖNCESİ şema: yeni kolonlar yok → ham SQL.
  const arasRow = (
    await pglite.query(
      `INSERT INTO marketplace_accounts (organization_id, marketplace, provider_account_id, display_name, is_active)
       VALUES ($1, 'aras', 'aras-local-1', 'Aras Test', true) RETURNING id`,
      [orgB],
    )
  ).rows[0]

  for (const statement of statementsOf(migration)) await pglite.exec(statement)
  // İkinci uygulama (yeniden çalıştırma) çift satır ÜRETMEZ.
  for (const statement of statementsOf(migration).filter((s) => s.includes('INSERT INTO "carrier_accounts"'))) {
    await pglite.exec(statement)
  }

  const rows = (await pglite.query('select organization_id, provider, display_name, credential_ref, verification_status, enabled from carrier_accounts order by provider')).rows
  assert.deepEqual(rows, [
    { organization_id: orgB, provider: 'aras', display_name: 'Aras Test', credential_ref: `connector_credentials:${arasRow.id}`, verification_status: 'unverified', enabled: true },
    { organization_id: orgA, provider: 'surat', display_name: 'Sürat Kargo', credential_ref: 'integration_credentials:surat', verification_status: 'unverified', enabled: true },
  ])
  const dump = JSON.stringify((await pglite.query('select * from carrier_accounts')).rows)
  assert.ok(!dump.includes('GIZLI-SURAT'))
  // Mevcut pazaryeri hesapları doğrulanmamış başlar (doğrulama UYDURULMAZ).
  assert.ok((await pglite.query('select verification_status from marketplace_accounts')).rows.every((row) => row.verification_status === 'unverified'))
})

test('CA-2: çözümleme — açık eşleme, sağlayıcı uyuşmazlığı, kapalı hesap, belirsizlik, tek hesap', () => {
  const surat = record({ id: 's1' })
  const surat2 = record({ id: 's2', credentialRef: 'x' })
  const arasAcc = record({ id: 'a1', provider: 'aras', credentialRef: 'connector_credentials:m' })
  const resolve = carriers.resolveCarrierAccountFromRecords
  assert.deepEqual(resolve([surat], [], { provider: 'surat', marketplaceAccountId: 'm1' }), { ok: true, account: surat, source: 'ONLY_ACCOUNT_FOR_PROVIDER' })
  assert.deepEqual(resolve([surat], [], { provider: 'surat', marketplaceAccountId: null }).ok, true)
  assert.deepEqual(resolve([], [], { provider: 'surat', marketplaceAccountId: 'm1' }), { ok: false, code: 'CARRIER_ACCOUNT_NOT_CONFIGURED' })
  assert.deepEqual(resolve([surat, surat2], [], { provider: 'surat', marketplaceAccountId: 'm1' }), { ok: false, code: 'CARRIER_ACCOUNT_AMBIGUOUS' })
  const mapped = resolve([surat, surat2], [{ marketplaceAccountId: 'm1', carrierAccountId: 's2' }], { provider: 'surat', marketplaceAccountId: 'm1' })
  assert.equal(mapped.ok && mapped.account.id, 's2')
  assert.equal(mapped.source, 'EXPLICIT_MAPPING')
  assert.deepEqual(resolve([surat, arasAcc], [{ marketplaceAccountId: 'm1', carrierAccountId: 'a1' }], { provider: 'surat', marketplaceAccountId: 'm1' }), { ok: false, code: 'CARRIER_MAPPING_PROVIDER_MISMATCH' })
  assert.deepEqual(resolve([record({ id: 's1', enabled: false }), surat2], [{ marketplaceAccountId: 'm1', carrierAccountId: 's1' }], { provider: 'surat', marketplaceAccountId: 'm1' }), { ok: false, code: 'CARRIER_ACCOUNT_DISABLED' })
  // Kapalı hesap tek-hesap kuralında aday SAYILMAZ.
  assert.deepEqual(resolve([record({ enabled: false })], [], { provider: 'surat', marketplaceAccountId: null }), { ok: false, code: 'CARRIER_ACCOUNT_NOT_CONFIGURED' })
})

test('CA-3: eşleme yazımı kiracı sahipliğini doğrular; kapalı hesap eşlenemez; null eşlemeyi kaldırır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'a')
  const orgB = await makeOrg(db, 'b')
  await credentials.saveIntegrationCredential(db, orgA, 'surat', { kullaniciAdi: 'cari-a', sifre: 's' })
  await credentials.saveIntegrationCredential(db, orgB, 'surat', { kullaniciAdi: 'cari-b', sifre: 's' })
  const carrierA = await carriers.syncSuratCarrierAccount(db, orgA)
  const carrierB = await carriers.syncSuratCarrierAccount(db, orgB)
  const marketA = await accounts.resolveOrCreateActiveAccount(db, orgA, 'Trendyol', '100')

  await assert.rejects(
    carriers.setCarrierMapping(db, { organizationId: orgA, marketplaceAccountId: marketA.id, carrierAccountId: carrierB.id }),
    (error) => error.code === 'CARRIER_ACCOUNT_NOT_FOUND',
  )
  await assert.rejects(
    carriers.setCarrierMapping(db, { organizationId: orgB, marketplaceAccountId: marketA.id, carrierAccountId: carrierB.id }),
    (error) => error.code === 'MARKETPLACE_ACCOUNT_NOT_FOUND',
  )
  await carriers.setCarrierMapping(db, { organizationId: orgA, marketplaceAccountId: marketA.id, carrierAccountId: carrierA.id })
  assert.deepEqual(await carriers.listCarrierMappings(db, orgA), [{ marketplaceAccountId: marketA.id, carrierAccountId: carrierA.id }])
  assert.deepEqual(await carriers.listCarrierMappings(db, orgB), [])
  const resolved = await carriers.resolveCarrierAccount(db, { organizationId: orgA, provider: 'surat', marketplaceAccountId: marketA.id })
  assert.equal(resolved.ok && resolved.source, 'EXPLICIT_MAPPING')

  await db.update(schema.carrierAccounts).set({ enabled: false })
  await assert.rejects(
    carriers.setCarrierMapping(db, { organizationId: orgA, marketplaceAccountId: marketA.id, carrierAccountId: carrierA.id }),
    (error) => error.code === 'CARRIER_ACCOUNT_DISABLED',
  )
  await carriers.setCarrierMapping(db, { organizationId: orgA, marketplaceAccountId: marketA.id, carrierAccountId: null })
  assert.deepEqual(await carriers.listCarrierMappings(db, orgA), [])
})

test('CA-4: parmak izi anahtarlıdır (düz hash DEĞİL); sır taşıyıcı tablosuna YAZILMAZ; Sürat kimliği silinince hesap kapanır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'a')
  const payload = { kullaniciAdi: 'cari-a', sifre: 'ZAYIF123' }
  await credentials.saveIntegrationCredential(db, org, 'surat', payload)
  const account = await carriers.syncSuratCarrierAccount(db, org)
  assert.equal(account.externalAccountRef, 'cari-a')
  const row = (await pglite.query('select * from carrier_accounts')).rows[0]
  assert.ok(row.credential_fingerprint)
  const plain = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  assert.notEqual(row.credential_fingerprint, plain)
  assert.ok(!JSON.stringify(row).includes('ZAYIF123'))

  await credentials.deleteIntegrationCredential(db, org, 'surat')
  assert.equal(await carriers.syncSuratCarrierAccount(db, org), null)
  assert.equal((await carriers.listCarrierAccounts(db, org))[0].enabled, false)
})

test('CA-5: Aras bağlantısı taşıyıcı hesabı oluşturur (doğrulanmamış — canlı probe YOK); bağlantı kesilince kapanır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'a')
  const connected = await aras.connectArasCarrierAccount(db, { organizationId: org, userName: 'aras-user', password: 'aras-pass', displayName: 'Aras Depo' })
  assert.equal(connected.ok, true)
  const [account] = await carriers.listCarrierAccounts(db, org)
  assert.equal(account.provider, 'aras')
  assert.equal(account.displayName, 'Aras Depo')
  assert.equal(account.verificationStatus, 'unverified')
  assert.equal(account.credentialRef, `connector_credentials:${connected.marketplaceAccountId}`)
  assert.ok(!JSON.stringify(await pglite.query('select * from carrier_accounts')).includes('aras-pass'))
  await aras.disconnectArasCarrierAccount(db, { organizationId: org, marketplaceAccountId: connected.marketplaceAccountId })
  assert.equal((await carriers.listCarrierAccounts(db, org))[0].enabled, false)
})

test('CA-6: onboarding OPERATIONS — yanlış sağlayıcıya eşleme çözümsüz; ödeyen sinyali listesi tek kaynakla eşit', () => {
  assert.deepEqual([...onboardingModel.PAYER_SIGNAL_MARKETPLACES], [...billing.MARKETPLACES_WITH_VERIFIED_ORDER_SIGNAL])
  const base = {
    completed: false,
    completedAt: null,
    providers: [{ providerKey: 'trendyol', displayName: 'Trendyol', rolloutStage: 'ga', eligibleForOnboarding: true, bootstrapResources: ['orders'] }],
    healthByResource: {
      orders: [{ providerKey: 'trendyol', marketplaceAccountId: 'm1', connectionScope: 'account', connection: 'CONNECTED', sync: 'HEALTHY', lastSuccessfulSyncAt: '2026-10-01T00:00:00.000Z' }],
    },
    accounts: [{ id: 'm1', marketplace: 'trendyol', displayName: 'Mağaza', isActive: true, verificationStatus: 'verified' }],
    accountScopedCredentialProviders: [],
    carrierConfigured: true,
    defaultUnitDesiConfigured: false,
    counts: { products: 0, orders: 1 },
    businessProfileComplete: true,
    carrierAccounts: [record({ id: 's1', verificationStatus: 'verified' }), record({ id: 'a1', provider: 'aras', credentialRef: 'c' })],
    carrierMappings: [{ marketplaceAccountId: 'm1', carrierAccountId: 'a1' }],
  }
  const mismatch = onboardingModel.evaluateOnboarding(base)
  assert.equal(mismatch.operations.resolved, false)
  assert.deepEqual(mismatch.operations.accounts[0].carrier, { ok: false, code: 'CARRIER_MAPPING_PROVIDER_MISMATCH' })
  assert.ok(mismatch.blockers.includes('OPERATIONS_UNRESOLVED'))
  assert.equal(mismatch.eligibleToComplete, false)

  const fixed = onboardingModel.evaluateOnboarding({ ...base, carrierMappings: [{ marketplaceAccountId: 'm1', carrierAccountId: 's1' }] })
  assert.equal(fixed.operations.resolved, true)
  assert.equal(fixed.eligibleToComplete, true)
  assert.deepEqual(fixed.steps.map((step) => [step.key, step.done]), [
    ['WELCOME', true], ['BUSINESS', true], ['MARKETPLACE', true], ['CARRIER', true], ['OPERATIONS', true], ['FIRST_SYNC', true], ['READY', false],
  ])
})
