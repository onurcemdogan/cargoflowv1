// INTEGRATION-HEALTH — SAĞLAYICI ANAHTARI KANONİKLEŞTİRME.
//
// ═══ ÖLÇÜLEN KUSUR (yamadan ÖNCE üretildi) ═══════════════════════════════
//
// Üretimdeki Trendyol hesap yolu `marketplace_accounts.marketplace = 'Trendyol'`
// yazar. Sağlık, henüz senkron etmemiş hesapları SQL'de
//
//   inArray(marketplaceAccounts.marketplace, ['trendyol', 'woocommerce', …])
//
// ile süzüyordu. PostgreSQL metin karşılaştırması büyük/küçük harfe
// DUYARLIDIR: GERÇEK bir Trendyol hesabı listelenmiyor, sağlık
// `connectionScope: 'none'` / `marketplaceAccountId: null` yer tutucusuna
// düşüyordu. İlk hesap kapsamlı senkron satırı (`provider` zaten küçük
// harfli) yazılınca kusur GÖRÜNMEZ oluyordu.
//
// Gerçek Postgres motoru (PGlite) + GERÇEK göçler + GERÇEK üretim yardımcıları.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

const here = dirname(fileURLToPath(import.meta.url))
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const healthService = await import('./connectors/integrationHealthService.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const credentials = await import('./integrations/credentialService.ts')
const connectorStore = await import('./connectors/connectorCredentialStore.ts')
const syncRepo = await import('./onboarding/onboardingRepository.ts')
const onboarding = await import('./onboarding/onboardingService.ts')

const NOW = Date.parse('2026-09-24T12:00:00.000Z')

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
async function makeOrg(db) {
  const slug = `canon-${randomBytes(4).toString('hex')}`
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

/** GERÇEK üretim yolu: kimlik kaydı + `resolveOrCreateActiveAccount`. */
async function connectTrendyol(db, org, sellerId = '111') {
  await credentials.saveIntegrationCredential(db, org, 'trendyol', {
    sellerId,
    apiKey: 'k',
    apiSecret: 's',
  })
  return accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', sellerId)
}
const loadHealth = (db, org, resource) =>
  healthService.loadIntegrationHealthForOrganization(db, {
    organizationId: org,
    nowMs: NOW,
    ...(resource ? { resource } : {}),
  })
const trendyolOf = (entries) => entries.filter((entry) => entry.providerKey === 'trendyol')

/* ─────────────────────────────────────────────────────────────────────── */

test('IH-CANON-1/2: senkron ETMEMİŞ gerçek Trendyol hesabı GERÇEK kimlikle, TEK kayıt', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  // Üretim yardımcısı GERÇEKTEN büyük harfli yazar — test bunu varsaymaz, ÖLÇER.
  assert.equal(account.marketplace, 'Trendyol')
  assert.equal((await db.select().from(schema.integrationSyncState)).length, 0)

  const entries = trendyolOf(await loadHealth(db, org))
  assert.equal(entries.length, 1, 'trendyol::account + trendyol::none ÇİFTİ YOK')
  const [entry] = entries
  assert.equal(entry.providerKey, 'trendyol')
  assert.equal(entry.marketplaceAccountId, account.id, 'GERÇEK hesap UUID')
  assert.equal(entry.connectionScope, 'account')
  assert.equal(entry.sync, 'NEVER_RUN')
  assert.equal(entry.connectionKey, `trendyol::${account.id}`)
})

test('IH-CANON-3: kimlik VAR + gerçek hesap + NEVER_RUN → VALID uydurulmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  const [entry] = trendyolOf(await loadHealth(db, org))
  assert.equal(entry.marketplaceAccountId, account.id)
  assert.equal(entry.connection, 'CONNECTED')
  // Varlık KANIT değildir: başarılı okuma olmadan VALID denmez.
  assert.equal(entry.credentials, 'UNKNOWN')
  assert.ok(entry.reasons.some((reason) => reason.code === 'CREDENTIALS_NOT_PROVEN'))
  assert.ok(entry.reasons.some((reason) => reason.code === 'SYNC_NEVER_RUN'))
})

test('IH-CANON-4: kimlik YOK + gerçek hesap (geçmişli/geçmişsiz) → NOT_CONFIGURED', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  // (a) geçmiş yok
  const fresh = await makeOrg(db)
  const freshAccount = await connectTrendyol(db, fresh)
  await credentials.deleteIntegrationCredential(db, fresh, 'trendyol')
  const [a] = trendyolOf(await loadHealth(db, fresh))
  assert.equal(a.marketplaceAccountId, freshAccount.id)
  assert.equal(a.connection, 'NOT_CONFIGURED')
  assert.equal(a.sync, 'NEVER_RUN')

  // (b) geçmişte BAŞARILI senkron var, kimlik sonradan silindi
  const old = await makeOrg(db)
  const oldAccount = await connectTrendyol(db, old)
  await syncRepo.recordSyncState(db, old, {
    provider: 'trendyol', resource: 'orders', status: 'success', marketplaceAccountId: oldAccount.id,
  })
  await credentials.deleteIntegrationCredential(db, old, 'trendyol')
  const [b] = trendyolOf(await loadHealth(db, old))
  assert.equal(b.marketplaceAccountId, oldAccount.id)
  assert.equal(b.connection, 'NOT_CONFIGURED', 'eski başarı silinmiş kimliği DİRİLTMEZ')
})

test('IH-CANON-5: küçük harfli Woo hesapları AYNEN listelenir; çok mağaza bağımsız', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const storeA = await accounts.ensureAccount(db, org, 'woocommerce', 'a.example')
  const storeB = await accounts.ensureAccount(db, org, 'woocommerce', 'b.example')
  assert.equal(storeA.marketplace, 'woocommerce')
  await connectorStore.saveConnectorCredential(db, {
    organizationId: org,
    marketplaceAccountId: storeA.id,
    providerKey: 'woocommerce',
    payload: { consumerKey: 'ck', consumerSecret: 'cs' },
  })
  const woo = (await loadHealth(db, org)).filter((entry) => entry.providerKey === 'woocommerce')
  const byId = Object.fromEntries(woo.map((entry) => [entry.marketplaceAccountId, entry]))
  assert.equal(woo.length, 2)
  assert.equal(byId[storeA.id].connectionScope, 'account')
  assert.equal(byId[storeA.id].connection, 'CONNECTED', 'A mağazasının kimliği VAR')
  assert.equal(byId[storeB.id].connection, 'NOT_CONFIGURED', 'B, A nın kimliğiyle bağlı görünmez')
})

test('IH-CANON-5b: tarihsel yazım farkları (boşluk/büyük harf) KANONİK anahtara çözülür', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // Tarihsel satır: VERİ YENİDEN YAZILMAZ, okuyucu tolere eder.
  const [legacyCased] = await db
    .insert(schema.marketplaceAccounts)
    .values({ organizationId: org, marketplace: ' WooCommerce ', providerAccountId: 'c.example' })
    .returning()
  const woo = (await loadHealth(db, org)).filter((entry) => entry.providerKey === 'woocommerce')
  assert.deepEqual(woo.map((entry) => entry.marketplaceAccountId), [legacyCased.id])
  assert.equal(woo[0].connectionKey, `woocommerce::${legacyCased.id}`)
  // Depolanan değer DEĞİŞMEDİ (göç/yeniden yazım yok).
  const [stored] = await db.select().from(schema.marketplaceAccounts)
  assert.equal(stored.marketplace, ' WooCommerce ')
})

test('IH-CANON-6: desteklenmeyen hesap satırı sağlayıcı UYDURMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await db.insert(schema.marketplaceAccounts).values([
    { organizationId: org, marketplace: 'Hepsiburada', providerAccountId: 'h1' },
    { organizationId: org, marketplace: '', providerAccountId: 'blank' },
  ])
  const entries = await loadHealth(db, org)
  const keys = [...new Set(entries.map((entry) => entry.providerKey))].sort()
  assert.deepEqual(keys, ['ikas', 'ticimax', 'trendyol', 'woocommerce'])
  assert.equal(entries.some((entry) => entry.marketplaceAccountId !== null), false)
})

test('IH-CANON-7: A kiracısının karışık yazımlı hesabı B sağlığında GÖRÜNMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const accountA = await connectTrendyol(db, orgA)
  const entriesB = await loadHealth(db, orgB)
  assert.equal(JSON.stringify(entriesB).includes(accountA.id), false)
  const [trendyolB] = trendyolOf(entriesB)
  assert.equal(trendyolB.connectionScope, 'none')
  assert.equal(trendyolB.marketplaceAccountId, null)
  await assert.rejects(() => loadHealth(db, ''))
})

test('IH-CANON-8: başarılı hesap satırı sonrası AYNI kimlik, NEVER_RUN → HEALTHY', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const account = await connectTrendyol(db, org)
  const [before] = trendyolOf(await loadHealth(db, org))
  assert.equal(before.sync, 'NEVER_RUN')
  await syncRepo.recordSyncState(db, org, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    marketplaceAccountId: account.id,
    successfulSyncAt: new Date(NOW - 60_000),
  })
  const after = trendyolOf(await loadHealth(db, org))
  assert.equal(after.length, 1, 'ikinci bağlantı YOK')
  assert.equal(after[0].marketplaceAccountId, account.id)
  assert.equal(after[0].connectionKey, before.connectionKey)
  assert.equal(after[0].sync, 'HEALTHY')
  assert.equal(after[0].credentials, 'VALID')
})

test('ONB-CANON-1/2: onboarding sonucu DEĞİŞMEZ, alttaki kayıt GERÇEK hesabı taşır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await credentials.saveIntegrationCredential(db, org, 'surat', { kullaniciAdi: 'u', sifre: 'p' })
  const account = await connectTrendyol(db, org)

  const status = await onboarding.deriveOnboardingStatus(db, org, { nowMs: NOW })
  assert.equal(status.marketplaces[0].configured, true)
  assert.deepEqual(status.blockers, ['FIRST_SYNC_REQUIRED'])
  const snapshot = await onboarding.loadOnboardingSnapshot(db, org, { nowMs: NOW })
  const underlying = snapshot.healthByResource.orders.filter((entry) => entry.providerKey === 'trendyol')
  assert.deepEqual(underlying.map((entry) => entry.marketplaceAccountId), [account.id])
  assert.equal(underlying[0].connectionScope, 'account')

  await syncRepo.recordSyncState(db, org, {
    provider: 'trendyol', resource: 'orders', status: 'success', marketplaceAccountId: account.id,
  })
  const ready = await onboarding.deriveOnboardingStatus(db, org, { nowMs: NOW })
  assert.equal(ready.marketplaces[0].bootstrapReady, true)
  assert.deepEqual(ready.blockers, [])
})
