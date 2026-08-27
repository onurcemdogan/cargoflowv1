import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ UYGULAMA PERFORMANSI — DEĞİŞMEZLER ═════════════════════════════════
//
// Bu dosya GECİKME EŞİĞİ DAYATMAZ. Milisaniye rakamları makineye, çekirdek
// sayısına ve o anki yüke bağlıdır; CI'da eşik koymak testi kırılgan yapar
// ve gerçek bir regresyonu kanıtlamaz.
//
// Dayatılan şey ORTAMDAN BAĞIMSIZ olan sorgu sayısıdır:
//   • sayfa başına sorgu sayısı, SAYFA BOYUTUNDAN bağımsızdır (N+1 yok)
//   • sipariş detayı ve hazır etiket okuması SABİT sayıda sorgu üretir
//
// Gecikme rakamları `appPerformanceBenchmark` CLI'ı ile ölçülür ve raporda
// KAPSAM UYARISIYLA birlikte yayımlanır (üretim SLA'sı değildir).
//
// TAŞIYICI VE PAZARYERİ ÇAĞRISI YOKTUR. Gerçek etiket ÜRETİLMEZ.

const here = dirname(fileURLToPath(import.meta.url))

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

// Ölçüm yükü KÜÇÜK tutulur: bu test doğruluk testidir, kıyaslama değil.
const ORDERS = 120

test('PERF-1: sayfa sorgu sayisi SAYFA BOYUTUNDAN bagimsizdir (N+1 yok)', async (t) => {
  const bench = await load('/server/benchmarks/appPerformanceBenchmark.ts')
  const persistence = await load('/server/orders/orderPersistenceService.ts')
  const { pglite, db, seed } = await bench.makeSeededDb(ORDERS)
  t.after(() => pglite.close())

  const measureQueries = async (pageSize) => {
    const counter = bench.countingDb(db)
    await persistence.listOrders(counter.db, seed.organizationId, {
      page: 1,
      pageSize,
    })
    return counter.count()
  }

  const q10 = await measureQueries(10)
  const q50 = await measureQueries(50)
  const q100 = await measureQueries(100)

  // KÖK KANIT: 10 kat daha fazla satır, AYNI sorgu sayısı.
  assert.equal(q50, q10)
  assert.equal(q100, q10)
  // Sorgu sayısı makul bir sabit olmalı (sayfa + toplam + satırlar +
  // gönderiler + operasyonlar). Üst sınır, sessiz bir katman eklenmesini
  // yakalar.
  assert.ok(q100 > 0 && q100 <= 8, `sayfa basina ${q100} sorgu`)
})

test('PERF-2: siparis detayi ve hazir etiket SABIT sorgu uretir', async (t) => {
  const bench = await load('/server/benchmarks/appPerformanceBenchmark.ts')
  const persistence = await load('/server/orders/orderPersistenceService.ts')
  const { pglite, db, seed } = await bench.makeSeededDb(ORDERS)
  t.after(() => pglite.close())

  const count = async (run) => {
    const counter = bench.countingDb(db)
    await run(counter.db)
    return counter.count()
  }

  const first = await count((handle) =>
    persistence.getOrder(handle, seed.organizationId, seed.orderIds[0]),
  )
  const last = await count((handle) =>
    persistence.getOrder(handle, seed.organizationId, seed.orderIds.at(-1)),
  )
  assert.equal(first, last)
  assert.ok(first > 0 && first <= 6, `detay ${first} sorgu`)

  const label = await count((handle) =>
    persistence.resolvePersistedLabel(handle, seed.organizationId, seed.orderIds[0]),
  )
  // Hazır etiket okuması, detay okumasının üstüne YENİ bir sorgu katmanı
  // eklememelidir: artefakt zaten gönderi kaydında kalıcıdır.
  assert.ok(label <= first + 1, `etiket ${label} sorgu, detay ${first} sorgu`)
})

test('PERF-3: dashboard satis araligi TEK sorgu ciftiyle cozulur', async (t) => {
  const bench = await load('/server/benchmarks/appPerformanceBenchmark.ts')
  const persistence = await load('/server/orders/orderPersistenceService.ts')
  const { pglite, db, seed } = await bench.makeSeededDb(ORDERS)
  t.after(() => pglite.close())

  const counter = bench.countingDb(db)
  const rows = await persistence.listOrdersForAnalytics(
    counter.db,
    seed.organizationId,
    { startMs: Date.UTC(2026, 7, 1), endMs: Date.UTC(2026, 7, 28) },
  )
  assert.ok(rows.length > 0)
  // Sipariş + satır: sipariş BAŞINA sorgu YOK.
  assert.equal(counter.count(), 2)
})

test('PERF-4: rapor KAPSAM UYARISINI kendisi tasir', async () => {
  const bench = await load('/server/benchmarks/appPerformanceBenchmark.ts')
  const report = await bench.runAppPerformanceBenchmark({
    orderCount: 60,
    repeats: 3,
  })
  assert.equal(report.nPlusOneGuard.constant, true)
  assert.equal(report.measurements.length, 5)
  for (const row of report.measurements) {
    assert.ok(row.p50 >= 0 && row.p95 >= row.p50, row.label)
    assert.ok(row.queries > 0, row.label)
  }
  // Rakamlar üretim SLA'sı olarak alıntılanamaz; rapor bunu KENDİSİ söyler.
  assert.match(report.scopeCaveat, /PGlite/)
  assert.match(report.scopeCaveat, /SLA/)
})

test('PERF-5: UI okuma yollari TASIYICI/PAZARYERI cagrisi YAPMAZ', async (t) => {
  const bench = await load('/server/benchmarks/appPerformanceBenchmark.ts')
  const persistence = await load('/server/orders/orderPersistenceService.ts')
  const { pglite, db, seed } = await bench.makeSeededDb(ORDERS)
  t.after(() => pglite.close())

  // UI_WAITS_FOR_TRENDYOL = NO. Liste, dashboard, detay ve hazır etiket
  // okuması YALNIZ yerel veritabanını okur; hiçbiri ağa çıkmaz. Aksi hâlde
  // pazaryeri yavaşladığında kullanıcının ekranı da yavaşlardı.
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]))
    throw new Error('UI okuma yolunda ag cagrisi OLMAMALI')
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const org = seed.organizationId
  await persistence.listOrders(db, org, { page: 1, pageSize: 50 })
  await persistence.listOrdersForAnalytics(db, org, {
    startMs: Date.UTC(2026, 7, 1),
    endMs: Date.UTC(2026, 7, 28),
  })
  await persistence.getOrder(db, org, seed.orderIds[0])
  await persistence.resolvePersistedLabel(db, org, seed.orderIds[0])

  assert.deepEqual(calls, [])
})

test('PERF-6: /api/orders ucu pazaryerine CIKMAZ', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const source = readFileSync(
    join(here, 'index.mjs'),
    'utf8',
  )
  const start = source.indexOf("app.get('/api/orders', async")
  assert.ok(start > 0)
  const NEXT_ROUTE = String.fromCharCode(10) + 'app.'
  const handler = source.slice(start, source.indexOf(NEXT_ROUTE, start + 10))
  // Uç yalnız kalıcı katmanı okur. Trendyol istemcisi, senkron tetikleyicisi
  // veya ham fetch bu handler'da BULUNMAZ.
  for (const forbidden of ['callTrendyol', 'trendyol', 'fetch(', 'syncOrders']) {
    assert.ok(
      !handler.toLowerCase().includes(forbidden.toLowerCase()),
      `handler icinde ${forbidden} bulundu`,
    )
  }
})
