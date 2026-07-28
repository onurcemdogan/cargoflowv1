import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Account-scoped local-first yükleme performansı (kaynak-seviyesi sözleşme).
// Problem: login/hesap değişiminde siparişler ürün kataloğunu (auth modda çok
// sayfalı, binlerce varyant) BEKLİYORDU → ekran "0 kayıt / senkron sürüyor"da
// takılıyordu. Düzeltme: siparişler ve katalog PARALEL yüklenir; provider sync
// ayrı state'tir; account-scoped SWR cache + nesil (generation) race koruması.

const here = dirname(fileURLToPath(import.meta.url))
function readSrc(rel) {
  return readFileSync(join(here, '..', rel), 'utf8')
}
function sliceBlock(src, anchor, length = 2200) {
  const idx = src.indexOf(anchor)
  assert.notEqual(idx, -1, `beklenen kod bulunamadı: ${anchor}`)
  return src.slice(idx, idx + length)
}

// ── 1: mount — siparişler ve katalog PARALEL; siparişler katalogu beklemez ──
test('PERF-1: App mount siparişleri ve katalogu paralel yükler (orders katalogu awaitlemez)', () => {
  const app = readSrc('src/App.tsx')
  const block = sliceBlock(app, 'const isFresh = () =>', 2600)
  // Orders ve katalog ayrı promise; ikisi de .then ile bağımsız uygulanır.
  assert.match(block, /const ordersPromise =/)
  assert.match(block, /const catalogPromise =/)
  assert.match(block, /ordersPromise\.then/)
  assert.match(block, /catalogPromise\.then/)
  // Siparişler katalog gelmeden (ordersLoading:false) render edilir.
  assert.match(block, /LOCAL-FIRST \+ PARALEL/)
  // Eski seri kalıp (katalogu awaitleyip sonra orders) KALDIRILDI.
  assert.doesNotMatch(
    block,
    /const cachedCatalog = await workflowService\.hydrateProductCatalog\(\)/,
  )
})

// ── 2: nesil (generation) race koruması — stale sonuç uygulanmaz ────────────
test('PERF-2: mount/reload/account-switch nesil ile stale sonucu DISCARD eder', () => {
  const app = readSrc('src/App.tsx')
  // Mount: isFresh() nesil kontrolü.
  assert.match(app, /const generation = workflowService\.getMarketplaceAccountGeneration\(\)/)
  assert.match(app, /generation === workflowService\.getMarketplaceAccountGeneration\(\)/)
  // Reload: nesil değiştiyse sonucu atla.
  const reload = sliceBlock(app, 'async function handleReloadOrders()', 1600)
  assert.match(reload, /if \(generation !== workflowService\.getMarketplaceAccountGeneration\(\)\)/)
})

// ── 3: workflowService — account-scoped SWR cache + TTL + nesil + clear ─────
test('PERF-3: orderWorkflowService account-scoped SWR cache (TTL/generation/LRU)', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  assert.match(svc, /accountScopedOrdersCache/)
  assert.match(svc, /ORDERS_CACHE_TTL_MS/)
  assert.match(svc, /ORDERS_CACHE_MAX_ENTRIES/)
  assert.match(svc, /peekCachedOrders/)
  // TTL + nesil kontrolü peek içinde.
  const peek = sliceBlock(svc, 'peekCachedOrders(', 600)
  assert.match(peek, /entry\.generation !== this\.marketplaceAccountGeneration/)
  assert.match(peek, /Date\.now\(\) - entry\.at > OrderWorkflowService\.ORDERS_CACHE_TTL_MS/)
  // Yalnız filtresiz (varsayılan) liste cache'lenir.
  assert.match(svc, /if \(query === ''\) this\.writeOrdersCache\('default', orders\)/)
})

// ── 4: hesap değişimi — nesil artar, SWR + in-memory cache temizlenir ───────
test('PERF-4: setMarketplaceAccount değişimde nesil artar + cache temizler', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  const block = sliceBlock(svc, 'setMarketplaceAccount(sellerId', 1200)
  assert.match(block, /this\.marketplaceAccountGeneration \+= 1/)
  assert.match(block, /this\.accountScopedOrdersCache\.clear\(\)/)
  // Eski hesabın in-memory auth snapshot'ları da temizlenir (çapraz-hesap sızıntı yok).
  assert.match(block, /this\.authOrdersCache = \[\]/)
  assert.match(block, /this\.authProductsCache = \[\]/)
})

// ── 5: reload SWR — taze cache anında gösterilir, arkada revalidate ─────────
test('PERF-5: handleReloadOrders SWR (taze cache anında) + revalidate', () => {
  const app = readSrc('src/App.tsx')
  const reload = sliceBlock(app, 'async function handleReloadOrders()', 1600)
  assert.match(reload, /const cached = workflowService\.peekCachedOrders\(\)/)
  // Taze cache varsa loading'e düşmeden gösterilir; yoksa loading.
  assert.match(reload, /if \(cached\)/)
})

// ── 6: hesap değişiminde eski veri bir kare bile kalmaz (paralel yeni yükleme)
test('PERF-6: account switch eski listeyi anında temizler + yeni veriyi paralel yükler', () => {
  const app = readSrc('src/App.tsx')
  const block = sliceBlock(app, 'if (accountChanged) {', 1800)
  // Eski liste anında boşaltılır.
  assert.match(block, /setOrdersState\(\{ orders: \[\], ordersLoading: true \}\)/)
  // Yeni hesap siparişleri katalogtan bağımsız (paralel) yüklenir + nesil guard.
  assert.match(block, /const ordersPromise =/)
  assert.match(block, /if \(!isFresh\(\)\) return/)
})

// ── 7: Dashboard mount provider sync ÇAĞIRMAZ; analytics+claims paralel ─────
test('PERF-7: Dashboard mount /api/orders/sync çağırmaz; sales+claims ayrı paralel effect', () => {
  const page = readSrc('src/pages/DashboardPage.tsx')
  assert.doesNotMatch(page, /\/api\/orders\/sync/)
  // İki ayrı effect: satış analitiği ve iade (claims) bağımsız yüklenir.
  assert.match(page, /fetchDashboardAnalyticsOrders\(/)
  assert.match(page, /fetchDashboardAnalyticsClaims\(/)
  // Sales analitiği yüklenirken operasyon bölümleri bloklanmaz (bölümsel).
  assert.match(page, /Operasyon verileri \(aşağıda\) zaten hazır/)
})

// ── 8: timing metadata PII/secret sızdırmaz + DEV-gated ─────────────────────
test('PERF-8: timing log güvenli (raw id/PII/ZPL/secret yok) + DEV-gated', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  const block = sliceBlock(svc, "console.debug('PERF_ORDERS_LOAD'", 260)
  // Yalnız boolean varlık bayrağı (ham sellerId/scope değeri değil).
  assert.match(block, /marketplaceAccountScopePresent: this\.marketplaceAccountScope !== ''/)
  assert.match(block, /totalDurationMs/)
  assert.match(block, /itemCount: orders\.length/)
  // DEV dışında loglanmaz.
  assert.match(svc, /import\.meta\.env\?\.DEV/)
  // Ham scope/secret/ZPL alanı loglanmaz.
  assert.doesNotMatch(block, /zpl|apiKey|apiSecret|password|sellerId:/i)
})

// ── 9: provider sync ayrı state — dataLoading tek global flag değil ─────────
test('PERF-9: fetchOrdersAuthMode syncInProgress/syncOk ayrı; liste sync ile silinmez', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  const block = sliceBlock(svc, 'private async fetchOrdersAuthMode(', 4200)
  // Sync durumu (syncInProgress/syncOk) veri yüklemeden AYRI ele alınır.
  assert.match(block, /syncInProgress/)
  assert.match(block, /syncOk/)
  // PARTIAL/başarısız sync mevcut listeyi korur (silmez).
  assert.match(block, /korun/i)
})

// ── 10: products local-first — katalog hydrate background, sync ayrı ────────
test('PERF-10: ürün kataloğu background hydrate; sayfa provider ürün sync\'ini beklemez', () => {
  const app = readSrc('src/App.tsx')
  // Katalog mount'ta background .then ile gelir (await ile bloklanmaz).
  assert.match(app, /catalogPromise\.then\(\(cachedCatalog\) => \{/)
  // Ürün SENKRONU (fetchProducts) yalnız açık aksiyonla; mount onu tetiklemez.
  const svc = readSrc('src/services/orderWorkflowService.ts')
  // Ürün sayfaları fetchProductsPage ile GET /api/products'tan okunur (DB);
  // POST /api/products/sync (provider) DEĞİL. loadProductsFromServer bu yardımcıyı
  // bounded paralel kullanır.
  const pageFetch = sliceBlock(svc, 'private async fetchProductsPage(', 700)
  assert.match(pageFetch, /\/api\/products\?/)
  assert.doesNotMatch(pageFetch, /\/api\/products\/sync/)
  const load = sliceBlock(svc, 'async loadProductsFromServer()', 900)
  assert.doesNotMatch(load, /\/api\/products\/sync/)
  assert.match(load, /fetchProductsPage/)
})
