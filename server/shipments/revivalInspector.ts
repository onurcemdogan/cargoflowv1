// CANLANDIRMA İNCELEYİCİSİ — SALT OKUNUR.
//
// ═══ NEDEN ═══════════════════════════════════════════════════════════════
// Üretimde `BLOCKED` satırlar yalnız "paket yeniden görüldü" diye QUEUED'e
// çekildi: `Shipped` (4110043440 · attempt 37) ve `Created` paketler
// uyandırıldı, worker onları hemen yeniden bloke etti — durum çalkantısı.
//
// Bu araç, HER bloke satır için "şimdi canlandırılabilir mi?" sorusunu
// MUTASYONSUZ yanıtlar ve gerekçeyi açıkça yazar.
//
// Karar OTORİTESİ paylaşılan hazırlıktır (`prepareLabelJob`); burada ikinci
// bir kural YAZILMAZ.

import { and, eq, inArray } from 'drizzle-orm'
import { labelJobs, shipmentOperations, shipments } from '../db/schema.ts'
import { prepareLabelJob } from './labelJobPreparation.ts'
import { DEPENDENCY_BLOCKED_CODES } from './labelJobQueue.ts'
import { classifyMarketplaceLifecycle } from './trendyolShipmentEligibility.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface RevivalCandidate {
  readonly packageId: string
  readonly jobId: string
  readonly jobStatus: string
  readonly attemptCount: number
  readonly lastErrorCode: string | null
  readonly marketplaceStatus: string | null
  readonly marketplaceLifecycle: string

  readonly carrierCreateCalled: boolean
  readonly artifact: boolean
  readonly unknownEvidence: boolean

  readonly currentPreflightValid: boolean
  readonly currentBlockers: readonly string[]

  readonly revivalReason: string
  readonly safeToRevive: boolean
}

export interface RevivalReport {
  readonly organizationId: string
  readonly blockedTotal: number
  readonly safeCount: number
  readonly candidates: readonly RevivalCandidate[]
  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

export async function inspectRevivalCandidates(
  db: Db,
  params: { organizationId: string },
): Promise<RevivalReport> {
  // YALNIZ `BLOCKED`. READY / UNKNOWN_AFTER_NETWORK / PREPARING satırlar
  // canlandırma konusu DEĞİLDİR ve sorgulanmaz bile.
  const blocked = (await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.status, 'BLOCKED'),
      ),
    )
    .orderBy(labelJobs.packageId)) as Record<string, unknown>[]

  const packageIds = blocked.map((job) => String(job.packageId ?? ''))
  const operations = packageIds.length
    ? ((await db
        .select({
          packageId: shipmentOperations.packageId,
          carrierCreateCalled: shipmentOperations.carrierCreateCalled,
          status: shipmentOperations.status,
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

  const candidates: RevivalCandidate[] = []
  for (const job of blocked) {
    const packageId = String(job.packageId ?? '')
    const marketplace = String(job.marketplace ?? 'Trendyol')
    const lastErrorCode = job.lastErrorCode ? String(job.lastErrorCode) : null
    const ops = operations.filter(
      (operation) => String(operation.packageId) === packageId,
    )
    const carrierCreateCalled = ops.some(
      (operation) => operation.carrierCreateCalled === true,
    )
    const artifact = hasArtifact.has(packageId)
    const statuses = statusesByPackage.get(packageId) ?? []
    const unknownEvidence = statuses.includes('UNKNOWN_AFTER_NETWORK')

    const prepared = await prepareLabelJob(db, {
      organizationId: params.organizationId, packageId, marketplace,
    })
    const lifecycle = prepared.order
      ? classifyMarketplaceLifecycle(prepared.order).lifecycle
      : 'UNKNOWN'

    let safeToRevive = false
    let revivalReason: string
    if (carrierCreateCalled) {
      revivalReason = 'Taşıyıcı çağrısı kaydı var; ASLA canlandırılmaz.'
    } else if (artifact) {
      revivalReason = 'Taşıyıcı artefaktı mevcut; ASLA canlandırılmaz.'
    } else if (unknownEvidence) {
      revivalReason = 'Bu paket için ağ belirsizliği kaydı var; canlandırılmaz.'
    } else if (lifecycle === 'TERMINAL') {
      revivalReason = 'Pazaryeri yaşam döngüsü TERMINAL; yeni create açılmaz.'
    } else if (!lastErrorCode || !DEPENDENCY_BLOCKED_CODES.includes(lastErrorCode)) {
      revivalReason = `Bloklayıcı kod bağımlılık sınıfı değil (${lastErrorCode ?? 'yok'}).`
    } else if (!prepared.ok) {
      revivalReason = `Bağımlılık HÂLÂ çözülmedi: ${prepared.blockerCode}. BLOKE kalır.`
    } else {
      safeToRevive = true
      revivalReason = 'Bağımlılık ÇÖZÜLDÜ ve taşıyıcı kanıtı temiz; canlandırılabilir.'
    }

    candidates.push({
      packageId,
      jobId: String(job.id ?? ''),
      jobStatus: String(job.status ?? ''),
      attemptCount: Number(job.attemptCount ?? 0),
      lastErrorCode,
      marketplaceStatus: prepared.marketplaceStatus,
      marketplaceLifecycle: lifecycle,
      carrierCreateCalled,
      artifact,
      unknownEvidence,
      currentPreflightValid: prepared.ok,
      currentBlockers: prepared.blockers,
      revivalReason,
      safeToRevive,
    })
  }

  return {
    organizationId: params.organizationId,
    blockedTotal: blocked.length,
    safeCount: candidates.filter((candidate) => candidate.safeToRevive).length,
    candidates,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}
