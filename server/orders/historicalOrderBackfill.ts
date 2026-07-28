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

export interface BackfillScope {
  organizationId: string
  marketplaceAccountId: string
  startMs: number
  endMs: number
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
  startDate: string
  endDate: string
  providerPackageCount: number
  localPackageCount: number
  missingCount: number
  updateNeededCount: number
  conflictCount: number
  providerStatusBuckets: { key: string; count: number }[]
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
  return {
    organizationId: scope.organizationId,
    marketplaceAccountId: scope.marketplaceAccountId,
    startDate: new Date(scope.startMs).toISOString(),
    endDate: new Date(scope.endMs).toISOString(),
    providerPackageCount: providerIds.size,
    localPackageCount: existing.size,
    missingCount: missing,
    updateNeededCount: existing.size,
    // Account-scoped upsert: aynı hesap+packageId sadece GÜNCELLENİR (unique
    // çakışması yok). Conflict yalnız farklı-hesap senaryosunda olurdu; backfill
    // yalnız hedef hesaba yazdığından 0.
    conflictCount: 0,
    providerStatusBuckets: [...statusBuckets.entries()].map(([key, count]) => ({ key, count })),
    confirmationToken: computeConfirmationToken(scope),
    willModify: false,
  }
}

export interface BackfillManifest {
  batchId: string
  organizationId: string
  marketplaceAccountId: string
  startDate: string
  endDate: string
  appliedAt: string
  providerComplete: boolean
  failedWindows: number
  before: { localPackageCount: number }
  after: { insertedCount: number; updatedCount: number; failedCount: number }
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

  return {
    batchId: options.batchId,
    organizationId: options.organizationId,
    marketplaceAccountId: options.marketplaceAccountId,
    startDate: new Date(options.startMs).toISOString(),
    endDate: new Date(options.endMs).toISOString(),
    appliedAt: options.appliedAt,
    providerComplete: options.providerComplete,
    failedWindows: options.failedWindows,
    before: { localPackageCount: beforeLocal.size },
    after: {
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount,
      failedCount: result.failedCount,
    },
    checksum,
  }
}
