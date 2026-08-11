// ═══ NULL-HESAP GÖLGE SATIRI KÖKEN/TEKRAR DENETİMİ — SALT OKUNUR ══════════
//
// SORU: `marketplace_account_id IS NULL` satırlar TARİHSEL kalıntı mı, yoksa
// üretimde HÂLÂ yeniden oluşuyor mu?
//
// BU MODÜL HİÇBİR ŞEY YAZMAZ/SİLMEZ/ARŞİVLEMEZ. Yalnız zaman çizelgesi,
// sınıflandırma ve profil üretir.
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'
import {
  carrierKeyOf,
  isCarrierDependent,
  loadCarrierDependencies,
} from './carrierDependency.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface TimelineBuckets {
  earliest: string | null
  latest: string | null
  countLast1h: number
  countLast6h: number
  countLast24h: number
  countLast3d: number
}

const HOUR = 60 * 60 * 1000

/** Bir zaman damgası listesini istenen pencerelere böler. */
export function bucketTimestamps(
  values: readonly (Date | null | undefined)[],
  now: Date,
): TimelineBuckets {
  const times = values
    .map((value) => (value ? value.getTime() : NaN))
    .filter((value) => Number.isFinite(value))
  const since = (ms: number) =>
    times.filter((value) => value >= now.getTime() - ms).length
  return {
    earliest: times.length ? new Date(Math.min(...times)).toISOString() : null,
    latest: times.length ? new Date(Math.max(...times)).toISOString() : null,
    countLast1h: since(HOUR),
    countLast6h: since(6 * HOUR),
    countLast24h: since(24 * HOUR),
    countLast3d: since(72 * HOUR),
  }
}

export type NullShadowClass =
  | 'exact_semantic_match'
  | 'status_match_operation_diff'
  | 'marketplace_status_diff'
  | 'active_archived_null_open'
  | 'null_archived_active_open'
  | 'multi_row_group'
  | 'other'

export interface ShadowRowFacts {
  marketplaceStatus: string | null
  operationStatus: string | null
  archived: boolean
  /** Satır içeriğinin KİMLİK ÖZETİ (değer DEĞİL, karşılaştırma anahtarı). */
  lineSignature: string
}

/**
 * SINIFLANDIRMA. `exact_semantic_match` en dar sınıftır: pazaryeri statüsü,
 * operasyon durumu ve satır içerik imzası AYNI. Arşiv farkları ayrı
 * sınıflarda tutulur; hiçbiri "silinebilir" demek DEĞİLDİR.
 */
export function classifyNullShadowGroup(input: {
  rowCount: number
  active: ShadowRowFacts | null
  shadow: ShadowRowFacts | null
}): NullShadowClass {
  if (input.rowCount > 2) return 'multi_row_group'
  const { active, shadow } = input
  if (!active || !shadow) return 'other'
  if (active.archived && !shadow.archived) return 'active_archived_null_open'
  if (!active.archived && shadow.archived) return 'null_archived_active_open'
  if (active.marketplaceStatus !== shadow.marketplaceStatus) {
    return 'marketplace_status_diff'
  }
  if (active.operationStatus !== shadow.operationStatus) {
    return 'status_match_operation_diff'
  }
  if (active.lineSignature !== shadow.lineSignature) return 'other'
  return 'exact_semantic_match'
}

/**
 * NULL yazabilen ÇALIŞMA ZAMANI yolları.
 *
 * ÖNCE (kanıtlanmış hata): hesap kimliği `resolveActiveMarketplaceAccountId`
 * ile çözülüyordu ve bu fonksiyon HEM "aktif hesap yok" HEM DE "çözümleme
 * hatası" durumunda `null` döndürüyordu; değer doğrudan
 * `persistSyncResult` → `upsertMarketplaceOrders(..., null)` zincirine
 * gidiyordu. Üç çalışma zamanı yolu da NULL kapsamına yazabiliyordu.
 *
 * SONRA (bu turdaki düzeltme): üç yol da `resolveActiveMarketplaceAccountScope`
 * kullanır; `status !== 'ok'` ise persist ÇAĞRILMAZ (manuel uç 409/503 döner,
 * arka plan ve stale turu organizasyonu ATLAR). Ayrıca `persistSyncResult`
 * `requireMarketplaceAccount: true` ile çağrıldığı için kimlik yoksa yazma
 * REDDEDİLİR. Bu yüzden `canBeNull` artık `false`.
 *
 * Çevrimdışı/elle çalıştırılan araçlar (tarihsel backfill, legacy import)
 * KASITLI olarak legacy kapsama yazabilir; `runtimeReachable: false`.
 */
export const NULL_CAPABLE_WRITERS = [
  {
    writer: 'manual_sync',
    location: 'server/index.mjs · POST /api/orders/sync',
    accountSource: 'resolveActiveMarketplaceAccountScope (status !== ok → persist YOK)',
    canBeNull: false,
    reason: 'hesap kapsamı çözülemezse 409/503 döner; persist YOK',
    runtimeReachable: true,
  },
  {
    writer: 'background_sync',
    location: 'server/index.mjs · syncTrendyolOrdersForOrganization',
    accountSource: 'resolveActiveMarketplaceAccountScope (status !== ok → persist YOK)',
    canBeNull: false,
    reason: 'hesap kapsamı çözülemezse organizasyon turu ATLANIR',
    runtimeReachable: true,
  },
  {
    writer: 'stale_open_reconcile',
    location: 'server/index.mjs · reconcileStaleOpenForOrganization',
    accountSource: 'resolveActiveMarketplaceAccountScope (status !== ok → persist YOK)',
    canBeNull: false,
    reason: 'hesap kapsamı çözülemezse aday seçilmez, persist YOK',
    runtimeReachable: true,
  },
  {
    writer: 'historical_backfill_cli',
    location: 'server/orders/historicalOrderBackfill.ts',
    accountSource: 'options.marketplaceAccountId (CLI parametresi)',
    canBeNull: true,
    reason: 'operatör null geçerse legacy kapsama yazar (elle çalıştırılır)',
    runtimeReachable: false,
  },
  {
    writer: 'legacy_import_cli',
    location: 'server/orders/importLegacyOrders.ts',
    accountSource: 'yok (legacy içe aktarım)',
    canBeNull: true,
    reason: 'tarihsel içe aktarma yolu; elle çalıştırılır',
    runtimeReachable: false,
  },
] as const

export interface NullShadowAuditInput {
  organizationId?: string | null
  activeAccountIds: readonly string[]
  now?: Date
  /** Düzeltme sınırı (commit tarihi). Verilmezse öncesi/sonrası ayrılmaz. */
  fixBoundary?: Date | null
  sampleLimit?: number
}

export interface NullShadowAuditReport {
  totalNullRows: number
  createdAt: TimelineBuckets
  firstSeenAt: TimelineBuckets
  lastSeenAt: TimelineBuckets
  createdBeforeFix: number | null
  createdAfterFix: number | null
  latestNullRowCreatedAt: string | null
  recentNullRows: Record<string, unknown>[]
  classification: Record<string, number>
  classDetail: Record<
    string,
    { packageCount: number; carrierDependent: number; carrierFree: number }
  >
  nullShadowPackages: number
  reachableNullWriterCount: number
  writers: typeof NULL_CAPABLE_WRITERS
  recurrenceVerdict:
    | 'HISTORICAL_ONLY'
    | 'NEW_NULL_ROWS_STILL_CREATED'
    | 'INCONCLUSIVE'
}

function lineSignatureOf(lines: Record<string, any>[]): string {
  // İÇERİK DEĞİL, KARŞILAŞTIRMA ANAHTARI: sıralı teknik alan üçlüsü.
  return lines
    .map(
      (line) =>
        `${String(line.merchantSku ?? '')}|${String(line.barcode ?? '')}|${String(
          line.quantity ?? '',
        )}`,
    )
    .sort()
    .join('~')
}

/** SALT OKUMA denetimi. */
export async function auditNullShadowRows(
  db: Db,
  input: NullShadowAuditInput,
): Promise<NullShadowAuditReport> {
  const now = input.now ?? new Date()
  const sampleLimit = Math.max(1, Math.min(50, input.sampleLimit ?? 20))
  const orgScope = input.organizationId
    ? eq(orders.organizationId, input.organizationId)
    : sql`true`

  const nullRows = (await db
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
      createdAt: orders.createdAt,
      firstSeenAt: orders.firstSeenAt,
      lastSeenAt: orders.lastSeenAt,
      archivedAt: orders.archivedAt,
    })
    .from(orders)
    .where(and(orgScope, isNull(orders.marketplaceAccountId)))
    .orderBy(desc(orders.createdAt))) as Record<string, any>[]

  const createdAt = bucketTimestamps(
    nullRows.map((row) => row.createdAt),
    now,
  )
  const boundary = input.fixBoundary ?? null
  const createdBeforeFix = boundary
    ? nullRows.filter((row) => row.createdAt && row.createdAt < boundary).length
    : null
  const createdAfterFix = boundary
    ? nullRows.filter((row) => row.createdAt && row.createdAt >= boundary).length
    : null

  // Eşleşen aktif hesap satırı var mı? (paket bazında tek sorgu)
  const packageIds = nullRows.map((row) => String(row.packageId))
  const counterparts = new Map<string, Record<string, any>[]>()
  if (packageIds.length > 0) {
    const rows = (await db
      .select({
        id: orders.id,
        organizationId: orders.organizationId,
        marketplaceAccountId: orders.marketplaceAccountId,
        marketplace: orders.marketplace,
        packageId: orders.packageId,
        marketplaceStatus: orders.marketplaceStatus,
        operationStatus: orders.operationStatus,
        archivedAt: orders.archivedAt,
      })
      .from(orders)
      .where(
        and(orgScope, sql`${orders.packageId} in ${packageIds}`),
      )) as Record<string, any>[]
    for (const row of rows) {
      const key = String(row.packageId)
      if (!counterparts.has(key)) counterparts.set(key, [])
      counterparts.get(key)!.push(row)
    }
  }

  const recentNullRows = nullRows.slice(0, sampleLimit).map((row) => {
    const group = counterparts.get(String(row.packageId)) ?? []
    const active = group.find(
      (other) =>
        other.marketplaceAccountId != null &&
        input.activeAccountIds.includes(other.marketplaceAccountId),
    )
    return {
      id: row.id,
      organizationId: row.organizationId,
      packageId: row.packageId,
      orderNumber: row.orderNumber,
      marketplaceStatus: row.marketplaceStatus,
      operationStatus: row.operationStatus,
      createdAt: row.createdAt?.toISOString?.() ?? null,
      firstSeenAt: row.firstSeenAt?.toISOString?.() ?? null,
      lastSeenAt: row.lastSeenAt?.toISOString?.() ?? null,
      archived: Boolean(row.archivedAt),
      matchingActiveAccountRowExists: Boolean(active),
      matchingActiveAccountId: active?.marketplaceAccountId ?? null,
    }
  })

  // ── SINIFLANDIRMA (paket bazında) ────────────────────────────────────────
  const classification: Record<string, number> = {}
  const classDetail: Record<
    string,
    { packageCount: number; carrierDependent: number; carrierFree: number }
  > = {}
  let nullShadowPackages = 0

  const lineRows = (await db
    .select({
      orderId: orderLines.orderId,
      merchantSku: orderLines.merchantSku,
      barcode: orderLines.barcode,
      quantity: orderLines.quantity,
    })
    .from(orderLines)) as Record<string, any>[]
  const linesByOrder = new Map<string, Record<string, any>[]>()
  for (const line of lineRows) {
    const key = String(line.orderId)
    if (!linesByOrder.has(key)) linesByOrder.set(key, [])
    linesByOrder.get(key)!.push(line)
  }

  // KANONİK taşıyıcı sayımı TEK seferde yüklenir (grup başına sorgu YOK).
  const carrierKeys = []
  for (const [packageId, group] of counterparts) {
    const hasNull = group.some((row) => row.marketplaceAccountId == null)
    const hasOther = group.some((row) => row.marketplaceAccountId != null)
    if (!hasNull || !hasOther) continue
    carrierKeys.push({
      organizationId: String(group[0].organizationId ?? ''),
      marketplace: String(group[0].marketplace),
      packageId,
    })
  }
  const carrierByKey = await loadCarrierDependencies(db, carrierKeys)

  for (const [packageId, group] of counterparts) {
    const hasNull = group.some((row) => row.marketplaceAccountId == null)
    const hasOther = group.some((row) => row.marketplaceAccountId != null)
    if (!hasNull || !hasOther) continue
    nullShadowPackages += 1

    const marketplace = String(group[0].marketplace)
    // DÜZELTME: eski sürüm organizasyon kimliğini TEK bir satırdan (ilk NULL
    // satır) türetip tüm gruplara uyguluyordu. Artık her grup KENDİ
    // organizasyonuyla, tek kanonik helper üzerinden sayılır.
    const organizationId = String(group[0].organizationId ?? '')
    const carrierDependent = isCarrierDependent(
      carrierByKey.get(
        carrierKeyOf({ organizationId, marketplace, packageId }),
      ),
    )

    const factsOf = (row: Record<string, any> | undefined): ShadowRowFacts | null =>
      row
        ? {
            marketplaceStatus: row.marketplaceStatus ?? null,
            operationStatus: row.operationStatus ?? null,
            archived: Boolean(row.archivedAt),
            lineSignature: lineSignatureOf(linesByOrder.get(String(row.id)) ?? []),
          }
        : null

    const activeRow = group.find(
      (row) =>
        row.marketplaceAccountId != null &&
        input.activeAccountIds.includes(row.marketplaceAccountId),
    )
    const shadowRow = group.find((row) => row.marketplaceAccountId == null)
    const klass = classifyNullShadowGroup({
      rowCount: group.length,
      active: factsOf(activeRow),
      shadow: factsOf(shadowRow),
    })
    classification[klass] = (classification[klass] ?? 0) + 1
    const detail =
      classDetail[klass] ??
      (classDetail[klass] = {
        packageCount: 0,
        carrierDependent: 0,
        carrierFree: 0,
      })
    detail.packageCount += 1
    if (carrierDependent) detail.carrierDependent += 1
    else detail.carrierFree += 1
  }

  const reachableNullWriterCount = NULL_CAPABLE_WRITERS.filter(
    (writer) => writer.runtimeReachable && writer.canBeNull,
  ).length

  // ── VERDICT ──────────────────────────────────────────────────────────────
  // HISTORICAL_ONLY yalnız İKİ koşul birden sağlanırsa verilir.
  let recurrenceVerdict: NullShadowAuditReport['recurrenceVerdict']
  if (createdAfterFix === null) {
    recurrenceVerdict = 'INCONCLUSIVE'
  } else if (createdAfterFix > 0) {
    recurrenceVerdict = 'NEW_NULL_ROWS_STILL_CREATED'
  } else if (reachableNullWriterCount > 0) {
    // Yeni satır YOK ama NULL yazabilen çalışma zamanı yolu MEVCUT.
    recurrenceVerdict = 'INCONCLUSIVE'
  } else {
    recurrenceVerdict = 'HISTORICAL_ONLY'
  }

  return {
    totalNullRows: nullRows.length,
    createdAt,
    firstSeenAt: bucketTimestamps(
      nullRows.map((row) => row.firstSeenAt),
      now,
    ),
    lastSeenAt: bucketTimestamps(
      nullRows.map((row) => row.lastSeenAt),
      now,
    ),
    createdBeforeFix,
    createdAfterFix,
    latestNullRowCreatedAt: createdAt.latest,
    recentNullRows,
    classification,
    classDetail,
    nullShadowPackages,
    reachableNullWriterCount,
    writers: NULL_CAPABLE_WRITERS,
    recurrenceVerdict,
  }
}

/** Yeni NULL satır sayımı (pencere bazlı, tek sorgu). */
export async function countNullRowsSince(
  db: Db,
  since: Date,
  organizationId?: string | null,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(orders)
    .where(
      and(
        isNull(orders.marketplaceAccountId),
        gte(orders.createdAt, since),
        organizationId ? eq(orders.organizationId, organizationId) : sql`true`,
      ),
    )
  return Number(row?.total ?? 0)
}
