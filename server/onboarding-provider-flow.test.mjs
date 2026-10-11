import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ ONBOARDING-001 — SAĞLAYICI FARKINDA, HESAP KAPSAMLI, DÜRÜST KURULUM ══
//
// Gerçek Postgres motoru (PGlite) + GERÇEK drizzle göçleri. Onboarding
// durumu Entegrasyon Sağlığı'nı TÜKETİR; sağlayıcıya/taşıyıcıya HİÇBİR ağ
// çağrısı yapılmaz (ONB-15/16 bunu `fetch` sayacıyla kanıtlar).

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const schema = await import('./db/schema.ts')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const service = await import('./onboarding/onboardingService.ts')
const model = await import('./onboarding/onboardingModel.ts')
const repo = await import('./onboarding/onboardingRepository.ts')
const credentials = await import('./integrations/credentialService.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const orders = await import('./orders/orderPersistenceService.ts')
const connectorStore = await import('./connectors/connectorCredentialStore.ts')
const kernel = await import('./connectors/connectorKernel.ts')
const catalog = await import('./connectors/providerCatalog.ts')

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
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}
let slugSeq = 0
async function makeOrg(db, name = 'Org') {
  slugSeq += 1
  const [org] = await db
    .insert(schema.organizations)
    .values({ name, slug: `onb-${slugSeq}-${randomBytes(3).toString('hex')}` })
    .returning()
  return org.id
}

const TRENDYOL_SECRET = 'TY-SECRET-9f3a1c'
const TRENDYOL_KEY = 'TY-APIKEY-77b2e0'
const SURAT_SECRET = 'SURAT-SIFRE-51de'

/** Üretim yolu: kimlik kaydı + AKTİF hesap (kimlik kaydı ucunun yaptığı). */
async function connectTrendyol(db, org, sellerId = '111') {
  await credentials.saveIntegrationCredential(db, org, 'trendyol', {
    sellerId,
    apiKey: TRENDYOL_KEY,
    apiSecret: TRENDYOL_SECRET,
  })
  return accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', sellerId)
}
async function connectSurat(db, org) {
  await credentials.saveIntegrationCredential(db, org, 'surat', {
    kullaniciAdi: 'cari-1',
    sifre: SURAT_SECRET,
  })
}
const sync = (db, org, entry) =>
  repo.recordSyncState(db, org, { provider: 'trendyol', fetchedCount: 0, ...entry })

const blockersOf = async (db, org) => (await service.deriveOnboardingStatus(db, org)).blockers

/* ─────────────────────────────────────────────────────────────────────── */

test('ONB-1: yeni organizasyon → tamamlanmamış, onboarding gösterilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const status = await service.deriveOnboardingStatus(db, org)
  assert.equal(status.completed, false)
  assert.equal(status.eligibleToComplete, false)
  assert.deepEqual(status.blockers, ['MARKETPLACE_NOT_CONFIGURED', 'CARRIER_NOT_CONFIGURED'])
  assert.equal(status.resumeStep, 'WELCOME')
  const done = await service.handleOnboardingCompleteRequest({ db, organizationId: org })
  assert.equal(done.httpStatus, 409)
  assert.equal((await repo.getSettings(db, org)).onboardingCompleted, false)
})

test('ONB-2/22: tamamlanmış organizasyon, entegrasyon BOZULSA da yeniden açılmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  await sync(db, org, { resource: 'orders', status: 'success', marketplaceAccountId: account.id })
  assert.equal((await service.completeOnboarding(db, org)).ok, true)

  // SONRADAN: kimlik silindi, kimlik reddedildi, taşıyıcı silindi.
  await sync(db, org, {
    resource: 'orders', status: 'failed', errorCode: 'HTTP_401', marketplaceAccountId: account.id,
  })
  await credentials.deleteIntegrationCredential(db, org, 'trendyol')
  await credentials.deleteIntegrationCredential(db, org, 'surat')

  const status = await service.deriveOnboardingStatus(db, org)
  // Güncel durum DÜRÜSTÇE raporlanır...
  assert.ok(status.blockers.length > 0, 'güncel eksikler gizlenmez')
  // ...ama TARİHSEL tamamlanma OTORİTERDİR.
  assert.equal(status.completed, true, 'tamamlanmış organizasyon yeniden açılmaz')
  assert.ok(status.completedAt)
  const again = await service.handleOnboardingCompleteRequest({ db, organizationId: org })
  assert.equal(again.httpStatus, 200, 'tamamlanmış organizasyon için çağrı idempotent')
  assert.equal(again.body.completed, true)
  assert.equal((await repo.getSettings(db, org)).onboardingCompleted, true)
})

test('ONB-3: Trendyol kayıtlı, başarılı bootstrap senkronu yok → tamamlanmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await connectTrendyol(db, org)
  await connectSurat(db, org)
  const status = await service.deriveOnboardingStatus(db, org)
  assert.deepEqual(status.blockers, ['FIRST_SYNC_REQUIRED'])
  assert.equal(status.marketplaces[0].configured, true)
  assert.equal(status.marketplaces[0].bootstrapReady, false)
  assert.equal(status.resumeStep, 'FIRST_SYNC')
  assert.equal((await service.handleOnboardingCompleteRequest({ db, organizationId: org })).httpStatus, 409)
})

test('ONB-4/6: HESAP KAPSAMLI, SIFIR satırlı başarılı sipariş senkronu bootstrap sağlar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  // R1 yeniden üretimi: üretim yolu hesap kapsamlı satır yazar ve ilk sipariş
  // senkronu MEŞRU olarak 0 satır dönebilir. Eski okuyucu bunu GÖRMÜYORDU.
  await sync(db, org, {
    resource: 'orders', status: 'success', fetchedCount: 0, marketplaceAccountId: account.id,
  })
  const status = await service.deriveOnboardingStatus(db, org)
  assert.equal(status.counts.orders, 0, 'satır SAYISI kanıt değildir')
  assert.deepEqual(status.blockers, [])
  assert.equal(status.eligibleToComplete, true)
  assert.equal(status.resumeStep, 'READY')
  const [trendyol] = status.marketplaces
  assert.equal(trendyol.bootstrapReady, true)
  assert.equal(trendyol.accounts[0].marketplaceAccountId, account.id)
  assert.equal(trendyol.accounts[0].bootstrapReady, true)
  const done = await service.handleOnboardingCompleteRequest({ db, organizationId: org })
  assert.equal(done.httpStatus, 200)
  assert.equal(done.body.completed, true)
})

test('ONB-5: yalnız ürün senkronu başarısı mevcut sözleşmeyle bootstrap sağlar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  await sync(db, org, { resource: 'products', status: 'success', marketplaceAccountId: account.id })
  const status = await service.deriveOnboardingStatus(db, org)
  assert.deepEqual(status.marketplaces[0].bootstrapResources, ['orders', 'products'])
  assert.deepEqual(status.blockers, [])
})

test('ONB-7: başarısız/kısmi senkron bootstrap SAĞLAMAZ; kilit başarıyı SİLMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  const scope = { marketplaceAccountId: account.id }

  await sync(db, org, { resource: 'orders', status: 'failed', errorCode: 'HTTP_500', ...scope })
  assert.deepEqual(await blockersOf(db, org), ['FIRST_SYNC_REQUIRED'], 'failed sayılmaz')
  await sync(db, org, { resource: 'products', status: 'partial', fetchedCount: 12, ...scope })
  assert.deepEqual(await blockersOf(db, org), ['FIRST_SYNC_REQUIRED'], 'partial sayılmaz')
  // Açık 'running' kilidi de başarı DEĞİLDİR.
  await repo.acquireSyncLock(db, org, 'orders', scope)
  assert.deepEqual(await blockersOf(db, org), ['FIRST_SYNC_REQUIRED'], 'running sayılmaz')

  // R3 yeniden üretimi: başarıdan SONRA alınan kilit adımı geri ÇEVİRMEZ.
  await sync(db, org, { resource: 'orders', status: 'success', ...scope })
  await repo.acquireSyncLock(db, org, 'orders', scope)
  assert.deepEqual(await blockersOf(db, org), [], 'kilit geçmiş başarıyı silmez')

  // Kimlik REDDİ (AUTH) ise "doğrulandı" DENMEZ.
  await sync(db, org, { resource: 'orders', status: 'failed', errorCode: 'HTTP_401', ...scope })
  await sync(db, org, { resource: 'products', status: 'failed', errorCode: 'HTTP_401', ...scope })
  const rejected = await service.deriveOnboardingStatus(db, org)
  assert.deepEqual(rejected.blockers, ['MARKETPLACE_NOT_VERIFIED'])
  assert.equal(rejected.marketplaces[0].credentialsRejected, true)
})

test('ONB-8/20: başka kiracının senkronu/hesabı/tamamlanması SIZMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'A')
  const orgB = await makeOrg(db, 'B')
  await connectTrendyol(db, orgA, '111')
  await connectSurat(db, orgA)
  const accountB = await connectTrendyol(db, orgB, '222')
  await connectSurat(db, orgB)
  await sync(db, orgB, { resource: 'orders', status: 'success', marketplaceAccountId: accountB.id })
  // B'nin başarısı A'yı SAĞLAMAZ.
  const statusA = await service.deriveOnboardingStatus(db, orgA)
  assert.deepEqual(statusA.blockers, ['FIRST_SYNC_REQUIRED'])
  // A'nın yanıtı B'nin hesabını GÖRMEZ.
  assert.equal(JSON.stringify(statusA).includes(accountB.id), false)
  assert.equal(statusA.marketplaces[0].accounts.length, 1)
  // B tamamlanır; A bundan etkilenmez.
  assert.equal((await service.handleOnboardingCompleteRequest({ db, organizationId: orgB })).httpStatus, 200)
  assert.equal((await service.deriveOnboardingStatus(db, orgA)).completed, false)
  assert.equal((await repo.getSettings(db, orgA)).onboardingCompleted, false)
  // A'yı tamamlama denemesi B'yi DEĞİŞTİRMEZ (ve A için 409 döner).
  assert.equal((await service.handleOnboardingCompleteRequest({ db, organizationId: orgA })).httpStatus, 409)
  assert.equal((await repo.getSettings(db, orgB)).onboardingCompleted, true)
  // Kapsamsız okuma FAIL-CLOSED.
  await assert.rejects(() => service.deriveOnboardingStatus(db, ''))
})

test('ONB-9: kardeş hesabın başarısı diğer hesabı DOĞRULAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await connectSurat(db, org)
  // Eski satıcı kimliği (PASİF kalacak) senkron etti ve sipariş yazdı.
  const old = await connectTrendyol(db, org, '999')
  await sync(db, org, { resource: 'orders', status: 'success', marketplaceAccountId: old.id })
  await orders.persistSyncResult(
    db,
    org,
    [{ marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'O1', orderDate: '2026-07-10T00:00:00Z', items: [] }],
    { complete: false, marketplaceAccountId: old.id },
  )
  // Yeni satıcı kimliği AKTİF oldu, henüz senkron ETMEDİ.
  const current = await connectTrendyol(db, org, '111')

  const status = await service.deriveOnboardingStatus(db, org)
  const views = Object.fromEntries(
    status.marketplaces[0].accounts.map((view) => [view.marketplaceAccountId, view]),
  )
  assert.equal(views[current.id].bootstrapReady, false, 'aktif hesap kendi başarısını ister')
  assert.equal(views[old.id].credentials, 'NOT_BOUND', 'sağlayıcı geneli kimlik pasif hesaba bağlanmaz')
  assert.equal(views[old.id].bootstrapReady, false)
  // R4 yeniden üretimi: kardeşin sipariş SATIRI kanıt DEĞİLDİR.
  assert.equal(status.counts.orders, 1)
  assert.deepEqual(status.blockers, ['FIRST_SYNC_REQUIRED'])

  // Hesap kapsamlı kimlikli sağlayıcıda (çok mağaza) izolasyon — saf model.
  const health = (accountId, success) => ({
    providerKey: 'acme',
    marketplaceAccountId: accountId,
    connectionScope: 'account',
    connection: 'CONNECTED',
    sync: success ? 'HEALTHY' : 'NEVER_RUN',
    lastSuccessfulSyncAt: success ? '2026-09-01T00:00:00.000Z' : null,
  })
  const evaluated = model.evaluateOnboarding({
    completed: false,
    completedAt: null,
    providers: [{
      providerKey: 'acme', displayName: 'Acme', rolloutStage: 'ga',
      eligibleForOnboarding: true, bootstrapResources: ['orders'],
    }],
    healthByResource: { orders: [health('X', false), health('Y', true)] },
    accounts: [
      { id: 'X', marketplace: 'acme', displayName: 'X', isActive: false },
      { id: 'Y', marketplace: 'acme', displayName: 'Y', isActive: false },
    ],
    accountScopedCredentialProviders: ['acme'],
    carrierConfigured: true,
    defaultUnitDesiConfigured: false,
    counts: { products: 0, orders: 0 },
  })
  const acme = Object.fromEntries(
    evaluated.marketplaces[0].accounts.map((view) => [view.marketplaceAccountId, view]),
  )
  assert.equal(acme.X.bootstrapReady, false, 'Y başarısı X\'i doğrulamaz')
  assert.equal(acme.Y.bootstrapReady, true)
})

test('ONB-10: eski (hesapsız) Trendyol satırı AÇIK ve SINIRLI uyumluluk', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  // (a) Hesap öncesi dönem: hesap YOK → eski satır SAYILIR.
  const legacyOrg = await makeOrg(db)
  await credentials.saveIntegrationCredential(db, legacyOrg, 'trendyol', { sellerId: '5' })
  await connectSurat(db, legacyOrg)
  await sync(db, legacyOrg, { resource: 'orders', status: 'success' })
  const legacy = await service.deriveOnboardingStatus(db, legacyOrg)
  assert.equal(legacy.marketplaces[0].legacyConnection.counted, true)
  assert.equal(legacy.marketplaces[0].legacyConnection.reason, 'NO_ACCOUNT_FOR_PROVIDER')
  assert.deepEqual(legacy.blockers, [])

  // (b) Hesap VAR → eski satır HİÇBİR hesaba eşlenmez ve SAYILMAZ.
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  await sync(db, org, { resource: 'orders', status: 'success' })
  const status = await service.deriveOnboardingStatus(db, org)
  const trendyol = status.marketplaces[0]
  assert.equal(trendyol.legacyConnection.counted, false)
  assert.equal(trendyol.legacyConnection.reason, 'ACCOUNT_STATE_AUTHORITATIVE')
  assert.equal(trendyol.accounts[0].marketplaceAccountId, account.id)
  assert.equal(trendyol.accounts[0].bootstrapReady, false, 'eski satır hesabı doğrulamaz')
  assert.deepEqual(status.blockers, ['FIRST_SYNC_REQUIRED'])

  // (c) Kimlik SİLİNMİŞSE eski başarı dirilmez.
  await credentials.deleteIntegrationCredential(db, legacyOrg, 'trendyol')
  assert.deepEqual(await blockersOf(db, legacyOrg), ['MARKETPLACE_NOT_CONFIGURED'])
})

test('ONB-11/12: WooCommerce (internal_test), ikas/Ticimax (off) normal kurulumda YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await connectSurat(db, org)
  // Woo mağazası GERÇEKTEN bağlı ve başarıyla senkron etmiş olsun.
  const store = await accounts.ensureAccount(db, org, 'woocommerce', 'shop.example')
  await connectorStore.saveConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: store.id,
    providerKey: 'woocommerce',
    payload: { consumerKey: 'ck_x', consumerSecret: 'cs_x' },
  })
  await repo.recordSyncState(db, org, {
    provider: 'woocommerce', resource: 'orders', status: 'success', marketplaceAccountId: store.id,
  })
  const status = await service.deriveOnboardingStatus(db, org)
  const keys = status.marketplaces.map((entry) => entry.providerKey)
  assert.deepEqual(keys, ['trendyol'], 'yalnız canlı sağlayıcılar sunulur')
  assert.equal(JSON.stringify(status).includes('woocommerce'), false)
  assert.deepEqual(status.blockers, ['MARKETPLACE_NOT_CONFIGURED'], 'Woo kurulumu SAĞLAMAZ')
  assert.equal((await service.handleOnboardingCompleteRequest({ db, organizationId: org })).httpStatus, 409)

  const eligibility = Object.fromEntries(
    model
      .resolveOnboardingProviders(catalog.buildProviderCatalog(), catalog.resolveRolloutStage)
      .map((entry) => [entry.providerKey, entry]),
  )
  assert.equal(eligibility.trendyol.eligibleForOnboarding, true)
  assert.equal(eligibility.woocommerce.rolloutStage, 'internal_test')
  assert.equal(eligibility.woocommerce.eligibleForOnboarding, false)
  assert.equal(eligibility.ikas.eligibleForOnboarding, false)
  assert.equal(eligibility.ticimax.eligibleForOnboarding, false)
})

test('ONB-13: uygun liste KATALOG + CANLI yetenekten gelir (sabit liste yok)', () => {
  const registry = new kernel.ConnectorRegistry()
  const marketplace = (providerKey, caps) =>
    registry.register({
      providerKey,
      kind: 'marketplace',
      displayName: providerKey.toUpperCase(),
      capabilities: caps,
    })
  marketplace('ordersonly', [kernel.declareCapability('orders.read', { stage: 'ga' })])
  marketplace('pilotshop', [kernel.declareCapability('orders.read', { stage: 'pilot' })])
  marketplace('shadowshop', [kernel.declareCapability('orders.read', { stage: 'shadow' })])
  marketplace('noread', [kernel.declareCapability('orders.status.write', { stage: 'ga' })])
  marketplace('gatedoff', [kernel.declareCapability('orders.read', { stage: 'ga' })])
  // Kendi mağazası ailesi de sipariş kaynağıdır: terfi edince GÖRÜNMELİDİR.
  registry.register({
    providerKey: 'ownstore', kind: 'commerce_platform', displayName: 'Own',
    capabilities: [kernel.declareCapability('orders.read', { stage: 'pilot' })],
  })
  registry.register({
    providerKey: 'somecarrier', kind: 'shipping', displayName: 'C',
    capabilities: [kernel.declareCapability('orders.read', { stage: 'ga' })],
  })
  const stages = {
    ordersonly: 'ga', pilotshop: 'pilot', shadowshop: 'ga', noread: 'ga',
    gatedoff: 'internal_test', ownstore: 'pilot', somecarrier: 'ga',
  }
  const list = model.resolveOnboardingProviders(registry, (key) => stages[key] ?? 'off')
  const byKey = Object.fromEntries(list.map((entry) => [entry.providerKey, entry]))
  assert.equal(byKey.ordersonly.eligibleForOnboarding, true)
  assert.deepEqual(byKey.ordersonly.bootstrapResources, ['orders'], 'desteklenmeyen kaynak istenmez')
  assert.equal(byKey.pilotshop.eligibleForOnboarding, true)
  assert.equal(byKey.shadowshop.eligibleForOnboarding, false, 'yetenek canlı değil')
  assert.equal(byKey.noread.eligibleForOnboarding, false, 'bootstrap yeteneği yok')
  assert.equal(byKey.gatedoff.eligibleForOnboarding, false, 'yayın aşaması kapalı')
  assert.equal(byKey.somecarrier, undefined, 'taşıyıcı sipariş kaynağı değildir')
  assert.equal(byKey.ownstore.eligibleForOnboarding, true, 'mağaza altyapısı terfi edince sunulur')

  // Yalnız-sipariş sağlayıcıda ÜRÜN başarısı sayılmaz (kaynak canlı değil),
  // sipariş başarısı sayılır.
  const snapshot = (resource) => ({
    completed: false,
    completedAt: null,
    providers: [byKey.ordersonly],
    healthByResource: {
      [resource]: [{
        providerKey: 'ordersonly', marketplaceAccountId: null, connectionScope: 'none',
        connection: 'CONNECTED', sync: 'HEALTHY', lastSuccessfulSyncAt: '2026-09-01T00:00:00.000Z',
      }],
    },
    accounts: [],
    accountScopedCredentialProviders: [],
    carrierConfigured: true,
    defaultUnitDesiConfigured: false,
    counts: { products: 0, orders: 0 },
  })
  assert.equal(model.evaluateOnboarding(snapshot('products')).eligibleToComplete, false)
  // Hesapsız sağlayıcıda eski satır uyumluluğu YALNIZ listelenen sağlayıcıdır.
  assert.equal(model.LEGACY_SYNC_COMPAT_PROVIDERS.includes('ordersonly'), false)

  // Kaynak taraması: tamamlanma kuralı pazaryeri ADINA bağlı değildir.
  const source = readFileSync(join(here, 'onboarding', 'onboardingModel.ts'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(/trendyolConfigured/.test(source), false)
  assert.equal(/providerKey\s*===\s*['"]trendyol['"]/.test(source), false)
})

test('ONB-14: Sürat kayıtlı ≠ doğrulanmış (kalıcı kanıt yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const none = await service.deriveOnboardingStatus(db, org)
  assert.equal(none.carrier.verification, 'NOT_CONFIGURED')
  await connectSurat(db, org)
  const status = await service.deriveOnboardingStatus(db, org)
  assert.equal(status.carrier.configured, true)
  assert.equal(status.carrier.verification, 'VERIFICATION_NOT_PERSISTED')
  assert.equal(JSON.stringify(status.carrier).includes('VERIFIED"'), false)
  // Eski yalan alan GERİ GELEMEZ.
  assert.equal('suratConnectionVerified' in status, false)
  assert.equal(JSON.stringify(status).includes('suratConnectionVerified'), false)
  // Taşıyıcı kayıtlıyken engel kalkar — doğrulama ŞART KOŞULMAZ.
  assert.equal(status.blockers.includes('CARRIER_NOT_CONFIGURED'), false)
})

test('ONB-15/16: durum ve tamamlama SIFIR ağ çağrısı, SIFIR gönderi', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]))
    throw new Error('onboarding ağa ÇIKMAMALI')
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  await service.handleOnboardingStatusRequest({ db, organizationId: org })
  await service.handleOnboardingCompleteRequest({ db, organizationId: org })
  await sync(db, org, { resource: 'orders', status: 'success', marketplaceAccountId: account.id })
  await service.handleOnboardingStatusRequest({ db, organizationId: org })
  await service.handleOnboardingCompleteRequest({ db, organizationId: org })
  assert.deepEqual(calls, [], 'sağlayıcı/taşıyıcı çağrısı yok')
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 0)
  assert.equal((await db.select().from(schema.shipments)).length, 0)
  // Durum okuması senkron BAŞLATMAZ: yeni senkron satırı yazılmaz.
  const before = (await db.select().from(schema.integrationSyncState)).length
  await service.handleOnboardingStatusRequest({ db, organizationId: org })
  assert.equal((await db.select().from(schema.integrationSyncState)).length, before)
  for (const file of ['onboardingService.ts', 'onboardingModel.ts']) {
    const source = readFileSync(join(here, 'onboarding', file), 'utf8')
    assert.equal(/\bfetch\(|callSurat|createShipment|syncOrders|fetchTrendyol/.test(source), false, file)
  }
})

test('ONB-17: yeniden açılış İLK EKSİK ZORUNLU adımdan sürer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const resume = async () => (await service.deriveOnboardingStatus(db, org)).resumeStep
  assert.equal(await resume(), 'WELCOME')
  await connectSurat(db, org)
  assert.equal(await resume(), 'MARKETPLACE', 'taşıyıcı önce girildiyse pazaryerine döner')
  const account = await connectTrendyol(db, org)
  assert.equal(await resume(), 'FIRST_SYNC')
  await sync(db, org, { resource: 'orders', status: 'success', marketplaceAccountId: account.id })
  assert.equal(await resume(), 'READY', 'hepsi tamam ama completed=false → Hazır')

  const other = await makeOrg(db)
  await connectTrendyol(db, other, '444')
  assert.equal((await service.deriveOnboardingStatus(db, other)).resumeStep, 'CARRIER')
})

test('ONB-18: tamamlama sunucuda YENİDEN hesaplanır; sahte istemci değeri yok sayılır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // İstemci "tamamlandı" ve tüm adımları doğru İDDİA EDER.
  const forged = await service.handleOnboardingCompleteRequest({
    db,
    organizationId: org,
    completed: true,
    eligibleToComplete: true,
    blockers: [],
    steps: [{ key: 'MARKETPLACE', required: true, done: true }],
    body: { completed: true },
  })
  assert.equal(forged.httpStatus, 409)
  assert.equal(forged.body.completed, false)
  assert.equal((await repo.getSettings(db, org)).onboardingCompleted, false)

  // Ürün ucu istek gövdesini OKUMAZ ve yalnız servise devreder.
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = index.indexOf("app.post('/api/onboarding/complete'")
  const block = index.slice(start, index.indexOf('\n})', start))
  assert.ok(start > 0)
  assert.equal(/request\.body|req\.body/.test(block), false, 'gövde okunmaz')
  assert.match(block, /handleOnboardingCompleteRequest\(\{\s*db: context\.db,\s*organizationId: context\.organizationId,\s*\}\)/)
  assert.equal(service.completeOnboarding.length, 2, 'tamamlama yalnız (db, org) alır')
})

test('ONB-19: yanıt sır/anahtar/şifre İÇERMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  await sync(db, org, { resource: 'orders', status: 'failed', errorCode: 'HTTP_401', marketplaceAccountId: account.id })
  for (const result of [
    await service.handleOnboardingStatusRequest({ db, organizationId: org }),
    await service.handleOnboardingCompleteRequest({ db, organizationId: org }),
  ]) {
    const text = JSON.stringify(result.body)
    for (const secret of [TRENDYOL_SECRET, TRENDYOL_KEY, SURAT_SECRET, 'HTTP_401']) {
      assert.equal(text.includes(secret), false, `yanıt ${secret} taşımamalı`)
    }
    assert.equal(/apiKey|apiSecret|sifre|password|encrypted/i.test(text), false)
  }
})

test('ONB-21: RAW yazıcı yeteneği kurulumu ENGELLEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  await sync(db, org, { resource: 'orders', status: 'success', marketplaceAccountId: account.id })
  // Bu çalışma zamanı Windows DEĞİLMİŞ gibi: SERVER_WINDOWS_RAW kullanılamaz.
  const { describeServerRawCapability } = await import('./printing/printTransport.ts')
  assert.equal(
    describeServerRawCapability({ platform: 'linux', printerName: 'Zebra' }).available,
    false,
  )
  const status = await service.deriveOnboardingStatus(db, org)
  assert.deepEqual(status.blockers, [])
  assert.equal(status.steps.some((step) => /PRINT/.test(step.key)), false)
  const source = readFileSync(join(here, 'onboarding', 'onboardingModel.ts'), 'utf8')
  assert.equal(/printTransport|SERVER_WINDOWS_RAW|printerName/.test(source), false)
  assert.equal((await service.handleOnboardingCompleteRequest({ db, organizationId: org })).httpStatus, 200)
})

test('ONB-23: varsayılan desi KANITLANMIŞ çalışma zamanında tamamlanma şartı DEĞİL', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  await connectSurat(db, org)
  await sync(db, org, { resource: 'orders', status: 'success', marketplaceAccountId: account.id })

  // KANIT 1: otomatik etiket VARSAYILAN KAPALI — yeni organizasyonun normal
  // ilk etiket yolu ELLE baskıdır (arka plan işçisi devrede değil).
  const policy = await import('./shipments/suratAutoLabelPolicy.ts')
  assert.equal(policy.AUTO_LABEL_DEFAULT_ENABLED, false)
  assert.equal(policy.isAutoLabelEnabledForScope({
    settings: null, scope: { marketplace: 'Trendyol', carrier: 'surat' },
  }).enabled, false)

  // KANIT 2: kiracı varsayılanı YOKKEN elle girilen desi create yolunda
  // OTORİTERDİR — çözücü kiracı ayarı İSTEMEZ.
  const defaults = await import('./onboarding/shipmentDefaultsRepository.ts')
  assert.equal((await defaults.getShipmentDefaults(db, org)).defaultUnitDesi, null)
  const { resolveShipmentDesi } = await import('./shipments/resolveShipmentDesi.ts')
  const manual = await resolveShipmentDesi({
    db, organizationId: org, order: { desi: 3, items: [] }, products: [],
  })
  assert.equal(manual.desi, 3)
  assert.equal(manual.source, 'request')
  assert.equal(manual.tenantSettingPresent, false)

  // KANIT 3: ürün kataloğu desisi de kiracı varsayılanı OLMADAN çözülür.
  const { calculateOrderDesi } = await import('../src/utils/orderDesi.ts')
  const fromCatalog = calculateOrderDesi(
    { items: [{ barcode: 'B1', quantity: 1 }] },
    [{ barcode: 'B1', desi: 2 }],
    { defaultUnitDesi: null },
  )
  assert.equal(fromCatalog.finalDesi, 2)

  // SONUÇ: desi TAMAMLANMA ŞARTI DEĞİL.
  const status = await service.deriveOnboardingStatus(db, org)
  assert.equal(status.shipmentDefaults.required, false)
  assert.equal(status.shipmentDefaults.defaultUnitDesiConfigured, false)
  assert.equal(status.blockers.includes('SHIPMENT_DEFAULTS_REQUIRED'), false)
  assert.equal(status.steps.some((step) => step.key === 'SHIPMENT_DEFAULTS'), false)
  assert.equal((await service.handleOnboardingCompleteRequest({ db, organizationId: org })).httpStatus, 200)
})

test('ONB-24: onboarding tamamlanma gerçeği tarayıcı deposunda TUTULMAZ', () => {
  for (const file of [
    'src/services/onboardingService.ts',
    'src/onboarding/OnboardingGate.tsx',
    'src/pages/OnboardingPage.tsx',
  ]) {
    // Yorumlar ayıklanır: yasak "kullanım"dır, açıklama metni değil.
    const source = readFileSync(join(root, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    assert.equal(/localStorage|sessionStorage|indexedDB/.test(source), false, file)
  }
})

test('ONB-HEALTH: onboarding sağlık GERÇEĞİNİ tüketir, kopyalamaz', () => {
  const source = readFileSync(join(here, 'onboarding', 'onboardingService.ts'), 'utf8')
  assert.match(source, /loadIntegrationHealthForOrganization/)
  assert.match(source, /ACCOUNT_SCOPED_CREDENTIAL_PROVIDERS/)
  // Senkron durumu doğrudan sorgulanmaz; kimlik varlık haritası kurulmaz.
  assert.equal(/getSyncStates|integrationSyncState|listAccountsWithCredential/.test(source), false)
  const modelSource = readFileSync(join(here, 'onboarding', 'onboardingModel.ts'), 'utf8')
  assert.match(modelSource, /capabilityIsLive/)
  assert.match(modelSource, /stageAffectsLiveBehavior/)
  assert.equal(/ROLLOUT_STAGE_POLICY/.test(modelSource), false, 'ikinci yayın yorumu yok')
})
