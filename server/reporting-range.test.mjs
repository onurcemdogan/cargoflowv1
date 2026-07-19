import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'

// Satış raporlama günü UTC mutabakatı (Durusoft): saf helper makine
// timezone'undan bağımsızdır; yalnız SATIŞ analitiği bucket'ları değişir,
// operasyon sayaçları yerel gün semantiğini korur.
test('UTC raporlama günü: sınırlar, TZ bağımsızlığı ve satış/operasyon ayrımı', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { resolveReportingRange, resolveReportingComparisonRange } =
    await vite.ssrLoadModule('/src/dashboard/reportingRange.ts')
  const { buildDashboardSalesPeriodCards, buildDashboardViewModel } =
    await vite.ssrLoadModule('/src/dashboard/dashboardViewModel.ts')

  // Referans an: 19.07.2026 12:00 UTC.
  const now = new Date('2026-07-19T12:00:00.000Z')
  const today = resolveReportingRange('today', now, 'UTC')
  const yesterday = resolveReportingRange('yesterday', now, 'UTC')
  assert.equal(today.start.toISOString(), '2026-07-19T00:00:00.000Z')
  assert.equal(today.end.toISOString(), '2026-07-19T23:59:59.999Z')
  assert.equal(yesterday.start.toISOString(), '2026-07-18T00:00:00.000Z')
  assert.equal(yesterday.end.toISOString(), '2026-07-18T23:59:59.999Z')

  // A) 19.07 02:00 TSİ = 18.07 23:00 UTC → UTC DÜN.
  const nightOrderTs = new Date('2026-07-18T23:00:00.000Z').getTime()
  assert.equal(
    nightOrderTs >= yesterday.start.getTime() &&
      nightOrderTs <= yesterday.end.getTime(),
    true,
  )
  assert.equal(nightOrderTs >= today.start.getTime(), false)

  // B) 19.07 03:00 TSİ = 19.07 00:00 UTC → UTC BUGÜN.
  const morningTs = new Date('2026-07-19T00:00:00.000Z').getTime()
  assert.equal(
    morningTs >= today.start.getTime() && morningTs <= today.end.getTime(),
    true,
  )

  // Europe/Istanbul modu (ileride kullanım için) test edilebilir durumda.
  const istToday = resolveReportingRange('today', now, 'Europe/Istanbul')
  assert.equal(istToday.start.toISOString(), '2026-07-18T21:00:00.000Z')
  assert.equal(istToday.end.toISOString(), '2026-07-19T20:59:59.999Z')

  // Ay dönemleri ve karşılaştırmalar UTC takvimine göre.
  const thisMonth = resolveReportingRange('thisMonth', now, 'UTC')
  assert.equal(thisMonth.start.toISOString(), '2026-07-01T00:00:00.000Z')
  const lastMonth = resolveReportingRange('lastMonth', now, 'UTC')
  assert.equal(lastMonth.start.toISOString(), '2026-06-01T00:00:00.000Z')
  assert.equal(lastMonth.end.toISOString(), '2026-06-30T23:59:59.999Z')
  const todayComparison = resolveReportingComparisonRange(
    'today',
    today,
    now,
    'UTC',
  )
  assert.equal(todayComparison.start.toISOString(), '2026-07-18T00:00:00.000Z')

  // C) Makine timezone BAĞIMSIZLIĞI: aynı hesap farklı TZ ortamlarında
  //    birebir aynı UTC anlarını üretmeli (child process TZ=America/New_York
  //    ve TZ=Pacific/Auckland ile çalıştırılır).
  const childScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'reporting-range-child.mjs',
  )
  for (const tz of ['America/New_York', 'Pacific/Auckland', 'UTC']) {
    const child = spawnSync(process.execPath, [childScript], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf-8',
      timeout: 120_000,
    })
    assert.equal(child.status, 0, `${tz}: ${child.stderr}`)
    const parsed = JSON.parse(child.stdout.trim().split('\n').at(-1))
    assert.equal(parsed.todayStart, '2026-07-19T00:00:00.000Z', tz)
    assert.equal(parsed.yesterdayStart, '2026-07-18T00:00:00.000Z', tz)
    assert.equal(parsed.istTodayStart, '2026-07-18T21:00:00.000Z', tz)
  }

  // D/E benzeri sınıflandırma (sipariş bazlı; tutarlar sabitlenmeden):
  // 19.07 02:00 TSİ iptali ve 00:14-02:16 TSİ satışları UTC-DÜN kartına,
  // 03:07 TSİ satışı UTC-BUGÜN kartına düşer.
  const order = (id, iso, amount, status = 'Picking') => ({
    id,
    marketplace: 'Trendyol',
    externalOrderId: id,
    orderNumber: id,
    packageId: `PKG-${id}`,
    customerName: 'A',
    customerPhone: '',
    customerEmail: '',
    address: 'x',
    city: 'İstanbul',
    district: 'Fatih',
    marketplaceStatus: status,
    operationStatus: 'READY_TO_SHIP',
    source: 'real',
    status: 'Yeni',
    totalAmount: amount,
    createdAt: iso,
    orderDate: iso,
    items: [
      { id: `${id}-L1`, productName: 'Ürün', sku: 's', barcode: 'b', quantity: 1 },
    ],
  })
  const fixtures = [
    // Kanıtlanan canlı örneklerin zaman damgaları:
    order('11427115120', '2026-07-18T23:00:00.000Z', 808.68, 'Cancelled'),
    order('11426827170', '2026-07-18T21:14:00.000Z', 939),
    order('11427144536', '2026-07-18T23:12:00.000Z', 2018.01),
    order('11427152914', '2026-07-18T23:16:00.000Z', 826.25),
    order('11427277322', '2026-07-19T00:07:00.000Z', 826.25),
    // 18.07 TSİ 00:05 = 17.07 21:05 UTC → UTC ÖNCEKİ güne düşer.
    order('11424011318', '2026-07-17T21:05:00.000Z', 889.05),
  ]
  const cards = buildDashboardSalesPeriodCards(fixtures, now)
  const todayCard = cards.find((card) => card.key === 'today')
  const yesterdayCard = cards.find((card) => card.key === 'yesterday')
  assert.equal(todayCard.packageCount, 1)
  assert.equal(todayCard.salesAmount, 826.25)
  assert.equal(todayCard.cancelPackageCount, 0)
  assert.equal(yesterdayCard.packageCount, 3)
  assert.equal(
    Math.round(yesterdayCard.salesAmount * 100) / 100,
    Math.round((939 + 2018.01 + 826.25) * 100) / 100,
  )
  assert.equal(yesterdayCard.cancelPackageCount, 1)
  assert.equal(yesterdayCard.returnCancellationAmount, 808.68)

  // F) Operasyon sayaçları YEREL dönem semantiğini korur: viewModel'in
  //    operationalSummary'si satış bucket'ından bağımsızdır (anlık sayımlar
  //    dönem kaydırmasından etkilenmez).
  const viewModel = buildDashboardViewModel({
    orders: fixtures,
    selectedPeriod: { key: 'today' },
    now,
  })
  assert.equal(viewModel.operationalSummary.openOperations, 5)
  assert.equal(viewModel.operationalSummary.errors, 0)
  // Satış özeti UTC-bugün ile aynı (tek satış).
  assert.equal(viewModel.salesSummary.orderCount.value, 1)
  assert.equal(viewModel.salesSummary.salesAmount.value, 826.25)
})
