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

test('ARE-9: boru hatti mock tasima ile create-verify-label-reprint', async () => {
  const calls = []
  const fetchImpl = async (_url, init) => {
    calls.push(init.headers.SOAPAction)
    const body = init.body
    if (body.includes('<SetOrder')) {
      return {
        ok: true, status: 200,
        text: async () => '<Envelope><ResultCode>0</ResultCode><ResultMessage>OK</ResultMessage></Envelope>',
      }
    }
    if (body.includes('GetOrderWithIntegrationCode')) {
      return {
        ok: true, status: 200,
        text: async () => '<Envelope><IntegrationCode>ARAS:org1:ord1:CREATE</IntegrationCode></Envelope>',
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
  const outcome = await pipeline.runArasInternalTestPipeline({
    organizationId: 'org1',
    orderId: 'ord1',
    credentials: { userName: 'u', password: 'p' },
    shipmentFields: { ReceiverName: 'A', ReceiverAddress: 'B' },
    fetchImpl,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.verificationState, 'VERIFIED_REGISTERED')
  assert.equal(outcome.persistedArtifact?.content, '^XA^XZ')
  assert.deepEqual(calls, [
    'http://tempuri.org/SetOrder',
    'http://tempuri.org/GetOrderWithIntegrationCode',
    'http://tempuri.org/GetBarcode',
  ])
})

test('ARE-10: COD dogrulanmamis deger tablosu boru hattinda reddedilir', async () => {
  const outcome = await pipeline.runArasInternalTestPipeline({
    organizationId: 'org1',
    orderId: 'ord2',
    credentials: { userName: 'u', password: 'p' },
    shipmentFields: { ReceiverName: 'A', ReceiverAddress: 'B' },
    cod: { isCod: true, codAmount: 10 },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<Envelope/>' }),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorCode, 'ARAS_COD_VALUE_TABLE_UNVERIFIED')
})
