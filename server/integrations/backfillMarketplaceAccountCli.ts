// CLI: legacy (marketplaceAccountId IS NULL) kayıtları OPERATÖRÜN AÇIKÇA verdiği
// bir Trendyol hesabına bağlar. Hesap TAHMİN EDİLMEZ; operatör sellerId'yi verir.
//
// Dry-run (VARSAYILAN — DB'yi değiştirmez):
//   npm run marketplace-account:backfill -- \
//     --organization-id <UUID> --marketplace Trendyol \
//     --provider-account-id <SELLER_ID> --dry-run
//
// Apply (açık onay token'ı ile):
//   npm run marketplace-account:backfill -- \
//     --organization-id <UUID> --marketplace Trendyol \
//     --provider-account-id <SELLER_ID> --apply --confirmation-token <TOKEN>
//
// Rollback dry-run:
//   npm run marketplace-account:backfill -- --rollback-batch <BATCH_ID> --dry-run
// Rollback apply:
//   npm run marketplace-account:backfill -- --rollback-batch <BATCH_ID> --apply
//
// Manifest güvenli JSON olarak MARKETPLACE_BACKFILL_MANIFEST_DIR (vars. cwd)
// altına yazılır; secret/PII içermez ve git'e EKLENMEZ (.gitignore).
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  applyBackfill,
  applyRollback,
  BackfillConflictError,
  planBackfill,
  planRollback,
  type BackfillManifest,
} from './marketplaceAccountBackfill.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1]
  }
  return undefined
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function manifestDir(): string {
  return String(process.env.MARKETPLACE_BACKFILL_MANIFEST_DIR ?? process.cwd())
}
function manifestPath(batchId: string): string {
  return join(manifestDir(), `marketplace-account-backfill-${batchId}.json`)
}
function log(obj: unknown): void {
  console.info(JSON.stringify(obj, null, 2))
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[backfill] DATABASE_URL tanımlı değil; backfill çalıştırılamaz.')
    return 1
  }
  const db = getDb()
  const apply = hasFlag('apply')
  const rollbackBatch = parseArg('rollback-batch')

  // ── ROLLBACK yolu ─────────────────────────────────────────────────────────
  if (rollbackBatch) {
    let manifest: BackfillManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath(rollbackBatch), 'utf8')) as BackfillManifest
    } catch {
      console.error(
        `[backfill] Manifest bulunamadı: ${manifestPath(rollbackBatch)} ` +
          '(MARKETPLACE_BACKFILL_MANIFEST_DIR doğru mu?).',
      )
      return 1
    }
    if (!apply) {
      const plan = await planRollback(db, manifest)
      console.info('[backfill] ROLLBACK DRY-RUN (DB değişmedi):')
      log(plan)
      if (!plan.safe) {
        console.error(
          '[backfill] UYARI: bazı kayıtlar backfill\'den beri değişmiş; apply rollback DURUR.',
        )
      }
      return 0
    }
    const result = await applyRollback(db, manifest, new Date().toISOString())
    console.info('[backfill] ROLLBACK UYGULANDI:')
    log(result)
    return 0
  }

  // ── BACKFILL yolu ─────────────────────────────────────────────────────────
  const organizationId = parseArg('organization-id')
  const marketplace = parseArg('marketplace') ?? 'Trendyol'
  const providerAccountId = parseArg('provider-account-id')
  if (!organizationId || !providerAccountId) {
    console.error(
      '[backfill] --organization-id ve --provider-account-id zorunlu. ' +
        'Hesap TAHMİN EDİLMEZ; sellerId açıkça verilmelidir.',
    )
    return 1
  }
  const target = { organizationId, marketplace, providerAccountId }
  const plan = await planBackfill(db, target)

  if (!apply) {
    console.info('[backfill] DRY-RUN (DB değişmedi):')
    log(plan)
    if (!plan.targetAccountExists) {
      console.info(
        '[backfill] NOT: hedef hesap henüz YOK; apply sırasında PASİF olarak oluşturulur ' +
          '(aktif hesap değişmez).',
      )
    }
    const conflicts =
      plan.conflictingOrders + plan.conflictingProducts + plan.conflictingSyncStates
    if (conflicts > 0) {
      console.error(
        `[backfill] UYARI: ${conflicts} conflict var; apply DURACAK. Otomatik merge/delete YOK.`,
      )
    }
    console.info(`[backfill] Apply için onay token'ı: --confirmation-token ${plan.confirmationToken}`)
    return 0
  }

  const confirmationToken = parseArg('confirmation-token')
  if (!confirmationToken) {
    console.error(
      '[backfill] --apply için --confirmation-token zorunlu (dry-run çıktısındaki değer).',
    )
    return 1
  }
  const batchId = randomUUID()
  const appliedAt = new Date().toISOString()
  let manifest: BackfillManifest
  try {
    manifest = await applyBackfill(db, {
      ...target,
      confirmationToken,
      batchId,
      appliedAt,
    })
  } catch (error) {
    if (error instanceof BackfillConflictError) {
      console.error('[backfill] CONFLICT — hiçbir değişiklik yapılmadı (rollback):')
      log(error.conflicts)
      return 2
    }
    console.error(
      '[backfill] Apply başarısız (rollback):',
      error instanceof Error ? error.message : String(error),
    )
    return 1
  }
  try {
    mkdirSync(manifestDir(), { recursive: true })
  } catch {
    // dizin zaten olabilir
  }
  writeFileSync(manifestPath(batchId), JSON.stringify(manifest, null, 2), 'utf8')
  console.info('[backfill] APPLY tamamlandı. Manifest:', manifestPath(batchId))
  log({
    batchId: manifest.batchId,
    marketplaceAccountId: manifest.marketplaceAccountId,
    revertedOrders: manifest.after.scopedOrders,
    scoped: manifest.after,
    checksums: {
      orders: manifest.orders.checksum,
      products: manifest.products.checksum,
      syncStates: manifest.syncStates.checksum,
    },
  })
  console.info(`[backfill] Rollback için: --rollback-batch ${batchId} --dry-run`)
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    '[backfill] Beklenmedik hata:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
