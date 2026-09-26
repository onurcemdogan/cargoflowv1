// TICIMAX-001 — SÖZLEŞME-BAĞIMSIZ İSKELET (HERMETİK).
//
// SelectSiparis SOAP tel sözleşmesi DOĞRULANMADI → SOAP XML uydurulmaz.
// Kapı fail-closed; hermetik testler pageFetcher / kimlik / sır / imleç /
// yazma denylist / canlı yazma kapısı / rollout=off kanıtlar.
// LIVE_PROVIDER_VERIFICATION = NOT_PERFORMED.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const endpoint = await import('./connectors/ticimax/ticimaxEndpoint.ts')
const identity = await import('./connectors/ticimax/ticimaxIdentity.ts')
const wireGate = await import('./connectors/ticimax/ticimaxWireGate.ts')
const writeGuard = await import('./connectors/ticimax/ticimaxWriteGuard.ts')
const client = await import('./connectors/ticimax/ticimaxClient.ts')
const connection = await import('./connectors/ticimax/ticimaxConnectionService.ts')
const normalizer = await import('./connectors/ticimax/ticimaxOrderNormalizer.ts')
const pagination = await import('./connectors/ticimax/ticimaxPagination.ts')
const sync = await import('./connectors/ticimax/ticimaxOrderSync.ts')
const connectorStore = await import('./connectors/connectorCredentialStore.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const catalog = await import('./connectors/providerCatalog.ts')
const liveGate = await import('./connectors/liveWriteGate.ts')
const healthService = await import('./connectors/integrationHealthService.ts')

const pack = JSON.parse(
  readFileSync(join(root, 'providers/ticimax/contracts/siparisservis-v1.json'), 'utf8'),
)

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

async function makeOrg(db, label = 'ticimax') {
  const slug = `${label}-${randomBytes(4).toString('hex')}`
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

function order(id, over = {}) {
  return {
    SiparisID: id,
    SiparisNo: over.SiparisNo ?? `SN-${id}`,
    SiparisKodu: over.SiparisKodu ?? `SK-${id}`,
    SiparisDurumu: over.SiparisDurumu ?? 'Onay bekliyor',
    OdemeTipi: over.OdemeTipi ?? 'Havale',
    UyeID: over.UyeID ?? 10,
    KargoTakipNo: over.KargoTakipNo ?? null,
    AliciAdi: over.AliciAdi ?? 'Örnek Alıcı',
    ToplamTutar: over.ToplamTutar ?? '119.99',
    ...over,
  }
}

async function checkpointOf(pglite, org, accountId) {
  const rows = await pglite.query(
    `select last_successful_sync_at, last_sync_status from integration_sync_state
     where organization_id=$1 and marketplace_account_id=$2 and provider='ticimax'`,
    [org, accountId],
  )
  return rows.rows[0] ?? null
}

/* ═══ 1. UyeKodu ≠ providerAccountId ════════════════════════════════════ */

test('TICIMAX-1: UyeKodu providerAccountId / kimlik OLAMAZ', () => {
  const storeA = identity.ticimaxProviderAccountId('https://magaza.example.com')
  const storeB = identity.ticimaxProviderAccountId('https://www.magaza.example.com/')
  assert.equal(storeA, storeB)
  assert.notEqual(storeA, 'SECRET-UYE-KODU-xyz')

  assert.throws(
    () => identity.assertUyeKoduNeverIdentity({ candidateField: 'UyeKodu' }),
    (err) => err?.code === 'UYE_KODU_NOT_IDENTITY',
  )
  assert.throws(
    () =>
      identity.assertUyeKoduNeverIdentity({
        candidateValue: 'SECRET-UYE-KODU-xyz',
        uyeKodu: 'SECRET-UYE-KODU-xyz',
      }),
    (err) => err?.code === 'UYE_KODU_NOT_IDENTITY',
  )
  assert.doesNotThrow(() =>
    identity.assertUyeKoduNeverIdentity({
      candidateValue: storeA,
      uyeKodu: 'SECRET-UYE-KODU-xyz',
    }),
  )
})

/* ═══ Tel kapısı / istemci ══════════════════════════════════════════════ */

test('TICIMAX-WIRE: selectSiparisVerified=false; kapı DEFERRED; SOAP yok', async () => {
  assert.equal(wireGate.TICIMAX_WIRE_CONTRACT.selectSiparisVerified, false)
  assert.equal(wireGate.TICIMAX_WIRE_CONTRACT.reason, 'DEFERRED_TO_LIVE_PROVIDER_VERIFICATION')
  assert.throws(
    () => wireGate.assertSelectSiparisWireReady(),
    (err) => err?.code === 'DEFERRED_TO_LIVE_PROVIDER_VERIFICATION',
  )

  const result = await client.selectSiparis({
    storeUrl: 'https://magaza.example.com',
    uyeKodu: 'SECRET-SHOULD-NOT-LEAK',
  })
  assert.equal(result.ok, false)
  assert.equal(result.errorClass, 'WIRE_CONTRACT_UNVERIFIED')
  assert.deepEqual(result.rawOrders, [])

  const probe = await client.testTicimaxConnection({
    storeUrl: 'https://magaza.example.com',
    uyeKodu: 'SECRET-SHOULD-NOT-LEAK',
  })
  assert.equal(probe.ok, false)
  assert.equal(probe.errorClass, 'WIRE_CONTRACT_UNVERIFIED')

  // UyeKodu URL sorgusunda yok.
  const soapUrl = 'https://magaza.example.com/Servis/SiparisServis.svc'
  const built = client.buildTicimaxRequestUrl(soapUrl)
  assert.equal(built.includes('SECRET'), false)
  assert.equal(new URL(built).search, '')
})

test('TICIMAX-5: SOAP Fault başarılı sipariş okuması OLAMAZ', () => {
  const fault = client.classifyTicimaxSoapBody(
    `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>auth</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
  )
  assert.equal(fault.ok, false)
  assert.equal(fault.errorClass, 'SOAP_FAULT')
})

/* ═══ Uç nokta ══════════════════════════════════════════════════════════ */

test('TICIMAX-ENDPOINT: HTTPS kök + sabit yol; kullanıcı yolu reddedilir', () => {
  const ok = endpoint.inspectTicimaxStoreOrigin('https://magaza.example.com')
  assert.equal(ok.ok, true)
  assert.equal(ok.soapEndpointUrl, 'https://magaza.example.com/Servis/SiparisServis.svc')

  const withPath = endpoint.inspectTicimaxStoreOrigin('https://magaza.example.com/evil')
  assert.equal(withPath.ok, false)
  assert.equal(withPath.rejection, 'USER_CONTROLLED_SERVICE_PATH')

  assert.equal(
    endpoint.isAllowedTicimaxSoapUrl(
      'https://magaza.example.com/Servis/SiparisServis.svc',
      'https://magaza.example.com/Servis/SiparisServis.svc',
    ),
    true,
  )
  assert.equal(
    endpoint.isAllowedTicimaxSoapUrl(
      'https://magaza.example.com/Servis/Other.svc',
      'https://magaza.example.com/Servis/SiparisServis.svc',
    ),
    false,
  )
})

/* ═══ Connect asla kalıcılaştırmaz (tel kapalı) ═════════════════════════ */

test('TICIMAX-CONNECT: tel doğrulanmadan WIRE_CONTRACT_UNVERIFIED ve persist=false', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tx-connect')

  const result = await connection.connectTicimaxStore(
    db,
    {
      organizationId: org,
      storeUrl: 'https://shop.example.com',
      uyeKodu: 'PLAINTEXT-SECRET-uye',
    },
    { resolver: async () => [{ address: '203.0.113.10' }] },
  )
  assert.equal(result.outcome, 'WIRE_CONTRACT_UNVERIFIED')
  assert.equal(result.persisted, false)
  assert.equal(result.account, null)
  assert.ok(result.providerAccountId)

  const listed = await accounts.listAccounts(db, org, 'ticimax')
  assert.equal(listed.length, 0)

  const credRows = await pglite.query(
    `select count(*)::int as n from connector_credentials where organization_id=$1`,
    [org],
  )
  assert.equal(credRows.rows[0].n, 0)
})

/* ═══ 2. Sırlar şifreli; list plaintext UyeKodu dönmez ══════════════════ */

test('TICIMAX-2: manuel kayıtlı UyeKodu şifreli; list plaintext dönmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tx-secret')
  const providerAccountId = identity.ticimaxProviderAccountId('https://a.example.com')
  const account = await accounts.ensureAccount(db, org, 'ticimax', providerAccountId)
  const secret = `UYE-${randomBytes(8).toString('hex')}`

  await connectorStore.saveConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    providerKey: 'ticimax',
    payload: { storeUrl: 'https://a.example.com', uyeKodu: secret },
  })

  const raw = await pglite.query(
    `select encrypted_payload from connector_credentials
     where organization_id=$1 and marketplace_account_id=$2`,
    [org, account.id],
  )
  assert.equal(raw.rows.length, 1)
  assert.equal(
    String(raw.rows[0].encrypted_payload).includes(secret),
    false,
    'UyeKodu ciphertext içinde plaintext olmamalı',
  )

  const views = await connection.listTicimaxStores(db, org)
  assert.equal(views.length, 1)
  assert.equal(views[0].hasUyeKodu, true)
  assert.equal(JSON.stringify(views).includes(secret), false)
  assert.equal('uyeKodu' in views[0], false)
})

/* ═══ 3–4. Kiracı / kardeş hesap izolasyonu (stub) ══════════════════════ */

test('TICIMAX-3/4: kiracı ve kardeş hesap izolasyonu', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'tx-a')
  const orgB = await makeOrg(db, 'tx-b')

  const accA1 = await accounts.ensureAccount(
    db,
    orgA,
    'ticimax',
    identity.ticimaxProviderAccountId('https://a1.example.com'),
  )
  const accA2 = await accounts.ensureAccount(
    db,
    orgA,
    'ticimax',
    identity.ticimaxProviderAccountId('https://a2.example.com'),
  )
  const accB = await accounts.ensureAccount(
    db,
    orgB,
    'ticimax',
    identity.ticimaxProviderAccountId('https://b.example.com'),
  )

  await connectorStore.saveConnectorCredential(db, {
    organizationId: orgA,
    marketplaceAccountId: accA1.id,
    providerKey: 'ticimax',
    payload: { storeUrl: 'https://a1.example.com', uyeKodu: 'sec-a1' },
  })
  await connectorStore.saveConnectorCredential(db, {
    organizationId: orgA,
    marketplaceAccountId: accA2.id,
    providerKey: 'ticimax',
    payload: { storeUrl: 'https://a2.example.com', uyeKodu: 'sec-a2' },
  })
  await connectorStore.saveConnectorCredential(db, {
    organizationId: orgB,
    marketplaceAccountId: accB.id,
    providerKey: 'ticimax',
    payload: { storeUrl: 'https://b.example.com', uyeKodu: 'sec-b' },
  })

  // Org B, Org A hesabını göremez / ayıramaz.
  assert.equal(
    (await connection.findOwnedTicimaxAccount(db, {
      organizationId: orgB,
      marketplaceAccountId: accA1.id,
    })),
    null,
  )
  assert.equal(
    (await connection.disconnectTicimaxStore(db, {
      organizationId: orgB,
      marketplaceAccountId: accA1.id,
    })).outcome,
    'NOT_FOUND',
  )

  // Kardeş: A2 ayırılınca A1 kimliği kalır.
  assert.equal(
    (await connection.disconnectTicimaxStore(db, {
      organizationId: orgA,
      marketplaceAccountId: accA2.id,
    })).outcome,
    'DISCONNECTED',
  )
  const still = await connectorStore.getConnectorCredential(db, {
    organizationId: orgA,
    marketplaceAccountId: accA1.id,
    providerKey: 'ticimax',
  })
  assert.ok(still)
  assert.equal(still.payload.uyeKodu, 'sec-a1')

  const gone = await connectorStore.getConnectorCredential(db, {
    organizationId: orgA,
    marketplaceAccountId: accA2.id,
    providerKey: 'ticimax',
  })
  assert.equal(gone, null)
})

/* ═══ 8. SiparisID kararlı kimlik ═══════════════════════════════════════ */

test('TICIMAX-8: kararlı sipariş kimliği SiparisID; statü ham; para dizgi; epoch yok', () => {
  const ok = normalizer.normalizeTicimaxOrder(
    order(42, { SiparisDurumu: 'GaripStatü', ToplamTutar: '119.99', SiparisTarihi: '0001-01-01' }),
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.order.externalOrderId, '42')
  assert.equal(ok.order.rawStatus, 'GaripStatü')
  assert.equal(ok.order.canonicalStatus, null)
  assert.equal(ok.order.totalDecimal, '119.99')
  assert.equal(ok.order.orderDate, null)
  assert.equal(ok.order.orderDateMalformed, true)

  const missing = normalizer.normalizeTicimaxOrder({ SiparisNo: 'X' })
  assert.equal(missing.ok, false)
  assert.equal(missing.rejection, 'MISSING_SIPARIS_ID')

  assert.equal(identity.ticimaxOrderExternalId(order(7)), '7')
  assert.equal(identity.ticimaxOrderHumanReference(order(7)), 'SN-7')
})

/* ═══ 6–7. İmleç + tekrar sayfa ═════════════════════════════════════════ */

test('TICIMAX-6/7: başarısız/tekrar sayfa imleci ilerletmez; tekrar güvenli biter', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tx-page')
  const account = await accounts.ensureAccount(
    db,
    org,
    'ticimax',
    identity.ticimaxProviderAccountId('https://page.example.com'),
  )
  const upper = Date.parse('2026-09-20T12:00:00.000Z')

  // Başarılı tur → imleç kurulur.
  const success = await sync.syncTicimaxOrdersForAccount(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    upperBoundMs: upper,
    pageFetcher: async ({ pageIndex }) => ({
      ok: true,
      page: {
        orders: pageIndex === 1 ? [order(1), order(2)] : [],
        hasMore: false,
      },
    }),
  })
  assert.equal(success.outcome, 'SUCCESS')
  assert.equal(success.checkpointAdvanced, true)
  assert.equal(success.normalization.orders.length, 2)
  const baseline = await checkpointOf(pglite, org, account.id)
  assert.equal(baseline.last_sync_status, 'success')
  assert.equal(new Date(baseline.last_successful_sync_at).toISOString(), new Date(upper).toISOString())

  // Tekrarlayan sayfa → PARTIAL, imleç sabit.
  const stuck = await sync.syncTicimaxOrdersForAccount(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    upperBoundMs: upper + 60_000,
    pageFetcher: async () => ({
      ok: true,
      page: { orders: [order(1)], hasMore: true },
    }),
    maxPages: 5,
  })
  assert.equal(stuck.outcome, 'PARTIAL')
  assert.equal(stuck.terminatedForNonProgress, true)
  assert.equal(stuck.checkpointAdvanced, false)
  const afterStuck = await checkpointOf(pglite, org, account.id)
  assert.equal(afterStuck.last_sync_status, 'partial')
  assert.equal(
    new Date(afterStuck.last_successful_sync_at).toISOString(),
    new Date(baseline.last_successful_sync_at).toISOString(),
  )

  // Fetcher hatası → FAILED, imleç sabit.
  const failed = await sync.syncTicimaxOrdersForAccount(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    upperBoundMs: upper + 120_000,
    pageFetcher: async () => ({ ok: false, errorClass: 'SOAP_FAULT' }),
  })
  assert.equal(failed.outcome, 'FAILED')
  assert.equal(failed.checkpointAdvanced, false)
  const afterFail = await checkpointOf(pglite, org, account.id)
  assert.equal(afterFail.last_sync_status, 'failed')
  assert.equal(
    new Date(afterFail.last_successful_sync_at).toISOString(),
    new Date(baseline.last_successful_sync_at).toISOString(),
  )
})

test('TICIMAX-SYNC: pageFetcher yokken tel kapısı fail-closed; imleç ilerlemez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tx-nowire')
  const account = await accounts.ensureAccount(
    db,
    org,
    'ticimax',
    identity.ticimaxProviderAccountId('https://nowire.example.com'),
  )
  const result = await sync.syncTicimaxOrdersForAccount(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    upperBoundMs: Date.parse('2026-09-20T12:00:00.000Z'),
  })
  assert.equal(result.outcome, 'FAILED')
  assert.equal(result.checkpointAdvanced, false)
  assert.equal(result.errorClass, 'DEFERRED_TO_LIVE_PROVIDER_VERIFICATION')
  assert.equal(result.canonicalPersisted, false)
})

/* ═══ 9. Yazma denylist ═════════════════════════════════════════════════ */

test('TICIMAX-9: WRITE_OPERATIONS denylist; yazma çağrısı engellenir', () => {
  for (const method of pack.WRITE_OPERATIONS.documented) {
    assert.equal(writeGuard.isTicimaxWriteMethod(method), true, method)
  }
  assert.equal(writeGuard.isTicimaxWriteMethod('SelectSiparis'), false)
  assert.throws(
    () => writeGuard.assertTicimaxWriteDenied('SetSiparisDurum'),
    (err) => err?.code === 'TICIMAX_WRITE_DENIED',
  )
  assert.throws(
    () => client.invokeTicimaxMethod('SaveSiparisKargoPaketKargoTakipNo'),
    (err) => err?.code === 'TICIMAX_WRITE_DENIED',
  )
})

/* ═══ 10–11. Canlı yazma kapısı + rollout off ═══════════════════════════ */

test('TICIMAX-10/11: liveWriteGate bloklar; rollout ticimax=off; ACCOUNT_SCOPED yok', async (t) => {
  assert.equal(catalog.ROLLOUT_STAGE_POLICY.ticimax, 'off')
  assert.equal(catalog.resolveRolloutStage('ticimax'), 'off')

  const gate = liveGate.canPersistCanonicalOrders('ticimax')
  assert.equal(gate.decision, 'BLOCKED_BY_ROLLOUT')
  assert.equal(gate.reasonCode, 'ROLLOUT_STAGE_NOT_LIVE')
  assert.equal(liveGate.canTriggerFulfillmentSideEffects('ticimax').decision, 'BLOCKED_BY_ROLLOUT')

  assert.deepEqual([...healthService.ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS], [
    'woocommerce',
    'ikas',
  ])
  assert.equal(healthService.ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS.includes('ticimax'), false)

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'tx-live')
  const account = await accounts.ensureAccount(
    db,
    org,
    'ticimax',
    identity.ticimaxProviderAccountId('https://live.example.com'),
  )
  let persistCalls = 0
  const result = await sync.syncTicimaxOrdersForAccount(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    upperBoundMs: Date.parse('2026-09-20T12:00:00.000Z'),
    persistCanonical: async () => {
      persistCalls += 1
    },
    pageFetcher: async () => ({
      ok: true,
      page: { orders: [order(99)], hasMore: false },
    }),
  })
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.canonicalPersisted, false)
  assert.equal(result.liveWriteReason, 'ROLLOUT_STAGE_NOT_LIVE')
  assert.equal(persistCalls, 0)
})

test('TICIMAX-PAGINATION: semantik tekrar sayfa sonlandırması (SOAP yok)', async () => {
  const result = await pagination.fetchTicimaxOrderPages(
    async () => ({ ok: true, page: { orders: [order(1)], hasMore: true } }),
    { maxPages: 3 },
  )
  assert.equal(result.outcome, 'PARTIAL')
  assert.equal(result.terminatedForNonProgress, true)
  assert.equal(result.errorClass, 'NON_PROGRESSING_PAGE')
})

test('TICIMAX-SCAFFOLD: iskelet dizini var; paket fieldLevelVerified false; rollout off', () => {
  assert.equal(existsSync(join(here, 'connectors', 'ticimax', 'ticimaxWireGate.ts')), true)
  assert.equal(existsSync(join(here, 'connectors', 'ticimax', 'ticimaxClient.ts')), true)
  assert.equal(pack.PAGINATION.fieldLevelVerified, false)
  assert.deepEqual(pack.ORDER_LIST.parameters, [
    'UyeKodu',
    'WebSiparisFiltre',
    'WebSiparisSayfalama',
  ])
  assert.equal(catalog.ROLLOUT_STAGE_POLICY.ticimax, 'off')
})
