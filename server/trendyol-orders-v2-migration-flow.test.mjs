// TRENDYOL ORDER V2 GEÇİŞİ — SÖZLEŞME, ERİŞİM PENCERESİ VE EMEKLİ UÇ KANITI.
//
// Resmî duyuru: `/integration/order/sellers/{sellerId}/orders` 15 Ekim 2026'da
// kullanım dışı kalır; geçiş döneminde günde 3 kez 10'ar dakika 426 döner.
// Bu dosya ÜÇ şeyi kanıtlar:
//   1) saf sözleşme katmanı (yol, erişim penceresi aritmetiği, dilimleme),
//   2) üretim kaynağında emekli yolun KALMADIĞI,
//   3) GERÇEK sunucu çalışırken tek bir isteğin bile emekli uca ÇIKMADIĞI.
//
// CANLI SAĞLAYICI ÇAĞRISI YOKTUR: tüm yanıtlar yerel mock ve fixture'lardan.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FIXTURE_META,
  V2_ORDERS_1_NORMAL_PAGE,
  V2_ORDERS_2_EMPTY,
  V2_ORDERS_3_MULTI_PAGE,
  V2_ORDERS_4_CAP_BOUNDARY,
  V2_ORDERS_5_UNKNOWN_STATUS,
  V2_ORDERS_6_MALFORMED,
  V2_ORDERS_7_FORBIDDEN,
  V2_ORDERS_7_UNAUTHORIZED,
  V2_ORDERS_8_RATE_LIMITED,
  V2_ORDERS_9_DEPRECATED_426,
  packageFixture,
} from './fixtures/trendyol/ordersV2.mjs'

const host = '127.0.0.1'
const DAY = 24 * 60 * 60 * 1000

const endpoint = await import('./marketplaces/trendyolOrdersEndpoint.ts')
const historical = await import('./trendyol/historicalOrderFetch.ts')

// ═══ 1. SAF SÖZLEŞME ══════════════════════════════════════════════════════

test('V2-CONTRACT-1: kanonik yol v2; emekli yol YALNIZ tespit icin durur', () => {
  assert.equal(
    endpoint.TRENDYOL_ORDERS_V2_PATH_TEMPLATE,
    '/integration/order/sellers/{sellerId}/v2/orders',
  )
  assert.equal(endpoint.TRENDYOL_ORDERS_V2_MANDATORY_DATE, '2026-10-15')
  assert.equal(endpoint.TRENDYOL_DEPRECATED_ENDPOINT_STATUS, 426)
  const url = endpoint.buildTrendyolOrdersV2Url({
    baseUrl: 'https://apigw.trendyol.com/',
    sellerId: 277221,
    search: new URLSearchParams({ page: '0', size: '200' }),
  })
  assert.equal(
    url,
    'https://apigw.trendyol.com/integration/order/sellers/277221/v2/orders?page=0&size=200',
  )
  assert.equal(endpoint.isDeprecatedTrendyolOrdersUrl(url), false)
})

test('V2-CONTRACT-2: emekli uc tespiti akis ucunu YANLIS ISARETLEMEZ', () => {
  const deprecated =
    'https://apigw.trendyol.com/integration/order/sellers/277221/orders?page=0'
  assert.equal(endpoint.isDeprecatedTrendyolOrdersUrl(deprecated), true)
  // Sorgu parametresiz hali de emeklidir.
  assert.equal(
    endpoint.isDeprecatedTrendyolOrdersUrl(
      'https://apigw.trendyol.com/integration/order/sellers/277221/orders',
    ),
    true,
  )
  // `orders/stream` AYRI ve GUNCEL bir servistir; emekli SAYILMAZ.
  assert.equal(
    endpoint.isDeprecatedTrendyolOrdersUrl(
      'https://apigw.trendyol.com/integration/order/sellers/277221/orders/stream?size=200',
    ),
    false,
  )
  // v2 hicbir kosulda emekli sayilmaz.
  assert.equal(
    endpoint.isDeprecatedTrendyolOrdersUrl(
      'https://apigw.trendyol.com/integration/order/sellers/277221/v2/orders?page=49',
    ),
    false,
  )
})

test('V2-WINDOW-1: erisim penceresi SAYFA degil KAYIT OFSETI ile olculur', () => {
  // Resmi ornek size=200 uzerinden anlatilir: page 0..49.
  assert.equal(endpoint.maxReachablePageCount(200), 50)
  assert.equal(endpoint.isPageReachable({ page: 49, size: 200 }), true)
  assert.equal(endpoint.isPageReachable({ page: 50, size: 200 }), false)
  // Kural "page <= 49" DEGILDIR: size=50 ile 200 sayfa okunabilir. Kurali
  // sayfa numarasina sabitlemek bu cagirani YANLIS engellerdi.
  assert.equal(endpoint.maxReachablePageCount(50), 200)
  assert.equal(endpoint.isPageReachable({ page: 150, size: 50 }), true)
  assert.equal(endpoint.isPageReachable({ page: 200, size: 50 }), false)
})

test('V2-CAP-1: resmi ornek (12.540) cap olarak TESPIT EDILIR', () => {
  const cap = endpoint.detectQueryWindowCap({
    totalElements: V2_ORDERS_4_CAP_BOUNDARY.totalElements,
    size: 200,
  })
  assert.equal(cap.capped, true)
  assert.equal(cap.reason, 'TOTAL_EXCEEDS_QUERY_WINDOW')
  assert.equal(cap.reachableRecords, 10000)
  assert.equal(cap.unreachableRecords, 2540)
  // Bolme adedi saglayicinin KENDI sayisindan turetilir; sabit UYDURULMAZ.
  assert.equal(cap.requiredSliceCount, 2)
})

test('V2-CAP-2: tam sinirda ve altinda cap YOKTUR; bilinmeyen total cap SAYILMAZ', () => {
  assert.equal(endpoint.detectQueryWindowCap({ totalElements: 10000, size: 200 }).capped, false)
  assert.equal(endpoint.detectQueryWindowCap({ totalElements: 10001, size: 200 }).capped, true)
  const unknown = endpoint.detectQueryWindowCap({ totalElements: undefined, size: 200 })
  assert.equal(unknown.capped, false)
  assert.equal(unknown.reason, 'UNKNOWN_TOTAL')
})

test('V2-SLICE-1: dilimler BITISIK, KAPSAYICI ve BOSLUKSUZDUR', () => {
  const start = 1_757_000_000_000
  const end = start + 40 * DAY
  const slices = endpoint.planTrendyolDateSlices({
    startMs: start,
    endMs: end,
    maxRangeMs: endpoint.TRENDYOL_V2_MAX_RANGE_MS,
  })
  assert.ok(slices.length >= 3, '40 gun 14 gunluk dilimlere boluner')
  assert.equal(slices[0].startMs, start)
  assert.equal(slices.at(-1).endMs, end)
  for (const slice of slices) {
    assert.ok(
      slice.endMs - slice.startMs < endpoint.TRENDYOL_V2_MAX_RANGE_MS,
      'hicbir dilim tek-istek sinirini asmaz',
    )
  }
  for (let i = 1; i < slices.length; i += 1) {
    assert.equal(
      slices[i].startMs,
      slices[i - 1].endMs + 1,
      'dilimler arasinda BOSLUK ve ORTUSME yok',
    )
  }
})

test('V2-SLICE-2: sliceCount daha dar dilim URETIR; 1 ms tabaninda DURUR', () => {
  const start = 1_757_000_000_000
  const end = start + 10 * DAY
  const four = endpoint.planTrendyolDateSlices({
    startMs: start,
    endMs: end,
    maxRangeMs: endpoint.TRENDYOL_V2_MAX_RANGE_MS,
    sliceCount: 4,
  })
  assert.equal(four.length, 4)
  assert.equal(four[0].startMs, start)
  assert.equal(four.at(-1).endMs, end)

  // Tek milisaniyelik aralik DAHA INCE bolunemez.
  const atomic = { startMs: start, endMs: start }
  assert.equal(endpoint.canSplitFurther(atomic), false)
  assert.equal(
    endpoint.planTrendyolDateSlices({ ...atomic, sliceCount: 8 }).length,
    1,
  )
  assert.equal(endpoint.canSplitFurther({ startMs: start, endMs: start + 1 }), true)
})

test('V2-SLICE-3: gecmis siniri (1 ay) ASILDIGINDA acikca bildirilir', () => {
  const now = 1_757_000_000_000
  assert.equal(endpoint.isBeyondLookback({ startMs: now - 29 * DAY, nowMs: now }), false)
  assert.equal(endpoint.isBeyondLookback({ startMs: now - 31 * DAY, nowMs: now }), true)
})

// ═══ 2. ÜRETİM KAYNAĞINDA EMEKLİ YOL YOK ══════════════════════════════════

const PRODUCTION_SOURCES = [
  'server/index.mjs',
  'server/trendyol/historicalOrderFetch.ts',
  'server/orders/trendyolPackageIdentityTrace.ts',
  'server/orders/trendyolPackageIdentityTraceCli.ts',
  'server/marketplaces/trendyolOrderStream.ts',
  'server/marketplaces/trendyolStreamScheduler.ts',
  'src/providers/marketplace/TrendyolProvider.ts',
]

test('V2-SOURCE-1: uretim kaynaginda emekli sipariş yolu KALMADI', async () => {
  // Yorumlar haric edilir: sozlesme belgesi olarak emekli yolu ANLATMAK
  // serbesttir; ISTEK KURMAK degil.
  const stripComments = (text) =>
    text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')

  for (const file of PRODUCTION_SOURCES) {
    const source = stripComments(await readFile(file, 'utf8'))
    // Emekli sablon: sellers/<sey>/orders — `/v2/orders` ve `/orders/stream` haric.
    const deprecated = /sellers\/[^'"`\n]*?\/orders(?!\/stream)(?![A-Za-z0-9_-])/g
    const hits = [...source.matchAll(deprecated)]
      .map((match) => match[0])
      .filter((hit) => !hit.includes('/v2/orders'))
    assert.deepEqual(hits, [], `${file} emekli sipariş yolunu ICERMEMELI`)
  }
})

test('V2-SOURCE-2: uc nokta TEK otoritede kurulur', async () => {
  const entry = await readFile('server/index.mjs', 'utf8')
  const backfill = await readFile('server/trendyol/historicalOrderFetch.ts', 'utf8')
  const trace = await readFile('server/orders/trendyolPackageIdentityTrace.ts', 'utf8')
  for (const [name, source] of [
    ['index.mjs', entry],
    ['historicalOrderFetch.ts', backfill],
    ['trendyolPackageIdentityTrace.ts', trace],
  ]) {
    assert.ok(
      source.includes('buildTrendyolOrdersV2Url'),
      `${name} uc noktayi paylasilan otoriteden almali`,
    )
  }
})

// ═══ 3. GEÇMİŞ GERİ-DOLUM (enjekte edilmiş fetch; AĞ YOK) ═════════════════

const credentials = {
  sellerId: '277221',
  apiKey: 'key',
  apiSecret: 'secret',
}

function recordingFetch(handler) {
  const urls = []
  const impl = async (url) => {
    urls.push(String(url))
    const reply = handler(new URL(String(url)), urls.length - 1)
    return new Response(JSON.stringify(reply.body ?? reply), {
      status: reply.statusCode ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { urls, impl }
}

test('V2-ORDERS-1/2: normal sayfa ve bos yanit — istek v2 uca gider', async () => {
  const { urls, impl } = recordingFetch((url) =>
    url.searchParams.get('status') === 'Created'
      ? V2_ORDERS_1_NORMAL_PAGE
      : V2_ORDERS_2_EMPTY,
  )
  const now = Date.now()
  const result = await historical.fetchHistoricalOrders(credentials, {
    startMs: now - 3 * DAY,
    endMs: now,
    statuses: ['Created', 'Delivered'],
    fetchImpl: impl,
    baseUrl: 'https://apigw.trendyol.com',
    retryDelaysMs: [],
  })
  assert.equal(result.fetchedPackageCount, 1)
  assert.equal(result.complete, true)
  assert.equal(result.cancelled, false)
  assert.ok(urls.length > 0)
  for (const url of urls) {
    assert.ok(url.includes('/v2/orders?'), `v2 uc noktasi bekleniyor: ${url}`)
    assert.equal(endpoint.isDeprecatedTrendyolOrdersUrl(url), false)
  }
})

test('V2-ORDERS-3: cok sayfali yanit EKSIKSIZ sayfalanir ve dedup edilir', async () => {
  const { urls, impl } = recordingFetch((url) => {
    const page = Number(url.searchParams.get('page') ?? 0)
    return V2_ORDERS_3_MULTI_PAGE.pages[page] ?? V2_ORDERS_2_EMPTY
  })
  const now = Date.now()
  const result = await historical.fetchHistoricalOrders(credentials, {
    startMs: now - 2 * DAY,
    endMs: now,
    statuses: ['Created'],
    fetchImpl: impl,
    baseUrl: 'https://apigw.trendyol.com',
    retryDelaysMs: [],
  })
  assert.equal(result.fetchedPackageCount, 450)
  assert.equal(urls.length, 3)
  assert.equal(result.complete, true)
})

test('V2-ORDERS-4: cap tespit edilince SESSIZCE basarili DONULMEZ, BOLUNUR', async () => {
  const sliceStarts = []
  let call = 0
  const impl = async (url) => {
    const parsed = new URL(String(url))
    sliceStarts.push(Number(parsed.searchParams.get('startDate')))
    call += 1
    // Ilk istek cap bildirir; bolunmus alt dilimler pencere ICINDE kalir.
    const body =
      call === 1
        ? V2_ORDERS_4_CAP_BOUNDARY
        : {
            totalElements: 1,
            totalPages: 1,
            page: 0,
            size: 200,
            content: [packageFixture({ id: 5000 + call, shipmentPackageId: 5000 + call })],
          }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const now = Date.now()
  const result = await historical.fetchHistoricalOrders(credentials, {
    startMs: now - 10 * DAY,
    endMs: now,
    statuses: ['Created'],
    fetchImpl: impl,
    baseUrl: 'https://apigw.trendyol.com',
    retryDelaysMs: [],
  })
  // Cap gorulunce aralik BOLUNDU. Ilk alt dilim ebeveynle AYNI startDate'ten
  // basladigi icin farkli baslangic sayisi bolme adedine esittir (2), toplam
  // birim sayisi ise ebeveyn + cocuklar = 3'tur.
  assert.ok(new Set(sliceStarts).size >= 2, 'cap sonrasi tarih BOLUNMELI')
  assert.ok(result.requestedWindows >= 3, 'ebeveyn + alt dilimler sayilir')
  assert.equal(result.complete, true, 'alt dilimler pencere icinde kaldi')
  // Her birim ayri raporlanir (devam ettirilebilirlik).
  assert.ok(result.windows.length >= 2)
  for (const window of result.windows) {
    assert.equal(typeof window.ok, 'boolean')
    assert.equal(typeof window.startMs, 'number')
  }
})

test('V2-ORDERS-4b: 1 ms tabaninda hala cap varsa EKSIKLIK bildirilir', async () => {
  const impl = async () =>
    new Response(JSON.stringify(V2_ORDERS_4_CAP_BOUNDARY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  const anchor = 1_757_000_000_000
  const result = await historical.fetchHistoricalOrders(credentials, {
    // Tek milisaniyelik aralik: daha ince bolunemez.
    startMs: anchor,
    endMs: anchor,
    statuses: ['Created'],
    fetchImpl: impl,
    baseUrl: 'https://apigw.trendyol.com',
    retryDelaysMs: [],
  })
  assert.equal(result.complete, false, 'ulasilamayan kayit varken COMPLETE denemez')
  assert.equal(result.windows[0].queryWindowExhausted, true)
  assert.equal(result.windows[0].unreachableRecords, 2540)
})

test('V2-ORDERS-5: dokumante EDILMEMIS statu tasinir, cokme YOK', async () => {
  const { impl } = recordingFetch(() => V2_ORDERS_5_UNKNOWN_STATUS)
  const now = Date.now()
  const result = await historical.fetchHistoricalOrders(credentials, {
    startMs: now - DAY,
    endMs: now,
    statuses: ['Created'],
    fetchImpl: impl,
    baseUrl: 'https://apigw.trendyol.com',
    retryDelaysMs: [],
  })
  assert.equal(result.fetchedPackageCount, 1)
  assert.equal(result.orders[0].marketplaceStatus, 'SomeFutureStatus')
})

test('V2-ORDERS-6: bozuk govde COKERTMEZ; bos icerik olarak gecer', async () => {
  const { impl } = recordingFetch(() => V2_ORDERS_6_MALFORMED)
  const now = Date.now()
  const result = await historical.fetchHistoricalOrders(credentials, {
    startMs: now - DAY,
    endMs: now,
    statuses: ['Created'],
    fetchImpl: impl,
    baseUrl: 'https://apigw.trendyol.com',
    retryDelaysMs: [],
  })
  assert.equal(result.fetchedPackageCount, 0)
})

test('V2-ORDERS-7/8: 401 · 403 · 429 birimi BASARISIZ isaretler', async () => {
  for (const fixture of [
    V2_ORDERS_7_UNAUTHORIZED,
    V2_ORDERS_7_FORBIDDEN,
    V2_ORDERS_8_RATE_LIMITED,
  ]) {
    const impl = async () =>
      new Response(JSON.stringify(fixture.body), {
        status: fixture.statusCode,
        headers: { 'Content-Type': 'application/json' },
      })
    const now = Date.now()
    const result = await historical.fetchHistoricalOrders(credentials, {
      startMs: now - DAY,
      endMs: now,
      statuses: ['Created'],
      fetchImpl: impl,
      baseUrl: 'https://apigw.trendyol.com',
      retryDelaysMs: [],
    })
    assert.equal(result.complete, false, `${fixture.statusCode} COMPLETE olamaz`)
    assert.equal(result.failedWindows, 1)
  }
})

test('V2-BACKFILL-1: iptal edilebilir ve yarim sonuc COMPLETE SAYILMAZ', async () => {
  let served = 0
  const impl = async () => {
    served += 1
    return new Response(JSON.stringify(V2_ORDERS_1_NORMAL_PAGE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const now = Date.now()
  const result = await historical.fetchHistoricalOrders(credentials, {
    startMs: now - 60 * DAY,
    endMs: now,
    statuses: ['Created', 'Delivered', 'Shipped'],
    fetchImpl: impl,
    baseUrl: 'https://apigw.trendyol.com',
    retryDelaysMs: [],
    shouldContinue: () => served < 2,
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.complete, false, 'iptal edilen cekim TAMAMLANMIS sayilmaz')
  assert.ok(result.windows.length >= 1, 'tamamlanan birimler KORUNUR (devam edilebilir)')
})

test('V2-FIXTURE-META: fixture kaynagi ve tarihi KAYITLI', () => {
  assert.equal(FIXTURE_META.official, true)
  assert.equal(FIXTURE_META.apiVersion, 'v2')
  assert.match(FIXTURE_META.retrievedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(FIXTURE_META.source.includes('developers.trendyol.com'))
})

// ═══ 4. ÇALIŞAN SUNUCU: TEK BİR İSTEK BİLE EMEKLİ UCA ÇIKMAZ ══════════════

const listen = (server) =>
  new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)))

/** BOSTA port ayirir ve BIRAKIR: dinleyici acik kalirsa API baglanamaz. */
async function reserveFreePort() {
  const probe = http.createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function startApi(t, mockPort, configDirectory) {
  const apiPort = await reserveFreePort()
  const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CARGOFLOW_API_PORT: String(apiPort),
      TRENDYOL_PROD_BASE_URL: `http://${host}:${mockPort}`,
      TRENDYOL_STAGE_BASE_URL: `http://${host}:${mockPort}`,
      CARGOFLOW_CONFIG_DIR: configDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => apiProcess.kill())
  const output = []
  apiProcess.stdout.on('data', (chunk) => output.push(String(chunk)))
  apiProcess.stderr.on('data', (chunk) => output.push(String(chunk)))
  await waitForHealth(apiPort, apiProcess, output)
  return apiPort
}

async function waitForHealth(port, child, output = []) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`API süreci kapandı (${child.exitCode}): ${output.join('')}`)
    }
    try {
      const response = await fetch(`http://${host}:${port}/api/health`)
      if (response.ok) return
    } catch {
      /* henüz ayakta değil */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`API sağlık kontrolüne yanıt vermedi: ${output.join('')}`)
}

test('V2-RUNTIME-1: canli senkron yolu YALNIZ v2 uca cikar; 426 uca HIC gidilmez', async (t) => {
  const upstreamRequests = []
  let deprecatedHits = 0

  const mockTrendyol = http.createServer((request, response) => {
    upstreamRequests.push(String(request.url))
    // EMEKLI UC: gercek gecis davranisini taklit eder (426). Bu dala
    // DUSULURSE test coker — istenen de budur.
    if (endpoint.isDeprecatedTrendyolOrdersUrl(`http://x${request.url}`)) {
      deprecatedHits += 1
      response.writeHead(V2_ORDERS_9_DEPRECATED_426.statusCode, {
        'Content-Type': 'application/json',
      })
      response.end(JSON.stringify(V2_ORDERS_9_DEPRECATED_426.body))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(V2_ORDERS_1_NORMAL_PAGE))
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => new Promise((resolve) => mockTrendyol.close(resolve)))

  const configDirectory = await mkdtemp(join(tmpdir(), 'cargoflow-v2-'))
  t.after(() => rm(configDirectory, { recursive: true, force: true }))
  const apiPort = await startApi(t, mockPort, configDirectory)

  const now = Date.now()
  const response = await fetch(
    `http://${host}:${apiPort}/api/integrations/trendyol/orders`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentials,
        query: { startDate: now - 3 * DAY, endDate: now, size: 200 },
      }),
    },
  )
  const body = await response.json()
  assert.equal(body.ok, true, body.message)

  assert.ok(upstreamRequests.length > 0, 'upstream istek YAPILMALI')
  assert.equal(deprecatedHits, 0, 'EMEKLI uca SIFIR istek')
  for (const url of upstreamRequests) {
    assert.ok(url.includes('/v2/orders?'), `v2 bekleniyor: ${url}`)
  }

  // ADAPTER SINIRI: v2 ham yaniti → kanonik CargoFlow siparisi. Asagi akis
  // (UI/worker) v2'yi BILMEK ZORUNDA DEGIL; alanlar AYNI isimlerle gelir.
  const order = body.orders?.[0]
  assert.ok(order, 'normalize edilmis siparis donmeli')
  const source = packageFixture()
  assert.equal(String(order.packageId), String(source.shipmentPackageId))
  assert.equal(String(order.orderNumber), String(source.orderNumber))
  assert.equal(order.marketplaceStatus, source.status)
  assert.equal(order.cargoTrackingNumber, source.cargoTrackingNumber)
  assert.equal(order.cargoProviderName, source.cargoProviderName)
  assert.equal(order.customerFirstName, source.customerFirstName)
  assert.equal(order.customerLastName, source.customerLastName)
  assert.equal(Number(order.totalAmount), Number(source.grossAmount))
  assert.equal(order.items?.[0]?.quantity, source.lines[0].quantity)
  assert.equal(order.city, source.shipmentAddress.city)
  assert.equal(order.district, source.shipmentAddress.district)
  assert.equal(order.customerPhone, source.shipmentAddress.phone)
  // HAM YANIT KORUNUR: adapter siniri v2 govdesini AYNEN tasir, dolayisiyla
  // bugun projekte EDILMEYEN alanlar (orn. `currencyCode`) kaybolmaz.
  //
  // NOT (bu gecisin KAPSAMI DISINDA, DEGISTIRILMEDI): canli senkron
  // normalizasyonu `currency` alanini URETMEZ; Trendyol `currencyCode`
  // gonderir ama yalniz `rawOrder` icinde kalir. Bu v2 ile GELMEDI, eski
  // uctaki davranisin AYNISIDIR — uc nokta gecisinde davranis degistirmemek
  // icin burada DUZELTILMEZ, raporda ayrica bildirilir.
  assert.equal(order.rawOrder?.currencyCode, source.currencyCode)
  assert.equal(order.currency, undefined)
})

test('V2-RUNTIME-2: tek istekte 14 GUNU asan aralik DILIMLENIR, hata DEGIL', async (t) => {
  const windows = []
  const mockTrendyol = http.createServer((request, response) => {
    const parsed = new URL(`http://x${request.url}`)
    if (endpoint.isDeprecatedTrendyolOrdersUrl(parsed.href)) {
      response.writeHead(426, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(V2_ORDERS_9_DEPRECATED_426.body))
      return
    }
    windows.push({
      start: Number(parsed.searchParams.get('startDate')),
      end: Number(parsed.searchParams.get('endDate')),
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(V2_ORDERS_1_NORMAL_PAGE))
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => new Promise((resolve) => mockTrendyol.close(resolve)))

  const configDirectory = await mkdtemp(join(tmpdir(), 'cargoflow-v2b-'))
  t.after(() => rm(configDirectory, { recursive: true, force: true }))
  const apiPort = await startApi(t, mockPort, configDirectory)

  const now = Date.now()
  const response = await fetch(
    `http://${host}:${apiPort}/api/integrations/trendyol/orders`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentials,
        // 25 gun: v2 tek-istek sinirinin (14) USTUNDE.
        query: {
          startDate: now - 25 * DAY,
          endDate: now,
          size: 200,
          status: 'Delivered',
        },
      }),
    },
  )
  const body = await response.json()
  assert.equal(body.ok, true, body.message)
  assert.ok(windows.length >= 2, 'aralik DILIMLENMELI')
  for (const window of windows) {
    assert.ok(
      window.end - window.start <= endpoint.TRENDYOL_V2_MAX_RANGE_MS,
      'hicbir istek tek-istek sinirini ASMAZ',
    )
  }
  // Dilimler istenen araligi UCTAN UCA kapsar.
  const sorted = [...windows].sort((a, b) => a.start - b.start)
  assert.ok(sorted[0].start <= now - 25 * DAY + 1)
  assert.ok(sorted.at(-1).end >= now - 1)
})

test('V2-RUNTIME-3: erişim penceresi tükendiginde COMPLETE denmez', async (t) => {
  // Mock HER istekte cap bildirir; aralik TEK MILISANIYE oldugu icin daha
  // ince bolunemez. Bu, gercek "erisilemeyen kayit var" durumudur.
  const mockTrendyol = http.createServer((request, response) => {
    if (endpoint.isDeprecatedTrendyolOrdersUrl(`http://x${request.url}`)) {
      response.writeHead(426, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(V2_ORDERS_9_DEPRECATED_426.body))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(V2_ORDERS_4_CAP_BOUNDARY))
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => new Promise((resolve) => mockTrendyol.close(resolve)))

  const configDirectory = await mkdtemp(join(tmpdir(), 'cargoflow-v2c-'))
  t.after(() => rm(configDirectory, { recursive: true, force: true }))
  const apiPort = await startApi(t, mockPort, configDirectory)

  const anchor = Date.now() - DAY
  const response = await fetch(
    `http://${host}:${apiPort}/api/integrations/trendyol/orders`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentials,
        query: {
          startDate: anchor,
          endDate: anchor,
          size: 200,
          status: 'Delivered',
        },
      }),
    },
  )
  const body = await response.json()
  assert.equal(body.ok, true, body.message)
  // KRITIK: `ok:true` COMPLETE DEMEK DEGILDIR.
  assert.equal(body.debug.queryWindowExhausted, true)
  assert.equal(
    body.debug.syncStatus,
    'PARTIAL',
    'ulasilamayan kayit varken COMPLETE yazilamaz',
  )
})

test('V2-RUNTIME-4: tuketilmislik senkron TAMAMLANDI kararina BAGLI', async () => {
  // Kaynak kaniti: `complete` hesabi tukenmislik kapisini ICERIR. Bu dal
  // olmadan `archiveMissingOrders` cekilemeyen siparisleri ARSIVLERDI.
  const entry = await readFile('server/index.mjs', 'utf8')
  assert.ok(
    entry.includes(
      "Boolean(result.ok) && syncStatus === 'COMPLETE' && !queryWindowExhausted",
    ),
    'complete karari tukenmislik kapisini icermeli',
  )
  assert.ok(
    entry.includes('function anyQueryWindowExhausted('),
    'birlestirme katmanlari tukenmisligi YUKARI TASIMALI',
  )
})
