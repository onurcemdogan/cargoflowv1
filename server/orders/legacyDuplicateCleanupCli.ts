// CLI: FAZ 1 LEGACY TEKRAR TEMİZLİĞİ — VARSAYILAN OLARAK KURU ÇALIŞMA.
//
// Kuru çalışma (HİÇBİR yazma yok):
//   npm run orders:legacy-duplicates:cleanup
//   npm run orders:legacy-duplicates:cleanup -- --org <uuid> --batch 25
//
// Uygulamak için AYNI komuta `--apply` eklenir.
//
// KAPSAM: YALNIZ `active_plus_legacy`. `null_shadow` bu fazda kod düzeyinde
// SERT ENGELLİDİR. Silinen tek şey pasif hesap kapsamındaki sipariş satırı
// ve ona bağlı `order_lines`'tır; gönderi/operasyon/aktif satır/hesap ve
// entegrasyon durumu ASLA silinmez. Taşıyıcı veya Trendyol çağrısı YOKTUR.
import { and, eq, sql } from 'drizzle-orm'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  marketplaceAccounts,
  orders,
  shipmentOperations,
  shipments,
} from '../db/schema.ts'
import { auditCrossAccountDuplicates } from './crossAccountDuplicateAudit.ts'
import {
  applyPhase1Target,
  planPhase1Cleanup,
  type Phase1SkipReason,
} from './legacyDuplicateCleanup.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

/** Doğrulama anlık görüntüsü (salt okuma). */
async function snapshot(db: unknown, organizationId: string | null) {
  const database = db as any /* eslint-disable-line @typescript-eslint/no-explicit-any */
  const orgScope = organizationId
    ? eq(orders.organizationId, organizationId)
    : sql`true`
  const [orderCount] = await database
    .select({ total: sql<number>`count(*)` })
    .from(orders)
    .where(orgScope)
  const [shipmentCount] = await database
    .select({ total: sql<number>`count(*)` })
    .from(shipments)
  const [operationCount] = await database
    .select({ total: sql<number>`count(*)` })
    .from(shipmentOperations)
  return {
    orderRowCount: Number(orderCount?.total ?? 0),
    shipmentCount: Number(shipmentCount?.total ?? 0),
    shipmentOperationCount: Number(operationCount?.total ?? 0),
  }
}

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }
  const organizationId = parseArg('org') ?? null
  const batchSize = Math.max(1, Math.min(100, Number(parseArg('batch') ?? 25)))
  const apply = process.argv.includes('--apply')
  const db = getDb()

  // Hesap durumları (credential OKUNMAZ).
  const accountRows = (await db
    .select({
      id: marketplaceAccounts.id,
      isActive: marketplaceAccounts.isActive,
    })
    .from(marketplaceAccounts)
    .where(
      organizationId
        ? and(
            eq(marketplaceAccounts.organizationId, organizationId),
            eq(marketplaceAccounts.marketplace, 'Trendyol'),
          )
        : eq(marketplaceAccounts.marketplace, 'Trendyol'),
    )) as { id: string; isActive: boolean }[]
  const activeAccountIds = accountRows.filter((r) => r.isActive).map((r) => r.id)
  const inactiveAccountIds = accountRows
    .filter((r) => !r.isActive)
    .map((r) => r.id)

  const before = await snapshot(db, organizationId)
  const beforeDuplicates = await auditCrossAccountDuplicates(db, {
    organizationId,
    activeAccountIds,
    sampleLimit: 1,
  })

  const plan = await planPhase1Cleanup(db, {
    organizationId,
    activeAccountIds,
    inactiveAccountIds,
    batchSize,
  })

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          mode: 'dry_run',
          phase: 'active_plus_legacy_only',
          scanned: plan.activePlusLegacyTotal,
          eligible: plan.activePlusLegacyEligible,
          blocked: plan.activePlusLegacyBlocked,
          batchSize,
          wouldDeleteOrders: plan.expectedOrderDeletes,
          wouldDeleteOrderLines: plan.expectedOrderLineDeletes,
          blockedReasons: plan.blockedReasons,
          samples: plan.targets.slice(0, 10),
          nullShadowTouched: false,
          cleanupPerformed: false,
        },
        null,
        2,
      ),
    )
    return
  }

  // ── UYGULAMA: her hedef KENDİ transaction'ında yeniden doğrulanır ────────
  let deletedOrders = 0
  let deletedOrderLines = 0
  let skippedChangedSinceAudit = 0
  let failed = 0
  const skipReasons: Record<string, number> = {}
  for (const target of plan.targets) {
    try {
      const result = await applyPhase1Target(db, target, {
        activeAccountIds,
        inactiveAccountIds,
      })
      if (result.applied) {
        deletedOrders += result.deletedOrders
        deletedOrderLines += result.deletedOrderLines
      } else {
        skippedChangedSinceAudit += 1
        const reason = (result.reason ?? 'unknown') as Phase1SkipReason
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
      }
    } catch {
      // TEK HEDEF HATASI TÜM ÇALIŞMAYI DÜŞÜRMEZ (idempotent yeniden çalıştırma).
      failed += 1
    }
  }

  const after = await snapshot(db, organizationId)
  const afterDuplicates = await auditCrossAccountDuplicates(db, {
    organizationId,
    activeAccountIds,
    sampleLimit: 1,
  })

  console.log(
    JSON.stringify(
      {
        mode: 'apply',
        phase: 'active_plus_legacy_only',
        batchSize,
        deletedOrders,
        deletedOrderLines,
        skippedChangedSinceAudit,
        skipReasons,
        blocked: plan.activePlusLegacyBlocked,
        failed,
        // ── SONRASI DOĞRULAMA (salt okuma) ─────────────────────────────────
        verification: {
          orderRowCountBefore: before.orderRowCount,
          orderRowCountAfter: after.orderRowCount,
          shipmentCountBefore: before.shipmentCount,
          shipmentCountAfter: after.shipmentCount,
          shipmentCountUnchanged:
            before.shipmentCount === after.shipmentCount,
          shipmentOperationCountBefore: before.shipmentOperationCount,
          shipmentOperationCountAfter: after.shipmentOperationCount,
          shipmentOperationCountUnchanged:
            before.shipmentOperationCount === after.shipmentOperationCount,
          duplicatePackagesBefore: beforeDuplicates.duplicatePackageCount,
          duplicatePackagesAfter: afterDuplicates.duplicatePackageCount,
          nullShadowBefore: beforeDuplicates.classCounts.null_shadow ?? 0,
          nullShadowAfter: afterDuplicates.classCounts.null_shadow ?? 0,
          nullShadowUnchanged:
            (beforeDuplicates.classCounts.null_shadow ?? 0) ===
            (afterDuplicates.classCounts.null_shadow ?? 0),
        },
        nullShadowTouched: false,
        cleanupPerformed: deletedOrders > 0,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((error) => {
    console.error('temizlik başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
