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
