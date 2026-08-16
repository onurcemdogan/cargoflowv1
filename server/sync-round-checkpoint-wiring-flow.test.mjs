import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// B3 — GERÇEK SENKRON TURUNUN DEFTERE BAĞLANMASI.
//
// Checkpoint servisi zaten testliydi; bu paket onun ÜRETİM turunda gerçekten
// kullanıldığını ve watermark'ın YALNIZ doğru noktada ilerlediğini kilitler.

const nl = (v) => v.split('\r\n').join('\n')
const SERVER = nl(readFileSync('server/index.mjs', 'utf8'))

/** `executeOrdersSyncRound` gövdesi. */
function roundBody() {
  const start = SERVER.indexOf('async function executeOrdersSyncRound(')
  assert.ok(start > 0, 'tur fonksiyonu bulunamadi')
  const rest = SERVER.slice(start)
  const end = rest.indexOf("\napp.post('/api/orders/sync', executeOrdersSyncRound)")
  assert.ok(end > 0, 'tur sonu bulunamadi')
  return rest.slice(0, end)
}

const BODY = roundBody()

test('WIRE-1: tur DENEME damgasini yazar', () => {
  assert.ok(BODY.includes('checkpointApi'), 'checkpoint modulu kullanilmali')
  assert.ok(BODY.includes('recordSyncAttempt('), 'deneme kaydedilmeli')
  // Deneme damgası sağlayıcı çağrısından ÖNCE.
  assert.ok(
    BODY.indexOf('recordSyncAttempt(') < BODY.indexOf('callTrendyolOrdersByStatuses('),
  )
})

test('WIRE-2: watermark YALNIZ tam basarida ilerler (partial DEGIL)', () => {
  const commitAt = BODY.indexOf('commitSyncWatermark(')
  assert.ok(commitAt > 0, 'watermark commit edilmeli')
  // Commit `if (!partial)` korumasi ICINDE olmali.
  const guardAt = BODY.lastIndexOf('if (!partial) {', commitAt)
  assert.ok(guardAt > 0, 'commit `!partial` korumasi icinde olmali')
  // Ve kalicilastirma SONRASI (persistResult uretildikten sonra).
  assert.ok(BODY.indexOf('persistSyncResult(') < commitAt, 'persist SONRASI olmali')
})

test('WIRE-3: pencere sonu `now` DEGIL, cekim baslangicidir', () => {
  assert.ok(BODY.includes('const roundStartedAt = new Date()'))
  assert.ok(
    BODY.includes('roundStartedAt,') || BODY.includes('roundStartedAt)'),
    'watermark cekim baslangicindan yazilmali',
  )
  // Tur sürerken gelen siparişleri atlamamak için `new Date()` ile commit YOK.
  assert.equal(BODY.includes('commitSyncWatermark(\n            context.db,\n            context.organizationId,\n            syncAccountId,\n            new Date()'), false)
})

test('WIRE-4: KALICILASTIRMA hatasinda watermark ILERLEMEZ', () => {
  const failureAt = BODY.indexOf("recordSyncFailure(")
  assert.ok(failureAt > 0, 'persistence hatasi kaydedilmeli')
  assert.ok(BODY.includes("'PERSISTENCE',"), 'hata sinifi kaydedilmeli')
  // Hata dalında commit YOK.
  const failureBlock = BODY.slice(failureAt, failureAt + 600)
  assert.equal(failureBlock.includes('commitSyncWatermark('), false)
})

test('WIRE-5: ARTIMLI pencere watermarktan turer', () => {
  assert.ok(BODY.includes('buildIncrementalWindow('))
  assert.ok(BODY.includes('startDate: incrementalWindow.startTime.getTime()'))
  assert.ok(BODY.includes('endDate: roundStartedAt.getTime()'))
})

test('WIRE-6: ILK TURDA mevcut varsayilan KORUNUR (sinirsiz gecmis YOK)', () => {
  // Watermark yoksa istemci varsayılanı (son 7 gün) devrede kalır.
  assert.ok(BODY.includes('incrementalWindow.initial'))
  assert.ok(BODY.includes('? requestedQuery'), 'ilk turda istek sorgusu AYNEN')
  // Sabit "1970" / sınırsız aralık uydurulmamış.
  assert.equal(BODY.includes('1970'), false)
  assert.equal(BODY.includes('new Date(0)'), false)
})

test('WIRE-7: ACIK tarih veren cagirana SAYGI duyulur', () => {
  assert.ok(BODY.includes('const explicitWindow ='))
  assert.ok(BODY.includes('requestedQuery.startDate !== undefined'))
  assert.ok(BODY.includes('requestedQuery.endDate !== undefined'))
})

test('WIRE-8: defter yazimlari turu DUSURMEZ (best-effort)', () => {
  // Defter yazımı sağlayıcı sonucunu geçersiz kılmamalı; ama hata SESSİZ
  // kalmamalı diye ayrı `recordSyncFailure` yolu var.
  const catches = BODY.split('.catch(() => undefined)').length - 1
  assert.ok(catches >= 3, `defter cagrilari korumali olmali (${catches})`)
})

test('WIRE-9: ikinci senkron implementasyonu ACILMADI', () => {
  // Tek tur gövdesi; kabul eden uç da AYNI gövdeyi çağırır.
  assert.equal(
    SERVER.split('async function executeOrdersSyncRound(').length - 1, 1,
  )
  assert.ok(SERVER.includes('executeOrdersSyncRound(snapshot, collector)'))
})
