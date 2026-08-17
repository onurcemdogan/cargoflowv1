import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// FAZ 3B — PRODUCTION-GÜVENLİ ADAY TARAYICISI.
//
// EN KRİTİK TEST: tarayıcı BUGÜNKÜ üretim şemasıyla çalışmalı. `0008`
// (order_filter_projection) ve `0009` (yeni sync-state kolonları) production'da
// HENÜZ UYGULANMADI; bunlara bağımlılık tarayıcıyı üretimde çalışmaz yapardı.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const scanner = await import('./shipments/suratBillingScanner.ts')
const orderEncryption = await import('./orders/orderEncryption.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []

/**
 * ÜRETİM TABAN ŞEMASI — 0008 ve 0009 ÖNCESİ.
 *
 * Migration dosyaları `0007`ye kadar uygulanır; yeni tablo/kolonlar YOKTUR.
 * Tarayıcı bu şemada çalışabilmelidir.
 */
async function makeProductionBaseDb() {
  const pglite = new PGlite()
  const dir = join(here, '..', 'drizzle')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !f.startsWith('0008') && !f.startsWith('0009'))
  for (const file of files) {
    for (const statement of readFileSync(join(dir, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await pglite.exec(statement)
    }
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

/** PGlite'a giden HER SQL — yazma/sorgu sayımı için. */
function instrument(pglite) {
  const statements = []
  const original = pglite.query.bind(pglite)
  pglite.query = (query, ...rest) => {
    statements.push(String(query))
    return original(query, ...rest)
  }
  return statements
}

async function makeOrg(db, name) {
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('${name}','${name.toLowerCase()}-${randomBytes(3).toString('hex')}')
     returning id, name, slug`)))
  return { id: String(rows[0].id), name: rows[0].name, slug: rows[0].slug }
}

/** PII İÇEREN gerçekçi sipariş — çıktıda görünmemeli. */
async function seedOrder(db, org, options = {}) {
  const raw = orderEncryption.encryptOrderPayload({
    orderNumber: options.orderNumber ?? '1141000001',
    customerFirstName: 'Ömer',
    customerLastName: 'Şahin',
    customerEmail: 'omer.sahin@ornek.com',
    customerPhone: '05551112233',
    shipmentAddress: { address1: 'Gizli Mahalle 5', city: 'İstanbul' },
    ...(options.rawExtra ?? {}),
  })
  await db.execute(sql.raw(
    `insert into orders (organization_id, marketplace, package_id, order_number,
       marketplace_status, operation_status, customer_first_name, customer_last_name,
       customer_email, customer_phone, shipping_city, cargo_tracking_number,
       order_date, raw_payload_encrypted)
     values ('${org.id}','Trendyol','${options.packageId}','${options.orderNumber ?? 'ORD'}',
       'Created','NEW','Ömer','Şahin','omer.sahin@ornek.com','05551112233',
       'İstanbul','${options.cargoTrackingNumber ?? ''}',
       '2026-03-0${options.day ?? 1}T09:00:00.000Z','${raw}')`))
}

/* ═══ TABAN ŞEMA UYUMLULUĞU (EN KRİTİK) ════════════════════════════════ */

test('SCAN-13: 0008/0009 OLMADAN calisir (bugunku uretim semasi)', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())

  // Yeni tablo/kolonlar GERÇEKTEN yok.
  const tables = rowsOf(await db.execute(sql.raw(
    `select table_name from information_schema.tables where table_schema='public'`)))
    .map((r) => String(r.table_name))
  assert.equal(tables.includes('order_filter_projection'), false, '0008 uygulanmamis')
  const syncColumns = rowsOf(await db.execute(sql.raw(
    `select column_name from information_schema.columns
     where table_name='integration_sync_state'`))).map((r) => String(r.column_name))
  assert.equal(syncColumns.includes('sync_watermark_at'), false, '0009 uygulanmamis')

  const org = await makeOrg(db, 'MonalisaToka')
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: '727000001' })

  const result = await scanner.scanTenantBillingCandidates(db, org, { limit: 10 })
  assert.equal(result.ordersScanned, 1)
  assert.equal(result.summary.sampledOrders, 1)
})

/* ═══ TENANT ÇÖZÜMÜ ════════════════════════════════════════════════════ */

test('SCAN-1: isimden tenant cozulur', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  const resolved = await scanner.resolveOrganizationByName(db, 'monalisatoka')
  assert.equal(resolved.status, 'ok')
  assert.equal(resolved.organization.id, org.id)
})

test('SCAN-2: BELIRSIZ isim fail-closed (tahmin YOK)', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  await makeOrg(db, 'Monalisa Toka A')
  await makeOrg(db, 'Monalisa Toka B')
  const resolved = await scanner.resolveOrganizationByName(db, 'Monalisa')
  assert.equal(resolved.status, 'ambiguous')
  assert.equal(resolved.candidates.length, 2)

  const missing = await scanner.resolveOrganizationByName(db, 'YokBoyleTenant')
  assert.equal(missing.status, 'not_found')
})

test('SCAN-3: varsayilan sinir 100, tavan uygulanir', () => {
  assert.equal(scanner.resolveScanLimit(undefined), 100)
  assert.equal(scanner.resolveScanLimit(0), 100)
  assert.equal(scanner.resolveScanLimit(-3), 100)
  assert.equal(scanner.resolveScanLimit(25), 25)
  assert.equal(scanner.resolveScanLimit(99999), scanner.MAX_SCAN_LIMIT)
})

/* ═══ HAM PAYER SAYIMI ═════════════════════════════════════════════════ */

test('SCAN-4/5: HAM sayaclar korunur, SEMANTIK sinif ayri turetilir', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  await seedOrder(db, org, {
    packageId: 'PKG-1', cargoTrackingNumber: '727000001', day: 1,
    rawExtra: { whoPays: 1 },
  })
  await seedOrder(db, org, { packageId: 'PKG-2', cargoTrackingNumber: '727000002', day: 2 })
  await seedOrder(db, org, { packageId: 'PKG-3', cargoTrackingNumber: '727000003', day: 3 })

  const result = await scanner.scanTenantBillingCandidates(db, org, { limit: 50 })

  // (1) HAM GÖZLEM — sözleşme değişse de AYNI kalır (veri ≠ yorum).
  assert.equal(result.summary.rawWhoPays1Count, 1)
  assert.equal(result.summary.rawMissingCount, 2)
  assert.equal(result.summary.rawOtherCount, 0)

  // (2) SEMANTİK SINIFLANDIRMA — sağlayıcı sözleşmesinden TÜRETİLİR.
  assert.equal(result.summary.expectedSellerPaysCount, 1)
  assert.equal(result.summary.expectedTrendyolPaysCount, 2)
  assert.equal(result.summary.expectedUnknownCount, 0)
  assert.equal(result.summary.expectedSourceExplicit1Count, 1)
  assert.equal(result.summary.expectedSourceAbsentCount, 2)
  assert.equal(result.summary.expectedSourceUnsupportedCount, 0)

  assert.equal(result.supplierCandidates.length, 1)
  assert.equal(result.supplierCandidates[0].expectedBillingParty, 'SELLER')

  // GERÇEK taraf hâlâ BİLİNMİYOR: getCargo çağrılmadı, uydurulmadı.
  for (const candidate of result.trendyolPaysCandidates) {
    assert.equal(candidate.expectedBillingParty, 'TRENDYOL')
    assert.equal(candidate.expectedBillingPartySource, 'TRENDYOL_WHO_PAYS_ABSENT')
    // Geçmiş veri sağlayıcı paritesi kanıtlanmadığı için kanıt seviyesi düşük.
    assert.equal(candidate.expectedBillingEvidence, 'UNVERIFIED_HISTORICAL_RAW')
    assert.equal(candidate.actualBillingParty, 'UNKNOWN')
    assert.equal(candidate.actualSuratWhoPays, null, 'gercek whoPays UYDURULMAZ')
  }
  const report = scanner.formatScanReport(result, org.name).join('\n')
  assert.ok(report.includes('RAW OBSERVATION'))
  assert.ok(report.includes('SEMANTIC CLASSIFICATION'))
  assert.ok(report.includes('EXPECTED_TRENDYOL_PAYS  2'))
  assert.ok(report.includes('EVIDENCE_UNVERIFIED_HISTORICAL_RAW'))
  // Beklenen taraf BİLİNİYOR, gerçek taraf hâlâ DOĞRULANMIYOR.
  assert.ok(report.includes('EXPECTED_BILLING_PARTY_AVAILABLE  YES'))
  assert.ok(report.includes('ACTUAL_BILLING_PARTY_AVAILABLE    NO'))
  assert.ok(report.includes('BILLING_SUCCESS_GAP               CONFIRMED'))
  // Kanıtlanmamış bir şey "doğrulandı" olarak BASILMAZ.
  assert.equal(report.includes('TRENDYOL_PAYS_CONFIRMED'), false)
})

/* ═══ HESAP BAĞLAMI + GRUPLAMA ═════════════════════════════════════════ */

test('SCAN-6/7: hesap parmak izi KARARLI ve gruplama calisiyor', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: '727000001' })
  await seedOrder(db, org, { packageId: 'PKG-2', cargoTrackingNumber: '727000002', day: 2 })

  const config = { serviceMode: 'SURAT_CANONICAL_API', liveKullaniciAdi: '1551267127' }
  const first = await scanner.scanTenantBillingCandidates(db, org, { suratConfig: config })
  const second = await scanner.scanTenantBillingCandidates(db, org, { suratConfig: config })

  const fingerprints = new Set(first.supplierCandidates.concat(
    first.trendyolPaysCandidates,
  ).map((c) => c.accountFingerprint))
  assert.equal(fingerprints.size <= 1, true, 'ayni tenant → ayni parmak izi')
  assert.equal(
    first.trendyolPaysCandidates[0].accountFingerprint,
    second.trendyolPaysCandidates[0].accountFingerprint,
    'parmak izi KARARLI',
  )
  // Parmak izi maskelidir; ham kullanıcı adı DEĞİLDİR.
  assert.match(first.trendyolPaysCandidates[0].accountFingerprint, /^\*\*\*\*/)
  assert.equal(
    first.trendyolPaysCandidates[0].accountFingerprint.includes('1551267127'),
    false,
  )
  // Tüm adaylar aynı bağlamda → TEK grup.
  assert.equal(first.summary.groups.length, 1)
})

/* ═══ GOLDEN ═══════════════════════════════════════════════════════════ */

test('SCAN-8: golden 727...9605 otomatik BULUNUR', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  await seedOrder(db, org, {
    packageId: 'PKG-GOLD',
    cargoTrackingNumber: scanner.GOLDEN_TRENDYOL_PAYS_PARCEL,
  })
  await seedOrder(db, org, {
    packageId: 'PKG-SUP', cargoTrackingNumber: '727000009', day: 2,
    rawExtra: { whoPays: 1 },
  })

  const result = await scanner.scanTenantBillingCandidates(db, org, {
    suratConfig: { serviceMode: 'SURAT_CANONICAL_API' },
  })
  assert.equal(result.goldenFound, true)
  assert.equal(
    result.goldenCandidate.parcelIdentity, scanner.GOLDEN_TRENDYOL_PAYS_PARCEL,
  )
  // AYNI hesapta supplier adayı + bilinen Trendyol-pays → çift önerilir.
  assert.notEqual(result.bestSameAccountPair, null)
  assert.equal(
    result.bestSameAccountPair.supplier.expectedBillingParty, 'SELLER',
  )

  const found = await scanner.findGoldenParcel(db, org.id)
  assert.equal(found.found, true)
  assert.match(found.packageIdMasked, /^\*\*\*\*/)
})

/* ═══ GİZLİLİK ═════════════════════════════════════════════════════════ */

test('SCAN-9: stdout raporunda PII/kimlik YOK', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  await seedOrder(db, org, { packageId: 'PKG-PII-0001', cargoTrackingNumber: '727000001' })

  const result = await scanner.scanTenantBillingCandidates(db, org, {
    suratConfig: { serviceMode: 'SURAT_CANONICAL_API', liveKullaniciAdi: 'GIZLI_KULLANICI' },
  })
  const report = scanner.formatScanReport(result, org.name).join('\n')

  for (const secret of [
    'Ömer', 'Şahin', 'omer.sahin@ornek.com', '05551112233',
    'Gizli Mahalle', 'GIZLI_KULLANICI', org.id,
  ]) {
    assert.equal(report.includes(secret), false, `PII/sir sizdi: ${secret}`)
  }
  // Paket kimliği MASKELİ; parcel (operasyonel) açık olabilir.
  assert.equal(report.includes('PKG-PII-0001'), false)
  assert.ok(report.includes('****'))
})

/* ═══ SALT OKUNURLUK + AĞSIZLIK ════════════════════════════════════════ */

test('SCAN-10/12: DB yazma = 0, migration = 0', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: '727000001' })

  const statements = instrument(pglite)
  await scanner.scanTenantBillingCandidates(db, org, { limit: 50 })

  const mutations = statements.filter((s) =>
    /^\s*(insert|update|delete|alter|create|drop|truncate)\b/i.test(s),
  )
  assert.deepEqual(mutations, [], 'tarama HIC yazmamali')
})

test('SCAN-11: tarayici AGA CIKMAZ (yapisal)', () => {
  for (const file of [
    'server/shipments/suratBillingScanner.ts',
    'server/shipments/suratBillingScanCli.ts',
  ]) {
    const code = nl(readFileSync(file, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    for (const forbidden of [
      'fetch(', 'axios', 'https://', 'getSuratCargoByParcelUniqueId',
      'get-cargo', 'callTrendyol', 'migrate(', 'db:migrate',
    ]) {
      assert.equal(code.includes(forbidden), false, `${file}: ${forbidden}`)
    }
    // Mutasyon çağrısı yok.
    for (const forbidden of ['.insert(', '.update(', '.delete(', 'transaction(']) {
      assert.equal(code.includes(forbidden), false, `${file}: ${forbidden}`)
    }
  }
})

/* ═══ KARDİNALİTE ══════════════════════════════════════════════════════ */

test('SCAN-CARD-1: 100 adayda N+1 YOK (sabit sorgu)', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  for (let i = 0; i < 30; i += 1) {
    await seedOrder(db, org, {
      packageId: `PKG-${i}`,
      cargoTrackingNumber: `72700${String(i).padStart(4, '0')}`,
      day: (i % 9) + 1,
    })
  }
  const statements = instrument(pglite)
  const result = await scanner.scanTenantBillingCandidates(db, org, { limit: 100 })
  assert.equal(result.ordersScanned, 30)
  // Siparişler + gönderiler = 2 sorgu. Buna ek olarak tarayıcı artık KENDİ
  // ürettiği adayları çözülebilir mi diye denetliyor; bu denetim yalnız
  // RAPORLANAN örnekler için çalışır (≤5+5), sipariş başına DEĞİL.
  const first = result.dbQueryCount
  assert.ok(first <= 13, `sorgu sayisi: ${first}`)
  const selects = statements.filter((s) => /^\s*select/i.test(s))
  assert.ok(selects.length <= 20, `${selects.length} select — sinirli olmali`)

  // ASIL DEĞİŞMEZ: sipariş sayısı ikiye katlansa da sorgu sayısı ARTMAZ.
  for (let i = 30; i < 60; i += 1) {
    await seedOrder(db, org, {
      packageId: `PKG-${i}`,
      cargoTrackingNumber: `72700${String(i).padStart(4, '0')}`,
      day: (i % 9) + 1,
    })
  }
  const grown = await scanner.scanTenantBillingCandidates(db, org, { limit: 100 })
  assert.equal(grown.ordersScanned, 60)
  assert.equal(grown.dbQueryCount, first, 'sorgu sayisi siparisle BUYUMEMELI')
})

/* ═══ CLI SÖZLEŞMESİ ═══════════════════════════════════════════════════ */

test('SCAN-14: inspect CLI --name destekler, --org GERIYE UYUMLU', () => {
  const source = nl(
    readFileSync('server/shipments/suratBillingInspectCli.ts', 'utf8'),
  )
  assert.ok(source.includes("readArg('name')"), '--name desteklenmeli')
  assert.ok(source.includes("readArg('org')"), '--org korunmali')
  assert.ok(source.includes('resolveOrganizationByName'))
  assert.ok(source.includes('BİRDEN FAZLA eşleşme'), 'belirsizlikte fail-closed')
})

test('SCAN-15: sonraki komutlar GERCEK paket kimligini kullanir', async (t) => {
  const { pglite, db } = await makeProductionBaseDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'MonalisaToka')
  await seedOrder(db, org, {
    packageId: 'PKG-SUP', cargoTrackingNumber: '727000042',
    rawExtra: { whoPays: 1 },
  })
  await seedOrder(db, org, {
    packageId: 'PKG-GOLD', day: 2,
    cargoTrackingNumber: scanner.GOLDEN_TRENDYOL_PAYS_PARCEL,
  })

  const result = await scanner.scanTenantBillingCandidates(db, org, {})
  const report = scanner.formatScanReport(result, org.name).join('\n')
  assert.ok(report.includes('NEXT_SUPPLIER_INSPECT_COMMAND'))
  assert.ok(report.includes('--name MonalisaToka --package 727000042'))
  assert.ok(
    report.includes(`--package ${scanner.GOLDEN_TRENDYOL_PAYS_PARCEL}`),
    'Trendyol adayi golden parcel olmali',
  )
  // Komutta ağ anahtarı YOK.
  assert.equal(report.includes('--get-cargo'), false)
})

test('SCAN-16: scan CLI de --get-cargo anahtari YOK', () => {
  const source = nl(readFileSync('server/shipments/suratBillingScanCli.ts', 'utf8'))
  // YORUMLARI AYIKLA: açıklamada anahtarın ADI geçebilir, KODDA geçemez.
  const code = source
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  assert.equal(code.includes('get-cargo'), false, 'tarama AG YAPMAZ')
  assert.equal(code.includes('hasFlag'), false, 'ag anahtari okuyan yol YOK')
  assert.ok(source.includes('--name veya --org ZORUNLU'))
})
