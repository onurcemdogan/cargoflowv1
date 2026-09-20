// WOOCOMMERCE-001 — KABUL PAKETİ.
//
// ═══ HERMETİK ════════════════════════════════════════════════════════════
//
// GERÇEK bir WooCommerce mağazasına İSTEK ATILMAZ. Taşıma katmanı enjekte
// edilir, ad çözümleyici enjekte edilir, veritabanı GERÇEK Postgres'tir
// (PGlite + GERÇEK drizzle migration'ları).
//
// Bu yüzden bu paket "CANLI DOĞRULANDI" DEMEZ; sözleşmeye ve politikaya
// uygunluğu kanıtlar.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHmac } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const storeUrlPolicy = await import('./connectors/storeUrlPolicy.ts')
const credentialStore = await import('./connectors/connectorCredentialStore.ts')
const inbox = await import('./connectors/webhookInbox.ts')
const liveGate = await import('./connectors/liveWriteGate.ts')
const catalog = await import('./connectors/providerCatalog.ts')
const healthRepo = await import('./connectors/integrationHealthRepository.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const wooClient = await import('./connectors/woocommerce/wooClient.ts')
const wooNormalizer = await import('./connectors/woocommerce/wooOrderNormalizer.ts')
const wooSignature = await import('./connectors/woocommerce/wooWebhookSignature.ts')
const wooConnection = await import('./connectors/woocommerce/wooConnectionService.ts')
const wooIngest = await import('./connectors/woocommerce/wooWebhookIngest.ts')
const wooSync = await import('./connectors/woocommerce/wooOrderSync.ts')

const CONTRACT = JSON.parse(
  readFileSync(join(here, '..', 'providers', 'woocommerce', 'contracts', 'wc-v3.json'), 'utf8'),
)

/**
 * Kaynak taramadan ÖNCE yorumları siler.
 *
 * SATIR yorumları ÖNCE silinir: bir satır yorumundaki `/*` dizisi
 * blok-yorum silicisini yanlış yerden başlatıp import bloğunu YUTAR.
 * (Bu tuzağa daha önce düşüldü; tarama sessizce körleşiyordu.)
 */
function stripComments(source) {
  return source
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

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
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}

async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

/** Herkese açık adrese çözen sahte DNS. */
const publicResolver = async () => [{ address: '93.184.216.34' }]
/** Özel adrese çözen sahte DNS (rebinding senaryosu). */
const privateResolver = async () => [{ address: '10.0.0.5' }]

/** Kontrollü taşıma: verilen yanıt sırasını döndürür, istekleri kaydeder. */
function makeTransport(responses) {
  const requests = []
  const queue = [...responses]
  const transport = async (request) => {
    requests.push(request)
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next instanceof Error) throw next
    return next
  }
  return { transport, requests }
}

const okResponse = (body, headers = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  bodyText: JSON.stringify(body),
})

const wooOrderFixture = (overrides = {}) => ({
  id: 4711,
  number: 'WC-1001',
  status: 'processing',
  date_created: '2026-09-18T13:20:30',
  date_created_gmt: '2026-09-18T10:20:30',
  date_modified_gmt: '2026-09-19T08:00:00',
  currency: 'TRY',
  total: '119.99',
  billing: {
    first_name: 'Ayşe',
    last_name: 'Yılmaz',
    email: 'a@example.com',
    phone: '+905551112233',
  },
  shipping: {
    first_name: 'Ayşe',
    last_name: 'Yılmaz',
    address_1: 'Örnek Sok. 1',
    city: 'İstanbul',
    state: 'TR-34',
    postcode: '34000',
    country: 'TR',
  },
  line_items: [
    {
      id: 88,
      name: 'Ürün A',
      product_id: 501,
      variation_id: 0,
      quantity: 2,
      sku: 'SKU-A',
      price: '59.995',
      total: '119.99',
    },
  ],
  ...overrides,
})

const clientOptions = (transport) => ({
  transport,
  resolver: publicResolver,
  retryDelaysMs: [],
  sleep: async () => {},
})

/* ═══ SÖZLEŞME GERÇEĞİ ════════════════════════════════════════════════ */

test('WOO-CONTRACT: uygulama KABUL EDİLEN sözleşme paketine dayanır', () => {
  assert.equal(CONTRACT.API_VERSION.namespace, 'wc/v3')
  assert.equal(CONTRACT.AUTH_MODEL.https.scheme, 'http-basic')
  assert.equal(CONTRACT.AUTH_MODEL.http.cargoflowSupport, false)
  assert.equal(CONTRACT.WEBHOOK_SIGNATURE.algorithm, 'HMAC-SHA256')
  assert.equal(CONTRACT.WEBHOOK_SIGNATURE.encoding, 'base64')
  // Mutabakat sınırı SÖZLEŞMEDEN gelir, varsayımdan değil.
  assert.equal(CONTRACT.ORDER_LIST.checkpointFilter.modifiedAfterVerified, false)
  assert.equal(wooSync.WOO_RECONCILIATION_LIMITATION.modifiedAfterVerified, false)
  assert.equal(
    wooSync.WOO_RECONCILIATION_LIMITATION.completeness,
    'PARTIAL_BY_VERIFIED_CONTRACT',
  )
  // Ham statü kümesi sözleşmeyle BİREBİR.
  assert.deepEqual(
    [...wooNormalizer.WOO_ORDER_STATUSES],
    CONTRACT.ORDER_STATUSES.values,
  )
  // Takip yazımı sözleşmede DESTEKLENMİYOR.
  assert.equal(CONTRACT.CAPABILITIES['shipments.tracking.write'].supported, false)
})

/* ═══ SSRF ════════════════════════════════════════════════════════════ */

test('WOO-SSRF-1: http:// mağaza REDDEDİLİR', async () => {
  const result = await storeUrlPolicy.assertStoreUrlAllowed('http://shop.example.com', {
    resolver: publicResolver,
  })
  assert.equal(result.ok, false)
  assert.equal(result.rejection, 'NOT_HTTPS')
})

test('WOO-SSRF-2: localhost REDDEDİLİR', async () => {
  for (const url of ['https://localhost', 'https://localhost:8443', 'https://x.local']) {
    const result = await storeUrlPolicy.assertStoreUrlAllowed(url, {
      resolver: publicResolver,
    })
    assert.equal(result.ok, false, url)
    assert.equal(result.rejection, 'PRIVATE_HOST', url)
  }
})

test('WOO-SSRF-3: 127.0.0.1 REDDEDİLİR', async () => {
  for (const url of ['https://127.0.0.1', 'https://127.1.2.3', 'https://[::1]']) {
    const result = await storeUrlPolicy.assertStoreUrlAllowed(url, {
      resolver: publicResolver,
    })
    assert.equal(result.ok, false, url)
    assert.equal(result.rejection, 'PRIVATE_HOST', url)
  }
})

test('WOO-SSRF-4: RFC1918 ve diğer özel bloklar REDDEDİLİR', async () => {
  const privateHosts = [
    'https://10.0.0.1',
    'https://172.16.5.5',
    'https://172.31.255.255',
    'https://192.168.1.1',
    'https://169.254.169.254', // bulut metadata
    'https://100.64.0.1', // CGNAT
    'https://0.0.0.0',
    'https://224.0.0.1', // multicast
  ]
  for (const url of privateHosts) {
    const result = await storeUrlPolicy.assertStoreUrlAllowed(url, {
      resolver: publicResolver,
    })
    assert.equal(result.ok, false, url)
    assert.equal(result.rejection, 'PRIVATE_HOST', url)
  }
  // IPv6 ULA / link-local / IPv4-eşlemli kaçış.
  assert.equal(storeUrlPolicy.isPrivateAddress('fd00::1'), true)
  assert.equal(storeUrlPolicy.isPrivateAddress('fe80::1'), true)
  assert.equal(storeUrlPolicy.isPrivateAddress('::ffff:127.0.0.1'), true)
})

test('WOO-SSRF-5: HERKESE AÇIK GÖRÜNEN ama ÖZELE ÇÖZÜLEN ad REDDEDİLİR', async () => {
  // Kritik: hostname metni masumdur; karar ÇÖZÜLEN ADRESE göre verilir.
  const result = await storeUrlPolicy.assertStoreUrlAllowed('https://shop.example.com', {
    resolver: privateResolver,
  })
  assert.equal(result.ok, false)
  assert.equal(result.rejection, 'PRIVATE_RESOLVED_ADDRESS')

  // Kayıtlardan HERHANGİ biri özelse yeter.
  const mixed = await storeUrlPolicy.assertStoreUrlAllowed('https://shop.example.com', {
    resolver: async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }],
  })
  assert.equal(mixed.ok, false)
  assert.equal(mixed.rejection, 'PRIVATE_RESOLVED_ADDRESS')
})

test('WOO-SSRF-6: herkese açıktan ÖZELE yönlendirme REDDEDİLİR', async () => {
  const redirect = await wooClient.validateRedirectTarget('https://internal.example.com', {
    resolver: privateResolver,
  })
  assert.equal(redirect.allowed, false)
  assert.equal(redirect.rejection, 'PRIVATE_RESOLVED_ADDRESS')

  const toLoopback = await wooClient.validateRedirectTarget('https://127.0.0.1/wp-json', {
    resolver: publicResolver,
  })
  assert.equal(toLoopback.allowed, false)

  // ÜRETİM TAŞIMASI yönlendirmeyi HİÇ İZLEMEZ.
  const source = readFileSync(join(here, 'connectors', 'woocommerce', 'wooClient.ts'), 'utf8')
  assert.match(source, /redirect:\s*'manual'/)
})

test('WOO-SSRF-7: geçerli herkese açık HTTPS mağaza KABUL EDİLİR', async () => {
  const result = await storeUrlPolicy.assertStoreUrlAllowed(
    'https://shop.example.com/store',
    { resolver: publicResolver },
  )
  assert.equal(result.ok, true)
  assert.equal(result.host, 'shop.example.com')
  // ANLAMLI ALT YOL KORUNUR.
  assert.equal(result.normalizedUrl, 'https://shop.example.com/store')
})

test('WOO-SSRF-EXTRA: gömülü kimlik, sorgu ve parça REDDEDİLİR', () => {
  assert.equal(
    storeUrlPolicy.inspectStoreUrlSyntax('https://user:pass@shop.example.com').rejection,
    'EMBEDDED_CREDENTIALS',
  )
  assert.equal(
    storeUrlPolicy.inspectStoreUrlSyntax('https://shop.example.com?a=1').rejection,
    'QUERY_NOT_ALLOWED',
  )
  assert.equal(
    storeUrlPolicy.inspectStoreUrlSyntax('https://shop.example.com#x').rejection,
    'FRAGMENT_NOT_ALLOWED',
  )
})

/* ═══ MAĞAZA KİMLİĞİ ══════════════════════════════════════════════════ */

test('WOO-IDENTITY: aynı mağazanın farklı yazımları AYNI kimliğe çözülür', () => {
  const canonical = wooConnection.wooProviderAccountId('https://shop.example.com')
  for (const variant of [
    'https://shop.example.com/',
    'https://www.shop.example.com',
    'HTTPS://Shop.Example.COM/',
    'https://shop.example.com:443',
  ]) {
    assert.equal(
      wooConnection.wooProviderAccountId(variant),
      canonical,
      `${variant} AYNI mağaza olmalı`,
    )
  }
  // ANLAMLI ALT YOL AYRI mağazadır.
  assert.notEqual(
    wooConnection.wooProviderAccountId('https://example.com'),
    wooConnection.wooProviderAccountId('https://example.com/store'),
  )
})

/* ═══ HESAP / KİMLİK ══════════════════════════════════════════════════ */

test('WOO-ACC-1: AYNI normalize mağaza İKİ KEZ bağlanamaz (idempotent)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-acc-1')
  const { transport } = makeTransport([okResponse([wooOrderFixture()])])

  const first = await wooConnection.connectWooStore(
    db,
    {
      organizationId: org,
      storeUrl: 'https://shop.example.com',
      consumerKey: 'ck_1',
      consumerSecret: 'cs_1',
    },
    clientOptions(transport),
  )
  assert.equal(first.outcome, 'CONNECTED')

  const second = await wooConnection.connectWooStore(
    db,
    {
      // Farklı YAZIM, aynı mağaza.
      organizationId: org,
      storeUrl: 'HTTPS://WWW.Shop.Example.com/',
      consumerKey: 'ck_2',
      consumerSecret: 'cs_2',
    },
    clientOptions(transport),
  )
  assert.equal(second.outcome, 'CONNECTED')
  // YENİ HESAP AÇILMAZ.
  assert.equal(second.account.id, first.account.id)
  const rows = await accounts.listAccounts(db, org, 'woocommerce')
  assert.equal(rows.length, 1)
})

test('WOO-ACC-2 / WOO-MS-1: aynı org İKİ Woo mağazası AKTİF kalır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-acc-2')
  const { transport } = makeTransport([okResponse([])])

  const a = await wooConnection.connectWooStore(
    db,
    { organizationId: org, storeUrl: 'https://a.example.com', consumerKey: 'ck_a', consumerSecret: 'cs_a' },
    clientOptions(transport),
  )
  const b = await wooConnection.connectWooStore(
    db,
    { organizationId: org, storeUrl: 'https://b.example.com', consumerKey: 'ck_b', consumerSecret: 'cs_b' },
    clientOptions(transport),
  )
  assert.equal(a.outcome, 'CONNECTED')
  assert.equal(b.outcome, 'CONNECTED')

  const rows = await accounts.listAccounts(db, org, 'woocommerce')
  assert.equal(rows.length, 2)
  // İKİSİ DE AKTİF — eski DB kısıtı bunu ENGELLİYORDU.
  assert.equal(rows.filter((r) => r.isActive).length, 2)
})

test('WOO-MS-2 / WOO-ACC-7: Trendyol TEK AKTİF davranışı DEĞİŞMEDİ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-ms-2')

  const first = await accounts.resolveOrCreateActiveAccount(db, org, 'trendyol', '111')
  const second = await accounts.resolveOrCreateActiveAccount(db, org, 'trendyol', '222')
  const rows = await accounts.listAccounts(db, org, 'trendyol')
  assert.equal(rows.length, 2)
  // ESKİ hesap PASİF olur; YENİ hesap aktif.
  const active = rows.filter((r) => r.isActive)
  assert.equal(active.length, 1)
  assert.equal(active[0].id, second.id)
  assert.equal(rows.find((r) => r.id === first.id).isActive, false)
})

test('WOO-ACC-3: aynı mağaza URL i FARKLI org larda İZOLEDİR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'woo-acc-3a')
  const orgB = await makeOrg(db, 'woo-acc-3b')
  const { transport } = makeTransport([okResponse([])])

  const a = await wooConnection.connectWooStore(
    db,
    { organizationId: orgA, storeUrl: 'https://same.example.com', consumerKey: 'ck_a', consumerSecret: 'cs_a' },
    clientOptions(transport),
  )
  const b = await wooConnection.connectWooStore(
    db,
    { organizationId: orgB, storeUrl: 'https://same.example.com', consumerKey: 'ck_b', consumerSecret: 'cs_b' },
    clientOptions(transport),
  )
  assert.notEqual(a.account.id, b.account.id)

  // A'nın kiracısı B'nin kimliğini OKUYAMAZ.
  const cross = await credentialStore.getConnectorCredential(db, {
    organizationId: orgA,
    marketplaceAccountId: b.account.id,
    providerKey: 'woocommerce',
  })
  assert.equal(cross, null)

  const own = await credentialStore.getConnectorCredential(db, {
    organizationId: orgA,
    marketplaceAccountId: a.account.id,
    providerKey: 'woocommerce',
  })
  assert.equal(own.payload.consumerKey, 'ck_a')
})

test('WOO-ACC-4: A mağazasının sırrı B mağazasını DOĞRULAYAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-acc-4')
  const { transport } = makeTransport([okResponse([])])

  const a = await wooConnection.connectWooStore(
    db,
    {
      organizationId: org,
      storeUrl: 'https://a.example.com',
      consumerKey: 'ck_a',
      consumerSecret: 'cs_a',
      webhookSecret: 'whs_a',
    },
    clientOptions(transport),
  )
  const b = await wooConnection.connectWooStore(
    db,
    {
      organizationId: org,
      storeUrl: 'https://b.example.com',
      consumerKey: 'ck_b',
      consumerSecret: 'cs_b',
      webhookSecret: 'whs_b',
    },
    clientOptions(transport),
  )

  const credA = await credentialStore.getConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: a.account.id,
    providerKey: 'woocommerce',
  })
  const credB = await credentialStore.getConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: b.account.id,
    providerKey: 'woocommerce',
  })
  assert.notEqual(credA.payload.consumerSecret, credB.payload.consumerSecret)
  assert.notEqual(credA.payload.webhookSecret, credB.payload.webhookSecret)

  // A'nın webhook sırrıyla B'ye imzalanmış teslim DOĞRULANMAZ.
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')
  const signedWithA = createHmac('sha256', 'whs_a').update(body).digest('base64')
  const verified = wooSignature.verifyWooWebhookSignature({
    rawBody: body,
    signatureHeader: signedWithA,
    secret: credB.payload.webhookSecret,
  })
  assert.equal(verified.verified, false)
  assert.equal(verified.rejection, 'SIGNATURE_MISMATCH')
})

test('WOO-ACC-5: API sırrı GERİ DÖNDÜRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-acc-5')
  const { transport } = makeTransport([okResponse([])])
  await wooConnection.connectWooStore(
    db,
    {
      organizationId: org,
      storeUrl: 'https://a.example.com',
      consumerKey: 'ck_supersecret',
      consumerSecret: 'cs_supersecret',
      webhookSecret: 'whs_supersecret',
    },
    clientOptions(transport),
  )
  const view = await wooConnection.listWooStores(db, org)
  const serialized = JSON.stringify(view)
  for (const secret of ['cs_supersecret', 'whs_supersecret']) {
    assert.equal(serialized.includes(secret), false, `SIR SIZDI: ${secret}`)
  }
  // Tam consumer_key de dönmez; yalnız maskeli kuyruk.
  assert.equal(serialized.includes('ck_supersecret'), false)
  assert.equal(view[0].hasConsumerSecret, true)
  assert.equal(view[0].hasWebhookSecret, true)
  assert.match(view[0].consumerKeyMasked, /^••••/)
})

test('WOO-ACC-6: sır settings_json a YAZILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-acc-6')
  const { transport } = makeTransport([okResponse([])])
  await wooConnection.connectWooStore(
    db,
    {
      organizationId: org,
      storeUrl: 'https://a.example.com',
      consumerKey: 'ck_x',
      consumerSecret: 'cs_leaktest',
      webhookSecret: 'whs_leaktest',
    },
    clientOptions(transport),
  )
  const settings = await pglite.query('select * from organization_settings')
  const accountRows = await pglite.query('select * from marketplace_accounts')
  const dump = JSON.stringify(settings.rows) + JSON.stringify(accountRows.rows)
  for (const secret of ['cs_leaktest', 'whs_leaktest']) {
    assert.equal(dump.includes(secret), false, `SIR YANLIŞ TABLODA: ${secret}`)
  }
  // Doğru tabloda ve ŞİFRELİ.
  const stored = await pglite.query('select encrypted_payload from connector_credentials')
  assert.equal(stored.rows.length, 1)
  assert.equal(stored.rows[0].encrypted_payload.includes('cs_leaktest'), false)
})

test('WOO-ACC-OWNERSHIP: yabancı hesaba kimlik BAĞLANAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'woo-own-a')
  const orgB = await makeOrg(db, 'woo-own-b')
  const foreign = await accounts.ensureAccount(db, orgB, 'woocommerce', 'b.example.com')
  await assert.rejects(
    () =>
      credentialStore.saveConnectorCredential(db, {
        organizationId: orgA,
        marketplaceAccountId: foreign.id,
        providerKey: 'woocommerce',
        payload: { consumerKey: 'x' },
      }),
    credentialStore.ConnectorAccountOwnershipError,
  )
})

/* ═══ BAĞLANTI TESTİ ══════════════════════════════════════════════════ */

test('WOO-CONN: sır SORGU DİZESİNE ASLA konmaz, Basic başlıkta', async () => {
  const { transport, requests } = makeTransport([okResponse([])])
  await wooClient.testWooConnection(
    {
      storeUrl: 'https://shop.example.com',
      consumerKey: 'ck_secret',
      consumerSecret: 'cs_secret',
    },
    clientOptions(transport),
  )
  assert.equal(requests.length, 1)
  const request = requests[0]
  // Sözleşmedeki taban yol.
  assert.match(request.url, /^https:\/\/shop\.example\.com\/wp-json\/wc\/v3\/orders\?/)
  // SIR URL'DE YOK.
  assert.equal(request.url.includes('cs_secret'), false)
  assert.equal(request.url.includes('consumer_secret'), false)
  assert.equal(request.url.includes('consumer_key'), false)
  // Basic başlıkta VAR.
  const decoded = Buffer.from(
    request.headers.Authorization.replace('Basic ', ''),
    'base64',
  ).toString('utf8')
  assert.equal(decoded, 'ck_secret:cs_secret')
  // En küçük yük.
  assert.match(request.url, /per_page=1/)
  assert.equal(request.method, 'GET')
})

test('WOO-CONN-CLASS: hata sınıfları KARARLI, ham PHP metni TAŞINMAZ', async () => {
  const cases = [
    [401, 'AUTH'],
    [403, 'PERMISSION'],
    [404, 'NOT_FOUND_OR_CONFIG'],
    [429, 'RATE_LIMIT'],
    [500, 'PROVIDER'],
    [502, 'PROVIDER'],
  ]
  for (const [status, expected] of cases) {
    const { transport } = makeTransport([
      {
        status,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          code: 'woocommerce_rest_authentication_error',
          message: '<b>Fatal error</b> in /var/www/wp-includes/foo.php line 42',
          data: { status },
        }),
      },
    ])
    const result = await wooClient.testWooConnection(
      { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
      clientOptions(transport),
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorClass, expected, String(status))
    // Ham sağlayıcı metni operatöre GİTMEZ.
    assert.equal(result.message.includes('Fatal error'), false)
    assert.equal(result.message.includes('/var/www'), false)
  }

  // Ağ hatası.
  const { transport } = makeTransport([new Error('ECONNREFUSED')])
  const network = await wooClient.testWooConnection(
    { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    clientOptions(transport),
  )
  assert.equal(network.errorClass, 'NETWORK')

  // JSON olmayan yanıt.
  const { transport: htmlTransport } = makeTransport([
    { status: 200, headers: {}, bodyText: '<html>not json</html>' },
  ])
  const malformed = await wooClient.testWooConnection(
    { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    clientOptions(htmlTransport),
  )
  assert.equal(malformed.errorClass, 'MALFORMED_RESPONSE')
})

test('WOO-CONN-GATE: BAŞARISIZ doğrulama HİÇBİR ŞEY kalıcılaştırmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-conn-gate')
  const { transport } = makeTransport([
    { status: 401, headers: {}, bodyText: JSON.stringify({ code: 'x', data: { status: 401 } }) },
  ])
  const result = await wooConnection.connectWooStore(
    db,
    { organizationId: org, storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    clientOptions(transport),
  )
  assert.equal(result.outcome, 'CONNECTION_FAILED')
  assert.equal(result.errorClass, 'AUTH')
  // Hesap da kimlik de YAZILMAZ.
  assert.equal((await accounts.listAccounts(db, org, 'woocommerce')).length, 0)
  const creds = await pglite.query('select * from connector_credentials')
  assert.equal(creds.rows.length, 0)
})

test('WOO-CONN-SSRF-GATE: özel adrese çözülen mağaza için AĞ İSTEĞİ YAPILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-conn-ssrf')
  const { transport, requests } = makeTransport([okResponse([])])
  const result = await wooConnection.connectWooStore(
    db,
    { organizationId: org, storeUrl: 'https://evil.example.com', consumerKey: 'k', consumerSecret: 's' },
    { transport, resolver: privateResolver, retryDelaysMs: [], sleep: async () => {} },
  )
  assert.equal(result.outcome, 'STORE_URL_REJECTED')
  // KRİTİK: istek HİÇ kurulmadı.
  assert.equal(requests.length, 0)
})

/* ═══ SİPARİŞ NORMALLEŞTİRME ══════════════════════════════════════════ */

test('WOO-ORD-1/2/3: kimlik KARARLI alanlardan gelir', () => {
  const result = wooNormalizer.normalizeWooOrder(wooOrderFixture())
  assert.equal(result.ok, true)
  // id = kanonik kimlik
  assert.equal(result.order.externalOrderId, '4711')
  assert.equal(result.order.packageId, '4711')
  // number = İNSAN referansı, kimlik DEĞİL
  assert.equal(result.order.orderNumber, 'WC-1001')
  assert.notEqual(result.order.externalOrderId, result.order.orderNumber)
  // satır kimliği line_items[].id
  assert.equal(result.order.lines[0].externalLineId, '88')
  assert.equal(result.order.lines[0].productId, '501')
  // variation_id = 0 → varyant YOK (sahte varyant üretilmez)
  assert.equal(result.order.lines[0].variantId, null)
})

test('WOO-ORD-4: aynı sipariş iki kez → İDEMPOTENT', () => {
  const batch = wooNormalizer.normalizeWooOrders([
    wooOrderFixture(),
    wooOrderFixture(),
  ])
  assert.equal(batch.orders.length, 1)
  assert.equal(batch.duplicateRemovedCount, 1)
})

test('WOO-ORD-5: farklı mağazalarda AYNI Woo id İZOLEDİR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-ord-5')
  const { transport } = makeTransport([okResponse([])])
  const a = await wooConnection.connectWooStore(
    db,
    { organizationId: org, storeUrl: 'https://a.example.com', consumerKey: 'k', consumerSecret: 's' },
    clientOptions(transport),
  )
  const b = await wooConnection.connectWooStore(
    db,
    { organizationId: org, storeUrl: 'https://b.example.com', consumerKey: 'k', consumerSecret: 's' },
    clientOptions(transport),
  )
  // Kimlik kapsamı HESAPTIR: aynı Woo id iki AYRI hesapta AYRI kayıttır.
  assert.notEqual(a.account.id, b.account.id)
  const sameOrderId = wooNormalizer.normalizeWooOrder(wooOrderFixture()).order.externalOrderId
  assert.equal(sameOrderId, '4711')
  // Gelen kutusu/senkron anahtarları hesap kapsamlıdır (aşağıdaki WH-4 kilitler).
})

test('WOO-ORD-6/7: date_created_gmt UTC olarak TAM BİR KEZ yorumlanır', () => {
  const result = wooNormalizer.normalizeWooOrder(wooOrderFixture())
  // GMT 10:20:30 → mutlak an 10:20:30Z. +03 UYGULANMAZ.
  assert.equal(result.order.orderDate, '2026-09-18T10:20:30.000Z')
  // Yerel alan (13:20:30) kanonik anı EZEMEZ.
  assert.notEqual(result.order.orderDate, '2026-09-18T13:20:30.000Z')

  // Yerel alan DEĞİŞSE BİLE sonuç DEĞİŞMEZ.
  const shifted = wooNormalizer.normalizeWooOrder(
    wooOrderFixture({ date_created: '2026-01-01T00:00:00' }),
  )
  assert.equal(shifted.order.orderDate, '2026-09-18T10:20:30.000Z')

  // Zaten ofsetli değer İKİNCİ KEZ çevrilmez.
  assert.equal(
    wooNormalizer.wooGmtToInstant('2026-09-18T10:20:30Z'),
    '2026-09-18T10:20:30.000Z',
  )
  assert.equal(
    wooNormalizer.wooGmtToInstant('2026-09-18T13:20:30+03:00'),
    '2026-09-18T10:20:30.000Z',
  )
})

test('WOO-ORD-8: date_modified_gmt pazaryeri değişiklik anı olarak saklanır', () => {
  const result = wooNormalizer.normalizeWooOrder(wooOrderFixture())
  assert.equal(result.order.marketplaceLastModifiedAt, '2026-09-19T08:00:00.000Z')
})

test('WOO-ORD-9: BOZUK GMT tarih SESSİZCE Unix epoch OLMAZ', () => {
  for (const bad of ['not-a-date', '0000-13-45T99:99:99', '']) {
    const result = wooNormalizer.normalizeWooOrder(
      wooOrderFixture({ date_created_gmt: bad }),
    )
    assert.equal(result.ok, false, bad)
    assert.match(result.rejection, /CREATED_GMT/)
  }
  // Epoch'a düşen bir sonuç ÜRETİLMEZ.
  const epochish = wooNormalizer.normalizeWooOrders([
    wooOrderFixture({ date_created_gmt: 'garbage' }),
  ])
  assert.equal(epochish.orders.length, 0)
  assert.equal(epochish.rejected.length, 1)
  assert.equal(
    epochish.orders.some((o) => o.orderDate === '1970-01-01T00:00:00.000Z'),
    false,
  )
  // Bozuk MODIFIED de reddedilir.
  assert.equal(
    wooNormalizer.normalizeWooOrder(wooOrderFixture({ date_modified_gmt: 'zzz' })).rejection,
    'MALFORMED_MODIFIED_GMT',
  )
})

test('WOO-ORD-10: para ONDALIK DİZGİ olarak korunur', () => {
  const result = wooNormalizer.normalizeWooOrder(wooOrderFixture())
  assert.equal(result.order.totalDecimal, '119.99')
  assert.equal(typeof result.order.totalDecimal, 'string')
  // Satır fiyatındaki ek ondalık da KORUNUR (yuvarlanmaz).
  assert.equal(result.order.lines[0].priceDecimal, '59.995')

  // TEST DÜZELTİLDİ: ilk yazımda `Number('59.995') * 2` ile kayıp
  // göstermeye çalışmıştım — o değer kayan noktada TAM ÇIKIYOR, yani
  // "kanıt" hiçbir şey kanıtlamıyordu. GERÇEKTEN kayıplı vakalar:
  //
  //   · sondaki sıfır YOK OLUR   : '119.90' → 119.9  → '119.9'
  //   · ondalık kayması          : 0.1 + 0.2 → 0.30000000000000004
  assert.equal(String(Number('119.90')), '119.9', 'float sondaki sıfırı YUTAR')
  assert.notEqual(String(Number('119.90')), '119.90')
  assert.notEqual(String(0.1 + 0.2), '0.3')

  // Adaptör sağlayıcı dizgisini AYNEN taşır: sondaki sıfır KAYBOLMAZ.
  const trailing = wooNormalizer.normalizeWooOrder(
    wooOrderFixture({
      total: '119.90',
      line_items: [{ id: 1, product_id: 2, quantity: 1, total: '119.90', price: '119.90' }],
    }),
  )
  assert.equal(trailing.order.totalDecimal, '119.90')
  assert.equal(trailing.order.lines[0].priceDecimal, '119.90')
})

test('WOO-ORD-11: shipping.phone UYDURULMAZ; billing.phone sözleşmeye göre kullanılır', () => {
  const ok = wooNormalizer.normalizeWooOrder(wooOrderFixture())
  assert.equal(ok.order.customerPhone, '+905551112233')
  assert.equal(ok.order.dataQualityFlags.includes('PHONE_MISSING'), false)

  // Telefon HİÇ YOKSA: uydurulmaz, VERİ KALİTESİ BAYRAĞI konur.
  const noPhone = wooNormalizer.normalizeWooOrder(
    wooOrderFixture({
      billing: { first_name: 'A', last_name: 'B', email: 'a@b.c' },
      shipping: { first_name: 'A', last_name: 'B', address_1: 'X', city: 'Y', state: 'Z' },
    }),
  )
  assert.equal(noPhone.order.customerPhone, '')
  assert.equal(noPhone.order.dataQualityFlags.includes('PHONE_MISSING'), true)

  // shipping bloğuna telefon KONSA BİLE sözleşme dışıdır → OKUNMAZ.
  // (Yorum satırlarında geçen `shipping.phone` ifadesi KOD DEĞİLDİR;
  //  tarama yorumları SİLER — aksi hâlde kendi açıklamamı ihlal sanardım.)
  const source = stripComments(
    readFileSync(join(here, 'connectors', 'woocommerce', 'wooOrderNormalizer.ts'), 'utf8'),
  )
  assert.equal(/shipping\.phone/.test(source), false)
  assert.equal(/shipping\s*\.\s*phone/.test(source), false)

  // Sağlayıcı sözleşme dışı `shipping.phone` GÖNDERSE BİLE kullanılmaz.
  const rogue = wooNormalizer.normalizeWooOrder(
    wooOrderFixture({
      billing: { first_name: 'A', last_name: 'B', email: 'a@b.c' },
      shipping: {
        first_name: 'A',
        last_name: 'B',
        address_1: 'X',
        city: 'Y',
        state: 'Z',
        phone: '+900000000000',
      },
    }),
  )
  assert.equal(rogue.order.customerPhone, '')
  assert.equal(rogue.order.dataQualityFlags.includes('PHONE_MISSING'), true)
})

test('WOO-ORD-12: eklenti takip alanları YOK SAYILIR', () => {
  const result = wooNormalizer.normalizeWooOrder(
    wooOrderFixture({
      meta_data: [
        { id: 1, key: '_tracking_number', value: 'TRK123' },
        { id: 2, key: '_wc_shipment_tracking_items', value: 'CARRIER-X' },
      ],
    }),
  )
  assert.equal(result.order.marketplaceTrackingNumber, null)
  assert.equal(result.order.marketplaceCarrier, null)
  const serialized = JSON.stringify({
    tracking: result.order.marketplaceTrackingNumber,
    carrier: result.order.marketplaceCarrier,
  })
  assert.equal(serialized.includes('TRK123'), false)
  assert.equal(serialized.includes('CARRIER-X'), false)
})

test('WOO-ORD-13: ham sağlayıcı yükü KORUNUR', () => {
  const raw = wooOrderFixture()
  const result = wooNormalizer.normalizeWooOrder(raw)
  assert.deepEqual(result.order.rawOrder, raw)
})

test('WOO-ORD-STATUS: ham statü korunur, iş anlamı UYDURULMAZ', () => {
  for (const status of wooNormalizer.WOO_ORDER_STATUSES) {
    const result = wooNormalizer.normalizeWooOrder(wooOrderFixture({ status }))
    assert.equal(result.order.rawStatus, status)
    // `completed` "teslim edildi", `refunded` "iade geldi" SAYILMAZ.
    assert.equal(result.order.canonicalStatus, null, status)
  }
})

test('WOO-ORD-NOID: kimliksiz sipariş UYDURULMAZ, REDDEDİLİR', () => {
  for (const bad of [{}, { id: 0 }, { id: '' }]) {
    const result = wooNormalizer.normalizeWooOrder({ ...bad, date_created_gmt: '2026-01-01T00:00:00' })
    assert.equal(result.ok, false)
    assert.equal(result.rejection, 'MISSING_ORDER_ID')
  }
})

/* ═══ SAYFALAMA ═══════════════════════════════════════════════════════ */

test('WOO-PAGE-1/2: çok sayfa DETERMİNİSTİK toplanır, X-WP-TotalPages e UYULUR', async () => {
  const responses = [
    okResponse([wooOrderFixture({ id: 1 })], { 'x-wp-totalpages': '3', 'x-wp-total': '3' }),
    okResponse([wooOrderFixture({ id: 2 })], { 'x-wp-totalpages': '3', 'x-wp-total': '3' }),
    okResponse([wooOrderFixture({ id: 3 })], { 'x-wp-totalpages': '3', 'x-wp-total': '3' }),
    okResponse([wooOrderFixture({ id: 999 })], { 'x-wp-totalpages': '3' }),
  ]
  const { transport, requests } = makeTransport(responses)
  const result = await wooClient.fetchWooOrders(
    { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    { perPage: 1 },
    { ...clientOptions(transport), maxPages: 10 },
  )
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.pagesFetched, 3, 'TotalPages AŞILMAMALI')
  assert.equal(result.totalPages, 3)
  assert.equal(result.rawOrders.length, 3)
  // 4. sayfa HİÇ istenmedi.
  assert.equal(requests.length, 3)
  assert.match(requests[0].url, /page=1/)
  assert.match(requests[2].url, /page=3/)
})

test('WOO-PAGE-3: sayfalar arası MÜKERRER kararlı id TEKİLLEŞTİRİLİR', async () => {
  const { transport } = makeTransport([
    okResponse([wooOrderFixture({ id: 7 })], { 'x-wp-totalpages': '2' }),
    okResponse([wooOrderFixture({ id: 7 })], { 'x-wp-totalpages': '2' }),
  ])
  const fetched = await wooClient.fetchWooOrders(
    { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    { perPage: 1 },
    { ...clientOptions(transport), maxPages: 5 },
  )
  assert.equal(fetched.rawOrders.length, 2)
  const normalized = wooNormalizer.normalizeWooOrders(fetched.rawOrders)
  assert.equal(normalized.orders.length, 1)
  assert.equal(normalized.duplicateRemovedCount, 1)

  // AYNI görüntü numarası + FARKLI id → AYRI siparişler.
  const distinct = wooNormalizer.normalizeWooOrders([
    wooOrderFixture({ id: 10, number: 'SAME' }),
    wooOrderFixture({ id: 11, number: 'SAME' }),
  ])
  assert.equal(distinct.orders.length, 2)
})

test('WOO-PAGE-4: sayfa ortasında hata → PARTIAL, veri KAYBOLMAZ', async () => {
  const { transport } = makeTransport([
    okResponse([wooOrderFixture({ id: 1 })], { 'x-wp-totalpages': '3' }),
    { status: 500, headers: {}, bodyText: '{}' },
  ])
  const result = await wooClient.fetchWooOrders(
    { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    { perPage: 1 },
    { ...clientOptions(transport), maxPages: 5 },
  )
  assert.equal(result.outcome, 'PARTIAL')
  assert.equal(result.rawOrders.length, 1, 'o ana kadarki veri TAŞINIR')
  assert.equal(result.errorClass, 'PROVIDER')

  // İLK sayfa düşerse FAILED.
  const { transport: firstFails } = makeTransport([{ status: 500, headers: {}, bodyText: '{}' }])
  const failed = await wooClient.fetchWooOrders(
    { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    { perPage: 1 },
    { ...clientOptions(firstFails), maxPages: 5 },
  )
  assert.equal(failed.outcome, 'FAILED')
})

test('WOO-PAGE-CAP: güvenlik üst sınırı SESSİZCE KESMEZ → PARTIAL', async () => {
  const { transport } = makeTransport([
    okResponse([wooOrderFixture({ id: 1 })], { 'x-wp-totalpages': '99' }),
  ])
  const result = await wooClient.fetchWooOrders(
    { storeUrl: 'https://shop.example.com', consumerKey: 'k', consumerSecret: 's' },
    { perPage: 1 },
    { ...clientOptions(transport), maxPages: 2 },
  )
  assert.equal(result.outcome, 'PARTIAL')
  assert.match(result.message, /üst sınır/i)
})

/* ═══ SENKRON / İMLEÇ ═════════════════════════════════════════════════ */

async function wooAccountFor(db, org, host) {
  const { transport } = makeTransport([okResponse([])])
  const connected = await wooConnection.connectWooStore(
    db,
    { organizationId: org, storeUrl: `https://${host}`, consumerKey: 'k', consumerSecret: 's' },
    clientOptions(transport),
  )
  return connected.account
}

async function checkpointOf(pglite, org, accountId) {
  const rows = await pglite.query(
    `select last_successful_sync_at, last_sync_status from integration_sync_state
     where organization_id=$1 and marketplace_account_id=$2 and provider='woocommerce'`,
    [org, accountId],
  )
  return rows.rows[0] ?? null
}

test('WOO-PAGE-7: BAŞARI imleci PENCERE ÜST SINIRINA ilerletir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-cp-success')
  const account = await wooAccountFor(db, org, 'a.example.com')
  const { transport } = makeTransport([okResponse([wooOrderFixture()], { 'x-wp-totalpages': '1' })])

  const before = '2026-09-20T00:00:00.000Z'
  const result = await wooSync.syncWooOrdersForAccount(
    db,
    {
      organizationId: org,
      marketplaceAccountId: account.id,
      credentials: { storeUrl: 'https://a.example.com', consumerKey: 'k', consumerSecret: 's' },
      window: { after: '2026-09-01T00:00:00.000Z', before },
    },
    { ...clientOptions(transport), maxPages: 5 },
  )
  assert.equal(result.outcome, 'SUCCESS')
  assert.equal(result.checkpointAdvanced, true)
  const state = await checkpointOf(pglite, org, account.id)
  assert.equal(state.last_sync_status, 'success')
  // İmleç `now` DEĞİL, PENCERE ÜST SINIRI.
  assert.equal(new Date(state.last_successful_sync_at).toISOString(), before)
})

test('WOO-PAGE-5: PARTIAL imleci İLERLETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-cp-partial')
  const account = await wooAccountFor(db, org, 'a.example.com')

  // Önce BAŞARILI bir tur → imleç kurulur.
  const { transport: okT } = makeTransport([okResponse([], { 'x-wp-totalpages': '1' })])
  await wooSync.syncWooOrdersForAccount(
    db,
    {
      organizationId: org,
      marketplaceAccountId: account.id,
      credentials: { storeUrl: 'https://a.example.com', consumerKey: 'k', consumerSecret: 's' },
      window: { before: '2026-09-10T00:00:00.000Z' },
    },
    { ...clientOptions(okT), maxPages: 5 },
  )
  const baseline = await checkpointOf(pglite, org, account.id)

  // Sonra KISMİ tur.
  const { transport: partialT } = makeTransport([
    okResponse([wooOrderFixture({ id: 1 })], { 'x-wp-totalpages': '3' }),
    { status: 500, headers: {}, bodyText: '{}' },
  ])
  const partial = await wooSync.syncWooOrdersForAccount(
    db,
    {
      organizationId: org,
      marketplaceAccountId: account.id,
      credentials: { storeUrl: 'https://a.example.com', consumerKey: 'k', consumerSecret: 's' },
      window: { before: '2026-09-20T00:00:00.000Z' },
      perPage: 1,
    },
    { ...clientOptions(partialT), maxPages: 5 },
  )
  assert.equal(partial.outcome, 'PARTIAL')
  assert.equal(partial.checkpointAdvanced, false)
  const after = await checkpointOf(pglite, org, account.id)
  assert.equal(after.last_sync_status, 'partial')
  // İMLEÇ DEĞİŞMEDİ — çekilemeyen aralık BİR DAHA sorulacak.
  assert.equal(
    new Date(after.last_successful_sync_at).toISOString(),
    new Date(baseline.last_successful_sync_at).toISOString(),
  )
})

test('WOO-PAGE-6: FAILED imleci İLERLETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-cp-failed')
  const account = await wooAccountFor(db, org, 'a.example.com')

  const { transport: okT } = makeTransport([okResponse([], { 'x-wp-totalpages': '1' })])
  await wooSync.syncWooOrdersForAccount(
    db,
    {
      organizationId: org,
      marketplaceAccountId: account.id,
      credentials: { storeUrl: 'https://a.example.com', consumerKey: 'k', consumerSecret: 's' },
      window: { before: '2026-09-10T00:00:00.000Z' },
    },
    { ...clientOptions(okT), maxPages: 5 },
  )
  const baseline = await checkpointOf(pglite, org, account.id)

  const { transport: failT } = makeTransport([{ status: 401, headers: {}, bodyText: '{}' }])
  const failed = await wooSync.syncWooOrdersForAccount(
    db,
    {
      organizationId: org,
      marketplaceAccountId: account.id,
      credentials: { storeUrl: 'https://a.example.com', consumerKey: 'k', consumerSecret: 's' },
      window: { before: '2026-09-20T00:00:00.000Z' },
    },
    { ...clientOptions(failT), maxPages: 5 },
  )
  assert.equal(failed.outcome, 'FAILED')
  assert.equal(failed.checkpointAdvanced, false)
  const after = await checkpointOf(pglite, org, account.id)
  assert.equal(after.last_sync_status, 'failed')
  assert.equal(
    new Date(after.last_successful_sync_at).toISOString(),
    new Date(baseline.last_successful_sync_at).toISOString(),
  )
})

/* ═══ WEBHOOK İMZASI ══════════════════════════════════════════════════ */

test('WOO-WH-1: geçerli HAM GÖVDE HMAC-SHA256/base64 imzası KABUL EDİLİR', () => {
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')
  const secret = 'whs_test'
  const signature = createHmac('sha256', secret).update(body).digest('base64')
  const result = wooSignature.verifyWooWebhookSignature({
    rawBody: body,
    signatureHeader: signature,
    secret,
  })
  assert.equal(result.verified, true)
  assert.equal(result.rejection, null)
  // Yardımcı da AYNI değeri üretir.
  assert.equal(wooSignature.computeWooSignature(body, secret), signature)
})

test('WOO-WH-2: YENİDEN SERİLEŞTİRİLMİŞ aynı JSON DOĞRULANMAZ', () => {
  const secret = 'whs_test'
  // Sağlayıcının gönderdiği GERÇEK baytlar (boşluklu, belirli anahtar sırası).
  const original = Buffer.from(
    '{\n  "id": 4711,\n  "number": "WC-1001",\n  "total": "119.99"\n}',
    'utf8',
  )
  const signature = createHmac('sha256', secret).update(original).digest('base64')

  // JSON.parse → JSON.stringify AYNI NESNE, FARKLI BAYT.
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString('utf8'))), 'utf8')
  assert.notEqual(reserialized.toString('utf8'), original.toString('utf8'))
  assert.deepEqual(JSON.parse(reserialized.toString('utf8')), JSON.parse(original.toString('utf8')))

  assert.equal(
    wooSignature.verifyWooWebhookSignature({
      rawBody: original,
      signatureHeader: signature,
      secret,
    }).verified,
    true,
  )
  // Yeniden serileştirilmiş gövde imzayı TUTMAZ.
  assert.equal(
    wooSignature.verifyWooWebhookSignature({
      rawBody: reserialized,
      signatureHeader: signature,
      secret,
    }).verified,
    false,
  )

  // Doğrulayıcı JSON'a HİÇ BAKMAZ. (Yorumlar SİLİNİR: açıklamada geçen
  //  `JSON.parse` ifadesi kod değildir.)
  const source = stripComments(
    readFileSync(join(here, 'connectors', 'woocommerce', 'wooWebhookSignature.ts'), 'utf8'),
  )
  assert.equal(source.includes('JSON.parse'), false)
  assert.equal(source.includes('JSON.stringify'), false)
  assert.match(source, /timingSafeEqual/)
})

test('WOO-WH-SIG-REJECTIONS: eksik/bozuk imza sebepleri AYRIŞIR', () => {
  const body = Buffer.from('{}', 'utf8')
  assert.equal(
    wooSignature.verifyWooWebhookSignature({ rawBody: body, signatureHeader: '', secret: 's' })
      .rejection,
    'MISSING_SIGNATURE',
  )
  assert.equal(
    wooSignature.verifyWooWebhookSignature({ rawBody: body, signatureHeader: 'x', secret: '' })
      .rejection,
    'MISSING_SECRET',
  )
  assert.equal(
    wooSignature.verifyWooWebhookSignature({
      rawBody: Buffer.alloc(0),
      signatureHeader: 'x',
      secret: 's',
    }).rejection,
    'MISSING_BODY',
  )
  // Dizge gövde KABUL EDİLMEZ (yeniden kodlama riski).
  assert.equal(
    wooSignature.verifyWooWebhookSignature({
      rawBody: '{}',
      signatureHeader: 'x',
      secret: 's',
    }).rejection,
    'MISSING_BODY',
  )
  assert.equal(
    wooSignature.verifyWooWebhookSignature({
      rawBody: body,
      signatureHeader: 'dG9vLXNob3J0',
      secret: 's',
    }).rejection,
    'MALFORMED_SIGNATURE',
  )
})

/* ═══ WEBHOOK ALIMI / GELEN KUTUSU ════════════════════════════════════ */

async function wooStoreWithWebhook(db, org, host, webhookSecret) {
  const { transport } = makeTransport([okResponse([])])
  const connected = await wooConnection.connectWooStore(
    db,
    {
      organizationId: org,
      storeUrl: `https://${host}`,
      consumerKey: 'k',
      consumerSecret: 's',
      webhookSecret,
    },
    clientOptions(transport),
  )
  return connected.account
}

function signedRequest(body, secret, overrides = {}) {
  return {
    rawBody: body,
    headers: {
      'x-wc-webhook-signature': createHmac('sha256', secret).update(body).digest('base64'),
      'x-wc-webhook-topic': 'order.created',
      'x-wc-webhook-delivery-id': 'delivery-1',
      ...overrides,
    },
  }
}

test('WOO-WH-3: GEÇERSİZ imza gelen kutusuna GİRMEZ ve 2xx ALMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-3')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')

  const result = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: {
      rawBody: body,
      headers: {
        'x-wc-webhook-signature': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'x-wc-webhook-topic': 'order.created',
        'x-wc-webhook-delivery-id': 'delivery-bad',
      },
    },
  })
  assert.equal(result.outcome, 'SIGNATURE_REJECTED')
  assert.equal(result.httpStatus, 401)
  // SAHTE BAŞARI YOK.
  assert.notEqual(result.httpStatus, 200)
  const rows = await pglite.query('select * from connector_webhook_inbox')
  assert.equal(rows.rows.length, 0, 'geçersiz imza KALICILAŞMAMALI')
})

test('WOO-WH-4: A mağazasının sırrı B mağazasının teslimini DOĞRULAYAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-4')
  const a = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const b = await wooStoreWithWebhook(db, org, 'b.example.com', 'whs_b')
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')

  // A'nın sırrıyla imzalanmış teslim B hesabına gönderilir.
  const crossed = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: b.id,
    webhookSecret: 'whs_b',
    request: signedRequest(body, 'whs_a'),
  })
  assert.equal(crossed.outcome, 'SIGNATURE_REJECTED')

  // Kendi hesabında KABUL EDİLİR.
  const own = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: a.id,
    webhookSecret: 'whs_a',
    request: signedRequest(body, 'whs_a'),
  })
  assert.equal(own.outcome, 'ACCEPTED')

  // B'nin gelen kutusu BOŞ kalır.
  const bRows = await inbox.listInbox(db, {
    organizationId: org,
    marketplaceAccountId: b.id,
    providerKey: 'woocommerce',
  })
  assert.equal(bRows.length, 0)
  const aRows = await inbox.listInbox(db, {
    organizationId: org,
    marketplaceAccountId: a.id,
    providerKey: 'woocommerce',
  })
  assert.equal(aRows.length, 1)
  await pglite.query('select 1')
})

test('WOO-WH-5: AYNI teslim kimliği İDEMPOTENT', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-5')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')

  const first = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: signedRequest(body, 'whs_a'),
  })
  const second = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: signedRequest(body, 'whs_a'),
  })
  assert.equal(first.outcome, 'ACCEPTED')
  // Tekrar teslim yine 2xx alır (sağlayıcı tekrarı normaldir)...
  assert.equal(second.outcome, 'DUPLICATE')
  assert.equal(second.httpStatus, 200)
  // ...ama İKİNCİ SATIR AÇILMAZ.
  const rows = await pglite.query('select * from connector_webhook_inbox')
  assert.equal(rows.rows.length, 1)
  assert.equal(second.record.id, first.record.id)
})

test('WOO-WH-6: KALICI YAZIM 2xx TEN ÖNCE gelir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-6')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')

  const result = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: signedRequest(body, 'whs_a'),
  })
  assert.equal(result.httpStatus, 200)
  // 2xx DÖNDÜĞÜ ANDA satır DİSKTE.
  const rows = await pglite.query('select * from connector_webhook_inbox')
  assert.equal(rows.rows.length, 1)
  assert.equal(rows.rows[0].status, 'RECEIVED')
  assert.notEqual(rows.rows[0].verified_at, null)

  // Kalıcı yazım DÜŞERSE 2xx YOK.
  const brokenDb = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => {
      throw new Error('disk dolu')
    },
  }
  const notDurable = await wooIngest.ingestWooWebhook(brokenDb, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: signedRequest(body, 'whs_a', { 'x-wc-webhook-delivery-id': 'delivery-2' }),
  })
  assert.equal(notDurable.outcome, 'NOT_DURABLE')
  assert.equal(notDurable.httpStatus, 503)
})

test('WOO-WH-7: ACK SONRASI işleme hatası RETRYABLE bırakır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-7')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  // Geçerli imza AMA işlenemez gövde (bozuk sipariş).
  const body = Buffer.from(JSON.stringify({ id: 0 }), 'utf8')
  const accepted = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: signedRequest(body, 'whs_a'),
  })
  assert.equal(accepted.httpStatus, 200, 'ALIM başarılı sayılır')

  const processed = await wooIngest.processWooInboxItem(db, {
    organizationId: org,
    record: accepted.record,
    rawBody: body,
  })
  assert.equal(processed.processed, false)
  assert.equal(processed.status, 'RETRYABLE')
  const rows = await pglite.query('select * from connector_webhook_inbox')
  assert.equal(rows.rows[0].status, 'RETRYABLE')
  assert.equal(rows.rows[0].attempt_count, 1)
  assert.equal(rows.rows[0].processed_at, null)
})

test('WOO-WH-8: OLAY YOKLUĞU webhook u DISABLED YAPMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-8')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  // HİÇ teslim yok.
  const rows = await inbox.listInbox(db, { organizationId: org, providerKey: 'woocommerce' })
  assert.equal(rows.length, 0)

  const health = await healthRepo.loadIntegrationHealth(db, {
    organizationId: org,
    nowMs: Date.now(),
  })
  const woo = health.find((h) => h.marketplaceAccountId === account.id)
  // Gözlem YOKSA webhook durumu DISABLED UYDURULMAZ.
  assert.notEqual(woo.webhook, 'DISABLED')
})

test('WOO-WH-9/10: sipariş konuları işlenir, DESTEKLENMEYEN konu siparişe DOKUNMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-9')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')

  for (const topic of ['order.created', 'order.updated']) {
    const accepted = await wooIngest.ingestWooWebhook(db, {
      organizationId: org,
      marketplaceAccountId: account.id,
      webhookSecret: 'whs_a',
      request: signedRequest(body, 'whs_a', {
        'x-wc-webhook-topic': topic,
        'x-wc-webhook-delivery-id': `d-${topic}`,
      }),
    })
    assert.equal(accepted.outcome, 'ACCEPTED', topic)
    assert.equal(accepted.topicSupported, true, topic)
    const processed = await wooIngest.processWooInboxItem(db, {
      organizationId: org,
      record: accepted.record,
      rawBody: body,
    })
    assert.equal(processed.processed, true, topic)
    assert.equal(processed.normalized.externalOrderId, '4711')
  }

  // DESTEKLENMEYEN konu: kabul edilir ama SİPARİŞ İŞLEMEYE GİRMEZ.
  const productBody = Buffer.from(JSON.stringify({ id: 999, name: 'ürün' }), 'utf8')
  const unsupported = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: signedRequest(productBody, 'whs_a', {
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-delivery-id': 'd-product',
    }),
  })
  assert.equal(unsupported.topicSupported, false)
  assert.equal(unsupported.record.status, 'IGNORED')
  const processed = await wooIngest.processWooInboxItem(db, {
    organizationId: org,
    record: unsupported.record,
    rawBody: productBody,
  })
  assert.equal(processed.status, 'IGNORED')
  assert.equal(processed.normalized, null)
  await pglite.query('select 1')
})

test('WOO-WH-11: ham webhook PII i DİSKTE ŞİFRELİ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-wh-11')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const pii = wooOrderFixture({
    billing: {
      first_name: 'GizliAd',
      last_name: 'GizliSoyad',
      email: 'gizli@example.com',
      phone: '+905559998877',
    },
  })
  const body = Buffer.from(JSON.stringify(pii), 'utf8')
  const accepted = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: account.id,
    webhookSecret: 'whs_a',
    request: signedRequest(body, 'whs_a'),
  })
  assert.equal(accepted.outcome, 'ACCEPTED')

  const rows = await pglite.query('select * from connector_webhook_inbox')
  const dump = JSON.stringify(rows.rows)
  for (const secret of ['GizliAd', 'gizli@example.com', '+905559998877']) {
    assert.equal(dump.includes(secret), false, `PII DÜZ METİN: ${secret}`)
  }
  // Geri çözülebilir ve BAYT BAYT AYNI (imza yeniden doğrulanabilir).
  const restored = await inbox.readInboxRawBody(db, {
    organizationId: org,
    inboxId: accepted.record.id,
  })
  assert.equal(restored.equals(body), true)
})

/* ═══ SAĞLIK ══════════════════════════════════════════════════════════ */

test('WOO-H-1: YAPILANDIRILMIŞ + HİÇ ÇALIŞMAMIŞ → GERÇEK hesap + NEVER_RUN', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-h-1')
  const account = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')

  // Senkron satırı YOK.
  const syncRows = await pglite.query('select * from integration_sync_state')
  assert.equal(syncRows.rows.length, 0)

  const health = await healthRepo.loadIntegrationHealth(db, {
    organizationId: org,
    nowMs: Date.now(),
    credentialsPresenceByConnection: {
      [`woocommerce::${account.id}`]: 'PRESENT',
    },
  })
  const woo = health.filter((h) => h.providerKey === 'woocommerce')
  assert.equal(woo.length, 1)
  // GERÇEK hesap kimliği — 'none'/null DEĞİL.
  assert.equal(woo[0].marketplaceAccountId, account.id)
  assert.equal(woo[0].connectionScope, 'account')
  assert.equal(woo[0].sync, 'NEVER_RUN')
})

test('WOO-H-2/3: İKİ mağaza İKİ SAĞLIK SATIRI, birbirinden BAĞIMSIZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-h-2')
  const a = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const b = await wooStoreWithWebhook(db, org, 'b.example.com', 'whs_b')

  // A başarılı, B kimlik hatası.
  const { recordSyncState } = await import('./onboarding/onboardingRepository.ts')
  await recordSyncState(db, org, {
    provider: 'woocommerce',
    resource: 'orders',
    status: 'success',
    marketplaceAccountId: a.id,
    successfulSyncAt: new Date(),
  })
  await recordSyncState(db, org, {
    provider: 'woocommerce',
    resource: 'orders',
    status: 'failed',
    marketplaceAccountId: b.id,
    errorCode: 'AUTH',
  })

  const health = await healthRepo.loadIntegrationHealth(db, {
    organizationId: org,
    nowMs: Date.now(),
    credentialsPresenceByConnection: {
      [`woocommerce::${a.id}`]: 'PRESENT',
      [`woocommerce::${b.id}`]: 'PRESENT',
    },
  })
  const woo = health.filter((h) => h.providerKey === 'woocommerce')
  // İKİ AYRI SATIR — çökme YOK.
  assert.equal(woo.length, 2)
  const rowA = woo.find((h) => h.marketplaceAccountId === a.id)
  const rowB = woo.find((h) => h.marketplaceAccountId === b.id)
  assert.ok(rowA && rowB)
  // BAĞIMSIZ: biri sağlıklı, diğeri başarısız — çökme olsaydı EŞİT olurdu.
  assert.notEqual(rowA.sync, rowB.sync)
  // TEST DÜZELTİLDİ: ilk yazımda 'OK' bekledim; kanonik enum `HEALTHY`dir
  // (`SYNC_STATES`). Kod doğruydu, beklentim yanlıştı.
  assert.equal(rowA.sync, 'HEALTHY')
  assert.equal(rowB.sync, 'FAILED')
})

test('WOO-H-4/5: A kimliği SİLİNDİ → A ABSENT, B ETKİLENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-h-4')
  const a = await wooStoreWithWebhook(db, org, 'a.example.com', 'whs_a')
  const b = await wooStoreWithWebhook(db, org, 'b.example.com', 'whs_b')

  // A GEÇMİŞTE başarılı olmuştu.
  const { recordSyncState } = await import('./onboarding/onboardingRepository.ts')
  await recordSyncState(db, org, {
    provider: 'woocommerce',
    resource: 'orders',
    status: 'success',
    marketplaceAccountId: a.id,
    successfulSyncAt: new Date(),
  })

  // A'nın kimliği KALDIRILIR.
  await wooConnection.disconnectWooStore(db, {
    organizationId: org,
    marketplaceAccountId: a.id,
  })

  const withCredential = await credentialStore.listAccountsWithCredential(db, {
    organizationId: org,
    providerKey: 'woocommerce',
  })
  assert.equal(withCredential.includes(a.id), false)
  assert.equal(withCredential.includes(b.id), true)

  const presence = {}
  for (const account of [a.id, b.id]) {
    presence[`woocommerce::${account}`] = withCredential.includes(account)
      ? 'PRESENT'
      : 'ABSENT'
  }
  const health = await healthRepo.loadIntegrationHealth(db, {
    organizationId: org,
    nowMs: Date.now(),
    credentialsPresenceByConnection: presence,
  })
  const rowA = health.find((h) => h.marketplaceAccountId === a.id)
  const rowB = health.find((h) => h.marketplaceAccountId === b.id)

  // GEÇMİŞ BAŞARI silinmiş kimliği DİRİLTEMEZ (001B semantiği).
  assert.equal(rowA.credentials, 'UNKNOWN')
  assert.ok(rowA.reasons.some((r) => r.code === 'CREDENTIALS_ABSENT'))

  // TEST DÜZELTİLDİ: ilk yazımda `rowB.credentials !== 'UNKNOWN'` bekledim.
  // Bu, KABUL EDİLMİŞ sağlık semantiğine AYKIRIYDI: kimlik VARLIĞI
  // GEÇERLİLİK DEĞİLDİR — B hiç çalışmadığı için doğrulanmış başarı yoktur
  // ve `UNKNOWN` DOĞRU yanıttır. Kod doğruydu, beklentim yanlıştı.
  //
  // KARDEŞ İZOLASYONU'nun gerçek ölçüsü SEBEPTİR: A "kimlik YOK" der,
  // B DEMEZ. A'nın silinmesi B'yi ETKİLEMEMİŞTİR.
  assert.equal(
    rowB.reasons.some((r) => r.code === 'CREDENTIALS_ABSENT'),
    false,
    'kardeş mağazaya SIZMA',
  )
  assert.equal(rowB.sync, 'NEVER_RUN')

  // İŞ VERİSİ SİLİNMEDİ: hesap ve senkron geçmişi DURUYOR.
  const stillThere = await accounts.getAccountById(db, org, a.id)
  assert.ok(stillThere)
  const syncRows = await pglite.query(
    'select * from integration_sync_state where marketplace_account_id=$1',
    [a.id],
  )
  assert.equal(syncRows.rows.length, 1)
})

test('WOO-H-6: HİÇ hesap yoksa sağlayıcı yer tutucusu none KALIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-h-6')
  const health = await healthRepo.loadIntegrationHealth(db, {
    organizationId: org,
    nowMs: Date.now(),
  })
  const woo = health.filter((h) => h.providerKey === 'woocommerce')
  assert.equal(woo.length, 1)
  assert.equal(woo[0].connectionScope, 'none')
  // SAHTE KİMLİK ÜRETİLMEZ.
  assert.equal(woo[0].marketplaceAccountId, null)
})

test('WOO-H-7: ESKİ hesapsız senkron satırı legacy KALIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-h-7')
  const { recordSyncState } = await import('./onboarding/onboardingRepository.ts')
  await recordSyncState(db, org, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    marketplaceAccountId: null,
    successfulSyncAt: new Date(),
  })
  const health = await healthRepo.loadIntegrationHealth(db, {
    organizationId: org,
    nowMs: Date.now(),
  })
  const legacy = health.find(
    (h) => h.providerKey === 'trendyol' && h.connectionScope === 'legacy',
  )
  assert.ok(legacy, 'legacy bağlantı KORUNMALI')
  assert.equal(legacy.marketplaceAccountId, null)
})

/* ═══ YAYIN AŞAMASI / CANLI YAZMA ═════════════════════════════════════ */

test('WOO-R-1: Woo varsayılan aşaması pilot/ga DEĞİL', () => {
  const stage = catalog.resolveRolloutStage('woocommerce')
  assert.equal(stage, 'internal_test')
  assert.notEqual(stage, 'pilot')
  assert.notEqual(stage, 'ga')
})

test('WOO-R-2: internal_test KANONİK YAZIMI çalışma zamanında YAPAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-r-2')
  const account = await wooAccountFor(db, org, 'a.example.com')
  const { transport } = makeTransport([okResponse([wooOrderFixture()], { 'x-wp-totalpages': '1' })])

  let persistCalls = 0
  const result = await wooSync.syncWooOrdersForAccount(
    db,
    {
      organizationId: org,
      marketplaceAccountId: account.id,
      credentials: { storeUrl: 'https://a.example.com', consumerKey: 'k', consumerSecret: 's' },
      window: { before: '2026-09-20T00:00:00.000Z' },
      persistCanonical: async () => {
        persistCalls += 1
      },
    },
    { ...clientOptions(transport), maxPages: 5 },
  )
  // NORMALLEŞTİRME YAPILIR...
  assert.equal(result.normalization.orders.length, 1)
  // ...ama KANONİK YAZIM YAPILMAZ.
  assert.equal(persistCalls, 0)
  assert.equal(result.canonicalPersisted, false)
  assert.equal(result.liveWriteReason, 'ROLLOUT_STAGE_NOT_LIVE')

  // Webhook yolu da AYNI kapıya tabidir.
  const wh = await wooStoreWithWebhook(db, org, 'b.example.com', 'whs_b')
  const body = Buffer.from(JSON.stringify(wooOrderFixture()), 'utf8')
  const accepted = await wooIngest.ingestWooWebhook(db, {
    organizationId: org,
    marketplaceAccountId: wh.id,
    webhookSecret: 'whs_b',
    request: signedRequest(body, 'whs_b'),
  })
  let webhookPersistCalls = 0
  const processed = await wooIngest.processWooInboxItem(db, {
    organizationId: org,
    record: accepted.record,
    rawBody: body,
    persistCanonical: async () => {
      webhookPersistCalls += 1
    },
  })
  assert.equal(processed.processed, true)
  assert.equal(webhookPersistCalls, 0)
  assert.equal(processed.canonicalPersisted, false)
})

test('WOO-R-3: canlı olmayan aşama KARŞILAMA yan etkilerini TETİKLEYEMEZ', () => {
  const gate = liveGate.canTriggerFulfillmentSideEffects('woocommerce')
  assert.equal(gate.decision, 'BLOCKED_BY_ROLLOUT')
  assert.equal(gate.reasonCode, 'ROLLOUT_STAGE_NOT_LIVE')

  // Kapı SAĞLAYICI ADINA dallanmaz — aşama sürer.
  const source = readFileSync(join(here, 'connectors', 'liveWriteGate.ts'), 'utf8')
  const code = source
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  assert.equal(code.includes("'woocommerce'"), false, 'sağlayıcı adına dallanma')
  assert.equal(code.includes("'trendyol'"), false)
  assert.match(code, /stageAffectsLiveBehavior/)
})

test('WOO-R-4: Trendyol + Sürat ÜRETİM davranışı DEĞİŞMEDİ', () => {
  assert.equal(catalog.resolveRolloutStage('trendyol'), 'ga')
  assert.equal(liveGate.canPersistCanonicalOrders('trendyol').decision, 'ALLOWED')
  // Bilinmeyen sağlayıcı FAIL-CLOSED.
  assert.equal(liveGate.canPersistCanonicalOrders('bilinmeyen').decision, 'BLOCKED_BY_ROLLOUT')
})

/* ═══ ÖDEYEN ETKİLEŞİMİ ═══════════════════════════════════════════════ */

test('WOO-PAYER: Woo hesabı ACCOUNT_CONFIG_REQUIRED görünür, çıkarım YAPILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'woo-payer')
  const account = await wooAccountFor(db, org, 'a.example.com')
  const payerConfig = await import('./shipments/marketplacePayerConfig.ts')
  const view = await payerConfig.loadAccountPayerView(db, org)
  const row = view.find((r) => r.marketplaceAccountId === account.id)
  assert.ok(row)
  assert.equal(row.evidenceClass, 'ACCOUNT_CONFIG_REQUIRED')
  assert.equal(row.configurable, true)
  // Mağaza URL'i/anahtarı/statüsü ödeyen ÇIKARIMI ÜRETMEZ.
  assert.equal(row.payer, 'UNKNOWN')
})

/* ═══ KAYIT / ŞEMA ════════════════════════════════════════════════════ */

test('WOO-MIGRATION: 0013 migration KAYITLI ve GERÇEK migrator ile uygulanır', async (t) => {
  const journal = JSON.parse(
    readFileSync(join(here, '..', 'drizzle', 'meta', '_journal.json'), 'utf8'),
  )
  const entry = journal.entries.find((e) => e.tag === '0013_woocommerce_connector')
  assert.ok(entry, 'journal kaydı ZORUNLU')

  const { pglite } = await makeDb()
  t.after(() => pglite.close())
  // Yeni tablolar GERÇEKTEN oluştu.
  for (const table of ['connector_credentials', 'connector_webhook_inbox']) {
    const rows = await pglite.query(
      `select count(*)::int as n from information_schema.tables where table_name=$1`,
      [table],
    )
    assert.equal(rows.rows[0].n, 1, `${table} OLUŞMALI`)
  }
  // Çok mağazalı engel KALKTI.
  const index = await pglite.query(
    `select count(*)::int as n from pg_indexes where indexname='marketplace_accounts_single_active_unique'`,
  )
  assert.equal(index.rows[0].n, 0, 'tek-aktif kısıtı KALKMALI')
  // ESKİ kimlik tablosu YIKILMADI.
  const legacy = await pglite.query(
    `select count(*)::int as n from information_schema.tables where table_name='integration_credentials'`,
  )
  assert.equal(legacy.rows[0].n, 1, 'eski tablo KORUNMALI')
})
