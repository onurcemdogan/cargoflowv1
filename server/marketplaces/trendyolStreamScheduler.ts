// TRENDYOL STREAM MUTABAKAT ZAMANLAYICISI.
//
// Stream adaptörü kütüphane olarak kalırsa hiçbir şey senkronlanmaz. Bu
// modül onu çalışma zamanına bağlar — depo deseniyle: VARSAYILAN KAPALI,
// turlar üst üste binmez, kontrol noktası SÜREÇTE DEĞİL VERİTABANINDA.
//
// Bu zamanlayıcı TAŞIYICI MUTASYONU ÜRETMEZ: yalnız pazaryerinden OKUR ve
// yerel deposu günceller. Etiket üretimi ayrı worker'ın işidir.

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false

export const STREAM_SCHEDULER_DEFAULT_INTERVAL_MS = 15 * 60 * 1000

/** `TRENDYOL_STREAM_SYNC_ENABLED`: yalnız `true`/`1` etkinleştirir. */
export function isStreamSchedulerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.TRENDYOL_STREAM_SYNC_ENABLED ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

export interface StreamCheckpoint {
  organizationId: string
  marketplace: string
  syncType: string
  cursor: string | null
  windowStart: number
  windowEnd: number
  lastRunAt: number | null
  lastModifiedSeen: number | null
  filterFingerprint: string | null
  status: string
}

/**
 * Devam kararı — SAF.
 *
 * İmleç YALNIZ filtre parmak izi AYNIYSA sürdürülür. Süreç yeniden
 * başladıysa imleç veritabanından gelir; bellekteki durum kaybolsa bile
 * mutabakat bozulmaz.
 *
 * Parmak izi DEĞİŞMİŞSE imleç ATILIR: sunucu imleci, verildiği sorguya göre
 * çözer; farklı filtreyle sürdürmek KAYIP/MÜKERRER paket üretir.
 */
export function resolveStreamResume(params: {
  checkpoint: StreamCheckpoint | null
  currentFingerprint: string
}): { cursor: string | null; resumed: boolean; reason: string } {
  const checkpoint = params.checkpoint
  if (!checkpoint || !checkpoint.cursor) {
    return { cursor: null, resumed: false, reason: 'NO_CHECKPOINT' }
  }
  if (checkpoint.filterFingerprint !== params.currentFingerprint) {
    return {
      cursor: null, resumed: false,
      reason: 'FILTER_CHANGED_CURSOR_DISCARDED',
    }
  }
  return { cursor: checkpoint.cursor, resumed: true, reason: 'RESUMED' }
}

export function startTrendyolStreamScheduler(params: {
  runCycle: () => Promise<unknown>
  intervalMs?: number
  env?: Record<string, string | undefined>
}): boolean {
  if (timer) return true
  if (!isStreamSchedulerEnabled(params.env)) return false
  const intervalMs = Math.max(
    60_000, Number(params.intervalMs ?? STREAM_SCHEDULER_DEFAULT_INTERVAL_MS),
  )
  timer = setInterval(() => {
    if (cycleRunning) return
    cycleRunning = true
    void Promise.resolve(params.runCycle())
      .catch(() => undefined)
      .finally(() => { cycleRunning = false })
  }, intervalMs)
  timer.unref?.()
  return true
}

export function stopTrendyolStreamScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  cycleRunning = false
}
