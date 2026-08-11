// ═══ ÇAPRAZ HESAP TEKRARI TANI ÇEKİRDEĞİ — SALT OKUNUR ════════════════════
//
// ÜRETİM BULGUSU: aynı `(organization, marketplace, package_id)` üçlüsü
// BİRDEN FAZLA `marketplace_account_id` kapsamında satır taşıyabiliyor.
// Tekillik `(org, marketplace, account, package)` olduğu ve NULLS NOT
// DISTINCT tanımlandığı için bu ŞEMA AÇISINDAN GEÇERLİDİR — hata değildir.
// Ancak UI yalnız AKTİF hesap kapsamındaki satırı gösterir; kapsam
// belirtmeyen bir tanı aracı ESKİ satırı okuyup yanlış teşhis koyabilir.
//
// BU MODÜL YALNIZ SAYAR VE SINIFLANDIRIR. Hiçbir silme/güncelleme/arşivleme
// YOKTUR; temizlik ayrı ve onaylı bir turun işidir.
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  orderLines,
  orders,
  shipmentOperations,
  shipments,
} from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * TEKRAR SINIFI:
 *   active_plus_legacy → biri aktif hesap kapsamında, diğer(ler)i pasif/eski
 *   multiple_active     → birden fazla AKTİF hesap (beklenmez; şema tek aktif
 *                         hesabı partial unique ile korur, yine de raporlanır)
 *   null_shadow        → NULL hesap kapsamlı gölge satır + hesaplı satır
 *   no_active_scope    → hiçbiri aktif hesap kapsamında değil
 */
export type DuplicateClass =
  | 'active_plus_legacy'
  | 'multiple_active'
  | 'null_shadow'
  | 'no_active_scope'

export interface DuplicateRowSummary {
  id: string
  marketplaceAccountId: string | null
  isActiveAccountScope: boolean
  marketplaceStatus: string | null
  operationStatus: string | null
  lastSeenAt: string | null
  archived: boolean
  /** Taşıyıcı/işlem bağımlılıkları — temizlik güvenliği için (§4). */
  childCounts?: {
    orderLines: number
    shipments: number
    shipmentOperations: number
  }
}

export interface DuplicateGroup {
  packageId: string
  orderNumber: string | null
  marketplace: string
  accountIds: (string | null)[]
  marketplaceStatuses: (string | null)[]
  operationStatuses: (string | null)[]
  duplicateClass: DuplicateClass
  rows: DuplicateRowSummary[]
}

/**
 * Bir tekrar grubunu aktif hesap kimliğine göre sınıflandırır.
 * Aktif hesap bilinmiyorsa (null) `no_active_scope` döner — kör "hepsi legacy"
 * varsayımı YAPILMAZ.
 */
export function classifyDuplicateGroup(
  accountIds: (string | null)[],
  activeAccountIds: readonly string[],
): DuplicateClass {
  const activeMatches = accountIds.filter(
    (id) => id !== null && activeAccountIds.includes(id),
  )
  if (activeMatches.length > 1) return 'multiple_active'
  if (accountIds.some((id) => id === null)) return 'null_shadow'
  if (activeMatches.length === 1) return 'active_plus_legacy'
  return 'no_active_scope'
}

export interface DuplicateAuditReport {
  duplicatePackageCount: number
  duplicateRowCount: number
  classCounts: Record<string, number>
  samples: DuplicateGroup[]
}

/**
 * SALT OKUMA. Aynı (organization, marketplace, package_id) için birden fazla
 * `marketplace_account_id` bulunan grupları sayar; ilk `sampleLimit` grup için
 * satır ayrıntısı ve bağımlılık sayımlarını döner.
 */
export async function auditCrossAccountDuplicates(
  db: Db,
  input: {
    organizationId?: string | null
    activeAccountIds: readonly string[]
    sampleLimit?: number
  },
): Promise<DuplicateAuditReport> {
  const sampleLimit = Math.max(1, Math.min(50, input.sampleLimit ?? 10))
  const orgScope = input.organizationId
    ? eq(orders.organizationId, input.organizationId)
    : undefined

  // Gruplama: aynı paket için FARKLI hesap kapsamı sayısı > 1.
  const grouped = await db
    .select({
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
      accountCount: sql<number>`count(distinct coalesce(${orders.marketplaceAccountId}::text, 'null'))`,
      rowCount: sql<number>`count(*)`,
    })
    .from(orders)
    .where(orgScope ?? sql`true`)
    .groupBy(orders.organizationId, orders.marketplace, orders.packageId)
    .having(
      sql`count(distinct coalesce(${orders.marketplaceAccountId}::text, 'null')) > 1`,
    )

  const duplicatePackageCount = grouped.length
  const duplicateRowCount = grouped.reduce(
    (total: number, row: { rowCount: number }) => total + Number(row.rowCount),
    0,
  )

  const samples: DuplicateGroup[] = []
  const classCounts: Record<string, number> = {}

  for (const group of grouped as {
    organizationId: string
    marketplace: string
    packageId: string
  }[]) {
    const rows = await db
      .select({
        id: orders.id,
        marketplaceAccountId: orders.marketplaceAccountId,
        orderNumber: orders.orderNumber,
        marketplaceStatus: orders.marketplaceStatus,
        operationStatus: orders.operationStatus,
        lastSeenAt: orders.lastSeenAt,
        archivedAt: orders.archivedAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, group.organizationId),
          eq(orders.marketplace, group.marketplace),
          eq(orders.packageId, group.packageId),
        ),
      )

    const accountIds = rows.map(
      (row: { marketplaceAccountId: string | null }) => row.marketplaceAccountId,
    )
    const duplicateClass = classifyDuplicateGroup(
      accountIds,
      input.activeAccountIds,
    )
    classCounts[duplicateClass] = (classCounts[duplicateClass] ?? 0) + 1
    if (samples.length >= sampleLimit) continue

    const summaries: DuplicateRowSummary[] = []
    for (const row of rows as Record<string, any>[]) {
      // § TAŞIYICI GÜVENLİĞİ: gönderi/operasyon taşıyan satır otomatik
      // temizlik planına ALINAMAZ; sayımlar burada raporlanır.
      const [lineCount] = await db
        .select({ total: sql<number>`count(*)` })
        .from(orderLines)
        .where(
          and(
            eq(orderLines.organizationId, group.organizationId),
            eq(orderLines.orderId, row.id),
          ),
        )
      const [shipmentCount] = await db
        .select({ total: sql<number>`count(*)` })
        .from(shipments)
        .where(
          and(
            eq(shipments.organizationId, group.organizationId),
            eq(shipments.marketplace, group.marketplace),
            eq(shipments.packageId, group.packageId),
          ),
        )
      const [operationCount] = await db
        .select({ total: sql<number>`count(*)` })
        .from(shipmentOperations)
        .where(
          and(
            eq(shipmentOperations.organizationId, group.organizationId),
            eq(shipmentOperations.marketplace, group.marketplace),
            eq(shipmentOperations.packageId, group.packageId),
          ),
        )
      summaries.push({
        id: String(row.id),
        marketplaceAccountId: row.marketplaceAccountId ?? null,
        isActiveAccountScope:
          row.marketplaceAccountId != null &&
          input.activeAccountIds.includes(row.marketplaceAccountId),
        marketplaceStatus: row.marketplaceStatus ?? null,
        operationStatus: row.operationStatus ?? null,
        lastSeenAt: row.lastSeenAt?.toISOString?.() ?? null,
        archived: Boolean(row.archivedAt),
        childCounts: {
          orderLines: Number(lineCount?.total ?? 0),
          shipments: Number(shipmentCount?.total ?? 0),
          shipmentOperations: Number(operationCount?.total ?? 0),
        },
      })
    }

    samples.push({
      packageId: group.packageId,
      orderNumber: (rows[0]?.orderNumber as string | null) ?? null,
      marketplace: group.marketplace,
      accountIds,
      marketplaceStatuses: rows.map(
        (row: { marketplaceStatus: string | null }) => row.marketplaceStatus,
      ),
      operationStatuses: rows.map(
        (row: { operationStatus: string | null }) => row.operationStatus,
      ),
      duplicateClass,
      rows: summaries,
    })
  }

  return {
    duplicatePackageCount,
    duplicateRowCount,
    classCounts,
    samples,
  }
}

/** Legacy (hesapsız) satır sayımı — ayrı sinyal. */
export async function countNullAccountRows(
  db: Db,
  organizationId?: string | null,
): Promise<number> {
  const clauses = [isNull(orders.marketplaceAccountId)]
  if (organizationId) clauses.push(eq(orders.organizationId, organizationId))
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(orders)
    .where(and(...clauses))
  return Number(row?.total ?? 0)
}
