import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { sql } from 'drizzle-orm'

// B2-1b-B2 · FAZ 6-8 — GÖLGE MOTOR + ALTIN PARİTE.
//
// TASARIM: projeksiyon kanonik filtreyi YENİDEN YAZMAZ; yalnız aday kümesini
// SQL'de daraltır. Nihai kararı her zaman `buildVisibleOrders` verir. Bu yüzden
// tek gerçek risk YANLIŞ NEGATİF'tir ve bu paket tam olarak onu kovalar:
// her filtre için ESKİ ve ÖN-ELEMELİ sonuç kimlik dizileri BİREBİR aynı olmalı.

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'drizzle')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const shadow = await import('./orders/orderProjectionShadow.ts')
const query = await import('./orders/orderProjectionQuery.ts')
const backfill = await import('./orders/orderProjectionBackfill.ts')
const legacyEngine = await import('./orders/orderFilterProjection.ts')
const shipmentRepo = await import('./shipments/shipmentRepository.ts')
const operationRepo = await import('./shipments/shipmentOperationRepository.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []

async function makeDb() {
  const pglite = new PGlite()
  const db = drizzle(pglite, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  return { pglite, db }
}

async function makeOrg(db) {
  const result = await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('Org','org-${randomBytes(5).toString('hex')}') returning id`))
  return String(rowsOf(result)[0].id)
}

/** Her filtre için AYIRT EDİCİ fikstür — Türkçe kenar durumları dahil. */
const FIXTURE = [
  { pkg: 'P01', marketplace: 'Trendyol', city: 'İstanbul', district: 'Kadıköy',
    first: 'Ömer', last: 'Şahin', phone: '05550001111', email: 'omer@ornek.com',
    orderNumber: '1141000001', external: 'EXT-1', tracking: '727000001',
    ozel: 'OZEL-AAA', shipTracking: 'TRK-AAA', barcode: 'BAR-AAA', opTracking: '11419469827' },
  { pkg: 'P02', marketplace: 'Trendyol', city: 'ISTANBUL', district: 'Üsküdar',
    first: 'Ayşe', last: 'Yılmaz', phone: '05550002222', email: 'ayse@ornek.com',
    orderNumber: '1141000002', external: 'EXT-2', tracking: '727000002',
    ozel: 'OZEL-BBB', shipTracking: 'TRK-BBB', barcode: 'BAR-BBB', opTracking: '11419469828' },
  { pkg: 'P03', marketplace: 'Hepsiburada', city: 'İSTANBUL', district: 'Kadikoy',
    first: 'Mehmet', last: 'Çelik', phone: '05550003333', email: 'mehmet@ornek.com',
    orderNumber: '1141000003', external: 'EXT-3', tracking: '727000003',
    ozel: 'OZEL-CCC', shipTracking: 'TRK-CCC', barcode: 'BAR-CCC', opTracking: '11419469829' },
  { pkg: 'P04', marketplace: 'Trendyol', city: 'Ankara', district: 'Çankaya',
    first: 'Zeynep', last: 'Öztürk', phone: '05550004444', email: 'zeynep@ornek.com',
    orderNumber: '1141000004', external: 'EXT-4', tracking: '727000004',
    ozel: 'OZEL-DDD', shipTracking: 'TRK-DDD', barcode: 'BAR-DDD', opTracking: '11419469830' },
  { pkg: 'P05', marketplace: 'Trendyol', city: 'İzmir', district: 'Bornova',
    first: 'Ömer', last: 'Kaya', phone: '05550005555', email: 'omerk@ornek.com',
    orderNumber: '1141000005', external: 'EXT-5', tracking: '727000005',
    ozel: 'OZEL-EEE', shipTracking: 'TRK-EEE', barcode: 'BAR-EEE', opTracking: '11419469831' },
]

async function seed(db, organizationId) {
  for (const [index, row] of FIXTURE.entries()) {
    await db.execute(sql.raw(
      `insert into orders (organization_id, marketplace, package_id, order_number,
         external_order_id, marketplace_status, operation_status,
         customer_first_name, customer_last_name, customer_email, customer_phone,
         shipping_city, shipping_district, cargo_tracking_number, order_date)
       values ('${organizationId}','${row.marketplace}','${row.pkg}','${row.orderNumber}',
         '${row.external}','Created','NEW','${row.first}','${row.last}',
         '${row.email}','${row.phone}','${row.city}','${row.district}',
         '${row.tracking}','2026-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z')`))
    await shipmentRepo.upsertShipment(db, {
      organizationId, marketplace: row.marketplace, packageId: row.pkg,
      orderNumber: row.orderNumber, provider: 'surat', source: 'local_create',
      status: 'created', trackingNumber: row.shipTracking, senderNumber: 'S1',
      barcode: row.barcode, trackingLink: null,
      carrierPayload: { ozelKargoTakipNo: row.ozel, barkodNo: row.barcode },
    })
    await operationRepo.upsertCreateOperation(db, {
      organizationId, marketplace: row.marketplace, packageId: row.pkg,
      provider: 'surat', operationType: 'CREATE', idempotencyKey: `IDEM-${row.pkg}`,
      status: 'succeeded', trackingNumber: row.opTracking,
      // GERÇEKÇİ: kanonik görünüm `operation.payload`ı `shipment.carrierPayload`a
      // TERCİH eder; üretimde create sonucu bu alanları taşır.
      payload: {
        carrierTrackingNumber: row.opTracking,
        ozelKargoTakipNo: row.ozel,
        trackingNumber: row.shipTracking,
        barkodNo: row.barcode,
      },
    })
  }
  // Eski kayıt gibi davran: projeksiyonu sıfırla, sonra geri doldur.
  await db.execute(sql.raw(
    `delete from order_filter_projection where organization_id='${organizationId}'`))
  const summary = await backfill.runProjectionBackfill(db, { organizationId })
  assert.equal(summary.written, FIXTURE.length)
}

/* ═══ ALTIN PARİTE MATRİSİ ═════════════════════════════════════════════ */

const SUPPORTED_CASES = [
  ['marketplace: Trendyol', { marketplace: 'Trendyol' }, 4],
  ['marketplace: Hepsiburada', { marketplace: 'Hepsiburada' }, 1],
  ['marketplace: normalize (TRENDYOL)', { marketplace: 'TRENDYOL' }, 4],
  ['city: İstanbul', { city: 'İstanbul' }, 3],
  ['city: ISTANBUL', { city: 'ISTANBUL' }, 3],
  ['city: İSTANBUL', { city: 'İSTANBUL' }, 3],
  ['city: istanbul', { city: 'istanbul' }, 3],
  ['city: Ankara', { city: 'Ankara' }, 1],
  ['district: Kadıköy', { district: 'Kadıköy' }, 1],
  ['district: Kadikoy', { district: 'Kadikoy' }, 1],
  ['district: Çankaya', { district: 'Çankaya' }, 1],
  ['customerQuery: Ömer', { customerQuery: 'Ömer' }, 2],
  ['customerQuery: omer', { customerQuery: 'omer' }, 2],
  ['customerQuery: Şahin', { customerQuery: 'Şahin' }, 1],
  ['customerQuery: telefon', { customerQuery: '05550003333' }, 1],
  ['customerQuery: e-posta', { customerQuery: 'zeynep@ornek.com' }, 1],
  ['orderNumberQuery: kanonik no', { orderNumberQuery: '1141000003' }, 1],
  ['orderNumberQuery: harici no', { orderNumberQuery: 'EXT-4' }, 1],
  ['orderNumberQuery: Trendyol referansi', { orderNumberQuery: '727000002' }, 1],
  ['orderNumberQuery: gonderi ozel takip', { orderNumberQuery: 'OZEL-CCC' }, 1],
  ['cargoSlipQuery: kargo takip', { cargoSlipQuery: '727000005' }, 1],
  // Projeksiyon token'i ILISKISEL T.No'yu da tasir (ust kume); kanonik gorunum
  // ise operasyon yukundeki T.No'yu kullanir. Sonuc: ADAY cikar ama kanonik
  // REDDEDER -> iki tarafta da 0. Bu, yanlis POZITIF sizmadigini kanitlar.
  ['cargoSlipQuery: iliskisel T.No (kanonik REDDEDER)', { cargoSlipQuery: 'TRK-AAA' }, 0],
  ['cargoSlipQuery: barkod', { cargoSlipQuery: 'BAR-BBB' }, 1],
  ['cargoSlipQuery: operasyon T.No', { cargoSlipQuery: '11419469830' }, 1],
  ['bilesik: marketplace + city', { marketplace: 'Trendyol', city: 'İstanbul' }, 2],
  ['bilesik: city + customerQuery', { city: 'İzmir', customerQuery: 'Ömer' }, 1],
  ['eslesme YOK', { customerQuery: 'BULUNMAYAN-DEGER' }, 0],
]

for (const [label, filters, expected] of SUPPORTED_CASES) {
  test(`PAR [${label}]: eski ve on-elemeli sonuc BIREBIR`, async (t) => {
    const { pglite, db } = await makeDb()
    t.after(() => pglite.close())
    const org = await makeOrg(db)
    await seed(db, org)

    const comparison = await shadow.compareProjectionShadow(db, org, filters, null)
    assert.ok(comparison, 'on-eleme uygulanabilir olmali')
    assert.equal(
      comparison.parity, true,
      `PARITE YOK — eksik=${comparison.missingHashed.length} fazla=${comparison.extraHashed.length} sira=${comparison.orderMismatch}`,
    )
    assert.deepEqual(comparison.missingHashed, [], 'YANLIS NEGATIF olmamali')
    assert.deepEqual(comparison.extraHashed, [], 'YANLIS POZITIF olmamali')
    // Fikstür AYIRT EDİCİ olmalı: beklenen sayı gerçekten tutuyor mu?
    assert.equal(comparison.legacyCount, expected, 'fikstur beklentisi')
    assert.equal(comparison.projectionCount, expected)
  })
}

/* ═══ DESTEKLENMEYEN FİLTRELER — HİBRİT ════════════════════════════════ */

const UNSUPPORTED = [
  ['productQuery', { productQuery: 'ayakkabi' }],
  ['multiProduct', { multiProduct: 'multi' }],
  ['sameProduct', { sameProduct: 'same' }],
  ['tab', { tab: 'newOrders' }],
  ['operationTab', { operationTab: 'labelReady' }],
  ['status', { status: 'Created' }],
  ['cargo', { cargo: 'surat' }],
  ['action', { action: 'printLabel' }],
  ['search', { search: 'omer' }],
  ['datePreset', { datePreset: 'today' }],
]

for (const [label, filters] of UNSUPPORTED) {
  test(`HYB [${label}]: on-elemeye ZORLANMAZ, eski motor devralir`, async (t) => {
    const { pglite, db } = await makeDb()
    t.after(() => pglite.close())
    const org = await makeOrg(db)
    await seed(db, org)

    const plan = query.planProjectionPrefilter(filters)
    assert.equal(plan.usable, false, `${label} on-elemeye girmemeli`)
    assert.ok(plan.deferred.length > 0, 'ertelenen filtre raporlanmali')
    assert.equal(
      await query.selectPrefilteredOrderIds(db, org, filters, null), null,
    )
    // PROJECTION modunda bile sonuç ESKİ motordan gelir.
    const served = await shadow.listOrdersWithReadMode(
      db, org, filters, null, null, 'projection',
    )
    assert.equal(served.servedBy, 'legacy')
    assert.equal(served.fallbackReason, 'UNSUPPORTED_FILTER')
  })
}

test('HYB-KARMA: desteklenen + desteklenmeyen filtre BIRLIKTE dogru', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seed(db, org)

  // Ön-eleme yalnız `city` ile daraltır; `status` kanonikte uygulanır.
  const filters = { city: 'İstanbul', status: 'Created' }
  const comparison = await shadow.compareProjectionShadow(db, org, filters, null)
  assert.equal(comparison.parity, true)
  assert.deepEqual(comparison.prefilterApplied, ['city'])
  assert.deepEqual(comparison.prefilterDeferred, ['status'])

  const legacy = await legacyEngine.listFilteredOrdersPage(db, org, filters, null)
  const projection = await shadow.listOrdersWithReadMode(
    db, org, filters, null, null, 'projection',
  )
  assert.equal(projection.servedBy, 'projection')
  assert.equal(projection.total, legacy.total)
  assert.deepEqual(
    projection.orders.map((o) => String(o.id)),
    legacy.orders.map((o) => String(o.id)),
  )
})

/* ═══ SAYFALAMA + SIRALAMA ═════════════════════════════════════════════ */

test('PAG-1: sayfalama ve siralama ESKI ile BIREBIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seed(db, org)

  for (const sort of ['orderDateDesc', 'orderDateAsc']) {
    for (const page of [1, 2, 3]) {
      const filters = { marketplace: 'Trendyol', sort, page, pageSize: 2 }
      const legacy = await legacyEngine.listFilteredOrdersPage(db, org, filters, null)
      const projection = await shadow.listOrdersWithReadMode(
        db, org, filters, null, null, 'projection',
      )
      assert.equal(projection.total, legacy.total, `${sort} p${page} total`)
      assert.deepEqual(
        projection.orders.map((o) => String(o.id)),
        legacy.orders.map((o) => String(o.id)),
        `${sort} p${page} sira/dilim`,
      )
    }
  }
})

/* ═══ DARALTMA GERÇEKTEN OLUYOR MU ═════════════════════════════════════ */

test('NARROW-1: on-eleme aday sayisini GERCEKTEN dusurur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seed(db, org)

  // `orderNumberQuery` gönderi+operasyon yükü gerektirir; daralma buradaki
  // ŞİFRE ÇÖZME sayısında da görünmeli.
  const filters = { orderNumberQuery: 'OZEL-CCC' }
  const legacy = await legacyEngine.loadFilteredProjection(db, org, filters, null)
  const ids = await query.selectPrefilteredOrderIds(db, org, filters, null)
  const narrowed = await legacyEngine.loadFilteredProjection(
    db, org, filters, null, null, query.buildCandidateIdCondition(ids),
  )
  assert.equal(legacy.instrumentation.candidateRowsBeforeCanonical, 5)
  assert.equal(
    narrowed.instrumentation.candidateRowsBeforeCanonical, 1,
    'kanonike giren satir sayisi DUSMELI',
  )
  // Şifre çözme de düşer: 5 yerine 1 gönderi/operasyon yükü.
  assert.ok(
    narrowed.instrumentation.payloadRowsDecrypted <
      legacy.instrumentation.payloadRowsDecrypted,
    'cozulen yuk sayisi DUSMELI',
  )
  assert.deepEqual(narrowed.orderIds, legacy.orderIds)
})

/* ═══ MOD SÖZLEŞMESİ + GERİ ALMA ═══════════════════════════════════════ */

test('MODE-1: varsayilan ve BILINMEYEN mod LEGACY', () => {
  assert.equal(shadow.resolveProjectionReadMode(undefined), 'legacy')
  assert.equal(shadow.resolveProjectionReadMode(''), 'legacy')
  assert.equal(shadow.resolveProjectionReadMode('bilinmeyen'), 'legacy')
  assert.equal(shadow.resolveProjectionReadMode('PROJECTION'), 'projection')
  assert.equal(shadow.resolveProjectionReadMode('shadow'), 'shadow')
})

test('MODE-2: HAZIR OLMAYAN tenant projeksiyona GECEMEZ', () => {
  assert.equal(shadow.resolveEffectiveReadMode('projection', null), 'legacy')
  assert.equal(shadow.resolveEffectiveReadMode('projection', { ready: false }), 'legacy')
  assert.equal(shadow.resolveEffectiveReadMode('projection', { ready: true }), 'projection')
  // Gölge hazırlık gerektirmez: kullanıcıya zaten eski sonuç döner.
  assert.equal(shadow.resolveEffectiveReadMode('shadow', { ready: false }), 'shadow')
})

test('MODE-3: ANINDA GERI ALMA — mod degisimi kod dagitimi GEREKTIRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seed(db, org)
  const filters = { city: 'İstanbul' }

  const projection = await shadow.listOrdersWithReadMode(
    db, org, filters, null, null, 'projection')
  assert.equal(projection.servedBy, 'projection')

  // Tek parametre değişimi ⇒ eski yol. Projeksiyon VERİSİ silinmez.
  const rolledBack = await shadow.listOrdersWithReadMode(
    db, org, filters, null, null, 'legacy')
  assert.equal(rolledBack.servedBy, 'legacy')
  assert.equal(rolledBack.total, projection.total, 'sonuc DEGISMEMELI')
  const remaining = rowsOf(await db.execute(sql.raw(
    `select count(*)::int as n from order_filter_projection
     where organization_id='${org}'`)))[0].n
  assert.equal(Number(remaining), 5, 'projeksiyon verisi KALMALI')
})

test('MODE-4: GOLGE modda kullaniciya ESKI sonuc doner', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seed(db, org)

  const result = await shadow.listOrdersWithReadMode(
    db, org, { city: 'İstanbul' }, null, null, 'shadow')
  assert.equal(result.servedBy, 'legacy')
  assert.ok(result.shadow, 'karsilastirma raporlanmali')
  assert.equal(result.shadow.parity, true)
})

/* ═══ TENANT + TELEMETRİ ═══════════════════════════════════════════════ */

test('TEN-1: on-eleme tenant kapsamini ASLA asmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  await seed(db, orgA)
  await seed(db, orgB)

  const idsA = await query.selectPrefilteredOrderIds(db, orgA, { city: 'İstanbul' }, null)
  const ownedA = rowsOf(await db.execute(sql.raw(
    `select id from orders where organization_id='${orgA}'`))).map((r) => String(r.id))
  for (const id of idsA) {
    assert.ok(ownedA.includes(id), 'baska tenant kimligi SIZDI')
  }
  const comparison = await shadow.compareProjectionShadow(
    db, orgA, { city: 'İstanbul' }, null)
  assert.equal(comparison.parity, true)
  assert.equal(comparison.legacyCount, 3)
})

test('TEL-1: telemetri PII/kimlik SIZDIRMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seed(db, org)

  const comparison = await shadow.compareProjectionShadow(
    db, org, { customerQuery: 'Ömer' }, null)
  const text = JSON.stringify(comparison)
  for (const secret of ['Ömer', 'Şahin', 'omer@ornek.com', '05550001111', org]) {
    assert.equal(text.includes(secret), false, `telemetride sizinti: ${secret}`)
  }
  assert.ok(text.includes(`****${org.slice(-4)}`), 'maskeli organizasyon olmali')
  assert.match(comparison.queryFingerprint, /^[0-9a-f]{12}$/)
})

test('TEL-2: parite ihlali GIZLENMEZ (kimlikler karmali raporlanir)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seed(db, org)

  // Bir satırın projeksiyonunu BOZ: yanlış negatif üretilmeli ve GÖRÜNMELİ.
  await db.execute(sql.raw(
    `update order_filter_projection set customer_search_token='bozuk'
     where order_id = (select id from orders where package_id='P01'
                       and organization_id='${org}')`))

  const comparison = await shadow.compareProjectionShadow(
    db, org, { customerQuery: 'Şahin' }, null)
  assert.equal(comparison.parity, false, 'ihlal GORUNMELI')
  assert.equal(comparison.missingHashed.length, 1)
  assert.match(comparison.missingHashed[0], /^[0-9a-f]{12}$/)
  assert.equal(comparison.legacyCount, 1)
  assert.equal(comparison.projectionCount, 0)
})

/* ═══ YAPISAL ═══════════════════════════════════════════════════════════ */

test('SRC-1: on-eleme kanonik filtreyi YENIDEN YAZMAZ', () => {
  const raw = nl(readFileSync('server/orders/orderProjectionQuery.ts', 'utf8'))
  // YORUMLARI AYIKLA: açıklama metnindeki isimler kod sayılmamalı.
  const source = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ')
  // Karar `buildVisibleOrders`ta kalır; bu modül yalnız aday üretir.
  assert.equal(source.includes('buildVisibleOrders'), false)
  assert.equal(source.includes('classifyOrderForTabs'), false)
  // Normalizasyon ortak kaynaktan gelir; burada yeniden kurulmaz.
  assert.ok(raw.includes("from '../../src/utils/orderClassification.ts'"))
  assert.ok(source.includes('buildSearchLikePattern'))
  // Yalnız GÜNCEL sürüm satırları aday olur (bayat satır yanlis negatif verir).
  assert.ok(source.includes('ORDER_FILTER_PROJECTION_VERSION'))
})

test('SRC-2: golge yolu kullaniciya donen sonucu DEGISTIRMEZ', () => {
  const source = nl(readFileSync('server/orders/orderProjectionShadow.ts', 'utf8'))
  const start = source.indexOf("if (mode !== 'shadow')")
  assert.ok(start > 0)
  const block = source.slice(start)
  // Gölge dalında dönen liste HER ZAMAN `legacy`.
  assert.ok(block.includes("servedBy: 'legacy'"))
  assert.ok(block.includes('shadow = null'), 'golge hatasi kullaniciyi ETKILEMEZ')
})
