import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Sipariş listesinin TÜM sayfaları yüklemesi (25 kayıt tavanının kaldırılması).
// Sentetik veri; gerçek müşteri bilgisi veya gerçek ID YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
      // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
      // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
      // "server is being restarted or closed" hatası verir. SSR-only test
      // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
      // tarama tamamen kapatılır.
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const PAGE_SIZE = 100

function makeOrder(i) {
  return {
    id: `o-${i}`,
    orderNumber: `ORD-${i}`,
    packageId: `PKG-${i}`,
    marketplace: 'Trendyol',
    marketplaceStatus: 'Created',
    operationStatus: i < 2 ? 'LABEL_READY' : 'NEW',
    orderDate: '2026-07-29T08:00:00.000Z',
    items: [{ id: `l-${i}`, productName: 'Ürün', quantity: 1, barcode: `B${i}` }],
  }
}

// Sahte /api/orders: sözleşme {ok,orders,total,page,pageSize}.
function installFetch(options) {
  const {
    total,
    failPages = new Set(),
    slowPages = new Map(),
    duplicateOnPage2 = false,
    emptyPages = new Set(),
    totalOverride,
    makeItems = makeOrder,
  } = options
  const calls = []
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost')
    const page = Number(parsed.searchParams.get('page') ?? 1)
    const pageSize = Number(parsed.searchParams.get('pageSize') ?? PAGE_SIZE)
    calls.push({ page, pageSize, query: parsed.search })
    if (slowPages.has(page)) {
      await new Promise((resolve) => setTimeout(resolve, slowPages.get(page)))
    }
    if (failPages.has(page)) {
      return { ok: false, status: 500, json: async () => ({}) }
    }
    let orders
    if (emptyPages.has(page)) {
      orders = []
    } else {
      const start = (page - 1) * pageSize
      orders = Array.from(
        { length: Math.max(0, Math.min(pageSize, total - start)) },
        (_, k) => makeItems(start + k),
      )
      if (duplicateOnPage2 && page === 2 && orders.length > 0) {
        // 1. sayfadaki ilk kaydı 2. sayfada TEKRAR gönder (kayan pencere).
        orders = [makeItems(0), ...orders.slice(1)]
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        orders,
        total: totalOverride ?? total,
        page,
        pageSize,
      }),
    }
  }
  return calls
}

async function makeService() {
  const { OrderWorkflowService } = await load('/src/services/orderWorkflowService.ts')
  return new OrderWorkflowService({}, {}, {}, {}, { append: () => [] })
}

let previousFetch
let previousWindow
test.beforeEach(() => {
  previousFetch = globalThis.fetch
  previousWindow = globalThis.window
  const storage = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  }
})
test.afterEach(() => {
  globalThis.fetch = previousFetch
  globalThis.window = previousWindow
})

// ── sayfa sayısı senaryoları ──────────────────────────────────────────────

test('PAG-1: 25\'ten az kayıt tek sayfada gelir', async () => {
  const calls = installFetch({ total: 12 })
  const orders = await (await makeService()).loadOrdersFromServer()
  assert.equal(orders.length, 12)
  assert.equal(calls.length, 1, 'tek istek')
  assert.equal(calls[0].pageSize, PAGE_SIZE, 'sayfa boyutu 25 DEĞİL')
})

test('PAG-2: tam 25 kayıt artık tavana takılmaz', async () => {
  installFetch({ total: 25 })
  const orders = await (await makeService()).loadOrdersFromServer()
  assert.equal(orders.length, 25)
})

test('PAG-3: 35 paket İKİ sayfadan eksiksiz yüklenir (Durusoft senaryosu)', async () => {
  // Backend'in 25'lik varsayılanını taklit et: pageSize yanıtta 25 dönerse
  // yükleyici KALAN sayfaları da çeker.
  const calls = []
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost')
    const page = Number(parsed.searchParams.get('page') ?? 1)
    calls.push(page)
    const size = 25
    const start = (page - 1) * size
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        orders: Array.from(
          { length: Math.max(0, Math.min(size, 35 - start)) },
          (_, k) => makeOrder(start + k),
        ),
        total: 35, page, pageSize: size,
      }),
    }
  }
  const orders = await (await makeService()).loadOrdersFromServer()
  assert.equal(orders.length, 35, 'ekrandaki 25 tavanı kalktı')
  assert.deepEqual(calls, [1, 2], 'iki sayfa çekildi')
  const packages = new Set(orders.map((o) => o.packageId))
  assert.equal(packages.size, 35, 'paket sayısı 35')
})

test('PAG-4: 35 paket / 36 kalem / 36 adet özeti korunur', async () => {
  installFetch({
    total: 35,
    makeItems: (i) =>
      i === 0
        ? {
            ...makeOrder(0),
            items: [
              { id: 'l-0', productName: 'Ürün', quantity: 1, barcode: 'B0' },
              { id: 'l-0b', productName: 'Ürün 2', quantity: 1, barcode: 'B0b' },
            ],
          }
        : makeOrder(i),
  })
  const orders = await (await makeService()).loadOrdersFromServer()
  assert.equal(orders.length, 35, 'paket')
  const lineCount = orders.reduce((t, o) => t + (o.items?.length ?? 0), 0)
  const quantity = orders.reduce(
    (t, o) => t + (o.items ?? []).reduce((q, l) => q + (l.quantity ?? 0), 0), 0)
  assert.equal(lineCount, 36, 'kalem')
  assert.equal(quantity, 36, 'adet')
})

test('PAG-5: 3+ sayfa ve kısmi son sayfa eksiksiz yüklenir', async () => {
  const calls = installFetch({ total: 250 })
  const orders = await (await makeService()).loadOrdersFromServer()
  assert.equal(orders.length, 250)
  assert.deepEqual(calls.map((c) => c.page).sort((a, b) => a - b), [1, 2, 3])
  // Son sayfa kısmi (50 kayıt) — eksiksiz alındı.
  assert.equal(new Set(orders.map((o) => o.packageId)).size, 250)
})

test('PAG-6: totalPages 0/1 sınır davranışı', async () => {
  installFetch({ total: 0 })
  assert.deepEqual(await (await makeService()).loadOrdersFromServer(), [])
  installFetch({ total: 1 })
  assert.equal((await (await makeService()).loadOrdersFromServer()).length, 1)
})

// ── tekilleştirme + sıralama ──────────────────────────────────────────────

test('PAG-7: aynı paket iki sayfada gelirse SESSİZCE başarı sayılmaz', async () => {
  // Pencere kayması: 2. sayfa 1. sayfadaki kaydı tekrar gönderiyor. Canonical
  // dedupe çalışır ama dedupe sonrası sayı total'den KÜÇÜK kalır → açık hata.
  installFetch({ total: 200, duplicateOnPage2: true })
  await assert.rejects(
    () => makeService().then((s) => s.loadOrdersFromServer()),
    /kayıt kümesi değişti/,
    'duplicate sessizce yutulmaz',
  )
})

test('PAG-7b: canonical dedupe yardımcısı tekrarları düşürmeye devam eder', async () => {
  const { dedupeOrdersByPackageIdentity } = await load('/src/utils/orderCounts.ts')
  const rows = [makeOrder(0), makeOrder(1), makeOrder(0), makeOrder(2)]
  const deduped = dedupeOrdersByPackageIdentity(rows)
  assert.equal(deduped.length, 3, 'tekrar düşer')
  // Sıra korunur: ilk görülen kalır.
  assert.deepEqual(deduped.map((o) => o.packageId), ['PKG-0', 'PKG-1', 'PKG-2'])
})

// ── kısmi başarı yasak ────────────────────────────────────────────────────

test('PAG-8: 2. sayfa hata verirse KISMİ sonuç dönmez', async () => {
  installFetch({ total: 200, failPages: new Set([2]) })
  const service = await makeService()
  await assert.rejects(
    () => service.loadOrdersFromServer(),
    /Siparisler yuklenemedi/,
    'kısmi liste değil, açık hata',
  )
})

test('PAG-9: hata sırasında önceki başarılı liste KORUNUR ve retry duplicate üretmez', async () => {
  const service = await makeService()
  installFetch({ total: 150 })
  const good = await service.loadOrdersFromServer()
  assert.equal(good.length, 150)
  const cachedBefore = service.getAuthOrdersCache
    ? service.getAuthOrdersCache()
    : null

  // Sonraki yükleme 2. sayfada patlıyor.
  installFetch({ total: 150, failPages: new Set([2]) })
  await assert.rejects(() => service.loadOrdersFromServer())
  if (cachedBefore) {
    assert.equal(
      (service.getAuthOrdersCache() ?? []).length, 150,
      'başarısız yükleme mevcut listeyi BOŞALTMAZ',
    )
  }

  // Retry başarılı → duplicate yok.
  installFetch({ total: 150 })
  const retried = await service.loadOrdersFromServer()
  assert.equal(retried.length, 150)
  assert.equal(
    new Set(retried.map((o) => o.packageId)).size, 150,
    'retry duplicate üretmez',
  )
})

test('PAG-10: bozuk/tutarsız sayfalama metadata\'sı sessizce başarı sayılmaz', async () => {
  // Negatif/NaN total.
  installFetch({ total: 10, totalOverride: -5 })
  await assert.rejects(
    () => makeService().then((s) => s.loadOrdersFromServer()),
    /geçersiz toplam kayıt/,
  )
  // Beklenen dolu sayfa BOŞ dönerse.
  installFetch({ total: 300, emptyPages: new Set([2]) })
  await assert.rejects(
    () => makeService().then((s) => s.loadOrdersFromServer()),
    /kayıt kümesi değişti/,
  )
})

test('PAG-11: sonsuz sayfalama güvenlik sınırı AÇIK hata verir', async () => {
  // 200 sayfa sınırı: 100'lük sayfada 20.001 kayıt → 201 sayfa.
  installFetch({ total: 20_001 })
  await assert.rejects(
    () => makeService().then((s) => s.loadOrdersFromServer()),
    /guvenlik sinirini asti/,
    'sessiz kırpma değil, açık hata',
  )
})

// ── race ──────────────────────────────────────────────────────────────────

test('PAG-12: eski YAVAŞ istek yeni HIZLI isteğin sonucunu EZMEZ', async () => {
  const service = await makeService()
  // Yavaş yükleme: 12 kayıt, 1. sayfa gecikmeli.
  installFetch({ total: 12, slowPages: new Map([[1, 60]]) })
  const slow = service.loadOrdersFromServer()
  // Hemen ardından hızlı yükleme: 7 kayıt.
  await new Promise((r) => setTimeout(r, 5))
  installFetch({ total: 7 })
  const fast = await service.loadOrdersFromServer()
  assert.equal(fast.length, 7)
  await slow.catch(() => undefined)
  // Cache HIZLI (en güncel) sonucu taşımalı; yavaş yanıt ezmemeli.
  if (service.getAuthOrdersCache) {
    assert.equal(
      service.getAuthOrdersCache().length, 7,
      'stale yanıt cache\'i ezmedi',
    )
  }
})

// ── sözleşme / güvenlik ───────────────────────────────────────────────────

test('PAG-13: istemci marketplaceAccountId GÖNDERMEZ; kapsam backend\'de çözülür', async () => {
  const calls = installFetch({ total: 150 })
  await (await makeService()).loadOrdersFromServer()
  for (const call of calls) {
    assert.equal(
      /marketplaceAccountId|organizationId/i.test(call.query), false,
      'istemci hesap/organizasyon kimliği göndermiyor',
    )
    assert.ok(call.pageSize > 0 && call.pageSize <= 100, 'backend max 100')
  }
})

test('PAG-14: sabit büyük limit (1000 vb.) KULLANILMAZ; sayfa döngüsü vardır', () => {
  const src = readFileSync(
    join(here, '..', 'src/services/orderWorkflowService.ts'), 'utf8')
  assert.match(src, /const ORDERS_LOAD_PAGE_SIZE = 100/)
  assert.match(src, /const MAX_ORDER_PAGES = /, 'güvenlik sınırı tanımlı')
  assert.match(src, /resolveTotalPages\(total, effectivePageSize\)/, 'totalPages türetilir')
  const helper = readFileSync(join(here, '..', 'src/utils/orderPagination.ts'), 'utf8')
  assert.match(helper, /Math\.ceil\(total \/ pageSize\)/)
  assert.equal(
    /pageSize:\s*'?1000|pageSize=1000/.test(src), false,
    'sabit 1000 limiti yok',
  )
  // Backend varsayılanı (25) endpoint için KALIR.
  const repo = readFileSync(
    join(here, '..', 'server/orders/orderRepository.ts'), 'utf8')
  assert.match(repo, /const DEFAULT_PAGE_SIZE = 25/)
  assert.match(repo, /const MAX_PAGE_SIZE = 100/)
})

test('PAG-15: kısmi hata UI listesini boşaltmaz (App çağrı yerleri)', () => {
  const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
  assert.equal(
    /\.catch\(\(\) => \[\] as CargoOrder\[\]\)/.test(app), false,
    'hata artık boş listeye çevrilmiyor',
  )
  assert.match(app, /catch\(\(\) => null as CargoOrder\[\] \| null\)/)
  assert.match(app, /if \(baseOrders === null\)/)
  assert.match(app, /ordersLoading: false/)
  // Race koruması yerinde.
  assert.match(app, /getMarketplaceAccountGeneration\(\)/)
  assert.match(app, /if \(!isFresh\(\)\) return/)
})

test('PAG-16: sekme sınıflandırma iş kuralları DEĞİŞMEDİ', async () => {
  const { classifyOrderForTabs, orderMatchesQuickTab } = await load(
    '/src/utils/orderClassification.ts')
  const base = {
    id: 'o', orderNumber: 'n', packageId: 'p',
    marketplaceStatus: 'Created', operationStatus: 'NEW', items: [],
  }
  assert.equal(
    orderMatchesQuickTab(classifyOrderForTabs(base), 'newOrders'), true)
  assert.equal(
    orderMatchesQuickTab(
      classifyOrderForTabs({ ...base, operationStatus: 'LABEL_READY' }),
      'labelStage'), true)
  assert.equal(
    orderMatchesQuickTab(
      classifyOrderForTabs({ ...base, operationStatus: 'LABEL_READY' }),
      'newOrders'), false)
  assert.equal(
    orderMatchesQuickTab(
      classifyOrderForTabs({ ...base, marketplaceStatus: 'Shipped' }),
      'handedToCargo'), true)
})

test('PAG-17: yükleme günlüğü PII veya ham sipariş verisi TAŞIMAZ', () => {
  const src = readFileSync(
    join(here, '..', 'src/services/orderWorkflowService.ts'), 'utf8')
  // Yalnız console.debug nesne literalini al (blok sonuna kadar); daha
  // geniş dilim sonraki tip tanımlarını yakalayıp yanlış alarm verir.
  const perfStart = src.indexOf("console.debug('PERF_ORDERS_LOAD'")
  const perf = src.slice(perfStart, src.indexOf('})', perfStart) + 2)
  for (const forbidden of [
    'customerName', 'address', 'phone', 'orderNumber', 'packageId',
    'barcodeRaw', 'orders:', 'payload',
  ]) {
    assert.equal(
      perf.includes(forbidden), false, `PERF logunda sızıntı: ${forbidden}`)
  }
  assert.match(perf, /itemCount/)
  assert.match(perf, /pageCount/)
})

// ── sertleştirme: eşzamanlılık sınırı, snapshot, stabil sıralama ──────────

test('PAG-18: 6 sayfada eşzamanlı istek sayısı hiçbir an 4\'ü AŞMAZ', async () => {
  let inFlight = 0
  let peak = 0
  const total = 600 // 100'lük sayfa → 6 sayfa
  globalThis.fetch = async (url) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 15))
    const parsed = new URL(String(url), 'http://localhost')
    const page = Number(parsed.searchParams.get('page') ?? 1)
    const pageSize = Number(parsed.searchParams.get('pageSize') ?? PAGE_SIZE)
    const start = (page - 1) * pageSize
    const orders = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - start)) },
      (_, k) => makeOrder(start + k),
    )
    inFlight -= 1
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, orders, total, page, pageSize }),
    }
  }
  const orders = await (await makeService()).loadOrdersFromServer()
  assert.equal(orders.length, 600)
  assert.ok(peak <= 4, `eşzamanlı istek zirvesi ${peak} (<= 4 olmalı)`)
  assert.ok(peak > 1, 'yine de paralel çalışıyor')
})

test('PAG-19: sonraki sayfada total DEĞİŞİRSE açık hata verilir', async () => {
  let call = 0
  globalThis.fetch = async (url) => {
    call += 1
    const parsed = new URL(String(url), 'http://localhost')
    const page = Number(parsed.searchParams.get('page') ?? 1)
    const pageSize = Number(parsed.searchParams.get('pageSize') ?? PAGE_SIZE)
    // 1. sayfa total=200; sonraki sayfalarda kayıt kümesi büyüdü (total=201).
    const total = call === 1 ? 200 : 201
    const start = (page - 1) * pageSize
    const orders = Array.from(
      { length: Math.max(0, Math.min(pageSize, 200 - start)) },
      (_, k) => makeOrder(start + k),
    )
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, orders, total, page, pageSize }),
    }
  }
  await assert.rejects(
    () => makeService().then((s) => s.loadOrdersFromServer()),
    /Sipariş listesi yüklenirken kayıt kümesi değişti; yeniden deneyin/,
  )
})

test('PAG-20: yanlış page metadata\'sı açık hata verir', async () => {
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost')
    const page = Number(parsed.searchParams.get('page') ?? 1)
    const pageSize = Number(parsed.searchParams.get('pageSize') ?? PAGE_SIZE)
    const start = (page - 1) * pageSize
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        orders: Array.from(
          { length: Math.max(0, Math.min(pageSize, 200 - start)) },
          (_, k) => makeOrder(start + k),
        ),
        total: 200,
        // Sunucu YANLIŞ sayfa numarası bildiriyor.
        page: page === 2 ? 5 : page,
        pageSize,
      }),
    }
  }
  await assert.rejects(
    () => makeService().then((s) => s.loadOrdersFromServer()),
    /2\. sayfa yerine 5\. sayfayı döndürdü/,
  )
})

test('PAG-21: geçersiz pageSize (0 / backend maksimumu üstü) reddedilir', async () => {
  const { validateOrderPageMeta, ORDERS_BACKEND_MAX_PAGE_SIZE } = await load(
    '/src/utils/orderPagination.ts')
  const expected = { page: 1, pageSize: 100, expectedTotal: 10, totalPages: 1 }
  assert.equal(ORDERS_BACKEND_MAX_PAGE_SIZE, 100)
  assert.throws(
    () => validateOrderPageMeta(
      { orderCount: 10, total: 10, page: 1, pageSize: 0 }, expected),
    /geçersiz sayfa boyutu/,
  )
  assert.throws(
    () => validateOrderPageMeta(
      { orderCount: 10, total: 10, page: 1, pageSize: 500 }, expected),
    /geçersiz sayfa boyutu/,
  )
  // Sayfa boyutundan FAZLA kayıt döndürmek de reddedilir.
  assert.throws(
    () => validateOrderPageMeta(
      { orderCount: 150, total: 10, page: 1, pageSize: 100 }, expected),
    /sayfa boyutundan fazla kayıt/,
  )
})

test('PAG-22: son sayfa kısmi olabilir, ara sayfalar TAM dolu olmalı', async () => {
  const { validateOrderPageMeta } = await load('/src/utils/orderPagination.ts')
  // total=250, pageSize=100 → 3 sayfa; son sayfa 50 kayıt.
  const base = { pageSize: 100, expectedTotal: 250, totalPages: 3 }
  validateOrderPageMeta(
    { orderCount: 50, total: 250, page: 3, pageSize: 100 },
    { ...base, page: 3 },
  )
  validateOrderPageMeta(
    { orderCount: 100, total: 250, page: 2, pageSize: 100 },
    { ...base, page: 2 },
  )
  // Ara sayfa eksik dolu → snapshot kaymış.
  assert.throws(
    () => validateOrderPageMeta(
      { orderCount: 80, total: 250, page: 2, pageSize: 100 },
      { ...base, page: 2 }),
    /kayıt kümesi değişti/,
  )
})

test('PAG-23: aynı timestamp\'li kayıtlar için backend sıralaması DETERMİNİSTİK', () => {
  const repo = readFileSync(
    join(here, '..', 'server/orders/orderRepository.ts'), 'utf8')
  // İkincil anahtar (id) yalnız eşitlik durumunu çözer.
  assert.match(repo, /desc\(orders\.orderDate\), desc\(orders\.id\)/)
  assert.match(repo, /asc\(orders\.orderDate\), asc\(orders\.id\)/)
  assert.match(repo, /\.orderBy\(\.\.\.orderBy\)/)
  // Kullanıcının gördüğü birincil sıra DEĞİŞMEDİ (hâlâ orderDate).
  assert.match(repo, /filters\.sort === 'orderDateAsc'/)
})

test('PAG-24: 35/36/36 sonucu sertleştirmeden SONRA da korunur', async () => {
  installFetch({
    total: 35,
    makeItems: (i) =>
      i === 0
        ? {
            ...makeOrder(0),
            items: [
              { id: 'l-0', productName: 'Ürün', quantity: 1, barcode: 'B0' },
              { id: 'l-0b', productName: 'Ürün 2', quantity: 1, barcode: 'B0b' },
            ],
          }
        : makeOrder(i),
  })
  const orders = await (await makeService()).loadOrdersFromServer()
  assert.equal(orders.length, 35, 'paket')
  assert.equal(
    orders.reduce((t, o) => t + (o.items?.length ?? 0), 0), 36, 'kalem')
  assert.equal(
    orders.reduce(
      (t, o) => t + (o.items ?? []).reduce((q, l) => q + (l.quantity ?? 0), 0), 0),
    36, 'adet')
})
