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

export type DashboardPeriodKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'month'
  | 'custom'

export interface DashboardPeriodSelection {
  key: DashboardPeriodKey
  startDate?: string
  endDate?: string
}

export interface DashboardDateRange {
  key: DashboardPeriodKey | 'comparison'
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
  const period = resolveDashboardPeriod(selectedPeriod, now)
  const resolvedComparison =
    comparisonPeriod ?? resolveComparisonPeriod(period, selectedPeriod.key)
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
  const periodClassified = periodOrders.map((order) => ({
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
      timestampInRange(order.label?.printedAt, period),
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
    topProducts: buildTopProducts(periodOrders, products).slice(0, 5),
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
        openOrders.filter((order) => orderIsInRange(order, period)),
        products,
      ).slice(0, 5),
    },
    recentOperations: buildRecentOperations(periodOrders, products).slice(0, 8),
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

function calculatePeriodTotals(orders: CargoOrder[]): PeriodTotals {
  const salesOrders = orders.filter(
    (order) => !classifyOrderForTabs(order).isCanceledOrReturned,
  )
  const returnedOrders = orders.filter(
    (order) => classifyOrderForTabs(order).isCanceledOrReturned,
  )
  const salesAmounts = salesOrders.map(resolveOrderAmount)
  const returnAmounts = returnedOrders.map(resolveOrderAmount)
  return {
    salesAmount: sumAvailableAmounts(salesAmounts),
    salesAmountAvailable: salesOrders.length === 0 || salesAmounts.every(isNumber),
    orderCount: salesOrders.length,
    lineCount: salesOrders.reduce((total, order) => total + order.items.length, 0),
    productCount: salesOrders.reduce(
      (total, order) =>
        total +
        order.items.reduce(
          (sum, item) => sum + Math.max(0, finiteNumber(item.quantity)),
          0,
        ),
      0,
    ),
    returnAmount: sumAvailableAmounts(returnAmounts),
    returnAmountAvailable:
      returnedOrders.length === 0 || returnAmounts.every(isNumber),
    returnCount: returnedOrders.length,
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

function buildDistribution(
  orders: CargoOrder[],
  labelFor: (order: CargoOrder) => string,
): DashboardDistributionRow[] {
  const groups = new Map<string, { label: string; orders: CargoOrder[] }>()
  for (const order of orders.filter(
    (item) => !classifyOrderForTabs(item).isCanceledOrReturned,
  )) {
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
    (item) => !classifyOrderForTabs(item).isCanceledOrReturned,
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
  for (const order of orders.filter(
    (item) => !classifyOrderForTabs(item).isCanceledOrReturned,
  )) {
    for (const item of order.items) {
      const key = dashboardProductKey(item)
      const quantity = Math.max(0, finiteNumber(item.quantity))
      const existing = groups.get(key)
      if (existing) {
        existing.quantity += quantity
        existing.revenue += isNumber(item.price)
          ? finiteNumber(item.price) * quantity
          : 0
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
        revenue: isNumber(item.price) ? finiteNumber(item.price) * quantity : 0,
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
    (item) => !classifyOrderForTabs(item).isCanceledOrReturned,
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

function bucketIndex(
  period: DashboardDateRange,
  granularity: DashboardViewModel['salesChart']['granularity'],
  date: Date,
): number {
  if (granularity === 'hourly') return date.getHours()
  const days = Math.floor((startOfDay(date).getTime() - startOfDay(period.start).getTime()) / 86_400_000)
  if (granularity === 'daily') return days
  if (granularity === 'weekly') return Math.floor(days / 7)
  return (
    (date.getFullYear() - period.start.getFullYear()) * 12 +
    date.getMonth() -
    period.start.getMonth()
  )
}

function bucketLabel(
  period: DashboardDateRange,
  granularity: DashboardViewModel['salesChart']['granularity'],
  index: number,
): string {
  if (granularity === 'hourly') return `${String(index).padStart(2, '0')}:00`
  if (granularity === 'daily') return formatShortDate(addDays(period.start, index))
  if (granularity === 'weekly') return `${formatShortDate(addDays(period.start, index * 7))}`
  const date = new Date(period.start.getFullYear(), period.start.getMonth() + index, 1)
  return date.toLocaleDateString('tr-TR', { month: 'short', year: '2-digit' })
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

function daySpan(period: DashboardDateRange): number {
  return Math.max(
    1,
    Math.round((startOfDay(period.end).getTime() - startOfDay(period.start).getTime()) / 86_400_000) + 1,
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

function formatShortDate(value: Date): string {
  return value.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' })
}
