import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// SURAT_CREATE_UNKNOWN=300 KÖK NEDEN FORENSİĞİ.
//
// EN KRİTİK AYRIM: "create yapılmadı" ile "sınıflandıramıyorum" AYRI
// ŞEYLERDİR. Üretimde 300 kalıcı Sürat gönderisi var ve hepsi UNKNOWN;
// bu, gönderilerin oluşmadığı anlamına GELMEZ.
//
// KANITLANAN TARİH: `shipment_operations` + `carrier_create_called`
// 2026-07-20'de (`218e448`, drizzle/0001) geldi. Bu tarihten ÖNCEKİ bir
// gönderi için operasyon kaydı BEKLENEMEZ.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const forensics = await import('./shipments/suratCreateEvidenceForensics.ts')
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
    packageId: o.packageId, orderNumber: o.orderNumber ?? 'ORD-1', lines: [],
  })
  await db.execute(sql`insert into orders
    (organization_id, marketplace, package_id, order_number, marketplace_status,
     operation_status, cargo_tracking_number, order_date, raw_payload_encrypted)
    values (${org.id}, 'Trendyol', ${o.packageId}, ${o.orderNumber ?? 'ORD-1'},
      'Created', 'NEW', ${o.cargoTrackingNumber ?? null},
      '2026-03-01T09:00:00.000Z', ${raw})`)
}

async function seedShipment(db, org, s) {
  const payload = s.noPayload
    ? null
    : shipmentEncryption.encryptShipmentPayload({
        ozelKargoTakipNo: s.ozelKargoTakipNo ?? null,
        serviceMode: s.serviceMode ?? 'SURAT_CANONICAL_API',
        ...(s.payloadExtra ?? {}),
      })
  await db.execute(sql`insert into shipments
    (organization_id, marketplace, package_id, provider, source, status,
     tracking_number, barcode, carrier_payload_encrypted, created_at)
    values (${org.id}, 'Trendyol', ${s.packageId}, 'Surat',
      ${s.source ?? 'local_create'}, 'CREATED', ${s.trackingNumber ?? null},
      ${s.barcode ?? null}, ${payload},
      ${s.createdAt ?? '2026-07-25T10:00:00.000Z'})`)
}

async function seedOperation(db, org, o) {
  const responsePayload = o.responsePayload
    ? shipmentEncryption.encryptShipmentPayload(o.responsePayload)
    : null
  await db.execute(sql`insert into shipment_operations
    (organization_id, marketplace, package_id, provider, operation_type,
     idempotency_key, status, carrier_create_called, create_call_count,
     response_payload_encrypted)
    values (${org.id}, 'Trendyol', ${o.packageId}, 'Surat',
      ${o.operationType ?? 'CREATE'},
      ${`SURAT:${org.id}:${o.packageId}:${o.operationType ?? 'CREATE'}`},
      ${o.status}, ${o.carrierCreateCalled ?? false}, 1, ${responsePayload})`)
}

/* ═══ SEBEP SINIFLANDIRMASI — SAF ══════════════════════════════════════ */

test('RSN-1: ithal kayit BIRINCIL sebep olarak ISARETLENIR', () => {
  // İthal kayıtta operasyon kaydı BEKLENMEZ; tarih ne olursa olsun sebep budur.
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: false, hasCreateOperation: false,
      source: 'imported_legacy', createdAt: '2026-08-01T00:00:00.000Z',
    }),
    'UNKNOWN_IMPORTED',
  )
})

test('RSN-2: operasyon izlemesi ONCESI kayit LEGACY_SCHEMA', () => {
  // 2026-07-20 ÖNCESİ: operasyon kaydı beklenemez.
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: false, hasCreateOperation: false,
      source: 'local_create', createdAt: '2026-07-17T10:00:00.000Z',
    }),
    'UNKNOWN_LEGACY_SCHEMA',
  )
  // SONRASI: artık mekanik sebep geçerlidir.
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: false, hasCreateOperation: false,
      source: 'local_create', createdAt: '2026-07-25T10:00:00.000Z',
    }),
    'UNKNOWN_NO_OPERATION_ROWS',
  )
})

test('RSN-3: mekanik sebepler deterministik sirayla ayrisir', () => {
  const at = '2026-08-01T00:00:00.000Z'
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: true, hasCreateOperation: false,
      source: 'local_create', createdAt: at,
    }),
    'UNKNOWN_NO_CREATE_OPERATION',
  )
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: true, hasCreateOperation: true, createStatus: '',
      source: 'local_create', createdAt: at,
    }),
    'UNKNOWN_CREATE_OPERATION_STATUS_MISSING',
  )
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: true, hasCreateOperation: true, createStatus: 'succeeded',
      carrierCreateCalled: null, source: 'local_create', createdAt: at,
    }),
    'UNKNOWN_CARRIER_CREATE_CALLED_MISSING',
  )
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: true, hasCreateOperation: true, createStatus: 'succeeded',
      carrierCreateCalled: false, source: 'local_create', createdAt: at,
    }),
    'UNKNOWN_CARRIER_CREATE_CALLED_FALSE',
  )
  assert.equal(
    discovery.classifyUnknownReason({
      hasAnyOperation: true, hasCreateOperation: true, createStatus: 'pending',
      source: 'local_create', createdAt: at,
    }),
    'UNKNOWN_CREATE_OPERATION_STATUS_OTHER',
  )
})

test('EVD-1: tracking TEK BASINA success DEGIL, kaynak sarttir', () => {
  // Güçlü kanıt.
  assert.equal(
    discovery.classifyCreateEvidence({
      operationStatus: 'succeeded', carrierCreateCalled: true,
    }),
    'CREATE_PROVEN_STRONG',
  )
  // local_create + numara → o yolda numara ancak taşıyıcı yanıtından gelir.
  assert.equal(
    discovery.classifyCreateEvidence({
      source: 'local_create', trackingNumber: '11419469827',
    }),
    'CREATE_PROVEN_PERSISTED_LOCAL',
  )
  // İthal/pazaryeri kaynaklı numara create KANITI DEĞİLDİR.
  assert.equal(
    discovery.classifyCreateEvidence({
      source: 'imported_legacy', trackingNumber: '11419469827',
    }),
    'CREATE_POSSIBLE',
  )
  assert.equal(
    discovery.classifyCreateEvidence({
      source: 'marketplace_external', trackingNumber: '114',
    }),
    'CREATE_POSSIBLE',
  )
  // Numara yoksa hiçbir şey kanıtlanamaz.
  assert.equal(
    discovery.classifyCreateEvidence({ source: 'local_create' }),
    'CREATE_UNKNOWN',
  )
})

/* ═══ ÜRETİM ŞEKLİNİN YENİDEN ÜRETİMİ ══════════════════════════════════ */

test('FOR-1: uretim deseni — numara VAR, operasyon YOK → UNKNOWN sebebi', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // Üretimdeki şekil: 3 gönderi, hepsinde taşıyıcı numarası, operasyon YOK.
  for (let index = 0; index < 3; index += 1) {
    await seedOrder(db, org, {
      packageId: `PKG-${index}`, orderNumber: `ORD-${index}`,
      cargoTrackingNumber: `72700000000${String(index).padStart(5, '0')}`,
    })
    await seedShipment(db, org, {
      packageId: `PKG-${index}`, trackingNumber: `1141946982${index}`,
      createdAt: '2026-07-17T10:00:00.000Z',
    })
  }

  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 1000 })
  assert.equal(result.shipmentsScanned, 3)
  assert.equal(result.shipmentsWithoutAnyOperation, 3)
  assert.equal(result.shipmentsWithCreateOperation, 0)
  assert.equal(result.createSucceeded, 0)
  // Tarih operasyon izlemesinden ÖNCE → birincil sebep LEGACY_SCHEMA.
  assert.equal(result.unknownReasonBreakdown.UNKNOWN_LEGACY_SCHEMA, 3)
  assert.equal(result.shipmentsBeforeOperationTracking, 3)
  assert.equal(result.shipmentsAfterOperationTracking, 0)
  // Yardımcı bayraklar birincil sebep dışındaki olguları KAYBETMEZ.
  assert.equal(result.auxiliaryFlags.NO_OPERATION_ROWS, 3)
  assert.equal(result.auxiliaryFlags.HAS_TRACKING_NUMBER, 3)
  assert.equal(result.auxiliaryFlags.SOURCE_LOCAL_CREATE, 3)
  // İkinci derece kanıt: bunlar aslında create edilmiş kayıtlar.
  assert.equal(result.createEvidence.CREATE_PROVEN_PERSISTED_LOCAL, 3)
  assert.equal(result.createEvidence.CREATE_PROVEN_STRONG, 0)
  // Ters join ve beklenen taraf ayrıca ölçülür.
  assert.equal(result.orderJoinResolved, 3)
  assert.equal(result.expectedTrendyol, 3)
})

test('FOR-2: 300 sayisi sinir mi gercek mi — COUNT ile ayrisir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  for (let index = 0; index < 7; index += 1) {
    await seedShipment(db, org, {
      packageId: `PKG-${index}`, trackingNumber: `114${index}`,
    })
  }
  // İstenen limit toplamdan BÜYÜK → taranan sayı gerçek toplamdır.
  const wide = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 1000 })
  assert.equal(wide.totalSuratShipmentsInScope, 7)
  assert.equal(wide.shipmentsScanned, 7)
  assert.equal(wide.queryLimitEffective, 1000)

  // İstenen limit toplamdan KÜÇÜK → kesilme GÖRÜNÜR olur.
  const narrow = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 3 })
  assert.equal(narrow.totalSuratShipmentsInScope, 7)
  assert.equal(narrow.shipmentsScanned, 3)
  assert.ok(narrow.shipmentsScanned < narrow.totalSuratShipmentsInScope)
})

test('FOR-3: operasyon kapsamasi dogru sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const at = '2026-08-01T10:00:00.000Z'
  // (1) güçlü kanıt
  await seedShipment(db, org, { packageId: 'P1', trackingNumber: '114', createdAt: at })
  await seedOperation(db, org, {
    packageId: 'P1', status: 'succeeded', carrierCreateCalled: true,
  })
  // (2) CREATE var ama called=false
  await seedShipment(db, org, { packageId: 'P2', trackingNumber: '115', createdAt: at })
  await seedOperation(db, org, {
    packageId: 'P2', status: 'succeeded', carrierCreateCalled: false,
  })
  // (3) operasyon var ama CREATE DEĞİL
  await seedShipment(db, org, { packageId: 'P3', trackingNumber: '116', createdAt: at })
  await seedOperation(db, org, {
    packageId: 'P3', operationType: 'LABEL', status: 'succeeded',
  })

  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 1000 })
  assert.equal(result.shipmentsWithAnyOperation, 3)
  assert.equal(result.shipmentsWithCreateOperation, 2)
  assert.equal(result.shipmentsWithoutCreateOperation, 1)
  assert.equal(result.createSucceeded, 2)
  assert.equal(result.carrierCreateCalledTrue, 1)
  assert.equal(result.carrierCreateCalledFalse, 1)
  assert.equal(result.createEvidence.CREATE_PROVEN_STRONG, 1)
  assert.equal(result.unknownReasonBreakdown.UNKNOWN_CARRIER_CREATE_CALLED_FALSE, 1)
  assert.equal(result.unknownReasonBreakdown.UNKNOWN_NO_CREATE_OPERATION, 1)
})

/* ═══ YÜK ÖRNEKLEMESİ ══════════════════════════════════════════════════ */

test('FOR-4: yuk ornegi SINIRLI, yalniz ALAN ADLARI raporlanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  for (let index = 0; index < 25; index += 1) {
    await seedShipment(db, org, {
      packageId: `PKG-${index}`, trackingNumber: `114${index}`,
      ozelKargoTakipNo: `72700000000${String(index).padStart(5, '0')}`,
      payloadExtra: { gizliMusteriAdi: 'Ömer Şahin' },
      createdAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
    })
  }
  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 1000 })
  assert.ok(
    result.payloadsDecrypted <= discovery.MAX_CANDIDATE_PAYLOADS,
    `cozulen: ${result.payloadsDecrypted}`,
  )
  assert.ok(result.candidates.length <= discovery.MAX_CANDIDATE_PAYLOADS)
  // Alan ADLARI görünür, DEĞERLER görünmez.
  assert.ok(result.payloadFieldInventory.includes('ozelKargoTakipNo'))
  assert.ok(result.payloadFieldInventory.includes('gizliMusteriAdi'))
  const report = forensics.formatCreateEvidenceReport(result).join('\n')
  assert.equal(report.includes('Ömer Şahin'), false, 'PII BASILMAMALI')
  assert.ok(report.includes('PAYLOAD_FIELD_INVENTORY'))
  // Servis modu dağılımı YALNIZ örnekten gelir — bu açıkça yazılır.
  assert.ok(report.includes('YALNIZ cozulen ornekler'))
})

test('FOR-5: gercek whoPays alani varsa provenance ile raporlanir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedShipment(db, org, {
    packageId: 'PKG-W', trackingNumber: '114', payloadExtra: { whoPays: '3' },
  })
  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  assert.equal(result.actualWhoPaysFieldFound, true)
  assert.equal(result.actualWhoPaysProvenance, 'persistedCarrierPayload.whoPays')

  // Tahmini alan adi KABUL EDILMEZ.
  const { pglite: p2, db: db2 } = await makeDb()
  t.after(() => p2.close())
  const org2 = await makeOrg(db2)
  await seedShipment(db2, org2, {
    packageId: 'PKG-X', trackingNumber: '114', payloadExtra: { whoPaysCode: '3' },
  })
  const guessed = await forensics.analyzeSuratCreateEvidence(db2, org2, { limit: 100 })
  assert.equal(guessed.actualWhoPaysFieldFound, false)
})

/* ═══ GOLDEN ARAMASI ═══════════════════════════════════════════════════ */

test('FOR-6: golden TAM ESLESME ile aranir, bulunmazsa NO', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedShipment(db, org, { packageId: 'PKG-N', trackingNumber: '114' })

  const missing = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  assert.equal(missing.goldenSearchOrder, false)
  assert.equal(missing.goldenSearchShipment, false)
  assert.equal(missing.goldenSearchPayload, false)

  // Siparişte varsa bulunur.
  await seedOrder(db, org, {
    packageId: 'PKG-G', orderNumber: 'ORD-G',
    cargoTrackingNumber: discovery.GOLDEN_PARCEL,
  })
  await seedShipment(db, org, {
    packageId: 'PKG-G', trackingNumber: '115',
    ozelKargoTakipNo: discovery.GOLDEN_PARCEL,
  })
  const found = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  assert.equal(found.goldenSearchOrder, true)
  assert.equal(found.goldenSearchPayload, true)
})

/* ═══ İZOLASYON · PERFORMANS · GÜVENLİK ════════════════════════════════ */

test('FOR-7: tenant izolasyonu + sabit sorgu butcesi + YAZMA YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const mine = await makeOrg(db, 'MonalisaToka')
  const other = await makeOrg(db, 'BaskaFirma')
  await seedShipment(db, other, { packageId: 'PKG-OTHER', trackingNumber: '114' })
  for (let index = 0; index < 20; index += 1) {
    await seedOrder(db, mine, { packageId: `PKG-${index}`, orderNumber: `ORD-${index}` })
    await seedShipment(db, mine, {
      packageId: `PKG-${index}`, trackingNumber: `114${index}`,
    })
  }

  const writes = []
  const original = pglite.query.bind(pglite)
  pglite.query = (query, ...rest) => {
    writes.push(String(query))
    return original(query, ...rest)
  }
  const result = await forensics.analyzeSuratCreateEvidence(db, mine, { limit: 1000 })
  assert.equal(result.shipmentsScanned, 20, 'baska tenant SIZMAMALI')
  assert.equal(result.totalSuratShipmentsInScope, 20)
  // count + gönderiler + operasyonlar + siparişler + 2 golden = 6. SABİT.
  assert.equal(result.dbQueryCount, 6)
  for (const statement of writes) {
    assert.equal(
      /\b(insert|update|delete)\b/i.test(statement), false,
      `YAZMA: ${statement.slice(0, 60)}`,
    )
  }
})

test('FOR-8: forensik modul AG/YAZMA/CREATE icermez', () => {
  const code = codeOf('server/shipments/suratCreateEvidenceForensics.ts')
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'migrate(']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  assert.equal(/\bfetch\(/.test(code), false, 'ag cagrisi OLMAMALI')
  assert.equal(code.includes('suratGetCargoClient'), false)
  // Operasyon izleme tarihi SABIT ve kanitli.
  assert.equal(discovery.OPERATION_TRACKING_INTRODUCED.commit, '218e448')
  assert.equal(discovery.OPERATION_TRACKING_INTRODUCED.date, '2026-07-20')
  assert.equal(
    discovery.OPERATION_TRACKING_INTRODUCED.migration, '0001_next_outlaw_kid.sql',
  )
})

/* ═══ KÖK NEDEN: operation_type SABİT 'CREATE' DEĞİL ═══════════════════ */

test('GAP-1: operation_type TASIYICI OPERASYON ADIDIR — kaynak kaniti', () => {
  // ÜRETİMDE KIRAN VARSAYIM: 300/300 WITH_ANY_OPERATION ama 0/300
  // WITH_CREATE_OPERATION. Sebep: `recordToColumns`
  // `first(record.operation, 'CREATE')` yazar ve `record.operation`
  // `resolveSuratCreateOperationName(config)` sonucudur.
  const persistence = codeOf('server/shipments/shipmentPersistenceService.ts')
  assert.ok(
    persistence.includes("operationType: first(record.operation, 'CREATE')"),
    'operationType record.operation dan gelir',
  )
  const server = codeOf('server/index.mjs')
  assert.ok(server.includes('operation: resolveSuratCreateOperationName(config)'))

  // Cozucudeki HER donus degeri kanit kumesinde OLMALI — aksi halde o
  // servis modunun create kayitlari yine gorunmez olur.
  const start = server.indexOf('function resolveSuratCreateOperationName')
  assert.ok(start > 0)
  const body = server.slice(start, server.indexOf('\n}', start + 60))
  const returned = [...body.matchAll(/return '([^']+)'/g)].map((m) => m[1])
  assert.ok(returned.length >= 5, `cozucu donusleri: ${returned.length}`)
  for (const name of returned) {
    assert.ok(
      discovery.SURAT_CREATE_OPERATION_TYPES.includes(name),
      `${name} kanit kumesinde EKSIK`,
    )
  }
  // Takip/sorgu operasyonlari kanit SAYILMAZ.
  for (const nonCreate of [
    'KargoTakipHareketDetayi', 'CariKoduveSifre', 'TrendyolUpdatePackageStatus',
    'KargoBarkodu', 'WebSiparisKodu', 'TakipNo',
  ]) {
    assert.equal(
      discovery.isCreateOperationType(nonCreate), false,
      `${nonCreate} create kaniti OLMAMALI`,
    )
  }
})

test('GAP-2: OrtakBarkodOlustur kaydi artik CREATE olarak GORULUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedOrder(db, org, {
    packageId: 'PKG-OB', cargoTrackingNumber: '7270000000000031',
  })
  await seedShipment(db, org, {
    packageId: 'PKG-OB', trackingNumber: '11419469827',
    createdAt: '2026-08-12T08:00:00.000Z',
  })
  // ÜRETİMDEKİ GERÇEK YAZIM: operation_type = 'OrtakBarkodOlustur'.
  await seedOperation(db, org, {
    packageId: 'PKG-OB', operationType: 'OrtakBarkodOlustur',
    status: 'succeeded', carrierCreateCalled: true,
  })
  // Takip operasyonu da var — kanıt SAYILMAMALI.
  await seedOperation(db, org, {
    packageId: 'PKG-OB', operationType: 'KargoTakipHareketDetayi',
    status: 'succeeded', carrierCreateCalled: true,
  })

  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  assert.equal(result.shipmentsWithAnyOperation, 1)
  assert.equal(result.shipmentsWithCreateOperation, 1, 'ARTIK gorulmeli')
  assert.equal(result.createEvidence.CREATE_PROVEN_STRONG, 1)
  assert.deepEqual(result.unknownReasonBreakdown, {}, 'UNKNOWN kalmamali')

  // Gerçek operasyon tipi dağılımı çelişkiyi açıklar.
  assert.equal(result.operationTypeDistribution.OrtakBarkodOlustur.count, 1)
  assert.equal(result.operationTypeDistribution.KargoTakipHareketDetayi.count, 1)
  const report = forensics.formatCreateEvidenceReport(result).join('\n')
  assert.ok(report.includes('OPERATION_TYPE_DISTRIBUTION'))
  assert.ok(/OrtakBarkodOlustur\s+1\s+succeeded=1\s+called:true=1\s+\[CREATE\]/.test(report))
  assert.ok(/KargoTakipHareketDetayi.*\[NON-CREATE\]/.test(report))

  // Kesif araci da AYNI sonucu vermeli (iki arac ayrismamali).
  const found = await discovery.discoverSuratShipmentBillingEvidence(db, org, {
    limit: 100,
  })
  assert.equal(found.suratCreateSuccess, 1)
  assert.equal(found.suratCreateUnknown, 0)
})

test('GAP-3: senderCode kaynagi raporlanir, FirmaId ile KARISTIRILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedShipment(db, org, {
    packageId: 'PKG-SC', trackingNumber: '114',
    payloadExtra: { senderCode: '496056', firmaId: '1411052622' },
  })
  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  assert.equal(result.senderCodeAvailableCount, 1)
  assert.equal(result.distinctSenderCodes, 1)
  // Alan envanterinde ikisi AYRI durur.
  assert.ok(result.payloadFieldInventory.includes('senderCode'))
  assert.ok(result.payloadFieldInventory.includes('firmaId'))
  // DEĞERLER raporda basılmaz.
  const report = forensics.formatCreateEvidenceReport(result).join('\n')
  assert.equal(report.includes('496056'), false)
  assert.equal(report.includes('1411052622'), false)
})

test('GAP-4: billingParty GERCEK payer SAYILMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedShipment(db, org, {
    packageId: 'PKG-BP', trackingNumber: '114',
    payloadExtra: { billingParty: 'PRIMARY' },
  })
  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  // CargoFlow'un KENDİ kredensiyal sınıfı taşıyıcı cevabı DEĞİLDİR.
  assert.equal(result.actualWhoPaysFieldFound, false)
  assert.equal(result.payloadsWithActualPayer, 0)
  assert.deepEqual(result.cargoflowOriginPayerKeysSeen, ['billingParty'])
})

/* ═══ FAZ 4D: PENDING LIFECYCLE ════════════════════════════════════════ */

test('LIFE-1: finalize YALNIZ dosya deposuna yaziyor — kaynak kaniti', () => {
  // KÖK NEDEN: `record.status = 'SUCCESS'` yazan HER İKİ yer de
  // `queueSuratCreateStoreUpdate` (dosya tabanlı JSON depo) icindedir ve
  // DB-farkindali `writeSuratCreateOperation` CAGRILMAZ. DB kalicilik
  // modunda finalize `shipment_operations`a HIC ULASMAZ → satir sonsuza
  // dek `pending` kalir.
  const server = codeOf('server/index.mjs')
  const successSites = [...server.matchAll(/record\.status = 'SUCCESS'/g)]
  assert.equal(successSites.length, 2, 'iki finalize yeri bekleniyor')
  for (const site of successSites) {
    // Her yazimin ONUNDEKI en yakin blok acilisini bul.
    const before = server.slice(0, site.index)
    const queueAt = before.lastIndexOf('queueSuratCreateStoreUpdate')
    const dbAt = before.lastIndexOf('writeSuratCreateOperation')
    assert.ok(
      queueAt > dbAt,
      'SUCCESS yazimi dosya deposu blogunda — DB yazicisi DEGIL',
    )
  }
  // Create ANI ise DB yazicisini kullanir; ayrisma tam olarak burada.
  assert.ok(server.includes('await writeSuratCreateOperation(record)'))
  // Ve create-ani durumu legacy SOAP yolunda 'UNKNOWN' olabilir.
  assert.ok(server.includes("? 'SUCCESS'\n      : explicitBusinessFailure\n        ? 'FAILED_SAFE'\n        : 'UNKNOWN'"))

  // Eslesme: 'SUCCESS'/'FAILED_SAFE' disindaki HER SEY `pending` yazilir.
  const persistence = codeOf('server/shipments/shipmentPersistenceService.ts')
  assert.ok(persistence.includes("status === 'SUCCESS'"))
  assert.ok(persistence.includes("status === 'FAILED_SAFE'"))
  assert.ok(persistence.includes(": 'pending'"))
})

test('LIFE-2: carrierTrackingNumber YALNIZ onayli yolda dolar', () => {
  // Bu, kalici yukten gercek basariyi cikarabilmemizin TEK dayanagi.
  const server = codeOf('server/index.mjs')
  assert.ok(
    server.includes(
      'verified || result?.shipment?.dispatchRegistrationConfirmed',
    ),
    'aday numara ile onayli numara AYRI alanlara yazilir',
  )
  assert.ok(server.includes('candidateTrackingNumber:'))

  assert.equal(
    discovery.classifyPersistedCarrierResponse({ carrierTrackingNumber: '114' }),
    'SUCCESS',
  )
  // ADAY numara kanit DEGILDIR.
  assert.equal(
    discovery.classifyPersistedCarrierResponse({ candidateTrackingNumber: '114' }),
    'UNKNOWN',
  )
  assert.equal(
    discovery.classifyPersistedCarrierResponse({ status: 'FAILED_SAFE' }),
    'FAILURE',
  )
  assert.equal(
    discovery.classifyPersistedCarrierResponse({ verificationStatus: 'VERIFIED' }),
    'SUCCESS',
  )
  assert.equal(discovery.classifyPersistedCarrierResponse({ status: 'UNKNOWN' }), 'UNKNOWN')
})

test('LIFE-3: pending + tasiyici basarisi AYRI eksen olarak sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const at = '2026-08-12T08:00:00.000Z'
  await seedOrder(db, org, {
    packageId: 'PKG-P1', cargoTrackingNumber: '7270000000000041',
  })
  await seedShipment(db, org, {
    packageId: 'PKG-P1', trackingNumber: '11419469827', createdAt: at,
  })
  // ÜRETİMDEKİ ŞEKİL: pending + called=true + yükte onaylı taşıyıcı numarası.
  await seedOperation(db, org, {
    packageId: 'PKG-P1',
    operationType: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    status: 'pending', carrierCreateCalled: true,
    responsePayload: { status: 'UNKNOWN', carrierTrackingNumber: '11419469827' },
  })

  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  // Audit durumu HÂLÂ pending — gevşetilmedi.
  assert.equal(result.createSucceeded, 0)
  assert.equal(result.createOtherStatus, 1)
  // Ama taşıyıcı yanıtı başarıyı kanıtlıyor.
  assert.equal(result.persistedResponseSuccess, 1)
  assert.equal(result.responseSuccessOperationPending, 1, 'DEGISMEZ IHLALI gorunur')
  assert.equal(result.createEvidence.CREATE_PROVEN_CARRIER_RESPONSE, 1)
  assert.equal(result.createEvidence.CREATE_PROVEN_STRONG, 0)
  assert.equal(result.realCreateSuccessProven, 1)

  const report = forensics.formatCreateEvidenceReport(result).join('\n')
  assert.ok(report.includes('CREATE_RESPONSE_SUCCESS_OPERATION_PENDING  1'))
  assert.ok(report.includes('REAL_CREATE_SUCCESS_PROVEN        1'))
})

test('LIFE-4: yukte KANIT YOKSA pending SUCCESS a CEVRILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedShipment(db, org, {
    packageId: 'PKG-P2', trackingNumber: '11419469827',
    createdAt: '2026-08-12T08:00:00.000Z',
  })
  // Yalnız ADAY numara — onay YOK.
  await seedOperation(db, org, {
    packageId: 'PKG-P2',
    operationType: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    status: 'pending', carrierCreateCalled: true,
    responsePayload: { status: 'UNKNOWN', candidateTrackingNumber: '11419469827' },
  })
  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  assert.equal(result.persistedResponseSuccess, 0)
  assert.equal(result.responseUnknownOperationPending, 1)
  assert.equal(result.createEvidence.CREATE_PROVEN_CARRIER_RESPONSE, 0)
  assert.equal(result.realCreateSuccessProven, 0)
  // Numara var + local_create → yalnizca zayif sinif.
  assert.equal(result.createEvidence.CREATE_PROVEN_PERSISTED_LOCAL, 1)
})

/* ═══ FAZ 4E: KANIT ZARFI MUTABAKATI ══════════════════════════════════ */

test('ENV-1: gonderi satirinin VAR OLMASI on-atanmis ZPL kanitidir', () => {
  // `persistShipmentRecord` gonderiyi YALNIZ su kosulda yazar:
  //   columns.status === 'succeeded' || isSuratRecordPreassignedReady(record)
  // Audit pending iken satir varsa ikinci kosul saglanmis demektir:
  // sert hata YOK ve teknik ZPL GELDI.
  const persistence = codeOf('server/shipments/shipmentPersistenceService.ts')
  assert.ok(
    persistence.includes(
      "columns.status === 'succeeded' || isSuratRecordPreassignedReady(record)",
    ),
  )
  assert.ok(persistence.includes('record.technicalZpl ||'))
  assert.ok(persistence.includes('shipment.barcodeRaw ||'))
  // Ve gonderi tracking'i ADAY numaraya duser.
  assert.ok(
    persistence.includes(
      'first(record.carrierTrackingNumber, record.candidateTrackingNumber)',
    ) || persistence.includes('columns.trackingNumber'),
  )

  assert.equal(discovery.hasCarrierArtifactEvidence({ technicalZpl: '^XA' }), true)
  assert.equal(
    discovery.hasCarrierArtifactEvidence({ shipment: { barcodeRaw: '^XA' } }), true,
  )
  assert.equal(discovery.hasCarrierArtifactEvidence({ status: 'UNKNOWN' }), false)
  assert.equal(discovery.hasCarrierArtifactEvidence(null), false)
})

test('ENV-2: ANAHTAR VAR ile DEGER DOLU ayri sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  // ÜRETİMDEKİ ŞEKİL: anahtarlar var, onaylı değerler BOŞ, aday DOLU, ZPL VAR.
  const record = {
    status: 'UNKNOWN',
    carrierTrackingNumber: '',
    candidateTrackingNumber: '11419469827',
    carrierBarcodeNumber: '',
    candidateBarcodeNumber: '01231201025',
    businessCode: '',
    verificationStatus: '',
    operation: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    soapAction: 'http://tempuri.org/x',
    technicalZpl: '^XA^XZ',
  }
  await seedShipment(db, org, {
    packageId: 'PKG-E1', trackingNumber: '11419469827',
    createdAt: '2026-08-12T08:00:00.000Z', payloadExtra: record,
  })
  await seedOperation(db, org, {
    packageId: 'PKG-E1',
    operationType: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    status: 'pending', carrierCreateCalled: true, responsePayload: record,
  })

  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  const matrix = result.fieldSourceMatrix
  // Anahtar HER İKİ zarfta da var…
  assert.equal(matrix.carrierTrackingNumber.shipmentKey, 1)
  assert.equal(matrix.carrierTrackingNumber.operationKey, 1)
  // …ama DEĞER hiçbirinde dolu değil. Üretimdeki yanılgı tam olarak buydu.
  assert.equal(matrix.carrierTrackingNumber.shipmentValue, 0)
  assert.equal(matrix.carrierTrackingNumber.operationValue, 0)
  // Aday numara ise DOLU.
  assert.equal(matrix.candidateTrackingNumber.shipmentValue, 1)

  assert.equal(result.shipmentPayloadCarrierTrackingPresent, 0)
  assert.equal(result.shipmentPayloadCandidateTrackingOnly, 1)
  assert.equal(result.shipmentPayloadCandidateBarcodeOnly, 1)

  // ZPL geldiği için taşıyıcı ARTEFAKT kanıtı VAR.
  assert.equal(result.carrierArtifactPresent, 1)
  assert.equal(result.createEvidence.CREATE_PROVEN_CARRIER_ARTIFACT, 1)
  assert.equal(result.createEvidence.CREATE_PROVEN_CARRIER_RESPONSE, 0)
  assert.equal(result.createEvidence.CREATE_PROVEN_STRONG, 0)
  assert.equal(result.realCreateSuccessProven, 1)
  // Audit durumu GEVSETILMEDI.
  assert.equal(result.createSucceeded, 0)
  assert.equal(result.persistedResponseSuccess, 0)

  const report = forensics.formatCreateEvidenceReport(result).join('\n')
  assert.ok(report.includes('FIELD_SOURCE_MATRIX'))
  assert.ok(report.includes('SHIPMENT_PAYLOAD_CANDIDATE_TRACKING_ONLY    1'))
  assert.ok(report.includes('CREATE_PROVEN_CARRIER_ARTIFACT    1'))
  // Kimlik DEGERLERI raporda basilmaz.
  assert.equal(report.includes('11419469827'), false)
})

test('ENV-3: ZPL YOKSA artefakt kaniti URETILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await seedShipment(db, org, {
    packageId: 'PKG-E2', trackingNumber: '114',
    payloadExtra: { status: 'UNKNOWN', candidateTrackingNumber: '114' },
  })
  await seedOperation(db, org, {
    packageId: 'PKG-E2', operationType: 'OrtakBarkodOlustur',
    status: 'pending', carrierCreateCalled: true,
  })
  const result = await forensics.analyzeSuratCreateEvidence(db, org, { limit: 100 })
  assert.equal(result.carrierArtifactPresent, 0)
  assert.equal(result.createEvidence.CREATE_PROVEN_CARRIER_ARTIFACT, 0)
  assert.equal(result.realCreateSuccessProven, 0)
  assert.equal(result.createEvidence.CREATE_PROVEN_PERSISTED_LOCAL, 1)
})

test('FOR-9: CLI --unknown-reasons bayragi bagli', () => {
  const code = codeOf('server/shipments/suratBillingScanCli.ts')
  assert.ok(code.includes("process.argv.includes('--unknown-reasons')"))
  assert.ok(code.includes('analyzeSuratCreateEvidence'))
})
