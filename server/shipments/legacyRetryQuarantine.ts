// ESKİ ÇALIŞMA ZAMANI KALINTILARININ KARANTİNASI.
//
// ═══ NEDEN GEREKLİ ═══════════════════════════════════════════════════════
// Eski worker, AĞDAN ÖNCEKİ deterministik bir reddi (desi eksik)
// `FAILED_SAFE_TO_RETRY` olarak yazıyordu. `claimLabelJobs` bu durumu
// TALEP EDER; bu doğru davranıştır — gerçekten geçici hatalar için.
//
// Ama bu beş satır o hatanın kalıntısıdır ve worker açıldığında UYANIRLAR.
// Bunları uyandırmak istemiyoruz: sebep hâlâ deterministikse aynı döngü
// yeniden başlar; sebep düzelmişse bile SIRAYA GİRME KARARI insanın
// olmalıdır.
//
// ═══ CLAIM MANTIĞI DEĞİŞTİRİLMEZ ═════════════════════════════════════════
// `claimLabelJobs` sorgusuna DOKUNULMAZ. Bu araç yalnız KALINTI SATIRLARI
// `BLOCKED` durumuna taşır; genel davranış aynı kalır.
//
// ═══ KANIT OLMADAN DOKUNULMAZ (FAIL-CLOSED) ══════════════════════════════
// Bir satır ancak ŞU ÜÇÜ BİRDEN kanıtlanırsa "kanıtlanmış kalıntı" sayılır:
//   1. Durum `FAILED_SAFE_TO_RETRY`
//   2. Taşıyıcıya HİÇ gidilmediği OPERASYONEL kayıtla kanıtlı
//      (`shipment_operations.carrier_create_called` hiçbir satırda true değil)
//   3. Taşıyıcı artefaktı (shipment) YOK
//   4. Saklanan hata kodu/özeti AĞDAN ÖNCEKİ desi reddine işaret ediyor
//
// Biri bile sağlanmazsa satır `HISTORY_UNPROVEN` olarak RAPORLANIR ve
// DOKUNULMAZ. Belirsizlik ASLA create izni değildir.
//
// ═══ İZ DEPOSUNUN SINIRI (ölçüldü) ═══════════════════════════════════════
// `surat_trace_attempts` (org, trace_id) üzerinde UNIQUE'tir ve yazım
// `onConflictDoNothing` kullanır. `traceId` ise paket kimliğinden
// TÜRETİLİR (`CF-SOAP-<packageId>`). Sonuç: bir paket için YALNIZ İLK
// deneme saklanır; 8–37 denemenin geri kalanı iz bırakmaz.
//
// Bu yüzden "her tarihsel deneme ağdan önceydi" iddiası İZ DEPOSUNDAN
// KANITLANAMAZ. Kullanılan otoriter ve MUTASYONSUZ kaynak
// `shipment_operations`'tır: `carrier_create_called` kümülatiftir ve
// herhangi bir deneme taşıyıcıya ulaşsaydı true olurdu.

import { and, eq, inArray } from 'drizzle-orm'
import {
  labelJobs,
  shipmentOperations,
  shipments,
  suratTraceAttempts,
} from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Runtime düzeltmesinin getirdiği KESİN kod — yenisi uydurulmaz. */
export const LEGACY_DESI_ERROR_CODE = 'SURAT_PREFLIGHT_DESI_MISSING'

/** Eski çalışma zamanının desi reddi için yazdığı kodlar/özetler. */
const LEGACY_DESI_SIGNALS: readonly string[] = [
  'SURAT_PREFLIGHT_DESI_MISSING',
  'BLOCKED_DESI_MISSING',
  // Eski hatalı sınıflandırma: taşıma denenmediği hâlde taşıma hatası.
  'SURAT_SOAP_TRANSPORT_FAILED',
]

export type LegacyVerdict =
  | 'PROVEN_LEGACY_DESI'
  | 'HISTORY_UNPROVEN'
  | 'NOT_LEGACY_CANDIDATE'

export interface LegacyCandidate {
  readonly jobId: string
  readonly packageId: string
  readonly status: string
  readonly attemptCount: number
  readonly lastErrorCode: string | null
  readonly lastErrorSummary: string | null
  /** Operasyonel kayıtta taşıyıcı çağrısı kanıtı. */
  readonly carrierCreateCalled: boolean
  readonly createCallCount: number
  readonly carrierArtifactPresent: boolean
  /** İz deposunda bu paket için saklanan deneme sayısı (en fazla 1). */
  readonly recordedTraceAttempts: number
  readonly verdict: LegacyVerdict
  readonly reason: string
}

export interface LegacyInspectReport {
  readonly organizationId: string
  readonly totalFailedSafeToRetry: number
  readonly provenLegacy: number
  readonly historyUnproven: number
  readonly notLegacy: number
  readonly candidates: readonly LegacyCandidate[]
  readonly networkCalls: number
  readonly dbWrites: number
  readonly carrierCalls: number
}

function desiSignal(job: Record<string, unknown>): boolean {
  const code = String(job.lastErrorCode ?? '')
  const summary = String(job.lastErrorSummary ?? '').toLocaleLowerCase('tr-TR')
  return LEGACY_DESI_SIGNALS.includes(code) || summary.includes('desi')
}

/**
 * SALT-OKUNUR inceleme. Hiçbir satır yazılmaz, hiçbir ağ çağrısı yapılmaz.
 */
export async function inspectLegacyRetryJobs(
  db: Db,
  params: { organizationId: string },
): Promise<LegacyInspectReport> {
  const jobs = await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.status, 'FAILED_SAFE_TO_RETRY'),
      ),
    )
    .orderBy(labelJobs.createdAt)

  const rows = jobs as Record<string, unknown>[]
  const packageIds = rows.map((row) => String(row.packageId ?? ''))

  // OPERASYONEL KANIT — taşıyıcıya gidildi mi?
  const operations = packageIds.length
    ? await db
        .select()
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, params.organizationId),
            inArray(shipmentOperations.packageId, packageIds),
          ),
        )
    : []
  const carrierCalled = new Map<string, boolean>()
  const callCounts = new Map<string, number>()
  for (const operation of operations as Record<string, unknown>[]) {
    const key = String(operation.packageId ?? '')
    if (operation.carrierCreateCalled === true) carrierCalled.set(key, true)
    callCounts.set(
      key,
      Math.max(callCounts.get(key) ?? 0, Number(operation.createCallCount ?? 0)),
    )
  }

  // TAŞIYICI ARTEFAKTI — gönderi kaydı var mı?
  const shipmentRows = packageIds.length
    ? await db
        .select({ packageId: shipments.packageId })
        .from(shipments)
        .where(
          and(
            eq(shipments.organizationId, params.organizationId),
            inArray(shipments.packageId, packageIds),
          ),
        )
    : []
  const hasArtifact = new Set(
    (shipmentRows as { packageId: string }[]).map((row) => String(row.packageId)),
  )

  // İZ DEPOSU — paket başına saklanan deneme sayısı (yapısal olarak ≤ 1).
  const traceRows = packageIds.length
    ? await db
        .select({ packageId: suratTraceAttempts.packageId })
        .from(suratTraceAttempts)
        .where(
          and(
            eq(suratTraceAttempts.organizationId, params.organizationId),
            inArray(suratTraceAttempts.packageId, packageIds),
          ),
        )
    : []
  const traceCounts = new Map<string, number>()
  for (const row of traceRows as { packageId: string }[]) {
    const key = String(row.packageId)
    traceCounts.set(key, (traceCounts.get(key) ?? 0) + 1)
  }

  const candidates: LegacyCandidate[] = rows.map((job) => {
    const packageId = String(job.packageId ?? '')
    const called = carrierCalled.get(packageId) === true
    const artifact = hasArtifact.has(packageId)
    const signal = desiSignal(job)

    let verdict: LegacyVerdict = 'NOT_LEGACY_CANDIDATE'
    let reason = ''
    if (called) {
      // Taşıyıcıya gidilmiş: bu satır kalıntı DEĞİLDİR ve DOKUNULMAZ.
      verdict = 'HISTORY_UNPROVEN'
      reason = 'Operasyonel kayıt taşıyıcı çağrısı gösteriyor; dokunulmaz.'
    } else if (artifact) {
      verdict = 'HISTORY_UNPROVEN'
      reason = 'Taşıyıcı artefaktı mevcut; dokunulmaz.'
    } else if (!signal) {
      verdict = 'HISTORY_UNPROVEN'
      reason = 'Saklanan hata desi reddine işaret etmiyor; kanıt yetersiz.'
    } else {
      verdict = 'PROVEN_LEGACY_DESI'
      reason =
        'Taşıyıcı çağrısı kanıtı YOK, artefakt YOK, hata desi reddi: '
        + 'kanıtlanmış eski deterministik kalıntı.'
    }

    return {
      jobId: String(job.id ?? ''),
      packageId,
      status: String(job.status ?? ''),
      attemptCount: Number(job.attemptCount ?? 0),
      lastErrorCode: (job.lastErrorCode as string | null) ?? null,
      lastErrorSummary: (job.lastErrorSummary as string | null) ?? null,
      carrierCreateCalled: called,
      createCallCount: callCounts.get(packageId) ?? 0,
      carrierArtifactPresent: artifact,
      recordedTraceAttempts: traceCounts.get(packageId) ?? 0,
      verdict,
      reason,
    }
  })

  return {
    organizationId: params.organizationId,
    totalFailedSafeToRetry: candidates.length,
    provenLegacy: candidates.filter((c) => c.verdict === 'PROVEN_LEGACY_DESI').length,
    historyUnproven: candidates.filter((c) => c.verdict === 'HISTORY_UNPROVEN').length,
    notLegacy: candidates.filter((c) => c.verdict === 'NOT_LEGACY_CANDIDATE').length,
    candidates,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}

export interface QuarantineResult {
  readonly report: LegacyInspectReport
  readonly quarantined: number
  readonly skipped: number
  readonly carrierCalls: number
}

/**
 * KANITLANMIŞ kalıntıları `BLOCKED` durumuna taşır.
 *
 *   • `attempt_count` KORUNUR — tarihsel kanıttır, sıfırlanmaz.
 *   • Satır SİLİNMEZ/YENİDEN YARATILMAZ — aynı iş, aynı kimlik.
 *   • READY / UNKNOWN_AFTER_NETWORK / PREPARING / QUEUED DOKUNULMAZ.
 *   • Kanıtlanmamış satırlar DOKUNULMAZ.
 *   • Taşıyıcıya ÇIKILMAZ.
 */
export async function quarantineLegacyRetryJobs(
  db: Db,
  params: { organizationId: string },
): Promise<QuarantineResult> {
  const report = await inspectLegacyRetryJobs(db, params)
  let quarantined = 0
  for (const candidate of report.candidates) {
    if (candidate.verdict !== 'PROVEN_LEGACY_DESI') continue
    await db
      .update(labelJobs)
      .set({
        status: 'BLOCKED',
        // KESİN kod yazılır: eski yanlış "taşıma hatası" etiketi düzeltilir.
        lastErrorCode: LEGACY_DESI_ERROR_CODE,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
        // attemptCount'a DOKUNULMAZ.
      })
      .where(
        and(
          eq(labelJobs.id, candidate.jobId),
          // Yarış koruması: satır hâlâ beklenen durumdaysa güncellenir.
          eq(labelJobs.status, 'FAILED_SAFE_TO_RETRY'),
        ),
      )
    quarantined += 1
  }
  return {
    report,
    quarantined,
    skipped: report.candidates.length - quarantined,
    carrierCalls: 0,
  }
}

// ═══ TEK İŞ YENİDEN ETKİNLEŞTİRME ════════════════════════════════════════

export interface ReactivationCheck {
  readonly packageId: string
  readonly jobId: string | null
  readonly jobStatusIsBlocked: boolean
  readonly tenantDesiValue: number | null
  readonly multiplyByItemQuantity: boolean | null
  readonly resolverDesi: number | null
  readonly readyLabelExists: boolean
  readonly carrierArtifactExists: boolean
  readonly unknownAfterNetworkExists: boolean
  readonly carrierCallRecorded: boolean
  readonly duplicateJobs: number
  readonly safeToReactivate: boolean
  readonly blockers: readonly string[]
}

/** SALT-OKUNUR: tek paketin yeniden etkinleştirilebilirliğini kanıtlar. */
export async function inspectSingleJobReactivation(
  db: Db,
  params: { organizationId: string; packageId: string; marketplace?: string },
): Promise<ReactivationCheck> {
  const blockers: string[] = []
  const jobs = await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.packageId, params.packageId),
      ),
    )
  const rows = jobs as Record<string, unknown>[]
  const job = rows[0] ?? null
  if (!job) blockers.push('IS_BULUNAMADI')
  if (rows.length > 1) blockers.push('MUKERRER_IS')

  const statusBlocked = String(job?.status ?? '') === 'BLOCKED'
  if (job && !statusBlocked) blockers.push(`DURUM_BLOCKED_DEGIL(${job.status})`)
  if (String(job?.status ?? '') === 'UNKNOWN_AFTER_NETWORK') {
    blockers.push('UNKNOWN_AFTER_NETWORK')
  }
  if (String(job?.status ?? '') === 'READY') blockers.push('ZATEN_READY')

  // Taşıyıcı kanıtı.
  const operations = await db
    .select()
    .from(shipmentOperations)
    .where(
      and(
        eq(shipmentOperations.organizationId, params.organizationId),
        eq(shipmentOperations.packageId, params.packageId),
      ),
    )
  const carrierCallRecorded = (operations as Record<string, unknown>[]).some(
    (operation) => operation.carrierCreateCalled === true,
  )
  if (carrierCallRecorded) blockers.push('TASIYICI_CAGRISI_KAYITLI')

  const shipmentRows = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(
      and(
        eq(shipments.organizationId, params.organizationId),
        eq(shipments.packageId, params.packageId),
      ),
    )
  const carrierArtifactExists = shipmentRows.length > 0
  if (carrierArtifactExists) blockers.push('TASIYICI_ARTEFAKTI_VAR')

  // Desi ayarı ve GÜNCEL çözücü çıktısı.
  let tenantDesiValue: number | null = null
  let multiplyByItemQuantity: boolean | null = null
  let resolverDesi: number | null = null
  try {
    const [{ getShipmentDefaults }, { resolveShipmentDesi }, orderRepo] =
      await Promise.all([
        import('../onboarding/shipmentDefaultsRepository.ts'),
        import('./resolveShipmentDesi.ts'),
        import('../orders/orderRepository.ts'),
      ])
    const defaults = await getShipmentDefaults(db, params.organizationId)
    tenantDesiValue = Number(defaults?.defaultUnitDesi ?? 0) || null
    multiplyByItemQuantity = defaults?.multiplyByItemQuantity ?? null

    const orderRow = await orderRepo.findOrderByPackageId(
      db,
      params.organizationId,
      params.marketplace ?? String(job?.marketplace ?? 'Trendyol'),
      params.packageId,
    )
    if (orderRow) {
      const { getOrder } = await import('../orders/orderPersistenceService.ts')
      const order = await getOrder(
        db, params.organizationId, String((orderRow as { id: string }).id),
      )
      const resolution = await resolveShipmentDesi({
        db,
        organizationId: params.organizationId,
        order: (order ?? {}) as Record<string, unknown>,
      })
      resolverDesi = resolution.desi
    } else {
      blockers.push('SIPARIS_BULUNAMADI')
    }
  } catch {
    blockers.push('DESI_COZUMU_OKUNAMADI')
  }
  if (resolverDesi == null) blockers.push('DESI_COZULEMIYOR')
  if (
    tenantDesiValue != null &&
    resolverDesi != null &&
    resolverDesi !== tenantDesiValue
  ) {
    // Ayar ile çözücü çıkmıyorsa create'i açmak yanlış fiyat riskidir.
    blockers.push(`DESI_UYUSMUYOR(ayar=${tenantDesiValue} cozucu=${resolverDesi})`)
  }

  return {
    packageId: params.packageId,
    jobId: job ? String(job.id) : null,
    jobStatusIsBlocked: statusBlocked,
    tenantDesiValue,
    multiplyByItemQuantity,
    resolverDesi,
    readyLabelExists: String(job?.status ?? '') === 'READY',
    carrierArtifactExists,
    unknownAfterNetworkExists:
      String(job?.status ?? '') === 'UNKNOWN_AFTER_NETWORK',
    carrierCallRecorded,
    duplicateJobs: Math.max(0, rows.length - 1),
    safeToReactivate: blockers.length === 0,
    blockers,
  }
}

/**
 * TEK işi `BLOCKED → QUEUED` yapar. Worker'ı ÇALIŞTIRMAZ, Sürat'i ÇAĞIRMAZ.
 *
 * Yalnız `safeToReactivate` ise uygulanır; aksi hâlde hiçbir yazım olmaz.
 */
export async function reactivateSingleJob(
  db: Db,
  params: { organizationId: string; packageId: string; marketplace?: string },
): Promise<{ check: ReactivationCheck; reactivated: boolean; carrierCalls: 0 }> {
  const check = await inspectSingleJobReactivation(db, params)
  if (!check.safeToReactivate || !check.jobId) {
    return { check, reactivated: false, carrierCalls: 0 }
  }
  await db
    .update(labelJobs)
    .set({
      status: 'QUEUED',
      availableAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
      // attemptCount KORUNUR.
    })
    .where(and(eq(labelJobs.id, check.jobId), eq(labelJobs.status, 'BLOCKED')))
  return { check, reactivated: true, carrierCalls: 0 }
}
