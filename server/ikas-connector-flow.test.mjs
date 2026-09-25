// IKAS-001 — HESAP KAPSAMLI IKAS BAĞLAYICISI (HERMETİK).
//
// Gerçek ikas'a ÇIKILMAZ: resmî sözleşmeye (providers/ikas/contracts/admin-v1.json
// v2) sadık bir SAHTE ikas sunucusu taşıma katmanına enjekte edilir.
// Veritabanı: PGlite + GERÇEK göçler. LIVE_PROVIDER_VERIFICATION = NOT_PERFORMED.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
const storeNamePolicy = await import('./connectors/ikas/ikasStoreName.ts')
const client = await import('./connectors/ikas/ikasClient.ts')
const normalizer = await import('./connectors/ikas/ikasOrderNormalizer.ts')
const sync = await import('./connectors/ikas/ikasOrderSync.ts')
const connection = await import('./connectors/ikas/ikasConnectionService.ts')
const handlers = await import('./connectors/ikas/ikasHttpHandlers.ts')
const connectorStore = await import('./connectors/connectorCredentialStore.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const syncRepo = await import('./onboarding/onboardingRepository.ts')
const healthService = await import('./connectors/integrationHealthService.ts')
const catalog = await import('./connectors/providerCatalog.ts')
const kernel = await import('./connectors/connectorKernel.ts')
const gate = await import('./connectors/liveWriteGate.ts')
const onboardingModel = await import('./onboarding/onboardingModel.ts')

const pack = JSON.parse(readFileSync(join(root, 'providers/ikas/contracts/admin-v1.json'), 'utf8'))

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
  const slug = `ikas-${randomBytes(4).toString('hex')}`
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

/* ═══ SAHTE IKAS SUNUCUSU (sözleşmeye sadık) ═════════════════════════════ */

const HOUR = 3_600_000
const BASE_MS = Date.parse('2026-09-20T10:00:00.000Z')

function makeOrder(n, over = {}) {
  return {
    __updatedAtMs: over.__updatedAtMs ?? BASE_MS + n * 1000,
    id: over.id ?? `ord-${n}`,
    merchantId: over.merchantId ?? 'm-A',
    orderNumber: String(1000 + n),
    status: over.status ?? 'CREATED',
    orderPackageStatus: 'UNFULFILLED',
    orderedAt: over.orderedAt ?? BASE_MS + n * 1000,
    currencyCode: 'TRY',
    totalFinalPrice: over.totalFinalPrice ?? 99.95,
    customer: { id: `c-${n}`, fullName: 'Örnek Müşteri', firstName: 'Örnek', lastName: 'Müşteri', phone: null },
    shippingAddress: {
      firstName: 'Örnek', lastName: 'Alıcı', addressLine1: 'Örnek Mah. 1', addressLine2: null,
      phone: '+905550000000', postalCode: '34000',
      city: { name: 'İstanbul' }, district: { name: 'Kadıköy' },
    },
    orderLineItems: [
      {
        id: `line-${n}-1`, quantity: 2, price: 49.99, finalPrice: 99.98, status: 'CREATED',
        options: [{ name: 'Renk', values: [{ name: 'Renk', value: 'Kırmızı' }] }],
        variant: { id: `var-${n}`, sku: `SKU-${n}`, barcodeList: [`869000${n}`], name: 'Ürün' },
      },
    ],
    orderPackages: over.orderPackages ?? null,
  }
}

function fakeIkas(config = {}) {
  const stores = new Map(Object.entries(config.stores ?? {
    magazaa: { clientId: 'cid-A', clientSecret: 'SECRET-A-xyz', merchantId: 'm-A', storeName: 'magazaa', orders: [] },
  }))
  const tokens = new Map()
  const calls = []
  let tokenSeq = 0
  const state = {
    tokenRequests: 0,
    graphqlRequests: 0,
    expiresIn: config.expiresIn ?? 14400,
    revoked: new Set(),
    graphqlAlways401: false,
    merchantErrors: null,
    orderErrors: null,
    failOrderPage: null,
    brokenPageNumber: false,
    stuckHasNext: false,
    duplicateOnPage: null,
  }
  const transport = async (request) => {
    calls.push({ url: request.url, headers: { ...request.headers }, body: request.body })
    const url = new URL(request.url)
    if (url.pathname === '/api/admin/oauth/token') {
      state.tokenRequests += 1
      const storeKey = url.hostname.replace('.myikas.com', '')
      const form = new URLSearchParams(request.body)
      const store = stores.get(storeKey)
      if (
        request.headers['Content-Type'] !== 'application/x-www-form-urlencoded' ||
        form.get('grant_type') !== 'client_credentials' ||
        !store || form.get('client_id') !== store.clientId || form.get('client_secret') !== store.clientSecret
      ) {
        return { status: 401, bodyText: JSON.stringify({ error: 'invalid_client' }) }
      }
      tokenSeq += 1
      const token = `tok-${storeKey}-${tokenSeq}-${randomBytes(4).toString('hex')}`
      tokens.set(token, storeKey)
      return {
        status: 200,
        bodyText: JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: state.expiresIn }),
      }
    }
    if (request.url === 'https://api.myikas.com/api/v1/admin/graphql') {
      state.graphqlRequests += 1
      const token = String(request.headers.Authorization ?? '').replace(/^Bearer /, '')
      if (state.graphqlAlways401 || !tokens.has(token) || state.revoked.has(token)) {
        return { status: 401, bodyText: JSON.stringify({ message: 'Unauthorized' }) }
      }
      const store = stores.get(tokens.get(token))
      const { query, variables } = JSON.parse(request.body)
      if (query.includes('getMerchant')) {
        if (state.merchantErrors) return { status: 200, bodyText: JSON.stringify({ data: null, errors: state.merchantErrors }) }
        return { status: 200, bodyText: JSON.stringify({ data: { getMerchant: { id: store.merchantId, storeName: store.storeName } } }) }
      }
      if (query.includes('listOrder')) {
        if (state.orderErrors) return { status: 200, bodyText: JSON.stringify({ data: null, errors: state.orderErrors }) }
        const page = variables.pagination?.page ?? 1
        const limit = variables.pagination?.limit ?? 50
        if (limit > 200 || limit < 1) {
          return { status: 200, bodyText: JSON.stringify({ errors: [{ message: 'limit out of range' }] }) }
        }
        if (state.failOrderPage === page) return { status: 500, bodyText: 'boom' }
        const gte = variables.updatedAt?.gte ?? -Infinity
        const lte = variables.updatedAt?.lte ?? Infinity
        const filtered = store.orders.filter((o) => o.__updatedAtMs >= gte && o.__updatedAtMs <= lte)
        const effectivePage = state.stuckHasNext ? 1 : page
        let slice = filtered.slice((effectivePage - 1) * limit, effectivePage * limit)
        if (state.duplicateOnPage === page && slice.length > 0) slice = [...slice, slice[0]]
        const hasNext = state.stuckHasNext ? true : effectivePage * limit < filtered.length
        // `__updatedAtMs` Order TİPİNDE YOK: yanıttan ÇIKARILIR.
        const data = slice.map(({ __updatedAtMs, ...rest }) => rest)
        return {
          status: 200,
          bodyText: JSON.stringify({
            data: {
              listOrder: {
                hasNext,
                page: state.brokenPageNumber ? 1 : page,
                limit,
                count: 3,
                data,
              },
            },
          }),
        }
      }
      return { status: 200, bodyText: JSON.stringify({ errors: [{ message: 'unknown query' }] }) }
    }
    throw new Error(`sahte ikas: beklenmeyen hedef ${request.url}`)
  }
  return { transport, calls, state, stores, tokens }
}

function options(fake, over = {}) {
  return {
    transport: fake.transport,
    tokenCache: new client.IkasTokenCache(),
    sleep: async () => {},
    retryDelaysMs: [],
    ...over,
  }
}

async function connectA(db, org, fake, over = {}) {
  return connection.connectIkasStore(
    db,
    { organizationId: org, storeName: 'magazaa', clientId: 'cid-A', clientSecret: 'SECRET-A-xyz', ...over },
    options(fake),
  )
}

/* ═══ SÖZLEŞME ═══════════════════════════════════════════════════════════ */

test('IKAS-CONTRACT-1/2/3: token ömrü 14400, sayfa üst sınırı 200, kimlik merchant.id', () => {
  assert.equal(pack.AUTH_MODEL.tokenLifetime.expiresInSeconds, 14400)
  assert.equal(pack.AUTH_MODEL.tokenLifetime.verified, true)
  assert.equal(pack.PAGINATION.maxLimit.value, 200)
  assert.equal(pack.PAGINATION.maxLimit.verified, true)
  assert.match(pack.IDENTITY_FIELDS.store, /getMerchant\.id/)
  assert.ok(pack.IDENTITY_FIELDS.notIdentity.includes('client_id'))
  assert.equal(pack.ORDER_MODEL.updatedAtField.documentedOnOrderType, false)
  assert.equal(pack.PACKAGE_MODEL.cargoflowPackageIdentityVerified, false)
  assert.equal(client.IKAS_MAX_PAGE_LIMIT, 200)
  // Sorgu `updatedAt` ALANINI seçmez (tipte yok), yalnız filtre argümanıdır.
  assert.doesNotMatch(client.LIST_ORDER_QUERY.replace(/\$updatedAt|updatedAt: \$updatedAt/g, ''), /\bupdatedAt\b/)
  assert.doesNotMatch(client.LIST_ORDER_QUERY, /\bsort\b/)
})

/* ═══ MAĞAZA ADI / AĞ POLİTİKASI ═════════════════════════════════════════ */

test('IKAS-GQL-2 + host güvenliği: yalnız *.myikas.com belirteç hostu ve sabit GraphQL ucu', () => {
  for (const [input, expected] of [
    ['magazam', 'magazam'],
    ['  MAGAZAM ', 'magazam'],
    ['magazam.myikas.com', 'magazam'],
    ['https://magazam.myikas.com/', 'magazam'],
    ['benim-magazam', 'benim-magazam'],
  ]) {
    const result = storeNamePolicy.normalizeIkasStoreName(input)
    assert.equal(result.ok, true, input)
    assert.equal(result.storeName, expected)
    assert.equal(result.tokenUrl, `https://${expected}.myikas.com/api/admin/oauth/token`)
  }
  for (const evil of [
    '', 'evil.com', 'magazam.myikas.com.evil.com', 'magazam.myikas.com:8443',
    'https://magazam.myikas.com/x', 'user@magazam', 'magazam?x=1', 'magazam#a',
    'http://magazam.myikas.com', '-bad', 'bad-', 'a..b', '127.0.0.1', 'api',
    'https://evil.com/?h=magazam.myikas.com', 'magazam/../evil',
  ]) {
    assert.equal(storeNamePolicy.normalizeIkasStoreName(evil).ok, false, `reddedilmeli: ${evil}`)
  }
  const allowed = storeNamePolicy.isAllowedIkasRequestUrl
  assert.equal(allowed('https://api.myikas.com/api/v1/admin/graphql'), true)
  assert.equal(allowed('https://magazam.myikas.com/api/admin/oauth/token'), true)
  for (const bad of [
    'https://evil.com/api/admin/oauth/token',
    'http://magazam.myikas.com/api/admin/oauth/token',
    'https://magazam.myikas.com:444/api/admin/oauth/token',
    'https://magazam.myikas.com/api/admin/oauth/token?x=1',
    'https://u:p@magazam.myikas.com/api/admin/oauth/token',
    'https://api.myikas.com/api/v1/admin/graphql?x=1',
    'https://api.myikas.com.evil.com/api/v1/admin/graphql',
  ]) {
    assert.equal(allowed(bad), false, bad)
  }
})

/* ═══ OAUTH ══════════════════════════════════════════════════════════════ */

test('IKAS-AUTH-1/2: belirteç isteği mağaza hostuna form gövdesiyle; sır sorgu dizesinde DEĞİL', async () => {
  const fake = fakeIkas()
  const creds = { storeName: 'magazaa', tokenUrl: 'https://magazaa.myikas.com/api/admin/oauth/token', clientId: 'cid-A', clientSecret: 'SECRET-A-xyz' }
  const merchant = await client.fetchIkasMerchant(creds, options(fake))
  assert.equal(merchant.ok, true)
  const [tokenCall, graphqlCall] = fake.calls
  assert.equal(tokenCall.url, 'https://magazaa.myikas.com/api/admin/oauth/token')
  assert.equal(tokenCall.headers['Content-Type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(tokenCall.body)
  assert.equal(form.get('grant_type'), 'client_credentials')
  assert.equal(form.get('client_id'), 'cid-A')
  assert.equal(form.get('client_secret'), 'SECRET-A-xyz')
  for (const call of fake.calls) {
    assert.equal(new URL(call.url).search, '', 'sorgu dizesi YOK')
    assert.equal(call.url.includes('SECRET-A-xyz'), false)
  }
  assert.equal(graphqlCall.url, 'https://api.myikas.com/api/v1/admin/graphql')
  assert.match(graphqlCall.headers.Authorization, /^Bearer tok-/)
  assert.equal(graphqlCall.body.includes('SECRET-A-xyz'), false, 'sır GraphQL gövdesine GİTMEZ')
})

test('IKAS-AUTH-4/5 + ömür: 401 → BİR KEZ yenile/tekrarla; ikinci 401 durur; ömür yanıttan', async () => {
  const creds = { storeName: 'magazaa', tokenUrl: 'https://magazaa.myikas.com/api/admin/oauth/token', clientId: 'cid-A', clientSecret: 'SECRET-A-xyz' }
  // (4) belirteç iptal edildi → tek yenileme, tek tekrar, başarı
  const fake = fakeIkas()
  const opts = options(fake)
  assert.equal((await client.fetchIkasMerchant(creds, opts)).ok, true)
  for (const token of fake.tokens.keys()) fake.state.revoked.add(token)
  const beforeTokens = fake.state.tokenRequests
  const beforeGql = fake.state.graphqlRequests
  const again = await client.fetchIkasMerchant(creds, opts)
  assert.equal(again.ok, true)
  assert.equal(fake.state.tokenRequests - beforeTokens, 1, 'tam BİR yenileme')
  assert.equal(fake.state.graphqlRequests - beforeGql, 2, 'ilk deneme + TEK tekrar')

  // (5) sürekli 401 → döngü YOK
  const stuck = fakeIkas()
  stuck.state.graphqlAlways401 = true
  const failed = await client.fetchIkasMerchant(creds, options(stuck))
  assert.equal(failed.ok, false)
  assert.equal(failed.errorClass, 'GRAPHQL_AUTH_FAILED')
  assert.equal(stuck.state.tokenRequests, 2)
  assert.equal(stuck.state.graphqlRequests, 2)

  // Ömür YANITTAN okunur ve güvenlik payı düşülür.
  const clock = { now: BASE_MS }
  const ttl = fakeIkas({ expiresIn: 120 })
  const ttlOpts = options(ttl, { now: () => clock.now })
  await client.fetchIkasMerchant(creds, ttlOpts)
  await client.fetchIkasMerchant(creds, ttlOpts)
  assert.equal(ttl.state.tokenRequests, 1, 'geçerli belirteç önbellekten')
  clock.now += 61_000 // 120 sn − 60 sn pay aşıldı
  await client.fetchIkasMerchant(creds, ttlOpts)
  assert.equal(ttl.state.tokenRequests, 2, 'süresi dolan belirteç yenilenir')
})

test('IKAS-GQL-1: HTTP 200 + errors[] BAŞARISIZDIR; bağlantı kalıcılaşmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const fake = fakeIkas()
  fake.state.merchantErrors = [{ message: 'ham sağlayıcı iç hata metni', extensions: { code: 'INTERNAL' } }]
  const result = await connectA(db, org, fake)
  assert.equal(result.outcome, 'CONNECTION_FAILED')
  assert.equal(result.errorClass, 'GRAPHQL_ERROR')
  assert.equal(JSON.stringify(result).includes('ham sağlayıcı'), false, 'ham metin dışarı ÇIKMAZ')
  assert.equal((await db.select().from(schema.marketplaceAccounts)).length, 0)
  assert.equal((await db.select().from(schema.connectorCredentials)).length, 0)
  assert.equal(client.classifyGraphqlErrors([{ extensions: { code: 'UNAUTHENTICATED' } }]), 'GRAPHQL_AUTH_FAILED')
  assert.equal(client.classifyGraphqlErrors([{ extensions: { code: 'FORBIDDEN' } }]), 'PERMISSION_DENIED')
})

/* ═══ HESAP / ÇOK MAĞAZA / SIR ═══════════════════════════════════════════ */

test('IKAS-ACC-1/2/3/5 + AUTH-3: merchant.id kimliği; döndürme yeni hesap üretmez; A+B aktif; sır/belirteç dönmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const fake = fakeIkas({
    stores: {
      magazaa: { clientId: 'cid-A', clientSecret: 'SECRET-A-xyz', merchantId: 'm-A', storeName: 'magazaa', orders: [] },
      magazab: { clientId: 'cid-B', clientSecret: 'SECRET-B-xyz', merchantId: 'm-B', storeName: 'Mağaza B', orders: [] },
    },
  })
  const first = await connectA(db, org, fake)
  assert.equal(first.outcome, 'CONNECTED')
  assert.equal(first.providerAccountId, 'm-A', 'kimlik merchant.id')
  const [accountA] = await db.select().from(schema.marketplaceAccounts)
  assert.equal(accountA.marketplace, 'ikas')
  assert.equal(accountA.providerAccountId, 'm-A')
  assert.notEqual(accountA.providerAccountId, 'cid-A')
  assert.equal(accountA.isActive, true)

  // (2) Özel uygulama yeniden oluşturuldu: YENİ client_id/sır, AYNI merchant.
  fake.stores.get('magazaa').clientId = 'cid-A2'
  fake.stores.get('magazaa').clientSecret = 'SECRET-A2-new'
  const rotated = await connectA(db, org, fake, { clientId: 'cid-A2', clientSecret: 'SECRET-A2-new' })
  assert.equal(rotated.marketplaceAccountId, first.marketplaceAccountId, 'AYNI hesap')
  assert.equal((await db.select().from(schema.marketplaceAccounts)).length, 1)
  const stored = await connectorStore.getConnectorCredential(db, {
    organizationId: org, marketplaceAccountId: first.marketplaceAccountId, providerKey: 'ikas',
  })
  assert.equal(stored.payload.clientId, 'cid-A2')

  // (3) Mağaza B bağlanır — A AKTİF kalır.
  const b = await connection.connectIkasStore(
    db,
    { organizationId: org, storeName: 'magazab', clientId: 'cid-B', clientSecret: 'SECRET-B-xyz' },
    options(fake),
  )
  assert.equal(b.outcome, 'CONNECTED')
  const all = await db.select().from(schema.marketplaceAccounts)
  assert.equal(all.length, 2)
  assert.ok(all.every((row) => row.isActive), 'A ve B AYNI ANDA aktif')
  assert.equal(all.find((row) => row.providerAccountId === 'm-B').displayName, 'Mağaza B')

  // AUTH-3: kalıcı yük YALNIZ uzun ömürlü kimlik — access_token YOK.
  const tokens = [...fake.tokens.keys()]
  for (const accountId of [first.marketplaceAccountId, b.marketplaceAccountId]) {
    const credential = await connectorStore.getConnectorCredential(db, {
      organizationId: org, marketplaceAccountId: accountId, providerKey: 'ikas',
    })
    assert.deepEqual(Object.keys(credential.payload).sort(), ['clientId', 'clientSecret', 'storeName'])
    for (const token of tokens) assert.equal(JSON.stringify(credential.payload).includes(token), false)
  }
  const rawRows = JSON.stringify(await db.select().from(schema.connectorCredentials))
  for (const token of tokens) assert.equal(rawRows.includes(token), false, 'belirteç DB’de YOK')
  assert.equal(rawRows.includes('SECRET-B-xyz'), false, 'sır DÜZ METİN değil (şifreli)')

  // ACC-5: liste yanıtı sır/belirteç taşımaz.
  const listed = await handlers.handleIkasListStores({ db, organizationId: org })
  const text = JSON.stringify(listed.body)
  for (const secret of ['SECRET-A2-new', 'SECRET-B-xyz', 'cid-A2', ...tokens]) {
    assert.equal(text.includes(secret), false, `yanıt ${secret} taşımamalı`)
  }
  assert.equal(listed.body.stores.length, 2)
  assert.ok(listed.body.stores.every((store) => store.hasClientSecret))
})

test('IKAS-ACC-4 + ACC-6: A’nın kimliği B’yi SAĞLAMAZ; başarısız bağlantı HİÇBİR ŞEY yazmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const fake = fakeIkas({
    stores: {
      magazaa: { clientId: 'cid-A', clientSecret: 'SECRET-A-xyz', merchantId: 'm-A', storeName: 'magazaa', orders: [] },
      magazab: { clientId: 'cid-B', clientSecret: 'SECRET-B-xyz', merchantId: 'm-B', storeName: 'magazab', orders: [] },
    },
  })
  // A’nın kimliğiyle B mağazası → belirteç REDDİ.
  const crossed = await connection.connectIkasStore(
    db,
    { organizationId: org, storeName: 'magazab', clientId: 'cid-A', clientSecret: 'SECRET-A-xyz' },
    options(fake),
  )
  assert.equal(crossed.outcome, 'CONNECTION_FAILED')
  assert.equal(crossed.errorClass, 'AUTH_FAILED')
  // Sipariş okuma yetkisi YOK → bağlantı reddi (merchant okunsa bile).
  fake.state.orderErrors = [{ message: 'no scope', extensions: { code: 'FORBIDDEN' } }]
  const noScope = await connectA(db, org, fake)
  assert.equal(noScope.outcome, 'CONNECTION_FAILED')
  assert.equal(noScope.errorClass, 'PERMISSION_DENIED')
  assert.equal((await db.select().from(schema.marketplaceAccounts)).length, 0)
  assert.equal((await db.select().from(schema.connectorCredentials)).length, 0)
  // Geçersiz mağaza adı ağa ÇIKMADAN reddedilir.
  const before = fake.calls.length
  const evil = await connection.connectIkasStore(
    db,
    { organizationId: org, storeName: 'evil.com', clientId: 'x', clientSecret: 'y' },
    options(fake),
  )
  assert.equal(evil.outcome, 'STORE_NAME_REJECTED')
  assert.equal(fake.calls.length, before, 'ağ çağrısı YOK')

  // Başarılı A + B: her hesabın kimliği KENDİSİNİNDİR.
  fake.state.orderErrors = null
  const a = await connectA(db, org, fake)
  const b = await connection.connectIkasStore(
    db,
    { organizationId: org, storeName: 'magazab', clientId: 'cid-B', clientSecret: 'SECRET-B-xyz' },
    options(fake),
  )
  const loadedA = await connection.loadIkasCredentials(db, { organizationId: org, marketplaceAccountId: a.marketplaceAccountId })
  const loadedB = await connection.loadIkasCredentials(db, { organizationId: org, marketplaceAccountId: b.marketplaceAccountId })
  assert.equal(loadedA.credentials.clientId, 'cid-A')
  assert.equal(loadedB.credentials.clientId, 'cid-B')
  assert.equal(loadedB.credentials.tokenUrl, 'https://magazab.myikas.com/api/admin/oauth/token')
})

/* ═══ AYIRMA ═════════════════════════════════════════════════════════════ */

test('IKAS-DISC-1/2/3: A ayrılır B dokunulmaz; yabancı sağlayıcı/kiracı → 404 ve mutasyon YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const other = await makeOrg(db)
  const fake = fakeIkas({
    stores: {
      magazaa: { clientId: 'cid-A', clientSecret: 'SECRET-A-xyz', merchantId: 'm-A', storeName: 'magazaa', orders: [] },
      magazab: { clientId: 'cid-B', clientSecret: 'SECRET-B-xyz', merchantId: 'm-B', storeName: 'magazab', orders: [] },
    },
  })
  const a = await connectA(db, org, fake)
  const b = await connection.connectIkasStore(
    db,
    { organizationId: org, storeName: 'magazab', clientId: 'cid-B', clientSecret: 'SECRET-B-xyz' },
    options(fake),
  )
  const trendyol = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'S-1')
  const woo = await accounts.ensureAccount(db, org, 'woocommerce', 'shop.example')

  // (2) Aynı kiracının Trendyol/Woo hesap id’si → 404, hiçbir şey değişmez.
  for (const foreign of [trendyol.id, woo.id]) {
    const result = await handlers.handleIkasDisconnect({ db, organizationId: org, marketplaceAccountId: foreign })
    assert.equal(result.httpStatus, 404)
  }
  assert.equal((await accounts.getAccountById(db, org, trendyol.id)).isActive, true)
  // (3) Başka kiracı → 404, A’nın kimliği yerinde.
  const cross = await handlers.handleIkasDisconnect({ db, organizationId: other, marketplaceAccountId: a.marketplaceAccountId })
  assert.equal(cross.httpStatus, 404)
  assert.ok(await connectorStore.getConnectorCredential(db, { organizationId: org, marketplaceAccountId: a.marketplaceAccountId, providerKey: 'ikas' }))

  // (1) A ayrılır: kimlik silinir, hesap pasifleşir; B aynen.
  const done = await handlers.handleIkasDisconnect({ db, organizationId: org, marketplaceAccountId: a.marketplaceAccountId })
  assert.equal(done.httpStatus, 200)
  assert.equal(await connectorStore.getConnectorCredential(db, { organizationId: org, marketplaceAccountId: a.marketplaceAccountId, providerKey: 'ikas' }), null)
  assert.equal((await accounts.getAccountById(db, org, a.marketplaceAccountId)).isActive, false)
  assert.equal((await accounts.getAccountById(db, org, b.marketplaceAccountId)).isActive, true)
  assert.ok(await connectorStore.getConnectorCredential(db, { organizationId: org, marketplaceAccountId: b.marketplaceAccountId, providerKey: 'ikas' }))
})

/* ═══ SİPARİŞ NORMALLEŞTİRME ═════════════════════════════════════════════ */

test('IKAS-ORD-1..8: kimlik, referans, satır/varyant, ham statü, zaman, para, adres', () => {
  const raw = makeOrder(7, { status: 'SOME_FUTURE_STATUS', totalFinalPrice: 1234.56, orderedAt: 1758362400000 })
  const order = normalizer.normalizeIkasOrder(raw)
  assert.equal(order.providerOrderId, 'ord-7')
  assert.equal(order.orderNumber, '1007')
  assert.equal(order.lines[0].providerLineId, 'line-7-1')
  assert.equal(order.lines[0].variantId, 'var-7')
  assert.equal(order.lines[0].sku, 'SKU-7')
  assert.deepEqual(order.lines[0].barcodes, ['8690007'])
  assert.deepEqual(order.lines[0].options, [{ name: 'Renk', values: ['Kırmızı'] }])
  // (4) Bilinmeyen statü TAHMİN EDİLMEZ.
  assert.equal(order.rawStatus, 'SOME_FUTURE_STATUS')
  assert.equal(order.canonicalStatus, null)
  // (5) Mutlak an — ±3 saat YOK.
  assert.equal(order.orderedAt, new Date(1758362400000).toISOString())
  assert.equal(order.orderedAt, '2025-09-20T10:00:00.000Z')
  // (6) Bozuk zaman ASLA epoch değil.
  for (const bad of [0, -5, 'yarın', '2025-09-20T10:00:00', NaN, {}, 1.5]) {
    assert.equal(normalizer.ikasTimestampToIso(bad), null, `bozuk: ${String(bad)}`)
  }
  const malformed = normalizer.normalizeIkasOrder(makeOrder(8, { orderedAt: 'bozuk' }))
  assert.equal(malformed.orderedAt, null)
  assert.equal(malformed.orderedAtMalformed, true)
  assert.equal(JSON.stringify(malformed).includes('1970'), false)
  // (7) Para: ikili aritmetik YOK; görünür yuvarlama hatası üretilmez.
  assert.equal(order.totalFinalPrice, '1234.56')
  assert.equal(normalizer.ikasDecimalString(99.95), '99.95')
  // Naif ikili aritmetik GÖRÜNÜR biçimde bozar (kanıt): 1.005 × 100 = 100.49999999999999.
  assert.notEqual(String(1.005 * 100), '100.5', 'naif çarpma bozar')
  assert.equal(normalizer.ikasDecimalString(1.005), '1.005', 'sınır çarpma YAPMAZ')
  assert.equal(normalizer.ikasDecimalString(0.3), '0.3')
  assert.equal(normalizer.ikasDecimalString(1e21), '1000000000000000000000')
  assert.equal(normalizer.ikasDecimalString('abc'), null)
  assert.equal(order.lines[0].finalPrice, '99.98')
  assert.equal(order.currencyCode, 'TRY')
  // (8) İlçe/telefon yalnız belgelenmiş alanlardan.
  assert.equal(order.shipping.city, 'İstanbul')
  assert.equal(order.shipping.district, 'Kadıköy')
  assert.equal(order.shipping.phone, '+905550000000')
  const noDistrict = normalizer.normalizeIkasOrder({
    ...makeOrder(9),
    shippingAddress: { ...makeOrder(9).shippingAddress, district: null, addressLine1: 'Moda Kadıköy', phone: null },
    customer: { phone: null },
  })
  assert.equal(noDistrict.shipping.district, null, 'serbest metinden ilçe ÇIKARILMAZ')
  assert.equal(noDistrict.shipping.phone, null, 'telefon başka alandan ÜRETİLMEZ')
})

test('IKAS-PACKAGE: paket yoksa CargoFlow paket kimliği UYDURULMAZ; paketler AYNEN taşınır', () => {
  const none = normalizer.normalizeIkasOrder(makeOrder(1, { orderPackages: null }))
  assert.equal(none.packageIdentity, 'NO_PROVIDER_PACKAGE')
  assert.deepEqual(none.packages, [])
  assert.equal(JSON.stringify(none).includes('"packageId"'), false, 'order.id paket kimliği DEĞİL')
  const multi = normalizer.normalizeIkasOrder(makeOrder(2, {
    orderPackages: [
      { id: 'pkg-1', orderPackageNumber: '1002-1', orderLineItemIds: ['line-2-1'], orderPackageFulfillStatus: 'FULFILLED', trackingInfo: { trackingNumber: 'T1', cargoCompany: 'X' } },
      { id: 'pkg-2', orderPackageNumber: '1002-2', orderLineItemIds: [], orderPackageFulfillStatus: 'UNFULFILLED', trackingInfo: null },
    ],
  }))
  assert.equal(multi.packageIdentity, 'PROVIDER_PACKAGES')
  assert.deepEqual(multi.packages.map((p) => p.providerPackageId), ['pkg-1', 'pkg-2'])
  assert.equal(multi.packages[0].trackingNumber, 'T1')
})

/* ═══ SAYFALAMA ══════════════════════════════════════════════════════════ */

const credsA = { storeName: 'magazaa', tokenUrl: 'https://magazaa.myikas.com/api/admin/oauth/token', clientId: 'cid-A', clientSecret: 'SECRET-A-xyz' }

function storeWith(orders) {
  return fakeIkas({ stores: { magazaa: { clientId: 'cid-A', clientSecret: 'SECRET-A-xyz', merchantId: 'm-A', storeName: 'magazaa', orders } } })
}
const listCalls = (fake) =>
  fake.calls.filter((c) => c.url.endsWith('/graphql') && c.body.includes('listOrder')).map((c) => JSON.parse(c.body).variables)

test('IKAS-PAGE-1/2/3: limit ≤200; çok sayfa tümünü alır; tekrar satır tekilleşir', async () => {
  const orders = Array.from({ length: 450 }, (_, i) => makeOrder(i + 1))
  const fake = storeWith(orders)
  fake.state.duplicateOnPage = 2
  const result = await sync.fetchAllIkasOrders(credsA, { fromMs: null, upperBoundMs: BASE_MS + 10_000_000 }, options(fake, { pageLimit: 500 }))
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.pagesFetched, 3)
  const ids = result.rawOrders.map((o) => o.id)
  assert.equal(ids.length, 450)
  assert.equal(new Set(ids).size, 450, 'tekrar eden satır TEK')
  for (const variables of listCalls(fake)) {
    assert.ok(variables.pagination.limit <= 200 && variables.pagination.limit >= 1)
  }
})

test('IKAS-PAGE-4: ilerlemeyen/tekrarlanan sayfa SINIRLI biçimde başarısız', async () => {
  const fake = storeWith(Array.from({ length: 5 }, (_, i) => makeOrder(i + 1)))
  fake.state.stuckHasNext = true
  const stuck = await sync.fetchAllIkasOrders(credsA, { fromMs: null, upperBoundMs: BASE_MS + 1e7 }, options(fake))
  assert.equal(stuck.outcome, 'PARTIAL')
  assert.equal(stuck.errorClass, 'PARTIAL_PAGINATION')
  assert.ok(listCalls(fake).length <= 2, 'sonsuz döngü YOK')

  const broken = storeWith(Array.from({ length: 300 }, (_, i) => makeOrder(i + 1)))
  broken.state.brokenPageNumber = true
  const wrongPage = await sync.fetchAllIkasOrders(credsA, { fromMs: null, upperBoundMs: BASE_MS + 1e7 }, options(broken))
  assert.equal(wrongPage.errorClass, 'PARTIAL_PAGINATION')

  const bounded = storeWith(Array.from({ length: 30 }, (_, i) => makeOrder(i + 1)))
  const capped = await sync.fetchAllIkasOrders(credsA, { fromMs: null, upperBoundMs: BASE_MS + 1e7 }, options(bounded, { pageLimit: 5, maxPages: 3 }))
  assert.equal(capped.outcome, 'PARTIAL')
  assert.equal(listCalls(bounded).length, 3)
})

/* ═══ MUTABAKAT + SAĞLIK + CANLI YAZMA KAPISI ════════════════════════════ */

test('IKAS-PAGE-5 + REC-1/2/3: sabit üst sınır; tam başarıda imleç ilerler; kısmi koşu ilerletmez; örtüşme tekil', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const orders = Array.from({ length: 250 }, (_, i) => makeOrder(i + 1))
  const fake = storeWith(orders)
  const a = await connectA(db, org, fake)
  const loaded = await connection.loadIkasCredentials(db, { organizationId: org, marketplaceAccountId: a.marketplaceAccountId })
  const upper1 = BASE_MS + 300_000 // 250 siparişin TAMAMI → 2 sayfa
  const persistCanonical = async () => assert.fail('internal_test kanonik yazım YAPAMAZ')
  const run1 = await sync.syncIkasOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: a.marketplaceAccountId, merchantId: 'm-A',
    credentials: loaded.credentials, window: { fromMs: BASE_MS, upperBoundMs: upper1 }, persistCanonical,
  }, options(fake))
  assert.equal(run1.outcome, 'SUCCESS')
  assert.equal(run1.checkpointAdvanced, true)
  // REC-1: TÜM sayfalar AYNI sabit üst sınırla sorulur.
  const bounds = listCalls(fake).filter((v) => v.pagination.limit === 200).map((v) => v.updatedAt.lte)
  assert.ok(bounds.length >= 2)
  assert.ok(bounds.every((value) => value === upper1))
  // REC-2: imleç = üst sınır.
  let state = await syncRepo.getSyncState(db, org, 'orders', a.marketplaceAccountId)
  assert.equal(new Date(state.lastSuccessfulSyncAt).getTime(), upper1)
  assert.equal(state.lastSyncStatus, 'success')

  // PAGE-5: ikinci koşuda 2. sayfa çöker → PARTIAL, imleç ESKİ yerinde.
  orders.push(...Array.from({ length: 250 }, (_, i) => makeOrder(1000 + i, { __updatedAtMs: upper1 + 1000 + i })))
  fake.state.failOrderPage = 2
  const run2 = await sync.syncIkasOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: a.marketplaceAccountId, merchantId: 'm-A',
    credentials: loaded.credentials, window: { fromMs: upper1, upperBoundMs: upper1 + 900_000 },
  }, options(fake))
  assert.equal(run2.outcome, 'PARTIAL')
  assert.equal(run2.checkpointAdvanced, false)
  state = await syncRepo.getSyncState(db, org, 'orders', a.marketplaceAccountId)
  assert.equal(new Date(state.lastSuccessfulSyncAt).getTime(), upper1, 'imleç İLERLEMEDİ')
  assert.equal(state.lastSyncStatus, 'partial')

  // REC-3: sınırdaki sipariş (updatedAt == upper1) yeni koşuda tekrar gelir → TEK.
  fake.state.failOrderPage = null
  orders.push(makeOrder(5000, { id: 'boundary', __updatedAtMs: upper1 }))
  const run3 = await sync.syncIkasOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: a.marketplaceAccountId, merchantId: 'm-A',
    credentials: loaded.credentials, window: { fromMs: upper1, upperBoundMs: upper1 + 900_000 },
  }, options(fake))
  assert.equal(run3.outcome, 'SUCCESS')
  const ids = run3.normalization.orders.map((o) => o.providerOrderId)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.filter((id) => id === 'boundary').length, 1)
})

test('IKAS-ROLLOUT-1/2/3: internal_test canlı değildir; okuma kanonik/karşılama yan etkisi ÜRETMEZ', async (t) => {
  assert.equal(catalog.resolveRolloutStage('ikas'), 'internal_test')
  assert.equal(kernel.stageAffectsLiveBehavior(catalog.resolveRolloutStage('ikas')), false)
  assert.equal(gate.canPersistCanonicalOrders('ikas').decision, 'BLOCKED_BY_ROLLOUT')
  assert.equal(gate.canTriggerFulfillmentSideEffects('ikas').decision, 'BLOCKED_BY_ROLLOUT')

  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const fake = storeWith(Array.from({ length: 3 }, (_, i) => makeOrder(i + 1)))
  const a = await connectA(db, org, fake)
  const loaded = await connection.loadIkasCredentials(db, { organizationId: org, marketplaceAccountId: a.marketplaceAccountId })
  let persisted = 0
  const result = await sync.syncIkasOrdersForAccount(db, {
    organizationId: org, marketplaceAccountId: a.marketplaceAccountId, merchantId: 'm-A',
    credentials: loaded.credentials, window: { fromMs: null, upperBoundMs: BASE_MS + 1e7 },
    persistCanonical: async () => { persisted += 1 },
  }, options(fake))
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(persisted, 0, 'kanonik yazıcı ÇAĞRILMADI')
  assert.equal(result.canonicalPersisted, false)
  assert.equal(result.liveWriteReason, 'ROLLOUT_STAGE_NOT_LIVE')
  for (const table of [schema.orders, schema.shipments, schema.shipmentOperations, schema.labelJobs]) {
    assert.equal((await db.select().from(table)).length, 0, 'canlı iş tablosu BOŞ')
  }
  // Kapı SAĞLAYICI ADINA değil AŞAMAYA bakar (kaynak).
  const syncSource = readFileSync(join(here, 'connectors/ikas/ikasOrderSync.ts'), 'utf8')
  assert.match(syncSource, /canPersistCanonicalOrders\(IKAS_PROVIDER_KEY\)/)
  assert.doesNotMatch(syncSource, /=== 'ikas'/)
})

test('IKAS-ROLLOUT-4/5: tanıtım ikas’ı DUYURMAZ; normal kurulum ikas’ı SUNMAZ', () => {
  for (const file of ['src/landing/landingContent.ts', 'src/landing/LandingPage.tsx', 'index.html']) {
    assert.equal(/ikas/i.test(readFileSync(join(root, file), 'utf8').replace(/\/\/.*$/gm, '')), false, file)
  }
  const providers = onboardingModel.resolveOnboardingProviders(catalog.buildProviderCatalog(), catalog.resolveRolloutStage)
  const ikas = providers.find((provider) => provider.providerKey === 'ikas')
  assert.equal(ikas.rolloutStage, 'internal_test')
  assert.equal(ikas.eligibleForOnboarding, false)
})

test('IKAS-HEALTH-1/2/3: gerçek hesap UUID ile NEVER_RUN; A/B varlığı bağımsız; okuma yalnız kendi sağlığını günceller', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const fake = fakeIkas({
    stores: {
      magazaa: { clientId: 'cid-A', clientSecret: 'SECRET-A-xyz', merchantId: 'm-A', storeName: 'magazaa', orders: [makeOrder(1)] },
      magazab: { clientId: 'cid-B', clientSecret: 'SECRET-B-xyz', merchantId: 'm-B', storeName: 'magazab', orders: [] },
    },
  })
  const a = await connectA(db, org, fake)
  const b = await connection.connectIkasStore(
    db, { organizationId: org, storeName: 'magazab', clientId: 'cid-B', clientSecret: 'SECRET-B-xyz' }, options(fake),
  )
  const ikasHealth = async () =>
    Object.fromEntries(
      (await healthService.loadIntegrationHealthForOrganization(db, { organizationId: org, nowMs: BASE_MS + 1e7 }))
        .filter((entry) => entry.providerKey === 'ikas')
        .map((entry) => [entry.marketplaceAccountId, entry]),
    )
  // (1) Gerçek hesap UUID'leri, NEVER_RUN, CONNECTED.
  let health = await ikasHealth()
  assert.equal(health[a.marketplaceAccountId].connectionScope, 'account')
  assert.equal(health[a.marketplaceAccountId].sync, 'NEVER_RUN')
  assert.equal(health[a.marketplaceAccountId].connection, 'CONNECTED')
  assert.equal(health[a.marketplaceAccountId].credentials, 'UNKNOWN', 'varlık GEÇERLİLİK değildir')
  // (2) B'nin kimliği kaldırıldı → B NOT_CONFIGURED; A etkilenmez.
  await connectorStore.deleteConnectorCredential(db, { organizationId: org, marketplaceAccountId: b.marketplaceAccountId, providerKey: 'ikas' })
  health = await ikasHealth()
  assert.equal(health[b.marketplaceAccountId].connection, 'NOT_CONFIGURED')
  assert.equal(health[a.marketplaceAccountId].connection, 'CONNECTED')
  // (3) A için okuma testi → yalnız A sağlığı güncellenir.
  const read = await handlers.handleIkasOrdersReadTest({
    db, organizationId: org, marketplaceAccountId: a.marketplaceAccountId, options: options(fake), nowMs: BASE_MS + 5 * HOUR,
  })
  assert.equal(read.httpStatus, 200)
  assert.equal(read.body.ok, true)
  assert.equal(read.body.canonicalPersisted, false)
  assert.equal(JSON.stringify(read.body).includes('Örnek'), false, 'yanıt kişisel veri taşımaz')
  health = await ikasHealth()
  assert.equal(health[a.marketplaceAccountId].sync, 'HEALTHY')
  assert.equal(health[a.marketplaceAccountId].credentials, 'VALID')
  assert.equal(health[b.marketplaceAccountId].sync, 'NEVER_RUN')
})

test('IKAS-TENANT-1/2: A kiracısının mağazası B’de görünmez; B, A’nın kimliğini okuyamaz/test edemez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const fake = storeWith([makeOrder(1)])
  const a = await connectA(db, orgA, fake)
  const listedB = await handlers.handleIkasListStores({ db, organizationId: orgB })
  assert.deepEqual(listedB.body.stores, [])
  assert.equal(await connection.loadIkasCredentials(db, { organizationId: orgB, marketplaceAccountId: a.marketplaceAccountId }), null)
  const before = fake.calls.length
  const test = await handlers.handleIkasOrdersReadTest({ db, organizationId: orgB, marketplaceAccountId: a.marketplaceAccountId, options: options(fake) })
  assert.equal(test.httpStatus, 404)
  assert.equal(fake.calls.length, before, 'B adına ikas’a ÇIKILMADI')
})

/* ═══ WEBHOOK ════════════════════════════════════════════════════════════ */

test('IKAS-WH-1/2: ikas webhook ucu YOK; imzasız olay hiçbir yerde ikas gerçeği olarak kabul EDİLMEZ', async (t) => {
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.equal(/webhooks\/ikas/i.test(index), false)
  const ikasRoutes = [...index.matchAll(/app\.(get|post|put|patch|delete)\('([^']*ikas[^']*)'/gi)].map((m) => m[2])
  assert.ok(ikasRoutes.length >= 4)
  for (const route of ikasRoutes) assert.doesNotMatch(route, /webhook/i)
  assert.equal(pack.CAPABILITIES['orders.webhook'].supported, false)
  assert.equal(pack.CAPABILITIES['orders.webhook'].contractVerified, false)
  const descriptor = catalog.buildProviderCatalog().get('ikas')
  assert.equal(kernel.supportsCapability(descriptor, 'orders.webhook'), false)
  const dir = join(here, 'connectors', 'ikas')
  for (const file of readdirSync(dir)) {
    assert.doesNotMatch(file, /webhook/i)
    const source = readFileSync(join(dir, file), 'utf8')
    assert.doesNotMatch(source, /webhookInbox|wooWebhookSignature|connector_webhook_inbox|connectorWebhookInbox/)
  }
  // Tüm ikas akışlarından sonra webhook gelen kutusu BOŞ.
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const fake = storeWith([makeOrder(1)])
  const a = await connectA(db, org, fake)
  await handlers.handleIkasOrdersReadTest({ db, organizationId: org, marketplaceAccountId: a.marketplaceAccountId, options: options(fake) })
  assert.equal((await db.select().from(schema.connectorWebhookInbox)).length, 0)
})

test('IKAS-MOUNT: ikas uçları kiracı kimlik kapısının ARKASINDA', () => {
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = index.indexOf('const TENANT_AUTH_PATHS = [')
  const block = index.slice(start, index.indexOf(']', start))
  const paths = [...block.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1])
  const covered = (url) => paths.some((p) => url === p || url.startsWith(`${p}/`))
  for (const url of [
    '/api/integrations/ikas/stores',
    '/api/integrations/ikas/stores/disconnect',
    '/api/integrations/ikas/stores/orders-read-test',
  ]) {
    assert.equal(covered(url), true, `kapsanmalı: ${url}`)
  }
  assert.equal(existsSync(join(here, 'connectors', 'ikas', 'ikasHttpHandlers.ts')), true)
})
