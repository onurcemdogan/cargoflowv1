// ARAS-EXPANSION — kimlik, kimlik deposu, saglik, boru hatti, tasiyici dislama.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

assert.notEqual(process.env.REAL_CARRIER_NETWORK, '1')

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const identity = await import('./connectors/aras/arasIdentity.ts')
const connection = await import('./connectors/aras/arasConnectionService.ts')
const store = await import('./connectors/connectorCredentialStore.ts')
const healthService = await import('./connectors/integrationHealthService.ts')
const { connectionKey } = await import('./connectors/integrationHealth.ts')
const eligibility = await import('./shipments/trendyolShipmentEligibility.ts')
const pipeline = await import('./carriers/aras/arasShipmentPipeline.ts')
const rollout = await import('./carriers/aras/arasRollout.ts')
const artifactStoreModule = await import('./carriers/aras/arasLabelArtifactStore.ts')
const operationStoreModule = await import('./carriers/aras/arasOperationStore.ts')
const preflightModule = await import('./shipments/shipmentPreflight.ts')

// PHASE2-D: Aras create ONAYLI ortak ön kontrol + DOĞRULANMIŞ ödeyen kodu +
// ortak işlem kaydı ister. Test kimliği AÇIKÇA test değeridir — resmî Aras
// değer tablosu iddiası DEĞİLDİR.
const TEST_VERIFIED_PAYOR_CODE = 'TEST-VERIFIED-MAPPING'

function approvedPreflight(organizationId = 'org-test', carrierAccountId = 'aras-ca') {
  const result = preflightModule.evaluateShipmentPreflight({
    organizationId,
    provider: 'aras',
    order: { marketplace: 'Trendyol', packageId: 'pkg', recipientName: 'A', address: 'B', city: 'İstanbul' },
    marketplaceAccounts: [],
    carrierAccounts: [{
      id: carrierAccountId, provider: 'aras', displayName: 'Aras', externalAccountRef: null,
      credentialRef: 'connector_credentials:x', verificationStatus: 'verified',
      lastVerifiedAt: '2026-10-12T09:00:00.000Z', lastVerificationAttemptAt: null, enabled: true,
    }],
    carrierMappings: [],
    payer: { payer: 'SELLER_PAYS', source: 'ACCOUNT_CONFIG' },
    carrierPayer: null,
    idempotencyKey: `ARAS:${organizationId}:pkg:CREATE`,
  })
  assert.equal(result.ok, true)
  return result
}

function hardened(extra = {}) {
  return {
    preflight: approvedPreflight(),
    verifiedPayorTypeCode: TEST_VERIFIED_PAYOR_CODE,
    operationStore: operationStoreModule.createMemoryArasOperationStore(),
    ...extra,
  }
}

function migrationStatements() {
  const dir = join(root, 'drizzle')
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
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db) {
  const slug = `aras-${randomBytes(4).toString('hex')}`
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

test('ARE-1: UserName providerAccountId OLAMAZ', () => {
  assert.throws(
    () => identity.assertArasCredentialNeverIdentity({ candidateValue: 'secret-user', userName: 'secret-user' }),
    (e) => e?.code === 'ARAS_CREDENTIAL_NOT_IDENTITY',
  )
})

test('ARE-2: kimlikler DBde sifreli; ham okuma duz metin vermez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const connected = await connection.connectArasCarrierAccount(db, {
    organizationId: org,
    userName: 'aras-wire-user',
    password: 'aras-wire-pass',
    displayName: 'Test Aras',
  })
  assert.equal(connected.ok, true)
  const rows = await db.select().from(schema.connectorCredentials)
  assert.equal(rows.length, 1)
  const payload = String(rows[0].encryptedPayload)
  assert.equal(payload.includes('aras-wire-user'), false)
  assert.equal(payload.includes('aras-wire-pass'), false)
  const loaded = await connection.loadArasCredentialsForAccount(db, {
    organizationId: org,
    marketplaceAccountId: connected.marketplaceAccountId,
  })
  assert.equal(loaded.userName, 'aras-wire-user')
})

test('ARE-3: kardes Aras hesaplari kimlikleri paylasmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const a = await connection.connectArasCarrierAccount(db, {
    organizationId: org, userName: 'u1', password: 'p1',
  })
  const b = await connection.connectArasCarrierAccount(db, {
    organizationId: org, userName: 'u2', password: 'p2',
  })
  assert.notEqual(a.marketplaceAccountId, b.marketplaceAccountId)
  const credA = await store.getConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: a.marketplaceAccountId,
    providerKey: 'aras',
  })
  const credB = await store.getConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: b.marketplaceAccountId,
    providerKey: 'aras',
  })
  assert.equal(credA.payload.userName, 'u1')
  assert.equal(credB.payload.userName, 'u2')
})

test('ARE-4: kiraci B, kiraci A Aras kimligini okuyamaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const a = await connection.connectArasCarrierAccount(db, {
    organizationId: orgA, userName: 'only-a', password: 'pass-a',
  })
  const leaked = await store.getConnectorCredential(db, {
    organizationId: orgB,
    marketplaceAccountId: a.marketplaceAccountId,
    providerKey: 'aras',
  })
  assert.equal(leaked, null)
})

test('ARE-5: saglik aras::<hesapId> anahtari ve NEVER_RUN hesap tasir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const connected = await connection.connectArasCarrierAccount(db, {
    organizationId: org, userName: 'h', password: 'p',
  })
  const presence = await healthService.loadAccountCredentialPresence(db, { organizationId: org })
  const key = connectionKey('aras', connected.marketplaceAccountId)
  assert.equal(presence[key], 'PRESENT')
})

test('ARE-6: Aras siparisi Surat create on kontrolunu kapatir', () => {
  const result = eligibility.buildTrendyolShipmentEligibility({
    cargoProviderName: 'Aras Kargo',
    cargoTrackingNumber: 'TN1',
    marketplaceStatus: 'Shipped',
    isReadyToShip: true,
  })
  assert.equal(result.canCallSurat, false)
})

test('ARE-7: bos cargoProviderName Surat create acmaz', () => {
  const result = eligibility.buildTrendyolShipmentEligibility({
    cargoTrackingNumber: 'TN1',
    marketplaceStatus: 'Shipped',
    isReadyToShip: true,
  })
  assert.equal(result.canCallSurat, false)
})

test('ARE-8: internal_test rollout canli yan etki acamaz', () => {
  assert.equal(rollout.canArasCarrierAffectLiveFulfillment(), false)
})

function arasFetchImpl(calls) {
  return async (_url, init) => {
    calls.push(init.headers.SOAPAction)
    const body = init.body
    if (body.includes('<SetOrder')) {
      return {
        ok: true, status: 200,
        text: async () => '<Envelope><ResultCode>0</ResultCode><ResultMessage>OK</ResultMessage></Envelope>',
      }
    }
    if (body.includes('GetOrderWithIntegrationCode')) {
      const requested = body.match(/<integrationCode>([\s\S]*?)<\/integrationCode>/)?.[1] ?? ''
      return {
        ok: true, status: 200,
        text: async () => `<Envelope><IntegrationCode>${requested}</IntegrationCode></Envelope>`,
      }
    }
    if (body.includes('<GetBarcode')) {
      return {
        ok: true, status: 200,
        text: async () => '<Envelope><ZebraZpl>^XA^XZ</ZebraZpl></Envelope>',
      }
    }
    return { ok: false, status: 500, text: async () => '<Envelope/>' }
  }
}

test('ARE-9: boru hatti mock tasima ile create-verify-label-reprint (KALICI depo)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const artifactStore = artifactStoreModule.createDbArasLabelArtifactStore(db)
  const calls = []
  const outcome = await pipeline.runArasInternalTestPipeline({
    organizationId: org,
    orderId: 'ord1',
    credentials: { userName: 'u', password: 'p' },
    shipmentFields: { ReceiverName: 'A', ReceiverAddress: 'B' },
    fetchImpl: arasFetchImpl(calls),
    artifactStore,
    ...hardened(),
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.verificationState, 'VERIFIED_REGISTERED')
  assert.equal(outcome.persistedArtifact?.content, '^XA^XZ')
  assert.deepEqual(calls, [
    'http://tempuri.org/SetOrder',
    'http://tempuri.org/GetOrderWithIntegrationCode',
    'http://tempuri.org/GetBarcode',
  ])

  // KALICILIK KANITI: satır DB'de gerçekten var ve şifreli — düz metin YOK.
  const rows = await db.select().from(schema.arasLabelArtifacts)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].artifactEncrypted.includes('^XA^XZ'), false)

  // REPRINT-FROM-STORAGE: taşıyıcı TEKRAR ÇAĞRILMADAN, yalnız depodan okur.
  const callsBeforeReprint = calls.length
  const reloaded = await artifactStore.load(org, outcome.integrationCode)
  assert.equal(reloaded?.content, '^XA^XZ')
  assert.equal(calls.length, callsBeforeReprint, 'reprint taşıyıcıya GİTMEZ')

  // İMMUTABLE YAZIM: aynı integrationCode için ikinci bir persist() çağrısı
  // (ör. eşzamanlı retry) mevcut kaydı DEĞİŞTİRMEZ.
  const overwriteAttempt = await artifactStore.persist(org, outcome.integrationCode, {
    type: 'ZPL', content: '^DIFFERENT^', encoding: 'text',
  })
  assert.equal(overwriteAttempt, false)
  const stillOriginal = await artifactStore.load(org, outcome.integrationCode)
  assert.equal(stillOriginal?.content, '^XA^XZ')
  const rowsAfterOverwriteAttempt = await db.select().from(schema.arasLabelArtifacts)
  assert.equal(rowsAfterOverwriteAttempt.length, 1)
})

test('ARE-9b: depoda artefakt yokken reprint FAIL-CLOSED olur (taşıyıcıya yeniden gidilmez)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const artifactStore = artifactStoreModule.createDbArasLabelArtifactStore(db)
  const calls = []
  const outcome = await pipeline.runArasInternalTestPipeline({
    organizationId: org,
    orderId: 'ord-fail',
    credentials: { userName: 'u', password: 'p' },
    shipmentFields: { ReceiverName: 'A', ReceiverAddress: 'B' },
    fetchImpl: async (_url, init) => {
      calls.push(init.headers.SOAPAction)
      const body = init.body
      if (body.includes('<SetOrder')) {
        return {
          ok: true, status: 200,
          text: async () => '<Envelope><ResultCode>0</ResultCode><ResultMessage>OK</ResultMessage></Envelope>',
        }
      }
      if (body.includes('GetOrderWithIntegrationCode')) {
        const requested = body.match(/<integrationCode>([\s\S]*?)<\/integrationCode>/)?.[1] ?? ''
        return {
          ok: true, status: 200,
          text: async () => `<Envelope><IntegrationCode>${requested}</IntegrationCode></Envelope>`,
        }
      }
      // GetBarcode boş/basılamaz artefakt döner: hiçbir şey depoya yazılmaz.
      if (body.includes('<GetBarcode')) {
        return { ok: true, status: 200, text: async () => '<Envelope/>' }
      }
      return { ok: false, status: 500, text: async () => '<Envelope/>' }
    },
    artifactStore,
    ...hardened(),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.persistedArtifact, null)
  const rows = await db.select().from(schema.arasLabelArtifacts)
  assert.equal(rows.length, 0)
})

test('ARE-10: COD dogrulanmamis deger tablosu boru hattinda reddedilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const outcome = await pipeline.runArasInternalTestPipeline({
    organizationId: org,
    orderId: 'ord2',
    credentials: { userName: 'u', password: 'p' },
    shipmentFields: { ReceiverName: 'A', ReceiverAddress: 'B' },
    cod: { isCod: true, codAmount: 10 },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<Envelope/>' }),
    artifactStore: artifactStoreModule.createDbArasLabelArtifactStore(db),
    ...hardened(),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_COD_VALUE_TABLE_UNVERIFIED')
  assert.equal(outcome.carrierCreateCalled, false)
})

/* ─── PHASE2-D: ödeyen fail-closed, ön kontrol, ortak idempotency ───── */

function countingFetch(calls, { setOrder = 'ok' } = {}) {
  const base = arasFetchImpl(calls)
  return async (url, init) => {
    if (init.body.includes('<SetOrder')) {
      calls.push(init.headers.SOAPAction)
      if (setOrder === 'timeout') throw new Error('zaman aşımı')
      if (setOrder === '503') return { ok: false, status: 503, text: async () => '' }
      if (setOrder === 'reject') {
        return { ok: true, status: 200, text: async () => '<Envelope><ResultCode>1</ResultCode><ResultMessage>Hatalı alan</ResultMessage></Envelope>' }
      }
      return { ok: true, status: 200, text: async () => '<Envelope><ResultCode>0</ResultCode><ResultMessage>OK</ResultMessage></Envelope>' }
    }
    return base(url, init)
  }
}

const setOrderCalls = (calls) => calls.filter((action) => action === 'http://tempuri.org/SetOrder').length

test('ARE-11: ödeyen FAIL-CLOSED — eşleme yoksa veya PayorTypeCode doğrudan verilirse SetOrder YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const calls = []
  const common = {
    organizationId: org,
    orderId: 'ord-payer',
    credentials: { userName: 'u', password: 'p' },
    fetchImpl: countingFetch(calls),
    artifactStore: artifactStoreModule.createDbArasLabelArtifactStore(db),
  }
  const noMapping = await pipeline.runArasInternalTestPipeline({
    ...common, shipmentFields: { ReceiverName: 'A' }, ...hardened({ verifiedPayorTypeCode: null }),
  })
  assert.equal(noMapping.errorCode, 'ARAS_PAYER_MAPPING_UNVERIFIED')
  const guessed = await pipeline.runArasInternalTestPipeline({
    ...common, shipmentFields: { ReceiverName: 'A', PayorTypeCode: '1' }, ...hardened(),
  })
  assert.equal(guessed.errorCode, 'ARAS_PAYER_FIELD_NOT_ALLOWED')
  assert.equal(setOrderCalls(calls), 0)
})

test('ARE-12: onaysız ortak ön kontrol (UNKNOWN ödeyen) → SetOrder YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const calls = []
  const rejected = preflightModule.evaluateShipmentPreflight({
    organizationId: org,
    provider: 'aras',
    order: { marketplace: 'Trendyol', packageId: 'p', recipientName: 'A', address: 'B', city: 'İstanbul' },
    marketplaceAccounts: [],
    carrierAccounts: [],
    carrierMappings: [],
    payer: { payer: 'UNKNOWN', source: 'UNKNOWN' },
    carrierPayer: null,
    idempotencyKey: 'k',
  })
  const outcome = await pipeline.runArasInternalTestPipeline({
    organizationId: org,
    orderId: 'ord-pf',
    credentials: { userName: 'u', password: 'p' },
    shipmentFields: { ReceiverName: 'A' },
    fetchImpl: countingFetch(calls),
    artifactStore: artifactStoreModule.createDbArasLabelArtifactStore(db),
    ...hardened({ preflight: rejected }),
  })
  assert.equal(outcome.errorCode, 'ARAS_PREFLIGHT_BLOCKED')
  assert.ok(outcome.preflightBlockers.includes('PAYER_UNKNOWN'))
  assert.ok(outcome.preflightBlockers.includes('CARRIER_ACCOUNT_NOT_CONFIGURED'))
  assert.equal(setOrderCalls(calls), 0)
})

test('ARE-13: ortak işlem kaydı — tekrar replay eder, eşzamanlı çift tıklama TEK SetOrder, zaman aşımı sonrası yeniden create YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const artifactStore = artifactStoreModule.createDbArasLabelArtifactStore(db)
  const operationStore = operationStoreModule.createDbArasOperationStore(db)
  const connected = await connection.connectArasCarrierAccount(db, { organizationId: org, userName: 'aras-user', password: 'aras-pass' })
  const carrierRow = (await pglite.query(`select id from carrier_accounts where credential_ref = $1`, [`connector_credentials:${connected.marketplaceAccountId}`])).rows[0]
  const calls = []
  const run = (orderId, fetchImpl) =>
    pipeline.runArasInternalTestPipeline({
      organizationId: org,
      orderId,
      credentials: { userName: 'u', password: 'p' },
      shipmentFields: { ReceiverName: 'A', ReceiverAddress: 'B' },
      fetchImpl,
      artifactStore,
      ...hardened({ operationStore, preflight: approvedPreflight(org, carrierRow.id) }),
    })

  // Eşzamanlı çift tıklama.
  const [first, second] = await Promise.all([run('ord-dup', countingFetch(calls)), run('ord-dup', countingFetch(calls))])
  assert.equal(setOrderCalls(calls), 1, 'tek SetOrder')
  assert.deepEqual([first.ok || second.ok, [first.errorCode, second.errorCode].includes('ARAS_CREATE_IN_FLIGHT')], [true, true])

  // Yeniden deneme / istemcinin tekrar göndermesi → kayıttan replay.
  const again = await run('ord-dup', countingFetch(calls))
  assert.equal(again.replayed, true)
  assert.equal(again.ok, true)
  assert.equal(again.carrierCreateCalled, false)
  assert.equal(setOrderCalls(calls), 1)

  // Ortak tablo: işlem + gönderi satırı, köken normalize kolonlarda.
  const operation = (await pglite.query(`select provider, status, carrier_create_called, payer_type, payer_source, contract_source, rate_source, carrier_account_id from shipment_operations where idempotency_key = $1`, [`ARAS:${org}:ord-dup:CREATE`])).rows[0]
  assert.deepEqual(operation, {
    provider: 'aras', status: 'succeeded', carrier_create_called: true,
    payer_type: 'SELLER_PAYS', payer_source: 'ACCOUNT_CONFIG', contract_source: 'CARRIER_ACCOUNT', rate_source: 'NOT_QUOTED',
    carrier_account_id: carrierRow.id,
  })
  const shipment = (await pglite.query(`select provider, package_id, payer_type, expected_payer, resolved_payer from shipments`)).rows
  assert.deepEqual(shipment, [{ provider: 'aras', package_id: 'ord-dup', payer_type: 'SELLER_PAYS', expected_payer: 'SELLER_PAYS', resolved_payer: 'SELLER_PAYS' }])

  // Zaman aşımı: sonuç belirsiz → ikinci create MÜKERRER olur → bloke.
  const timeoutCalls = []
  const timedOut = await run('ord-timeout', countingFetch(timeoutCalls, { setOrder: 'timeout' }))
  assert.equal(timedOut.errorCode, 'ARAS_CREATE_OUTCOME_UNKNOWN')
  const retry = await run('ord-timeout', countingFetch(timeoutCalls))
  assert.equal(retry.errorCode, 'ARAS_CREATE_OUTCOME_UNKNOWN')
  assert.equal(setOrderCalls(timeoutCalls), 1, 'zaman aşımı sonrası ikinci SetOrder YOK')

  // 5xx de belirsizdir.
  const fiveCalls = []
  await run('ord-503', countingFetch(fiveCalls, { setOrder: '503' }))
  assert.equal((await run('ord-503', countingFetch(fiveCalls))).errorCode, 'ARAS_CREATE_OUTCOME_UNKNOWN')
  assert.equal(setOrderCalls(fiveCalls), 1)

  // Açık RED: Aras'ta gönderi yok → düzeltilip yeniden açılabilir.
  const rejectCalls = []
  const rejected = await run('ord-reject', countingFetch(rejectCalls, { setOrder: 'reject' }))
  assert.equal(rejected.ok, false)
  const reopened = await run('ord-reject', countingFetch(rejectCalls))
  assert.equal(reopened.ok, true)
  assert.equal(setOrderCalls(rejectCalls), 2)
})
