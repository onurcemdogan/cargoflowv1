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

export interface BillingStatus {
  plan: {
    planId: string
    displayName: string
    legacy: boolean
    assignable: boolean
    assignedAt: string | null
    assignedBy: string | null
  }
  access: FeatureAccessResult[]
  usage: Record<string, UsageReading>
  measuredAt: string
}

export interface BillingStatusOptions {
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

export async function loadBillingStatus(
  db: Db,
  organizationId: string,
  options: BillingStatusOptions,
): Promise<BillingStatus> {
  const [assignment, usage] = await Promise.all([
    loadPlanAssignment(db, organizationId),
    loadUsageSnapshot(db, organizationId, { nowMs: options.nowMs }),
  ])
  return buildBillingStatus(assignment, usage, options)
}

/** SAF birleştirme — testte DB olmadan da çağrılabilir. */
export function buildBillingStatus(
  assignment: PlanAssignment,
  usage: UsageSnapshot,
  options: BillingStatusOptions,
): BillingStatus {
  const definition = planDefinition(assignment.planId)
  const access = BILLABLE_CAPABILITIES.map((capability) => {
    const metric = CAPABILITY_USAGE[capability]
    const reading: UsageReading = metric ? usage.metrics[metric] : NOT_YET_METERED
    return resolveFeatureAccess({
      capability,
      planId: assignment.planId,
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
      planId: assignment.planId,
      displayName: definition.defaultDisplayName,
      legacy: assignment.legacy,
      assignable: definition.assignable,
      assignedAt: assignment.assignedAt,
      assignedBy: assignment.assignedBy,
    },
    access,
    usage: usage.metrics as Record<string, UsageReading>,
    measuredAt: usage.measuredAt,
  }
}
