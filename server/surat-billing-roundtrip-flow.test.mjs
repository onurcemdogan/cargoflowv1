import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// TARAYICI → TEŞHİS ARACI GİDİŞ-DÖNÜŞ DEĞİŞMEZİ.
//
// ÜRETİMDE KIRILDI: tarayıcı `parcel=7270035969837837` adayını üretip
//   npm run surat:billing:inspect -- --name MonalisaToka --package 7270035969837837
// komutunu KENDİSİ yazdı; aynı veri üzerinde teşhis aracı
// "Sipariş bulunamadı" dedi.
//
// KÖK NEDEN: tarayıcı, `orders.cargo_tracking_number` BOŞSA aday kimliği
// gönderi yükündeki `ozelKargoTakipNo`dan üretiyordu. Bu değer HİÇBİR
// indeksli kolonda yoktur; çözücü onu arayamıyordu.
//
// DEĞİŞMEZ: SCANNER_CANDIDATE_IS_INSPECTABLE.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const scanner = await import('./shipments/suratBillingScanner.ts')
const inspect = await import('./shipments/suratBillingInspectCli.ts')
const verify = await import('./shipments/suratBillingVerification.ts')
const orderEncryption = await import('./orders/orderEncryption.ts')
const shipmentEncryption = await import('./shipments/shipmentEncryption.ts')

const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []

/** Üretimdeki gerçek değer — 16 hane, JS safe-integer sınırına yakın. */
const PROD_PARCEL = '7270035969837837'

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

async function makeOrg(db, name = 'MonalisaToka') {
  const rows = rowsOf(await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('${name}','${name.toLowerCase()}-${randomBytes(3).toString('hex')}')
     returning id, name, slug`)))
  return { id: String(rows[0].id), name: rows[0].name, slug: rows[0].slug }
}

async function seedOrder(db, org, o) {
  const raw = orderEncryption.encryptOrderPayload({
    packageId: o.packageId,
    orderNumber: o.orderNumber ?? 'ORD-1',
    lines: [],
  })
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, external_order_id,
     marketplace_status, operation_status, cargo_tracking_number, order_date,
     raw_payload_encrypted)
    values (${org.id}, 'Trendyol', ${o.packageId}, ${o.orderNumber ?? 'ORD-1'},
      ${o.externalOrderId ?? null}, 'Created', 'NEW',
      ${o.cargoTrackingNumber ?? null}, ${o.orderDate ?? '2026-03-01T09:00:00.000Z'},
      ${raw})`)
}

async function seedShipment(db, org, s) {
  const payload = s.ozelKargoTakipNo
    ? shipmentEncryption.encryptShipmentPayload({
        ozelKargoTakipNo: s.ozelKargoTakipNo,
      })
    : null
  await db.execute(sql`insert into shipments
    (organization_id, marketplace, package_id, provider, source, status,
     tracking_number, sender_number, carrier_payload_encrypted)
    values (${org.id}, 'Trendyol', ${s.packageId}, 'Surat', 'local_create',
      'CREATED', ${s.trackingNumber ?? null}, ${s.senderNumber ?? null},
      ${payload})`)
}

/* ═══ ÜRETİMDE KIRAN VAKA ══════════════════════════════════════════════ */

test('RT-PROD: ozelKargoTakipNo adayi ARTIK cozulebiliyor', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // Üretim şekli: siparişte kargo numarası YOK, kimlik gönderi yükünde.
  await seedOrder(db, org, { packageId: 'PKG-PROD-1', cargoTrackingNumber: null })
  await seedShipment(db, org, {
    packageId: 'PKG-PROD-1',
    trackingNumber: '11419469827',
    ozelKargoTakipNo: PROD_PARCEL,
  })

  const resolution = await scanner.resolveBillingInspectionTarget(
    db, org.id, PROD_PARCEL,
  )
  assert.equal(resolution.status, 'ok', 'uretimde bulunamayan kimlik COZULMELI')
  assert.equal(resolution.matchedField, 'shipmentOzelKargoTakipNo')
  assert.equal(String(resolution.order.packageId), 'PKG-PROD-1')

  // Ve teşhis aracı uçtan uca çalışmalı.
  const report = await inspect.inspectOrderBilling(db, org.id, PROD_PARCEL, {
    inspectedAt: '2026-08-17T09:00:00.000Z',
  })
  assert.ok(report, 'ORDER_FOUND YES olmali')
  assert.equal(report.matchedField, 'shipmentOzelKargoTakipNo')
  // Gönderi bulundu → taşıyıcı ekseni gerçekten SUCCESS.
  assert.equal(report.carrierCreateStatus, 'SUCCESS')
  assert.equal(report.billingVerificationState, 'UNVERIFIED')
})

test('RT-JOIN: gonderi sorgusu COZULEN siparisin paket kimligini kullanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // Kimlik `cargoTrackingNumber` ile çözülür; gönderi ise `packageId` altında.
  await seedOrder(db, org, {
    packageId: 'PKG-JOIN-1', cargoTrackingNumber: PROD_PARCEL,
  })
  await seedShipment(db, org, {
    packageId: 'PKG-JOIN-1', trackingNumber: '11419469827',
  })

  const report = await inspect.inspectOrderBilling(db, org.id, PROD_PARCEL, {
    inspectedAt: '2026-08-17T09:00:00.000Z',
  })
  assert.equal(report.matchedField, 'cargoTrackingNumber')
  // ESKİ KUSUR: gönderi CLI argümanıyla (727…) aranıyordu ve bulunamıyordu.
  assert.equal(report.carrierCreateStatus, 'SUCCESS', 'gonderi BULUNMALI')
  assert.equal(report.shipmentIds.length, 1)
})

/* ═══ ROUND-TRIP MATRİSİ ═══════════════════════════════════════════════ */

const ROUND_TRIP_CASES = [
  { name: 'packageId', seed: { packageId: 'PKG-A' }, identity: 'PKG-A', field: 'packageId' },
  {
    name: 'cargoTrackingNumber',
    seed: { packageId: 'PKG-B', cargoTrackingNumber: '7270035969837838' },
    identity: '7270035969837838', field: 'cargoTrackingNumber',
  },
  {
    name: 'externalOrderId',
    seed: { packageId: 'PKG-C', externalOrderId: 'EXT-C' },
    identity: 'EXT-C', field: 'externalOrderId',
  },
  {
    name: 'orderNumber',
    seed: { packageId: 'PKG-D', orderNumber: 'ORD-D' },
    identity: 'ORD-D', field: 'orderNumber',
  },
]

for (const testCase of ROUND_TRIP_CASES) {
  test(`RT-${testCase.name}: kimlik dogru alanda cozulur`, async (t) => {
    const { pglite, db } = await makeDb()
    t.after(() => pglite.close())
    const org = await makeOrg(db)
    await seedOrder(db, org, testCase.seed)
    const resolution = await scanner.resolveBillingInspectionTarget(
      db, org.id, testCase.identity,
    )
    assert.equal(resolution.status, 'ok')
    assert.equal(resolution.matchedField, testCase.field)
  })
}

test('RT-shipmentTrackingNumber: tasiyici numarasi da cozulur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-E' })
  await seedShipment(db, org, { packageId: 'PKG-E', trackingNumber: '11419469827' })
  const resolution = await scanner.resolveBillingInspectionTarget(
    db, org.id, '11419469827',
  )
  assert.equal(resolution.status, 'ok')
  assert.equal(resolution.matchedField, 'shipmentTrackingNumber')
})

/* ═══ KİMLİK HASSASİYETİ ═══════════════════════════════════════════════ */

test('RT-PRECISION: 16 haneli kimlik METIN olarak korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // Bu iki değer Number() ile AYNI sayıya yuvarlanabilecek kadar yakındır.
  const a = '7270035969837837'
  const b = '7270035969837838'
  await seedOrder(db, org, { packageId: 'PKG-P1', cargoTrackingNumber: a })
  await seedOrder(db, org, {
    packageId: 'PKG-P2', cargoTrackingNumber: b, orderNumber: 'ORD-2',
  })

  const first = await scanner.resolveBillingInspectionTarget(db, org.id, a)
  const second = await scanner.resolveBillingInspectionTarget(db, org.id, b)
  assert.equal(String(first.order.packageId), 'PKG-P1')
  assert.equal(String(second.order.packageId), 'PKG-P2')
  assert.notEqual(String(first.order.packageId), String(second.order.packageId))

  // Kaynak taraması: kimlik hiçbir yerde sayıya ÇEVRİLMEZ.
  const code = readFileSync('server/shipments/suratBillingScanner.ts', 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const pattern of [
    /Number\((?:needle|identifier|parcel)/,
    /parseInt\(/,
    /BigInt\(/,
  ]) {
    assert.equal(pattern.test(code), false, `kimlik donusumu: ${pattern}`)
  }
})

/* ═══ İZOLASYON + BELİRSİZLİK ══════════════════════════════════════════ */

test('RT-ISOLATION: baska tenant AYNI kimligi tasisa bile sizmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const mine = await makeOrg(db, 'MonalisaToka')
  const other = await makeOrg(db, 'BaskaFirma')
  await seedOrder(db, other, {
    packageId: 'PKG-OTHER', cargoTrackingNumber: PROD_PARCEL,
  })

  const resolution = await scanner.resolveBillingInspectionTarget(
    db, mine.id, PROD_PARCEL,
  )
  assert.equal(resolution.status, 'not_found', 'tenant izolasyonu KORUNMALI')
  // Yük tabanlı son çare de tenant kapsamlıdır.
  await seedShipment(db, other, {
    packageId: 'PKG-OTHER', ozelKargoTakipNo: '7270000000000001',
  })
  assert.equal(
    (await scanner.resolveBillingInspectionTarget(db, mine.id, '7270000000000001'))
      .status,
    'not_found',
  )
})

test('RT-AMBIGUOUS: birden fazla eslesme YANLIS satir SECMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-X1', orderNumber: 'DUP' })
  await seedOrder(db, org, { packageId: 'PKG-X2', orderNumber: 'DUP' })
  const resolution = await scanner.resolveBillingInspectionTarget(db, org.id, 'DUP')
  assert.equal(resolution.status, 'ambiguous')
  assert.equal(resolution.matchedField, 'orderNumber')
})

/* ═══ SELF-CHECK + FUNNEL ══════════════════════════════════════════════ */

test('SELF-1: tarayici COZULEMEYEN kimlik icin KOMUT URETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-OK', cargoTrackingNumber: PROD_PARCEL })
  await seedShipment(db, org, { packageId: 'PKG-OK', trackingNumber: '114' })

  const scan = await scanner.scanTenantBillingCandidates(db, org, {
    limit: 50, capturedAt: '2026-08-17T09:00:00.000Z',
  })
  const report = scanner.formatScanReport(scan, org.name).join('\n')
  assert.ok(report.includes('CANDIDATE SELF-CHECK'))
  assert.ok(report.includes('INSPECTABLE YES'))
  const match = report.match(/--package (\S+)/)
  assert.ok(match, 'cozulebilir aday icin komut URETILMELI')
  const fromCommand = await scanner.resolveBillingInspectionTarget(
    db, org.id, match[1],
  )
  assert.equal(fromCommand.status, 'ok', 'URETILEN KOMUT calisabilir olmali')
})

test('FUNNEL-1: join kusuru NOT_APPLICABLE altinda GIZLENMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // (1) gönderi VAR + taşıyıcı numarası VAR → SUCCESS
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: '7270000000000011' })
  await seedShipment(db, org, { packageId: 'PKG-1', trackingNumber: '114' })
  // (2) gönderi VAR + numara YOK → UNKNOWN (create denendi mi bilinmez)
  await seedOrder(db, org, {
    packageId: 'PKG-2', cargoTrackingNumber: '7270000000000012', orderNumber: 'ORD-2',
  })
  await seedShipment(db, org, { packageId: 'PKG-2' })
  // (3) gönderi YOK → NOT_STARTED
  await seedOrder(db, org, {
    packageId: 'PKG-3', cargoTrackingNumber: '7270000000000013', orderNumber: 'ORD-3',
  })

  const scan = await scanner.scanTenantBillingCandidates(db, org, {
    limit: 50, capturedAt: '2026-08-17T09:00:00.000Z',
  })
  assert.equal(scan.resolution.carrierCreateSuccess, 1)
  assert.equal(scan.resolution.carrierCreateUnknown, 1)
  assert.equal(scan.resolution.carrierCreateNotStarted, 1)
  assert.equal(scan.resolution.shipmentJoinResolved, 2)
  assert.equal(scan.resolution.shipmentJoinMissing, 1)
  assert.equal(scan.resolution.orderIdentityResolved, 3)

  // Belirsiz taşıyıcı durumu ERROR'dır — "uygulanamaz" DEĞİL.
  assert.equal(scan.verification.error, 1, 'UNKNOWN durum ERROR sayilmali')
  assert.equal(scan.verification.notApplicable, 1, 'yalniz GERCEK not-started')
  assert.equal(scan.verification.unverified, 1, 'create basarili olan UNVERIFIED')

  const report = scanner.formatScanReport(scan, org.name).join('\n')
  assert.ok(report.includes('IDENTITY / JOIN RESOLUTION'))
  assert.ok(report.includes('CARRIER_CREATE_UNKNOWN       1'))
})

test('FUNNEL-2: ayni pakete IKINCI gonderi SEMANIN kendisi tarafindan engellenir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-DUP', cargoTrackingNumber: '7270000000000021' })
  await seedShipment(db, org, { packageId: 'PKG-DUP', trackingNumber: '114' })

  // ÖLÇÜLEN GERÇEK: `shipments_org_marketplace_package_provider_unique`
  // aynı (org, pazaryeri, paket, sağlayıcı) için ikinci satıra izin VERMEZ.
  // Bu yüzden belirsiz join üretimde OLUŞAMAZ; sayaç yine de savunma amaçlı
  // tutulur ve aşağıda saf fonksiyonla ayrıca kapsanır.
  let rejected = false
  try {
    await seedShipment(db, org, { packageId: 'PKG-DUP', trackingNumber: '115' })
  } catch {
    rejected = true
  }
  assert.equal(rejected, true, 'ikinci gonderi REDDEDILMELI')

  const scan = await scanner.scanTenantBillingCandidates(db, org, {
    limit: 50, capturedAt: '2026-08-17T09:00:00.000Z',
  })
  assert.equal(scan.resolution.shipmentJoinAmbiguous, 0)
  assert.equal(scan.resolution.shipmentJoinResolved, 1)
})

test('FUNNEL-2b: belirsiz join sayaci UNKNOWN olarak siniflanir', () => {
  // Saf katman: şema garantisi bir gün gevşerse davranış tanımlı kalmalı.
  const totals = scanner.summarizeBillingResolution([
    {
      packageIdMasked: '****0001',
      rawSourceField: null,
      rawValue: null,
      expectedBillingParty: 'TRENDYOL',
      credentialClass: 'PRIMARY',
      accountFingerprint: 'acc',
      serviceMode: 'SURAT_CANONICAL_API',
      actualSuratWhoPays: null,
      actualBillingParty: 'UNKNOWN',
      senderCode: null,
      parcelIdentity: '7270000000000021',
      isGoldenParcel: false,
      shipmentJoin: 'AMBIGUOUS',
      carrierCreateStatus: 'UNKNOWN',
    },
  ])
  assert.equal(totals.shipmentJoinAmbiguous, 1)
  assert.equal(totals.carrierCreateUnknown, 1)
})

test('FUNNEL-3: durum makinesi UNKNOWN u ERROR a esler', () => {
  const result = verify.evaluateBillingVerification({
    carrierCreateStatus: 'UNKNOWN',
    expected: verify.buildBillingExpectationSnapshot({
      expectedParty: 'TRENDYOL',
      expectedSource: 'TRENDYOL_WHO_PAYS_ABSENT',
      expectedEvidence: 'UNVERIFIED_HISTORICAL_RAW',
      capturedAt: '2026-08-17T09:00:00.000Z',
    }),
    actual: null,
  })
  assert.equal(result.status, 'ERROR')
  assert.equal(result.reason, 'CARRIER_CREATE_STATUS_UNKNOWN')
  assert.notEqual(result.status, 'NOT_APPLICABLE')
})

/* ═══ İZ + N+1 ═════════════════════════════════════════════════════════ */

test('TRACE-1: lookup trace her kanonik alan icin SAYI verir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-T', cargoTrackingNumber: PROD_PARCEL })

  const trace = await scanner.traceBillingIdentityLookup(db, org.id, PROD_PARCEL)
  const byField = Object.fromEntries(trace.map((e) => [e.field, e.matches]))
  assert.equal(byField.cargoTrackingNumber, 1)
  assert.equal(byField.packageId, 0)
  assert.equal(byField.orderNumber, 0)
  assert.equal(byField.shipmentPackageId, 0)
  // İz SATIR İÇERİĞİ taşımaz — yalnız alan adı ve sayı.
  for (const entry of trace) {
    assert.deepEqual(Object.keys(entry).sort(), ['field', 'matches'])
  }
})

test('NPLUS1: 500 aday icin siparis basina sorgu YAPILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  for (let index = 0; index < 25; index += 1) {
    await seedOrder(db, org, {
      packageId: `PKG-${index}`,
      orderNumber: `ORD-${index}`,
      cargoTrackingNumber: `72700000000${String(index).padStart(5, '0')}`,
      orderDate: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
    })
  }
  const scan = await scanner.scanTenantBillingCandidates(db, org, {
    limit: 500, capturedAt: '2026-08-17T09:00:00.000Z',
  })
  assert.equal(scan.ordersScanned, 25)
  // Taban: siparişler + gönderiler = 2 sorgu. Self-check YALNIZ raporlanan
  // örnekler için ek sorgu yapar (≤10), sipariş başına DEĞİL.
  assert.ok(scan.dbQueryCount <= 12, `sorgu sayisi: ${scan.dbQueryCount}`)
})
