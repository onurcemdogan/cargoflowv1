// ETİKET İŞ WORKER'I — SINIRLI, TEKRARSIZ, AYNI ORKESTRASYON.
//
// ═══ NE YAPMAZ ═══════════════════════════════════════════════════════════
//
// Bu worker KENDİ Sürat istemcisini KURMAZ. Etiket üretimi `runLabel`
// olarak ENJEKTE EDİLİR ve üretimde elle basılan butonun çağırdığı AYNI
// orkestrasyondur. İkinci bir uygulama olsaydı, arka plan ile buton
// zamanla ayrışır ve faturalama/kimlik güvenceleri yalnız birinde kalırdı.
//
// ═══ EN KRİTİK KURAL ═════════════════════════════════════════════════════
//
// Ağ sınırı GEÇİLDİKTEN sonra sonuç belirsizse iş `UNKNOWN_AFTER_NETWORK`
// olur ve BİR DAHA TALEP EDİLMEZ. Worker yeniden başlasa bile ikinci
// gönderi YARATILMAZ.
import {
  AUTO_LABEL_CONCURRENCY,
  resolveAutoLabelJobState,
} from './suratAutoLabelPolicy.ts'
import {
  claimLabelJobs, completeLabelJob, releaseStaleLocks, type LabelJobRow,
} from './labelJobQueue.ts'

export interface LabelRunOutcome {
  labelReady: boolean
  /** Taşıyıcı ağına ÇIKILDI mı? Belirsizlik kararının tek girdisi. */
  networkCrossed: boolean
  blocked?: boolean
  errorCode?: string | null
  errorSummary?: string | null
  carrierCalls?: number
}

export interface WorkerReport {
  claimed: number
  ready: number
  blocked: number
  failedSafeToRetry: number
  unknownAfterNetwork: number
  carrierCalls: number
  staleLocksReleased: number
  maxConcurrentObserved: number
  durationMs: number
}

/** Sınırlı eşzamanlılık — `Promise.all(binlerce)` ASLA. */
async function runBounded<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
  onConcurrency?: (active: number) => void,
): Promise<void> {
  const size = Math.max(1, Math.min(Number(limit) || 1, AUTO_LABEL_CONCURRENCY.global))
  let index = 0
  let active = 0
  const workers = Array.from({ length: Math.min(size, items.length || 1) }, async () => {
    while (index < items.length) {
      const item = items[index++]
      active += 1
      onConcurrency?.(active)
      try {
        await run(item)
      } finally {
        active -= 1
      }
    }
  })
  await Promise.all(workers)
}

/**
 * Bir tur çalıştırır.
 *
 * `runLabel` üretimdeki create orkestrasyonudur; burada YENİDEN YAZILMAZ.
 */
export async function runLabelJobCycle(params: {
  db: unknown
  workerId: string
  batchSize?: number
  concurrency?: number
  staleLockMs?: number
  runLabel: (job: LabelJobRow) => Promise<LabelRunOutcome>
  now?: () => number
}): Promise<WorkerReport> {
  const now = params.now ?? (() => Date.now())
  const startedAt = now()
  const db = params.db as never

  // Çökmüş worker'ın kilitleri serbest kalır; iş KAYBOLMAZ.
  const staleLocksReleased = await releaseStaleLocks(db, {
    olderThanMs: Number(params.staleLockMs ?? 10 * 60 * 1000),
  })

  const jobs = await claimLabelJobs(db, {
    workerId: params.workerId,
    limit: Number(params.batchSize ?? 20),
  })

  const report: WorkerReport = {
    claimed: jobs.length, ready: 0, blocked: 0, failedSafeToRetry: 0,
    unknownAfterNetwork: 0, carrierCalls: 0, staleLocksReleased,
    maxConcurrentObserved: 0, durationMs: 0,
  }

  await runBounded(
    jobs,
    Number(params.concurrency ?? AUTO_LABEL_CONCURRENCY.perCarrier),
    async (job) => {
      let outcome: LabelRunOutcome
      try {
        outcome = await params.runLabel(job)
      } catch (error) {
        // İSTİSNA AĞA ÇIKILDIĞI ANLAMINA GELMEZ, ama gelmediği de
        // KANITLANMAZ. Bu yüzden burada create TEKRARLANMAZ: iş güvenli
        // tekrar sınıfına DÜŞMEZ, belirsiz sayılır.
        outcome = {
          labelReady: false, networkCrossed: true,
          errorCode: 'LABEL_WORKER_EXCEPTION',
          errorSummary: String((error as Error)?.message ?? error).slice(0, 300),
        }
      }
      report.carrierCalls += Number(outcome.carrierCalls ?? 0)
      const state = resolveAutoLabelJobState({
        networkCrossed: outcome.networkCrossed === true,
        labelReady: outcome.labelReady === true,
        blocked: outcome.blocked === true,
        // Deterministik ağ-öncesi engeller BLOKE edilir; sonsuz tekrar yok.
        errorCode: outcome.errorCode ?? null,
      })
      if (state.state === 'READY') report.ready += 1
      else if (state.state === 'BLOCKED') report.blocked += 1
      else if (state.state === 'UNKNOWN_AFTER_NETWORK') report.unknownAfterNetwork += 1
      else report.failedSafeToRetry += 1

      await completeLabelJob(db, {
        id: job.id,
        status: state.state,
        errorCode: outcome.errorCode ?? null,
        errorSummary: outcome.errorSummary ?? null,
      })
    },
    (active) => {
      if (active > report.maxConcurrentObserved) report.maxConcurrentObserved = active
    },
  )

  report.durationMs = now() - startedAt
  return report
}

// ═══ ZAMANLAYICI ══════════════════════════════════════════════════════════
//
// Depo deseni: varsayılan KAPALI, açık onayla etkinleşir. Bu worker GERÇEK
// taşıyıcı mutasyonu üretebildiği için varsayılan kapalı olması ŞARTTIR.

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false

export const LABEL_WORKER_DEFAULT_INTERVAL_MS = 60_000

/** `LABEL_WORKER_ENABLED`: yalnız `true`/`1` etkinleştirir. */
export function isLabelWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.LABEL_WORKER_ENABLED ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

export function startLabelJobScheduler(params: {
  runCycle: () => Promise<unknown>
  intervalMs?: number
  env?: Record<string, string | undefined>
}): boolean {
  if (timer) return true
  if (!isLabelWorkerEnabled(params.env)) return false
  const intervalMs = Math.max(
    5_000, Number(params.intervalMs ?? LABEL_WORKER_DEFAULT_INTERVAL_MS),
  )
  timer = setInterval(() => {
    // Turlar ÜST ÜSTE BİNMEZ: yavaş bir tur ikinci bir talep dalgası açmaz.
    if (cycleRunning) return
    cycleRunning = true
    void Promise.resolve(params.runCycle())
      .catch(() => undefined)
      .finally(() => { cycleRunning = false })
  }, intervalMs)
  timer.unref?.()
  return true
}

export function stopLabelJobScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  cycleRunning = false
}
