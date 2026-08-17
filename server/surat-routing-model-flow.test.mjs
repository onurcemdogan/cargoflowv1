import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// FAZ 5B — YÖNLENDİRME KATMANLARININ AYRILMASI.
//
// BEŞ EKSEN BİRBİRİNİ DEĞİŞTİREMEZ:
//   billing · payment(OdemeTipi) · COD · credential · contract
//
// EN KRİTİK İKİ KURAL:
//   · OdemeTipi ile BillingParty arasında OTOMATİK EŞLEME YOK.
//   · COD faturalama tarafını, faturalama tarafı COD'u DEĞİŞTİREMEZ.
//
// VE: SESSİZ KREDENSİYAL DÜŞÜŞÜ YOK.

const routing = await import('./shipments/suratRoutingModel.ts')
const trace = await import('./shipments/suratCreateTrace.ts')
const model = await import('./shipments/suratCanonicalGonderiModel.ts')

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
  canonicalPrimaryKullaniciAdi: '1551267127',
  canonicalPrimarySifre: 'GIZLI_PRIMARY',
  sellerPaysKullaniciAdi: '1551260044',
  sellerPaysSifre: 'GIZLI_SELLER',
  codKullaniciAdi: '1551260033',
  codSifre: 'GIZLI_COD',
}

const noCod = routing.resolveCodContext({ enabled: false })
const withCod = routing.resolveCodContext({
  enabled: true, collectionType: '1', amount: 250,
})

const route = (billingParty, cod, config = CONFIG, codPolicy) =>
  routing.resolveSuratCredentialContext({ config, billingParty, cod, codPolicy })

/* ═══ TEST MATRİSİ 1-5: KREDENSİYAL YÖNLENDİRME ════════════════════════ */

test('MTX-1: TRENDYOL_PAYS + COD=false → PRIMARY_MARKETPLACE', () => {
  const context = route('TRENDYOL_PAYS', noCod)
  assert.equal(context.role, 'PRIMARY_MARKETPLACE')
  assert.equal(context.source, 'tenant.surat.primary')
  assert.equal(context.reason, 'TRENDYOL_MARKETPLACE_NON_COD')
  assert.equal(context.resolved, true)
  assert.equal(context.errorCode, null)
  assert.equal(context.maskedAccount, '15******27')
})

test('MTX-2: SELLER_PAYS + COD=false → SELLER_PAYS kimligi', () => {
  const context = route('SELLER_PAYS', noCod)
  assert.equal(context.role, 'SELLER_PAYS')
  assert.equal(context.reason, 'SELLER_PAYS_NON_COD')
  assert.equal(context.resolved, true)
})

test('MTX-3: TRENDYOL_PAYS + COD=true → DEDICATED_COD', () => {
  const context = route('TRENDYOL_PAYS', withCod)
  assert.equal(context.role, 'COD')
  assert.equal(context.source, 'tenant.surat.cod')
  assert.equal(context.reason, 'COD_DEDICATED_COD')
  assert.equal(context.resolved, true)
})

test('MTX-4: SELLER_PAYS + COD=true → yine DEDICATED_COD', () => {
  // COD politikasi faturalama tarafindan BAGIMSIZDIR.
  const context = route('SELLER_PAYS', withCod)
  assert.equal(context.role, 'COD')
  assert.equal(context.reason, 'COD_DEDICATED_COD')
})

test('MTX-5: COD kimligi YOKSA SESSIZCE baska role DUSULMEZ', () => {
  const context = route('TRENDYOL_PAYS', withCod, {
    ...CONFIG, codKullaniciAdi: '', codSifre: '',
  })
  assert.equal(context.role, 'COD', 'rol DEGISMEZ')
  assert.equal(context.resolved, false)
  assert.equal(context.errorCode, 'COD_CREDENTIAL_NOT_CONFIGURED')
  assert.equal(context.maskedAccount, '')

  // Ve on kontrol create'i ENGELLER → ag cagrisi 0.
  const preflight = routing.evaluateSuratCreatePreflight({
    marketplace: 'Trendyol', pazaryerimi: 1, entegrasyonFirmasi: 'Trendyol',
    ozelKargoTakipNo: '7270035942963454',
    billingParty: 'TRENDYOL_PAYS', credential: context,
  })
  assert.equal(preflight.valid, false)
  assert.equal(preflight.errorCode, 'BILLING_CONTEXT_INVALID')
  assert.ok(preflight.failures.includes('COD_CREDENTIAL_NOT_CONFIGURED'))
})

test('MTX-5b: acik politika SELLER_PAYS/PRIMARY secilebilir', () => {
  assert.equal(route('TRENDYOL_PAYS', withCod, CONFIG, 'SELLER_PAYS').role, 'SELLER_PAYS')
  assert.equal(
    route('TRENDYOL_PAYS', withCod, CONFIG, 'PRIMARY').role, 'PRIMARY_MARKETPLACE',
  )
  // Tanimsiz/gecersiz politika varsayilan DEDICATED_COD'a duser (migration-safe).
  assert.equal(routing.resolveCodCredentialPolicy(undefined), 'DEDICATED_COD')
  assert.equal(routing.resolveCodCredentialPolicy('SAÇMA'), 'DEDICATED_COD')
  assert.equal(routing.resolveCodCredentialPolicy('primary'), 'PRIMARY')
})

/* ═══ TEST MATRİSİ 6-8: PAZARYERİ ÖN KONTROLÜ ══════════════════════════ */

const validPreflight = (over = {}) =>
  routing.evaluateSuratCreatePreflight({
    marketplace: 'Trendyol',
    pazaryerimi: 1,
    entegrasyonFirmasi: 'Trendyol',
    ozelKargoTakipNo: '7270035942963454',
    orderCargoTrackingNumber: '7270035942963454',
    billingParty: 'TRENDYOL_PAYS',
    credential: route('TRENDYOL_PAYS', noCod),
    ...over,
  })

test('MTX-6: Pazaryerimi=0 → BLOCKED', () => {
  const result = validPreflight({ pazaryerimi: 0 })
  assert.equal(result.valid, false)
  assert.ok(result.failures.includes('PAZARYERIMI_NOT_1'))
})

test('MTX-7: EntegrasyonFirmasi eksik → BLOCKED', () => {
  const result = validPreflight({ entegrasyonFirmasi: '' })
  assert.equal(result.valid, false)
  assert.ok(result.failures.includes('ENTEGRASYON_FIRMASI_INVALID'))
})

test('MTX-8: 727 eksik/bozuk/baska kaynak → BLOCKED', () => {
  assert.ok(
    validPreflight({ ozelKargoTakipNo: '' }).failures.includes(
      'OZEL_KARGO_TAKIP_NO_MISSING',
    ),
  )
  // BİÇİM BLOKLAMAZ — mevcut kanonik sözleşme yalnız "boş değil" ister.
  // Uydurma bir hane kuralı gerçek gönderileri engelleyebilirdi; biçim
  // yalnız TEŞHİS olarak raporlanır.
  const oddFormat = validPreflight({
    ozelKargoTakipNo: 'PKG-1', orderCargoTrackingNumber: 'PKG-1',
  })
  assert.equal(oddFormat.valid, true, 'bicim BLOKLAMAZ')
  assert.equal(oddFormat.parcelIdentityFormatValid, false, 'ama RAPORLANIR')
  assert.equal(validPreflight().parcelIdentityFormatValid, true)
  // Numara SIPARISTEN gelmeli; baska kaynak faturalamayi bozar.
  assert.ok(
    validPreflight({
      ozelKargoTakipNo: '7270035942963454',
      orderCargoTrackingNumber: '7270035999999999',
    }).failures.includes('OZEL_KARGO_TAKIP_NO_SOURCE_MISMATCH'),
  )
  // Gecerli baglam gecer.
  const ok = validPreflight()
  assert.equal(ok.valid, true)
  assert.equal(ok.errorCode, null)
  assert.equal(ok.expectedSuratWhoPays, '3')
})

/* ═══ TEST MATRİSİ 9-12: KATMAN BAĞIMSIZLIĞI ══════════════════════════ */

test('MTX-9: whoPays ABSENT → TRENDYOL_PAYS / expected 3', () => {
  const billing = routing.resolveBillingPartyV2({ packageId: '1' })
  assert.equal(billing.billingParty, 'TRENDYOL_PAYS')
  assert.equal(billing.rawWhoPaysPresent, false)
  assert.equal(billing.billingEvidence, 'TRENDYOL_WHO_PAYS_ABSENT')
  assert.equal(routing.expectedSuratWhoPays(billing.billingParty), '3')
})

test('MTX-10: whoPays=1 → SELLER_PAYS / expected 1', () => {
  for (const value of [1, '1']) {
    const billing = routing.resolveBillingPartyV2({ whoPays: value })
    assert.equal(billing.billingParty, 'SELLER_PAYS', String(value))
    assert.equal(routing.expectedSuratWhoPays(billing.billingParty), '1')
  }
  // Desteklenmeyen deger fail-closed.
  const unknown = routing.resolveBillingPartyV2({ whoPays: null })
  assert.equal(unknown.billingParty, 'UNKNOWN')
  assert.equal(routing.expectedSuratWhoPays('UNKNOWN'), null)
})

test('MTX-11: OdemeTipi billingParty yi DEGISTIRMEZ', () => {
  const raw = { packageId: '1' }
  const billing = routing.resolveBillingPartyV2(raw)
  assert.equal(billing.billingParty, 'TRENDYOL_PAYS')
  // TRENDYOL_PAYS + OdemeTipi=1 GECERLI bir kombinasyondur.
  assert.equal(routing.describeOdemeTipi(1).odemeTipiMeaning, 'PESIN')
  assert.equal(routing.describeOdemeTipi(2).odemeTipiMeaning, 'UCRET_ALICI')
  assert.equal(routing.describeOdemeTipi(9).odemeTipiMeaning, 'UNKNOWN')
  // Kaynak kaniti: yonlendirme modulunde OdemeTipi -> billing esleme YOK.
  const code = codeOf('server/shipments/suratRoutingModel.ts')
  assert.equal(/odemeTipi[\s\S]{0,80}billingParty\s*=/.test(code), false)
})

test('MTX-12: COD toggle billingParty yi DEGISTIRMEZ', () => {
  const raw = { packageId: '1' }
  assert.equal(routing.resolveBillingPartyV2(raw).billingParty, 'TRENDYOL_PAYS')
  // COD acik/kapali — faturalama tarafi AYNI kalir.
  assert.equal(
    route('TRENDYOL_PAYS', withCod).reason.startsWith('COD_'), true,
  )
  assert.equal(route('TRENDYOL_PAYS', noCod).reason, 'TRENDYOL_MARKETPLACE_NON_COD')
  // Ve COD kapaliyken tahsilat alanlari TASINMAZ.
  assert.equal(noCod.codCollectionType, null)
  assert.equal(noCod.codAmountPresent, false)
  assert.equal(withCod.codCollectionTypeMeaning, 'NAKIT')
  assert.equal(
    routing.resolveCodContext({ enabled: true, collectionType: '2', amount: 1 })
      .codCollectionTypeMeaning,
    'POS',
  )
})

/* ═══ BEKLENEN vs TELDE GİDEN ═════════════════════════════════════════ */

test('WIRE-1: kanonik sozlesme WhoPays TASIMAZ — sebep ACIKCA yazilir', () => {
  const wire = trace.describeWireWhoPays({
    contractFields: model.CANONICAL_GONDERI_FIELDS,
  })
  assert.equal(wire.wireWhoPaysPresent, false)
  assert.equal(wire.wireWhoPaysValue, null)
  assert.equal(wire.wireWhoPaysReason, 'CONTRACT_HAS_NO_WHO_PAYS_FIELD')
  // Beklenti 3 olsa BILE telde alan GITMEZ; ikisi AYRI tutulur.
  assert.equal(routing.expectedSuratWhoPays('TRENDYOL_PAYS'), '3')
})

test('WIRE-2: sozlesme destekliyorsa gonderilen deger raporlanir', () => {
  const supported = ['WhoPays', 'OdemeTipi']
  assert.deepEqual(
    trace.describeWireWhoPays({ contractFields: supported, requestBody: { WhoPays: 3 } }),
    { wireWhoPaysPresent: true, wireWhoPaysValue: '3', wireWhoPaysReason: 'SENT' },
  )
  assert.equal(
    trace.describeWireWhoPays({ contractFields: supported, requestBody: {} })
      .wireWhoPaysReason,
    'CONTRACT_SUPPORTS_BUT_NOT_SENT',
  )
})

/* ═══ İZ: GİZLİLİK + ŞEMA ═════════════════════════════════════════════ */

test('TRC-1: istek izi SIR/PII TASIMAZ, yalniz varlik + guvenli deger', () => {
  const built = trace.buildRequestTrace({
    KullaniciAdi: '1551267127',
    Sifre: 'GIZLI_SIFRE',
    OdemeTipi: 1,
    Pazaryerimi: 1,
    EntegrasyonFirmasi: 'Trendyol',
    OzelKargoTakipNo: '7270035942963454',
    KapidanOdemeTahsilatTipi: 0,
    AliciAdresi: 'Gizli Mahalle 5',
    TelefonCep: '05551112233',
  })
  assert.equal(built.requestFieldPresence.KullaniciAdi, true)
  assert.equal(built.requestFieldPresence.Sifre, true)
  assert.equal(built.requestFieldPresence.WhoPays, false)
  const text = JSON.stringify(built)
  for (const secret of [
    '1551267127', 'GIZLI_SIFRE', 'Gizli Mahalle 5', '05551112233',
    '7270035942963454',
  ]) {
    assert.equal(text.includes(secret), false, `${secret} SIZDI`)
  }
  // Faturalama acisindan anlamli ve PII olmayan degerler GORUNUR.
  assert.equal(built.requestSemanticSnapshot.Pazaryerimi, 1)
  assert.equal(built.requestSemanticSnapshot.EntegrasyonFirmasi, 'Trendyol')
  assert.equal(built.requestSemanticSnapshot.OzelKargoTakipNoMasked, '****3454')
})

test('TRC-2: kullaniciya mesaj kod + korelasyon verir, sir VERMEZ', () => {
  const id = trace.buildTraceId('SURAT:org:PKG-1:CREATE')
  assert.ok(id.startsWith('CF-'))
  const message = trace.buildUserFacingError({ traceId: id, businessCode: '039' })
  assert.ok(message.includes('039'))
  assert.ok(message.includes(id))
  assert.equal(message.includes('Sifre'), false)
  // Kod yoksa da iz kimligi VERILIR.
  assert.ok(
    trace.buildUserFacingError({ traceId: id }).includes(id),
  )
})

test('MTX-13: ESKI sema izleri yeni ekranda GORUNMEZ', () => {
  const traces = [
    { schemaVersion: 1, traceId: 'CF-OLD', createdAt: '2026-08-17T09:00:00.000Z' },
    { schemaVersion: 2, traceId: 'CF-NEW', createdAt: '2026-08-17T09:00:00.000Z' },
    { traceId: 'CF-NONE', createdAt: '2026-08-17T09:00:00.000Z' },
  ]
  const current = trace.selectCurrentSchemaTraces(traces)
  assert.equal(current.length, 1)
  assert.equal(current[0].traceId, 'CF-NEW')
})

test('TRC-3: saklama GUN ve ADET sinirlarini birlikte uygular', () => {
  const now = '2026-08-17T09:00:00.000Z'
  const old = { createdAt: '2026-08-01T09:00:00.000Z' }
  const fresh = { createdAt: '2026-08-16T09:00:00.000Z' }
  assert.deepEqual(trace.applyTraceRetention([old, fresh], now), [fresh])

  const many = Array.from({ length: 250 }, () => ({ createdAt: fresh.createdAt }))
  assert.equal(
    trace.applyTraceRetention(many, now).length,
    trace.TRACE_RETENTION_MAX_PER_TENANT,
  )
  assert.equal(trace.TRACE_RETENTION_DAYS, 7)
  assert.equal(trace.SURAT_TRACE_SCHEMA_VERSION, 2)
})

test('TRC-4: alan durumlari operator icin isaretlenir', () => {
  const status = trace.traceFieldStatus({
    billingParty: 'TRENDYOL_PAYS',
    credential: route('TRENDYOL_PAYS', noCod),
    preflightValid: true,
  })
  assert.equal(status.billing, 'OK')
  assert.equal(status.credential, 'OK')
  assert.equal(status.marketplace, 'OK')
  // Gercek odeyen taraf hala okunamiyor: BASARI degil, UYARI.
  assert.equal(status.carrierResult, 'WARNING')

  const broken = trace.traceFieldStatus({
    billingParty: 'UNKNOWN',
    credential: route('TRENDYOL_PAYS', withCod, { ...CONFIG, codSifre: '' }),
    preflightValid: false,
  })
  assert.equal(broken.billing, 'ERROR')
  assert.equal(broken.credential, 'ERROR')
  assert.equal(broken.marketplace, 'ERROR')
})

/* ═══ ÜRETİM DAVRANIŞI DEĞİŞMEDİ ══════════════════════════════════════ */

test('SAFE-1: yonlendirme OTORITER create sinirina BAGLANDI', () => {
  // Faz 5C: model artik GERCEK create yolunda. Tek otoriter sinir adaptor.
  const adapter = codeOf('server/shipments/suratCanonicalCreateAdapter.ts')
  assert.ok(adapter.includes('resolveSuratCredentialContext('))
  assert.ok(adapter.includes('evaluateSuratCreatePreflight('))
  assert.ok(adapter.includes('resolveBillingPartyV2('))
  assert.ok(adapter.includes('buildTraceId('))

  // Alt katmanlar HALA saf: model/istemci yonlendirme bilmez.
  for (const file of [
    'server/shipments/suratCanonicalGonderiModel.ts',
    'server/shipments/suratWebApiClient.ts',
  ]) {
    const code = codeOf(file)
    assert.equal(code.includes('suratRoutingModel'), false, file)
    assert.equal(code.includes('suratCreateTrace'), false, file)
  }
  // Kanonik govde HALA WhoPays/KimOder TASIMAZ.
  for (const field of ['WhoPays', 'KimOder']) {
    assert.equal(model.CANONICAL_GONDERI_FIELDS.includes(field), false)
    assert.ok(model.FORBIDDEN_CANONICAL_FIELDS.includes(field))
  }
})

test('SAFE-2: modeller SAF — ag/DB/yazma YOK', () => {
  for (const file of [
    'server/shipments/suratRoutingModel.ts',
    'server/shipments/suratCreateTrace.ts',
  ]) {
    const code = codeOf(file)
    for (const forbidden of ['.insert(', '.update(', '.delete(', 'getDb(']) {
      assert.equal(code.includes(forbidden), false, `${file}: ${forbidden}`)
    }
    assert.equal(/\bfetch\(/.test(code), false, `${file}: ag`)
  }
})
