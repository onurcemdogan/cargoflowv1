import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// GÖNDERİ-ÖNCELİKLİ FATURALAMA KANITI KEŞFİ.
//
// NEDEN: son 500 sipariş taraması `ORDER_SHIPMENT_JOIN_MISSING=500` verdi —
// en yeni siparişler henüz kargoya verilmemiş. O evren `whoPays`
// doğrulaması için UYGUN DEĞİL. Doğru evren, taşıyıcı kaydı GERÇEKTEN
// oluşmuş gönderilerdir.
//
// EN KRİTİK KURAL: `tracking_number` TEK BAŞINA "create başarılı" DEMEZ.
// Ön-atanmış kodlar da o alana yazılabilir. Güçlü kanıt
// `shipment_operations(CREATE, succeeded, carrier_create_called)`tır.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const discovery = await import('./shipments/suratShipmentBillingDiscovery.ts')
const orderEncryption = await import('./orders/orderEncryption.ts')
const shipmentEncryption = await import('./shipments/shipmentEncryption.ts')

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
     returning id, name`)))
  return { id: String(rows[0].id), name: rows[0].name }
}

async function seedOrder(db, org, o) {
  const raw = orderEncryption.encryptOrderPayload({
    packageId: o.packageId,
    orderNumber: o.orderNumber ?? 'ORD-1',
    lines: [],
    ...(o.rawExtra ?? {}),
  })
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, marketplace_status,
     operation_status, cargo_tracking_number, order_date, raw_payload_encrypted)
    values (${org.id}, 'Trendyol', ${o.packageId}, ${o.orderNumber ?? 'ORD-1'},
      'Created', 'NEW', ${o.cargoTrackingNumber ?? null},
      '2026-03-01T09:00:00.000Z', ${raw})`)
}

async function seedShipment(db, org, s) {
  const payload = shipmentEncryption.encryptShipmentPayload({
    ozelKargoTakipNo: s.ozelKargoTakipNo ?? null,
    serviceMode: s.serviceMode ?? 'SURAT_CANONICAL_API',
    ...(s.payloadExtra ?? {}),
  })
  await db.execute(sql`insert into shipments
    (organization_id, marketplace, package_id, provider, source, status,
     tracking_number, sender_number, carrier_payload_encrypted, created_at)
    values (${org.id}, 'Trendyol', ${s.packageId}, ${s.provider ?? 'Surat'},
      'local_create', 'CREATED', ${s.trackingNumber ?? null},
      ${s.senderNumber ?? null}, ${payload},
      ${s.createdAt ?? '2026-07-17T10:00:00.000Z'})`)
}

async function seedOperation(db, org, o) {
  await db.execute(sql`insert into shipment_operations
    (organization_id, marketplace, package_id, provider, operation_type,
     idempotency_key, status, carrier_create_called, create_call_count,
     tracking_number)
    values (${org.id}, 'Trendyol', ${o.packageId}, 'Surat', 'CREATE',
      ${`SURAT:${org.id}:${o.packageId}:CREATE`}, ${o.status},
      ${o.carrierCreateCalled ?? false}, 1, ${o.trackingNumber ?? null})`)
}

/* ═══ KANIT GÜCÜ ═══════════════════════════════════════════════════════ */

test('EV-1: tracking_number TEK BASINA create basarisi SAYILMAZ', () => {
  // Ön-atanmış kod da bu alana yazılabilir; kanıt gücü yetmez.
  assert.equal(
    discovery.classifyCarrierCreate({ trackingNumber: '11419469827' }),
    'UNKNOWN',
  )
  assert.equal(discovery.classifyCarrierCreate({ trackingNumber: '' }), 'NOT_STARTED')
})

test('EV-2: succeeded + carrierCreateCalled → SUCCESS', () => {
  assert.equal(
    discovery.classifyCarrierCreate({
      operationStatus: 'succeeded', carrierCreateCalled: true,
    }),
    'SUCCESS',
  )
  // Taşıyıcıya gidilmediyse "başarılı" kaydı da kanıt DEĞİLDİR.
  assert.equal(
    discovery.classifyCarrierCreate({
      operationStatus: 'succeeded', carrierCreateCalled: false,
    }),
    'UNKNOWN',
  )
  assert.equal(
    discovery.classifyCarrierCreate({ operationStatus: 'failed' }), 'FAILED',
  )
  assert.equal(
    discovery.classifyCarrierCreate({ operationStatus: 'blocked' }), 'FAILED',
  )
  assert.equal(
    discovery.classifyCarrierCreate({ operationStatus: 'pending' }), 'UNKNOWN',
  )
})

test('EV-3: gercek whoPays ALAN ADINDAN TAHMIN EDILMEZ', () => {
  assert.deepEqual(
    discovery.findPersistedActualWhoPays({ whoPays: '3' }),
    { key: 'whoPays', value: '3' },
  )
  assert.deepEqual(
    discovery.findPersistedActualWhoPays({ KimOder: 1 }),
    { key: 'KimOder', value: '1' },
  )
  // `payer` bilinen TAM anahtarlardandır (Faz 4C'de eklendi).
  assert.deepEqual(
    discovery.findPersistedActualWhoPays({ payer: 'TRENDYOL' }),
    { key: 'payer', value: 'TRENDYOL' },
  )
  // Benzer/tahmini isimler KABUL EDİLMEZ.
  for (const payload of [
    { whoPaysCode: '3' }, { who_pays: '3' }, { payerName: 'X' }, {},
  ]) {
    assert.equal(discovery.findPersistedActualWhoPays(payload), null)
  }
  // `billingParty` CargoFlow KÖKENLİDİR — taşıyıcı cevabı SAYILMAZ.
  assert.equal(
    discovery.findPersistedActualWhoPays({ billingParty: 'PRIMARY' }), null,
  )
  assert.ok(discovery.CARGOFLOW_ORIGIN_PAYER_KEYS.includes('billingParty'))
  // Boş değer kanıt değildir.
  assert.equal(discovery.findPersistedActualWhoPays({ whoPays: '' }), null)
  assert.equal(discovery.findPersistedActualWhoPays(null), null)
})

/* ═══ KEŞİF ════════════════════════════════════════════════════════════ */

test('DISC-1: gonderi-oncelikli evren gercek create kayitlarini bulur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)

  // (1) GERÇEK create — güçlü kanıt.
  await seedOrder(db, org, { packageId: 'PKG-1', cargoTrackingNumber: '7270000000000001' })
  await seedShipment(db, org, {
    packageId: 'PKG-1', trackingNumber: '11419469827',
    ozelKargoTakipNo: '7270000000000001', createdAt: '2026-07-17T10:00:00.000Z',
  })
  await seedOperation(db, org, {
    packageId: 'PKG-1', status: 'succeeded', carrierCreateCalled: true,
  })

  // (2) Numara var ama operasyon kaydı YOK → UNKNOWN (uydurma YOK).
  await seedOrder(db, org, {
    packageId: 'PKG-2', orderNumber: 'ORD-2', cargoTrackingNumber: '7270000000000002',
  })
  await seedShipment(db, org, { packageId: 'PKG-2', trackingNumber: '114' })

  // (3) Başarısız create.
  await seedOrder(db, org, { packageId: 'PKG-3', orderNumber: 'ORD-3' })
  await seedShipment(db, org, { packageId: 'PKG-3' })
  await seedOperation(db, org, { packageId: 'PKG-3', status: 'failed' })

  // (4) Sürat OLMAYAN sağlayıcı — evrene GİRMEZ.
  await seedOrder(db, org, { packageId: 'PKG-4', orderNumber: 'ORD-4' })
  await seedShipment(db, org, { packageId: 'PKG-4', provider: 'Yurtici' })

  const result = await discovery.discoverSuratShipmentBillingEvidence(db, org, {
    limit: 500,
  })
  assert.equal(result.shipmentsScanned, 4)
  assert.equal(result.suratShipments, 3, 'yalniz Surat gonderileri')
  assert.equal(result.suratCreateSuccess, 1)
  assert.equal(result.suratCreateUnknown, 1)
  assert.equal(result.suratCreateFailed, 1)

  // Ters join YALNIZ başarılı create'ler için sayılır.
  assert.equal(result.orderJoinResolved, 1)
  assert.equal(result.orderJoinMissing, 0)

  // Beklenen taraf mevcut Trendyol mapper'ından gelir; yeni kural YOK.
  assert.equal(result.expectedTrendyol, 1)
  assert.equal(result.expectedSeller, 0)
  assert.equal(result.expectedSources.TRENDYOL_WHO_PAYS_ABSENT, 1)

  // Gerçek taraf yok → VERIFIED/MISMATCH URETILMEZ.
  assert.equal(result.actualUnavailable, 1)
  assert.equal(result.actualAvailable, 0)
  assert.equal(result.verifiedCount, 0)
  assert.equal(result.mismatchCount, 0)
  assert.equal(result.unverifiedCount, 1)

  assert.equal(result.oldestSuccessAt, '2026-07-17T10:00:00.000Z')
  assert.equal(result.newestSuccessAt, '2026-07-17T10:00:00.000Z')
})

test('DISC-2: siparise baglanmayan basarili gonderi MISSING sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedShipment(db, org, { packageId: 'PKG-ORPHAN', trackingNumber: '114' })
  await seedOperation(db, org, {
    packageId: 'PKG-ORPHAN', status: 'succeeded', carrierCreateCalled: true,
  })

  const result = await discovery.discoverSuratShipmentBillingEvidence(db, org)
  assert.equal(result.suratCreateSuccess, 1)
  assert.equal(result.orderJoinMissing, 1)
  assert.equal(result.orderJoinResolved, 0)
  // Sipariş yoksa beklenen taraf UYDURULMAZ.
  assert.equal(result.expectedUnknown, 1)
  assert.equal(result.expectedTrendyol, 0)
})

test('DISC-3: expected SELLER gercek whoPays=1 yukunden turer', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, {
    packageId: 'PKG-S', cargoTrackingNumber: '7270000000000009',
    rawExtra: { whoPays: 1 },
  })
  await seedShipment(db, org, {
    packageId: 'PKG-S', trackingNumber: '114', ozelKargoTakipNo: '7270000000000009',
  })
  await seedOperation(db, org, {
    packageId: 'PKG-S', status: 'succeeded', carrierCreateCalled: true,
  })

  const result = await discovery.discoverSuratShipmentBillingEvidence(db, org)
  assert.equal(result.expectedSeller, 1)
  assert.equal(result.expectedTrendyol, 0)
  assert.equal(result.expectedSources.TRENDYOL_WHO_PAYS_EXPLICIT_1, 1)
})

test('DISC-4: kalici yukte gercek whoPays VARSA tespit edilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, { packageId: 'PKG-A', cargoTrackingNumber: '7270000000000010' })
  await seedShipment(db, org, {
    packageId: 'PKG-A', trackingNumber: '114',
    ozelKargoTakipNo: '7270000000000010',
    payloadExtra: { whoPays: '3' },
  })
  await seedOperation(db, org, {
    packageId: 'PKG-A', status: 'succeeded', carrierCreateCalled: true,
  })

  const result = await discovery.discoverSuratShipmentBillingEvidence(db, org)
  assert.equal(result.actualAvailable, 1)
  assert.equal(
    result.candidates[0].actualSource, 'persistedCarrierPayload.whoPays',
  )
  // Kaynak provenance ile raporlanır; getCargo çağrısı YAPILMAZ.
})

test('DISC-5: golden parcel bulunursa isaretlenir, yoksa FOUND=NO', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, {
    packageId: 'PKG-G', cargoTrackingNumber: discovery.GOLDEN_PARCEL,
  })
  await seedShipment(db, org, {
    packageId: 'PKG-G', trackingNumber: '114',
    ozelKargoTakipNo: discovery.GOLDEN_PARCEL,
  })
  await seedOperation(db, org, {
    packageId: 'PKG-G', status: 'succeeded', carrierCreateCalled: true,
  })

  const result = await discovery.discoverSuratShipmentBillingEvidence(db, org)
  assert.equal(result.goldenFound, true)
  assert.equal(result.goldenCandidate.parcelIdentity, discovery.GOLDEN_PARCEL)
  // Maildeki gerçek whoPays DB'ye YAZILMADI; hâlâ okunamıyor.
  assert.equal(result.goldenCandidate.actualAvailable, false)

  const report = discovery.formatShipmentDiscoveryReport(result).join('\n')
  assert.ok(report.includes(`GOLDEN_${discovery.GOLDEN_PARCEL}_FOUND  YES`))
})

/* ═══ İZOLASYON · PERFORMANS · GİZLİLİK ════════════════════════════════ */

test('DISC-6: baska tenant gonderileri EVRENE GIRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const mine = await makeOrg(db, 'MonalisaToka')
  const other = await makeOrg(db, 'BaskaFirma')
  await seedShipment(db, other, { packageId: 'PKG-OTHER', trackingNumber: '114' })
  await seedOperation(db, other, {
    packageId: 'PKG-OTHER', status: 'succeeded', carrierCreateCalled: true,
  })

  const result = await discovery.discoverSuratShipmentBillingEvidence(db, mine)
  assert.equal(result.shipmentsScanned, 0)
  assert.equal(result.suratCreateSuccess, 0)
})

test('DISC-7: sabit sorgu butcesi — gonderi basina sorgu YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  for (let index = 0; index < 30; index += 1) {
    await seedOrder(db, org, {
      packageId: `PKG-${index}`, orderNumber: `ORD-${index}`,
      cargoTrackingNumber: `72700000000${String(index).padStart(5, '0')}`,
    })
    await seedShipment(db, org, {
      packageId: `PKG-${index}`, trackingNumber: `114${index}`,
    })
    await seedOperation(db, org, {
      packageId: `PKG-${index}`, status: 'succeeded', carrierCreateCalled: true,
    })
  }
  const result = await discovery.discoverSuratShipmentBillingEvidence(db, org, {
    limit: 1000,
  })
  assert.equal(result.suratCreateSuccess, 30)
  // Gönderiler + operasyonlar + siparişler = 3 sorgu. SABİT.
  assert.equal(result.dbQueryCount, 3)
  // Şifreli yük YALNIZ aday kümesi için çözülür — 30 değil.
  assert.ok(
    result.payloadsDecrypted <= discovery.MAX_CANDIDATE_PAYLOADS,
    `cozulen yuk: ${result.payloadsDecrypted}`,
  )
  assert.ok(result.candidates.length <= discovery.MAX_CANDIDATE_PAYLOADS)
})

test('DISC-8: rapor PII/kimlik BASMAZ, kesif YAZMA/AG icermez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, {
    packageId: 'PKG-PII', cargoTrackingNumber: '7270000000000077',
  })
  await seedShipment(db, org, {
    packageId: 'PKG-PII', trackingNumber: '11419469827',
    ozelKargoTakipNo: '7270000000000077',
  })
  await seedOperation(db, org, {
    packageId: 'PKG-PII', status: 'succeeded', carrierCreateCalled: true,
  })

  const writes = []
  const original = pglite.query.bind(pglite)
  pglite.query = (query, ...rest) => {
    writes.push(String(query))
    return original(query, ...rest)
  }
  const result = await discovery.discoverSuratShipmentBillingEvidence(db, org)
  for (const statement of writes) {
    assert.equal(
      /\b(insert|update|delete)\b/i.test(statement), false,
      `YAZMA: ${statement.slice(0, 60)}`,
    )
  }
  const report = discovery.formatShipmentDiscoveryReport(result).join('\n')
  // Tam gönderi kimliği ve tam paket kimliği BASILMAZ (maskeli).
  assert.equal(report.includes('PKG-PII'), false)
  assert.ok(report.includes('****'))

  const code = codeOf('server/shipments/suratShipmentBillingDiscovery.ts')
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'migrate(']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  assert.equal(/\bfetch\(/.test(code), false, 'ag cagrisi OLMAMALI')
  // getCargo istemcisi bu modulden CAGRILMAZ.
  assert.equal(code.includes('suratGetCargoClient'), false)
})

test('DISC-9: CLI --shipments bayragi bagli', () => {
  const code = codeOf('server/shipments/suratBillingScanCli.ts')
  assert.ok(code.includes("process.argv.includes('--shipments')"))
  assert.ok(code.includes('discoverSuratShipmentBillingEvidence'))
})
