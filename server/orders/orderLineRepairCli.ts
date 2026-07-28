// CLI: account-scoped order_line DUPLICATE onarımı. Kanıtlanmış duplicate
// satırları (aynı canonical anahtar + aynı içerik) kaldırır; gerçek quantity=2
// veya iki gerçek provider satırını KORUR. Hesap operatörün verdiği
// providerAccountId ile BACKEND'de çözülür (istemci girdisi yetki kanıtı DEĞİL).
// Dry-run varsayılan (DB YAZMAZ); apply --confirmation-token ister. orders/
// operationStatus/LABEL/desi/shipment DEĞİŞMEZ. Ham PII/provider id LOGLANMAZ.
//
//   npm run order-lines:repair -- --organization-id <org> \
//     --provider-account-id 277221 --dry-run
//   npm run order-lines:repair -- ... --apply --confirmation-token <TOKEN>
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { getAccountByProviderAccountId } from '../integrations/marketplaceAccountRepository.ts'
import { applyOrderLineRepair, planOrderLineRepair } from './orderLineRepair.ts'

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return undefined
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function manifestDir(): string {
  return String(process.env.ORDER_BACKFILL_MANIFEST_DIR ?? process.cwd())
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[order-lines:repair] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = parseArg('organization-id')
  const marketplace = parseArg('provider') ?? 'Trendyol'
  const providerAccountId = parseArg('provider-account-id')
  const apply = hasFlag('apply')
  if (!organizationId || !providerAccountId) {
    console.error(
      '[order-lines:repair] --organization-id, --provider-account-id zorunlu.',
    )
    return 1
  }
  const db = getDb()
  const account = await getAccountByProviderAccountId(
    db,
    organizationId,
    marketplace,
    providerAccountId,
  )
  if (!account) {
    console.error(
      `[order-lines:repair] Hesap bulunamadı: org=${organizationId} ` +
        `${marketplace} providerAccountId=${providerAccountId}.`,
    )
    return 1
  }
  const scope = { organizationId, marketplaceAccountId: account.id }

  if (!apply) {
    const { plan } = await planOrderLineRepair(db, scope)
    console.info('[order-lines:repair] DRY-RUN (DB değişmedi):')
    console.info(JSON.stringify(plan, null, 2))
    console.info(
      `[order-lines:repair] Apply için: --apply --confirmation-token ${plan.confirmationToken}`,
    )
    return 0
  }

  const confirmationToken = parseArg('confirmation-token')
  if (!confirmationToken) {
    console.error('[order-lines:repair] --apply için --confirmation-token zorunlu.')
    return 1
  }
  const batchId = randomUUID()
  const appliedAt = new Date().toISOString()
  const manifest = await applyOrderLineRepair(db, scope, {
    confirmationToken,
    batchId,
    appliedAt,
  })
  try {
    mkdirSync(manifestDir(), { recursive: true })
  } catch {
    // dizin zaten olabilir
  }
  const manifestPath = join(manifestDir(), `order-line-repair-${batchId}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  console.info('[order-lines:repair] APPLY tamamlandı. Manifest:', manifestPath)
  console.info(JSON.stringify(manifest, null, 2))
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    '[order-lines:repair] Hata:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
