import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Eski (historical) sipariş sınıflandırması.
// Kök neden: güçlü kapanış/etiket sinyali OLMAYAN eski siparişler, pazaryeri
// status'ü forward değilse aktif "Barkod Bekliyor"/"Yeni Siparişler" kuyruğuna
// düşüyordu. Düzeltme: isHistoricalOrder (yaş + güçlü sinyal yokluğu) → pasif
// Arşiv sunumu; SAHTE "Kargoya Verildi/Teslim" ATANMAZ. Yeni siparişler ve
// LABEL_READY/LABEL_PRINTED/reprint akışları KORUNUR.

const NOW = new Date('2026-07-28T12:00:00Z')
const OLD = '2026-01-01T00:00:00Z' // ~208 gün → eşik (60g) üstü
const RECENT = '2026-07-25T00:00:00Z' // 3 gün → eşik altı

async function withVite(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  return vite
}

function baseOrder(over = {}) {
  const id = over.id || 'x'
  return {
    id: `order-${id}`,
    marketplace: 'Trendyol',
    orderNumber: `114${id}`,
    packageId: `PKG-${id}`,
    shipmentPackageId: `PKG-${id}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    status: 'Yeni',
    customerName: 'Test',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoProviderName: 'Sürat Kargo',
    totalAmount: 100,
    createdAt: over.orderDate || OLD,
    orderDate: over.orderDate || OLD,
    desi: 2,
    items: [{ id: `i-${id}`, productName: 'Ürün', quantity: 1, price: 100 }],
    ...over,
  }
}

async function loadClassifier(vite) {
  return vite.ssrLoadModule('/src/utils/orderClassification.ts')
}

test('HST-1: eski + marketplaceStatus=Delivered → DELIVERED (Barkod Bekliyor değil)', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await loadClassifier(vite)
  const order = baseOrder({ id: 'd', marketplaceStatus: 'Delivered' })
  assert.equal(classifyCanonicalOrderStatus(order, NOW).stage, 'delivered')
  assert.equal(classifyCanonicalOrderStatus(order, NOW).label, 'Teslim Edildi')
  assert.equal(classifyOrderForTabs(order, NOW).isBarcodeWaiting, false)
  assert.equal(classifyOrderForTabs(order, NOW).isHistorical, false)
})

test('HST-2: eski + shipment.shippedAt → HANDED_TO_CARGO (güçlü kanıt)', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus } = await loadClassifier(vite)
  const order = baseOrder({
    id: 's',
    shipment: { shippedAt: '2026-01-03T09:00:00Z' },
  })
  assert.equal(classifyCanonicalOrderStatus(order, NOW).stage, 'handedToCargo')
  assert.equal(
    classifyCanonicalOrderStatus(order, NOW).label,
    'Kargoya Verildi',
  )
})

test('HST-3: eski + canonical operationStatus=SHIPPED (persisted lifecycle) → Kargoya Verildi', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus } = await loadClassifier(vite)
  const order = baseOrder({ id: 'l', operationStatus: 'SHIPPED' })
  assert.equal(classifyCanonicalOrderStatus(order, NOW).stage, 'handedToCargo')
})

test('HST-4: eski + Cancelled → İptal / İade', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus } = await loadClassifier(vite)
  const order = baseOrder({ id: 'c', marketplaceStatus: 'Cancelled' })
  assert.equal(
    classifyCanonicalOrderStatus(order, NOW).stage,
    'canceledOrReturned',
  )
  assert.equal(classifyCanonicalOrderStatus(order, NOW).label, 'İptal / İade')
})

test('HST-5: eski + LABEL_PRINTED → Etiket Basıldı (Barkod Bekliyor değil, historical değil)', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await loadClassifier(vite)
  const order = baseOrder({
    id: 'p',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    hasPrintableLabel: true,
    shipment: { barcodeRaw: '^XA^FD01^FS^XZ', hasPrintableLabel: true },
  })
  assert.equal(classifyCanonicalOrderStatus(order, NOW).stage, 'labelPrinted')
  assert.equal(classifyOrderForTabs(order, NOW).isHistorical, false)
  assert.equal(classifyOrderForTabs(order, NOW).isBarcodeWaiting, false)
})

test('HST-6: eski + hiçbir güçlü sinyal yok → Arşiv/historical; aktif barkod kuyruğunda değil', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await loadClassifier(vite)
  const order = baseOrder({ id: 'h', operationStatus: 'BARCODE_WAITING' })
  const canonical = classifyCanonicalOrderStatus(order, NOW)
  assert.equal(canonical.stage, 'archived')
  assert.equal(canonical.label, 'Arşiv')
  assert.equal(canonical.isHistorical, true)
  const state = classifyOrderForTabs(order, NOW)
  assert.equal(state.isHistorical, true)
  assert.equal(state.isBarcodeWaiting, false)
  assert.equal(state.isOpenOperation, false)
})

test('HST-7: YENİ + Created + etiket yok → Barkod Bekliyor korunur (historical değil)', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await loadClassifier(vite)
  const order = baseOrder({
    id: 'n',
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    orderDate: RECENT,
  })
  assert.equal(classifyOrderForTabs(order, NOW).isHistorical, false)
  assert.equal(classifyOrderForTabs(order, NOW).isBarcodeWaiting, true)
  assert.equal(classifyCanonicalOrderStatus(order, NOW).stage, 'barcodeWaiting')
})

test('HST-8: yalnız 727 referansı (eski, sinyalsiz) → Kargoya Verildi SAYILMAZ', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus, classifyOrderForTabs } =
    await loadClassifier(vite)
  // Yalnız cargoTrackingNumber (727) + packageId + kargo firma adı: güçlü kanıt DEĞİL.
  const order = baseOrder({
    id: '727',
    cargoTrackingNumber: '7270034994447844',
    operationStatus: 'BARCODE_WAITING',
  })
  const state = classifyOrderForTabs(order, NOW)
  assert.equal(state.isHandedToCargo, false)
  assert.equal(state.isDelivered, false)
  // Güçlü kanıt olmadığından pasif Arşiv'e düşer (aktif kuyruğa değil).
  assert.equal(classifyCanonicalOrderStatus(order, NOW).stage, 'archived')
})

test('HST-9: sınıflandırma saf/per-order — tenant A ve tenant B siparişleri birbirini etkilemez', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus } = await loadClassifier(vite)
  const tenantAHistorical = baseOrder({
    id: 'A',
    operationStatus: 'BARCODE_WAITING',
  })
  const tenantBRecentBarcode = baseOrder({
    id: 'B',
    operationStatus: 'NEW',
    orderDate: RECENT,
  })
  // Sıra/karışım fark etmez: her sipariş yalnız kendi alanlarından sınıflanır.
  assert.equal(
    classifyCanonicalOrderStatus(tenantAHistorical, NOW).stage,
    'archived',
  )
  assert.equal(
    classifyCanonicalOrderStatus(tenantBRecentBarcode, NOW).stage,
    'barcodeWaiting',
  )
  // Ters sırada tekrar → aynı sonuç (paylaşılan state yok).
  assert.equal(
    classifyCanonicalOrderStatus(tenantBRecentBarcode, NOW).stage,
    'barcodeWaiting',
  )
  assert.equal(
    classifyCanonicalOrderStatus(tenantAHistorical, NOW).stage,
    'archived',
  )
})

test('HST-10: aynı sipariş — tablo rozeti, Dashboard aşaması ve canonical statü AYNI (Arşiv)', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus, classifyDashboardOperationStage } =
    await loadClassifier(vite)
  const { mapOperationStatus } = await vite.ssrLoadModule(
    '/src/utils/statusPresentation.ts',
  )
  const order = baseOrder({ id: 'same', operationStatus: 'BARCODE_WAITING' })
  // Tablo rozeti (mapOperationStatus) — çok eski tarih olduğundan gerçek-zaman
  // now ile de historical'dır.
  assert.equal(mapOperationStatus(order).label, 'Arşiv')
  assert.equal(classifyDashboardOperationStage(order, NOW).label, 'Arşiv')
  assert.equal(classifyCanonicalOrderStatus(order, NOW).label, 'Arşiv')
})

test('HST-11: Dashboard sayaçları — historical aktif operasyon sayısına girmez', async (t) => {
  const vite = await withVite(t)
  const { buildDashboardViewModel } = await vite.ssrLoadModule(
    '/src/dashboard/dashboardViewModel.ts',
  )
  const historical = baseOrder({ id: 'old', operationStatus: 'BARCODE_WAITING' })
  const recentBarcode = baseOrder({
    id: 'new',
    operationStatus: 'NEW',
    orderDate: RECENT,
  })
  const model = buildDashboardViewModel({
    orders: [historical, recentBarcode],
    selectedPeriod: { key: 'today' },
    now: NOW,
  })
  // Yalnız yakın tarihli aktif sipariş sayılır; historical Açık/Barkod dışında.
  assert.equal(model.operationalSummary.openOperations, 1)
  assert.equal(model.operationalSummary.barcodeWaiting, 1)
})

test('HST-12: YENİ LABEL_READY/LABEL_PRINTED akışı değişmeden geçer', async (t) => {
  const vite = await withVite(t)
  const { classifyCanonicalOrderStatus } = await loadClassifier(vite)
  const ready = baseOrder({
    id: 'r',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    orderDate: RECENT,
    hasPrintableLabel: true,
    shipment: { barcodeRaw: '^XA^FD01^FS^XZ', hasPrintableLabel: true },
  })
  const printed = baseOrder({
    id: 'pr',
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
    orderDate: RECENT,
    hasPrintableLabel: true,
    shipment: { barcodeRaw: '^XA^FD01^FS^XZ', hasPrintableLabel: true },
  })
  assert.equal(classifyCanonicalOrderStatus(ready, NOW).stage, 'labelReady')
  assert.equal(classifyCanonicalOrderStatus(printed, NOW).stage, 'labelPrinted')
})
