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
/**
 * Worker ETKİN mi (olay tetiği). Zamanlayıcının varlığından AYRIDIR: yedek
 * yoklama kapalıyken de `requestLabelJobCycle()` tur başlatır.
 */
let workerActive = false
let cycleRunning = false
let rerunRequested = false
let scheduledCycle: (() => Promise<unknown>) | null = null

/**
 * YEDEK (yalnız kurtarma) yoklama aralığı — YALNIZ `LABEL_WORKER_POLL_ENABLED`
 * açıkken kurulur. Gecikmenin asıl mekanizması olaydır
 * (`requestLabelJobCycle`): üretici iş kuyruğa aldığında worker HEMEN
 * uyanır; açılışta da bir kurtarma turu koşulur.
 */
export const LABEL_WORKER_DEFAULT_INTERVAL_MS = 60_000

/** `LABEL_WORKER_ENABLED`: yalnız `true`/`1` etkinleştirir. */
export function isLabelWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.LABEL_WORKER_ENABLED ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

/**
 * `LABEL_WORKER_POLL_ENABLED`: 60 sn'lik yedek yoklama — VARSAYILAN KAPALI.
 * Yalnız `true`/`1` açar (`LABEL_WORKER_ENABLED` ile aynı anlam).
 *
 * ÜRETİM İZOLASYON KANITI (2026-10-13, master b1cfb0a): paket mutabakatı
 * kapalıyken worker KAPALI → bellek stabil; worker yeniden AÇIK → 01:56
 * ~602 MB, 02:30 ~867 MB ve PM2 restart. Kuyrukta PREPARING yoktu,
 * UNKNOWN_AFTER_NETWORK 25'te sabitti. Tek değişken worker'ı açıp kapatmaktı
 * ve worker'ın tek periyodik işi 60 sn'lik TAM turdur. Heap snapshot YOK: bu
 * kesin kök neden değil, üretim izolasyon kanıtı + kod çıkarımıdır.
 *
 * Kapalıyken worker yine olay güdümlü çalışır: açılışta tek kurtarma turu,
 * üretici kuyruğa aldığında anında uyanma. Boş sistemde her 60 sn tam
 * DB/worker turu DÖNMEZ.
 */
export function isLabelWorkerPollEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.LABEL_WORKER_POLL_ENABLED ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

/** Worker olay tetiğiyle etkin mi (test/teşhis). */
export function isLabelJobSchedulerActive(): boolean {
  return workerActive
}

/** 60 sn yedek yoklama zamanlayıcısı kurulu mu (test/teşhis). */
export function isLabelWorkerPollActive(): boolean {
  return timer !== null
}

// ═══ ZARİF BOŞALTMA (DRAIN) ══════════════════════════════════════════════
//
// ÜRETİMDE ÖLÇÜLDÜ: kanarya betiği `sleep 90` sonrası PM2'yi KOŞULSUZ
// yeniden başlattı ve iş `PREPARING` iken süreç öldü. Geriye kilitli bir
// satır ve ağdan önce ölmüş bir rezervasyon kaldı.
//
// Kapanış sinyalinde:
//   • YENİ talep DERHAL durur (bir sonraki tur açılmaz),
//   • ÇALIŞAN tur sınırlı bir süre boyunca BİTİRİLİR,
//   • İKİNCİ create ASLA başlatılmaz,
//   • süre dolarsa kalıcı taşıyıcı kanıtı bir sonraki açılışı GÜVENLİ kılar
//     (`releaseStaleLocks` kanıta bakar, süreye değil).
let draining = false
let activeCycle: Promise<unknown> | null = null

/** Kapanış başladı mı? Yeni talep AÇILMAZ. */
export function isDraining(): boolean {
  return draining
}

/**
 * Kapanış sinyali: yeni tur açma, çalışanı sınırlı süre bekle.
 *
 * `graceMs` dolsa bile süreç ZORLA bekletilmez; kanıt kalıcıdır.
 */
export async function drainLabelJobScheduler(
  graceMs = 30_000,
): Promise<{ drained: boolean; hadActiveCycle: boolean }> {
  draining = true
  // Olay tetiği de kapanır: yeni tur AÇILMAZ.
  workerActive = false
  if (timer) clearInterval(timer)
  timer = null
  const hadActiveCycle = Boolean(activeCycle)
  if (!activeCycle) {
    cycleRunning = false
    return { drained: true, hadActiveCycle }
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('expired'), Math.max(0, graceMs))
  })
  const finished = await Promise.race([
    activeCycle.then(() => 'finished' as const).catch(() => 'finished' as const),
    expired,
  ])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  cycleRunning = false
  return { drained: finished === 'finished', hadActiveCycle }
}

// Tek tur başlatıcı — aralık ve olay AYNI yolu kullanır. Turlar ÜST ÜSTE
// BİNMEZ: tur sürerken gelen istek kaybolmaz, tur bitince BİR kez daha
// koşulur (ikinci bir eşzamanlı talep dalgası AÇILMAZ).
function triggerCycle(): boolean {
  if (!workerActive || !scheduledCycle || draining) return false
  if (cycleRunning) {
    rerunRequested = true
    return true
  }
  cycleRunning = true
  const runCycle = scheduledCycle
  const cycle = Promise.resolve()
    .then(() => runCycle())
    .catch(() => undefined)
    .finally(() => {
      cycleRunning = false
      activeCycle = null
      // Yeniden koşma zamanlayıcıya BAĞLI DEĞİL: yoklama kapalıyken de tur
      // sırasında gelen uyandırma kaybolmaz.
      if (rerunRequested && workerActive && !draining) {
        rerunRequested = false
        triggerCycle()
      }
    })
  activeCycle = cycle
  void cycle
  return true
}

/**
 * OLAY TETİĞİ: iş kuyruğa alındığında worker'ı HEMEN uyandırır. Yedek
 * yoklama zamanlayıcısı GEREKMEZ. Worker etkin değilse (`LABEL_WORKER_ENABLED`
 * kapalı, durdurulmuş veya boşaltılıyor) hiçbir şey yapmaz → taşıyıcı
 * çağrısı YOK.
 */
export function requestLabelJobCycle(): boolean {
  if (!workerActive) return false
  return triggerCycle()
}

export function startLabelJobScheduler(params: {
  runCycle: () => Promise<unknown>
  intervalMs?: number
  env?: Record<string, string | undefined>
}): boolean {
  if (workerActive) return true
  if (!isLabelWorkerEnabled(params.env)) return false
  // Boşaltma başladıysa yeniden kurulmaz.
  if (draining) return false
  scheduledCycle = params.runCycle
  // Olay tetiği etkin: `requestLabelJobCycle()` artık tur başlatır.
  workerActive = true
  // YEDEK YOKLAMA VARSAYILAN KAPALI: yalnız `LABEL_WORKER_POLL_ENABLED`
  // açıkken 60 sn'lik zamanlayıcı kurulur.
  if (!isLabelWorkerPollEnabled(params.env)) return true
  const intervalMs = Math.max(
    5_000, Number(params.intervalMs ?? LABEL_WORKER_DEFAULT_INTERVAL_MS),
  )
  timer = setInterval(() => {
    // Turlar ÜST ÜSTE BİNMEZ: yavaş bir tur ikinci bir talep dalgası açmaz.
    if (cycleRunning) return
    // Kapanış başladıysa YENİ tur AÇILMAZ.
    if (draining) return
    triggerCycle()
  }, intervalMs)
  timer.unref?.()
  return true
}

export function stopLabelJobScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  workerActive = false
  cycleRunning = false
  draining = false
  activeCycle = null
  rerunRequested = false
  scheduledCycle = null
}
