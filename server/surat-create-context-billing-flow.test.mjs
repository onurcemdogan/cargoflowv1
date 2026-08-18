import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// SÜRAT CREATE-CONTEXT FORENSİĞİ.
//
// SORU: EXPECTED_BILLING_PARTY = TRENDYOL olan gerçek bir sipariş Sürat'e
// create edilseydi hangi gövdeyle giderdi — ve bu gövde beklenen ödeyen tarafa
// göre DEĞİŞİYOR MU?
//
// Bu paket ağa ÇIKMAZ, DB'ye YAZMAZ, barkod ÜRETMEZ. Gövdeyi üretimin
// kullandığı GERÇEK builder'lar üretir; mock gövde denetimi değersiz kılardı.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const dryRun = await import('./shipments/suratCreateContextDryRun.ts')
const contract = await import('./shipments/suratBillingSuccessContract.ts')
const model = await import('./shipments/suratCanonicalGonderiModel.ts')
const inspect = await import('./shipments/suratBillingInspectCli.ts')
const orderEncryption = await import('./orders/orderEncryption.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []

/** Yorum satırları KOD SAYILMAZ. */
const codeOf = (file) =>
  nl(readFileSync(file, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

const PARCEL = '7270035942963454'

/** Gerçek üretim yapılandırmasına benzeyen tenant ayarı (SIR İÇERİR). */
const PROD_LIKE_CONFIG = {
  serviceMode: 'SURAT_CANONICAL_API',
  serviceType: 'SuratCanonicalWebApi',
  createShipmentPath: '/api/OrtakBarkodOlustur',
  firmaId: '1411052622',
  entegrasyonFirmasi: 'Trendyol',
  odemeTipi: '1',
  // NOT: hesap parmak izi SON 4 KARAKTERDİR. Bu yüzden fikstür kullanıcı
  // adlarının son 4'ü BİLEREK farklı seçildi; aynı olsaydı iki AYRI hesap
  // denetim çıktısında ayırt edilemezdi (gerçek hesaplarda da geçerli bir
  // sınırlama — sayısal kimliklerde çakışma olasılığı düşük ama sıfır değil).
  canonicalPrimaryKullaniciAdi: 'GIZLI_PRIMARY_KULLANICI_1111',
  canonicalPrimarySifre: 'GIZLI_PRIMARY_SIFRE',
  sellerPaysKullaniciAdi: 'GIZLI_SELLER_KULLANICI_2222',
  sellerPaysSifre: 'GIZLI_SELLER_SIFRE',
}

/** Üretimdeki sipariş görünüm modeline benzer, pazaryeri gönderisi. */
const marketplaceOrder = (over = {}) => ({
  marketplace: 'Trendyol',
  packageId: 'PKG-1',
  shipmentPackageId: 'PKG-1',
  orderNumber: '1141000001',
  cargoTrackingNumber: PARCEL,
  customerName: 'Ad Soyad',
  address: 'Gizli Mahalle 5',
  city: 'İstanbul',
  district: 'Kadıköy',
  customerPhone: '05551112233',
  customerEmail: 'gizli@ornek.com',
  ...over,
})

/* ═══ CREATE BAĞLAMI ENVANTERİ ═════════════════════════════════════════ */

test('CTX-1: kanonik govde SABIT alan kumesini uretir', () => {
  const summary = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  assert.deepEqual(summary.requestRootFields, ['KullaniciAdi', 'Sifre', 'Gonderi'])
  assert.equal(summary.serviceMode, 'SURAT_CANONICAL_API')
  assert.equal(summary.createPath, '/api/OrtakBarkodOlustur')
  assert.equal(summary.createHost, 'api02.suratkargo.com.tr')

  // Faturalama üçlüsü gövdede GERÇEKTEN var.
  assert.equal(summary.billingRelevantValues.OzelKargoTakipNo, PARCEL)
  assert.equal(summary.billingRelevantValues.Pazaryerimi, 1)
  assert.equal(summary.billingRelevantValues.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(summary.marketplaceIdentityPresent, true)
  assert.equal(summary.billingContextValid, true)
})

test('CTX-2: govdede payer alani YOK — WhoPays/KimOder/FirmaId/Gonderen', () => {
  const summary = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  assert.equal(summary.whoPaysPresent, false)
  assert.equal(summary.kimOderPresent, false)
  assert.equal(summary.firmaIdPresentInRequest, false, 'firmaId gövdeye GIRMIYOR')
  assert.equal(summary.restSenderIdPresentInRequest, false, 'Gonderen bloğu YOK')
  assert.deepEqual(summary.forbiddenFieldsPresent, [])
})

test('CTX-3: odemeTipi SABIT — tenant ayari kanonik govdeye GIRMIYOR', () => {
  const asConfigured = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  assert.equal(asConfigured.odemeTipiPresent, true)
  assert.equal(asConfigured.odemeTipiValue, 1)
  assert.equal(asConfigured.odemeTipiSource, 'HARDCODED_SURAT_SERVICE_DEFAULTS')

  // Tenant ayarı 3 olsa BİLE gövde değişmez: kanonik builder onu okumaz.
  const overridden = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    suratConfig: { ...PROD_LIKE_CONFIG, odemeTipi: '3' },
    reference: 'PKG-1',
  })
  assert.equal(overridden.odemeTipiValue, 1, 'tenant odemeTipi ETKISIZ')
})

/* ═══ EN KRİTİK KARŞILAŞTIRMA ══════════════════════════════════════════ */

test('CTX-4: CREATE_CONTEXT_BILLING_INSENSITIVE — expected TRENDYOL vs SELLER', () => {
  // CASE A: gerçek üretim durumu (whoPays absent → beklenen TRENDYOL).
  const caseA = dryRun.buildCreateContextSummary({
    order: marketplaceOrder({ rawOrder: {} }),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  // CASE B: Trendyol whoPays=1 gelmiş olsaydı (beklenen SELLER).
  const caseB = dryRun.buildCreateContextSummary({
    order: marketplaceOrder({ rawOrder: { whoPays: 1 } }),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })

  const comparison = dryRun.compareCreateContexts(caseA, caseB)
  assert.equal(
    comparison.identical, true,
    'beklenen odeyen taraf create govdesini DEGISTIRMIYOR',
  )
  assert.deepEqual(comparison.differences, [])
  // Aynı kredensiyal, aynı alanlar, aynı faturalama değerleri.
  assert.equal(caseA.credentialClass, 'PRIMARY')
  assert.equal(caseB.credentialClass, 'PRIMARY')
  assert.equal(caseA.accountFingerprint, caseB.accountFingerprint)
})

test('CTX-5: kredensiyal sinifi YALNIZ acik sellerPays/COD sinyaliyle degisir', () => {
  const primary = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  const sellerPays = dryRun.buildCreateContextSummary({
    order: marketplaceOrder({ sellerPays: true }),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  assert.equal(primary.credentialClass, 'PRIMARY')
  assert.equal(sellerPays.credentialClass, 'SELLER_PAYS')
  // Hesap DEĞİŞİR ama gövdenin geri kalanı AYNI kalır — fark yalnız kimlikte.
  assert.notEqual(primary.accountFingerprint, sellerPays.accountFingerprint)
  assert.deepEqual(primary.gonderiFieldNames, sellerPays.gonderiFieldNames)
  assert.deepEqual(
    primary.billingRelevantValues,
    sellerPays.billingRelevantValues,
  )

  // KRİTİK: bu sinyal Trendyol `whoPays` alanından GELMİYOR. Üretimdeki
  // 500 siparişin hiçbirinde `sellerPays`/`payer` yok → hepsi PRIMARY.
  const trendyolWhoPays = dryRun.buildCreateContextSummary({
    order: marketplaceOrder({ rawOrder: { whoPays: 1 } }),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  assert.equal(trendyolWhoPays.credentialClass, 'PRIMARY')
})

test('CTX-6: sellerPays kredensiyali YOKSA sessizce PRIMARY a DUSULMEZ', () => {
  const summary = dryRun.buildCreateContextSummary({
    order: marketplaceOrder({ sellerPays: true }),
    suratConfig: {
      ...PROD_LIKE_CONFIG,
      sellerPaysKullaniciAdi: '',
      sellerPaysSifre: '',
    },
    reference: 'PKG-1',
  })
  assert.equal(summary.credentialClass, 'SELLER_PAYS')
  assert.equal(summary.credentialResolved, false, 'baska hesaba DUSMEZ')
  assert.equal(summary.accountFingerprint, '')
})

/* ═══ GİZLİLİK + SIFIR YAN ETKİ ════════════════════════════════════════ */

test('CTX-7: SIR DEGERLERI hicbir kosulda raporda cikmaz', () => {
  const summary = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    suratConfig: PROD_LIKE_CONFIG,
    reference: 'PKG-1',
  })
  assert.deepEqual(summary.secretValuesLeaked, [])
  const text = [
    ...dryRun.formatCreateContextReport(summary, 'A'),
    JSON.stringify(summary),
  ].join('\n')
  for (const secret of [
    'GIZLI_PRIMARY_KULLANICI_1111', 'GIZLI_PRIMARY_SIFRE',
    'GIZLI_SELLER_KULLANICI_2222', 'GIZLI_SELLER_SIFRE',
  ]) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
  // PII de basılmaz: yalnız alan ADLARI raporlanır.
  for (const pii of ['Gizli Mahalle 5', '05551112233', 'gizli@ornek.com']) {
    assert.equal(text.includes(pii), false, `${pii} BASILMAMALI`)
  }
  // Ama alan adları görünür (denetlenebilirlik).
  assert.ok(summary.gonderiFieldNames.includes('AliciAdresi'))
  assert.ok(summary.gonderiFieldNames.includes('TelefonCep'))
})

test('CTX-7b: sizinti dedektoru KISA degerde YANLIS ALARM vermez', () => {
  // Tek karakterlik bir "sır" rapor metninde tesadüfen geçer (`P` →
  // `Pazaryerimi`). Eşiksiz dedektör her çalıştırmada alarm verir ve
  // okunmaz hâle gelir.
  const short = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    suratConfig: { ...PROD_LIKE_CONFIG, canonicalPrimarySifre: 'P' },
    reference: 'PKG-1',
  })
  assert.deepEqual(short.secretValuesLeaked, [], 'yanlis alarm OLMAMALI')

  // Ama gerçek uzunlukta bir değer gövdeye sızarsa YAKALANIR.
  const leaked = ['Pazaryerimi', 'EntegrasyonFirmasi']
  assert.ok(dryRun.SECRET_LEAK_MIN_LENGTH <= leaked[0].length)
  const detected = dryRun.buildCreateContextSummary({
    order: marketplaceOrder(),
    // Kimlik değeri gövdedeki gerçek bir değerle AYNI olursa dedektör görür.
    suratConfig: { ...PROD_LIKE_CONFIG, canonicalPrimarySifre: 'Trendyol' },
    reference: 'PKG-1',
  })
  assert.deepEqual(detected.secretValuesLeaked, ['Sifre'])
})

test('CTX-8: kuru calistirma AG/YAZMA/CREATE icermez', () => {
  const code = codeOf('server/shipments/suratCreateContextDryRun.ts')
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'migrate(', 'createOrtakBarkodShipment',
  ]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  assert.equal(/\bfetch\(/.test(code), false, 'ag cagrisi OLMAMALI')
  // Gerçek builder kullanılıyor — mock gövde YOK.
  assert.ok(code.includes('buildSuratOrtakBarkodRequest'))
  assert.ok(code.includes('resolveSuratMarketplaceContext'))
  assert.ok(code.includes('resolveCanonicalTenantSuratAccount'))
})

/* ═══ LEGACY ↔ KANONİK PAYER ALAN FARKI ════════════════════════════════ */

test('CTX-9: legacy SOAP WhoPays gonderiyor, kanonik GONDERMIYOR', () => {
  const server = codeOf('server/index.mjs')
  // LEGACY: `KargoBarkoduSiparis` gövdesinde WhoPays tenant ayarından gelir.
  assert.ok(
    server.includes("optionalXmlTag('WhoPays', payload.WhoPays)"),
    'legacy SOAP WhoPays etiketi bulunmali',
  )
  assert.ok(
    server.includes('payload.WhoPays = firstNonEmpty(config.whoPays, config.WhoPays)'),
    'legacy WhoPays tenant ayarindan besleniyor',
  )
  // LEGACY REST: KimOder SABIT 1.
  assert.ok(server.includes('KimOder: 1'), 'legacy REST KimOder=1 sabit')

  // KANONİK: her ikisi de YASAK listesinde ve alan kümesinde YOK.
  assert.ok(model.FORBIDDEN_CANONICAL_FIELDS.includes('WhoPays'))
  assert.ok(model.FORBIDDEN_CANONICAL_FIELDS.includes('KimOder'))
  for (const field of ['WhoPays', 'KimOder']) {
    assert.equal(model.CANONICAL_GONDERI_FIELDS.includes(field), false)
  }
})

test('CTX-10: kanonik builder tenant odemeTipi ni OKUMAZ (kaynak kaniti)', () => {
  const code = codeOf('server/shipments/suratCanonicalGonderiModel.ts')
  assert.ok(code.includes('model.OdemeTipi = SURAT_SERVICE_DEFAULTS.OdemeTipi'))
  // Tenant ayarı adı kanonik builder'da hiç geçmez.
  assert.equal(code.includes('config.odemeTipi'), false)
  assert.equal(code.includes('odemeTipi:'), false)
  // Legacy zincirde ise TAM TERSİ.
  const server = codeOf('server/index.mjs')
  assert.ok(server.includes('firstNonEmpty(config.odemeTipi, config.odemetipi'))
})

/* ═══ BAŞARI SÖZLEŞMESİ ════════════════════════════════════════════════ */

test('SUC-1: bugunku uretim durumu OPERATION_SUCCESS_BILLING_UNVERIFIED', () => {
  const outcome = contract.classifyBillingOperationOutcome({
    carrierCreateStatus: 'SUCCESS',
    expectedBillingParty: 'TRENDYOL',
    actualBillingParty: 'UNKNOWN',
  })
  assert.equal(outcome.outcome, 'OPERATION_SUCCESS_BILLING_UNVERIFIED')
  assert.equal(outcome.carrierCreateSuccess, true)
  assert.equal(outcome.billingExpectationKnown, true)
  assert.equal(outcome.billingActualVerified, false)
  assert.equal(outcome.billingMatch, null)
})

test('SUC-2: uyusmazlik BILLING_MISMATCH — create BASARISIZ SAYILMAZ', () => {
  const outcome = contract.classifyBillingOperationOutcome({
    carrierCreateStatus: 'SUCCESS',
    expectedBillingParty: 'TRENDYOL',
    actualBillingParty: 'SELLER',
  })
  assert.equal(outcome.outcome, 'BILLING_MISMATCH')
  assert.equal(outcome.carrierCreateSuccess, true, 'gonderi GERCEKTEN olustu')
  assert.equal(outcome.billingMatch, false)
})

test('SUC-3: eslesme VERIFIED, create hatasi OPERATION_FAILED', () => {
  assert.equal(
    contract.classifyBillingOperationOutcome({
      carrierCreateStatus: 'SUCCESS',
      expectedBillingParty: 'TRENDYOL',
      actualBillingParty: 'TRENDYOL',
    }).outcome,
    'OPERATION_SUCCESS_BILLING_VERIFIED',
  )
  assert.equal(
    contract.classifyBillingOperationOutcome({
      carrierCreateStatus: 'FAILED',
      expectedBillingParty: 'TRENDYOL',
      actualBillingParty: 'UNKNOWN',
    }).outcome,
    'OPERATION_FAILED',
  )
  assert.equal(
    contract.classifyBillingOperationOutcome({
      carrierCreateStatus: 'SUCCESS',
      expectedBillingParty: 'UNKNOWN',
      actualBillingParty: 'UNKNOWN',
    }).outcome,
    'OPERATION_SUCCESS_BILLING_UNKNOWN',
  )
})

/* ═══ ENFORCEMENT TASARIMI ═════════════════════════════════════════════ */

test('ENF-1: varsayilan kapi KAPALI — bu tur uretim davranisi DEGISMEZ', () => {
  const decision = contract.evaluatePreCreateBillingGuard({
    billingContextValid: true,
    expectedBillingParty: 'TRENDYOL',
    createContextCanExpressBillingParty: false,
  })
  assert.equal(decision.mode, 'OFF')
  assert.equal(decision.decision, 'ALLOW')
})

test('ENF-2: CONTEXT_INTEGRITY yalniz BOZUK baglami engeller', () => {
  assert.equal(
    contract.evaluatePreCreateBillingGuard({
      mode: 'CONTEXT_INTEGRITY',
      billingContextValid: true,
      expectedBillingParty: 'TRENDYOL',
      createContextCanExpressBillingParty: false,
    }).decision,
    'ALLOW',
    'payer ifade edilemiyor diye operasyon DURDURULMAZ',
  )
  const blocked = contract.evaluatePreCreateBillingGuard({
    mode: 'CONTEXT_INTEGRITY',
    billingContextValid: false,
    billingContextError: 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING',
    expectedBillingParty: 'TRENDYOL',
    createContextCanExpressBillingParty: false,
  })
  assert.equal(blocked.decision, 'BLOCK')
  assert.equal(blocked.errorCode, 'SURAT_MARKETPLACE_TRACKING_NUMBER_MISSING')
})

test('ENF-3: STRICT_EXPECTATION bugun TUM gonderileri bloklar (maliyet acik)', () => {
  const decision = contract.evaluatePreCreateBillingGuard({
    mode: 'STRICT_EXPECTATION',
    billingContextValid: true,
    expectedBillingParty: 'TRENDYOL',
    createContextCanExpressBillingParty: false,
  })
  assert.equal(decision.decision, 'BLOCK')
  assert.equal(decision.errorCode, 'BILLING_PARTY_NOT_EXPRESSIBLE')
  // Bu yüzden önerilen varsayılan STRICT DEĞİL.
  assert.equal(contract.RECOMMENDED_ENFORCEMENT, 'HYBRID')
  assert.equal(contract.ENFORCEMENT_DESIGN.preCreate.mode, 'CONTEXT_INTEGRITY')
  assert.equal(contract.ENFORCEMENT_DESIGN.postCreate.requires, 'SURAT_GETCARGO_CONTRACT')
})

test('ENF-4: sozlesme modulu uretim akisina BAGLI DEGIL', () => {
  // Bu tur yalnız model/test/tasarım. Hiçbir create/print yolu import etmiyor.
  for (const file of [
    'server/shipments/suratCanonicalCreateAdapter.ts',
    'server/shipments/suratCanonicalShipmentService.ts',
    'server/shipments/suratWebApiClient.ts',
  ]) {
    const code = codeOf(file)
    assert.equal(
      code.includes('suratBillingSuccessContract'), false,
      `${file} henuz baglanmamali`,
    )
    assert.equal(code.includes('suratCreateContextDryRun'), false)
  }
})

/* ═══ GERÇEK RUNTIME BAĞLANTISI ════════════════════════════════════════ */

test('WIRE-1: expectedBillingParty GERCEK create secimine BAGLI DEGIL', () => {
  // KAYNAK KANITI: `resolveSuratBillingParty` yalnız üç sipariş alanına ve
  // COD bayrağına bakar. Trendyol `whoPays` türevine erişimi YOKTUR.
  const adapter = codeOf('server/shipments/suratCanonicalCreateAdapter.ts')
  const start = adapter.indexOf('export function resolveSuratBillingParty')
  assert.ok(start > 0)
  // SINIR: bir sonraki üst düzey bildirim. `\n}` ARANMAZ — imzadaki tip
  // literali (`}): SuratBillingParty {`) gövdeyi erken keserdi.
  const after = adapter.slice(start + 1)
  const next = after.search(/^(?:export )?(?:async )?(?:function|const|interface|type) /m)
  const body = next === -1 ? adapter.slice(start) : adapter.slice(start, start + 1 + next)
  assert.ok(body.includes('order.sellerPays === true'))
  assert.ok(body.includes('order.payer ?? order.shippingPayer'))
  assert.ok(body.includes('cashOnDelivery'))
  // Beklenen taraf modülü bu dosyada HİÇ geçmez.
  assert.equal(adapter.includes('suratBillingParty'), false)
  assert.equal(adapter.includes('expectedBillingParty'), false)
  assert.equal(body.includes('whoPays'), false)

  const wiring = dryRun.describeBillingWiring({
    order: marketplaceOrder({ rawOrder: {} }),
    credentials: dryRun.probeCredentialPresence(PROD_LIKE_CONFIG),
  })
  assert.equal(wiring.expectedPartyWiredToCreate, false)
})

test('WIRE-2: uretimde order.sellerPays / order.payer yazan KOD YOLU YOK', () => {
  // Bu alanlar sipariş normalizasyonunda, mapper'da veya frontend'de
  // ÜRETİLMİYOR. Dolayısıyla SELLER_PAYS dalı girdi açlığından ölü.
  for (const file of [
    'server/index.mjs',
    'server/orders/orderMapper.ts',
    'server/trendyol/historicalOrderFetch.ts',
  ]) {
    const code = codeOf(file)
    for (const pattern of [
      /\bsellerPays\s*[:=]\s*(true|1|'1')/,
      /\bpayer\s*[:=]\s*['"]SELLER['"]/i,
      /\bshippingPayer\s*[:=]/,
    ]) {
      assert.equal(pattern.test(code), false, `${file}: ${pattern} URETILMEMELI`)
    }
  }
  // Gerçek bir siparişte hiçbiri yok → girdi kümesi BOŞ.
  const wiring = dryRun.describeBillingWiring({
    order: marketplaceOrder({ rawOrder: {} }),
    credentials: dryRun.probeCredentialPresence(PROD_LIKE_CONFIG),
  })
  assert.deepEqual(wiring.presentInputs, [])
})

test('WIRE-3: SELLER_PAYS iki kosula birden bagli; biri yoksa ERISILEMEZ', () => {
  const withCredential = dryRun.probeCredentialPresence(PROD_LIKE_CONFIG)
  const withoutCredential = dryRun.probeCredentialPresence({
    ...PROD_LIKE_CONFIG,
    sellerPaysKullaniciAdi: '',
    sellerPaysSifre: '',
  })

  // (1) kredensiyal VAR ama sipariş sinyali YOK.
  assert.equal(
    dryRun.describeBillingWiring({
      order: marketplaceOrder(), credentials: withCredential,
    }).sellerPaysUnreachableReason,
    'NO_ORDER_SIGNAL',
  )
  // (2) sipariş sinyali VAR ama kredensiyal YOK — üretim durumu bu.
  assert.equal(
    dryRun.describeBillingWiring({
      order: marketplaceOrder({ sellerPays: true }), credentials: withoutCredential,
    }).sellerPaysUnreachableReason,
    'NO_CREDENTIAL',
  )
  // (3) ikisi de yok.
  assert.equal(
    dryRun.describeBillingWiring({
      order: marketplaceOrder(), credentials: withoutCredential,
    }).sellerPaysUnreachableReason,
    'NO_ORDER_SIGNAL_AND_NO_CREDENTIAL',
  )
  // (4) ikisi birden varsa erişilebilir.
  const reachable = dryRun.describeBillingWiring({
    order: marketplaceOrder({ sellerPays: true }), credentials: withCredential,
  })
  assert.equal(reachable.sellerPaysReachable, true)
  assert.equal(reachable.sellerPaysUnreachableReason, null)
})

test('WIRE-4: kredensiyal probu DEGER BASMAZ, varlik hasOwnProperty ile', () => {
  const presence = dryRun.probeCredentialPresence(PROD_LIKE_CONFIG)
  assert.equal(presence.primaryUsername, true)
  assert.equal(presence.sellerPaysUsername, true)
  assert.equal(presence.codUsername, false)
  assert.equal(presence.legacyWhoPaysPresent, false)
  assert.equal(presence.legacyWhoPaysValue, null)

  // BOŞ STRİNG varlık sayılmaz — anahtar var ama hesap yok demektir.
  assert.equal(
    dryRun.probeCredentialPresence({ sellerPaysKullaniciAdi: '   ' })
      .sellerPaysUsername,
    false,
  )
  // Prototip kirliliği kanıt DEĞİL.
  const polluted = Object.create({ sellerPaysKullaniciAdi: 'X' })
  assert.equal(dryRun.probeCredentialPresence(polluted).sellerPaysUsername, false)

  // Sır DEĞERİ hiçbir alanda yok.
  const text = JSON.stringify(presence)
  for (const secret of ['GIZLI_PRIMARY_KULLANICI_1111', 'GIZLI_SELLER_SIFRE']) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
  // whoPays DEĞERİ raporlanır (kimlik değil, faturalama kodu).
  assert.equal(
    dryRun.probeCredentialPresence({ ...PROD_LIKE_CONFIG, whoPays: '3' })
      .legacyWhoPaysValue,
    '3',
  )
})

test('WIRE-5: kanonik dal HAM body config alir, normalize edilmis config DEGIL', () => {
  // ÜRETİM GERÇEĞİ: `normalizeSuratConfig` `deriveCanonicalPrimaryAccount`
  // türevini üretir, fakat kanonik dal adaptöre HAM gövdeyi geçirir. Bu
  // yüzden `canonicalPrimarySifre` yalnız istemcinin gönderdiği yükte varsa
  // çözülür — türev burada devreye GİRMEZ.
  const server = codeOf('server/index.mjs')
  const branch = server.indexOf('if (config.serviceMode === SURAT_CANONICAL_SERVICE_MODE)')
  assert.ok(branch > 0)
  const block = server.slice(branch, branch + 1200)
  assert.ok(
    block.includes('config: request.body?.config?.surat ?? request.body?.config ?? {}'),
    'kanonik dal HAM gövde config geciriyor',
  )
  // Normalize edilmiş `config` degiskeni bu cagriya GECIRILMIYOR.
  assert.equal(block.includes('config: config,'), false)
})

async function makeDb() {
  const pglite = new PGlite()
  const dir = join(here, '..', 'drizzle')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pglite.exec(statement)
    }
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

test('CLI-1: gercek siparis satirindan kuru calistirma DB YAZMADAN calisir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('MonalisaToka','monalisatoka-${randomBytes(3).toString('hex')}')
     returning id`)))
  const organizationId = String(rows[0].id)
  const raw = orderEncryption.encryptOrderPayload({
    packageId: 'PKG-PROD-1',
    orderNumber: '1141000001',
    lines: [],
  })
  const address = orderEncryption.encryptOrderPayload({
    fullAddress: 'Gizli Mahalle 5',
    city: 'İstanbul',
  })
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, marketplace_status,
     operation_status, shipping_city, shipping_district, cargo_tracking_number,
     order_date, raw_payload_encrypted, shipping_address_encrypted)
    values (${organizationId}, 'Trendyol', 'PKG-PROD-1', '1141000001', 'Created',
      'NEW', 'İstanbul', 'Kadıköy', ${PARCEL}, '2026-03-01T09:00:00.000Z',
      ${raw}, ${address})`)

  const writes = []
  const original = pglite.query.bind(pglite)
  pglite.query = (query, ...rest) => {
    writes.push(String(query))
    return original(query, ...rest)
  }
  const logs = []
  const originalInfo = console.info
  console.info = (line) => logs.push(String(line))
  let code
  try {
    code = await inspect.runCreateContextDryRun(db, organizationId, PARCEL)
  } finally {
    console.info = originalInfo
  }
  assert.equal(code, 0)

  const text = logs.join('\n')
  assert.ok(text.includes('CASE                    A_REAL_PRODUCTION_ORDER'))
  assert.ok(text.includes('WHO_PAYS_PRESENT        NO'))
  assert.ok(text.includes('KIM_ODER_PRESENT        NO'))
  assert.ok(text.includes('FIRMA_ID_PRESENT        NO'))
  assert.ok(text.includes('ODEMETIPI_SOURCE        HARDCODED_SURAT_SERVICE_DEFAULTS'))
  assert.ok(text.includes('NETWORK_CALLS 0'))

  // TEORİK case GERÇEK davranış gibi sunulmaz.
  assert.ok(text.includes('B_SIMULATED_SELLER'))
  assert.ok(text.includes('SIMULATED_CREDENTIAL_CLASS    SELLER_PAYS'))
  assert.ok(text.includes('CONFIG_AVAILABLE              NO'))
  assert.ok(text.includes('REAL_RUNTIME_REACHABLE        NO'))
  // Gerçek çalışma zamanı bağlantısı açıkça raporlanır.
  assert.ok(text.includes('REAL_RUNTIME_BILLING_INPUT    NONE'))
  assert.ok(text.includes('EXPECTED_BILLING_PARTY_WIRED_TO_REAL_CREATE  NO'))
  assert.ok(text.includes('SELLER_PAYS_CREDENTIAL_REACHABLE_IN_REAL_CREATE  NO'))
  assert.ok(text.includes('CREDENTIAL_PRESENCE'))
  // Fidelite ARTIK SINIRLI DEĞİL: denetçi çalışma zamanı türevini uygular ve
  // ağ sınırındaki YETKİLİ çözücünün kendisini çağırır. (Eskiden ham kayıt
  // okunduğu için kanonik kimlik görünmez ve YANLIŞ "çözülemedi" raporlanırdı.)
  assert.ok(text.includes('CONFIG_SOURCE                 STORED_TENANT_CONFIG'))
  assert.ok(text.includes('RUNTIME_DERIVATION_APPLIED    YES'))
  assert.ok(
    text.includes('CREDENTIAL_RESOLUTION_FIDELITY  AUTHORITATIVE_RESOLVER'),
  )
  // Yetkili çözücünün kararı raporlanır.
  assert.ok(text.includes('CREDENTIAL_ROLE'))
  assert.ok(text.includes('CREDENTIAL_RESOLVED'))
  assert.ok(text.includes('ACCOUNT_FINGERPRINT'))
  // PII BASILMAZ.
  for (const pii of ['Gizli Mahalle 5', 'Kadıköy']) {
    assert.equal(text.includes(pii), false, `${pii} BASILMAMALI`)
  }
  // YAZMA YOK.
  for (const statement of writes) {
    assert.equal(
      /\b(insert|update|delete)\b/i.test(statement), false,
      `YAZMA TESPIT EDILDI: ${statement.slice(0, 60)}`,
    )
  }
})

test('CLI-2: --create-context bayragi CLI de bagli', () => {
  const code = codeOf('server/shipments/suratBillingInspectCli.ts')
  assert.ok(code.includes("hasFlag('create-context')"))
  assert.ok(code.includes('runCreateContextDryRun'))
  // Kuru çalıştırma gerçek sipariş görünüm modelini kullanır.
  assert.ok(code.includes('rowToOrder(target.order, [])'))
})

test('CFG-WHOPAYS: legacy payer ayari config ozetinde GORUNUR', () => {
  // H6'yı üretimde yanıtlayabilmek için `whoPays` ayarının DEĞERİ gerekir;
  // kimlik bilgisi değil, tek haneli faturalama kodudur.
  assert.ok(inspect.CONFIG_SUMMARY_ALLOWLIST.includes('whoPays'))
  const summary = inspect.buildConfigSummary({
    ...PROD_LIKE_CONFIG,
    whoPays: '3',
  })
  const whoPays = summary.allowed.find((entry) => entry.key === 'whoPays')
  assert.ok(whoPays, 'whoPays ozette olmali')
  assert.equal(whoPays.value, '3')
  // Kimlik alanları hâlâ DIŞARIDA.
  const text = JSON.stringify(summary)
  for (const secret of ['GIZLI_PRIMARY_KULLANICI_1111', 'GIZLI_SELLER_SIFRE']) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
})
