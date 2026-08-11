// CLI: TEK BOZUK SİPARİŞ SATIRI TEMİZLİĞİ — VARSAYILAN OLARAK KURU ÇALIŞMA.
//
// Kuru çalışma (hiçbir şey silinmez):
//   npm run orders:malformed:cleanup -- \
//     --id 2e45b831-dc0e-46b1-824d-5af5fc8f01c0 \
//     --package-id 0 --order-number 11496311967 \
//     --valid-package-id 4068544739
//
// Uygulamak için AYNI komuta `--apply` eklenir.
//
// YAPAR : hedef satırı ve GEÇERLİ karşılığını doğrular, bağımlı kayıtları
//         sayar, `--apply` ile TEK transaction'da yalnız hedef satırı ve ona
//         bağlı `order_lines` kayıtlarını siler.
// YAPMAZ: başka satır silme · toplu temizlik · taşıyıcı (Sürat) API çağrısı ·
//         Trendyol write · shipment/shipment_operation silme · migration.
//
// GÜVENLİK: dört kimlik parametresinin TAMAMI zorunludur ve satırla birebir
// eşleşmelidir. Taşıyıcı kaydı (shipment/operation) varsa işlem YAPILMAZ.
// PII YOK: yalnız teknik kimlikler ve sayımlar yazdırılır.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  cleanupMalformedOrder,
  inspectCleanupTarget,
  type CleanupTarget,
} from './malformedOrderCleanup.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

/**
 * ÇALIŞAN SÜRÜMDE KİMLİK GUARD'I VAR MI?
 *
 * Guard olmadan temizlik yapmak anlamsızdır: bir sonraki senkron turu aynı
 * satırı yeniden yazardı. Kontrol, ÇALIŞAN checkout'un kaynağı üzerinden
 * yapılır (deploy edilmiş revizyon).
 */
function isIdentityGuardDeployed(): boolean {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(here, '..', 'index.mjs'), 'utf8')
    return (
      source.includes('function resolveTrendyolPackageIdentity') &&
      source.includes('PLACEHOLDER_PACKAGE_IDENTITIES')
    )
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const id = parseArg('id')
  const malformedPackageId = parseArg('package-id')
  const orderNumber = parseArg('order-number')
  const validPackageId = parseArg('valid-package-id')
  const apply = process.argv.includes('--apply')

  if (!id || !malformedPackageId || !orderNumber || !validPackageId) {
    console.error(
      'Kullanım: --id <uuid> --package-id <bozuk> --order-number <no> ' +
        '--valid-package-id <gerçek> [--apply]',
    )
    process.exitCode = 1
    return
  }
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL tanımlı değil.')
    process.exitCode = 1
    return
  }

  const guardDeployed = isIdentityGuardDeployed()
  const target: CleanupTarget = {
    id,
    malformedPackageId,
    orderNumber,
    validPackageId,
  }
  const db = getDb()

  const inspection = await inspectCleanupTarget(db, target)
  const summarize = (row: Record<string, unknown> | null) =>
    row
      ? {
          id: row.id,
          marketplaceAccountId: row.marketplaceAccountId,
          marketplace: row.marketplace,
          packageId: row.packageId,
          orderNumber: row.orderNumber,
          marketplaceStatus: row.marketplaceStatus,
          operationStatus: row.operationStatus,
          archived: Boolean(row.archivedAt),
        }
      : null

  // GUARD YOKSA UYGULAMA YOK: yeni bozuk satır oluşumu durmadan temizlik
  // anlamsızdır (bir sonraki tur aynı satırı yeniden yazardı).
  const blockedByGuard = apply && !guardDeployed
  const result =
    apply && guardDeployed && inspection.safe
      ? await cleanupMalformedOrder(db, target)
      : { applied: false, deletedOrders: 0, deletedOrderLines: 0, violations: inspection.violations }

  const after = result.applied ? await inspectCleanupTarget(db, target) : null

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry_run',
        identityGuardDeployed: guardDeployed,
        blockedByMissingGuard: blockedByGuard,
        preCleanup: {
          target: summarize(inspection.target),
          valid: summarize(inspection.valid),
          childCounts: inspection.childCounts,
        },
        violations: inspection.violations,
        safe: inspection.safe,
        applied: result.applied,
        deletedOrders: result.deletedOrders,
        deletedOrderLines: result.deletedOrderLines,
        postCleanup: after
          ? {
              target: summarize(after.target),
              valid: summarize(after.valid),
              violations: after.violations,
            }
          : null,
      },
      null,
      2,
    ),
  )
  if (apply && !result.applied) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('temizlik başarısız:', (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
