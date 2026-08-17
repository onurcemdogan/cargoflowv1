import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// FATURALAMA DOĞRULAMA DURUM MAKİNESİ.
//
// EN KRİTİK KURAL — BU PAKETİN VARLIK SEBEBİ:
//   UNVERIFIED != VERIFIED
// Barkod/T.No üretilmiş olması faturalamanın doğru tarafa yazıldığını
// KANITLAMAZ. Taşıyıcı ekseni ile faturalama ekseni ayrı ayrı kilitlenir.
//
// İKİ SAĞLAYICI SÖZLEŞMESİ ASLA BİRLEŞTİRİLMEZ:
//   TRENDYOL (beklenen): whoPays absent → TRENDYOL, 1 → SELLER
//   SÜRAT   (gerçek)   : whoPays 1 → SELLER, 3 → TRENDYOL

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const verify = await import('./shipments/suratBillingVerification.ts')
const contract = await import('./shipments/suratBillingSuccessContract.ts')
const billing = await import('./shipments/suratBillingParty.ts')
const inspect = await import('./shipments/suratBillingInspectCli.ts')
const orderEncryption = await import('./orders/orderEncryption.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []
const codeOf = (file) =>
  nl(readFileSync(file, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

const AT = '2026-08-17T09:00:00.000Z'

const expectation = (party, source = 'TRENDYOL_WHO_PAYS_ABSENT') =>
  verify.buildBillingExpectationSnapshot({
    expectedParty: party,
    expectedSource: source,
    expectedEvidence: 'UNVERIFIED_HISTORICAL_RAW',
    capturedAt: AT,
  })

const suratActual = (whoPays) =>
  verify.readSuratActualBillingParty({ whoPays, senderCode: '496056' })

const evaluate = (expected, actual, carrier = 'SUCCESS') =>
  verify.evaluateBillingVerification({
    carrierCreateStatus: carrier,
    expected,
    actual,
  })

/* ═══ TEST MATRİSİ ═════════════════════════════════════════════════════ */

test('VER-1: expected TRENDYOL + gercek OKUNAMADI → UNVERIFIED', () => {
  const result = evaluate(expectation('TRENDYOL'), null)
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.reason, 'ACTUAL_NOT_READ')
  assert.equal(result.actualParty, 'UNKNOWN')
})

test('VER-2: expected SELLER + gercek OKUNAMADI → UNVERIFIED', () => {
  const result = evaluate(
    expectation('SELLER', 'TRENDYOL_WHO_PAYS_EXPLICIT_1'), null,
  )
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.expectedParty, 'SELLER')
})

test('VER-3: expected TRENDYOL + Surat 3 → VERIFIED', () => {
  const result = evaluate(expectation('TRENDYOL'), suratActual('3'))
  assert.equal(result.status, 'VERIFIED')
  assert.equal(result.actualParty, 'TRENDYOL')
  assert.equal(result.actualSource, 'SURAT_GET_CARGO')
})

test('VER-4: expected SELLER + Surat 1 → VERIFIED', () => {
  const result = evaluate(
    expectation('SELLER', 'TRENDYOL_WHO_PAYS_EXPLICIT_1'), suratActual(1),
  )
  assert.equal(result.status, 'VERIFIED')
  assert.equal(result.actualParty, 'SELLER')
})

test('VER-5: expected TRENDYOL + Surat 1 → MISMATCH', () => {
  const result = evaluate(expectation('TRENDYOL'), suratActual('1'))
  assert.equal(result.status, 'MISMATCH')
  assert.equal(result.reason, 'EXPECTED_DIFFERS_FROM_ACTUAL')
})

test('VER-6: expected SELLER + Surat 3 → MISMATCH', () => {
  const result = evaluate(
    expectation('SELLER', 'TRENDYOL_WHO_PAYS_EXPLICIT_1'), suratActual('3'),
  )
  assert.equal(result.status, 'MISMATCH')
})

test('VER-7: expected UNKNOWN + Surat 3 → UNVERIFIED (FAIL CLOSED)', () => {
  // Tek taraflı bilgi doğrulama SAYILMAZ. Gerçek taraf okunmuş olsa bile
  // beklenti yoksa karşılaştırılacak bir şey yoktur.
  const result = evaluate(expectation('UNKNOWN', 'UNKNOWN'), suratActual('3'))
  assert.equal(result.status, 'UNVERIFIED')
  assert.equal(result.reason, 'EXPECTED_PARTY_UNKNOWN')
  assert.notEqual(result.status, 'VERIFIED')
})

test('VER-8: Surat whoPays null/2/4/"" → UNKNOWN, dogrulama YAPILMAZ', () => {
  for (const value of ['2', '4', 'X']) {
    const reading = suratActual(value)
    assert.equal(reading.actualParty, 'UNKNOWN', value)
    const result = evaluate(expectation('TRENDYOL'), reading)
    assert.equal(result.status, 'UNVERIFIED')
    assert.equal(result.reason, 'ACTUAL_WHO_PAYS_UNRECOGNIZED')
  }
  // Boş/null bir okuma BAŞARISIZ okumadır, "bilinmeyen taraf" değil.
  for (const value of ['', null, undefined]) {
    const reading = suratActual(value)
    assert.equal(reading.status, 'FAILED', String(value))
    assert.equal(evaluate(expectation('TRENDYOL'), reading).status, 'ERROR')
  }
})

test('VER-9: NAMESPACE CAKISMASI YOK — ayni sayi iki ayri anlam', () => {
  // Trendyol tarafında `3` TANINMAZ (UNKNOWN).
  assert.equal(billing.classifyTrendyolWhoPays({ whoPays: 3 }).billingParty, 'UNKNOWN')
  // Sürat tarafında `3` TRENDYOL demektir.
  assert.equal(billing.normalizeSuratWhoPays(3), 'TRENDYOL')
  // Trendyol'da alan YOKLUĞU TRENDYOL; Sürat'ta yokluk bir okuma HATASI.
  assert.equal(billing.classifyTrendyolWhoPays({}).billingParty, 'TRENDYOL')
  assert.equal(suratActual(undefined).status, 'FAILED')
  // `1` ise iki sözleşmede de SELLER — tesadüf, birleştirme gerekçesi DEĞİL.
  assert.equal(billing.classifyTrendyolWhoPays({ whoPays: 1 }).billingParty, 'SELLER')
  assert.equal(billing.normalizeSuratWhoPays(1), 'SELLER')
})

test('VER-10: tasiyici create yoksa/basarisizsa NOT_APPLICABLE', () => {
  assert.equal(
    evaluate(expectation('TRENDYOL'), suratActual('3'), 'NOT_STARTED').status,
    'NOT_APPLICABLE',
  )
  assert.equal(
    evaluate(expectation('TRENDYOL'), suratActual('3'), 'FAILED').reason,
    'CARRIER_CREATE_FAILED',
  )
})

test('VER-11: sozlesme yokken UNVERIFIED — sebep ACIKCA raporlanir', () => {
  const reader = verify.createContractUnavailableActualReader()
  return reader
    .readActualBillingParty({ organizationId: 'org', parcelUniqueId: '727' })
    .then((reading) => {
      assert.equal(reading.status, 'CONTRACT_UNAVAILABLE')
      assert.equal(reading.actualParty, 'UNKNOWN')
      const result = evaluate(expectation('TRENDYOL'), reading)
      assert.equal(result.status, 'UNVERIFIED')
      assert.equal(result.reason, 'ACTUAL_PROVIDER_CONTRACT_UNAVAILABLE')
    })
})

test('VER-12: PENDING okuma VERIFIED e DONUSMEZ', () => {
  const result = evaluate(expectation('TRENDYOL'), {
    status: 'PENDING', actualWhoPays: null, actualParty: 'UNKNOWN',
    senderCode: null, evidence: 'UNKNOWN',
  })
  assert.equal(result.status, 'PENDING')
})

/* ═══ BİLEŞİK OPERASYON DURUMU ═════════════════════════════════════════ */

test('SUC-4: carrier SUCCESS + billing unverified → BILLING_UNVERIFIED', () => {
  const { verification, classification } =
    contract.classifyBillingOperationFromVerification({
      carrierCreateStatus: 'SUCCESS',
      expected: expectation('TRENDYOL'),
      actual: null,
    })
  assert.equal(verification.status, 'UNVERIFIED')
  assert.equal(classification.outcome, 'OPERATION_SUCCESS_BILLING_UNVERIFIED')
  assert.equal(classification.carrierCreateSuccess, true)
})

test('SUC-5: carrier SUCCESS + mismatch → BILLING_MISMATCH (create BASARILI)', () => {
  const { verification, classification } =
    contract.classifyBillingOperationFromVerification({
      carrierCreateStatus: 'SUCCESS',
      expected: expectation('TRENDYOL'),
      actual: suratActual('1'),
    })
  assert.equal(verification.status, 'MISMATCH')
  assert.equal(classification.outcome, 'BILLING_MISMATCH')
  assert.equal(classification.carrierCreateSuccess, true, 'gonderi OLUSTU')
})

test('SUC-6: TEK karsilastirici — mantik tekrarlanmiyor', () => {
  // İki ayrı karşılaştırıcı zamanla ayrışır ve hangisinin doğru olduğu
  // bilinemez hâle gelir. Bileşik sınıflandırma durum makinesini ÇAĞIRIR.
  const code = codeOf('server/shipments/suratBillingSuccessContract.ts')
  assert.ok(code.includes('evaluateBillingVerification('))
})

/* ═══ BARKOD ≠ DOĞRULAMA ═══════════════════════════════════════════════ */

test('GAP-1: barkod/T.No VARLIGI billing dogrulamasi SAYILMAZ', () => {
  // Taşıyıcı ekseni tamamen başarılı, faturalama ekseni hâlâ doğrulanmamış.
  const result = evaluate(expectation('TRENDYOL'), null, 'SUCCESS')
  assert.equal(result.status, 'UNVERIFIED')
  assert.notEqual(result.status, 'VERIFIED')
  // Durum kümesinde "barkod var → VERIFIED" diye bir geçiş YOK.
  const code = codeOf('server/shipments/suratBillingVerification.ts')
  for (const forbidden of ['barcode', 'trackingNo', 'printEnabled', 'labelStatus']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} ETKI ETMEMELI`)
  }
})

/* ═══ KALICILIK ════════════════════════════════════════════════════════ */

test('PERSIST-1: mevcut sifreli yuke EK blok — migration GEREKMEZ', () => {
  const expected = expectation('TRENDYOL')
  const verification = evaluate(expected, suratActual('1'))
  const record = contract.buildBillingVerificationRecord({ expected, verification })
  assert.equal(record.version, 1)
  assert.equal(record.expectedParty, 'TRENDYOL')
  assert.equal(record.actualParty, 'SELLER')
  assert.equal(record.status, 'MISMATCH')
  assert.equal(record.expectedCapturedAt, AT)
  assert.equal(contract.BILLING_STATE_PERSISTENCE_KEY, 'billingVerification')

  // Blok PII/secret TAŞIMAZ.
  const text = JSON.stringify(record)
  for (const forbidden of [
    'customerName', 'address', 'phone', 'kullaniciAdi', 'sifre',
  ]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
})

test('PERSIST-2: onerilen migration TASARLANDI, UYGULANMADI', () => {
  assert.equal(contract.PROPOSED_BILLING_STATE_MIGRATION.applied, false)
  assert.equal(contract.PROPOSED_BILLING_STATE_MIGRATION.table, 'shipments')
  // Bu tur yeni migration dosyası EKLENMEDİ.
  const files = readdirSync(join(here, '..', 'drizzle')).filter((f) =>
    f.endsWith('.sql'),
  )
  assert.equal(
    files.some((f) => /billing/i.test(f)), false,
    'billing migration dosyasi OLMAMALI',
  )
})

/* ═══ CREATE YOLU KORUNDU ══════════════════════════════════════════════ */

test('REG-1: kanonik create govdesi ve kredensiyal secimi DEGISMEDI', () => {
  const model = codeOf('server/shipments/suratCanonicalGonderiModel.ts')
  // Alan kümesi ve sabitler aynen.
  assert.ok(model.includes('model.OdemeTipi = SURAT_SERVICE_DEFAULTS.OdemeTipi'))
  assert.ok(model.includes('model.Pazaryerimi = context.pazaryerimi'))
  assert.ok(model.includes('model.EntegrasyonFirmasi = context.entegrasyonFirmasi'))
  for (const forbidden of ['WhoPays', 'KimOder']) {
    assert.equal(model.includes(`'${forbidden}'`) && model.includes(`model.${forbidden}`), false)
  }

  // Create yolu doğrulama modülünü IMPORT ETMİYOR — gözlem katmanı ayrık.
  for (const file of [
    'server/shipments/suratCanonicalCreateAdapter.ts',
    'server/shipments/suratCanonicalShipmentService.ts',
    'server/shipments/suratWebApiClient.ts',
    'server/shipments/suratCanonicalGonderiModel.ts',
  ]) {
    const code = codeOf(file)
    assert.equal(code.includes('suratBillingVerification'), false, file)
    assert.equal(code.includes('suratBillingSuccessContract'), false, file)
  }
})

test('REG-2: kredensiyal secici bu turda DEGISMEDI', () => {
  const adapter = codeOf('server/shipments/suratCanonicalCreateAdapter.ts')
  assert.ok(adapter.includes('order.sellerPays === true'))
  assert.ok(adapter.includes("pick(config.canonicalPrimaryKullaniciAdi, config.liveKullaniciAdi)"))
  // Beklenen taraf HÂLÂ bağlı değil — bu tur bilinçli olarak bağlanmadı.
  assert.equal(adapter.includes('expectedBillingParty'), false)
})

/* ═══ DTO YÜZEYİ — GERİYE UYUMLU ═══════════════════════════════════════ */

test('DTO-1: billingVerification OPSIYONEL — mevcut istemci KIRILMAZ', () => {
  const types = readFileSync('src/types/cargoflow.ts', 'utf8')
  const block = types.slice(
    types.indexOf('export interface Shipment'),
    types.indexOf('export interface Shipment') + 6000,
  )
  assert.ok(block.includes('billingVerification?: {'), 'alan OPSIYONEL olmali')
  // Taşıyıcı yaşam döngüsü alanı DEĞİŞMEDİ.
  assert.ok(block.includes("lifecycleStatus?:"))
  assert.ok(block.includes("'LABEL_READY_AWAITING_ACCEPTANCE'"))
  // Durum kümesi doğrulama makinesiyle AYNI.
  for (const state of verify.BILLING_VERIFICATION_STATES) {
    assert.ok(block.includes(`'${state}'`), `${state} DTO da olmali`)
  }
  // Bu tur alan hiçbir yerde DOLDURULMUYOR — yalnız sözleşme duruyor.
  const server = codeOf('server/index.mjs')
  assert.equal(server.includes('billingVerification'), false)
})

/* ═══ UYUŞMAZLIK KANCASI ═══════════════════════════════════════════════ */

test('HOOK-1: yalniz MISMATCH kancayi tetikler, varsayilan NOOP', () => {
  const seen = []
  const mismatch = evaluate(expectation('TRENDYOL'), suratActual('1'))
  const verified = evaluate(expectation('TRENDYOL'), suratActual('3'))

  assert.equal(
    verify.publishBillingMismatch(
      { organizationId: 'org', parcelUniqueId: '727', verification: mismatch },
      (event) => seen.push(event),
    ),
    true,
  )
  assert.equal(seen.length, 1)
  assert.equal(
    verify.publishBillingMismatch(
      { organizationId: 'org', parcelUniqueId: '727', verification: verified },
      (event) => seen.push(event),
    ),
    false,
  )
  assert.equal(seen.length, 1, 'VERIFIED kancayi TETIKLEMEZ')
  // Varsayılan kanca sessizdir (yayın bu turda YOK).
  assert.equal(verify.noopBillingMismatchHook({}), undefined)
})

/* ═══ ÜRETİM BENZERİ TEŞHİS ════════════════════════════════════════════ */

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

const PARCEL = '7270035942963454'

test('PROD-1: gonderi YOKSA faturalama sorusu HENUZ DOGMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('MonalisaToka','monalisatoka-${randomBytes(3).toString('hex')}')
     returning id`)))
  const organizationId = String(rows[0].id)
  const raw = orderEncryption.encryptOrderPayload({
    packageId: 'PKG-PROD-1', orderNumber: '1141000001', lines: [],
  })
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, marketplace_status,
     operation_status, cargo_tracking_number, order_date, raw_payload_encrypted)
    values (${organizationId}, 'Trendyol', 'PKG-PROD-1', '1141000001', 'Created',
      'NEW', ${PARCEL}, '2026-03-01T09:00:00.000Z', ${raw})`)

  const report = await inspect.inspectOrderBilling(
    db, organizationId, PARCEL, { inspectedAt: AT },
  )
  // Beklenti ZATEN biliniyor — sipariş yükünden türüyor, gönderiden değil.
  assert.equal(report.expectedBillingParty, 'TRENDYOL')
  assert.equal(report.actualBillingParty, 'UNKNOWN')
  // Gönderi kaydı yok → taşıyıcı ekseni başlamamış → faturalama sorusu
  // henüz DOĞMAMIŞTIR. Bunu UNVERIFIED saymak, var olmayan bir gönderiyi
  // "doğrulanmayı bekliyor" diye raporlamak olurdu.
  assert.equal(report.carrierCreateStatus, 'NOT_STARTED')
  assert.equal(report.billingVerificationState, 'NOT_APPLICABLE')
  assert.equal(report.billingVerificationReason, 'CARRIER_CREATE_NOT_STARTED')

  const text = inspect.formatBillingReport(report).join('\n')
  assert.ok(text.includes('CARRIER_CREATE_STATUS       NOT_STARTED'))
  assert.ok(text.includes('EXPECTED_BILLING_PARTY      TRENDYOL'))
  assert.ok(text.includes('ACTUAL_BILLING_PARTY        UNKNOWN'))
  assert.ok(text.includes('BILLING_VERIFICATION_STATUS NOT_APPLICABLE'))
  assert.ok(text.includes('BILLING_VERIFICATION_REASON'))
})

test('PROD-2: kayitli gonderi VARSA tasiyici ekseni SUCCESS olur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('MonalisaToka','monalisatoka-${randomBytes(3).toString('hex')}')
     returning id`)))
  const organizationId = String(rows[0].id)
  const raw = orderEncryption.encryptOrderPayload({
    packageId: 'PKG-PROD-2', orderNumber: '1141000002', lines: [],
  })
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, marketplace_status,
     operation_status, cargo_tracking_number, order_date, raw_payload_encrypted)
    values (${organizationId}, 'Trendyol', 'PKG-PROD-2', '1141000002', 'Created',
      'NEW', ${PARCEL}, '2026-03-01T09:00:00.000Z', ${raw})`)
  await db.execute(sql`insert into shipments
    (organization_id, marketplace, package_id, provider, source, status,
     tracking_number)
    values (${organizationId}, 'Trendyol', 'PKG-PROD-2', 'Surat', 'local_create',
      'CREATED', '11419469827')`)

  const report = await inspect.inspectOrderBilling(
    db, organizationId, 'PKG-PROD-2', { inspectedAt: AT },
  )
  // TAŞIYICI başarılı — ama faturalama HÂLÂ doğrulanmadı.
  assert.equal(report.carrierCreateStatus, 'SUCCESS')
  assert.equal(report.billingVerificationState, 'UNVERIFIED')
  assert.equal(report.billingVerificationReason, 'ACTUAL_NOT_READ')
  assert.notEqual(report.billingVerificationState, 'VERIFIED')
})
