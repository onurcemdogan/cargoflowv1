// CLI: Durusoft ↔ CargoFlow sipariş/paket sayısı mutabakatı — SALT OKUNUR.
//
// Provider (Trendyol/Sürat) çağrısı YAPMAZ, DB'ye YAZMAZ, gönderi
// OLUŞTURMAZ. Yalnız mevcut yerel kayıtları okur ve CargoFlow'un GERÇEK
// yükleme davranışını yeniden üretir.
//
//   npm run orders:count-reconcile -- \
//     --organization-id b309a548-... \
//     --provider-account-id 277221 \
//     --start 2026-07-28T10:39:00.000Z \
//     --end 2026-08-02T10:39:00.000Z \
//     --dry-run
//
// --dry-run varsayılandır; bu komutun YAZAN bir modu YOKTUR.
// Çıktı aggregate'tir: müşteri adı, adres, telefon, ham order/package ID veya
// payload BASILMAZ. Kayıt düzeyinde tek bilgi SHA-256'nın ilk 12 karakteri +
// marketplace status + operation status + exclusion bucket'tır.
import { closePool, getDb, isDatabaseConfigured } from '../db/client.ts'
import {
  checkInvariant,
  countByDateBasis,
  decideReconciliation,
  emptyExclusionTally,
  summarizePackages,
  tallyExclusion,
  type ExclusionStage,
} from './orderCountReconcile.ts'
import {
  describeUiLoad,
  loadLocalScope,
} from './orderCountReconcileLoader.ts'

const TAG = '[orders:count-reconcile]'

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

// Yerel kaydı, CargoFlow sekme sözleşmesine göre hangi aşamada UI'den
// düştüğüne eşler. Sekme tanımları src/utils/orderClassification.ts'tedir:
//   newOrders  = isOpenOperation && !isLabelReady && !isLabelPrinted
//   labelStage = isLabelReady || isLabelPrinted
// processClosed (⇒ isOpenOperation=false) = cancelled/returned | delivered |
//   archived | handedToCargo | explicitlyClosed
function classifyExclusion(row: {
  marketplaceStatus?: string
  operationStatus?: string
  archived?: boolean
  lineCount?: number
}): ExclusionStage | null {
  const ms = String(row.marketplaceStatus ?? '')
  const os = String(row.operationStatus ?? '').toLowerCase()
  if (row.archived) return 'archived'
  if (['Cancelled', 'Returned', 'UnDelivered', 'UnSupplied'].includes(ms)) {
    return 'cancelled_or_returned_excluded'
  }
  if (['Shipped', 'AtCollectionPoint'].includes(ms)) {
    return 'shipped_or_delivered_excluded'
  }
  if (ms === 'Delivered') return 'shipped_or_delivered_excluded'
  if (os === 'labelready' || os === 'labelprinted') return 'label_ready_separated'
  if (Number(row.lineCount ?? 0) === 0) return 'missing_lines'
  return null
}

async function main(): Promise<number> {
  if (hasFlag('apply')) {
    console.error(`${TAG} Bu komut SALT OKUNUR'dur; --apply desteklenmez.`)
    return 1
  }
  if (!isDatabaseConfigured()) {
    console.error(`${TAG} DATABASE_URL tanımlı değil.`)
    return 1
  }
  const organizationId = parseArg('organization-id')
  const startIso = parseArg('start')
  const endIso = parseArg('end')
  if (!organizationId || !startIso || !endIso) {
    console.error(`${TAG} --organization-id, --start, --end zorunlu.`)
    return 1
  }
  const scope = {
    organizationId,
    marketplace: parseArg('marketplace') ?? 'Trendyol',
    providerAccountId: parseArg('provider-account-id'),
    startIso,
    endIso,
  }

  const db = getDb()
  const local = await loadLocalScope(db, scope)
  if (!local.accountResolved) {
    console.error(`${TAG} Hesap bulunamadı (org/marketplace kapsamında).`)
    return 1
  }
  const ui = await describeUiLoad(db, scope, local.marketplaceAccountId)

  const localModel = summarizePackages(local.rows)
  const dateBasis = countByDateBasis(local.rows, scope.startIso, scope.endIso)

  // Exclusion tally: yerel kayıtların sekme sözleşmesine göre dağılımı.
  const tally = emptyExclusionTally()
  let visible = 0
  for (const row of local.rows) {
    const stage = classifyExclusion(row)
    if (stage) tallyExclusion(tally, row, stage)
    else visible += 1
  }
  // Sayfa sınırı nedeniyle UI'ye HİÇ inmeyen kayıtlar ayrı bucket.
  const truncatedCount = Math.max(0, visible - ui.effectivePageSize)
  if (truncatedCount > 0) {
    tally.buckets.pagination_or_fetch_incomplete += truncatedCount
  }
  const cargoFlowVisiblePackages = visible - truncatedCount

  const invariant = checkInvariant(
    localModel.distinctPackageCount,
    cargoFlowVisiblePackages,
    tally,
  )
  const decision = decideReconciliation({
    localScopePackageCount: localModel.distinctPackageCount,
    uiLoadedPackageCount: ui.loadedCount,
    backendReportedTotal: ui.backendReportedTotal,
    uiPageSize: ui.effectivePageSize,
    uiRequestsAllPages: ui.requestsAllPages,
    accountScopeMismatchCount: local.accountScopeMismatchCount,
    duplicatePackageCount: local.duplicatePackageIds,
    missingLocalOrderCount: 0, // provider karşılaştırması bu komutta YOK
  })

  const report = {
    scope: {
      marketplace: scope.marketplace,
      startIso: scope.startIso,
      endIso: scope.endIso,
      accountScoped: Boolean(scope.providerAccountId),
    },
    providerModel: {
      available: false,
      note:
        'Bu komut provider API çağırmaz (salt okunur sözleşme). Trendyol ' +
        'karşılaştırması ayrı ve açıkça yetkilendirilmiş bir adımdır.',
    },
    localDatabaseModel: {
      ...localModel,
      operationStatusBuckets: local.operationStatusBuckets,
      archivedCount: local.archivedCount,
      ordersWithoutLines: local.ordersWithoutLines,
      duplicatePackageIds: local.duplicatePackageIds,
      nullMarketplaceAccountCount: local.nullAccountCount,
      accountScopeMismatchCount: local.accountScopeMismatchCount,
    },
    dateBasis: {
      orderDateCohort: dateBasis.orderDateCohort,
      modifiedAtActivity: dateBasis.modifiedAtActivity,
      note: 'İki eksen AYRI raporlanır; tek rakamda karıştırılmaz.',
    },
    cargoFlowUiModel: {
      effectivePageSize: ui.effectivePageSize,
      backendReportedTotal: ui.backendReportedTotal,
      loadedCount: ui.loadedCount,
      requestsAllPages: ui.requestsAllPages,
      truncated: ui.truncated,
      note:
        'loadOrdersFromServer() hiçbir pageSize göndermez; backend ' +
        'varsayılanı uygulanır ve sekme/özet sayıları bu kesilmiş küme ' +
        'üzerinden hesaplanır.',
    },
    exclusionStages: tally.buckets,
    reconciliation: invariant,
    safeFingerprintSamples: tally.samples,
    conclusion: decision,
  }

  console.info(`${TAG} SALT OKUNUR tarama tamamlandı (DB değişmedi).`)
  console.info(JSON.stringify(report, null, 2))
  console.info(`${TAG} KARAR [${decision.conclusion}]: ${decision.message}`)
  return 0
}

try {
  const code = await main()
  await closePool().catch(() => undefined)
  process.exit(code)
} catch (error) {
  console.error(
    `${TAG} Hata:`,
    error instanceof Error ? error.message : String(error),
  )
  await closePool().catch(() => undefined)
  process.exit(1)
}
