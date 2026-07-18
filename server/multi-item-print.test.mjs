import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

const SINGLE_ZPL =
  '^XA^FO40,40^A0N,24,24^FD24510610424923^FS^FO60,520^BCN,140,N,N,N^FD01249492893^FS^XZ'

function buildLabelData(over = {}) {
  return {
    orderNumber: '11400000001',
    marketplaceName: 'Trendyol',
    recipientName: 'Test Alıcı',
    recipientPhone: '',
    senderName: 'HASAN GÜREL',
    address: 'Mah. Cad. No:1',
    fullAddressLines: ['Mah. Cad. No:1'],
    addressFontScale: 'normal',
    city: 'İstanbul',
    district: 'Fatih',
    routeCenter: 'İstanbul / Fatih',
    transferCenter: 'İstanbul / Fatih',
    branchName: 'FERAH',
    trackingNumber: '24510610424923',
    tNo: '24510610424923',
    barcodeValue: '01249492893',
    shipmentReference: 'PKG-1',
    leftVerticalReference: 'PKG-1',
    qrPayload: '7270039999999997',
    trendyolCargoTrackingNumber: '7270039999999997',
    desi: 2,
    desiSource: 'product_lines',
    items: [
      {
        productName: 'Tişört Basic',
        sku: 'SKU-1',
        barcode: 'BC-1',
        color: 'Siyah',
        size: 'M',
        quantity: 1,
      },
    ],
    totalQuantity: 1,
    ...over,
  }
}

function buildPrintableOrder(over = {}) {
  const shipment = {
    id: 'shp-1',
    provider: 'surat-kargo',
    trackingNumber: '24510610424923',
    tNo: '24510610424923',
    kargoTakipNo: '24510610424923',
    trackingUrl: '',
    shipmentCode: 'PKG-1',
    barcodeValue: '01249492893',
    barkodNo: '01249492893',
    barcode: '01249492893',
    finalSuratBarcode: '01249492893',
    barcodeRaw: SINGLE_ZPL,
    zplAnalysis: {
      acceptedTNo: '24510610424923',
      acceptedFinalBarcode: '01249492893',
    },
    printEnabled: true,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    labelStatus: 'READY',
    verifiedShipment: false,
    ozelKargoTakipNo: '7270039999999997',
    ...over.shipment,
  }
  return {
    id: over.id ?? 'order-1',
    marketplace: 'Trendyol',
    externalOrderId: 'EXT-1',
    orderNumber: over.orderNumber ?? '11400000001',
    customerName: 'Test Alıcı',
    customerPhone: '',
    customerEmail: '',
    address: 'Mah. Cad. No:1',
    city: 'İstanbul',
    district: 'Fatih',
    cargoTrackingNumber: '7270039999999997',
    marketplaceStatus: 'Created',
    operationStatus: 'READY_TO_SHIP',
    source: 'real',
    status: 'Etiket Hazır',
    totalAmount: 0,
    createdAt: '2026-07-18T00:00:00.000Z',
    desi: 2,
    desiSource: 'product_lines',
    packageCount: 1,
    items: over.items ?? [
      {
        id: 'L1',
        productName: 'Tişört Basic',
        sku: 'SKU-1',
        barcode: 'BC-1',
        color: 'Siyah',
        size: 'M',
        quantity: 1,
      },
    ],
    shipment,
  }
}

// KIRMIZI ÇİZGİ (regression baseline): tekli ürünlü siparişin print çıktısı
// ve model sözleşmesi DEĞİŞMEMELİDİR. Bu test çoklu-ürün düzeltmesinden
// önce yazılmıştır ve mevcut tekli davranışı bire bir kilitler.
test('Tekli sipariş print akışı baseline olarak değişmez', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const {
    renderPrintableLabelHtml,
    buildSuratPrintPageModel,
    resolveSuratPrintableSelection,
  } = await vite.ssrLoadModule('/src/utils/browserLabelPrint.ts')

  // 1) Renderer: tekli footer bire bir aynı markup.
  const html = renderPrintableLabelHtml(buildLabelData())
  assert.ok(
    html.includes(
      `<footer class="surat-section surat-product">
            <strong>1 x Tişört Basic</strong>
            <span>Renk: Siyah | Beden: M | SKU: SKU-1</span>
          </footer>`,
    ),
    'tekli footer markup değişmemeli',
  )
  assert.equal((html.match(/surat-product-multi/g) ?? []).length, 0)

  // 2) Tek satır quantity=2 tekli davranışta kalır (adet çarpanı başlıkta).
  const qtyHtml = renderPrintableLabelHtml(
    buildLabelData({
      items: [
        {
          productName: 'Tişört Basic',
          sku: 'SKU-1',
          barcode: 'BC-1',
          color: 'Siyah',
          size: 'M',
          quantity: 2,
        },
      ],
      totalQuantity: 2,
    }),
  )
  assert.ok(qtyHtml.includes('<strong>2 x Tişört Basic</strong>'))
  assert.equal((qtyHtml.match(/surat-product-multi/g) ?? []).length, 0)

  // 3) Model sözleşmesi: tekli siparişte mevcut alanlar aynen, canPrint=true.
  const { model, reason } = buildSuratPrintPageModel(buildPrintableOrder())
  assert.equal(reason, undefined)
  assert.equal(model.orderNumber, '11400000001')
  assert.equal(model.trackingNumber, '24510610424923')
  assert.equal(model.barcodeNumber, '01249492893')
  assert.equal(model.zpl, SINGLE_ZPL)
  assert.equal(model.desi, 2)
  assert.equal(model.packageCount, 1)
  assert.equal(model.contentLines, undefined)

  // 4) Seçim: tekli sipariş printable, skip yok.
  const selection = resolveSuratPrintableSelection([buildPrintableOrder()])
  assert.equal(selection.printable.length, 1)
  assert.equal(selection.skipped.length, 0)
})

// Çoklu ürün düzeltmesi: model shipment'ı mutate etmeden ayrı contentLines
// üretir; renderer tüm satırları tek sayfada, sarmalı ve throw etmeden basar.
test('Çoklu ürünlü sipariş yazdırılabilir model ve etiket üretir', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const {
    renderPrintableLabelHtml,
    buildSuratPrintPageModel,
    resolveSuratPrintableSelection,
  } = await vite.ssrLoadModule('/src/utils/browserLabelPrint.ts')

  const multiItems = [
    {
      id: 'L1',
      productName: 'Scuba Seçil Detaylı Tesettür Siyah Elbise',
      sku: 'SKU-1',
      barcode: 'BC-1',
      color: 'Siyah',
      size: '36',
      quantity: 1,
    },
    {
      id: 'L2',
      productName: 'Scuba Seçil Detaylı Tesettür Bordo Elbise',
      sku: 'SKU-2',
      barcode: 'BC-2',
      color: 'Bordo',
      size: '38',
      quantity: 1,
    },
  ]
  const multiOrder = buildPrintableOrder({
    id: 'order-multi',
    orderNumber: '11425963017',
    items: multiItems,
  })
  multiOrder.desi = 4

  // B) Model: canPrint=true, contentLines/totalQuantity dolu, canonical
  //    kodlar ve ZPL ürün satırlarınca ezilmemiş, shipment mutate edilmemiş.
  const shipmentSnapshot = JSON.stringify(multiOrder.shipment)
  const { model, reason } = buildSuratPrintPageModel(multiOrder)
  assert.equal(reason, undefined)
  assert.equal(model.orderNumber, '11425963017')
  assert.equal(model.trackingNumber, '24510610424923')
  assert.equal(model.barcodeNumber, '01249492893')
  assert.equal(model.zpl, SINGLE_ZPL)
  assert.equal(model.desi, 4)
  assert.equal(model.packageCount, 1)
  assert.deepEqual(model.contentLines, [
    '1 x Scuba Seçil Detaylı Tesettür Siyah Elbise',
    '1 x Scuba Seçil Detaylı Tesettür Bordo Elbise',
  ])
  assert.equal(model.totalQuantity, 2)
  assert.equal(model.items.length, 2)
  assert.equal(JSON.stringify(multiOrder.shipment), shipmentSnapshot)

  const multiSelection = resolveSuratPrintableSelection([multiOrder])
  assert.equal(multiSelection.printable.length, 1)
  assert.equal(multiSelection.skipped.length, 0)

  // Renderer: iki ürün satırı da etikette görünür; multi sınıfı uygulanır.
  const multiHtml = renderPrintableLabelHtml(
    buildLabelData({
      desi: 4,
      items: multiItems.map((item) => ({ ...item })),
      totalQuantity: 2,
    }),
  )
  assert.ok(multiHtml.includes('surat-product-multi'))
  assert.ok(
    multiHtml.includes('1 x Scuba Seçil Detaylı Tesettür Siyah Elbise'),
  )
  assert.ok(
    multiHtml.includes('1 x Scuba Seçil Detaylı Tesettür Bordo Elbise'),
  )
  assert.ok(multiHtml.includes('Renk: Bordo | Beden: 38'))
  assert.equal((multiHtml.match(/<article class="label-page">/g) ?? []).length, 1)

  // D) Uzun ürün adları: renderer throw etmez, tek sayfa kalır.
  const longName =
    'Çok Uzun Ürün Adı ' + 'Saten Detaylı Şifon Astarlı Tesettür Abiye '.repeat(6)
  const longHtml = renderPrintableLabelHtml(
    buildLabelData({
      items: [
        { productName: longName, quantity: 2, sku: 'SKU-L1', color: 'Siyah', size: '38' },
        { productName: `${longName} B`, quantity: 1, sku: 'SKU-L2', color: 'Bordo', size: '40' },
      ],
      totalQuantity: 3,
    }),
  )
  assert.equal((longHtml.match(/<article class="label-page">/g) ?? []).length, 1)
  assert.ok(longHtml.includes('surat-product-multi'))
})
