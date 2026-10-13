import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import v8 from 'node:v8'
import vm from 'node:vm'

// ═══ TRENDYOL STREAM — SAYFA BİRİKTİRME BELLEK REGRESYONU ════════════════
//
// ÜRETİM: süreç 120–200 MB'ta başlayıp 35–40 dakikada 540–870 MB'a çıkıyor
// ve PM2 (512 MiB) yeniden başlatıyordu. Yerel hızlandırılmış ölçüm
// (gerçek server/index.mjs + PostgreSQL + mock Trendyol, 100 sayfa × 200
// paket): tur zirvesi heapUsed ~166 MB / RSS ~312 MB; GC sonrası heapUsed
// tabana dönüyor (tutulan nesne YOK) ama RSS yüksek kalıyor.
//
// Kök: `runTrendyolStream` her sayfayı KOŞULSUZ `collected` dizisine
// ekliyordu ve üretim çağıranı `onPage` vermeden tüm zinciri tur SONUNDA
// normalize + persist ediyordu (varsayılan sınır 500 × 200 = 100.000 paket).
// Düzeltme: `onPage` verildiğinde sayfa orada işlenir ve TUTULMAZ; üretim
// çağıranı sayfa sayfa kalıcılaştırır.
//
// AĞ ÇAĞRISI YOK: `fetchJson` enjekte edilir.

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc')

const STREAM = await import('./marketplaces/trendyolOrderStream.ts')
const here = new URL('.', import.meta.url)
const FILTERS = { startDate: 1_000, endDate: 2_000, size: 200 }

// Temsilî paket: resmî Trendyol V2 fixture'ı (adres, müşteri, kargo alanları)
// + 2 satır ve paket geçmişi — üretim yanıtına yakın boyut.
const { packageFixture } = await import('./fixtures/trendyol/ordersV2.mjs')
function pkg(id) {
  return packageFixture({
    id, shipmentPackageId: id, orderNumber: String(10_000_000 + id),
    cargoTrackingNumber: String(7_260_000_000_000_000 + id),
    lines: [
      { id: id * 10, quantity: 1, productName: `Scuba Seçil Detaylı Tesettür Elbise ${id % 37}`, barcode: `BRC${id % 500}`, stockCode: `SKU-${id % 500}`, merchantSku: `SKU-${id % 500}`, productSize: '38', productColor: 'Lacivert', price: 299.9, amount: 299.9 },
      { id: id * 10 + 1, quantity: 2, productName: `Örme Hırka ${id % 29}`, barcode: `BRC${(id + 7) % 500}`, stockCode: `SKU-${(id + 7) % 500}`, merchantSku: `SKU-${(id + 7) % 500}`, productSize: 'M', productColor: 'Bej', price: 199.9, amount: 199.9 },
    ],
    packageHistories: [{ createdDate: 1_757_000_000_000, status: 'Created' }, { createdDate: 1_757_003_600_000, status: 'Picking' }],
  })
}

function pagedFetcher(pageCount, perPage) {
  return async (url) => {
    const cursor = new URL(url).searchParams.get('cursor')
    const page = cursor ? Number(cursor.slice(1)) : 0
    const content = Array.from({ length: perPage }, (_, i) => pkg(page * perPage + i + 1))
    const hasMore = page + 1 < pageCount
    return { ok: true, body: { content, nextCursor: hasMore ? `c${page + 1}` : null, hasMore } }
  }
}

test('TY-STREAM-MEM-1: onPage verildiğinde sayfalar BİRİKTİRİLMEZ; paket sayısı yine raporlanır', async () => {
  let seen = 0
  const run = await STREAM.runTrendyolStream({
    baseUrl: 'https://example.invalid', sellerId: 1, filters: FILTERS,
    fetchJson: pagedFetcher(12, 50), minIntervalMs: 0,
    onPage: (page) => { seen += page.packages.length },
  })
  assert.equal(run.pages, 12)
  assert.equal(seen, 600)
  assert.equal(run.packageCount, 600)
  assert.deepEqual(run.packages, [], 'onPage varken tur sonucu paketleri TUTMAMALI')
  assert.equal(run.stopReason, 'NO_MORE_PAGES')
})

test('TY-STREAM-MEM-2: işlenen sayfanın paketleri tur bitince toplanabilir (GC), sonuç onları tutmaz', async () => {
  const refs = []
  const run = await STREAM.runTrendyolStream({
    baseUrl: 'https://example.invalid', sellerId: 1, filters: FILTERS,
    fetchJson: pagedFetcher(20, 100), minIntervalMs: 0,
    onPage: (page) => { refs.push(new WeakRef(page.packages[0])) },
  })
  assert.equal(run.packageCount, 2_000)
  // `run` HÂLÂ erişilebilir: eskiden `run.packages` 2.000 paketi tutuyordu.
  for (let i = 0; i < 3; i += 1) {
    gc()
    await new Promise((resolve) => setImmediate(resolve))
  }
  const alive = refs.filter((ref) => ref.deref() !== undefined).length
  assert.equal(alive, 0, `${alive}/${refs.length} sayfa paketi tur sonucunda tutuluyor`)
  assert.ok(run.pages === 20)
})

test('TY-STREAM-MEM-3: 500 sayfa × 200 temsilî paketlik zincirde yığın büyümesi SINIRLI', async () => {
  // Varsayılan üst sınır (maxPages 500 × size 200 = 100.000 paket).
  const PAGES = 500
  const PER_PAGE = 200
  let early = 0
  let late = 0
  await STREAM.runTrendyolStream({
    baseUrl: 'https://example.invalid', sellerId: 1, filters: FILTERS,
    fetchJson: pagedFetcher(PAGES, PER_PAGE), minIntervalMs: 0,
    onPage: (_page, index) => {
      if (index === 20 || index === PAGES - 1) {
        gc()
        const used = process.memoryUsage().heapUsed
        if (index === 20) early = used
        else late = used
      }
    },
  })
  const growthMb = (late - early) / 1_048_576
  // Eski davranış: sayfa 20 → 499 arasında 96.000 ek paket tutulurdu
  // (temsilî paketlerle yüzlerce MB); düzeltmeyle sayfa başı bellek sabit.
  assert.ok(growthMb < 10, `yığın ${growthMb.toFixed(1)} MB büyüdü (sayfa 20 → ${PAGES - 1})`)
})

test('TY-STREAM-MEM-4: üretim stream turu sayfa sayfa kalıcılaştırır; tüm zinciri tur sonunda persist ETMEZ', () => {
  const source = readFileSync(new URL('index.mjs', here), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('async function syncTrendyolStreamForOrganization')
  const body = source.slice(start, source.indexOf('async function syncTrendyolStreamForAllOrganizations'))
  assert.ok(start > 0 && body.length > 0)
  assert.match(body, /onPage: async \(page\) => \{/)
  assert.match(body, /normalizeTrendyolOrders\(\{ content: page\.packages \}\)/)
  assert.doesNotMatch(body, /result\.packages/, 'tur sonunda biriktirilmiş paket listesi kullanılmamalı')
  // Güvenlik kapsamı AYNI: aktif hesap zorunlu, arşivleme yok.
  assert.match(body, /requireMarketplaceAccount: true/)
  assert.match(body, /complete: false/)
})

test('TY-STREAM-MEM-5: onPage VERİLMEZSE eski sözleşme korunur (paketler döner)', async () => {
  const run = await STREAM.runTrendyolStream({
    baseUrl: 'https://example.invalid', sellerId: 1, filters: FILTERS,
    fetchJson: pagedFetcher(3, 10), minIntervalMs: 0,
  })
  assert.equal(run.packages.length, 30)
  assert.equal(run.packageCount, 30)
})
