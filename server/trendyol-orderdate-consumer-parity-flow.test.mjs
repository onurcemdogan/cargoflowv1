// TRENDYOL-ORDERDATE — KANONİK DÜZELTMENİN AŞAĞI AKIŞ ETKİLERİ.
//
// ═══ NE BEKLENİR ═════════════════════════════════════════════════════════
//
// Kanonik anı düzeltmek gün kovasını, tarih filtresini ve sıra konumunu
// DEĞİŞTİREBİLİR. Önceki sonuç YANLIŞ ANA dayanıyorsa bu bir REGRESYON
// DEĞİL, DÜZELTMEDİR. Bu dosya değişimin YÖNÜNÜ ve SINIRLARINI sabitler.
//
// ═══ NEDEN 20:30–23:30 UTC SINIRLARI ═════════════════════════════════════
//
// Siparişler ekranı ve etiket gösterimi Europe/Istanbul (+03) gününe göre
// çalışır: 21:00Z = ertesi gün 00:00 İstanbul. Kusurlu kayıt 3 saat İLERİDE
// olduğu için, gerçek an 18:00–21:00Z aralığındaki siparişler ekranda BİR
// SONRAKİ GÜNE düşmüştü. Düzeltme onları DOĞRU güne geri taşır.
//
// Dashboard satış kovası ise UTC sınırlıdır (SALES_REPORTING_TIME_ZONE);
// orada kritik aralık 00:00–03:00Z'dir. İKİSİ DE sınanır.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const vite = await createServer({
  root,
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  logLevel: 'error',
})
test.after(() => vite.close())

const { dateKeyInTimeZone, buildOrdersDateRange, isOrderWithinDateRange, ORDERS_TIME_ZONE } =
  await vite.ssrLoadModule('/src/utils/orderDateRange.ts')
const { buildDashboardSalesPeriodCards } = await vite.ssrLoadModule(
  '/src/dashboard/dashboardViewModel.ts',
)
const { resolveReportingRange, DASHBOARD_SALES_REPORTING_TIME_ZONE } =
  await vite.ssrLoadModule('/src/dashboard/reportingRange.ts')
const { formatLabelOrderDateTime } = await vite.ssrLoadModule(
  '/src/utils/labelOrderDateTime.ts',
)

const OFFSET_MS = 180 * 60_000
const corrected = (storedIso) => new Date(Date.parse(storedIso) - OFFSET_MS).toISOString()

// ── §7 SINIR DAVRANIŞI ─────────────────────────────────────────────────────

test('TZC-1: 20:30/21:30/22:30/23:30Z — Istanbul GUN KOVASI duzeltme ile geri gelir', () => {
  const cases = [
    // [kusurlu kayit, duzeltilmis, kusurlu Istanbul gunu, dogru Istanbul gunu]
    ['2026-09-14T20:30:00.000Z', '2026-09-14', '2026-09-14'],
    ['2026-09-14T21:30:00.000Z', '2026-09-15', '2026-09-14'],
    ['2026-09-14T22:30:00.000Z', '2026-09-15', '2026-09-14'],
    ['2026-09-14T23:30:00.000Z', '2026-09-15', '2026-09-14'],
  ]
  for (const [stored, expectedWrongDay, expectedRightDay] of cases) {
    const wrongKey = dateKeyInTimeZone(new Date(stored), ORDERS_TIME_ZONE)
    const rightKey = dateKeyInTimeZone(new Date(corrected(stored)), ORDERS_TIME_ZONE)
    assert.equal(wrongKey, expectedWrongDay, `${stored}: kusurlu gun`)
    assert.equal(rightKey, expectedRightDay, `${stored}: duzeltilmis gun`)
  }
  // 21:00Z ve SONRASI icin gun DEGISIR; 20:30Z icin DEGISMEZ. Degisim
  // rastgele degil, SINIRA baglidir.
  assert.notEqual(
    dateKeyInTimeZone(new Date('2026-09-14T21:30:00.000Z'), ORDERS_TIME_ZONE),
    dateKeyInTimeZone(new Date(corrected('2026-09-14T21:30:00.000Z')), ORDERS_TIME_ZONE),
  )
  assert.equal(
    dateKeyInTimeZone(new Date('2026-09-14T20:30:00.000Z'), ORDERS_TIME_ZONE),
    dateKeyInTimeZone(new Date(corrected('2026-09-14T20:30:00.000Z')), ORDERS_TIME_ZONE),
  )
})

test('TZC-2: etiket gosterimi — kusurlu saat 3 saat ILERI basiyordu', () => {
  const stored = '2026-09-14T20:36:00.000Z'
  assert.equal(formatLabelOrderDateTime(stored), '14.09.2026 23:36')
  assert.equal(formatLabelOrderDateTime(corrected(stored)), '14.09.2026 20:36')
})

// ── §7 TARİH FİLTRESİ ──────────────────────────────────────────────────────

test('TZC-3: Siparisler tarih filtresi — duzeltilen siparis DOGRU gune duser', () => {
  const stored = '2026-09-14T22:30:00.000Z' // Istanbul: 15 Eylul 01:30 (YANLIS)
  const fixed = corrected(stored) // Istanbul: 14 Eylul 22:30 (DOGRU)
  const sep14 = buildOrdersDateRange('custom', '2026-09-14', '2026-09-14')
  const sep15 = buildOrdersDateRange('custom', '2026-09-15', '2026-09-15')

  // ÖNCE: 15 Eylül filtresinde görünüyordu, 14 Eylül'de görünmüyordu.
  assert.equal(isOrderWithinDateRange({ orderDate: stored, createdAt: stored }, sep15), true)
  assert.equal(isOrderWithinDateRange({ orderDate: stored, createdAt: stored }, sep14), false)
  // SONRA: 14 Eylül'de görünür, 15 Eylül'den düşer. Bu DÜZELTMEDİR.
  assert.equal(isOrderWithinDateRange({ orderDate: fixed, createdAt: fixed }, sep14), true)
  assert.equal(isOrderWithinDateRange({ orderDate: fixed, createdAt: fixed }, sep15), false)
})

test('TZC-4: gun ICI siparis filtrede AYNI gunde kalir (gereksiz oynama YOK)', () => {
  // Gerçek an 09:00 Istanbul → kusurlu kayıt 12:00 Istanbul: gün AYNI.
  const stored = '2026-09-14T09:00:00.000Z'
  const fixed = corrected(stored)
  const sep14 = buildOrdersDateRange('custom', '2026-09-14', '2026-09-14')
  assert.equal(isOrderWithinDateRange({ orderDate: stored, createdAt: stored }, sep14), true)
  assert.equal(isOrderWithinDateRange({ orderDate: fixed, createdAt: fixed }, sep14), true)
})

// ── §7 SIRALAMA ────────────────────────────────────────────────────────────

test('TZC-5: SIRALAMA — kaymis ve kaymamis siparisler karisikken sira DUZELIR', () => {
  // A: kusurlu (kaymış). B: zaten doğru (ofsetli ham değerden gelmiş).
  // Kusurlu hâlde A, B'den SONRA görünüyordu; gerçekte A ÖNCE verilmiş.
  const aStored = '2026-09-14T20:00:00.000Z' // gercek an 17:00Z
  const bStored = '2026-09-14T18:00:00.000Z' // zaten dogru
  const before = [
    { id: 'A', orderDate: aStored },
    { id: 'B', orderDate: bStored },
  ].sort((l, r) => Date.parse(r.orderDate) - Date.parse(l.orderDate))
  assert.deepEqual(before.map((o) => o.id), ['A', 'B'], 'ONCE: A yanlis sekilde once')

  const after = [
    { id: 'A', orderDate: corrected(aStored) },
    { id: 'B', orderDate: bStored },
  ].sort((l, r) => Date.parse(r.orderDate) - Date.parse(l.orderDate))
  assert.deepEqual(
    after.map((o) => o.id),
    ['B', 'A'],
    'SONRA: gercek zamana gore B once — sira degisimi DUZELTMEDIR',
  )
})

// ── §7 DASHBOARD KOVASI (UTC SINIRLI) ──────────────────────────────────────

test('TZC-6: dashboard satis kovasi UTC sinirlidir — kritik aralik 00:00-03:00Z', () => {
  assert.equal(DASHBOARD_SALES_REPORTING_TIME_ZONE, 'UTC')
  const now = new Date('2026-09-15T12:00:00.000Z')
  const today = resolveReportingRange('today', now, DASHBOARD_SALES_REPORTING_TIME_ZONE)
  const stored = '2026-09-15T01:00:00.000Z' // kusurlu: 15 Eylul UTC
  const fixed = corrected(stored) // dogru: 14 Eylul 22:00Z
  const inRange = (iso) =>
    Date.parse(iso) >= today.start.getTime() && Date.parse(iso) < today.end.getTime()
  assert.equal(inRange(stored), true, 'ONCE: bugunun kovasindaydi')
  assert.equal(inRange(fixed), false, 'SONRA: dune tasindi — BEKLENEN degisim')
})

test('TZC-7: dashboard satis kartlari duzeltme sonrasi DOGRU gune sayar', () => {
  const now = new Date('2026-09-15T12:00:00.000Z')
  const order = (iso) => ({
    id: `o-${iso}`,
    marketplace: 'Trendyol',
    orderNumber: `N-${iso}`,
    packageId: `P-${iso}`,
    status: 'Created',
    marketplaceStatus: 'Created',
    orderDate: iso,
    createdAt: iso,
    totalAmount: 100,
    currency: 'TRY',
    items: [],
  })
  const stored = '2026-09-15T01:00:00.000Z'
  const cardOf = (cards, key) => cards.find((card) => card.key === key)
  const shape = (cards, key) => ({
    salesAmount: cardOf(cards, key).salesAmount,
    packageCount: cardOf(cards, key).packageCount,
  })

  const before = buildDashboardSalesPeriodCards([order(stored)], now)
  // ÖNCE: kusurlu kayıt BUGÜNE sayılıyordu.
  assert.deepEqual(shape(before, 'today'), { salesAmount: 100, packageCount: 1 })
  assert.deepEqual(shape(before, 'yesterday'), { salesAmount: 0, packageCount: 0 })

  const after = buildDashboardSalesPeriodCards([order(corrected(stored))], now)
  // SONRA: DÜNE sayılır. Sayım KAYBOLMAZ, DOĞRU güne taşınır.
  assert.deepEqual(shape(after, 'today'), { salesAmount: 0, packageCount: 0 })
  assert.deepEqual(shape(after, 'yesterday'), { salesAmount: 100, packageCount: 1 })

  // TOPLAM KORUNUR: ay kartinda sayim DEGISMEZ (gun degisti, satis degil).
  assert.deepEqual(shape(before, 'month'), shape(after, 'month'))
})

// ── §8 SENKRON GÜVENLİĞİ ───────────────────────────────────────────────────

test('TZC-8: senkron imleci orderDate DEGILDIR — onarim imleci OYNATMAZ', async () => {
  const policy = await vite.ssrLoadModule('/server/orders/syncWindowPolicy.ts')
  // Pencere YALNIZ checkpoint + now'dan turer; siparis tarihi girdisi YOK.
  const window = policy.resolveSyncWindow({
    checkpointMs: Date.parse('2026-09-14T00:00:00.000Z'),
    nowMs: Date.parse('2026-09-15T00:00:00.000Z'),
  })
  assert.ok(Number.isFinite(window.startMs) && Number.isFinite(window.endMs))
  const source = readFileSync(join(here, 'orders', 'syncWindowPolicy.ts'), 'utf8')
  assert.equal(
    /orderDate|order_date/.test(source),
    false,
    'senkron penceresi siparis tarihine BAKMAZ',
  )
  // İmleç ilerletme de yalnız pencere adayını kullanır.
  const advanced = policy.advanceCheckpoint({
    currentCheckpointMs: 1,
    candidateCheckpointMs: 2,
    complete: true,
  })
  assert.equal(advanced.advanced, true)
  assert.equal(advanced.checkpointMs, 2)
})

test('TZC-9: dedup kimligi tarih TASIMAZ — duplicate/kayip siparis riski YOK', () => {
  const schema = readFileSync(join(here, 'db', 'schema.ts'), 'utf8')
  const start = schema.indexOf('orders_org_marketplace_account_package_unique')
  assert.ok(start > 0, 'orders unique index bulunamadi')
  // SABİT KARAKTER PENCERESİ KULLANILMAZ: dilim, unique tanımının KENDİ
  // sonunda (`.nullsNotDistinct()`) biter. Sabit pencere komşu performans
  // indeksine (`orders_org_order_date_idx`) taşar ve testi YANLIŞ düşürürdü.
  const end = schema.indexOf('.nullsNotDistinct()', start)
  assert.ok(end > start, 'unique tanimi sonu bulunamadi')
  const block = schema.slice(start, end)
  for (const dateish of ['orderDate', 'order_date', 'firstSeenAt', 'createdAt']) {
    assert.equal(
      block.includes(dateish),
      false,
      `dedup anahtarinda tarih alani: ${dateish}`,
    )
  }
  assert.ok(block.includes('packageId'), 'kimlik PAKETTIR')
})

test('TZC-10: onarim cekirdegi pazaryeri/tasiyici/kuyruk cagrisi YAPMAZ', () => {
  const source = readFileSync(join(here, 'orders', 'trendyolOrderDateRepair.ts'), 'utf8')
  for (const forbidden of [
    'fetch(',
    'axios',
    'labelJobs',
    'label_jobs',
    'shipments',
    'surat',
    'Surat',
    'trendyolClient',
    'enqueue',
  ]) {
    assert.equal(source.includes(forbidden), false, `onarimda yan etki: ${forbidden}`)
  }
})

// ── §9 FİNANS ──────────────────────────────────────────────────────────────

test('TZC-11: orderDate MUTABAKAT/ODEME zaman damgasi YERINE kullanilmaz', () => {
  // Satış kohortu bilinçli olarak orderDate'tir; fakat mutabakat/aktivite
  // ekseni AYRI alandır (marketplaceLastModifiedAt). İkisinin AYRI olduğu
  // dashboard mutabakat raporunda SABİTLENMİŞTİR.
  const report = readFileSync(join(here, 'analytics', 'dashboardReconcileReport.ts'), 'utf8')
  assert.match(report, /orderDateCohort/)
  assert.match(report, /modifiedActivity/)
  // Sürat faturalama taraması sipariş tarihini SIRALAMA icin kullanir,
  // tutar/donem kaynagi olarak DEGIL.
  const billing = readFileSync(join(here, 'shipments', 'suratBillingScanner.ts'), 'utf8')
  const orderDateLines = billing
    .split('\n')
    .filter((line) => line.includes('orders.orderDate'))
  assert.ok(orderDateLines.length > 0)
  for (const line of orderDateLines) {
    assert.match(line, /orderBy|desc\(|asc\(/, `finans ekseni olarak kullanim: ${line.trim()}`)
  }
})
