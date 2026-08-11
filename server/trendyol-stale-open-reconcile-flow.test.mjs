import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// CASE OLD-B — ESKI ACIK KAYITLAR ARKA PLAN PENCERESININ DISINDA KALIYOR.
//
// URETIM VAKALARI (PII YOK):
//   4035080498 / 11456395252 · orderDate 2026-07-29 · Trendyol Delivered
//   4034372398 / 11455613726 · orderDate 2026-07-28 · Trendyol Delivered
//   Ikisi de DB'de Picking + LABEL_PRINTED kalmisti.
//
// KOK NEDEN (kod duzeyinde kanitli): arka plan turu tarih parametresi
// GONDERMEZ; `callTrendyolOrders` varsayilani SON 7 GUNDUR. Manuel "Simdi
// Yenile" 30 gunluk pencere gonderir. 13-14 gunluk bu kayitlar arka plan
// kapsamina HIC girmiyordu.
//
// Bu paket sinirli (bounded) stale-open mutabakatinin sozlesmesini kilitler.
// Surat/SSP, ZPL, etiket, retention KAPSAM DISIDIR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const reconciler = await import('./orders/staleOpenReconciler.ts')
const service = await import('./orders/orderPersistenceService.ts')

const { orders, organizations, marketplaceAccounts } = schema
const ENTRY_SOURCE = readFileSync('server/index.mjs', 'utf8')

const NOW = new Date('2026-08-11T12:00:00.000Z')
const daysAgo = (days) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

const GOLDEN = [
  { packageId: '4035080498', orderNumber: '11456395252', orderDate: daysAgo(13) },
  { packageId: '4034372398', orderNumber: '11455613726', orderDate: daysAgo(14) },
]

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
  const [account] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: '277221',
      isActive: true,
    })
    .returning({ id: marketplaceAccounts.id })
  return { db, organizationId: org.id, accountId: account.id }
}

async function seed(db, organizationId, accountId, overrides = {}) {
  const [row] = await db
    .insert(orders)
    .values({
      organizationId,
      marketplaceAccountId: accountId,
      marketplace: 'Trendyol',
      marketplaceStatus: 'Picking',
      operationStatus: 'LABEL_PRINTED',
      ...overrides,
    })
    .returning({ id: orders.id })
  return row.id
}

const seedGolden = async (db, organizationId, accountId) => {
  for (const item of GOLDEN) {
    await seed(db, organizationId, accountId, {
      packageId: item.packageId,
      orderNumber: item.orderNumber,
      orderDate: item.orderDate,
    })
  }
}

/** Trendyol'un HAM paket kaydiyla ayni sekil (normalize girisi). */
const rawPackage = (item, status = 'Delivered') => ({
  id: item.packageId,
  packageId: item.packageId,
  shipmentPackageId: item.packageId,
  orderNumber: item.orderNumber,
  status,
  shipmentPackageStatus: status,
  lastModifiedDate: NOW.getTime(),
  orderDate: item.orderDate.toISOString(),
  customerFirstName: 'T',
  customerLastName: 'M',
  shipmentAddress: { city: 'Istanbul' },
  lines: [],
})

const defaults = () => reconciler.resolveStaleReconcilePolicy({})
/** Etkin (acik) policy — mutabakat davranisi testleri icin. */
const enabledPolicy = (extra = {}) =>
  reconciler.resolveStaleReconcilePolicy({
    TRENDYOL_STALE_RECONCILE_ENABLED: 'true',
    ...extra,
  })

const findCandidates = (db, organizationId, accountId, extra = {}) =>
  reconciler.findStaleOpenCandidates(db, {
    organizationId,
    marketplaceAccountId: accountId,
    limit: 20,
    staleBefore: new Date(NOW.getTime() - defaults().staleAfterMs),
    ...extra,
  })

// ═══ ADAY YUKLEMI ═════════════════════════════════════════════════════════

test('OLD-B-CANDIDATE-1: eski acik kayitlar aday olur', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  const candidates = await findCandidates(db, organizationId, accountId)
  assert.equal(candidates.length, 2)
  assert.deepEqual(
    candidates.map((c) => c.packageId).sort(),
    ['4034372398', '4035080498'],
  )
  // En eski once (keyset sirasi).
  assert.equal(candidates[0].packageId, '4034372398')
})

test('OLD-B-CANDIDATE-2: ana turun kapsadigi TAZE kayit aday DEGIL', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seed(db, organizationId, accountId, {
    packageId: '4099999999',
    orderNumber: '11499999999',
    orderDate: daysAgo(2),
  })
  const candidates = await findCandidates(db, organizationId, accountId)
  assert.equal(candidates.length, 0, '7 gunluk pencere zaten kapsiyor')
})

test('OLD-B-CANDIDATE-3: terminal/ileri statu ve arsiv aday DEGIL', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seed(db, organizationId, accountId, {
    packageId: 'P-DELIVERED',
    orderNumber: 'O-DELIVERED',
    orderDate: daysAgo(20),
    marketplaceStatus: 'Delivered',
  })
  await seed(db, organizationId, accountId, {
    packageId: 'P-ARCHIVED',
    orderNumber: 'O-ARCHIVED',
    orderDate: daysAgo(20),
    archivedAt: NOW,
  })
  await seed(db, organizationId, accountId, {
    packageId: 'P-NOOP',
    orderNumber: 'O-NOOP',
    orderDate: daysAgo(20),
    operationStatus: null,
  })
  const candidates = await findCandidates(db, organizationId, accountId)
  assert.equal(candidates.length, 0)
})

test('OLD-B-CANDIDATE-4: hesap kapsami disina TASMAZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  // Legacy (hesapsiz) kapsam aktif hesabi GORMEZ.
  const legacy = await reconciler.findStaleOpenCandidates(db, {
    organizationId,
    marketplaceAccountId: null,
    limit: 20,
    staleBefore: new Date(NOW.getTime() - defaults().staleAfterMs),
  })
  assert.equal(legacy.length, 0)
})

// ═══ SINIR VE ROTASYON ════════════════════════════════════════════════════

test('OLD-B-BOUNDED-1: batch SINIRI asilmaz, cursor ILERLER', async () => {
  const { db, organizationId, accountId } = await makeDb()
  for (let index = 0; index < 5; index += 1) {
    await seed(db, organizationId, accountId, {
      packageId: `P-${index}`,
      orderNumber: `O-${index}`,
      orderDate: daysAgo(20 + index),
    })
  }
  const first = await findCandidates(db, organizationId, accountId, { limit: 2 })
  assert.equal(first.length, 2)
  const cursor = reconciler.advanceCursor(first, 2)
  assert.ok(cursor, 'batch dolu → cursor ilerler')

  const second = await findCandidates(db, organizationId, accountId, {
    limit: 2,
    cursor,
  })
  assert.equal(second.length, 2)
  const overlap = second.filter((row) =>
    first.some((prev) => prev.id === row.id),
  )
  assert.equal(overlap.length, 0, 'ayni adaylar TEKRAR secilmez')
})

test('OLD-B-BOUNDED-2: liste bitince cursor SIFIRLANIR (starvation YOK)', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  const candidates = await findCandidates(db, organizationId, accountId, {
    limit: 20,
  })
  assert.equal(reconciler.advanceCursor(candidates, 20), null)
  assert.equal(reconciler.advanceCursor([], 20), null)
})

test('STALE-SCHEDULE-5: default batch 10, concurrency 2, esik 6 gun', () => {
  const policy = defaults()
  assert.equal(policy.batchSize, 10)
  assert.equal(policy.concurrency, 2)
  assert.equal(policy.staleAfterMs, 6 * 24 * 60 * 60 * 1000)
})

test('STALE-SCHEDULE-6: batch hard max 50, concurrency max 4', () => {
  const capped = reconciler.resolveStaleReconcilePolicy({
    TRENDYOL_STALE_RECONCILE_ENABLED: 'true',
    TRENDYOL_STALE_RECONCILE_BATCH: '9999',
    TRENDYOL_STALE_RECONCILE_CONCURRENCY: '64',
  })
  assert.equal(capped.batchSize, 50)
  assert.equal(capped.concurrency, 4)
})

// ═══ SONUC SOZLESMESI ═════════════════════════════════════════════════════

test('OLD-B-RESULT-1: golden kayitlar Delivered olur, LABEL_PRINTED KORUNUR', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  const candidates = await findCandidates(db, organizationId, accountId)

  const queried = []
  const report = await reconciler.reconcileStaleOpenOrders(
    enabledPolicy(),
    candidates,
    async (candidate) => {
      queried.push(candidate.orderNumber)
      const item = GOLDEN.find((g) => g.orderNumber === candidate.orderNumber)
      return [rawPackage(item)]
    },
    async (packages) => {
      // KANONIK zincirin test karsiligi: normalize edilmis sekil dogrudan
      // persistSyncResult'a verilir (yeni mapping YOK).
      await service.persistSyncResult(
        db,
        organizationId,
        packages.map((item) => ({
          marketplace: 'Trendyol',
          packageId: item.packageId,
          shipmentPackageId: item.packageId,
          externalOrderId: item.packageId,
          orderNumber: item.orderNumber,
          marketplaceStatus: item.status,
          orderDate: item.orderDate,
          customerFirstName: item.customerFirstName,
          customerLastName: item.customerLastName,
          items: [],
        })),
        {
          complete: false,
          fetchedCount: packages.length,
          marketplaceAccountId: accountId,
        },
      )
    },
  )
  assert.equal(report.scanned, 2)
  assert.equal(report.persisted, 2)
  assert.equal(report.failed, 0)
  assert.deepEqual(queried.sort(), ['11455613726', '11456395252'])

  for (const item of GOLDEN) {
    const [row] = await db
      .select({
        marketplaceStatus: orders.marketplaceStatus,
        operationStatus: orders.operationStatus,
        marketplaceAccountId: orders.marketplaceAccountId,
      })
      .from(orders)
      .where(eq(orders.packageId, item.packageId))
    assert.equal(row.marketplaceStatus, 'Delivered', item.packageId)
    assert.equal(row.operationStatus, 'LABEL_PRINTED', 'operasyon KORUNUR')
    assert.equal(row.marketplaceAccountId, accountId, 'hesap kapsami KORUNUR')
  }
  // Golge satir OLUSMAZ.
  const all = await db.select({ id: orders.id }).from(orders)
  assert.equal(all.length, 2)
})

test('OLD-B-RESULT-2: bos yanit kaydi DEGISTIRMEZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  const candidates = await findCandidates(db, organizationId, accountId)
  const report = await reconciler.reconcileStaleOpenOrders(
    enabledPolicy(),
    candidates,
    async () => [],
    async () => {
      throw new Error('bos yanitta kalicilastirma CAGRILMAMALI')
    },
  )
  assert.equal(report.skipped, 2)
  assert.equal(report.persisted, 0)
})

test('OLD-B-RESULT-3: tek aday hatasi digerlerini ENGELLEMEZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  const candidates = await findCandidates(db, organizationId, accountId)
  const report = await reconciler.reconcileStaleOpenOrders(
    enabledPolicy(),
    candidates,
    async (candidate) => {
      if (candidate.orderNumber === '11455613726') throw new Error('http_502')
      return [rawPackage(GOLDEN[0])]
    },
    async () => {},
  )
  assert.equal(report.failed, 1)
  assert.equal(report.persisted, 1)
})

test('OLD-B-RESULT-4: kapali policy turu TAMAMEN durdurur', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await seedGolden(db, organizationId, accountId)
  const candidates = await findCandidates(db, organizationId, accountId)
  let calls = 0
  const report = await reconciler.reconcileStaleOpenOrders(
    reconciler.resolveStaleReconcilePolicy({}),
    candidates,
    async () => {
      calls += 1
      return []
    },
    async () => {},
  )
  assert.equal(calls, 0, 'tek bir Trendyol istegi bile YAPILMAZ')
  assert.deepEqual(report, {
    scanned: 0,
    queried: 0,
    persisted: 0,
    failed: 0,
    skipped: 0,
  })
})

// ═══ KAPSAM VE BAGLAMA ════════════════════════════════════════════════════

test('OLD-B-WIRING: arka plan turu KANONIK zinciri kullanir', () => {
  const lines = ENTRY_SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function reconcileStaleOpenForOrganization'),
  )
  assert.ok(start >= 0, 'baglanti fonksiyonu bulunmali')
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines
    .slice(start, end)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  // Salt okunur kanonik sorgu: orderNumber, statu filtresi YOK.
  assert.ok(body.includes('callTrendyolOrders('))
  assert.ok(body.includes('orderNumber: candidate.orderNumber'))
  assert.equal(body.includes('status:'), false, 'statu filtresi UYGULANMAZ')
  // Kanonik kalicilastirma; ikinci bir mapping YOK.
  assert.ok(body.includes('normalizeTrendyolOrders('))
  assert.ok(body.includes('persistSyncResult('))
  assert.ok(body.includes('complete: false'))
  assert.ok(body.includes('marketplaceAccountId: context.marketplaceAccountId'))
  // Yazma/ikinci statu karari YOK.
  for (const forbidden of [
    'update(orders)',
    'marketplaceStatus:',
    'operationStatus:',
    'surat',
    'zpl',
  ]) {
    assert.equal(
      body.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      forbidden,
    )
  }
})

test('OLD-B-SCOPE: mevcut sozlesmeler KORUNUR', () => {
  // Ana tur hesap kapsami + arsivsiz kalir.
  assert.ok(ENTRY_SOURCE.includes('resolveActiveMarketplaceAccountId('))
  assert.ok(ENTRY_SOURCE.includes('reconcileStaleOpenForOrganization('))
  // Stale-merge fix (670ffd7) yerinde.
  assert.ok(ENTRY_SOURCE.includes('incomingIsNewer'))
  // Manuel sync degismedi.
  assert.ok(ENTRY_SOURCE.includes('marketplaceAccountId: syncAccountId,'))
  // Mutabakat modulu Surat/etiket katmanina DOKUNMAZ.
  const module = readFileSync('server/orders/staleOpenReconciler.ts', 'utf8')
  // NOT: `LABEL_READY`/`LABEL_PRINTED` canonical OPERASYON durumlaridir
  // (aday yuklemi); etiket/baski katmani DEGILDIR.
  for (const forbidden of [
    'surat',
    'zpl',
    'barkod',
    'printZpl',
    'markOrderLabel',
  ]) {
    assert.equal(
      module.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      forbidden,
    )
  }
  // Retention politikasi degismedi (yalniz ileri statu kumesi PAYLASILIR).
  assert.ok(module.includes("from './orderRetention.ts'"))
})

// ═══ BAGIMSIZ ZAMANLAYICI (LOAD SAFETY) ═══════════════════════════════════
//
// Ana Trendyol turu uretimde TRENDYOL_STATUS_SYNC_INTERVAL_MS=60000 ile
// calisiyor. Bu gecis ONA BAGLI DEGILDIR: kendi bayragi, kendi timer'i,
// kendi overlap guard'i ve tabani 5 dakika olan kendi cadence'i vardir.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const emptyReport = () => ({
  scanned: 0,
  queried: 0,
  persisted: 0,
  failed: 0,
  skipped: 0,
})

test('STALE-SCHEDULE-1: bayrak unset → is CALISMAZ', async () => {
  let calls = 0
  const handle = reconciler.startStaleReconcileScheduler({
    policy: reconciler.resolveStaleReconcilePolicy({}),
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  assert.equal(handle.started, false)
  assert.equal(handle.reason, 'disabled')
  await wait(30)
  assert.equal(calls, 0, 'tek bir tur bile baslamaz')
  handle.stop()
  // Varsayilan ve gecersiz degerler KAPALI.
  for (const value of ['', '0', 'false', 'no', 'yes']) {
    assert.equal(
      reconciler.isStaleReconcileEnabled({
        TRENDYOL_STALE_RECONCILE_ENABLED: value,
      }),
      false,
      value || '(unset)',
    )
  }
  assert.equal(reconciler.isStaleReconcileEnabled({}), false, 'default OFF')
})

test('STALE-SCHEDULE-2: bayrak true/1 → is CALISIR', async () => {
  for (const value of ['true', '1']) {
    assert.equal(
      reconciler.isStaleReconcileEnabled({
        TRENDYOL_STALE_RECONCILE_ENABLED: value,
      }),
      true,
      value,
    )
  }
  let calls = 0
  const handle = reconciler.startStaleReconcileScheduler({
    policy: { ...enabledPolicy(), intervalMs: 25 },
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  assert.equal(handle.started, true)
  assert.equal(handle.reason, 'started')
  await wait(120)
  handle.stop()
  assert.ok(calls >= 2, `periyodik tur beklenir: ${calls}`)
})

test('STALE-SCHEDULE-3: ana sync 60 sn olsa da stale kendi 5 dk tabanini kullanir', () => {
  // Ana senkron bayragi/araligi bu policy'yi ETKILEMEZ.
  const policy = reconciler.resolveStaleReconcilePolicy({
    TRENDYOL_STALE_RECONCILE_ENABLED: 'true',
    TRENDYOL_STATUS_SYNC_INTERVAL_MS: '60000',
  })
  assert.equal(policy.intervalMs, 300_000, 'varsayilan 5 dakika')

  // Daha kucuk deger verilse bile TABAN 5 dakikadir.
  assert.equal(
    reconciler.resolveStaleReconcilePolicy({
      TRENDYOL_STALE_RECONCILE_ENABLED: 'true',
      TRENDYOL_STALE_RECONCILE_INTERVAL_MS: '60000',
    }).intervalMs,
    300_000,
    '60 sn TABANA yukseltilir',
  )
  // Daha uzun aralik SAYGI GORUR.
  assert.equal(
    reconciler.resolveStaleReconcilePolicy({
      TRENDYOL_STALE_RECONCILE_ENABLED: 'true',
      TRENDYOL_STALE_RECONCILE_INTERVAL_MS: '900000',
    }).intervalMs,
    900_000,
  )
  // Ana zamanlayicinin kendi sozlesmesi DEGISMEDI: taban 60 sn.
  const entryScheduler = readFileSync(
    'server/orders/trendyolStatusSyncScheduler.ts',
    'utf8',
  )
  assert.ok(entryScheduler.includes('60_000,'), 'ana tur tabani 60 sn kalir')
})

test('STALE-SCHEDULE-4: ORTUSME engellenir (kendi guard\'i)', async () => {
  let active = 0
  let peak = 0
  const handle = reconciler.startStaleReconcileScheduler({
    policy: { ...enabledPolicy(), intervalMs: 20 },
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
  assert.equal(peak, 1, 'ayni anda tek stale tur')
  handle.stop()
  await wait(80)
})

test('STALE-SCHEDULE-7: ana sync bayragi stale isi OTOMATIK ACMAZ', async () => {
  assert.equal(
    reconciler.isStaleReconcileEnabled({
      TRENDYOL_STATUS_SYNC_ENABLED: 'true',
      TRENDYOL_STATUS_SYNC_INTERVAL_MS: '60000',
    }),
    false,
    'ayri ve acik karar gerekir',
  )
  let calls = 0
  const handle = reconciler.startStaleReconcileScheduler({
    policy: reconciler.resolveStaleReconcilePolicy({
      TRENDYOL_STATUS_SYNC_ENABLED: 'true',
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

  // Ana tur ARTIK stale gecisini kendi icinde CAGIRMAZ (ayri zamanlayici).
  const lines = ENTRY_SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function syncTrendyolOrdersForOrganization'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.equal(
    body.includes('reconcileStaleOpen'),
    false,
    'stale gecisi ana turun ICINDE CALISMAZ',
  )
  // Kendi boot yolu ve kapanis temizligi var.
  assert.ok(ENTRY_SOURCE.includes('startStaleOpenReconcileOnBoot'))
  assert.ok(ENTRY_SOURCE.includes('stopStaleReconcileScheduler'))
})
