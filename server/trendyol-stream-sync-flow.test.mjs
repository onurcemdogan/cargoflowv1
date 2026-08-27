import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

// ═══ TRENDYOL RESMÎ STREAM + PAKET YAKINSAMASI ═══════════════════════════
//
// Denetim: üretim SAYFA TABANLI çalışıyordu, resmî `getShipmentPackagesStream`
// hiç kullanılmıyordu. Bu paket, stream sözleşmesini ve aynı paketin farklı
// kaynaklardan gelince TEK kayıtta buluşmasını kilitler.
//
// AĞ YOK — getirici enjekte edilir.

const STREAM = await import('./marketplaces/trendyolOrderStream.ts')
const CONV = await import('./marketplaces/trendyolPackageConvergence.ts')

const here = new URL('.', import.meta.url)
const BASE = 'https://api.trendyol.com'
const FILTERS = { startDate: 1_000, endDate: 2_000, size: 200 }

const pkg = (id, extra = {}) => ({
  shipmentPackageId: id, orderNumber: `115${id}`,
  cargoTrackingNumber: `727${id}`, status: 'Created',
  lastModifiedDate: 5_000, ...extra,
})

/** Sayfa listesini sırayla döndüren sahte getirici. */
const fetcherFor = (pages) => {
  const seen = []
  let index = 0
  return {
    seen,
    fetchJson: async (url) => {
      seen.push(url)
      const page = pages[index++] ?? { content: [], hasMore: false }
      return { ok: page.ok !== false, body: page }
    },
  }
}

/* ═══ STREAM SÖZLEŞMESİ ════════════════════════════════════════════ */

test('TY-STREAM-1: resmi yol ve sozlesme sinirlari', () => {
  assert.equal(
    STREAM.TRENDYOL_STREAM_PATH_TEMPLATE,
    '/integration/order/sellers/{sellerId}/orders/stream',
  )
  assert.equal(STREAM.TRENDYOL_STREAM_MAX_SIZE, 200)
  assert.equal(STREAM.TRENDYOL_STREAM_MAX_WINDOW_MS, 14 * 24 * 60 * 60 * 1000)
  assert.equal(STREAM.TRENDYOL_STREAM_MAX_HISTORY_MS, 90 * 24 * 60 * 60 * 1000)

  const url = STREAM.buildTrendyolStreamUrl({
    baseUrl: BASE, sellerId: 277221, filters: FILTERS,
  })
  assert.ok(url.includes('/sellers/277221/orders/stream'))
  assert.ok(url.includes('size=200'))
  // Ilk istekte imlec YOKTUR — uydurulmaz.
  assert.equal(url.includes('cursor='), false)

  // Boyut ust sinirda KIRPILIR.
  const big = STREAM.buildTrendyolStreamUrl({
    baseUrl: BASE, sellerId: 1, filters: { ...FILTERS, size: 5000 },
  })
  assert.ok(big.includes('size=200'))
})

test('TY-STREAM-2: imlec OPAKTIR — ayristirilmaz, degistirilmez', () => {
  const opaque = 'eyJvZmZzZXQiOjQyfQ==.SIGNED'
  const url = STREAM.buildTrendyolStreamUrl({
    baseUrl: BASE, sellerId: 1, filters: FILTERS, cursor: opaque,
  })
  // AYNEN tasinir (yalniz URL kodlamasi).
  assert.equal(
    new URL(url).searchParams.get('cursor'), opaque,
    'imlec degistirildi',
  )
  // Kaynakta imleci ayristiran/ureten bir sey OLMAMALI.
  const source = readFileSync(
    new URL('./marketplaces/trendyolOrderStream.ts', here), 'utf8',
  )
  for (const forbidden of [
    'atob(', 'Buffer.from(cursor', 'JSON.parse(cursor', 'cursor.split',
    'decodeCursor', 'buildCursor',
  ]) {
    assert.equal(source.includes(forbidden), false, `imlece dokunuluyor: ${forbidden}`)
  }
})

test('TY-STREAM-3: zincir hasMore/nextCursor ile ilerler', async () => {
  const f = fetcherFor([
    { content: [pkg('A1'), pkg('A2')], nextCursor: 'C1', hasMore: true },
    { content: [pkg('B1')], nextCursor: 'C2', hasMore: true },
    { content: [pkg('D1')], nextCursor: null, hasMore: false },
  ])
  const run = await STREAM.runTrendyolStream({
    baseUrl: BASE, sellerId: 1, filters: FILTERS,
    fetchJson: f.fetchJson, minIntervalMs: 0,
  })
  assert.equal(run.pages, 3)
  assert.equal(run.packages.length, 4)
  assert.equal(run.stopReason, 'NO_MORE_PAGES')
  // 2. ve 3. istek sunucunun verdigi imleci TASIR.
  assert.equal(new URL(f.seen[1]).searchParams.get('cursor'), 'C1')
  assert.equal(new URL(f.seen[2]).searchParams.get('cursor'), 'C2')
})

test('TY-STREAM-4: zincir boyunca FILTRELER DEGISMEZ', async () => {
  const f = fetcherFor([
    { content: [pkg('A1')], nextCursor: 'C1', hasMore: true },
    { content: [pkg('A2')], nextCursor: null, hasMore: false },
  ])
  await STREAM.runTrendyolStream({
    baseUrl: BASE, sellerId: 1, filters: FILTERS,
    fetchJson: f.fetchJson, minIntervalMs: 0,
  })
  const filtersOf = (url) => {
    const q = new URL(url).searchParams
    return [q.get('startDate'), q.get('endDate'), q.get('size'), q.get('status')]
  }
  assert.deepEqual(filtersOf(f.seen[0]), filtersOf(f.seen[1]))
  // Parmak izi kimligi sabittir.
  assert.equal(
    STREAM.streamFilterFingerprint(FILTERS),
    STREAM.streamFilterFingerprint({ ...FILTERS }),
  )
  assert.notEqual(
    STREAM.streamFilterFingerprint(FILTERS),
    STREAM.streamFilterFingerprint({ ...FILTERS, endDate: 9_999 }),
  )
})

test('TY-STREAM-5: hasMore=true ama imlec YOKSA zincir DURUR', async () => {
  const f = fetcherFor([
    { content: [pkg('A1')], nextCursor: null, hasMore: true },
  ])
  const run = await STREAM.runTrendyolStream({
    baseUrl: BASE, sellerId: 1, filters: FILTERS,
    fetchJson: f.fetchJson, minIntervalMs: 0,
  })
  // Imlec UYDURULMAZ.
  assert.equal(run.stopReason, 'EMPTY_CURSOR_WITH_MORE')
  assert.equal(run.pages, 1)
})

test('TY-STREAM-6: hata KISMI ilerlemeyi korur ve devam imleci verir', async () => {
  const f = fetcherFor([
    { content: [pkg('A1')], nextCursor: 'C1', hasMore: true },
    { ok: false },
  ])
  const run = await STREAM.runTrendyolStream({
    baseUrl: BASE, sellerId: 1, filters: FILTERS,
    fetchJson: f.fetchJson, minIntervalMs: 0,
  })
  assert.equal(run.stopReason, 'FETCH_FAILED')
  assert.equal(run.packages.length, 1, 'kismi ilerleme KAYBOLMAMALI')
  assert.equal(run.resumeCursor, 'C1', 'devam imleci saklanmali')
})

test('TY-STREAM-7: pencereler 14 gunu ASMAZ, 3 aydan ESKIYE gitmez', () => {
  const now = Date.UTC(2026, 7, 26)
  const windows = STREAM.planStreamWindows({ nowMs: now })
  assert.ok(windows.length > 0)
  for (const w of windows) {
    assert.ok(
      w.endDate - w.startDate <= STREAM.TRENDYOL_STREAM_MAX_WINDOW_MS,
      '14 gun asildi',
    )
    assert.ok(w.startDate >= now - STREAM.TRENDYOL_STREAM_MAX_HISTORY_MS)
  }
  // Sinirsiz gecmis ISTENMEZ: cok eski bir baslangic kirpilir.
  const clamped = STREAM.planStreamWindows({ nowMs: now, fromMs: 0 })
  assert.ok(clamped[0].startDate >= now - STREAM.TRENDYOL_STREAM_MAX_HISTORY_MS)
})

/* ═══ YAKINSAMA ════════════════════════════════════════════════════ */

test('TY-CONV-1: paket kimligi packageId, orderNumber DEGIL', () => {
  // Ayni siparis, IKI paket → AYRI kimlik.
  const a = CONV.resolvePackageIdentity({ shipmentPackageId: 'P1', orderNumber: 'O1' })
  const b = CONV.resolvePackageIdentity({ shipmentPackageId: 'P2', orderNumber: 'O1' })
  assert.notEqual(a, b)
  // Kimlik YOKSA reddedilir — orderNumber yedek DEGILDIR.
  const rejected = CONV.resolvePackageConvergence({
    incoming: { orderNumber: 'O1', lastModifiedDate: 1 }, stored: null,
  })
  assert.equal(rejected.decision, 'REJECT_NO_IDENTITY')
})

test('TY-CONV-2: ESKI olay YENI veriyi EZMEZ', () => {
  const result = CONV.resolvePackageConvergence({
    incoming: pkg('P1', { status: 'Created', lastModifiedDate: 1_000 }),
    stored: {
      packageId: 'P1', providerStatus: 'Picking',
      marketplaceLastModifiedAt: 5_000,
    },
  })
  assert.equal(result.decision, 'SKIP_STALE')
})

test('TY-CONV-3: daha YENI olay uygulanir; degismeyen yazilmaz', () => {
  const fresher = CONV.resolvePackageConvergence({
    incoming: pkg('P1', { status: 'Picking', lastModifiedDate: 9_000 }),
    stored: {
      packageId: 'P1', orderNumber: '115P1', cargoTrackingNumber: '727P1',
      providerStatus: 'Created', marketplaceLastModifiedAt: 5_000,
    },
  })
  assert.equal(fresher.decision, 'UPDATE')

  const same = CONV.resolvePackageConvergence({
    incoming: pkg('P1', { status: 'Created', lastModifiedDate: 5_000 }),
    stored: {
      packageId: 'P1', orderNumber: '115P1', cargoTrackingNumber: '727P1',
      providerStatus: 'Created', marketplaceLastModifiedAt: 5_000,
    },
  })
  assert.equal(same.decision, 'SKIP_UNCHANGED', 'gereksiz yazma')
})

test('TY-CONV-4: webhook + stream ayni paketi TEK girise indirger', () => {
  const merged = CONV.dedupeIncomingPackages([
    pkg('P1', { status: 'Created', lastModifiedDate: 1_000 }),  // stream
    pkg('P1', { status: 'Picking', lastModifiedDate: 9_000 }),  // webhook
    pkg('P2', { lastModifiedDate: 2_000 }),
  ])
  assert.equal(merged.length, 2)
  const p1 = merged.find((m) => m.shipmentPackageId === 'P1')
  // EN TAZE olan kazanir.
  assert.equal(p1.status, 'Picking')
})

test('TY-CONV-5: sirasiz teslimat ve tekrar OYNATMA yakinsar', () => {
  // Ayni parti ters sirada gelse de sonuc AYNI.
  const forward = CONV.dedupeIncomingPackages([
    pkg('P1', { status: 'Created', lastModifiedDate: 1_000 }),
    pkg('P1', { status: 'Picking', lastModifiedDate: 9_000 }),
  ])
  const reverse = CONV.dedupeIncomingPackages([
    pkg('P1', { status: 'Picking', lastModifiedDate: 9_000 }),
    pkg('P1', { status: 'Created', lastModifiedDate: 1_000 }),
  ])
  assert.equal(forward[0].status, reverse[0].status)
  assert.equal(forward.length, 1)
  assert.equal(reverse.length, 1)
})

test('TY-CONV-6: bolunmus ve iptal-yerine paketler AYRI kalir', () => {
  const split = CONV.dedupeIncomingPackages([
    pkg('P1', { orderNumber: 'O1' }),
    pkg('P2', { orderNumber: 'O1' }),   // ayni siparis, ikinci paket
    pkg('P3', { orderNumber: 'O1', status: 'Cancelled' }),
  ])
  assert.equal(split.length, 3, 'paketler birbirine EZDIRILDI')
})

test('TY-SYNC-REG: yeni test dosyasi test:surat icinde KAYITLI', () => {
  const listed = new Set(
    JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
      .scripts['test:surat'].split(' ').filter((x) => x.endsWith('.test.mjs')),
  )
  const onDisk = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [])
})
