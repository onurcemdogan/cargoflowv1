// SAF (pure) Dashboard satış mutabakat raporu üreticisi. GERÇEK frontend
// buildDashboardSalesPeriodCards çıktısı (ay + geçen ay kartları) + GERÇEK
// buildDashboardViewModel refundDataSource'u ile, YEREL DB mutabakatını (iki
// tarih ekseni: orderDate kohortu vs marketplaceLastModifiedAt aktivitesi)
// birleştirir. HİÇBİR provider çağrısı YAPMAZ, DB YAZMAZ, PII/ham ID
// DÖNDÜRMEZ (yalnız güvenli aggregate). CLI bu saf fonksiyonu db + vite ile
// besler; testler aynı fonksiyonu pglite reconcile callback'i ile doğrular.
import { toCanonicalSummary } from './orderMetricDefinitions.ts'
import type {
  OrderReconciliationReport,
  ReconcileDateBasis,
} from './orderReconciliation.ts'

// Frontend DashboardSalesPeriodCard'ın diagnostic için gerekli ALT KÜMESİ.
export interface SalesPeriodCardLike {
  range: { start: Date; end: Date }
  salesAmount: number
  packageCount: number
  lineCount: number
  productCount: number
  returnCancellationAmount: number
  returnPackageCount: number
  cancelPackageCount: number
}

export type RefundDataSource = 'order_status' | 'persisted_claims' | 'unavailable'

export interface ReconcilePeriodReport {
  // Kartın (UI'nın ürettiği) GERÇEK değerleri.
  start: string
  end: string
  salesAmount: number
  packageCount: number
  lineCount: number
  productCount: number
  returnCancellationAmount: number
  cancelCount: number
  returnCount: number
  refundDataSource: RefundDataSource
  // İki tarih EKSENİ modeli (aynı dönem sınırları, farklı çapa sütunu). Aynı
  // isimle sunulmayan iki ayrı metrik: kohort vs aktivite.
  dateBasisModels: {
    orderDateCohort: DateBasisModel
    modifiedActivity: DateBasisModel
  }
}

export interface DateBasisModel {
  dateBasis: ReconcileDateBasis
  start: string
  end: string
  packageCount: number
  lineCount: number
  unitQuantity: number
  grossSales: number
  cancelAmount: number
  returnAmount: number
  netSales: number
  byMarketplaceStatus: { key: string; count: number; amount: number }[]
  distinctOrderDateDays: number
}

export interface DashboardReconciliationReport {
  providerAccountId: string
  marketplaceAccountId: string
  asOf: string
  // Kartlar/kohort orderDate eksenindedir; iki metrik aynı isimle sunulmaz.
  salesDateBasis: ReconcileDateBasis
  salesDateBasisLabel: string
  currentPeriod: ReconcilePeriodReport
  comparisonPeriod: ReconcilePeriodReport
  notes: string[]
}

function modelFromReconcile(report: OrderReconciliationReport): DateBasisModel {
  const summary = toCanonicalSummary({
    distinctPackageIds: report.distinctPackageIds,
    orderLineCount: report.orderLineCount,
    lineQuantityTotal: report.lineQuantityTotal,
    totalAmount: report.totalAmount,
    byMarketplaceStatus: report.byMarketplaceStatus,
  })
  return {
    dateBasis: report.dateBasis,
    start: report.startDate,
    end: report.endDate,
    packageCount: summary.packageCount,
    lineCount: summary.lineCount,
    unitQuantity: summary.unitQuantity,
    grossSales: summary.grossSales,
    cancelAmount: summary.cancelAmount,
    returnAmount: summary.returnAmount,
    netSales: summary.netSales,
    byMarketplaceStatus: report.byMarketplaceStatus,
    distinctOrderDateDays: report.byDay.length,
  }
}

async function buildPeriod(
  card: SalesPeriodCardLike,
  refundDataSource: RefundDataSource,
  reconcile: (args: {
    startMs: number
    endMs: number
    dateBasis: ReconcileDateBasis
  }) => Promise<OrderReconciliationReport>,
): Promise<ReconcilePeriodReport> {
  const startMs = card.range.start.getTime()
  const endMs = card.range.end.getTime()
  const orderDateCohort = modelFromReconcile(
    await reconcile({ startMs, endMs, dateBasis: 'order_date' }),
  )
  const modifiedActivity = modelFromReconcile(
    await reconcile({
      startMs,
      endMs,
      dateBasis: 'marketplace_last_modified_at',
    }),
  )
  return {
    start: card.range.start.toISOString(),
    end: card.range.end.toISOString(),
    salesAmount: card.salesAmount,
    packageCount: card.packageCount,
    lineCount: card.lineCount,
    productCount: card.productCount,
    returnCancellationAmount: card.returnCancellationAmount,
    cancelCount: card.cancelPackageCount,
    returnCount: card.returnPackageCount,
    refundDataSource,
    dateBasisModels: { orderDateCohort, modifiedActivity },
  }
}

// GERÇEK kartlar (ay = currentPeriod, geçen ay = comparisonPeriod) + refund
// kaynağı + iki eksen modeli → tek diagnostic rapor. reconcile callback'i
// db'ye bağlıdır (CLI) veya pglite'a (test); saf fonksiyon db bilmez.
export async function buildDashboardReconciliationReport(input: {
  providerAccountId: string
  marketplaceAccountId: string
  asOf: string
  salesDateBasisLabel: string
  monthCard: SalesPeriodCardLike
  lastMonthCard: SalesPeriodCardLike
  refundDataSource: RefundDataSource
  reconcile: (args: {
    startMs: number
    endMs: number
    dateBasis: ReconcileDateBasis
  }) => Promise<OrderReconciliationReport>,
}): Promise<DashboardReconciliationReport> {
  const currentPeriod = await buildPeriod(
    input.monthCard,
    input.refundDataSource,
    input.reconcile,
  )
  const comparisonPeriod = await buildPeriod(
    input.lastMonthCard,
    input.refundDataSource,
    input.reconcile,
  )
  const notes = [
    'currentPeriod/comparisonPeriod GERÇEK buildDashboardSalesPeriodCards ' +
      'çıktısıdır (ay + geçen ay kartı); orderDate kohortu.',
    'KANITLANAN temel semantik fark TARİH EKSENİdir: CargoFlow local Dashboard ' +
      'date basis = orderDate; historical Trendyol fetch/backfill date basis = ' +
      'marketplaceLastModifiedAt. Bu iki metriğin aynı isimle karşılaştırılması ' +
      'semantik olarak yanlıştır.',
    'dateBasisModels.orderDateCohort = Dashboard ekseni; modifiedActivity = ' +
      'provider historical-fetch/backfill ekseni. Aynı dönem için farklı küme ' +
      'döndürürler; karıştırılmamalıdır.',
    'DİKKAT: Referans (harici) Dashboard rakamlarının (ör. 754/854) TEK nedeni ' +
      'tarih ekseni OLDUĞU İDDİA EDİLEMEZ. Harici uygulamanın kaynak kodu, cache ' +
      'generatedAt değeri, claim tanımı ve capture anındaki provider snapshot\'ı ' +
      'burada YOK. Kalan fark capture-time, status, claim ve harici tanımdan ' +
      'kaynaklanabilir.',
    'refundDataSource=order_status ise iade YALNIZ Returned/UnDelivered ' +
      'statüsünden türetilir (kısmi claim tutarı yereldeki DEĞİL).',
    'Rakamlar as-of anındaki YEREL DB durumudur; eski ekran görüntüsü ' +
      'rakamıyla doğrudan eşitlenmemelidir (provider verisi sonradan değişmiş olabilir).',
  ]
  return {
    providerAccountId: input.providerAccountId,
    marketplaceAccountId: input.marketplaceAccountId,
    asOf: input.asOf,
    salesDateBasis: 'order_date',
    salesDateBasisLabel: input.salesDateBasisLabel,
    currentPeriod,
    comparisonPeriod,
    notes,
  }
}
