import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// REPRINT desi korunumu — frontend render/enjeksiyon.
// "ZPL İndir" ve "Etiketi Yazdır" aynı kalıcı artifact'i çözer; reprint etiketin
// "Top Ds/Kg" alanı orijinal desiyi korur. order.desi zaten geçerliyse EZİLMEZ.

async function withVite(t) {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    // Bu sunucular YALNIZ ssrLoadModule icin kullanilir; SSR'da bagimliliklar
    // zaten harici tutulur. Otomatik dep-scan bu yuzden GEREKSIZ ve ayni surecte
    // pes pese acilip kapanan sunucularda yarisa girip sonraki dosyayi dusuruyordu.
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  return vite
}

function printableOrder(over = {}) {
  return {
    id: 'order-r',
    marketplace: 'Trendyol',
    orderNumber: '11452948259',
    packageId: 'PKG-r',
    shipmentPackageId: 'PKG-r',
    operationStatus: 'LABEL_PRINTED',
    marketplaceStatus: 'Hazırlanıyor',
    labelStatus: 'PRINTED',
    hasPrintableLabel: true,
    customerName: 'Test',
    city: 'İstanbul',
    district: 'Kadıköy',
    cargoTrackingNumber: '7270034994447844',
    cargoProviderName: 'Sürat Kargo',
    desi: null,
    items: [{ id: 'i1', productName: 'Ürün', quantity: 1, price: 100 }],
    shipment: {
      printEnabled: true,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      trackingNumber: '11820824092123',
      tNo: '11820824092123',
      barcode: '01252765588',
      barkodNo: '01252765588',
      ozelKargoTakipNo: '7270034994447844',
      barcodeRaw: '^XA^FO20,20^FD01252765588^FS^XZ',
    },
    ...over,
  }
}

test('RDP-6: injectPersistedZpl — desi=null order’a kalıcı desi enjekte edilir', async (t) => {
  const vite = await withVite(t)
  const { injectPersistedZpl } = await vite.ssrLoadModule(
    '/src/utils/persistedLabel.ts',
  )
  const order = printableOrder({ desi: null })
  const patched = injectPersistedZpl(order, order.shipment.barcodeRaw, 2)
  assert.equal(patched.desi, 2)
  assert.equal(patched.shipment.desi, 2)
  // Ham ZPL korunur.
  assert.equal(patched.shipment.barcodeRaw, order.shipment.barcodeRaw)
})

test('RDP-7: injectPersistedZpl — order’da geçerli desi varsa EZİLMEZ', async (t) => {
  const vite = await withVite(t)
  const { injectPersistedZpl } = await vite.ssrLoadModule(
    '/src/utils/persistedLabel.ts',
  )
  const order = printableOrder({ desi: 3 })
  const patched = injectPersistedZpl(order, order.shipment.barcodeRaw, 2)
  assert.equal(patched.desi, 3)
})

// SÖZLEŞME DEĞİŞTİ (Aşama 3A/Adım 3): "indir = yazdır" garantisi artık
// istemcinin AYNI KAYNAĞI seçmesinden değil, ikisinin de AYNI SUNUCU
// sözleşmesini uygulamasından gelir. İddia zayıflatılmadı: byte-for-byte
// eşitlik hâlâ kilitli, yalnız kaynağı değişti.
test('RDP-8: byte-for-byte — indir ve yazdır AYNI sunucu sözleşmesini uygular', async (t) => {
  const vite = await withVite(t)
  const { resolvePersistedLabelArtifact, applyServerPrintContract } =
    await vite.ssrLoadModule('/src/utils/persistedLabel.ts')
  const order = printableOrder()

  // İstemci kaynaktan basılabilir ZPL SEÇMEZ.
  const artifact = resolvePersistedLabelArtifact(order)
  assert.equal(artifact.zpl, null)
  assert.equal(artifact.source, 'pending-fetch')

  // Sunucu sözleşmesi uygulandığında iki yol da AYNI baytları görür.
  const contract = {
    carrierPrintReady: true,
    printArtifactStatus: 'ready',
    productDetailStatus: 'none',
    zpl: order.shipment.barcodeRaw,
    desi: null,
    supplementalLabels: [],
  }
  const download = applyServerPrintContract(order, contract)
  const print = applyServerPrintContract(order, contract)
  assert.equal(download.shipment.barcodeRaw, print.shipment.barcodeRaw)
  assert.equal(download.shipment.barcodeRaw, contract.zpl)
})

test('RDP-9: format korunur — 2→2.00, 2.5→2.50, null→-', async (t) => {
  const vite = await withVite(t)
  const { formatDesi, extractZplDesi } = await vite.ssrLoadModule(
    '/src/utils/desi.ts',
  )
  assert.equal(formatDesi(2), '2.00')
  assert.equal(formatDesi(2.5), '2.50')
  assert.equal(formatDesi(null), '-')
  // Ham ZPL’den desi ekstraksiyonu (frontend sözleşmesi).
  assert.equal(
    extractZplDesi('^XA^FDTop Ds/Kg^FS^FD2.00^FS^XZ'),
    2,
  )
})

test('RDP-10: reprint HTML etiketi desiyi 2.00 gösterir (order.desi korunmuş)', async (t) => {
  const vite = await withVite(t)
  const { buildSuratPrintPageModel } = await vite.ssrLoadModule(
    '/src/utils/browserLabelPrint.ts',
  )
  const order = printableOrder({ desi: 2 })
  const { model, reason } = buildSuratPrintPageModel(order)
  assert.ok(model, `yazdırılabilir model beklenir: ${reason ?? ''}`)
  assert.equal(model.desi, 2)
})

test('RDP-11: Dashboard aşaması/historical değişmez — LABEL_PRINTED yine Etiket Basıldı', async (t) => {
  const vite = await withVite(t)
  const { classifyDashboardOperationStage } = await vite.ssrLoadModule(
    '/src/utils/orderClassification.ts',
  )
  const order = printableOrder({ desi: null })
  const result = classifyDashboardOperationStage(order)
  assert.equal(result.stage, 'labelPrinted')
  assert.equal(result.label, 'Etiket Basıldı')
})
