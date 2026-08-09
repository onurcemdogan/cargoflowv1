import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// TOPLU BASKI HAZIRLIK UCU — AŞAMA 3A / ADIM 2.
//
// SÖZLEŞME
//  - ZPL DÖNMEZ: ne taşıyıcı, ne ek sayfa, ne kaynak, ne ham payload.
//  - SORGU SAYISI GÖNDERİ SAYISINDAN BAĞIMSIZ (N+1 yok).
//  - YALNIZ istenen kimlikler çözülür; org'un tamamı decrypt EDİLMEZ.
//  - YAZMA YOK: hazırlık sorgusu hydration tetiklemez.
//  - Fail-open politikası baskı yoluyla AYNI: taşıyıcı geçerli + ek sayfa
//    çökmüş → carrierPrintReady=true, productDetailStatus='failed'.
//
// Fixture MASKELİDİR; gerçek müşteri verisi içermez.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const repo = await import('./shipments/printZplRepository.ts')
const readiness = await import('./shipments/printReadinessService.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')

const ZPL = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const NOW = '2026-08-09T00:00:00.000Z'
const CANONICAL_TRACKING = '63074185296307'
const CANONICAL_BARCODE = '18529630741'

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
async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return drizzle(pglite, { schema })
}
async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

const item = (overrides = {}) => ({
  productName: 'Scuba Secil Detayli Tesettur Elbise',
  quantity: 1,
  color: 'Lacivert',
  size: '40',
  sku: 'SCUBA-SEC01',
  ...overrides,
})
const distinct = (n) =>
  Array.from({ length: n }, (_, index) =>
    item({ productName: `Urun ${index + 1}`, sku: `SKU-${index + 1}` }),
  )
const monsterItems = (count = 3) =>
  Array.from({ length: count }, (_, index) =>
    item({
      productName: Array.from({ length: 220 }, (_, w) => `Sozcuk${w}`).join(' '),
      sku: `MONSTER-${index + 1}`,
    }),
  )

const payloadOf = (packageId, extra = {}) => ({
  technicalZpl: ZPL,
  orderNumber: `ORD-${packageId}`,
  packageId,
  aliciAdi: 'ARIFE BOLSAGAR',
  ...extra,
})

/**
 * Bir gönderi + (istenirse) sipariş satırları seed eder.
 * `artifactItems` verilirse KALICI artefakt da yazılır.
 */
async function seedShipment(
  db,
  organizationId,
  packageId,
  { artifactItems = null, lineItems = [], identity = {} } = {},
) {
  const payload = artifactItems
    ? repo.attachPrintZplArtifact(payloadOf(packageId), artifactItems, NOW)
    : payloadOf(packageId)
  const [row] = await db
    .insert(schema.shipments)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `ORD-${packageId}`,
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      trackingNumber: CANONICAL_TRACKING,
      barcode: CANONICAL_BARCODE,
      ...identity,
      carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
    })
    .returning()
  if (lineItems.length > 0) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        organizationId,
        marketplace: 'Trendyol',
        packageId,
        orderNumber: `ORD-${packageId}`,
        operationStatus: 'LABEL_READY',
        orderDate: new Date('2026-08-01T00:00:00.000Z'),
      })
      .returning()
    for (const [index, line] of lineItems.entries()) {
      await db.insert(schema.orderLines).values({
        organizationId,
        orderId: order.id,
        externalLineId: `L-${index}`,
        productName: line.productName,
        merchantSku: line.sku ?? null,
        quantity: line.quantity ?? 1,
        variantAttributes: [],
      })
    }
  }
  return row.id
}

/** `select` çağrılarını sayan sarmalayıcı — sorgu bütçesi ölçümü. */
function countingDb(db) {
  const counters = { select: 0, update: 0, insert: 0 }
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'select' || property === 'update' || property === 'insert') {
        counters[property] += 1
        return target[property].bind(target)
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return { proxy, counters }
}

// ═══ READINESS-1: ESKİ TEK SAYFA ARTEFAKT ════════════════════════════════

test('READINESS-1: eski tek sayfa artefakt → taşıyıcı HAZIR', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-1')
  const id = await seedShipment(db, organizationId, 'PKG-1', {
    artifactItems: [item()],
  })
  const [entry] = await readiness.loadPrintReadiness(db, organizationId, [id])
  assert.equal(entry.carrierPrintReady, true)
  assert.equal(entry.printArtifactStatus, 'ready')
  assert.equal(entry.productDetailStatus, 'none')
  assert.equal(entry.labelPageCount, 1)
  assert.equal(entry.productDetailPageCount, 0)
})

// ═══ READINESS-2: TAM PAKET ══════════════════════════════════════════════

test('READINESS-2: tam paket → taşıyıcı + ürün detay HAZIR, sayfa sayıları doğru', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-2')
  const id = await seedShipment(db, organizationId, 'PKG-2', {
    artifactItems: distinct(8),
  })
  const [entry] = await readiness.loadPrintReadiness(db, organizationId, [id])
  assert.equal(entry.carrierPrintReady, true)
  assert.equal(entry.printArtifactStatus, 'ready')
  assert.equal(entry.productDetailStatus, 'ready')
  assert.ok(entry.productDetailPageCount >= 1)
  // Taşıyıcı DAHİL toplam sayfa.
  assert.equal(entry.labelPageCount, entry.productDetailPageCount + 1)

  // Kalıcı kayıtla BİREBİR tutarlı olmalı (hazırlık ≠ tahmin).
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  const artifact = encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
    .printZplArtifact
  assert.equal(entry.productDetailPageCount, artifact.supplementalLabels.length)
})

// ═══ READINESS-3: GEÇİCİ TAŞIYICI FALLBACK ═══════════════════════════════

test('READINESS-3: ek sayfa çökecek + kimlik geçerli → taşıyıcı HAZIR, detay FAILED', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-3')
  const id = await seedShipment(db, organizationId, 'PKG-3', {
    lineItems: monsterItems(3),
  })
  const [entry] = await readiness.loadPrintReadiness(db, organizationId, [id])
  assert.equal(entry.carrierPrintReady, true, 'ana etiket ENGELLENMEZ')
  assert.equal(entry.printArtifactStatus, 'fallback_carrier')
  assert.equal(entry.productDetailStatus, 'failed')
  assert.equal(
    entry.productDetailFailureReason,
    repo.SUPPLEMENTAL_GEOMETRY_FAILURE,
  )
  assert.equal(entry.labelPageCount, 1)
  assert.equal(entry.productDetailPageCount, 0)

  // HAZIRLIK SORGUSU YAZMAZ: artefakt hâlâ yok.
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  assert.equal(
    encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
      ?.printZplArtifact,
    undefined,
  )
})

// ═══ READINESS-4: KİMLİK GEÇERSİZ ════════════════════════════════════════

test('READINESS-4: taşıyıcı kimliği geçersiz → HAZIR DEĞİL', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-4')
  const id = await seedShipment(db, organizationId, 'PKG-4', {
    lineItems: monsterItems(3),
    identity: { trackingNumber: '99999999999999' },
  })
  const [entry] = await readiness.loadPrintReadiness(db, organizationId, [id])
  assert.equal(entry.carrierPrintReady, false, 'yanlış etiket riski → BLOCK')
  assert.equal(entry.printArtifactStatus, 'failed')
  assert.equal(entry.failureReason, 'carrier_identity_mismatch')
  assert.equal(entry.labelPageCount, 0)
})

// ═══ READINESS-5: BOZUK KALICI ARTEFAKT ══════════════════════════════════

test('READINESS-5: bozuk kalıcı artefakt → HAZIR DEĞİL, kaynağa düşülmez', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-5')
  const payload = repo.attachPrintZplArtifact(
    payloadOf('PKG-5'),
    distinct(8),
    NOW,
  )
  payload.printZplArtifact.printZplSha256 = 'f'.repeat(64)
  const [row] = await db
    .insert(schema.shipments)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      packageId: 'PKG-5',
      orderNumber: 'ORD-PKG-5',
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      trackingNumber: CANONICAL_TRACKING,
      barcode: CANONICAL_BARCODE,
      carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
    })
    .returning()
  const [entry] = await readiness.loadPrintReadiness(db, organizationId, [row.id])
  assert.equal(entry.carrierPrintReady, false)
  assert.equal(entry.failureReason, 'artifact_corrupt')

  // Bozuk PAKET (ek sayfa hash'i) de taşıyıcıyı tek başına AÇMAZ.
  const bundlePayload = repo.attachPrintZplArtifact(
    payloadOf('PKG-5B'),
    distinct(8),
    NOW,
  )
  bundlePayload.printZplArtifact.supplementalLabels[0].sha256 = '0'.repeat(64)
  const [row2] = await db
    .insert(schema.shipments)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      packageId: 'PKG-5B',
      orderNumber: 'ORD-PKG-5B',
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      trackingNumber: CANONICAL_TRACKING,
      barcode: CANONICAL_BARCODE,
      carrierPayloadEncrypted: encryption.encryptShipmentPayload(bundlePayload),
    })
    .returning()
  const [entry2] = await readiness.loadPrintReadiness(db, organizationId, [row2.id])
  assert.equal(entry2.carrierPrintReady, false)
  assert.equal(entry2.failureReason, 'bundle_invalid')
})

// ═══ READINESS-6: TOPLU ÇEKİM, N+1 YOK ═══════════════════════════════════

test('READINESS-6: 25 kimlik → sorgu sayısı gönderi sayısından BAĞIMSIZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-6')
  const ids = []
  for (let index = 0; index < 25; index += 1) {
    // Yarısı kalıcı artefaktlı, yarısı artefaktsız (katalog yolu tetiklenir).
    ids.push(
      await seedShipment(db, organizationId, `PKG-6-${index}`, {
        ...(index % 2 === 0
          ? { artifactItems: distinct(3) }
          : { lineItems: distinct(3) }),
      }),
    )
  }
  const { proxy, counters } = countingDb(db)
  const entries = await readiness.loadPrintReadiness(proxy, organizationId, ids)
  assert.equal(entries.length, 25)
  for (const entry of entries) {
    assert.equal(entry.carrierPrintReady, true, entry.shipmentId)
  }
  // 1 gönderi sorgusu + en fazla 3 toplu ürün/katalog sorgusu.
  assert.ok(
    counters.select <= 4,
    `N+1 YOK bekleniyordu, select=${counters.select}`,
  )
  // HAZIRLIK YAZMAZ.
  assert.equal(counters.update, 0)
  assert.equal(counters.insert, 0)
})

test('READINESS-6 ek: hepsi kalıcıysa katalog HİÇ okunmaz', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-6b')
  const ids = []
  for (let index = 0; index < 10; index += 1) {
    ids.push(
      await seedShipment(db, organizationId, `PKG-6B-${index}`, {
        artifactItems: distinct(3),
      }),
    )
  }
  const { proxy, counters } = countingDb(db)
  await readiness.loadPrintReadiness(proxy, organizationId, ids)
  assert.equal(counters.select, 1, 'yalnız gönderi sorgusu')
})

// ═══ READINESS-7: BİLİNMEYEN / BAŞKA ORG ═════════════════════════════════

test('READINESS-7: bilinmeyen ve başka org kimlikleri güvenle elenir', async () => {
  const db = await makeDb()
  const mine = await makeOrg(db, 'readiness-7-mine')
  const other = await makeOrg(db, 'readiness-7-other')
  const myId = await seedShipment(db, mine, 'PKG-7', { artifactItems: [item()] })
  const otherId = await seedShipment(db, other, 'PKG-7X', {
    artifactItems: [item()],
  })
  const unknown = '00000000-0000-4000-8000-000000000000'

  const entries = await readiness.loadPrintReadiness(db, mine, [
    myId,
    otherId,
    unknown,
  ])
  assert.equal(entries.length, 3)
  assert.equal(entries[0].carrierPrintReady, true)
  // Başka org'un gönderisi ile HİÇ OLMAYAN kimlik AYNI cevabı verir:
  // varlık bilgisi sızmaz.
  assert.deepEqual(
    { status: entries[1].failureReason, ready: entries[1].carrierPrintReady },
    { status: 'shipment_not_found', ready: false },
  )
  assert.deepEqual(
    { status: entries[2].failureReason, ready: entries[2].carrierPrintReady },
    { status: 'shipment_not_found', ready: false },
  )

  // Uç, org'u YALNIZ oturumdan alır; istemciden organizationId KABUL ETMEZ.
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const route = source.slice(
    source.indexOf("app.post('/api/orders/print-readiness'"),
  )
  const body = route.slice(0, route.indexOf('\napp.'))
  assert.ok(
    body.includes('requireOrderPersistenceContext'),
    'mevcut auth kapısı kullanılmalı',
  )
  assert.ok(
    body.includes('context.organizationId'),
    'org yalnız auth bağlamından',
  )
  assert.equal(
    /request\.body\??\.organizationId|body\.organizationId/.test(body),
    false,
    'istemciden organizationId KABUL EDİLMEZ',
  )
})

// ═══ READINESS-8: YANITTA ZPL / HAM PAYLOAD YOK ══════════════════════════

test('READINESS-8: yanıt hiçbir ZPL veya ham payload TAŞIMAZ', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-8')
  const ids = [
    await seedShipment(db, organizationId, 'PKG-8A', { artifactItems: distinct(8) }),
    await seedShipment(db, organizationId, 'PKG-8B', { lineItems: monsterItems(3) }),
    await seedShipment(db, organizationId, 'PKG-8C', { artifactItems: [item()] }),
  ]
  const entries = await readiness.loadPrintReadiness(db, organizationId, ids)
  const serialized = JSON.stringify(entries)
  for (const token of ['^XA', '^XZ', '^FD', '^FO', '^FT', '^BC', '^BQ', '^BX']) {
    assert.equal(serialized.includes(token), false, `ZPL sızıntısı: ${token}`)
  }
  // Kaynak/karar alanlarının hiçbiri taşınmaz.
  for (const key of [
    'printZpl',
    'technicalZpl',
    'barcodeRaw',
    'supplementalLabels',
    'zpl',
    'carrierPayloadEncrypted',
    'sourceZpl',
  ]) {
    assert.equal(serialized.includes(key), false, `alan sızıntısı: ${key}`)
  }
  // Kimlik/müşteri değerleri de taşınmaz.
  assert.equal(serialized.includes(CANONICAL_TRACKING), false)
  assert.equal(serialized.includes(CANONICAL_BARCODE), false)
  assert.equal(serialized.includes('ARIFE'), false)

  // Alan kümesi KAPALI: beklenmeyen anahtar eklenirse test düşer.
  const allowed = new Set([
    'shipmentId',
    'carrierPrintReady',
    'printArtifactStatus',
    'productDetailStatus',
    'labelPageCount',
    'productDetailPageCount',
    'failureReason',
    'productDetailFailureReason',
  ])
  for (const entry of entries) {
    for (const key of Object.keys(entry)) {
      assert.ok(allowed.has(key), `beklenmeyen alan: ${key}`)
    }
  }
})

// ═══ READINESS-9: GİRDİ SIRASI DETERMİNİSTİK ═════════════════════════════

test('READINESS-9: yanıt GİRDİ SIRASINI birebir korur', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-9')
  const ids = []
  for (let index = 0; index < 6; index += 1) {
    ids.push(
      await seedShipment(db, organizationId, `PKG-9-${index}`, {
        artifactItems: [item()],
      }),
    )
  }
  for (const order of [ids, [...ids].reverse(), [ids[3], ids[0], ids[5]]]) {
    const entries = await readiness.loadPrintReadiness(db, organizationId, order)
    assert.deepEqual(
      entries.map((entry) => entry.shipmentId),
      order,
    )
  }
  // Boş girdi güvenli.
  assert.deepEqual(await readiness.loadPrintReadiness(db, organizationId, []), [])
})

// ═══ READINESS-10: TEKRARLI KİMLİK ═══════════════════════════════════════

test('READINESS-10: tekrarlı kimlik EK sorgu/şifre çözme üretmez', async () => {
  const db = await makeDb()
  const organizationId = await makeOrg(db, 'readiness-10')
  const id = await seedShipment(db, organizationId, 'PKG-10', {
    artifactItems: distinct(8),
  })
  const repeated = Array.from({ length: 20 }, () => id)
  const { proxy, counters } = countingDb(db)
  const entries = await readiness.loadPrintReadiness(proxy, organizationId, repeated)
  // Her girdi için TAM bir kayıt döner (sıra sözleşmesi korunur)...
  assert.equal(entries.length, 20)
  // ...ama çözüm TEK KEZ yapılır.
  assert.equal(counters.select, 1)
  for (const entry of entries) {
    assert.deepEqual(entry, entries[0], 'tekrarlar aynı sonucu verir')
  }
})

// ═══ SINIR: SESSİZ KIRPMA YOK ════════════════════════════════════════════

test('READINESS-11: kimlik sınırı UI toplu sözleşmesinden türetilir', async () => {
  // En büyük liste sayfa boyutu 100 → görünür sayfa TEK istekte karşılanır.
  assert.equal(readiness.MAX_READINESS_IDS, 100)
  const ordersPage = readFileSync(
    join(here, '..', 'src', 'pages', 'OrdersPage.tsx'),
    'utf8',
  )
  assert.ok(
    ordersPage.includes('[10, 25, 50, 100]'),
    'sınır sayfa boyutu seçeneklerinden TÜRETİLİR (magic number değil)',
  )
  // Sınır aşımı SESSİZCE kırpılmaz, açıkça reddedilir.
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const route = source.slice(
    source.indexOf("app.post('/api/orders/print-readiness'"),
  )
  const body = route.slice(0, route.indexOf('\napp.'))
  assert.ok(body.includes('too_many_ids'))
  assert.equal(/\.slice\(0,\s*MAX_READINESS_IDS\)/.test(body), false)
})
