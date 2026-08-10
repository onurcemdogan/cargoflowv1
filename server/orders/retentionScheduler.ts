import {
  resolveRetentionPolicy,
  runRetentionCycle,
  type HousekeepingReport,
  type RetentionPolicy,
} from './orderRetention.ts'

// ═══ RETENTION HOUSEKEEPING ZAMANLAYICISI ═════════════════════════════════
//
// TEK AMACI: MEVCUT `runRetentionCycle`'ı güvenli, sınırlı ve KAPILI şekilde
// çalışma zamanına bağlamak. Burada HİÇBİR iş kuralı yoktur — baseline,
// arşiv ve purge yüklemleri ile batch limitleri `orderRetention.ts` içinde
// kalır ve OLDUĞU GİBİ kullanılır (predicate KOPYALANMAZ).
//
// SÖZLEŞME:
//   ORDER_HOUSEKEEPING_ENABLED unset/false/0 → ZAMANLAYICI KURULMAZ.
//     Boot yazması YOK, periyodik yazma YOK, hiçbir baseline/archive/purge YOK.
//   ORDER_HOUSEKEEPING_ENABLED true/1        → boot sonrası BİR sınırlı tur,
//     ardından ORDER_HOUSEKEEPING_INTERVAL_MS (varsayılan 6 saat) ile
//     periyodik sınırlı tur.
//
// Varsayılan KESİNLİKLE KAPALIDIR.

type Db = Record<string, unknown>

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false
let stopping = false

export interface RetentionSchedulerHandle {
  started: boolean
  reason: 'disabled' | 'started'
  stop: () => void
}

interface StartOptions {
  policy?: RetentionPolicy
  /** Tur çalıştırıcı (test enjeksiyonu). Varsayılan: gerçek runRetentionCycle. */
  runCycle?: (db: Db, policy: RetentionPolicy) => Promise<HousekeepingReport>
  /** Aggregate log yayıcı. PII İÇERMEZ. */
  log?: (report: HousekeepingReport) => void
  onError?: (error: unknown) => void
}

/**
 * Zamanlayıcıyı kurar. KAPALI bayrakta hiçbir şey yapmaz ve `started:false`
 * döner — bu durumda tek bir tur bile ÇALIŞTIRILMAZ.
 */
export function startRetentionScheduler(
  db: Db,
  options: StartOptions = {},
): RetentionSchedulerHandle {
  stopRetentionScheduler()
  stopping = false
  const policy = options.policy ?? resolveRetentionPolicy()

  // ACTIVATION GUARD — tek karar noktası.
  if (!policy.housekeepingEnabled) {
    return { started: false, reason: 'disabled', stop: stopRetentionScheduler }
  }

  const runCycle =
    options.runCycle ??
    ((database: Db, activePolicy: RetentionPolicy) =>
      runRetentionCycle(database as never, activePolicy))

  const emit = (report: HousekeepingReport) => {
    if (options.log) {
      options.log(report)
      return
    }
    // PII YOK: yalnız aggregate sayımlar.
    console.log(
      `[retention] scanned=${report.scanned} baselineEligible=${report.baselineEligible} ` +
        `baselined=${report.baselined} archiveEligible=${report.archiveEligible} ` +
        `archived=${report.archived} purgeEligible=${report.purgeEligible} ` +
        `purged=${report.purged} failed=${report.failed} durationMs=${report.durationMs}`,
    )
  }

  const cycle = async (): Promise<void> => {
    // ÖRTÜŞME YOK: önceki tur bitmeden yenisi başlamaz. Bu YALNIZ aynı
    // process içindeki eşzamanlılığı engeller; uygunluk kaynağı DB'dir,
    // restart sonrası aday kayıtlar yeniden bulunur.
    if (cycleRunning || stopping) return
    cycleRunning = true
    try {
      const report = await runCycle(db, policy)
      emit(report)
    } catch (error) {
      // TUR HATASI UYGULAMAYI DÜŞÜRMEZ: bir sonraki aralıkta yeniden denenir.
      if (options.onError) options.onError(error)
      else console.error('[retention] cycle failed:', (error as Error)?.message)
    } finally {
      cycleRunning = false
    }
  }

  // 1) Boot sonrası TEK sınırlı tur. Boot'u BLOKLAMAZ (await edilmez).
  void cycle()

  // 2) Periyodik sınırlı tur. `unref` → PM2 yaşam döngüsünü etkilemez
  //    (mevcut labelBundlePreparer deseniyle aynı).
  timer = setInterval(() => {
    void cycle()
  }, policy.intervalMs)
  timer.unref?.()

  return { started: true, reason: 'started', stop: stopRetentionScheduler }
}

/** Zamanlayıcıyı durdurur; devam eden tur biter, YENİ tur başlamaz. */
export function stopRetentionScheduler(): void {
  stopping = true
  if (timer) clearInterval(timer)
  timer = null
}

/** Test/tanı: zamanlayıcı kurulu mu? */
export function isRetentionSchedulerActive(): boolean {
  return timer !== null
}
