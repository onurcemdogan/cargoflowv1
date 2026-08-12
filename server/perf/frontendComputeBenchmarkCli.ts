// CLI: FRONTEND HESAPLAMA MALİYETİ — SAF FONKSİYON ÖLÇÜMÜ, DB YOK, AĞ YOK.
//
//   npm run perf:frontend:bench
//   npm run perf:frontend:bench -- --scales 1000,10000,50000
//
// Orders ekranı ve Dashboard, sunucudan gelen TÜM sipariş dizisi üzerinde
// istemci tarafında filtreleme/sayaç/sıralama yapar. Bu ölçüm o işin tek
// render'daki maliyetini gösterir (React render + DOM maliyeti HARİÇ; yani
// gerçek gecikme buradan DAHA YÜKSEKTİR).
//
// SALT OKUNUR: DB'ye bağlanmaz, ağa çıkmaz, dosya yazmaz.

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = process.argv[index + 1]
  if (index >= 0 && value && !value.startsWith('--')) return value
  return undefined
}

function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

// OrdersPage'deki hızlı sekme sayısı (tabCounts her biri için TAM tarama yapar).
const QUICK_TABS = [
  'newOrders',
  'labelStage',
  'handedToCargo',
  'delivered',
  'cancelReturn',
  'all',
] as const

const STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
]

function buildOrders(count: number): Record<string, unknown>[] {
  const baseMs = Date.UTC(2026, 0, 1, 9, 0, 0)
  const orders: Record<string, unknown>[] = []
  for (let seq = 0; seq < count; seq += 1) {
    orders.push({
      id: `order-${seq}`,
      marketplace: 'Trendyol',
      packageId: `PKG${1_000_000_000 + seq}`,
      shipmentPackageId: `PKG${1_000_000_000 + seq}`,
      externalOrderId: `PKG${1_000_000_000 + seq}`,
      orderNumber: `114${10_000_000 + seq}`,
      customerName: `Ad${seq % 500} Soyad${seq % 500}`,
      customerFirstName: `Ad${seq % 500}`,
      customerLastName: `Soyad${seq % 500}`,
      marketplaceStatus: STATUSES[seq % STATUSES.length],
      operationStatus:
        seq % 4 === 0 ? 'LABEL_PRINTED' : seq % 4 === 1 ? 'LABEL_READY' : 'NEW',
      status: 'Yeni',
      city: 'Istanbul',
      district: 'Kadikoy',
      address: 'Ornek Mah. Ornek Cad. No 1',
      totalAmount: 100 + (seq % 900),
      currency: 'TRY',
      orderDate: new Date(baseMs + (seq % 86_400) * 1000).toISOString(),
      createdAt: new Date(baseMs + (seq % 86_400) * 1000).toISOString(),
      items: [
        {
          id: `line-${seq}-0`,
          productName: `Ornek Urun ${seq % 5000}`,
          barcode: `869${1_000_000 + (seq % 5000)}`,
          merchantSku: `SKU${seq % 5000}`,
          quantity: 1,
          unitPrice: 100,
        },
      ],
      source: 'real_api',
    })
  }
  return orders
}

async function main(): Promise<void> {
  const scales = (parseArg('scales') ?? '1000,10000,50000')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  const repeats = Number(parseArg('repeats') ?? 5)

  // `src/` modülleri bundler çözümlemesi (uzantısız import) kullanır; Node
  // için kanca kaydedilir. Ürün kodu DEĞİŞMEZ.
  const { register } = await import('node:module')
  register('./bundlerStyleResolver.mjs', import.meta.url)

  const { buildVisibleOrders } = await import(
    '../../src/utils/orderClassification.ts'
  )
  const { buildDashboardViewModel } = await import(
    '../../src/dashboard/dashboardViewModel.ts'
  )

  const results: Record<string, unknown>[] = []
  for (const scale of scales) {
    const orders = buildOrders(scale) as never[]
    const filterInput = {
      persistentOrders: orders,
      selectedTab: 'all' as const,
      marketplaceFilter: 'all' as const,
      operationStatusFilter: 'all' as const,
      cargoFilter: 'all' as const,
      // OrdersPage her zaman bir tarih filtresi geçirir (varsayılan "tümü").
      dateFilter: {
        preset: 'all' as const,
        startTime: undefined,
        endTime: undefined,
        timezone: 'Europe/Istanbul',
      },
      searchQuery: '',
    }

    // 1) TEK görünür liste hesabı.
    const singleSamples: number[] = []
    for (let run = 0; run < repeats; run += 1) {
      const start = now()
      buildVisibleOrders(filterInput as never)
      singleSamples.push(now() - start)
    }

    // 2) OrdersPage'in GERÇEK render maliyeti: görünür liste + 6 sekme sayacı.
    const renderSamples: number[] = []
    for (let run = 0; run < repeats; run += 1) {
      const start = now()
      buildVisibleOrders(filterInput as never)
      for (const tab of QUICK_TABS) {
        buildVisibleOrders({ ...filterInput, selectedTab: tab } as never)
      }
      renderSamples.push(now() - start)
    }

    // 3) Dashboard view-model (operasyon listesi + satış analitiği aynı kütle).
    const dashboardSamples: number[] = []
    for (let run = 0; run < repeats; run += 1) {
      const start = now()
      buildDashboardViewModel({
        orders,
        analyticsOrders: orders,
        products: [],
        selectedPeriod: { key: 'today', startDate: '', endDate: '' },
      } as never)
      dashboardSamples.push(now() - start)
    }

    const summarize = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right)
      return {
        p50: round(sorted[Math.floor(sorted.length / 2)]),
        p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
        max: round(sorted[sorted.length - 1]),
      }
    }

    results.push({
      scale,
      buildVisibleOrdersSingleMs: summarize(singleSamples),
      ordersPageRenderMs: summarize(renderSamples),
      ordersPageFullScans: QUICK_TABS.length + 1,
      dashboardViewModelMs: summarize(dashboardSamples),
    })
  }

  console.log(
    JSON.stringify(
      {
        mode: 'pure_function_read_only',
        note:
          'React render ve DOM maliyeti HARİÇTİR; gerçek kullanıcı gecikmesi ' +
          'bu değerlerden DAHA YÜKSEKTİR. Bu iş ana iş parçacığında yapılır, ' +
          'yani bu süre boyunca arayüz DONAR.',
        results,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error('frontend benchmark başarısız:', (error as Error).message)
  process.exitCode = 1
})
