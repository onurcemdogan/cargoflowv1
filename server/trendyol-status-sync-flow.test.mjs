import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

// ARKA PLAN TRENDYOL DURUM SENKRONU.
//
// "Kargoya Verildi" icin otoriter kaynak TRENDYOL'dur. Bu paket, kullanicinin
// "Simdi Yenile"ye basmasina gerek kalmadan durumun tazelenmesini kilitler.
// SURAT/SSP KAPSAM DISIDIR: tasiyici sorgusu, Serendip, KTH veya kabul
// eslemesi burada YOKTUR.

let vite

before(async () => {
  vite = await createServer({
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
})
after(async () => {
  await vite?.close()
})

const load = (path) => vite.ssrLoadModule(path)
const SCHEDULER = '/server/orders/trendyolStatusSyncScheduler.ts'
const CLASSIFICATION = '/src/utils/orderClassification.ts'

const order = (overrides = {}) => ({
  id: 'o-1',
  orderNumber: '11493372619',
  packageId: '4065907241',
  marketplace: 'Trendyol',
  marketplaceStatus: 'Picking',
  status: 'Yeni',
  orderDate: '2026-08-01T10:00:00.000Z',
  items: [],
  ...overrides,
})

async function stageOf(input) {
  const { classifyOrderForTabs, resolveDashboardOperationStage } =
    await load(CLASSIFICATION)
  const state = classifyOrderForTabs(input)
  return { state, stage: resolveDashboardOperationStage(state) }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const emptyReport = () => ({ scanned: 0, synced: 0, failed: 0, skipped: 0 })

// ═══ SONUC SOZLESMESI ═════════════════════════════════════════════════════

test('AUTO-SYNC-1: LABEL_PRINTED + Picking → Shipped → handedToCargo', async () => {
  const before = await stageOf(
    order({ operationStatus: 'LABEL_PRINTED', marketplaceStatus: 'Picking' }),
  )
  assert.equal(before.stage, 'labelPrinted')
  // Arka plan senkronu YALNIZ marketplaceStatus'u tazeler; operation_status
  // yerinde kalir ve nihai asamayi resolver uretir.
  const after = await stageOf(
    order({ operationStatus: 'LABEL_PRINTED', marketplaceStatus: 'Shipped' }),
  )
  assert.equal(after.state.isHandedToCargo, true)
  assert.equal(after.stage, 'handedToCargo')
})

test('AUTO-SYNC-2: LABEL_READY + Picking → Shipped → handedToCargo', async () => {
  const after = await stageOf(
    order({ operationStatus: 'LABEL_READY', marketplaceStatus: 'Shipped' }),
  )
  assert.equal(after.state.isHandedToCargo, true)
  assert.equal(after.stage, 'handedToCargo')
})

test('AUTO-SYNC-3: Trendyol hala Picking → LABEL_PRINTED KORUNUR', async () => {
  const after = await stageOf(
    order({ operationStatus: 'LABEL_PRINTED', marketplaceStatus: 'Picking' }),
  )
  assert.equal(after.state.isHandedToCargo, false)
  assert.equal(after.stage, 'labelPrinted')
})

// ═══ KAPSAM VE GUVENLIK ═══════════════════════════════════════════════════

test('AUTO-SYNC-4: SURAT/tasiyici cagrisi YAPILMAZ', async () => {
  const scheduler = readFileSync(
    'server/orders/trendyolStatusSyncScheduler.ts',
    'utf8',
  )
  for (const forbidden of [
    'surat',
    'Serendip',
    'KargoTakip',
    'CariKoduveSifre',
    'WebSiparisKodu',
    'mapSuratCarrierStatus',
  ]) {
    assert.equal(
      scheduler.toLowerCase().includes(forbidden.toLowerCase()) &&
        !scheduler.includes(`SÜRAT/SSP`),
      false,
      `tasiyici tarafina dokunulmamali: ${forbidden}`,
    )
  }
  // Boot yolunda senkron YALNIZ kanonik Trendyol zincirini kullanir.
  const entry = readFileSync('server/index.mjs', 'utf8')
  assert.ok(entry.includes('callTrendyolOrdersByStatuses(credentials'))
  assert.ok(entry.includes('normalizeTrendyolOrders(result.data)'))
  assert.ok(entry.includes('service.persistSyncResult('))
})

test('AUTO-SYNC-5: bayrak OFF → arka plan senkronu CALISMAZ', async () => {
  const module = await load(SCHEDULER)
  let calls = 0
  const handle = module.startTrendyolStatusSyncScheduler({
    policy: module.resolveTrendyolSyncPolicy({}),
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
  // Varsayilan ve gecersiz degerler KAPALI.
  for (const value of ['', '0', 'false', 'no']) {
    assert.equal(
      module.isTrendyolStatusSyncEnabled({
        TRENDYOL_STATUS_SYNC_ENABLED: value,
      }),
      false,
    )
  }
  for (const value of ['true', '1']) {
    assert.equal(
      module.isTrendyolStatusSyncEnabled({
        TRENDYOL_STATUS_SYNC_ENABLED: value,
      }),
      true,
    )
  }
})

test('AUTO-SYNC-6: bayrak ON → sinirli tur calisir', async () => {
  const module = await load(SCHEDULER)
  let calls = 0
  const policy = {
    ...module.resolveTrendyolSyncPolicy({
      TRENDYOL_STATUS_SYNC_ENABLED: 'true',
    }),
    intervalMs: 25,
  }
  assert.equal(policy.enabled, true)
  const handle = module.startTrendyolStatusSyncScheduler({
    policy,
    runCycle: async () => {
      calls += 1
      return emptyReport()
    },
    log: () => {},
  })
  assert.equal(handle.started, true)
  await wait(120)
  handle.stop()
  assert.ok(calls >= 2, `periyodik tur beklenir: ${calls}`)
})

test('AUTO-SYNC-7: ORTUSME engellenir', async () => {
  const module = await load(SCHEDULER)
  let active = 0
  let peak = 0
  const handle = module.startTrendyolStatusSyncScheduler({
    policy: {
      ...module.resolveTrendyolSyncPolicy({
        TRENDYOL_STATUS_SYNC_ENABLED: 'true',
      }),
      intervalMs: 20,
    },
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

test('AUTO-SYNC-8: tek hedef hatasi digerlerini ENGELLEMEZ', async () => {
  const module = await load(SCHEDULER)
  const policy = module.resolveTrendyolSyncPolicy({
    TRENDYOL_STATUS_SYNC_ENABLED: 'true',
  })
  const targets = [{ organizationId: 'a' }, { organizationId: 'b' }, { organizationId: 'c' }]
  const report = await module.runTrendyolSyncCycle(
    policy,
    async () => targets,
    async (target) => {
      if (target.organizationId === 'b') throw new Error('trendyol hatasi')
      return { synced: true }
    },
  )
  assert.equal(report.scanned, 3)
  assert.equal(report.synced, 2, 'digerleri devam eder')
  assert.equal(report.failed, 1)
})

test('AUTO-SYNC-8b: kimlik bilgisi olmayan hedef SESSIZCE atlanir', async () => {
  const module = await load(SCHEDULER)
  const policy = module.resolveTrendyolSyncPolicy({
    TRENDYOL_STATUS_SYNC_ENABLED: 'true',
  })
  const report = await module.runTrendyolSyncCycle(
    policy,
    async () => [{ organizationId: 'a' }],
    async () => ({ synced: false }),
  )
  assert.equal(report.skipped, 1)
  assert.equal(report.failed, 0)
})

test('AUTO-SYNC-9: rutin senkron retention saatini RESETLEMEZ', async () => {
  // marketplaceUpdateSet retention saatine DOKUNMAZ (ACTIVITY-3 sozlesmesi).
  const mapper = readFileSync('server/orders/orderMapper.ts', 'utf8')
  // Fonksiyon govdesi SATIR SATIR alinir: 'export function' satirindan,
  // tek basina '}' olan kapanis satirina kadar. Yorumlar ayiklanir —
  // sozlesme YAZILAN ALANLARA bakar, aciklamaya degil.
  const lines = mapper.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('export function marketplaceUpdateSet'),
  )
  assert.ok(start >= 0, 'marketplaceUpdateSet bulunmali')
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines
    .slice(start, end)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.equal(body.includes('lastOperationalActivityAt'), false)
  assert.equal(body.includes('archivedAt'), false)
  assert.equal(body.includes('operationStatus:'), false)
})

test('AUTO-SYNC-10: manuel "Simdi Yenile" yolu BOZULMAZ', async () => {
  const entry = readFileSync('server/index.mjs', 'utf8')
  // Manuel uc yerinde ve ayni kanonik zinciri kullaniyor.
  assert.ok(entry.includes("app.post('/api/orders/sync'"))
  // Arka plan senkronu AYRI bir fonksiyondur; manuel ucu degistirmez.
  assert.ok(entry.includes('syncTrendyolOrdersForOrganization'))
  assert.ok(entry.includes('startTrendyolStatusSyncOnBoot'))
  // Kapanista temizlik.
  assert.ok(entry.includes('stopTrendyolStatusSyncScheduler'))
})

test('AUTO-SYNC-POLICY: varsayilanlar ve tavanlar', async () => {
  const module = await load(SCHEDULER)
  const defaults = module.resolveTrendyolSyncPolicy({})
  assert.equal(defaults.enabled, false)
  assert.equal(defaults.intervalMs, 300_000)
  assert.equal(defaults.batchSize, 100)
  assert.equal(defaults.concurrency, 2)
  // Taban/tavan korumalari.
  const capped = module.resolveTrendyolSyncPolicy({
    TRENDYOL_STATUS_SYNC_INTERVAL_MS: '1000',
    TRENDYOL_STATUS_SYNC_BATCH_SIZE: '9999',
    TRENDYOL_STATUS_SYNC_CONCURRENCY: '64',
  })
  assert.equal(capped.intervalMs, 60_000)
  assert.equal(capped.batchSize, 500)
  assert.equal(capped.concurrency, 4)
})

test('AUTO-SYNC-SURAT-OFF: Surat mutabakat bayragi ETKILENMEZ', async () => {
  const surat = await load('/server/shipments/suratTrackingScheduler.ts')
  assert.equal(surat.isTrackingReconcileEnabled({}), false)
  assert.equal(
    surat.isTrackingReconcileEnabled({ TRENDYOL_STATUS_SYNC_ENABLED: 'true' }),
    false,
    'Trendyol bayragi Surat mutabakatini ACMAZ',
  )
})
