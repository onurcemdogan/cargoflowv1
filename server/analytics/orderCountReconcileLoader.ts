// Durusoft ↔ CargoFlow sayı mutabakatı — SALT OKUNUR veri yolu.
//
// YALNIZ select. INSERT/UPDATE/DELETE YOK, provider (Trendyol/Sürat) çağrısı
// YOK. Ham PII bu modülden dışarı taşınmaz; çağıran yalnız aggregate + SHA-256
// parmak izi raporlar.
import { and, eq, gte, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { orderLines, orders } from '../db/schema.ts'
import { getAccountByProviderAccountId } from '../integrations/marketplaceAccountRepository.ts'
import { resolvePageSize } from '../orders/orderRepository.ts'
import type { PackageFacts } from './orderCountReconcile.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface ReconcileScope {
  organizationId: string
  marketplace: string
  providerAccountId?: string
  startIso: string
  endIso: string
}

export interface LocalScopeResult {
  accountResolved: boolean
  marketplaceAccountId: string | null
  // Kapsamdaki TÜM kayıtlar — sayfa sınırı UYGULANMADAN.
  rows: PackageFacts[]
  // Aynı kapsamda başka hesaba yazılmış paket sayısı.
  accountScopeMismatchCount: number
  nullAccountCount: number
  duplicatePackageIds: number
  ordersWithoutLines: number
  archivedCount: number
  operationStatusBuckets: Record<string, number>
}

function bucket(map: Record<string, number>, key: unknown): void {
  const k = String(key ?? '').trim() || 'null'
  map[k] = (map[k] ?? 0) + 1
}

// Kapsamdaki tüm siparişleri orderDate ekseninde yükler (SAYFA SINIRI YOK).
export async function loadLocalScope(
  db: Db,
  scope: ReconcileScope,
): Promise<LocalScopeResult> {
  let marketplaceAccountId: string | null = null
  if (scope.providerAccountId) {
    const account = await getAccountByProviderAccountId(
      db,
      scope.organizationId,
      scope.marketplace,
      scope.providerAccountId,
    )
    if (!account) {
      return {
        accountResolved: false,
        marketplaceAccountId: null,
        rows: [],
        accountScopeMismatchCount: 0,
        nullAccountCount: 0,
        duplicatePackageIds: 0,
        ordersWithoutLines: 0,
        archivedCount: 0,
        operationStatusBuckets: {},
      }
    }
    marketplaceAccountId = account.id
  }

  const dateWindow = and(
    gte(orders.orderDate, new Date(scope.startIso)),
    lt(orders.orderDate, new Date(scope.endIso)),
  )
  const base = and(
    eq(orders.organizationId, scope.organizationId),
    eq(orders.marketplace, scope.marketplace),
    dateWindow,
  )

  const scoped = marketplaceAccountId
    ? and(base, eq(orders.marketplaceAccountId, marketplaceAccountId))
    : base

  const rawRows = await db
    .select({
      id: orders.id,
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
      archivedAt: orders.archivedAt,
      marketplaceAccountId: orders.marketplaceAccountId,
      orderDate: orders.orderDate,
      marketplaceLastModifiedAt: orders.marketplaceLastModifiedAt,
    })
    .from(orders)
    .where(scoped)

  // Satır/adet toplamları AYRI ve gruplu sorguyla çözülür. (Korele alt sorgu
  // sürücüye göre 0 dönebiliyor; sayım doğruluğu buna bırakılmaz.)
  const lineAgg = await db
    .select({
      orderId: orderLines.orderId,
      lineCount: sql<number>`count(*)::int`,
      quantityTotal: sql<number>`coalesce(sum(${orderLines.quantity}), 0)::int`,
    })
    .from(orderLines)
    .where(eq(orderLines.organizationId, scope.organizationId))
    .groupBy(orderLines.orderId)
  const lineByOrder = new Map<string, { lineCount: number; quantityTotal: number }>()
  for (const row of lineAgg as Array<Record<string, unknown>>) {
    lineByOrder.set(String(row.orderId), {
      lineCount: Number(row.lineCount ?? 0),
      quantityTotal: Number(row.quantityTotal ?? 0),
    })
  }

  const operationStatusBuckets: Record<string, number> = {}
  const seenPackages = new Set<string>()
  let duplicatePackageIds = 0
  let ordersWithoutLines = 0
  let archivedCount = 0

  const rows: PackageFacts[] = rawRows.map((row: Record<string, unknown>) => {
    const packageId = String(row.packageId ?? '')
    if (seenPackages.has(packageId)) duplicatePackageIds += 1
    else seenPackages.add(packageId)
    const lines = lineByOrder.get(String(row.id)) ?? {
      lineCount: 0,
      quantityTotal: 0,
    }
    if (lines.lineCount === 0) ordersWithoutLines += 1
    if (row.archivedAt) archivedCount += 1
    bucket(operationStatusBuckets, row.operationStatus)
    const toIso = (value: unknown): string | undefined =>
      value instanceof Date ? value.toISOString() : (value ? String(value) : undefined)
    return {
      packageId,
      orderNumber: String(row.orderNumber ?? ''),
      marketplaceStatus: String(row.marketplaceStatus ?? ''),
      operationStatus: String(row.operationStatus ?? ''),
      archived: Boolean(row.archivedAt),
      marketplaceAccountId: (row.marketplaceAccountId as string | null) ?? null,
      lineCount: lines.lineCount,
      quantityTotal: lines.quantityTotal,
      orderDate: toIso(row.orderDate),
      marketplaceLastModifiedAt: toIso(row.marketplaceLastModifiedAt),
    }
  })

  // Aynı dönemde BAŞKA hesaba (veya hesapsız) yazılmış paketler.
  let accountScopeMismatchCount = 0
  let nullAccountCount = 0
  if (marketplaceAccountId) {
    const others = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          base,
          or(
            isNull(orders.marketplaceAccountId),
            ne(orders.marketplaceAccountId, marketplaceAccountId),
          ),
        ),
      )
    accountScopeMismatchCount = Number(others[0]?.value ?? 0)
    const nulls = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(base, isNull(orders.marketplaceAccountId)))
    nullAccountCount = Number(nulls[0]?.value ?? 0)
  }

  return {
    accountResolved: true,
    marketplaceAccountId,
    rows,
    accountScopeMismatchCount,
    nullAccountCount,
    duplicatePackageIds,
    ordersWithoutLines,
    archivedCount,
    operationStatusBuckets,
  }
}

export interface UiLoadModel {
  // UI'nin GERÇEKTEN kullandığı sayfa boyutu (istek parametresi vermeden).
  effectivePageSize: number
  // Backend'in bildirdiği toplam (COUNT(*), sayfa sınırından bağımsız).
  backendReportedTotal: number
  // Tek istekte UI'ye inen kayıt sayısı.
  loadedCount: number
  requestsAllPages: boolean
  truncated: boolean
}

// CargoFlow sipariş listesinin GERÇEK yükleme davranışını yeniden üretir.
// Frontend loadOrdersFromServer() hiçbir filtre/pageSize GÖNDERMEZ; bu yüzden
// backend varsayılan sayfa boyutu uygulanır.
export async function describeUiLoad(
  db: Db,
  scope: ReconcileScope,
  marketplaceAccountId: string | null,
): Promise<UiLoadModel> {
  // Frontend hiç pageSize göndermediği için backend varsayılanı geçerlidir.
  const effectivePageSize = resolvePageSize(undefined)
  const where = and(
    eq(orders.organizationId, scope.organizationId),
    ...(marketplaceAccountId
      ? [eq(orders.marketplaceAccountId, marketplaceAccountId)]
      : []),
  )
  const totalRows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orders)
    .where(where)
  const backendReportedTotal = Number(totalRows[0]?.value ?? 0)
  const loadedCount = Math.min(backendReportedTotal, effectivePageSize)
  return {
    effectivePageSize,
    backendReportedTotal,
    loadedCount,
    // Sipariş listesi ürün kataloğundan farklı olarak sayfaları DOLAŞMAZ.
    requestsAllPages: false,
    truncated: backendReportedTotal > loadedCount,
  }
}
