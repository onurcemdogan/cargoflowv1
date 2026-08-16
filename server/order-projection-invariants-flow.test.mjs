import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// B1-C — DAVRANIŞSAL DEĞİŞMEZLER (GERÇEK PRODUCTION HOOK'LARI).
//
// `order-projection-mutation-coverage-flow` sınıflandırmayı KAYNAKTAN kilitler.
// Bu dosya aynı kararların GERÇEK DB üzerinde doğru davrandığını kanıtlar:
// mock yazıcı yok — üretimdeki `upsertMarketplaceOrders`, `markOrderLabelReady`,
// `upsertShipment`, `upsertCreateOperation`, `purgeOrderRecord` çağrılır.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const orderRepo = await import('./orders/orderRepository.ts')
const shipmentRepo = await import('./shipments/shipmentRepository.ts')
const operationRepo = await import('./shipments/shipmentOperationRepository.ts')
const retention = await import('./orders/orderRetention.ts')

const nl = (v) => v.split('\r\n').join('\n')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, f), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

/** PGlite'a giden HER SQL ifadesini kaydeder (gerçek roundtrip ölçümü). */
function instrument(pglite) {
  const statements = []
  const original = pglite.query.bind(pglite)
  pglite.query = (query, ...rest) => {
    statements.push(String(query))
    return original(query, ...rest)
  }
  return statements
}

async function makeDb() {
  const pglite = new PGlite()
  for (const s of migrationStatements()) await pglite.exec(s)
  const statements = instrument(pglite)
  return { pglite, db: drizzle(pglite, { schema }), statements }
}

async function makeOrg(db) {
  const rows = await db.execute(
    sql.raw(`insert into organizations (name, slug)
             values ('Org','org-${randomBytes(5).toString('hex')}') returning id`),
  )
  return String((Array.isArray(rows) ? rows[0] : rows.rows[0]).id)
}

async function makeOrder(db, organizationId, packageId = 'PKG-1') {
  const id = randomUUID()
  await db.execute(sql.raw(
    `insert into orders (id, organization_id, marketplace, package_id, order_number,
       marketplace_status, operation_status, customer_first_name, customer_last_name,
       shipping_city, shipping_district, cargo_tracking_number, order_date)
     values ('${id}','${organizationId}','Trendyol','${packageId}','ORD-${packageId}',
       'Created','NEW','Ömer','Şahin','İstanbul','Kadıköy','727000001',
       '2026-01-01T09:00:00.000Z')`))
  return id
}

async function readProjection(db, organizationId, orderId) {
  const rows = await db.execute(sql.raw(
    `select * from order_filter_projection
     where organization_id='${organizationId}' and order_id='${orderId}'`))
  return ((Array.isArray(rows) ? rows : rows.rows) ?? [])[0] ?? null
}

const projectionStatements = (statements) =>
  statements.filter((s) => /order_filter_projection/i.test(s))

/* ═══ 1. PURGE CASCADE — VARSAYIM DEĞİL, KANIT ══════════════════════════ */

test('INV-1: purgeOrderRecord — projeksiyon FK CASCADE ile duser', async (t) => {
  const { pglite, db, statements } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const orderId = await makeOrder(db, org)

  await orderRepo.markOrderLabelReady(db, org, orderId)
  assert.ok(await readProjection(db, org, orderId), 'projeksiyon satiri olmali')

  // Purge ön koşulu: arşivli ve retention süresi dolmuş.
  await db.execute(sql.raw(
    `update orders set archived_at='2020-01-01T00:00:00.000Z' where id='${orderId}'`))

  const before = statements.length
  const result = await retention.purgeOrderRecord(db, {
    id: orderId, organizationId: org, marketplace: 'Trendyol', packageId: 'PKG-1',
  })

  assert.equal(result.purged, true)
  const orders = await db.execute(sql.raw(`select id from orders where id='${orderId}'`))
  assert.equal(((Array.isArray(orders) ? orders : orders.rows) ?? []).length, 0)
  assert.equal(await readProjection(db, org, orderId), null, 'projeksiyon DUSMELI')

  // AÇIK projeksiyon silme çağrısı YOK — düşüş yalnız FK cascade ile.
  const explicit = projectionStatements(statements.slice(before)).filter((s) =>
    /delete\s+from\s+"?order_filter_projection/i.test(s),
  )
  assert.deepEqual(explicit, [], 'acik projeksiyon DELETE olmamali')
  const source = nl(readFileSync('server/orders/orderRetention.ts', 'utf8'))
  assert.equal(source.includes('orderFilterProjection'), false)
})

/* ═══ 2. ACTUAL-HOOK LOST UPDATE ════════════════════════════════════════ */

/** Gerçek üretim yazıcıları — sıralaması test tarafından değiştirilir. */
function productionWrites(db, org, orderId, generation) {
  const g = generation
  return {
    ORDER: async () => {
      // Kanonik ORDER yaşam döngüsü yazıcısı (pazaryeri senkronu).
      await orderRepo.upsertMarketplaceOrders(db, org, [
        {
          packageId: 'PKG-1',
          orderNumber: 'ORD-PKG-1',
          marketplaceStatus: 'Created',
          operationStatus: 'NEW',
          city: 'İstanbul',
          district: 'Kadıköy',
          cargoTrackingNumber: `ORDER-${g}`,
          orderDate: '2026-01-01T09:00:00.000Z',
        },
      ])
    },
    SHIPMENT: async () => {
      await shipmentRepo.upsertShipment(db, {
        organizationId: org, marketplace: 'Trendyol', packageId: 'PKG-1',
        orderNumber: 'ORD-PKG-1', provider: 'surat', source: 'local_create',
        status: 'created', trackingNumber: `SHIP-${g}`, senderNumber: 'S1',
        barcode: null, trackingLink: null,
        carrierPayload: { ozelKargoTakipNo: `SHIP-${g}` },
      })
    },
    OPERATION: async () => {
      await operationRepo.upsertCreateOperation(db, {
        organizationId: org, marketplace: 'Trendyol', packageId: 'PKG-1',
        provider: 'surat', operationType: 'CREATE', idempotencyKey: 'IDEM-1',
        status: 'succeeded', trackingNumber: `OPER-${g}`,
        payload: { carrierTrackingNumber: `OPER-${g}` },
      })
    },
  }
}

const PERMUTATIONS = [
  ['ORDER', 'SHIPMENT', 'OPERATION'],
  ['OPERATION', 'SHIPMENT', 'ORDER'],
  ['SHIPMENT', 'ORDER', 'OPERATION'],
  ['OPERATION', 'ORDER', 'SHIPMENT'],
]

for (const order of PERMUTATIONS) {
  test(`INV-2 [${order.join('>')}]: uc parca birbirini EZMEZ`, async (t) => {
    const { pglite, db } = await makeDb()
    t.after(() => pglite.close())
    const org = await makeOrg(db)
    const orderId = await makeOrder(db, org)

    // 1. nesil: A1 / B1 / C1
    const first = productionWrites(db, org, orderId, 1)
    for (const key of order) await first[key]()
    const gen1 = await readProjection(db, org, orderId)
    assert.match(String(gen1.cargo_slip_order_token), /order-1/)
    assert.match(String(gen1.cargo_slip_shipment_token), /ship-1/)
    assert.match(String(gen1.cargo_slip_operation_token), /oper-1/)

    // 2. nesil: A2 / B2 / C2 — aynı satırda, iç içe geçmiş sırayla
    const second = productionWrites(db, org, orderId, 2)
    for (const key of order) await second[key]()

    const gen2 = await readProjection(db, org, orderId)
    // HEPSİ 2. nesle taşınmalı: hiçbir yazıcı diğerinin parçasını EZMEDİ.
    assert.match(String(gen2.cargo_slip_order_token), /order-2/, 'ORDER kaybolmus')
    assert.match(String(gen2.cargo_slip_shipment_token), /ship-2/, 'SHIPMENT kaybolmus')
    assert.match(String(gen2.cargo_slip_operation_token), /oper-2/, 'OPERATION kaybolmus')
    // Eski nesil ARTIK YOK (bayat token birikmesi de bir hata olurdu).
    assert.equal(String(gen2.cargo_slip_order_token).includes('order-1'), false)
    assert.equal(String(gen2.cargo_slip_shipment_token).includes('ship-1'), false)
    assert.equal(String(gen2.cargo_slip_operation_token).includes('oper-1'), false)
  })
}

/* ═══ 3. FAILURE SEMANTICS — SESSİZ BAŞARI YOK ══════════════════════════ */

test('INV-3: projeksiyon yazimi COKERSE hata YUTULMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const orderId = await makeOrder(db, org)

  // Projeksiyon tablosunu erişilemez yap: iş yazımı başarılı, projeksiyon çöker.
  await pglite.exec('ALTER TABLE order_filter_projection RENAME TO ofp_hidden')

  await assert.rejects(
    () => orderRepo.markOrderLabelReady(db, org, orderId),
    'ORDER yolu SESSIZCE basarili donmemeli',
  )
  await assert.rejects(
    () =>
      operationRepo.upsertCreateOperation(db, {
        organizationId: org, marketplace: 'Trendyol', packageId: 'PKG-1',
        provider: 'surat', operationType: 'CREATE', idempotencyKey: 'IDEM-X',
        status: 'succeeded', trackingNumber: 'T-1',
        payload: { carrierTrackingNumber: 'T-1' },
      }),
    'OPERATION yolu SESSIZCE basarili donmemeli',
  )

  // İş mutasyonu YİNE DE kalıcı: taşıyıcı sonucu kaybolmaz.
  await pglite.exec('ALTER TABLE ofp_hidden RENAME TO order_filter_projection')
  const rows = await db.execute(sql.raw(
    `select operation_status from orders where id='${orderId}'`))
  const row = ((Array.isArray(rows) ? rows : rows.rows) ?? [])[0]
  assert.notEqual(row.operation_status, 'NEW', 'is yazimi KALICI olmali')
  const ops = await db.execute(sql.raw(
    `select tracking_number from shipment_operations where idempotency_key='IDEM-X'`))
  assert.equal(((Array.isArray(ops) ? ops : ops.rows) ?? []).length, 1)
})

test('INV-3B: projeksiyon bakimi TASIYICI tarafina hic dokunmaz', () => {
  // Projeksiyon hatası bir taşıyıcı/pazaryeri tekrarına DÖNÜŞEMEZ: bu
  // modüllerin taşıyıcı istemcisi yoktur, dolayısıyla retry de yoktur.
  for (const file of [
    'server/orders/orderRepository.ts',
    'server/shipments/shipmentRepository.ts',
    'server/shipments/shipmentOperationRepository.ts',
    'server/orders/orderFilterProjectionRepository.ts',
    'server/orders/orderFilterProjectionBuilder.ts',
  ]) {
    const src = nl(readFileSync(file, 'utf8'))
    for (const forbidden of [
      'suratWebApiClient', 'suratSoap', 'fetch(', 'axios',
      'https://', 'trendyolClient', 'createCanonicalSuratShipment',
    ]) {
      assert.equal(src.includes(forbidden), false, `${file}: ${forbidden} olmamali`)
    }
  }
})

/* ═══ 4. TENANT IZOLASYONU ══════════════════════════════════════════════ */

test('INV-4: her REQUIRED sinifta org A yazimi org B yi ETKILEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  // AYNI paket/sipariş kimliği iki tenant'ta — global lookup varsa patlar.
  const a = await makeOrder(db, orgA, 'PKG-1')
  const b = await makeOrder(db, orgB, 'PKG-1')

  for (const [org, id, tag] of [[orgA, a, 1], [orgB, b, 2]]) {
    const writes = productionWrites(db, org, id, tag)
    await writes.ORDER()
    await writes.SHIPMENT()
    await writes.OPERATION()
  }

  const projA = await readProjection(db, orgA, a)
  const projB = await readProjection(db, orgB, b)
  assert.match(String(projA.cargo_slip_shipment_token), /ship-1/)
  assert.match(String(projB.cargo_slip_shipment_token), /ship-2/)
  assert.match(String(projA.cargo_slip_operation_token), /oper-1/)
  assert.match(String(projB.cargo_slip_operation_token), /oper-2/)
  // Çapraz sızıntı YOK.
  assert.equal(String(projA.cargo_slip_shipment_token).includes('ship-2'), false)
  assert.equal(String(projB.cargo_slip_operation_token).includes('oper-1'), false)
  // Her tenant'ın YALNIZ kendi satırı var.
  const all = await db.execute(sql.raw(
    `select organization_id from order_filter_projection where organization_id='${orgA}'`))
  assert.equal(((Array.isArray(all) ? all : all.rows) ?? []).length, 1)
})

/* ═══ 5. BATCH KARDİNALİTESİ — GERÇEK ROUNDTRIP SAYIMI ══════════════════ */

function normalizedOrder(index) {
  return {
    packageId: `BULK-${index}`,
    orderNumber: `ORD-${index}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'Ada',
    customerLastName: 'Yılmaz',
    city: 'İzmir',
    district: 'Bornova',
    orderDate: '2026-01-02T09:00:00.000Z',
  }
}

test('INV-5: toplu yazim projeksiyon roundtriplerini N ile BUYUTMEZ', async (t) => {
  const { pglite, db, statements } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)

  const measure = async (count, offset) => {
    const batch = Array.from({ length: count }, (_, i) => normalizedOrder(offset + i))
    const before = statements.length
    const result = await orderRepo.upsertMarketplaceOrders(db, org, batch)
    assert.equal(result.persisted, count, 'tum siparisler yazilmali')
    return projectionStatements(statements.slice(before)).length
  }

  const small = await measure(2, 0)
  const large = await measure(10, 100)

  // Beklenen: sipariş sayısından BAĞIMSIZ, sabit sayıda projeksiyon ifadesi.
  assert.ok(small > 0, 'projeksiyon bakimi CALISMALI')
  assert.equal(large, small, `2 -> ${small}, 10 -> ${large} (N ile buyuyor)`)
  // Satır başına bir roundtrip olsaydı 10 sipariş >= 10 ifade üretirdi.
  assert.ok(large < 10, `sinirli olmali, ${large} ifade`)

  // Tüm satırlar gerçekten projeksiyona düştü (az sorgu ≠ eksik iş).
  const rows = await db.execute(sql.raw(
    `select count(*)::int as n from order_filter_projection where organization_id='${org}'`))
  const n = ((Array.isArray(rows) ? rows : rows.rows) ?? [])[0].n
  assert.equal(Number(n), 12)
})

/* ═══ 6. NOT_REQUIRED SINIFLARININ DAVRANIŞSAL KARŞILIĞI ════════════════ */

test('INV-6: ACTIVITY_ONLY — projeksiyon BIREBIR ayni kalir', async (t) => {
  const { pglite, db, statements } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const orderId = await makeOrder(db, org)
  await orderRepo.markOrderLabelReady(db, org, orderId)

  const before = await readProjection(db, org, orderId)
  const mark = statements.length
  await orderRepo.touchOrderOperationalActivity(db, org, orderId)
  await retention.applyActivityBaseline(db, retention.resolveRetentionPolicy({}))
  const after = await readProjection(db, org, orderId)

  assert.deepEqual(after, before, 'projeksiyon DEGISMEMELI')
  // Açık projeksiyon yenileme çağrısı = 0.
  const touched = projectionStatements(statements.slice(mark)).filter(
    (s) => !/^\s*select/i.test(s),
  )
  assert.deepEqual(touched, [], 'projeksiyon yazimi olmamali')
})

test('INV-7: RESERVATION_ONLY — rezervasyon aranabilir parca URETMEZ', async (t) => {
  const { pglite, db, statements } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const orderId = await makeOrder(db, org)

  const mark = statements.length
  const reservation = await operationRepo.reserveCreateOperation(db, {
    organizationId: org, marketplace: 'Trendyol', packageId: 'PKG-1',
    provider: 'surat', operationType: 'CREATE', idempotencyKey: 'IDEM-R',
    status: 'pending', payload: { status: 'IN_PROGRESS' },
  })
  assert.equal(reservation.won, true)
  assert.equal(await readProjection(db, org, orderId), null, 'rezervasyon YAZMAMALI')

  // Taşıyıcıya ulaşılmadı → rezervasyon geri alınır; yine projeksiyon yok.
  await operationRepo.deleteCreateOperation(db, org, 'IDEM-R')
  assert.equal(await readProjection(db, org, orderId), null)
  const writes = projectionStatements(statements.slice(mark)).filter(
    (s) => !/^\s*select/i.test(s),
  )
  assert.deepEqual(writes, [], 'rezervasyon/geri alma projeksiyona YAZMAMALI')

  // Buna karşılık create SONUCU (upsert) parçayı GERÇEKTEN yazar.
  await operationRepo.upsertCreateOperation(db, {
    organizationId: org, marketplace: 'Trendyol', packageId: 'PKG-1',
    provider: 'surat', operationType: 'CREATE', idempotencyKey: 'IDEM-R',
    status: 'succeeded', trackingNumber: '11419469827',
    payload: { carrierTrackingNumber: '11419469827' },
  })
  const projection = await readProjection(db, org, orderId)
  assert.match(String(projection.cargo_slip_operation_token), /11419469827/)
})

test('INV-8: ARTIFACT_ONLY — artifact yazimi projeksiyonu DEGISTIRMEZ', async (t) => {
  const { pglite, db, statements } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const orderId = await makeOrder(db, org)
  const writes = productionWrites(db, org, orderId, 1)
  await writes.ORDER()
  await writes.SHIPMENT()

  const before = await readProjection(db, org, orderId)
  const mark = statements.length
  // Artifact yolu: yalnız carrier_payload_encrypted güncellenir.
  await db.execute(sql.raw(
    `update shipments set carrier_payload_encrypted='ARTIFACT-ONLY'
     where organization_id='${org}' and package_id='PKG-1'`))
  const after = await readProjection(db, org, orderId)

  assert.deepEqual(after, before, 'artifact yazimi projeksiyonu DEGISTIRMEMELI')
  // (Okuma sorguları hariç) projeksiyona hiçbir yazma gitmemeli.
  const projectionWrites = projectionStatements(statements.slice(mark)).filter(
    (s) => !/^\s*select/i.test(s),
  )
  assert.deepEqual(projectionWrites, [])
})

/* ═══ 7. SIFIR YAN ETKİ ═════════════════════════════════════════════════ */

test('INV-9: projeksiyon bakimi DECRYPT/AG yapmaz (yapisal)', () => {
  for (const [file, fn] of [
    ['server/shipments/shipmentRepository.ts', 'upsertShipment'],
    ['server/shipments/shipmentOperationRepository.ts', 'upsertCreateOperation'],
    ['server/shipments/importLegacyShipments.ts', 'importOne'],
  ]) {
    const src = nl(readFileSync(file, 'utf8'))
    const start = src.indexOf('PROJEKSİYON BAKIMI')
    assert.ok(start > 0, `${file}#${fn}: projeksiyon bakim blogu bulunamadi`)
    const block = src.slice(start)
    // Bakım bloğunda YENİDEN çözme YOK: değerler zaten bellekte.
    assert.equal(block.includes('decryptShipmentPayload'), false, `${file}: decrypt`)
    assert.equal(block.includes('decryptOrderPayload'), false, `${file}: decrypt`)
  }
  // Yazıcı ve üretici modülleri de saf.
  const builder = nl(
    readFileSync('server/orders/orderFilterProjectionBuilder.ts', 'utf8'),
  )
  for (const forbidden of ['decrypt', 'process.env', 'require(']) {
    const body = builder.slice(builder.indexOf('export const'))
    assert.equal(body.includes(forbidden), false, `builder: ${forbidden}`)
  }
})
