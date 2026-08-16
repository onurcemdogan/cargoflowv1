import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// B3 — MANUEL YENİLEME SAĞLAYICIYI BEKLEMEZ + GEZİNME SAĞLAYICIYA ÇIKMAZ.
//
// Bu paket sözleşmeyi KAYNAKTA kilitler: uç noktalar, çağrı yönü ve
// gezinme/dashboard okuma yollarının sağlayıcıdan bağımsızlığı.

const nl = (v) => v.split('\r\n').join('\n')
const SERVER = nl(readFileSync('server/index.mjs', 'utf8'))
const WORKFLOW = nl(readFileSync('src/services/orderWorkflowService.ts', 'utf8'))

/** Bir fonksiyon/uç gövdesi: bildiriminden sonraki üst düzey bildirime kadar. */
function block(source, startMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start > 0, `bulunamadi: ${startMarker}`)
  const rest = source.slice(start + startMarker.length)
  const next = rest.search(/^(?:app\.(?:get|post|put|delete)\(|async function |function )/m)
  return next === -1 ? rest : rest.slice(0, next)
}

/* ═══ TEK IMPLEMENTASYON ═══════════════════════════════════════════════ */

test('NB-1: senkron turu TEK gövdede — ikinci Trendyol yolu YOK', () => {
  // Eski bloklayan uç ve yeni kabul eden uç AYNI fonksiyonu kullanır.
  assert.ok(SERVER.includes('async function executeOrdersSyncRound('))
  assert.ok(SERVER.includes("app.post('/api/orders/sync', executeOrdersSyncRound)"))
  const accept = block(SERVER, "app.post('/api/orders/sync/request'")
  assert.ok(
    accept.includes('executeOrdersSyncRound(snapshot, collector)'),
    'kabul eden uc AYNI turu calistirmali',
  )
  // İkinci bir sağlayıcı çağrısı kurmaz.
  assert.equal(accept.includes('callTrendyolOrdersByStatuses'), false)
  assert.equal(accept.includes('normalizeTrendyolOrders'), false)
  assert.equal(accept.includes('persistSyncResult'), false)
})

/* ═══ BLOKLAMAMA SÖZLEŞMESİ ════════════════════════════════════════════ */

test('NB-2: kabul eden uc turu AWAIT ETMEZ', () => {
  const accept = block(SERVER, "app.post('/api/orders/sync/request'")
  // Tur `run` geri çağrısının İÇİNDE çalışır; uç yalnız kabulü döner.
  assert.ok(accept.includes('requestMarketplaceSync({'))
  assert.ok(accept.includes('response.status(202)'), '202 KABUL donmeli')
  // `await executeOrdersSyncRound` uç gövdesinde DOĞRUDAN çağrılmaz.
  const outsideRun = accept.slice(0, accept.indexOf('run: async () => {'))
  assert.equal(
    outsideRun.includes('executeOrdersSyncRound'), false,
    'tur, istek yolunda beklenmemeli',
  )
  // Yanıt, `run` bloğundan SONRA gelir (kabul → yanıt).
  assert.ok(
    accept.indexOf('response.status(202)') > accept.indexOf('requestMarketplaceSync({'),
  )
})

test('NB-3: kabul yanitinda tur kimligi ve durumu var', () => {
  const accept = block(SERVER, "app.post('/api/orders/sync/request'")
  for (const field of ['accepted:', 'state:', 'syncRunId:', 'reason:']) {
    assert.ok(accept.includes(field), `${field} donmeli`)
  }
})

test('NB-4: durum ucu SALT OKUNUR ve saglayiciya CIKMAZ', () => {
  const status = block(SERVER, "app.get('/api/orders/sync/status'")
  for (const forbidden of [
    'callTrendyolOrdersByStatuses', 'persistSyncResult', 'upsertMarketplaceOrders',
    '.insert(', '.update(', '.delete(', 'fetch(',
  ]) {
    assert.equal(status.includes(forbidden), false, `${forbidden} OLMAMALI`)
  }
  // Sır/kimlik bilgisi dönmez.
  for (const forbidden of ['credential', 'apiKey', 'password', 'sifre']) {
    assert.equal(status.toLowerCase().includes(forbidden.toLowerCase()), false)
  }
  assert.ok(status.includes('lastSuccessfulAt'))
})

/* ═══ FRONTEND KESİMİ — HENÜZ YAPILMADI (BİLİNÇLİ) ════════════════════ */

test('NB-5: kabul eden uc HAZIR; frontend kesimi POLLING UI ile yapilacak', () => {
  // Sunucu tarafı hazır ve test edilmiş durumda.
  assert.ok(SERVER.includes("app.post('/api/orders/sync/request'"))
  assert.ok(SERVER.includes("app.get('/api/orders/sync/status'"))

  // FRONTEND HÂLÂ BLOKLAYAN UCU KULLANIYOR — BİLİNÇLİ.
  //
  // BULGU: frontend'i kabul eden uca çevirdiğimde, kullanıcı 207 KISMİ senkron
  // ve başarısızlık geri bildirimini ANINDA GÖREMEZ oldu (o bilgi artık arka
  // plan turunda oluşuyor). Bu bir UX GERİLEMESİDİR. Kesim ancak durum
  // yoklaması (`/api/orders/sync/status`) UI'ye bağlandığında ve kısmi/hata
  // durumu yüzeye çıktığında yapılmalıdır.
  assert.ok(
    WORKFLOW.includes("fetch('/api/orders/sync'"),
    'kesim tamamlanana kadar bloklayan uc korunur',
  )
  // Kısmi/başarısız senkron geri bildirimi HÂLÂ kullanıcıya ulaşıyor.
  assert.ok(WORKFLOW.includes('successfulStatuses'))
  assert.ok(WORKFLOW.includes('failedStatuses'))
  assert.ok(WORKFLOW.includes('sync_in_progress'))
})

test('NB-6: senkron sonucu ne olursa olsun YEREL liste okunur', () => {
  const start = WORKFLOW.indexOf("fetch('/api/orders/sync'")
  const body = WORKFLOW.slice(start, start + 3000)
  // Sağlayıcı DTO'su doğrudan UI'ye basılmaz; sunucudaki kalıcı liste okunur.
  assert.ok(body.includes('this.loadOrdersFromServer()'))
})

/* ═══ GEZİNME + DASHBOARD: SAĞLAYICI ÇAĞRISI 0 ═════════════════════════ */

const PROVIDER_CALLS = [
  'callTrendyolOrdersByStatuses',
  'fetchTrendyolOrders',
  'callSuratWebApi',
  'createCanonicalSuratShipment',
]

const READ_ONLY_ENDPOINTS = [
  "app.get('/api/orders'",
  "app.get('/api/orders/sync/status'",
]

for (const marker of READ_ONLY_ENDPOINTS) {
  test(`NAV [${marker}]: saglayici cagrisi = 0`, () => {
    const body = block(SERVER, marker)
    for (const call of PROVIDER_CALLS) {
      assert.equal(body.includes(call), false, `${call} OLMAMALI`)
    }
    // Doğrudan HTTP de yok.
    assert.equal(/\bfetch\(/.test(body), false, 'dogrudan fetch OLMAMALI')
  })
}

test('NAV-1: sayfa gezinmesi senkron TETIKLEMEZ (frontend)', () => {
  const app = nl(readFileSync('src/App.tsx', 'utf8'))
  // Mevcut sözleşme: sync YALNIZ açık kullanıcı eylemiyle.
  assert.ok(
    app.includes('sync YALNIZ açık "Şimdi Yenile / Senkronize Et" butonuyla'),
    'gezinme-sync ayrimi sozlesmesi korunmali',
  )
})

test('NAV-2: dashboard sayaclari YEREL kaynaktan (saglayici yok)', () => {
  // Dashboard operasyon izdüşümü sunucu tarafı toplamlarını kullanır.
  const marker = "app.get('/api/orders'"
  const body = block(SERVER, marker)
  assert.equal(body.includes('callTrendyolOrdersByStatuses'), false)
  // Kanonik okuma yolu: yerel liste motoru.
  assert.ok(
    body.includes('listOrdersForRequest') || body.includes('orderFilterProjection'),
    'yerel okuma motoru kullanilmali',
  )
})
