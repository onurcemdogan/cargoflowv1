import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// TRENDYOL FATURALAMA TARAFI — SAĞLAYICI SÖZLEŞMESİ.
//
// TRENDYOL PROVIDER CONTRACT (bu paketin kilitlediği kural):
//   `whoPays` OWN PROPERTY ve değeri 1  → satıcı anlaşması (SELLER)
//   `whoPays` property HİÇ GÖNDERİLMEMİŞ → Trendyol anlaşması (TRENDYOL)
//   diğer her şey (null / "" / 0 / 2 / 3 / bilinmeyen) → UNKNOWN
//
// SÜRAT getCargo AYRI BİR SÖZLEŞMEDİR: orada 1 → SUPPLIER, 3 → TRENDYOL.
// İki sağlayıcının sayıları AYNI ENUM DEĞİLDİR; TR-7 bunu kilitler.
//
// EN KRİTİK İKİ AYRIM:
//   (1) ABSENT != NULL — biri sözleşme sinyali, diğeri bilinmeyen.
//   (2) "alan yok" != "yük yok" — okunamayan yükten çıkarım YAPILAMAZ.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const billing = await import('./shipments/suratBillingParty.ts')
const scanner = await import('./shipments/suratBillingScanner.ts')
const inspect = await import('./shipments/suratBillingInspectCli.ts')
const orderMapper = await import('./orders/orderMapper.ts')
const orderEncryption = await import('./orders/orderEncryption.ts')

const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []
const nl = (v) => v.split('\r\n').join('\n')

/** Yorum satırlarını ayıklar — açıklama metni KOD SAYILMAZ. */
const codeOf = (file) =>
  nl(readFileSync(file, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

/** Sağlayıcı ham paketi gibi görünen minimum yük (kimlik alanı taşır). */
const providerPackage = (extra = {}) => ({
  packageId: '9001',
  orderNumber: '1141000001',
  lines: [],
  ...extra,
})

/* ═══ SÖZLEŞME MATRİSİ ═════════════════════════════════════════════════ */

test('TR-1: whoPays property YOK → TRENDYOL (ABSENT)', () => {
  const pure = billing.classifyTrendyolWhoPays({})
  assert.equal(pure.rawFieldPresent, false)
  assert.equal(pure.rawValue, null)
  assert.equal(pure.billingParty, 'TRENDYOL')
  assert.equal(pure.source, 'TRENDYOL_WHO_PAYS_ABSENT')
})

test('TR-2: whoPays=1 (number) → SELLER', () => {
  const pure = billing.classifyTrendyolWhoPays(providerPackage({ whoPays: 1 }))
  assert.equal(pure.rawFieldPresent, true)
  assert.equal(pure.rawValue, '1')
  assert.equal(pure.billingParty, 'SELLER')
  assert.equal(pure.source, 'TRENDYOL_WHO_PAYS_EXPLICIT_1')
})

test('TR-3: whoPays="1" (sayisal metin) → SELLER', () => {
  // KARAR GEREKÇESİ: repo genelindeki normalizasyon politikası sayısal metni
  // sayıya EŞ sayar (`String(item.x ?? '')` kalıbı; `normalizeSuratWhoPays`
  // hem 1 hem "1" kabul eder). Sağlayıcı JSON tipini değiştirdiğinde
  // sınıflandırma sessizce kaymasın diye ikisi de kabul edilir.
  assert.equal(
    billing.classifyTrendyolWhoPays({ whoPays: '1' }).billingParty,
    'SELLER',
  )
  assert.equal(
    billing.classifyTrendyolWhoPays({ whoPays: ' 1 ' }).billingParty,
    'SELLER',
    'bosluk normalize edilir',
  )
})

test('TR-4: whoPays=null → UNKNOWN (ABSENT ILE AYNI DEGIL)', () => {
  const pure = billing.classifyTrendyolWhoPays({ whoPays: null })
  assert.equal(pure.rawFieldPresent, true, 'property VAR — yalnizca degeri null')
  assert.equal(pure.billingParty, 'UNKNOWN')
  assert.equal(pure.source, 'TRENDYOL_WHO_PAYS_UNSUPPORTED')
  // EN ÖNEMLİ KARŞITLIK: absent TRENDYOL, null UNKNOWN.
  assert.equal(billing.classifyTrendyolWhoPays({}).billingParty, 'TRENDYOL')
})

test('TR-5: whoPays="" → UNKNOWN', () => {
  const pure = billing.classifyTrendyolWhoPays({ whoPays: '' })
  assert.equal(pure.rawFieldPresent, true)
  assert.equal(pure.billingParty, 'UNKNOWN')
})

test('TR-6: whoPays=0 → UNKNOWN (falsy TUZAGI)', () => {
  // `if (!raw.whoPays)` yazılsaydı 0 ile absent aynı davranırdı.
  const pure = billing.classifyTrendyolWhoPays({ whoPays: 0 })
  assert.equal(pure.rawFieldPresent, true)
  assert.equal(pure.rawValue, '0')
  assert.equal(pure.billingParty, 'UNKNOWN')
})

test('TR-7: Trendyol whoPays=3, SURAT whoPays=3 ILE KARISTIRILMAZ', () => {
  const trendyol = billing.classifyTrendyolWhoPays({ whoPays: 3 })
  assert.equal(trendyol.billingParty, 'UNKNOWN')
  assert.equal(trendyol.source, 'TRENDYOL_WHO_PAYS_UNSUPPORTED')
  // AYNI sayı Sürat sözleşmesinde TRENDYOL demektir — iki ayrı namespace.
  assert.equal(billing.normalizeSuratWhoPays(3), 'TRENDYOL')
  assert.equal(billing.classifyTrendyolWhoPays({ whoPays: 2 }).billingParty, 'UNKNOWN')
})

test('TR-8: prototip uzerindeki whoPays KANIT SAYILMAZ', () => {
  const polluted = Object.create({ whoPays: 1 })
  polluted.packageId = '9001'
  assert.equal(polluted.whoPays, 1, 'fikstur gercekten prototipten okuyor')
  const pure = billing.classifyTrendyolWhoPays(polluted)
  assert.equal(pure.rawFieldPresent, false, 'own property DEGIL')
  assert.equal(pure.billingParty, 'TRENDYOL')
  assert.equal(pure.source, 'TRENDYOL_WHO_PAYS_ABSENT')
})

test('TR-9: GERCEK kaynak yolu order.rawOrder.whoPays — DB satiri kaynak DEGIL', () => {
  // Kanıtlanan zincir: Trendyol paketi → `rawOrder: item` → raw_payload_encrypted.
  // Sipariş satırında `whoPays` diye bir kolon YOKTUR; oradan okumak yanlış
  // olurdu ve gelecekte eklenecek bir kolon sözleşmeyi sessizce ezerdi.
  const fromRaw = billing.inspectTrendyolBillingSource({
    rawOrder: providerPackage({ whoPays: 1 }),
  })
  assert.equal(fromRaw.billingParty, 'SELLER')

  const dbRowShadow = billing.inspectTrendyolBillingSource({
    whoPays: 1,
    rawOrder: providerPackage(),
  })
  assert.equal(dbRowShadow.billingParty, 'TRENDYOL', 'DB satiri OKUNMAMALI')

  // Yanlış derinlikteki bir alan da sözleşme kaynağı DEĞİLDİR.
  const wrongDepth = billing.inspectTrendyolBillingSource({
    rawOrder: providerPackage({ package: { whoPays: 1 } }),
  })
  assert.equal(wrongDepth.billingParty, 'TRENDYOL')

  // `rawPayload` eşanlamlısı da aynı yolu kullanır.
  assert.equal(
    billing.inspectTrendyolBillingSource({
      rawPayload: providerPackage({ whoPays: 1 }),
    }).billingParty,
    'SELLER',
  )
})

/* ═══ SERİLEŞTİRME KORUNUMU ════════════════════════════════════════════ */

test('TR-10: JSON gidis-donusunde ABSENT hala ABSENT', () => {
  const roundTripped = JSON.parse(JSON.stringify(providerPackage()))
  assert.equal(
    Object.prototype.hasOwnProperty.call(roundTripped, 'whoPays'),
    false,
  )
  assert.equal(billing.classifyTrendyolWhoPays(roundTripped).billingParty, 'TRENDYOL')

  // `undefined` DEĞER JSON'da düşer — absent'e dönüşür. Bu bilinen ve
  // sözleşmeyle UYUMLU bir daralmadır: sağlayıcı JSON'unda `undefined` yoktur.
  const undefinedValued = JSON.parse(
    JSON.stringify(providerPackage({ whoPays: undefined })),
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(undefinedValued, 'whoPays'),
    false,
  )
})

test('TR-11: JSON {"whoPays":null} sonrasi PRESENT + null', () => {
  const parsed = JSON.parse('{"packageId":"9001","whoPays":null}')
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'whoPays'), true)
  const pure = billing.classifyTrendyolWhoPays(parsed)
  assert.equal(pure.rawFieldPresent, true)
  assert.equal(pure.billingParty, 'UNKNOWN')
})

/* ═══ INGESTION SINIRI — ALAN VARLIĞI PARİTESİ ═════════════════════════ */

test('TR-ING-1: kalicilastirma ALAN VARLIGINI korur (absent absent kalir)', () => {
  const provider = providerPackage()
  const values = orderMapper.toOrderInsertValues('org-1', {
    packageId: provider.packageId,
    orderNumber: provider.orderNumber,
    rawOrder: provider,
  })
  const persisted = orderEncryption.decryptOrderPayload(values.rawPayloadEncrypted)
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted, 'whoPays'),
    Object.prototype.hasOwnProperty.call(provider, 'whoPays'),
    'PROVIDER_WHO_PAYS_PRESENCE == PERSISTED_RAW_WHO_PAYS_PRESENCE',
  )
  assert.equal(billing.classifyTrendyolWhoPays(persisted).billingParty, 'TRENDYOL')
})

test('TR-ING-2: kalicilastirma DEGERI korur (1 ve null ayri ayri)', () => {
  for (const raw of [1, '1', 0, null, 3]) {
    const provider = providerPackage({ whoPays: raw })
    const values = orderMapper.toOrderInsertValues('org-1', {
      packageId: provider.packageId,
      rawOrder: provider,
    })
    const persisted = orderEncryption.decryptOrderPayload(values.rawPayloadEncrypted)
    assert.equal(
      Object.prototype.hasOwnProperty.call(persisted, 'whoPays'),
      true,
      `PRESENT kalmali: ${String(raw)}`,
    )
    assert.deepEqual(persisted.whoPays, raw, `DEGER kalmali: ${String(raw)}`)
    assert.equal(
      billing.classifyTrendyolWhoPays(persisted).billingParty,
      billing.classifyTrendyolWhoPays(provider).billingParty,
      `sinif kalmali: ${String(raw)}`,
    )
  }
})

test('TR-ING-3: normalizer sagLAYICI paketini FILTRELEMEDEN saklar', () => {
  // Kaynak-türetilmiş değişmez: eğer bir gün alan beyaz listesi eklenirse
  // `whoPays` sessizce düşerdi ve "500 kayitta alan yok" YANLIŞ olurdu.
  const server = codeOf('server/index.mjs')
  const start = server.indexOf('function normalizeTrendyolOrders(data)')
  assert.ok(start > 0, 'normalizeTrendyolOrders bulunmali')
  const body = server.slice(start, server.indexOf('\n}', start))
  assert.ok(body.includes('rawOrder: item'), 'ham paket AYNEN saklanmali')
  assert.equal(body.includes('whoPays'), false, 'alan bazli mudahale OLMAMALI')

  // Kalıcılaştırma da aynı referansı şifreler.
  const mapper = codeOf('server/orders/orderMapper.ts')
  assert.ok(mapper.includes('encryptOrderPayload(order.rawOrder ?? order)'))
})

/* ═══ FAIL-CLOSED ══════════════════════════════════════════════════════ */

test('TR-14: bilinmeyen deger/okunamayan yuk TRENDYOL a DONMEZ (fail-open YOK)', () => {
  for (const value of [3, 2, 0, '', null, 'X', true, [1], {}]) {
    assert.equal(
      billing.classifyTrendyolWhoPays({ whoPays: value }).billingParty,
      'UNKNOWN',
      `fail-open: ${JSON.stringify(value)}`,
    )
  }

  // Yük YOK / OKUNAMADI → alan yokluğu ÇIKARIMI YAPILAMAZ.
  const missing = billing.inspectTrendyolBillingSource({ rawOrder: null })
  assert.equal(missing.rawPayloadAvailability, 'MISSING')
  assert.equal(missing.billingParty, 'UNKNOWN')
  assert.equal(missing.evidence, 'UNKNOWN')

  const unreadable = billing.inspectTrendyolBillingSource(
    { rawOrder: null },
    { rawPayloadAvailability: 'UNREADABLE' },
  )
  assert.equal(unreadable.billingParty, 'UNKNOWN')

  // Saklanan yük NORMALIZE KOPYA ise alan yokluğu KANIT DEĞİLDİR.
  const normalizedCopy = billing.inspectTrendyolBillingSource({
    rawOrder: { marketplace: 'Trendyol', operationStatus: 'NEW', packageId: '1' },
  })
  assert.equal(normalizedCopy.provenance, 'NORMALIZED_COPY')
  assert.equal(normalizedCopy.billingParty, 'UNKNOWN')
  assert.equal(normalizedCopy.evidence, 'UNKNOWN')

  // Ama AÇIK bir `whoPays` kökeni ne olursa olsun DOĞRUDAN kanıttır.
  assert.equal(
    billing.inspectTrendyolBillingSource({
      rawOrder: { marketplace: 'Trendyol', whoPays: 1 },
    }).billingParty,
    'SELLER',
  )
})

test('TR-PROV-1: kaynak kokeni ayirt edilir', () => {
  assert.equal(
    billing.detectRawPayloadProvenance(providerPackage()),
    'PROVIDER_RAW',
  )
  assert.equal(
    billing.detectRawPayloadProvenance({ marketplace: 'Trendyol', packageId: '1' }),
    'NORMALIZED_COPY',
  )
  assert.equal(billing.detectRawPayloadProvenance({}), 'UNKNOWN')
  assert.equal(billing.detectRawPayloadProvenance(null), 'UNKNOWN')
})

test('TR-EVID-1: canli saglayici yanitinda kanit seviyesi YUKSELIR', () => {
  const persisted = billing.inspectTrendyolBillingSource({
    rawOrder: providerPackage(),
  })
  assert.equal(persisted.evidence, 'UNVERIFIED_HISTORICAL_RAW')

  const live = billing.inspectTrendyolBillingSource(
    { rawOrder: providerPackage() },
    { origin: 'LIVE_PROVIDER_RESPONSE' },
  )
  assert.equal(live.evidence, 'CONFIRMED_PROVIDER_CONTRACT')
  assert.equal(live.billingParty, 'TRENDYOL')
})

/* ═══ TARAYICI: HAM ≠ SEMANTİK ═════════════════════════════════════════ */

const candidate = (overrides = {}) => ({
  packageIdMasked: '****0001',
  rawSourceField: null,
  rawValue: null,
  expectedBillingParty: 'TRENDYOL',
  expectedBillingPartySource: 'TRENDYOL_WHO_PAYS_ABSENT',
  expectedBillingEvidence: 'UNVERIFIED_HISTORICAL_RAW',
  expectedRawProvenance: 'PROVIDER_RAW',
  credentialClass: 'PRIMARY',
  accountFingerprint: 'acc-aaaa',
  serviceMode: 'SURAT_CANONICAL_API',
  actualSuratWhoPays: null,
  actualBillingParty: 'UNKNOWN',
  senderCode: null,
  ...overrides,
})

test('TR-12: ham sayaclar DEGISMEDEN semantik sayaclar turer', () => {
  const summary = billing.summarizeBillingScan([
    candidate({
      rawSourceField: 'whoPays', rawValue: '1',
      expectedBillingParty: 'SELLER',
      expectedBillingPartySource: 'TRENDYOL_WHO_PAYS_EXPLICIT_1',
    }),
    candidate({
      rawSourceField: 'whoPays', rawValue: '3',
      expectedBillingParty: 'UNKNOWN',
      expectedBillingPartySource: 'TRENDYOL_WHO_PAYS_UNSUPPORTED',
    }),
    candidate(),
    candidate(),
    candidate({
      expectedBillingParty: 'UNKNOWN',
      expectedBillingPartySource: 'UNKNOWN',
      expectedBillingEvidence: 'UNKNOWN',
      expectedRawProvenance: 'NORMALIZED_COPY',
    }),
  ])

  // HAM katman — eski davranış AYNEN korunur.
  assert.equal(summary.sampledOrders, 5)
  assert.equal(summary.rawWhoPays1Count, 1)
  assert.equal(summary.rawOtherCount, 1)
  assert.equal(summary.rawMissingCount, 3)

  // SEMANTİK katman — ham sayaçlardan BAĞIMSIZ türer.
  assert.equal(summary.expectedSellerPaysCount, 1)
  assert.equal(summary.expectedTrendyolPaysCount, 2)
  assert.equal(summary.expectedUnknownCount, 2)
  assert.equal(summary.expectedSourceExplicit1Count, 1)
  assert.equal(summary.expectedSourceAbsentCount, 2)
  assert.equal(summary.expectedSourceUnsupportedCount, 1)

  // Toplamlar tutarlı: her kayıt TEK sınıfa girer.
  assert.equal(
    summary.expectedSellerPaysCount +
      summary.expectedTrendyolPaysCount +
      summary.expectedUnknownCount,
    summary.sampledOrders,
  )
  assert.equal(summary.evidenceLevels.UNVERIFIED_HISTORICAL_RAW, 4)
  assert.equal(summary.evidenceLevels.UNKNOWN, 1)
  assert.equal(summary.rawProvenances.NORMALIZED_COPY, 1)
})

/* ═══ TEŞHİS ARACI — ÜRETİM BENZERİ ════════════════════════════════════ */

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

async function makeOrg(db) {
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('MonalisaToka','monalisatoka-${randomBytes(3).toString('hex')}')
     returning id, name, slug`)))
  return { id: String(rows[0].id), name: rows[0].name, slug: rows[0].slug }
}

async function seedOrder(db, org, { packageId, parcel, rawExtra, raw }) {
  const payload =
    raw === null
      ? null
      : orderEncryption.encryptOrderPayload({
          packageId,
          orderNumber: '1141000001',
          // PII fikstürü: çıktıda GÖRÜNMEMELİ.
          customerFirstName: 'Ömer',
          customerLastName: 'Şahin',
          shipmentAddress: { address1: 'Gizli Mahalle 5', city: 'İstanbul' },
          lines: [],
          ...(rawExtra ?? {}),
        })
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, marketplace_status,
     operation_status, cargo_tracking_number, order_date, raw_payload_encrypted)
    values (${org.id}, 'Trendyol', ${packageId}, '1141000001', 'Created', 'NEW',
      ${parcel}, '2026-03-01T09:00:00.000Z', ${payload})`)
}

const PARCEL = '7270035942963454'

test('TR-13: uretim benzeri kayitta absent → TRENDYOL, rapor ABSENT basar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-PROD-1', parcel: PARCEL })

  const report = await inspect.inspectOrderBilling(db, org.id, PARCEL)
  assert.ok(report, 'siparis bulunmali')
  assert.equal(report.matchedField, 'cargoTrackingNumber')
  assert.equal(report.rawSourceField, 'whoPays')
  assert.equal(report.rawPayerPresent, false)
  assert.equal(report.rawPayloadAvailability, 'AVAILABLE')
  assert.equal(report.rawDataProvenance, 'PROVIDER_RAW')
  assert.equal(report.expectedBillingParty, 'TRENDYOL')
  assert.equal(report.expectedBillingPartySource, 'TRENDYOL_WHO_PAYS_ABSENT')
  assert.equal(report.expectedBillingEvidence, 'UNVERIFIED_HISTORICAL_RAW')
  // GERÇEK taraf hâlâ doğrulanmadı — getCargo çağrılmadı.
  assert.equal(report.actualBillingParty, 'UNKNOWN')
  assert.equal(report.billingVerificationStatus, 'UNVERIFIED')

  const text = inspect.formatBillingReport(report).join('\n')
  assert.ok(text.includes('RAW_PAYER_PRESENT       NO'))
  assert.ok(text.includes('RAW_PAYER_VALUE         <ABSENT>'))
  assert.ok(text.includes('EXPECTED_BILLING_PARTY  TRENDYOL'))
  assert.ok(text.includes('EXPECTED_SOURCE         TRENDYOL_WHO_PAYS_ABSENT'))
  assert.ok(text.includes('EVIDENCE_LEVEL          UNVERIFIED_HISTORICAL_RAW'))
  // FATURALAMA BAŞARI BOŞLUĞU açıkça isimlendirilir.
  assert.ok(text.includes('EXPECTED_BILLING_PARTY_AVAILABLE  YES'))
  assert.ok(text.includes('ACTUAL_BILLING_PARTY_AVAILABLE    NO'))
  assert.ok(text.includes('BILLING_SUCCESS_GAP               CONFIRMED'))
  assert.ok(text.includes('GETCARGO_ROLE                     POST_CREATE_ACTUAL_VERIFICATION'))
  // PII SIZMAZ.
  for (const secret of ['Ömer', 'Şahin', 'Gizli Mahalle', 'İstanbul']) {
    assert.equal(text.includes(secret), false, `${secret} BASILMAMALI`)
  }
})

test('TR-13b: explicit whoPays=1 uretim yolunda SELLER basar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, {
    packageId: 'PKG-PROD-2', parcel: PARCEL, rawExtra: { whoPays: 1 },
  })

  const report = await inspect.inspectOrderBilling(db, org.id, PARCEL)
  assert.equal(report.rawPayerPresent, true)
  assert.equal(report.rawValue, '1')
  assert.equal(report.expectedBillingParty, 'SELLER')
  assert.equal(report.expectedBillingPartySource, 'TRENDYOL_WHO_PAYS_EXPLICIT_1')
  const text = inspect.formatBillingReport(report).join('\n')
  assert.ok(text.includes('RAW_PAYER_PRESENT       YES'))
  assert.ok(text.includes('RAW_PAYER_VALUE         1'))
})

test('TR-13c: ham yuk YOKSA teshis TRENDYOL DEMEZ (fail-closed)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-PROD-3', parcel: PARCEL, raw: null })

  const report = await inspect.inspectOrderBilling(db, org.id, PARCEL)
  assert.equal(report.rawPayloadAvailability, 'MISSING')
  assert.equal(report.expectedBillingParty, 'UNKNOWN')
  assert.equal(report.expectedBillingEvidence, 'UNKNOWN')
})

/* ═══ ÜRETİM DAVRANIŞI DEĞİŞMEDİ ═══════════════════════════════════════ */

test('TR-SAFE-1: sozlesme kanonik CREATE govdesine SIZMADI', () => {
  const model = codeOf('server/shipments/suratCanonicalGonderiModel.ts')
  const fieldsBlock = model.slice(
    model.indexOf('export const CANONICAL_GONDERI_FIELDS'),
    model.indexOf('] as const', model.indexOf('CANONICAL_GONDERI_FIELDS')),
  )
  for (const forbidden of ['WhoPays', 'KimOder', 'Payer', 'BillingParty']) {
    assert.equal(fieldsBlock.includes(forbidden), false, `${forbidden} SIZDI`)
  }
  // Gözlem modülü kanonik istemci tarafından import EDİLMEZ.
  const client = codeOf('server/shipments/suratWebApiClient.ts')
  assert.equal(client.includes('suratBillingParty'), false)
})

test('TR-SAFE-2: IDEMPOTENCY kimligi DEGISMEDI', () => {
  const server = nl(readFileSync('server/index.mjs', 'utf8'))
  const start = server.indexOf('const fingerprintPayload = {')
  assert.ok(start > 0)
  const block = server.slice(start, server.indexOf('}', start))
  for (const field of [
    'billingParty', 'expectedBillingParty', 'whoPays', 'payer', 'sellerPays',
    'evidence', 'provenance',
  ]) {
    assert.equal(block.includes(field), false, `${field} fingerprinte GIRMEMELI`)
  }
  assert.ok(server.includes('idempotencyKey: `SURAT:${tenantId}:${orderId}:CREATE`'))
})

test('TR-SAFE-3: tarayici/teshis YAZMA yapmaz, ag CAGIRMAZ', () => {
  for (const file of [
    'server/shipments/suratBillingParty.ts',
    'server/shipments/suratBillingScanner.ts',
  ]) {
    const code = codeOf(file)
    for (const forbidden of ['.insert(', '.update(', '.delete(', 'migrate(']) {
      assert.equal(code.includes(forbidden), false, `${file}: ${forbidden}`)
    }
    assert.equal(/\bfetch\(/.test(code), false, `${file}: ag cagrisi`)
  }
  // Sözleşme modülü tamamen SAF: DB/ağ/şifre çözme bağımlılığı YOK.
  const contract = codeOf('server/shipments/suratBillingParty.ts')
  assert.equal(contract.includes('import'), false, 'sozlesme modulu SAF olmali')
})

test('TR-SAFE-4: gevsek varlik kontrolu YASAK', () => {
  // `raw.whoPays ?? …`, `if (!raw.whoPays)`, `raw.whoPays || …` kalıpları
  // absent/null ayrımını yok eder. Sözleşme modülünde bulunmamalı.
  const code = codeOf('server/shipments/suratBillingParty.ts')
  for (const pattern of [
    /whoPays\s*\?\?/,
    /!\s*\w+\.whoPays/,
    /whoPays\s*\|\|/,
  ]) {
    assert.equal(pattern.test(code), false, `gevsek kalip: ${pattern}`)
  }
  assert.ok(code.includes('Object.prototype.hasOwnProperty.call'))
})
