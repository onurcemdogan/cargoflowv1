import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Canlı bulgu (19.07.2026, 11425963017): Trendyol senkronu sonrası panel
// shipment'sız göründü ve create butonu açıldı. Kök neden sınıfı: bayat bir
// in-memory kopyanın persist edilip storage'daki operasyonel shipment'ı
// ezebilmesi (merge fonksiyonunun kendisi korumalıdır — burada kanıtlanır).
// Bu test persist-katmanı reconcile'ını ve ikinci create guard'ını kilitler.
test('Marketplace senkronu operasyonel shipment state kaybetmez (A-G)', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { OrderWorkflowService, preserveOperationalStateFromStore } =
    await vite.ssrLoadModule('/src/services/orderWorkflowService.ts')
  const { canCreateShipment, canMarkPrinted } = await vite.ssrLoadModule(
    '/src/utils/orderStatus.ts',
  )
  const { resolveSuratPrintSource } = await vite.ssrLoadModule(
    '/src/utils/suratPrintEligibility.ts',
  )

  const storage = new Map()
  const previousWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  }
  t.after(() => {
    globalThis.window = previousWindow
  })

  const KEY = 'cargoFlow_orders_v3:277221'
  const shipmentFixture = (over = {}) => ({
    id: 'shp-1',
    provider: 'surat-kargo',
    trackingNumber: '11722641149218',
    tNo: '11722641149218',
    kargoTakipNo: '11722641149218',
    trackingUrl: '',
    shipmentCode: '4009094498',
    barcodeValue: '01250312435',
    barkodNo: '01250312435',
    barcode: '01250312435',
    finalSuratBarcode: '01250312435',
    candidateTNo: '11722641149218',
    candidateBarkodNo: '01250312435',
    ozelKargoTakipNo: '7270034562631323',
    barcodeRaw: '',
    zplSource: 'generated',
    printEnabled: true,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    labelStatus: 'READY',
    verifiedShipment: false,
    desi: 4,
    desiSource: 'product_lines',
    ...over,
  })
  const cachedFixture = (over = {}) => ({
    id: 'ty_order_4009094498',
    marketplace: 'Trendyol',
    externalOrderId: '4009094498',
    orderNumber: '11425963017',
    packageId: '4009094498',
    shipmentPackageId: '4009094498',
    customerName: 'Bahar KUT',
    customerPhone: '',
    customerEmail: '',
    address: 'Bahar Cad. Gül 1. Sok. No:6A',
    city: 'Diyarbakır',
    district: 'Ergani',
    cargoTrackingNumber: '7270034562631323',
    marketplaceStatus: 'Picking',
    operationStatus: 'LABEL_READY',
    source: 'real',
    status: 'Etiket Hazır',
    labelStatus: 'READY',
    totalAmount: 3880,
    createdAt: '2026-07-18T20:12:00.000Z',
    desi: 4,
    desiSource: 'product_lines',
    packageCount: 1,
    lastMarketplaceSyncedAt: '2026-07-19T05:00:00.000Z',
    lastMarketplaceSyncBatchId: '2026-07-19T05:00:00.000Z',
    items: [
      { id: 'L1', productName: 'Elbise Bordo', sku: 'S1', barcode: 'B1', quantity: 1 },
      { id: 'L2', productName: 'Elbise Siyah', sku: 'S2', barcode: 'B2', quantity: 1 },
    ],
    shipment: shipmentFixture(),
    ...over,
  })
  const freshFixture = (over = {}) => ({
    id: 'ty_order_4009094498',
    marketplace: 'Trendyol',
    externalOrderId: '4009094498',
    orderNumber: '11425963017',
    packageId: '4009094498',
    shipmentPackageId: '4009094498',
    customerName: 'Bahar KUT (güncel)',
    customerPhone: '',
    customerEmail: '',
    address: 'Bahar Cad. Gül 1. Sok. No:6A Daire 2',
    city: 'Diyarbakır',
    district: 'Ergani',
    cargoTrackingNumber: '7270034562631323',
    marketplaceStatus: 'Picking',
    operationStatus: 'READY_TO_SHIP',
    source: 'real',
    status: 'Yeni',
    totalAmount: 3880,
    createdAt: '2026-07-18T20:12:00.000Z',
    items: [
      { id: 'L1', productName: 'Elbise Bordo', sku: 'S1', barcode: 'B1', quantity: 1 },
      { id: 'L2', productName: 'Elbise Siyah', sku: 'S2', barcode: 'B2', quantity: 1 },
    ],
    ...over,
  })
  const config = {
    trendyol: {
      sellerId: '277221',
      apiKey: 'k',
      apiSecret: 's',
      environment: 'prod',
      userAgentName: '',
    },
    surat: {},
  }
  const audit = { append: () => [] }
  const buildWorkflow = (marketplace, shipping = {}) =>
    new OrderWorkflowService(marketplace, shipping, {}, {}, audit)

  // A) Trendyol'dan shipment'sız taze order gelir → mevcut persisted
  //    shipment senkron sonrasında da korunur (fetchOrders tam zinciri).
  const workflowA = buildWorkflow({
    fetchOrders: async () => ({
      orders: [freshFixture()],
      source: 'real',
      message: 'ok',
    }),
  })
  workflowA.setMarketplaceAccount('277221')
  storage.set(KEY, JSON.stringify([cachedFixture()]))
  const syncedA = await workflowA.fetchOrders(config, {})
  const orderA = syncedA.orders.find((o) => o.orderNumber === '11425963017')
  assert.ok(orderA.shipment, 'A: shipment senkronda kaybolmamalı')
  assert.equal(orderA.shipment.tNo, '11722641149218')
  assert.equal(orderA.shipment.barkodNo, '01250312435')
  assert.equal(orderA.shipment.ozelKargoTakipNo, '7270034562631323')

  // B) LABEL_READY_AWAITING_ACCEPTANCE senkron sonrası korunur;
  //    create pasif, print (canonical) aktif kalır.
  assert.equal(orderA.shipment.lifecycleStatus, 'LABEL_READY_AWAITING_ACCEPTANCE')
  assert.equal(orderA.status, 'Etiket Hazır')
  assert.equal(canCreateShipment(orderA), false)
  assert.equal(canMarkPrinted(orderA), true)

  // C) Legacy canonical shipment (BarcodeRaw boş) canonical_html olarak korunur.
  const sourceC = resolveSuratPrintSource(orderA)
  assert.equal(sourceC.source, 'canonical_html')
  assert.equal(sourceC.canPrint, true)
  assert.equal(sourceC.canDownloadZpl, false)

  // D) İki AYRI packageId: paket A'nın shipment'ı paket B'ye sızmaz.
  storage.clear()
  const workflowD = buildWorkflow({
    fetchOrders: async () => ({
      orders: [
        freshFixture(),
        freshFixture({
          id: 'ty_order_5000000001',
          externalOrderId: '5000000001',
          orderNumber: '11425963018',
          packageId: '5000000001',
          shipmentPackageId: '5000000001',
          cargoTrackingNumber: '7270034562639999',
        }),
      ],
      source: 'real',
      message: 'ok',
    }),
  })
  workflowD.setMarketplaceAccount('277221')
  storage.set(KEY, JSON.stringify([cachedFixture()]))
  const syncedD = await workflowD.fetchOrders(config, {})
  const otherD = syncedD.orders.find((o) => o.orderNumber === '11425963018')
  const sameD = syncedD.orders.find((o) => o.orderNumber === '11425963017')
  assert.ok(sameD.shipment, 'D: kendi paketi shipment korur')
  assert.equal(otherD.shipment, undefined, 'D: farklı pakete shipment sızmaz')

  // E) String/number packageId aynı paket sayılır ("4009094498" === 4009094498).
  storage.clear()
  const workflowE = buildWorkflow({
    fetchOrders: async () => ({
      orders: [freshFixture({ packageId: 4009094498, shipmentPackageId: 4009094498 })],
      source: 'real',
      message: 'ok',
    }),
  })
  workflowE.setMarketplaceAccount('277221')
  storage.set(KEY, JSON.stringify([cachedFixture()]))
  const syncedE = await workflowE.fetchOrders(config, {})
  const orderE = syncedE.orders.find((o) => o.orderNumber === '11425963017')
  assert.ok(orderE.shipment, 'E: tip farkı eşleşmeyi bozmamalı')
  assert.equal(orderE.shipment.tNo, '11722641149218')

  // F) Persist reconcile: bayat (shipment'sız) in-memory kopya persist
  //    edilse bile storage'daki shipment EZİLMEZ; ve ikinci guard —
  //    shipment'sız order ile createShipments yeni carrier çağrısı YAPMAZ.
  storage.clear()
  let carrierCreateCalls = 0
  const workflowF = buildWorkflow(
    {},
    {
      createShipment: async () => {
        carrierCreateCalls += 1
        throw new Error('bu test carrier create beklemiyor')
      },
    },
  )
  workflowF.setMarketplaceAccount('277221')
  storage.set(KEY, JSON.stringify([cachedFixture()]))
  const staleSnapshot = [freshFixture()] // shipment'sız bayat kopya
  workflowF.enrichOrderImages(staleSnapshot, [])
  const persistedF = JSON.parse(storage.get(KEY)).find(
    (o) => o.orderNumber === '11425963017',
  )
  assert.ok(
    persistedF.shipment,
    'F: bayat snapshot persist edilse bile storage shipment korur',
  )
  assert.equal(persistedF.shipment.tNo, '11722641149218')
  const createF = await workflowF.createShipments(
    staleSnapshot,
    ['ty_order_4009094498'],
    config,
  )
  assert.equal(carrierCreateCalls, 0, 'F: yeni SOAP create çağrısı yok')
  assert.match(
    createF.result.bulkActionDebug.skippedReasons.join(' '),
    /Önceki gönderi kaydı inceleniyor; yeni gönderi oluşturulamaz\./,
  )
  const orderF = createF.orders.find((o) => o.orderNumber === '11425963017')
  assert.ok(orderF.shipment, 'F: guard shipmenti listeye geri baglar')

  // G) Marketplace alanları güncellenir, operasyonel state korunur.
  assert.equal(orderA.customerName, 'Bahar KUT (güncel)')
  assert.match(orderA.address, /Daire 2/)
  assert.equal(orderA.items.length, 2)
  assert.equal(orderA.shipment.printEnabled, true)

  // preserveOperationalStateFromStore birim sözleşmesi: incoming kendi
  // shipment'ını taşıyorsa (daha yeni) aynen yazılır.
  const newerShipment = shipmentFixture({ id: 'shp-2', tNo: '99999999999999' })
  const preserved = preserveOperationalStateFromStore(
    [cachedFixture({ shipment: newerShipment })],
    [cachedFixture()],
  )
  assert.equal(preserved[0].shipment.id, 'shp-2')
})
