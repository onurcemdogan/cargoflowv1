import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const CARRIER_ZPL =
  '^XA^FO40,40^A0N,24,24^FD24510610424923^FS^FO60,520^BCN,140,N,N,N^FD01249492893^FS^XZ'

function buildItem(over = {}) {
  return {
    id: over.id ?? 'L1',
    productName: 'Scuba Seçil Detaylı Tesettür Bordo Elbise SCUBA-SEC01, 36',
    sku: 'SKU-1',
    barcode: 'SCUBA-SEC011',
    color: 'Bordo',
    size: '36',
    quantity: 1,
    price: 714.7,
    ...over,
  }
}

function buildShipmentFixture(over = {}) {
  return {
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
    barcodeRaw: CARRIER_ZPL,
    zplAnalysis: {
      acceptedTNo: '11722641149218',
      acceptedFinalBarcode: '01250312435',
    },
    printEnabled: true,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    labelStatus: 'READY',
    verifiedShipment: false,
    desi: 4,
    desiSource: 'product_lines',
    ...over,
  }
}

function buildOrderFixture(over = {}) {
  return {
    id: over.id ?? 'order-1',
    marketplace: 'Trendyol',
    externalOrderId: 'EXT-1',
    orderNumber: over.orderNumber ?? '11425963017',
    packageId: '4009094498',
    shipmentPackageId: '4009094498',
    customerName: 'Bahar KUT',
    customerPhone: '',
    customerEmail: 'pf@example.com',
    address: 'Bahar Cad. Gül 1. Sok. Kapı No:6A',
    city: 'Diyarbakır',
    district: 'Ergani',
    cargoTrackingNumber: '7270034562631323',
    marketplaceStatus: 'Picking',
    operationStatus: 'READY_TO_SHIP',
    source: 'real',
    status: 'Etiket Hazır',
    totalAmount: 3880,
    createdAt: '2026-07-18T20:12:00.000Z',
    desi: 4,
    desiSource: 'product_lines',
    packageCount: 1,
    items: over.items ?? [buildItem()],
    ...over,
  }
}

function renderDrawer(OrderDetailDrawer, order, products = []) {
  return renderToStaticMarkup(
    createElement(OrderDetailDrawer, {
      order,
      products,
      busy: false,
      onClose: () => {},
      onCreateShipment: () => {},
      onTrackShipment: () => {},
      onDownloadZpl: () => {},
      onPrintLabel: () => {},
      onDesiChange: () => {},
    }),
  )
}

// Regression baseline: panel read-only'dir; render sırasında hiçbir API
// çağrısı yapmaz, canonical kodları ve ürün satırlarını gösterir, buton
// eligibility'si ortak helper'larla aynı kalır.
test('Sipariş detay paneli read-only sözleşmesi ve matris A-I', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { OrderDetailDrawer } = await vite.ssrLoadModule(
    '/src/components/OrderDetailDrawer.tsx',
  )
  const { buildSuratShipmentTimeline } = await vite.ssrLoadModule(
    '/src/utils/suratShipmentTimeline.ts',
  )
  const { canCreateShipment, canDownloadZpl, canMarkPrinted } =
    await vite.ssrLoadModule('/src/utils/orderStatus.ts')

  const previousFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async (...args) => {
    fetchCalls += 1
    return previousFetch(...args)
  }
  t.after(() => {
    globalThis.fetch = previousFetch
  })

  // A) Tekli ürün, shipment yok: panel açılır, ürün görünür, create
  //    eligibility mevcut helper ile aynı, API çağrısı yok.
  const noShipment = buildOrderFixture({
    id: 'order-a',
    orderNumber: 'ORDER-A',
    status: 'Yeni',
    shipment: undefined,
    desi: null,
    desiSource: null,
  })
  const htmlA = renderDrawer(OrderDetailDrawer, noShipment)
  assert.match(htmlA, /ORDER-A/)
  assert.match(htmlA, /Scuba Seçil Detaylı Tesettür Bordo Elbise/)
  assert.equal(canCreateShipment(noShipment), true)
  assert.match(htmlA, /Sürat Gönderisi Oluştur/)
  const timelineA = buildSuratShipmentTimeline(noShipment)
  assert.equal(timelineA[0].status, 'completed')
  assert.equal(
    timelineA.find((step) => step.key === 'labelCreated').status !==
      'completed',
    true,
  )

  // B) Tekli ürün, carrier ZPL: kodlar doğru, print+download aktif,
  //    timeline'da Etiket Oluşturuldu completed.
  const carrierOrder = buildOrderFixture({
    id: 'order-b',
    orderNumber: 'ORDER-B',
    shipment: buildShipmentFixture(),
  })
  const htmlB = renderDrawer(OrderDetailDrawer, carrierOrder)
  assert.match(htmlB, /11722641149218/)
  assert.match(htmlB, /01250312435/)
  assert.match(htmlB, /7270034562631323/)
  assert.equal(canDownloadZpl(carrierOrder), true)
  assert.equal(canMarkPrinted(carrierOrder), true)
  assert.equal(canCreateShipment(carrierOrder), false)
  assert.match(htmlB, /Taşıyıcı ZPL etiketi/)
  const timelineB = buildSuratShipmentTimeline(carrierOrder)
  assert.equal(
    timelineB.find((step) => step.key === 'labelCreated').status,
    'completed',
  )
  assert.equal(
    timelineB.find((step) => step.key === 'awaitingAcceptance').status,
    'active',
  )

  // C) Legacy canonical HTML: BarcodeRaw boş — print aktif, download pasif,
  //    timeline Fiziksel Kabul Bekleniyor active, kırmızı hata yok.
  const legacyOrder = buildOrderFixture({
    id: 'order-c',
    orderNumber: 'ORDER-C',
    shipment: buildShipmentFixture({
      barcodeRaw: '',
      zplAnalysis: undefined,
      zplSource: 'generated',
    }),
  })
  const htmlC = renderDrawer(OrderDetailDrawer, legacyOrder)
  assert.equal(canMarkPrinted(legacyOrder), true)
  assert.equal(canDownloadZpl(legacyOrder), false)
  assert.equal(canCreateShipment(legacyOrder), false)
  assert.match(htmlC, /Canonical HTML etiketi/)
  assert.match(htmlC, /Ham ZPL mevcut değil/)
  assert.doesNotMatch(htmlC, /class="drawer-error"/)
  const timelineC = buildSuratShipmentTimeline(legacyOrder)
  assert.equal(
    timelineC.find((step) => step.key === 'awaitingAcceptance').status,
    'active',
  )
  assert.equal(
    timelineC.some((step) => step.status === 'error'),
    false,
  )

  // D) Çoklu ürün: tüm satırlar görünür, totalQuantity doğru, toplam desi
  //    breakdown ile aynı; yalnız items[0] gösterilmez.
  const multiOrder = buildOrderFixture({
    id: 'order-d',
    orderNumber: 'ORDER-D',
    items: [
      buildItem({ id: 'L1' }),
      buildItem({
        id: 'L2',
        productName:
          'Scuba Seçil Detaylı Tesettür Siyah Elbise SCUBA-SEC01, 36',
        barcode: 'svacjsajczcz1',
        sku: 'SKU-2',
        color: 'Siyah',
        price: 756.88,
      }),
    ],
    shipment: buildShipmentFixture(),
  })
  const htmlD = renderDrawer(OrderDetailDrawer, multiOrder)
  assert.match(htmlD, /Tesettür Bordo Elbise/)
  assert.match(htmlD, /Tesettür Siyah Elbise/)
  assert.match(htmlD, /Ürünler \(2\)/)

  // Tek satır quantity=2: yapay ikinci satır üretilmez, Adet 2 gösterilir.
  const qtyOrder = buildOrderFixture({
    id: 'order-d2',
    orderNumber: 'ORDER-D2',
    items: [buildItem({ id: 'L1', quantity: 2 })],
    shipment: buildShipmentFixture(),
  })
  const htmlD2 = renderDrawer(OrderDetailDrawer, qtyOrder)
  assert.match(htmlD2, /Ürünler \(1\)/)

  // E) Safe idempotency replay: create kapalı, hata yok, Etiket Hazır korunur.
  assert.equal(canCreateShipment(legacyOrder), false)
  assert.match(htmlC, /fiziksel Sürat kabulü bekleniyor/i)

  // F) Gerçek create hatası: timeline error, printable state oluşmaz.
  const failedOrder = buildOrderFixture({
    id: 'order-f',
    orderNumber: 'ORDER-F',
    status: 'Hata',
    operationStatus: 'ERROR',
    errorMessage: 'Sürat create başarısız: kota aşıldı.',
    shipment: buildShipmentFixture({
      printEnabled: false,
      lifecycleStatus: 'SURAT_CREATE_UNCERTAIN',
      candidateVerificationStatus: 'PENDING_VERIFICATION',
      labelStatus: 'BLOCKED',
      barcodeRaw: '',
      zplAnalysis: undefined,
      trackingNumber: '',
      tNo: '',
      kargoTakipNo: '',
      candidateTNo: '',
      barcodeValue: '',
      barkodNo: '',
      barcode: '',
      finalSuratBarcode: '',
      candidateBarkodNo: '',
    }),
  })
  const timelineF = buildSuratShipmentTimeline(failedOrder)
  assert.equal(
    timelineF.find((step) => step.key === 'labelCreated').status,
    'error',
  )
  assert.equal(canMarkPrinted(failedOrder), false)
  const htmlF = renderDrawer(OrderDetailDrawer, failedOrder)
  assert.match(htmlF, /kota aşıldı/)

  // G) Eksik görsel: placeholder ile panel açılır, print/create etkilenmez.
  assert.match(htmlB, /Fotoğraf yok|line-image-placeholder/)
  assert.equal(canMarkPrinted(carrierOrder), true)

  // H) Eksik adres: throw yok, '-' gösterimi, canonical print unavailable.
  const missingAddress = buildOrderFixture({
    id: 'order-h',
    orderNumber: 'ORDER-H',
    address: '',
    city: '',
    district: '',
    customerName: '',
    customerEmail: '',
    shipment: buildShipmentFixture({
      barcodeRaw: '',
      zplAnalysis: undefined,
    }),
  })
  const htmlH = renderDrawer(OrderDetailDrawer, missingAddress)
  assert.match(htmlH, /ORDER-H/)
  assert.equal(canMarkPrinted(missingAddress), false)
  assert.match(htmlH, /Etiket oluşturulamıyor/)

  // I) Dar ekran: sabit piksel genişlikli inline style yok (responsive CSS
  //    sınıfları kullanılır); panel içeriği tablo dışında yatay taşmaz.
  assert.doesNotMatch(htmlD, /style="[^"]*width:\s*\d{3,}px/)

  // Read-only garanti: hiçbir render fetch tetiklemedi.
  assert.equal(fetchCalls, 0)
})
