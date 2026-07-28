// CLI: Dashboard satış kartlarını GERÇEK frontend fonksiyonlarıyla BİREBİR
// yeniden üretir (reproduce) ve iki tarih EKSENİ modelini (orderDate kohortu vs
// marketplaceLastModifiedAt aktivitesi) yan yana raporlar. READ-ONLY: DB YAZMAZ,
// provider ÇAĞIRMAZ. Hesap operatörün verdiği providerAccountId ile BACKEND'de
// çözülür (istemci girdisi yetki kanıtı DEĞİLDİR). Ham order/PII/credential
// LOGLANMAZ; yalnız güvenli aggregate + kart değerleri.
//
//   npm run dashboard:reconcile -- \
//     --organization-id <org> --provider-account-id 277221 \
//     --as-of 2026-07-28T20:00:00Z --dry-run
//
// --as-of ZORUNLUDUR: eski ekran görüntüsü alınan an ile bugünkü veriyi
// karıştırmamak için değerlendirme anını sabitler (deterministik).
import { createServer } from 'vite'
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import { getAccountByProviderAccountId } from '../integrations/marketplaceAccountRepository.ts'
import { listOrdersForAnalytics } from '../orders/orderPersistenceService.ts'
import { reconcileLocalOrders } from './orderReconciliation.ts'
import { SALES_DATE_BASIS_LABEL } from './orderMetricDefinitions.ts'
import {
  buildDashboardReconciliationReport,
  type RefundDataSource,
  type SalesPeriodCardLike,
} from './dashboardReconcileReport.ts'

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1]
  }
  return undefined
}

async function main(): Promise<number> {
  if (!isDatabaseConfigured()) {
    console.error('[dashboard:reconcile] DATABASE_URL tanımlı değil.')
    return 1
  }
  const organizationId = parseArg('organization-id')
  const marketplace = parseArg('marketplace') ?? 'Trendyol'
  const providerAccountId = parseArg('provider-account-id')
  const asOfRaw = parseArg('as-of')
  if (!organizationId || !providerAccountId || !asOfRaw) {
    console.error(
      '[dashboard:reconcile] --organization-id, --provider-account-id, --as-of zorunlu.',
    )
    return 1
  }
  const asOfMs = Date.parse(asOfRaw)
  if (!Number.isFinite(asOfMs)) {
    console.error(`[dashboard:reconcile] --as-of geçersiz tarih: ${asOfRaw}`)
    return 1
  }
  const asOf = new Date(asOfMs)

  const db = getDb()
  const account = await getAccountByProviderAccountId(
    db,
    organizationId,
    marketplace,
    providerAccountId,
  )
  if (!account) {
    console.error(
      `[dashboard:reconcile] Hesap bulunamadı: org=${organizationId} ` +
        `${marketplace} providerAccountId=${providerAccountId}.`,
    )
    return 1
  }

  // Kartların (bugün/dün/ay/geçen ay) hesaplanabilmesi için orderDate'i geçen
  // ay başından as-of'a kadar olan siparişleri yükle (cap yok, account-scoped).
  const windowStartMs = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 2, 1)
  const salesSource = await listOrdersForAnalytics(
    db,
    organizationId,
    { startMs: windowStartMs, endMs: asOfMs },
    account.id,
  )

  // GERÇEK frontend fonksiyonları (vite ssrLoadModule). buildDashboardViewModel
  // ve buildDashboardSalesPeriodCards UI'nın kullandığı AYNI koddur.
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  try {
    const { buildDashboardSalesPeriodCards, buildDashboardViewModel } =
      (await vite.ssrLoadModule('/src/dashboard/dashboardViewModel.ts')) as {
        buildDashboardSalesPeriodCards: (
          orders: unknown[],
          now?: Date,
          claims?: unknown[],
        ) => SalesPeriodCardLike[] & { key: string }[]
        buildDashboardViewModel: (input: unknown) => {
          salesSummary: { refundDataSource: RefundDataSource }
        }
      }

    const cards = buildDashboardSalesPeriodCards(salesSource, asOf) as Array<
      SalesPeriodCardLike & { key: string }
    >
    const monthCard = cards.find((card) => card.key === 'month')
    const lastMonthCard = cards.find((card) => card.key === 'lastMonth')
    if (!monthCard || !lastMonthCard) {
      console.error('[dashboard:reconcile] ay/geçen ay kartı çözülemedi.')
      return 1
    }

    // refundDataSource GERÇEK viewModel'den (auth/local-only: claimsAvailable=false).
    const model = buildDashboardViewModel({
      orders: [],
      analyticsOrders: salesSource,
      selectedPeriod: { key: 'month' },
      now: asOf,
      claimsAvailable: false,
    })
    const refundDataSource = model.salesSummary.refundDataSource

    const report = await buildDashboardReconciliationReport({
      providerAccountId,
      marketplaceAccountId: account.id,
      asOf: asOf.toISOString(),
      salesDateBasisLabel: SALES_DATE_BASIS_LABEL,
      monthCard,
      lastMonthCard,
      refundDataSource,
      reconcile: (args) =>
        reconcileLocalOrders(db, {
          organizationId,
          marketplaceAccountId: account.id,
          startMs: args.startMs,
          endMs: args.endMs,
          dateBasis: args.dateBasis,
        }),
    })
    console.info(JSON.stringify(report, null, 2))
    return 0
  } finally {
    await vite.close()
  }
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    '[dashboard:reconcile] Beklenmedik hata:',
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
