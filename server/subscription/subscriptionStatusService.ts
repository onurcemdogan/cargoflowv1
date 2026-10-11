// TİCARİ DURUM SERVİSİ — SALT OKUNUR, KİRACI KAPSAMLI.
//
// Plan hakkı ile bağlantı sağlığı AYRI modellerdir ve burada BİRLEŞTİRİLMEZ;
// yalnız AYNI KARARDA yan yana kullanılırlar. Sağlık yeniden hesaplanmaz,
// `integrationHealth` çıktısı GİRDİ olarak alınır.
//
// Yanıt sır TAŞIMAZ: kimlik bilgisi, sağlayıcı token'ı, ham hata metni ve
// ödeme verisi (ki yok) buraya GİRMEZ.
import {
  resolveFeatureAccess,
  NOT_YET_METERED,
  type FeatureAccessResult,
  type UsageReading,
} from './featureAccess.ts'
import {
  BILLABLE_CAPABILITIES,
  planDefinition,
  type BillableCapability,
} from './planCatalog.ts'
import {
  loadPlanAssignment,
  loadUsageSnapshot,
  type PlanAssignment,
  type UsageMetric,
  type UsageSnapshot,
} from './planRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Yeteneğin kullanım metriğine bağlanması — limit ölçümü buradan gelir. */
const CAPABILITY_USAGE: Partial<Record<BillableCapability, UsageMetric>> = {
  'connections.marketplace': 'connections.marketplace',
  'connections.carrier': 'connections.carrier',
}

export interface SubscriptionStatus {
  plan: {
    /** Bozuk atamada `null` — uydurma plan gösterilmez. */
    planId: string | null
    displayName: string
    legacy: boolean
    assignable: boolean
    assignedAt: string | null
    assignedBy: string | null
    resolution: string
    /** Yapılandırma hatası varsa KARARLI kod; yoksa null. */
    errorCode: string | null
    invalidPlanId: string | null
  }
  access: FeatureAccessResult[]
  usage: Record<string, UsageReading>
  measuredAt: string
}

export interface SubscriptionStatusOptions {
  nowMs: number
  /**
   * Sağlayıcı/yayın gerçeği — `integrationHealth` ve connector kernel
   * ÇIKTISI. Verilmezse bu boyutlar karara GİRMEZ (ticari karar yalnız
   * plan+kullanım üzerinden verilir).
   */
  productSupported?: Partial<Record<BillableCapability, boolean>>
  rolloutLive?: Partial<Record<BillableCapability, boolean>>
  connectionOperational?: Partial<Record<BillableCapability, boolean>>
  /** Ek talep (ör. "bir hesap daha ekleyebilir miyim"). */
  requested?: Partial<Record<BillableCapability, number>>
}

export async function loadSubscriptionStatus(
  db: Db,
  organizationId: string,
  options: SubscriptionStatusOptions,
): Promise<SubscriptionStatus> {
  const [assignment, usage] = await Promise.all([
    loadPlanAssignment(db, organizationId),
    loadUsageSnapshot(db, organizationId, { nowMs: options.nowMs }),
  ])
  return buildSubscriptionStatus(assignment, usage, options)
}

/** SAF birleştirme — testte DB olmadan da çağrılabilir. */
export function buildSubscriptionStatus(
  assignment: PlanAssignment,
  usage: UsageSnapshot,
  options: SubscriptionStatusOptions,
): SubscriptionStatus {
  // ── BOZUK ATAMA: FAIL-CLOSED ──────────────────────────────────────────
  //
  // Açıkça yazılmış ama tanınmayan plan (ör. `tier_standrad` yazım hatası)
  // NE sınırsız geçiş durumuna NE de kısıtlayıcı bir plana çevrilir. Ticari
  // hak VERİLMEZ ve yapılandırma hatası UI'da görünür olur.
  if (assignment.resolution === 'INVALID_ASSIGNMENT' || assignment.planId === null) {
    return {
      plan: {
        planId: null,
        displayName: 'Plan yapılandırması geçersiz',
        legacy: false,
        assignable: false,
        assignedAt: assignment.assignedAt,
        assignedBy: assignment.assignedBy,
        resolution: assignment.resolution,
        errorCode: assignment.errorCode ?? 'PLAN_ASSIGNMENT_INVALID',
        invalidPlanId: assignment.invalidPlanId,
      },
      access: BILLABLE_CAPABILITIES.map((capability) => ({
        capability,
        decision: 'PLAN_REQUIRED' as const,
        reasonCode: 'PLAN_ASSIGNMENT_INVALID',
        // Yükseltme hedefi YOK: sorun plan seviyesi değil, YAPILANDIRMA.
        requiredPlanId: null,
        limit: null,
        usage: NOT_YET_METERED,
        usageMetered: false,
      })),
      usage: usage.metrics as Record<string, UsageReading>,
      measuredAt: usage.measuredAt,
    }
  }

  // Erken dönüşten sonra `planId` kesin olarak doludur; closure içinde
  // daraltma kaybolmasın diye sabitlenir.
  const planId = assignment.planId
  const definition = planDefinition(planId)
  const access = BILLABLE_CAPABILITIES.map((capability) => {
    const metric = CAPABILITY_USAGE[capability]
    const reading: UsageReading = metric ? usage.metrics[metric] : NOT_YET_METERED
    return resolveFeatureAccess({
      capability,
      planId,
      usage: reading,
      ...(options.productSupported?.[capability] !== undefined
        ? { productSupported: options.productSupported[capability] }
        : {}),
      ...(options.rolloutLive?.[capability] !== undefined
        ? { rolloutLive: options.rolloutLive[capability] }
        : {}),
      ...(options.connectionOperational?.[capability] !== undefined
        ? { connectionOperational: options.connectionOperational[capability] }
        : {}),
      ...(options.requested?.[capability] !== undefined
        ? { requested: options.requested[capability] }
        : {}),
    })
  })

  return {
    plan: {
      planId,
      displayName: definition.defaultDisplayName,
      legacy: assignment.legacy,
      assignable: definition.assignable,
      assignedAt: assignment.assignedAt,
      assignedBy: assignment.assignedBy,
      resolution: assignment.resolution,
      errorCode: null,
      invalidPlanId: null,
    },
    access,
    usage: usage.metrics as Record<string, UsageReading>,
    measuredAt: usage.measuredAt,
  }
}
