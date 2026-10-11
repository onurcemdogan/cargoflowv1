// WOOCOMMERCE GELEN KUTUSU TÜKETİCİSİ — DAYANIKLI KUTUNUN DİĞER YARISI.
//
// ═══ ÖLÇÜLEN EKSİK (YAMADAN ÖNCE YENİDEN ÜRETİLDİ) ═══════════════════════
//
// Üretim yolu `doğrula → kalıcı yaz → 2xx` ile BİTİYORDU. `processWooInboxItem`
// yazılmıştı ama HİÇBİR çalışma zamanı onu çağırmıyordu: kabul edilen teslim
// `RECEIVED` olarak SONSUZA KADAR duruyordu (ölçüldü: `D-1=RECEIVED/attempt=0`).
//
// Tüketicisi olmayan dayanıklı kutu, kutu değil MEZARLIKTIR.
//
// ═══ GERÇEK KAYNAĞI: KUTUDAKİ ŞİFRELİ YÜK ════════════════════════════════
//
// Bu modül HTTP isteğine HİÇ BAKMAZ. İstek gövdesi 2xx'ten sonra bellekte
// DURMAZ ve durduğu VARSAYILAMAZ: süreç yeniden başlayabilir, kabul ile
// işleme arasında saatler geçebilir. Ham gövde HER ZAMAN diskten çözülür
// (`readInboxRawBody`) — böylece imza baytları da korunur.
//
// ═══ SAĞLAYICIYA BAĞIMLILIK YOK ══════════════════════════════════════════
//
// 2xx verildikten sonra WooCommerce o teslimi BİR DAHA GÖNDERMEZ. Bu yüzden
// "tekrar denemek" = SAĞLAYICIYA yeniden gönder DEMEK DEĞİLDİR; kurtarma
// TAMAMEN İÇERİDEDİR. (Sözleşme: ardışık 5 başarısız teslimde webhook
// DISABLED olur — sahte 5xx dönmek akışı sessizce kapatırdı.)
//
// ═══ VARSAYILAN KAPALI ═══════════════════════════════════════════════════
//
// Depo deseni: arka plan zamanlayıcıları AÇIK BAYRAKLA etkinleşir
// (`retentionScheduler`, `labelJobWorker`, `trendyolStreamScheduler`).
// WooCommerce `internal_test` aşamasındadır; bayrak açılmadıkça boot'ta
// hiçbir tur kurulmaz. Açıldığında bile kanonik sipariş yazımı
// `liveWriteGate` ile KAPALIDIR.
import {
  claimInboxDelivery,
  listDueInboxDeliveries,
  markInboxProcessing,
  readInboxRawBody,
  DEFAULT_INBOX_RETRY_POLICY,
  type InboxRetryPolicy,
} from '../webhookInbox.ts'
import { WOO_PROVIDER_KEY } from './wooConnectionService.ts'
import { processWooInboxItem } from './wooWebhookIngest.ts'
import type { WooNormalizedOrder } from './wooOrderNormalizer.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const WOO_INBOX_WORKER_DEFAULT_INTERVAL_MS = 30_000
export const WOO_INBOX_WORKER_DEFAULT_BATCH = 25

/** `WOO_WEBHOOK_WORKER_ENABLED`: yalnız `true`/`1` etkinleştirir. */
export function isWooInboxWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = String(env.WOO_WEBHOOK_WORKER_ENABLED ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

export interface WooInboxCycleReport {
  /** Uygunluk sorgusundan dönen aday sayısı. */
  due: number
  /** Sahiplenilebilen kayıt sayısı. */
  claimed: number
  processed: number
  retryable: number
  ignored: number
  /** Yarışı kaybedip DOKUNULMAYAN kayıtlar. */
  skipped: number
  /** İşleyicinin KENDİSİ patladı (kardeşler DURMAZ). */
  failed: number
  canonicalPersisted: number
  durationMs: number
}

export interface WooInboxCycleOptions {
  nowMs?: number
  limit?: number
  policy?: InboxRetryPolicy
  /** Tek kiracıya daraltma (tanı/test). Üretimde verilmez. */
  organizationId?: string
  /**
   * Kanonik yazıcı. ÜRETİMDE VERİLMEZ: `internal_test`te kapı zaten
   * kapalıdır ve ikinci bir yazma yolu açmak sessiz canlı davranış olurdu.
   */
  persistCanonical?: (order: WooNormalizedOrder) => Promise<void>
  onError?: (error: unknown) => void
}

/**
 * BİR TUR.
 *
 * Sınırlıdır (`limit`), kiracı kapsamı SATIRDAN gelir ve tek bozuk kayıt
 * KARDEŞLERİ DURDURMAZ: her kayıt kendi `try` bloğundadır.
 */
export async function runWooInboxCycle(
  db: Db,
  options: WooInboxCycleOptions = {},
): Promise<WooInboxCycleReport> {
  const startedAt = Date.now()
  const nowMs = options.nowMs ?? startedAt
  const policy = options.policy ?? DEFAULT_INBOX_RETRY_POLICY
  const report: WooInboxCycleReport = {
    due: 0,
    claimed: 0,
    processed: 0,
    retryable: 0,
    ignored: 0,
    skipped: 0,
    failed: 0,
    canonicalPersisted: 0,
    durationMs: 0,
  }

  const due = await listDueInboxDeliveries(db, {
    providerKey: WOO_PROVIDER_KEY,
    nowMs,
    policy,
    limit: options.limit ?? WOO_INBOX_WORKER_DEFAULT_BATCH,
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
  })
  report.due = due.length

  for (const candidate of due) {
    // KİRACI KAPSAMI SATIRIN KENDİSİNDEN: sistem taraması izolasyonu
    // kaldırmaz, aşağıdaki HER çağrı bu kimlikle kapsanır.
    const organizationId = candidate.organizationId
    try {
      const claimed = await claimInboxDelivery(db, {
        organizationId,
        inboxId: candidate.id,
        expectedStatus: candidate.status,
        expectedAttemptCount: candidate.attemptCount,
      })
      if (!claimed) {
        // Yarışı kaybettik; satıra DOKUNULMAZ (çift işleme YOK).
        report.skipped += 1
        continue
      }
      report.claimed += 1

      // GERÇEK KAYNAĞI DİSKTİR — istek gövdesi DEĞİL.
      const rawBody = await readInboxRawBody(db, {
        organizationId,
        inboxId: claimed.id,
      })
      if (!rawBody) {
        await markInboxProcessing(db, {
          organizationId,
          inboxId: claimed.id,
          status: 'RETRYABLE',
          errorCode: 'BODY_UNREADABLE',
          incrementAttempt: false,
        })
        report.retryable += 1
        continue
      }

      const result = await processWooInboxItem(db, {
        organizationId,
        record: claimed,
        rawBody,
        // Sayaç SAHİPLENMEDE artırıldı; ikinci artış YOK.
        incrementAttempt: false,
        ...(options.persistCanonical
          ? { persistCanonical: options.persistCanonical }
          : {}),
      })
      if (result.status === 'PROCESSED') report.processed += 1
      else if (result.status === 'IGNORED') report.ignored += 1
      else report.retryable += 1
      if (result.canonicalPersisted) report.canonicalPersisted += 1
    } catch (error) {
      // TEK BOZUK KAYIT TURU DÜŞÜRMEZ: kardeşler işlenmeye devam eder.
      report.failed += 1
      if (options.onError) options.onError(error)
      try {
        await markInboxProcessing(db, {
          organizationId,
          inboxId: candidate.id,
          status: 'RETRYABLE',
          errorCode: 'PROCESSOR_ERROR',
          incrementAttempt: false,
        })
      } catch {
        // Sonuç yazılamadıysa kayıt olduğu gibi kalır ve tekrar seçilir.
      }
    }
  }

  report.durationMs = Date.now() - startedAt
  return report
}

// ═══ ZAMANLAYICI ══════════════════════════════════════════════════════════

let timer: ReturnType<typeof setInterval> | null = null
let cycleRunning = false
let draining = false
let activeCycle: Promise<unknown> | null = null

export function isWooInboxSchedulerActive(): boolean {
  return timer !== null
}

/**
 * Zamanlayıcıyı kurar. Bayrak kapalıysa HİÇBİR tur çalışmaz ve `false` döner.
 */
export function startWooInboxScheduler(params: {
  runCycle: () => Promise<unknown>
  intervalMs?: number
  env?: Record<string, string | undefined>
}): boolean {
  if (timer) return true
  if (!isWooInboxWorkerEnabled(params.env)) return false
  if (draining) return false
  const intervalMs = Math.max(
    5_000,
    Number(params.intervalMs ?? WOO_INBOX_WORKER_DEFAULT_INTERVAL_MS),
  )
  timer = setInterval(() => {
    // ÖRTÜŞME YASAK: yavaş bir tur ikinci bir tur AÇMAZ.
    if (cycleRunning || draining) return
    cycleRunning = true
    activeCycle = Promise.resolve(params.runCycle())
      .catch(() => undefined)
      .finally(() => {
        cycleRunning = false
        activeCycle = null
      })
  }, intervalMs)
  // PM2 yaşam döngüsünü etkilemez (depo deseni).
  timer.unref?.()
  return true
}

/** Kapanış: yeni tur AÇILMAZ, çalışan tur sınırlı süre beklenir. */
export async function drainWooInboxScheduler(
  graceMs = 15_000,
): Promise<{ drained: boolean; hadActiveCycle: boolean }> {
  draining = true
  if (timer) clearInterval(timer)
  timer = null
  const hadActiveCycle = Boolean(activeCycle)
  if (!activeCycle) {
    cycleRunning = false
    return { drained: true, hadActiveCycle }
  }
  let handle: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>((resolve) => {
    handle = setTimeout(() => resolve('expired'), Math.max(0, graceMs))
    handle.unref?.()
  })
  const finished = await Promise.race([
    activeCycle.then(() => 'finished' as const).catch(() => 'finished' as const),
    expired,
  ])
  if (handle) clearTimeout(handle)
  cycleRunning = false
  // Süre dolsa bile VERİ KAYBI YOK: kayıt kutuda durur, sonraki açılışta
  // aynı sorgu onu YENİDEN bulur.
  return { drained: finished === 'finished', hadActiveCycle }
}

export function stopWooInboxScheduler(): void {
  draining = true
  if (timer) clearInterval(timer)
  timer = null
}

/** Test yalıtımı: modül durumunu sıfırlar (üretimde çağrılmaz). */
export function resetWooInboxSchedulerForTest(): void {
  if (timer) clearInterval(timer)
  timer = null
  cycleRunning = false
  draining = false
  activeCycle = null
}
