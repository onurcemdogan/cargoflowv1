import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// DEBUG V3 + KANONİK CAST HATASI.
//
// ÖLÇÜLEN ÜRETİM KUSURU: Trace V2 hiçbir yere KALICILAŞTIRILMIYORDU. Sunucu
// `traceAttempt` üretip yanıtta döndürüyor, istemci onu HİÇ okumuyor
// (`traceAttempt` src/ içinde YOK) ve istemci deposunun yazıcısı `appendTrace`
// HİÇ çağrılmıyordu. Gerçek bir create denemesinden sonra bile Canlı Debug
// "Henüz bir Sürat gönderi denemesi kaydedilmedi." diyordu.
//
// AĞ YOK · GERÇEK TAŞIYICI CREATE YOK.
assert.notEqual(process.env.REAL_CARRIER_CREATE, '1')
assert.notEqual(process.env.LIVE_CREATE, '1')

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const repo = await import('./shipments/suratTraceRepository.ts')
const CAST = await import('./shipments/suratCanonicalCastRecovery.ts')
const orderRepo = await import('./orders/orderRepository.ts')

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function freshDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'dbg', slug: `dbg-${randomBytes(4).toString('hex')}` })
    .returning()
  return { db, organizationId: org.id }
}

const attempt = (traceId, overrides = {}) => ({
  traceId,
  createdAt: new Date().toISOString(),
  orderNumber: '11518942910',
  packageId: '7270036019076954',
  marketplace: 'Trendyol',
  serviceMode: 'SURAT_CANONICAL_API',
  operation: 'OrtakBarkodOlustur',
  finalState: 'CREATE_FAILED',
  stages: [
    { stage: 'PRE_FLIGHT', section: 'ROUTING', at: '2026-08-19T10:00:00Z', data: {} },
    { stage: 'FINAL', section: 'FINAL_RESULT', at: '2026-08-19T10:00:05Z', data: {} },
  ],
  summary: { httpStatus: 500 },
  ...overrides,
})

/* ═══════════════ DEBUG-1..3 — GERÇEK KALICILAŞTIRMA ════════════════ */

test('DEBUG-1: gercek deneme KALICILASIR ve yeniden okunur', async () => {
  const { db, organizationId } = await freshDb()
  // Once BOS: "Henuz bir Surat gonderi denemesi kaydedilmedi."
  assert.equal(await repo.readLatestTraceAttempt(db, organizationId), null)

  const written = await repo.persistTraceAttempt(db, organizationId, attempt('TR-1'))
  assert.equal(written.persisted, true)

  // "Sayfa yenilendi" = yeni okuma. Iz HALA gorunur.
  const latest = await repo.readLatestTraceAttempt(db, organizationId)
  assert.ok(latest, 'kalicilasan iz yeniden okunamadi')
  assert.equal(latest.traceId, 'TR-1')
  assert.equal(latest.schemaVersion, 2)
  assert.equal(latest.orderNumber, '11518942910')
  assert.equal(Array.isArray(latest.stages), true)
})

test('DEBUG-2: Trace A, Trace B verisini GOSTERMEZ', async () => {
  const { db, organizationId } = await freshDb()
  await repo.persistTraceAttempt(db, organizationId, attempt('TR-A', {
    createdAt: '2026-08-19T09:00:00Z', orderNumber: 'ORDER-A',
  }))
  await repo.persistTraceAttempt(db, organizationId, attempt('TR-B', {
    createdAt: '2026-08-19T11:00:00Z', orderNumber: 'ORDER-B',
  }))
  const latest = await repo.readLatestTraceAttempt(db, organizationId)
  assert.equal(latest.traceId, 'TR-B')
  assert.equal(latest.orderNumber, 'ORDER-B')
  // Karisma YOK: tek satir doner, alanlar TEK denemeye aittir.
  const all = await repo.listTraceAttempts(db, organizationId, 50)
  assert.equal(all.length, 2)
  const a = all.find((t) => t.traceId === 'TR-A')
  assert.equal(a.orderNumber, 'ORDER-A')
})

test('DEBUG-2b: KIRACI izolasyonu — baska kiracinin izi GORUNMEZ', async () => {
  const { db, organizationId } = await freshDb()
  const [other] = await db.insert(schema.organizations)
    .values({ name: 'other', slug: `other-${randomBytes(4).toString('hex')}` })
    .returning()
  await repo.persistTraceAttempt(db, other.id, attempt('TR-OTHER'))
  assert.equal(await repo.readLatestTraceAttempt(db, organizationId), null)
  assert.equal((await repo.listTraceAttempts(db, organizationId)).length, 0)
})

test('DEBUG-3: varsayilan ekranda LEGACY satir YOKTUR', () => {
  // Panel YALNIZ Trace V2 deposundan okur; eski v1/Hata Merkezi kaynagini
  // SORGULAMAZ.
  const panel = readFileSync(
    join(here, '..', 'src', 'components', 'SuratLiveDebugPanel.tsx'), 'utf8',
  )
  assert.equal(
    /apiDebugLogs\.v1/.test(panel), false,
    'panel legacy v1 deposunu okuyor',
  )
  const store = readFileSync(
    join(here, '..', 'src', 'services', 'suratTraceDebugStore.ts'), 'utf8',
  )
  // v1 kayitlari SEMA SURUMUNDEN elenir.
  assert.match(store, /schemaVersion === TRACE_SCHEMA_VERSION/)
})

/* ═══════════════ DEBUG-4..5 — TEMIZLEME ════════════════════════════ */

test('DEBUG-4: temizleme Trace V2 gecmisini SILER', async () => {
  const { db, organizationId } = await freshDb()
  await repo.persistTraceAttempt(db, organizationId, attempt('TR-1'))
  await repo.persistTraceAttempt(db, organizationId, attempt('TR-2'))
  assert.equal((await repo.listTraceAttempts(db, organizationId)).length, 2)

  await repo.clearTraceAttempts(db, organizationId)
  assert.equal((await repo.listTraceAttempts(db, organizationId)).length, 0)
  assert.equal(await repo.readLatestTraceAttempt(db, organizationId), null)
})

test('DEBUG-5: temizleme DOGRULANMIS legacy debug-only cache anahtarini tanir', () => {
  const store = readFileSync(
    join(here, '..', 'src', 'services', 'suratTraceDebugStore.ts'), 'utf8',
  )
  // Legacy anahtar SADECE silme icin taninir; okuma kaynagi DEGILDIR.
  assert.match(store, /LEGACY_DEBUG_STORAGE_KEY = 'cargoflow\.apiDebugLogs\.v1'/)
})

test('DEBUG-5b: temizleme SADECE kendi kiracisini siler', async () => {
  const { db, organizationId } = await freshDb()
  const [other] = await db.insert(schema.organizations)
    .values({ name: 'other', slug: `o-${randomBytes(4).toString('hex')}` })
    .returning()
  await repo.persistTraceAttempt(db, organizationId, attempt('MINE'))
  await repo.persistTraceAttempt(db, other.id, attempt('THEIRS'))

  await repo.clearTraceAttempts(db, organizationId)
  assert.equal((await repo.listTraceAttempts(db, organizationId)).length, 0)
  assert.equal(
    (await repo.listTraceAttempts(db, other.id)).length, 1,
    'baska kiracinin debug gecmisi silindi',
  )
})

/* ═══════════════ DEBUG-6..10 — OPERASYONEL VERİ KORUNUR ════════════ */

test('DEBUG-6..10: temizleme OPERASYONEL veriye DOKUNMAZ', async () => {
  const { db, organizationId } = await freshDb()

  // Operasyonel kayitlar: siparis + satir.
  await orderRepo.upsertMarketplaceOrders(db, organizationId, [{
    marketplace: 'Trendyol',
    packageId: 'PKG-KEEP-1',
    shipmentPackageId: 'PKG-KEEP-1',
    orderNumber: '11518942910',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'A', customerLastName: 'B',
    city: 'İstanbul', totalAmount: 100, currency: 'TRY',
    orderDate: '2026-08-19T08:00:00Z',
    items: [{ lineId: 'L1', productName: 'X', quantity: 1, price: 100 }],
  }])
  // Debug izi.
  await repo.persistTraceAttempt(db, organizationId, attempt('TR-1'))

  const before = {
    orders: (await db.select().from(schema.orders)).length,
    orderLines: (await db.select().from(schema.orderLines)).length,
    shipments: (await db.select().from(schema.shipments)).length,
    operations: (await db.select().from(schema.shipmentOperations)).length,
  }
  assert.ok(before.orders > 0, 'senaryo siparis icermeli')

  await repo.clearTraceAttempts(db, organizationId)

  const after = {
    orders: (await db.select().from(schema.orders)).length,
    orderLines: (await db.select().from(schema.orderLines)).length,
    shipments: (await db.select().from(schema.shipments)).length,
    operations: (await db.select().from(schema.shipmentOperations)).length,
  }
  // DEBUG-6 orders · DEBUG-7 shipments · DEBUG-8 shipment_operations
  // DEBUG-9 idempotency (shipment_operations satiri) · DEBUG-10 etiket artefakti
  assert.deepEqual(after, before, 'OPERASYONEL VERI SILINDI')
  // Debug tarafi gercekten temizlendi.
  assert.equal((await repo.listTraceAttempts(db, organizationId)).length, 0)
})

test('DEBUG-11: silme sorgusu YALNIZ debug tablosunu adlandirir', () => {
  const source = readFileSync(
    join(here, 'shipments', 'suratTraceRepository.ts'), 'utf8',
  )
  const clearAt = source.indexOf('export async function clearTraceAttempts')
  const body = source.slice(clearAt)
  for (const forbidden of ['orders', 'shipments,', 'shipmentOperations', 'orderLines']) {
    assert.equal(
      body.includes(forbidden), false,
      `temizleme fonksiyonu operasyonel tabloya dokunuyor: ${forbidden}`,
    )
  }
  assert.match(body, /suratTraceAttempts/)
})

/* ═══════════════ DEĞİŞMEZLİK ve SAKLAMA ═══════════════════════════ */

test('DEBUG-12: ayni traceId IKINCI kez yazilmaz (deneme DEGISMEZ)', async () => {
  const { db, organizationId } = await freshDb()
  await repo.persistTraceAttempt(db, organizationId, attempt('TR-DUP', {
    orderNumber: 'ORIGINAL',
  }))
  await repo.persistTraceAttempt(db, organizationId, attempt('TR-DUP', {
    orderNumber: 'TAMPERED',
  }))
  const all = await repo.listTraceAttempts(db, organizationId)
  assert.equal(all.length, 1, 'ayni deneme iki kez yazildi')
  assert.equal(all[0].orderNumber, 'ORIGINAL', 'kayitli deneme DEGISTIRILDI')
})

test('DEBUG-13: saklama siniri 7 GUN', async () => {
  const { db, organizationId } = await freshDb()
  const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString()
  await repo.persistTraceAttempt(db, organizationId, attempt('OLD', { createdAt: old }))
  await repo.persistTraceAttempt(db, organizationId, attempt('NEW'))
  await repo.applyTraceRetentionForTenant(db, organizationId)
  const all = await repo.listTraceAttempts(db, organizationId)
  assert.deepEqual(all.map((t) => t.traceId), ['NEW'])
})

/* ═══════════════ CAST-1..3 — SINIFLANDIRMA ════════════════════════ */

const PROD_ERROR =
  "System.InvalidCastException: Unable to cast object of type 'System.String' "
  + "to type 'KargoBarkod'\n   at SK_WebService.Api.Controllers."
  + 'OrtakBarkodController.OrtakBarkodOlusturSonuc(...) line 1836'

test('CAST-0: uretim hata imzasi TANINIR, genel hata TANINMAZ', () => {
  assert.equal(CAST.isCanonicalResultCastError(PROD_ERROR), true)
  for (const other of [
    'System.NullReferenceException at Foo',
    'InvalidCastException at SomeOtherController.Bar',
    '', null, undefined,
  ]) {
    assert.equal(CAST.isCanonicalResultCastError(other), false, String(other))
  }
})

test('CAST-1: gonderi VAR + etiket VAR → kurtarma, IKINCI create YOK', () => {
  const result = CAST.classifyCanonicalCastOutcome({
    lookupCompleted: true, shipmentFound: true,
    trackingNumber: '11419469827', barcode: '01254596670', zpl: '^XA^XZ',
  })
  assert.equal(result.classification, 'RECOVERED_AFTER_CANONICAL_RESULT_ERROR')
  assert.equal(result.mayCreateAgain, false, 'ikinci fiziksel create acildi')
  assert.equal(result.trackingRecovered, true)
  assert.equal(result.barcodeRecovered, true)
  assert.equal(result.zplRecovered, true)
})

test('CAST-2: gonderi VAR + etiket YOK → SAVED_BARCODE_FAILED', () => {
  const result = CAST.classifyCanonicalCastOutcome({
    lookupCompleted: true, shipmentFound: true, trackingNumber: '11419469827',
  })
  assert.equal(result.classification, 'SAVED_BARCODE_FAILED')
  assert.equal(result.mayCreateAgain, false)
  // DURUST IFADE: yaniltici cumleler YASAK.
  assert.equal(result.userMessage, 'Sürat gönderiyi kaydetti ancak barkod üretmedi.')
  assert.equal(/etiket oluşturuldu/.test(result.userMessage), false)
  assert.equal(/barkod bekliyor/.test(result.userMessage), false)
})

test('CAST-3: gonderi YOK → NO_CONFIRMED_CREATE', () => {
  const result = CAST.classifyCanonicalCastOutcome({
    lookupCompleted: true, shipmentFound: false,
  })
  assert.equal(
    result.classification, 'CANONICAL_RESULT_CAST_FAILED_NO_CONFIRMED_CREATE',
  )
  assert.equal(result.barcodeRecovered, false)
})

test('CAST-3b: dogrulama TAMAMLANMADIYSA kanit YETERSIZ', () => {
  for (const evidence of [
    { lookupCompleted: false, shipmentFound: null },
    { lookupCompleted: true, shipmentFound: null },
  ]) {
    const result = CAST.classifyCanonicalCastOutcome(evidence)
    assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE')
    assert.equal(result.mayCreateAgain, false, 'kanitsiz create acildi')
  }
})

/* ═══════════════ CAST-4..7 — FALLBACK KAPISI ══════════════════════ */

const eligible = {
  canonicalCastError: true, verificationCompleted: true,
  shipmentConfirmed: false, barcodeConfirmed: false,
  requestFingerprintMatches: true, financialFingerprintMatches: true,
  credentialFingerprintMatches: true, carrierCreateCallCount: 1,
  explicitAuthorization: true,
}

test('CAST-4: OTOMATIK fallback YOK — varsayilan KAPALI', () => {
  assert.equal(CAST.LEGACY_FALLBACK_DEFAULT_ENABLED, false)
  // Yetkilendirme olmadan uygun DEGIL.
  const auto = CAST.inspectLegacyFallbackEligibility({
    ...eligible, explicitAuthorization: false,
  })
  assert.equal(auto.eligible, false)
  assert.ok(auto.failedConditions.includes('EXPLICIT_AUTHORIZATION_MISSING'))
  // Denetci ASLA cagri yapmaz.
  assert.equal(auto.dryRun, true)
})

test('CAST-4b: gonderi VARSA fallback ASLA uygun degildir', () => {
  for (const shipmentConfirmed of [true, null]) {
    const result = CAST.inspectLegacyFallbackEligibility({
      ...eligible, shipmentConfirmed,
    })
    assert.equal(result.eligible, false, String(shipmentConfirmed))
    assert.ok(result.failedConditions.includes('SHIPMENT_NOT_PROVEN_ABSENT'))
  }
})

test('CAST-5: kimlik parmak izi uyusmazsa AG CAGRISI YOK', () => {
  const result = CAST.inspectLegacyFallbackEligibility({
    ...eligible, credentialFingerprintMatches: false,
  })
  assert.equal(result.eligible, false)
  assert.ok(result.failedConditions.includes('CREDENTIAL_FINGERPRINT_MISMATCH'))
})

test('CAST-6: finansal parmak izi uyusmazsa AG CAGRISI YOK', () => {
  const result = CAST.inspectLegacyFallbackEligibility({
    ...eligible, financialFingerprintMatches: false,
  })
  assert.equal(result.eligible, false)
  assert.ok(result.failedConditions.includes('FINANCIAL_FINGERPRINT_MISMATCH'))
})

test('CAST-7: istek parmak izi uyusmazsa REPLAY YOK', () => {
  const result = CAST.inspectLegacyFallbackEligibility({
    ...eligible, requestFingerprintMatches: false,
  })
  assert.equal(result.eligible, false)
  assert.ok(result.failedConditions.includes('REQUEST_FINGERPRINT_MISMATCH'))
})

test('CAST-7b: birden fazla fiziksel deneme varsa fallback KAPALI', () => {
  for (const count of [0, 2, 3]) {
    const result = CAST.inspectLegacyFallbackEligibility({
      ...eligible, carrierCreateCallCount: count,
    })
    assert.equal(result.eligible, false, String(count))
    assert.ok(result.failedConditions.includes('CARRIER_CREATE_COUNT_NOT_ONE'))
  }
  // DOKUZ kosulun HEPSI saglandiginda uygun olur.
  assert.equal(CAST.inspectLegacyFallbackEligibility(eligible).eligible, true)
})

/* ═══════════════ CAST-8..10 — SÖZLEŞME KORUNUR ════════════════════ */

test('CAST-8: Gonderi tel sinirinda NESNE kalir', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  // Kanonik istek `Gonderi` alanini NESNE olarak tasir; dizeye cevrilmez.
  assert.match(source, /Gonderi/)
  const model = readFileSync(
    join(here, 'shipments', 'suratCanonicalGonderiModel.ts'), 'utf8',
  )
  assert.equal(
    /JSON\.stringify\(\s*gonderi/i.test(model), false,
    'Gonderi dizeye cevriliyor',
  )
})

test('CAST-9: ReferansNo ve OzelKargoTakipNo BIRBIRINE karismaz', () => {
  const model = readFileSync(
    join(here, 'shipments', 'suratCanonicalGonderiModel.ts'), 'utf8',
  )
  // Model, ozelKargoTakipNo icin orderNumber/packageId/ReferansNo fallback'ini
  // ACIKCA yasaklar.
  assert.match(model, /fallback YOKTUR/)
  assert.match(model, /ozelKargoTakipNo/)
})

test('CAST-10: BIR basarisiz deneme BIR traceId uretir', async () => {
  const { db, organizationId } = await freshDb()
  const single = attempt('TR-SINGLE')
  await repo.persistTraceAttempt(db, organizationId, single)
  // Ayni denemenin ikinci yazimi yeni kayit URETMEZ.
  await repo.persistTraceAttempt(db, organizationId, single)
  const all = await repo.listTraceAttempts(db, organizationId)
  assert.equal(all.length, 1)
  assert.equal(all[0].traceId, 'TR-SINGLE')
})

/* ═══════════════ WIRING — yazici GERCEKTEN cagriliyor mu ══════════ */

test('DEBUG-14: create yolu izi GERCEKTEN kalicilastirir', () => {
  // Bu testin varlik sebebi: kalicilastirma katmani var olup CAGRILMAMASI,
  // tanilanan kusurun TA KENDISIDIR. Yazicinin cagrildigi kanitlanir.
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.match(source, /async function persistSuratTraceAttempt\(/)
  assert.match(source, /repository\.persistTraceAttempt\(/)
  // ARTIK YANIT SINIRINDA: tek dal degil, TUM cikis yollari kapsanir.
  // (Onceki surum yalniz kanonik BASARI dalini kapsiyordu; uretimde basarisiz
  // deneme `catch` dalindan donuyor ve hic kaydedilmiyordu.)
  assert.match(source, /const withSuratTracePersistence = \(handler\) =>/)
  assert.match(
    source,
    /app\.post\('\/api\/shipments\/surat', withSuratTracePersistence\(createSuratShipment\)\)/,
  )
  const wrapAt = source.indexOf('const withSuratTracePersistence')
  const region = source.slice(wrapAt, wrapAt + 900)
  // Yazma AWAITED; yanit gonderildikten sonra iz kaybolmaz.
  assert.match(region, /if \(pending\) await pending/)
  // Saklama siniri da uygulanir.
  assert.match(source, /applyTraceRetentionForTenant\(/)
})

test('DEBUG-15: iz yazimi create sonucunu BOZMAZ', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = source.indexOf('async function persistSuratTraceAttempt(')
  const body = source.slice(start, source.indexOf('\n}', start))
  // Tum govde try/catch icinde: debug hatasi create yanitini DUSURMEZ.
  assert.match(body, /try \{/)
  assert.match(body, /\} catch \{/)
})

/* ═══════════════ UI/ROUTE BAĞLAMA ═════════════════════════════════ */

test('DEBUG-16: panel SUNUCUDAN okur, tek dogru kaynak localStorage DEGIL', () => {
  const panel = readFileSync(
    join(here, '..', 'src', 'components', 'SuratLiveDebugPanel.tsx'), 'utf8',
  )
  assert.match(panel, /const TRACES_ENDPOINT = '\/api\/debug\/surat-traces'/)
  assert.match(panel, /fetchServerTraces/)
  // Sunucu okumasi, yerel depodan ONCE gelir.
  assert.match(panel, /traces \?\? serverTraces \?\? readStoredTraces\(\)/)
})

test('DEBUG-17: temizleme dugmesi ve ONAY metni vardir', () => {
  const panel = readFileSync(
    join(here, '..', 'src', 'components', 'SuratLiveDebugPanel.tsx'), 'utf8',
  )
  assert.match(panel, /Tüm Debug Geçmişini Sil/)
  assert.match(panel, /Yalnızca debug kayıtları silinecek/)
  assert.match(panel, /Sipariş, gönderi, barkod ve operasyon kayıtları etkilenmeyecek/)
  // Hem legacy hem v2 yerel anahtar temizlenir.
  assert.match(panel, /removeItem\(TRACE_STORAGE_KEY\)/)
  assert.match(panel, /removeItem\(LEGACY_DEBUG_STORAGE_KEY\)/)
  // Sunucu tarafi da silinir.
  assert.match(panel, /method: 'DELETE'/)
})

test('DEBUG-18: silme ucu OPERASYONEL tabloya dokunmaz', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const at = source.indexOf("app.delete('/api/debug/surat-traces'")
  assert.ok(at > 0, 'silme ucu YOK')
  const body = source.slice(at, at + 1200)
  assert.match(body, /clearTraceAttempts/)
  assert.match(body, /operationalDataDeleted: 0/)
  for (const forbidden of ['deleteOrder', 'orders)', 'shipmentOperations']) {
    assert.equal(body.includes(forbidden), false, forbidden)
  }
})
