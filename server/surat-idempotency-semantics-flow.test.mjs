import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// P3/B4 — IDEMPOTENCY SEMANTİK KIYASI.
//
// ÖLÇÜLEN KUSUR (P3_AUDIT §1-2): `requestFingerprint` üretiliyor, yazılıyor ve
// HİÇBİR YERDE okunmuyordu; `financialFingerprint` ise kapının dışına hiç
// çıkmıyordu. Anahtar `SURAT:${tenant}:${order}:CREATE` olduğu için desi ya da
// ödeyen taraf değişse bile ESKİ sonuç "başarılı" diye geri oynatılıyordu.
//
// Bu dosya kararı kilitler: fark varsa NE replay NE create.
//
// Ağ YOK, DB YOK, gerçek taşıyıcı çağrısı YOK.

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, 'index.mjs'), 'utf8')
  .split('\r\n')
  .join('\n')
const S = await import('./shipments/suratIdempotencySemantics.ts')

const financial = (overrides = {}) => ({
  billingParty: 'TRENDYOL_PAYS',
  expectedSuratWhoPays: 3,
  credentialRole: 'MARKETPLACE',
  odemeTipi: 1,
  codEnabled: false,
  codCollectionType: null,
  pazaryerimi: true,
  entegrasyonFirmasi: 'Trendyol',
  marketplaceIdentitySource: 'order.cargoTrackingNumber',
  marketplaceIdentityPresent: true,
  ...overrides,
})

/* ═══ AYNI SEMANTİK → BUGÜNKÜ DAVRANIŞ AYNEN KORUNUR ═════════════════ */

test('IDS-1: ayni semantik REPLAY edilir', () => {
  const result = S.compareCreateSemantics({
    stored: { requestFingerprint: 'abc', financialFingerprint: financial() },
    current: { requestFingerprint: 'abc', financialFingerprint: financial() },
  })
  assert.equal(result.match, true)
  assert.deepEqual(result.changedAxes, [])
  assert.equal(result.message, null)
})

/* ═══ FİZİKSEL SEMANTİK DEĞİŞTİ ══════════════════════════════════════ */

test('IDS-2: desi duzeltmesi ESKI etiketi basari saymaz', () => {
  // desi fingerprint'e girer, anahtara GIRMEZ: eskiden sessizce replay edilirdi.
  const result = S.compareCreateSemantics({
    stored: { requestFingerprint: 'desi-1-hash' },
    current: { requestFingerprint: 'desi-5-hash' },
  })
  assert.equal(result.match, false)
  assert.deepEqual(result.changedAxes, ['requestFingerprint'])
  assert.match(result.message, /durduruldu/)
})

/* ═══ FİNANSAL SEMANTİK DEĞİŞTİ ══════════════════════════════════════ */

test('IDS-3: odeyen taraf degisirse DURULUR', () => {
  const result = S.compareCreateSemantics({
    stored: { financialFingerprint: financial() },
    current: {
      financialFingerprint: financial({
        billingParty: 'SELLER_PAYS',
        expectedSuratWhoPays: 1,
      }),
    },
  })
  assert.equal(result.match, false)
  assert.ok(result.changedAxes.includes('billingParty'))
  assert.ok(result.changedAxes.includes('expectedSuratWhoPays'))
  // Mesaj SIR icermez; yalniz eksen adlarini soyler.
  assert.match(result.message, /faturalanan taraf/)
})

test('IDS-4: COD ve kimlik rolu BAGIMSIZ eksenlerdir', () => {
  const cod = S.compareCreateSemantics({
    stored: { financialFingerprint: financial() },
    current: { financialFingerprint: financial({ codEnabled: true }) },
  })
  assert.equal(cod.match, false)
  assert.deepEqual(cod.changedAxes, ['codEnabled'])

  const role = S.compareCreateSemantics({
    stored: { financialFingerprint: financial() },
    current: { financialFingerprint: financial({ credentialRole: 'SELLER' }) },
  })
  assert.equal(role.match, false)
  assert.deepEqual(role.changedAxes, ['credentialRole'])
})

test('IDS-5: pazaryeri kimlik KAYNAGI degisirse yakalanir', () => {
  // Kimlik ikame edilirse gonderi baska bir pakete baglanabilir.
  const result = S.compareCreateSemantics({
    stored: { financialFingerprint: financial() },
    current: {
      financialFingerprint: financial({
        marketplaceIdentitySource: 'zpl.fallback',
      }),
    },
  })
  assert.equal(result.match, false)
  assert.deepEqual(result.changedAxes, ['marketplaceIdentitySource'])
})

/* ═══ ESKİ KAYIT SEBEPSİZ BLOKLANMAZ ═════════════════════════════════ */

test('IDS-6: kiyaslanacak alan YOKSA fark IDDIA EDILMEZ', () => {
  // Eski kayitlar financialFingerprint tasimaz. "Kanit yoklugu" ile "farkli"
  // ayni sey DEGILDIR; bunlari reddetmek calisan siparisleri bloklardi.
  const legacy = S.compareCreateSemantics({
    stored: {},
    current: { requestFingerprint: 'abc', financialFingerprint: financial() },
  })
  assert.equal(legacy.match, true)
  assert.equal(legacy.comparable, false, 'hicbir eksen kiyaslanamadi')

  const halfLegacy = S.compareCreateSemantics({
    stored: { requestFingerprint: 'abc' },
    current: { requestFingerprint: 'abc', financialFingerprint: financial() },
  })
  assert.equal(halfLegacy.match, true)
  assert.equal(halfLegacy.comparable, true, 'hash ekseni kiyaslandi')
})

test('IDS-7: kapiya YENI alan eklenince eski kayitlar toptan reddedilmez', () => {
  const stored = financial()
  const current = financial({ yeniEksen: 'X' })
  const result = S.compareCreateSemantics({
    stored: { financialFingerprint: stored },
    current: { financialFingerprint: current },
  })
  assert.equal(result.match, true, 'yalniz bir tarafta olan alan fark sayildi')
})

test('IDS-8: null ile undefined AYNI sayilir (alan yok)', () => {
  const result = S.compareCreateSemantics({
    stored: { financialFingerprint: financial({ codCollectionType: null }) },
    current: { financialFingerprint: financial({ codCollectionType: undefined }) },
  })
  assert.equal(result.match, true)
})

test('IDS-9: bos girdi COKMEZ ve fark IDDIA ETMEZ', () => {
  for (const params of [{}, { stored: null, current: null }]) {
    const result = S.compareCreateSemantics(params)
    assert.equal(result.match, true)
    assert.equal(result.comparable, false)
  }
})

/* ═══ index.mjs BAĞLAMA SÖZLEŞMESİ ═══════════════════════════════════ */

test('IDS-10: kiyas REPLAY dallarindan ONCE calisir', () => {
  const comparisonAt = SOURCE.indexOf('const replayable =')
  const successReplayAt = SOURCE.indexOf("if (existing?.status === 'SUCCESS') {")
  assert.ok(comparisonAt > 0, 'semantik kiyasi baglanmamis')
  assert.ok(
    comparisonAt < successReplayAt,
    'kiyas SUCCESS replayinden SONRA calisiyor — eski sonuc yine geri oynatilir',
  )
  // Preassigned replay de ayni kapidan gecer.
  assert.match(SOURCE, /isSuratRecordPreassignedReplayReady\(existing\)\n\s*if \(replayable\)/)
})

test('IDS-11: finansal parmak izi kayda YAZILIR', () => {
  assert.match(SOURCE, /financialFingerprint: financialFingerprint \?\? null/)
  // Kapi replay KARARINDAN once, yani operation baglaminin uretiminde calisir.
  const gateAt = SOURCE.indexOf('const financialFingerprint = resolveSuratFinancialFingerprint(')
  const contextAt = SOURCE.indexOf('const operation = buildSuratCreateOperationContext(')
  assert.ok(gateAt > 0 && gateAt < contextAt)
})

test('IDS-12: mismatch NE replay NE create uretir', () => {
  const start = SOURCE.indexOf('const replayable =')
  const end = SOURCE.indexOf("if (existing?.status === 'SUCCESS') {", start)
  const region = SOURCE.slice(start, end)
  assert.match(region, /SURAT_IDEMPOTENCY_MISMATCH_CODE/)
  assert.match(region, /carrierCreateCalled: false/)
  assert.match(region, /ok: false/)
  // Bu dalda taşıyıcıya giden bir çağrı OLMAMALI.
  assert.ok(
    !region.includes('executeSuratCreateCoreAsValue'),
    'mismatch dalindan create cagrisi yapiliyor',
  )
})

test('IDS-13: parmak izi ANAHTARA katilmaz (ikinci gonderi dogmaz)', () => {
  // Anahtar sabit kalmali: semantik degisince YENI anahtar uretilseydi ayni
  // siparis icin ikinci fiziksel gonderi olusurdu.
  assert.match(
    SOURCE,
    /idempotencyKey: `SURAT:\$\{tenantId\}:\$\{orderId\}:CREATE`/,
  )
})
