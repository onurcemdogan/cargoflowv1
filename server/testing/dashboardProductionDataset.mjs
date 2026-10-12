// DASHBOARD ÜRETİM BENZERİ VERİ SETİ — test ve TZ child'ı AYNI veriyi kurar.
//
// Üretimdeki dağılımı taklit eder: 60 güne yayılmış siparişler, kuruşlu
// tutarlar, TSİ gece yarısı (UTC 21:xx) siparişleri, satış/iade/iptal
// statü karışımı, çok satırlı paketler, aynı organizasyonda İKİNCİ satıcı
// hesabı ve ayrı bir organizasyon (izolasyon). Taşıyıcı/pazaryeri çağrısı yok.
//
// `expectedSales` sunucu modelinden BAĞIMSIZ bir kâhindir: yalnız UTC gün
// aritmetiği ve statü→dispozisyon tablosu kullanır.

export const DATASET_NOW = new Date('2026-10-12T19:00:00.000Z') // 12.10 22:00 TSİ

const DAY_MS = 86_400_000
const STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'Delivered',
  'Delivered',
  'Shipped',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
  'Picking',
  'Delivered',
]
const OPERATIONS = ['NEW', 'LABEL_READY', 'LABEL_PRINTED', 'HANDED_TO_CARGO', 'DELIVERED']
// 21:30 UTC = ertesi gün 00:30 TSİ (gece yarısı sınırı); 02:15 UTC = 05:15 TSİ.
const HOURS = [
  [21, 30],
  [22, 45],
  [2, 15],
  [9, 5],
  [13, 40],
  [18, 20],
]
const PRODUCTS = Array.from({ length: 9 }, (_, index) => ({
  barcode: `869000000${String(index).padStart(4, '0')}`,
  sku: `SKU-${index}`,
  name: `Ürün ${index}`,
  unitPrice: 49.9 + index * 15,
}))

export function dispositionOf(status) {
  if (status === 'Returned' || status === 'UnDelivered') return 'return'
  if (status === 'Cancelled' || status === 'UnSupplied') return 'cancel'
  return 'sale'
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function buildRows() {
  const rows = []
  for (let index = 0; index < 360; index += 1) {
    const daysAgo = index % 60
    // Gün ve saat bağımsız döner: her gün altı farklı saat dilimi görür.
    const [hour, minute] = HOURS[Math.floor(index / 60) % HOURS.length]
    const orderDate = new Date(
      Date.UTC(2026, 9, 12 - daysAgo, hour, minute) - (index % 3) * 60_000,
    )
    // Gelecek tarihli sipariş üretimde olmaz.
    if (orderDate.getTime() > DATASET_NOW.getTime()) continue
    const lines = []
    const lineCount = 1 + (index % 2)
    for (let line = 0; line < lineCount; line += 1) {
      const product = PRODUCTS[(index + line * 4) % PRODUCTS.length]
      lines.push({ product, quantity: 1 + ((index + line) % 3) })
    }
    const totalAmount = round2(
      lines.reduce((sum, line) => sum + line.product.unitPrice * line.quantity, 0) +
        (index % 5) * 0.35,
    )
    rows.push({
      index,
      packageId: `PRD-${String(index).padStart(5, '0')}`,
      orderNumber: `TY-${String(10_000_000 + index)}`,
      status: STATUSES[index % STATUSES.length],
      operation: OPERATIONS[index % OPERATIONS.length],
      city: ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya'][index % 5],
      orderDate,
      totalAmount,
      lines,
    })
  }
  return rows
}

export const DATASET_ROWS = buildRows()

export async function seedProductionDataset(db, schema) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Üretim Benzeri', slug: `prod-like-${Math.random().toString(16).slice(2, 10)}` })
    .returning()
  const [account] = await db
    .insert(schema.marketplaceAccounts)
    .values({ organizationId: org.id, marketplace: 'Trendyol', providerAccountId: '277221', isActive: true })
    .returning()
  // Aynı organizasyonda ikinci satıcı hesabı: aktif hesabın sayılarına KARIŞMAZ.
  const [otherAccount] = await db
    .insert(schema.marketplaceAccounts)
    .values({ organizationId: org.id, marketplace: 'Trendyol', providerAccountId: '999001', isActive: true })
    .returning()
  const [otherOrg] = await db
    .insert(schema.organizations)
    .values({ name: 'Başka Kiracı', slug: `other-${Math.random().toString(16).slice(2, 10)}` })
    .returning()

  const orderValues = DATASET_ROWS.map((row) => ({
    organizationId: org.id,
    marketplaceAccountId: account.id,
    marketplace: 'Trendyol',
    packageId: row.packageId,
    orderNumber: row.orderNumber,
    customerFirstName: 'Ayşe',
    customerLastName: `Yılmaz${row.index % 7}`,
    shippingCity: row.city,
    marketplaceStatus: row.status,
    operationStatus: row.operation,
    totalAmount: row.totalAmount.toFixed(2),
    currency: 'TRY',
    orderDate: row.orderDate,
    firstSeenAt: new Date(row.orderDate.getTime() + 60_000),
  }))
  // Gürültü: diğer hesap ve diğer kiracı BUGÜN yüksek tutarlı satış yapar.
  for (let index = 0; index < 12; index += 1) {
    const orderDate = new Date(DATASET_NOW.getTime() - (index + 1) * 600_000)
    orderValues.push({
      organizationId: org.id,
      marketplaceAccountId: otherAccount.id,
      marketplace: 'Trendyol',
      packageId: `OTHER-ACC-${index}`,
      orderNumber: `OA-${index}`,
      marketplaceStatus: 'Created',
      operationStatus: 'NEW',
      totalAmount: '9999.00',
      currency: 'TRY',
      orderDate,
      firstSeenAt: orderDate,
    })
    orderValues.push({
      organizationId: otherOrg.id,
      marketplace: 'Trendyol',
      packageId: `OTHER-ORG-${index}`,
      orderNumber: `OO-${index}`,
      marketplaceStatus: 'Created',
      operationStatus: 'NEW',
      totalAmount: '7777.00',
      currency: 'TRY',
      orderDate,
      firstSeenAt: orderDate,
    })
  }
  const inserted = await db.insert(schema.orders).values(orderValues).returning()
  const byPackage = new Map(inserted.map((order) => [order.packageId, order]))
  const lineValues = []
  for (const row of DATASET_ROWS) {
    const order = byPackage.get(row.packageId)
    row.lines.forEach((line, position) => {
      lineValues.push({
        organizationId: org.id,
        orderId: order.id,
        externalLineId: `${row.packageId}-L${position}`,
        merchantSku: line.product.sku,
        barcode: line.product.barcode,
        productName: line.product.name,
        quantity: line.quantity,
        unitPrice: line.product.unitPrice.toFixed(2),
        lineTotal: (line.product.unitPrice * line.quantity).toFixed(2),
      })
    })
  }
  await db.insert(schema.orderLines).values(lineValues)
  return { org, account, otherAccount, otherOrg }
}

// ── Bağımsız kâhin ───────────────────────────────────────────────────────

function utcDay(year, month, day) {
  return Date.UTC(year, month, day)
}

/** Satış analitiği UTC rapor günüdür; "bugün" TSİ takvimine göre seçilir. */
export function expectedRange(key, now = DATASET_NOW, custom = {}) {
  const ist = new Date(now.getTime() + 3 * 3_600_000)
  const y = ist.getUTCFullYear()
  const m = ist.getUTCMonth()
  const d = ist.getUTCDate()
  const endOf = (startMs, days = 1) => startMs + days * DAY_MS - 1
  if (key === 'today') return [utcDay(y, m, d), endOf(utcDay(y, m, d))]
  if (key === 'yesterday') return [utcDay(y, m, d - 1), endOf(utcDay(y, m, d - 1))]
  if (key === 'last7') return [utcDay(y, m, d - 6), endOf(utcDay(y, m, d))]
  if (key === 'last30') return [utcDay(y, m, d - 29), endOf(utcDay(y, m, d))]
  if (key === 'month') return [utcDay(y, m, 1), endOf(utcDay(y, m, d))]
  const [sy, sm, sd] = custom.startDate.split('-').map(Number)
  const [ey, em, ed] = custom.endDate.split('-').map(Number)
  return [utcDay(sy, sm - 1, sd), endOf(utcDay(ey, em - 1, ed))]
}

export function expectedSales(key, custom) {
  const [start, end] = expectedRange(key, DATASET_NOW, custom)
  const inPeriod = DATASET_ROWS.filter((row) => {
    const time = row.orderDate.getTime()
    return time >= start && time <= end
  })
  const sum = (rows) => round2(rows.reduce((total, row) => total + row.totalAmount, 0))
  const sales = inPeriod.filter((row) => dispositionOf(row.status) === 'sale')
  const returns = inPeriod.filter((row) => dispositionOf(row.status) === 'return')
  const cancels = inPeriod.filter((row) => dispositionOf(row.status) === 'cancel')
  const products = new Map()
  for (const row of sales) {
    for (const line of row.lines) {
      products.set(line.product.barcode, (products.get(line.product.barcode) ?? 0) + line.quantity)
    }
  }
  const cities = new Map()
  for (const row of sales) cities.set(row.city, (cities.get(row.city) ?? 0) + 1)
  return {
    orderCount: sales.length,
    salesAmount: sum(sales),
    returnCount: returns.length,
    returnAmount: sum(returns),
    cancelCount: cancels.length,
    cancelAmount: sum(cancels),
    grossAmount: round2(sum(sales) + sum(returns) + sum(cancels)),
    averageOrderAmount: sales.length ? sum(sales) / sales.length : 0,
    productQuantities: products,
    cityCounts: cities,
  }
}

/** "Bugün gelen": TSİ takvim günü, statüden bağımsız TÜM paketler. */
export function expectedReceivedToday(now = DATASET_NOW) {
  const ist = new Date(now.getTime() + 3 * 3_600_000)
  const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 3 * 3_600_000
  const end = start + DAY_MS - 1
  return DATASET_ROWS.filter((row) => {
    const time = row.orderDate.getTime()
    return time >= start && time <= end
  }).length
}

/** Sunucu modelinden karşılaştırılabilir, TZ'den bağımsız olması gereken özet. */
export function summarizeViewModel(viewModel) {
  const summary = viewModel.salesSummary
  return {
    orderCount: summary.orderCount.value,
    salesAmount: round2(summary.salesAmount.value),
    returnCount: summary.returnCount.value,
    cancelCount: summary.cancelCount.value,
    grossAmount: round2(summary.grossAmount.value),
    receivedToday: viewModel.operationalSummary.receivedToday,
    cards: viewModel.salesPeriodCards.map((card) => [card.key, card.packageCount, round2(card.salesAmount)]),
    trend: round2(viewModel.salesChart.current.reduce((total, bucket) => total + bucket.amount, 0)),
  }
}
