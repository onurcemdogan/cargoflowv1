// BILLING-PARTY-MODEL-UI-001 — KARGO ÜCRETİNİ KİM ÖDER.
//
// ═══ ABONELİKLE KARIŞTIRILMAMALI ═════════════════════════════════════════
//
// `server/subscription/*` CargoFlow'un KENDİ PLANIDIR (abonelik). Bu dosya
// GÖNDERİ ÜCRETİNİ kimin ödediğidir. BP-14/BP-15 ikisinin birbirini
// ETKİLEMEDİĞİNİ kilitler.
//
// ═══ EN TEHLİKELİ VARSAYIM ═══════════════════════════════════════════════
//
// "Aras/Sürat kimlik bilgisi var → demek ki satıcı ödüyor" ÇIKARIMI YANLIŞ
// CARİYE FATURA demektir. Taşıyıcı kimliği ödeyeni KANITLAMAZ (BP-4, BP-10).
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
const payer = await import('./shipments/shippingBillingParty.ts')
const suratBilling = await import('./shipments/suratBillingParty.ts')
const accountConfig = await import('./shipments/marketplacePayerConfig.ts')

// ── TEMEL ÇÖZÜMLEME ────────────────────────────────────────────────────────

test('BP-1: hesap yapilandirmasi MARKETPLACE_PAYS cozulur', () => {
  const result = payer.resolveShippingBillingParty({
    marketplace: 'n11',
    marketplaceAccountConfig: 'MARKETPLACE_PAYS',
  })
  assert.equal(result.payer, 'MARKETPLACE_PAYS')
  assert.equal(result.provenance, 'ACCOUNT_CONFIG')
  assert.equal(result.usableForRouting, true)
})

test('BP-2: hesap yapilandirmasi SELLER_PAYS cozulur', () => {
  const result = payer.resolveShippingBillingParty({
    marketplace: 'n11',
    marketplaceAccountConfig: 'SELLER_PAYS',
  })
  assert.equal(result.payer, 'SELLER_PAYS')
  assert.equal(result.provenance, 'ACCOUNT_CONFIG')
})

test('BP-3: kanit ve yapilandirma YOKSA UNKNOWN', () => {
  const result = payer.resolveShippingBillingParty({ marketplace: 'n11' })
  assert.equal(result.payer, 'UNKNOWN')
  assert.equal(result.provenance, 'UNKNOWN')
  assert.equal(result.usableForRouting, false)
  assert.equal(payer.routingGateForPayer(result).gate, 'CONFIG_REQUIRED')
})

test('BP-4: TASIYICI KIMLIGI tek basina odeyeni COZEMEZ', () => {
  // Kargo saglayici adi girdide HIC YOK; olsa bile cozumleyici onu okumaz.
  const source = readFileSync(join(here, 'shipments', 'shippingBillingParty.ts'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  for (const carrier of ['aras', 'Aras', 'surat', 'Surat', 'cargoProviderName', 'yurtici']) {
    assert.equal(code.includes(carrier), false, `tasiyici adindan cikarim: ${carrier}`)
  }
  // Tasiyici bilgisi verilse bile sonuc UNKNOWN kalir.
  const result = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    // DOGRULANMIS sinyal YOK.
  })
  assert.equal(result.payer, 'UNKNOWN')
})

test('BP-9: UNKNOWN, UNKNOWN kalir — varsayilan SELLER_PAYS YOK', () => {
  for (const input of [
    { marketplace: 'hepsiburada' },
    { marketplace: 'hepsiburada', marketplaceAccountConfig: 'UNKNOWN' },
    { marketplace: 'hepsiburada', tenantConfig: 'UNKNOWN' },
    { marketplace: 'bilinmeyen-pazaryeri' },
  ]) {
    const result = payer.resolveShippingBillingParty(input)
    assert.equal(result.payer, 'UNKNOWN', JSON.stringify(input))
    assert.notEqual(result.payer, 'SELLER_PAYS')
  }
})

// ── ÖNCELİK ────────────────────────────────────────────────────────────────

test('BP-7: DOGRULANMIS siparis sinyali kiraci varsayilanini EZER', () => {
  const result = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    // Trendyol sozlesmesi: whoPays alani YOK → TRENDYOL oder.
    verifiedOrderSignal: 'TRENDYOL',
    tenantConfig: 'SELLER_PAYS',
  })
  assert.equal(result.payer, 'MARKETPLACE_PAYS', 'kanitlanmis olgu varsayimi YENER')
  assert.equal(result.provenance, 'ORDER_CONTRACT')
})

test('BP-8: hesap ayari kiraci varsayilanini EZER', () => {
  const result = payer.resolveShippingBillingParty({
    marketplace: 'n11',
    marketplaceAccountConfig: 'SELLER_PAYS',
    tenantConfig: 'MARKETPLACE_PAYS',
  })
  assert.equal(result.payer, 'SELLER_PAYS')
  assert.equal(result.provenance, 'ACCOUNT_CONFIG')
  assert.deepEqual([...payer.PAYER_PRECEDENCE], [
    'ORDER_CONTRACT',
    'ACCOUNT_CONFIG',
    'TENANT_CONFIG',
    'UNKNOWN',
  ])
})

// ── SAĞLAYICI GERÇEĞİ ──────────────────────────────────────────────────────

test('BP-10: Trendyol, DOGRULANMIS sinyal yoksa kargo saglayicisindan CIKARIM YAPMAZ', () => {
  const noSignal = payer.resolveShippingBillingParty({ marketplace: 'trendyol' })
  assert.equal(noSignal.payer, 'UNKNOWN')

  // Mevcut KANITLANMIS Trendyol sozlesmesi korunur:
  //   whoPays own-property '1' → SELLER ; property YOK → TRENDYOL
  const sellerPays = suratBilling.classifyTrendyolWhoPays({ whoPays: '1' })
  assert.equal(sellerPays.billingParty, 'SELLER')
  const marketplacePays = suratBilling.classifyTrendyolWhoPays({ orderNumber: 'X' })
  assert.equal(marketplacePays.billingParty, 'TRENDYOL')

  // Kanonik cevrim.
  assert.equal(payer.canonicalizeBillingParty('SELLER'), 'SELLER_PAYS')
  assert.equal(payer.canonicalizeBillingParty('TRENDYOL'), 'MARKETPLACE_PAYS')
  assert.equal(payer.canonicalizeBillingParty('UNKNOWN'), 'UNKNOWN')

  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      verifiedOrderSignal: sellerPays.billingParty,
    }).payer,
    'SELLER_PAYS',
  )
})

test('BP-11: n11 odeyen alani BU DEPODA DOGRULANMADI — uydurulmaz', () => {
  // `deliveryFeeType` bu depoda HIC gecmiyor ve kabul edilmis bir n11
  // sozlesme paketi YOK. Dolayisiyla n11 icin siparis sinyali KULLANILMAZ.
  assert.equal(
    payer.MARKETPLACES_WITH_VERIFIED_ORDER_SIGNAL.includes('n11'),
    false,
    'dogrulanmamis alan siparis sinyali olarak KABUL EDILEMEZ',
  )
  assert.equal(payer.payerEvidenceClass('n11'), 'ACCOUNT_CONFIG_REQUIRED')
  // Sinyal verilse bile n11 icin YOK SAYILIR (dogrulanmamis).
  const ignored = payer.resolveShippingBillingParty({
    marketplace: 'n11',
    verifiedOrderSignal: 'SELLER',
  })
  assert.equal(ignored.payer, 'UNKNOWN')
  assert.notEqual(ignored.provenance, 'ORDER_CONTRACT')
})

test('BP-12: Hepsiburada dogrulanmamis → UNKNOWN / hesap yapilandirmasi', () => {
  assert.equal(payer.payerEvidenceClass('hepsiburada'), 'ACCOUNT_CONFIG_REQUIRED')
  assert.equal(
    payer.resolveShippingBillingParty({ marketplace: 'hepsiburada' }).payer,
    'UNKNOWN',
  )
  assert.equal(payer.payerEvidenceClass('trendyol'), 'CAN_DERIVE_FROM_ORDER')
})

test('BP-13: cozumleyici DETERMINISTIK', () => {
  const build = () =>
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      verifiedOrderSignal: 'SELLER',
      marketplaceAccountConfig: 'MARKETPLACE_PAYS',
      tenantConfig: 'MARKETPLACE_PAYS',
    })
  assert.deepEqual(build(), build())
  const source = readFileSync(join(here, 'shipments', 'shippingBillingParty.ts'), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  assert.equal(code.includes('Math.random'), false)
  assert.equal(code.includes('Date.now()'), false)
})

// ── ÇOK HESAP / KİRACI (GERÇEK POSTGRES) ──────────────────────────────────

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

async function makeAccount(db, organizationId, marketplace, providerAccountId) {
  const [account] = await db
    .insert(schema.marketplaceAccounts)
    .values({ organizationId, marketplace, providerAccountId })
    .returning()
  return account.id
}

test('BP-5: ayni pazaryerinin IKI hesabi FARKLI odeyen modunda kalir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bp-5')
  const a = await makeAccount(db, org, 'n11', 'acct-a')
  const b = await makeAccount(db, org, 'n11', 'acct-b')

  await accountConfig.setAccountPayerConfig(db, org, a, 'MARKETPLACE_PAYS')
  await accountConfig.setAccountPayerConfig(db, org, b, 'SELLER_PAYS')

  const configs = await accountConfig.loadAccountPayerConfigs(db, org)
  assert.equal(configs[a], 'MARKETPLACE_PAYS')
  assert.equal(configs[b], 'SELLER_PAYS')

  // Cozumleme de BAGIMSIZ.
  assert.equal(
    payer.resolveShippingBillingParty({ marketplace: 'n11', marketplaceAccountConfig: configs[a] })
      .payer,
    'MARKETPLACE_PAYS',
  )
  assert.equal(
    payer.resolveShippingBillingParty({ marketplace: 'n11', marketplaceAccountConfig: configs[b] })
      .payer,
    'SELLER_PAYS',
  )
  // SAGLAYICI GENELI EZME YOK: biri digerini degistirmedi.
  assert.notEqual(configs[a], configs[b])
})

test('BP-6: kiraci A, kiraci Bnin odeyen yapilandirmasini GOREMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'bp-6-a')
  const orgB = await makeOrg(db, 'bp-6-b')
  const bAccount = await makeAccount(db, orgB, 'n11', 'b-acct')
  await accountConfig.setAccountPayerConfig(db, orgB, bAccount, 'SELLER_PAYS')

  const aConfigs = await accountConfig.loadAccountPayerConfigs(db, orgA)
  assert.deepEqual(aConfigs, {}, 'A hicbir yapilandirma GORMEZ')
  assert.equal(JSON.stringify(aConfigs).includes(bAccount), false)

  const bConfigs = await accountConfig.loadAccountPayerConfigs(db, orgB)
  assert.equal(bConfigs[bAccount], 'SELLER_PAYS')

  // Kapsamsiz okuma/yazma fail-closed.
  for (const bad of ['', '   ', null, undefined]) {
    await assert.rejects(
      () => accountConfig.loadAccountPayerConfigs(db, bad),
      accountConfig.TenantScopeMissingError,
    )
  }
  // Baska kiracinin hesabina yazilamaz.
  await assert.rejects(
    () => accountConfig.setAccountPayerConfig(db, orgA, bAccount, 'SELLER_PAYS'),
    accountConfig.AccountNotInTenantError,
  )
})

// ── AYRIM: ABONELİK ↔ KARGO ÖDEYENİ ───────────────────────────────────────

test('BP-14: abonelik plani kargo odeyenini ETKILEMEZ', async () => {
  const subscription = await import('./subscription/planCatalog.ts')
  const before = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    verifiedOrderSignal: 'SELLER',
  })
  // En yuksek plan bile odeyeni DEGISTIRMEZ.
  void subscription.PLAN_CATALOG.tier_advanced
  const after = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    verifiedOrderSignal: 'SELLER',
  })
  assert.deepEqual(after, before)

  // Odeyen cozumleyicisi abonelik modulunu IMPORT ETMEZ.
  //
  // Bagimlilik YALNIZ import satirlarindan okunur: dosyanin AYRIMI ACIKLAYAN
  // yorumu "subscription" kelimesini gecirir ve ham metin taramasi bunu
  // bagimlilik sanardi (ilk kosuda gercekten oldu).
  const source = readFileSync(join(here, 'shipments', 'shippingBillingParty.ts'), 'utf8')
  const imports = [...source.matchAll(/^\s*import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  for (const specifier of imports) {
    for (const forbidden of ['subscription', 'planCatalog', 'featureAccess', 'entitlement']) {
      assert.equal(
        specifier.includes(forbidden),
        false,
        `odeyen modulu abonelige bagli: ${specifier}`,
      )
    }
  }
  // Kod govdesinde de abonelik tipi KULLANILMAZ.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  for (const forbidden of ['planCatalog', 'featureAccess', 'PLAN_CATALOG', 'BillableCapability']) {
    assert.equal(code.includes(forbidden), false, `kodda abonelik kullanimi: ${forbidden}`)
  }
})

test('BP-15: kargo odeyeni abonelik hakkini ETKILEMEZ', async () => {
  const featureAccess = await import('./subscription/featureAccess.ts')
  const build = () =>
    featureAccess.resolveFeatureAccess({
      capability: 'labels.bulk_print',
      planId: 'tier_standard',
    })
  const before = build()
  void payer.resolveShippingBillingParty({ marketplace: 'trendyol', verifiedOrderSignal: 'SELLER' })
  assert.deepEqual(build(), before)

  // Abonelik modulleri kargo odeyenini YENIDEN TANIMLAMAZ.
  for (const file of ['planCatalog.ts', 'featureAccess.ts', 'planRepository.ts']) {
    const source = readFileSync(join(here, 'subscription', file), 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    for (const forbidden of ['MARKETPLACE_PAYS', 'SELLER_PAYS', 'whoPays', 'billingParty']) {
      assert.equal(
        code.includes(forbidden),
        false,
        `abonelik modulu kargo odeyenini yeniden tanimliyor: ${file}/${forbidden}`,
      )
    }
  }
})

test('BP-16: odeyen yapilandirmasi SIR TASIMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bp-16')
  const account = await makeAccount(db, org, 'n11', 'acct')
  await accountConfig.setAccountPayerConfig(db, org, account, 'SELLER_PAYS')
  const configs = await accountConfig.loadAccountPayerConfigs(db, org)
  const serialized = JSON.stringify(configs)
  for (const secret of ['password', 'apiKey', 'apiSecret', 'token', 'credential']) {
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, secret)
  }
})

// ── ROTA KAPISI ────────────────────────────────────────────────────────────

test('BP-17: UNKNOWN → CONFIG_REQUIRED; sessiz dogrudan-tasiyici DUSUSU YOK', () => {
  const unknown = payer.resolveShippingBillingParty({ marketplace: 'hepsiburada' })
  assert.deepEqual(payer.routingGateForPayer(unknown), {
    gate: 'CONFIG_REQUIRED',
    reasonCode: 'PAYER_UNKNOWN',
  })
  const known = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    verifiedOrderSignal: 'TRENDYOL',
  })
  assert.equal(payer.routingGateForPayer(known).gate, 'ALLOWED')
})

// ── MEVCUT MODEL KORUNDU ───────────────────────────────────────────────────

test('BP-18: kanitlanmis Surat/Trendyol modeli DEGISMEDI', () => {
  assert.deepEqual([...suratBilling.BILLING_PARTIES], ['SELLER', 'TRENDYOL', 'UNKNOWN'])
  assert.equal(suratBilling.SURAT_WHO_PAYS_SELLER, '1')
  assert.equal(suratBilling.SURAT_WHO_PAYS_TRENDYOL, '3')
  assert.equal(suratBilling.normalizeSuratWhoPays('1'), 'SELLER')
  assert.equal(suratBilling.normalizeSuratWhoPays('3'), 'TRENDYOL')
  assert.equal(suratBilling.normalizeSuratWhoPays(''), 'UNKNOWN')
})
