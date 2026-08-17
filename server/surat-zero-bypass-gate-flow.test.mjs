import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// FAZ 5C.2 — SIFIR BYPASS FİNANSAL KAPI.
//
// KABUL KRİTERİ: hangi `serviceMode` seçilirse seçilsin, bozuk finansal
// bağlamda taşıyıcıya ağ çağrısı YAPILAMAZ. Kapı `serviceMode` dallarının
// ALTINDA değil, HEPSİNİN ÜSTÜNDEDİR.

const GATE = await import('./shipments/suratFinancialGate.ts')

const nl = (v) => v.split('\r\n').join('\n')
const codeOf = (file) =>
  nl(readFileSync(file, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

const CONFIG = {
  liveKullaniciAdi: 'PRIMARY_1111',
  liveSifre: 'PRIMARY_SECRET',
  sellerPaysKullaniciAdi: 'SELLER_2222',
  sellerPaysSifre: 'SELLER_SECRET',
  codKullaniciAdi: 'COD_3333',
  codSifre: 'COD_SECRET',
  odemeTipi: 1,
}

const ORDER = {
  marketplace: 'Trendyol',
  orderNumber: '1141234567',
  packageId: 'PKG-1',
  cargoTrackingNumber: '7270035942963454',
  rawOrder: {},
}

const gate = (over = {}) =>
  GATE.evaluateSuratFinancialGate({
    config: { ...CONFIG, ...(over.config ?? {}) },
    order: { ...ORDER, ...(over.order ?? {}) },
    cashOnDelivery: over.cashOnDelivery === true,
    serviceMode: over.serviceMode ?? 'SURAT_CANONICAL_API',
  })

/* ═══ MİMARİ: KAPI DALLARIN ÜSTÜNDE ════════════════════════════════════ */

test('GATE-ARCH: kapi serviceMode dallarindan ONCE calisir', () => {
  const server = codeOf('server/index.mjs')
  const gateAt = server.indexOf('evaluateSuratFinancialGate({')
  assert.ok(gateAt > 0, 'kapi index.mjs de cagrilmali')
  // TUM create serviceMode dallari kapidan SONRA gelmeli.
  for (const mode of GATE.GUARDED_SURAT_SERVICE_MODES) {
    // YALNIZ DISPATCH formu aranir; ust taraftaki dogrulama/isim cozucu
    // karsilastirmalari create dali DEGILDIR.
    const branch = server.indexOf(`if (config.serviceMode === '${mode}') {`)
    if (branch < 0) continue
    assert.ok(branch > gateAt, `${mode} dali kapidan ONCE — BYPASS`)
  }
  // Kanonik dal sabitle karsilastirilir; o da kapidan sonra olmali.
  const canonicalBranch = server.indexOf(
    'if (config.serviceMode === SURAT_CANONICAL_SERVICE_MODE) {',
  )
  assert.ok(canonicalBranch > gateAt, 'kanonik dal kapidan ONCE — BYPASS')
  // Kapi basarisizsa DERHAL donulur; asagi akis yok.
  const block = server.slice(gateAt, gateAt + 900)
  assert.ok(block.includes('if (!financialGate.ok)'))
  assert.ok(block.includes('return'))
})

test('GATE-MODES: bes legacy mod + kanonik AYNI kapidan gecer', () => {
  assert.equal(GATE.GUARDED_SURAT_SERVICE_MODES.length, 6)
  for (const mode of [
    'SURAT_CANONICAL_API',
    'KARGO_BARKODU_SIPARIS_SOAP',
    'ORTAK_BARKOD_SOAP',
    'PRE_REGISTRATION_REST',
    'GONDERI_YENI_SOAP',
    'GONDERI_OLUSTUR_V2_EXPERIMENTAL',
  ]) {
    assert.ok(GATE.GUARDED_SURAT_SERVICE_MODES.includes(mode), mode)
    // Saglikli baglam her modda GECER.
    assert.equal(gate({ serviceMode: mode }).ok, true, `${mode} saglikli`)
    // Bozuk baglam her modda BLOKLANIR.
    assert.equal(
      gate({ serviceMode: mode, order: { cargoTrackingNumber: '' } }).ok,
      false,
      `${mode} bozuk baglamda GECMEMELI`,
    )
  }
})

/* ═══ FAIL-CLOSED DEĞİŞMEZLER — HER MODDA ══════════════════════════════ */

const MUTATIONS = [
  { name: 'UNKNOWN payer', over: { order: { rawOrder: { whoPays: null } } } },
  { name: 'pazaryeri degil', over: { order: { marketplace: 'KendiSitem' } } },
  { name: 'saglayici 727 yok', over: { order: { cargoTrackingNumber: '' } } },
  {
    name: 'birincil kimlik yok',
    over: { config: { liveKullaniciAdi: '', liveSifre: '' } },
  },
  {
    name: 'COD kimligi yok',
    over: { cashOnDelivery: true, config: { codKullaniciAdi: '', codSifre: '' } },
  },
  {
    name: 'SELLER_PAYS kimligi yok',
    over: {
      order: { rawOrder: { whoPays: 1 } },
      config: { sellerPaysKullaniciAdi: '', sellerPaysSifre: '' },
    },
  },
]

for (const mode of GATE.GUARDED_SURAT_SERVICE_MODES) {
  for (const mutation of MUTATIONS) {
    test(`GATE-${mode}: ${mutation.name} → BLOCK`, () => {
      const result = gate({ ...mutation.over, serviceMode: mode })
      assert.equal(result.ok, false)
      assert.ok(result.errorCode, 'hata kodu URETILMELI')
      assert.ok(result.trace.preflightFailures.length > 0)
      // Kapi ag/DB DOKUNMAZ — saf karar.
      assert.equal(typeof result.financialFingerprint, 'object')
    })
  }
}

/* ═══ FİNANSAL FINGERPRINT ═════════════════════════════════════════════ */

test('GATE-FP: fingerprint finansal semantigi TAM tasir, SIR TASIMAZ', () => {
  const result = gate()
  const fp = result.financialFingerprint
  for (const key of [
    'billingParty', 'expectedSuratWhoPays', 'credentialRole', 'odemeTipi',
    'codEnabled', 'codCollectionType', 'pazaryerimi', 'entegrasyonFirmasi',
    'marketplaceIdentitySource', 'marketplaceIdentityPresent',
  ]) {
    assert.ok(key in fp, `${key} fingerprintte OLMALI`)
  }
  assert.equal(fp.billingParty, 'TRENDYOL_PAYS')
  assert.equal(fp.expectedSuratWhoPays, '3')
  assert.equal(fp.credentialRole, 'PRIMARY_MARKETPLACE')
  assert.equal(fp.marketplaceIdentitySource, 'cargoTrackingNumber')

  // Finansal baglam DEGISINCE fingerprint DEGISIR — sessiz reuse OLMAZ.
  const codFp = gate({ cashOnDelivery: true }).financialFingerprint
  assert.notDeepEqual(fp, codFp)
  const sellerFp = gate({ order: { rawOrder: { whoPays: 1 } } })
    .financialFingerprint
  assert.notDeepEqual(fp, sellerFp)
  assert.equal(sellerFp.expectedSuratWhoPays, '1')

  // SIR YOK.
  const text = JSON.stringify({ fp: result.financialFingerprint, tr: result.trace })
  for (const secret of ['PRIMARY_SECRET', 'COD_SECRET', 'SELLER_SECRET']) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
})

/* ═══ KAPI SAF ═════════════════════════════════════════════════════════ */

test('GATE-PURE: kapi ag/DB/yazma icermez', () => {
  const code = codeOf('server/shipments/suratFinancialGate.ts')
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'getDb(']) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
  assert.equal(/\bfetch\(/.test(code), false, 'ag cagrisi')
  // Kapi hicbir istege ALAN EKLEMEZ.
  assert.equal(/['\"]WhoPays['\"]s*:/.test(code), false, 'wire alani EKLENMEMELI')
  assert.equal(/['\"]KimOder['\"]s*:/.test(code), false)
})
