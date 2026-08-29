// KUYRUK NORMALİZASYONU — TEK SEFERLİK, KANIT TEMELLİ DURUM ONARIMI.
//
// ═══ NE OLDU ═════════════════════════════════════════════════════════════
// Üretimde 13 satır `QUEUED` durumda kaldı. Adli inceleme, bunların MEVCUT
// üretici tarafından yaratılmadığını kanıtladı:
//   • 4111722658 `created_at` = 2026-08-29 01:48:57 +03
//   • diğer 12 satır `updated_at` = 2026-08-29 01:34:04 +03
//   • mevcut PM2 süreci (5f366f8) 09:50:03 +03'te başladı
// Yani hepsi ESKİ koddan kalan durum kirliliğidir; mevcut canlandırma
// politikasının regresyonu DEĞİLDİR.
//
// ═══ BU DOSYA NE DEĞİLDİR ════════════════════════════════════════════════
// İş mantığı yeniden tasarımı DEĞİLDİR. Yaşam döngüsü kuralı, hazırlık
// boru hattı ve taşıyıcı kanıt modeli AYNEN kullanılır; burada YENİ kural
// YAZILMAZ. Yapılan tek şey, kirli satırları MEVCUT kuralların söylediği
// duruma taşımaktır.
//
// ═══ TAŞIYICI GÜVENLİĞİ GEVŞETİLMEZ ══════════════════════════════════════
// Ağ sınırına girmiş olabilecek hiçbir satır yorumlanmaz: taşıyıcı çağrısı
// kaydı, artefakt, READY ya da UNKNOWN kanıtı olan satır REDDEDİLİR ve
// dokunulmaz. Bu araç taşıyıcıyı ÇAĞIRMAZ.

import { and, eq, inArray } from 'drizzle-orm'
import { labelJobs, shipmentOperations, shipments } from '../db/schema.ts'
import { prepareLabelJob } from './labelJobPreparation.ts'
import { DEPENDENCY_BLOCKED_CODES } from './labelJobQueue.ts'
import { classifyMarketplaceLifecycle } from './trendyolShipmentEligibility.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const QUEUE_ORIGINS = [
  /** Daha önce denenmiş; eski kod tarafından kuyruğa geri alınmış. */
  'HISTORICAL_POLLUTION',
  /** Hiç denenmemiş ve şu an geçerli — meşru üretici çıktısı. */
  'FRESH_PRODUCER',
  /** Taşıyıcı tarafında sonuç doğmuş olabilir. */
  'NETWORK_TOUCHED',
] as const
export type QueueOrigin = (typeof QUEUE_ORIGINS)[number]

export const NORMALIZATION_VERDICTS = [
  /** Şu an uygun değil → mevcut kesin blokçu ile BLOCKED. */
  'NORMALIZE_TO_BLOCKED_INELIGIBLE',
  /** Hazırlık geçerli ama satır tarihsel; kanaryadan önce BLOCKED'a alınır. */
  'NORMALIZE_TO_BLOCKED_HISTORICAL',
  /** Meşru ve taze; DOKUNULMAZ. */
  'LEAVE_QUEUED_FRESH',
  /** Ağ kanıtı var; ASLA yorumlanmaz. */
  'REFUSED_NETWORK_EVIDENCE',
] as const
export type NormalizationVerdict = (typeof NORMALIZATION_VERDICTS)[number]

export interface QueueNormalizationCandidate {
  readonly packageId: string
  readonly jobId: string
  readonly attemptCount: number
  readonly lastErrorCode: string | null

  readonly marketplaceStatus: string | null
  readonly marketplaceLifecycle: string

  readonly currentPreflightValid: boolean
  readonly currentBlockers: readonly string[]

  readonly carrierCreateCalled: boolean
  readonly carrierArtifactExists: boolean
  readonly readyLabelExists: boolean
  readonly unknownAfterNetworkEvidence: boolean

  readonly currentDesi: number | null
  readonly currentCredentialResolved: boolean

  readonly queueOrigin: QueueOrigin
  readonly verdict: NormalizationVerdict
  /** Uygulanacak hedef durum (yoksa dokunulmaz). */
  readonly targetState: 'BLOCKED' | null
  /** Hedef `last_error_code` — mevcut blokçu ya da KORUNAN tarihsel kod. */
  readonly targetErrorCode: string | null
  readonly safeToNormalize: boolean
  readonly reason: string
}

export interface QueueNormalizationReport {
  readonly organizationId: string
  readonly queuedTotal: number
  readonly safeCount: number
  readonly candidates: readonly QueueNormalizationCandidate[]
  readonly networkCalls: 0
  readonly dbWrites: 0
  readonly carrierCalls: 0
}

/**
 * SALT OKUNUR SINIFLANDIRMA — uygulama da AYNI bu fonksiyonu kullanır.
 *
 * İnceleme ile mutasyonun ayrışması, bu alt sistemde defalarca üretim
 * olayına yol açtı; bu yüzden tek sınıflandırıcı vardır.
 */
export async function inspectQueueNormalization(
  db: Db,
  params: { organizationId: string },
): Promise<QueueNormalizationReport> {
  const queued = (await db
    .select()
    .from(labelJobs)
    .where(
      and(
        eq(labelJobs.organizationId, params.organizationId),
        eq(labelJobs.status, 'QUEUED'),
      ),
    )
    .orderBy(labelJobs.packageId)) as Record<string, unknown>[]

  const packageIds = queued.map((job) => String(job.packageId ?? ''))
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

  const candidates: QueueNormalizationCandidate[] = []
  for (const job of queued) {
    const packageId = String(job.packageId ?? '')
    const marketplace = String(job.marketplace ?? 'Trendyol')
    const attemptCount = Number(job.attemptCount ?? 0)
    const lastErrorCode = job.lastErrorCode ? String(job.lastErrorCode) : null

    const ops = operations.filter(
      (operation) => String(operation.packageId) === packageId,
    )
    const carrierCreateCalled = ops.some(
      (operation) => operation.carrierCreateCalled === true,
    )
    const operationUnknown = ops.some(
      (operation) => String(operation.status ?? '') === 'unknown',
    )
    const carrierArtifactExists = hasArtifact.has(packageId)
    const statuses = statusesByPackage.get(packageId) ?? []
    const readyLabelExists = statuses.includes('READY')
    const unknownAfterNetworkEvidence = statuses.includes('UNKNOWN_AFTER_NETWORK')

    const prepared = await prepareLabelJob(db, {
      organizationId: params.organizationId, packageId, marketplace,
    })
    const lifecycle = prepared.order
      ? classifyMarketplaceLifecycle(prepared.order).lifecycle
      : 'UNKNOWN'

    let queueOrigin: QueueOrigin
    let verdict: NormalizationVerdict
    let targetState: 'BLOCKED' | null = null
    let targetErrorCode: string | null = null
    let safeToNormalize = false
    let reason: string

    if (
      carrierCreateCalled || carrierArtifactExists
      || readyLabelExists || unknownAfterNetworkEvidence || operationUnknown
    ) {
      // ═══ ASLA YORUMLANMAZ ═════════════════════════════════════════════
      queueOrigin = 'NETWORK_TOUCHED'
      verdict = 'REFUSED_NETWORK_EVIDENCE'
      reason =
        'Taşıyıcı tarafında sonuç doğmuş olabilir; bu satır otomatik '
        + 'yorumlanmaz ve DOKUNULMAZ.'
    } else if (!prepared.ok) {
      // ═══ A — ŞU AN UYGUN DEĞİL ════════════════════════════════════════
      queueOrigin = attemptCount > 0 ? 'HISTORICAL_POLLUTION' : 'FRESH_PRODUCER'
      verdict = 'NORMALIZE_TO_BLOCKED_INELIGIBLE'
      targetState = 'BLOCKED'
      // MEVCUT kesin blokçu yazılır; uydurma kod YOK.
      targetErrorCode = prepared.blockerCode
      safeToNormalize = true
      reason =
        `Şu anki hazırlık GEÇERSİZ (${prepared.blockerCode}); `
        + 'kuyrukta kalmamalı. Taşıyıcı kanıtı temiz.'
    } else if (attemptCount > 0) {
      // ═══ B — TARİHSEL SATIR, BAĞIMLILIK ARTIK ÇÖZÜLMÜŞ ════════════════
      //
      // Hazırlık geçerli ama satır ESKİ kod tarafından kuyruğa alınmıştı.
      // Taze kanaryada işlenmemeli. Tarihsel blokçu KORUNUR ki canlandırma
      // aracı bunları `SAFE_TO_REVIVE` olarak TANIYABİLSİN.
      queueOrigin = 'HISTORICAL_POLLUTION'
      verdict = 'NORMALIZE_TO_BLOCKED_HISTORICAL'
      targetState = 'BLOCKED'
      targetErrorCode =
        lastErrorCode && DEPENDENCY_BLOCKED_CODES.includes(lastErrorCode)
          ? lastErrorCode
          // Kod kaybolmuşsa bağımlılık sınıfı KESİN kod yazılır; aksi hâlde
          // satır canlandırma aracınca hiç görülemezdi.
          : 'SURAT_PREFLIGHT_DESI_MISSING'
      safeToNormalize = true
      reason =
        'Tarihsel kuyruk kirliliği (attempt>0). Hazırlık şu an geçerli; '
        + 'kanaryadan sonra canlandırma aracıyla açıkça değerlendirilecek.'
    } else {
      // ═══ C — TAZE ve MEŞRU ════════════════════════════════════════════
      queueOrigin = 'FRESH_PRODUCER'
      verdict = 'LEAVE_QUEUED_FRESH'
      reason =
        'Hiç denenmemiş (attempt=0) ve hazırlık GEÇERLİ: meşru üretici '
        + 'çıktısı. DOKUNULMAZ.'
    }

    candidates.push({
      packageId,
      jobId: String(job.id ?? ''),
      attemptCount,
      lastErrorCode,
      marketplaceStatus: prepared.marketplaceStatus,
      marketplaceLifecycle: lifecycle,
      currentPreflightValid: prepared.ok,
      currentBlockers: prepared.blockers,
      carrierCreateCalled,
      carrierArtifactExists,
      readyLabelExists,
      unknownAfterNetworkEvidence,
      currentDesi: prepared.resolvedDesi,
      currentCredentialResolved: prepared.credentialSnapshot.resolved,
      queueOrigin,
      verdict,
      targetState,
      targetErrorCode,
      safeToNormalize,
      reason,
    })
  }

  return {
    organizationId: params.organizationId,
    queuedTotal: queued.length,
    safeCount: candidates.filter((candidate) => candidate.safeToNormalize).length,
    candidates,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}

export interface AppliedNormalization {
  readonly packageId: string
  readonly from: string
  readonly to: string
  readonly oldError: string | null
  readonly newError: string | null
  readonly attemptCount: number
  readonly reason: string
}

export interface QueueNormalizationResult {
  readonly report: QueueNormalizationReport
  readonly applied: readonly AppliedNormalization[]
  readonly normalized: number
  readonly skipped: number
  readonly carrierCalls: 0
  readonly networkCalls: 0
}

/**
 * MUTASYON — YALNIZ sınıflandırıcının GÜVENLİ dediği satırlar.
 *
 * Tek işlemde (transaction) çalışır. Her güncelleme KOŞULLUDUR: durum hâlâ
 * `QUEUED` değilse 0 satır etkilenir. İkinci çalıştırma 0 yazım üretir.
 * Yeni iş YARATILMAZ, yeni operasyon YARATILMAZ, `attempt_count` ve
 * `created_at` KORUNUR, taşıyıcı ÇAĞRILMAZ.
 */
export async function applyQueueNormalization(
  db: Db,
  params: { organizationId: string; packageIds?: readonly string[] },
): Promise<QueueNormalizationResult> {
  const report = await inspectQueueNormalization(db, {
    organizationId: params.organizationId,
  })
  const requested = params.packageIds?.length ? new Set(params.packageIds) : null

  const applied: AppliedNormalization[] = []
  let skipped = 0

  const run = async (tx: Db) => {
    for (const candidate of report.candidates) {
      const wanted = !requested || requested.has(candidate.packageId)
      if (!wanted || !candidate.safeToNormalize || !candidate.targetState) {
        skipped += 1
        continue
      }
      const updated = await tx
        .update(labelJobs)
        .set({
          status: candidate.targetState,
          lastErrorCode: candidate.targetErrorCode,
          // Kilit alanları YALNIZ doluysa temizlenir; `QUEUED` satırda
          // zaten boş olmalıdır.
          lockedAt: null,
          lockedBy: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(labelJobs.id, candidate.jobId),
            eq(labelJobs.organizationId, params.organizationId),
            eq(labelJobs.packageId, candidate.packageId),
            // KOŞUL GÜNCELLEMENİN İÇİNDE: ikinci çalıştırma 0 satır bulur.
            eq(labelJobs.status, 'QUEUED'),
          ),
        )
        .returning({ id: labelJobs.id })
      if ((updated as unknown[]).length === 1) {
        applied.push({
          packageId: candidate.packageId,
          from: 'QUEUED',
          to: candidate.targetState,
          oldError: candidate.lastErrorCode,
          newError: candidate.targetErrorCode,
          attemptCount: candidate.attemptCount,
          reason: candidate.reason,
        })
      } else {
        skipped += 1
      }
    }
  }

  if (typeof db.transaction === 'function') {
    await db.transaction(run)
  } else {
    await run(db)
  }

  return {
    report,
    applied,
    normalized: applied.length,
    skipped,
    carrierCalls: 0,
    networkCalls: 0,
  }
}
