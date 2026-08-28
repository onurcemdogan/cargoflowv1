// BLOKE İŞ KURTARMA — SALT OKUNUR İNCELEME + AÇIK YENİDEN ETKİNLEŞTİRME.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
// Genel worker parite kusuru yüzünden AĞDAN ÖNCE bloke olmuş satırlar var
// (desi hazırlıkta çözülmüyordu). Bağımlılık artık sağlandığında bu satırlar
// güvenle sıraya alınabilir — ama SEÇİMİ İNSAN YAPAR ve yalnız KANITLANMIŞ
// satırlar açılır.
//
// ═══ İZ DEPOSU KANIT DEĞİLDİR ════════════════════════════════════════════
// `surat_trace_attempts` paket başına deterministik `traceId` kullanır ve
// yazım `onConflictDoNothing`'dir: bazı tarihsel yollarda YALNIZ İLK deneme
// saklanır. Bu yüzden "yeni iz yok" bir şeyin KANITI DEĞİLDİR ve ASLA
// retry izni sayılmaz. Otoriter ve mutasyonsuz kaynak
// `shipment_operations.carrier_create_called`'dır.
//
// ═══ DOKUNULMAZLAR ═══════════════════════════════════════════════════════
// `UNKNOWN_AFTER_NETWORK`, `READY` ve taşıyıcı çağrısı kanıtlı satırlar
// İNCELENİR ama ASLA açılmaz. Mükerrer iş YARATILMAZ: mevcut satır
// yeniden kuyruğa alınır.

import { and, eq, inArray } from 'drizzle-orm'
import { labelJobs, shipmentOperations, shipments } from '../db/schema.ts'
import { prepareLabelJob } from './labelJobPreparation.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** AĞDAN ÖNCE olduğu KESİN olan bloklayıcı kodlar. */
const PRE_NETWORK_BLOCKED_CODES: readonly string[] = [
  'SURAT_PREFLIGHT_DESI_MISSING',
  'SURAT_CREDENTIAL_CONFIG_INVALID',
  'SURAT_PREFLIGHT_FAILED',
  'PRIMARY_CREDENTIAL_NOT_CONFIGURED',
  'TRENDYOL_CARGO_NOT_ELIGIBLE_STATUS',
  'TRENDYOL_PICKING_UPDATE_FAILED',
]

export interface BlockedJobCandidate {
  readonly packageId: string
  readonly jobId: string
  readonly status: string
  readonly attemptCount: number
  readonly lastErrorCode: string | null
  readonly carrierCalled: boolean
  readonly artifact: boolean
  readonly currentResolvedDesi: number | null
  readonly currentEligibility: boolean | null
  readonly currentBlockerCode: string | null
  readonly safeToReactivate: boolean
  readonly reason: string
}

export interface BlockedJobReport {
  readonly organizationId: string
  readonly blockedTotal: number
  readonly safeCount: number
  readonly candidates: readonly BlockedJobCandidate[]
  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

export async function inspectBlockedJobs(
  db: Db,
  params: { organizationId: string },
): Promise<BlockedJobReport> {
  // YALNIZ `BLOCKED`. `UNKNOWN_AFTER_NETWORK` ve `READY` SORGULANMAZ bile.
  const blocked = (await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.status, 'BLOCKED'),
      ),
    )
    .orderBy(labelJobs.createdAt, labelJobs.packageId)) as Record<string, unknown>[]

  const packageIds = blocked.map((job) => String(job.packageId ?? ''))
  const operations = packageIds.length
    ? ((await db
        .select({
          packageId: shipmentOperations.packageId,
          carrierCreateCalled: shipmentOperations.carrierCreateCalled,
        })
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, params.organizationId),
            inArray(shipmentOperations.packageId, packageIds),
          ),
        )) as Record<string, unknown>[])
    : []
  const carrierCalled = new Set(
    operations
      .filter((operation) => operation.carrierCreateCalled === true)
      .map((operation) => String(operation.packageId)),
  )
  const shipmentRows = packageIds.length
    ? ((await db
        .select({ packageId: shipments.packageId })
        .from(shipments)
        .where(
          and(
            eq(shipments.organizationId, params.organizationId),
            inArray(shipments.packageId, packageIds),
          ),
        )) as Record<string, unknown>[])
    : []
  const hasArtifact = new Set(shipmentRows.map((row) => String(row.packageId)))

  // Mükerrer tespiti.
  const allJobs = (await db
    .select({ packageId: labelJobs.packageId })
    .from(labelJobs)
    .where(eq(labelJobs.organizationId, params.organizationId))) as Record<
    string,
    unknown
  >[]
  const perPackage = new Map<string, number>()
  for (const job of allJobs) {
    const key = String(job.packageId ?? '')
    perPackage.set(key, (perPackage.get(key) ?? 0) + 1)
  }

  const candidates: BlockedJobCandidate[] = []
  for (const job of blocked) {
    const packageId = String(job.packageId ?? '')
    const lastErrorCode = job.lastErrorCode ? String(job.lastErrorCode) : null
    const called = carrierCalled.has(packageId)
    const artifact = hasArtifact.has(packageId)
    const duplicate = (perPackage.get(packageId) ?? 0) > 1

    // GÜNCEL bağımlılık durumu — AYNI paylaşılan hazırlık.
    const prepared = await prepareLabelJob(db, {
      organizationId: params.organizationId,
      packageId,
      marketplace: String(job.marketplace ?? 'Trendyol'),
    })

    // Her dal atama yapar; ölü başlangıç değeri VERİLMEZ.
    let safeToReactivate = false
    let reason: string
    if (called) {
      reason = 'Operasyonel kayıt taşıyıcı çağrısı gösteriyor; DOKUNULMAZ.'
    } else if (artifact) {
      reason = 'Taşıyıcı artefaktı mevcut; DOKUNULMAZ.'
    } else if (duplicate) {
      reason = 'Bu paket için birden fazla iş satırı var; elle incelenmeli.'
    } else if (!lastErrorCode || !PRE_NETWORK_BLOCKED_CODES.includes(lastErrorCode)) {
      // Kod ağdan önce olduğunu KANITLAMIYORSA açılmaz.
      reason = `Bloklayıcı kod ağ-öncesi olduğunu kanıtlamıyor (${lastErrorCode ?? 'yok'}).`
    } else if (!prepared.ok) {
      reason = `Bağımlılık hâlâ sağlanmıyor: ${prepared.blockerCode}.`
    } else {
      safeToReactivate = true
      reason = 'Taşıyıcıya çıkılmadığı kanıtlı ve güncel hazırlık GEÇERLİ.'
    }

    candidates.push({
      packageId,
      jobId: String(job.id ?? ''),
      status: String(job.status ?? ''),
      attemptCount: Number(job.attemptCount ?? 0),
      lastErrorCode,
      carrierCalled: called,
      artifact,
      currentResolvedDesi: prepared.resolvedDesi,
      currentEligibility: prepared.eligibleForCreate,
      currentBlockerCode: prepared.blockerCode,
      safeToReactivate,
      reason,
    })
  }

  return {
    organizationId: params.organizationId,
    blockedTotal: blocked.length,
    safeCount: candidates.filter((candidate) => candidate.safeToReactivate).length,
    candidates,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}

export interface ReactivationResult {
  readonly report: BlockedJobReport
  readonly reactivated: number
  readonly skipped: number
  readonly carrierCalls: 0
}

/**
 * AÇIK MUTASYON — yalnız KANITLANMIŞ satırlar.
 *
 * Worker ÇALIŞTIRILMAZ, taşıyıcı ÇAĞRILMAZ. Satır SİLİNMEZ, yenisi
 * YARATILMAZ: AYNI iş kimliği `QUEUED`'e döner ve `attempt_count`
 * tarihsel kanıt olarak KORUNUR.
 */
export async function reactivateBlockedJobs(
  db: Db,
  params: { organizationId: string; packageIds?: readonly string[] },
): Promise<ReactivationResult> {
  const report = await inspectBlockedJobs(db, { organizationId: params.organizationId })
  const requested = params.packageIds ? new Set(params.packageIds) : null

  let reactivated = 0
  let skipped = 0
  for (const candidate of report.candidates) {
    const wanted = !requested || requested.has(candidate.packageId)
    if (!wanted || !candidate.safeToReactivate) {
      skipped += 1
      continue
    }
    // Koşul güncellemenin İÇİNDEDİR: yarışta ikinci çalıştırma 0 satır alır.
    const updated = await db
      .update(labelJobs)
      .set({
        status: 'QUEUED',
        lockedAt: null,
        lockedBy: null,
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(labelJobs.id, candidate.jobId),
          eq(labelJobs.organizationId, params.organizationId),
          eq(labelJobs.packageId, candidate.packageId),
          eq(labelJobs.status, 'BLOCKED'),
        ),
      )
      .returning({ id: labelJobs.id })
    if ((updated as unknown[]).length === 1) reactivated += 1
    else skipped += 1
  }

  return { report, reactivated, skipped, carrierCalls: 0 }
}
