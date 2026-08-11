// ═══ TEKRAR TEMİZLİĞİ UYGUNLUK DENETİMİ — SALT OKUNUR ═════════════════════
//
// AMAÇ: 964 tekrar grubunun hangilerinin TEORİK olarak güvenli temizlik
// adayı olabileceğini sınıflandırmak. HİÇBİR SATIR SİLİNMEZ/GÜNCELLENMEZ/
// ARŞİVLENMEZ — bu modül yalnız sayar ve etiketler.
//
// ═══ KRİTİK KISIT (KANITLI) ═══════════════════════════════════════════════
// `shipments` ve `shipment_operations` doğal anahtarı
//   (organization_id, marketplace, package_id[, provider])
// şeklindedir; `marketplace_account_id` VEYA `order_id` İÇERMEZ. Bu yüzden
// bir taşıyıcı kaydı "aktif satıra mı, legacy satıra mı ait" sorusunun
// veri düzeyinde CEVABI YOKTUR — kayıt PAKET düzeyinde ortaktır.
//
// Bu nedenle taşıyıcı bağımlılığı PAKET DÜZEYİNDE raporlanır ve temizlik
// uygunluğu için MUHAFAZAKÂR yorumlanır: pakette gönderi/operasyon varsa
// o gruptaki HİÇBİR satır otomatik aday sayılmaz. `order_lines` ise
// `order_id` taşıdığı için SATIR DÜZEYİNDE atfedilebilir.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'
import {
  carrierKeyOf,
  loadCarrierDependencies,
} from './carrierDependency.ts'
import { classifyDuplicateGroup, type DuplicateClass } from './crossAccountDuplicateAudit.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type BlockReason =
  | 'package_has_shipment'
  | 'package_has_shipment_operation'
  | 'multi_row_group'
  | 'no_active_counterpart'
  | 'account_not_inactive'
  | 'archived_row'
  | 'unsupported_class'

export interface EligibilityRow {
  id: string
  marketplaceAccountId: string | null
  role: 'active' | 'legacy' | 'null_shadow'
  marketplaceStatus: string | null
  operationStatus: string | null
  archived: boolean
  orderLineCount: number
}

export interface EligibilityGroup {
  packageId: string
  orderNumber: string | null
  marketplace: string
  duplicateClass: DuplicateClass
  rowCount: number
  accountIds: (string | null)[]
  statuses: (string | null)[]
  operationStatuses: (string | null)[]
  /** PAKET düzeyinde (satıra atfedilemez) taşıyıcı bağımlılıkları. */
  packageCarrier: { shipments: number; shipmentOperations: number }
  rows: EligibilityRow[]
  /** Silinmesi TEORİK olarak güvenli görünen satır (varsa) — ÖNERİ DEĞİL. */
  candidateRowId: string | null
  cleanupEligible: boolean
  blockedReasons: BlockReason[]
}

export interface ClassAggregate {
  packageCount: number
  rowCount: number
  rowsWithOrderLines: number
  /** Paket düzeyinde gönderi taşıyan gruplardaki satır sayısı. */
  rowsWithShipments: number
  rowsWithShipmentOperations: number
  rowsWithAnyCarrierDependency: number
  rowsWithoutCarrierDependency: number
  /** Rol kırılımı (aktif kapsam vs legacy/gölge). */
  activeRowsWithShipment: number
  legacyRowsWithShipment: number
  activeRowsWithShipmentOperation: number
  legacyRowsWithShipmentOperation: number
  legacyRowsWithNoCarrierChildren: number
}

function emptyAggregate(): ClassAggregate {
  return {
    packageCount: 0,
    rowCount: 0,
    rowsWithOrderLines: 0,
    rowsWithShipments: 0,
    rowsWithShipmentOperations: 0,
    rowsWithAnyCarrierDependency: 0,
    rowsWithoutCarrierDependency: 0,
    activeRowsWithShipment: 0,
    legacyRowsWithShipment: 0,
    activeRowsWithShipmentOperation: 0,
    legacyRowsWithShipmentOperation: 0,
    legacyRowsWithNoCarrierChildren: 0,
  }
}

/**
 * TEK GRUP UYGUNLUK KARARI. Koşulların TAMAMI sağlanmadan `cleanupEligible`
 * true olmaz; engel sebepleri açıkça listelenir.
 */
export function evaluateGroupEligibility(input: {
  duplicateClass: DuplicateClass
  rowCount: number
  rows: EligibilityRow[]
  packageCarrier: { shipments: number; shipmentOperations: number }
  inactiveAccountIds: readonly string[]
}): { candidateRowId: string | null; eligible: boolean; reasons: BlockReason[] } {
  const reasons: BlockReason[] = []
  // 2 satırdan fazla grup ANOMALİDİR: otomatik adaylıktan tamamen çıkar.
  if (input.rowCount > 2) reasons.push('multi_row_group')
  if (input.packageCarrier.shipments > 0) reasons.push('package_has_shipment')
  if (input.packageCarrier.shipmentOperations > 0) {
    reasons.push('package_has_shipment_operation')
  }
  if (
    input.duplicateClass !== 'active_plus_legacy' &&
    input.duplicateClass !== 'null_shadow'
  ) {
    reasons.push('unsupported_class')
  }

  const active = input.rows.find((row) => row.role === 'active') ?? null
  if (!active) reasons.push('no_active_counterpart')

  const candidate =
    input.rows.find((row) => row.role === 'legacy' || row.role === 'null_shadow') ??
    null
  if (candidate?.archived) reasons.push('archived_row')
  // Legacy hesabın GERÇEKTEN pasif olduğu doğrulanmalı (aktifse aday değil).
  if (
    candidate?.role === 'legacy' &&
    candidate.marketplaceAccountId &&
    !input.inactiveAccountIds.includes(candidate.marketplaceAccountId)
  ) {
    reasons.push('account_not_inactive')
  }

  return {
    candidateRowId: candidate?.id ?? null,
    eligible: reasons.length === 0 && Boolean(candidate) && Boolean(active),
    reasons,
  }
}

export interface CleanupEligibilityReport {
  totalDuplicatePackages: number
  totalDuplicateRows: number
  classAggregates: Record<string, ClassAggregate>
  multiRowGroups: { count: number; samples: EligibilityGroup[] }
  cleanupEligibleCount: number
  blockedCount: number
  blockedReasons: Record<string, number>
  eligibleSamples: EligibilityGroup[]
  /** Taşıyıcı bağımlılığının satıra ATFEDİLEMEDİĞİ açıkça belirtilir. */
  carrierAttribution: string
}

/**
 * SALT OKUMA. Tüm tekrar gruplarını TOPLU sorgularla yükler (grup başına
 * sorgu döngüsü YOK) ve uygunluk sınıflandırması üretir.
 */
export async function buildCleanupEligibilityReport(
  db: Db,
  input: {
    organizationId?: string | null
    activeAccountIds: readonly string[]
    inactiveAccountIds: readonly string[]
    sampleLimit?: number
  },
): Promise<CleanupEligibilityReport> {
  const sampleLimit = Math.max(1, Math.min(50, input.sampleLimit ?? 10))
  const orgScope = input.organizationId
    ? eq(orders.organizationId, input.organizationId)
    : sql`true`

  // 1) Tekrar eden (org, marketplace, package) anahtarları.
  const groups = (await db
    .select({
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
      rowCount: sql<number>`count(*)`,
    })
    .from(orders)
    .where(orgScope)
    .groupBy(orders.organizationId, orders.marketplace, orders.packageId)
    .having(
      sql`count(distinct coalesce(${orders.marketplaceAccountId}::text, 'null')) > 1`,
    )) as {
    organizationId: string
    marketplace: string
    packageId: string
    rowCount: number
  }[]

  const packageIds = groups.map((group) => group.packageId)
  if (packageIds.length === 0) {
    return {
      totalDuplicatePackages: 0,
      totalDuplicateRows: 0,
      classAggregates: {},
      multiRowGroups: { count: 0, samples: [] },
      cleanupEligibleCount: 0,
      blockedCount: 0,
      blockedReasons: {},
      eligibleSamples: [],
      carrierAttribution: CARRIER_ATTRIBUTION_NOTE,
    }
  }

  // 2) İlgili TÜM sipariş satırları (tek sorgu).
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
    .where(and(orgScope, inArray(orders.packageId, packageIds)))) as Record<
    string,
    any
  >[]

  // 3) Satır bazlı `order_lines` sayımı (tek sorgu, orderId ile atfedilebilir).
  const lineCounts = new Map<string, number>()
  const lineRows = (await db
    .select({ orderId: orderLines.orderId, total: sql<number>`count(*)` })
    .from(orderLines)
    .where(
      inArray(
        orderLines.orderId,
        rows.map((row) => String(row.id)),
      ),
    )
    .groupBy(orderLines.orderId)) as { orderId: string; total: number }[]
  for (const row of lineRows) lineCounts.set(String(row.orderId), Number(row.total))

  // 4) PAKET bazlı taşıyıcı sayımları — TEK KANONİK HELPER.
  //
  // DÜZELTME: ilk sürüm YALNIZ `package_id` ile eşleştiriyordu; organizasyon
  // ve pazaryeri kapsamı düşürüldüğü için farklı kapsamdaki aynı paket
  // numarasını da sayıp FAZLA bağımlılık raporluyordu (iki denetim arasındaki
  // 230 ≠ 35 tutarsızlığının kaynağı). Artık kanonik anahtar kullanılır.
  const carrier = await loadCarrierDependencies(
    db,
    groups.map((group) => ({
      organizationId: group.organizationId,
      marketplace: group.marketplace,
      packageId: group.packageId,
    })),
  )

  // 5) Grup bazında sınıflandırma + toplama.
  const rowsByPackage = new Map<string, Record<string, any>[]>()
  for (const row of rows) {
    const key = String(row.packageId)
    if (!rowsByPackage.has(key)) rowsByPackage.set(key, [])
    rowsByPackage.get(key)!.push(row)
  }

  const classAggregates: Record<string, ClassAggregate> = {}
  const multiRowSamples: EligibilityGroup[] = []
  const eligibleSamples: EligibilityGroup[] = []
  const blockedReasons: Record<string, number> = {}
  let multiRowCount = 0
  let cleanupEligibleCount = 0
  let blockedCount = 0
  let totalDuplicateRows = 0

  for (const group of groups) {
    const groupRows = rowsByPackage.get(group.packageId) ?? []
    const accountIds = groupRows.map((row) => row.marketplaceAccountId ?? null)
    const duplicateClass = classifyDuplicateGroup(
      accountIds,
      input.activeAccountIds,
    )
    const packageCarrier = carrier.get(
      carrierKeyOf({
        organizationId: group.organizationId,
        marketplace: group.marketplace,
        packageId: group.packageId,
      }),
    ) ?? { shipments: 0, shipmentOperations: 0 }
    const eligibilityRows: EligibilityRow[] = groupRows.map((row) => ({
      id: String(row.id),
      marketplaceAccountId: row.marketplaceAccountId ?? null,
      role:
        row.marketplaceAccountId == null
          ? 'null_shadow'
          : input.activeAccountIds.includes(row.marketplaceAccountId)
            ? 'active'
            : 'legacy',
      marketplaceStatus: row.marketplaceStatus ?? null,
      operationStatus: row.operationStatus ?? null,
      archived: Boolean(row.archivedAt),
      orderLineCount: lineCounts.get(String(row.id)) ?? 0,
    }))

    const verdict = evaluateGroupEligibility({
      duplicateClass,
      rowCount: groupRows.length,
      rows: eligibilityRows,
      packageCarrier,
      inactiveAccountIds: input.inactiveAccountIds,
    })

    const summary: EligibilityGroup = {
      packageId: group.packageId,
      orderNumber: (groupRows[0]?.orderNumber as string | null) ?? null,
      marketplace: group.marketplace,
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
    }

    totalDuplicateRows += groupRows.length
    if (groupRows.length > 2) {
      multiRowCount += 1
      if (multiRowSamples.length < sampleLimit) multiRowSamples.push(summary)
    }
    if (verdict.eligible) {
      cleanupEligibleCount += 1
      if (eligibleSamples.length < sampleLimit) eligibleSamples.push(summary)
    } else {
      blockedCount += 1
      for (const reason of verdict.reasons) {
        blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1
      }
    }

    const aggregate =
      classAggregates[duplicateClass] ??
      (classAggregates[duplicateClass] = emptyAggregate())
    aggregate.packageCount += 1
    aggregate.rowCount += groupRows.length
    const hasShipment = packageCarrier.shipments > 0
    const hasOperation = packageCarrier.shipmentOperations > 0
    for (const row of eligibilityRows) {
      if (row.orderLineCount > 0) aggregate.rowsWithOrderLines += 1
      if (hasShipment) aggregate.rowsWithShipments += 1
      if (hasOperation) aggregate.rowsWithShipmentOperations += 1
      if (hasShipment || hasOperation) {
        aggregate.rowsWithAnyCarrierDependency += 1
      } else {
        aggregate.rowsWithoutCarrierDependency += 1
      }
      const isActive = row.role === 'active'
      if (hasShipment) {
        if (isActive) aggregate.activeRowsWithShipment += 1
        else aggregate.legacyRowsWithShipment += 1
      }
      if (hasOperation) {
        if (isActive) aggregate.activeRowsWithShipmentOperation += 1
        else aggregate.legacyRowsWithShipmentOperation += 1
      }
      if (!isActive && !hasShipment && !hasOperation) {
        aggregate.legacyRowsWithNoCarrierChildren += 1
      }
    }
  }

  return {
    totalDuplicatePackages: groups.length,
    totalDuplicateRows,
    classAggregates,
    multiRowGroups: { count: multiRowCount, samples: multiRowSamples },
    cleanupEligibleCount,
    blockedCount,
    blockedReasons,
    eligibleSamples,
    carrierAttribution: CARRIER_ATTRIBUTION_NOTE,
  }
}

export const CARRIER_ATTRIBUTION_NOTE =
  'shipments/shipment_operations dogal anahtari (org, marketplace, package_id) ' +
  'oldugu icin tasiyici kaydi TEK BIR duplicate satira ATFEDILEMEZ; paket ' +
  'duzeyinde raporlanir ve muhafazakar yorumlanir (paket bagimliysa grup ' +
  'otomatik adaylıktan cikar). order_lines ise order_id ile satira atfedilir.'
