// CLI: Dashboard satış tutarsızlığı için READ-ONLY yerel sipariş mutabakatı.
// organizationId + providerAccountId (sellerId) + tarih aralığı kapsamında
// hesap-scoped yerel PostgreSQL metriklerini raporlar. HİÇBİR yazma, HİÇBİR
// provider çağrısı yapmaz. Hesap operatörün verdiği sellerId ile backend'de
// çözülür (istemci girdisi yetki kanıtı değildir). Ham order/PII/credential
// loglanmaz; yalnız sayı/tutar aggregate'i.
//
//   npm run orders:reconcile:diagnose -- \
//     --organization-id <org> --provider-account-id 2777221 \
//     --start 2026-07-01 --end 2026-07-31
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { getAccountByProviderAccountId } from '../integrations/marketplaceAccountRepository.ts'
import { reconcileLocalOrders } from './orderReconciliation.ts'
import { toCanonicalSummary } from './orderMetricDefinitions.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1]
  }
  return undefined
}
function parseDate(value: string | undefined, endOfDay = false): number | null {
  if (!value) return null
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[reconcile] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = parseArg('organization-id')
  const marketplace = parseArg('marketplace') ?? 'Trendyol'
  const providerAccountId = parseArg('provider-account-id')
  const startMs = parseDate(parseArg('start'))
  const endMs = parseDate(parseArg('end'), true)
  if (!organizationId || !providerAccountId || startMs == null || endMs == null) {
    console.error(
      '[reconcile] --organization-id, --provider-account-id, --start, --end zorunlu.',
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
      `[reconcile] Hesap bulunamadı: org=${organizationId} ${marketplace} providerAccountId=${providerAccountId}. ` +
        'Backfill/hesap kaydı gerekli olabilir.',
    )
    return 1
  }
  const report = await reconcileLocalOrders(db, {
    organizationId,
    marketplaceAccountId: account.id,
    startMs,
    endMs,
  })
  const canonical = toCanonicalSummary({
    distinctPackageIds: report.distinctPackageIds,
    orderLineCount: report.orderLineCount,
    lineQuantityTotal: report.lineQuantityTotal,
    totalAmount: report.totalAmount,
    byMarketplaceStatus: report.byMarketplaceStatus,
  })
  console.info(JSON.stringify({ report, canonical }, null, 2))
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    '[reconcile] Beklenmedik hata:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
