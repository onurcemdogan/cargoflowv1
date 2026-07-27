import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// FAZ 2 — Operation Flow sayaçları canonical operasyon aşamasından türetilir.
// Tek helper (classifyDashboardOperationStage / resolveDashboardOperationStage)
// hem "Son Operasyonlar" statüsünü hem Operation Flow sayaçlarını besler.
// Kurallar: LABEL_PRINTED asla "Açık Operasyon" sayılmaz; LABEL_READY asla
// "Açık Operasyon"/"Barkod Bekliyor" sayılmaz; "Arşiv" sunumu ve pazaryeri
// ara durumu ("Hazırlanıyor") canonical operationStatus'ü EZMEZ; sayım
// order.label.printedAt gibi geçici tarayıcı metadata'sına bağlı DEĞİLDİR.

async function withVite(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  return vite
}

function baseOrder(overrides = {}) {
  const suffix = overrides.id || 'x'
  return {
    id: `order-${suffix}`,
    marketplace: 'Trendyol',
    orderNumber: `114${suffix}`,
    packageId: `PKG-${suffix}`,
    shipmentPackageId: `PKG-${suffix}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    status: 'Yeni',
    customerName: 'Test Müşteri',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoProviderName: 'Sürat Kargo',
    cargoTrackingNumber: `727${suffix}`,
    totalAmount: 100,
    createdAt: '2026-07-19T10:00:00',
    orderDate: '2026-07-19T10:00:00',
    desi: 2,
    items: [{ id: `i-${suffix}`, productName: 'Ürün', quantity: 1, price: 100 }],
    ...overrides,
  }
}

// LABEL_PRINTED canonical fixture — persistlenmiş print metadata OLMADAN
// (DB reload sonrası gerçek shape: order.label.printedAt yok).
function printedOrder(overrides = {}) {
  return baseOrder({
    id: overrides.id || 'printed',
    marketplaceStatus: 'Hazırlanıyor',
    operationStatus: 'LABEL_PRINTED',
    status: 'Etiket Basıldı',
    labelStatus: 'PRINTED',
    hasPrintableLabel: true,
    shipment: {
      ozelKargoTakipNo: `727${overrides.id || 'printed'}`,
      hasPrintableLabel: true,
      barcodeRaw: '^XA^FD0123^FS^XZ',
    },
    ...overrides,
  })
}

test('FAZ2-A: LABEL_PRINTED → stage labelPrinted / "Etiket Basıldı"', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const result = classifyDashboardOperationStage(printedOrder())
  assert.equal(result.stage, 'labelPrinted')
  assert.equal(result.label, 'Etiket Basıldı')
})

test('FAZ2-B: LABEL_READY → stage labelReady; asla open/barcodeWaiting değil', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const order = baseOrder({
    id: 'ready',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  })
  const result = classifyDashboardOperationStage(order)
  assert.equal(result.stage, 'labelReady')
  assert.equal(result.label, 'Etiket Hazır')
  assert.notEqual(result.stage, 'open')
  assert.notEqual(result.stage, 'barcodeWaiting')
})

test('FAZ2-C: barkod bekleyen sipariş (shipment yok) → stage barcodeWaiting', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const order = baseOrder({ id: 'barcode', operationStatus: 'NEW' })
  const result = classifyDashboardOperationStage(order)
  assert.equal(result.stage, 'barcodeWaiting')
  assert.equal(result.label, 'Barkod Bekliyor')
})

test('FAZ2-D: HANDED_TO_CARGO/Shipped → handedToCargo; Delivered → delivered', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const handed = classifyDashboardOperationStage(
    baseOrder({
      id: 'handed',
      marketplaceStatus: 'Shipped',
      operationStatus: 'HANDED_TO_CARGO',
    }),
  )
  assert.equal(handed.stage, 'handedToCargo')
  assert.equal(handed.label, 'Kargoya Verildi')
  const delivered = classifyDashboardOperationStage(
    baseOrder({
      id: 'delivered',
      marketplaceStatus: 'Delivered',
      operationStatus: 'DELIVERED',
    }),
  )
  assert.equal(delivered.stage, 'delivered')
  assert.equal(delivered.label, 'Teslim Edildi')
})

test('FAZ2-E: "Arşiv" işareti canonical LABEL_PRINTED durumunu EZMEZ', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const archivedPrinted = printedOrder({ id: 'arch', archived: true })
  const result = classifyDashboardOperationStage(archivedPrinted)
  assert.equal(result.stage, 'labelPrinted')
  assert.equal(result.label, 'Etiket Basıldı')
})

test('FAZ2-F: marketplaceStatus "Hazırlanıyor" LABEL_PRINTED durumunu EZMEZ', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const result = classifyDashboardOperationStage(
    printedOrder({ id: 'hazir', marketplaceStatus: 'Hazırlanıyor' }),
  )
  assert.equal(result.stage, 'labelPrinted')
})

test('FAZ2-G: operationalSummary — LABEL_PRINTED sipariş labelPrinted=1, open=0 (desi=null, printedAt yok)', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const model = buildDashboardViewModel({
    orders: [printedOrder({ id: 'p1', desi: null })],
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })
  assert.equal(model.operationalSummary.labelPrinted, 1)
  assert.equal(model.operationalSummary.openOperations, 0)
  assert.equal(model.operationalSummary.barcodeWaiting, 0)
})

test('FAZ2-H: labelPrinted sayımı order.label.printedAt gerektirmez', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  // printedAt olan ve OLMAYAN iki LABEL_PRINTED sipariş → ikisi de sayılır.
  const withPrintedAt = printedOrder({
    id: 'wp',
    label: { id: 'l', printedAt: '2026-07-19T11:00:00', printCount: 1 },
  })
  const withoutPrintedAt = printedOrder({ id: 'np' })
  const model = buildDashboardViewModel({
    orders: [withPrintedAt, withoutPrintedAt],
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })
  assert.equal(model.operationalSummary.labelPrinted, 2)
  assert.equal(model.operationalSummary.openOperations, 0)
})

test('FAZ2-I: recentOperations statüsü ve operationFlow sayaçları AYNI helper ile tutarlıdır', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const model = buildDashboardViewModel({
    orders: [printedOrder({ id: 'consistency', desi: null })],
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })
  // recentOperations statüsü = canonical aşama etiketi.
  assert.equal(model.recentOperations[0].status, 'Etiket Basıldı')
  // Operation Flow: printed 1, open 0 — recentOperations ile mutabık.
  const printedStep = model.operationFlow.find((s) => s.key === 'printed')
  const openStep = model.operationFlow.find((s) => s.key === 'open')
  assert.equal(printedStep.count, 1)
  assert.equal(openStep.count, 0)
})

test('FAZ2-J: "Açık Operasyon" dönem filtresinden bağımsızdır ve LABEL_READY/PRINTED hariç aktifleri kapsar', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const oldBarcode = baseOrder({
    id: 'old',
    operationStatus: 'NEW',
    createdAt: '2026-07-10T10:00:00',
    orderDate: '2026-07-10T10:00:00',
  })
  const ready = baseOrder({
    id: 'rdy',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
  })
  const printed = printedOrder({ id: 'prn' })
  const model = buildDashboardViewModel({
    orders: [oldBarcode, ready, printed],
    selectedPeriod: { key: 'today' },
    now: new Date('2026-07-19T12:00:00'),
  })
  // Dönem dışı (10 Tem) barkod bekleyen sipariş yine "Açık Operasyon" sayılır.
  assert.equal(model.operationalSummary.openOperations, 1)
  assert.equal(model.operationalSummary.barcodeWaiting, 1)
  // LABEL_READY ve LABEL_PRINTED açık operasyona sızmaz.
  assert.equal(model.operationalSummary.labelReady, 1)
  assert.equal(model.operationalSummary.labelPrinted, 1)
})

test('FAZ2-REAL: gerçek canlı shape — LABEL_PRINTED/Hazırlanıyor/desi=null → Etiket Basıldı, labelPrinted=1, open=0, refresh başarılı', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  // Spesifikasyondaki gerçek shape:
  const order = {
    id: 'order-real',
    marketplace: 'Trendyol',
    orderNumber: '11400000999',
    packageId: 'PKG-real',
    shipmentPackageId: 'PKG-real',
    orderNumber_display: '114...',
    cargoTrackingNumber: '7270000000999',
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Hazırlanıyor',
    status: 'Etiket Basıldı',
    labelStatus: 'PRINTED',
    hasPrintableLabel: true,
    customerName: 'Test',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoProviderName: 'Sürat Kargo',
    totalAmount: 100,
    createdAt: '2026-07-19T10:00:00',
    orderDate: '2026-07-19T10:00:00',
    desi: null,
    items: [{ id: 'ir', productName: 'Ürün', quantity: 1, price: 100 }],
    shipment: { ozelKargoTakipNo: '7270000000999', hasPrintableLabel: true },
  }
  const stage = classifyDashboardOperationStage(order)
  assert.equal(stage.stage, 'labelPrinted')
  assert.equal(stage.label, 'Etiket Basıldı')

  let model
  assert.doesNotThrow(() => {
    model = buildDashboardViewModel({
      orders: [order],
      selectedPeriod: { key: 'today' },
      now: new Date('2026-07-19T12:00:00'),
    })
  })
  assert.equal(model.recentOperations[0].status, 'Etiket Basıldı')
  assert.equal(
    model.operationFlow.find((s) => s.key === 'printed').count,
    1,
  )
  assert.equal(model.operationFlow.find((s) => s.key === 'open').count, 0)
  assert.equal(model.operationalSummary.labelPrinted, 1)
  assert.equal(model.operationalSummary.openOperations, 0)
})
