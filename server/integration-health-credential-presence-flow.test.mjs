// INTEGRATION-HEALTH-001B — ŞU ANKİ KİMLİK VARLIĞI GERÇEĞİ.
//
// ═══ ÖLÇÜLEN KUSUR (yamadan ÖNCE üretildi) ═══════════════════════════════
//
//   credentialsPresent : false  (AÇIKÇA YOK)
//   geçmiş başarı      : VAR
//   → connection CONNECTED · credentials VALID · overall OPERATIONAL
//
// Yani kimlik bilgisi SİLİNMİŞ bir bağlantı, eski bir başarılı senkron
// sayesinde DİRİLİYORDU.
//
// ═══ AYRIM ═══════════════════════════════════════════════════════════════
//
// GEÇMİŞTE başarılı bir kimlik doğrulanmış okuma, o kimliğin O ZAMAN geçerli
// olduğunu kanıtlar — BUGÜN HÂLÂ DURDUĞUNU DEĞİL. Ayrıca tek bir boolean
// "açıkça YOK" ile "BİLMİYORUZ"u ayıramaz; bu yüzden varlık ÜÇ DURUMLUDUR
// ve `ABSENT`, `UNKNOWN`DAN DAHA GÜÇLÜ kanıttır.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const health = await import('./connectors/integrationHealth.ts')
const repo = await import('./connectors/integrationHealthRepository.ts')
const catalog = await import('./connectors/providerCatalog.ts')

const NOW = Date.parse('2026-09-20T12:00:00.000Z')
const MIN = 60_000
const registry = catalog.buildProviderCatalog()

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
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

async function makeAccount(db, organizationId, marketplace, providerAccountId, isActive = false) {
  const [account] = await db
    .insert(schema.marketplaceAccounts)
    .values({ organizationId, marketplace, providerAccountId, isActive })
    .returning()
  return account.id
}

async function insertSyncRow(db, organizationId, over = {}) {
  await db.insert(schema.integrationSyncState).values({
    organizationId,
    marketplaceAccountId: over.marketplaceAccountId ?? null,
    provider: over.provider ?? 'woocommerce',
    resource: 'orders',
    lastSyncStatus: over.lastSyncStatus ?? 'success',
    lastSuccessfulSyncAt:
      'lastSuccessfulSyncAt' in over ? over.lastSuccessfulSyncAt : new Date(NOW - MIN),
    lastErrorCode: over.lastErrorCode ?? null,
    lastFetchedCount: over.lastFetchedCount ?? 3,
    updatedAt: over.updatedAt ?? new Date(NOW - MIN),
  })
}

const load = (db, over = {}) => repo.loadIntegrationHealth(db, { nowMs: NOW, ...over })
const wooOf = (entries) => entries.filter((e) => e.providerKey === 'woocommerce')

/** Geçmişte BAŞARILI senkronu olan bir Trendyol bağlantısı. */
function resolveWith(over = {}) {
  return health.resolveIntegrationHealth({
    descriptor: registry.get('trendyol'),
    rolloutStage: 'ga',
    marketplaceAccountId: 'acc-1',
    connectionScope: 'account',
    syncState: {
      lastSyncStatus: 'success',
      lastSuccessfulSyncAt: new Date(NOW - 5 * MIN),
      lastErrorCode: null,
      lastFetchedCount: 7,
      updatedAt: new Date(NOW - 5 * MIN),
    },
    nowMs: NOW,
    ...over,
  })
}

// ── ÇEKİRDEK KURAL ─────────────────────────────────────────────────────────

test('IHB-1: gecmis basari + kimlik SIMDI YOK → NOT_CONFIGURED, VALID DEGIL', () => {
  const result = resolveWith({ credentialsPresence: 'ABSENT' })
  assert.equal(result.connection, 'NOT_CONFIGURED')
  assert.notEqual(result.credentials, 'VALID', 'silinmis kimlik gecmisle DIRILEMEZ')
  assert.equal(result.credentials, 'UNKNOWN')
  assert.equal(result.overall, 'NOT_CONFIGURED')
  assert.ok(result.reasons.some((r) => r.code === 'CREDENTIALS_ABSENT'))
  // Eski boolean girdi de `false` ise AYNI sonucu vermeli.
  assert.equal(resolveWith({ credentialsPresent: false }).connection, 'NOT_CONFIGURED')
})

test('IHB-2: gecmis basari + kimlik SIMDI VAR → CONNECTED + VALID', () => {
  const result = resolveWith({ credentialsPresence: 'PRESENT' })
  assert.equal(result.connection, 'CONNECTED')
  assert.equal(result.credentials, 'VALID')
  assert.equal(result.overall, 'OPERATIONAL')
})

test('IHB-3: kimlik VAR + AUTH reddi → INVALID / DISCONNECTED / ACTION_REQUIRED', () => {
  const result = resolveWith({
    credentialsPresence: 'PRESENT',
    syncState: {
      lastSyncStatus: 'failed',
      lastSuccessfulSyncAt: new Date(NOW - 60 * MIN),
      lastErrorCode: 'HTTP_401_UNAUTHORIZED',
      lastFetchedCount: 0,
      updatedAt: new Date(NOW - MIN),
    },
  })
  assert.equal(result.credentials, 'INVALID')
  assert.equal(result.connection, 'DISCONNECTED')
  assert.equal(result.overall, 'ACTION_REQUIRED')
  assert.equal(result.lastErrorClass, 'AUTH')
})

test('IHB-4: kimlik BILINMIYOR + gecmis basari → gecmis kanit KULLANILABILIR', () => {
  const explicit = resolveWith({ credentialsPresence: 'UNKNOWN' })
  assert.equal(explicit.credentials, 'VALID')
  assert.equal(explicit.connection, 'CONNECTED')
  // Hicbir girdi verilmezse de UNKNOWN varsayilir — ABSENT UYDURULMAZ.
  const implicit = resolveWith({})
  assert.equal(implicit.credentials, 'VALID')
  assert.equal(implicit.connection, 'CONNECTED')
})

test('IHB-5: kimlik BILINMIYOR + gecmis basari YOK → UNKNOWN, VALID DEGIL', () => {
  const result = resolveWith({ credentialsPresence: 'UNKNOWN', syncState: null })
  assert.equal(result.credentials, 'UNKNOWN')
  assert.notEqual(result.credentials, 'VALID')
  assert.equal(result.connection, 'NOT_CONFIGURED')
})

test('IHB-A: ABSENT ile UNKNOWN AYNI SEY DEGILDIR', () => {
  const absent = resolveWith({ credentialsPresence: 'ABSENT' })
  const unknown = resolveWith({ credentialsPresence: 'UNKNOWN' })
  assert.notEqual(absent.connection, unknown.connection)
  assert.notEqual(absent.credentials, unknown.credentials)
  assert.deepEqual([...health.CREDENTIAL_PRESENCE], ['PRESENT', 'ABSENT', 'UNKNOWN'])
})

// ── ÇOK HESAPLI YALITIM ────────────────────────────────────────────────────

test('IHB-6/8/9: A VAR + B YOK, ikisinin de gecmis basarisi var', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ihb-6')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  await insertSyncRow(db, org, { marketplaceAccountId: a })
  await insertSyncRow(db, org, { marketplaceAccountId: b })

  const woo = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresenceByConnection: {
        [health.connectionKey('woocommerce', a)]: 'PRESENT',
        [health.connectionKey('woocommerce', b)]: 'ABSENT',
      },
    }),
  )
  const kept = woo.find((e) => e.marketplaceAccountId === a)
  const removed = woo.find((e) => e.marketplaceAccountId === b)

  assert.equal(kept.connection, 'CONNECTED')
  assert.equal(kept.credentials, 'VALID')
  assert.equal(removed.connection, 'NOT_CONFIGURED')
  assert.notEqual(removed.credentials, 'VALID')
  // IHB-8: bir hesabin kimlik durumu kardesine SIZMAZ.
  assert.notEqual(kept.connection, removed.connection)
  // IHB-9: kardinalite 2 → 2 KORUNUR.
  assert.equal(woo.length, 2)
})

test('IHB-7: hesaba ozel ABSENT, saglayici geneli PRESENTI EZER', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ihb-7')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  await insertSyncRow(db, org, { marketplaceAccountId: a })
  await insertSyncRow(db, org, { marketplaceAccountId: b })

  const woo = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresenceByProvider: { woocommerce: 'PRESENT' },
      credentialsPresenceByConnection: {
        [health.connectionKey('woocommerce', b)]: 'ABSENT',
      },
    }),
  )
  assert.equal(woo.find((e) => e.marketplaceAccountId === a).connection, 'CONNECTED')
  assert.equal(
    woo.find((e) => e.marketplaceAccountId === b).connection,
    'NOT_CONFIGURED',
    'hesap gercegi saglayici genelini YENER',
  )
})

test('IHB-10: WooCommerce webhook yalitimi DEGISMEDI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ihb-10')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  await insertSyncRow(db, org, { marketplaceAccountId: a })
  await insertSyncRow(db, org, { marketplaceAccountId: b })

  const woo = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresenceByProvider: { woocommerce: 'PRESENT' },
      webhookByConnection: {
        [health.connectionKey('woocommerce', a)]: {
          configured: true,
          lastReceivedAt: new Date(NOW - MIN),
        },
        [health.connectionKey('woocommerce', b)]: {
          configured: true,
          disabledAt: new Date(NOW - 10 * MIN),
        },
      },
    }),
  )
  assert.equal(woo.find((e) => e.marketplaceAccountId === a).webhook, 'HEALTHY')
  assert.equal(woo.find((e) => e.marketplaceAccountId === b).webhook, 'DISABLED')
})

test('IHB-11: tek hesapli Trendyol, kimlik PRESENT iken UYUMLU kalir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ihb-11')
  const account = await makeAccount(db, org, 'Trendyol', '277221', true)
  await insertSyncRow(db, org, { provider: 'trendyol', marketplaceAccountId: account })

  const [only] = (
    await load(db, {
      organizationId: org,
      credentialsPresenceByProvider: { trendyol: 'PRESENT' },
    })
  ).filter((e) => e.providerKey === 'trendyol')

  assert.equal(only.sync, 'HEALTHY')
  assert.equal(only.credentials, 'VALID')
  assert.equal(only.connection, 'CONNECTED')
  assert.equal(only.overall, 'OPERATIONAL')
  assert.equal(only.rolloutStage, 'ga')
  assert.equal(only.marketplaceAccountId, account)
})

// ── GİZLİLİK ───────────────────────────────────────────────────────────────

test('IHB-12: saglik ciktisi HICBIR kimlik/sir degeri TASIMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ihb-12')
  const account = await makeAccount(db, org, 'woocommerce', 'ck_live_SECRETKEY', true)
  await insertSyncRow(db, org, {
    marketplaceAccountId: account,
    lastSyncStatus: 'failed',
    lastSuccessfulSyncAt: null,
    lastErrorCode: 'Bearer ck_live_SECRETKEY cs_live_OTHER https://shop.example.com',
  })

  const entries = await load(db, {
    organizationId: org,
    credentialsPresenceByProvider: { woocommerce: 'PRESENT' },
  })
  const serialized = JSON.stringify(entries)
  for (const secret of ['ck_live_SECRETKEY', 'cs_live_OTHER', 'shop.example.com', 'Bearer']) {
    assert.equal(serialized.includes(secret), false, `saglik ciktisina sizdi: ${secret}`)
  }
  const views = JSON.stringify(entries.map((entry) => repo.toHealthView(entry, 'WooCommerce')))
  for (const secret of ['ck_live_SECRETKEY', 'cs_live_OTHER', 'shop.example.com']) {
    assert.equal(views.includes(secret), false, `gorunume sizdi: ${secret}`)
  }
})

// ── UÇ NOKTA ───────────────────────────────────────────────────────────────

test('IHB-13: uc nokta UYDURMAZ — gozlenemeyen saglayici UNKNOWN bildirir', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = source.indexOf("app.get('/api/integrations/health'")
  assert.ok(start > 0, 'saglik ucu bulunamadi')
  const block = source.slice(start, source.indexOf('\n})', start))
  // Trendyol gozlenebilir → uc durumlu esleme yapilir.
  assert.match(block, /credentialsPresenceByProvider/)
  assert.match(block, /'PRESENT'/)
  assert.match(block, /'ABSENT'/)
  assert.match(block, /'UNKNOWN'/)
  // Diger saglayicilar icin UYDURMA deger yazilmamali.
  for (const fabricated of ['woocommerce:', 'ikas:', 'ticimax:']) {
    assert.equal(
      block.includes(fabricated),
      false,
      `kimlik kaliciligi olmayan saglayici icin uydurma deger: ${fabricated}`,
    )
  }
})
