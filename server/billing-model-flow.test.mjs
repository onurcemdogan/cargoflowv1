// BILLING-MODEL-UI-001 — plan / hak / kullanım gerçeği kabul testleri.
//
// ═══ EN KRİTİK TEST BILL-1'DİR ═══════════════════════════════════════════
//
// Üretimdeki organizasyonların plan kaydı YOKTUR. Kayıt yokluğu "Free"
// sayılsaydı, bu kod üretime çıktığı an mevcut Trendyol + Sürat kullanıcıları
// yetenek KAYBEDERDİ. Geriye uyumluluk burada kilitlenir.
//
// ═══ AD ÇAKIŞMASI ════════════════════════════════════════════════════════
//
// Bu dosyadaki "billing" CargoFlow ABONELİĞİDİR. Depoda ayrıca `billingParty`
// vardır (taşıyıcı gönderi ücretini kim öder) ve TAMAMEN FARKLI bir şeydir.
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
const catalog = await import('./billing/planCatalog.ts')
const access = await import('./billing/featureAccess.ts')
const planRepo = await import('./billing/planRepository.ts')
const service = await import('./billing/billingStatusService.ts')

const NOW = Date.parse('2026-09-20T12:00:00.000Z')

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

async function assignPlan(db, organizationId, planId, extra = {}) {
  await db
    .insert(schema.organizationSettings)
    .values({
      organizationId,
      settingsJson: {
        [planRepo.PLAN_SETTINGS_KEY]: { planId, assignedAt: '2026-09-01T00:00:00.000Z', ...extra },
      },
    })
    .onConflictDoUpdate({
      target: schema.organizationSettings.organizationId,
      set: {
        settingsJson: {
          [planRepo.PLAN_SETTINGS_KEY]: { planId, assignedAt: '2026-09-01T00:00:00.000Z', ...extra },
        },
      },
    })
}

async function addMarketplaceAccount(db, organizationId, providerAccountId) {
  await db.insert(schema.marketplaceAccounts).values({
    organizationId,
    marketplace: 'woocommerce',
    providerAccountId,
  })
}

const decisionFor = (status, capability) =>
  status.access.find((entry) => entry.capability === capability)

// ── GERİYE UYUMLULUK ───────────────────────────────────────────────────────

test('BILL-1: plan kaydi OLMAYAN organizasyon mevcut yeteneklerini KORUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bill-1')
  // Hic plan atamasi YOK — uretimdeki mevcut durum.

  const assignment = await planRepo.loadPlanAssignment(db, org)
  assert.equal(assignment.planId, 'legacy_unmetered')
  assert.equal(assignment.legacy, true)

  const status = await service.loadBillingStatus(db, org, { nowMs: NOW })
  // HICBIR yetenek plan yuzunden kapanmamali.
  for (const entry of status.access) {
    assert.notEqual(
      entry.decision,
      'PLAN_REQUIRED',
      `legacy organizasyon yetenek KAYBETTI: ${entry.capability}`,
    )
    assert.notEqual(entry.decision, 'LIMIT_REACHED', `legacy limite takildi: ${entry.capability}`)
  }
  assert.equal(status.plan.legacy, true)
  assert.equal(status.plan.assignable, false, 'gecis durumu SATILABILIR bir plan degildir')
})

test('BILL-17/BILL-20: legacy organizasyon Trendyol + Surat yollarini KULLANABILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bill-17')
  const status = await service.loadBillingStatus(db, org, { nowMs: NOW })
  // Pazaryeri ve tasiyici baglantisi ile toplu baski ACIK olmali.
  for (const capability of ['connections.marketplace', 'connections.carrier', 'labels.bulk_print']) {
    assert.equal(decisionFor(status, capability).decision, 'ALLOWED', capability)
  }
  // TANINMAYAN plan kimligi de legacy'e duser (yetenek kaybi YOK).
  await assignPlan(db, org, 'enterprise_that_does_not_exist')
  const fallback = await planRepo.loadPlanAssignment(db, org)
  assert.equal(fallback.planId, 'legacy_unmetered')
})

// ── HAK / LİMİT ────────────────────────────────────────────────────────────

test('BILL-2: plana DAHIL yetenek ALLOWED', () => {
  const result = access.resolveFeatureAccess({
    capability: 'labels.bulk_print',
    planId: 'tier_standard',
  })
  assert.equal(result.decision, 'ALLOWED')
})

test('BILL-3: plana dahil OLMAYAN yetenek PLAN_REQUIRED + yukseltme hedefi', () => {
  const result = access.resolveFeatureAccess({
    capability: 'analytics.export',
    planId: 'tier_basic',
  })
  assert.equal(result.decision, 'PLAN_REQUIRED')
  assert.equal(result.reasonCode, 'CAPABILITY_NOT_IN_PLAN')
  assert.equal(result.requiredPlanId, 'tier_advanced', 'DETERMINISTIK yukseltme hedefi')
})

test('BILL-4: DESTEKLENMEYEN yetenek EN YUKSEK planda bile UNSUPPORTED', () => {
  const result = access.resolveFeatureAccess({
    capability: 'analytics.export',
    planId: 'tier_advanced',
    productSupported: false,
  })
  assert.equal(result.decision, 'UNSUPPORTED')
  assert.equal(result.requiredPlanId, null, 'para teknik imkansizligi ACMAZ')
})

test('BILL-5: limit DOLMAMIS → ALLOWED', () => {
  const result = access.resolveFeatureAccess({
    capability: 'connections.marketplace',
    planId: 'tier_standard',
    usage: { metered: true, value: 1 },
  })
  assert.equal(result.decision, 'ALLOWED')
})

test('BILL-6: limit DOLMUS → LIMIT_REACHED', () => {
  const result = access.resolveFeatureAccess({
    capability: 'connections.marketplace',
    planId: 'tier_standard',
    usage: { metered: true, value: 3 },
  })
  assert.equal(result.decision, 'LIMIT_REACHED')
  assert.equal(result.reasonCode, 'PLAN_LIMIT_REACHED')
  assert.equal(result.requiredPlanId, 'tier_advanced')
})

// ── KULLANIM GERÇEĞİ ───────────────────────────────────────────────────────

test('BILL-7: kullanim OTORITER kaynaktan gelir (rastgele sayac DEGIL)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bill-7')
  await addMarketplaceAccount(db, org, 'store-1')
  await addMarketplaceAccount(db, org, 'store-2')

  const usage = await planRepo.loadUsageSnapshot(db, org, { nowMs: NOW })
  assert.equal(usage.metrics['connections.marketplace'].metered, true)
  assert.equal(
    usage.metrics['connections.marketplace'].value,
    2,
    'sayim marketplace_accounts TABLOSUNDAN gelir',
  )
  // Tasiyici sayimi CargoFlow'un OLUSTURDUGU gonderilerden gelir.
  assert.equal(usage.metrics['connections.carrier'].value, 0)
})

test('BILL-8: OLCULEMEYEN metrik SAHTE SIFIR bildirmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bill-8')
  const usage = await planRepo.loadUsageSnapshot(db, org, { nowMs: NOW })

  const team = usage.metrics['team.members']
  assert.equal(team.metered, false)
  assert.equal(team.value, null, 'olculemeyen metrik 0 DEGIL null doner')
  assert.equal(team.reason, 'NO_MEMBERSHIP_TABLE')

  const monthly = usage.metrics['orders.ingested.monthly']
  assert.equal(monthly.metered, false)
  assert.equal(monthly.value, null)
  assert.equal(monthly.reason, 'NO_BILLING_CYCLE_DEFINED', 'faturalama dongusu YOK')

  // Olculemeyen kullanim ASLA LIMIT_REACHED uretmez.
  const result = access.resolveFeatureAccess({
    capability: 'connections.marketplace',
    planId: 'tier_basic',
    usage: access.NOT_YET_METERED,
  })
  assert.notEqual(result.decision, 'LIMIT_REACHED', 'olculmeyen sey kilitlemez')
  assert.equal(result.usageMetered, false)
})

// ── AYRI KAYNAKLAR ─────────────────────────────────────────────────────────

test('BILL-9: bozuk baglanti CONNECTION_REQUIRED — ticari hak ETKILENMEZ', () => {
  const result = access.resolveFeatureAccess({
    capability: 'connections.marketplace',
    planId: 'tier_advanced',
    usage: { metered: true, value: 1 },
    connectionOperational: false,
  })
  assert.equal(result.decision, 'CONNECTION_REQUIRED')
  assert.equal(result.requiredPlanId, null, 'bu bir PLAN sorunu DEGIL')
})

test('BILL-10: rollout kapali → ROLLOUT_DISABLED, plan DEGISMEZ', () => {
  const result = access.resolveFeatureAccess({
    capability: 'labels.bulk_print',
    planId: 'tier_advanced',
    rolloutLive: false,
  })
  assert.equal(result.decision, 'ROLLOUT_DISABLED')
  assert.equal(
    result.requiredPlanId,
    null,
    'yayinda olmayan ozellik icin "yukseltin" demek YANLIS TAHSILATTIR',
  )
})

test('BILL-P: oncelik sirasi DOKUMANTE EDILEN sirayla ayni', () => {
  assert.deepEqual([...access.ACCESS_PRECEDENCE], [
    'UNSUPPORTED',
    'ROLLOUT_DISABLED',
    'PLAN_REQUIRED',
    'LIMIT_REACHED',
    'CONNECTION_REQUIRED',
    'ALLOWED',
  ])
  // Hepsi ayni anda bozukken EN USTTEKI kazanir.
  const worst = access.resolveFeatureAccess({
    capability: 'analytics.export',
    planId: 'tier_basic',
    productSupported: false,
    rolloutLive: false,
    connectionOperational: false,
    usage: { metered: true, value: 999 },
  })
  assert.equal(worst.decision, 'UNSUPPORTED')
  // Teknik olarak destekleniyorsa sira ROLLOUT'a duser.
  const next = access.resolveFeatureAccess({
    capability: 'analytics.export',
    planId: 'tier_basic',
    productSupported: true,
    rolloutLive: false,
    connectionOperational: false,
  })
  assert.equal(next.decision, 'ROLLOUT_DISABLED')
})

// ── KİRACI / ÇOK HESAP ─────────────────────────────────────────────────────

test('BILL-11: kiraci A, kiraci Bnin plan/kullanim durumunu GOREMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'bill-11-a')
  const orgB = await makeOrg(db, 'bill-11-b')
  await assignPlan(db, orgB, 'tier_advanced')
  await addMarketplaceAccount(db, orgB, 'b-store-1')
  await addMarketplaceAccount(db, orgB, 'b-store-2')

  const a = await service.loadBillingStatus(db, orgA, { nowMs: NOW })
  const b = await service.loadBillingStatus(db, orgB, { nowMs: NOW })

  assert.equal(a.plan.planId, 'legacy_unmetered', 'A kendi gercegini gorur')
  assert.equal(b.plan.planId, 'tier_advanced')
  assert.equal(a.usage['connections.marketplace'].value, 0, 'A, Bnin hesaplarini GOREMEZ')
  assert.equal(b.usage['connections.marketplace'].value, 2)

  // Kapsamsiz okuma fail-closed.
  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(
      () => planRepo.loadPlanAssignment(db, bad),
      planRepo.TenantScopeMissingError,
    )
    await assert.rejects(
      () => planRepo.loadUsageSnapshot(db, bad, { nowMs: NOW }),
      planRepo.TenantScopeMissingError,
    )
  }
})

test('BILL-14: ayni saglayicinin IKI hesabi BAGIMSIZ sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bill-14')
  await assignPlan(db, org, 'tier_standard') // pazaryeri limiti 3
  await addMarketplaceAccount(db, org, 'store-1')

  // SEMANTİK: karar "BİR TANE DAHA ekleyebilir miyim" sorusudur
  // (varsayılan `requested: 1`). 1/3 → yer var.
  const first = await service.loadBillingStatus(db, org, { nowMs: NOW })
  assert.equal(first.usage['connections.marketplace'].value, 1)
  assert.equal(decisionFor(first, 'connections.marketplace').decision, 'ALLOWED')

  // AYNI SAĞLAYICININ ikinci hesabı BAĞIMSIZ sayılır (birleştirilmez).
  await addMarketplaceAccount(db, org, 'store-2')
  const second = await service.loadBillingStatus(db, org, { nowMs: NOW })
  assert.equal(second.usage['connections.marketplace'].value, 2, 'iki hesap AYRI sayilir')
  assert.equal(decisionFor(second, 'connections.marketplace').decision, 'ALLOWED')

  // Üçüncü hesapla limit DOLAR: 3/3 → bir tane daha EKLENEMEZ.
  await addMarketplaceAccount(db, org, 'store-3')
  const third = await service.loadBillingStatus(db, org, { nowMs: NOW })
  assert.equal(third.usage['connections.marketplace'].value, 3)
  assert.equal(decisionFor(third, 'connections.marketplace').decision, 'LIMIT_REACHED')
  assert.equal(decisionFor(third, 'connections.marketplace').requiredPlanId, 'tier_advanced')
})

test('BILL-15: legacy (hesapsiz) durum ACIKCA temsil edilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bill-15')
  // organization_settings SATIRI hic yok.
  const noRow = await planRepo.loadPlanAssignment(db, org)
  assert.equal(noRow.legacy, true)
  assert.equal(noRow.assignedAt, null, 'atama zamani UYDURULMAZ')
  assert.equal(noRow.assignedBy, null)

  // Satir VAR ama plan blogu YOK → yine legacy.
  await db.insert(schema.organizationSettings).values({
    organizationId: org,
    settingsJson: { someOtherFeature: true },
  })
  const emptyBlock = await planRepo.loadPlanAssignment(db, org)
  assert.equal(emptyBlock.legacy, true)
})

// ── GÜVENLİK / MİMARİ ──────────────────────────────────────────────────────

test('BILL-12: istemci durumu sunucu hakkini ACAMAZ', () => {
  const source = readFileSync(join(here, 'billing', 'featureAccess.ts'), 'utf8')
  // Karar YALNIZ sunucu girdilerinden turer; istemciden gelen bir "unlocked"
  // bayragi YOKTUR.
  for (const forbidden of ['request.body', 'req.body', 'clientPlan', 'unlocked', 'override']) {
    assert.equal(source.includes(forbidden), false, `istemci etkisi: ${forbidden}`)
  }
  // Uc nokta kiraciyi GOVDEDEN almaz.
  const endpoint = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = endpoint.indexOf("app.get('/api/billing/status'")
  assert.ok(start > 0)
  const block = endpoint.slice(start, endpoint.indexOf('\n})', start))
  assert.match(block, /requireOnboardingContext/)
  assert.equal(block.includes('request.body'), false, 'organizasyon govdeden ALINMAZ')
})

test('BILL-13: ticari yanit SIR TASIMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bill-13')
  await assignPlan(db, org, 'tier_standard', { assignedBy: 'system' })
  const status = await service.loadBillingStatus(db, org, { nowMs: NOW })
  const serialized = JSON.stringify(status)
  for (const secret of ['password', 'apiKey', 'apiSecret', 'token', 'consumer_secret', 'card', 'iban']) {
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, `sizdi: ${secret}`)
  }
  // Odeme saglayici alani HIC YOK.
  for (const payment of ['stripe', 'iyzico', 'paytr', 'paddle', 'invoice', 'charge']) {
    assert.equal(serialized.toLowerCase().includes(payment), false, `odeme alani: ${payment}`)
  }
})

test('BILL-16: plan ADI karsilastirmasi ticari modul DISINDA YOK', () => {
  const offenders = []
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'billing', 'testing'].includes(entry.name)) continue
        scan(full)
        continue
      }
      if (!/\.(ts|mjs)$/.test(entry.name)) continue
      if (entry.name.includes('.test.')) continue
      const code = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      for (const planId of catalog.PLAN_IDS) {
        if (new RegExp(`===\\s*['"]${planId}['"]|['"]${planId}['"]\\s*===`).test(code)) {
          offenders.push(`${full}: ${planId}`)
        }
      }
    }
  }
  scan(here)
  assert.deepEqual(offenders, [], `ticari modul disinda plan karsilastirmasi:\n${offenders.join('\n')}`)
})

test('BILL-S: DOGRULUK ve GUVENLIK yetenekleri ASLA paraya baglanmaz', () => {
  for (const capability of catalog.NEVER_BILLABLE) {
    assert.equal(
      catalog.BILLABLE_CAPABILITIES.includes(capability),
      false,
      `dogruluk/guvenlik yetenegi ticari hak yapilmis: ${capability}`,
    )
    for (const planId of catalog.PLAN_IDS) {
      assert.equal(
        catalog.entitlementOf(planId, capability),
        null,
        `${planId} icin ${capability} hak olarak tanimlanmis`,
      )
    }
  }
})

// ── DETERMİNİZM / AYRIM ────────────────────────────────────────────────────

test('BILL-19: ayni girdi → ayni karar', () => {
  const build = () =>
    access.resolveFeatureAccess({
      capability: 'connections.marketplace',
      planId: 'tier_standard',
      usage: { metered: true, value: 2 },
      connectionOperational: true,
    })
  assert.deepEqual(build(), build())
  const source = readFileSync(join(here, 'billing', 'featureAccess.ts'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  assert.equal(code.includes('Date.now()'), false, 'saf cozumleyicide Date.now() YASAK')
  assert.equal(code.includes('Math.random'), false)
})

test('BILL-18: entegrasyon sagligi ticari durumdan ETKILENMEZ', async () => {
  const health = await import('./connectors/integrationHealth.ts')
  const providerCatalog = await import('./connectors/providerCatalog.ts')
  const registry = providerCatalog.buildProviderCatalog()
  const build = () =>
    health.resolveIntegrationHealth({
      descriptor: registry.get('trendyol'),
      rolloutStage: 'ga',
      credentialsPresence: 'PRESENT',
      syncState: {
        lastSyncStatus: 'success',
        lastSuccessfulSyncAt: new Date(NOW - 60_000),
        lastErrorCode: null,
        lastFetchedCount: 4,
        updatedAt: new Date(NOW - 60_000),
      },
      nowMs: NOW,
    })
  const before = build()
  // Ticari modul YUKLENDIKTEN sonra bile saglik AYNI.
  assert.deepEqual(build(), before)
  assert.equal(before.overall, 'OPERATIONAL')
  // Saglik modulu ticari modulu IMPORT ETMEZ.
  const healthSource = readFileSync(join(here, 'connectors', 'integrationHealth.ts'), 'utf8')
  for (const forbidden of ['planCatalog', 'featureAccess', 'billing']) {
    assert.equal(healthSource.includes(forbidden), false, `saglik ticari module bagli: ${forbidden}`)
  }
})
