import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// FAZ E — ÜRETİM DENETİM ARAÇLARI.
//
// Kök neden: `surat:canary:precheck` `.env` YÜKLEMİYORDU. Aynı hostta
// `surat:billing:inspect` DATABASE_URL'i görüp 0 dönerken precheck
// göremiyordu. Postgres kapalı DEĞİLDİ; ortam dosyası okunmuyordu.

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

/** Üretim verisine bakan HER CLI aynı ortam dosyasını yüklemelidir. */
const PRODUCTION_READ_SCRIPTS = [
  'surat:billing:inspect',
  'surat:billing:scan',
  'surat:canary:precheck',
]

test('E-1: uretim okuyan CLI\'lar .env YUKLER', () => {
  for (const name of PRODUCTION_READ_SCRIPTS) {
    const script = pkg.scripts?.[name]
    assert.ok(script, `${name} tanimli olmali`)
    assert.match(
      script, /--env-file-if-exists=\.env/,
      `${name} .env yuklemiyor — ayni hostta farkli sonuc verir`,
    )
  }
})

test('E-2: precheck veri kaynagini ACIKCA bildirir', () => {
  const source = readFileSync(
    'server/shipments/suratCanaryPrecheckCli.ts', 'utf8',
  )
  assert.ok(source.includes('DATA_SOURCE'), 'veri kaynagi raporlanmali')
  assert.ok(source.includes('AUTHORITATIVE_SOURCE_RESOLVED'))
  // Cozulemediginde FAIL degil, tanimli bir dis engel bildirilir.
  assert.ok(source.includes('BLOCKED_EXTERNAL'))
  assert.ok(source.includes('CONFIG_NOT_FOUND'))
})

test('E-3: denetim araclari YAZMA yapmaz', () => {
  for (const file of [
    'server/shipments/suratCanaryPrecheckCli.ts',
    'server/shipments/suratBillingInspectCli.ts',
  ]) {
    const code = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    for (const forbidden of ['.insert(', '.update(', '.delete(']) {
      assert.equal(code.includes(forbidden), false, `${file} → ${forbidden}`)
    }
    // Tasiyiciya ag cagrisi YOK.
    assert.equal(/\bfetch\(/.test(code), false, `${file} → ag cagrisi`)
  }
})

/* ═══ ÇALIŞMA ZAMANI PARİTESİ ═════════════════════════════════════════ */

const DERIVE = await import('./shipments/suratCanonicalServiceMode.mjs')
const ROUTING = await import('./shipments/suratRoutingModel.ts')
const TRACE_WIRE = await import('./shipments/suratCreateTrace.ts')

/** Üretimdeki MonalisaToka biçimi: ham kayıtta `canonicalPrimary*` YOKTUR. */
const STORED = {
  serviceMode: 'SURAT_CANONICAL_API',
  kullaniciAdi: 'CARI2622',
  sifre: 'STORED_SECRET',
  webPassword: 'STORED_WEB',
}

const runtimeView = (stored) => ({
  ...stored, ...DERIVE.deriveCanonicalPrimaryAccount(stored),
})

const resolve = (config) => ROUTING.resolveSuratCredentialContext({
  config,
  billingParty: 'TRENDYOL_PAYS',
  cod: ROUTING.resolveCodContext({ enabled: false }),
  serviceMode: config.serviceMode,
})

test('E-4: HAM kayit tek basina kanonik kimligi COZEMEZ', () => {
  // Denetcinin eski hatasi tam olarak buydu: turetim atlanip YANLIS
  // "cozulemedi" raporlaniyordu.
  assert.equal(resolve(STORED).resolved, false)
})

test('E-5: calisma zamani turevi uygulaninca kimlik COZULUR', () => {
  const credential = resolve(runtimeView(STORED))
  assert.equal(credential.resolved, true, 'kanonik birincil COZULMELI')
  assert.equal(credential.role, 'PRIMARY_MARKETPLACE')
  assert.ok(credential.maskedAccount, 'maskeli hesap URETILMELI')
  // Sir SIZMAZ.
  assert.equal(
    JSON.stringify(credential).includes('STORED_SECRET'), false,
  )
})

test('E-6: denetci HAM degil TUREV gorunumu okur', () => {
  const code = readFileSync('server/shipments/suratBillingInspectCli.ts', 'utf8')
  assert.ok(
    code.includes('deriveCanonicalPrimaryAccount(stored)'),
    'denetci calisma zamani turevini UYGULAMALI',
  )
  // Paralel kimlik mantigi DEGIL, YETKILI cozucu kullanilmali.
  assert.ok(code.includes('resolveSuratCredentialContext('))
  assert.ok(code.includes('AUTHORITATIVE_RESOLVER'))
})

test('E-7: eksik SELLER_PAYS / COD kimligi FAIL-CLOSED kalir', () => {
  const config = runtimeView(STORED)
  // Uretimde bu ikisi yapilandirilmamis; sahte kimlik URETILMEZ.
  const seller = ROUTING.resolveSuratCredentialContext({
    config, billingParty: 'SELLER_PAYS',
    cod: ROUTING.resolveCodContext({ enabled: false }),
    serviceMode: config.serviceMode,
  })
  assert.equal(seller.resolved, false)
  const cod = ROUTING.resolveSuratCredentialContext({
    config, billingParty: 'TRENDYOL_PAYS',
    cod: ROUTING.resolveCodContext({ enabled: true }),
    codPolicy: 'DEDICATED_COD', serviceMode: config.serviceMode,
  })
  assert.equal(cod.resolved, false)
})

/* ═══ FATURA TARAFI ≠ KİMLİK SINIFI ══════════════════════════════════ */

const DRYRUN = await import('./shipments/suratCreateContextDryRun.ts')

test('E-8: BillingParty ile CredentialRole AYRI alanlardir', () => {
  const config = runtimeView(STORED)
  const credential = resolve(config)
  const billing = ROUTING.resolveBillingPartyV2({})
  // Normal Trendyol siparisi: fatura Trendyol'a, baglanti ANA cariyle.
  assert.equal(billing.billingParty, 'TRENDYOL_PAYS')
  assert.equal(ROUTING.expectedSuratWhoPays(billing.billingParty), '3')
  assert.equal(credential.role, 'PRIMARY_MARKETPLACE')
  // PRIMARY bir kimlik sinifidir; fatura tarafi DEGILDIR.
  assert.notEqual(billing.billingParty, credential.role)
  assert.equal(billing.billingParty.startsWith('PRIMARY'), false)
})

test('E-9: SELLER_PAYS siparisi kendi rolunu secer, semantik korunur', () => {
  const billing = ROUTING.resolveBillingPartyV2({ whoPays: 1 })
  assert.equal(billing.billingParty, 'SELLER_PAYS')
  assert.equal(ROUTING.expectedSuratWhoPays(billing.billingParty), '1')
  const configured = ROUTING.resolveSuratCredentialContext({
    config: {
      ...runtimeView(STORED),
      sellerPaysKullaniciAdi: 'SELLER1', sellerPaysSifre: 'SELLER_SECRET',
    },
    billingParty: 'SELLER_PAYS',
    cod: ROUTING.resolveCodContext({ enabled: false }),
    serviceMode: 'SURAT_CANONICAL_API',
  })
  assert.equal(configured.resolved, true)
  assert.equal(configured.role, 'SELLER_PAYS')
})

test('E-10: beklenen taraf SABIT false DEGIL, kanittan turetilir', () => {
  const credentials = DRYRUN.probeCredentialPresence(runtimeView(STORED))
  // Trendyol semantigi cozulduyse BAGLIDIR.
  assert.equal(
    DRYRUN.describeBillingWiring({
      order: {}, credentials, billingParty: 'TRENDYOL_PAYS',
    }).expectedPartyWiredToCreate,
    true,
  )
  // UNKNOWN ise bagli SAYILMAZ — fail-closed.
  assert.equal(
    DRYRUN.describeBillingWiring({
      order: {}, credentials, billingParty: 'UNKNOWN',
    }).expectedPartyWiredToCreate,
    false,
  )
})

test('E-11: tel WhoPays tasimasa da semantik TRENDYOL_PAYS KORUNUR', () => {
  const wire = TRACE_WIRE.describeWireWhoPays({
    contractFields: ['KullaniciAdi', 'Sifre', 'Gonderi'],
  })
  assert.equal(wire.wireWhoPaysPresent, false)
  assert.equal(wire.wireWhoPaysReason, 'CONTRACT_HAS_NO_WHO_PAYS_FIELD')
  // Telde alan olmamasi fatura semantigini BOZMAZ.
  assert.equal(ROUTING.resolveBillingPartyV2({}).billingParty, 'TRENDYOL_PAYS')
})

test('E-12: denetci kimlik sinifini fatura tarafi olarak BASMAZ', () => {
  const code = readFileSync('server/shipments/suratBillingInspectCli.ts', 'utf8')
  assert.equal(
    /REAL_RUNTIME_BILLING_PARTY\s+\$\{caseA\.credentialClass\}/.test(code),
    false,
    'fatura tarafi kimlik sinifiyla DOLDURULMAMALI',
  )
  assert.ok(code.includes('domainBilling.billingParty'))
})

/* ═══ HESAP PARMAK İZİ — TEK BİÇİM ═══════════════════════════════════ */

test('E-13: parmak izi TEK fonksiyondan uretilir', () => {
  const config = runtimeView(STORED)
  const credential = resolve(config)
  // Denetci ve create yolu ayni alani okur; kiyas ANLAMLIDIR.
  assert.equal(
    credential.accountFingerprint,
    ROUTING.accountFingerprint(config.canonicalPrimaryKullaniciAdi),
  )
  // Ham cari kodu SIZMAZ.
  assert.equal(
    credential.accountFingerprint.includes(config.canonicalPrimaryKullaniciAdi),
    false,
  )
})

test('E-14: farkli maske bicimleri SAHTE uyusmazlik URETEMEZ', () => {
  // Ayni hesap iki eski bicimde FARKLI gorunuyordu:
  //   maskAccount('1537690927')    -> 15******27
  //   '****' + son4                -> ****0927
  // Paylasilan fonksiyon her iki cagirandan AYNI degeri verir.
  const account = '1537690927'
  assert.equal(
    ROUTING.accountFingerprint(account), ROUTING.accountFingerprint(account),
  )
  assert.notEqual(ROUTING.accountFingerprint(account), ROUTING.maskAccount(account))
  // Uzunluk farki GIZLENMEZ — farkli hesaplar ayni gorunmez.
  assert.notEqual(
    ROUTING.accountFingerprint('1537690927'),
    ROUTING.accountFingerprint('37690927'),
  )
})

test('E-15: GERCEKTEN farkli hesaplar FARKLI parmak izi verir', () => {
  assert.notEqual(
    ROUTING.accountFingerprint('1537690927'),
    ROUTING.accountFingerprint('1537692622'),
  )
})
