import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Sadeleştirilmiş Siparişler sekmeleri: yalnız görünüm/navigasyon. Mevcut
// classifier'lar, sayaç hesapları ve filtre mantığı korunur.
test('sipariş sekmeleri sadeleştirme sözleşmesi', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { buildVisibleOrders, orderMatchesQuickTab } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const { resolveLegacyTab } = await vite.ssrLoadModule(
    '/src/utils/ordersTabs.ts',
  )

  // --- resolveLegacyTab: eski tab state'leri güvenli eşlenir ---
  const map = (tab) => resolveLegacyTab(tab)
  assert.deepEqual(map('currentSync'), { tab: 'newOrders', operationTab: 'all' })
  assert.deepEqual(map('today'), { tab: 'newOrders', operationTab: 'all' })
  assert.deepEqual(map('open'), { tab: 'newOrders', operationTab: 'all' })
  assert.deepEqual(map('barcodePending'), { tab: 'newOrders', operationTab: 'barcodePending' })
  assert.deepEqual(map('shipmentPending'), { tab: 'newOrders', operationTab: 'shipmentPending' })
  assert.deepEqual(map('suratVerificationPending'), { tab: 'newOrders', operationTab: 'suratVerificationPending' })
  assert.deepEqual(map('labelReady'), { tab: 'labelStage', operationTab: 'labelReady' })
  assert.deepEqual(map('labelPrinted'), { tab: 'labelStage', operationTab: 'labelPrinted' })
  assert.deepEqual(map('handedToCargo'), { tab: 'handedToCargo', operationTab: 'all' })
  assert.deepEqual(map('delivered'), { tab: 'delivered', operationTab: 'all' })
  assert.deepEqual(map('cancelReturn'), { tab: 'cancelReturn', operationTab: 'all' })
  assert.deepEqual(map('archive'), { tab: 'all', operationTab: 'archive' })
  assert.deepEqual(map('all'), { tab: 'all', operationTab: 'all' })
  assert.deepEqual(map(undefined), { tab: 'newOrders', operationTab: 'all' })

  // --- tab matcher'ları (mevcut bayrakların türevi) ---
  const cls = (over) => ({
    isOpenOperation: false,
    isLabelReady: false,
    isLabelPrinted: false,
    ...over,
  })
  // newOrders = açık && !labelReady && !labelPrinted
  assert.equal(orderMatchesQuickTab(cls({ isOpenOperation: true }), 'newOrders'), true)
  assert.equal(orderMatchesQuickTab(cls({ isOpenOperation: true, isLabelReady: true }), 'newOrders'), false)
  assert.equal(orderMatchesQuickTab(cls({ isOpenOperation: true, isLabelPrinted: true }), 'newOrders'), false)
  assert.equal(orderMatchesQuickTab(cls({ isOpenOperation: false }), 'newOrders'), false)
  // labelStage = labelReady || labelPrinted
  assert.equal(orderMatchesQuickTab(cls({ isLabelReady: true }), 'labelStage'), true)
  assert.equal(orderMatchesQuickTab(cls({ isLabelPrinted: true }), 'labelStage'), true)
  assert.equal(orderMatchesQuickTab(cls({}), 'labelStage'), false)

  // --- buildVisibleOrders entegrasyonu ---
  const baseFilters = {
    marketplaceFilter: 'all',
    operationStatusFilter: 'all',
    cargoFilter: 'all',
    dateFilter: { preset: 'all' },
    searchQuery: '',
  }
  const orderA = buildOrder({ id: 'a', packageId: 'PKG-A' }) // Created → newOrders (barkod bekliyor)
  const orderADup = buildOrder({ id: 'a2', packageId: 'PKG-A' }) // aynı paket → tekilleşir
  const orderLabel = buildLabelPrinted('c', 'PKG-C') // labelPrinted → labelStage
  const orderDelivered = buildOrder({
    id: 'd',
    packageId: 'PKG-D',
    marketplaceStatus: 'Delivered',
    status: 'Teslim Edildi',
  })
  const dataset = [orderA, orderADup, orderLabel, orderDelivered]
  const count = (over) =>
    buildVisibleOrders({ persistentOrders: dataset, ...baseFilters, ...over })
      .visibleOrders.length

  // Yeni Siparişler: aktif açık paketler, duplicate yok (PKG-A tek).
  assert.equal(count({ selectedTab: 'newOrders' }), 1)
  // Etiket Hazır: hazır + basılı (PKG-C).
  assert.equal(count({ selectedTab: 'labelStage' }), 1)
  // Tümü: distinct packageId (A, C, D) = 3, duplicate A elendi.
  assert.equal(count({ selectedTab: 'all' }), 3)
  // "İşlem Durumu" filtresi mevcut classifier'ı kullanır.
  assert.equal(count({ selectedTab: 'newOrders', operationTabFilter: 'barcodePending' }), 1)
  assert.equal(count({ selectedTab: 'newOrders', operationTabFilter: 'labelReady' }), 0)
  assert.equal(count({ selectedTab: 'all', operationTabFilter: 'archive' }), 0)
  // operationTabFilter='all' baseline'ı değiştirmez.
  assert.equal(count({ selectedTab: 'all', operationTabFilter: 'all' }), count({ selectedTab: 'all' }))
})

function buildOrder(options = {}) {
  return {
    id: options.id ?? 'order-ui',
    marketplace: 'Trendyol',
    externalOrderId: options.packageId ?? 'PKG-UI',
    orderNumber: options.orderNumber ?? `ORD-${options.id ?? 'ui'}`,
    packageId: options.packageId ?? 'PKG-UI',
    marketplaceStatus: options.marketplaceStatus ?? 'Created',
    operationStatus: options.operationStatus ?? 'NEW',
    source: 'real',
    status: options.status ?? 'Yeni',
    customerName: 'Müşteri',
    customerPhone: '5550000000',
    customerEmail: '',
    address: 'Adres',
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 100,
    createdAt: new Date('2026-07-10T10:00:00.000Z').toISOString(),
    orderDate: new Date('2026-07-10T10:00:00.000Z').toISOString(),
    items: [
      {
        id: `item-${options.id ?? 'ui'}`,
        productName: 'Ürün',
        sku: 'sku',
        barcode: `BARCODE-${options.id ?? 'ui'}`,
        quantity: 1,
        variantAttributes: [],
      },
    ],
    ...(options.extra ?? {}),
  }
}

function buildLabelPrinted(id, packageId) {
  return buildOrder({
    id,
    packageId,
    marketplaceStatus: 'Invoiced',
    operationStatus: 'LABELREADY',
    status: 'Etiket Basıldı',
    extra: {
      labelStatus: 'PRINTED',
      label: { printedAt: new Date('2026-07-11T10:00:00.000Z').toISOString() },
      shipment: {
        dispatchRegistrationConfirmed: true,
        barcodeRaw: '^XA^XZ',
        barcode: '012500001',
        barcodeValue: '012500001',
        finalSuratBarcode: '012500001',
        trackingNumber: '99887766',
      },
    },
  })
}
