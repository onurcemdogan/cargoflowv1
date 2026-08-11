// ═══ TRENDYOL DURUM SENKRONU ZAMANLAYICISI ════════════════════════════════
//
// AMAÇ: kullanıcı "Şimdi Yenile"ye basmak zorunda kalmadan pazaryeri sipariş
// durumlarının arka planda tazelenmesi. Trendyol `Shipped` dediğinde kanonik
// zincir zaten "Kargoya Verildi" üretiyor (TRENDYOL-HANDED-1/2); eksik olan
// tek şey periyodik tetikleyiciydi.
//
// BU MODÜLDE İŞ KURALI YOKTUR. Trendyol çekme, normalize ve kalıcılaştırma
// "Şimdi Yenile"nin kullandığı KANONİK zincirin AYNISIDIR ve dışarıdan
// enjekte edilir:
//   callTrendyolOrdersByStatuses → normalizeTrendyolOrders → persistSyncResult
// İkinci bir marketplace mapping/persistence YAZILMAZ.
//
// SÖZLEŞME (retention/Sürat zamanlayıcılarıyla aynı güvenlik deseni):
//   TRENDYOL_STATUS_SYNC_ENABLED unset/false/0 → ZAMANLAYICI KURULMAZ.
//     Boot senkronu YOK · periyodik senkron YOK · Trendyol çağrısı YOK.
//   true/1 → boot sonrası sınırlı bir tur, ardından
//     TRENDYOL_STATUS_SYNC_INTERVAL_MS (varsayılan 5 dk, taban 60 sn).
//
// SÜRAT/SSP TARAFINA DOKUNMAZ: taşıyıcı sorgusu, Serendip, KTH,
// CariKoduveSifre veya kabul eşlemesi BURADA YOKTUR.

export interface TrendyolSyncPolicy {
  enabled: boolean
  intervalMs: number
  /** Bir turda işlenecek EN FAZLA organizasyon sayısı. */
  batchSize: number
  /** Aynı anda kaç organizasyon senkronlanır. */
  concurrency: number
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

/** Yalnız açık onay etkinleştirir: 'true' | '1'. Diğer her şey KAPALI. */
export function isTrendyolStatusSyncEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.TRENDYOL_STATUS_SYNC_ENABLED ?? '')
    .trim()
    .toLowerCase()
  return raw === 'true' || raw === '1'
}

export function resolveTrendyolSyncPolicy(
  env: Record<string, string | undefined> = process.env,
): TrendyolSyncPolicy {
  return {
    enabled: isTrendyolStatusSyncEnabled(env),
    // Taban 60 sn: pazaryeri API'sini yormamak için sert alt sınır.
    intervalMs: Math.max(
      60_000,
      positiveInt(env.TRENDYOL_STATUS_SYNC_INTERVAL_MS, 300_000),
    ),
    batchSize: Math.min(
      500,
      positiveInt(env.TRENDYOL_STATUS_SYNC_BATCH_SIZE, 100),
    ),
    concurrency: Math.min(
      4,
      positiveInt(env.TRENDYOL_STATUS_SYNC_CONCURRENCY, 2),
    ),
  }
}

export interface TrendyolSyncReport {
  scanned: number
  synced: number
  failed: number
  skipped: number
}

export interface TrendyolSyncTarget {
  organizationId: string
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const current = index
      index += 1
      if (current >= items.length) return
      results[current] = await worker(items[current])
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * SINIRLI bir senkron turu. Hedefler ve senkron fonksiyonu DIŞARIDAN gelir
 * (bu modül DB'ye ve Trendyol'a doğrudan bağlı DEĞİLDİR).
 *
 * FAIL-OPEN: bir organizasyonun senkronu başarısız olursa o kayıtlar
 * DEĞİŞMEZ ve tur diğer hedeflerle DEVAM eder.
 */
export async function runTrendyolSyncCycle(
  policy: TrendyolSyncPolicy,
  listTargets: (limit: number) => Promise<TrendyolSyncTarget[]>,
  syncOne: (target: TrendyolSyncTarget) => Promise<{ synced: boolean }>,
): Promise<TrendyolSyncReport> {
  const targets = await listTargets(policy.batchSize)
  if (targets.length === 0) {
    return { scanned: 0, synced: 0, failed: 0, skipped: 0 }
  }
  const outcomes = await mapWithConcurrency(
    targets,
    policy.concurrency,
    async (target) => {
      try {
        const result = await syncOne(target)
        return result.synced ? 'synced' : 'skipped'
      } catch {
        return 'failed'
      }
    },
  )
  return {
    scanned: targets.length,
    synced: outcomes.filter((value) => value === 'synced').length,
    failed: outcomes.filter((value) => value === 'failed').length,
    skipped: outcomes.filter((value) => value === 'skipped').length,
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false
let stopping = false

export interface TrendyolSyncSchedulerHandle {
  started: boolean
  reason: 'disabled' | 'started'
  stop: () => void
}

export function startTrendyolStatusSyncScheduler(options: {
  policy?: TrendyolSyncPolicy
  runCycle: () => Promise<TrendyolSyncReport>
  log?: (report: TrendyolSyncReport) => void
  onError?: (error: unknown) => void
}): TrendyolSyncSchedulerHandle {
  stopTrendyolStatusSyncScheduler()
  stopping = false
  const policy = options.policy ?? resolveTrendyolSyncPolicy()

  // ACTIVATION GUARD — tek karar noktası.
  if (!policy.enabled) {
    return {
      started: false,
      reason: 'disabled',
      stop: stopTrendyolStatusSyncScheduler,
    }
  }

  const emit = (report: TrendyolSyncReport) => {
    if (options.log) {
      options.log(report)
      return
    }
    // PII YOK: yalnız aggregate sayımlar.
    console.log(
      `[trendyol-sync] scanned=${report.scanned} synced=${report.synced} ` +
        `failed=${report.failed} skipped=${report.skipped}`,
    )
  }

  const cycle = async (): Promise<void> => {
    // ÖRTÜŞME YOK: önceki tur bitmeden yenisi başlamaz.
    if (cycleRunning || stopping) return
    cycleRunning = true
    try {
      emit(await options.runCycle())
    } catch (error) {
      // TUR HATASI UYGULAMAYI DÜŞÜRMEZ.
      if (options.onError) options.onError(error)
      else
        console.error('[trendyol-sync] cycle failed:', (error as Error)?.message)
    } finally {
      cycleRunning = false
    }
  }

  void cycle()
  timer = setInterval(() => {
    void cycle()
  }, policy.intervalMs)
  timer.unref?.()

  return {
    started: true,
    reason: 'started',
    stop: stopTrendyolStatusSyncScheduler,
  }
}

export function stopTrendyolStatusSyncScheduler(): void {
  stopping = true
  if (timer) clearInterval(timer)
  timer = null
}

export function isTrendyolStatusSyncActive(): boolean {
  return timer !== null
}
