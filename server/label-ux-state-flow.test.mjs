import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, and } from 'drizzle-orm'
import { createServer } from 'vite'

// ═══ DAHİLİ HAZIRLIK ≠ KULLANICI İŞ AKIŞI DURUMU ═════════════════════════
//
// ÖLÇÜLEN KUSUR: arka plan worker'ı yeni siparişin taşıyıcı etiketini önceden
// hazırlıyor (kalıcı artefakt). Artefakt doğrulanır doğrulanmaz istemci/sunucu
// projeksiyonu (`withDerivedOperationStatus` → `hasLiveOrtakBarkodShipment`)
// durumu LABEL_READY'ye TÜRETİYOR ve sipariş "Etiket Hazır" görünüyordu.
// Kullanıcı o siparişe HİÇ dokunmamıştı: "Barkod Oluştur'a bastım mı?" sorusu
// UI'dan yanıtlanamıyordu.
//
// YENİ SÖZLEŞME:
//   DAHİLİ hazırlık  → QUEUED/PREPARING/READY/…  (worker; kullanıcı durumu DEĞİL)
//   KULLANICI akışı  → BARKOD_BEKLIYOR → ETIKET_HAZIR → ETIKET_BASILDI
//                      (YALNIZ açık kullanıcı aksiyonu ilerletir)
//
// Canonical sinyal: `orders.user_label_activated_at`. Worker bu alanı
// ÜRETEMEZ (server/shipments/* `orders` tablosuna hiç yazmaz).

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const orderService = await import('./orders/orderPersistenceService.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')

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
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, name, slug) {
  const [org] = await db.insert(schema.organizations).values({ name, slug }).returning()
  return org.id
}
let seq = 0
function makeOrder(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `UX-${seq}`
  return {
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `UXO-${seq}`, marketplaceStatus: 'Created',
    operationStatus: 'NEW', customerFirstName: 'Ada', customerLastName: 'L',
    city: 'İstanbul', district: 'Kadıköy', totalAmount: 100, currency: 'TRY',
    orderDate: '2026-09-01T08:00:00Z', rawOrder: {},
    items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}

// ARKA PLAN HAZIRLIĞININ ÜRETTİĞİ GERÇEK KAYIT ŞEKLİ (index.mjs create record):
// `shipment` alanı YOKTUR; ZPL `technicalZpl`, kimlikler `candidate*` alanında.
// Worker ve manuel yol AYNI create çekirdeğini kullandığı için kayıt şekli de
// aynıdır — bu yüzden "worker hazırladı" senaryosu gerçekçi biçimde kurulur.
function preparedRecord(org, order, over = {}) {
  return {
    idempotencyKey: `SURAT:org_${org}:${order.orderNumber}:CREATE`,
    organizationId: org, marketplace: 'Trendyol', packageId: order.packageId,
    orderNumber: order.orderNumber, orderId: order.orderNumber, provider: 'surat',
    operation: 'OrtakBarkodOlustur', status: 'UNKNOWN', createCallCount: 1,
    completedAt: '2026-09-01T09:00:00Z',
    carrierTrackingNumber: '', carrierBarcodeNumber: '',
    candidateTrackingNumber: '11820824092123', candidateBarcodeNumber: '01252765588',
    ozelKargoTakipNo: '7270039999999',
    technicalZpl: '^XA^FD01252765588^FS^XZ',
    technicalZplSha256: 'a'.repeat(64), technicalZplLength: 24,
    verificationStatus: 'LABEL_CREATED_UNVERIFIED',
    ...over,
  }
}

async function orderIdByPackage(db, org, packageId) {
  const [row] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, packageId)))
  return row?.id
}
async function orderRow(db, org, packageId) {
  const [row] = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, packageId)))
  return row
}

// ── Saf istemci yardımcıları TEK Vite sunucusundan yüklenir (üretim modülleri) ──
const vite = await createServer({
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})
const classification = await vite.ssrLoadModule('/src/utils/orderClassification.ts')
const activation = await vite.ssrLoadModule('/src/utils/labelWorkflowActivation.ts')
const orderStatus = await vite.ssrLoadModule('/src/utils/orderStatus.ts')
test.after(() => vite.close())

/** Üretim projeksiyonunun AYNISI: türetme uygulanmış kullanıcı görünümü. */
function project(order) {
  return orderStatus.withDerivedOperationStatus(order)
}
function stageOf(order) {
  return classification.classifyDashboardOperationStage(project(order))
}

/* ═══ LABEL-UX-STATE-1 ═══════════════════════════════════════════════ */

test('LABEL-UX-STATE-1: yeni siparis, worker kosmadi → BARKOD_BEKLIYOR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org 1', 'ux-1')
  const order = makeOrder({ packageId: 'S1' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  const view = await orderService.getOrder(db, org, await orderIdByPackage(db, org, 'S1'))

  assert.equal(view.userLabelActivatedAt, null, 'aktivasyon damgasi YOK')
  assert.equal(activation.hasPreparedLabelArtifact(view), false, 'artefakt YOK')
  assert.equal(stageOf(view).label, 'Barkod Bekliyor')
})

/* ═══ LABEL-UX-STATE-2 — EN KRİTİK ═══════════════════════════════════ */

test('LABEL-UX-STATE-2: worker artefakti hazirladi → UI HALA BARKOD_BEKLIYOR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org 2', 'ux-2')
  const order = makeOrder({ packageId: 'S2' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  // Arka plan hazırlığı: taşıyıcı artefakt kalıcılaşır.
  await shipmentService.writeOperationRecord(db, org, preparedRecord(org, order))

  const row = await orderRow(db, org, 'S2')
  // Worker `orders` satırına DOKUNMADI.
  assert.equal(row.userLabelActivatedAt, null, 'worker aktivasyon damgasi YAZAMAZ')
  assert.notEqual(row.operationStatus, 'LABEL_READY', 'worker canonical durumu DEGISTIRMEZ')

  const view = await orderService.getOrder(db, org, row.id)
  // DAHİLİ hazırlık GERÇEKTEN tamamlandı — gizlenen şey hazırlık değil,
  // KULLANICI durumudur.
  assert.equal(view.hasPrintableLabel, true, 'kalici basilabilir artefakt VAR')
  assert.equal(activation.hasPreparedLabelArtifact(view), true, 'artefakt HAZIR')
  // ...ama kullanıcı durumu ilerlemedi.
  assert.equal(view.userLabelActivatedAt, null)
  assert.equal(activation.isLabelWorkflowActivated(view), false)
  assert.equal(stageOf(view).label, 'Barkod Bekliyor')
  assert.notEqual(stageOf(view).label, 'Etiket Hazır')

  const tabs = classification.classifyOrderForTabs(project(view))
  assert.equal(tabs.isLabelPrepared, true, 'DAHILI hazirlik gorunur (ops/debug)')
  assert.equal(tabs.isLabelReady, false, 'KULLANICI durumu ilerlemedi')
  assert.equal(tabs.isBarcodeWaiting, true)
})

/* ═══ LABEL-UX-STATE-3 ═══════════════════════════════════════════════ */

test('LABEL-UX-STATE-3: kullanici tiklar → artefakt DEGISMEZ, durum ETIKET_HAZIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org 3', 'ux-3')
  const order = makeOrder({ packageId: 'S3' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, preparedRecord(org, order))
  const id = await orderIdByPackage(db, org, 'S3')

  const before = await orderService.getOrder(db, org, id)
  const shipmentsBefore = await db.select().from(schema.shipments)
  const opsBefore = await db.select().from(schema.shipmentOperations)

  const result = await orderService.markLabelReady(db, org, id)
  assert.equal(result.updated, true)

  const after = await orderService.getOrder(db, org, id)
  const shipmentsAfter = await db.select().from(schema.shipments)
  const opsAfter = await db.select().from(schema.shipmentOperations)

  // ARTEFAKT DELTASI = 0: yeni gönderi yok, ZPL yeniden compose edilmedi,
  // taşıyıcı create sayacı artmadı.
  assert.equal(shipmentsAfter.length, shipmentsBefore.length, 'yeni shipment YOK')
  assert.equal(opsAfter.length, opsBefore.length, 'yeni create operasyonu YOK')
  assert.equal(
    opsAfter[0].createCallCount, opsBefore[0].createCallCount,
    'tasiyici create sayaci ARTMADI',
  )
  assert.equal(after.shipment.barcodeRaw, before.shipment.barcodeRaw, 'ZPL AYNEN durur')

  // Kullanıcı durumu ilerledi.
  assert.ok(after.userLabelActivatedAt, 'aktivasyon damgasi YAZILDI')
  assert.equal(activation.isLabelWorkflowActivated(after), true)
  assert.equal(stageOf(after).label, 'Etiket Hazır')
})

/* ═══ LABEL-UX-STATE-5 ═══════════════════════════════════════════════ */

test('LABEL-UX-STATE-5: hazirlik katmani aktivasyon alanina DOKUNMAZ', () => {
  const workerDir = join(here, 'shipments')
  const offenders = []
  for (const name of readdirSync(workerDir).filter((f) => /\.(ts|mjs)$/.test(f))) {
    if (name.includes('.test.')) continue
    const body = readFileSync(join(workerDir, name), 'utf8')
    if (/userLabelActivatedAt|user_label_activated_at/.test(body)) {
      offenders.push(`${name}: aktivasyon alanina referans`)
    }
  }
  assert.deepEqual(offenders, [], 'hazirlik katmani aktivasyon damgasini GOREMEZ')
})

// Hazırlık katmanının `orders` tablosuna yazan TEK modülü takip mutabakatıdır
// ve YALNIZ ileri taşıyıcı yaşam döngüsü yazar. "Etiket Hazır"/"Etiket Basıldı"
// üretemez; bu yüzden kullanıcı durumunu uyduramaz. Modül listesi ELLE değil
// ÖLÇÜLEREK tutulur: yeni bir yazar eklenirse test KIRILIR.
test('LABEL-UX-STATE-5b: hazirlik katmanindaki tek orders yazari ileri lifecycle yazar', () => {
  const workerDir = join(here, 'shipments')
  const writers = []
  for (const name of readdirSync(workerDir).filter((f) => /\.(ts|mjs)$/.test(f))) {
    if (name.includes('.test.')) continue
    const body = readFileSync(join(workerDir, name), 'utf8')
    if (/update\(\s*orders\s*\)/.test(body)) writers.push(name)
  }
  assert.deepEqual(writers, ['suratTrackingReconciler.ts'])

  // ÖLÇÜM YAZIM İFADESİNE BAĞLANIR, dosyanın tamamına DEĞİL: modül
  // `LABEL_READY`i OKUMA filtresinde (aday kümesi) kullanır; bunu yazım
  // sanmak testi yanlış kırardı. `.set({ operationStatus, ... })`i besleyen
  // ifadedeki literaller ölçülür.
  const body = readFileSync(join(workerDir, 'suratTrackingReconciler.ts'), 'utf8')
  const assignStart = body.indexOf('const operationStatus =')
  assert.ok(assignStart > 0, 'yazim ifadesi bulunamadi')
  const assignment = body.slice(
    assignStart,
    body.indexOf('const database', assignStart),
  )
  const written = [...assignment.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1])
  assert.deepEqual(
    written, ['HANDED_TO_CARGO', 'DELIVERED', 'RETURNING'],
    'takip mutabakati YALNIZ ileri tasiyici lifecycle yazar',
  )
  // `.set(...)` gerçekten yalnız bu değişkeni ve saat alanlarını yazar.
  const setBlock = body.slice(body.indexOf('.set({', assignStart))
  const setFields = setBlock.slice(0, setBlock.indexOf('})'))
  assert.equal(/userLabelActivatedAt/.test(setFields), false)
})

test('LABEL-UX-STATE-5c: aktivasyon damgasinin TEK yazari orderRepository', () => {
  const writers = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|mjs)$/.test(entry.name) || entry.name.includes('.test.')) continue
      const body = readFileSync(full, 'utf8')
      // YAZIM = drizzle `.set({ ... userLabelActivatedAt ... })`
      if (/\.set\(\{[^}]*userLabelActivatedAt/s.test(body)) writers.push(entry.name)
    }
  }
  walk(here)
  assert.deepEqual(writers, ['orderRepository.ts'], 'damgayi baska modul YAZMAZ')
})

/* ═══ LABEL-UX-STATE-6 ═══════════════════════════════════════════════ */

test('LABEL-UX-STATE-6: cift tiklama → TEK mantiksal aktivasyon, damga OYNAMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org 6', 'ux-6')
  const order = makeOrder({ packageId: 'S6' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, preparedRecord(org, order))
  const id = await orderIdByPackage(db, org, 'S6')

  const first = await orderService.markLabelReady(db, org, id)
  const stampAfterFirst = (await orderRow(db, org, 'S6')).userLabelActivatedAt
  const second = await orderService.markLabelReady(db, org, id)
  const stampAfterSecond = (await orderRow(db, org, 'S6')).userLabelActivatedAt

  assert.equal(first.updated, true)
  assert.equal(second.updated, false, 'ikinci tiklama YENI gecis URETMEZ')
  assert.ok(stampAfterFirst, 'ilk tiklama damgayi yazdi')
  assert.deepEqual(stampAfterSecond, stampAfterFirst, 'aktivasyon ani KAYMAZ')
  // Mükerrer gönderi/operasyon doğmadı.
  assert.equal((await db.select().from(schema.shipments)).length, 1)
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 1)
})

/* ═══ LABEL-UX-STATE-7 / 8 ═══════════════════════════════════════════ */

test('LABEL-UX-STATE-7: ETIKET_HAZIR → baski, mevcut PRINTED semantigi DEGISMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org 7', 'ux-7')
  const order = makeOrder({ packageId: 'S7' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, preparedRecord(org, order))
  const id = await orderIdByPackage(db, org, 'S7')

  await orderService.markLabelReady(db, org, id)
  const printed = await orderService.markLabelPrinted(db, org, id)
  assert.equal(printed.updated, true)
  assert.equal(printed.operationStatus, 'LABEL_PRINTED')

  const view = await orderService.getOrder(db, org, id)
  assert.equal(stageOf(view).label, 'Etiket Basıldı')
})

test('LABEL-UX-STATE-8: printedAt varsa arka plan durumundan BAGIMSIZ ETIKET_BASILDI', () => {
  const base = {
    id: 'p1', orderNumber: 'P-1', packageId: 'PK-1', marketplaceStatus: 'Created',
    status: 'Created', customerName: 'X', items: [],
    shipment: {
      provider: 'surat-kargo', dispatchRegistrationConfirmed: true,
      barcodeRaw: '^XA^XZ', barcode: 'BC-1', zplReady: true, printEnabled: true,
    },
    labelStatus: 'PRINTED',
    label: { printedAt: '2026-09-02T10:00:00.000Z' },
  }
  // Aktivasyon damgası YOK — baskı kanıtı TEK BAŞINA yeterlidir.
  assert.equal(activation.resolveLabelWorkflowActivation(base).source, 'printed')
  assert.equal(stageOf(base).label, 'Etiket Basıldı')
})

/* ═══ LABEL-UX-STATE-9 ═══════════════════════════════════════════════ */

test('LABEL-UX-STATE-9: listeleme/projeksiyon artefakt yuzunden AKTIVE ETMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org 9', 'ux-9')
  const orders = [makeOrder({ packageId: 'S9A' }), makeOrder({ packageId: 'S9B' })]
  await orderService.persistSyncResult(db, org, orders, { complete: true })
  for (const order of orders) {
    await shipmentService.writeOperationRecord(db, org, preparedRecord(org, order))
  }
  // Toplu okuma yolu (liste projeksiyonu) DEFALARCA çalışsa da YAZMAZ.
  for (let i = 0; i < 3; i += 1) {
    await orderService.listOrders(db, org, { pageSize: 50 })
  }
  const rows = await db.select().from(schema.orders)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.userLabelActivatedAt, null, `${row.packageId} AKTIVE EDILMEDI`)
    assert.notEqual(row.operationStatus, 'LABEL_READY')
  }
})

/* ═══ GEÇMİŞ VERİ — MİGRASYON GEREKMEZ ═══════════════════════════════ */

test('LABEL-UX-HISTORY-1: eski LABEL_READY kaydi (damgasiz) AKTIVE sayilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org H', 'ux-h')
  const order = makeOrder({ packageId: 'SH' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, preparedRecord(org, order))
  const id = await orderIdByPackage(db, org, 'SH')
  // Kolon EKLENMEDEN ÖNCEKİ gerçek üretim satırı: canonical durum LABEL_READY,
  // damga NULL. O durumu tarihte YALNIZ kullanıcı yolu yazabilmiştir
  // (markOrderLabelReady ← POST /api/orders/:id/label-ready).
  await db.update(schema.orders)
    .set({
      operationStatus: 'LABEL_READY',
      userLabelActivatedAt: null,
      lastOperationalActivityAt: new Date('2026-08-20T12:00:00Z'),
    })
    .where(eq(schema.orders.id, id))

  const view = await orderService.getOrder(db, org, id)
  assert.equal(
    view.userLabelActivatedAt, '2026-08-20T12:00:00.000Z',
    'gecmis aktivasyon OKUMA aninda telafi edilir',
  )
  assert.equal(stageOf(view).label, 'Etiket Hazır', 'gecmis semantik KORUNUR')

  // DB MUTASYONU YOK: telafi yalnız okuma yolundadır.
  const row = await orderRow(db, org, 'SH')
  assert.equal(row.userLabelActivatedAt, null, 'kolon DB tarafinda DEGISMEDI')
})

test('LABEL-UX-HISTORY-2: eski LABEL_PRINTED kaydi ETIKET_BASILDI kalir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org H2', 'ux-h2')
  const order = makeOrder({ packageId: 'SH2' })
  await orderService.persistSyncResult(db, org, [order], { complete: true })
  await shipmentService.writeOperationRecord(db, org, preparedRecord(org, order))
  const id = await orderIdByPackage(db, org, 'SH2')
  await db.update(schema.orders)
    .set({ operationStatus: 'LABEL_PRINTED', userLabelActivatedAt: null })
    .where(eq(schema.orders.id, id))

  const view = await orderService.getOrder(db, org, id)
  assert.equal(stageOf(view).label, 'Etiket Basıldı')
})

/* ═══ KAYIT ═════════════════════════════════════════════════════════════ */

test('LABEL-UX-REG: bu dosya test:surat icinde KAYITLI', () => {
  const registry = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const files = Array.isArray(registry) ? registry : registry.files
  assert.ok(files.includes('server/label-ux-state-flow.test.mjs'))
})
