// SENKRON DURUM İZLEYİCİSİ — SINIRLI YOKLAMA.
//
// "Şimdi Yenile" artık sağlayıcı turunu BEKLEMEZ; kabul yanıtı hemen döner.
// Turun bitişini bu izleyici gözler ve tamamlandığında çağıranı uyarır.
//
// SÖZLEŞMELER
//   TEK İZLEYİCİ   — aynı anda yalnız BİR aktif yoklama döngüsü. 20 tıklama
//                    20 döngü ÜRETMEZ.
//   SINIRLI        — aralık artar (1s → 2s → 3s → 5s) ve tavanda kalır;
//                    sabit agresif yoklama YOK.
//   TERMİNALDE DUR — SUCCEEDED/FAILED sonrası yoklama 0.
//   TEMİZLENİR     — `stop()` çağrıldığında bekleyen zamanlayıcı kalmaz
//                    (sayfa değişimi/unmount sızıntı yapmaz).
//
// SAĞLAYICIYA ÇIKMAZ: yalnız yerel `/api/orders/sync/status` okunur.

export const POLL_INTERVALS_MS = [1000, 2000, 3000, 5000] as const

export interface SyncStatusSnapshot {
  running: boolean
  state: string | null
  syncRunId: string | null
  errorCategory: string | null
  lastSuccessfulAt: string | null
  summary: {
    partial?: boolean
    successfulStatuses?: string[]
    failedStatuses?: string[]
    persistedCount?: number | null
    failedCount?: number | null
  } | null
}

export type SyncTerminalState = 'SUCCEEDED' | 'FAILED'

export interface SyncWatcherOptions {
  fetchStatus: () => Promise<SyncStatusSnapshot | null>
  onTerminal: (state: SyncTerminalState, snapshot: SyncStatusSnapshot | null) => void
  onUpdate?: (snapshot: SyncStatusSnapshot | null) => void
  /** Test edilebilirlik: zamanlayıcı enjekte edilebilir. */
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
  /** Sonsuz döngü emniyeti. */
  maxPolls?: number
}

export interface SyncWatcher {
  start: () => void
  stop: () => void
  isActive: () => boolean
  pollCount: () => number
}

/** Terminal durum mu — bilinmeyen değer terminal SAYILMAZ (yoklama sürer). */
export function isTerminalSyncState(state: unknown): SyncTerminalState | null {
  const token = String(state ?? '').trim().toUpperCase()
  if (token === 'SUCCEEDED') return 'SUCCEEDED'
  if (token === 'FAILED') return 'FAILED'
  return null
}

/** N. yoklamanın bekleme süresi — artan ve TAVANLI. */
export function pollDelayMs(pollIndex: number): number {
  const index = Math.max(0, Math.trunc(pollIndex))
  return POLL_INTERVALS_MS[Math.min(index, POLL_INTERVALS_MS.length - 1)]
}

const DEFAULT_MAX_POLLS = 120

export function createSyncStatusWatcher(
  options: SyncWatcherOptions,
): SyncWatcher {
  const schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as never))
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS

  let handle: unknown = null
  let active = false
  let polls = 0
  let stopped = false

  const stop = () => {
    stopped = true
    active = false
    if (handle !== null) {
      cancel(handle)
      handle = null
    }
  }

  const tick = async () => {
    handle = null
    if (stopped) return
    polls += 1
    let snapshot: SyncStatusSnapshot | null = null
    try {
      snapshot = await options.fetchStatus()
    } catch {
      // Durum okuması geçici olarak başarısız olabilir; izleme SÜRER ama
      // sonsuza kadar değil (maxPolls emniyeti).
      snapshot = null
    }
    if (stopped) return
    options.onUpdate?.(snapshot)

    const terminal = snapshot ? isTerminalSyncState(snapshot.state) : null
    // Koşan bir tur varken terminal sayma (yeni tur başlamış olabilir).
    if (terminal && snapshot && !snapshot.running) {
      active = false
      options.onTerminal(terminal, snapshot)
      return
    }
    if (polls >= maxPolls) {
      // EMNİYET: sonsuz yoklama YOK.
      active = false
      options.onTerminal('FAILED', snapshot)
      return
    }
    handle = schedule(() => void tick(), pollDelayMs(polls))
  }

  return {
    start() {
      // TEK İZLEYİCİ: zaten aktifse yeni döngü AÇILMAZ.
      if (active) return
      active = true
      stopped = false
      polls = 0
      handle = schedule(() => void tick(), pollDelayMs(0))
    },
    stop,
    isActive: () => active,
    pollCount: () => polls,
  }
}
