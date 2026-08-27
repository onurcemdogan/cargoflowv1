import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ ARKA PLAN ETİKET — GÜVENLİK MATRİSİ ═════════════════════════════════
//
// Taşıyıcı etiketi GERİ ALINAMAZ ve FATURALANABİLİR. Bu paket, otomatik
// üretimin mükerrer gönderi yaratamayacağını kilitler.

const AUTO = await import('./shipments/suratAutoLabelPolicy.ts')
const here = new URL('.', import.meta.url)

const SCOPE = {
  organizationId: 'org-1', marketplace: 'Trendyol', carrier: 'Surat',
}
// AKTIVASYON SINIRI: kiracinin otomatik etiketi ACTIGI an. Yalniz bu andan
// SONRA ilk kez gorulen paketler otomatik siraya girer.
const ACTIVATED_AT = '2026-08-27T00:00:00.000Z'
const AFTER_ACTIVATION = Date.parse('2026-08-27T06:00:00.000Z')
const BEFORE_ACTIVATION = Date.parse('2026-08-26T18:00:00.000Z')

const ENABLED = {
  enabled: true, marketplaces: ['trendyol'], carriers: ['surat'],
  activatedAt: ACTIVATED_AT,
}
const base = (over = {}) => ({
  scope: SCOPE, packageId: 'PKG-1', settings: ENABLED,
  eligibility: { eligible: true, reasons: [] },
  billingResolved: true, credentialResolved: true,
  hasLabelArtifact: false, hasCarrierArtifact: false,
  previousNetworkCrossed: false,
  firstSeenAtMs: AFTER_ACTIVATION, ...over,
})

/* ═══ VARSAYILAN KAPALI ════════════════════════════════════════════ */

test('AUTO-DEFAULT: varsayilan KAPALI — sessiz etkinlesme YOK', () => {
  assert.equal(AUTO.AUTO_LABEL_DEFAULT_ENABLED, false)
  // Ayar YOKSA kapali.
  assert.equal(
    AUTO.resolveAutoLabelEnqueue(base({ settings: null })).enqueue, false,
  )
  // `enabled` acikca true DEGILSE kapali.
  for (const settings of [{}, { enabled: false }, { marketplaces: ['trendyol'] }]) {
    const d = AUTO.resolveAutoLabelEnqueue(base({ settings }))
    assert.equal(d.enqueue, false)
    assert.equal(d.blockReason, 'AUTO_LABEL_DISABLED')
  }
})

test('AUTO-SCOPE: pazaryeri/tasiyici kapsami disinda SIRAYA ALINMAZ', () => {
  const otherMarketplace = AUTO.resolveAutoLabelEnqueue(base({
    scope: { ...SCOPE, marketplace: 'Hepsiburada' },
  }))
  assert.equal(otherMarketplace.enqueue, false)
  assert.equal(otherMarketplace.blockReason, 'MARKETPLACE_NOT_ENABLED')

  const otherCarrier = AUTO.resolveAutoLabelEnqueue(base({
    scope: { ...SCOPE, carrier: 'Aras' },
  }))
  assert.equal(otherCarrier.enqueue, false)
  assert.equal(otherCarrier.blockReason, 'CARRIER_NOT_ENABLED')
})

/* ═══ AUTO-1 / AUTO-2 — TEKİLLİK ═══════════════════════════════════ */

test('AUTO-1: webhook + stream AYNI paket icin AYNI is anahtari', () => {
  const fromWebhook = AUTO.autoLabelJobKey({ ...SCOPE, packageId: 'PKG-9' })
  const fromStream = AUTO.autoLabelJobKey({ ...SCOPE, packageId: 'PKG-9' })
  assert.equal(fromWebhook, fromStream, 'iki kaynak IKI is yaratirdi')
  // Buyuk/kucuk harf ve bosluk farki anahtari BOLMEZ.
  assert.equal(
    AUTO.autoLabelJobKey({
      organizationId: ' ORG-1 ', marketplace: 'TRENDYOL',
      carrier: ' Surat', packageId: 'PKG-9',
    }),
    fromWebhook,
  )
  // FARKLI paket → FARKLI anahtar.
  assert.notEqual(
    AUTO.autoLabelJobKey({ ...SCOPE, packageId: 'PKG-10' }), fromWebhook,
  )
})

test('AUTO-2: is iki kez calissa da etiket varsa TASIYICIYA GIDILMEZ', () => {
  const second = AUTO.resolveAutoLabelEnqueue(base({ hasLabelArtifact: true }))
  assert.equal(second.enqueue, false)
  assert.equal(second.blockReason, 'LABEL_ALREADY_PRESENT')
  // Tasiyici artefakti varsa da hayir.
  assert.equal(
    AUTO.resolveAutoLabelEnqueue(base({ hasCarrierArtifact: true })).blockReason,
    'CARRIER_ARTIFACT_PRESENT',
  )
})

/* ═══ AUTO-3 — HAZIR ETİKET, SIFIR ÇAĞRI ═══════════════════════════ */

test('AUTO-3: HAZIR etikette buton tasiyici cagrisi = 0', () => {
  const ready = AUTO.resolveLabelButtonAction({
    jobState: 'READY', hasStoredLabel: true, eligible: true,
  })
  assert.equal(ready.action, 'OPEN_STORED_LABEL')
  assert.equal(ready.carrierCalls, 0)
  // Is durumu bilinmese de saklanmis etiket varsa cagri YOK.
  assert.equal(
    AUTO.resolveLabelButtonAction({
      jobState: null, hasStoredLabel: true, eligible: true,
    }).carrierCalls, 0,
  )
})

test('AUTO-3b: hazirlanirken buton IKINCI create ACMAZ', () => {
  for (const state of ['QUEUED', 'PREPARING']) {
    const d = AUTO.resolveLabelButtonAction({
      jobState: state, hasStoredLabel: false, eligible: true,
    })
    assert.equal(d.action, 'SHOW_PREPARING')
    assert.equal(d.carrierCalls, 0)
  }
})

/* ═══ AUTO-4 — BELİRSİZLİK CREATE AÇMAZ ════════════════════════════ */

test('AUTO-4: faturalama/kimlik cozulmediyse tasiyici cagrisi 0', () => {
  assert.equal(
    AUTO.resolveAutoLabelEnqueue(base({ billingResolved: false })).blockReason,
    'BILLING_UNRESOLVED',
  )
  assert.equal(
    AUTO.resolveAutoLabelEnqueue(base({ credentialResolved: false })).blockReason,
    'CREDENTIAL_UNRESOLVED',
  )
})

/* ═══ AUTO-7 — AĞ GEÇİLDİ, OTOMATİK TEKRAR YOK ═════════════════════ */

test('AUTO-7: ag sinirindan sonra belirsizlik OTOMATIK tekrar ACMAZ', () => {
  const state = AUTO.resolveAutoLabelJobState({
    networkCrossed: true, labelReady: false,
  })
  assert.equal(state.state, 'UNKNOWN_AFTER_NETWORK')
  assert.equal(state.retryAllowed, false)
  // Bu durumda buton da create SUNMAZ.
  const button = AUTO.resolveLabelButtonAction({
    jobState: 'UNKNOWN_AFTER_NETWORK', hasStoredLabel: false, eligible: true,
  })
  assert.equal(button.action, 'REQUIRES_RECONCILIATION')
  assert.equal(button.carrierCalls, 0)
  // Ve bu paket bir daha SIRAYA ALINMAZ.
  assert.equal(
    AUTO.resolveAutoLabelEnqueue(base({ previousNetworkCrossed: true })).blockReason,
    'PREVIOUS_NETWORK_CROSSED',
  )
})

test('AUTO-7b: ag GECILMEDIYSE guvenle tekrar denenebilir', () => {
  const safe = AUTO.resolveAutoLabelJobState({
    networkCrossed: false, labelReady: false,
  })
  assert.equal(safe.state, 'FAILED_SAFE_TO_RETRY')
  assert.equal(safe.retryAllowed, true)
})

/* ═══ AUTO-8 — UYGUN OLMAYAN SİPARİŞ ═══════════════════════════════ */

test('AUTO-8: iptal/uygun-degil siparis icin tasiyici cagrisi 0', () => {
  const d = AUTO.resolveAutoLabelEnqueue(base({
    eligibility: { eligible: false, reasons: ['CANCELLED'] },
  }))
  assert.equal(d.enqueue, false)
  assert.equal(d.blockReason, 'NOT_ELIGIBLE')
  assert.ok(d.reason.includes('CANCELLED'))
})

/* ═══ EŞZAMANLILIK ═════════════════════════════════════════════════ */

test('AUTO-CONCURRENCY: sinirli parti — binlerce es zamanli create YOK', () => {
  const items = Array.from({ length: 1000 }, (_, i) => i)
  const batches = AUTO.planAutoLabelBatches(items)
  assert.ok(batches.length > 1, 'tek partide 1000 create acilirdi')
  for (const batch of batches) {
    assert.ok(
      batch.length <= AUTO.AUTO_LABEL_CONCURRENCY.global,
      'kuresel esszamanlilik siniri asildi',
    )
  }
  assert.equal(batches.flat().length, 1000, 'is KAYBOLDU')
  // Sinirlar MERKEZI — kod tabanina dagitilmaz.
  assert.ok(AUTO.AUTO_LABEL_CONCURRENCY.perCarrier > 0)
  assert.ok(AUTO.AUTO_LABEL_CONCURRENCY.perTenant > 0)
})

/* ═══ MUTLU YOL ════════════════════════════════════════════════════ */

test('AUTO-HAPPY: acik kiracida uygun paket SIRAYA ALINIR', () => {
  const d = AUTO.resolveAutoLabelEnqueue(base())
  assert.equal(d.enqueue, true)
  assert.equal(d.blockReason, null)
  assert.equal(d.jobKey, 'org-1:trendyol:surat:PKG-1:label_prepare')
})

test('AUTO-NO-SECOND-IMPL: politika KENDI create/uygunluk mantigini KURMAZ', () => {
  // Uygunluk GERCEK create kapisindan gecirilir; ikinci kopya olsaydi elle
  // create ile arka plan AYRISIRDI.
  const source = readFileSync(
    new URL('./shipments/suratAutoLabelPolicy.ts', here), 'utf8',
  )
  for (const forbidden of [
    'fetch(', 'createSuratCommonBarcodeSoap', 'OrtakBarkodOlustur',
    'kullaniciAdi', 'whoPays',
  ]) {
    assert.equal(source.includes(forbidden), false, `politika sinirini asiyor: ${forbidden}`)
  }
})

test('AUTO-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  // Liste `package.json`'dan AYRI bir dosyada: 190 dosyada komut satiri
  // Windows cmd.exe'nin 8191 karakter sinirini asiyordu ve paket
  // CALISMADAN dusuyordu. Acik kayit KORUNUR, yalnizca yeri degisti.
  const listed = new Set(
    JSON.parse(readFileSync(new URL('./testing/suratSuiteFiles.json', here), 'utf8')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})

/* ═══ AKTIVASYON SINIRI ════════════════════════════════════════════ */

test('AUTO-BOUNDARY-1: GECMIS yigin otomatik SIRAYA ALINMAZ', () => {
  // KOK RISK: bayrak acildiginda kiracinin acik sekmesinde binlerce uygun
  // GECMIS paket bekliyor olabilir. Sinir olmasaydi tek bir ayar degisikligi
  // binlerce GERI ALINAMAZ ve FATURALANABILIR Surat etiketi uretirdi.
  const d = AUTO.resolveAutoLabelEnqueue(
    base({ firstSeenAtMs: BEFORE_ACTIVATION }),
  )
  assert.equal(d.enqueue, false)
  assert.equal(d.blockReason, 'BEFORE_ACTIVATION_BOUNDARY')
})

test('AUTO-BOUNDARY-2: sinir YOKSA hicbir paket siraya girmez (fail-safe)', () => {
  // "Sinir tanimsiz" ASLA "sinirsiz" demek degildir.
  for (const settings of [
    { enabled: true, marketplaces: ['trendyol'], carriers: ['surat'] },
    { enabled: true, marketplaces: ['trendyol'], carriers: ['surat'], activatedAt: '' },
    { enabled: true, marketplaces: ['trendyol'], carriers: ['surat'], activatedAt: 'gecersiz' },
  ]) {
    const d = AUTO.resolveAutoLabelEnqueue(base({ settings }))
    assert.equal(d.enqueue, false, JSON.stringify(settings))
    assert.equal(d.blockReason, 'BEFORE_ACTIVATION_BOUNDARY')
  }
  assert.equal(AUTO.resolveActivationBoundary(null), null)
  assert.equal(AUTO.resolveActivationBoundary({ activatedAt: ACTIVATED_AT }),
    Date.parse(ACTIVATED_AT))
})

test('AUTO-BOUNDARY-3: ilk gorulme ZAMANI bilinmiyorsa siraya girmez', () => {
  for (const firstSeenAtMs of [undefined, null, NaN, 'dun']) {
    const d = AUTO.resolveAutoLabelEnqueue(base({ firstSeenAtMs }))
    assert.equal(d.enqueue, false, String(firstSeenAtMs))
    assert.equal(d.blockReason, 'BEFORE_ACTIVATION_BOUNDARY')
  }
})

test('AUTO-BOUNDARY-4: sinirdan SONRA gorulen paket siraya GIRER', () => {
  const d = AUTO.resolveAutoLabelEnqueue(
    base({ firstSeenAtMs: AFTER_ACTIVATION }),
  )
  assert.equal(d.enqueue, true)
  assert.equal(d.blockReason, null)
  // Tam sinirin USTUNDE olan paket de kabul edilir (>= karsilastirmasi).
  assert.equal(
    AUTO.resolveAutoLabelEnqueue(
      base({ firstSeenAtMs: Date.parse(ACTIVATED_AT) }),
    ).enqueue,
    true,
  )
})
