import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// HESAP KAPSAMLI TEK-UCUS (SINGLE-FLIGHT).
//
// AUDIT SONUCU (kod duzeyinde kanitli):
//   · manuel POST /api/orders/sync ZATEN DB tabanli, hesap kapsamli bir kilit
//     alir (integration_sync_state) → manuel+manuel engelli (409).
//   · ANCAK 60 sn'lik arka plan turu bu kilidi ALMIYORDU → manuel senkron ile
//     arka plan turu AYNI hesapta ORTUSEBILIYORDU. Iki paralel cekim, ayni
//     satici icin istek sayisini ikiye katlar ve 429/gecici hata olasiligini
//     yukseltir ("Senkron kismi kaldi" uyarisinin zemini).
//
// Cozum: SUREC ICI, hesap kapsamli ucus kayit defteri. DB kilidi arka plan
// icin KULLANILMAZ (releaseSyncLock durumu `failed` yazar ve UI'nin "son
// senkronizasyon" gostergesini bozardi).
//
// Retry sozlesmesi, statu esleme, Surat/SSP, etiket ve retention KAPSAM DISI.

// Satir sonu (CRLF/LF) checkout ayarina gore degisebilir; sozlesme
// assertion'lari bundan ETKILENMEMELI.
const SOURCE = readFileSync('server/index.mjs', 'utf8').split('\r\n').join('\n')

/** Ucus kayit defterini index.mjs'ten IZOLE calistirir (boot YOK). */
function loadFlight() {
  const lines = SOURCE.split(/\r?\n/)
  const names = [
    'const syncFlights',
    'const SYNC_FLIGHT_WAIT_MS',
    'const SYNC_FLIGHT_POLL_MS',
    'function syncFlightKey',
    'function beginSyncFlight',
    'function endSyncFlight',
    'async function waitForSyncFlight',
  ]
  const blocks = names.map((needle) => {
    const start = lines.findIndex((line) => line.startsWith(needle))
    assert.ok(start >= 0, `bulunamadi: ${needle}`)
    if (needle.startsWith('const')) return lines[start]
    const end = lines.findIndex((line, index) => index > start && line === '}')
    return lines.slice(start, end + 1).join('\n')
  })
  return new Function(
    `${blocks.join('\n\n')}\nreturn { syncFlightKey, beginSyncFlight, endSyncFlight, waitForSyncFlight, syncFlights }`,
  )()
}

const flight = loadFlight()
const ORG = '11111111-1111-1111-1111-111111111111'
const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

// ═══ TEK UCUS ═════════════════════════════════════════════════════════════

test('SYNC-SINGLEFLIGHT-1: ayni hesapta ikinci ucus BASLAMAZ', () => {
  const key = flight.syncFlightKey(ORG, ACCOUNT_A)
  assert.equal(flight.beginSyncFlight(key), true, 'ilk ucus baslar')
  assert.equal(flight.beginSyncFlight(key), false, 'ikinci ucus REDDEDILIR')
  flight.endSyncFlight(key)
  assert.equal(flight.beginSyncFlight(key), true, 'serbest kalinca yeniden alinir')
  flight.endSyncFlight(key)
})

test('SYNC-SINGLEFLIGHT-2: manuel+manuel DB kilidiyle ZATEN engelli', () => {
  // Mevcut sozlesme korunur: kilit hesap kapsamli ve 409 doner.
  assert.ok(SOURCE.includes("code: 'sync_in_progress'"))
  assert.ok(SOURCE.includes('acquireOrgSyncLock(\n    context.db'))
  // Kilit hesap kapsamli cagrilir (global DEGIL).
  assert.ok(SOURCE.includes("'orders',\n    syncAccountId,\n  )"))
})

test('SYNC-SINGLEFLIGHT-3: manuel calisirken arka plan turu ATLAR', async () => {
  const key = flight.syncFlightKey(ORG, ACCOUNT_A)
  assert.equal(flight.beginSyncFlight(key), true) // manuel ucusta
  // Arka plan turu BEKLEMEZ: begin basarisizsa tur sessizce atlanir.
  assert.equal(flight.beginSyncFlight(key), false)
  const lines = SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function syncTrendyolOrdersForOrganization'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('if (!beginSyncFlight(flightKey)) return { synced: false }'))
  assert.equal(body.includes('waitForSyncFlight'), false, 'arka plan BEKLEMEZ')
  flight.endSyncFlight(key)
})

test('SYNC-SINGLEFLIGHT-4: arka plan calisirken manuel istek KAYBOLMAZ', async () => {
  const key = flight.syncFlightKey(ORG, ACCOUNT_A)
  assert.equal(flight.beginSyncFlight(key), true) // arka plan ucusta
  // Manuel istek BEKLER; arka plan bitince ucusu devralir.
  const waiting = flight.waitForSyncFlight(key, 3000)
  setTimeout(() => flight.endSyncFlight(key), 120)
  assert.equal(await waiting, true, 'manuel istek sirasini alir')
  flight.endSyncFlight(key)

  // Manuel yol gercekten BEKLEYEN cagriyi kullanir ve sure dolarsa MEVCUT
  // 409 sozlesmesine doner.
  assert.ok(SOURCE.includes('const flying = await waitForSyncFlight(flightKey)'))
  assert.ok(SOURCE.includes("code: 'sync_in_progress'"))
})

test('SYNC-SINGLEFLIGHT-4b: bekleme SINIRLIDIR', async () => {
  const key = flight.syncFlightKey(ORG, ACCOUNT_B)
  assert.equal(flight.beginSyncFlight(key), true)
  const startedAt = Date.now()
  assert.equal(await flight.waitForSyncFlight(key, 120), false, 'sure dolar')
  assert.ok(Date.now() - startedAt < 3000, 'sinirsiz beklemez')
  flight.endSyncFlight(key)
  assert.ok(SOURCE.includes('const SYNC_FLIGHT_WAIT_MS = 8000'))
})

test('SYNC-SINGLEFLIGHT-5: FARKLI hesaplar birbirini BLOKLAMAZ', async () => {
  const keyA = flight.syncFlightKey(ORG, ACCOUNT_A)
  const keyB = flight.syncFlightKey(ORG, ACCOUNT_B)
  const keyLegacy = flight.syncFlightKey(ORG, null)
  assert.notEqual(keyA, keyB)
  assert.notEqual(keyA, keyLegacy)
  assert.equal(flight.beginSyncFlight(keyA), true)
  assert.equal(flight.beginSyncFlight(keyB), true, 'B hesabi engellenmez')
  assert.equal(flight.beginSyncFlight(keyLegacy), true, 'legacy kapsam ayri')
  flight.endSyncFlight(keyA)
  flight.endSyncFlight(keyB)
  flight.endSyncFlight(keyLegacy)
  // GLOBAL kilit YOK.
  assert.equal(SOURCE.includes('globalSyncLock'), false)
})

test('SYNC-SINGLEFLIGHT-6: hata sonrasi ucus SERBEST kalir', () => {
  // Her iki yol da `finally` icinde endSyncFlight cagirir.
  const manualFinally = SOURCE.includes(
    '    // SÜREÇ İÇİ UÇUŞ HER DURUMDA düşer (hata/erken dönüş dâhil); aksi hâlde',
  )
  assert.ok(manualFinally, 'manuel yolda finally temizligi')
  assert.equal(
    SOURCE.split('endSyncFlight(flightKey)').length - 1,
    2,
    'manuel + arka plan: iki temizlik noktasi',
  )
  const lines = SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function syncTrendyolOrdersForOrganization'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('} finally {'), 'arka plan yolunda finally')
})

test('SYNC-SINGLEFLIGHT-7: retry ve PARTIAL veri guvencesi KORUNUR', () => {
  // Retry katmanina DOKUNULMADI.
  assert.ok(SOURCE.includes('async function retryTrendyolStatusPass'))
  assert.ok(SOURCE.includes('const TRENDYOL_STATUS_RETRY_DELAYS_MS = [1000, 3000, 7000]'))
  assert.ok(SOURCE.includes('const TRENDYOL_STATUS_RETRY_BUDGET_MS = 10_000'))
  assert.ok(SOURCE.includes("syncStatus: 'PARTIAL'"))
  assert.ok(SOURCE.includes('Mevcut tam liste korunur.'))
  // Reconcile YALNIZ COMPLETE sync'te.
  assert.ok(
    SOURCE.includes("const complete = Boolean(result.ok) && syncStatus === 'COMPLETE'"),
  )
  // Arka plan turu hala reconcile ETMEZ ve hesap kapsamini gecirir.
  assert.ok(SOURCE.includes('complete: false'))
  assert.ok(SOURCE.includes('resolveActiveMarketplaceAccountId('))
})

test('SYNC-SINGLEFLIGHT-UI: buton bekleme durumunda kilitli', () => {
  const ordersPage = readFileSync('src/pages/OrdersPage.tsx', 'utf8')
  assert.ok(ordersPage.includes('disabled={busy}'))
  assert.ok(ordersPage.includes("{busy ? 'Yenileniyor...' : 'Şimdi Yenile'}"))
  // Dashboard butonu da zaten kilitli.
  const dashboard = readFileSync('src/pages/DashboardPage.tsx', 'utf8')
  assert.ok(dashboard.includes('disabled={loading || !hasConfiguredMarketplace}'))
  assert.ok(dashboard.includes("{loading ? 'Yenileniyor' : 'Yenile'}"))
})
