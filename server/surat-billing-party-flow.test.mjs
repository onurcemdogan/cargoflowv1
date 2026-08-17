import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

// WHO PAYS FAZ 2 — GÖZLEM KATMANI.
//
// GOLDEN OPERASYONEL GERÇEK (forensic audit'te doğrulandı):
//   Sürat getCargo whoPays = 1 → SUPPLIER/SELLER öder
//   Sürat getCargo whoPays = 3 → TRENDYOL öder
//
// Bu paketin en önemli işi, gözlem katmanının ÜRETİM DAVRANIŞINI
// DEĞİŞTİRMEDİĞİNİ kilitlemek: kanonik istek gövdesi, kredensiyal seçimi ve
// idempotency kimliği AYNEN kalmalı.

process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const billing = await import('./shipments/suratBillingParty.ts')
const getCargo = await import('./shipments/suratGetCargoClient.ts')
const adapter = await import('./shipments/suratCanonicalCreateAdapter.ts')

const nl = (v) => v.split('\r\n').join('\n')

/* ═══ SÜRAT whoPays SEMANTİĞİ ══════════════════════════════════════════ */

test('BILL-1: Surat whoPays "1" → SELLER', () => {
  assert.equal(billing.normalizeSuratWhoPays('1'), 'SELLER')
  assert.equal(billing.normalizeSuratWhoPays(1), 'SELLER')
  assert.equal(billing.normalizeSuratWhoPays(' 1 '), 'SELLER')
})

test('BILL-2: Surat whoPays "3" → TRENDYOL', () => {
  assert.equal(billing.normalizeSuratWhoPays('3'), 'TRENDYOL')
  assert.equal(billing.normalizeSuratWhoPays(3), 'TRENDYOL')
})

test('BILL-3: bilinmeyen/eksik → UNKNOWN (tahmin YOK)', () => {
  for (const value of ['', null, undefined, '2', '0', 'X', {}, []]) {
    assert.equal(billing.normalizeSuratWhoPays(value), 'UNKNOWN', String(value))
  }
})

/* ═══ BEKLENEN vs GERÇEK ═══════════════════════════════════════════════ */

test('BILL-4: SELLER + 1 → VERIFIED', () => {
  assert.equal(billing.compareBillingParty('SELLER', 'SELLER'), 'VERIFIED')
})

test('BILL-5: TRENDYOL + 3 → VERIFIED', () => {
  assert.equal(billing.compareBillingParty('TRENDYOL', 'TRENDYOL'), 'VERIFIED')
})

test('BILL-6: SELLER beklenip TRENDYOL cikarsa MISMATCH', () => {
  assert.equal(billing.compareBillingParty('SELLER', 'TRENDYOL'), 'MISMATCH')
})

test('BILL-7: TRENDYOL beklenip SELLER cikarsa MISMATCH', () => {
  assert.equal(billing.compareBillingParty('TRENDYOL', 'SELLER'), 'MISMATCH')
})

test('BILL-8: taraflardan biri UNKNOWN ise UNVERIFIED', () => {
  assert.equal(billing.compareBillingParty('UNKNOWN', 'TRENDYOL'), 'UNVERIFIED')
  assert.equal(billing.compareBillingParty('SELLER', 'UNKNOWN'), 'UNVERIFIED')
  assert.equal(billing.compareBillingParty('UNKNOWN', 'UNKNOWN'), 'UNVERIFIED')
})

/* ═══ TRENDYOL KAYNAK TEŞHİSİ ══════════════════════════════════════════ */

test('BILL-SRC-1: SAGLAYICI SOZLESMESI — whoPays property YOK → TRENDYOL', () => {
  // SÖZLEŞME DEĞİŞTİ (bu tur): eskiden "alan yok → UNKNOWN" idi. Artık
  // Trendyol paket sözleşmesine göre alanın HİÇ GÖNDERİLMEMESİ Trendyol
  // anlaşması demektir. Çıkarım YALNIZ yük gerçekten sağlayıcı ham paketi ise
  // geçerlidir — burada `orderNumber`/`cargoTrackingNumber` bunu kanıtlar.
  const inspection = billing.inspectTrendyolBillingSource({
    rawOrder: { orderNumber: '1141000001', cargoTrackingNumber: '727000001' },
  })
  assert.equal(inspection.sourceField, null)
  assert.equal(inspection.rawFieldPresent, false)
  assert.equal(inspection.billingParty, 'TRENDYOL')
  assert.equal(inspection.source, 'TRENDYOL_WHO_PAYS_ABSENT')
  assert.equal(inspection.provenance, 'PROVIDER_RAW')
  // Geçmiş veri sağlayıcı paritesi KANITLANMADIĞI için kanıt seviyesi düşük.
  assert.equal(inspection.evidence, 'UNVERIFIED_HISTORICAL_RAW')
})

test('BILL-SRC-2: SAGLAYICI SOZLESMESI — whoPays=1 → SELLER', () => {
  // TRENDYOL PROVIDER CONTRACT:
  //   whoPays=1        → satıcı anlaşması
  //   whoPays omitted  → Trendyol anlaşması
  const inspection = billing.inspectTrendyolBillingSource({
    rawOrder: { whoPays: 1 },
  })
  assert.equal(inspection.sourceField, 'whoPays')
  assert.equal(inspection.rawFieldPresent, true)
  assert.equal(inspection.billingParty, 'SELLER')
  assert.equal(inspection.source, 'TRENDYOL_WHO_PAYS_EXPLICIT_1')
})

test('BILL-SRC-3: kanitlanmamis whoPays degeri UNKNOWN kalir', () => {
  const inspection = billing.inspectTrendyolBillingSource({
    rawOrder: { whoPays: 3 },
  })
  // Trendyol tarafında `3`ün anlamı KANITLANMADI (Sürat kodlaması değil).
  assert.equal(inspection.billingParty, 'UNKNOWN')
  assert.equal(inspection.source, 'TRENDYOL_WHO_PAYS_UNSUPPORTED')
  assert.match(inspection.interpretation, /sözleşmede tanımlı değil/)
})

test('BILL-SRC-4: payer/sellerPays TARAF BELIRLEMEZ, yalniz raporlanir', () => {
  // Bu iki alan Faz 2'de KANITSIZ tahminlerdi. Sözleşme `whoPays` VARLIĞINA
  // dayandığı için ikisini birlikte karar verici tutmak TUTARSIZ olurdu:
  // `whoPays` yokken `payer=SELLER` hem "Trendyol öder" hem "satıcı öder" derdi.
  const seller = billing.inspectTrendyolBillingSource({
    rawOrder: { packageId: '1', sellerPays: true },
  })
  assert.equal(seller.billingParty, 'TRENDYOL', 'sozlesme whoPays VARLIGIDIR')
  assert.deepEqual(seller.auxiliarySignals, [
    { field: 'sellerPays', rawValue: 'true' },
  ])

  const payer = billing.inspectTrendyolBillingSource({
    rawOrder: { packageId: '1', payer: 'SELLER' },
  })
  assert.equal(payer.billingParty, 'TRENDYOL')
  assert.deepEqual(payer.auxiliarySignals, [
    { field: 'payer', rawValue: 'SELLER' },
  ])

  // Açık `whoPays` her zaman yardımcı sinyalin ÖNÜNDEDİR.
  const explicit = billing.inspectTrendyolBillingSource({
    rawOrder: { packageId: '1', whoPays: 1, payer: 'TRENDYOL' },
  })
  assert.equal(explicit.billingParty, 'SELLER')
})

/* ═══ GOLDEN ═══════════════════════════════════════════════════════════ */

test('BILL-GOLDEN-1: gercek gonderi 727...9605 → TRENDYOL (whoPays=3)', () => {
  // MASKELİ fikstür: gerçek kişi verisi YOK, yalnız operasyonel alanlar.
  const record = getCargo.parseSuratCargoBillingRecord({
    cargo: {
      parcelUniqueId: '7270035725579605',
      whoPays: '3',
      senderCode: '496056',
      approved: true,
      creationDate: '2026-07-17T10:00:00',
    },
  })
  assert.equal(record.parcelUniqueId, '7270035725579605')
  assert.equal(record.whoPays, '3')
  assert.equal(record.billingParty, 'TRENDYOL')
  assert.equal(record.senderCode, '496056')
  assert.equal(record.approved, true)

  const observation = billing.buildBillingObservation({
    order: { rawOrder: {} },
    suratWhoPays: record.whoPays,
    senderCode: record.senderCode,
  })
  assert.equal(observation.actualBillingParty, 'TRENDYOL')
  assert.equal(observation.actualBillingPartySource, 'SURAT_GET_CARGO')
  // Beklenen taraf modellenemediği için doğrulama YAPILAMAZ — gizlenmez.
  assert.equal(observation.expectedBillingParty, 'UNKNOWN')
  assert.equal(observation.billingVerificationStatus, 'UNVERIFIED')
})

test('BILL-GOLDEN-2: sentetik sozlesme fikstur — whoPays=1 → SELLER', () => {
  const record = getCargo.parseSuratCargoBillingRecord({
    whoPays: 1,
    senderCode: '000000',
  })
  assert.equal(record.billingParty, 'SELLER')
})

test('BILL-GOLDEN-3: MISMATCH gorunur olur', () => {
  const observation = billing.buildBillingObservation({
    order: { rawOrder: { whoPays: 1 } }, // beklenen SELLER
    suratWhoPays: '3', // gerçek TRENDYOL
  })
  assert.equal(observation.expectedBillingParty, 'SELLER')
  assert.equal(observation.actualBillingParty, 'TRENDYOL')
  assert.equal(observation.billingVerificationStatus, 'MISMATCH')
})

/* ═══ GETCARGO SALT OKUNURLUK ══════════════════════════════════════════ */

test('BILL-12: getCargo istemcisi CREATE ucunu CAGIRMAZ', async () => {
  const source = nl(readFileSync('server/shipments/suratGetCargoClient.ts', 'utf8'))
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  // Yalnız GET; POST/PUT/DELETE yok.
  assert.equal(code.includes("method: 'POST'"), false)
  assert.equal(code.includes("method: 'PUT'"), false)
  assert.equal(code.includes("method: 'DELETE'"), false)
  assert.ok(code.includes("method: 'GET'"))

  // Mutasyon yolu VERİLSE BİLE reddedilir.
  const calls = []
  const outcome = await getCargo.getSuratCargoByParcelUniqueId({
    parcelUniqueId: '7270035725579605',
    config: {
      baseUrl: 'https://example.invalid',
      path: '/api/OrtakBarkodOlustur',
    },
    fetchImpl: async (...args) => {
      calls.push(args)
      return new Response('{}', { status: 200 })
    },
  })
  assert.equal(outcome.status, 'FAILED')
  assert.equal(outcome.reason, 'MUTATION_PATH_REFUSED')
  assert.equal(calls.length, 0, 'create yoluna istek ATILMAMALI')
})

test('BILL-13: YAPILANDIRILMAMISSA ag cagrisi = 0 (adres UYDURULMAZ)', async () => {
  const calls = []
  const outcome = await getCargo.getSuratCargoByParcelUniqueId({
    parcelUniqueId: '7270035725579605',
    config: {},
    fetchImpl: async (...args) => {
      calls.push(args)
      return new Response('{}', { status: 200 })
    },
  })
  assert.equal(outcome.status, 'NOT_CONFIGURED')
  assert.equal(calls.length, 0, 'tahmini adrese istek YOK')
  assert.equal(getCargo.isGetCargoConfigured({}), false)
  assert.equal(
    getCargo.isGetCargoConfigured({ baseUrl: 'https://x', path: '/api/getCargo' }),
    true,
  )
})

test('BILL-GC-1: bilinmeyen yanit alanlari KIRMAZ', () => {
  const record = getCargo.parseSuratCargoBillingRecord({
    cargo: { whoPays: '3', beklenmeyenAlan: { derin: true } },
  }, '727X')
  assert.equal(record.billingParty, 'TRENDYOL')
  assert.equal(record.parcelUniqueId, '727X')
  assert.equal(record.approved, null)
})

/* ═══ ÜRETİM DAVRANIŞI DEĞİŞMEDİ ═══════════════════════════════════════ */

test('BILL-9: gozlem alanlari KANONIK istege SIZMIYOR', () => {
  const model = nl(
    readFileSync('server/shipments/suratCanonicalGonderiModel.ts', 'utf8'),
  )
  // WhoPays hâlâ YASAK ve alan kümesinde YOK.
  assert.ok(model.includes("'WhoPays'"), 'yasak listesinde kalmali')
  const fieldsBlock = model.slice(
    model.indexOf('export const CANONICAL_GONDERI_FIELDS'),
    model.indexOf('] as const', model.indexOf('CANONICAL_GONDERI_FIELDS')),
  )
  for (const forbidden of ['WhoPays', 'KimOder', 'Payer', 'BillingParty']) {
    assert.equal(fieldsBlock.includes(forbidden), false, `${forbidden} SIZDI`)
  }
  // Gözlem modülü kanonik model/istemci tarafından import EDİLMEZ.
  const client = nl(readFileSync('server/shipments/suratWebApiClient.ts', 'utf8'))
  assert.equal(model.includes('suratBillingParty'), false)
  assert.equal(client.includes('suratBillingParty'), false)
})

test('BILL-10: faturalama beklentisi IDEMPOTENCY kimligini DEGISTIRMIYOR', () => {
  const server = nl(readFileSync('server/index.mjs', 'utf8'))
  const start = server.indexOf('const fingerprintPayload = {')
  assert.ok(start > 0)
  const block = server.slice(start, server.indexOf('}', start))
  // DIŞ create semantiğini değiştirmeyen gözlem alanları kimliğe GİRMEZ.
  for (const field of [
    'billingParty', 'expectedBillingParty', 'whoPays', 'payer', 'sellerPays',
  ]) {
    assert.equal(block.includes(field), false, `${field} fingerprinte GIRMEMELI`)
  }
  // Idempotency anahtarı da payer'dan bağımsız.
  assert.ok(server.includes('idempotencyKey: `SURAT:${tenantId}:${orderId}:CREATE`'))
})

test('BILL-11: kredensiyal secimi bu turda DEGISMEDI', () => {
  // Aynı sipariş → aynı sınıf. Gözlem katmanı auth davranışını etkilemez.
  const order = { rawOrder: { whoPays: 1 } }
  assert.equal(
    adapter.resolveSuratBillingParty({ order, cashOnDelivery: false }),
    'PRIMARY',
    'ham payer sinyali kredensiyal sinifini DEGISTIRMEMELI',
  )
  assert.equal(
    adapter.resolveSuratBillingParty({ order: {}, cashOnDelivery: false }),
    'PRIMARY',
  )
  assert.equal(
    adapter.resolveSuratBillingParty({ order: {}, cashOnDelivery: true }),
    'CASH_ON_DELIVERY',
  )
  // Beklenen faturalama tarafı AYRI bir kavram olarak durur.
  assert.equal(
    billing.deriveExpectedBillingParty(order).billingParty, 'SELLER',
  )
})

test('BILL-OBS-1: gozlem baskiyi/basariyi ETKILEMEZ', () => {
  // YORUMLARI AYIKLA: açıklama metnindeki isimler kod sayılmaz.
  const code = nl(readFileSync('server/shipments/suratBillingParty.ts', 'utf8'))
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      return (
        !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
      )
    })
    .join('\n')
  for (const forbidden of [
    'printEnabled', 'labelStatus', 'carrierCreateStatus', 'idempotency',
    'OrtakBarkodOlustur', 'fetch(', 'getDb(', '.insert(', '.update(',
  ]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
})

/* ═══ CLI ══════════════════════════════════════════════════════════════ */

test('BILL-14: CLI varsayilan ag = 0, DB yazma = 0', () => {
  const source = nl(
    readFileSync('server/shipments/suratBillingInspectCli.ts', 'utf8'),
  )
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  // YAZMA YOK.
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'migrate(']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  // Ağ yalnız AÇIK `--get-cargo` ile.
  assert.ok(code.includes("hasFlag('get-cargo')"))
  assert.ok(code.includes('getCargoStatus = \'SKIPPED\''))
  // Doğrudan fetch yok; yalnız salt-okunur istemci üzerinden.
  assert.equal(/\bfetch\(/.test(code), false)
})

test('BILL-CLI-1: rapor PII/kimlik bilgisi BASMAZ', () => {
  const lines = (
    [
      'organizationMasked', 'packageIdMasked', 'marketplace', 'rawSourceField',
      'rawValue', 'expectedBillingParty', 'expectedBillingPartySource',
      'credentialClass', 'parcelUniqueId', 'shipmentIds', 'getCargoRequested',
      'getCargoStatus', 'actualSuratWhoPays', 'actualBillingParty', 'senderCode',
      'billingVerificationStatus',
    ]
  )
  const source = nl(
    readFileSync('server/shipments/suratBillingInspectCli.ts', 'utf8'),
  )
  const start = source.indexOf('export function formatBillingReport')
  const block = source.slice(start, source.indexOf('\n}', start))
  for (const forbidden of [
    'customerFirstName', 'customerLastName', 'customerPhone', 'customerEmail',
    'shippingCity', 'kullaniciAdi', 'sifre', 'password', 'Encrypted',
  ]) {
    assert.equal(block.includes(forbidden), false, `${forbidden} BASILMAMALI`)
  }
  // Rapor alanları yalnız operasyonel payer metadatası.
  for (const field of lines) {
    assert.ok(source.includes(field), `${field} raporda olmali`)
  }
})

/* ═══ FAZ 3 — ADAY TARAMA + NEDENSELLİK ═══════════════════════════════ */

const candidate = (overrides = {}) => ({
  packageIdMasked: '****0001',
  rawSourceField: null,
  rawValue: null,
  expectedBillingParty: 'UNKNOWN',
  credentialClass: 'PRIMARY',
  accountFingerprint: 'acc-aaaa',
  serviceMode: 'SURAT_CANONICAL_API',
  actualSuratWhoPays: null,
  actualBillingParty: 'UNKNOWN',
  senderCode: null,
  ...overrides,
})

test('SCAN-1: gruplama anahtari sinif+hesap+servisModu', () => {
  const key = billing.billingGroupKey({
    credentialClass: 'PRIMARY',
    accountFingerprint: 'acc-aaaa',
    serviceMode: 'SURAT_CANONICAL_API',
  })
  assert.equal(key, 'PRIMARY::acc-aaaa::SURAT_CANONICAL_API')
  // AYNI sınıf ama FARKLI hesap → AYRI grup (yanlış pozitif önlenir).
  assert.notEqual(
    key,
    billing.billingGroupKey({
      credentialClass: 'PRIMARY',
      accountFingerprint: 'acc-bbbb',
      serviceMode: 'SURAT_CANONICAL_API',
    }),
  )
})

test('SCAN-2: AYNI hesapta hem 1 hem 3 → CREDENTIAL_ONLY REFUTED', () => {
  const summary = billing.summarizeBillingScan([
    candidate({ actualSuratWhoPays: '1', actualBillingParty: 'SELLER' }),
    candidate({ actualSuratWhoPays: '3', actualBillingParty: 'TRENDYOL' }),
  ])
  assert.equal(summary.groups.length, 1, 'ayni baglam TEK grup')
  assert.deepEqual(summary.groups[0].observedWhoPays, ['1', '3'])
  assert.equal(summary.sameAccountBothWhoPays, true)
  assert.equal(summary.credentialOnlyCausation, 'REFUTED')
})

test('SCAN-3: FARKLI hesaplarda 1 ve 3 CURUTMEZ (yanlis pozitif YOK)', () => {
  const summary = billing.summarizeBillingScan([
    candidate({ accountFingerprint: 'acc-aaaa', actualSuratWhoPays: '1' }),
    candidate({ accountFingerprint: 'acc-bbbb', actualSuratWhoPays: '3' }),
  ])
  assert.equal(summary.groups.length, 2)
  assert.equal(summary.sameAccountBothWhoPays, false)
  // Kanıt yoksa "doğrulandı" DENMEZ.
  assert.equal(summary.credentialOnlyCausation, 'UNRESOLVED')
})

test('SCAN-4: FARKLI servis modu ayri grup sayilir', () => {
  const summary = billing.summarizeBillingScan([
    candidate({ serviceMode: 'SURAT_CANONICAL_API', actualSuratWhoPays: '1' }),
    candidate({ serviceMode: 'ORTAK_BARKOD_SOAP', actualSuratWhoPays: '3' }),
  ])
  assert.equal(summary.sameAccountBothWhoPays, false, 'mod farkli → nedensellik YOK')
})

test('SCAN-5: ham payer dagilimi dogru sayilir', () => {
  const summary = billing.summarizeBillingScan([
    candidate({ rawSourceField: 'whoPays', rawValue: '1' }),
    candidate({ rawSourceField: 'whoPays', rawValue: '1' }),
    candidate({ rawSourceField: 'whoPays', rawValue: '9' }),
    candidate(),
    candidate(),
  ])
  assert.equal(summary.sampledOrders, 5)
  assert.equal(summary.rawWhoPays1Count, 2)
  assert.equal(summary.rawOtherCount, 1)
  assert.equal(summary.rawMissingCount, 2)
  assert.deepEqual(summary.credentialClasses, { PRIMARY: 5 })
})

test('SCAN-6: gercek whoPays gozlenmemisse CURUTME YOK', () => {
  // Yalnız ham taraf taranmışsa (getCargo yok) nedensellik ÇÖZÜLEMEZ.
  const summary = billing.summarizeBillingScan([
    candidate({ rawSourceField: 'whoPays', rawValue: '1' }),
    candidate(),
  ])
  assert.deepEqual(summary.groups[0].observedWhoPays, [])
  assert.equal(summary.credentialOnlyCausation, 'UNRESOLVED')
})
