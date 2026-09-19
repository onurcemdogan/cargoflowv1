// INTEGRATION-HEALTH-001 — kanonik bağlantı/senkron sağlığı kabul testleri.
//
// ═══ MODELİN SINANAN ÇEKİRDEK İDDİASI ════════════════════════════════════
//
// "Sağlıklı" tek bir boolean DEĞİLDİR. Bu dosya en çok şu iki hatayı avlar:
//
//   1) Kimlik bilgisi VAR diye "geçerli" demek (IH-2)
//   2) Sağlayıcı webhook SUNMUYOR diye "bozuk" demek (IH-7, IH-8)
//
// Kiracı izolasyonu GERÇEK Postgres (PGlite) + GERÇEK migration'lar üzerinde
// sınanır: depoda RLS YOKTUR, izolasyon uygulama kapsamıyla sağlanır ve bu
// iddia SQL düzeyinde kanıtlanmalıdır (IH-11).
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
const catalog = await import('./connectors/providerCatalog.ts')
const repo = await import('./connectors/integrationHealthRepository.ts')

const NOW = Date.parse('2026-09-19T12:00:00.000Z')
const MIN = 60_000
const HOUR = 3_600_000

const registry = catalog.buildProviderCatalog()
const descriptorOf = (key) => registry.get(key)

function input(over = {}) {
  return {
    descriptor: descriptorOf('trendyol'),
    rolloutStage: 'ga',
    credentialsPresent: true,
    syncState: null,
    nowMs: NOW,
    ...over,
  }
}

function syncState(over = {}) {
  return {
    lastSyncStatus: 'success',
    lastSuccessfulSyncAt: new Date(NOW - 5 * MIN),
    lastErrorCode: null,
    lastFetchedCount: 12,
    updatedAt: new Date(NOW - 5 * MIN),
    ...over,
  }
}

// ── TEMEL DURUMLAR ─────────────────────────────────────────────────────────

test('IH-1: yapilandirilmis + yeni basarili senkron → OPERATIONAL', () => {
  const result = health.resolveIntegrationHealth(input({ syncState: syncState() }))
  assert.equal(result.overall, 'OPERATIONAL')
  assert.equal(result.connection, 'CONNECTED')
  assert.equal(result.credentials, 'VALID')
  assert.equal(result.sync, 'HEALTHY')
  assert.equal(result.reconciliation, 'HEALTHY')
})

test('IH-2: kimlik ALANLARI var ama kimlik dogrulanmis okuma YOK → UNKNOWN', () => {
  const result = health.resolveIntegrationHealth(
    input({ credentialsPresent: true, syncState: null }),
  )
  assert.equal(
    result.credentials,
    'UNKNOWN',
    'alan varligi ASLA "gecerli" demek degildir',
  )
  assert.notEqual(result.credentials, 'VALID')
  assert.equal(result.sync, 'NEVER_RUN')
  assert.equal(result.overall, 'DEGRADED', 'ilk senkron bekleniyor — HATA degil')
  assert.ok(result.reasons.some((r) => r.code === 'CREDENTIALS_NOT_PROVEN'))
  assert.equal(
    health.HEALTH_REASON_COPY_TR.AWAITING_FIRST_SYNC,
    'Bağlandı — ilk senkron bekleniyor',
  )
})

test('IH-3: yakin kimlik hatasi → ACTION_REQUIRED / AUTH', () => {
  const result = health.resolveIntegrationHealth(
    input({
      syncState: syncState({
        lastSyncStatus: 'failed',
        lastSuccessfulSyncAt: null,
        lastErrorCode: 'HTTP_401_UNAUTHORIZED',
      }),
    }),
  )
  assert.equal(result.credentials, 'INVALID')
  assert.equal(result.connection, 'DISCONNECTED')
  assert.equal(result.overall, 'ACTION_REQUIRED')
  assert.equal(result.lastErrorClass, 'AUTH')
  assert.equal(health.HEALTH_REASON_COPY_TR.CREDENTIALS_REJECTED, 'Kimlik doğrulama gerekli')
})

test('IH-4: esigi asan eski basarili yoklama → STALE', () => {
  const policy = health.resolveFreshnessPolicy(descriptorOf('trendyol'))
  assert.equal(policy.mode, 'polling_only')
  const result = health.resolveIntegrationHealth(
    input({
      syncState: syncState({
        lastSuccessfulSyncAt: new Date(NOW - policy.syncStaleAfterMs - MIN),
        updatedAt: new Date(NOW - policy.syncStaleAfterMs - MIN),
      }),
    }),
  )
  assert.equal(result.sync, 'STALE')
  assert.equal(result.overall, 'DEGRADED')
  assert.ok(result.reasons.some((r) => r.code === 'SYNC_STALE'))
  assert.equal(health.HEALTH_REASON_COPY_TR.SYNC_STALE, 'Senkron gecikmiş')
})

// ── SAĞLAYICIYA ÖZEL GERÇEK ────────────────────────────────────────────────

test('IH-5: WooCommerce webhook bozuk ama mutabakat saglikli → DEGRADED', () => {
  const result = health.resolveIntegrationHealth(
    input({
      descriptor: descriptorOf('woocommerce'),
      rolloutStage: 'pilot',
      syncState: syncState(),
      webhook: { configured: true, consecutiveDeliveryFailures: 3 },
    }),
  )
  assert.equal(result.webhook, 'DEGRADED')
  assert.equal(result.reconciliation, 'HEALTHY', 'mutabakat BAGIMSIZ gorunur')
  assert.equal(result.connection, 'CONNECTED')
  assert.equal(
    result.overall,
    'DEGRADED',
    'webhook bozuk olsa da sistem mutabakatla CALISIR — tamamen kopuk DEGIL',
  )
})

test('IH-6: WooCommerce saglayici tarafindan DISABLED durumu temsil edilir', () => {
  const result = health.resolveIntegrationHealth(
    input({
      descriptor: descriptorOf('woocommerce'),
      rolloutStage: 'pilot',
      syncState: syncState(),
      webhook: { configured: true, disabledAt: new Date(NOW - HOUR) },
    }),
  )
  assert.equal(result.webhook, 'DISABLED')
  assert.ok(result.reasons.some((r) => r.code === 'WEBHOOK_DISABLED_BY_PROVIDER'))
  // Sağlayıcı olayı YOKSA disabled UYDURULMAZ.
  const noEvent = health.resolveIntegrationHealth(
    input({
      descriptor: descriptorOf('woocommerce'),
      rolloutStage: 'pilot',
      syncState: syncState(),
      webhook: { configured: true },
    }),
  )
  assert.notEqual(noEvent.webhook, 'DISABLED')
  assert.equal(noEvent.webhook, 'UNKNOWN', 'trafik yoklugu BASARISIZLIK degildir')
  assert.ok(noEvent.reasons.some((r) => r.code === 'WEBHOOK_NO_TRAFFIC_OBSERVED'))
})

test('IH-7: ikas webhook NOT_SUPPORTED — FAILED DEGIL', () => {
  const result = health.resolveIntegrationHealth(
    input({ descriptor: descriptorOf('ikas'), rolloutStage: 'shadow', syncState: syncState() }),
  )
  assert.equal(result.webhook, 'NOT_SUPPORTED')
  assert.notEqual(result.webhook, 'DEGRADED')
  assert.notEqual(result.webhook, 'DISABLED')
  assert.ok(
    result.reasons.some((r) => r.code === 'WEBHOOK_CONTRACT_NOT_VERIFIED'),
    'sebep "dogrulanmadi" olmali — "bozuk" degil',
  )
  // Doğruluk yolu mutabakattır ve SAĞLIKLI görünür.
  assert.equal(result.reconciliation, 'HEALTHY')
  // Genel durum webhook yuzunden DUSMEZ.
  assert.notEqual(result.overall, 'ACTION_REQUIRED')
})

test('IH-8: Ticimax webhook sozlesmede YOK — FAILED DEGIL', () => {
  const result = health.resolveIntegrationHealth(
    input({ descriptor: descriptorOf('ticimax'), rolloutStage: 'shadow', syncState: syncState() }),
  )
  assert.equal(result.webhook, 'NOT_SUPPORTED')
  assert.ok(
    result.reasons.some((r) => r.code === 'WEBHOOK_NOT_OFFERED_BY_PROVIDER'),
    'saglayici SUNMUYOR — dogrulanmadi ile ayni sey degil',
  )
  assert.equal(result.reconciliation, 'HEALTHY', 'yoklama dogruluk yolu')
})

// ── YAYIN AŞAMASI SAĞLIKTAN AYRI ───────────────────────────────────────────

test('IH-9: saglik yesil olsa da rolloutStage=off OFF kalir', () => {
  const result = health.resolveIntegrationHealth(
    input({ descriptor: descriptorOf('woocommerce'), rolloutStage: 'off', syncState: syncState() }),
  )
  assert.equal(result.sync, 'HEALTHY', 'bilesen saglikli')
  assert.equal(result.rolloutStage, 'off', 'saglik ASAMAYI ILERLETMEZ')
  assert.equal(result.overall, 'DISABLED')
  assert.equal(health.healthPermitsLiveMutation(result), false)
  // Katalog politikası da off demeli.
  assert.equal(catalog.resolveRolloutStage('woocommerce'), 'off')
})

test('IH-10: shadow saglikli olsa bile URETIM MUTASYONUNA izin vermez', () => {
  const shadow = health.resolveIntegrationHealth(
    input({ descriptor: descriptorOf('woocommerce'), rolloutStage: 'shadow', syncState: syncState() }),
  )
  assert.equal(shadow.sync, 'HEALTHY')
  assert.equal(
    health.healthPermitsLiveMutation(shadow),
    false,
    'shadow okur/normallestirir ama canli davranisi DEGISTIREMEZ',
  )
  const pilot = health.resolveIntegrationHealth(
    input({ descriptor: descriptorOf('woocommerce'), rolloutStage: 'pilot', syncState: syncState() }),
  )
  assert.equal(health.healthPermitsLiveMutation(pilot), true)
  // Kimlik gecersizse pilot bile izin VERMEZ.
  const brokenPilot = health.resolveIntegrationHealth(
    input({
      descriptor: descriptorOf('woocommerce'),
      rolloutStage: 'pilot',
      syncState: syncState({ lastSyncStatus: 'failed', lastSuccessfulSyncAt: null, lastErrorCode: 'AUTH_FAILED' }),
    }),
  )
  assert.equal(health.healthPermitsLiveMutation(brokenPilot), false)
})

// ── KİRACI İZOLASYONU (GERÇEK POSTGRES) ────────────────────────────────────

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

test('IH-11: kiraci A, kiraci B saglik/senkron durumunu GOREMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'ih-a')
  const orgB = await makeOrg(db, 'ih-b')

  // A hic senkron etmedi; B basarili senkron etti.
  await db.insert(schema.integrationSyncState).values({
    organizationId: orgB,
    provider: 'trendyol',
    resource: 'orders',
    lastSyncStatus: 'success',
    lastSuccessfulSyncAt: new Date(NOW - MIN),
    lastFetchedCount: 99,
    updatedAt: new Date(NOW - MIN),
  })

  const aHealth = await repo.loadIntegrationHealth(db, {
    organizationId: orgA,
    credentialsPresentByProvider: { trendyol: true },
    nowMs: NOW,
  })
  const bHealth = await repo.loadIntegrationHealth(db, {
    organizationId: orgB,
    credentialsPresentByProvider: { trendyol: true },
    nowMs: NOW,
  })
  const aTrendyol = aHealth.find((h) => h.providerKey === 'trendyol')
  const bTrendyol = bHealth.find((h) => h.providerKey === 'trendyol')

  assert.equal(aTrendyol.sync, 'NEVER_RUN', 'A kendi gercegini gorur')
  assert.equal(aTrendyol.lastSuccessfulSyncAt, null, 'A, Bnin senkronunu GOREMEZ')
  assert.equal(bTrendyol.sync, 'HEALTHY')
  assert.ok(bTrendyol.lastSuccessfulSyncAt)

  // Kapsamsiz okuma REDDEDILIR (fail-closed).
  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(
      () => repo.loadIntegrationHealth(db, { organizationId: bad, nowMs: NOW }),
      repo.TenantScopeMissingError,
    )
  }

  // Kaynakta KAPSAMSIZ sorgu olmamali.
  const source = readFileSync(join(here, 'connectors', 'integrationHealthRepository.ts'), 'utf8')
  assert.match(source, /eq\(integrationSyncState\.organizationId, organizationId\)/)
  // RLS KULLANILMADIGI icin KOD icinde RLS/policy cagrisi da olmamali.
  // (Yorumda "RLS YOKTUR" yazmasi bir IDDIA degil, tam tersi bir UYARIDIR —
  //  bu yuzden tarama yorumlari cikarilmis KOD uzerinde yapilir.)
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  for (const claim of ['RLS', 'row level security', 'CREATE POLICY', 'set_config']) {
    assert.equal(
      code.toLowerCase().includes(claim.toLowerCase()),
      false,
      `kodda RLS iddiasi/kullanimi: ${claim}`,
    )
  }
  // Dosya, izolasyonun UYGULAMA KAPSAMIYLA saglandigini ACIKCA belgelemeli.
  assert.match(source, /RLS YOKTUR/, 'RLS yoklugu acikca belgelenmeli')
})

// ── GİZLİLİK / DETERMİNİZM / EŞİKLER ───────────────────────────────────────

test('IH-12: hata taksonomisi SIR SIZDIRMAZ', () => {
  const secretish = 'Bearer sk_live_ABC123 at https://shop.example.com/wp-json?consumer_secret=cs_9f'
  const result = health.resolveIntegrationHealth(
    input({
      syncState: syncState({
        lastSyncStatus: 'failed',
        lastSuccessfulSyncAt: null,
        lastErrorCode: secretish,
      }),
    }),
  )
  const serialized = JSON.stringify(result)
  for (const secret of ['sk_live_ABC123', 'consumer_secret', 'cs_9f', 'shop.example.com', 'Bearer']) {
    assert.equal(serialized.includes(secret), false, `sagliga sizdi: ${secret}`)
  }
  assert.ok(health.ERROR_CLASSES.includes(result.lastErrorClass))

  // Görünüm katmanı da yalnız kararlı KODLARI tasir.
  const view = repo.toHealthView(result, 'Trendyol')
  const viewSerialized = JSON.stringify(view)
  assert.equal(viewSerialized.includes('sk_live_ABC123'), false)
  for (const code of view.attentionReasonCodes) {
    assert.match(code, /^[A-Z0-9_]+$/, `sebep kodu kararli olmali: ${code}`)
  }
})

test('IH-13: ayni durum + ayni now → DETERMINISTIK sonuc', () => {
  const build = () => health.resolveIntegrationHealth(input({ syncState: syncState() }))
  assert.deepEqual(build(), build())
  // Cozumleyicide Date.now() KULLANILMAZ.
  const source = readFileSync(join(here, 'connectors', 'integrationHealth.ts'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  assert.equal(code.includes('Date.now()'), false, 'saf cozumleyicide Date.now() YASAK')
})

test('IH-14: tazelik esigi SAGLAYICI/YETENEK guduludur, tek global sabit YOK', () => {
  const woo = health.resolveFreshnessPolicy(descriptorOf('woocommerce'))
  const ikas = health.resolveFreshnessPolicy(descriptorOf('ikas'))
  const ticimax = health.resolveFreshnessPolicy(descriptorOf('ticimax'))
  const trendyol = health.resolveFreshnessPolicy(descriptorOf('trendyol'))

  // Dogrulanmis webhook TASIYAN tek saglayici WooCommerce.
  assert.equal(woo.mode, 'webhook_plus_reconciliation')
  for (const [name, policy] of [['ikas', ikas], ['ticimax', ticimax], ['trendyol', trendyol]]) {
    assert.equal(policy.mode, 'polling_only', `${name} yoklama modunda olmali`)
    assert.ok(
      policy.syncStaleAfterMs < woo.syncStaleAfterMs,
      `${name}: yoklama TEK dogruluk yolu oldugu icin esik DAHA SIKI olmali`,
    )
  }

  // AYNI gecikme iki saglayicida FARKLI sonuc verir — esigin gerceklige bagli
  // oldugunun kaniti.
  const lateBy = trendyol.syncStaleAfterMs + MIN
  const state = syncState({
    lastSuccessfulSyncAt: new Date(NOW - lateBy),
    updatedAt: new Date(NOW - lateBy),
  })
  assert.equal(
    health.resolveIntegrationHealth(input({ syncState: state })).sync,
    'STALE',
  )
  assert.equal(
    health.resolveIntegrationHealth(
      input({ descriptor: descriptorOf('woocommerce'), rolloutStage: 'pilot', syncState: state }),
    ).sync,
    'HEALTHY',
  )
})

test('IH-15: HIC CALISMADI ile BASARISIZ AYRI durumlardir', () => {
  const never = health.resolveIntegrationHealth(input({ syncState: null }))
  const failed = health.resolveIntegrationHealth(
    input({
      syncState: syncState({
        lastSyncStatus: 'failed',
        lastSuccessfulSyncAt: null,
        lastErrorCode: 'PROVIDER_503',
      }),
    }),
  )
  assert.equal(never.sync, 'NEVER_RUN')
  assert.equal(failed.sync, 'FAILED')
  assert.notEqual(never.sync, failed.sync)
  assert.equal(never.overall, 'DEGRADED', 'hic calismamis = beklemede')
  assert.equal(failed.overall, 'ACTION_REQUIRED', 'basarisiz = mudahale')
  assert.equal(failed.lastErrorClass, 'PROVIDER_5XX')
  // Yapılandırılmamış da AYRI bir durumdur.
  const unconfigured = health.resolveIntegrationHealth(
    input({ credentialsPresent: false, syncState: null }),
  )
  assert.equal(unconfigured.connection, 'NOT_CONFIGURED')
  assert.equal(unconfigured.overall, 'NOT_CONFIGURED')
})

// ── EK KİLİTLER ────────────────────────────────────────────────────────────

test('IH-16: RUNNING gercek kilit statusunden okunur, bayat kilit AYIRT EDILIR', () => {
  const running = health.resolveIntegrationHealth(
    input({
      syncState: syncState({ lastSyncStatus: 'running', updatedAt: new Date(NOW - 30_000) }),
    }),
  )
  assert.equal(running.sync, 'RUNNING')

  // 120 sn ustu kilit BAYATTIR: "calisiyor" gibi gosterilmez.
  const staleLock = health.resolveIntegrationHealth(
    input({
      syncState: syncState({ lastSyncStatus: 'running', updatedAt: new Date(NOW - 10 * MIN) }),
    }),
  )
  assert.notEqual(staleLock.sync, 'RUNNING')
  assert.ok(staleLock.reasons.some((r) => r.code === 'SYNC_LOCK_STALE'))
})

test('IH-17: saglik modeli MIGRATION GEREKTIRMEZ — mevcut kolonlar yeterli', () => {
  // Cozumleyicinin okudugu HER alan mevcut semada VARDIR.
  const columns = Object.keys(schema.integrationSyncState)
  for (const needed of [
    'lastSyncStatus', 'lastSuccessfulSyncAt', 'lastErrorCode', 'lastFetchedCount', 'updatedAt',
    'organizationId', 'provider', 'resource',
  ]) {
    assert.ok(columns.includes(needed), `mevcut semada eksik kolon: ${needed}`)
  }
  // Bu bilette yeni migration EKLENMEDI.
  const migrations = readdirSync(join(here, '..', 'drizzle')).filter((f) => f.endsWith('.sql'))
  assert.equal(migrations.length, 13, `migration sayisi degismemeli: ${migrations.length}`)
})

test('IH-18: katalog yetenek gercegini SOZLESME PAKETINDEN alir', () => {
  // ikas webhook paketi "dogrulanmadi" diyor → katalog da oyle demeli.
  const ikasWebhook = registry.get('ikas').capabilities.find((c) => c.capability === 'orders.webhook')
  assert.equal(ikasWebhook.supported, false)
  assert.equal(ikasWebhook.contractVerified, false)
  // WooCommerce webhook paketi dogrulanmis diyor.
  const wooWebhook = registry.get('woocommerce').capabilities.find((c) => c.capability === 'orders.webhook')
  assert.equal(wooWebhook.supported, true)
  assert.equal(wooWebhook.contractVerified, true)
  // Ticimax: saglayici SUNMUYOR (yoklugu KANITLI).
  const ticimaxWebhook = registry.get('ticimax').capabilities.find((c) => c.capability === 'orders.webhook')
  assert.equal(ticimaxWebhook.supported, false)
  assert.equal(ticimaxWebhook.contractVerified, true)
})
