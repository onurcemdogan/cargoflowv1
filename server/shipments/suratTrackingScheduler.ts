import {
  resolveTrackingReconcilePolicy,
  type TrackingReconcilePolicy,
  type TrackingReconcileReport,
} from './suratTrackingReconciler.ts'

// ═══ SÜRAT TAKİP MUTABAKATI ZAMANLAYICISI ═════════════════════════════════
//
// TEK AMACI: mevcut `reconcileSuratTracking` turunu güvenli, sınırlı ve
// KAPILI şekilde çalışma zamanına bağlamak. Burada HİÇBİR iş kuralı yoktur;
// aday yüklemi, karar ve kalıcı yazım `suratTrackingReconciler.ts`te kalır.
//
// SÖZLEŞME (retention housekeeping ile AYNI güvenlik deseni):
//   SURAT_TRACKING_RECONCILE_ENABLED unset/false/0 → ZAMANLAYICI KURULMAZ.
//     Boot taşıyıcı sorgusu YOK · periyodik sorgu YOK · DB yazması YOK.
//   true/1 → server hazır olduktan sonra BİR sınırlı tur, ardından
//     SURAT_TRACKING_RECONCILE_INTERVAL_MS (varsayılan 5 dk) ile periyodik tur.
//
// Bu YALNIZ bir etkinleştirme kapısıdır: batch/concurrency/aralık ve karar
// mantığı DEĞİŞMEZ. Varsayılan KESİNLİKLE KAPALIDIR (dış taşıyıcı API'sine
// çağrı ürettiği için açık onay şarttır).

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false
let stopping = false

/**
 * SURAT_TRACKING_RECONCILE_ENABLED: yalnız açık onay etkinleştirir.
 *   undefined / '' / 'false' / '0' / başka her şey → FALSE
 *   'true' / '1'                                   → TRUE
 */
export function isTrackingReconcileEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.SURAT_TRACKING_RECONCILE_ENABLED ?? '')
    .trim()
    .toLowerCase()
  return raw === 'true' || raw === '1'
}

export interface TrackingSchedulerHandle {
  started: boolean
  reason: 'disabled' | 'started'
  stop: () => void
  /** Elle tetikleme (ör. başarılı "Şimdi Yenile" sonrası). */
  trigger: () => void
}

interface StartOptions {
  policy?: TrackingReconcilePolicy
  enabled?: boolean
  /** Bir sınırlı tur çalıştırır. Enjekte edilebilir (test + katman ayrımı). */
  runCycle: () => Promise<TrackingReconcileReport>
  log?: (report: TrackingReconcileReport) => void
  onError?: (error: unknown) => void
}

export function startTrackingScheduler(
  options: StartOptions,
): TrackingSchedulerHandle {
  stopTrackingScheduler()
  stopping = false
  const policy = options.policy ?? resolveTrackingReconcilePolicy()
  const enabled = options.enabled ?? isTrackingReconcileEnabled()

  const noop: TrackingSchedulerHandle = {
    started: false,
    reason: 'disabled',
    stop: stopTrackingScheduler,
    trigger: () => {},
  }
  // ACTIVATION GUARD — tek karar noktası.
  if (!enabled) return noop

  const emit = (report: TrackingReconcileReport) => {
    if (options.log) {
      options.log(report)
      return
    }
    // PII YOK: yalnız aggregate sayımlar.
    console.log(
      `[surat-tracking] scanned=${report.scanned} queried=${report.queried} ` +
        `handedToCargo=${report.handedToCargo} delivered=${report.delivered} ` +
        `returning=${report.returning} unchanged=${report.unchanged} ` +
        `failed=${report.failed}`,
    )
  }

  const cycle = async (): Promise<void> => {
    // ÖRTÜŞME YOK: önceki tur bitmeden yenisi başlamaz. Taşıyıcı API'sini
    // ikiye katlamamak için bu guard KRİTİKTİR.
    if (cycleRunning || stopping) return
    cycleRunning = true
    try {
      emit(await options.runCycle())
    } catch (error) {
      // TUR HATASI UYGULAMAYI DÜŞÜRMEZ; sonraki aralıkta yeniden denenir.
      if (options.onError) options.onError(error)
      else
        console.error(
          '[surat-tracking] cycle failed:',
          (error as Error)?.message,
        )
    } finally {
      cycleRunning = false
    }
  }

  // 1) Boot sonrası TEK sınırlı tur (boot'u BLOKLAMAZ).
  void cycle()
  // 2) Periyodik sınırlı tur; `unref` → PM2 yaşam döngüsü etkilenmez.
  timer = setInterval(() => {
    void cycle()
  }, policy.intervalMs)
  timer.unref?.()

  return {
    started: true,
    reason: 'started',
    stop: stopTrackingScheduler,
    // Elle tetikleme de AYNI örtüşme guard'ından geçer.
    trigger: () => {
      void cycle()
    },
  }
}

export function stopTrackingScheduler(): void {
  stopping = true
  if (timer) clearInterval(timer)
  timer = null
}

export function isTrackingSchedulerActive(): boolean {
  return timer !== null
}
