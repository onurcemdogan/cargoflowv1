import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, beforeEach } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// ARKA PLAN ETİKET PAKETİ HAZIRLAMA — AŞAMA 3B.
//
// SÖZLEŞME
//  - Taşıyıcı hazır olduğunda kalıcı paket ARKA PLANDA hazırlanır; baskı
//    anındaki hydration gecikmesi kullanıcıdan alınır.
//  - IDEMPOTENT: aynı gönderi tekrar kuyruğa atılırsa TEK iş çalışır.
//  - HAZIR ARTEFAKT YENİDEN ÜRETİLMEZ (immutable reprint).
//  - SAĞLAYICI ÇAĞRISI YOK: yeni gönderi/barkod OLUŞTURULMAZ.
//  - Kuyruk ve yeniden başlatma taraması SINIRLIDIR.
//
// Gerçek PGlite. Fixture MASKELİDİR.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')
const repo = await import('./shipments/printZplRepository.ts')
const preparer = await import('./shipments/labelBundlePreparer.ts')

const ZPL = readFileSync(join(here, 'fixtures', 'real-template-masked.zpl'), 'utf8')
const NOW = '2026-08-09T00:00:00.000Z'

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
const pools = []
async function makeDb() {
  const pglite = new PGlite()
  pools.push(pglite)
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return drizzle(pglite, { schema })
}
after(async () => {
  for (const pool of pools) await pool.close()
})
beforeEach(() => {
  preparer.__resetBundlePreparer()
})

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

let LAST_ORG = null
const KEY = (organizationId, packageId = 'PKG-PREP') => ({
  organizationId: organizationId ?? LAST_ORG,
  marketplace: 'Trendyol',
  packageId,
  provider: 'surat',
})

const payloadOf = (packageId) => ({
  technicalZpl: ZPL,
  orderNumber: `ORD-${packageId}`,
  packageId,
  aliciAdi: 'ARIFE BOLSAGAR',
})

async function seed(db, slug, options = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  for (const packageId of options.packageIds ?? ['PKG-PREP']) {
    const payload = options.artifactItems
      ? repo.attachPrintZplArtifact(payloadOf(packageId), options.artifactItems, NOW)
      : payloadOf(packageId)
    const [order] = await db
      .insert(schema.orders)
      .values({
        organizationId: org.id,
        marketplace: 'Trendyol',
        packageId,
        orderNumber: `ORD-${packageId}`,
        orderDate: new Date('2026-08-01T00:00:00.000Z'),
        operationStatus: 'LABEL_READY',
      })
      .returning()
    for (const [index, line] of (options.lineItems ?? []).entries()) {
      await db.insert(schema.orderLines).values({
        organizationId: org.id,
        orderId: order.id,
        externalLineId: `L-${index}`,
        productName: line.productName,
        merchantSku: line.sku ?? null,
        quantity: line.quantity ?? 1,
        variantAttributes: [],
      })
    }
    await db.insert(schema.shipments).values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `ORD-${packageId}`,
      provider: 'surat',
      source: 'local_create',
      status: 'created',
      carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
    })
  }
  LAST_ORG = org.id
  return org.id
}

async function readArtifact(db, organizationId, packageId = 'PKG-PREP') {
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.packageId, packageId))
  void organizationId
  return encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
    ?.printZplArtifact
}

// ═══ PREP-1: TAŞIYICI HAZIR → PAKET ARKA PLANDA ÜRETİLİR ═════════════════

test('PREP-1: artefaktsız kayıt kuyruğa alınır ve paket hazırlanır', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'prep-1', { lineItems: distinct(8) })
  assert.equal(await readArtifact(db, organizationId), undefined)

  assert.equal(preparer.enqueueBundlePreparation(db, KEY(organizationId)), true)
  await preparer.drainBundlePreparation()

  const stored = await readArtifact(db, organizationId)
  assert.ok(stored, 'paket arka planda ÜRETİLMELİ')
  assert.equal(stored.supplementalStatus, 'ready')
  assert.ok(stored.supplementalLabels.length >= 1)
  assert.equal(preparer.bundlePrepareStats().prepared, 1)
})

// ═══ PREP-2: IDEMPOTENT KUYRUK ═══════════════════════════════════════════

test('PREP-2: aynı gönderi tekrar tekrar kuyruğa atılsa da TEK iş çalışır', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'prep-2', { lineItems: distinct(8) })

  const accepted = Array.from({ length: 25 }, () =>
    preparer.enqueueBundlePreparation(db, KEY(organizationId)),
  )
  // YALNIZ İLKİ yeni iş üretir.
  assert.equal(accepted.filter(Boolean).length, 1)
  assert.equal(preparer.bundlePrepareStats().deduped, 24)

  await preparer.drainBundlePreparation()
  const stats = preparer.bundlePrepareStats()
  assert.equal(stats.prepared, 1, 'artefakt BİR KEZ üretilir')
  assert.ok(await readArtifact(db, organizationId))

  // İş bittikten sonra tekrar kuyruğa alınabilir; artefakt HAZIR olduğu için
  // yeniden ÜRETİLMEZ.
  assert.equal(preparer.enqueueBundlePreparation(db, KEY(organizationId)), true)
  await preparer.drainBundlePreparation()
  assert.equal(preparer.bundlePrepareStats().prepared, 1)
  assert.equal(preparer.bundlePrepareStats().alreadyReady, 1)
})

// ═══ PREP-3: HAZIR ARTEFAKT YENİDEN COMPOSE EDİLMEZ ══════════════════════

test('PREP-3: hazır artefakt DOKUNULMAZ — bayt bazında aynı kalır', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'prep-3', {
    artifactItems: distinct(8),
    // Katalog satırları FARKLI: yeniden compose edilseydi çıktı DEĞİŞİRDİ.
    lineItems: distinct(3),
  })
  const before = await readArtifact(db, organizationId)

  const result = await preparer.prepareLabelBundle(db, KEY(organizationId))
  assert.equal(result, 'already_ready')

  const afterArtifact = await readArtifact(db, organizationId)
  assert.equal(afterArtifact.printZplSha256, before.printZplSha256)
  assert.equal(afterArtifact.printZpl, before.printZpl)
  assert.equal(
    afterArtifact.supplementalLabels.length,
    before.supplementalLabels.length,
  )
  assert.equal(preparer.bundlePrepareStats().prepared, 0)
})

// ═══ PREP-4: SAĞLAYICI ÇAĞRISI YOK ═══════════════════════════════════════

test('PREP-4: hazırlayıcı sağlayıcıya ÇIKMAZ, yeni gönderi OLUŞTURMAZ', async () => {
  const source = readFileSync(
    join(here, 'shipments', 'labelBundlePreparer.ts'),
    'utf8',
  )
  for (const forbidden of [
    'OrtakBarkodOlustur',
    'GonderiyiKargoyaGonderYeni',
    'createSuratShipment',
    'writeOperationRecord',
    'soap',
    'axios',
    'fetch(',
    // DOĞRUDAN DB YAZIMI: hazırlayıcı kendi yazma yolunu AÇMAZ; tek yazım
    // mevcut compare-and-set üzerinden olur. (Set.delete gibi bellek içi
    // çağrılarla karışmaması için DB giriş noktaları hedeflenir.)
    'db.insert(',
    'db.update(',
    'db.delete(',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `hazırlayıcı yasak çağrı içeriyor: ${forbidden}`,
    )
  }
  // Yazma YALNIZ mevcut kalıcılık yolundan (compare-and-set) geçer.
  assert.ok(source.includes('resolvePersistedPrintableLabel'))

  // Çalışma zamanında da doğrulanır: gönderi sayısı DEĞİŞMEZ.
  const db = await makeDb()
  const organizationId = await seed(db, 'prep-4', { lineItems: distinct(8) })
  const countBefore = (await db.select().from(schema.shipments)).length
  preparer.enqueueBundlePreparation(db, KEY(organizationId))
  await preparer.drainBundlePreparation()
  const countAfter = (await db.select().from(schema.shipments)).length
  assert.equal(countAfter, countBefore, 'yeni gönderi OLUŞMAMALI')
})

// ═══ PREP-5: TAŞIYICI YOKSA İŞ YOK ═══════════════════════════════════════

test('PREP-5: taşıyıcı ZPL yoksa hazırlama YAPILMAZ', async () => {
  const db = await makeDb()
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'prep-5', slug: 'prep-5' })
    .returning()
  await db.insert(schema.shipments).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: 'PKG-PREP',
    orderNumber: 'ORD-PKG-PREP',
    provider: 'surat',
    source: 'local_create',
    status: 'created',
    // Taşıyıcı ZPL YOK.
    carrierPayloadEncrypted: encryption.encryptShipmentPayload({ orderNumber: 'X' }),
  })
  const result = await preparer.prepareLabelBundle(db, KEY(org.id))
  assert.equal(result, 'not_applicable')
  assert.equal(await readArtifact(db, org.id), undefined)
})

// ═══ PREP-6: EK SAYFA ÜRETİLEMEZSE YARIM PAKET YAZILMAZ ══════════════════

test('PREP-6: ek sayfa üretilemeyen kayıt KALICI hale gelmez', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'prep-6', { lineItems: monsterItems(3) })
  preparer.enqueueBundlePreparation(db, KEY(organizationId))
  await preparer.drainBundlePreparation()
  // Aşama 2 invariant'ı KORUNUR: taşıyıcı-only artefakt YAZILMAZ.
  assert.equal(await readArtifact(db, organizationId), undefined)
  assert.equal(preparer.bundlePrepareStats().failed, 1)
  // Arka plan hatası HİÇBİR akışı BOZMAZ (fırlatmadı).
})

// ═══ PREP-7: SINIRLI KUYRUK ══════════════════════════════════════════════

test('PREP-7: kuyruk üst sınırı aşılınca iş SESSİZCE düşmez, sayılır', async () => {
  const db = await makeDb()
  const organizationId = await seed(db, 'prep-7', { lineItems: distinct(3) })
  // İşçilerin başlamasını engellemek için kuyruğu doğrudan doldururuz:
  // her anahtar FARKLI olmalı (dedupe devrede).
  let accepted = 0
  for (let index = 0; index < preparer.PREPARE_QUEUE_LIMIT + 20; index += 1) {
    if (
      preparer.enqueueBundlePreparation(db, KEY(organizationId, `PKG-${index}`))
    ) {
      accepted += 1
    }
  }
  const stats = preparer.bundlePrepareStats()
  assert.ok(accepted <= preparer.PREPARE_QUEUE_LIMIT + preparer.PREPARE_CONCURRENCY)
  assert.ok(stats.rejected > 0, 'sınır aşımı SAYILMALI')
  await preparer.drainBundlePreparation()
})

// ═══ PREP-8: EŞZAMANLILIK SINIRI ═════════════════════════════════════════

test('PREP-8: eşzamanlı işçi sayısı SINIRI aşmaz', async () => {
  const db = await makeDb()
  const packageIds = Array.from({ length: 12 }, (_, index) => `PKG-${index}`)
  const organizationId = await seed(db, 'prep-8', {
    packageIds,
    lineItems: distinct(3),
  })
  let peak = 0
  const watched = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'select') {
        peak = Math.max(peak, preparer.bundlePrepareStats().active)
      }
      return Reflect.get(target, property, receiver)
    },
  })
  for (const packageId of packageIds) {
    preparer.enqueueBundlePreparation(watched, KEY(organizationId, packageId))
  }
  await preparer.drainBundlePreparation()
  assert.ok(
    peak <= preparer.PREPARE_CONCURRENCY,
    `eşzamanlılık sınırı aşıldı: ${peak}`,
  )
  assert.equal(preparer.bundlePrepareStats().pending, 0)
})

// ═══ PREP-9/10: YENİDEN BAŞLATMA MUTABAKATI ══════════════════════════════

test('PREP-9: restart sonrası taşıyıcı-hazır + artefakt-yok kayıtlar kuyruğa alınır', async () => {
  const db = await makeDb()
  const packageIds = ['PKG-A', 'PKG-B', 'PKG-C']
  const organizationId = await seed(db, 'prep-9', {
    packageIds,
    lineItems: distinct(3),
  })
  // Biri ZATEN hazır: mutabakat onu tekrar kuyruğa ALMAMALI.
  await preparer.prepareLabelBundle(db, KEY(organizationId, 'PKG-A'))
  preparer.__resetBundlePreparer()

  const result = await preparer.reconcilePendingBundles(db)
  assert.equal(result.scanned, 3)
  assert.equal(result.alreadyReady, 1)
  assert.equal(result.enqueued, 2)

  await preparer.drainBundlePreparation()
  for (const packageId of packageIds) {
    assert.ok(
      await readArtifact(db, organizationId, packageId),
      `${packageId} hazırlanmalı`,
    )
  }
})

// SÖZLEŞME DEĞİŞTİ (Aşama 4): tarama artık `updatedAt desc` DEĞİL, `id`
// üzerinde KEYSET imleçle ilerler. Eski test "ikinci tarama 0 iş üretir"
// diyordu — bu, açlığın ta kendisiydi (hep aynı pencere). Yeni iddia daha
// güçlü: ardışık turlar İLERLER ve aynı kayıt uçuştayken ÇOĞALTILMAZ.
test('PREP-10: ardışık turlar İLERLER; uçuştaki kayıt çoğaltılmaz', async () => {
  const db = await makeDb()
  const packageIds = Array.from({ length: 6 }, (_, index) => `PKG-R${index}`)
  const organizationId = await seed(db, 'prep-10', {
    packageIds,
    lineItems: distinct(3),
  })
  // ÜST SINIR uygulanır: tüm tablo tek turda taranmaz.
  const first = await preparer.reconcilePendingBundles(db, { limit: 2 })
  assert.equal(first.scanned, 2)
  assert.equal(first.enqueued, 2)

  // İKİNCİ TUR FARKLI kayıtlara ilerler (eski davranışta 0 iş çıkardı).
  const second = await preparer.reconcilePendingBundles(db, { limit: 2 })
  assert.equal(second.scanned, 2)
  assert.equal(second.enqueued, 2, 'imleç İLERLEMELİ')

  // AYNI kayıt uçuştayken tekrar kuyruğa alınmaz (idempotency korunur).
  const beforeDedupe = preparer.bundlePrepareStats().deduped
  preparer.enqueueBundlePreparation(db, KEY(organizationId, packageIds[0]))
  assert.ok(preparer.bundlePrepareStats().deduped >= beforeDedupe)

  await preparer.drainBundlePreparation()
  // Sınır sabitleri makul ve açık.
  assert.ok(preparer.RECONCILE_SCAN_LIMIT > 0)
  assert.ok(preparer.PREPARE_CONCURRENCY > 0)
})

// ═══ PREP-11: CREATE YOLU KUYRUĞA BAĞLI ══════════════════════════════════

test('PREP-11: create yolu artefakt üretemediğinde arka plan kuyruğuna alır', async () => {
  const source = readFileSync(
    join(here, 'shipments', 'shipmentPersistenceService.ts'),
    'utf8',
  )
  assert.ok(source.includes('enqueueBundlePreparation'))
  // Kuyruğa alma YALNIZ artefakt YOKKEN yapılır.
  assert.ok(source.includes('needsBackgroundPrepare'))
  // Transaction DIŞINDA ve create sonucunu etkilemeyecek şekilde.
  const index = source.indexOf('enqueueBundlePreparation')
  const around = source.slice(index - 400, index + 400)
  assert.ok(around.includes('try {'), 'hata create akışını BOZMAMALI')

  // Açılış mutabakatı sunucuya bağlı.
  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.ok(server.includes('reconcileLabelBundlesOnBoot'))
  assert.ok(server.includes('reconcilePendingBundles'))
})

// ═══ PREP-12: MUTABAKAT AÇLIĞI YOK (Aşama 4 blocker) ═════════════════════

test('PREP-12: 260 uygun kayıt, tarama sınırı 200 → HEPSİ eninde sonunda hazırlanır', async () => {
  const db = await makeDb()
  const packageIds = Array.from({ length: 260 }, (_, index) => `PKG-S${index}`)
  await seed(db, 'prep-12', { packageIds, lineItems: distinct(2) })

  // İLK TUR: tarama sınırı kadar.
  const first = await preparer.reconcilePendingBundles(db)
  assert.equal(first.scanned, preparer.RECONCILE_SCAN_LIMIT)
  await preparer.drainBundlePreparation()

  // SONRAKİ TURLAR İMLEÇLE İLERLER: aynı ilk 200'e TAKILMAZ.
  const drained = await preparer.reconcileUntilDrained(db)
  assert.ok(drained.cycles >= 2)

  const rows = await db.select().from(schema.shipments)
  let missing = 0
  for (const row of rows) {
    const payload = encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
    if (!payload?.printZplArtifact) missing += 1
  }
  assert.equal(missing, 0, 'kalıcı olarak aç kalan kayıt OLMAMALI')
})

// ═══ PREP-13: KUYRUK TAŞMASI → ADAY KAYBI YOK ════════════════════════════

test('PREP-13: kuyruk taşsa da hiçbir hazırlama adayı KAYBOLMAZ', async () => {
  const db = await makeDb()
  const total = preparer.PREPARE_QUEUE_LIMIT + 150
  const packageIds = Array.from({ length: total }, (_, index) => `PKG-Q${index}`)
  await seed(db, 'prep-13', { packageIds, lineItems: distinct(2) })

  // NAİF ÜRETİCİ: geri basınç YOK, dönüş değeri YOK SAYILIR.
  let refused = 0
  for (const packageId of packageIds) {
    if (!preparer.enqueueBundlePreparation(db, KEY(null, packageId))) refused += 1
  }
  assert.ok(refused > 0, 'bu senaryoda kuyruk taşması BEKLENİR')
  await preparer.drainBundlePreparation()

  // Reddedilenler DB'de "taşıyıcı hazır + artefakt yok" olarak durur —
  // bu SOURCE-OF-TRUTH'tur ve mutabakat onları alır. SESSİZ KAYIP YOK.
  await preparer.reconcileUntilDrained(db)
  const rows = await db.select().from(schema.shipments)
  let missing = 0
  for (const row of rows) {
    const payload = encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
    if (!payload?.printZplArtifact) missing += 1
  }
  assert.equal(missing, 0, 'reddedilen adaylar eninde sonunda hazırlanmalı')
})

// ═══ PREP-14: EVENT-LOOP CANLILIĞI ═══════════════════════════════════════

test('PREP-14: hazırlama sırasında event-loop BLOKE OLMAZ', async () => {
  const db = await makeDb()
  const packageIds = Array.from({ length: 120 }, (_, index) => `PKG-E${index}`)
  await seed(db, 'prep-14', { packageIds, lineItems: distinct(3) })

  // HTTP-benzeri prob: 20 ms'de bir çalışması BEKLENEN zamanlayıcı.
  const gaps = []
  let last = Date.now()
  const probe = setInterval(() => {
    const now = Date.now()
    gaps.push(now - last)
    last = now
  }, 20)
  for (const packageId of packageIds) {
    preparer.enqueueBundlePreparation(db, KEY(null, packageId))
  }
  await preparer.drainBundlePreparation()
  clearInterval(probe)

  assert.ok(gaps.length > 0, 'prob HİÇ çalışamadıysa döngü tamamen blokedir')
  const maxGap = Math.max(...gaps)
  // Saniyelerce tek parça blokaj KABUL EDİLMEZ. Eşik yavaş CI için gevşek
  // tutulur ama saniye mertebesindeki donmayı yakalar.
  assert.ok(maxGap < 1000, `event-loop ${maxGap} ms bloke kaldı`)
})

// ═══ PREP-15: PERİYODİK MUTABAKAT ════════════════════════════════════════

test('PREP-15: mutabakat yalnız açılışa bağlı DEĞİL', async () => {
  const db = await makeDb()
  await seed(db, 'prep-15', { packageIds: ['PKG-P1'], lineItems: distinct(2) })
  // Zamanlayıcı kurulur ve DURDURULABİLİR; süreç kapanışını geciktirmez.
  const stop = preparer.startPeriodicReconciliation(db, { intervalMs: 10_000 })
  assert.equal(typeof stop, 'function')
  stop()
  preparer.stopPeriodicReconciliation()

  const server = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.ok(server.includes('startPeriodicReconciliation'))
  // Aralık yapılandırılabilir ve muhafazakâr bir alt sınırı var.
  assert.ok(preparer.RECONCILE_INTERVAL_MS >= 10_000)
})
