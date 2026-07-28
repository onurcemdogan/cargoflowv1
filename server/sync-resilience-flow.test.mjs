import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Dayanıklı sync sözleşmesi (kaynak-seviyesi doğrulama).
// 502 kök nedeni: Trendyol GET retry YALNIZ 429'da yapılıyordu; geçici 5xx/ağ
// hatası tek denemede başarısız olup app 502 dönüyordu. Düzeltme: güvenli GET
// retry artık geçici 5xx ve ağ hatalarını da (bounded + backoff + jitter) tekrar
// dener; kalıcı 4xx tekrar denenmez. Ayrıca tek-uçuş kilidi + kontrollü 409/502
// frontend davranışı korunur.

const here = dirname(fileURLToPath(import.meta.url))
function readSrc(rel) {
  return readFileSync(join(here, '..', rel), 'utf8')
}
function sliceBlock(src, anchor, length = 900) {
  const index = src.indexOf(anchor)
  assert.ok(index >= 0, `anchor bulunamadı: ${anchor}`)
  return src.slice(index, index + length)
}

test('RES-1: Trendyol sipariş GET retry geçici 5xx ve ağ hatalarını da tekrar dener (429 dışı)', () => {
  const block = sliceBlock(
    readSrc('server/index.mjs'),
    'async function callTrendyolOrders(credentials, query)',
    3200,
  )
  assert.match(block, /code >= 500 && code <= 599/, '5xx retry edilir')
  assert.match(block, /isNetworkError/, 'ağ hatası retry edilir')
  assert.match(block, /const isTransient/, 'transient sınıflandırması var')
  // Kalıcı 4xx tekrar denenmez: retry yalnız isTransient iken sürer.
  assert.match(block, /!isTransient/, '4xx (kalıcı) retry edilmez')
  // Retry üst sınırı korunur (sonsuz döngü yok).
  assert.match(block, /attempt === retryDelaysMs\.length/)
})

test('RES-2: retry backoff + jitter uygular; 429 için Retry-After korunur', () => {
  const block = sliceBlock(
    readSrc('server/index.mjs'),
    'async function callTrendyolOrders(credentials, query)',
    3200,
  )
  assert.match(block, /jitter/i)
  assert.match(block, /retryAfterMs/)
})

test('RES-3: reconciliation güçlü kanıtı korur (silmez); kaynak sözleşmesi', () => {
  const repo = readSrc('server/orders/orderRepository.ts')
  assert.match(repo, /STRONG_OPERATION_STATUSES/)
  assert.match(repo, /TERMINAL_MARKETPLACE_STATUSES/)
  assert.match(repo, /withShipment/)
  // Yaş/727/packageId TEK BAŞINA arşiv sebebi olmamalı: archive yalnız güçlü
  // kanıt yoksa yapılır.
  assert.match(repo, /if \(hasStrongEvidence\) continue/)
  // KAPSAM: reconcile yalnız sync tarih penceresine giren kayıtları değerlendirir.
  assert.match(repo, /inSyncWindow/)
  assert.match(repo, /if \(!inSyncWindow\(row\)\) continue/)
  // Pencere endpoint'ten persistSyncResult'a threadlenir.
  const server = readSrc('server/index.mjs')
  assert.match(server, /reconcileWindow/)
  assert.match(server, /window: reconcileWindow/)
})

test('RES-4: complete=false (kısmi/başarısız) reconcile ÇALIŞMAZ; endpoint sözleşmesi', () => {
  const server = readSrc('server/index.mjs')
  // persistSyncResult yalnız complete=true'da archiveMissingOrders çağırır.
  const persist = readSrc('server/orders/orderPersistenceService.ts')
  assert.match(persist, /if \(options\.complete\)/)
  assert.match(persist, /archiveMissingOrders/)
  // Endpoint: complete YALNIZ debug.syncStatus === 'COMPLETE' iken true → kısmi
  // (PARTIAL) veya başarısız sync reconcile ÇALIŞTIRMAZ.
  assert.match(server, /complete = Boolean\(result\.ok\) && syncStatus === 'COMPLETE'/)
  // TOTAL_FAILURE (PARTIAL değil) → 502, mevcut siparişlere DOKUNULMAZ.
  assert.match(server, /if \(!result\.ok && !partial\)/)
  assert.match(server, /response\.status\(502\)/)
})

test('RES-5: frontend — 409 sync_in_progress hata değil (info); mevcut liste korunur', () => {
  const svc = readSrc('src/services/orderWorkflowService.ts')
  assert.match(svc, /sync_in_progress/)
  assert.match(svc, /syncInProgress/)
  // Süren sync bilgi mesajıyla döner (error banner değil).
  const block = sliceBlock(svc, 'if (syncInProgress) {', 500)
  assert.match(block, /level: 'info'/)
})

test('RES-6: frontend — tek-uçuş kilidi + buton finally ile açılır', () => {
  const app = readSrc('src/App.tsx')
  // İkinci tıklama yeni sync başlatmaz (single-flight guard).
  assert.match(app, /if \(ordersSyncInFlight\.current\) return/)
  // Her yolda finally'de kilit + loading serbest bırakılır.
  const block = sliceBlock(app, 'async function handleFetchOrders(', 3500)
  assert.match(block, /finally \{[\s\S]*ordersSyncInFlight\.current = false/)
})

test('RES-7: Dashboard Yenile /api/orders/sync ÇAĞIRMAZ (yalnız yerel reload)', () => {
  const app = readSrc('src/App.tsx')
  const block = sliceBlock(app, 'async function handleReloadOrders()', 2000)
  assert.doesNotMatch(block, /\/api\/orders\/sync/)
  assert.match(block, /loadOrdersFromServer\(\)/)
})
