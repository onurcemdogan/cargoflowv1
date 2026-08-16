import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createServer } from 'vite'

// B3 — FRONTEND SENKRON DURUM İZLEYİCİSİ.
//
// Kritik: tek aktif döngü, sınırlı (artan) aralık, terminalde durma ve
// temizlenme. Sağlayıcıya çıkmaz; yalnız yerel durum ucu okunur.

const nl = (v) => v.split('\r\n').join('\n')

async function loadWatcher(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  return vite.ssrLoadModule('/src/services/syncStatusWatcher.ts')
}

/** Sahte zamanlayıcı — gerçek beklemeden sırayı ilerletir. */
function fakeClock() {
  const queue = []
  let nextId = 1
  return {
    schedule(callback, delayMs) {
      const id = nextId
      nextId += 1
      queue.push({ id, callback, delayMs })
      return id
    },
    cancel(handle) {
      const index = queue.findIndex((entry) => entry.id === handle)
      if (index >= 0) queue.splice(index, 1)
    },
    delays: () => queue.map((entry) => entry.delayMs),
    pending: () => queue.length,
    async runNext() {
      const entry = queue.shift()
      if (!entry) return false
      entry.callback()
      // Zamanlayıcı geri çağrısı asenkron; mikro görevleri boşalt.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      return true
    },
  }
}

const snapshot = (state, extra = {}) => ({
  running: state === 'RUNNING',
  state,
  syncRunId: 'sync_1',
  errorCategory: null,
  lastSuccessfulAt: null,
  summary: null,
  ...extra,
})

/* ═══ ARALIK SÖZLEŞMESİ ════════════════════════════════════════════════ */

test('WATCH-1: aralik ARTAR ve TAVANDA kalir (sabit agresif yoklama YOK)', async (t) => {
  const { pollDelayMs, POLL_INTERVALS_MS } = await loadWatcher(t)
  assert.deepEqual([...POLL_INTERVALS_MS], [1000, 2000, 3000, 5000])
  assert.equal(pollDelayMs(0), 1000)
  assert.equal(pollDelayMs(1), 2000)
  assert.equal(pollDelayMs(2), 3000)
  assert.equal(pollDelayMs(3), 5000)
  // Tavan: sonsuza kadar büyümez, 500ms'e de düşmez.
  assert.equal(pollDelayMs(10), 5000)
  assert.equal(pollDelayMs(999), 5000)
})

test('WATCH-2: terminal durum tanimi — bilinmeyen deger terminal DEGIL', async (t) => {
  const { isTerminalSyncState } = await loadWatcher(t)
  assert.equal(isTerminalSyncState('SUCCEEDED'), 'SUCCEEDED')
  assert.equal(isTerminalSyncState('failed'), 'FAILED')
  assert.equal(isTerminalSyncState('RUNNING'), null)
  assert.equal(isTerminalSyncState('QUEUED'), null)
  assert.equal(isTerminalSyncState(''), null)
  assert.equal(isTerminalSyncState(undefined), null)
})

/* ═══ TERMİNALDE DURMA ═════════════════════════════════════════════════ */

test('WATCH-3: SUCCEEDED sonrasi yoklama = 0', async (t) => {
  const { createSyncStatusWatcher } = await loadWatcher(t)
  const clock = fakeClock()
  const states = ['RUNNING', 'RUNNING', 'SUCCEEDED']
  let index = 0
  const terminals = []
  const watcher = createSyncStatusWatcher({
    fetchStatus: async () => snapshot(states[Math.min(index++, states.length - 1)]),
    onTerminal: (state) => terminals.push(state),
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  watcher.start()
  await clock.runNext()
  await clock.runNext()
  await clock.runNext()

  assert.deepEqual(terminals, ['SUCCEEDED'])
  assert.equal(watcher.isActive(), false)
  assert.equal(clock.pending(), 0, 'terminal sonrasi bekleyen yoklama YOK')
  // Ek çalıştırma denemesi yeni yoklama üretmez.
  assert.equal(await clock.runNext(), false)
})

test('WATCH-4: FAILED de terminaldir; izleme DURUR', async (t) => {
  const { createSyncStatusWatcher } = await loadWatcher(t)
  const clock = fakeClock()
  const terminals = []
  const watcher = createSyncStatusWatcher({
    fetchStatus: async () => snapshot('FAILED', { errorCategory: 'TRANSIENT' }),
    onTerminal: (state, snap) => terminals.push([state, snap?.errorCategory]),
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  watcher.start()
  await clock.runNext()
  assert.deepEqual(terminals, [['FAILED', 'TRANSIENT']])
  assert.equal(clock.pending(), 0)
})

/* ═══ TEK İZLEYİCİ (20 TIKLAMA) ════════════════════════════════════════ */

test('WATCH-5: 20 baslatma 20 DONGU uretmez', async (t) => {
  const { createSyncStatusWatcher } = await loadWatcher(t)
  const clock = fakeClock()
  let fetches = 0
  const watcher = createSyncStatusWatcher({
    fetchStatus: async () => {
      fetches += 1
      return snapshot('RUNNING')
    },
    onTerminal: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  for (let i = 0; i < 20; i += 1) watcher.start()
  assert.equal(clock.pending(), 1, 'TEK bekleyen zamanlayici')
  await clock.runNext()
  assert.equal(fetches, 1, 'tek yoklama')
  assert.equal(clock.pending(), 1, 'sirada yine TEK zamanlayici')
})

/* ═══ TEMİZLENME ═══════════════════════════════════════════════════════ */

test('WATCH-6: stop() bekleyen zamanlayiciyi TEMIZLER (sizinti YOK)', async (t) => {
  const { createSyncStatusWatcher } = await loadWatcher(t)
  const clock = fakeClock()
  let fetches = 0
  const watcher = createSyncStatusWatcher({
    fetchStatus: async () => {
      fetches += 1
      return snapshot('RUNNING')
    },
    onTerminal: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  watcher.start()
  assert.equal(clock.pending(), 1)

  watcher.stop()
  assert.equal(clock.pending(), 0, 'zamanlayici IPTAL edilmeli')
  assert.equal(watcher.isActive(), false)
  assert.equal(fetches, 0)
})

test('WATCH-7: stop() sonrasi ucan yoklama geri cagri URETMEZ', async (t) => {
  const { createSyncStatusWatcher } = await loadWatcher(t)
  const clock = fakeClock()
  const terminals = []
  const watcher = createSyncStatusWatcher({
    fetchStatus: async () => {
      // Yanıt dönerken bileşen unmount oluyor.
      watcher.stop()
      return snapshot('SUCCEEDED')
    },
    onTerminal: (state) => terminals.push(state),
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  watcher.start()
  await clock.runNext()
  assert.deepEqual(terminals, [], 'unmount sonrasi geri cagri YOK')
  assert.equal(clock.pending(), 0)
})

/* ═══ DAYANIKLILIK ═════════════════════════════════════════════════════ */

test('WATCH-8: gecici durum hatasi izlemeyi DUSURMEZ', async (t) => {
  const { createSyncStatusWatcher } = await loadWatcher(t)
  const clock = fakeClock()
  let call = 0
  const terminals = []
  const watcher = createSyncStatusWatcher({
    fetchStatus: async () => {
      call += 1
      if (call === 1) throw new Error('gecici ag hatasi')
      return snapshot('SUCCEEDED')
    },
    onTerminal: (state) => terminals.push(state),
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  watcher.start()
  await clock.runNext()
  assert.deepEqual(terminals, [], 'hata terminal DEGIL')
  assert.equal(clock.pending(), 1, 'izleme SURER')
  await clock.runNext()
  assert.deepEqual(terminals, ['SUCCEEDED'])
})

test('WATCH-9: EMNIYET — sonsuz yoklama YOK', async (t) => {
  const { createSyncStatusWatcher } = await loadWatcher(t)
  const clock = fakeClock()
  const terminals = []
  const watcher = createSyncStatusWatcher({
    fetchStatus: async () => snapshot('RUNNING'),
    onTerminal: (state) => terminals.push(state),
    schedule: clock.schedule,
    cancel: clock.cancel,
    maxPolls: 3,
  })
  watcher.start()
  for (let i = 0; i < 5; i += 1) await clock.runNext()
  assert.deepEqual(terminals, ['FAILED'], 'tavanda durmali')
  assert.equal(watcher.pollCount(), 3)
  assert.equal(clock.pending(), 0)
})

/* ═══ YAPISAL ══════════════════════════════════════════════════════════ */

test('WATCH-10: izleyici SAGLAYICIYA cikmaz, websocket ACMAZ', () => {
  const raw = nl(readFileSync('src/services/syncStatusWatcher.ts', 'utf8'))
  const code = raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join(' ')
  for (const forbidden of [
    'WebSocket', 'EventSource', 'trendyol', 'https://', 'credential', 'apiKey',
  ]) {
    assert.equal(code.toLowerCase().includes(forbidden.toLowerCase()), false,
      `${forbidden} OLMAMALI`)
  }
  // Yoklama aralığı sabit 500ms değil.
  assert.equal(code.includes('500)'), false)
})
