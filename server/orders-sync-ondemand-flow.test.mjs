import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import http from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// "Marketplace sync yalnız talep üzerine" regresyon testleri (1-10).
// Kök neden: sayfa açılışı / sekme / route / mount / focus efektleri otomatik
// Trendyol sync tetikliyordu → rate limit → /api/orders/sync 502 + eşzamanlı
// sync. Bu test dosyası şunları güvence altına alır:
//   1-3) Otomatik provider sync tetikleyicileri kaldırıldı (statik kaynak kapısı)
//   4-5) Yenile butonu tek-uçuş korumalı (App single-flight ref kapısı)
//   6)   Aynı org için ikinci sync backend kilidiyle reddedilir
//   7)   Farklı tenant'lar ayrı sync çalıştırır (kilit org bazında)
//   8)   429 SINIRLI retry yapar (bounded; sonsuz değil)
//   9)   Kısmi/başarısız sync mevcut siparişleri SİLMEZ
//   10)  Başarıdan sonra liste DB'den (GET /api/orders) yeniden okunur

const here = dirname(fileURLToPath(import.meta.url))
const host = '127.0.0.1'

const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const repo = await import('./onboarding/onboardingRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')

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
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, name, slug) {
  const [org] = await db.insert(schema.organizations).values({ name, slug }).returning()
  return org.id
}
let seq = 0
function makeOrder(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'Ada',
    customerLastName: 'Lovelace',
    customerPhone: '5550000000',
    shipmentAddress: { fullAddress: 'Gizli Mah. 1', city: 'İstanbul', district: 'Kadıköy' },
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 149.9,
    currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-10T08:00:00Z',
    rawOrder: { secretField: 'RAW' },
    items: [
      {
        id: `line-${packageId}-1`,
        barcode: 'BRC-1',
        merchantSku: 'SKU-1',
        productContentId: 'CID-1',
        productName: 'Kablosuz Kulaklık',
        quantity: 1,
        price: 149.9,
      },
    ],
    ...over,
  }
}

// ── Backend org kilidi (6, 7) + kilit yaşam döngüsü ─────────────────────────
test('6) Aynı org için ikinci sync kilit nedeniyle reddedilir; terminal statü serbest bırakır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org L6', 'lock-6')

  // İlk istek kilidi alır.
  assert.equal(await repo.acquireSyncLock(db, org, 'orders'), true, 'ilk sync kilidi alır')
  // İkinci eşzamanlı istek reddedilir (tek satır, atomik).
  assert.equal(await repo.acquireSyncLock(db, org, 'orders'), false, 'ikinci sync reddedilir')
  assert.equal(await repo.acquireSyncLock(db, org, 'orders'), false, 'üçüncü de reddedilir')

  // Terminal statü (recordSyncState) kilidi serbest bırakır → yeni sync alabilir.
  await repo.recordSyncState(db, org, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    fetchedCount: 3,
  })
  const state = await repo.getSyncState(db, org, 'orders')
  assert.equal(state.lastSyncStatus, 'success')
  assert.ok(state.lastSuccessfulSyncAt, 'son başarılı sync zamanı yazılır (UI status)')
  assert.equal(await repo.acquireSyncLock(db, org, 'orders'), true, 'serbest kalan kilit yeniden alınır')

  // Ürün kilidi sipariş kilidinden BAĞIMSIZDIR (ayrı resource).
  assert.equal(await repo.acquireSyncLock(db, org, 'products'), true, 'ürün kilidi ayrı resource')
})

test('7) Farklı tenant\'lar birbirini bloklamadan sync çalıştırır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A7', 'lock-7a')
  const orgB = await makeOrg(db, 'Org B7', 'lock-7b')

  assert.equal(await repo.acquireSyncLock(db, orgA, 'orders'), true)
  // Org A kilitliyken Org B kendi sync'ini başlatabilir (kilit org bazında).
  assert.equal(await repo.acquireSyncLock(db, orgB, 'orders'), true, 'farklı tenant ayrı sync')
  // Org A için ikinci istek yine reddedilir (izolasyon çift yönlü).
  assert.equal(await repo.acquireSyncLock(db, orgA, 'orders'), false)
})

test('Kilit: beklenmedik hata yolunda releaseSyncLock serbest bırakır; bayat kilit devralınır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org LC', 'lock-lifecycle')

  // Crash yolu: terminal statü yazılmadan kilit alındı → releaseSyncLock bırakır.
  assert.equal(await repo.acquireSyncLock(db, org, 'orders'), true)
  assert.equal(await repo.acquireSyncLock(db, org, 'orders'), false)
  await repo.releaseSyncLock(db, org, 'orders', { errorCode: null })
  assert.equal(await repo.acquireSyncLock(db, org, 'orders'), true, 'release sonrası yeniden alınır')

  // Bayat kilit: 'running' kaydı staleMs'ten eskiyse devralınır (process çökmüş).
  await db
    .update(schema.integrationSyncState)
    .set({ updatedAt: new Date(Date.now() - 5 * 60 * 1000) })
    .where(
      and(
        eq(schema.integrationSyncState.organizationId, org),
        eq(schema.integrationSyncState.resource, 'orders'),
      ),
    )
  assert.equal(
    await repo.acquireSyncLock(db, org, 'orders'),
    true,
    'bayat running kilidi devralınır',
  )
})

// ── Persistence garantileri (9, 10) ─────────────────────────────────────────
test('9) Kısmi/başarısız sync mevcut siparişleri SİLMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org P9', 'persist-9')

  // Tam sync ile iki sipariş yazılır.
  await orderService.persistSyncResult(
    db,
    org,
    [makeOrder({ packageId: 'K-1' }), makeOrder({ packageId: 'K-2' })],
    { complete: true },
  )
  assert.equal((await orderService.listOrders(db, org, {})).total, 2)

  // Kısmi sync (complete=false, yalnız bir paket) → arşivlemez/silmez.
  const partial = await orderService.persistSyncResult(db, org, [makeOrder({ packageId: 'K-1' })], {
    complete: false,
  })
  assert.equal(partial.archivedCount, 0, 'kısmi sync arşivlemez')
  const rows = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))
  assert.equal(rows.filter((o) => o.archivedAt == null).length, 2, 'kısmi sync sipariş silmez')

  // Backend başarısızlık simülasyonu: recordSyncState 'failed' YAZAR ama sipariş
  // verisine dokunmaz (endpoint !result.ok yolunda persist çağırmaz).
  await repo.recordSyncState(db, org, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'failed',
    errorCode: '429',
  })
  const afterFail = await orderService.listOrders(db, org, {})
  assert.equal(afterFail.total, 2, 'başarısız sync mevcut siparişleri korur')
  const failState = await repo.getSyncState(db, org, 'orders')
  assert.equal(failState.lastSyncStatus, 'failed')
  assert.equal(failState.lastErrorCode, '429', 'UI için başarısız statü/kod yüzeye çıkar')
})

test('10) Başarıdan sonra liste DB\'den okunur (listOrders kaynak-of-truth)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Org R10', 'reload-10')

  await orderService.persistSyncResult(
    db,
    org,
    [makeOrder({ packageId: 'D-1', orderNumber: 'D-1' }), makeOrder({ packageId: 'D-2', orderNumber: 'D-2' })],
    { complete: true },
  )
  // Yeni bir db örneği (yeniden okuma) aynı kalıcı listeyi döner.
  const reread = await orderService.listOrders(drizzle(pglite, { schema }), org, {})
  assert.equal(reread.total, 2)
  assert.deepEqual(
    reread.orders.map((o) => o.packageId).sort(),
    ['D-1', 'D-2'],
  )
})

// ── Statik kaynak kapıları (1-5): otomatik sync tetikleyicileri kaldırıldı ──
function readSrc(rel) {
  return readFileSync(join(here, '..', rel), 'utf8')
}
function sliceBlock(src, anchor, length = 400) {
  const idx = src.indexOf(anchor)
  assert.notEqual(idx, -1, `beklenen kod bulunamadı: ${anchor}`)
  return src.slice(idx, idx + length)
}

test('1-3) App.tsx: sayfa açılışı/route/dashboard geçişi DB okur, Trendyol sync ATMAZ', () => {
  const app = readSrc('src/App.tsx')

  // Orders'a navigasyon YALNIZ DB okur (handleReloadOrders), sync (handleFetchOrders) çağırmaz.
  const navBlock = sliceBlock(app, 'function handleNavigate(page: PageKey) {', 300)
  assert.match(navBlock, /handleReloadOrders\(\)/, 'sayfa açılışı DB okur')
  assert.doesNotMatch(navBlock, /handleFetchOrders/, 'sayfa açılışı otomatik sync atmaz')

  // Dashboard kartından geçiş de DB okur, sync atmaz.
  const dashBlock = sliceBlock(app, 'function handleDashboardNavigateOrders(', 900)
  assert.match(dashBlock, /handleReloadOrders\(\)/, 'dashboard geçişi DB okur')
  assert.doesNotMatch(dashBlock, /handleFetchOrders/, 'dashboard geçişi otomatik sync atmaz')

  // Görsel eksikliğinde otomatik ürün sync efekti KALDIRILDI.
  assert.doesNotMatch(app, /productsAutoRefreshAttempted/, 'otomatik ürün sync efekti kaldırıldı')

  // handleReloadOrders yalnız DB okuma yolunu (loadOrdersFromServer) kullanır.
  const reloadBlock = sliceBlock(app, 'async function handleReloadOrders() {', 2000)
  assert.match(reloadBlock, /loadOrdersFromServer\(\)/, 'reload DB\'den okur')
  assert.doesNotMatch(reloadBlock, /\/api\/orders\/sync/, 'reload sync endpoint\'i çağırmaz')
})

test('4-5) App.tsx: Yenile tek-uçuş korumalı (eşzamanlı/çift-tık tek sync)', () => {
  const app = readSrc('src/App.tsx')
  assert.match(app, /const ordersSyncInFlight = useRef\(false\)/, 'sipariş single-flight ref var')
  assert.match(app, /const productsSyncInFlight = useRef\(false\)/, 'ürün single-flight ref var')

  const fetchBlock = sliceBlock(app, 'async function handleFetchOrders(', 900)
  assert.match(
    fetchBlock,
    /if \(ordersSyncInFlight\.current\) return/,
    'ikinci eşzamanlı sipariş sync erken döner (çift-tık tek sync)',
  )
  assert.match(fetchBlock, /ordersSyncInFlight\.current = true/, 'guard set edilir')
})

test('1-2) OrdersPage.tsx: sekme değişimi client-side filtreler, sync ATMAZ; Yenile butonu busy iken kapalı', () => {
  const page = readSrc('src/pages/OrdersPage.tsx')
  const tabBlock = sliceBlock(page, 'function refreshForTab(tab: QuickTab) {', 700)
  // Yorumda "onFetchOrders" geçebilir; ÇAĞRI (parantezli) olmadığını doğrula.
  assert.doesNotMatch(tabBlock, /onFetchOrders\(/, 'sekme değişimi otomatik sync atmaz')
  // Yenile butonu ilk tıkta kilitlenir (disabled={busy}).
  assert.match(page, /disabled=\{busy\}/, 'Yenile butonu busy iken kapalı')
})

test('orderWorkflowService: DB okuma GET /api/orders; sync ayrı POST /api/orders/sync', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  // NOT: tek sayfa cekme private fetchOrdersPage'e tasindi; blok ikisini de
  // kapsayacak sekilde alinir (davranis sozlesmesi AYNI).
  const loadBlock = sliceBlock(svc, 'async loadOrdersFromServer(', 6000)
  assert.match(loadBlock, /\/api\/orders/, 'DB okuma GET /api/orders kullanır')
  // Tum sayfalar yuklenir (25 kayit tavani YOK).
  assert.match(loadBlock, /ORDERS_LOAD_PAGE_SIZE/, 'sayfali yukleme')
  assert.doesNotMatch(loadBlock, /\/api\/orders\/sync/, 'DB okuma sync tetiklemez')
  assert.doesNotMatch(loadBlock, /method:\s*'POST'/, 'DB okuma GET\'tir (POST değil)')
  // 409 (sync zaten çalışıyor) veri kaybı yapmadan yüzeye çıkar.
  assert.match(svc, /sync_in_progress/, '409 sync-in-progress durumu ele alınır')
})

// ── 8) 429 SINIRLI retry (bounded) — canlı server + mock Trendyol ───────────
test('8) 429 için SINIRLI (bounded) retry yapılır, sonsuz döngü YOK', async (t) => {
  const attempts = new Map()
  const mockTrendyol = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (!url.pathname.endsWith('/orders')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'not found' }))
      return
    }
    const key = `${url.searchParams.get('status') ?? ''}|${url.searchParams.get('page') ?? '0'}`
    attempts.set(key, (attempts.get(key) ?? 0) + 1)
    // Her istek 429 → retry sınırının çalıştığını (bounded) kanıtla.
    response.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '0' })
    response.end(JSON.stringify({ message: 'rate limited' }))
  })
  const mockPort = await listen(mockTrendyol)
  t.after(() => mockTrendyol.close())

  const apiPort = await getFreePort()
  const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CARGOFLOW_API_PORT: String(apiPort),
      TRENDYOL_PROD_BASE_URL: `http://${host}:${mockPort}`,
      TRENDYOL_STAGE_BASE_URL: `http://${host}:${mockPort}`,
      // Testte backoff'u kısalt; retry SAYISI (üst sınır) değişmez.
      TRENDYOL_ORDER_RETRY_DELAYS_MS: '5,5,5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => apiProcess.kill())
  await waitForHealth(apiPort, apiProcess)

  const body = await postJson(apiPort, '/api/trendyol/orders/fetch', {
    credentials: { sellerId: 'SELLER-1', apiKey: 'k', apiSecret: 's', environment: 'prod' },
    query: {
      startDate: Date.parse('2026-07-01T00:00:00.000Z'),
      endDate: Date.parse('2026-07-05T23:59:59.999Z'),
      size: 50,
    },
  })

  // Sync başarısızdır ama sonsuz retry OLMAZ: her (status,page) için tam
  // 1 ilk deneme + 3 retry = 4 istek (retryDelaysMs uzunluğu 3).
  assert.equal(body.ok, false, 'kalıcı 429 sync\'i başarısız kılar')
  const createdPage0 = attempts.get('Created|0')
  assert.equal(createdPage0, 4, 'Created/page0 için 1 + 3 retry (bounded)')
  for (const [key, count] of attempts) {
    assert.ok(count <= 4, `${key} retry sınırı aşmadı (${count})`)
  }
})

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve(server.address().port))
  })
}
async function getFreePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function waitForHealth(port, child) {
  const startedAt = Date.now()
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  while (Date.now() - startedAt < 10000) {
    try {
      const response = await fetch(`http://${host}:${port}/api/health`)
      if (response.ok) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`API server başlamadı. ${stderr}`)
}
async function postJson(port, path, body) {
  const response = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}
