// Account-scoped, idempotent HISTORICAL order backfill çekirdeği. Provider'dan
// (Trendyol) çekilmiş normalize edilmiş siparişleri YALNIZ hedef
// marketplaceAccountId kapsamında yerel PostgreSQL'e upsert eder. Mevcut
// operationStatus / LABEL_READY / LABEL_PRINTED / archived / first_seen / desi
// alanlarını EZMEZ (persistSyncResult → marketplaceUpdateSet operasyonel
// alanlara dokunmaz). complete=false ile çağrılır → reconcile/ARŞİVLEME YOK
// (yalnız ekler/günceller, silmez). Başka account/tenant'a dokunmaz.
import { createHash } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import { persistSyncResult } from './orderPersistenceService.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

// Historical fetch penceresinin GERÇEK ekseni: Trendyol'a verilen startDate/
// endDate pratikte orderDate DEĞİL packageLastModifiedDate aktivitesidir. Bu
// sabit manifest/plan içinde açıkça damgalanır (kullanıcı --start/--end'i
// "sipariş ayı" sanmasın).
export const BACKFILL_DATE_BASIS = 'marketplace_last_modified_at' as const

export interface BackfillScope {
  organizationId: string
  marketplaceAccountId: string
  startMs: number
  endMs: number
}

// Çekilen paketlerin orderDate DAĞILIMI (güvenli aggregate — ham ID/PII yok).
// Modified penceresi ile çekilen kayıtların HANGİ sipariş aylarına düştüğünü
// gösterir (ör. Haziran modified penceresinde Mayıs orderDate'li kayıtlar).
export interface OrderDateDistribution {
  min: string | null
  max: string | null
  byMonth: { month: string; count: number }[]
}

function computeOrderDateDistribution(
  providerOrders: Record<string, unknown>[],
): OrderDateDistribution {
  let minMs: number | null = null
  let maxMs: number | null = null
  const byMonth = new Map<string, number>()
  for (const order of providerOrders) {
    const ms = Date.parse(String(order.orderDate ?? ''))
    // new Date(0) (epoch) = orderDate bilinmiyor → dağılıma katılmaz.
    if (!Number.isFinite(ms) || ms <= 0) continue
    if (minMs == null || ms < minMs) minMs = ms
    if (maxMs == null || ms > maxMs) maxMs = ms
    const month = new Date(ms).toISOString().slice(0, 7) // YYYY-MM (UTC)
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1)
  }
  return {
    min: minMs == null ? null : new Date(minMs).toISOString(),
    max: maxMs == null ? null : new Date(maxMs).toISOString(),
    byMonth: [...byMonth.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  }
}

export function computeConfirmationToken(scope: BackfillScope): string {
  return createHash('sha256')
    .update(
      `${scope.organizationId}|${scope.marketplaceAccountId}|${scope.startMs}|${scope.endMs}`,
    )
    .digest('hex')
    .slice(0, 16)
}

function packageIdsOf(providerOrders: Record<string, unknown>[]): Set<string> {
  const set = new Set<string>()
  for (const order of providerOrders) {
    const id = String(order.packageId ?? order.shipmentPackageId ?? '').trim()
    if (id) set.add(id)
  }
  return set
}

async function localPackageIds(
  db: Db,
  scope: BackfillScope,
  candidateIds: string[],
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set()
  const rows = await db
    .select({ packageId: orders.packageId })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, scope.organizationId),
        eq(orders.marketplaceAccountId, scope.marketplaceAccountId),
        inArray(orders.packageId, candidateIds),
      ),
    )
  return new Set(rows.map((r: { packageId: string }) => String(r.packageId)))
}

export interface BackfillPlan {
  organizationId: string
  marketplaceAccountId: string
  // Tarih ekseni AÇIK: startDate/endDate bir MODIFIED aktivite penceresidir,
  // sipariş ayı DEĞİL.
  dateBasis: typeof BACKFILL_DATE_BASIS
  fetchedModifiedWindow: { start: string; end: string }
  startDate: string
  endDate: string
  providerPackageCount: number
  localPackageCount: number
  missingCount: number
  updateNeededCount: number
  conflictCount: number
  providerStatusBuckets: { key: string; count: number }[]
  // Çekilen paketlerin GERÇEK orderDate dağılımı (modified penceresi ≠ sipariş ayı).
  resultingOrderDateMinMax: { min: string | null; max: string | null }
  resultingOrderDateBuckets: { month: string; count: number }[]
  confirmationToken: string
  willModify: false
}

// DRY-RUN: DB'yi DEĞİŞTİRMEZ. Provider (çekilmiş) vs yerel kapsam farkını raporlar.
export async function planBackfill(
  db: Db,
  scope: BackfillScope,
  providerOrders: Record<string, unknown>[],
): Promise<BackfillPlan> {
  const providerIds = packageIdsOf(providerOrders)
  const existing = await localPackageIds(db, scope, [...providerIds])
  let missing = 0
  for (const id of providerIds) if (!existing.has(id)) missing += 1
  const statusBuckets = new Map<string, number>()
  for (const order of providerOrders) {
    const key = String(order.marketplaceStatus ?? '(null)')
    statusBuckets.set(key, (statusBuckets.get(key) ?? 0) + 1)
  }
  const distribution = computeOrderDateDistribution(providerOrders)
  const startDate = new Date(scope.startMs).toISOString()
  const endDate = new Date(scope.endMs).toISOString()
  return {
    organizationId: scope.organizationId,
    marketplaceAccountId: scope.marketplaceAccountId,
    dateBasis: BACKFILL_DATE_BASIS,
    fetchedModifiedWindow: { start: startDate, end: endDate },
    startDate,
    endDate,
    providerPackageCount: providerIds.size,
    localPackageCount: existing.size,
    missingCount: missing,
    updateNeededCount: existing.size,
    // Account-scoped upsert: aynı hesap+packageId sadece GÜNCELLENİR (unique
    // çakışması yok). Conflict yalnız farklı-hesap senaryosunda olurdu; backfill
    // yalnız hedef hesaba yazdığından 0.
    conflictCount: 0,
    providerStatusBuckets: [...statusBuckets.entries()].map(([key, count]) => ({ key, count })),
    resultingOrderDateMinMax: { min: distribution.min, max: distribution.max },
    resultingOrderDateBuckets: distribution.byMonth,
    confirmationToken: computeConfirmationToken(scope),
    willModify: false,
  }
}

export interface BackfillManifest {
  batchId: string
  organizationId: string
  marketplaceAccountId: string
  // Tarih ekseni AÇIK: pencere MODIFIED aktivitesidir, sipariş ayı DEĞİL.
  dateBasis: typeof BACKFILL_DATE_BASIS
  fetchedModifiedWindow: { start: string; end: string }
  startDate: string
  endDate: string
  appliedAt: string
  providerComplete: boolean
  failedWindows: number
  before: { localPackageCount: number }
  after: { insertedCount: number; updatedCount: number; failedCount: number }
  // Yazılan paketlerin GERÇEK orderDate dağılımı (modified penceresi ≠ sipariş ayı).
  resultingOrderDateMinMax: { min: string | null; max: string | null }
  resultingOrderDateBuckets: { month: string; count: number }[]
  checksum: string
}

export interface ApplyOptions extends BackfillScope {
  confirmationToken: string
  batchId: string
  appliedAt: string
  providerComplete: boolean
  failedWindows: number
}

// APPLY: onay token'ı doğrulanır; YALNIZ hedef account'a upsert (complete=false →
// reconcile/arşiv YOK). Idempotent. Manifest döner. Provider PARTIAL ise
// (failedWindows>0) manifest'te providerComplete=false → sessizce COMPLETE sayılmaz.
export async function applyBackfill(
  db: Db,
  options: ApplyOptions,
  providerOrders: Record<string, unknown>[],
): Promise<BackfillManifest> {
  const expected = computeConfirmationToken(options)
  if (options.confirmationToken !== expected) {
    throw new Error(
      'Onay token\'ı hedefle (org|account|start|end) eşleşmiyor; apply reddedildi.',
    )
  }
  const providerIds = packageIdsOf(providerOrders)
  const beforeLocal = await localPackageIds(db, options, [...providerIds])

  const result = await persistSyncResult(db, options.organizationId, providerOrders, {
    complete: false,
    marketplaceAccountId: options.marketplaceAccountId,
    fetchedCount: providerOrders.length,
  })

  const checksum = createHash('sha256')
    .update([...providerIds].sort().join(','))
    .digest('hex')
    .slice(0, 16)

  const distribution = computeOrderDateDistribution(providerOrders)
  const startDate = new Date(options.startMs).toISOString()
  const endDate = new Date(options.endMs).toISOString()
  return {
    batchId: options.batchId,
    organizationId: options.organizationId,
    marketplaceAccountId: options.marketplaceAccountId,
    dateBasis: BACKFILL_DATE_BASIS,
    fetchedModifiedWindow: { start: startDate, end: endDate },
    startDate,
    endDate,
    appliedAt: options.appliedAt,
    providerComplete: options.providerComplete,
    failedWindows: options.failedWindows,
    before: { localPackageCount: beforeLocal.size },
    after: {
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount,
      failedCount: result.failedCount,
    },
    resultingOrderDateMinMax: { min: distribution.min, max: distribution.max },
    resultingOrderDateBuckets: distribution.byMonth,
    checksum,
  }
}
