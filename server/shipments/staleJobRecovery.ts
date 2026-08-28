// BAYAT `PREPARING` İNCELEME + AÇIK KURTARMA.
//
// Süreç `PREPARING` sırasında ölürse iş kilitli kalır. Kurtarma kararı
// SÜREYE değil TAŞIYICI KANITINA dayanır (`stalePreparingClassifier`).
//
// Bu modül taşıyıcıyı ÇAĞIRMAZ ve worker'ı ÇALIŞTIRMAZ.

import { and, eq, inArray } from 'drizzle-orm'
import { labelJobs, shipmentOperations, shipments } from '../db/schema.ts'
import { prepareLabelJob } from './labelJobPreparation.ts'
import {
  classifyStalePreparing,
  type StaleClassification,
} from './stalePreparingClassifier.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Kilit bu süreden sonra BAYAT sayılır (yalnız bayatlık; izin değil). */
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000

export interface StaleJobCandidate {
  readonly packageId: string
  readonly jobId: string
  readonly attemptCount: number
  readonly lockedAt: string | null
  readonly lockedBy: string | null
  readonly lockAgeSeconds: number | null

  readonly operationStatus: string | null
  readonly createCallCount: number
  readonly carrierCreateCalled: boolean

  readonly readyLabelExists: boolean
  readonly carrierArtifactExists: boolean
  readonly unknownAfterNetworkEvidence: boolean

  readonly currentResolvedDesi: number | null
  readonly currentEligibility: boolean | null
  readonly currentPreflightValid: boolean

  readonly verdict: StaleClassification['verdict']
  readonly targetStatus: StaleClassification['targetStatus']
  readonly safeToRecover: boolean
  readonly reason: string
}

export interface StaleJobReport {
  readonly organizationId: string
  readonly preparingTotal: number
  readonly safeCount: number
  readonly candidates: readonly StaleJobCandidate[]
  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

export async function inspectStaleJobs(
  db: Db,
  params: { organizationId: string; staleAfterMs?: number; now?: () => number },
): Promise<StaleJobReport> {
  const now = params.now ?? (() => Date.now())
  const staleAfterMs = Number(params.staleAfterMs ?? DEFAULT_STALE_LOCK_MS)

  const preparing = (await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.status, 'PREPARING'),
      ),
    )
    .orderBy(labelJobs.lockedAt, labelJobs.packageId)) as Record<string, unknown>[]

  const packageIds = preparing.map((job) => String(job.packageId ?? ''))
  const operations = packageIds.length
    ? ((await db
        .select({
          packageId: shipmentOperations.packageId,
          status: shipmentOperations.status,
          createCallCount: shipmentOperations.createCallCount,
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
  const artifacts = packageIds.length
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
  const hasArtifact = new Set(artifacts.map((row) => String(row.packageId)))

  // Aynı paket için BAŞKA iş satırlarının durumu (READY / UNKNOWN kanıtı).
  const siblings = (await db
    .select({ packageId: labelJobs.packageId, status: labelJobs.status })
    .from(labelJobs)
    .where(eq(labelJobs.organizationId, params.organizationId))) as Record<
    string,
    unknown
  >[]
  const statusesByPackage = new Map<string, string[]>()
  for (const row of siblings) {
    const key = String(row.packageId ?? '')
    statusesByPackage.set(key, [
      ...(statusesByPackage.get(key) ?? []),
      String(row.status ?? ''),
    ])
  }

  const candidates: StaleJobCandidate[] = []
  for (const job of preparing) {
    const packageId = String(job.packageId ?? '')
    const ops = operations.filter(
      (operation) => String(operation.packageId) === packageId,
    )
    const carrierCreateCalled = ops.some(
      (operation) => operation.carrierCreateCalled === true,
    )
    const createCallCount = ops.reduce(
      (total, operation) => total + Number(operation.createCallCount ?? 0),
      0,
    )
    const statuses = statusesByPackage.get(packageId) ?? []
    const lockedAtRaw = job.lockedAt ? new Date(String(job.lockedAt)) : null
    const lockAgeMs = lockedAtRaw ? now() - lockedAtRaw.getTime() : null

    const prepared = await prepareLabelJob(db, {
      organizationId: params.organizationId,
      packageId,
      marketplace: String(job.marketplace ?? 'Trendyol'),
    })

    const classification = classifyStalePreparing({
      status: String(job.status ?? ''),
      lockedAt: lockedAtRaw,
      lockAgeMs,
      staleAfterMs,
      carrierCreateCalled,
      createCallCount,
      carrierArtifactExists: hasArtifact.has(packageId),
      readyLabelExists: statuses.includes('READY'),
      unknownAfterNetworkEvidence: statuses.includes('UNKNOWN_AFTER_NETWORK'),
      preparationValid: prepared.ok,
    })

    candidates.push({
      packageId,
      jobId: String(job.id ?? ''),
      attemptCount: Number(job.attemptCount ?? 0),
      lockedAt: lockedAtRaw ? lockedAtRaw.toISOString() : null,
      lockedBy: job.lockedBy ? String(job.lockedBy) : null,
      lockAgeSeconds: lockAgeMs == null ? null : Math.floor(lockAgeMs / 1000),
      operationStatus: ops[0] ? String(ops[0].status) : null,
      createCallCount,
      carrierCreateCalled,
      readyLabelExists: statuses.includes('READY'),
      carrierArtifactExists: hasArtifact.has(packageId),
      unknownAfterNetworkEvidence: statuses.includes('UNKNOWN_AFTER_NETWORK'),
      currentResolvedDesi: prepared.resolvedDesi,
      currentEligibility: prepared.eligibleForCreate,
      currentPreflightValid: prepared.ok,
      verdict: classification.verdict,
      targetStatus: classification.targetStatus,
      safeToRecover: classification.safeToRecover,
      reason: classification.reason,
    })
  }

  return {
    organizationId: params.organizationId,
    preparingTotal: preparing.length,
    safeCount: candidates.filter((candidate) => candidate.safeToRecover).length,
    candidates,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}

export interface StaleRecoveryResult {
  readonly report: StaleJobReport
  readonly recovered: number
  readonly skipped: number
  readonly carrierCalls: 0
}

/**
 * AÇIK KURTARMA — YALNIZ verilen paketler ve YALNIZ güvenli olanlar.
 *
 * Taşıyıcı ÇAĞRILMAZ. Yeni iş satırı YARATILMAZ. `attempt_count`
 * KORUNUR (sıfırlanmaz, azaltılmaz). Bayat kilit alanları TEMİZLENİR.
 */
export async function recoverStaleJobs(
  db: Db,
  params: {
    organizationId: string
    packageIds: readonly string[]
    staleAfterMs?: number
    now?: () => number
  },
): Promise<StaleRecoveryResult> {
  const report = await inspectStaleJobs(db, {
    organizationId: params.organizationId,
    staleAfterMs: params.staleAfterMs,
    now: params.now,
  })
  const requested = new Set(params.packageIds)

  let recovered = 0
  let skipped = 0
  for (const candidate of report.candidates) {
    if (!requested.has(candidate.packageId) || !candidate.safeToRecover) {
      skipped += 1
      continue
    }
    // Koşul güncellemenin İÇİNDEDİR: durum hâlâ PREPARING değilse 0 satır.
    const updated = await db
      .update(labelJobs)
      .set({
        status: candidate.targetStatus,
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
          eq(labelJobs.status, 'PREPARING'),
        ),
      )
      .returning({ id: labelJobs.id })
    if ((updated as unknown[]).length === 1) recovered += 1
    else skipped += 1
  }

  return { report, recovered, skipped, carrierCalls: 0 }
}
