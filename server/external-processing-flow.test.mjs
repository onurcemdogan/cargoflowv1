import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// HARİCİ SİSTEMDE İŞLENEN SİPARİŞLER — yerel, manuel, geri alınabilir arşiv.
//
// SÖZLEŞME:
//  - Provider veya marketplace çağrısı YOK.
//  - marketplaceStatus, tracking, barcode, labelStatus, printCount DEĞİŞMEZ.
//  - Sipariş SİLİNMEZ; yalnız aktif operasyon görünümünden çıkar.
//  - İdempotent: tekrar işaretleme / tekrar geri alma hata üretmez.
//  - Organizasyon kapsamlı; A org'u B'nin siparişini değiştiremez.
//  - Migration YOK: mevcut organization_settings JSONB kullanılır.
//  - Otomatik arşivleme YOK (yalnız kullanıcının açık işareti).
//
// Fixture'lar SENTETİKTİR; gerçek müşteri verisi, adres, telefon, ZPL veya
// credential İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const repo = await import('./orders/externalProcessingRepository.ts')

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      optimizeDeps: { noDiscovery: true, include: [] },
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

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
async function makeOrg(db, slug) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

// ── Sentetik siparişler ────────────────────────────────────────────────────
const order = (over = {}) => ({
  id: over.id ?? 'o-1',
  marketplace: 'Trendyol',
  packageId: over.packageId ?? 'PKG-1',
  orderNumber: over.orderNumber ?? '7270000000000001',
  customerName: '',
  address: '',
  city: '',
  district: '',
  marketplaceStatus: 'Created',
  operationStatus: 'LABEL_READY',
  labelStatus: 'READY',
  status: 'Yeni',
  source: 'real',
  createdAt: '2026-08-01T00:00:00.000Z',
  items: [{ id: 'l-1', productName: 'Sentetik Ürün', quantity: 1 }],
  ...over,
})

const READY = () => order({ id: 'o-ready', packageId: 'PKG-READY' })
const PRINTED = () =>
  order({
    id: 'o-printed',
    packageId: 'PKG-PRINTED',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    label: { printedAt: '2026-08-01T10:00:00.000Z', printCount: 1 },
    shipment: { trackingNumber: '25220148446193', barcode: '01231201025' },
  })

const baseFilters = {
  marketplaceFilter: 'all',
  operationStatusFilter: 'all',
  cargoFilter: 'all',
  cityFilter: 'all',
  districtFilter: 'all',
  multiProductFilter: 'all',
  actionFilter: 'all',
  dateFilter: { preset: 'all' },
  searchQuery: '',
}

async function visible(orders, over = {}) {
  const { buildVisibleOrders } = await load('/src/utils/orderClassification.ts')
  return buildVisibleOrders({
    persistentOrders: orders,
    selectedTab: 'all',
    ...baseFilters,
    ...over,
  }).visibleOrders
}

async function markLocally(orders, keysOrders) {
  const { applyExternalProcessingState, externalProcessingKeys } = await load(
    '/src/utils/externalProcessing.ts',
  )
  const entries = {}
  for (const key of externalProcessingKeys(keysOrders)) {
    entries[key] = { processedAt: '2026-08-05T09:00:00.000Z', source: 'manual' }
  }
  return applyExternalProcessingState(orders, { entries })
}

// ═══ 1-2: READY ve PRINTED işaretlenebilir ═════════════════════════════════

test('EP-1: seçili READY sipariş işaretlenebilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-1')
  const { externalProcessingKey } = await load('/src/utils/externalProcessing.ts')
  const key = externalProcessingKey(READY())
  const result = await repo.markExternallyProcessed(db, org, [key])
  assert.equal(result.changed, 1)
  assert.ok((await repo.getExternalProcessing(db, org)).entries[key])
})

test('EP-2: seçili PRINTED sipariş de işaretlenebilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-2')
  const { externalProcessingKey } = await load('/src/utils/externalProcessing.ts')
  const key = externalProcessingKey(PRINTED())
  const result = await repo.markExternallyProcessed(db, org, [key])
  assert.equal(result.changed, 1)
  assert.ok((await repo.getExternalProcessing(db, org)).entries[key])
})

// ═══ 3-7: provider / marketplace / etiket alanları DEĞİŞMEZ ════════════════

test('EP-3..EP-7: işaretleme sipariş alanlarını DEĞİŞTİRMEZ', async () => {
  const source = PRINTED()
  const [marked] = await markLocally([source], [source])
  // 3) Provider çağrısı yok → kaynak kodda fetch/provider referansı yok.
  const repoSrc = readFileSync(
    join(here, 'orders', 'externalProcessingRepository.ts'),
    'utf8',
  )
  for (const token of ['fetch(', 'surat', 'soap', 'kargoyagonder']) {
    assert.equal(
      repoSrc.toLocaleLowerCase('en-US').includes(token),
      false,
      `repository provider çağrısı içermemeli: ${token}`,
    )
  }
  // 4) marketplace status
  assert.equal(marked.marketplaceStatus, source.marketplaceStatus)
  // 5) tracking + barcode
  assert.equal(marked.shipment.trackingNumber, source.shipment.trackingNumber)
  assert.equal(marked.shipment.barcode, source.shipment.barcode)
  // 6) labelStatus
  assert.equal(marked.labelStatus, source.labelStatus)
  assert.equal(marked.operationStatus, source.operationStatus)
  // 7) printCount
  assert.equal(marked.label.printCount, source.label.printCount)
  assert.equal(marked.label.printedAt, source.label.printedAt)
  // Yalnız yerel bayrak eklendi.
  assert.equal(marked.externalProcessing.processed, true)
})

// ═══ 8-10: aktif listeler, sayaçlar ve filtre ══════════════════════════════

test('EP-8: işaretlenen sipariş aktif listeden ÇIKAR', async () => {
  const orders = [READY(), PRINTED()]
  const marked = await markLocally(orders, [orders[0]])
  const rows = await visible(marked)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].packageId, 'PKG-PRINTED')
})

test('EP-9: "Etiket Hazır" sayısı DÜŞER', async () => {
  const orders = [READY(), PRINTED()]
  const before = await visible(orders, { selectedTab: 'labelStage' })
  assert.equal(before.length, 2)
  const marked = await markLocally(orders, [orders[0]])
  const after = await visible(marked, { selectedTab: 'labelStage' })
  assert.equal(after.length, 1)
})

test('EP-10: "Harici Sistemde İşlendi" filtresinde GÖRÜNÜR', async () => {
  const orders = [READY(), PRINTED()]
  const marked = await markLocally(orders, [orders[0]])
  const rows = await visible(marked, {
    operationTabFilter: 'externallyProcessed',
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].packageId, 'PKG-READY')
})

test('EP-24: filtre temizlenince harici sipariş TEKRAR GÖRÜNMEZ', async () => {
  const orders = [READY(), PRINTED()]
  const marked = await markLocally(orders, [orders[0]])
  const cleared = await visible(marked, { operationTabFilter: 'all' })
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].packageId, 'PKG-PRINTED')
})

// ═══ 11-14: geri alma, kalıcılık, idempotency ══════════════════════════════

test('EP-11 / EP-25: geri alma siparişi aktif listeye DÖNDÜRÜR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-11')
  const { externalProcessingKey } = await load('/src/utils/externalProcessing.ts')
  const key = externalProcessingKey(READY())
  await repo.markExternallyProcessed(db, org, [key])
  const restored = await repo.restoreToActive(db, org, [key])
  assert.equal(restored.changed, 1)
  assert.equal(Object.keys(restored.state.entries).length, 0)

  const orders = [READY(), PRINTED()]
  const cleared = await visible(
    (await load('/src/utils/externalProcessing.ts')).applyExternalProcessingState(
      await markLocally(orders, [orders[0]]),
      restored.state,
    ),
  )
  assert.equal(cleared.length, 2, 'geri alınan sipariş aktif listede')
})

test('EP-12: işlem reload sonrası KORUNUR (DB okuması)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-12')
  const { externalProcessingKey } = await load('/src/utils/externalProcessing.ts')
  const key = externalProcessingKey(READY())
  await repo.markExternallyProcessed(db, org, [key])
  // Yeni okuma (sayfa yenilemesini temsil eder).
  const reloaded = await repo.getExternalProcessing(db, org)
  assert.ok(reloaded.entries[key])
  assert.equal(reloaded.entries[key].source, 'manual')
})

test('EP-13: tekrar işaretleme İDEMPOTENT', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-13')
  const { externalProcessingKey } = await load('/src/utils/externalProcessing.ts')
  const key = externalProcessingKey(READY())
  const first = await repo.markExternallyProcessed(db, org, [key])
  const second = await repo.markExternallyProcessed(db, org, [key])
  assert.equal(first.changed, 1)
  assert.equal(second.changed, 0)
  assert.equal(second.unchanged, 1)
  assert.equal(Object.keys(second.state.entries).length, 1)
})

test('EP-14: tekrar geri alma İDEMPOTENT', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-14')
  const { externalProcessingKey } = await load('/src/utils/externalProcessing.ts')
  const key = externalProcessingKey(READY())
  const first = await repo.restoreToActive(db, org, [key])
  assert.equal(first.changed, 0)
  assert.equal(first.unchanged, 1)
  await repo.markExternallyProcessed(db, org, [key])
  assert.equal((await repo.restoreToActive(db, org, [key])).changed, 1)
  assert.equal((await repo.restoreToActive(db, org, [key])).changed, 0)
})

// ═══ 15-18: izolasyon, kimlik, sayfalama, toplu işlem ══════════════════════

test('EP-15: organizasyon A, B siparişini DEĞİŞTİREMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const a = await makeOrg(db, 'ep-15-a')
  const b = await makeOrg(db, 'ep-15-b')
  const { externalProcessingKey } = await load('/src/utils/externalProcessing.ts')
  const key = externalProcessingKey(READY())
  await repo.markExternallyProcessed(db, a, [key])
  assert.ok((await repo.getExternalProcessing(db, a)).entries[key])
  assert.equal(
    Object.keys((await repo.getExternalProcessing(db, b)).entries).length,
    0,
    'B organizasyonu etkilenmez',
  )
  // B geri alma çağırsa bile A'nın kaydı DURUR.
  await repo.restoreToActive(db, b, [key])
  assert.ok((await repo.getExternalProcessing(db, a)).entries[key])
})

test('EP-16: canonical package identity KORUNUR (farklı paket ≠ aynı sipariş)', async () => {
  const { externalProcessingKey, externalProcessingKeys } = await load(
    '/src/utils/externalProcessing.ts',
  )
  const first = order({ id: 'a', packageId: 'PKG-A', orderNumber: '999' })
  const second = order({ id: 'b', packageId: 'PKG-B', orderNumber: '999' })
  assert.notEqual(externalProcessingKey(first), externalProcessingKey(second))
  assert.equal(externalProcessingKeys([first, second]).length, 2)
  // Aynı paket iki kez seçilse bile TEK kimlik gider.
  assert.equal(externalProcessingKeys([first, { ...first }]).length, 1)
})

test('EP-17: sayfalama üzerinde DOĞRU siparişler işaretlenir', async () => {
  const orders = Array.from({ length: 40 }, (_, index) =>
    order({
      id: `o-${index}`,
      packageId: `PKG-${index}`,
      orderNumber: `72700000000${String(index).padStart(5, '0')}`,
    }),
  )
  // İkinci "sayfadaki" 10 sipariş seçilir; kimlikler sayfadan bağımsızdır.
  const selection = orders.slice(10, 20)
  const marked = await markLocally(orders, selection)
  const rows = await visible(marked)
  assert.equal(rows.length, 30)
  const markedRows = await visible(marked, {
    operationTabFilter: 'externallyProcessed',
  })
  assert.equal(markedRows.length, 10)
  assert.deepEqual(
    markedRows.map((row) => row.packageId).sort(),
    selection.map((row) => row.packageId).sort(),
  )
})

test('EP-18: 105 sipariş toplu ve güvenle işlenir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-18')
  const { externalProcessingKeys } = await load(
    '/src/utils/externalProcessing.ts',
  )
  const orders = Array.from({ length: 105 }, (_, index) =>
    order({ id: `o-${index}`, packageId: `PKG-${index}` }),
  )
  const keys = externalProcessingKeys(orders)
  assert.equal(keys.length, 105)
  const result = await repo.markExternallyProcessed(db, org, keys)
  assert.equal(result.changed, 105)
  assert.equal(
    Object.keys((await repo.getExternalProcessing(db, org)).entries).length,
    105,
  )
  const marked = await markLocally(orders, orders)
  assert.equal((await visible(marked)).length, 0)
})

// ═══ 19-22: kısmi hata, audit, provider yasağı ═════════════════════════════

test('EP-19: geçersiz kimlikler AYRI raporlanır (sessiz yutulmaz)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-19')
  const result = await repo.markExternallyProcessed(db, org, [
    'trendyol:package:pkg-1',
    '',
    '   ',
    null,
  ])
  assert.equal(result.changed, 1)
  assert.equal(result.invalid, 3)
  // Geçerli olan yine de kaydedilir (kısmi hata tüm işlemi düşürmez).
  assert.equal(
    Object.keys((await repo.getExternalProcessing(db, org)).entries).length,
    1,
  )
})

test('EP-20: audit kaydı PII İÇERMEZ', async () => {
  const workflow = readFileSync(
    join(here, '..', 'src', 'services', 'orderWorkflowService.ts'),
    'utf8',
  )
  const start = workflow.indexOf('async setExternalProcessing(')
  assert.ok(start > 0)
  const block = workflow.slice(start, workflow.indexOf('async loadOrdersFromServer('))
  assert.match(block, /external_processing_marked/)
  assert.match(block, /external_processing_restored/)
  for (const field of [
    'customerName',
    'customerPhone',
    'customerEmail',
    'address',
    'barcodeRaw',
    'zpl',
  ]) {
    assert.equal(block.includes(field), false, `audit bloğunda ${field} var`)
  }
})

test('EP-21: provider / marketplace endpoint çağrısı YOK', async () => {
  const workflow = readFileSync(
    join(here, '..', 'src', 'services', 'orderWorkflowService.ts'),
    'utf8',
  )
  const start = workflow.indexOf('async setExternalProcessing(')
  const block = workflow.slice(start, workflow.indexOf('async loadOrdersFromServer('))
  // TEK ağ çağrısı yerel endpoint'tir.
  const fetches = block.match(/fetch\('([^']+)'/g) ?? []
  assert.deepEqual(fetches, ["fetch('/api/orders/external-processing'"])
  const repoSrc = readFileSync(
    join(here, 'orders', 'externalProcessingRepository.ts'),
    'utf8',
  )
  assert.equal(/fetch\(|http/i.test(repoSrc), false)
})

test('EP-22: yeni create / reprint TETİKLENMEZ', async () => {
  const workflow = readFileSync(
    join(here, '..', 'src', 'services', 'orderWorkflowService.ts'),
    'utf8',
  )
  const start = workflow.indexOf('async setExternalProcessing(')
  const block = workflow.slice(start, workflow.indexOf('async loadOrdersFromServer('))
  for (const forbidden of [
    'createShipments',
    'printLabels',
    'markSelectedHandedToCargo',
    'printCount',
    'labelStatus',
    'trackingNumber',
  ]) {
    assert.equal(block.includes(forbidden), false, `blokta ${forbidden} var`)
  }
})

// ═══ 23: Dashboard ve Orders AYNI state'i görür ════════════════════════════

test('EP-23: Dashboard ve Orders aynı sınıflandırmayı kullanır', async () => {
  const { classifyOrderForTabs } = await load(
    '/src/utils/orderClassification.ts',
  )
  const orders = [READY()]
  const [marked] = await markLocally(orders, orders)
  assert.equal(classifyOrderForTabs(marked).isExternallyProcessed, true)
  assert.equal(classifyOrderForTabs(orders[0]).isExternallyProcessed, false)
  // Dashboard view-model de aynı buildVisibleOrders/classifier zincirini
  // kullanır: işaretli sipariş aktif sayaçlara girmez.
  assert.equal((await visible([marked])).length, 0)
})

// ═══ Migration ve otomatik arşivleme yasağı ════════════════════════════════

test('EP-MIG: yeni migration veya kolon EKLENMEZ', () => {
  const files = readdirSync(join(here, '..', 'drizzle')).filter((f) =>
    f.endsWith('.sql'),
  )
  const sql = files
    .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'))
    .join('\n')
  assert.equal(
    /external_processing|externalProcessing/i.test(sql),
    false,
    'ayar JSONB içinde yaşar; kolon/migration yok',
  )
})

test('EP-AUTO: OTOMATİK arşivleme yoktur (yalnız açık kullanıcı işareti)', () => {
  const repoSrc = readFileSync(
    join(here, 'orders', 'externalProcessingRepository.ts'),
    'utf8',
  )
  // Zaman/heuristik tabanlı otomatik kural YOK.
  for (const heuristic of ['daysSince', 'olderThan', 'autoArchive', 'setInterval']) {
    assert.equal(repoSrc.includes(heuristic), false, heuristic)
  }
  // Kaynak yalnız 'manual'.
  assert.equal(repoSrc.includes("source: 'manual'"), true)
})

test('EP-SETTINGS: diğer organization ayarları KORUNUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ep-settings')
  await db.insert(schema.organizationSettings).values({
    organizationId: org,
    settingsJson: {
      onboarding: { completed: true },
      shipmentDefaults: { defaultUnitDesi: 2, multiplyByItemQuantity: false },
    },
  })
  await repo.markExternallyProcessed(db, org, ['trendyol:package:pkg-1'])
  const [row] = await db
    .select()
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, org))
  assert.equal(row.settingsJson.onboarding.completed, true)
  assert.equal(row.settingsJson.shipmentDefaults.defaultUnitDesi, 2)
  assert.equal(row.settingsJson.shipmentDefaults.multiplyByItemQuantity, false)
  assert.ok(row.settingsJson.externalProcessing.entries['trendyol:package:pkg-1'])
})
