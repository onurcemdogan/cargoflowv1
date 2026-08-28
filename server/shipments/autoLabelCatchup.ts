// TEK SEFERLİK OTOMATİK ETİKET YAKALAMA (CATCH-UP).
//
// ═══ NEDEN AYRI BİR İŞLEM ════════════════════════════════════════════════
// Normal üretici KASITLI olarak yalnız `first_seen_at >= activatedAt`
// paketlerini alır. Bu sınır, bayrak açıldığında geçmiş yığının tamamının
// sıraya girmesini engeller ve KALDIRILMAZ.
//
// Ama aktivasyondan ÖNCE gelmiş, hâlâ AÇIK ve etiket bekleyen siparişler
// bu sınır yüzünden sonsuza dek elle işlenmeyi bekler. Bu, ürün davranışı
// açısından bir boşluktur.
//
// Çözüm sınırı gevşetmek DEĞİL, operatörün AÇIKÇA çalıştırdığı, tek
// organizasyona kilitli, önce SALT-OKUNUR incelenebilen ayrı bir işlemdir.
//
// ═══ NE GEVŞEMEZ ═════════════════════════════════════════════════════════
// Yakalama YALNIZ aktivasyon sınırını atlar. Diğer TÜM kapılar aynen
// uygulanır ve hepsi ÜRETİMDEKİ AYNI fonksiyonlardan gelir:
//   • etiket artefaktı varsa            → HAYIR
//   • taşıyıcı artefaktı varsa          → HAYIR
//   • önceki create denemesi varsa      → HAYIR
//   • ağ sınırı geçilmiş/belirsizse     → HAYIR
//   • kimlik eksik/tutarsızsa           → HAYIR
//   • faturalama/WhoPays çözülemezse    → HAYIR
//   • iptal/iade/teslim edilmişse       → HAYIR
//   • kuyrukta zaten iş varsa           → HAYIR (DB tekilliği)
//
// ═══ BU MODÜL TAŞIYICIYA ÇIKMAZ ══════════════════════════════════════════
// Sürat'i ÇAĞIRMAZ. Yalnız LABEL_PREPARE işi yazar; gerçek create'i
// üretimdeki AYNI worker ve AYNI orkestrasyon yapar.
//
// ═══ ASLA OTOMATİK ÇALIŞMAZ ══════════════════════════════════════════════
// Uygulama açılışına BAĞLANMAZ. Yalnız açık CLI komutuyla ve açık
// organizasyon adıyla çalışır.

import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  labelJobs,
  orders,
  organizations,
  shipmentOperations,
  shipments,
} from '../db/schema.ts'
import {
  resolveAutoLabelEnqueue,
  type AutoLabelScope,
  type AutoLabelSettings,
} from './suratAutoLabelPolicy.ts'
import { resolveSuratCreateEligibility } from './suratCreateEligibility.ts'
import { resolveBillingPartyV2 } from './suratRoutingModel.ts'
import { enqueueLabelJob, LABEL_JOB_TYPE } from './labelJobQueue.ts'
import { loadAutoLabelSettings } from './autoLabelProducer.ts'
import { decryptOrderPayload } from '../orders/orderEncryption.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * "AÇIK / barkod bekliyor" sayılan operasyon durumları.
 *
 * KASITLI OLARAK DAR: yalnız create'in HİÇ denenmediği durumlar. Örneğin
 * `CREATE_ACCEPTED_UNCONFIRMED` veya `LABEL_CREATED_UNVERIFIED` bir
 * denemenin ağ sınırını geçmiş olabileceğini gösterir; bunlar yakalamaya
 * ALINMAZ. Yanlış bir dâhil etmenin bedeli GERİ ALINAMAZ ve
 * FATURALANABİLİR bir etikettir, bu yüzden kapsam dar tutulur.
 */
export const CATCHUP_OPEN_OPERATION_STATUSES: readonly string[] = [
  'NEW',
  'SHIPMENT_PENDING',
]

/** Terminal/işlenmemesi gereken pazaryeri durumları. */
export const CATCHUP_EXCLUDED_MARKETPLACE_STATUSES: readonly string[] = [
  'Delivered', 'Shipped', 'AtCollectionPoint',
  'Cancelled', 'UnSupplied', 'Returned', 'UnDelivered',
]

export type CatchupBlockReason =
  | 'NOT_OPEN_STATUS'
  | 'TERMINAL_MARKETPLACE_STATUS'
  | 'NOT_SALE_DISPOSITION'
  | 'LABEL_ALREADY_READY'
  | 'CARRIER_ARTIFACT_PRESENT'
  | 'PRIOR_CREATE_ATTEMPT'
  | 'UNKNOWN_AFTER_NETWORK'
  | 'ALREADY_QUEUED'
  | 'IDENTITY_INCOMPLETE'
  | 'BILLING_UNRESOLVED'
  | 'POLICY_BLOCKED'

export interface CatchupCandidate {
  readonly packageId: string
  readonly orderNumber: string
  readonly firstSeenAt: string
  readonly providerStatus: string
  readonly localStatus: string
  readonly eligibilityResult: 'ELIGIBLE' | 'BLOCKED'
  readonly reason: string
}

export interface CatchupReport {
  readonly organizationId: string
  readonly organizationName: string
  readonly marketplace: string
  readonly carrier: string
  readonly totalOpen: number
  readonly eligible: number
  readonly blocked: number
  readonly alreadyReady: number
  readonly priorAttempt: number
  readonly unknownAfterNetwork: number
  readonly candidates: readonly CatchupCandidate[]
  /** Salt-okunur incelemede DAİMA 0. */
  readonly networkCalls: number
  readonly dbWrites: number
  readonly carrierCalls: number
}

export async function resolveOrganizationByName(
  db: Db,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db.select().from(organizations)
  const wanted = String(name ?? '').trim().toLocaleLowerCase('tr-TR')
  const match = (rows as { id: string; name: string; slug: string }[]).find(
    (row) =>
      String(row.name ?? '').trim().toLocaleLowerCase('tr-TR') === wanted ||
      String(row.slug ?? '').trim().toLocaleLowerCase('tr-TR') === wanted,
  )
  return match ? { id: match.id, name: match.name } : null
}

interface EvaluationContext {
  readonly settings: AutoLabelSettings | null
  readonly shipmentPackages: Set<string>
  readonly attemptCounts: Map<string, number>
  readonly jobStatuses: Map<string, string>
}

async function loadContext(
  db: Db,
  organizationId: string,
  marketplace: string,
  packageIds: string[],
): Promise<EvaluationContext> {
  const settings = await loadAutoLabelSettings(db, organizationId)
  const shipmentRows = packageIds.length
    ? await db
        .select({ packageId: shipments.packageId })
        .from(shipments)
        .where(
          and(
            eq(shipments.organizationId, organizationId),
            eq(shipments.marketplace, marketplace),
            inArray(shipments.packageId, packageIds),
          ),
        )
    : []
  const operationRows = packageIds.length
    ? await db
        .select()
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, organizationId),
            inArray(shipmentOperations.packageId, packageIds),
          ),
        )
    : []
  const jobRows = packageIds.length
    ? await db
        .select()
        .from(labelJobs)
        .where(
          and(
            eq(labelJobs.organizationId, organizationId),
            inArray(labelJobs.packageId, packageIds),
          ),
        )
    : []

  const attemptCounts = new Map<string, number>()
  for (const row of operationRows as Record<string, unknown>[]) {
    const key = String(row.packageId ?? '')
    // "Denendi mi?" sorusu SAYIYLA değil KANITLA yanıtlanır: taşıyıcı
    // çağrıldıysa veya create sayacı arttıysa deneme VARDIR.
    const attempted =
      row.carrierCreateCalled === true || Number(row.createCallCount ?? 0) > 0
    if (attempted) attemptCounts.set(key, (attemptCounts.get(key) ?? 0) + 1)
  }
  const jobStatuses = new Map<string, string>()
  for (const row of jobRows as Record<string, unknown>[]) {
    jobStatuses.set(String(row.packageId ?? ''), String(row.status ?? ''))
  }
  return {
    settings,
    shipmentPackages: new Set(
      (shipmentRows as { packageId: string }[]).map((row) => String(row.packageId)),
    ),
    attemptCounts,
    jobStatuses,
  }
}

/**
 * TEK paketin yakalamaya uygunluğunu değerlendirir — SAF karar.
 *
 * Uygunluk ve politika kararı ÜRETİMDEKİ fonksiyonlardan gelir; burada
 * ikinci bir kural yazılmaz.
 */
export function evaluateCatchupCandidate(params: {
  row: Record<string, unknown>
  scope: AutoLabelScope
  context: EvaluationContext
}): { eligible: boolean; reason: string; blockReason: CatchupBlockReason | null } {
  const { row, scope, context } = params
  const packageId = String(row.packageId ?? '')
  const localStatus = String(row.operationStatus ?? '')
  const providerStatus = String(row.marketplaceStatus ?? '')

  const deny = (
    blockReason: CatchupBlockReason,
    reason: string,
  ) => ({ eligible: false, reason, blockReason })

  if (!CATCHUP_OPEN_OPERATION_STATUSES.includes(localStatus)) {
    return deny('NOT_OPEN_STATUS', `Açık/barkod bekleyen durum değil (${localStatus}).`)
  }
  if (CATCHUP_EXCLUDED_MARKETPLACE_STATUSES.includes(providerStatus)) {
    return deny(
      'TERMINAL_MARKETPLACE_STATUS',
      `Pazaryeri durumu terminal (${providerStatus}).`,
    )
  }
  // Kanonik sınıflandırma: iptal/iade olan hiçbir paket yakalanmaz.
  if (String(row.salesDisposition ?? 'sale') !== 'sale') {
    return deny(
      'NOT_SALE_DISPOSITION',
      `Satış dışı dispozisyon (${row.salesDisposition}).`,
    )
  }
  const jobStatus = context.jobStatuses.get(packageId)
  if (jobStatus === 'UNKNOWN_AFTER_NETWORK') {
    return deny(
      'UNKNOWN_AFTER_NETWORK',
      'Ağ sınırı geçilmiş ve sonuç belirsiz; tekrar TALEP EDİLMEZ.',
    )
  }
  if (jobStatus === 'READY') {
    return deny('LABEL_ALREADY_READY', 'Etiket zaten hazır.')
  }
  if (jobStatus) {
    return deny('ALREADY_QUEUED', `Kuyrukta iş var (${jobStatus}).`)
  }
  if (context.shipmentPackages.has(packageId)) {
    return deny('CARRIER_ARTIFACT_PRESENT', 'Taşıyıcı artefaktı mevcut.')
  }
  if ((context.attemptCounts.get(packageId) ?? 0) > 0) {
    return deny('PRIOR_CREATE_ATTEMPT', 'Önceki create denemesi var.')
  }

  // ── FATURALAMA / WhoPays ────────────────────────────────────────────
  // Çözülemiyorsa create AÇILMAZ: yanlış tarafa faturalanan bir etiket
  // geri alınamaz.
  let rawOrder: unknown
  try {
    rawOrder = decryptOrderPayload(row.rawPayloadEncrypted as string | null)
  } catch {
    rawOrder = undefined
  }
  const billing = resolveBillingPartyV2(rawOrder ?? {})
  const billingResolved = billing.billingParty !== 'UNKNOWN'
  if (!billingResolved) {
    return deny('BILLING_UNRESOLVED', 'WhoPays çözülemedi.')
  }

  // ── UYGUNLUK: ÜRETİMDEKİ GERÇEK KAPI ────────────────────────────────
  const eligibility = resolveSuratCreateEligibility({
    order: {
      orderNumber: String(row.orderNumber ?? ''),
      packageId,
      cargoTrackingNumber: String(row.cargoTrackingNumber ?? ''),
    },
    // Deneme geçmişi YUKARIDA kanıtla çözüldü; burada 0 olduğu BİLİNİYOR.
    attemptEvidence: { known: true, count: 0 },
  })
  if (!eligibility.eligible) {
    return deny(
      'IDENTITY_INCOMPLETE',
      `Create kapısı reddetti: ${eligibility.reasons.join(', ')}`,
    )
  }

  // ── POLİTİKA: yalnız aktivasyon sınırı atlanır ──────────────────────
  const decision = resolveAutoLabelEnqueue({
    scope,
    packageId,
    settings: context.settings,
    eligibility,
    billingResolved: true,
    credentialResolved: true,
    hasLabelArtifact: false,
    hasCarrierArtifact: false,
    previousNetworkCrossed: false,
    skipActivationBoundary: true,
  })
  if (!decision.enqueue) {
    return deny(
      'POLICY_BLOCKED',
      `Politika reddetti: ${decision.blockReason} — ${decision.reason}`,
    )
  }
  return { eligible: true, reason: 'Uygun.', blockReason: null }
}

/**
 * SALT-OKUNUR inceleme. Hiçbir satır yazılmaz, hiçbir ağ çağrısı yapılmaz.
 */
export async function inspectCatchupCandidates(
  db: Db,
  params: { organizationId: string; organizationName: string; marketplace: string; carrier: string },
): Promise<CatchupReport> {
  const scope: AutoLabelScope = {
    organizationId: params.organizationId,
    marketplace: params.marketplace,
    carrier: params.carrier,
  }
  const openRows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, params.organizationId),
        eq(orders.marketplace, params.marketplace),
        isNull(orders.archivedAt),
        inArray(orders.operationStatus, [...CATCHUP_OPEN_OPERATION_STATUSES]),
      ),
    )
    .orderBy(orders.firstSeenAt)

  const rows = openRows as Record<string, unknown>[]
  const packageIds = rows.map((row) => String(row.packageId ?? ''))
  const context = await loadContext(
    db, params.organizationId, params.marketplace, packageIds,
  )

  const candidates: CatchupCandidate[] = []
  let eligible = 0
  let alreadyReady = 0
  let priorAttempt = 0
  let unknownAfterNetwork = 0

  for (const row of rows) {
    const verdict = evaluateCatchupCandidate({ row, scope, context })
    if (verdict.eligible) eligible += 1
    if (verdict.blockReason === 'LABEL_ALREADY_READY') alreadyReady += 1
    if (verdict.blockReason === 'PRIOR_CREATE_ATTEMPT') priorAttempt += 1
    if (verdict.blockReason === 'UNKNOWN_AFTER_NETWORK') unknownAfterNetwork += 1
    const firstSeen = row.firstSeenAt
    candidates.push({
      packageId: String(row.packageId ?? ''),
      orderNumber: String(row.orderNumber ?? ''),
      firstSeenAt:
        firstSeen instanceof Date ? firstSeen.toISOString() : String(firstSeen ?? ''),
      providerStatus: String(row.marketplaceStatus ?? ''),
      localStatus: String(row.operationStatus ?? ''),
      eligibilityResult: verdict.eligible ? 'ELIGIBLE' : 'BLOCKED',
      reason: verdict.reason,
    })
  }

  return {
    organizationId: params.organizationId,
    organizationName: params.organizationName,
    marketplace: params.marketplace,
    carrier: params.carrier,
    totalOpen: rows.length,
    eligible,
    blocked: rows.length - eligible,
    alreadyReady,
    priorAttempt,
    unknownAfterNetwork,
    candidates,
    networkCalls: 0,
    dbWrites: 0,
    carrierCalls: 0,
  }
}

export interface CatchupEnqueueResult {
  readonly report: CatchupReport
  readonly enqueued: number
  readonly skippedExisting: number
  /** Bu işlem taşıyıcıyı ASLA çağırmaz. */
  readonly carrierCalls: number
}

/**
 * Uygun adayları kuyruğa alır. SÜRAT'İ ÇAĞIRMAZ.
 *
 * Yalnız LABEL_PREPARE işi yazılır; gerçek create üretimdeki aynı worker
 * tarafından yapılır. Tekillik veritabanındadır: ikinci kez çalıştırmak
 * mükerrer iş üretmez.
 */
export async function enqueueCatchupJobs(
  db: Db,
  params: {
    organizationId: string
    organizationName: string
    marketplace: string
    carrier: string
  },
): Promise<CatchupEnqueueResult> {
  const report = await inspectCatchupCandidates(db, params)
  let enqueued = 0
  let skippedExisting = 0
  for (const candidate of report.candidates) {
    if (candidate.eligibilityResult !== 'ELIGIBLE') continue
    const result = await enqueueLabelJob(db, {
      organizationId: params.organizationId,
      marketplace: params.marketplace,
      carrier: params.carrier.toLocaleLowerCase('tr-TR'),
      packageId: candidate.packageId,
    })
    if (result.enqueued) enqueued += 1
    else skippedExisting += 1
  }
  return { report, enqueued, skippedExisting, carrierCalls: 0 }
}

export { LABEL_JOB_TYPE }
