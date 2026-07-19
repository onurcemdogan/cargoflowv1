import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Canlı vaka (18.07.2026): newzeyna4 eşleşirken newzeyna11 eşleşmiyordu.
// Taze katalogta ikisi de var; kırılma bayat cache + zayıf model-token
// çıkarımından geliyordu. Bu test varyant/parent eşleşme sözleşmesini ve
// cache yenilenince yeniden çözülmeyi kilitler.
test('Varyant ve parent model görsel eşleşme sözleşmesi', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const {
    resolveProductCacheMatch,
    resolveProductImage,
    resolveProductImageCandidates,
    applyProductImageResolution,
    buildProductMatchDebug,
    extractModelCodeFromName,
  } = await vite.ssrLoadModule('/src/utils/productImage.ts')

  const zeynaProduct = (over = {}) => ({
    id: over.id,
    marketplace: 'Trendyol',
    productName:
      'Zara Saten Tesettür Elbise Drapeli Uzun Abiye Elbise Dik Yaka Şık Özel Gün Elbisesi',
    sku: 'zeyna',
    stockCode: 'zeyna',
    productMainId: 'ttzeyna44',
    category: 'Tesettür Abiye',
    stock: 0,
    price: 0,
    source: 'real',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...over,
  })
  const catalog = [
    zeynaProduct({
      id: 'prd-zeyna4',
      barcode: 'newzeyna4',
      color: 'Lacivert',
      size: '36',
      productImageUrl: 'https://cdn.example.com/zeyna-lacivert.jpg',
    }),
    zeynaProduct({
      id: 'prd-zeyna11',
      barcode: 'newzeyna11',
      color: 'Bordo',
      size: '38',
      productImageUrl: 'https://cdn.example.com/zeyna-bordo.jpg',
    }),
    zeynaProduct({
      id: 'prd-zeyna12',
      barcode: 'newzeyna12',
      color: 'Bordo',
      size: '36',
      productImageUrl: 'https://cdn.example.com/zeyna-bordo.jpg',
    }),
  ]
  const zeynaItem = (over = {}) => ({
    id: 'line-1',
    productName:
      'Zara Saten Tesettür Elbise Drapeli Uzun Abiye Elbise Dik Yaka Şık Özel Gün Elbisesi ttzeyna44, 38',
    sku: 'newzeyna11',
    merchantSku: 'zeyna',
    barcode: 'newzeyna11',
    quantity: 1,
    productContentId: '',
    productMainId: '',
    color: 'Bordo',
    size: '38',
    ...over,
  })

  // Model token çıkarımı: isimden 'ttzeyna44' (alfanümerik) ve '6496'.
  assert.equal(
    extractModelCodeFromName(
      'Zara Saten Tesettür Elbise ttzeyna44, 38',
    ),
    'ttzeyna44',
  )
  assert.equal(
    extractModelCodeFromName('Önü Drapeli Loş Tesettür Takım 6496, 42'),
    '6496',
  )

  // A) Exact varyant barkodu: newzeyna4 kendi görselini bulur.
  const exactA = resolveProductImage(
    zeynaItem({
      sku: 'newzeyna4',
      barcode: 'newzeyna4',
      color: 'Lacivert',
      size: '36',
    }),
    catalog,
  )
  assert.equal(exactA.matchedBy, 'barcode')
  assert.equal(exactA.url, 'https://cdn.example.com/zeyna-lacivert.jpg')
  assert.equal(exactA.imageResolvedFrom, 'productCache')

  // B) Exact varyant cache'te varsa (newzeyna11) kendi görseli kullanılır.
  const exactB = resolveProductImage(zeynaItem(), catalog)
  assert.equal(exactB.matchedBy, 'barcode')
  assert.equal(exactB.matchedProductId, 'prd-zeyna11')
  assert.equal(exactB.url, 'https://cdn.example.com/zeyna-bordo.jpg')

  // C) Exact varyant cache'te YOK, aynı parent model + renk uyumlu var:
  //    parent ürün görseli kullanılır, kaynak açıkça işaretlenir.
  //    (Beden farkı parent görseli için engel değildir.)
  const partialCatalog = catalog.filter((p) => p.id !== 'prd-zeyna11')
  const parentMatch = resolveProductCacheMatch(zeynaItem(), partialCatalog)
  assert.equal(parentMatch.matchedBy, 'parentModel')
  assert.equal(parentMatch.failureReason, 'PARENT_PRODUCT_IMAGE_USED')
  assert.equal(parentMatch.product.id, 'prd-zeyna12')
  const parentImage = resolveProductImage(zeynaItem(), partialCatalog)
  assert.equal(parentImage.imageResolvedFrom, 'parentProductCache')
  assert.equal(parentImage.url, 'https://cdn.example.com/zeyna-bordo.jpg')
  assert.equal(parentImage.matchedBy, 'parentModel')

  // Renk çelişirse parent görseli KULLANILMAZ (yanlış ürün gösterilmez).
  const conflictCatalog = [
    zeynaProduct({
      id: 'prd-zeyna-siyah',
      barcode: 'newzeyna8',
      color: 'Siyah',
      size: '38',
      productImageUrl: 'https://cdn.example.com/zeyna-siyah.jpg',
    }),
  ]
  const conflictMatch = resolveProductCacheMatch(zeynaItem(), conflictCatalog)
  assert.equal(conflictMatch.product, undefined)
  assert.equal(conflictMatch.failureReason, 'COLOR_CONFLICT')

  // D) Aynı base isim iki FARKLI modelde: belirsiz — placeholder.
  const ambiguousCatalog = [
    zeynaProduct({
      id: 'prd-model-a',
      barcode: 'amb-1',
      sku: 'amb-sku-a',
      stockCode: 'amb-sku-a',
      productMainId: 'model-a',
      color: 'Bordo',
      size: '38',
      productImageUrl: 'https://cdn.example.com/model-a.jpg',
    }),
    zeynaProduct({
      id: 'prd-model-b',
      barcode: 'amb-2',
      sku: 'amb-sku-b',
      stockCode: 'amb-sku-b',
      productMainId: 'model-b',
      color: 'Bordo',
      size: '38',
      productImageUrl: 'https://cdn.example.com/model-b.jpg',
    }),
  ]
  const ambiguous = resolveProductCacheMatch(
    zeynaItem({
      barcode: 'amb-x',
      sku: 'amb-x',
      merchantSku: '',
      productName:
        'Zara Saten Tesettür Elbise Drapeli Uzun Abiye Elbise Dik Yaka Şık Özel Gün Elbisesi',
    }),
    ambiguousCatalog,
  )
  assert.equal(ambiguous.product, undefined)
  assert.equal(ambiguous.failureReason, 'MULTIPLE_NAME_MATCHES')

  // E) merchantSku aynı ama modeller farklı: yanlış eşleşme YAPILMAZ.
  const sharedMerchantCatalog = [
    zeynaProduct({
      id: 'prd-shared-1',
      barcode: 'sh-1',
      sku: 'zeyna',
      productMainId: 'model-a',
      productName: 'Model A Elbise',
      color: 'Bordo',
      size: '38',
      productImageUrl: 'https://cdn.example.com/model-a.jpg',
    }),
    zeynaProduct({
      id: 'prd-shared-2',
      barcode: 'sh-2',
      sku: 'zeyna',
      productMainId: 'model-b',
      productName: 'Model B Elbise',
      color: 'Bordo',
      size: '38',
      productImageUrl: 'https://cdn.example.com/model-b.jpg',
    }),
  ]
  const sharedMerchant = resolveProductCacheMatch(
    zeynaItem({
      barcode: 'unknown-bc',
      sku: 'unknown-sku',
      productName: 'Bilinmeyen Ürün',
    }),
    sharedMerchantCatalog,
  )
  assert.equal(sharedMerchant.product, undefined)
  assert.equal(sharedMerchant.failureReason, 'AMBIGUOUS_MATCH')

  // merchantSku TEK BAŞINA (beden bilgisi olmadan) eşleşme için yeterli
  // değildir; model token da yoksa VARIANT_NOT_IN_CACHE raporlanır.
  const merchantOnly = resolveProductCacheMatch(
    zeynaItem({
      barcode: 'unknown-bc',
      sku: 'unknown-sku',
      size: undefined,
      color: undefined,
      productName: 'Bilinmeyen Ürün',
    }),
    [
      zeynaProduct({
        id: 'prd-only',
        barcode: 'only-1',
        sku: 'zeyna',
        productMainId: 'model-a',
        productName: 'Model A Elbise',
        color: 'Bordo',
        size: '38',
        productImageUrl: 'https://cdn.example.com/model-a.jpg',
      }),
    ],
  )
  assert.equal(merchantOnly.product, undefined)
  assert.equal(merchantOnly.failureReason, 'VARIANT_NOT_IN_CACHE')

  // F) Cache yenilenince çözülmemiş görsel yeniden çözülür (yeni dizi →
  //    yeni index; bayat matchedProductId=null sonucu tutulmaz).
  const before = applyProductImageResolution(zeynaItem(), [])
  assert.equal(before.matchedProductId, undefined)
  const debugBefore = buildProductMatchDebug(zeynaItem(), [])
  assert.equal(debugBefore.finalFailureReason, 'CACHE_NOT_SYNCED')
  const after = applyProductImageResolution(before, catalog)
  assert.equal(after.matchedProductId, 'prd-zeyna11')
  assert.equal(after.productImageUrl, 'https://cdn.example.com/zeyna-bordo.jpg')

  // G) Regression: satırdan gelen doğru görsel bozulmaz.
  const withLineImage = resolveProductImage(
    zeynaItem({
      productImageUrl: 'https://cdn.example.com/line-image.jpg',
    }),
    catalog,
  )
  assert.equal(withLineImage.url, 'https://cdn.example.com/line-image.jpg')
  const candidates = resolveProductImageCandidates(zeynaItem(), catalog)
  assert.equal(candidates[0].url, 'https://cdn.example.com/zeyna-bordo.jpg')

  // Merge kimliği varyant seviyesinde: aynı sku/model paylaşan varyantlar
  // cache merge sırasında TEK kayda ÇÖKMEZ (canlı kök neden: 4293 → 331).
  const { mergeProductsWithCache } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )
  const freshFamily = [
    zeynaProduct({ id: 'v1', barcode: 'newzeyna4', productCode: 'PC-4', externalProductId: 'E4', color: 'Lacivert', size: '36' }),
    zeynaProduct({ id: 'v2', barcode: 'newzeyna11', productCode: 'PC-11', externalProductId: 'E11', color: 'Bordo', size: '38' }),
    zeynaProduct({ id: 'v3', barcode: 'newzeyna12', productCode: 'PC-12', externalProductId: 'E12', color: 'Bordo', size: '36' }),
  ]
  const mergedFromEmpty = mergeProductsWithCache(freshFamily, [])
  assert.equal(mergedFromEmpty.length, 3)
  const mergedWithStale = mergeProductsWithCache(freshFamily, [
    zeynaProduct({ id: 'stale', barcode: 'newzeyna4', productCode: 'PC-4', externalProductId: 'E4', color: 'Lacivert', size: '36', productImageUrl: '' }),
  ])
  assert.equal(mergedWithStale.length, 3)
  assert.equal(
    mergedWithStale.filter((p) => p.barcode === 'newzeyna4').length,
    1,
  )
  assert.ok(mergedWithStale.some((p) => p.barcode === 'newzeyna11'))

  // Debug sözleşmesi: eksik varyantta model/beden ve sayaçlar raporlanır.
  const debug = buildProductMatchDebug(zeynaItem(), partialCatalog)
  assert.equal(debug.normalizedBarcode, 'newzeyna11')
  assert.equal(debug.extractedModelCode, 'ttzeyna44')
  assert.equal(debug.extractedSize, '38')
  assert.equal(debug.exactBarcodeMatches, 0)
  assert.equal(debug.parentModelMatches, 2)
  assert.equal(debug.matchedBy, 'parentModel')
  assert.equal(debug.finalFailureReason, 'PARENT_PRODUCT_IMAGE_USED')
})

// Normalize katalog sözleşmesi (spec A-H): TR isim normalizasyonu, öncelik
// sırası (barcode → stockCode → sku), varyant-tekil kimlikte renk adı
// toleransı ve güvenli isim fallback'i. Canlı vaka: 11425364152/newzeyna13
// 'Zümrüt Yeşil' satırı, katalogdaki 'Yeşil' varyantına exact barkodla
// bağlanmalıdır.
test('Normalize katalog görsel eşleşmesi (A-H)', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const {
    resolveProductCacheMatch,
    resolveProductImage,
    applyProductImageResolution,
    buildProductMatchDebug,
    parseProductNameParts,
    colorsCompatible,
    normalizeTrText,
  } = await vite.ssrLoadModule('/src/utils/productImage.ts')
  const { resolveSuratPrintSource } = await vite.ssrLoadModule(
    '/src/utils/suratPrintEligibility.ts',
  )

  const product = (over = {}) => ({
    id: over.id,
    marketplace: 'Trendyol',
    productName: 'Büyük İspanyol Kol Uzun Parça Detaylı Özel Gün Abiye',
    sku: '',
    stockCode: '',
    barcode: '',
    productMainId: 'zeyna-gfb44',
    stock: 0,
    price: 0,
    source: 'real',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  })
  const item = (over = {}) => ({
    id: 'line-1',
    productName:
      'Büyük İspanyol Kol Uzun Parça Detaylı Özel Gün Abiye Zümrüt Yeşil zeyna-gfb44, 38',
    sku: '',
    merchantSku: '',
    barcode: '',
    stockCode: '',
    quantity: 1,
    productContentId: '',
    productMainId: '',
    color: 'Zümrüt Yeşil',
    size: '38',
    ...over,
  })

  // Spec 4 örneği: isim ayrıştırma sözleşmesi.
  const parsed = parseProductNameParts(
    'Büyük İspanyol Kol Uzun Parça Detaylı Özel Gün Abiye Zümrüt Yeşil zeyna-gfb44, 38',
  )
  assert.equal(
    parsed.baseName,
    'buyuk ispanyol kol uzun parca detayli ozel gun abiye',
  )
  assert.equal(parsed.modelToken, 'zeyna-gfb44')
  assert.equal(parsed.color, 'zumrut yesil')
  assert.equal(parsed.size, '38')
  assert.equal(normalizeTrText('Şık Özel GÜN'), 'sik ozel gun')
  assert.equal(colorsCompatible('Zümrüt Yeşil', 'Yeşil'), true)
  assert.equal(colorsCompatible('Lacivert', 'Yeşil'), false)

  // Canlı vaka regresyonu: exact barkod tek aday, renk ADI farklı yazılmış
  // ('Zümrüt Yeşil' vs 'Yeşil') → kimlik kazanır, görsel gelir.
  const liveCatalog = [
    product({
      id: 'prd-z13',
      barcode: 'newzeyna13',
      sku: 'zeyna',
      stockCode: 'zeyna',
      productMainId: 'ttzeyna44',
      color: 'Yeşil',
      size: '42',
      productImageUrl: 'https://cdn.example.com/zeyna-yesil.jpg',
    }),
  ]
  const liveMatch = resolveProductImage(
    item({
      barcode: 'newzeyna13',
      sku: 'newzeyna13',
      merchantSku: 'zeyna',
      color: 'Zümrüt Yeşil',
      size: '42',
      productName:
        'Zara Saten Tesettür Elbise Drapeli Uzun Abiye Elbise Dik Yaka Şık Özel Gün Elbisesi ttzeyna44, 42',
    }),
    liveCatalog,
  )
  assert.equal(liveMatch.matchedBy, 'barcode')
  assert.equal(liveMatch.url, 'https://cdn.example.com/zeyna-yesil.jpg')

  // B) Barkod yok, exact stok kodu → doğru görsel (öncelik sku'dan önce).
  const stockCatalog = [
    product({
      id: 'prd-stok',
      stockCode: 'STK-778',
      sku: 'farkli-sku',
      color: 'Bordo',
      size: '38',
      productImageUrl: 'https://cdn.example.com/stok.jpg',
    }),
  ]
  const stockMatch = resolveProductImage(
    item({ stockCode: 'STK-778', color: 'Bordo' }),
    stockCatalog,
  )
  assert.equal(stockMatch.matchedBy, 'stockCode')
  assert.equal(stockMatch.url, 'https://cdn.example.com/stok.jpg')

  // C) Barkod/SKU yok, model token + renk + beden → doğru varyant.
  const modelCatalog = [
    product({
      id: 'prd-m-38',
      color: 'Zümrüt Yeşil',
      size: '38',
      productImageUrl: 'https://cdn.example.com/zumrut-38.jpg',
    }),
    product({
      id: 'prd-m-40',
      color: 'Zümrüt Yeşil',
      size: '40',
      productImageUrl: 'https://cdn.example.com/zumrut-40.jpg',
    }),
  ]
  const modelMatch = resolveProductCacheMatch(item(), modelCatalog)
  assert.equal(modelMatch.matchedBy, 'modelColorSize')
  assert.equal(modelMatch.product.id, 'prd-m-38')

  // D) İsim + renk + beden TEK aday → doğru görsel.
  const nameCatalog = [
    product({
      id: 'prd-name',
      productMainId: '',
      color: 'Zümrüt Yeşil',
      size: '38',
      productImageUrl: 'https://cdn.example.com/name.jpg',
    }),
  ]
  const nameMatch = resolveProductCacheMatch(
    item({
      productName:
        'Büyük İspanyol Kol Uzun Parça Detaylı Özel Gün Abiye, 38',
    }),
    nameCatalog,
  )
  assert.equal(nameMatch.matchedBy, 'normalizedNameColorSize')
  assert.equal(nameMatch.product.id, 'prd-name')

  // E) Aynı isim, iki farklı renk (tek model): item rengiyle uyumlu varyant
  //    seçilir; hiçbir renk uyumlu değilse YANLIŞ görsel seçilmez.
  const twoColorCatalog = [
    product({
      id: 'prd-lacivert',
      productMainId: 'model-x',
      color: 'Lacivert',
      size: '38',
      productImageUrl: 'https://cdn.example.com/lacivert.jpg',
    }),
    product({
      id: 'prd-zumrut',
      productMainId: 'model-x',
      color: 'Zümrüt Yeşil',
      size: '38',
      productImageUrl: 'https://cdn.example.com/zumrut.jpg',
    }),
  ]
  const colorPick = resolveProductCacheMatch(
    item({ productMainId: 'model-x' }),
    twoColorCatalog,
  )
  assert.equal(colorPick.product.id, 'prd-zumrut')
  const colorConflict = resolveProductCacheMatch(
    item({ productMainId: 'model-x', color: 'Bordo' }),
    twoColorCatalog,
  )
  assert.equal(colorConflict.product, undefined)
  assert.equal(colorConflict.failureReason, 'COLOR_CONFLICT')

  // F) Aynı isim, birden fazla FARKLI model aday → placeholder.
  const multiNameCatalog = [
    product({
      id: 'prd-a',
      productMainId: 'model-a',
      color: 'Zümrüt Yeşil',
      size: '38',
      productImageUrl: 'https://cdn.example.com/a.jpg',
    }),
    product({
      id: 'prd-b',
      productMainId: 'model-b',
      color: 'Zümrüt Yeşil',
      size: '38',
      productImageUrl: 'https://cdn.example.com/b.jpg',
    }),
  ]
  const multiName = resolveProductCacheMatch(
    item({
      productName:
        'Büyük İspanyol Kol Uzun Parça Detaylı Özel Gün Abiye, 38',
    }),
    multiNameCatalog,
  )
  assert.equal(multiName.product, undefined)
  assert.equal(multiName.failureReason, 'MULTIPLE_NAME_MATCHES')

  // G) Cache refresh: önce çözülmez, yeni katalog dizisiyle otomatik çözülür.
  const before = applyProductImageResolution(item({ barcode: 'bc-g' }), [])
  assert.equal(before.matchedProductId, undefined)
  const after = applyProductImageResolution(before, [
    product({
      id: 'prd-g',
      barcode: 'bc-g',
      color: 'Yeşil',
      size: '38',
      productImageUrl: 'https://cdn.example.com/g.jpg',
    }),
  ])
  assert.equal(after.matchedProductId, 'prd-g')
  assert.equal(after.productImageUrl, 'https://cdn.example.com/g.jpg')

  // H) Görsel bulunamaması print/create eligibility'yi etkilemez.
  const noImageOrder = {
    id: 'order-h',
    marketplace: 'Trendyol',
    externalOrderId: 'EXT-H',
    orderNumber: 'ORDER-H',
    packageId: 'PKG-H',
    customerName: 'Alıcı',
    customerPhone: '',
    customerEmail: '',
    address: 'Adres Mah. 1',
    city: 'İstanbul',
    district: 'Fatih',
    cargoTrackingNumber: '7270030000000001',
    marketplaceStatus: 'Picking',
    operationStatus: 'READY_TO_SHIP',
    source: 'real',
    status: 'Etiket Hazır',
    totalAmount: 0,
    createdAt: '2026-07-19T00:00:00.000Z',
    desi: 2,
    desiSource: 'product_lines',
    packageCount: 1,
    items: [item({ barcode: 'yok-boyle-barkod' })],
    shipment: {
      id: 'shp-h',
      provider: 'surat-kargo',
      trackingNumber: '11722641140000',
      tNo: '11722641140000',
      kargoTakipNo: '11722641140000',
      trackingUrl: '',
      shipmentCode: 'PKG-H',
      barcodeValue: '01250310000',
      barkodNo: '01250310000',
      barcode: '01250310000',
      finalSuratBarcode: '01250310000',
      candidateTNo: '11722641140000',
      candidateBarkodNo: '01250310000',
      ozelKargoTakipNo: '7270030000000001',
      barcodeRaw: '',
      zplSource: 'generated',
      printEnabled: true,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      labelStatus: 'READY',
      verifiedShipment: false,
    },
  }
  const debugH = buildProductMatchDebug(noImageOrder.items[0], [])
  assert.equal(debugH.finalFailureReason, 'CACHE_NOT_SYNCED')
  const printH = resolveSuratPrintSource(noImageOrder)
  assert.equal(printH.canPrint, true)
})

// currentSync canlı vakaları (19.07.2026): kirli/eksik katalogda aile-düzeyi
// kimlik ambiguity'si resolver'ı durdurmamalı; model token fallback'i isim
// türevli token'larla da çalışmalı.
test('Kirli barkod + aile kimliği ambiguity fallback (currentSync)', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { resolveProductCacheMatch, resolveProductImage } =
    await vite.ssrLoadModule('/src/utils/productImage.ts')

  const base = (over = {}) => ({
    id: over.id,
    marketplace: 'Trendyol',
    stock: 0,
    price: 0,
    source: 'real',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...over,
  })
  // Bayat katalog: 'eftal' sku'su iki FARKLI modelde; 56879 ailesinden tek
  // varyant (Yeşil/38). Sipariş barkodu (eftal56879-2) katalogda YOK.
  const staleCatalog = [
    base({
      id: 'prd-eftal-56879',
      productName: 'Eftal Zara Saten Kumaş Drapeli Yeşil Tesettür Abiye Elbise',
      barcode: 'eftal56879-4',
      sku: 'eftal',
      stockCode: 'eftal',
      productMainId: '56879',
      color: 'Yeşil',
      size: '38',
      productImageUrl: 'https://cdn.example.com/eftal-56879.jpg',
    }),
    base({
      id: 'prd-eftal-yeni',
      productName: 'Premium Yeşil Zara Saten Drapeli İspanyol Kol Tesettür Abiye',
      barcode: 'eftalyeni443-2',
      sku: 'eftal',
      stockCode: 'eftal',
      productMainId: 'eftalyeni44',
      color: 'Yeşil',
      size: '40',
      productImageUrl: 'https://cdn.example.com/eftal-yeni.jpg',
    }),
  ]
  const dirtyItem = {
    id: 'line-dirty',
    productName:
      'Eftal Zara Saten Kumaş Drapeli Yeşil Tesettür Abiye Elbise 56879, 40',
    barcode: 'eftal56879-2',
    sku: 'eftal56879-2',
    merchantSku: 'eftal',
    stockCode: 'eftal',
    quantity: 1,
    productContentId: '',
    productMainId: '',
    color: 'Yeşil',
    size: '40',
  }
  // E) exact barkod yok + 'eftal' iki modelde: ambiguity resolver'ı
  //    DURDURMAZ; model token 56879 + renk uyumu ile doğru aileden görsel
  //    gelir (beden farkı parent kullanımına engel değil).
  const dirtyMatch = resolveProductCacheMatch(dirtyItem, staleCatalog)
  assert.equal(dirtyMatch.product.id, 'prd-eftal-56879')
  assert.equal(dirtyMatch.matchedBy, 'parentModel')
  const dirtyImage = resolveProductImage(dirtyItem, staleCatalog)
  assert.equal(dirtyImage.url, 'https://cdn.example.com/eftal-56879.jpg')

  // İsimden türetilen model token da indexlidir: productMainId farklı
  // yazılmış olsa bile 56879 isim token'ı aileyi bulur.
  const renamedMainCatalog = [
    base({
      id: 'prd-renamed',
      productName: 'Eftal Zara Saten Kumaş Drapeli Yeşil Tesettür Abiye Elbise 56879',
      barcode: 'baska-barkod',
      sku: 'eftal',
      stockCode: 'eftal',
      productMainId: 'tamamen-farkli-main',
      color: 'Yeşil',
      size: '40',
      productImageUrl: 'https://cdn.example.com/renamed.jpg',
    }),
  ]
  const renamedMatch = resolveProductCacheMatch(dirtyItem, renamedMainCatalog)
  assert.equal(renamedMatch.product.id, 'prd-renamed')
  const renamedImage = resolveProductImage(dirtyItem, renamedMainCatalog)
  assert.equal(renamedImage.url, 'https://cdn.example.com/renamed.jpg')

  // Güvenli aday hiç yoksa (renk çelişkisi) ambiguity nihai nedene düşer,
  // yanlış görsel SEÇİLMEZ.
  const conflictItem = { ...dirtyItem, color: 'Bordo' }
  const conflictMatch = resolveProductCacheMatch(conflictItem, staleCatalog)
  assert.equal(conflictMatch.product, undefined)
  assert.equal(
    ['AMBIGUOUS_MATCH', 'COLOR_CONFLICT'].includes(conflictMatch.failureReason),
    true,
  )
})

test('Canlı katalog varyant kimlikleri üst ürün altında kaybolmaz', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())
  const { resolveProductImage } = await vite.ssrLoadModule(
    '/src/utils/productImage.ts',
  )
  const { mergeProductsWithCache } = await vite.ssrLoadModule(
    '/src/services/orderWorkflowService.ts',
  )

  const catalog = [
    {
      id: 'prd-green',
      marketplace: 'Trendyol',
      externalProductId: 'same-parent',
      productContentId: 'same-content-group',
      productCode: '1578164726',
      barcode: 'eftal56879-2',
      productName: 'Eftal Zara Saten Kumaş Drapeli Yeşil Tesettür Abiye Elbise',
      color: 'Yeşil',
      size: '40',
      productImageUrl: 'https://cdn.example.com/eftal-green.jpg',
    },
    {
      id: 'prd-black',
      marketplace: 'Trendyol',
      externalProductId: 'same-parent',
      productContentId: 'same-content-group',
      productCode: '1578164727',
      barcode: 'eftal56879-3',
      productName: 'Eftal Zara Saten Kumaş Drapeli Siyah Tesettür Abiye Elbise',
      color: 'Siyah',
      size: '40',
      productImageUrl: 'https://cdn.example.com/eftal-black.jpg',
    },
  ]
  const item = {
    id: 'line-live',
    productName:
      'Eftal Zara Saten Kumaş Drapeli Yeşil Tesettür Abiye Elbise 56879, 40',
    barcode: 'eftal56879-2',
    sku: 'eftal56879-2',
    merchantSku: 'eftal',
    stockCode: 'eftal',
    productCode: '1578164726',
    productContentId: '1578164726',
    color: 'Yeşil',
    size: '40',
  }

  const mergedCatalog = mergeProductsWithCache(catalog, [])
  assert.equal(mergedCatalog.length, 2)

  const image = resolveProductImage(item, mergedCatalog)
  assert.equal(image.matchedBy, 'barcode')
  assert.equal(image.matchedProductId, 'prd-green')
  assert.equal(image.url, 'https://cdn.example.com/eftal-green.jpg')
})
