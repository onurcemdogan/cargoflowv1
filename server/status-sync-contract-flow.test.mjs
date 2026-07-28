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
import { eq } from 'drizzle-orm'

// Trendyol statü-sync sözleşmesi (FAZ 1–4).
// Kök neden: statü bazlı istekler (Created/Picking/Invoiced) SIRALI çalışıyor;
// bir statü geçici 5xx/429 aldığında TÜM sync 502 dönüyordu (kısmi başarı
// uygulama hatası gibi throw ediliyordu). Bu dosya şunları güvence altına alır:
//   1) Tüm aktif statüler başarılı  → COMPLETE (reconcile çalışır)
//   2) Geçici 5xx  → bounded retry + backoff → COMPLETE
//   3) 429 + Retry-After → retry → COMPLETE
//   4) Kalıcı 4xx → RETRY YOK (mapping/credential hatası); en az bir statü
//      başarılıysa PARTIAL (statusCode 207), tarayıcıda 502 OLUŞMAZ
//   5) Hiçbir statü başarılı değilse → TOTAL_FAILURE (endpoint 502/503)
//   6) Endpoint sözleşmesi: PARTIAL 207 (reconcile YOK) / TOTAL 502 / COMPLETE 200
//   7) Frontend: PARTIAL warning (throw değil) + başarılı/başarısız statüler
//   8) Frontend: tek-uçuş (çift-tık tek sync) + Dashboard Yenile sync ATMAZ
//   9) COMPLETE sayım: reconcile sonrası aktif liste = güncel aktif set
//  10) PARTIAL persistence: complete=false → arşiv YOK, mevcut liste korunur
//  11) COMPLETE güçlü kanıtı (LABEL_READY/PRINTED) korur
//  12) lastSuccessfulSyncAt: yalnız 'success' günceller (partial/failed etkilemez)
//
// NOT: tenant izolasyonu + sync-penceresi kapsamı zaten
// active-sync-reconciliation-flow.test.mjs (RCN-8/9/10) ve
// orders-sync-ondemand-flow.test.mjs (7) tarafından kapsanır.

const here = dirname(fileURLToPath(import.meta.url))
const host = '127.0.0.1'

// ── Ortak yardımcılar ───────────────────────────────────────────────────────
function readSrc(rel) {
  return readFileSync(join(here, '..', rel), 'utf8')
}
function sliceBlock(src, anchor, length = 1400) {
  const idx = src.indexOf(anchor)
  assert.notEqual(idx, -1, `beklenen kod bulunamadı: ${anchor}`)
  return src.slice(idx, idx + length)
}
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
  while (Date.now() - startedAt < 15000) {
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
  return { httpStatus: response.status, body: await response.json() }
}

// Statü başına davranışı planlanabilen sahte Trendyol sunucusu. `plan(status,
// attempt)` → { code, retryAfter? }. Başarılı yanıt tek paketlik sayfa döner;
// başarısız yanıt hata gövdesi döner. attempts sayacı (status → deneme sayısı)
// retry/no-retry doğrulaması için toplanır.
function makeMockTrendyol(plan) {
  const attempts = new Map()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (!url.pathname.endsWith('/orders')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: 'not found' }))
      return
    }
    const status = url.searchParams.get('status') ?? ''
    // status='' → filtresiz aktif-keşif isteği (COMPLETE yolunda). Boş içerik.
    if (status === '') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ content: [], totalElements: 0, totalPages: 1, page: 0 }))
      return
    }
    const attempt = (attempts.get(status) ?? 0) + 1
    attempts.set(status, attempt)
    const decision = plan(status, attempt) ?? { code: 200 }
    if (decision.code === 200) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          content: [
            {
              id: `${status}-PKG-1`,
              shipmentPackageId: `${status}-PKG-1`,
              orderNumber: `${status}-ORD-1`,
              cargoTrackingNumber: '',
              status,
              lines: [{ barcode: 'B1', quantity: 1, productName: 'X', price: 10 }],
            },
          ],
          totalElements: 1,
          totalPages: 1,
          page: 0,
        }),
      )
      return
    }
    const headers = { 'Content-Type': 'application/json' }
    if (decision.retryAfter != null) headers['retry-after'] = String(decision.retryAfter)
    response.writeHead(decision.code, headers)
    response.end(JSON.stringify({ message: `status ${decision.code}` }))
  })
  return { server, attempts }
}

async function runFetch(t, plan, extraEnv = {}) {
  const { server, attempts } = makeMockTrendyol(plan)
  const mockPort = await listen(server)
  t.after(() => server.close())

  const apiPort = await getFreePort()
  const apiProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CARGOFLOW_API_PORT: String(apiPort),
      TRENDYOL_PROD_BASE_URL: `http://${host}:${mockPort}`,
      TRENDYOL_STAGE_BASE_URL: `http://${host}:${mockPort}`,
      // Testte backoff'u kısalt (retry SAYISI değişmez) + statü aralığını sıfırla.
      TRENDYOL_ORDER_RETRY_DELAYS_MS: '5,5,5',
      TRENDYOL_STATUS_REQUEST_SPACING_MS: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => apiProcess.kill())
  await waitForHealth(apiPort, apiProcess)

  // Aktif statüler + dar pencere (tek istek/statü) → deterministik.
  const { body } = await postJson(apiPort, '/api/trendyol/orders/fetch', {
    credentials: { sellerId: 'SELLER-1', apiKey: 'k', apiSecret: 's', environment: 'prod' },
    query: {
      statuses: ['Created', 'Picking', 'Invoiced'],
      startDate: Date.parse('2026-07-20T00:00:00.000Z'),
      endDate: Date.parse('2026-07-24T00:00:00.000Z'),
      size: 50,
    },
  })
  return { body, attempts }
}

// ── 1) Tüm aktif statüler başarılı → COMPLETE ───────────────────────────────
test('SSC-1: Created+Picking+Invoiced 200 → COMPLETE sync', async (t) => {
  const { body, attempts } = await runFetch(t, () => ({ code: 200 }))
  assert.equal(body.ok, true, 'tüm statüler başarılı → ok:true')
  assert.equal(body.debug?.syncStatus, 'COMPLETE')
  // Her statü tam bir kez denendi (retry gerekmedi).
  assert.equal(attempts.get('Created'), 1)
  assert.equal(attempts.get('Picking'), 1)
  assert.equal(attempts.get('Invoiced'), 1)
})

// ── 2) Geçici 5xx → bounded retry → COMPLETE ────────────────────────────────
test('SSC-2: Picking geçici 500 (2×) sonra 200 → retry ile COMPLETE', async (t) => {
  const { body, attempts } = await runFetch(t, (status, attempt) => {
    if (status === 'Picking' && attempt <= 2) return { code: 500 }
    return { code: 200 }
  })
  assert.equal(body.ok, true, 'geçici 5xx retry ile toparlanır → COMPLETE')
  assert.equal(body.debug?.syncStatus, 'COMPLETE')
  // 1 ilk deneme + 2 retry = 3 (bounded; sonsuz değil).
  assert.equal(attempts.get('Picking'), 3, 'Picking geçici 5xx için tekrar denendi')
})

// ── 3) 429 + Retry-After → retry → COMPLETE ─────────────────────────────────
test('SSC-3: Invoiced 429 (Retry-After) sonra 200 → retry ile COMPLETE', async (t) => {
  const { body, attempts } = await runFetch(t, (status, attempt) => {
    if (status === 'Invoiced' && attempt === 1) return { code: 429, retryAfter: 0 }
    return { code: 200 }
  })
  assert.equal(body.ok, true, '429 Retry-After sonrası toparlanır → COMPLETE')
  assert.equal(body.debug?.syncStatus, 'COMPLETE')
  assert.equal(attempts.get('Invoiced'), 2, 'Invoiced 429 için bir kez daha denendi')
})

// ── 4) Kalıcı 4xx → RETRY YOK; PARTIAL (207) ────────────────────────────────
test('SSC-4: Picking kalıcı 400 → retry YOK, kısmi (207) PARTIAL', async (t) => {
  const { body, attempts } = await runFetch(t, (status) => {
    if (status === 'Picking') return { code: 400 }
    return { code: 200 }
  })
  assert.equal(body.ok, false, 'bir statü kalıcı başarısız → ok:false')
  assert.equal(body.statusCode, 207, 'kısmi başarı 207 (5xx DEĞİL)')
  assert.equal(body.debug?.syncStatus, 'PARTIAL')
  // 4xx kalıcıdır → tekrar DENENMEZ (tam 1 deneme).
  assert.equal(attempts.get('Picking'), 1, 'kalıcı 400 retry edilmez')
  const picking = (body.debug?.statusRequests ?? []).find((s) => s.status === 'Picking')
  assert.ok(picking, 'Picking statü kaydı raporlanır')
  assert.equal(picking.ok, false)
  assert.equal(picking.retryable, false, '400 retryable DEĞİL (mapping/credential)')
})

// ── 5) Hiçbir statü başarılı değil → TOTAL_FAILURE ──────────────────────────
test('SSC-5: tüm statüler 400 → TOTAL_FAILURE (FAILED)', async (t) => {
  const { body, attempts } = await runFetch(t, () => ({ code: 400 }))
  assert.equal(body.ok, false, 'hiçbir statü başarılı değil → ok:false')
  assert.equal(body.debug?.syncStatus, 'FAILED')
  assert.notEqual(body.statusCode, 207, 'total failure kısmi (207) DEĞİL')
  // Kalıcı 4xx: her statü tam 1 kez (retry yok).
  for (const status of ['Created', 'Picking', 'Invoiced']) {
    assert.equal(attempts.get(status), 1, `${status} 400 retry edilmez`)
  }
})

// ── 6) Endpoint sözleşmesi (kaynak-seviyesi) ────────────────────────────────
test('SSC-6: /api/orders/sync — PARTIAL 207 (reconcile YOK) / TOTAL 502 / COMPLETE 200', () => {
  const server = readSrc('server/index.mjs')
  const block = sliceBlock(server, 'const syncStatus = result.debug?.syncStatus', 6600)
  // PARTIAL algısı: partial flag veya debug.syncStatus === 'PARTIAL'.
  assert.match(block, /const partial = result\.partial === true \|\| syncStatus === 'PARTIAL'/)
  // TOTAL_FAILURE yalnız PARTIAL DEĞİLKEN 502 döner (kısmi başarı 502 olmaz).
  assert.match(block, /if \(!result\.ok && !partial\)/)
  assert.match(block, /response\.status\(502\)/)
  // PARTIAL → HTTP 207 (2xx), ok:false, successful/failed statüler, arşiv 0.
  assert.match(block, /response\.status\(207\)/)
  assert.match(block, /successfulStatuses: result\.successfulStatuses/)
  assert.match(block, /failedStatuses: result\.failedStatuses/)
  assert.match(block, /archivedCount: 0/)
  // Reconcile YALNIZ complete=true'da: partial için complete=false threadlenir.
  assert.match(block, /complete = Boolean\(result\.ok\) && syncStatus === 'COMPLETE'/)
  // COMPLETE → 200 ok:true + reconcile sayaçları.
  assert.match(block, /ok: true,\s*\n\s*complete: persistResult\.complete/)
  // lastSuccessfulSyncAt yalnız 'success' (partial değil): status seçimi complete'e bağlı.
  assert.match(block, /const syncOutcome = persistResult\.complete \? 'success' : 'partial'/)
  assert.match(block, /status: syncOutcome/)
})

// ── 7) Frontend: PARTIAL warning (throw değil) + statü kırılımı ──────────────
test('SSC-7: orderWorkflowService — 207 PARTIAL warning; başarılı/başarısız statüler; liste korunur', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  const block = sliceBlock(svc, 'private async fetchOrdersAuthMode(', 4200)
  // 207 (2xx) → response.ok true ama payload.ok=false → syncOk=false → warning.
  assert.match(block, /syncOk = response\.ok && syncPayload\.ok === true/)
  // Kısmi statü kırılımı yüzeye çıkar.
  assert.match(block, /successfulStatuses/)
  assert.match(block, /failedStatuses/)
  assert.match(block, /retryable/)
  // Warning yolu: liste korunur (mevcut sipariş sayısı yüzeye çıkar), throw YOK.
  assert.match(block, /level: 'warning'/)
  assert.match(block, /korun/i)
  assert.doesNotMatch(block, /throw new Error/)
  // Non-JSON 502 gövdesi kullanıcıya HAM gösterilmez (güvenli parse).
  assert.match(block, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\)/)
  // 409 sync_in_progress hata değil (info).
  assert.match(block, /syncInProgress/)
})

// ── 8) Frontend: tek-uçuş + Dashboard Yenile sync atmaz ─────────────────────
test('SSC-8: App.tsx — çift-tık tek sync (single-flight) + Dashboard Yenile sync ATMAZ', () => {
  const app = readSrc('src/App.tsx')
  const fetchBlock = sliceBlock(app, 'async function handleFetchOrders(', 3500)
  assert.match(fetchBlock, /if \(ordersSyncInFlight\.current\) return/, 'ikinci tık erken döner')
  assert.match(fetchBlock, /ordersSyncInFlight\.current = true/)
  // Buton her yolda finally'de serbest bırakılır (kalıcı disabled kalmaz).
  assert.match(fetchBlock, /finally \{[\s\S]*ordersSyncInFlight\.current = false/)
  // Dashboard Yenile yalnız DB okur; /api/orders/sync ÇAĞIRMAZ.
  const reload = sliceBlock(app, 'async function handleReloadOrders()', 900)
  assert.doesNotMatch(reload, /\/api\/orders\/sync/)
  assert.match(reload, /loadOrdersFromServer\(\)/)
})

// ── DB destekli sözleşme testleri ───────────────────────────────────────────
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const orderService = await import('./orders/orderPersistenceService.ts')
const repo = await import('./onboarding/onboardingRepository.ts')

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
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}
function order(over = {}) {
  const packageId = over.packageId
  return {
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `114${packageId}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'A',
    customerLastName: 'B',
    city: 'İstanbul',
    totalAmount: 100,
    currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-24T08:00:00Z',
    rawOrder: {},
    items: [{ id: `l-${packageId}`, quantity: 1, price: 100 }],
    ...over,
  }
}
const JULY_WINDOW = {
  startMs: Date.parse('2026-07-20T00:00:00Z'),
  endMs: Date.parse('2026-07-28T23:59:59Z'),
}
async function archivedAtOf(db, packageId) {
  const [row] = await db
    .select({ archivedAt: schema.orders.archivedAt })
    .from(schema.orders)
    .where(eq(schema.orders.packageId, packageId))
  return row?.archivedAt ?? null
}

// ── 9) COMPLETE sayım: reconcile sonrası liste = güncel aktif set ────────────
test('SSC-9: COMPLETE — 10 aktif paket sayılır; 2 bayat düşünce liste 8 kalır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ssc-9')
  // İlk COMPLETE: 10 aktif (pencere içi, NEW).
  const first = Array.from({ length: 10 }, (_, i) => order({ packageId: `P-${i}` }))
  await orderService.persistSyncResult(db, org, first, { complete: true, window: JULY_WINDOW })
  assert.equal((await orderService.listOrders(db, org, {})).total, 10, 'COMPLETE 10 aktif → Yeni Siparişler 10')
  // İkinci COMPLETE: yalnız 8 aktif; P-8/P-9 aktif set'te YOK (zayıf NEW, pencere içi).
  const second = Array.from({ length: 8 }, (_, i) => order({ packageId: `P-${i}` }))
  const result = await orderService.persistSyncResult(db, org, second, { complete: true, window: JULY_WINDOW })
  assert.equal(result.archivedCount, 2, 'düşen 2 bayat NEW arşivlenir')
  const active = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.organizationId, org))
  assert.equal(active.filter((o) => o.archivedAt == null).length, 8, 'aktif liste güncel set = 8')
})

// ── 10) PARTIAL persistence: complete=false → arşiv YOK, liste korunur ───────
test('SSC-10: PARTIAL (complete=false) — mevcut 20 sipariş arşivlenmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ssc-10')
  const twenty = Array.from({ length: 20 }, (_, i) => order({ packageId: `Q-${i}` }))
  await orderService.persistSyncResult(db, org, twenty, { complete: true, window: JULY_WINDOW })
  assert.equal((await orderService.listOrders(db, org, {})).total, 20)
  // Kısmi sync: yalnız 5 başarılı statü içeriği gelir AMA complete=false → reconcile YOK.
  const partial = await orderService.persistSyncResult(
    db,
    org,
    [order({ packageId: 'Q-0' }), order({ packageId: 'Q-1' })],
    { complete: false, window: JULY_WINDOW },
  )
  assert.equal(partial.archivedCount, 0, 'kısmi sync arşivlemez')
  assert.equal((await orderService.listOrders(db, org, {})).total, 20, 'mevcut 20 korunur')
})

// ── 11) COMPLETE güçlü kanıtı korur ─────────────────────────────────────────
test('SSC-11: COMPLETE — LABEL_READY/LABEL_PRINTED aktif set dışıysa da korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ssc-11')
  await orderService.persistSyncResult(
    db,
    org,
    [
      order({ packageId: 'READY-1', operationStatus: 'LABEL_READY' }),
      order({ packageId: 'PRINTED-1', operationStatus: 'LABEL_PRINTED' }),
      order({ packageId: 'WEAK-1' }),
    ],
    { complete: true, window: JULY_WINDOW },
  )
  // Sonraki tam sync: üçü de aktif set'te YOK.
  const result = await orderService.persistSyncResult(
    db,
    org,
    [order({ packageId: 'FRESH' })],
    { complete: true, window: JULY_WINDOW },
  )
  assert.equal(await archivedAtOf(db, 'READY-1'), null, 'LABEL_READY korunur')
  assert.equal(await archivedAtOf(db, 'PRINTED-1'), null, 'LABEL_PRINTED korunur')
  assert.ok(await archivedAtOf(db, 'WEAK-1'), 'zayıf NEW arşivlenir')
  assert.equal(result.archivedCount, 1, 'yalnız zayıf kayıt arşivlenir')
})

// ── 12) lastSuccessfulSyncAt yalnız 'success' günceller ─────────────────────
test('SSC-12: lastSuccessfulSyncAt — partial/failed DEĞİŞTİRMEZ, success günceller', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'ssc-12')
  // partial → lastSuccessfulSyncAt yazılmaz.
  await repo.recordSyncState(db, org, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'partial',
    fetchedCount: 3,
  })
  let state = await repo.getSyncState(db, org, 'orders')
  assert.equal(state.lastSyncStatus, 'partial')
  assert.equal(state.lastSuccessfulSyncAt ?? null, null, 'partial son başarılı zamanı BOZMAZ')
  // failed → yine yazılmaz.
  await repo.recordSyncState(db, org, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'failed',
    errorCode: '429',
  })
  state = await repo.getSyncState(db, org, 'orders')
  assert.equal(state.lastSuccessfulSyncAt ?? null, null, 'failed son başarılı zamanı BOZMAZ')
  // success → yazılır.
  await repo.recordSyncState(db, org, {
    provider: 'trendyol',
    resource: 'orders',
    status: 'success',
    fetchedCount: 5,
  })
  state = await repo.getSyncState(db, org, 'orders')
  assert.ok(state.lastSuccessfulSyncAt, 'success son başarılı zamanı yazar')
})
