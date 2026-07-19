import type { CargoOrder, CargoProduct, OrderItem } from '../types/cargoflow'
import {
  classifyOrderForTabs,
  orderMatchesDashboardAction,
} from '../utils/orderClassification'
import {
  canDownloadZpl,
  canMarkPrinted,
} from '../utils/orderStatus'
import { resolveProductImageCandidates } from '../utils/productImage'
import type { OrdersActionFilter } from '../utils/ordersNavigation'
import {
  DASHBOARD_SALES_REPORTING_TIME_ZONE,
  resolveReportingComparisonRange,
  resolveReportingRange,
  type ReportingPeriodKey,
} from './reportingRange'

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

export interface DashboardPickingProduct extends DashboardTopProduct {
  orderCount: number
}

export interface DashboardRecentOperation {
  id: string
  packageId?: string
  shipmentPackageId?: string
  orderNumber: string
  marketplace: string
  customerName: string
  productName: string
  productVariant: string
  additionalItemCount: number
  imageCandidates: string[]
  status: string
  carrier: string
  orderDate: string
  canPrint: boolean
  canDownloadZpl: boolean
  printDisabledReason: string
  zplDisabledReason: string
}

export interface DashboardViewModel {
  period: DashboardDateRange
  comparisonPeriod: DashboardDateRange
  salesPeriodCards: DashboardSalesPeriodCard[]
  salesSummary: {
    salesAmount: DashboardMetric
    orderCount: DashboardMetric
    lineCount: DashboardMetric
    productCount: DashboardMetric
    returnAmount: DashboardMetric
    returnCount: DashboardMetric
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
  }
  recentOperations: DashboardRecentOperation[]
  latestSyncAt?: string
}

interface BuildDashboardViewModelInput {
  orders: CargoOrder[]
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
  products = [],
  selectedPeriod,
  comparisonPeriod,
  latestSyncAt,
  now = new Date(),
}: BuildDashboardViewModelInput): DashboardViewModel {
  const uniqueOrders = dedupeDashboardOrders(orders)
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
  const periodOrders = uniqueOrders.filter((order) =>
    orderIsInRange(order, period),
  )
  const comparisonOrders = uniqueOrders.filter((order) =>
    orderIsInRange(order, resolvedComparison),
  )
  const currentTotals = calculatePeriodTotals(periodOrders)
  const previousTotals = calculatePeriodTotals(comparisonOrders)
  const classified = uniqueOrders.map((order) => ({
    order,
    state: classifyOrderForTabs(order),
  }))
  // Operasyonel dönem sayaçları YEREL güne göre sayılmaya devam eder.
  const operationalPeriodOrders = uniqueOrders.filter((order) =>
    orderIsInRange(order, localPeriod),
  )
  const periodClassified = operationalPeriodOrders.map((order) => ({
    order,
    state: classifyOrderForTabs(order),
  }))
  const openOrders = classified
    .filter(({ state }) => state.isOpenOperation)
    .map(({ order }) => order)
  const labelPrinted = uniqueOrders.filter(
    (order) =>
      classifyOrderForTabs(order).isLabelPrinted &&
      Boolean(order.label?.printedAt) &&
      timestampInRange(order.label?.printedAt, localPeriod),
  ).length
  const handedToCargo = periodClassified.filter(
    ({ state }) => state.isHandedToCargo,
  ).length
  const delivered = periodClassified.filter(
    ({ state }) => state.isDelivered,
  ).length
  const operationalSummary = {
    openOperations: openOrders.length,
    barcodeWaiting: classified.filter(({ state }) => state.isBarcodeWaiting)
      .length,
    labelReady: classified.filter(({ state }) => state.isLabelReady).length,
    labelPrinted,
    handedToCargo,
    delivered,
    errors: classified.filter(({ state }) => state.hasError).length,
    snapshotLabel: 'Anlık operasyon durumu',
  }
  const granularity = resolveChartGranularity(period)

  return {
    period,
    comparisonPeriod: resolvedComparison,
    salesPeriodCards: buildDashboardSalesPeriodCards(uniqueOrders, now),
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
        currentTotals.returnAmountAvailable,
      ),
      returnCount: metric(
        currentTotals.returnCount,
        previousTotals.returnCount,
      ),
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
    actionRequired: buildActionRequired(classified),
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
    pickingLists: {
      mode: 'readonly-products',
      title: 'Toplanacak Ürünler',
      products: buildPickingProducts(
        openOrders,
        products,
      ).slice(0, 10),
    },
    recentOperations: buildRecentOperations(uniqueOrders, products).slice(0, 10),
    latestSyncAt: latestSyncAt ?? resolveLatestSyncAt(uniqueOrders),
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
): DashboardSalesPeriodCard[] {
  const uniqueOrders = dedupeDashboardOrders(orders)
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
    const totals = calculatePeriodTotals(periodOrders)
    const comparisonTotals = calculatePeriodTotals(comparisonOrders)

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

function resolveOrderAmount(order: CargoOrder): number | null {
  const candidates = [order.totalAmount, order.totalPrice]
  for (const candidate of candidates) {
    const parsed = Number(candidate)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  if (order.items.length > 0 && order.items.every((item) => isNumber(item.price))) {
    return order.items.reduce(
      (sum, item) =>
        sum + finiteNumber(item.price) * Math.max(0, finiteNumber(item.quantity)),
      0,
    )
  }
  return null
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

function salesDisposition(order: CargoOrder): 'sale' | 'return' | 'cancel' {
  const rawOrder =
    order.rawOrder && typeof order.rawOrder === 'object'
      ? (order.rawOrder as Record<string, unknown>)
      : undefined
  const tokens = [
    order.marketplaceStatus,
    order.packageStatus,
    order.shipmentStatusName,
    rawOrder?.status,
    rawOrder?.packageStatus,
    rawOrder?.shipmentStatus,
  ].map(normalizeIdentity)

  if (
    tokens.some((token) =>
      ['returned', 'returning', 'return', 'iade', 'undelivered'].some(
        (candidate) => token === candidate || token.includes(candidate),
      ),
    )
  ) {
    return 'return'
  }
  if (
    tokens.some((token) =>
      ['cancelled', 'canceled', 'cancel', 'iptal', 'unsupplied'].some(
        (candidate) => token === candidate || token.includes(candidate),
      ),
    )
  ) {
    return 'cancel'
  }
  return 'sale'
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

function buildPickingProducts(
  orders: CargoOrder[],
  products: CargoProduct[],
): DashboardPickingProduct[] {
  const topProducts = buildTopProducts(orders, products)
  return topProducts.map((product) => ({
    ...product,
    orderCount: orders.filter((order) =>
      order.items.some((item) => dashboardProductKey(item) === product.key),
    ).length,
  }))
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
      const printable = canMarkPrinted(order)
      const zplReady = canDownloadZpl(order)
      return {
        id: order.id,
        packageId: order.packageId,
        shipmentPackageId: order.shipmentPackageId,
        orderNumber: order.orderNumber,
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
        canPrint: printable,
        canDownloadZpl: zplReady,
        printDisabledReason: printable
          ? ''
          : order.labelBlockedReason || 'Doğrulanmış ve yazdırılabilir etiket yok.',
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

function dashboardOrderKey(order: CargoOrder): string {
  return (
    firstString(
      String(order.packageId ?? ''),
      String(order.shipmentPackageId ?? ''),
      `${String(order.marketplace ?? '')}::${String(order.orderNumber ?? '')}`,
      order.id,
    ) || `order-${orderTimestamp(order)}`
  )
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

