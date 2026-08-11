import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// SSP FIZIKSEL KABUL → "KARGOYA VERILDI" MUTABAKATI (hermetik).
//
// GOLDEN URETIM VAKASI (PII YOK — yalniz teknik kimlikler):
//   orderNumber 11493372619 · packageId 4065907241
//   T.No 25112970143170 · carrier barcode 01257551161
//   marketplace tracking 7270035639180935
//   BEFORE: marketplaceStatus=Picking,
//           lifecycleStatus=LABEL_READY_AWAITING_ACCEPTANCE,
//           candidateVerificationStatus=PREASSIGNED_AWAITING_ACCEPTANCE
//
// Bu paket YENI durum haritasi EKLEMEZ: mevcut mapSuratCarrierStatus
// oldugu gibi kullanilir. ZPL/QR/DataMatrix/Code128/T.No/composer KAPSAM DISI.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const reconciler = await import('./shipments/suratTrackingReconciler.ts')
const retention = await import('./orders/orderRetention.ts')

const { orders, shipments, organizations } = schema

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
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Test Org', slug: `org-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  return { db, organizationId: org.id }
}

const NOW = new Date('2026-08-11T12:00:00.000Z')

// ── GOLDEN KIMLIKLER ────────────────────────────────────────────────────────
const GOLDEN = {
  orderNumber: '11493372619',
  packageId: '4065907241',
  tNo: '25112970143170',
  carrierBarcode: '01257551161',
  marketplaceTracking: '7270035639180935',
}

let sequence = 0
async function seedOrder(db, organizationId, overrides = {}, withShipment = true) {
  sequence += 1
  const packageId = overrides.packageId ?? `PKG-${sequence}`
  const [row] = await db
    .insert(orders)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: overrides.orderNumber ?? `ORD-${sequence}`,
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      orderDate: NOW,
      ...overrides,
    })
    .returning({ id: orders.id, packageId: orders.packageId })
  if (withShipment) {
    await db.insert(shipments).values({
      organizationId,
      marketplace: 'Trendyol',
      packageId,
      provider: 'surat-kargo',
      source: 'local_create',
      status: 'CREATED',
      trackingNumber: overrides.tNo ?? GOLDEN.tNo,
      barcode: overrides.carrierBarcode ?? GOLDEN.carrierBarcode,
    })
  }
  return row
}

const policy = () => reconciler.resolveTrackingReconcilePolicy({})

/** Taşıyıcı yanıtı üretici (PII YOK). */
const snapshot = (kargonunDurumuSayi, gonderilerLength = 1, ok = true) => ({
  ok,
  gonderilerLength,
  kargonunDurumuSayi,
  trackingNumber: GOLDEN.tNo,
  sonHareketTarihi: '2026-08-11T11:30:00.000Z',
})

async function runCycle(db, queryCarrier) {
  return reconciler.reconcileSuratTracking(
    db,
    policy(),
    queryCarrier,
    (decision) => reconciler.applyTrackingDecision(db, decision, NOW),
  )
}

const stageOf = async (db, orderId) => {
  const rows = await db
    .select({
      operationStatus: orders.operationStatus,
      marketplaceStatus: orders.marketplaceStatus,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
  return rows[0]
}

// ═══ GOLDEN ═══════════════════════════════════════════════════════════════

test('SSP-GOLDEN-1: BEFORE — Picking + kabul kaniti YOK → handedToCargo FALSE', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    orderNumber: GOLDEN.orderNumber,
    packageId: GOLDEN.packageId,
  })
  // Kabul oncesi tasiyici: gonderi kaydi YOK.
  const report = await runCycle(db, async () => snapshot(null, 0))
  assert.equal(report.handedToCargo, 0)
  const state = await stageOf(db, order.id)
  assert.equal(state.operationStatus, 'LABEL_PRINTED', 'Etiket Basildi KALIR')
  assert.equal(state.marketplaceStatus, 'Picking')
})

test('SSP-GOLDEN-2: AFTER — kabul sonrasi shipped kodu → handedToCargo TRUE', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    orderNumber: GOLDEN.orderNumber,
    packageId: GOLDEN.packageId,
  })
  // Gonderiler=1 VE tasiyici hareket kodu (2 = Transfer Merkezinde).
  const report = await runCycle(db, async () => snapshot('2', 1))
  assert.equal(report.handedToCargo, 1)
  const state = await stageOf(db, order.id)
  assert.equal(state.operationStatus, 'HANDED_TO_CARGO')
  // TRENDYOL SAHTE SHIPPED YAPILMAZ.
  assert.equal(state.marketplaceStatus, 'Picking')
})

// ═══ POLL ═════════════════════════════════════════════════════════════════

test('SSP-POLL-1: LABEL_PRINTED + yerel Surat gonderisi → aday', async () => {
  const { db, organizationId } = await makeDb()
  await seedOrder(db, organizationId)
  const candidates = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidates.length, 1)
})

test('SSP-POLL-1b: yerel Surat gonderisi YOKSA aday DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  await seedOrder(db, organizationId, {}, false)
  const candidates = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidates.length, 0, 'tasiyici kaydi olmayana sorgu YOK')
})

test('SSP-POLL-2: KargonunDurumuSayi=1 → labelPrinted KALIR', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId)
  const report = await runCycle(db, async () => snapshot('1', 1))
  assert.equal(report.handedToCargo, 0)
  assert.equal(report.unchanged, 1)
  const state = await stageOf(db, order.id)
  assert.equal(state.operationStatus, 'LABEL_PRINTED')
})

test('SSP-POLL-3: shipped kodlarinin TAMAMI kargoya verildi uretir', async () => {
  for (const code of ['2', '3', '4', '5', '7', '11']) {
    const { db, organizationId } = await makeDb()
    const order = await seedOrder(db, organizationId)
    await runCycle(db, async () => snapshot(code, 1))
    const state = await stageOf(db, order.id)
    assert.equal(state.operationStatus, 'HANDED_TO_CARGO', `kod ${code}`)
  }
})

test('SSP-POLL-4: zaten handedToCargo/delivered → aday DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  await seedOrder(db, organizationId, { operationStatus: 'HANDED_TO_CARGO' })
  await seedOrder(db, organizationId, { operationStatus: 'DELIVERED' })
  const candidates = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidates.length, 0)
})

test('SSP-POLL-5: pazaryeri terminal (Delivered/Cancelled/Returned) → aday DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  for (const marketplaceStatus of [
    'Delivered',
    'Cancelled',
    'Returned',
    'Shipped',
  ]) {
    await seedOrder(db, organizationId, { marketplaceStatus })
  }
  const candidates = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidates.length, 0, 'pazaryeri onceligi korunur')
})

test('SSP-POLL-5b: teslim/iade kodu geriye DUSURMEZ (no-regress)', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    operationStatus: 'DELIVERED',
  })
  // Aday olmasa da dogrudan karar uygulansa bile geriye dusurmemeli.
  await reconciler.applyTrackingDecision(
    db,
    {
      orderId: order.id,
      handedToCargo: true,
      delivered: false,
      returning: false,
      carrierStatusCode: '2',
      applied: true,
      reason: 'handed_to_cargo',
    },
    NOW,
  )
  const state = await stageOf(db, order.id)
  assert.equal(state.operationStatus, 'DELIVERED', 'no-regress')
})

test('SSP-POLL-6: sorgu hatasi mevcut durumu KORUR, digerleri devam eder', async () => {
  const { db, organizationId } = await makeDb()
  const failing = await seedOrder(db, organizationId)
  const healthy = await seedOrder(db, organizationId)
  let call = 0
  const report = await runCycle(db, async () => {
    call += 1
    if (call === 1) throw new Error('tasiyici erisilemedi')
    return snapshot('3', 1)
  })
  assert.equal(report.failed, 1)
  assert.equal(report.handedToCargo, 1, 'diger adaylar etkilenmez')
  const failedState = await stageOf(db, failing.id)
  const healthyState = await stageOf(db, healthy.id)
  const statuses = [failedState.operationStatus, healthyState.operationStatus]
  assert.ok(statuses.includes('LABEL_PRINTED'))
  assert.ok(statuses.includes('HANDED_TO_CARGO'))
})

test('SSP-POLL-7: bilinmeyen kod → FAIL-SAFE, degisiklik YOK', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId)
  const report = await runCycle(db, async () => snapshot('999', 1))
  assert.equal(report.handedToCargo, 0)
  assert.equal(report.unchanged, 1)
  assert.equal((await stageOf(db, order.id)).operationStatus, 'LABEL_PRINTED')
})

test('SSP-POLL-8: Gonderiler=0 TEK BASINA kargoya verildi URETMEZ', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId)
  const report = await runCycle(db, async () => snapshot('2', 0))
  assert.equal(report.handedToCargo, 0, 'gonderi kaydi yoksa kanit yok')
  assert.equal((await stageOf(db, order.id)).operationStatus, 'LABEL_PRINTED')
})

test('SSP-NEGATIVE: shipment created / Gonderiler>0 TEK BASINA yetmez', async () => {
  // decideFromCarrierSnapshot saf sozlesmesi.
  const candidate = {
    orderId: 'o1',
    organizationId: 'org',
    marketplace: 'Trendyol',
    packageId: GOLDEN.packageId,
  }
  // Gonderiler=1 ama kod 1 (hazirlaniyor) → KABUL DEGIL.
  const preparing = reconciler.decideFromCarrierSnapshot(
    candidate,
    snapshot('1', 1),
  )
  assert.equal(preparing.handedToCargo, false)
  assert.equal(preparing.reason, 'not_shipped_yet')
  // Yanit yok → degisiklik yok.
  const missing = reconciler.decideFromCarrierSnapshot(candidate, null)
  assert.equal(missing.applied, false)
  assert.equal(missing.reason, 'no_response')
})

// ═══ IDENTITY ═════════════════════════════════════════════════════════════

test('SSP-IDENTITY-1: aday dogru (org, marketplace, packageId) ile eslenir', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    orderNumber: GOLDEN.orderNumber,
    packageId: GOLDEN.packageId,
  })
  const [candidate] = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidate.orderId, order.id)
  assert.equal(candidate.packageId, GOLDEN.packageId)
  assert.equal(candidate.marketplace, 'Trendyol')
  // 727 pazaryeri takip numarasi tasiyici kimligi OLARAK KULLANILMAZ.
  assert.notEqual(candidate.packageId, GOLDEN.marketplaceTracking)
})

test('SSP-IDENTITY-2: karar YALNIZ kendi orderId sine uygulanir', async () => {
  const { db, organizationId } = await makeDb()
  const target = await seedOrder(db, organizationId)
  const other = await seedOrder(db, organizationId)
  await reconciler.applyTrackingDecision(
    db,
    {
      orderId: target.id,
      handedToCargo: true,
      delivered: false,
      returning: false,
      carrierStatusCode: '2',
      applied: true,
      reason: 'handed_to_cargo',
    },
    NOW,
  )
  assert.equal((await stageOf(db, target.id)).operationStatus, 'HANDED_TO_CARGO')
  assert.equal((await stageOf(db, other.id)).operationStatus, 'LABEL_PRINTED')
})

// ═══ REFRESH / PERSISTENCE ════════════════════════════════════════════════

// SSP-REFRESH-1 (asama yeniden hesabi) vite yukleyicisi gerektirdigi icin
// server/marketplace-status-source-flow.test.mjs icinde kilitlenir.

test('SSP-REFRESH-2: karar KALICI yazilir (reload sonrasi korunur)', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId)
  await runCycle(db, async () => snapshot('4', 1))
  // "Reload": yeni okuma, ayni DB.
  const rows = await db
    .select({
      operationStatus: orders.operationStatus,
      activity: orders.lastOperationalActivityAt,
      marketplaceStatus: orders.marketplaceStatus,
    })
    .from(orders)
    .where(eq(orders.id, order.id))
  assert.equal(rows[0].operationStatus, 'HANDED_TO_CARGO')
  assert.ok(rows[0].activity, 'operasyon aktivitesi damgalanir')
  assert.equal(rows[0].marketplaceStatus, 'Picking', 'pazaryeri DOKUNULMAZ')
})

// ═══ LOAD ═════════════════════════════════════════════════════════════════

test('SSP-LOAD-1/4: 1000 aday / batch 50 → sinirli turlarla HEPSI islenir', async () => {
  const { db, organizationId } = await makeDb()
  const values = []
  const shipmentValues = []
  for (let index = 0; index < 1000; index += 1) {
    const packageId = `BULK-${index}`
    values.push({
      organizationId,
      marketplace: 'Trendyol',
      packageId,
      orderNumber: `BULK-ORD-${index}`,
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      orderDate: NOW,
    })
    shipmentValues.push({
      organizationId,
      marketplace: 'Trendyol',
      packageId,
      provider: 'surat-kargo',
      source: 'local_create',
      status: 'CREATED',
    })
  }
  await db.insert(orders).values(values)
  await db.insert(shipments).values(shipmentValues)

  let processed = 0
  for (let cycle = 0; cycle < 40; cycle += 1) {
    const report = await runCycle(db, async () => snapshot('3', 1))
    if (report.scanned === 0) break
    assert.ok(report.scanned <= 50, 'batch siniri asilmaz')
    processed += report.handedToCargo
  }
  assert.equal(processed, 1000, 'starvation YOK')
})

test('SSP-LOAD-2: eszamanlilik siniri asilmaz', async () => {
  const { db, organizationId } = await makeDb()
  for (let index = 0; index < 20; index += 1) {
    await seedOrder(db, organizationId)
  }
  let active = 0
  let peak = 0
  await runCycle(db, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return snapshot('2', 1)
  })
  assert.ok(peak <= policy().concurrency, `es zamanli sorgu tavani: ${peak}`)
})

test('SSP-LOAD-POLICY: varsayilanlar ve env yapilandirmasi', async () => {
  const defaults = reconciler.resolveTrackingReconcilePolicy({})
  assert.equal(defaults.intervalMs, 5 * 60_000)
  assert.equal(defaults.batchSize, 50)
  assert.equal(defaults.concurrency, 2)
  const custom = reconciler.resolveTrackingReconcilePolicy({
    SURAT_TRACKING_RECONCILE_INTERVAL_MS: '600000',
    SURAT_TRACKING_RECONCILE_BATCH_SIZE: '25',
    SURAT_TRACKING_RECONCILE_CONCURRENCY: '1',
  })
  assert.equal(custom.intervalMs, 600_000)
  assert.equal(custom.batchSize, 25)
  assert.equal(custom.concurrency, 1)
  // Tavanlar: asiri yuk engellenir.
  const capped = reconciler.resolveTrackingReconcilePolicy({
    SURAT_TRACKING_RECONCILE_INTERVAL_MS: '1000',
    SURAT_TRACKING_RECONCILE_BATCH_SIZE: '5000',
    SURAT_TRACKING_RECONCILE_CONCURRENCY: '64',
  })
  assert.equal(capped.intervalMs, 60_000)
  assert.equal(capped.batchSize, 200)
  assert.equal(capped.concurrency, 4)
})

// ═══ RETENTION ════════════════════════════════════════════════════════════

test('SSP-RETENTION-1: handedToCargo → 4 gunluk arsiv adayi DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    lastOperationalActivityAt: new Date(NOW.getTime() - 30 * 86_400_000),
  })
  // Kabul sonrasi kargoya verildi.
  await runCycle(db, async () => snapshot('2', 1))
  assert.equal((await stageOf(db, order.id)).operationStatus, 'HANDED_TO_CARGO')

  const counts = await retention.inspectRetention(
    db,
    retention.resolveRetentionPolicy({}),
    NOW,
  )
  assert.equal(counts.archiveEligible, 0, 'retention kurali DEGISMEDEN dislar')
})

// ═══ LABEL DOKUNULMADI ════════════════════════════════════════════════════

test('SSP-LABEL-UNCHANGED: mutabakat etiket katmanina DOKUNMAZ', async () => {
  const source = readFileSync(
    join(here, 'shipments', 'suratTrackingReconciler.ts'),
    'utf8',
  )
  for (const forbidden of [
    '^XA',
    '^FO',
    '^BC',
    '^BQ',
    'technicalZpl',
    'printZpl',
    'carrierPayloadEncrypted',
    'printBundle',
    'composeSurat',
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `etiket katmanina dokunulmamali: ${forbidden}`,
    )
  }
  // Yeni durum haritasi YOK: mevcut kanonik harita yeniden kullanilir.
  assert.ok(source.includes('mapSuratCarrierStatus'))
  assert.equal(source.includes('KargonunDurumu:'), false)
  // marketplace_status ASLA yazilmaz.
  assert.equal(/marketplaceStatus:\s*'/.test(source), false)
})
