// KANARYA ADAYI SEÇİCİ — SALT OKUNUR.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
// Worker KAPALIYKEN kuyrukta işler birikiyor. Global worker'ı açmak, hepsini
// aynı anda taşıyıcıya göndermek demektir. Önce TEK bir paketle kanıt almak
// istiyoruz — ama hangi paketin GÜVENLİ olduğu tahminle seçilemez.
//
// Bu komut kuyruktaki her işi, gerçek create yolunun HER deterministik
// kapısından geçirir ve yalnız RAPORLAR.
//
// ═══ HİÇBİR ŞEY YAPMAZ ═══════════════════════════════════════════════════
// Ağ çağrısı YOK (Trendyol dahil), veritabanı yazımı YOK, taşıyıcı çağrısı
// YOK. Uygunluk kararı KALICI durumdan verilir; pazaryerine canlı sorulmaz.
//
// ═══ İKİNCİ KURAL YOK ════════════════════════════════════════════════════
// Kapılar `preflightLabelJob` üzerinden gelir; o da uygunluk için
// `trendyolShipmentEligibility`, desi için `resolveShipmentDesi`, kimlik
// için kanonik anlık görüntüyü kullanır. Burada yeniden yorum YAPILMAZ.

import { and, eq, inArray } from 'drizzle-orm'
import { labelJobs, shipmentOperations, shipments } from '../db/schema.ts'
import { preflightLabelJob } from './labelJobPreflight.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface CanaryCandidate {
  readonly packageId: string
  readonly jobId: string
  readonly attemptCount: number
  readonly orderNumber: string | null
  readonly currentMarketplaceStatus: string | null

  readonly tenantDesi: number | null
  readonly resolvedDesi: number | null
  readonly suratBirimDesi: number | null

  readonly billingParty: string | null
  readonly expectedWhoPays: number | null
  readonly credentialRole: string | null
  readonly credentialResolved: boolean

  readonly readyLabelExists: boolean
  readonly carrierArtifactExists: boolean
  readonly carrierCallRecorded: boolean
  readonly unknownAfterNetworkEvidence: boolean
  readonly duplicateJob: boolean

  readonly preflightValid: boolean
  readonly wouldCallCarrier: boolean
  readonly blockers: readonly string[]

  readonly safeCanary: boolean
}

export interface CanaryCandidateReport {
  readonly organizationId: string
  readonly queuedTotal: number
  readonly safeCount: number
  readonly candidates: readonly CanaryCandidate[]
  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

export async function selectCanaryCandidates(
  db: Db,
  params: { organizationId: string },
): Promise<CanaryCandidateReport> {
  // YALNIZ KUYRUKTAKİLER. Diğer durumlar aday DEĞİLDİR.
  const queued = (await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.status, 'QUEUED'),
      ),
    )
    .orderBy(labelJobs.createdAt, labelJobs.packageId)) as Record<
    string,
    unknown
  >[]

  // Mükerrer tespiti için kiracının TÜM iş satırları okunur.
  const allJobs = (await db
    .select({
      packageId: labelJobs.packageId,
      status: labelJobs.status,
    })
    .from(labelJobs)
    .where(eq(labelJobs.organizationId, params.organizationId))) as Record<
    string,
    unknown
  >[]
  const jobsPerPackage = new Map<string, number>()
  const statusesPerPackage = new Map<string, string[]>()
  for (const job of allJobs) {
    const key = String(job.packageId ?? '')
    jobsPerPackage.set(key, (jobsPerPackage.get(key) ?? 0) + 1)
    statusesPerPackage.set(key, [
      ...(statusesPerPackage.get(key) ?? []),
      String(job.status ?? ''),
    ])
  }

  const packageIds = queued.map((job) => String(job.packageId ?? ''))
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
  const hasArtifact = new Set(
    shipmentRows.map((row) => String(row.packageId)),
  )

  const candidates: CanaryCandidate[] = []
  for (const job of queued) {
    const packageId = String(job.packageId ?? '')
    const attemptCount = Number(job.attemptCount ?? 0)
    const statuses = statusesPerPackage.get(packageId) ?? []

    const preflight = await preflightLabelJob(db, {
      organizationId: params.organizationId,
      packageId,
      marketplace: String(job.marketplace ?? 'Trendyol'),
    })

    const duplicateJob = (jobsPerPackage.get(packageId) ?? 0) > 1
    const readyLabelExists = statuses.includes('READY')
    const unknownAfterNetworkEvidence = statuses.includes('UNKNOWN_AFTER_NETWORK')
    const carrierArtifactExists = hasArtifact.has(packageId)
    const carrierCallRecorded = carrierCalled.has(packageId)

    // TÜM KOŞULLAR — biri bile sağlanmazsa aday DEĞİL.
    const safeCanary = Boolean(
      String(job.status ?? '') === 'QUEUED' &&
        attemptCount === 0 &&
        !duplicateJob &&
        !carrierCallRecorded &&
        !carrierArtifactExists &&
        !readyLabelExists &&
        !unknownAfterNetworkEvidence &&
        preflight.resolvedDesi != null &&
        preflight.resolvedDesi === preflight.tenantDesi &&
        preflight.credentialResolved &&
        preflight.eligibleForCreate === true &&
        preflight.preflightValid &&
        preflight.wouldCallCarrier,
    )

    candidates.push({
      packageId,
      jobId: String(job.id ?? ''),
      attemptCount,
      orderNumber: preflight.orderNumber,
      currentMarketplaceStatus: preflight.marketplaceStatus,
      tenantDesi: preflight.tenantDesi,
      resolvedDesi: preflight.resolvedDesi,
      suratBirimDesi: preflight.suratBirimDesi,
      billingParty: preflight.billingParty,
      expectedWhoPays: preflight.expectedSuratWhoPays,
      credentialRole: preflight.credentialRole,
      credentialResolved: preflight.credentialResolved,
      readyLabelExists,
      carrierArtifactExists,
      carrierCallRecorded,
      unknownAfterNetworkEvidence,
      duplicateJob,
      preflightValid: preflight.preflightValid,
      wouldCallCarrier: preflight.wouldCallCarrier,
      blockers: preflight.blockers,
      safeCanary,
    })
  }

  // DETERMİNİSTİK SIRA: en güvenliler önce, sonra paket kimliği.
  const sorted = [...candidates].sort((left, right) => {
    if (left.safeCanary !== right.safeCanary) return left.safeCanary ? -1 : 1
    return left.packageId.localeCompare(right.packageId)
  })

  return {
    organizationId: params.organizationId,
    queuedTotal: queued.length,
    safeCount: sorted.filter((candidate) => candidate.safeCanary).length,
    candidates: sorted,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}
