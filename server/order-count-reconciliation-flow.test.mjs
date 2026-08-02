import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { createServer } from 'vite'

// Durusoft ↔ CargoFlow sipariş/paket sayısı mutabakatı.
// Veriler SENTETİKTİR; gerçek müşteri bilgisi veya gerçek ID yoktur.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

// Durusoft ekranıyla BİREBİR aynı pencere (Europe/Istanbul 13:39 → UTC 10:39).
const START = '2026-07-28T10:39:00.000Z'
const END = '2026-08-02T10:39:00.000Z'

const schema = await import('./db/schema.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const model = await import('./analytics/orderCountReconcile.ts')
const loader = await import('./analytics/orderCountReconcileLoader.ts')

let _vite
async function loadFrontend(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

async function makeDb() {
  const pglite = new PGlite()
  const dir = join(here, '..', 'drizzle')
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(dir, file), 'utf8')
      .split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      await pglite.exec(stmt)
    }
  }
  return { pglite, db: drizzle(pglite, { schema }) }
}

// ── tarih ekseni ──────────────────────────────────────────────────────────

test('OCR-1: Durusoft penceresi birebir; orderDate ve modifiedAt AYRI sayılır', () => {
  const rows = [
    // orderDate içinde, modifiedAt dışında
    { packageId: 'p1', orderDate: '2026-07-29T08:00:00Z', marketplaceLastModifiedAt: '2026-08-03T00:00:00Z' },
    // orderDate dışında, modifiedAt içinde (eski sipariş, pencerede güncellendi)
    { packageId: 'p2', orderDate: '2026-07-01T08:00:00Z', marketplaceLastModifiedAt: '2026-07-30T09:00:00Z' },
    // her ikisi de içinde
    { packageId: 'p3', orderDate: '2026-07-30T10:00:00Z', marketplaceLastModifiedAt: '2026-07-31T10:00:00Z' },
    // her ikisi de dışında
    { packageId: 'p4', orderDate: '2026-06-01T10:00:00Z', marketplaceLastModifiedAt: '2026-06-02T10:00:00Z' },
  ]
  const counts = model.countByDateBasis(rows, START, END)
  assert.equal(counts.orderDateCohort, 2, 'p1 + p3')
  assert.equal(counts.modifiedAtActivity, 2, 'p2 + p3')
  assert.notEqual(counts.orderDateCohort, counts.modifiedAtActivity + 0 + 1)
  // Sınır: end HARİÇ (yarı-açık aralık).
  assert.equal(
    model.countByDateBasis([{ packageId: 'x', orderDate: END }], START, END)
      .orderDateCohort,
    0,
    'end sınırı hariç',
  )
  assert.equal(
    model.countByDateBasis([{ packageId: 'x', orderDate: START }], START, END)
      .orderDateCohort,
    1,
    'start sınırı dahil',
  )
})

// ── sekme tanımları (GERÇEK frontend fonksiyonu) ──────────────────────────

test('OCR-2: Yeni Siparişler / Etiket Hazır tanımları gerçek classifier\'dan gelir', async () => {
  const { classifyOrderForTabs, orderMatchesQuickTab } = await loadFrontend(
    '/src/utils/orderClassification.ts',
  )
  const mk = (over) => ({
    id: 'o', orderNumber: 'n', packageId: 'p',
    marketplaceStatus: 'Created', operationStatus: 'NEW', items: [], ...over,
  })
  const isNew = (o) => orderMatchesQuickTab(classifyOrderForTabs(o), 'newOrders')
  const isLabel = (o) => orderMatchesQuickTab(classifyOrderForTabs(o), 'labelStage')

  // Açık ve etiketsiz → Yeni Siparişler
  assert.equal(isNew(mk({})), true)
  assert.equal(isLabel(mk({})), false)
  // LABEL_READY → Etiket Hazır, Yeni Siparişler DEĞİL (çift sayım yok)
  const ready = mk({ operationStatus: 'LABEL_READY' })
  assert.equal(isLabel(ready), true)
  assert.equal(isNew(ready), false)
  // Shipped → ikisi de değil (processClosed)
  const shipped = mk({ marketplaceStatus: 'Shipped' })
  assert.equal(isNew(shipped), false)
  assert.equal(isLabel(shipped), false)
  // Delivered / Cancelled → ikisi de değil
  for (const status of ['Delivered', 'Cancelled', 'Returned', 'UnDelivered', 'UnSupplied']) {
    const o = mk({ marketplaceStatus: status })
    assert.equal(isNew(o), false, status)
    assert.equal(isLabel(o), false, status)
  }
})

// ── KÖK NEDEN: sayfa sınırı ───────────────────────────────────────────────

test('OCR-3: sipariş listesi artık TÜM sayfaları yükler (25 tavanı kalktı)', async () => {
  const src = readFileSync(
    join(here, '..', 'src/services/orderWorkflowService.ts'), 'utf8',
  )
  // Endpoint varsayılanı (25) KORUNUR; düzeltme istemci tarafındadır.
  const { resolvePageSize } = await import('./orders/orderRepository.ts')
  assert.equal(resolvePageSize(undefined), 25, 'backend varsayılanı değişmedi')

  // Yükleyici artık sayfa boyutunu AÇIKÇA verir ve tüm sayfaları dolaşır.
  assert.match(src, /const ORDERS_LOAD_PAGE_SIZE = 100/)
  assert.match(src, /resolveTotalPages\(total, effectivePageSize\)/, 'totalPages türetilir')
  assert.match(src, /const MAX_ORDER_PAGES = /, 'sonsuz döngü koruması')
  assert.match(src, /params\.set\('pageSize', String\(pageSize\)\)/)

  // Kısmi başarı yasak + snapshot doğrulaması ortak saf modülde.
  assert.match(src, /validateOrderPageMeta/)
  assert.match(src, /validatePaginationSnapshot/)
  const helper = readFileSync(
    join(here, '..', 'src/utils/orderPagination.ts'), 'utf8',
  )
  assert.match(helper, /geçersiz toplam kayıt/)
  assert.match(helper, /kayıt kümesi değişti/)

  // Eşzamanlılık koruması: stale yanıt cache'i ezmez.
  assert.match(src, /ordersLoadGeneration/)
})

test('OCR-4: karar mantığı — sayfa kesilmesi UI_FILTER_BUG verir, veri kaybı DEĞİL', () => {
  const truncated = model.decideReconciliation({
    localScopePackageCount: 35,
    uiLoadedPackageCount: 25,
    backendReportedTotal: 580,
    uiPageSize: 25,
    uiRequestsAllPages: false,
    accountScopeMismatchCount: 0,
    duplicatePackageCount: 0,
    missingLocalOrderCount: 0,
  })
  assert.equal(truncated.conclusion, 'UI_FILTER_BUG')
  assert.match(truncated.message, /Veri kaybı YOK/)
  assert.ok(truncated.evidence.some((e) => e.includes('uiPageSize=25')))

  // Sayfa dolaşılıyorsa aynı sayılar UI_FILTER_BUG vermez.
  const paged = model.decideReconciliation({
    localScopePackageCount: 35, uiLoadedPackageCount: 35,
    backendReportedTotal: 580, uiPageSize: 25, uiRequestsAllPages: true,
    accountScopeMismatchCount: 0, duplicatePackageCount: 0, missingLocalOrderCount: 0,
  })
  assert.notEqual(paged.conclusion, 'UI_FILTER_BUG')

  // Hesap kapsamı kusuru sayfa sorununun ÖNÜNDE gelir.
  assert.equal(
    model.decideReconciliation({
      localScopePackageCount: 35, uiLoadedPackageCount: 25,
      backendReportedTotal: 580, uiPageSize: 25, uiRequestsAllPages: false,
      accountScopeMismatchCount: 4, duplicatePackageCount: 0, missingLocalOrderCount: 0,
    }).conclusion,
    'ACCOUNT_SCOPE_BUG',
  )
  // Provider eksikse hiçbir şey karşılaştırılamaz.
  assert.equal(
    model.decideReconciliation({
      localScopePackageCount: 35, uiLoadedPackageCount: 25,
      backendReportedTotal: 580, uiPageSize: 25, uiRequestsAllPages: false,
      providerComplete: false,
      accountScopeMismatchCount: 0, duplicatePackageCount: 0, missingLocalOrderCount: 0,
    }).conclusion,
    'PROVIDER_FETCH_INCOMPLETE',
  )
  // Yerelde gerçekten eksik paket varsa (ve sayfa sorunu yoksa).
  assert.equal(
    model.decideReconciliation({
      localScopePackageCount: 30, uiLoadedPackageCount: 30,
      backendReportedTotal: 30, uiPageSize: 25, uiRequestsAllPages: true,
      accountScopeMismatchCount: 0, duplicatePackageCount: 0, missingLocalOrderCount: 5,
    }).conclusion,
    'LOCAL_DATA_MISSING',
  )
})

// ── exclusion invaryantı ──────────────────────────────────────────────────

test('OCR-5: exclusion invaryantı — her paket TEK bucket, toplam denk', () => {
  const tally = model.emptyExclusionTally()
  const rows = [
    { packageId: 'a', marketplaceStatus: 'Shipped' },
    { packageId: 'b', marketplaceStatus: 'Delivered' },
    { packageId: 'c', marketplaceStatus: 'Cancelled' },
    { packageId: 'd', marketplaceStatus: 'Created', operationStatus: 'LABEL_READY' },
  ]
  model.tallyExclusion(tally, rows[0], 'shipped_or_delivered_excluded')
  model.tallyExclusion(tally, rows[1], 'shipped_or_delivered_excluded')
  model.tallyExclusion(tally, rows[2], 'cancelled_or_returned_excluded')
  model.tallyExclusion(tally, rows[3], 'label_ready_separated')
  const inv = model.checkInvariant(10, 6, tally)
  assert.equal(inv.excludedTotal, 4)
  assert.equal(inv.balanced, true, '10 = 6 görünen + 4 dışlanan')
  assert.equal(inv.unexplained, 0)
  // Denksizlik gizlenmez.
  assert.equal(model.checkInvariant(12, 6, tally).balanced, false)
  assert.equal(model.checkInvariant(12, 6, tally).unexplained, 2)
})

// ── gerçek DB yolu (hermetik pglite) — 35 → 25 kesilmesi ──────────────────

test('OCR-6: gerçek şemada 35 paket yerelde MEVCUT ama UI yalnız 25 yükler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'ocr', slug: 'ocr' }).returning()
  const accA = await accounts.resolveOrCreateActiveAccount(db, org.id, 'Trendyol', '277221')
  const accB = await accounts.resolveOrCreateActiveAccount(db, org.id, 'Trendyol', '999999')

  // Durusoft penceresinde 35 paket; 33 Created + 2 LABEL_READY.
  const rows = []
  for (let i = 0; i < 35; i += 1) {
    rows.push({
      organizationId: org.id, marketplaceAccountId: accA.id,
      marketplace: 'Trendyol', packageId: `PKG-${i}`, orderNumber: `ORD-${i}`,
      marketplaceStatus: 'Created',
      operationStatus: i < 2 ? 'LABEL_READY' : 'NEW',
      orderDate: new Date('2026-07-29T08:00:00Z'),
      marketplaceLastModifiedAt: new Date('2026-07-30T08:00:00Z'),
    })
  }
  // Kapsam dışı: başka hesap + pencere dışı.
  rows.push({
    organizationId: org.id, marketplaceAccountId: accB.id,
    marketplace: 'Trendyol', packageId: 'PKG-OTHER', orderNumber: 'ORD-OTHER',
    marketplaceStatus: 'Created', operationStatus: 'NEW',
    orderDate: new Date('2026-07-29T08:00:00Z'),
  })
  rows.push({
    organizationId: org.id, marketplaceAccountId: accA.id,
    marketplace: 'Trendyol', packageId: 'PKG-OLD', orderNumber: 'ORD-OLD',
    marketplaceStatus: 'Created', operationStatus: 'NEW',
    orderDate: new Date('2026-06-01T08:00:00Z'),
  })
  const inserted = await db.insert(schema.orders).values(rows).returning()
  // Her siparişe 1 satır (35 paket = 36 kalem senaryosu için birine 2 satır).
  const lineRows = inserted.map((o, i) => ({
    organizationId: org.id, orderId: o.id, externalLineId: `L-${i}`,
    productName: 'Ürün', quantity: 1, barcode: `B${i}`,
  }))
  lineRows.push({
    organizationId: org.id, orderId: inserted[0].id, externalLineId: 'L-extra',
    productName: 'Ürün 2', quantity: 1, barcode: 'BX',
  })
  await db.insert(schema.orderLines).values(lineRows)

  const scope = {
    organizationId: org.id, marketplace: 'Trendyol',
    providerAccountId: '277221', startIso: START, endIso: END,
  }
  const local = await loader.loadLocalScope(db, scope)
  assert.equal(local.accountResolved, true)
  const localModel = model.summarizePackages(local.rows)

  // Kapsamdaki TÜM kayıtlar yerelde MEVCUT: 35 paket, 36 kalem.
  assert.equal(localModel.distinctPackageCount, 35, 'Durusoft 35 ile eşleşir')
  assert.equal(localModel.lineCount, 36, 'Durusoft 36 kalem ile eşleşir')
  assert.equal(localModel.quantityTotal, 36)
  assert.equal(local.accountScopeMismatchCount, 1, 'diğer hesap ayrı sayılır')
  assert.equal(local.duplicatePackageIds, 0)
  assert.equal(local.ordersWithoutLines, 0)

  // UI ise varsayılan sayfa sınırı yüzünden yalnız 25 kayıt yükler.
  const ui = await loader.describeUiLoad(db, scope, local.marketplaceAccountId)
  assert.equal(ui.effectivePageSize, 25)
  assert.equal(ui.loadedCount, 25, 'ekrandaki "Kalıcı operasyon listesi: 25"')
  assert.equal(ui.requestsAllPages, false)
  assert.equal(ui.truncated, true)
  assert.ok(ui.backendReportedTotal >= 36, 'DB toplamı sayfa sınırından büyük')

  const decision = model.decideReconciliation({
    localScopePackageCount: localModel.distinctPackageCount,
    uiLoadedPackageCount: ui.loadedCount,
    backendReportedTotal: ui.backendReportedTotal,
    uiPageSize: ui.effectivePageSize,
    uiRequestsAllPages: ui.requestsAllPages,
    accountScopeMismatchCount: 0,
    duplicatePackageCount: local.duplicatePackageIds,
    missingLocalOrderCount: 0,
  })
  assert.equal(decision.conclusion, 'UI_FILTER_BUG')

  // SALT OKUNUR: satır sayıları değişmedi.
  assert.equal((await db.select().from(schema.orders)).length, 37)
  // DB'de 38 satır var (37 siparişin her birine 1 + PKG-0'a 1 ekstra);
  // KAPSAMDAKİ kalem sayısı ise 36'dır. İkisi farklı büyüklüktür.
  assert.equal((await db.select().from(schema.orderLines)).length, 38)
})

test('OCR-7: hesap izolasyonu — diğer hesabın paketleri kapsama SIZMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const [org] = await db.insert(schema.organizations)
    .values({ name: 'ocr7', slug: 'ocr7' }).returning()
  const accA = await accounts.resolveOrCreateActiveAccount(db, org.id, 'Trendyol', '277221')
  const accB = await accounts.resolveOrCreateActiveAccount(db, org.id, 'Trendyol', '999999')
  await db.insert(schema.orders).values([
    { organizationId: org.id, marketplaceAccountId: accA.id, marketplace: 'Trendyol',
      packageId: 'A1', orderNumber: 'A1', marketplaceStatus: 'Created',
      orderDate: new Date('2026-07-29T08:00:00Z') },
    { organizationId: org.id, marketplaceAccountId: accB.id, marketplace: 'Trendyol',
      packageId: 'B1', orderNumber: 'B1', marketplaceStatus: 'Created',
      orderDate: new Date('2026-07-29T08:00:00Z') },
  ])
  const a = await loader.loadLocalScope(db, {
    organizationId: org.id, marketplace: 'Trendyol',
    providerAccountId: '277221', startIso: START, endIso: END,
  })
  assert.equal(model.summarizePackages(a.rows).distinctPackageCount, 1)
  assert.equal(a.accountScopeMismatchCount, 1)
  const unknown = await loader.loadLocalScope(db, {
    organizationId: org.id, marketplace: 'Trendyol',
    providerAccountId: '000000', startIso: START, endIso: END,
  })
  assert.equal(unknown.accountResolved, false)
  assert.equal(unknown.rows.length, 0)
})

test('OCR-8: paket / kalem / adet AYRI tanımlardır', () => {
  const rows = [
    { packageId: 'p1', orderNumber: 'o1', lineCount: 2, quantityTotal: 5 },
    { packageId: 'p2', orderNumber: 'o1', lineCount: 1, quantityTotal: 1 },
  ]
  const m = model.summarizePackages(rows)
  assert.equal(m.distinctPackageCount, 2, 'paket')
  assert.equal(m.distinctOrderCount, 1, 'sipariş (aynı sipariş iki paket)')
  assert.equal(m.lineCount, 3, 'kalem')
  assert.equal(m.quantityTotal, 6, 'adet')
  assert.notEqual(m.distinctPackageCount, m.lineCount)
  assert.notEqual(m.lineCount, m.quantityTotal)
})

// ── gizlilik + salt okunurluk ─────────────────────────────────────────────

test('OCR-9: rapor PII veya ham ID TAŞIMAZ; yalnız SHA-256 ilk 12 karakter', () => {
  const tally = model.emptyExclusionTally()
  model.tallyExclusion(
    tally,
    { packageId: '7270035037484352', orderNumber: 'SECIL-3346',
      marketplaceStatus: 'Shipped', operationStatus: 'SHIPPED' },
    'shipped_or_delivered_excluded',
  )
  const serialized = JSON.stringify(tally)
  assert.equal(serialized.includes('7270035037484352'), false, 'ham packageId sızmadı')
  assert.equal(serialized.includes('SECIL-3346'), false, 'ham orderNumber sızmadı')
  assert.equal(tally.samples.length, 1)
  assert.match(tally.samples[0].fingerprint, /^[0-9a-f]{12}$/)
  assert.deepEqual(
    Object.keys(tally.samples[0]).sort(),
    ['fingerprint', 'marketplaceStatus', 'operationStatus', 'stage'],
  )
  // Aynı girdi aynı parmak izini verir (tekrar üretilebilir kanıt).
  assert.equal(
    model.safeFingerprint('7270035037484352'),
    model.safeFingerprint('7270035037484352'),
  )
  assert.notEqual(
    model.safeFingerprint('7270035037484352'),
    model.safeFingerprint('7270035037484353'),
  )
})

test('OCR-10: CLI ve loader SALT OKUNUR — write/provider çağrısı içermez', () => {
  const cli = readFileSync(
    join(here, 'analytics', 'orderCountReconcileCli.ts'), 'utf8')
  const load = readFileSync(
    join(here, 'analytics', 'orderCountReconcileLoader.ts'), 'utf8')
  for (const forbidden of [
    '.insert(', '.update(', '.delete(', 'fetch(', 'axios',
    'createShipment', 'syncOrders',
  ]) {
    for (const [name, src] of [['CLI', cli], ['loader', load]]) {
      assert.equal(
        src.toLowerCase().includes(forbidden.toLowerCase()), false,
        `${name} yasak çağrı içeriyor: ${forbidden}`,
      )
    }
  }
  assert.match(load, /\.select\(/)
  assert.match(cli, /--apply desteklenmez/)
  // Saf model DB/ağ import etmez.
  const pure = readFileSync(
    join(here, 'analytics', 'orderCountReconcile.ts'), 'utf8')
  assert.equal(/from '\.\.\/db\//.test(pure), false)
  assert.equal(/drizzle/.test(pure), false)
  // npm script kayıtlı.
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['orders:count-reconcile'],
    'node server/analytics/orderCountReconcileCli.ts',
  )
})
