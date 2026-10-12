import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// PHASE2-D — ORTAK GÖNDERİ ÖN KONTROLÜ + KÖKEN + ORTAK İŞLEM KAYDI.

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const preflight = await import('./shipments/shipmentPreflight.ts')
const persistence = await import('./shipments/shipmentPersistenceService.ts')
const operations = await import('./shipments/shipmentOperationRepository.ts')
const credentials = await import('./integrations/credentialService.ts')
const carriers = await import('./carriers/carrierAccounts.ts')

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

async function makeOrg(pglite, slug) {
  return (await pglite.query('INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id', [slug])).rows[0].id
}

const SURAT = {
  id: 'c-surat', provider: 'surat', displayName: 'Sürat Kargo', externalAccountRef: 'cari',
  credentialRef: 'integration_credentials:surat', verificationStatus: 'verified',
  lastVerifiedAt: '2026-10-12T09:00:00.000Z', lastVerificationAttemptAt: null, enabled: true,
}
const ORDER = { marketplace: 'Trendyol', packageId: 'PKG-1', orderNumber: 'TY-1', recipientName: 'Ayşe Yılmaz', address: 'Örnek Sk. 1', city: 'İstanbul' }

function input(overrides = {}) {
  return {
    organizationId: 'org-1',
    provider: 'surat',
    order: ORDER,
    marketplaceAccounts: [{ id: 'm1', marketplace: 'Trendyol', isActive: true }],
    carrierAccounts: [SURAT],
    carrierMappings: [],
    payer: { payer: 'MARKETPLACE_PAYS', source: 'ORDER_CONTRACT' },
    carrierPayer: 'MARKETPLACE_PAYS',
    idempotencyKey: 'SURAT:org-1:PKG-1:CREATE',
    ...overrides,
  }
}

const blockersOf = (result) => (result.ok ? [] : result.blockers)

test('SP-1: bilinen satış hesabı + doğrulanmış kargo + bilinen ödeyen → create SERBEST, köken tam', () => {
  const result = preflight.evaluateShipmentPreflight(input())
  assert.equal(result.ok, true)
  assert.deepEqual(result.provenance, {
    marketplaceAccountId: 'm1',
    marketplaceAccountSource: 'ONLY_ACTIVE_ACCOUNT',
    carrierAccountId: 'c-surat',
    carrierAccountSource: 'ONLY_ACCOUNT_FOR_PROVIDER',
    payerType: 'MARKETPLACE_PAYS',
    payerSource: 'ORDER_CONTRACT',
    expectedPayer: 'MARKETPLACE_PAYS',
    resolvedPayer: 'MARKETPLACE_PAYS',
    contractSource: 'CARRIER_ACCOUNT',
    rateSource: 'NOT_QUOTED',
    carrierVerifiedAt: '2026-10-12T09:00:00.000Z',
    preflightReference: 'SURAT:org-1:PKG-1:CREATE',
    preflightEvidence: { provider: 'surat' },
  })
})

test('SP-2: UNKNOWN ödeyen → create YOK (taşıyıcıdan bağımsız)', () => {
  for (const provider of ['surat', 'aras']) {
    const result = preflight.evaluateShipmentPreflight(
      input({ provider, carrierAccounts: [{ ...SURAT, provider }], payer: { payer: 'UNKNOWN', source: 'UNKNOWN' }, carrierPayer: null }),
    )
    assert.equal(result.ok, false)
    assert.deepEqual(blockersOf(result), ['PAYER_UNKNOWN'])
    assert.equal(result.errorCode, 'SHIPMENT_PREFLIGHT_BLOCKED')
    assert.match(result.message, /^Kontrol gerekli — gönderi oluşturulmadı\./)
  }
})

test('SP-3: kargo eşlemesi belirsiz / yanlış sağlayıcı / hesap yok → create YOK', () => {
  const second = { ...SURAT, id: 'c-surat-2', credentialRef: 'x' }
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ carrierAccounts: [SURAT, second] }))), ['CARRIER_ACCOUNT_AMBIGUOUS'])
  const aras = { ...SURAT, id: 'c-aras', provider: 'aras', credentialRef: 'connector_credentials:a' }
  assert.deepEqual(
    blockersOf(preflight.evaluateShipmentPreflight(input({ carrierAccounts: [SURAT, aras], carrierMappings: [{ marketplaceAccountId: 'm1', carrierAccountId: 'c-aras' }] }))),
    ['CARRIER_MAPPING_PROVIDER_MISMATCH'],
  )
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ carrierAccounts: [] }))), ['CARRIER_ACCOUNT_NOT_CONFIGURED'])
  // Açık eşleme belirsizliği çözer.
  const mapped = preflight.evaluateShipmentPreflight(input({ carrierAccounts: [SURAT, second], carrierMappings: [{ marketplaceAccountId: 'm1', carrierAccountId: 'c-surat-2' }] }))
  assert.equal(mapped.ok && mapped.provenance.carrierAccountId, 'c-surat-2')
  assert.equal(mapped.provenance.carrierAccountSource, 'EXPLICIT_MAPPING')
})

test('SP-4: kargo hesabı doğrulanmamış / reddedilmiş → create YOK', () => {
  for (const status of ['unverified', 'auth_failed', 'provider_unavailable']) {
    const result = preflight.evaluateShipmentPreflight(input({ carrierAccounts: [{ ...SURAT, verificationStatus: status }] }))
    assert.deepEqual(blockersOf(result), ['CARRIER_NOT_VERIFIED'])
  }
})

test('SP-5: ortak işlem kaydı — aynı deterministik anahtar İKİNCİ kez rezerve edilemez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(pglite, 'a')
  const columns = {
    organizationId: org, marketplace: 'Trendyol', packageId: 'PKG-1', provider: 'surat',
    operationType: 'CREATE', idempotencyKey: `SURAT:${org}:PKG-1:CREATE`, status: 'pending',
  }
  const results = await Promise.all([operations.reserveCreateOperation(db, columns), operations.reserveCreateOperation(db, columns)])
  assert.deepEqual(results.map((r) => r.won).sort(), [false, true])
  assert.equal((await pglite.query('select count(*)::int as n from shipment_operations')).rows[0].n, 1)
})

test('SP-6/7: pazaryeri öder ve satıcı öder — köken DOĞRU ve gönderi satırında NORMALİZE', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(pglite, 'b')
  await credentials.saveIntegrationCredential(db, org, 'surat', { kullaniciAdi: 'cari', sifre: 's' })
  const carrier = await carriers.syncSuratCarrierAccount(db, org)
  await carriers.recordCarrierVerification(db, { organizationId: org, carrierAccountId: carrier.id, status: 'verified' })
  const [account] = await db.insert(schema.marketplaceAccounts).values({ organizationId: org, marketplace: 'Trendyol', providerAccountId: '1', isActive: true }).returning()
  const records = { carrierAccounts: await carriers.listCarrierAccounts(db, org), marketplaceAccounts: [{ id: account.id, marketplace: 'Trendyol', isActive: true }] }

  const cases = [
    { pkg: 'PKG-MP', billingParty: 'TRENDYOL_PAYS', role: 'PRIMARY_MARKETPLACE', expected: 'MARKETPLACE_PAYS' },
    { pkg: 'PKG-SP', billingParty: 'SELLER_PAYS', role: 'SELLER_PAYS', expected: 'SELLER_PAYS' },
  ]
  for (const entry of cases) {
    const result = preflight.evaluateShipmentPreflight(
      input({
        organizationId: org,
        order: { ...ORDER, packageId: entry.pkg },
        ...records,
        payer: { payer: preflight.suratExpectedPayer(entry.billingParty), source: 'ORDER_CONTRACT' },
        carrierPayer: preflight.suratCarrierPayer(entry.role),
        idempotencyKey: `SURAT:${org}:${entry.pkg}:CREATE`,
        evidence: { billingEvidence: 'TRENDYOL_WHO_PAYS', credentialRole: entry.role },
      }),
    )
    assert.equal(result.ok, true)
    // Sürat kalıcı yazımı (işlem + gönderi tek transaction).
    await persistence.writeOperationRecord(db, org, {
      idempotencyKey: `SURAT:${org}:${entry.pkg}:CREATE`,
      marketplace: 'Trendyol',
      packageId: entry.pkg,
      provider: 'surat',
      status: 'SUCCESS',
      carrierTrackingNumber: `T-${entry.pkg}`,
      completedAt: new Date().toISOString(),
      shipment: { barkodNo: `B-${entry.pkg}` },
      shipmentProvenance: result.provenance,
    })
  }
  const rows = (await pglite.query(`select package_id, payer_type, payer_source, expected_payer, resolved_payer, contract_source, rate_source, marketplace_account_id, carrier_account_id, carrier_verified_at is not null as has_verified, preflight_evidence->>'credentialRole' as role from shipments order by package_id`)).rows
  assert.deepEqual(rows, [
    { package_id: 'PKG-MP', payer_type: 'MARKETPLACE_PAYS', payer_source: 'ORDER_CONTRACT', expected_payer: 'MARKETPLACE_PAYS', resolved_payer: 'MARKETPLACE_PAYS', contract_source: 'CARRIER_ACCOUNT', rate_source: 'NOT_QUOTED', marketplace_account_id: account.id, carrier_account_id: carrier.id, has_verified: true, role: 'PRIMARY_MARKETPLACE' },
    { package_id: 'PKG-SP', payer_type: 'SELLER_PAYS', payer_source: 'ORDER_CONTRACT', expected_payer: 'SELLER_PAYS', resolved_payer: 'SELLER_PAYS', contract_source: 'CARRIER_ACCOUNT', rate_source: 'NOT_QUOTED', marketplace_account_id: account.id, carrier_account_id: carrier.id, has_verified: true, role: 'SELLER_PAYS' },
  ])
  const ops = (await pglite.query(`select payer_type from shipment_operations order by package_id`)).rows
  assert.deepEqual(ops, [{ payer_type: 'MARKETPLACE_PAYS' }, { payer_type: 'SELLER_PAYS' }])

  // Köksüz bir sonraki yazım (replay/eski kayıt) mevcut kökeni SİLMEZ.
  await persistence.writeOperationRecord(db, org, {
    idempotencyKey: `SURAT:${org}:PKG-MP:CREATE`, marketplace: 'Trendyol', packageId: 'PKG-MP', provider: 'surat',
    status: 'SUCCESS', carrierTrackingNumber: 'T-PKG-MP', completedAt: new Date().toISOString(), shipment: { barkodNo: 'B' },
  })
  assert.equal((await pglite.query(`select payer_type from shipments where package_id = 'PKG-MP'`)).rows[0].payer_type, 'MARKETPLACE_PAYS')

  // Ödeyen TUTARSIZLIĞI: sipariş satıcı öder derken pazaryeri kimliğiyle gönderi YOK.
  const mismatch = preflight.evaluateShipmentPreflight(
    input({ ...records, organizationId: org, payer: { payer: 'SELLER_PAYS', source: 'ORDER_CONTRACT' }, carrierPayer: 'MARKETPLACE_PAYS' }),
  )
  assert.deepEqual(blockersOf(mismatch), ['PAYER_MISMATCH'])
  // COD rolü ödeyen beyanı değildir → tutarlılık kontrolü atlanır.
  assert.equal(preflight.suratCarrierPayer('COD'), null)
})

test('SP-8: satış hesabı kapsamı — sipariş hesabı, tek aktif hesap, eski kapsam, belirsizlik', () => {
  const two = [{ id: 'm1', marketplace: 'Trendyol', isActive: true }, { id: 'm2', marketplace: 'Trendyol', isActive: true }]
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ marketplaceAccounts: two }))), ['MARKETPLACE_ACCOUNT_AMBIGUOUS'])
  const own = preflight.evaluateShipmentPreflight(input({ marketplaceAccounts: two, order: { ...ORDER, marketplaceAccountId: 'm2' } }))
  assert.equal(own.ok && own.provenance.marketplaceAccountSource, 'ORDER')
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ order: { ...ORDER, marketplaceAccountId: 'yabanci' } }))), ['MARKETPLACE_ACCOUNT_NOT_FOUND'])
  const legacy = preflight.evaluateShipmentPreflight(input({ marketplaceAccounts: [] }))
  assert.equal(legacy.ok && legacy.provenance.marketplaceAccountSource, 'LEGACY_UNSCOPED')
  assert.equal(legacy.provenance.marketplaceAccountId, null)
})

test('SP-9: zorunlu alanlar, işlem kimliği ve kiracı kapsamı', () => {
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ order: { ...ORDER, address: '  ' } }))), ['REQUIRED_FIELDS_MISSING'])
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ order: { ...ORDER, packageId: null, orderNumber: null } }))), ['REQUIRED_FIELDS_MISSING'])
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ idempotencyKey: null }))), ['OPERATION_KEY_MISSING'])
  assert.deepEqual(blockersOf(preflight.evaluateShipmentPreflight(input({ organizationId: null }))), ['TENANT_SCOPE_MISSING'])
})

test('SP-10: 0018 kanıta dayalı doğrulama — başarı kimlik değişiminden SONRAysa doğrulanır', async (t) => {
  const migration = FILES.find((file) => file.startsWith('0018_'))
  const { pglite, db } = await makeDb({ until: migration })
  t.after(() => pglite.close())
  const proven = await makeOrg(pglite, 'proven')
  const changed = await makeOrg(pglite, 'changed')
  const never = await makeOrg(pglite, 'never')
  for (const org of [proven, changed, never]) {
    await credentials.saveIntegrationCredential(db, org, 'surat', { kullaniciAdi: 'cari', sifre: 's' })
    await pglite.query(`INSERT INTO carrier_accounts (organization_id, provider, display_name, credential_ref) VALUES ($1, 'surat', 'Sürat Kargo', 'integration_credentials:surat')`, [org])
  }
  await pglite.query(`UPDATE integration_credentials SET updated_at = '2026-09-01T00:00:00Z'`)
  await pglite.query(`UPDATE integration_credentials SET updated_at = '2026-10-05T00:00:00Z' WHERE organization_id = $1`, [changed])
  for (const org of [proven, changed]) {
    await pglite.query(
      `INSERT INTO shipment_operations (organization_id, marketplace, package_id, provider, operation_type, idempotency_key, status, completed_at)
       VALUES ($1, 'Trendyol', 'P', 'surat', 'CREATE', $2, 'succeeded', '2026-10-01T00:00:00Z')`,
      [org, `SURAT:${org}:P:CREATE`],
    )
  }
  for (const statement of statementsOf(migration)) await pglite.exec(statement)
  const status = async (org) => (await pglite.query('select verification_status, last_verified_at from carrier_accounts where organization_id = $1', [org])).rows[0]
  assert.equal((await status(proven)).verification_status, 'verified')
  assert.equal(new Date((await status(proven)).last_verified_at).toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal((await status(changed)).verification_status, 'unverified', 'kimlik başarıdan sonra değişti')
  assert.equal((await status(never)).verification_status, 'unverified', 'başarı kanıtı yok')
})
