// ═══ FAZ 1 — LEGACY TEKRAR SATIRI TEMİZLİĞİ ═══════════════════════════════
//
// KAPSAM: YALNIZ `active_plus_legacy`. `null_shadow` bu fazda TAMAMEN
// KAPSAM DIŞIDIR ve KOD DÜZEYİNDE SERT ENGELLİDİR (aşağıdaki guard).
//
// SİLİNEBİLECEK TEK ŞEY: pasif (inactive) hesap kapsamındaki sipariş satırı
// ve ONA BAĞLI `order_lines`. Gönderi (`shipments`), taşıyıcı operasyonu
// (`shipment_operations`), aktif satır, aktif satırın satırları, pazaryeri
// hesabı ve entegrasyon durumu ASLA silinmez.
//
// TOCTOU: denetim çıktısına KÖR GÜVENİLMEZ. Her hedef, silme ile AYNI
// transaction içinde baştan doğrulanır; tek bir koşul bile değişmişse işlem
// atlanır (skip) ve sebep raporlanır.
import { and, eq, sql } from 'drizzle-orm'
import {
  orderLines,
  orders,
  shipmentOperations,
  shipments,
} from '../db/schema.ts'
import { classifyDuplicateGroup } from './crossAccountDuplicateAudit.ts'
import {
  evaluateGroupEligibility,
  type EligibilityGroup,
} from './duplicateCleanupEligibility.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type Phase1SkipReason =
  | 'not_found'
  | 'class_changed'
  | 'row_count_changed'
  | 'active_counterpart_missing'
  | 'candidate_not_legacy_scope'
  | 'candidate_account_not_inactive'
  | 'candidate_archived'
  | 'package_has_shipment'
  | 'package_has_shipment_operation'
  | 'null_shadow_hard_block'

export interface Phase1Target {
  organizationId: string
  marketplace: string
  packageId: string
  orderNumber: string | null
  /** SİLİNECEK satır — DAİMA pasif hesap kapsamındaki satır. */
  legacyRowId: string
  legacyAccountId: string
  /** KORUNACAK satır. */
  activeRowId: string
  activeAccountId: string
  expectedOrderLineDeletes: number
}

export interface Phase1Plan {
  activePlusLegacyTotal: number
  activePlusLegacyEligible: number
  activePlusLegacyBlocked: number
  blockedReasons: Record<string, number>
  targets: Phase1Target[]
  expectedOrderDeletes: number
  expectedOrderLineDeletes: number
  /** Bu fazda gölge satırlara DOKUNULMADIĞININ açık kaydı. */
  nullShadowTouched: false
}

/**
 * FAZ 1 SERT KAPSAM KURALI. Denetim genel olarak "uygun" dese bile bu faz
 * yalnız `active_plus_legacy` grubunu kabul eder; hesapsız (NULL) satır
 * ASLA aday olamaz.
 */
export function isPhase1Eligible(group: {
  duplicateClass: string
  cleanupEligible: boolean
  rows: { role: string; marketplaceAccountId: string | null }[]
}): boolean {
  if (group.duplicateClass !== 'active_plus_legacy') return false
  if (!group.cleanupEligible) return false
  // NULL hesaplı satır içeren grup FAZ 1'e giremez.
  if (group.rows.some((row) => row.marketplaceAccountId == null)) return false
  const candidates = group.rows.filter((row) => row.role === 'legacy')
  const actives = group.rows.filter((row) => row.role === 'active')
  return candidates.length === 1 && actives.length === 1
}

/** SALT OKUMA: Faz 1 planı (silme YOK). */
export async function planPhase1Cleanup(
  db: Db,
  input: {
    organizationId?: string | null
    activeAccountIds: readonly string[]
    inactiveAccountIds: readonly string[]
    batchSize?: number
  },
): Promise<Phase1Plan> {
  // Plan TÜM grupları değerlendirir (örneklem sınırı YOK); uygunluk kararı
  // `evaluateGroupEligibility` ile AYNI yüklemdir — ikinci bir kural yazılmaz.
  const groups = await loadEligibilityGroups(db, input)
  const activePlusLegacy = groups.filter(
    (group) => group.duplicateClass === 'active_plus_legacy',
  )
  const eligible = activePlusLegacy.filter((group) => isPhase1Eligible(group))
  const blockedReasons: Record<string, number> = {}
  for (const group of activePlusLegacy) {
    if (isPhase1Eligible(group)) continue
    const reasons = group.blockedReasons.length
      ? group.blockedReasons
      : ['unsupported_class']
    for (const reason of reasons) {
      blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1
    }
  }

  const limit = Math.max(1, Math.min(100, input.batchSize ?? 25))
  const targets: Phase1Target[] = eligible.slice(0, limit).map((group) => {
    const legacy = group.rows.find((row) => row.role === 'legacy')!
    const active = group.rows.find((row) => row.role === 'active')!
    return {
      organizationId: group.organizationId,
      marketplace: group.marketplace,
      packageId: group.packageId,
      orderNumber: group.orderNumber,
      legacyRowId: legacy.id,
      legacyAccountId: String(legacy.marketplaceAccountId),
      activeRowId: active.id,
      activeAccountId: String(active.marketplaceAccountId),
      expectedOrderLineDeletes: legacy.orderLineCount,
    }
  })

  return {
    activePlusLegacyTotal: activePlusLegacy.length,
    activePlusLegacyEligible: eligible.length,
    activePlusLegacyBlocked: activePlusLegacy.length - eligible.length,
    blockedReasons,
    targets,
    expectedOrderDeletes: targets.length,
    expectedOrderLineDeletes: targets.reduce(
      (total, target) => total + target.expectedOrderLineDeletes,
      0,
    ),
    nullShadowTouched: false,
  }
}

/** Grup ayrıntılarını (rol + engel) organizationId ile birlikte yükler. */
async function loadEligibilityGroups(
  db: Db,
  input: {
    organizationId?: string | null
    activeAccountIds: readonly string[]
    inactiveAccountIds: readonly string[]
  },
): Promise<(EligibilityGroup & { organizationId: string })[]> {
  const rows = (await db
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      marketplaceAccountId: orders.marketplaceAccountId,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
      archivedAt: orders.archivedAt,
    })
    .from(orders)
    .where(
      input.organizationId
        ? eq(orders.organizationId, input.organizationId)
        : sql`true`,
    )) as Record<string, any>[]

  const byKey = new Map<string, Record<string, any>[]>()
  for (const row of rows) {
    const key = `${row.organizationId}::${row.marketplace}::${row.packageId}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(row)
  }

  const groups: (EligibilityGroup & { organizationId: string })[] = []
  for (const [, groupRows] of byKey) {
    const accountIds = groupRows.map((row) => row.marketplaceAccountId ?? null)
    const distinctScopes = new Set(
      accountIds.map((id) => (id == null ? 'null' : String(id))),
    )
    if (distinctScopes.size < 2) continue

    const packageId = String(groupRows[0].packageId)
    const marketplace = String(groupRows[0].marketplace)
    const organizationId = String(groupRows[0].organizationId)
    const [shipmentRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          eq(shipments.marketplace, marketplace),
          eq(shipments.packageId, packageId),
        ),
      )
    const [operationRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(shipmentOperations)
      .where(
        and(
          eq(shipmentOperations.organizationId, organizationId),
          eq(shipmentOperations.marketplace, marketplace),
          eq(shipmentOperations.packageId, packageId),
        ),
      )
    const packageCarrier = {
      shipments: Number(shipmentRow?.total ?? 0),
      shipmentOperations: Number(operationRow?.total ?? 0),
    }

    const eligibilityRows = []
    for (const row of groupRows) {
      const [lineRow] = await db
        .select({ total: sql<number>`count(*)` })
        .from(orderLines)
        .where(
          and(
            eq(orderLines.organizationId, organizationId),
            eq(orderLines.orderId, String(row.id)),
          ),
        )
      eligibilityRows.push({
        id: String(row.id),
        marketplaceAccountId: row.marketplaceAccountId ?? null,
        role:
          row.marketplaceAccountId == null
            ? ('null_shadow' as const)
            : input.activeAccountIds.includes(row.marketplaceAccountId)
              ? ('active' as const)
              : ('legacy' as const),
        marketplaceStatus: row.marketplaceStatus ?? null,
        operationStatus: row.operationStatus ?? null,
        archived: Boolean(row.archivedAt),
        orderLineCount: Number(lineRow?.total ?? 0),
      })
    }

    const duplicateClass = classifyDuplicateGroup(
      accountIds,
      input.activeAccountIds,
    )
    const verdict = evaluateGroupEligibility({
      duplicateClass,
      rowCount: groupRows.length,
      rows: eligibilityRows,
      packageCarrier,
      inactiveAccountIds: input.inactiveAccountIds,
    })
    groups.push({
      organizationId,
      packageId,
      orderNumber: (groupRows[0].orderNumber as string | null) ?? null,
      marketplace,
      duplicateClass,
      rowCount: groupRows.length,
      accountIds,
      statuses: eligibilityRows.map((row) => row.marketplaceStatus),
      operationStatuses: eligibilityRows.map((row) => row.operationStatus),
      packageCarrier,
      rows: eligibilityRows,
      candidateRowId: verdict.candidateRowId,
      cleanupEligible: verdict.eligible,
      blockedReasons: verdict.reasons,
    })
  }
  return groups
}

export interface Phase1ApplyResult {
  applied: boolean
  reason: Phase1SkipReason | null
  deletedOrders: number
  deletedOrderLines: number
}

/**
 * TEK HEDEF UYGULAMASI. Tüm koşullar TRANSACTION İÇİNDE yeniden doğrulanır
 * (TOCTOU koruması); tek bir sapma bile silmeyi engeller.
 */
export async function applyPhase1Target(
  db: Db,
  target: Phase1Target,
  input: {
    activeAccountIds: readonly string[]
    inactiveAccountIds: readonly string[]
  },
): Promise<Phase1ApplyResult> {
  const database = db as unknown as {
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>
  }
  return database.transaction(async (tx) => {
    const trx = tx as Db
    const fail = (reason: Phase1SkipReason): Phase1ApplyResult => ({
      applied: false,
      reason,
      deletedOrders: 0,
      deletedOrderLines: 0,
    })

    const groupRows = (await trx
      .select({
        id: orders.id,
        marketplaceAccountId: orders.marketplaceAccountId,
        archivedAt: orders.archivedAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, target.organizationId),
          eq(orders.marketplace, target.marketplace),
          eq(orders.packageId, target.packageId),
        ),
      )) as Record<string, any>[]

    if (groupRows.length === 0) return fail('not_found')
    if (groupRows.length !== 2) return fail('row_count_changed')
    // SERT ENGEL: hesapsız satır içeren grup FAZ 1'e giremez.
    if (groupRows.some((row) => row.marketplaceAccountId == null)) {
      return fail('null_shadow_hard_block')
    }

    const accountIds = groupRows.map((row) => row.marketplaceAccountId ?? null)
    if (
      classifyDuplicateGroup(accountIds, input.activeAccountIds) !==
      'active_plus_legacy'
    ) {
      return fail('class_changed')
    }

    const legacy = groupRows.find((row) => String(row.id) === target.legacyRowId)
    const active = groupRows.find((row) => String(row.id) === target.activeRowId)
    if (!legacy) return fail('not_found')
    if (!active) return fail('active_counterpart_missing')
    // Aktif karşılık GERÇEKTEN aktif hesapta mı?
    if (!input.activeAccountIds.includes(String(active.marketplaceAccountId))) {
      return fail('active_counterpart_missing')
    }
    // Aday GERÇEKTEN pasif hesapta mı?
    if (input.activeAccountIds.includes(String(legacy.marketplaceAccountId))) {
      return fail('candidate_not_legacy_scope')
    }
    if (!input.inactiveAccountIds.includes(String(legacy.marketplaceAccountId))) {
      return fail('candidate_account_not_inactive')
    }
    if (legacy.archivedAt) return fail('candidate_archived')

    // PAKET DÜZEYİ TAŞIYICI BAĞIMLILIĞI — yeniden sayılır.
    const [shipmentRow] = await trx
      .select({ total: sql<number>`count(*)` })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, target.organizationId),
          eq(shipments.marketplace, target.marketplace),
          eq(shipments.packageId, target.packageId),
        ),
      )
    if (Number(shipmentRow?.total ?? 0) > 0) return fail('package_has_shipment')
    const [operationRow] = await trx
      .select({ total: sql<number>`count(*)` })
      .from(shipmentOperations)
      .where(
        and(
          eq(shipmentOperations.organizationId, target.organizationId),
          eq(shipmentOperations.marketplace, target.marketplace),
          eq(shipmentOperations.packageId, target.packageId),
        ),
      )
    if (Number(operationRow?.total ?? 0) > 0) {
      return fail('package_has_shipment_operation')
    }

    // ── SİLME: YALNIZ legacy satır + ONA BAĞLI order_lines ────────────────
    const [lineCount] = await trx
      .select({ total: sql<number>`count(*)` })
      .from(orderLines)
      .where(
        and(
          eq(orderLines.organizationId, target.organizationId),
          eq(orderLines.orderId, target.legacyRowId),
        ),
      )
    await trx
      .delete(orderLines)
      .where(
        and(
          eq(orderLines.organizationId, target.organizationId),
          eq(orderLines.orderId, target.legacyRowId),
        ),
      )
    await trx
      .delete(orders)
      .where(
        and(
          eq(orders.organizationId, target.organizationId),
          eq(orders.id, target.legacyRowId),
        ),
      )
    return {
      applied: true,
      reason: null,
      deletedOrders: 1,
      deletedOrderLines: Number(lineCount?.total ?? 0),
    }
  })
}
