import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ETİKET RENK / BEDEN METADATA SÖZLEŞMESİ.
//
// KÖK NEDEN (şema kanıtı, server/db/schema.ts):
//   order_lines      → variant_attributes JSONB VAR, color/size KOLONU YOK
//   product_variants → color TEXT ve size TEXT KOLONLARI VAR (organization_id
//                      kapsamlı)
// Bu yüzden Trendyol yalnız "Beden" attribute'u gönderdiğinde renk sipariş
// satırında YOK, ama KATALOGDA VAR. Sonuç: bazı etiketlerde "(Beden: 42)",
// bazılarında "(Renk: X, Beden: Y)".
//
// ÇÖZÜM: tek resolver + kesin kod eşleşmeli katalog tamamlama + eksik alan
// için "Belirtilmemiş". TAHMİN YOKTUR.
//
// Fixture'lar SENTETİKTİR; gerçek müşteri verisi, adres, telefon, ZPL veya
// credential İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      // DEP-SCANNER YARIŞI: Vite bağımlılık taramasını createServer'dan SONRA
      // asenkron başlatır. Bu test modülü yükleyip sunucuyu hemen kapattığı
      // için tarama kapanmış plugin container'a çarpar ve dosya seviyesinde
      // "server is being restarted or closed" hatası verir. SSR-only test
      // sunucusunun tarayıcıya optimize edilmiş bağımlılık paketi GEREKMEZ;
      // tarama tamamen kapatılır.
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

const UNSPECIFIED = 'Belirtilmemiş'

const orderItem = (over = {}) => ({
  id: 'line-1',
  productName: 'Taşlı Simli Tesettür Abiye',
  sku: '',
  merchantSku: '',
  barcode: '',
  quantity: 1,
  ...over,
})

const product = (over = {}) => ({
  id: 'p-1',
  marketplace: 'Trendyol',
  productName: 'Taşlı Simli Tesettür Abiye',
  sku: '',
  barcode: '',
  productMainId: 'MODEL-1',
  stock: 0,
  price: 0,
  source: 'real',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
})

// ═══ 1-2: yapısal alanlar ve variantAttributes ═════════════════════════════

test('VM-1: sipariş satırındaki doğrudan color/size alanları kullanılır', async () => {
  const { resolveLabelProductMetadata } = await load(
    '/src/utils/labelProductMetadata.ts',
  )
  const resolved = resolveLabelProductMetadata(
    orderItem({ color: 'Lacivert', size: '38' }),
  )
  assert.equal(resolved.color, 'Lacivert')
  assert.equal(resolved.size, '38')
  assert.equal(resolved.sources.color, 'field')
  assert.equal(resolved.sources.size, 'field')
})

test('VM-2: variantAttributes doğrulanmış anahtarlardan okunur', async () => {
  const { resolveLabelProductMetadata } = await load(
    '/src/utils/labelProductMetadata.ts',
  )
  for (const colorKey of ['Renk', 'Renk Seçeneği', 'Color', 'Colour']) {
    const resolved = resolveLabelProductMetadata(
      orderItem({
        variantAttributes: [{ name: colorKey, value: 'Bordo' }],
      }),
    )
    assert.equal(resolved.color, 'Bordo', `renk anahtarı: ${colorKey}`)
    assert.equal(resolved.sources.color, 'variantAttribute')
  }
  for (const sizeKey of ['Beden', 'Size', 'Numara', 'Ebat', 'Ölçü']) {
    const resolved = resolveLabelProductMetadata(
      orderItem({ variantAttributes: [{ name: sizeKey, value: '42' }] }),
    )
    assert.equal(resolved.size, '42', `beden anahtarı: ${sizeKey}`)
    assert.equal(resolved.sources.size, 'variantAttribute')
  }
})

// ═══ 3-6: katalog KESİN eşleşmesi ══════════════════════════════════════════

test('VM-3: katalog barkod tam eşleşmesi renk ve bedeni döndürür', async () => {
  const { resolveCatalogVariantMetadata } = await load(
    '/src/utils/labelVariantCatalog.ts',
  )
  const match = resolveCatalogVariantMetadata(
    orderItem({ barcode: 'BC-100' }),
    [product({ barcode: 'BC-100', color: 'Lacivert', size: '38' })],
  )
  assert.equal(match.color, 'Lacivert')
  assert.equal(match.size, '38')
  assert.equal(match.matchedBy, 'barcode')
  assert.equal(match.ambiguous, false)
})

test('VM-4: katalog SKU / stok kodu tam eşleşmesi de çalışır', async () => {
  const { resolveCatalogVariantMetadata } = await load(
    '/src/utils/labelVariantCatalog.ts',
  )
  const bySku = resolveCatalogVariantMetadata(orderItem({ sku: 'SECIL-334' }), [
    product({ sku: 'SECIL-334', color: 'Vizon', size: '40' }),
  ])
  assert.equal(bySku.color, 'Vizon')
  assert.equal(bySku.matchedBy, 'sku')

  const byStockCode = resolveCatalogVariantMetadata(
    orderItem({ stockCode: 'STK-9' }),
    [product({ stockCode: 'STK-9', color: 'Ekru', size: 'XL' })],
  )
  assert.equal(byStockCode.color, 'Ekru')
  assert.equal(byStockCode.size, 'XL')
  assert.equal(byStockCode.matchedBy, 'stockCode')
})

test('VM-5: başka organizasyonun ürünü KULLANILAMAZ (kapsam dışı katalog)', async () => {
  const { resolveCatalogVariantMetadata } = await load(
    '/src/utils/labelVariantCatalog.ts',
  )
  // Resolver YALNIZ kendisine verilen diziye bakar; dizi çağıran katmanda
  // organizasyon kapsamlı yüklenir. Başka org'un ürünü diziye girmediğinde
  // hiçbir değer üretilmez.
  const otherOrgOnly = resolveCatalogVariantMetadata(
    orderItem({ barcode: 'BC-100' }),
    [],
  )
  assert.equal(otherOrgOnly.color, '')
  assert.equal(otherOrgOnly.matchedBy, 'none')
  // Marketplace kapsamı da uygulanır: farklı pazaryeri ürünü değerlendirilmez.
  const wrongMarketplace = resolveCatalogVariantMetadata(
    orderItem({ barcode: 'BC-100' }),
    [product({ barcode: 'BC-100', color: 'Lacivert', marketplace: 'Hepsiburada' })],
    { marketplace: 'Trendyol' },
  )
  assert.equal(wrongMarketplace.color, '')
  assert.equal(wrongMarketplace.matchedBy, 'none')
})

test('VM-6: çelişkili birden çok aday varsa TAHMİN EDİLMEZ', async () => {
  const { resolveCatalogVariantMetadata } = await load(
    '/src/utils/labelVariantCatalog.ts',
  )
  const match = resolveCatalogVariantMetadata(
    orderItem({ sku: 'AILE-KODU' }),
    [
      product({ id: 'p-1', sku: 'AILE-KODU', color: 'Siyah', size: '38' }),
      product({ id: 'p-2', sku: 'AILE-KODU', color: 'Beyaz', size: '40' }),
    ],
  )
  assert.equal(match.color, '', 'çelişkili renk basılmaz')
  assert.equal(match.size, '', 'çelişkili beden basılmaz')
  assert.equal(match.ambiguous, true)
})

test('VM-6b: katalog eşleşmesi ürün ADI ile YAPILMAZ (fuzzy yok)', async () => {
  const { resolveCatalogVariantMetadata } = await load(
    '/src/utils/labelVariantCatalog.ts',
  )
  const match = resolveCatalogVariantMetadata(
    orderItem({ productName: 'Taşlı Simli Tesettür Abiye' }),
    [
      product({
        productName: 'Taşlı Simli Tesettür Abiye',
        color: 'Lacivert',
        size: '38',
      }),
    ],
  )
  assert.equal(match.matchedBy, 'none', 'kod yoksa ad üzerinden eşleşme yok')
  assert.equal(match.color, '')
})

// ═══ 7-9: başlık ayrıştırma güvenliği ve birleşim ══════════════════════════

test('VM-7: "Taşlı" renk olarak TAHMİN EDİLMEZ, ürün adında kalır', async () => {
  const { resolveLabelProductMetadata } = await load(
    '/src/utils/labelProductMetadata.ts',
  )
  const resolved = resolveLabelProductMetadata(
    orderItem({ productName: 'Taşlı Simli Tesettür Abiye' }),
  )
  assert.equal(resolved.color, '')
  assert.equal(resolved.productName, 'Taşlı Simli Tesettür Abiye')
})

test('VM-8: başlık sonundaki ", <beden>" eki güvenle ayrıştırılır', async () => {
  const { resolveLabelProductMetadata } = await load(
    '/src/utils/labelProductMetadata.ts',
  )
  const resolved = resolveLabelProductMetadata(
    orderItem({ productName: 'Taşlı Simli Tesettür Abiye SECIL-334, 36' }),
  )
  assert.equal(resolved.size, '36')
  assert.equal(resolved.sku, 'SECIL-334')
  assert.equal(resolved.productName, 'Taşlı Simli Tesettür Abiye')
})

test('VM-9: katalogdan renk + başlıktan beden güvenle BİRLEŞİR', async () => {
  const { resolveLabelProductMetadata } = await load(
    '/src/utils/labelProductMetadata.ts',
  )
  const { resolveCatalogVariantMetadata } = await load(
    '/src/utils/labelVariantCatalog.ts',
  )
  const item = orderItem({
    productName: 'Taşlı Simli Tesettür Abiye SECIL-334, 36',
    barcode: 'BC-77',
  })
  const catalog = resolveCatalogVariantMetadata(item, [
    product({ barcode: 'BC-77', color: 'Lacivert' }),
  ])
  const resolved = resolveLabelProductMetadata(item, catalog)
  assert.equal(resolved.color, 'Lacivert')
  assert.equal(resolved.sources.color, 'catalogVariant')
  assert.equal(resolved.size, '36')
  assert.equal(resolved.sources.size, 'productName')
  assert.equal(resolved.productName, 'Taşlı Simli Tesettür Abiye')
})

test('VM-9b: satırın kendi değeri katalog tarafından EZİLMEZ', async () => {
  const { resolveLabelProductMetadata } = await load(
    '/src/utils/labelProductMetadata.ts',
  )
  const resolved = resolveLabelProductMetadata(
    orderItem({ color: 'Bordo', size: '38' }),
    { color: 'Lacivert', size: '44' },
  )
  assert.equal(resolved.color, 'Bordo')
  assert.equal(resolved.size, '38')
})

// ═══ 10-13: tutarlı çıktı ══════════════════════════════════════════════════

test('VM-10: renk yoksa "Belirtilmemiş" yazılır', async () => {
  const { buildProductMetaText } = await load('/src/utils/labelProductFit.ts')
  const text = buildProductMetaText({
    productName: 'Abiye',
    quantity: 1,
    size: '42',
    sku: '66132-13',
  })
  assert.equal(text, `(Renk: ${UNSPECIFIED}, Beden: 42) [66132-13]`)
})

test('VM-11: beden yoksa "Belirtilmemiş" yazılır', async () => {
  const { buildProductMetaText } = await load('/src/utils/labelProductFit.ts')
  const text = buildProductMetaText({
    productName: 'Abiye',
    quantity: 1,
    color: 'Lacivert',
  })
  assert.equal(text, `(Renk: Lacivert, Beden: ${UNSPECIFIED})`)
})

test('VM-12: SKU yoksa boş köşeli parantez ÜRETİLMEZ', async () => {
  const { buildProductMetaText } = await load('/src/utils/labelProductFit.ts')
  const text = buildProductMetaText({
    productName: 'Abiye',
    quantity: 1,
    color: 'Lacivert',
    size: '38',
  })
  assert.equal(text, '(Renk: Lacivert, Beden: 38)')
  assert.equal(text.includes('[]'), false)
  assert.equal(text.includes('()'), false)
  assert.equal(/,\s*\)/.test(text), false, 'boş virgül/ayraç yok')
})

test('VM-13: metadata TAM OLARAK BİR KEZ yazılır', async () => {
  const { buildProductMetaText } = await load('/src/utils/labelProductFit.ts')
  const text = buildProductMetaText({
    productName: 'Abiye',
    quantity: 1,
    color: 'Lacivert',
    size: '38',
    sku: 'SECIL-334',
  })
  assert.equal((text.match(/Renk:/g) ?? []).length, 1)
  assert.equal((text.match(/Beden:/g) ?? []).length, 1)
  assert.equal((text.match(/\[/g) ?? []).length, 1)
})

// ═══ 14-16: yüzeyler arası tutarlılık ══════════════════════════════════════

test('VM-14: önizleme ve baskı AYNI biçimlendiriciyi kullanır (kopya yok)', () => {
  const preview = readFileSync(
    join(here, '..', 'src', 'components', 'LabelHtmlPreview.tsx'),
    'utf8',
  )
  const print = readFileSync(
    join(here, '..', 'src', 'utils', 'browserLabelPrint.ts'),
    'utf8',
  )
  for (const [name, src] of [['preview', preview], ['print', print]]) {
    assert.match(src, /buildProductMetaText/, `${name} ortak helper kullanmalı`)
    // Kopya biçimlendirme (elle "Renk: ${...}") KALMAMALI.
    assert.equal(
      /`Renk: \$\{/.test(src),
      false,
      `${name} içinde kopya biçimlendirme kaldı`,
    )
  }
})

test('VM-15: çoklu üründe HER satırda renk ve beden bulunur', async () => {
  const { buildLabelData } = await load('/src/utils/labelData.ts')
  const { buildProductMetaText } = await load('/src/utils/labelProductFit.ts')
  const order = {
    id: 'o-1',
    marketplace: 'Trendyol',
    orderNumber: '7270000000000002',
    packageId: 'PKG-1',
    customerName: '',
    address: '',
    city: '',
    district: '',
    items: [
      orderItem({ id: 'l-1', barcode: 'BC-A', productName: 'Ürün A' }),
      orderItem({ id: 'l-2', barcode: 'BC-B', productName: 'Ürün B' }),
    ],
  }
  const products = [
    product({ id: 'p-a', barcode: 'BC-A', color: 'Lacivert', size: '38' }),
    // İkinci üründe katalogda renk yok: "Belirtilmemiş" görünmeli.
    product({ id: 'p-b', barcode: 'BC-B', size: '40' }),
  ]
  const data = buildLabelData(order, undefined, undefined, {}, products)
  assert.equal(data.items.length, 2)
  const texts = data.items.map((line) =>
    buildProductMetaText({
      productName: line.productName,
      quantity: line.quantity,
      color: line.color,
      size: line.size,
      sku: line.sku,
    }),
  )
  assert.equal(texts[0], '(Renk: Lacivert, Beden: 38)')
  assert.equal(texts[1], `(Renk: ${UNSPECIFIED}, Beden: 40)`)
  for (const text of texts) {
    assert.match(text, /Renk: /)
    assert.match(text, /Beden: /)
  }
})

test('VM-16: aynı girdi + aynı katalog = AYNI sonuç (determinizm)', async () => {
  const { buildLabelData } = await load('/src/utils/labelData.ts')
  const order = {
    id: 'o-2',
    marketplace: 'Trendyol',
    orderNumber: '7270000000000003',
    items: [orderItem({ barcode: 'BC-100' })],
  }
  const products = [
    product({ barcode: 'BC-100', color: 'Lacivert', size: '38' }),
  ]
  const first = buildLabelData(order, undefined, undefined, {}, products)
  const second = buildLabelData(order, undefined, undefined, {}, products)
  assert.deepEqual(first.items, second.items)
  assert.equal(first.items[0].color, 'Lacivert')
})

// ═══ 17-18: provider ZPL ve güvenlik ═══════════════════════════════════════

test('VM-17: resmî provider ZPL\'ine ürün metadata ENJEKTE EDİLMEZ', async () => {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const OFFICIAL = ['^XA', '^CI28', '^FO60,120^BY3^BCN,140,Y,N,N^FD01231201025^FS', '^XZ'].join('\n')
  const order = {
    id: 'o-3',
    orderNumber: '7270000000000004',
    packageId: 'PKG-3',
    customerName: 'TEST ALICI',
    customerPhone: '5410000000',
    city: 'KASTAMONU',
    district: 'ARAC',
    address: 'TEST MAH 1',
    items: [orderItem({ color: 'Lacivert', size: '38', barcode: 'BC-1' })],
    desi: 2,
    desiSource: 'manual_total',
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: '25220148446193',
      tNo: '25220148446193',
      barcode: '01231201025',
      barcodeRaw: OFFICIAL,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true,
      printEnabled: true,
    },
  }
  const label = await new ZebraZplLabelProvider().generateSingle({
    order,
    shipment: order.shipment,
    template: { id: 'tpl' },
    mappingConfig: {},
    desiConfig: { defaultUnitDesi: 2 },
  })
  assert.equal(label.zplContent, OFFICIAL, 'byte-for-byte korunur')
  assert.equal(label.zplContent.includes('Renk'), false)
  assert.equal(label.zplContent.includes('Beden'), false)
  assert.equal(label.zplContent.includes('Belirtilmemiş'), false)
})

test('VM-18: metadata çözümleyicileri PII okumaz / loglamaz', () => {
  for (const rel of [
    'src/utils/labelVariantCatalog.ts',
    'src/utils/labelProductMetadata.ts',
  ]) {
    const src = readFileSync(join(here, '..', rel), 'utf8')
    assert.equal(/console\.(log|info|warn|error)/.test(src), false, rel)
    for (const field of [
      'customerName',
      'customerPhone',
      'customerEmail',
      'address',
      'apiKey',
      'apiSecret',
      'barcodeRaw',
    ]) {
      assert.equal(src.includes(field), false, `${rel} → ${field}`)
    }
  }
})
