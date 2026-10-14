import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// Hermetic provider interactions only. This suite never proves a real user's account.
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const schema = await import('./db/schema.ts')
const n11 = await import('./connectors/n11/n11HttpHandlers.ts')
const nc = await import('./connectors/n11/n11ConnectionService.ts')
const hb = await import('./connectors/hepsiburada/hepsiburadaHttpHandlers.ts')
const hc = await import('./connectors/hepsiburada/hepsiburadaConnectionService.ts')
const ac = await import('./connectors/aras/arasConnectionService.ts')
const ah = await import('./connectors/aras/arasHttpHandlers.ts')
const carrier = await import('./carriers/carrierAccounts.ts')
const gate = await import('./connectors/accountOrdersReadGate.ts')
const writes = await import('./connectors/liveWriteGate.ts')
const catalog = await import('./connectors/providerCatalog.ts')
const store = await import('./connectors/connectorCredentialStore.ts')
const onboarding = await import('./onboarding/onboardingService.ts')
const syncRepo = await import('./onboarding/onboardingRepository.ts')
const NOW = Date.UTC(2026, 9, 14, 12)
let pglite, db
test.before(async () => {
  pglite = new PGlite()
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')) if (sql.trim()) await pglite.exec(sql)
  }
  db = drizzle(pglite, { schema })
})
test.after(async () => { await pglite?.close() })
async function org() {
  const slug = `av-${randomBytes(5).toString('hex')}`
  const [row] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return row.id
}
const nCred = (over = {}) => ({ appKey: `app-${randomBytes(4).toString('hex')}`, appSecret: 'fixture-secret', ...over })
const hCred = (over = {}) => ({ merchantId: `m-${randomBytes(4).toString('hex')}`, username: 'fixture-user', password: 'fixture-password', host: 'oms-external-sit.hepsiburada.com', packagesPath: '/fixture/{merchantId}', ...over })
function transport(body = { content: [], totalPages: 0 }, status = 200, onCall) {
  const calls = []
  return { calls, options: { retryDelaysMs: [], transport: async (request) => {
    calls.push(request)
    await onCall?.(request)
    if (body instanceof Error) throw body
    return { status, headers: {}, bodyText: typeof body === 'string' ? body : JSON.stringify(body) }
  } } }
}
const row = async (id) => (await db.select().from(schema.marketplaceAccounts).where(eq(schema.marketplaceAccounts.id, id)))[0]
const readGate = (organizationId, marketplaceAccountId, providerKey = 'n11') => gate.getAccountOrdersReadGate(db, { organizationId, marketplaceAccountId, providerKey })
const probeN = (organizationId, marketplaceAccountId, fake = transport()) => n11.handleN11Test({ db, organizationId, body: { marketplaceAccountId }, clientOptions: fake.options, now: () => NOW })
const probeH = (organizationId, marketplaceAccountId, fake = transport([])) => hb.handleHepsiburadaTest({ db, organizationId, body: { marketplaceAccountId }, clientOptions: fake.options, now: () => NOW })
function nPackage(over = {}) {
  return { id: '10001', orderNumber: '20001', sellerId: 100, lastModifiedDate: NOW - 1000, shipmentPackageStatus: 'Created', cargoProviderName: 'Unknown Carrier', packageHistories: [{ status: 'Created', createdDate: NOW - 2000 }], lines: [{ orderLineId: 1, quantity: 1 }], ...over }
}
function hPackage(merchantId, over = {}) {
  return { packageNumber: 'PK-1', orderNumber: 'HB-1', merchantId, status: 'Packed', cargoCompany: 'HepsiJet', orderDate: new Date(NOW - 2000).toISOString(), items: [{ lineItemId: '1', quantity: 1 }], ...over }
}

test('AV-1/7/11: credentials alone and verified sibling never permit ingestion; body cannot spoof evidence', async () => {
  const organizationId = await org()
  const a = await nc.connectN11Account(db, { organizationId, ...nCred() })
  const b = await nc.connectN11Account(db, { organizationId, ...nCred() })
  await probeN(organizationId, a.marketplaceAccountId)
  assert.equal((await row(b.marketplaceAccountId)).verificationStatus, 'unverified')
  assert.equal((await readGate(organizationId, a.marketplaceAccountId)).decision, 'ALLOWED')
  assert.equal((await readGate(organizationId, b.marketplaceAccountId)).reasonCode, 'ACCOUNT_NOT_VERIFIED')
  const fake = transport({ content: [nPackage()], totalPages: 1 })
  const result = await n11.handleN11Sync({ db, organizationId, body: { marketplaceAccountId: b.marketplaceAccountId, verificationStatus: 'verified', accountVerified: true, liveWriteGate: 'ALLOWED', organizationId: 'spoof' }, clientOptions: fake.options, now: () => NOW })
  assert.equal(result.body.canonicalWrite, 'BLOCKED_BY_ACCOUNT')
  assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.marketplaceAccountId, b.marketplaceAccountId))).length, 0)
})

test('AV-2/3/9: N11 save and Test Et persist exact account evidence, including empty valid content', async () => {
  const organizationId = await org()
  for (const content of [[], [nPackage()]]) {
    const fake = transport({ content, totalPages: content.length ? 1 : 0 })
    const result = await n11.handleN11Connect({ db, organizationId, body: nCred(), clientOptions: fake.options, now: () => NOW })
    assert.equal(result.status, 200)
    assert.equal(result.body.verificationStatus, 'verified')
    const account = await row(result.body.marketplaceAccountId)
    assert.equal(account.verificationStatus, 'verified')
    assert.equal(account.lastVerifiedAt.getTime(), NOW)
    assert.equal(account.lastVerificationAttemptAt.getTime(), NOW)
    assert.equal(fake.calls.length, 1)
    const url = new URL(fake.calls[0].url)
    assert.equal(url.origin + url.pathname, 'https://api.n11.com/rest/delivery/v1/shipmentPackages')
    assert.equal(url.searchParams.get('sender'), 'ALL')
    assert.equal(url.searchParams.get('page'), '0')
    assert.equal(url.searchParams.get('size'), '1')
    await probeN(organizationId, account.id, transport({}, 401))
    assert.equal((await row(account.id)).verificationStatus, 'auth_failed')
    await probeN(organizationId, account.id)
    assert.equal((await row(account.id)).verificationStatus, 'verified')
  }
})

test('AV-4/5: N11 auth, rate, network, timeout, 5xx and shape classifications preserve saved credentials', async () => {
  const organizationId = await org()
  const connected = await nc.connectN11Account(db, { organizationId, ...nCred() })
  const id = connected.marketplaceAccountId
  const { N11TransportError } = await import('./connectors/n11/n11Client.ts')
  for (const [body, httpStatus, expected, reason] of [
    [{}, 401, 'auth_failed', 'N11_HTTP_401'], [{}, 403, 'auth_failed', 'N11_HTTP_403'],
    [{}, 429, 'rate_limited', 'N11_HTTP_429'], [{}, 503, 'provider_unavailable', 'N11_HTTP_503'],
    [new Error('fixture network'), 0, 'provider_unavailable', 'N11_NETWORK_ERROR'],
    [new N11TransportError('TIMEOUT'), 0, 'provider_unavailable', 'N11_TIMEOUT'],
    [{ unexpected: [] }, 200, 'unverified', 'N11_RESPONSE_SHAPE_UNVERIFIED'],
    [{ content: [null, 123], totalPages: 1 }, 200, 'unverified', 'N11_RESPONSE_SHAPE_UNVERIFIED'],
    ['broken json', 200, 'unverified', 'N11_RESPONSE_NOT_JSON'],
  ]) {
    const fake = transport(body, httpStatus)
    const result = await probeN(organizationId, id, fake)
    assert.equal(result.body.verificationStatus, expected)
    assert.equal(result.body.reasonCode, reason)
    assert.equal((await row(id)).verificationStatus, expected)
    assert.equal(fake.calls.length, 1, 'bounded probe never sleeps/retries')
    assert.ok((await nc.loadN11Account(db, { organizationId, marketplaceAccountId: id })).config)
  }
  const saved = await n11.handleN11Connect({ db, organizationId, body: { marketplaceAccountId: id, appSecret: 'changed-secret' }, clientOptions: transport({}, 503).options })
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.credentialsSaved, true)
  assert.equal(saved.body.verificationStatus, 'provider_unavailable')
})

test('AV-6: changed fingerprint resets verification; same credentials preserve it; stale probes fail closed', async () => {
  const organizationId = await org()
  const input = nCred()
  const { marketplaceAccountId: id } = await nc.connectN11Account(db, { organizationId, ...input })
  await probeN(organizationId, id)
  const first = await row(id)
  await nc.connectN11Account(db, { organizationId, marketplaceAccountId: id, appKey: '', appSecret: '' })
  assert.equal((await row(id)).verificationStatus, 'verified')
  await nc.connectN11Account(db, { organizationId, marketplaceAccountId: id, appSecret: 'second-secret' })
  const changed = await row(id)
  assert.notEqual(changed.credentialFingerprint, first.credentialFingerprint)
  assert.equal(changed.verificationStatus, 'unverified')
  assert.equal(changed.lastVerifiedAt, null)
  assert.equal((await readGate(organizationId, id)).reasonCode, 'ACCOUNT_NOT_VERIFIED')
  const stale = transport({ content: [nPackage({ sellerId: 999 })], totalPages: 1 }, 200, async () => {
    await nc.connectN11Account(db, { organizationId, marketplaceAccountId: id, appSecret: 'third-secret' })
  })
  const result = await probeN(organizationId, id, stale)
  assert.equal(result.body.reasonCode, 'ACCOUNT_CREDENTIALS_CHANGED')
  assert.equal((await row(id)).verificationStatus, 'unverified')
  assert.equal((await nc.loadN11Account(db, { organizationId, marketplaceAccountId: id })).config.boundSellerId, null, 'stale probe cannot bind its seller to new credentials')
  // Out-of-band credential writes cannot reuse verified evidence either.
  await probeN(organizationId, id)
  const loaded = await nc.loadN11Account(db, { organizationId, marketplaceAccountId: id })
  await store.saveConnectorCredential(db, { organizationId, marketplaceAccountId: id, providerKey: 'n11', payload: { ...loaded.config, appSecret: 'out-of-band' } })
  assert.equal((await readGate(organizationId, id)).reasonCode, 'ACCOUNT_CREDENTIALS_CHANGED')
})

test('AV-8: foreign tenant save/test/sync returns 404 with zero provider calls for N11 and HB', async () => {
  const a = await org(), b = await org()
  const n = await nc.connectN11Account(db, { organizationId: a, ...nCred() })
  const hi = hCred()
  const h = await hc.connectHepsiburadaAccount(db, { organizationId: a, ...hi })
  for (const [id, handlers, body] of [
    [n.marketplaceAccountId, [n11.handleN11Connect, n11.handleN11Test, n11.handleN11Sync], nCred()],
    [h.marketplaceAccountId, [hb.handleHepsiburadaConnect, hb.handleHepsiburadaTest, hb.handleHepsiburadaSync], hi],
  ]) {
    const fake = transport()
    for (const handler of handlers) {
      const result = await handler({ db, organizationId: b, body: { ...body, organizationId: a, marketplaceAccountId: id }, clientOptions: fake.options })
      assert.equal(result.status, 404)
    }
    assert.equal(fake.calls.length, 0)
  }
})

test('AV-N11-CONCURRENT: sibling probes cannot claim the same seller; duplicate legacy bindings cannot ingest', async () => {
  const organizationId = await org()
  const a = await nc.connectN11Account(db, { organizationId, ...nCred() })
  const b = await nc.connectN11Account(db, { organizationId, ...nCred() })
  const page = { content: [nPackage()], totalPages: 1 }
  const results = await Promise.all([probeN(organizationId, a.marketplaceAccountId, transport(page)), probeN(organizationId, b.marketplaceAccountId, transport(page))])
  assert.equal(results.filter((result) => result.body.ok).length, 1)
  assert.equal(results.find((result) => !result.body.ok).body.reasonCode, 'N11_SELLER_ALREADY_CONNECTED')
  const accounts = await Promise.all([row(a.marketplaceAccountId), row(b.marketplaceAccountId)])
  assert.equal(accounts.filter((account) => account.verificationStatus === 'verified').length, 1)
  const legacy = accounts.find((account) => account.verificationStatus !== 'verified')
  const config = (await nc.loadN11Account(db, { organizationId, marketplaceAccountId: legacy.id })).config
  await store.saveConnectorCredential(db, { organizationId, marketplaceAccountId: legacy.id, providerKey: 'n11', payload: { ...config, boundSellerId: '100' } })
  await carrier.recordMarketplaceVerification(db, { organizationId, marketplaceAccountId: legacy.id, status: 'verified' })
  for (const account of accounts) {
    const result = await n11.handleN11Sync({ db, organizationId, body: { marketplaceAccountId: account.id }, clientOptions: transport(page).options, now: () => NOW })
    assert.equal(result.body.checkpointAdvanced, false)
    assert.equal(result.body.durabilityReasonCode, 'N11_SELLER_ALREADY_CONNECTED')
  }
  assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.organizationId, organizationId))).length, 0)
})

test('AV-10/12/13: verified N11 ingests canonical orders; epoch/null-id remain blocked; fulfillment and marketplace writes stay closed', async () => {
  const organizationId = await org()
  const { marketplaceAccountId: id } = await nc.connectN11Account(db, { organizationId, ...nCred() })
  await probeN(organizationId, id)
  const fake = transport({ content: [nPackage()], totalPages: 1 }, 200, (request) => {
    assert.equal(new URL(request.url).searchParams.get('page'), '0')
  })
  const result = await n11.handleN11Sync({ db, organizationId, body: { marketplaceAccountId: id }, clientOptions: fake.options, now: () => NOW })
  assert.equal(result.body.canonicalWrite, 'ALLOWED')
  assert.equal(result.body.checkpointAdvanced, false)
  assert.equal(result.body.durabilityReasonCode, 'N11_EPOCH_SEMANTICS_UNVERIFIED')
  const orders = await db.select().from(schema.orders).where(eq(schema.orders.marketplaceAccountId, id))
  assert.equal(orders.length, 1)
  assert.notEqual(orders[0].operationStatus, 'READY_TO_SHIP')
  assert.equal(orders[0].cargoProviderName, 'Unknown Carrier')
  const sourceGate = await import('./shipments/orderSourceFulfillmentGate.ts')
  const createGate = await import('./shipments/suratCreateEligibility.ts')
  const preflight = await import('./shipments/shipmentPreflight.ts')
  for (const marketplace of ['N11', 'Hepsiburada']) {
    const carrierOrder = { marketplace, orderNumber: 'o', packageId: 'p', cargoTrackingNumber: '123', cargoProviderName: 'Sürat Kargo', marketplaceStatus: 'Packed', recipientName: 'Fixture', address: 'Fixture', city: 'Istanbul' }
    assert.equal(sourceGate.orderSourceFulfillmentAllowed(marketplace), false)
    assert.equal(createGate.resolveSuratCreateEligibility({ order: carrierOrder }).eligible, false)
    const decision = preflight.evaluateShipmentPreflight({ organizationId, provider: 'surat', order: carrierOrder, marketplaceAccounts: [{ id: 'm', marketplace, isActive: true }], carrierAccounts: [{ id: 'c', provider: 'surat', enabled: true, verificationStatus: 'verified' }], carrierMappings: [], payer: { payer: 'SELLER_PAYS', source: 'ACCOUNT_CONFIG' }, carrierPayer: 'SELLER_PAYS', idempotencyKey: 'fixture' })
    assert.equal(decision.ok, false)
    assert.ok(decision.blockers.includes('FULFILLMENT_NOT_AVAILABLE'))
  }
  assert.equal(await sourceGate.loadOrderSourceFulfillmentAllowed(db, organizationId, { ...orders[0], marketplace: 'Trendyol' }), false, 'caller cannot relabel canonical N11 order')
  assert.equal(await sourceGate.loadOrderSourceFulfillmentAllowed(db, organizationId, { packageId: orders[0].packageId, marketplace: 'Trendyol' }), false, 'legacy identity cannot relabel source either')
  const nullId = await n11.handleN11Sync({ db, organizationId, body: { marketplaceAccountId: id }, clientOptions: transport({ content: [nPackage({ id: null })], totalPages: 1 }).options, now: () => NOW })
  assert.equal(nullId.body.durabilityReasonCode, 'N11_RECORD_NOT_PERSISTABLE')
  for (const provider of ['n11', 'hepsiburada']) {
    assert.equal(writes.canTriggerFulfillmentSideEffects(provider).decision, 'BLOCKED_BY_ROLLOUT')
    assert.equal(catalog.resolveRolloutStage(provider), 'internal_test')
    assert.equal(catalog.buildProviderCatalog().get(provider).capabilities.find((c) => c.capability === 'orders.status.write').supported, false)
  }
  for (const table of [schema.shipments, schema.labelJobs]) assert.equal((await db.select().from(table).where(eq(table.organizationId, organizationId))).length, 0)
  assert.equal((await syncRepo.getSyncState(db, organizationId, 'orders', id)).lastSuccessfulSyncAt, null)
})

test('AV-14/15: HB save/test is exact-account scoped; missing endpoints and unknown envelopes never verify', async () => {
  const organizationId = await org()
  const firstInput = hCred(), siblingInput = hCred()
  const sibling = await hc.connectHepsiburadaAccount(db, { organizationId, ...siblingInput })
  const saved = await hb.handleHepsiburadaConnect({ db, organizationId, body: firstInput, clientOptions: transport([]).options, now: () => NOW })
  const id = saved.body.marketplaceAccountId
  assert.equal((await row(id)).verificationStatus, 'verified')
  assert.equal((await row(sibling.marketplaceAccountId)).verificationStatus, 'unverified')
  assert.equal((await readGate(organizationId, sibling.marketplaceAccountId, 'hepsiburada')).reasonCode, 'ACCOUNT_NOT_VERIFIED')
  const unknown = await probeH(organizationId, id, transport({ guessedList: [] }))
  assert.equal(unknown.body.reasonCode, 'HB_RESPONSE_SHAPE_UNVERIFIED')
  assert.equal((await row(id)).verificationStatus, 'unverified')
  const malformed = await probeH(organizationId, id, transport([null, 123]))
  assert.equal(malformed.body.reasonCode, 'HB_RESPONSE_SHAPE_UNVERIFIED')
  await probeH(organizationId, id)
  assert.equal((await row(id)).verificationStatus, 'verified')
  await hc.connectHepsiburadaAccount(db, { organizationId, ...firstInput, password: 'changed' })
  assert.equal((await row(id)).verificationStatus, 'unverified')
  const fake = transport([])
  const missing = await hb.handleHepsiburadaConnect({ db, organizationId, body: { ...firstInput, packagesPath: '', ordersPath: '' }, clientOptions: fake.options })
  assert.equal(missing.body.ok, true)
  assert.equal(missing.body.code, 'HB_ENDPOINT_CONFIG_REQUIRED')
  assert.equal(missing.body.verificationStatus, 'unverified')
  assert.equal(fake.calls.length, 0)
})

test('AV-HB-READ/ONBOARDING: verified HB persists canonical orders; first sync and verification must belong to the same active account', async () => {
  const organizationId = await org()
  const input = hCred()
  const { marketplaceAccountId: id } = await hc.connectHepsiburadaAccount(db, { organizationId, ...input })
  await probeH(organizationId, id)
  const before = await onboarding.deriveOnboardingStatus(db, organizationId)
  assert.equal(before.steps.find((s) => s.key === 'MARKETPLACE').done, true)
  assert.equal(before.steps.find((s) => s.key === 'FIRST_SYNC').done, false)
  const result = await hb.handleHepsiburadaSync({ db, organizationId, body: { marketplaceAccountId: id }, clientOptions: transport([hPackage(input.merchantId)]).options, now: () => NOW })
  assert.equal(result.body.canonicalWrite, 'ALLOWED')
  assert.equal(result.body.checkpointAdvanced, true)
  assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.marketplaceAccountId, id))).length, 1)
  assert.equal((await onboarding.deriveOnboardingStatus(db, organizationId)).steps.find((s) => s.key === 'FIRST_SYNC').done, true)
  const sibling = await hc.connectHepsiburadaAccount(db, { organizationId, ...hCred() })
  const scoped = (await onboarding.deriveOnboardingStatus(db, organizationId)).marketplaces.find((m) => m.providerKey === 'hepsiburada')
  assert.equal(scoped.accounts.find((a) => a.marketplaceAccountId === sibling.marketplaceAccountId).verified, false)
  // A has only historic sync; B has only verification. They cannot combine.
  await hc.connectHepsiburadaAccount(db, { organizationId, ...input, password: 'changed-after-sync' })
  const statusBoard = await import('./connectors/integrationStatus.ts')
  assert.equal((await statusBoard.loadIntegrationStatusBoard(db, { organizationId })).find((s) => s.providerKey === 'hepsiburada').health.verified, false, 'historical sync cannot verify changed credentials')
  await probeH(organizationId, sibling.marketplaceAccountId)
  const separate = await onboarding.deriveOnboardingStatus(db, organizationId)
  assert.equal(separate.steps.find((s) => s.key === 'FIRST_SYNC').done, false)
  await db.update(schema.marketplaceAccounts).set({ isActive: false }).where(eq(schema.marketplaceAccounts.id, sibling.marketplaceAccountId))
  assert.equal((await readGate(organizationId, sibling.marketplaceAccountId, 'hepsiburada')).reasonCode, 'ACCOUNT_NOT_ACTIVE')
  assert.equal((await onboarding.deriveOnboardingStatus(db, organizationId)).steps.find((s) => s.key === 'MARKETPLACE').done, false)
})

test('AV-REVIEW-HB-BIND: only selected-path identity or every returned merchant can verify; empty fake siblings stay unverified', async () => {
  const organizationId = await org()
  const cases = [
    { path: '/fixture/{merchantId}', rows: () => [], verified: true },
    { path: '/fixture', rows: () => [], verified: false },
    { path: '/fixture', rows: (id) => [{ merchantId: id }, { merchantId: id }], verified: true },
    { path: '/fixture', rows: (id) => [{ merchantId: id }, { merchantId: 'other' }], verified: false, reason: 'HB_MERCHANT_MISMATCH' },
    { path: '/fixture/{merchantId}', rows: () => [{ merchantId: 'other' }], verified: false, reason: 'HB_MERCHANT_MISMATCH' },
    { path: '/fixture', rows: (id) => [{ merchantId: id }, {}], verified: false },
    { path: '/fixture', rows: () => [{ merchantId: ' ' }], verified: false },
    { path: '/fixture', rows: () => [], verified: false },
  ]
  for (const example of cases) {
    // ordersPath is bound, but PACKAGES is the selected family: it cannot lend identity.
    const input = hCred({ packagesPath: example.path, ordersPath: '/orders/{merchantId}' })
    const saved = await hb.handleHepsiburadaConnect({ db, organizationId, body: input, clientOptions: transport(example.rows(input.merchantId)).options, now: () => NOW })
    const account = await row(saved.body.marketplaceAccountId)
    assert.equal(account.verificationStatus, example.verified ? 'verified' : 'unverified')
    if (!example.verified) {
      assert.equal(saved.body.reasonCode, example.reason ?? 'HB_ACCOUNT_BINDING_UNPROVEN')
      assert.equal(account.lastVerifiedAt, null)
      assert.equal((await readGate(organizationId, account.id, 'hepsiburada')).decision, 'BLOCKED_BY_ACCOUNT')
    }
    assert.ok((await hc.loadHepsiburadaAccount(db, { organizationId, marketplaceAccountId: account.id })).config, 'credentials remain saved')
  }
  for (const table of [schema.orders, schema.labelJobs, schema.shipments]) assert.equal((await db.select().from(table).where(eq(table.organizationId, organizationId))).length, 0)
})

test('AV-REVIEW-SOURCE: verified canonical read sources cannot produce, catch up, or prepare label jobs; Trendyol still enqueues', async () => {
  const organizationId = await org()
  const producer = await import('./shipments/autoLabelProducer.ts')
  const catchup = await import('./shipments/autoLabelCatchup.ts')
  const preparation = await import('./shipments/labelJobPreparation.ts')
  const encryption = await import('./orders/orderEncryption.ts')
  const hi = hCred()
  const h = await hc.connectHepsiburadaAccount(db, { organizationId, ...hi })
  const n = await nc.connectN11Account(db, { organizationId, ...nCred() })
  await probeH(organizationId, h.marketplaceAccountId)
  await probeN(organizationId, n.marketplaceAccountId)
  await hb.handleHepsiburadaSync({ db, organizationId, body: { marketplaceAccountId: h.marketplaceAccountId }, clientOptions: transport([hPackage(hi.merchantId)]).options, now: () => NOW })
  await n11.handleN11Sync({ db, organizationId, body: { marketplaceAccountId: n.marketplaceAccountId }, clientOptions: transport({ content: [nPackage()], totalPages: 1 }).options, now: () => NOW })
  const canonical = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, organizationId))
  assert.equal(canonical.length, 2)
  const fresh = new Date()
  await producer.activateAutoLabel(db, organizationId, { marketplaces: ['trendyol', 'n11', 'hepsiburada'], carriers: ['surat'], now: new Date(fresh.getTime() - 60_000).toISOString() })
  // Make all other pipeline conditions eligible so source is the deciding gate.
  await db.update(schema.orders).set({ firstSeenAt: fresh, operationStatus: 'NEW', marketplaceStatus: 'Picking', cargoProviderName: 'Surat Kargo', cargoTrackingNumber: '727001234567', rawPayloadEncrypted: encryption.encryptOrderPayload({ whoPays: 1 }) }).where(eq(schema.orders.organizationId, organizationId))
  const produced = await producer.enqueueEligibleAutoLabelJobs(db, organizationId)
  assert.equal(produced.examined, 0)
  assert.equal(produced.enqueued, 0)
  assert.equal(produced.blocked.FULFILLMENT_NOT_AVAILABLE, 2)
  for (const order of canonical) {
    assert.equal((await row(order.marketplaceAccountId)).verificationStatus, 'verified')
    const params = { organizationId, organizationName: 'fixture', marketplace: order.marketplace, carrier: 'surat' }
    const result = await catchup.enqueueCatchupJobs(db, params)
    assert.equal(result.enqueued, 0)
    assert.equal(result.report.blocked, 1)
    assert.match(result.report.candidates[0].reason, /FULFILLMENT_NOT_AVAILABLE/)
    const prepared = await preparation.prepareLabelJob(db, { organizationId, packageId: order.packageId, marketplace: order.marketplace })
    assert.equal(prepared.blockerCode, 'FULFILLMENT_NOT_AVAILABLE')
    assert.equal(prepared.eligibleForCreate, false)
    assert.equal(prepared.tenantSettingsLoaded, false)
    assert.equal(prepared.resolverCalled, false)
    assert.equal(prepared.eligibility, null)
    assert.equal(prepared.billingParty, null)
    assert.equal(prepared.credentialSnapshot.resolved, false)
    assert.equal(prepared.carrierCalls + prepared.networkCalls + prepared.dbWrites, 0)
  }
  assert.equal((await db.select().from(schema.labelJobs).where(eq(schema.labelJobs.organizationId, organizationId))).length, 0)
  await db.insert(schema.orders).values({ organizationId, marketplace: 'Trendyol', packageId: 'TY-positive', orderNumber: 'TY-order', cargoProviderName: 'Surat Kargo', cargoTrackingNumber: '727999123', orderDate: fresh, firstSeenAt: new Date(fresh.getTime() - 1000), marketplaceStatus: 'Picking', operationStatus: 'NEW' })
  const tyResult = await producer.enqueueEligibleAutoLabelJobs(db, organizationId, { limit: 1 })
  assert.equal(tyResult.enqueued, 1, `newer restricted rows cannot consume the Trendyol batch: ${JSON.stringify(tyResult)}`)
  const jobs = await db.select().from(schema.labelJobs).where(eq(schema.labelJobs.organizationId, organizationId))
  assert.deepEqual(jobs.map((job) => job.marketplace), ['Trendyol'])
})

test('AV-REVIEW-HB-SPLIT: production reads offset zero, discards broad pages, captures shifted records and persists each complete identity once', async () => {
  const organizationId = await org()
  const input = hCred()
  const account = await hc.connectHepsiburadaAccount(db, { organizationId, ...input })
  await probeH(organizationId, account.marketplaceAccountId)
  const config = (await hc.loadHepsiburadaAccount(db, { organizationId, marketplaceAccountId: account.marketplaceAccountId })).config
  const { syncHepsiburadaOrdersForAccount } = await import('./connectors/hepsiburada/hepsiburadaOrderSync.ts')
  const { persistHepsiburadaOrders } = await import('./connectors/hepsiburada/hepsiburadaPersistence.ts')
  const start = NOW - 3_600_000
  let dataset = Array.from({ length: 201 }, (_, i) => hPackage(input.merchantId, { packageNumber: `SPLIT-${i}`, orderNumber: `ORDER-${i}`, orderDate: new Date(start + 1000 + i * 15_000).toISOString() }))
  // An exact split-boundary record is returned by both adjacent complete leaves.
  dataset[120].orderDate = new Date(start + 1_800_000).toISOString()
  const calls = [], persistedIds = []
  const transport = async (request) => {
    const url = new URL(request.url)
    const from = Date.parse(url.searchParams.get('begindate')), to = Date.parse(url.searchParams.get('enddate'))
    const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'))
    const rows = dataset.filter((row) => Date.parse(row.orderDate) >= from && Date.parse(row.orderDate) <= to).slice(offset, offset + limit)
    calls.push({ from, to, offset, limit, count: rows.length })
    if (calls.length === 1) dataset = dataset.slice(1) // the old offset-100 read would lose SPLIT-100
    return { status: 200, headers: {}, bodyText: JSON.stringify(rows) }
  }
  const result = await syncHepsiburadaOrdersForAccount(db, {
    organizationId, marketplaceAccountId: account.marketplaceAccountId, config, fromMs: start, upperBoundMs: NOW,
    persistCanonical: async (orders) => {
      assert.ok(calls.length > 1, 'full broad response must split before persistence')
      persistedIds.push(...orders.map((order) => order.packageId))
      return persistHepsiburadaOrders(db, { organizationId, marketplaceAccountId: account.marketplaceAccountId, orders })
    },
  }, { transport, retryDelaysMs: [] })
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.checkpointAdvanced, true)
  assert.equal(result.checkpointMs, NOW)
  assert.ok(calls.every((call) => call.offset === 0 && call.to - call.from <= 86_400_000))
  assert.equal(calls[0].count, 100)
  assert.ok(calls[1].to < calls[0].to, 'older half is visited first')
  assert.equal(persistedIds.length, 200)
  assert.equal(new Set(persistedIds).size, 200, 'overlapping leaves persist each package once')
  assert.ok(persistedIds.includes('SPLIT-100'), 'shifted boundary record is captured')
  assert.ok(!persistedIds.includes('SPLIT-0'), 'discarded broad response cannot leak into persistence')
  assert.deepEqual(new Set(persistedIds), new Set(dataset.map((row) => row.packageNumber)))
  assert.equal((await db.select().from(schema.orders).where(eq(schema.orders.organizationId, organizationId))).length, 200)
})

test('AV-REVIEW-HB-BOUNDS: dense intervals and exhausted budgets stay partial without checkpoint or persistence; conflicting duplicate merchants block checkpoints', async () => {
  const { syncHepsiburadaOrdersForAccount } = await import('./connectors/hepsiburada/hepsiburadaOrderSync.ts')
  for (const [reason, options] of [
    ['HB_DENSE_WINDOW_UNSPLITTABLE', { minSplitIntervalMs: 3_600_000 }],
    ['HB_REQUEST_BUDGET_EXHAUSTED', { maxRequestsPerRun: 2 }],
  ]) {
    const organizationId = await org(), input = hCred()
    const { marketplaceAccountId } = await hc.connectHepsiburadaAccount(db, { organizationId, ...input })
    await probeH(organizationId, marketplaceAccountId)
    const config = (await hc.loadHepsiburadaAccount(db, { organizationId, marketplaceAccountId })).config
    const fake = transport(Array.from({ length: 100 }, (_, i) => hPackage(input.merchantId, { packageNumber: `DENSE-${i}` })))
    let persists = 0
    const result = await syncHepsiburadaOrdersForAccount(db, { organizationId, marketplaceAccountId, config, fromMs: NOW - 3_600_000, upperBoundMs: NOW, persistCanonical: async () => { persists++; return { persisted: 100, failed: 0 } } }, { ...fake.options, ...options })
    assert.equal(result.outcome, 'PARTIAL')
    assert.equal(result.reasonCode, reason)
    assert.equal(result.checkpointAdvanced, false)
    assert.equal(persists, 0)
    assert.ok(fake.calls.every((call) => new URL(call.url).searchParams.get('offset') === '0'))
    assert.equal((await syncRepo.getSyncState(db, organizationId, 'orders', marketplaceAccountId)).lastSuccessfulSyncAt, null)
  }
  const organizationId = await org(), input = hCred()
  const { marketplaceAccountId } = await hc.connectHepsiburadaAccount(db, { organizationId, ...input })
  await probeH(organizationId, marketplaceAccountId)
  const result = await hb.handleHepsiburadaSync({ db, organizationId, body: { marketplaceAccountId }, clientOptions: transport([hPackage(input.merchantId), hPackage('foreign')]).options, now: () => NOW })
  assert.equal(result.body.checkpointAdvanced, false)
  assert.equal((await syncRepo.getSyncState(db, organizationId, 'orders', marketplaceAccountId)).lastErrorCode, 'HB_MERCHANT_MISMATCH')
})

test('AV-16/17: existing Trendyol rollout and Sürat carrier verification remain unchanged', async () => {
  const organizationId = await org()
  const { saveIntegrationCredential } = await import('./integrations/credentialService.ts')
  await saveIntegrationCredential(db, organizationId, 'surat', { kullaniciAdi: 'fixture-cari', sifre: 'fixture-password' })
  const surat = await carrier.syncSuratCarrierAccount(db, organizationId)
  await carrier.recordCarrierVerification(db, { organizationId, carrierAccountId: surat.id, status: 'verified' })
  assert.equal((await carrier.syncSuratCarrierAccount(db, organizationId)).verificationStatus, 'verified')
  assert.equal(writes.canPersistCanonicalOrders('trendyol').decision, 'ALLOWED')
  assert.equal(writes.canTriggerFulfillmentSideEffects('trendyol').decision, 'ALLOWED')
  assert.equal((await readGate(organizationId, 'missing', 'aras')).reasonCode, 'ORDERS_READ_NOT_AVAILABLE')
})

test('AV-FULFILLMENT-HTTP: actual create/label handlers stop before any transport, including spoofed canonical source', async () => {
  const organizationId = await org()
  const input = hCred()
  const saved = await hb.handleHepsiburadaConnect({ db, organizationId, body: input, clientOptions: transport([]).options })
  await hb.handleHepsiburadaSync({ db, organizationId, body: { marketplaceAccountId: saved.body.marketplaceAccountId }, clientOptions: transport([hPackage(input.merchantId)]).options, now: () => NOW })
  const [canonical] = await db.select().from(schema.orders).where(eq(schema.orders.marketplaceAccountId, saved.body.marketplaceAccountId))
  const [trendyol] = await db.insert(schema.orders).values({ organizationId, marketplace: 'Trendyol', packageId: 'TY-FIXTURE', orderNumber: canonical.orderNumber, orderDate: new Date(NOW) }).returning()
  // Execute the exact production handler declarations with only guard dependencies injected.
  // Any attempt to reach downstream configuration/reservation/transport fails this test.
  const ts = await import('typescript')
  const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8')
  const ast = ts.createSourceFile('index.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const declaration = (name) => ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)
  const realGate = await import('./shipments/orderSourceFulfillmentGate.ts')
  assert.equal(await realGate.loadOrderSourceFulfillmentAllowed(db, organizationId, { marketplace: 'Trendyol', packageId: trendyol.packageId, orderNumber: trendyol.orderNumber }), true, 'unrelated HB order-number collision cannot block valid Trendyol identity')
  assert.equal(await realGate.loadOrderSourceFulfillmentAllowed(db, organizationId, { ...canonical, marketplace: 'Trendyol', id: trendyol.id }), false, 'allowed UUID cannot be paired with another source package')
  assert.equal(await realGate.loadOrderSourceFulfillmentAllowed(db, organizationId, { packageId: canonical.packageId, orderNumber: 'fabricated', marketplace: 'Trendyol' }), false, 'edited second identity cannot hide a restricted package')
  const guardCode = declaration('blockAccountReadSourceFulfillment')
    .replace("await import('./shipments/orderSourceFulfillmentGate.ts')", 'sourceGate')
    .replace("await import('./db/client.ts')", 'dbModule')
  const guard = new Function('sourceGate', 'dbModule', 'isTenantAuthMode', `return (${guardCode})`)(realGate, { getDb: () => db }, () => true)
  const originalFetch = globalThis.fetch
  let providerCalls = 0
  globalThis.fetch = async () => { providerCalls++; throw new Error('Provider must not be called') }
  try {
    for (const name of ['createSuratShipment', 'createSuratLabelForRegisteredShipment']) {
      const handler = new Function('blockAccountReadSourceFulfillment', `return (${declaration(name)})`)(guard)
      for (const order of [{ marketplace: 'N11' }, { marketplace: 'Hepsiburada' }, { ...canonical, marketplace: 'Trendyol' }, { ...canonical, marketplace: 'Trendyol', id: trendyol.id }, { marketplace: 'Trendyol', packageId: canonical.packageId, orderNumber: 'fabricated' }]) {
        let response
        await handler({ auth: { organizationId }, body: { order, verificationStatus: 'verified' } }, { json: (body) => { response = body } })
        assert.equal(response.ok, false)
        assert.equal(response.errorCode, 'FULFILLMENT_NOT_AVAILABLE')
      }
    }
    assert.equal(providerCalls, 0)
  } finally { globalThis.fetch = originalFetch }
})

test('AV-18/19/20/21: Aras saves never call SetOrder; TEST only, separate sibling evidence and changed-credential reset', async () => {
  const organizationId = await org()
  const originalFetch = globalThis.fetch
  let providerCalls = 0
  globalThis.fetch = async () => { providerCalls++; throw new Error('No provider call permitted') }
  try {
    const input = { organizationId, userName: 'fixture-user', password: 'fixture-password' }
    const a = await ac.connectArasCarrierAccount(db, input)
    const b = await ac.connectArasCarrierAccount(db, input)
    const carriers = await carrier.listCarrierAccounts(db, organizationId)
    const ca = carriers.find((c) => c.credentialRef === carrier.arasCredentialRef(a.marketplaceAccountId))
    const cb = carriers.find((c) => c.credentialRef === carrier.arasCredentialRef(b.marketplaceAccountId))
    assert.equal(ca.verificationStatus, 'unverified')
    assert.equal(cb.verificationStatus, 'unverified')
    const accountA = await row(a.marketplaceAccountId)
    assert.ok(accountA.credentialFingerprint)
    assert.equal(accountA.verificationStatus, 'unverified')
    await carrier.recordCarrierVerification(db, { organizationId, carrierAccountId: ca.id, status: 'verified' })
    await carrier.recordMarketplaceVerification(db, { organizationId, marketplaceAccountId: a.marketplaceAccountId, status: 'verified' })
    assert.equal((await row(b.marketplaceAccountId)).verificationStatus, 'unverified')
    await ac.connectArasCarrierAccount(db, { ...input, marketplaceAccountId: a.marketplaceAccountId, password: 'changed' })
    assert.equal((await row(a.marketplaceAccountId)).verificationStatus, 'unverified')
    const list = await ah.handleArasListStores({ db, organizationId })
    assert.equal(list.body.stores.find((s) => s.marketplaceAccountId === a.marketplaceAccountId).verificationStatus, 'unverified')
    assert.equal(list.body.stores.find((s) => s.marketplaceAccountId === b.marketplaceAccountId).verificationStatus, 'unverified')
    const credential = await store.getConnectorCredential(db, { organizationId, marketplaceAccountId: a.marketplaceAccountId, providerKey: 'aras' })
    assert.equal(credential.payload.environment, 'TEST')
    assert.equal(providerCalls, 0)
    assert.equal(writes.canTriggerFulfillmentSideEffects('aras').decision, 'BLOCKED_BY_ROLLOUT')
    const { canArasCarrierAffectLiveFulfillment } = await import('./carriers/aras/arasRollout.ts')
    assert.equal(canArasCarrierAffectLiveFulfillment(), false)
  } finally { globalThis.fetch = originalFetch }
})
