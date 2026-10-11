// BILLING-PARTY-CLOSEOUT-001 — KANIT SAHTECİLİĞİ VE ÜRÜNE BAĞLAMA.
//
// ═══ ÖLÇÜLEN AÇIK ════════════════════════════════════════════════════════
//
// `verifiedOrderSignal` DÜZ bir `BillingParty` idi: HERHANGİ bir çağıran
// `'TRENDYOL'` yazarak `ORDER_CONTRACT` kökeni UYDURABİLİYORDU. Köken
// iddiası artık KANITIN KENDİSİYLE gelmek zorunda ve kanıt seviyesi mevcut
// forensic modelden (`suratBillingParty`) OLDUĞU GİBİ taşınır.
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
const payer = await import('./shipments/shippingBillingParty.ts')
const suratBilling = await import('./shipments/suratBillingParty.ts')
const accountConfig = await import('./shipments/marketplacePayerConfig.ts')
const ingestion = await import('./shipments/trendyolLiveOrderIngestion.ts')

/**
 * CANLI YANIT SINIRINDAN kanit uretir — kanidin TEK dogum yolu budur.
 *
 * PROVENANCE-FINAL'den once burada `createTrendyolOrderContractEvidence`
 * cagriliyordu; o genel fabrika `(rastgeleYuk, { origin: 'LIVE_...' })`
 * kabul ettigi icin KALDIRILDI (bkz. PROV-1).
 */
function liveEvidence(rawPackage, packageId = 'P1') {
  const outcome = ingestion.ingestTrendyolLiveOrderResponse({
    ok: true,
    statusCode: 200,
    requestUrl:
      'https://apigw.trendyol.com/integration/order/sellers/277221/v2/orders?page=0&size=50',
    contentType: 'application/json',
    rawResponseText: JSON.stringify({ content: [rawPackage] }),
  })
  return outcome.evidenceByPackageId.get(packageId)
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

// ── KANIT SAHTECİLİĞİ ──────────────────────────────────────────────────────

test('BPX-1: DUZ deger UYDURMA koken URETEMEZ', () => {
  // Eski API sekli (duz deger) artik ORDER_CONTRACT vermez.
  const forged = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    verifiedOrderSignal: 'TRENDYOL',
  })
  assert.notEqual(forged.provenance, 'ORDER_CONTRACT', 'duz deger koken KANITI DEGILDIR')
  assert.equal(forged.payer, 'UNKNOWN')

  // Kanit nesnesi verilse bile seviye/kaynak yetersizse REDDEDILIR.
  const insufficient = [
    { evidence: 'UNVERIFIED_HISTORICAL_RAW', provenance: 'PROVIDER_RAW' },
    { evidence: 'UNKNOWN', provenance: 'PROVIDER_RAW' },
    { evidence: 'CONFIRMED_PROVIDER_CONTRACT', provenance: 'NORMALIZED_COPY' },
    { evidence: 'CONFIRMED_PROVIDER_CONTRACT', provenance: 'RECONSTRUCTED' },
    { evidence: 'CONFIRMED_PROVIDER_CONTRACT', provenance: 'UNKNOWN' },
  ]
  for (const bad of insufficient) {
    const result = payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: { billingParty: 'TRENDYOL', ...bad },
    })
    assert.notEqual(
      result.provenance,
      'ORDER_CONTRACT',
      `yetersiz kanit koken URETTI: ${JSON.stringify(bad)}`,
    )
  }
})

test('BPX-2: DOGRULANMIS saglayici sozlesmesi kaniti DOGRU cozulur', () => {
  // Kanit CANLI YANIT SINIRINDA dogar; taraf karari forensic modulden gelir.
  const live = liveEvidence({ packageId: 'P1', orderNumber: 'N1', whoPays: '1' })
  assert.equal(live.evidence, 'CONFIRMED_PROVIDER_CONTRACT')
  assert.equal(live.provenance, 'PROVIDER_RAW')
  assert.equal(live.billingParty, 'SELLER')

  // KANIT O SINIRDAN gecmelidir: alanlari kopyalamak YETMEZ (BPZ-1).
  const result = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    orderContractEvidence: live,
  })
  assert.equal(result.payer, 'SELLER_PAYS')
  assert.equal(result.provenance, 'ORDER_CONTRACT')
  assert.equal(result.reasonCode, 'CONFIRMED_PROVIDER_CONTRACT_EVIDENCE')
})

test('BPX-3: GECMIS ham veri kaniti sozlesme SAYILMAZ, alt kaynaga DUSER', () => {
  const historical = suratBilling.inspectTrendyolBillingSource({
    rawOrder: { packageId: 'P1', orderNumber: 'N1', whoPays: '1' },
  })
  assert.notEqual(historical.evidence, 'CONFIRMED_PROVIDER_CONTRACT')

  const evidence = {
    billingParty: historical.billingParty,
    evidence: historical.evidence,
    provenance: historical.provenance,
  }
  // Yapilandirma YOKSA UNKNOWN.
  assert.equal(
    payer.resolveShippingBillingParty({ marketplace: 'trendyol', orderContractEvidence: evidence })
      .payer,
    'UNKNOWN',
  )
  // Hesap ayari VARSA ONA duser (sozlesme kanitina DEGIL).
  const fallback = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    orderContractEvidence: evidence,
    marketplaceAccountConfig: 'MARKETPLACE_PAYS',
  })
  assert.equal(fallback.payer, 'MARKETPLACE_PAYS')
  assert.equal(fallback.provenance, 'ACCOUNT_CONFIG')
})

// ── ÜRÜNE BAĞLAMA: GİDİŞ-DÖNÜŞ ────────────────────────────────────────────

test('BPX-4: hesap gorunumu yuklenir, secim KALICI olur ve GERI OKUNUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bpx-4')
  const n11Account = await makeAccount(db, org, 'n11', 'n11-1')
  const trendyolAccount = await makeAccount(db, org, 'trendyol', '277221')

  const before = await accountConfig.loadAccountPayerView(db, org)
  assert.equal(before.length, 2)
  const n11Before = before.find((row) => row.marketplaceAccountId === n11Account)
  const tyBefore = before.find((row) => row.marketplaceAccountId === trendyolAccount)

  // Trendyol: sozlesmeden turetilir → operatore SORULMAZ.
  assert.equal(tyBefore.evidenceClass, 'CAN_DERIVE_FROM_ORDER')
  assert.equal(tyBefore.configurable, false)
  // n11: hesap ayari gerekir, baslangicta secilmemis.
  assert.equal(n11Before.evidenceClass, 'ACCOUNT_CONFIG_REQUIRED')
  assert.equal(n11Before.configurable, true)
  assert.equal(n11Before.payer, 'UNKNOWN')

  // YAZ → GERI OKU.
  await accountConfig.setAccountPayerConfig(db, org, n11Account, 'SELLER_PAYS')
  const after = await accountConfig.loadAccountPayerView(db, org)
  assert.equal(
    after.find((row) => row.marketplaceAccountId === n11Account).payer,
    'SELLER_PAYS',
    'secim KALICI ve GERI OKUNUR',
  )
  // Kardes hesap ETKILENMEDI.
  assert.equal(
    after.find((row) => row.marketplaceAccountId === trendyolAccount).payer,
    'UNKNOWN',
  )
  // Gorunum SIR tasimaz.
  const serialized = JSON.stringify(after)
  for (const secret of ['password', 'apiKey', 'apiSecret', 'token', 'encrypted']) {
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, secret)
  }
})

test('BPX-5: gecersiz odeyen degeri REDDEDILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bpx-5')
  const account = await makeAccount(db, org, 'n11', 'n11-1')
  for (const bad of ['', 'BUYER_PAYS', 'seller', 'true', 'PLATFORM_PAYS']) {
    await assert.rejects(
      () => accountConfig.setAccountPayerConfig(db, org, account, bad),
      accountConfig.InvalidPayerValueError,
      `kabul EDILMEMELIYDI: ${bad}`,
    )
  }
})

test('BPX-6: baska kiracinin hesabina YAZILAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'bpx-6-a')
  const orgB = await makeOrg(db, 'bpx-6-b')
  const bAccount = await makeAccount(db, orgB, 'n11', 'b-1')

  await assert.rejects(
    () => accountConfig.setAccountPayerConfig(db, orgA, bAccount, 'SELLER_PAYS'),
    accountConfig.AccountNotInTenantError,
  )
  // B'nin ayari DEGISMEDI.
  assert.deepEqual(await accountConfig.loadAccountPayerConfigs(db, orgB), {})
  // A hicbir hesap GORMEZ.
  assert.deepEqual(await accountConfig.loadAccountPayerView(db, orgA), [])
})

// ── API YÜZEYİ ─────────────────────────────────────────────────────────────

test('BPX-7: odeyen ucu kiraci govdeden ALMAZ, sir ve saglayici cagrisi ICERMEZ', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = source.indexOf("app.get('/api/shipping/payer'")
  assert.ok(start > 0, 'odeyen ucu bulunamadi')
  const end = source.indexOf("app.get('/api/subscription/status'")
  assert.ok(end > start)
  const block = source.slice(start, end)

  assert.match(block, /requireOnboardingContext/)
  assert.equal(
    /organizationId\s*[:=]\s*(request|req)\.body/.test(block),
    false,
    'kiraci govdeden ALINAMAZ',
  )
  for (const forbidden of ['fetch(', 'axios', 'apiKey', 'apiSecret', 'password']) {
    assert.equal(block.includes(forbidden), false, `odeyen ucunda yasak: ${forbidden}`)
  }
  // Sahiplik hatasi 404, gecersiz deger 400 olarak AYRISIR.
  assert.match(block, /AccountNotInTenantError/)
  assert.match(block, /InvalidPayerValueError/)
})

test('BPX-8: UNKNOWN hala CONFIG_REQUIRED kapisi uretir', () => {
  const unknown = payer.resolveShippingBillingParty({ marketplace: 'n11' })
  assert.equal(payer.routingGateForPayer(unknown).gate, 'CONFIG_REQUIRED')
  const chosen = payer.resolveShippingBillingParty({
    marketplace: 'n11',
    marketplaceAccountConfig: 'MARKETPLACE_PAYS',
  })
  assert.equal(payer.routingGateForPayer(chosen).gate, 'ALLOWED')
})

test('BPX-9: abonelik duzeltmeleri ve ayrimi KORUNDU', async () => {
  const planRepo = await import('./subscription/planRepository.ts')
  // ec21c97: tasiyici saglayici listesi ve fail-closed plan cozumlemesi.
  assert.deepEqual([...planRepo.CARRIER_PROVIDERS], ['surat'])
  assert.ok(planRepo.PLAN_RESOLUTIONS.includes('INVALID_ASSIGNMENT'))
  assert.ok(planRepo.PLAN_RESOLUTIONS.includes('LEGACY_NO_ASSIGNMENT'))

  // Odeyen modulu abonelik modulunu IMPORT ETMEZ (import satirlari).
  const source = readFileSync(join(here, 'shipments', 'shippingBillingParty.ts'), 'utf8')
  const imports = [...source.matchAll(/^\s*import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  for (const specifier of imports) {
    assert.equal(specifier.includes('subscription'), false, specifier)
  }
})


// ═══ CLOSEOUT-002 — KANIT ARTIK ÜRETİLEMEZ (MARKALI) ════════════════════
//
// ÖLÇÜLEN AÇIK (ikinci tur): kanıt ALANLI bir nesne olunca da elle
// kurulabiliyordu. Alanları doğru yazmak, kanıta SAHİP OLMAK DEĞİLDİR.
// Artık yalnız güvenilir fabrikadan geçen nesneler kabul edilir.

test('BPZ-1: ELLE kurulmus mukemmel kanit ORDER_CONTRACT URETEMEZ', () => {
  // Alanlarin HEPSI dogru; yine de fabrikadan gecmedigi icin REDDEDILIR.
  const forged = {
    billingParty: 'TRENDYOL',
    evidence: 'CONFIRMED_PROVIDER_CONTRACT',
    provenance: 'PROVIDER_RAW',
    interpretation: 'elle yazildi',
  }
  assert.equal(payer.isTrustedOrderContractEvidence(forged), false)
  const result = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    orderContractEvidence: forged,
  })
  assert.notEqual(result.provenance, 'ORDER_CONTRACT', 'elle kurulan kanit KABUL EDILDI')
  assert.equal(result.payer, 'UNKNOWN')

  // Gercek kanidin KOPYASI da gecersizdir (marka nesneye baglidir).
  const real = liveEvidence({ packageId: 'P1', orderNumber: 'N1', whoPays: '1' })
  const copy = { ...real }
  assert.equal(payer.isTrustedOrderContractEvidence(copy), false, 'kopya da gecersiz')
  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: copy,
    }).provenance,
    'UNKNOWN',
  )
})

test('BPZ-2: CANLI YANIT SINIRINDAN gecen kanit ORDER_CONTRACT uretir', () => {
  const evidence = liveEvidence({ packageId: 'P1', orderNumber: 'N1', whoPays: '1' })
  assert.equal(payer.isTrustedOrderContractEvidence(evidence), true)
  const result = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    orderContractEvidence: evidence,
  })
  assert.equal(result.payer, 'SELLER_PAYS')
  assert.equal(result.provenance, 'ORDER_CONTRACT')
})

test('BPZ-3: sinir SINIFLANDIRMAYI KOPYALAMAZ, forensic modulu CAGIRIR', () => {
  // Ayni girdi, iki yol → AYNI TARAF karari (seviye canli sinirda yukselir).
  const viaBoundary = liveEvidence({ packageId: 'P1', orderNumber: 'N1' })
  const viaForensic = suratBilling.inspectTrendyolBillingSource({
    rawOrder: { packageId: 'P1', orderNumber: 'N1' },
  })
  assert.equal(viaBoundary.billingParty, viaForensic.billingParty)
  assert.equal(viaBoundary.provenance, viaForensic.provenance)
  assert.equal(viaBoundary.interpretation, viaForensic.interpretation)
  // whoPays alani YOK → sozlesme geregi TRENDYOL oder.
  assert.equal(viaBoundary.billingParty, 'TRENDYOL')
  // Seviye FARKI tam olarak sinirin kattigi seydir.
  assert.equal(viaBoundary.evidence, 'CONFIRMED_PROVIDER_CONTRACT')
  assert.equal(viaForensic.evidence, 'UNVERIFIED_HISTORICAL_RAW')

  // Trendyol karar mantigi NE cozumleyicide NE de sinirda YENIDEN YAZILMIS
  // olmali. (Sinir modulunun kendi taramasi: PROV-NODUP.)
  const source = readFileSync(join(here, 'shipments', 'shippingBillingParty.ts'), 'utf8')
  // SATIR yorumlari ONCE silinir: aksi halde bir satir yorumundaki `/*`
  // dizisi (orn. "server/subscription/*") blok-yorum silicisini yanlis
  // yerden baslatir ve import blogunu YUTAR — tarama sessizce KORLESIR.
  const code = source
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const duplicated of ['whoPays', "'1'", 'hasOwnField', 'readOwnField']) {
    assert.equal(code.includes(duplicated), false, `siniflandirma KOPYALANMIS: ${duplicated}`)
  }
  // Cozumleyici kanidi TUKETIR; kanidi ureten sinirri ISIMLE isaret eder.
  assert.match(code, /trendyolLiveOrderIngestion/)
})

test('BPZ-4: SAKLANMIS yuk sozlesme kaniti URETMEZ', () => {
  // Kalicidan okunan yuk canli sinirdan GECMEZ → markasizdir.
  const persisted = suratBilling.inspectTrendyolBillingSource({
    rawOrder: { packageId: 'P1', orderNumber: 'N1', whoPays: '1' },
  })
  assert.equal(payer.isTrustedOrderContractEvidence(persisted), false)
  assert.notEqual(persisted.evidence, 'CONFIRMED_PROVIDER_CONTRACT')
  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: persisted,
    }).provenance,
    'UNKNOWN',
  )

  // Normalize edilmis kopya canli sinirdan GECSE BILE kanit URETMEZ.
  assert.equal(
    liveEvidence({ packageId: 'P1', marketplace: 'Trendyol', customerName: 'x' }),
    undefined,
  )
})

test('BPZ-5: Trendyol odeyeni YAZMA YOLUNDA da ayarlanamaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bpz-5')
  const trendyol = await makeAccount(db, org, 'trendyol', '277221')
  const n11 = await makeAccount(db, org, 'n11', 'n11-1')

  // UI alani gizlemek YETMEZ: API dogrudan cagrilabilir.
  await assert.rejects(
    () => accountConfig.setAccountPayerConfig(db, org, trendyol, 'SELLER_PAYS'),
    accountConfig.PayerNotConfigurableError,
  )
  // Hicbir sey yazilmadi.
  assert.deepEqual(await accountConfig.loadAccountPayerConfigs(db, org), {})

  // Yapilandirilabilir pazaryeri ETKILENMEZ.
  await accountConfig.setAccountPayerConfig(db, org, n11, 'SELLER_PAYS')
  const configs = await accountConfig.loadAccountPayerConfigs(db, org)
  assert.equal(configs[n11], 'SELLER_PAYS')
  assert.equal(configs[trendyol], undefined)

  // Uc 409 dondurur.
  const endpoint = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(endpoint, /PayerNotConfigurableError/)
  assert.match(endpoint, /409/)
})
