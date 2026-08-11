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
    .returning({
      id: orders.id,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
    })
  if (withShipment) {
    await db.insert(shipments).values({
      organizationId,
      marketplace: 'Trendyol',
      packageId,
      provider: 'surat-kargo',
      source: 'local_create',
      status: 'CREATED',
      // `null` ACIKCA "kimlik yok" demektir (?? ile GOLDEN'a dusmez).
      trackingNumber:
        overrides.tNo === undefined ? GOLDEN.tNo : overrides.tNo,
      barcode:
        overrides.carrierBarcode === undefined
          ? GOLDEN.carrierBarcode
          : overrides.carrierBarcode,
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
      // Kimlik SART: T.No olmayan kayda sorgu yapilmaz (SSP-IDENTITY-3).
      trackingNumber: `TNO-${index}`,
    })
  }
  await db.insert(orders).values(values)
  await db.insert(shipments).values(shipmentValues)

  let processed = 0
  for (let cycle = 0; cycle < 40; cycle += 1) {
    // KargoTakipHareketDetayi cogu zaman BarkodNo DONDURMEZ; capraz
    // dogrulama bu durumda ATLANIR (bkz. decideFromCarrierSnapshot).
    const report = await runCycle(db, async () => ({
      ok: true,
      gonderilerLength: 1,
      kargonunDurumuSayi: '3',
      trackingNumber: null,
      sonHareketTarihi: null,
    }))
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

// ═══ ADAY KAPSAMI: LABEL_READY + LABEL_PRINTED ════════════════════════════
//
// KRITIK: bu iki durum YALNIZ "tasiyiciya sorulur mu?" sorusunu yanitlar.
// "Kargoya Verildi" YALNIZ dogrulanmis tasiyici kabul kanitindan dogar.

test('SSP-READY-1: LABEL_READY + tasiyici hazirlaniyor → LABEL_READY KALIR', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
  })
  const report = await runCycle(db, async () => snapshot('1', 1))
  assert.equal(report.handedToCargo, 0)
  assert.equal((await stageOf(db, order.id)).operationStatus, 'LABEL_READY')
})

test('SSP-READY-2: LABEL_READY + dogrulanmis kabul → HANDED_TO_CARGO', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    operationStatus: 'LABEL_READY',
  })
  const report = await runCycle(db, async () => snapshot('2', 1))
  assert.equal(report.handedToCargo, 1)
  const state = await stageOf(db, order.id)
  assert.equal(state.operationStatus, 'HANDED_TO_CARGO')
  assert.equal(state.marketplaceStatus, 'Picking', 'Trendyol DOKUNULMAZ')
})

test('SSP-PRINTED-1: LABEL_PRINTED + hazirlaniyor → LABEL_PRINTED KALIR', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
  })
  await runCycle(db, async () => snapshot('1', 1))
  assert.equal((await stageOf(db, order.id)).operationStatus, 'LABEL_PRINTED')
})

test('SSP-PRINTED-2: LABEL_PRINTED + dogrulanmis kabul → HANDED_TO_CARGO', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, {
    operationStatus: 'LABEL_PRINTED',
  })
  await runCycle(db, async () => snapshot('5', 1))
  assert.equal((await stageOf(db, order.id)).operationStatus, 'HANDED_TO_CARGO')
})

test('SSP-SCOPE: LABEL_READY ve LABEL_PRINTED aday, digerleri DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  await seedOrder(db, organizationId, { operationStatus: 'LABEL_READY' })
  await seedOrder(db, organizationId, { operationStatus: 'LABEL_PRINTED' })
  await seedOrder(db, organizationId, { operationStatus: 'NEW' })
  await seedOrder(db, organizationId, { operationStatus: 'BARCODE_WAITING' })
  const candidates = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidates.length, 2)
})

test('SSP-IDENTITY-3: tasiyici kimligi (T.No/barkod) YOKSA aday DEGIL', async () => {
  const { db, organizationId } = await makeDb()
  // Gonderi kaydi var ama T.No ve barkod BOS.
  await seedOrder(db, organizationId, { tNo: null, carrierBarcode: null })
  const candidates = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidates.length, 0, 'kimliksiz sorgu YAPILMAZ')
})

test('SSP-NEGATIVE-2: Gonderiler=1 + KargonunDurumuSayi=1 → handedToCargo FALSE', async () => {
  const decision = reconciler.decideFromCarrierSnapshot(
    {
      orderId: 'o1',
      organizationId: 'org',
      marketplace: 'Trendyol',
      packageId: GOLDEN.packageId,
    },
    snapshot('1', 1),
  )
  assert.equal(decision.handedToCargo, false)
  assert.equal(decision.applied, false)
  assert.equal(decision.reason, 'not_shipped_yet')
})

// ═══ ZAMANLAYICI (production-safe gate) ═══════════════════════════════════

const scheduler = await import('./shipments/suratTrackingScheduler.ts')

const emptyReport = () => ({
  scanned: 0,
  queried: 0,
  handedToCargo: 0,
  delivered: 0,
  returning: 0,
  unchanged: 0,
  failed: 0,
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('SSP-SCHEDULER-1: bayrak unset → 0 tasiyici sorgusu', async () => {
  let calls = 0
  const handle = scheduler.startTrackingScheduler({
    enabled: scheduler.isTrackingReconcileEnabled({}),
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  assert.equal(handle.started, false)
  assert.equal(handle.reason, 'disabled')
  await wait(30)
  assert.equal(calls, 0)
  handle.stop()
})

test('SSP-SCHEDULER-2: bayrak false → 0 tasiyici sorgusu', async () => {
  let calls = 0
  const handle = scheduler.startTrackingScheduler({
    enabled: scheduler.isTrackingReconcileEnabled({
      SURAT_TRACKING_RECONCILE_ENABLED: 'false',
    }),
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  assert.equal(handle.started, false)
  await wait(30)
  assert.equal(calls, 0)
  handle.stop()
  // '0' ve rastgele degerler de KAPALI.
  for (const value of ['', '0', 'no', 'off']) {
    assert.equal(
      scheduler.isTrackingReconcileEnabled({
        SURAT_TRACKING_RECONCILE_ENABLED: value,
      }),
      false,
    )
  }
  for (const value of ['true', '1', 'TRUE']) {
    assert.equal(
      scheduler.isTrackingReconcileEnabled({
        SURAT_TRACKING_RECONCILE_ENABLED: value,
      }),
      true,
    )
  }
})

test('SSP-SCHEDULER-3: bayrak true → boot sonrasi TAM 1 sinirli tur', async () => {
  let calls = 0
  const handle = scheduler.startTrackingScheduler({
    enabled: true,
    policy: { ...policy(), intervalMs: 60_000 },
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  assert.equal(handle.started, true)
  await wait(40)
  assert.equal(calls, 1)
  handle.stop()
})

test('SSP-SCHEDULER-4: interval → sonraki tur calisir', async () => {
  let calls = 0
  const handle = scheduler.startTrackingScheduler({
    enabled: true,
    policy: { ...policy(), intervalMs: 25 },
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  await wait(120)
  handle.stop()
  assert.ok(calls >= 2, `periyodik tur beklenir: ${calls}`)
})

test('SSP-SCHEDULER-5: devam eden tur + tick → ORTUSME YOK', async () => {
  let active = 0
  let peak = 0
  const handle = scheduler.startTrackingScheduler({
    enabled: true,
    policy: { ...policy(), intervalMs: 20 },
    runCycle: async () => {
      active += 1
      peak = Math.max(peak, active)
      await wait(150)
      active -= 1
      return emptyReport()
    },
    log: () => {},
  })
  await wait(120)
  assert.equal(peak, 1, 'ayni anda tek tur')
  handle.stop()
  await wait(80)
})

test('SSP-SCHEDULER-6: tasiyici istisnasi zamanlayiciyi DUSURMEZ', async () => {
  let calls = 0
  const errors = []
  const handle = scheduler.startTrackingScheduler({
    enabled: true,
    policy: { ...policy(), intervalMs: 25 },
    runCycle: async () => {
      calls += 1
      throw new Error('tasiyici hatasi')
    },
    log: () => {},
    onError: (error) => errors.push(error),
  })
  await wait(120)
  assert.ok(calls >= 2, 'yeniden denenir')
  assert.ok(errors.length >= 2)
  assert.equal(scheduler.isTrackingSchedulerActive(), true)
  handle.stop()
})

test('SSP-SCHEDULER-7: stop() timer temizler, yeni tur BASLAMAZ', async () => {
  let calls = 0
  const handle = scheduler.startTrackingScheduler({
    enabled: true,
    policy: { ...policy(), intervalMs: 20 },
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  await wait(50)
  const seen = calls
  handle.stop()
  assert.equal(scheduler.isTrackingSchedulerActive(), false)
  await wait(80)
  assert.equal(calls, seen)
})

test('SSP-SCHEDULER-8: elle tetikleme AYNI ortusme guardindan gecer', async () => {
  let active = 0
  let peak = 0
  const handle = scheduler.startTrackingScheduler({
    enabled: true,
    policy: { ...policy(), intervalMs: 60_000 },
    runCycle: async () => {
      active += 1
      peak = Math.max(peak, active)
      await wait(80)
      active -= 1
      return emptyReport()
    },
    log: () => {},
  })
  handle.trigger()
  handle.trigger()
  await wait(40)
  assert.equal(peak, 1, 'cift tetikleme ortusme URETMEZ')
  handle.stop()
  await wait(60)
})

test('SSP-BOOT-WIRING: boot yolu KAPILI zamanlayiciyi kurar', async () => {
  const entry = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.ok(entry.includes('startSuratTrackingReconcileOnBoot'))
  assert.ok(entry.includes('startTrackingScheduler'))
  assert.ok(entry.includes('stopTrackingScheduler'))
  // Boot yolu bayragi KENDISI OKUMAZ; karar zamanlayicidadir.
  assert.equal(
    entry.includes('process.env.SURAT_TRACKING_RECONCILE_ENABLED'),
    false,
  )
  // Zamanlayici modulu is kurali TASIMAZ.
  const schedulerSource = readFileSync(
    join(here, 'shipments', 'suratTrackingScheduler.ts'),
    'utf8',
  )
  for (const forbidden of ['LABEL_READY', 'KargonunDurumu', 'mapSurat']) {
    assert.equal(schedulerSource.includes(forbidden), false, forbidden)
  }
})

test('SSP-CLI-READONLY: tani komutu YAZMA yapmaz', async () => {
  const cli = readFileSync(
    join(here, 'shipments', 'sspAcceptanceCheckCli.ts'),
    'utf8',
  )
  for (const forbidden of [
    '.update(',
    '.insert(',
    '.delete(',
    'applyTrackingDecision',
    'createShipment',
  ]) {
    assert.equal(cli.includes(forbidden), false, `CLI salt okunur olmali: ${forbidden}`)
  }
  assert.ok(cli.includes('mapSuratCarrierStatus'))
  assert.ok(cli.includes('wouldResolveHandedToCargo'))
})

// ═══ SORGU KIMLIGI (uretim kok nedeni) ════════════════════════════════════
//
// KANIT (server/index.mjs requestFieldMapping):
//   WebSiparisKodu = orderNumber   ← Serendip kaydinin ANAHTARI
//   ReferansNo     = packageId
// Takip ucu YALNIZ WebSiparisKodu kabul eder. Sorgu packageId ile
// yapiliyordu → carrierQuerySucceeded=false, Gonderiler=0 (golden 4065907241).

test('SSP-QUERY-1: aday SERENDIP ANAHTARINI (orderNumber) tasir', async () => {
  const { db, organizationId } = await makeDb()
  await seedOrder(db, organizationId, {
    orderNumber: GOLDEN.orderNumber,
    packageId: GOLDEN.packageId,
  })
  const [candidate] = await reconciler.findTrackingReconcileCandidates(
    db,
    policy(),
  )
  assert.equal(candidate.orderNumber, GOLDEN.orderNumber, 'WebSiparisKodu')
  assert.equal(candidate.packageId, GOLDEN.packageId, 'ReferansNo ayri kalir')
  assert.notEqual(candidate.orderNumber, GOLDEN.marketplaceTracking)
})

test('SSP-QUERY-5: sorgu orderNumber ile yapilir (packageId DEGIL)', async () => {
  const { db, organizationId } = await makeDb()
  await seedOrder(db, organizationId, {
    orderNumber: GOLDEN.orderNumber,
    packageId: GOLDEN.packageId,
  })
  const seen = []
  await runCycle(db, async (candidate) => {
    seen.push(candidate.orderNumber)
    return snapshot('2', 1)
  })
  assert.deepEqual(seen, [GOLDEN.orderNumber])
})

test('SSP-QUERY-6: donen kimlik UYUSMUYORSA guncelleme YOK', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, { tNo: GOLDEN.tNo })
  const report = await runCycle(db, async () => ({
    ok: true,
    gonderilerLength: 1,
    kargonunDurumuSayi: '2',
    // BASKA bir gonderinin takip numarasi.
    trackingNumber: '99999999999999',
    sonHareketTarihi: null,
  }))
  assert.equal(report.handedToCargo, 0)
  assert.equal((await stageOf(db, order.id)).operationStatus, 'LABEL_PRINTED')
})

test('SSP-QUERY-6b: kimlik UYUSUYORSA kabul edilir', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId, { tNo: GOLDEN.tNo })
  await runCycle(db, async () => snapshot('2', 1))
  assert.equal((await stageOf(db, order.id)).operationStatus, 'HANDED_TO_CARGO')
})

test('SSP-QUERY-7: tum sorgular basarisiz → mevcut durum KORUNUR', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId)
  const report = await runCycle(db, async () => null)
  assert.equal(report.failed, 1)
  assert.equal((await stageOf(db, order.id)).operationStatus, 'LABEL_PRINTED')
})


test('SSP-QUERY-9: Gonderiler=1 TEK BASINA handedToCargo URETMEZ', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId)
  await runCycle(db, async () => snapshot('1', 1))
  assert.equal((await stageOf(db, order.id)).operationStatus, 'LABEL_PRINTED')
})

test('SSP-QUERY-10: bulunan gonderi + shipped kod → handedToCargo', async () => {
  const { db, organizationId } = await makeDb()
  const order = await seedOrder(db, organizationId)
  await runCycle(db, async () => snapshot('3', 1))
  assert.equal((await stageOf(db, order.id)).operationStatus, 'HANDED_TO_CARGO')
})

test('SSP-QUERY-SINGLE-SOURCE: CLI ve scheduler AYNI takip ucunu kullanir', async () => {
  const cli = readFileSync(
    join(here, 'shipments', 'sspAcceptanceCheckCli.ts'),
    'utf8',
  )
  const entry = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.ok(cli.includes('/api/shipments/surat/track'))
  // Zamanlayici tarafi ayni referans cozumleyicisini kullanir.
  assert.ok(entry.includes('resolveSuratTrackingQueryReference'))
  assert.ok(entry.includes('webSiparisKodu: candidate.orderNumber'))
})

// ═══ FALLBACK YOK — TEK KANONIK SORGU KIMLIGI ═════════════════════════════
//
// KANIT: resolveSuratTrackingQueryReference —
//   "KargoTakipHareketDetayi yalniz WEB_SIPARIS_KODU kabul eder".
// Baska referans tipi icin AYRI sorgu sozlesmesi KANITLANMADI → fallback YOK.

const cliSource = () =>
  readFileSync(join(here, 'shipments', 'sspAcceptanceCheckCli.ts'), 'utf8')

test('SSP-IDENTITY-CONTRACT: orderNumber → WebSiparisKodu (TEK kimlik)', async () => {
  const cli = cliSource()
  assert.ok(cli.includes("queryIdentityType: 'orderNumber_webSiparisKodu'"))
  assert.ok(cli.includes('order?.orderNumber'))
  assert.ok(cli.includes('webSiparisKodu: queryReference'))
  // Tasiyici sorgusu TEK KEZ kurulur (deneme dongusu YOK).
  // Yorumdaki gecis sayilmaz: GERCEK cagri TEK olmali.
  assert.equal((cli.match(/await fetch\(/g) ?? []).length, 1)
})

test('SSP-IDENTITY-NO-FALLBACK-1: packageId WebSiparisKodu olarak DENENMEZ', async () => {
  const cli = cliSource()
  assert.equal(cli.includes('webSiparisKodu: packageId'), false)
  assert.equal(/identityType:\s*'packageId/.test(cli), false)
  // Deneme matrisi kaldirildi.
  assert.equal(cli.includes('attempts'), false)
})

test('SSP-IDENTITY-NO-FALLBACK-2: T.No WebSiparisKodu olarak DENENMEZ', async () => {
  const cli = cliSource()
  assert.equal(/webSiparisKodu:\s*shipment/.test(cli), false)
  assert.equal(/identityType:\s*'carrierTNo/.test(cli), false)
})

test('SSP-IDENTITY-NO-FALLBACK-3: barkod WebSiparisKodu olarak DENENMEZ', async () => {
  const cli = cliSource()
  assert.equal(/identityType:\s*'carrierBarcode/.test(cli), false)
  assert.equal(cli.includes("identityType: 'carrierBarcode'"), false)
})

test('SSP-IDENTITY-NO-FALLBACK-4: reconciler de TEK kimlik kullanir', async () => {
  const entry = readFileSync(join(here, 'index.mjs'), 'utf8')
  assert.ok(entry.includes('webSiparisKodu: candidate.orderNumber'))
  assert.equal(entry.includes('webSiparisKodu: candidate.packageId'), false)
  // CLI ve zamanlayici AYNI ucu ve AYNI kimligi kullanir.
  assert.ok(cliSource().includes('/api/shipments/surat/track'))
})

test('SSP-QUERY-DIAG: hata kategorisi raporlanir, SECRET/PII yok', async () => {
  const cli = cliSource()
  assert.ok(cli.includes('errorCategory'))
  assert.ok(cli.includes('queryReference: mask(queryReference)'))
  for (const forbidden of ['kullaniciAdi', 'sifre', 'password', 'customerName']) {
    assert.equal(cli.includes(`${forbidden}:`), false, forbidden)
  }
})
