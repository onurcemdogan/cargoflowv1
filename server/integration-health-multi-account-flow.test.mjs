// INTEGRATION-HEALTH-001A — ÇOK HESAPLI / BAĞLANTI KAPSAMLI SAĞLIK.
//
// ═══ ÖLÇÜLEN KUSUR (yamadan ÖNCE yeniden üretildi) ═══════════════════════
//
// Sağlık deposu satırları `Map<providerKey, …>` ile topluyordu. Oysa
// `integration_sync_state` kimliği (org, provider, resource, ACCOUNT)
// dörtlüsüdür ve CONNECTOR-KERNEL-001 kanonik kimliği "organizasyon +
// sağlayıcı + mağaza/hesap + varlık" olarak tanımlamıştı.
//
// Üretilen kanıt: aynı org + aynı sağlayıcı + İKİ farklı hesap →
//
//   DB satırı            : 2
//   Sağlık sonucu        : 1        ← ÇÖKTÜ
//   Hesap kimliği        : YOK
//   Görünen durum        : `Map.set()`i EN SON kazanan satır
//
// Yani SAĞLIKLI bir mağaza, KİMLİK HATASI olan diğerinin arkasında
// GÖRÜNMEZ oluyordu. Bu dosya o davranışın geri gelmesini engeller.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const health = await import('./connectors/integrationHealth.ts')
const repo = await import('./connectors/integrationHealthRepository.ts')
const onboarding = await import('./onboarding/onboardingRepository.ts')

const NOW = Date.parse('2026-09-20T12:00:00.000Z')
const MIN = 60_000

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
    resource: over.resource ?? 'orders',
    lastSyncStatus: over.lastSyncStatus ?? 'success',
    lastSuccessfulSyncAt: 'lastSuccessfulSyncAt' in over
      ? over.lastSuccessfulSyncAt
      : new Date(NOW - MIN),
    lastErrorCode: over.lastErrorCode ?? null,
    lastFetchedCount: over.lastFetchedCount ?? 3,
    updatedAt: over.updatedAt ?? new Date(NOW - MIN),
  })
}

const load = (db, over = {}) =>
  repo.loadIntegrationHealth(db, { nowMs: NOW, ...over })

const wooOf = (entries) => entries.filter((e) => e.providerKey === 'woocommerce')

// ── ÇÖKME KUSURU ───────────────────────────────────────────────────────────

test('IHA-1: ayni saglayici + IKI hesap → IKI ayri saglik sonucu', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-1')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  await insertSyncRow(db, org, { marketplaceAccountId: a })
  await insertSyncRow(db, org, { marketplaceAccountId: b })

  const woo = wooOf(await load(db, { organizationId: org }))
  assert.equal(woo.length, 2, 'iki baglanti BIRLESTIRILMEZ')
  assert.deepEqual(
    woo.map((entry) => entry.marketplaceAccountId).sort(),
    [a, b].sort(),
    'her sonuc KENDI hesap kimligini tasir',
  )
  assert.equal(new Set(woo.map((e) => e.connectionKey)).size, 2, 'anahtarlar AYRISIR')
})

test('IHA-2: A saglikli + B AUTH hatasi → durumlar BAGIMSIZ kalir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-2')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  await insertSyncRow(db, org, { marketplaceAccountId: a })
  await insertSyncRow(db, org, {
    marketplaceAccountId: b,
    lastSyncStatus: 'failed',
    lastSuccessfulSyncAt: null,
    lastErrorCode: 'HTTP_401_UNAUTHORIZED',
    updatedAt: new Date(NOW - 30_000),
  })

  const woo = wooOf(
    await load(db, {
      organizationId: org,
      // Iki magazanin da kimlik bilgisi GIRILMIS; B'ninki saglayicida REDDEDILIYOR.
      credentialsPresentByProvider: { woocommerce: true },
    }),
  )
  const healthy = woo.find((entry) => entry.marketplaceAccountId === a)
  const broken = woo.find((entry) => entry.marketplaceAccountId === b)

  assert.equal(healthy.sync, 'HEALTHY')
  assert.equal(healthy.credentials, 'VALID')
  assert.equal(healthy.connection, 'CONNECTED')

  assert.equal(broken.sync, 'FAILED')
  assert.equal(broken.credentials, 'INVALID')
  assert.equal(broken.connection, 'DISCONNECTED')
  assert.equal(broken.lastErrorClass, 'AUTH')

  // BOZUK hesap SAGLIKLI hesabi ETKILEMEZ.
  assert.notEqual(healthy.credentials, broken.credentials)
  assert.ok(healthy.lastSuccessfulSyncAt, 'saglikli magaza GORUNUR kalir')
})

test('IHA-3: ekleme/sorgu sirasi TERSINE cevrilse de sonuc AYNI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgForward = await makeOrg(db, 'iha-3-f')
  const orgReverse = await makeOrg(db, 'iha-3-r')

  for (const [org, reversed] of [[orgForward, false], [orgReverse, true]]) {
    const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
    const b = await makeAccount(db, org, 'woocommerce', 'store-2')
    const rows = [
      { marketplaceAccountId: a },
      {
        marketplaceAccountId: b,
        lastSyncStatus: 'failed',
        lastSuccessfulSyncAt: null,
        lastErrorCode: 'AUTH_FAILED',
      },
    ]
    for (const row of reversed ? [...rows].reverse() : rows) {
      await insertSyncRow(db, org, row)
    }
  }

  const forward = wooOf(await load(db, { organizationId: orgForward }))
  const reverse = wooOf(await load(db, { organizationId: orgReverse }))
  assert.equal(forward.length, 2)
  assert.equal(reverse.length, 2)
  // Kimlikler org'a gore farkli; SEMANTIK sonuc ayni olmali.
  const shape = (entries) =>
    entries
      .map((e) => `${e.sync}|${e.credentials}|${e.connection}|${e.connectionScope}`)
      .sort()
  assert.deepEqual(shape(forward), shape(reverse), 'sonuc EKLEME SIRASINDAN bagimsiz')
})

test('IHA-10: bir hesabin sagligi digerini Map.set(provider) ile EZEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-10')
  const ids = []
  for (let i = 0; i < 4; i += 1) {
    const id = await makeAccount(db, org, 'woocommerce', `store-${i}`, i === 0)
    ids.push(id)
    await insertSyncRow(db, org, {
      marketplaceAccountId: id,
      // Her hesap FARKLI durumda.
      ...(i % 2 === 0
        ? {}
        : { lastSyncStatus: 'failed', lastSuccessfulSyncAt: null, lastErrorCode: 'PROVIDER_503' }),
    })
  }
  const woo = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresentByProvider: { woocommerce: true },
    }),
  )
  assert.equal(woo.length, 4, 'DORT baglanti DORT sonuc')
  assert.equal(new Set(woo.map((e) => e.marketplaceAccountId)).size, 4)
  assert.equal(woo.filter((e) => e.sync === 'HEALTHY').length, 2)
  assert.equal(woo.filter((e) => e.sync === 'FAILED').length, 2)

  // Kaynakta saglayici anahtarli TOPLAMA geri gelmemeli.
  const source = readFileSync(join(here, 'connectors', 'integrationHealthRepository.ts'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  assert.equal(
    /new Map<string,\s*StoredSyncState>/.test(code),
    false,
    'saglayici anahtarli toplama YASAK',
  )
  assert.match(code, /marketplaceAccountId: integrationSyncState\.marketplaceAccountId/)
})

// ── KAPSAMLI GİRDİLER ──────────────────────────────────────────────────────

test('IHA-4: kimlik varligi HESAP KAPSAMLIDIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-4')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  // Iki hesap da HIC senkron etmemis → kimlik gecerliligi KANITLANMAMIS.
  await insertSyncRow(db, org, { marketplaceAccountId: a, lastSyncStatus: null, lastSuccessfulSyncAt: null })
  await insertSyncRow(db, org, { marketplaceAccountId: b, lastSyncStatus: null, lastSuccessfulSyncAt: null })

  const woo = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresentByConnection: {
        [health.connectionKey('woocommerce', a)]: true,
        [health.connectionKey('woocommerce', b)]: false,
      },
    }),
  )
  const withCreds = woo.find((e) => e.marketplaceAccountId === a)
  const without = woo.find((e) => e.marketplaceAccountId === b)
  assert.equal(withCreds.connection, 'CONNECTED')
  assert.equal(withCreds.credentials, 'UNKNOWN', 'alan varligi gecerlilik KANITI degil')
  assert.equal(without.connection, 'NOT_CONFIGURED', 'kimligi olmayan hesap AYRI gorunur')

  // ESKI saglayici geneli girdi, hesap gercegini EZEMEZ.
  const overridden = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresentByProvider: { woocommerce: true },
      credentialsPresentByConnection: { [health.connectionKey('woocommerce', b)]: false },
    }),
  )
  assert.equal(
    overridden.find((e) => e.marketplaceAccountId === b).connection,
    'NOT_CONFIGURED',
    'hesaba ozel deger saglayici geneli girdiyi YENER',
  )
})

test('IHA-5: webhook gozlemi HESAP KAPSAMLIDIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-5')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  await insertSyncRow(db, org, { marketplaceAccountId: a })
  await insertSyncRow(db, org, { marketplaceAccountId: b })

  const woo = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresentByProvider: { woocommerce: true },
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

// ── KİRACI VE ESKİ BAĞLANTI ────────────────────────────────────────────────

test('IHA-6: kiraci A, kiraci Bnin HICBIR hesabini goremez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'iha-6-a')
  const orgB = await makeOrg(db, 'iha-6-b')
  const b1 = await makeAccount(db, orgB, 'woocommerce', 'b-store-1', true)
  const b2 = await makeAccount(db, orgB, 'woocommerce', 'b-store-2')
  await insertSyncRow(db, orgB, { marketplaceAccountId: b1 })
  await insertSyncRow(db, orgB, { marketplaceAccountId: b2 })

  const aEntries = await load(db, { organizationId: orgA })
  const aAccounts = aEntries.map((e) => e.marketplaceAccountId).filter(Boolean)
  assert.equal(aAccounts.length, 0, 'A hicbir hesap kimligi GORMEZ')
  for (const leaked of [b1, b2]) {
    assert.equal(JSON.stringify(aEntries).includes(leaked), false, `sizinti: ${leaked}`)
  }
  assert.equal(wooOf(await load(db, { organizationId: orgB })).length, 2)
})

test('IHA-7: hesapsiz ESKI baglanti kendi kapsaminda KALIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-7')
  const account = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  // Biri hesapli, biri LEGACY (hesap kimligi NULL).
  await insertSyncRow(db, org, { marketplaceAccountId: account })
  await insertSyncRow(db, org, {
    marketplaceAccountId: null,
    lastSyncStatus: 'failed',
    lastSuccessfulSyncAt: null,
    lastErrorCode: 'NETWORK_TIMEOUT',
  })

  const woo = wooOf(
    await load(db, {
      organizationId: org,
      credentialsPresentByProvider: { woocommerce: true },
    }),
  )
  assert.equal(woo.length, 2, 'legacy baglanti AYRI kayittir')
  const legacy = woo.find((e) => e.connectionScope === 'legacy')
  const scoped = woo.find((e) => e.connectionScope === 'account')
  assert.ok(legacy && scoped)
  assert.equal(legacy.marketplaceAccountId, null, 'sahte id URETILMEZ')
  assert.equal(legacy.connectionKey, 'woocommerce::legacy')
  assert.equal(legacy.sync, 'FAILED')
  assert.equal(scoped.sync, 'HEALTHY', 'legacy hatasi hesapli baglantiyi ETKILEMEZ')
})

test('IHA-9: desteklenen ama BAGLANMAMIS saglayici sahte id ALMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-9')
  const entries = await load(db, { organizationId: org })

  for (const providerKey of ['trendyol', 'woocommerce', 'ikas', 'ticimax']) {
    const entry = entries.find((e) => e.providerKey === providerKey)
    assert.ok(entry, `${providerKey} listede kalmali (dogru gorunurluk)`)
    assert.equal(entry.connectionScope, 'none', `${providerKey}: baglanti YOK`)
    assert.equal(entry.marketplaceAccountId, null, `${providerKey}: sahte id URETILMEMELI`)
    assert.equal(entry.sync, 'NEVER_RUN')
  }
  // 'none' ile 'legacy' AYNI SEY DEGIL.
  assert.notEqual(health.CONNECTION_SCOPES.indexOf('none'), health.CONNECTION_SCOPES.indexOf('legacy'))
})

// ── TRENDYOL UYUMU ─────────────────────────────────────────────────────────

test('IHA-8: TEK hesapli Trendyol sonucu DAVRANIS OLARAK uyumlu kalir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-8')
  const account = await makeAccount(db, org, 'Trendyol', '277221', true)
  await insertSyncRow(db, org, { provider: 'trendyol', marketplaceAccountId: account })

  const entries = await load(db, {
    organizationId: org,
    credentialsPresentByProvider: { trendyol: true },
  })
  const trendyol = entries.filter((e) => e.providerKey === 'trendyol')
  assert.equal(trendyol.length, 1, 'tek hesap → TEK sonuc')
  const only = trendyol[0]
  assert.equal(only.sync, 'HEALTHY')
  assert.equal(only.credentials, 'VALID')
  assert.equal(only.connection, 'CONNECTED')
  assert.equal(only.overall, 'OPERATIONAL')
  assert.equal(only.rolloutStage, 'ga')
  // TEK FARK: hesap kimligi artik KORUNUYOR.
  assert.equal(only.marketplaceAccountId, account)
  assert.equal(only.connectionScope, 'account')
})

// ── CHECKPOINT SEMANTİĞİ (MEVCUT DAVRANIŞ KİLİTLENİR) ─────────────────────

async function readState(db, organizationId, accountId) {
  const [row] = await db
    .select()
    .from(schema.integrationSyncState)
    .where(eq(schema.integrationSyncState.organizationId, organizationId))
  return row
}

test('IHA-11: partial IMLECI ILERLETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-11')
  const account = await makeAccount(db, org, 'Trendyol', '277221', true)
  const first = new Date(NOW - 10 * MIN)

  await onboarding.recordSyncState(db, org, {
    provider: 'trendyol', resource: 'orders', status: 'success',
    marketplaceAccountId: account, successfulSyncAt: first,
  })
  await onboarding.recordSyncState(db, org, {
    provider: 'trendyol', resource: 'orders', status: 'partial',
    marketplaceAccountId: account, successfulSyncAt: new Date(NOW),
  })

  const row = await readState(db, org, account)
  assert.equal(
    row.lastSuccessfulSyncAt.toISOString(),
    first.toISOString(),
    'partial ONCEKI basarili imleci EZMEZ',
  )
  assert.equal(row.lastSyncStatus, 'partial')
})

test('IHA-12: failed IMLECI ILERLETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-12')
  const account = await makeAccount(db, org, 'Trendyol', '277221', true)
  const first = new Date(NOW - 10 * MIN)

  await onboarding.recordSyncState(db, org, {
    provider: 'trendyol', resource: 'orders', status: 'success',
    marketplaceAccountId: account, successfulSyncAt: first,
  })
  await onboarding.recordSyncState(db, org, {
    provider: 'trendyol', resource: 'orders', status: 'failed',
    marketplaceAccountId: account, errorCode: 'HTTP_500',
    successfulSyncAt: new Date(NOW),
  })

  const row = await readState(db, org, account)
  assert.equal(row.lastSuccessfulSyncAt.toISOString(), first.toISOString())
  assert.equal(row.lastSyncStatus, 'failed')
  assert.equal(row.lastErrorCode, 'HTTP_500')
})

test('IHA-13: success imleci TAM OLARAK verilen pencere ustune yazar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-13')
  const account = await makeAccount(db, org, 'Trendyol', '277221', true)
  const windowEnd = new Date(NOW - 3 * MIN)

  await onboarding.recordSyncState(db, org, {
    provider: 'trendyol', resource: 'orders', status: 'success',
    marketplaceAccountId: account, successfulSyncAt: windowEnd,
  })
  const row = await readState(db, org, account)
  assert.equal(
    row.lastSuccessfulSyncAt.toISOString(),
    windowEnd.toISOString(),
    'imlec `now` DEGIL, PENCERE UST SINIRIDIR',
  )
  assert.notEqual(row.lastSuccessfulSyncAt.toISOString(), new Date(NOW).toISOString())
})

// ── GÖRÜNÜM ────────────────────────────────────────────────────────────────

test('IHA-14b: gorunum katmani iki baglantiyi AYRI ve GUVENLI etiketler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iha-14')
  const a = await makeAccount(db, org, 'woocommerce', 'store-1', true)
  const b = await makeAccount(db, org, 'woocommerce', 'store-2')
  await insertSyncRow(db, org, { marketplaceAccountId: a })
  await insertSyncRow(db, org, { marketplaceAccountId: b })

  const views = wooOf(await load(db, { organizationId: org })).map((entry) =>
    repo.toHealthView(entry, 'WooCommerce'),
  )
  assert.equal(views.length, 2)
  assert.equal(new Set(views.map((v) => v.connectionLabel)).size, 2, 'etiketler AYRISIR')
  for (const view of views) {
    // Kanonik kimlik hesap kimligidir; etiket YALNIZ gosterimdir.
    assert.ok(view.marketplaceAccountId)
    assert.match(view.connectionLabel, /^WooCommerce · [0-9a-f]{8}$/)
    // Etikette tam uuid ya da gizli veri OLMAMALI.
    assert.equal(view.connectionLabel.includes(view.marketplaceAccountId), false)
  }
  // Legacy ve baglanmamis etiketleri de AYRI.
  assert.equal(repo.connectionLabelOf('WooCommerce', null, 'legacy'), 'WooCommerce (eski bağlantı)')
  assert.equal(repo.connectionLabelOf('WooCommerce', null, 'none'), 'WooCommerce')
})
