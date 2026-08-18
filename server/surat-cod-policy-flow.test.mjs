import assert from 'node:assert/strict'
import test from 'node:test'

// FAZ D — COD KİMLİK POLİTİKASI VE BAĞIMSIZLIK.
// COD ayrı bir eksendir: BillingParty'yi DEĞİŞTİRMEZ, ondan TÜREMEZ.

const GATE = await import('./shipments/suratFinancialGate.ts')
const ROUTING = await import('./shipments/suratRoutingModel.ts')

const CONFIG = {
  liveKullaniciAdi: 'PRIMARY_1111', liveSifre: 'PRIMARY_SECRET',
  sellerPaysKullaniciAdi: 'SELLER_2222', sellerPaysSifre: 'SELLER_SECRET',
  codKullaniciAdi: 'COD_3333', codSifre: 'COD_SECRET',
  odemeTipi: 1,
}
const ORDER = {
  marketplace: 'Trendyol', orderNumber: '1141234567', packageId: 'PKG-1',
  cargoTrackingNumber: '7270035942963454', rawOrder: {},
}
const gate = (over = {}) => GATE.evaluateSuratFinancialGate({
  config: { ...CONFIG, ...(over.config ?? {}) },
  order: { ...ORDER, ...(over.order ?? {}) },
  cashOnDelivery: over.cashOnDelivery === true,
  serviceMode: 'SURAT_CANONICAL_API',
})
const SELLER = { rawOrder: { whoPays: 1 } }

/* ═══ 2×2 MATRİS — COD ile FATURA TARAFI BAĞIMSIZ ════════════════════ */

const MATRIX = [
  { name: 'TRENDYOL_PAYS + COD yok', over: {}, party: 'TRENDYOL_PAYS', who: '3', cod: false },
  { name: 'SELLER_PAYS + COD yok', over: { order: SELLER }, party: 'SELLER_PAYS', who: '1', cod: false },
  { name: 'TRENDYOL_PAYS + COD', over: { cashOnDelivery: true }, party: 'TRENDYOL_PAYS', who: '3', cod: true },
  { name: 'SELLER_PAYS + COD', over: { order: SELLER, cashOnDelivery: true }, party: 'SELLER_PAYS', who: '1', cod: true },
]

for (const row of MATRIX) {
  test(`COD-M: ${row.name}`, () => {
    const fp = gate(row.over).financialFingerprint
    assert.equal(fp.billingParty, row.party)
    assert.equal(fp.expectedSuratWhoPays, row.who)
    assert.equal(fp.codEnabled, row.cod)
  })
}

test('COD-1: COD anahtari BillingParty DEGISTIRMEZ', () => {
  const off = gate().financialFingerprint
  const on = gate({ cashOnDelivery: true }).financialFingerprint
  assert.equal(off.billingParty, on.billingParty)
  assert.equal(off.expectedSuratWhoPays, on.expectedSuratWhoPays)
  // Ama kimlik rolu DEGISIR — para AYRI cariden tahsil edilir.
  assert.notEqual(off.credentialRole, on.credentialRole)
})

test('COD-2: BillingParty COD durumunu DEGISTIRMEZ', () => {
  assert.equal(gate().financialFingerprint.codEnabled, false)
  assert.equal(gate({ order: SELLER }).financialFingerprint.codEnabled, false)
})

test('COD-3: OdemeTipi BillingParty TUREMEZ', () => {
  const pesin = gate({ config: { odemeTipi: 1 } }).financialFingerprint
  const alici = gate({ config: { odemeTipi: 2 } }).financialFingerprint
  assert.equal(pesin.billingParty, alici.billingParty)
  assert.notEqual(pesin.odemeTipi, alici.odemeTipi)
})

/* ═══ POLİTİKA — SESSİZ FALLBACK YOK ═════════════════════════════════ */

test('COD-4: DEDICATED_COD + kimlik yok → BLOCK, ag 0', () => {
  const result = gate({
    cashOnDelivery: true,
    config: { codCredentialPolicy: 'DEDICATED_COD', codKullaniciAdi: '', codSifre: '' },
  })
  assert.equal(result.ok, false, 'TASIYICIYA GIDILMEMELI')
  assert.ok(result.trace.preflightFailures.length > 0)
  // Sessizce SELLER_PAYS/PRIMARY kimligine DUSMEZ.
  assert.notEqual(result.financialFingerprint.credentialRole, 'SELLER_PAYS')
  assert.notEqual(result.financialFingerprint.credentialRole, 'PRIMARY_MARKETPLACE')
})

test('COD-5: SELLER_PAYS politikasi ACIKCA secilir', () => {
  const result = gate({
    cashOnDelivery: true,
    config: { codCredentialPolicy: 'SELLER_PAYS', codKullaniciAdi: '', codSifre: '' },
  })
  assert.equal(result.ok, true, 'acik secim GECERLI')
  assert.equal(result.financialFingerprint.credentialRole, 'SELLER_PAYS')
  // Fatura tarafi yine DEGISMEZ.
  assert.equal(result.financialFingerprint.billingParty, 'TRENDYOL_PAYS')
})

test('COD-6: PRIMARY politikasi ACIKCA secilir', () => {
  const result = gate({
    cashOnDelivery: true,
    config: { codCredentialPolicy: 'PRIMARY', codKullaniciAdi: '', codSifre: '' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.financialFingerprint.credentialRole, 'PRIMARY_MARKETPLACE')
  assert.equal(result.financialFingerprint.billingParty, 'TRENDYOL_PAYS')
})

test('COD-7: politika enum ve varsayilan sabit', () => {
  assert.deepEqual([...ROUTING.COD_CREDENTIAL_POLICIES],
    ['DEDICATED_COD', 'SELLER_PAYS', 'PRIMARY'])
  assert.equal(ROUTING.DEFAULT_COD_CREDENTIAL_POLICY, 'DEDICATED_COD')
  // Gecersiz politika sessizce kabul EDILMEZ.
  assert.equal(
    ROUTING.resolveCodCredentialPolicy('UYDURMA'),
    ROUTING.DEFAULT_COD_CREDENTIAL_POLICY,
  )
})

test('COD-8: tahsilat tipi NAKIT/POS anlamlari', () => {
  assert.equal(ROUTING.COD_COLLECTION_TYPES['1'], 'NAKIT')
  assert.equal(ROUTING.COD_COLLECTION_TYPES['2'], 'POS')
})
