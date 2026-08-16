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

// B2-1b-B2 · FAZ 4-5 — GERİ DOLDURMA DOĞRULUĞU.
//
// Sınırlı · devam ettirilebilir · idempotent · tenant kapsamlı · bayat yazmaz.

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'drizzle')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const backfill = await import('./orders/orderProjectionBackfill.ts')
const orderRepo = await import('./orders/orderRepository.ts')
const shipmentRepo = await import('./shipments/shipmentRepository.ts')
const operationRepo = await import('./shipments/shipmentOperationRepository.ts')

const nl = (v) => v.split('\r\n').join('\n')
const rowsOf = (r) => (Array.isArray(r) ? r : r.rows) ?? []

/** PGlite'a giden HER SQL — gerçek roundtrip ölçümü. */
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
  const db = drizzle(pglite, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  return { pglite, db, statements: instrument(pglite) }
}

async function makeOrg(db) {
  const result = await db.execute(sql.raw(
    `insert into organizations (name, slug)
     values ('Org','org-${randomBytes(5).toString('hex')}') returning id`))
  return String(rowsOf(result)[0].id)
}

/** Eski (0008 öncesi) veri: sipariş + gönderi + operasyon, projeksiyon YOK. */
async function seedLegacy(db, organizationId, count, prefix = 'PKG') {
  const ids = []
  for (let i = 0; i < count; i += 1) {
    const packageId = `${prefix}-${String(i).padStart(4, '0')}`
    const result = await db.execute(sql.raw(
      `insert into orders (organization_id, marketplace, package_id, order_number,
         external_order_id, marketplace_status, operation_status,
         customer_first_name, customer_last_name, customer_phone,
         shipping_city, shipping_district, cargo_tracking_number, order_date)
       values ('${organizationId}','Trendyol','${packageId}','ORD-${packageId}',
         'EXT-${i}','Created','NEW','Ömer','Şahin','0555000${String(i).padStart(4, '0')}',
         'İstanbul','Kadıköy','7270${String(i).padStart(5, '0')}',
         '2026-01-01T09:00:00.000Z') returning id`))
    ids.push(String(rowsOf(result)[0].id))
    // Gönderi + operasyon: yükleri ŞİFRELİ yazılır (eski kayıt gibi).
    await shipmentRepo.upsertShipment(db, {
      organizationId, marketplace: 'Trendyol', packageId,
      orderNumber: `ORD-${packageId}`, provider: 'surat', source: 'local_create',
      status: 'created', trackingNumber: `TRK-${i}`, senderNumber: 'S1',
      barcode: `BAR-${i}`, trackingLink: null,
      carrierPayload: { ozelKargoTakipNo: `OZEL-${i}`, barkodNo: `BAR-${i}` },
    })
    await operationRepo.upsertCreateOperation(db, {
      organizationId, marketplace: 'Trendyol', packageId, provider: 'surat',
      operationType: 'CREATE', idempotencyKey: `IDEM-${prefix}-${i}`,
      status: 'succeeded', trackingNumber: `OPTRK-${i}`,
      payload: { carrierTrackingNumber: `OPTRK-${i}` },
    })
  }
  // Kurulum sırasında B1 hook'ları çalıştı; ESKİ durumu taklit etmek için
  // projeksiyonu sıfırla — geri doldurmanın işi budur.
  await db.execute(sql.raw(
    `delete from order_filter_projection where organization_id='${organizationId}'`))
  return ids
}

async function projectionRows(db, organizationId) {
  return rowsOf(await db.execute(sql.raw(
    `select * from order_filter_projection where organization_id='${organizationId}'
     order by order_id`)))
}

/* ═══ TEMEL DOĞRULUK ════════════════════════════════════════════════════ */

test('BF-1: 100 siparis -> 100 projeksiyon satiri, kapsama TAM', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 100)

  assert.equal(await backfill.countUncoveredOrders(db, org), 100)
  const summary = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 25,
  })
  assert.equal(summary.scanned, 100)
  assert.equal(summary.written, 100)
  assert.equal(summary.skippedStale, 0)
  assert.equal(summary.done, true)
  assert.equal(summary.nextCursor, null)
  assert.equal(await backfill.countUncoveredOrders(db, org), 0)

  const rows = await projectionRows(db, org)
  assert.equal(rows.length, 100)
  // ÜÇ parça da doldu: order, shipment (şifreli yükten çözülmüş), operation.
  const sample = rows[0]
  assert.match(String(sample.customer_search_token), /omer sahin/)
  assert.match(String(sample.shipping_city_token), /istanbul/)
  assert.ok(String(sample.cargo_slip_order_token).length > 0)
  assert.match(String(sample.order_number_shipment_token), /ozel-/)
  assert.match(String(sample.cargo_slip_shipment_token), /trk-/)
  assert.match(String(sample.cargo_slip_operation_token), /optrk-/)
  assert.equal(Number(sample.projection_version), 1)
})

test('BF-2: IDEMPOTENT — ikinci kosum yeni satir URETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 30)

  await backfill.runProjectionBackfill(db, { organizationId: org, batchSize: 10 })
  const first = await projectionRows(db, org)
  const second = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 10,
  })
  const after = await projectionRows(db, org)

  assert.equal(after.length, first.length, 'satir sayisi DEGISMEMELI')
  assert.equal(second.written, 30, 'tekrar yazim guvenli')
  // Token içerikleri birebir aynı (deterministik üretim).
  for (let i = 0; i < first.length; i += 1) {
    assert.equal(after[i].customer_search_token, first[i].customer_search_token)
    assert.equal(after[i].cargo_slip_shipment_token, first[i].cargo_slip_shipment_token)
  }
})

test('BF-3: DEVAM — yarida kesilen kosum kaldigi yerden tamamlanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 50)

  // İlk koşum SINIRLI: yalnız 2 parti (20 satır).
  const partial = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 10, maxBatches: 2,
  })
  assert.equal(partial.scanned, 20)
  assert.equal(partial.done, false)
  assert.ok(partial.nextCursor, 'imlec DONMELI')
  assert.equal((await projectionRows(db, org)).length, 20)

  // "Süreç yeniden başladı": imleci hatırlamıyoruz, --resume kullanılıyor.
  const resumeFrom = await backfill.resolveResumeCursor(db, org)
  assert.ok(resumeFrom, 'devam noktasi bulunmali')
  const rest = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 10, from: resumeFrom,
  })
  assert.equal(rest.done, true)
  assert.equal((await projectionRows(db, org)).length, 50, 'eksik satir KALMAMALI')
  assert.equal(await backfill.countUncoveredOrders(db, org), 0)

  // Kapsama tamken devam noktası YOK.
  assert.equal(await backfill.resolveResumeCursor(db, org), null)
})

test('BF-4: acik --cursor ile devam (dislayici)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 20)

  const first = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 5, maxBatches: 1,
  })
  assert.equal(first.scanned, 5)
  const second = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 5, cursor: first.nextCursor,
  })
  assert.equal(second.scanned, 15, 'imlecten SONRAKI satirlar')
  assert.equal((await projectionRows(db, org)).length, 20)
})

test('BF-5: --dry-run HICBIR SEY yazmaz', async (t) => {
  const { pglite, db, statements } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 15)

  const mark = statements.length
  const summary = await backfill.runProjectionBackfill(db, {
    organizationId: org, batchSize: 5, dryRun: true,
  })
  assert.equal(summary.dryRun, true)
  assert.equal(summary.scanned, 15)
  assert.equal(summary.written, 0)
  assert.equal((await projectionRows(db, org)).length, 0, 'yazim OLMAMALI')
  const writes = statements
    .slice(mark)
    .filter((s) => /order_filter_projection/i.test(s) && !/^\s*select/i.test(s))
  assert.deepEqual(writes, [], 'projeksiyona yazan ifade OLMAMALI')
})

/* ═══ BAYAT YAZMA KORUMASI ══════════════════════════════════════════════ */

test('BF-6: STALE OVERWRITE — canli yazim EZILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const [orderId] = await seedLegacy(db, org, 1, 'RACE')

  // 1) Geri doldurma anlık görüntüsünü ALIR (A1).
  const snapshotAt = new Date()
  const orderRow = rowsOf(await db.execute(sql.raw(
    `select * from orders where id='${orderId}'`)))[0]
  const a1 = {
    id: orderRow.id,
    marketplace: orderRow.marketplace,
    operationStatus: 'NEW',
    marketplaceStatus: orderRow.marketplace_status,
    shippingCity: orderRow.shipping_city,
    shippingDistrict: orderRow.shipping_district,
    orderDate: orderRow.order_date,
    customerFirstName: 'ESKI',
    customerLastName: 'SNAPSHOT',
    orderNumber: orderRow.order_number,
    cargoTrackingNumber: 'A1-ESKI',
  }

  // 2) Araya CANLI yazım girer (A2) — gerçek üretim yolu.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await db.execute(sql.raw(
    `update orders set customer_first_name='YENI', customer_last_name='CANLI',
       cargo_tracking_number='A2-YENI' where id='${orderId}'`))
  await orderRepo.markOrderLabelReady(db, org, orderId)
  const live = (await projectionRows(db, org))[0]
  assert.match(String(live.customer_search_token), /yeni canli/)

  // 3) Geri doldurma BAYAT anlık görüntüsünü yazmaya çalışır.
  const repository = await import('./orders/orderFilterProjectionRepository.ts')
  const result = await repository.backfillProjectionRows(
    db, org, [{ orderRow: a1 }], snapshotAt,
  )

  // FINAL = A2. Bayat yazım ATLANDI.
  assert.equal(result.written, 0, 'bayat yazim UYGULANMAMALI')
  assert.equal(result.skippedStale, 1)
  const final = (await projectionRows(db, org))[0]
  assert.match(String(final.customer_search_token), /yeni canli/, 'CANLI deger kalmali')
  assert.equal(String(final.customer_search_token).includes('eski'), false)
  assert.match(String(final.cargo_slip_order_token), /a2-yeni/)
})

test('BF-7: yeni anlik goruntu ile yazim TEKRAR calisir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const [orderId] = await seedLegacy(db, org, 1, 'AGAIN')
  await orderRepo.markOrderLabelReady(db, org, orderId)

  // Atlanan satır, koşum tekrarlandığında (yeni anlık görüntü) kapsanır.
  const summary = await backfill.runProjectionBackfill(db, { organizationId: org })
  assert.equal(summary.written, 1)
  assert.equal(summary.skippedStale, 0)
  const row = (await projectionRows(db, org))[0]
  assert.match(String(row.cargo_slip_shipment_token), /trk-0/, 'shipment parcasi DOLMALI')
})

/* ═══ TENANT İZOLASYONU + KAPSAM ════════════════════════════════════════ */

test('BF-8: TENANT izolasyonu — org A kosumu org B ye DOKUNMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  // AYNI paket kimlikleri iki tenant'ta.
  await seedLegacy(db, orgA, 10)
  await seedLegacy(db, orgB, 10)

  const summary = await backfill.runProjectionBackfill(db, { organizationId: orgA })
  assert.equal(summary.written, 10)
  assert.equal((await projectionRows(db, orgA)).length, 10)
  assert.equal((await projectionRows(db, orgB)).length, 0, 'org B ETKILENMEMELI')
  assert.equal(await backfill.countUncoveredOrders(db, orgB), 10)
})

test('BF-9: --org ZORUNLU — kazara tum-tenant kosum YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  await assert.rejects(
    () => backfill.runProjectionBackfill(db, { organizationId: '' }),
    /BACKFILL_ORGANIZATION_REQUIRED/,
  )
  const cli = nl(readFileSync('server/orders/orderProjectionBackfillCli.ts', 'utf8'))
  assert.ok(cli.includes('--org ZORUNLU'), 'CLI de zorunlu kilmali')
})

/* ═══ SINIRLILIK + KARDİNALİTE ══════════════════════════════════════════ */

test('BF-10: KARDINALITE — parti basina SABIT sorgu (N+1 YOK)', async (t) => {
  const { pglite, db, statements } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 40)

  const measure = async (batchSize) => {
    await db.execute(sql.raw(
      `delete from order_filter_projection where organization_id='${org}'`))
    const mark = statements.length
    await backfill.runProjectionBackfill(db, { organizationId: org, batchSize })
    return statements.slice(mark).length
  }

  // 40 satır: 4 parti (10'lu) vs 1 parti (40'lı).
  const wide = await measure(40)
  const narrow = await measure(10)
  // Parti başına sabit sorgu ⇒ 4 kat parti ≈ 4 kat sorgu, ASLA 40 kat değil.
  assert.ok(wide <= 6, `tek parti icin ${wide} sorgu (sabit olmali)`)
  assert.ok(narrow < 40, `${narrow} sorgu — satir basina sorgu VAR`)
  assert.ok(narrow <= wide * 6, 'parti sayisiyla dogru orantili olmali')
})

test('BF-11: SINIRLI — parti boyutu tavanla kisitlanir', () => {
  assert.equal(backfill.resolveBatchSize(undefined), backfill.DEFAULT_BACKFILL_BATCH_SIZE)
  assert.equal(backfill.resolveBatchSize(0), backfill.DEFAULT_BACKFILL_BATCH_SIZE)
  assert.equal(backfill.resolveBatchSize(-5), backfill.DEFAULT_BACKFILL_BATCH_SIZE)
  assert.equal(backfill.resolveBatchSize(50), 50)
  assert.equal(
    backfill.resolveBatchSize(999999),
    backfill.MAX_BACKFILL_BATCH_SIZE,
    'tavan asilmamali',
  )
})

/* ═══ GİZLİLİK ══════════════════════════════════════════════════════════ */

test('BF-12: projeksiyona SIR/ham sifreli veri GIRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 3)
  await backfill.runProjectionBackfill(db, { organizationId: org })

  const encrypted = rowsOf(await db.execute(sql.raw(
    `select carrier_payload_encrypted from shipments where organization_id='${org}'`)))
    .map((r) => String(r.carrier_payload_encrypted))
  const projectionText = JSON.stringify(await projectionRows(db, org))
  for (const blob of encrypted) {
    assert.ok(blob.length > 0, 'yuk gercekten sifreli olmali')
    assert.equal(projectionText.includes(blob), false, 'ham sifreli veri SIZDI')
  }
  for (const secret of ['password', 'sifre', 'apiKey', 'webPassword', 'secret']) {
    assert.equal(projectionText.toLowerCase().includes(secret.toLowerCase()), false)
  }
})

test('BF-13: bozuk/cozulemeyen yuk partiyi DUSURMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedLegacy(db, org, 5)
  // Bir kaydın şifreli yükünü boz.
  await db.execute(sql.raw(
    `update shipments set carrier_payload_encrypted='BOZUK-VERI'
     where organization_id='${org}' and package_id='PKG-0002'`))

  const summary = await backfill.runProjectionBackfill(db, { organizationId: org })
  assert.equal(summary.written, 5, 'tum satirlar yazilmali')
  const rows = await projectionRows(db, org)
  assert.equal(rows.length, 5)
  // Bozuk kayıtta bile İLİŞKİSEL tanımlayıcılar korunur; uydurma YOK.
  const damaged = rowsOf(await db.execute(sql.raw(
    `select p.cargo_slip_shipment_token from order_filter_projection p
       join orders o on o.id = p.order_id
     where o.package_id='PKG-0002'`)))[0]
  assert.match(String(damaged.cargo_slip_shipment_token), /trk-2/)
  assert.equal(String(damaged.cargo_slip_shipment_token).includes('ozel'), false)
})

test('BF-14: normalizasyon YENIDEN YAZILMAMIS (FROZEN uretici)', () => {
  const source = nl(readFileSync('server/orders/orderProjectionBackfill.ts', 'utf8'))
  // Kendi normalizasyonunu KURMAZ; ortak üreticileri çağırır.
  assert.ok(source.includes('shipmentFragmentInput'))
  assert.ok(source.includes('operationFragmentInput'))
  assert.ok(source.includes('backfillProjectionRows'))
  for (const forbidden of ['normalizedToken', 'normalizedSearch', 'toLowerCase()', 'NFD']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} burada OLMAMALI`)
  }
  // Taşıyıcı/pazaryeri çağrısı YOK.
  for (const forbidden of ['fetch(', 'suratWebApiClient', 'trendyol', 'axios']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false)
  }
})
