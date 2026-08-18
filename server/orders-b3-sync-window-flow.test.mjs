import assert from 'node:assert/strict'
import test from 'node:test'

// P2/B3 — ARTIMLI PENCERE POLİTİKASI (B seçeneği).
// İmleç + emniyet payı + periyodik geniş tarama. Ağ/DB YOK: saf karar.

const P = await import('./orders/syncWindowPolicy.ts')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-08-18T12:00:00Z')

/* ═══ BOOTSTRAP ══════════════════════════════════════════════════════ */

test('SW-1: imlec YOKSA guvenli 7 gunluk pencere', () => {
  const w = P.resolveSyncWindow({ checkpointMs: null, nowMs: NOW })
  assert.equal(w.mode, 'BOOTSTRAP')
  assert.equal(w.endMs, NOW)
  assert.equal(NOW - w.startMs, 7 * DAY)
})

/* ═══ PENCERE GERÇEKTEN DARALIR ══════════════════════════════════════ */

test('SW-2: sonraki sync penceresi GERCEKTEN daralir', () => {
  const bootstrap = P.resolveSyncWindow({ checkpointMs: null, nowMs: NOW })
  const checkpointMs = bootstrap.candidateCheckpointMs
  const next = P.resolveSyncWindow({
    checkpointMs, nowMs: NOW + HOUR, lastReconciliationAtMs: NOW,
  })
  assert.equal(next.mode, 'INCREMENTAL')
  const bootstrapSpan = bootstrap.endMs - bootstrap.startMs
  const nextSpan = next.endMs - next.startMs
  assert.ok(nextSpan < bootstrapSpan, `daralmadi: ${nextSpan} >= ${bootstrapSpan}`)
})

test('SW-3: emniyet payi UYGULANIR (varsayilan 24 saat)', () => {
  assert.equal(P.DEFAULT_SAFETY_MARGIN_MS, DAY)
  const w = P.resolveSyncWindow({
    checkpointMs: NOW, nowMs: NOW + HOUR, lastReconciliationAtMs: NOW,
  })
  // Baslangic imlecten TAM emniyet payi kadar GERIDE.
  assert.equal(w.startMs, NOW - DAY)
  assert.equal(w.safetyMarginMs, DAY)
})

test('SW-3b: emniyet payi YAPILANDIRILABILIR', () => {
  const w = P.resolveSyncWindow({
    checkpointMs: NOW, nowMs: NOW + HOUR,
    safetyMarginMs: 2 * HOUR, lastReconciliationAtMs: NOW,
  })
  assert.equal(w.startMs, NOW - 2 * HOUR)
})

/* ═══ WATERMARK, PROCESS SAATİ DEĞİL ═════════════════════════════════ */

test('SW-4: aday imlec pencere UST SINIRIDIR, bitis saati DEGIL', () => {
  const w = P.resolveSyncWindow({
    checkpointMs: NOW, nowMs: NOW + HOUR, lastReconciliationAtMs: NOW,
  })
  // Sorgu ust siniri = NOW+HOUR. Sync 10 dk surse bile imlec buraya sabitlenir;
  // bu sirada olusan kayitlar SONRAKI pencereye girer, ATLANMAZ.
  assert.equal(w.candidateCheckpointMs, w.endMs)
})

/* ═══ İMLEÇ YALNIZ TAM BAŞARIDA İLERLER ══════════════════════════════ */

test('SW-5: KISMI sync imleci ILERLETMEZ', () => {
  const r = P.advanceCheckpoint({
    currentCheckpointMs: NOW, candidateCheckpointMs: NOW + HOUR, complete: false,
  })
  assert.equal(r.advanced, false)
  assert.equal(r.checkpointMs, NOW)
  assert.equal(r.reason, 'INCOMPLETE_SYNC')
})

test('SW-6: kurtarilamayan HATA imleci ILERLETMEZ', () => {
  const r = P.advanceCheckpoint({
    currentCheckpointMs: NOW, candidateCheckpointMs: NOW + HOUR,
    complete: true, errorCode: 'PROVIDER_5XX',
  })
  assert.equal(r.advanced, false)
  assert.equal(r.reason, 'UNRECOVERED_ERROR')
})

test('SW-7: oran siniri tukenmesi imleci ILERLETMEZ', () => {
  const r = P.advanceCheckpoint({
    currentCheckpointMs: NOW, candidateCheckpointMs: NOW + HOUR,
    complete: true, rateLimited: true,
  })
  assert.equal(r.advanced, false)
  assert.equal(r.reason, 'RATE_LIMIT_EXHAUSTED')
})

test('SW-8: TAM basarili sync imleci ilerletir', () => {
  const r = P.advanceCheckpoint({
    currentCheckpointMs: NOW, candidateCheckpointMs: NOW + HOUR, complete: true,
  })
  assert.equal(r.advanced, true)
  assert.equal(r.checkpointMs, NOW + HOUR)
})

test('SW-9: imlec GERI GITMEZ', () => {
  const r = P.advanceCheckpoint({
    currentCheckpointMs: NOW, candidateCheckpointMs: NOW - HOUR, complete: true,
  })
  assert.equal(r.advanced, false)
  assert.equal(r.checkpointMs, NOW)
})

/* ═══ YENİDEN BAŞLATMA ═══════════════════════════════════════════════ */

test('SW-10: basarisiz kosudan sonra RESTART ayni imlecten devam eder', () => {
  const failed = P.advanceCheckpoint({
    currentCheckpointMs: NOW, candidateCheckpointMs: NOW + HOUR, complete: false,
  })
  // Yeniden baslatma AYNI imleci kullanir; atlanan aralik YOK.
  const resumed = P.resolveSyncWindow({
    checkpointMs: failed.checkpointMs, nowMs: NOW + 2 * HOUR,
    lastReconciliationAtMs: NOW,
  })
  assert.equal(resumed.startMs, NOW - DAY)
  assert.equal(resumed.mode, 'INCREMENTAL')
})

/* ═══ PERİYODİK KENDİNİ ONARMA ═══════════════════════════════════════ */

test('SW-11: periyodik genis tarama imlecten BAGIMSIZ calisir', () => {
  const w = P.resolveSyncWindow({
    checkpointMs: NOW, nowMs: NOW + 7 * HOUR,
    lastReconciliationAtMs: NOW,  // aralik doldu
  })
  assert.equal(w.mode, 'RECONCILIATION')
  // Guncel imlec cok yeni olsa BILE genis pencere taranir → kacan kayit yakalanir.
  assert.equal(w.endMs - w.startMs, 7 * DAY)
})

test('SW-12: aralik dolmadan genis tarama YAPILMAZ', () => {
  const w = P.resolveSyncWindow({
    checkpointMs: NOW, nowMs: NOW + HOUR, lastReconciliationAtMs: NOW,
  })
  assert.equal(w.mode, 'INCREMENTAL')
})

/* ═══ ÖRTÜŞME KASITLI ════════════════════════════════════════════════ */

test('SW-13: ardisik pencereler ORTUSUR (kayit dusmesin)', () => {
  const first = P.resolveSyncWindow({
    checkpointMs: NOW - DAY, nowMs: NOW, lastReconciliationAtMs: NOW,
  })
  const second = P.resolveSyncWindow({
    checkpointMs: first.candidateCheckpointMs, nowMs: NOW + HOUR,
    lastReconciliationAtMs: NOW,
  })
  // Ikinci pencere birincinin ustune BINER — bosluk YOK.
  assert.ok(second.startMs < first.endMs, 'pencereler arasinda BOSLUK var')
})
