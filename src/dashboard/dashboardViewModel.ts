import type { CargoOrder, CargoProduct, OrderItem } from '../types/cargoflow.ts'
import {
  classifyOrderForTabs,
  dashboardOperationStageLabel,
  isPickingEligible,
  orderMatchesDashboardAction,
  resolveDashboardOperationStage,
  resolvePickingStage,
  type DashboardOperationStage,
} from '../utils/orderClassification.ts'
import {
  buildProductFamilyIndex,
  type ProductFamilyGroup,
} from '../utils/orderProductFamily.ts'
import { resolveOrderActionCapabilities } from '../utils/orderActionCapabilities.ts'
import { displayOrderNumber } from '../utils/orderDisplay.ts'
import { resolveProductImageCandidates } from '../utils/productImage.ts'
import type { OrdersActionFilter } from '../utils/ordersNavigation.ts'
import {
  DASHBOARD_SALES_REPORTING_TIME_ZONE,
  resolveReportingComparisonRange,
  resolveReportingRange,
  type ReportingPeriodKey,
} from './reportingRange.ts'
import {
  summarizeAcceptedClaimsForPeriod,
  type AnalyticsClaim,
  type ClaimPeriodAdjustment,
} from './analyticsClaims.ts'
import {
  describeSalesMetric,
  orderDedupeKey,
  orderDispositionOf,
  resolveCanonicalOrderAmount,
  SALES_DATE_BASIS,
  SALES_DATE_BASIS_LABEL,
  type SalesDateBasis,
  type SalesDisposition,
  type SalesMetricDefinition,
} from './dashboardSalesMetricDefinition.ts'

// Yalnız SATIŞ analitiği rapor günü UTC'dir (Durusoft mutabakatı);
// operasyon sayaçları ve tarih GÖSTERİMLERİ yerel (Europe/Istanbul)
// semantiğini korur.
function toReportingPeriodKey(key: DashboardPeriodKey): ReportingPeriodKey {
  if (key === 'last7') return 'last7Days'
  if (key === 'last30') return 'last30Days'
  if (key === 'month') return 'thisMonth'
  if (key === 'custom') return 'custom'
  return key
}

function withReportingBounds(
  base: DashboardDateRange,
  bounds: { start: Date; end: Date },
): DashboardDateRange {
  return { ...base, start: bounds.start, end: bounds.end }
}

export type DashboardPeriodKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'month'
  | 'custom'

export type DashboardSalesPeriodKey =
  | 'today'
  | 'yesterday'
  | 'month'
  | 'lastMonth'

export interface DashboardPeriodSelection {
  key: DashboardPeriodKey
  startDate?: string
  endDate?: string
}

export interface DashboardDateRange {
  key: DashboardPeriodKey | DashboardSalesPeriodKey | 'comparison'
  label: string
  helper: string
  start: Date
  end: Date
}

export interface DashboardComparison {
  current: number
  previous: number
  absoluteChange: number
  percentageChange: number
  direction: 'up' | 'down' | 'flat'
  comparable: boolean
}

export interface DashboardMetric {
  value: number
  comparison: DashboardComparison
  available: boolean
}

export interface DashboardTimeBucket {
  key: string
  label: string
  amount: number
  orderCount: number
}

export interface DashboardDistributionRow {
  key: string
  label: string
  orderCount: number
  amount: number
  share: number
}

export interface DashboardTopProduct {
  key: string
  productName: string
  sku: string
  barcode: string
  color: string
  size: string
  quantity: number
  revenue: number
  imageCandidates: string[]
}

export interface DashboardSalesPeriodCard {
  key: DashboardSalesPeriodKey
  label: string
  dateLabel: string
  range: DashboardDateRange
  salesAmount: number
  salesAmountAvailable: boolean
  returnCancellationAmount: number
  returnCancellationAmountAvailable: boolean
  packageCount: number
  lineCount: number
  productCount: number
  packageAverage: number
  returnPackageCount: number
  cancelPackageCount: number
  comparison: DashboardComparison
}

export interface DashboardActionRequired {
  key: string
  label: string
  description: string
  count: number
  filterTarget:
    | 'shipmentPending'
    | 'labelReady'
    | 'suratVerificationPending'
    | 'all'
  actionFilter?: Exclude<OrdersActionFilter, 'all'>
  severity: 'warning' | 'danger' | 'info'
}

export interface DashboardOperationStep {
  key: string
  label: string
  count: number
  filterTarget:
    | 'open'
    | 'barcodePending'
    | 'labelReady'
    | 'labelPrinted'
    | 'handedToCargo'
    | 'delivered'
}

// ÜRÜN AİLESİ SATIRI (beden bağımsız üst grup + beden alt kırılımı).
// Etiket footer aggregation'ı ETKİLENMEZ; orada kimlik strict kalır
// (ürün + SKU + renk + BEDEN).
export interface DashboardPickingVariant {
  sizeKey: string
  size: string
  quantity: number
  orderCount: number
  orderIds: string[]
}

export interface DashboardPickingOrderRef {
  orderId: string
  displayOrderNumber: string
  customerName: string
  size: string
  quantity: number
  orderDate?: string
  operationStatusLabel: string
  labelReady: boolean
  carrier: string
}

export interface DashboardPickingProduct {
  key: string
  productName: string
  color: string
  sku: string
  barcode: string
  /** Beden bağımsız TOPLAM adet. */
  quantity: number
  /** DISTINCT logical order sayısı (quantity DEĞİL). */
  orderCount: number
  imageCandidates: string[]
  variants: DashboardPickingVariant[]
  /** Kanonik aşama dağılımı (Etiket Hazır / Barkod Bekliyor / …). */
  stageBreakdown: Array<{ stage: DashboardOperationStage; label: string; count: number }>
  orders: DashboardPickingOrderRef[]
  identitySource: string
}

export interface DashboardRecentOperation {
  id: string
  packageId?: string
  shipmentPackageId?: string
  // Canonical kaynak sipariş no (114...). API/eşleştirme için korunur.
  orderNumber: string
  // Kullanıcıya gösterilen "Sipariş No" (varsa 727... Trendyol referansı).
  displayOrderNumber: string
  marketplace: string
  customerName: string
  productName: string
  productVariant: string
  additionalItemCount: number
  imageCandidates: string[]
  status: string
  carrier: string
  orderDate: string
  // Güvenli capability alanları (canonical operationStatus + persisted metadata'dan
  // türetilir; geçici tarayıcı ZPL/shipment state'ine bağlı DEĞİLDİR). Raw ZPL yok.
  operationStatus: string
  labelStatus: string
  hasPrintableLabel: boolean
  canViewDetails: boolean
  canPrint: boolean
  canDownloadZpl: boolean
  printDisabledReason: string
  zplDisabledReason: string
}

export interface DashboardViewModel {
  period: DashboardDateRange
  comparisonPeriod: DashboardDateRange
  // Satış metriklerinin TARİH EKSENİ kullanıcıya açıkça gösterilir: Dashboard
  // satışı bir sipariş KOHORTUDUR (orderDate), provider "son güncellenme"
  // aktivite penceresi DEĞİL. İki farklı metrik aynı isimle sunulmaz.
  salesDateBasis: SalesDateBasis
  salesDateBasisLabel: string
  salesMetricDefinition: SalesMetricDefinition
  salesPeriodCards: DashboardSalesPeriodCard[]
  salesSummary: {
    salesAmount: DashboardMetric
    orderCount: DashboardMetric
    lineCount: DashboardMetric
    productCount: DashboardMetric
    returnAmount: DashboardMetric
    returnCount: DashboardMetric
    // İade metriğinin KESİN veri kaynağı. "persisted_claims": gerçek claim
    // muhasebesi (legacy Trendyol getClaims / ileride kalıcı claims).
    // "order_status": claim verisi yok; iade YALNIZ Returned sipariş
    // statüsünden türetildi (tam claim muhasebesi DEĞİL). "unavailable": iade
    // hesaplanacak yerel veri yok → "kesin 0 iade" izlenimi verilmez.
    refundDataSource: 'order_status' | 'persisted_claims' | 'unavailable'
  }
  operationalSummary: {
    openOperations: number
    barcodeWaiting: number
    labelReady: number
    labelPrinted: number
    handedToCargo: number
    delivered: number
    errors: number
    snapshotLabel: string
  }
  salesChart: {
    title: string
    granularity: 'hourly' | 'daily' | 'weekly' | 'monthly'
    current: DashboardTimeBucket[]
    comparison: DashboardTimeBucket[]
  }
  cityDistribution: DashboardDistributionRow[]
  marketplaceDistribution: DashboardDistributionRow[]
  topProducts: DashboardTopProduct[]
  actionRequired: DashboardActionRequired[]
  operationFlow: DashboardOperationStep[]
  pickingLists: {
    mode: 'readonly-products'
    title: string
    products: DashboardPickingProduct[]
    /** Uygun TÜM aile sayısı (gösterilen kısım kırpılmış olabilir). */
    totalFamilyCount: number
    /** Gösterilmeyen aile sayısı — SESSİZ kırpma YOK. */
    hiddenFamilyCount: number
    /** Toplanacak DISTINCT sipariş sayısı. */
    orderCount: number
    /** Toplanacak toplam adet. */
    totalQuantity: number
  }
  recentOperations: DashboardRecentOperation[]
  latestSyncAt?: string
}

/**
 * SUNUCUDA HESAPLANMIŞ OPERASYON ANLIK GÖRÜNTÜSÜ.
 *
 * ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
 * Operasyon sayaçları TÜM tenant siparişlerini ister (dönem daraltması yok).
 * Bu yüzden Dashboard bugüne kadar tarayıcıya tam sipariş tablosunu
 * indirtiyordu — 10k'da onlarca MB, 20k üstünde AÇIK hata.
 *
 * ═══ NEDEN CEVAPLAR DEĞİŞMEZ ═════════════════════════════════════════════
 * Bu alanlar SQL'de yeniden yazılmadı. Sunucu, AYNI `buildDashboardViewModel`
 * fonksiyonunu tam sipariş kümesiyle çalıştırır ve YALNIZ bu beş alanı
 * gönderir. Yani değer, tarayıcının hesaplayacağının BİREBİR aynısıdır;
 * parite testle de doğrulanır.
 *
 * `operationFlow` BURADA YOKTUR: o zaten `operationalSummary`den türetilir,
 * dolayısıyla otomatik olarak tutarlı kalır.
 */
export interface DashboardOperationalSnapshot {
  operationalSummary: DashboardViewModel['operationalSummary']
  actionRequired: DashboardActionRequired[]
  pickingLists: DashboardViewModel['pickingLists']
  recentOperations: DashboardRecentOperation[]
  latestSyncAt?: string
}

/** Tam view-model'den operasyon alanlarını ayıklar (sunucu tarafı üretim). */
export function extractDashboardOperationalSnapshot(
  viewModel: DashboardViewModel,
): DashboardOperationalSnapshot {
  return {
    operationalSummary: viewModel.operationalSummary,
    actionRequired: viewModel.actionRequired,
    pickingLists: viewModel.pickingLists,
    recentOperations: viewModel.recentOperations,
    latestSyncAt: viewModel.latestSyncAt,
  }
}

interface BuildDashboardViewModelInput {
  orders: CargoOrder[]
  /**
   * Verilirse operasyon alanları BU KAYNAKTAN alınır ve `orders` yalnız
   * satış/geri-dönük yollar için kullanılır. Böylece tam sipariş tablosu
   * tarayıcıya İNMEK ZORUNDA KALMAZ.
   */
  operationalSnapshot?: DashboardOperationalSnapshot
  // SATIŞ analitiği için cap'siz dönemsel veri (analytics endpoint'i);
  // verilmezse satış alanları da operational orders'tan hesaplanır
  // (geriye dönük davranış). Operasyon sayaçları HER ZAMAN orders'tan.
  analyticsOrders?: CargoOrder[]
  // Kabul edilmiş iadeler (claims endpoint'i); verilirse net satış
  // metriklerinden claim effectiveDate dönemine göre düşülür.
  analyticsClaims?: AnalyticsClaim[]
  // Gerçek bir claim veri kaynağı sorgulandı mı? Auth modunda /api/analytics/
  // claims provider ÇAĞIRMAZ ve source="unavailable" döner → claimsAvailable
  // false geçilir; iade YALNIZ Returned sipariş statüsünden türetilir. Verilmezse
  // (undefined) analyticsClaims varlığından türetilir (geriye dönük uyumluluk).
  claimsAvailable?: boolean
  products?: CargoProduct[]
  selectedPeriod: DashboardPeriodSelection
  comparisonPeriod?: DashboardDateRange
  latestSyncAt?: string
  now?: Date
}

interface PeriodTotals {
  salesAmount: number
  salesAmountAvailable: boolean
  orderCount: number
  lineCount: number
  productCount: number
  returnAmount: number
  returnAmountAvailable: boolean
  returnCount: number
  cancelAmount: number
  cancelAmountAvailable: boolean
  cancelCount: number
  returnCancellationAmount: number
  returnCancellationAmountAvailable: boolean
  packageAverage: number
}

export function buildDashboardViewModel({
  orders,
  operationalSnapshot,
  analyticsOrders,
  analyticsClaims,
  claimsAvailable,
  products = [],
  selectedPeriod,
  comparisonPeriod,
  latestSyncAt,
  now = new Date(),
}: BuildDashboardViewModelInput): DashboardViewModel {
  const uniqueOrders = dedupeDashboardOrders(orders)
  // Satış alanlarının kaynağı: analytics verisi varsa o (120'lik operasyon
  // cache'inden bağımsız), yoksa operational liste.
  const salesSource = analyticsOrders
    ? dedupeDashboardOrders(analyticsOrders)
    : uniqueOrders
  // İade metriğinin KESİN kaynağı. Gerçek claim kaynağı sorgulandıysa (legacy
  // getClaims veya ileride kalıcı claims) → persisted_claims. Aksi halde (auth:
  // claims unavailable) iade YALNIZ Returned sipariş statüsünden türetilir; satış
  // verisi varsa order_status, hiç yerel veri yoksa unavailable ("kesin 0 iade"
  // izlenimi verilmez).
  const claimsQueried =
    claimsAvailable !== undefined ? claimsAvailable : analyticsClaims !== undefined
  const refundDataSource: 'order_status' | 'persisted_claims' | 'unavailable' =
    claimsQueried
      ? 'persisted_claims'
      : salesSource.length > 0
        ? 'order_status'
        : 'unavailable'
  // Yerel (Europe/Istanbul) dönem: operasyon sayaçları ve etiket/kargo
  // dönem filtreleri MEVCUT semantiğini korur.
  const localPeriod = resolveDashboardPeriod(selectedPeriod, now)
  // SATIŞ analitiği dönemi: UTC rapor günü (etiketler yerel dönemden).
  const reportingKey = toReportingPeriodKey(selectedPeriod.key)
  const period = withReportingBounds(
    localPeriod,
    resolveReportingRange(
      reportingKey,
      now,
      DASHBOARD_SALES_REPORTING_TIME_ZONE,
      {
        startDate: selectedPeriod.startDate,
        endDate: selectedPeriod.endDate,
      },
    ),
  )
  const resolvedComparison =
    comparisonPeriod ??
    withReportingBounds(
      resolveComparisonPeriod(localPeriod, selectedPeriod.key),
      resolveReportingComparisonRange(
        reportingKey,
        period,
        now,
        DASHBOARD_SALES_REPORTING_TIME_ZONE,
      ),
    )
  const periodOrders = salesSource.filter((order) =>
    orderIsInRange(order, period),
  )
  const comparisonOrders = salesSource.filter((order) =>
    orderIsInRange(order, resolvedComparison),
  )
  // İade mutabakatı: kabul edilen claim'ler effectiveDate dönemine göre net
  // satış toplamlarından düşülür (salesSource üzerinden tam/kısmi ayrımı).
  const packageQuantityLookup = buildPackageQuantityLookup(salesSource)
  const lineQuantityLookup = buildLineQuantityLookup(salesSource)
  const resolveClaimOrder = buildClaimOrderResolver(salesSource)
  const currentTotals = applyClaimAdjustment(
    calculatePeriodTotals(periodOrders),
    buildClaimAdjustment(
      analyticsClaims,
      period,
      periodOrders,
      resolveClaimOrder,
      packageQuantityLookup,
      lineQuantityLookup,
    ),
  )
  const previousTotals = applyClaimAdjustment(
    calculatePeriodTotals(comparisonOrders),
    buildClaimAdjustment(
      analyticsClaims,
      resolvedComparison,
      comparisonOrders,
      resolveClaimOrder,
      packageQuantityLookup,
      lineQuantityLookup,
    ),
  )
  const classified = uniqueOrders.map((order) => ({
    order,
    state: classifyOrderForTabs(order),
  }))
  // Operation Flow "Anlık operasyon durumu" SNAPSHOT'ıdır: TÜM tenant siparişleri
  // üzerinde (recentOperations ile AYNI veri kümesi), döneme/güne göre daraltılmaz.
  // Her sipariş TEK canonical aşamaya (resolveDashboardOperationStage) düşer;
  // sayaçlar bu tek helper'dan türetilir → recentOperations statüsü ile daima
  // tutarlı. Sayım canonical operationStatus'e dayanır; printedAt gibi geçici
  // tarayıcı metadata'sına BAĞLI DEĞİLDİR → DB reload sonrası korunur.
  const stageCounts: Record<DashboardOperationStage, number> = {
    open: 0,
    barcodeWaiting: 0,
    labelReady: 0,
    labelPrinted: 0,
    handedToCargo: 0,
    delivered: 0,
    canceledOrReturned: 0,
    archived: 0,
    error: 0,
    unknown: 0,
  }
  for (const { state } of classified) {
    stageCounts[resolveDashboardOperationStage(state)] += 1
  }
  // "Açık Operasyon" = etiket öncesi AKTİF operasyonların toplamıdır (huni tepesi):
  // barkod bekleyen + doğrulama bekleyen/diğer açık + kontrol gerekli (aktif hata).
  // LABEL_READY, LABEL_PRINTED, kargoya verilen, teslim, iptal/iade, arşiv bu
  // toplama GİRMEZ (canonical kural: LABEL_PRINTED asla Açık Operasyon, LABEL_READY
  // asla Açık Operasyon/Barkod Bekliyor sayılmaz). "Barkod Bekliyor" bu toplamın
  // alt kümesidir (huni içi), ayrıca gösterilir.
  const openOperations =
    stageCounts.open + stageCounts.barcodeWaiting + stageCounts.error
  // NOT: Toplama listesi (picking) ARTIK `isOpenOperation` kullanmaz. O
  // predicate yalnız "süreç kapandı mı" sorusunu yanıtlıyordu ve LABEL_PRINTED
  // siparişleri DIŞARIDA BIRAKMIYORDU (processClosed'da yok) → basılmış
  // siparişler toplama listesinde kalıyordu. Yeni kapsam kanonik
  // `isPickingEligible` ile tanımlıdır (bkz. buildPickingLists).
  // Sunucu anlık görüntüsü VARSA sayaçlar ONDAN gelir. `operationFlow` de
  // bu nesneden türediği için huni ile kartlar ASLA ayrışamaz.
  const operationalSummary = operationalSnapshot?.operationalSummary ?? {
    openOperations,
    barcodeWaiting: stageCounts.barcodeWaiting,
    labelReady: stageCounts.labelReady,
    labelPrinted: stageCounts.labelPrinted,
    handedToCargo: stageCounts.handedToCargo,
    delivered: stageCounts.delivered,
    errors: stageCounts.error,
    snapshotLabel: 'Anlık operasyon durumu',
  }
  const granularity = resolveChartGranularity(period)

  return {
    period,
    comparisonPeriod: resolvedComparison,
    salesDateBasis: SALES_DATE_BASIS,
    salesDateBasisLabel: SALES_DATE_BASIS_LABEL,
    salesMetricDefinition: describeSalesMetric(),
    salesPeriodCards: buildDashboardSalesPeriodCards(
      salesSource,
      now,
      analyticsClaims,
    ),
    salesSummary: {
      salesAmount: metric(
        currentTotals.salesAmount,
        previousTotals.salesAmount,
        currentTotals.salesAmountAvailable,
      ),
      orderCount: metric(currentTotals.orderCount, previousTotals.orderCount),
      lineCount: metric(currentTotals.lineCount, previousTotals.lineCount),
      productCount: metric(
        currentTotals.productCount,
        previousTotals.productCount,
      ),
      returnAmount: metric(
        currentTotals.returnAmount,
        previousTotals.returnAmount,
        // "unavailable" → tutar KESİN gösterilmez ("—"); ₺0,00 ile yanlış
        // kesinlik verilmez.
        currentTotals.returnAmountAvailable && refundDataSource !== 'unavailable',
      ),
      returnCount: metric(
        currentTotals.returnCount,
        previousTotals.returnCount,
      ),
      refundDataSource,
    },
    operationalSummary,
    salesChart: {
      title:
        granularity === 'hourly'
          ? 'Saatlik Satış Grafiği'
          : granularity === 'daily'
            ? 'Günlük Satış Grafiği'
            : granularity === 'weekly'
              ? 'Haftalık Satış Grafiği'
              : 'Aylık Satış Grafiği',
      granularity,
      current: buildTimeBuckets(periodOrders, period, granularity),
      comparison: buildTimeBuckets(
        comparisonOrders,
        resolvedComparison,
        granularity,
      ),
    },
    cityDistribution: buildDistribution(
      periodOrders,
      (order) => normalizeCity(order.city),
    ),
    marketplaceDistribution: buildDistribution(
      periodOrders,
      (order) => String(order.marketplace || 'Bilinmeyen').trim() || 'Bilinmeyen',
    ),
    topProducts: buildTopProducts(periodOrders, products).slice(0, 10),
    actionRequired:
      operationalSnapshot?.actionRequired ?? buildActionRequired(classified),
    operationFlow: [
      {
        key: 'open',
        label: 'Açık Operasyon',
        count: operationalSummary.openOperations,
        filterTarget: 'open',
      },
      {
        key: 'barcode',
        label: 'Barkod Bekliyor',
        count: operationalSummary.barcodeWaiting,
        filterTarget: 'barcodePending',
      },
      {
        key: 'ready',
        label: 'Etiket Hazır',
        count: operationalSummary.labelReady,
        filterTarget: 'labelReady',
      },
      {
        key: 'printed',
        label: 'Etiket Basıldı',
        count: operationalSummary.labelPrinted,
        filterTarget: 'labelPrinted',
      },
      {
        key: 'cargo',
        label: 'Kargoya Verildi',
        count: operationalSummary.handedToCargo,
        filterTarget: 'handedToCargo',
      },
      {
        key: 'delivered',
        label: 'Teslim Edildi',
        count: operationalSummary.delivered,
        filterTarget: 'delivered',
      },
    ],
    pickingLists:
      operationalSnapshot?.pickingLists ?? buildPickingLists(uniqueOrders, products),
    recentOperations:
      operationalSnapshot?.recentOperations ??
      buildRecentOperations(uniqueOrders, products).slice(0, 10),
    latestSyncAt:
      latestSyncAt ??
      operationalSnapshot?.latestSyncAt ??
      resolveLatestSyncAt(uniqueOrders),
  }
}

export function calculateComparison(
  current: number,
  previous: number,
): DashboardComparison {
  const safeCurrent = finiteNumber(current)
  const safePrevious = finiteNumber(previous)
  const absoluteChange = safeCurrent - safePrevious
  const direction =
    absoluteChange > 0 ? 'up' : absoluteChange < 0 ? 'down' : 'flat'
  if (safePrevious === 0) {
    return {
      current: safeCurrent,
      previous: safePrevious,
      absoluteChange,
      percentageChange: 0,
      direction,
      comparable: safeCurrent === 0,
    }
  }
  return {
    current: safeCurrent,
    previous: safePrevious,
    absoluteChange,
    percentageChange: (absoluteChange / Math.abs(safePrevious)) * 100,
    direction,
    comparable: true,
  }
}

export function resolveDashboardPeriod(
  selection: DashboardPeriodSelection,
  now = new Date(),
): DashboardDateRange {
  const todayStart = startOfDay(now)
  const todayEnd = endOfDay(now)
  if (selection.key === 'today') {
    return range('today', 'Bugün', 'Dün ile karşılaştırılıyor', todayStart, todayEnd)
  }
  if (selection.key === 'yesterday') {
    return range(
      'yesterday',
      'Dün',
      'Önceki gün ile karşılaştırılıyor',
      addDays(todayStart, -1),
      addDays(todayEnd, -1),
    )
  }
  if (selection.key === 'last7') {
    return range(
      'last7',
      'Son 7 Gün',
      'Önceki 7 gün ile karşılaştırılıyor',
      addDays(todayStart, -6),
      todayEnd,
    )
  }
  if (selection.key === 'last30') {
    return range(
      'last30',
      'Son 30 Gün',
      'Önceki 30 gün ile karşılaştırılıyor',
      addDays(todayStart, -29),
      todayEnd,
    )
  }
  if (selection.key === 'month') {
    return range(
      'month',
      'Bu Ay',
      'Önceki ayın aynı gün sayısı ile karşılaştırılıyor',
      new Date(now.getFullYear(), now.getMonth(), 1),
      todayEnd,
    )
  }
  const customStart = parseLocalDate(selection.startDate) ?? todayStart
  const customEnd = parseLocalDate(selection.endDate) ?? customStart
  const start = startOfDay(customStart <= customEnd ? customStart : customEnd)
  const end = endOfDay(customStart <= customEnd ? customEnd : customStart)
  return range(
    'custom',
    'Özel Tarih',
    'Önceki aynı uzunluktaki dönem ile karşılaştırılıyor',
    start,
    end,
  )
}

export function dedupeDashboardOrders(orders: CargoOrder[]): CargoOrder[] {
  const seen = new Set<string>()
  return orders.filter((order) => {
    const key = dashboardOrderKey(order)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function buildDashboardSalesPeriodCards(
  orders: CargoOrder[],
  now = new Date(),
  claims?: AnalyticsClaim[],
): DashboardSalesPeriodCard[] {
  const uniqueOrders = dedupeDashboardOrders(orders)
  const packageQuantityLookup = buildPackageQuantityLookup(uniqueOrders)
  const lineQuantityLookup = buildLineQuantityLookup(uniqueOrders)
  const resolveClaimOrder = buildClaimOrderResolver(uniqueOrders)
  const keys: DashboardSalesPeriodKey[] = [
    'today',
    'yesterday',
    'month',
    'lastMonth',
  ]

  return keys.map((key) => {
    const period = resolveSalesPeriodRange(key, now)
    const comparisonPeriod = resolveSalesCardComparisonRange(key, period, now)
    const periodOrders = uniqueOrders.filter((order) =>
      orderIsInRange(order, period),
    )
    const comparisonOrders = uniqueOrders.filter((order) =>
      orderIsInRange(order, comparisonPeriod),
    )
    // Kabul edilen iadeler claim effectiveDate dönemine göre düşülür.
    const totals = applyClaimAdjustment(
      calculatePeriodTotals(periodOrders),
      buildClaimAdjustment(
        claims,
        period,
        periodOrders,
        resolveClaimOrder,
        packageQuantityLookup,
        lineQuantityLookup,
      ),
    )
    const comparisonTotals = applyClaimAdjustment(
      calculatePeriodTotals(comparisonOrders),
      buildClaimAdjustment(
        claims,
        comparisonPeriod,
        comparisonOrders,
        resolveClaimOrder,
        packageQuantityLookup,
        lineQuantityLookup,
      ),
    )

    return {
      key,
      label: period.label,
      dateLabel: salesPeriodDateLabel(key, period),
      range: period,
      salesAmount: totals.salesAmount,
      salesAmountAvailable: totals.salesAmountAvailable,
      returnCancellationAmount: totals.returnCancellationAmount,
      returnCancellationAmountAvailable:
        totals.returnCancellationAmountAvailable,
      packageCount: totals.orderCount,
      lineCount: totals.lineCount,
      productCount: totals.productCount,
      packageAverage: totals.packageAverage,
      returnPackageCount: totals.returnCount,
      cancelPackageCount: totals.cancelCount,
      comparison: calculateComparison(
        totals.salesAmount,
        comparisonTotals.salesAmount,
      ),
    }
  })
}

function resolveComparisonPeriod(
  period: DashboardDateRange,
  key: DashboardPeriodKey,
): DashboardDateRange {
  const durationDays = daySpan(period)
  if (key === 'month') {
    const previousMonthStart = new Date(
      period.start.getFullYear(),
      period.start.getMonth() - 1,
      1,
    )
    return range(
      'comparison',
      'Önceki Ay',
      period.helper,
      previousMonthStart,
      endOfDay(addDays(previousMonthStart, durationDays - 1)),
    )
  }
  const start = addDays(period.start, -durationDays)
  const end = endOfDay(addDays(start, durationDays - 1))
  return range('comparison', 'Karşılaştırma', period.helper, start, end)
}

// Satış kartlarının gün sınırları saf UTC raporlama helper'ından gelir
// (Durusoft mutabakatı); yalnız etiket/başlık metinleri burada kalır.
function salesCardReportingKey(
  key: DashboardSalesPeriodKey,
): ReportingPeriodKey {
  if (key === 'month') return 'thisMonth'
  if (key === 'lastMonth') return 'lastMonth'
  return key
}

function resolveSalesPeriodRange(
  key: DashboardSalesPeriodKey,
  now: Date,
): DashboardDateRange {
  const bounds = resolveReportingRange(
    salesCardReportingKey(key),
    now,
    DASHBOARD_SALES_REPORTING_TIME_ZONE,
  )
  if (key === 'today') {
    return range('today', 'Bugün', 'Bugünün net satış özeti', bounds.start, bounds.end)
  }
  if (key === 'yesterday') {
    return range('yesterday', 'Dün', 'Dünün net satış özeti', bounds.start, bounds.end)
  }
  if (key === 'month') {
    return range(
      'month',
      'Bu Ay',
      'Ay başından bugüne net satış özeti',
      bounds.start,
      bounds.end,
    )
  }
  return range(
    'lastMonth',
    'Geçen Ay',
    'Önceki takvim ayının net satış özeti',
    bounds.start,
    bounds.end,
  )
}

function resolveSalesCardComparisonRange(
  key: DashboardSalesPeriodKey,
  period: DashboardDateRange,
  now: Date,
): DashboardDateRange {
  const bounds = resolveReportingComparisonRange(
    salesCardReportingKey(key),
    period,
    now,
    DASHBOARD_SALES_REPORTING_TIME_ZONE,
  )
  if (key === 'today' || key === 'yesterday') {
    return range(
      'comparison',
      'Önceki Gün',
      'Önceki gün ile karşılaştırılıyor',
      bounds.start,
      bounds.end,
    )
  }
  if (key === 'month') {
    return range(
      'comparison',
      'Önceki Ayın Aynı Dönemi',
      'Önceki ayın aynı gün sayısı ile karşılaştırılıyor',
      bounds.start,
      bounds.end,
    )
  }
  return range(
    'comparison',
    'Bir Önceki Ay',
    'Bir önceki tam ay ile karşılaştırılıyor',
    bounds.start,
    bounds.end,
  )
}

// Kart tarih etiketi UTC bucket tarihinden okunur (İstanbul çapası gereği
// anchor tarihine eşittir); makine TZ'sinden bağımsızdır.
function salesPeriodDateLabel(
  key: DashboardSalesPeriodKey,
  period: DashboardDateRange,
): string {
  if (key === 'today' || key === 'yesterday') {
    return new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC' }).format(
      period.start,
    )
  }
  const label = new Intl.DateTimeFormat('tr-TR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(period.start)
  return label.charAt(0).toLocaleUpperCase('tr-TR') + label.slice(1)
}

function calculatePeriodTotals(orders: CargoOrder[]): PeriodTotals {
  const salesOrders = orders.filter((order) => salesDisposition(order) === 'sale')
  const returnedOrders = orders.filter(
    (order) => salesDisposition(order) === 'return',
  )
  const canceledOrders = orders.filter(
    (order) => salesDisposition(order) === 'cancel',
  )
  const salesAmounts = salesOrders.map(resolveOrderAmount)
  const returnAmounts = returnedOrders.map(resolveOrderAmount)
  const cancelAmounts = canceledOrders.map(resolveOrderAmount)
  const productCount = salesOrders.reduce(
    (total, order) =>
      total +
      order.items.reduce(
        (sum, item) => sum + Math.max(0, finiteNumber(item.quantity)),
        0,
      ),
    0,
  )
  const returnAmountAvailable =
    returnedOrders.length === 0 || returnAmounts.every(isNumber)
  const cancelAmountAvailable =
    canceledOrders.length === 0 || cancelAmounts.every(isNumber)
  return {
    salesAmount: sumAvailableAmounts(salesAmounts),
    salesAmountAvailable: salesOrders.length === 0 || salesAmounts.every(isNumber),
    orderCount: salesOrders.length,
    lineCount: salesOrders.reduce((total, order) => total + order.items.length, 0),
    productCount,
    returnAmount: sumAvailableAmounts(returnAmounts),
    returnAmountAvailable,
    returnCount: returnedOrders.length,
    cancelAmount: sumAvailableAmounts(cancelAmounts),
    cancelAmountAvailable,
    cancelCount: canceledOrders.length,
    returnCancellationAmount: sumAvailableAmounts([
      ...returnAmounts,
      ...cancelAmounts,
    ]),
    returnCancellationAmountAvailable:
      returnAmountAvailable && cancelAmountAvailable,
    packageAverage: salesOrders.length > 0 ? productCount / salesOrders.length : 0,
  }
}

// --- İade (claim) mutabakatı ---------------------------------------------
// Bir siparişin claim eşleşmesinde kullanılabilecek paket kimlikleri.
// Claim.packageId = Trendyol orderShipmentPackageId; sipariş normalize'ında
// bu değer packageId ve/veya shipmentPackageId olarak durur.
function orderPackageIdentifiers(order: CargoOrder): string[] {
  const ids = new Set<string>()
  const add = (value: unknown) => {
    const id = String(value ?? '').trim()
    if (id) ids.add(id)
  }
  add(order.packageId)
  add(order.shipmentPackageId)
  return [...ids]
}

function orderTotalQuantity(order: CargoOrder): number {
  return order.items.reduce(
    (sum, item) => sum + Math.max(0, finiteNumber(item.quantity)),
    0,
  )
}

// packageId → satış toplam adedi (tam/kısmi iade ayrımı için). Yalnız satış
// disposition'lı siparişler indekslenir; hem packageId hem shipmentPackageId
// anahtar olur.
function buildPackageQuantityLookup(
  salesSource: CargoOrder[],
): (packageId: string) => number | undefined {
  const map = new Map<string, number>()
  for (const order of salesSource) {
    if (salesDisposition(order) !== 'sale') continue
    const quantity = orderTotalQuantity(order)
    for (const id of orderPackageIdentifiers(order)) {
      map.set(id, (map.get(id) ?? 0) + quantity)
    }
  }
  return (packageId: string) => map.get(String(packageId ?? ''))
}

// (packageId, lineId) → satış satır adedi. claim.orderLineId Trendyol ham
// satır id'sidir; sipariş item.id ise `ty_line_<hamId>` biçimindedir, bu yüzden
// hem tam id hem ön eki kaldırılmış id anahtarlanır.
function buildLineQuantityLookup(
  salesSource: CargoOrder[],
): (packageId: string, lineId: string) => number | undefined {
  const map = new Map<string, number>()
  const stripLineId = (id: string) =>
    id.startsWith('ty_line_') ? id.slice('ty_line_'.length) : id
  for (const order of salesSource) {
    if (salesDisposition(order) !== 'sale') continue
    for (const packageId of orderPackageIdentifiers(order)) {
      for (const item of order.items) {
        const quantity = Math.max(0, finiteNumber(item.quantity))
        const rawId = String(item.id ?? '')
        for (const lineKey of new Set([rawId, stripLineId(rawId)])) {
          if (!lineKey) continue
          const key = `${packageId}::${lineKey}`
          map.set(key, (map.get(key) ?? 0) + quantity)
        }
      }
    }
  }
  return (packageId: string, lineId: string) =>
    map.get(`${String(packageId ?? '')}::${String(lineId ?? '')}`)
}

// Dönemde status ile ZATEN iade/iptal sayılan paket kimlikleri; claim çift
// düşümünü önler (Orders API Returned + aynı paket claim → tek düşüm).
function buildStatusReturnCancelPackageIds(
  periodOrders: CargoOrder[],
): Set<string> {
  const ids = new Set<string>()
  for (const order of periodOrders) {
    const disposition = salesDisposition(order)
    if (disposition === 'return' || disposition === 'cancel') {
      for (const id of orderPackageIdentifiers(order)) ids.add(id)
    }
  }
  return ids
}

// Claim → satış siparişi çözümleyici. İade edilen paket (outbound packageId)
// veya orderNumber ile eşleşir. order-cohort attribution ve tam/kısmi iade
// tespiti bu çözümlemeye dayanır.
function buildClaimOrderResolver(
  salesSource: CargoOrder[],
): (claim: AnalyticsClaim) => CargoOrder | undefined {
  const byPackage = new Map<string, CargoOrder>()
  const byNumber = new Map<string, CargoOrder>()
  for (const order of salesSource) {
    if (salesDisposition(order) !== 'sale') continue
    for (const id of orderPackageIdentifiers(order)) {
      if (!byPackage.has(id)) byPackage.set(id, order)
    }
    const orderNumber = String(order.orderNumber ?? '').trim()
    if (orderNumber && !byNumber.has(orderNumber)) byNumber.set(orderNumber, order)
  }
  return (claim: AnalyticsClaim) =>
    byPackage.get(String(claim.packageId ?? '')) ??
    byNumber.get(String(claim.orderNumber ?? ''))
}

// Verilen dönem için kabul edilmiş iade etkisini üretir. Döneme aitlik
// ORDER-COHORT'tur: iade, iade edilen SİPARİŞİN orderDate ayına yazılır
// (Durusoft mutabakatı). Siparişi bulunamayan (fetch penceresinden eski)
// iadeler hiçbir döneme yazılmaz.
function buildClaimAdjustment(
  claims: AnalyticsClaim[] | undefined,
  period: DashboardDateRange,
  periodOrders: CargoOrder[],
  resolveClaimOrder: (claim: AnalyticsClaim) => CargoOrder | undefined,
  packageQuantityLookup: (packageId: string) => number | undefined,
  lineQuantityLookup: (packageId: string, lineId: string) => number | undefined,
): ClaimPeriodAdjustment {
  return summarizeAcceptedClaimsForPeriod(
    claims,
    (claim) => {
      const order = resolveClaimOrder(claim)
      if (!order) return false
      return orderIsInRange(order, period)
    },
    {
      excludePackageIds: buildStatusReturnCancelPackageIds(periodOrders),
      packageQuantityLookup,
      lineQuantityLookup,
    },
  )
}

// Kabul edilen iade etkisini net satış toplamlarına uygular. Satış düşer,
// iade/iptal tutarına eklenir, iade paket sayısı artar. Değerler 0'ın
// altına düşürülmez (görüntü güvenliği).
function applyClaimAdjustment(
  totals: PeriodTotals,
  adjustment: ClaimPeriodAdjustment,
): PeriodTotals {
  const salesAmount = Math.max(0, totals.salesAmount - adjustment.amountDeduction)
  const orderCount = Math.max(0, totals.orderCount - adjustment.packageDeduction)
  const lineCount = Math.max(0, totals.lineCount - adjustment.lineDeduction)
  const productCount = Math.max(
    0,
    totals.productCount - adjustment.unitDeduction,
  )
  const amountAvailable = !adjustment.amountUnavailable
  return {
    ...totals,
    salesAmount,
    salesAmountAvailable: totals.salesAmountAvailable && amountAvailable,
    orderCount,
    lineCount,
    productCount,
    returnAmount: totals.returnAmount + adjustment.amountDeduction,
    returnAmountAvailable: totals.returnAmountAvailable && amountAvailable,
    returnCount: totals.returnCount + adjustment.returnedPackageCount,
    returnCancellationAmount:
      totals.returnCancellationAmount + adjustment.amountDeduction,
    returnCancellationAmountAvailable:
      totals.returnCancellationAmountAvailable && amountAvailable,
    packageAverage: orderCount > 0 ? productCount / orderCount : 0,
  }
}

function metric(
  current: number,
  previous: number,
  available = true,
): DashboardMetric {
  return {
    value: finiteNumber(current),
    comparison: calculateComparison(current, previous),
    available,
  }
}

// Tutar kaynağı CANONICAL (tek kaynak): totalAmount → totalPrice → item
// price×quantity toplamı; lineTotal DEĞİL. Diagnostic ile AYNI fonksiyon.
function resolveOrderAmount(order: CargoOrder): number | null {
  return resolveCanonicalOrderAmount(order)
}

function resolveItemRevenue(
  order: CargoOrder,
  item: OrderItem,
  orderQuantity: number,
): number {
  const quantity = Math.max(0, finiteNumber(item.quantity))
  if (isNumber(item.price)) return finiteNumber(item.price) * quantity
  const orderAmount = resolveOrderAmount(order)
  if (orderAmount === null || orderQuantity <= 0) return 0
  return orderAmount * (quantity / orderQuantity)
}

// Satış/iade/iptal dispozisyonu CANONICAL tanımdan (tek kaynak) türetilir:
// dashboardSalesMetricDefinition.orderDispositionOf. Token kümeleri, Türkçe-
// katlamalı normalize ve RETURN>CANCEL>SALE önceliği o modülde tanımlıdır;
// backend mutabakatı ve diagnostic ile AYNI kuralı paylaşır (davranış aynı).
function salesDisposition(order: CargoOrder): SalesDisposition {
  return orderDispositionOf(order)
}

function buildDistribution(
  orders: CargoOrder[],
  labelFor: (order: CargoOrder) => string,
): DashboardDistributionRow[] {
  const groups = new Map<string, { label: string; orders: CargoOrder[] }>()
  for (const order of orders.filter((item) => salesDisposition(item) === 'sale')) {
    const label = labelFor(order)
    const key = normalizeIdentity(label)
    const group = groups.get(key) ?? { label, orders: [] }
    group.orders.push(order)
    groups.set(key, group)
  }
  const totalAmount = Array.from(groups.values()).reduce(
    (sum, group) =>
      sum + group.orders.reduce((value, order) => value + (resolveOrderAmount(order) ?? 0), 0),
    0,
  )
  const totalOrders = orders.filter(
    (item) => salesDisposition(item) === 'sale',
  ).length
  return Array.from(groups.entries())
    .map(([key, group]) => {
      const amount = group.orders.reduce(
        (sum, order) => sum + (resolveOrderAmount(order) ?? 0),
        0,
      )
      return {
        key,
        label: group.label,
        orderCount: group.orders.length,
        amount,
        share:
          totalAmount > 0
            ? (amount / totalAmount) * 100
            : totalOrders > 0
              ? (group.orders.length / totalOrders) * 100
              : 0,
      }
    })
    .sort((left, right) => right.amount - left.amount || right.orderCount - left.orderCount)
}

function buildTopProducts(
  orders: CargoOrder[],
  products: CargoProduct[],
): DashboardTopProduct[] {
  const groups = new Map<string, DashboardTopProduct>()
  for (const order of orders.filter((item) => salesDisposition(item) === 'sale')) {
    const orderQuantity = order.items.reduce(
      (total, item) => total + Math.max(0, finiteNumber(item.quantity)),
      0,
    )
    for (const item of order.items) {
      const key = dashboardProductKey(item)
      const quantity = Math.max(0, finiteNumber(item.quantity))
      const revenue = resolveItemRevenue(order, item, orderQuantity)
      const existing = groups.get(key)
      if (existing) {
        existing.quantity += quantity
        existing.revenue += revenue
        continue
      }
      groups.set(key, {
        key,
        productName: item.productName || 'Ürün bilgisi yok',
        sku: firstString(item.merchantSku, item.sku, item.stockCode),
        barcode: String(item.barcode || '').trim(),
        color: String(item.color || '').trim(),
        size: String(item.size || '').trim(),
        quantity,
        revenue,
        imageCandidates: resolveProductImageCandidates(item, products).map(
          (candidate) => candidate.url,
        ),
      })
    }
  }
  return Array.from(groups.values())
    .sort((left, right) => right.quantity - left.quantity || right.revenue - left.revenue)
}

const PICKING_DISPLAY_LIMIT = 50

/**
 * TOPLANACAK ÜRÜNLER.
 *
 * Kapsam: TÜM sipariş kümesi kanonik `isPickingEligible` ile süzülür —
 * dönem/gün daraltması YOKTUR ve satış disposition'ı UYGULANMAZ (bu bir
 * operasyon kuyruğudur, satış raporu değil).
 *
 * Gruplama: ürün AİLESİ (beden bağımsız) + beden alt kırılımı.
 * Karmaşıklık: sipariş × kalem üzerinde TEK geçiş (eski kod ürün × sipariş ×
 * kalem iç içe tarıyordu).
 */
function buildPickingLists(
  orders: CargoOrder[],
  products: CargoProduct[],
): DashboardViewModel['pickingLists'] {
  const eligible = orders.filter(isPickingEligible)
  const families = buildProductFamilyIndex(eligible, resolvePickingStage)
  const orderLookup = new Map<string, CargoOrder>()
  for (const order of eligible) {
    orderLookup.set(String(order.id || order.orderNumber || ''), order)
  }
  const pickingOrderIds = new Set<string>()
  let totalQuantity = 0
  for (const family of families) {
    totalQuantity += family.totalQuantity
    for (const orderId of family.orderIds) pickingOrderIds.add(orderId)
  }
  const visible = families
    .slice(0, PICKING_DISPLAY_LIMIT)
    .map((family) => toPickingProduct(family, orderLookup, products))
  return {
    mode: 'readonly-products',
    title: 'Toplanacak Ürünler',
    products: visible,
    totalFamilyCount: families.length,
    hiddenFamilyCount: Math.max(0, families.length - visible.length),
    orderCount: pickingOrderIds.size,
    totalQuantity,
  }
}

function toPickingProduct(
  family: ProductFamilyGroup,
  orderLookup: Map<string, CargoOrder>,
  products: CargoProduct[],
): DashboardPickingProduct {
  const stageBreakdown = Object.entries(family.stageCounts)
    .map(([stage, count]) => ({
      stage: stage as DashboardOperationStage,
      label: dashboardOperationStageLabel(stage as DashboardOperationStage),
      count,
    }))
    .sort((left, right) => right.count - left.count)
  const seenOrders = new Set<string>()
  const orderRefs: DashboardPickingOrderRef[] = []
  for (const ref of family.orderRefs) {
    // Aynı sipariş aynı ailede birden çok kalem taşıyabilir → sipariş
    // kimliğiyle dedupe; adet birleştirilir.
    const existing = orderRefs.find((entry) => entry.orderId === ref.orderId)
    if (existing) {
      existing.quantity += ref.quantity
      if (!existing.size.includes(ref.size)) {
        existing.size = `${existing.size}, ${ref.size}`
      }
      continue
    }
    if (seenOrders.has(ref.orderId)) continue
    seenOrders.add(ref.orderId)
    const order = orderLookup.get(ref.orderId)
    const state = order ? classifyOrderForTabs(order) : undefined
    orderRefs.push({
      orderId: ref.orderId,
      displayOrderNumber: order ? displayOrderNumber(order) : ref.orderId,
      // Yalnız mevcut güvenli gösterim; ek PII (adres/telefon) TAŞINMAZ.
      customerName: String(order?.customerName ?? '').trim(),
      size: ref.size,
      quantity: ref.quantity,
      orderDate: order?.orderDate || order?.createdAt,
      operationStatusLabel: order
        ? dashboardOperationStageLabel(resolvePickingStage(order))
        : '',
      labelReady: Boolean(state?.isLabelReady),
      carrier: String(order?.cargoProviderName ?? '').trim(),
    })
  }
  return {
    key: family.key,
    productName: family.productName,
    color: family.color,
    sku: firstString(
      family.sampleItem.merchantSku,
      family.sampleItem.sku,
      family.sampleItem.stockCode,
    ),
    barcode: String(family.sampleItem.barcode || '').trim(),
    quantity: family.totalQuantity,
    orderCount: family.orderCount,
    imageCandidates: resolveProductImageCandidates(
      family.sampleItem,
      products,
    ).map((candidate) => candidate.url),
    variants: family.variants.map((variant) => ({
      sizeKey: variant.sizeKey,
      size: variant.size,
      quantity: variant.quantity,
      orderCount: variant.orderIds.length,
      orderIds: variant.orderIds,
    })),
    stageBreakdown,
    orders: orderRefs,
    identitySource: family.identitySource,
  }
}

function buildActionRequired(
  classified: Array<{
    order: CargoOrder
    state: ReturnType<typeof classifyOrderForTabs>
  }>,
): DashboardActionRequired[] {
  const createRequired = classified.filter(({ order }) =>
    orderMatchesDashboardAction(order, 'createEligible'),
  )
  const printable = classified.filter(({ order }) =>
    orderMatchesDashboardAction(order, 'printEligible'),
  )
  const verificationWaiting = classified.filter(
    ({ state }) => state.isSuratVerificationWaiting && !state.hasError,
  )
  const critical = classified.filter(({ order }) =>
    orderMatchesDashboardAction(order, 'critical'),
  )
  return [
    {
      key: 'create-required',
      label: 'Barkod oluşturulmamış siparişler',
      description: 'Kargo gönderisi oluşturulabilecek aktif siparişler',
      count: createRequired.length,
      filterTarget: 'all',
      actionFilter: 'createEligible',
      severity: 'warning',
    },
    {
      key: 'print-required',
      label: 'Etiket basılmamış siparişler',
      description: 'Etiketi hazır ve gerçek baskı kaydı olmayan siparişler',
      count: printable.length,
      filterTarget: 'all',
      actionFilter: 'printEligible',
      severity: 'warning',
    },
    {
      key: 'verification-waiting',
      label: 'Sürat doğrulama bekleyenler',
      description: 'Hata değil; kargo kabulü veya doğrulaması beklenen gönderiler',
      count: verificationWaiting.length,
      filterTarget: 'suratVerificationPending',
      severity: 'info',
    },
    {
      key: 'critical-data',
      label: 'Hatalı / kritik bilgisi eksik siparişler',
      description: 'Gerçek hata, adres veya desi kontrolü gereken açık işlemler',
      count: critical.length,
      filterTarget: 'all',
      actionFilter: 'critical',
      severity: 'danger',
    },
  ]
}

function buildRecentOperations(
  orders: CargoOrder[],
  products: CargoProduct[],
): DashboardRecentOperation[] {
  return [...orders]
    .sort((left, right) => orderTimestamp(right) - orderTimestamp(left))
    .map((order) => {
      const firstItem = order.items[0]
      const state = classifyOrderForTabs(order)
      // Yetki kalıcı (canonical operationStatus + persisted metadata) kaynaktan;
      // geçici tarayıcı state'ine bağlı değil → sayfa yenilemesinde korunur.
      const capabilities = resolveOrderActionCapabilities(order)
      const printable = capabilities.canPrintLabel
      const zplReady = capabilities.canDownloadLabel
      return {
        id: order.id,
        packageId: order.packageId,
        shipmentPackageId: order.shipmentPackageId,
        orderNumber: order.orderNumber,
        displayOrderNumber: displayOrderNumber(order),
        marketplace: String(order.marketplace || 'Bilinmeyen'),
        customerName: order.customerName,
        productName: firstItem?.productName || 'Ürün bilgisi yok',
        productVariant: [firstItem?.color, firstItem?.size].filter(Boolean).join(' · '),
        additionalItemCount: Math.max(0, order.items.length - 1),
        imageCandidates: firstItem
          ? resolveProductImageCandidates(firstItem, products).map(
              (candidate) => candidate.url,
            )
          : [],
        status: state.operationStatusLabel,
        carrier: order.cargoProviderName || order.shipment?.provider || 'Kargo bilgisi yok',
        orderDate: order.orderDate || order.createdAt,
        operationStatus: capabilities.operationStatus,
        labelStatus: capabilities.labelStatus,
        hasPrintableLabel: capabilities.hasPrintableLabel,
        canViewDetails: capabilities.canViewDetails,
        canPrint: printable,
        canDownloadZpl: zplReady,
        printDisabledReason: printable
          ? ''
          : order.labelBlockedReason || 'Yazdırılabilir etiket yok.',
        zplDisabledReason: zplReady
          ? ''
          : order.zplDisabledReason || 'İndirilebilir ZPL verisi yok.',
      }
    })
}

export function resolveDashboardOrder(
  orders: CargoOrder[],
  operation: Pick<
    DashboardRecentOperation,
    'id' | 'marketplace' | 'orderNumber' | 'packageId' | 'shipmentPackageId'
  >,
): CargoOrder | undefined {
  const marketplace = normalizeIdentity(operation.marketplace)
  const packageIdentity = firstString(
    String(operation.packageId ?? ''),
    String(operation.shipmentPackageId ?? ''),
  )
  if (packageIdentity) {
    const normalizedPackage = normalizeIdentity(packageIdentity)
    const packageMatch = orders.find((order) => {
      if (normalizeIdentity(order.marketplace) !== marketplace) return false
      return [order.packageId, order.shipmentPackageId]
        .filter(Boolean)
        .some((value) => normalizeIdentity(value) === normalizedPackage)
    })
    if (packageMatch) return packageMatch
  }
  const idMatch = orders.find((order) => order.id === operation.id)
  if (idMatch) return idMatch
  return orders.find(
    (order) =>
      normalizeIdentity(order.marketplace) === marketplace &&
      normalizeIdentity(order.orderNumber) ===
        normalizeIdentity(operation.orderNumber),
  )
}

function buildTimeBuckets(
  orders: CargoOrder[],
  period: DashboardDateRange,
  granularity: DashboardViewModel['salesChart']['granularity'],
): DashboardTimeBucket[] {
  const bucketCount =
    granularity === 'hourly'
      ? 24
      : granularity === 'daily'
        ? daySpan(period)
        : granularity === 'weekly'
          ? Math.ceil(daySpan(period) / 7)
          : Math.max(
              1,
              (period.end.getFullYear() - period.start.getFullYear()) * 12 +
                period.end.getMonth() -
                period.start.getMonth() +
                1,
            )
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    key: `${granularity}-${index}`,
    label: bucketLabel(period, granularity, index),
    amount: 0,
    orderCount: 0,
  }))
  for (const order of orders.filter(
    (item) => salesDisposition(item) === 'sale',
  )) {
    const date = new Date(order.orderDate || order.createdAt)
    const index = bucketIndex(period, granularity, date)
    const bucket = buckets[index]
    if (!bucket) continue
    bucket.orderCount += 1
    bucket.amount += resolveOrderAmount(order) ?? 0
  }
  return buckets
}

function resolveChartGranularity(
  period: DashboardDateRange,
): DashboardViewModel['salesChart']['granularity'] {
  const days = daySpan(period)
  if (days <= 2) return 'hourly'
  if (days <= 45) return 'daily'
  if (days <= 180) return 'weekly'
  return 'monthly'
}

// Satış grafiği bucket'ları RAPOR DÖNEMİ başlangıcından saf ms aritmetiğiyle
// bölünür (UTC rapor günüyle hizalı; makine TZ'sinden bağımsız). Saat
// etiketleri Türkiye saatiyle, gün etiketleri UTC rapor gününe göre yazılır.
const CHART_HOUR_MS = 3_600_000
const CHART_DAY_MS = 86_400_000

function bucketIndex(
  period: DashboardDateRange,
  granularity: DashboardViewModel['salesChart']['granularity'],
  date: Date,
): number {
  const offsetMs = date.getTime() - period.start.getTime()
  if (granularity === 'hourly') return Math.floor(offsetMs / CHART_HOUR_MS)
  const days = Math.floor(offsetMs / CHART_DAY_MS)
  if (granularity === 'daily') return days
  if (granularity === 'weekly') return Math.floor(days / 7)
  return (
    (date.getUTCFullYear() - period.start.getUTCFullYear()) * 12 +
    date.getUTCMonth() -
    period.start.getUTCMonth()
  )
}

function bucketLabel(
  period: DashboardDateRange,
  granularity: DashboardViewModel['salesChart']['granularity'],
  index: number,
): string {
  if (granularity === 'hourly') {
    return new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Europe/Istanbul',
    }).format(new Date(period.start.getTime() + index * CHART_HOUR_MS))
  }
  if (granularity === 'daily') {
    return formatUtcShortDate(
      new Date(period.start.getTime() + index * CHART_DAY_MS),
    )
  }
  if (granularity === 'weekly') {
    return formatUtcShortDate(
      new Date(period.start.getTime() + index * 7 * CHART_DAY_MS),
    )
  }
  return new Intl.DateTimeFormat('tr-TR', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }).format(
    new Date(
      Date.UTC(
        period.start.getUTCFullYear(),
        period.start.getUTCMonth() + index,
        1,
      ),
    ),
  )
}

function formatUtcShortDate(date: Date): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  }).format(date)
}

// Paket tekilleştirme anahtarı CANONICAL (tek kaynak): diagnostic projection
// ile AYNI dedupe kuralı.
function dashboardOrderKey(order: CargoOrder): string {
  return orderDedupeKey(order)
}

function dashboardProductKey(item: OrderItem): string {
  const variant = normalizeIdentity(
    [item.color, item.size, ...((item.variantAttributes ?? []).map((attribute) => attribute.value))]
      .filter(Boolean)
      .join('|'),
  )
  if (String(item.barcode || '').trim()) return `barcode:${normalizeIdentity(item.barcode)}`
  if (item.productContentId || item.productMainId) {
    return `content:${normalizeIdentity(item.productContentId || item.productMainId)}:${variant}`
  }
  if (item.productCode) return `product:${normalizeIdentity(item.productCode)}:${variant}`
  const sku = firstString(item.merchantSku, item.sku, item.stockCode)
  if (sku) return `sku:${normalizeIdentity(sku)}:${variant}`
  return `fallback:${normalizeIdentity(item.productName)}:${variant}`
}

function normalizeCity(value: unknown): string {
  const cleaned = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!cleaned) return 'Bilinmeyen'
  const token = normalizeIdentity(cleaned)
  if (token === 'istanbul') return 'İstanbul'
  if (token === 'izmir') return 'İzmir'
  return cleaned
    .toLocaleLowerCase('tr-TR')
    .split(' ')
    .map((part) => part.charAt(0).toLocaleUpperCase('tr-TR') + part.slice(1))
    .join(' ')
}

function normalizeIdentity(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function orderIsInRange(order: CargoOrder, period: DashboardDateRange): boolean {
  return timestampInRange(order.orderDate || order.createdAt, period)
}

function timestampInRange(value: unknown, period: DashboardDateRange): boolean {
  const time = new Date(String(value ?? '')).getTime()
  return Number.isFinite(time) && time >= period.start.getTime() && time <= period.end.getTime()
}

function range(
  key: DashboardDateRange['key'],
  label: string,
  helper: string,
  start: Date,
  end: Date,
): DashboardDateRange {
  return { key, label, helper, start, end }
}

function startOfDay(value: Date): Date {
  const result = new Date(value)
  result.setHours(0, 0, 0, 0)
  return result
}

function endOfDay(value: Date): Date {
  const result = new Date(value)
  result.setHours(23, 59, 59, 999)
  return result
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value)
  result.setDate(result.getDate() + days)
  return result
}

// Dönem gün sayısı saf ms aritmetiğiyle (sınırlar gün-hizalı olduğundan
// tam sayıdır; makine TZ'sinden bağımsız — UTC rapor dönemleriyle uyumlu).
function daySpan(period: DashboardDateRange): number {
  return Math.max(
    1,
    Math.round(
      (period.end.getTime() + 1 - period.start.getTime()) / 86_400_000,
    ),
  )
}

function parseLocalDate(value?: string): Date | null {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function orderTimestamp(order: CargoOrder): number {
  const time = new Date(order.orderDate || order.createdAt).getTime()
  return Number.isFinite(time) ? time : 0
}

function resolveLatestSyncAt(orders: CargoOrder[]): string | undefined {
  return orders
    .map((order) => String(order.lastMarketplaceSyncedAt ?? '').trim())
    .filter(Boolean)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => right.time - left.time)[0]?.value
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isNumber(value: unknown): value is number {
  return value !== null && value !== '' && Number.isFinite(Number(value))
}

function sumAvailableAmounts(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function firstString(...values: Array<string | undefined>): string {
  return values.map((value) => String(value ?? '').trim()).find(Boolean) ?? ''
}


// Test dikişi: SQL toplaması bu fonksiyonun ÇIKTISIYLA karşılaştırılır.
// Kopya bir referans uygulaması yazmak, karşılaştırmayı anlamsız kılardı —
// karşılaştırılan şey ÜRETİMDE çalışan koddur.
export const __testing = { calculatePeriodTotals }
