import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Ürün bazlı desi sözleşmesi:
// calculatedTotalDesi = sum(line.quantity × resolveLineUnitDesi(line))
// Kaynak önceliği: order_line → product_variant → product_cache →
// merchant_mapping → category_default → tenant_default. Manuel giriş
// TOPLAM koli desisidir (quantity ile çarpılmaz). Eksik desi sessizce
// varsayılmaz; tenant varsayılanı yoksa hesap bloklanır. Adet=1 (tek koli).
test('Ürün bazlı desi hesabı 12 senaryoluk sözleşmeyi karşılar', async (t) => {
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  })
  t.after(() => vite.close())

  const { calculateOrderDesi, resolveLineUnitDesi, normalizeTenantDesiConfig } =
    await vite.ssrLoadModule('/src/utils/orderDesi.ts')
  const { resolveNormalizedDesi } = await vite.ssrLoadModule(
    '/src/utils/desi.ts',
  )

  const line = (over = {}) => ({
    id: 'L1',
    productName: 'Tişört',
    sku: 'SKU-1',
    barcode: 'BC-1',
    quantity: 1,
    ...over,
  })
  const order = (items, extra = {}) => ({
    id: 'order-1',
    marketplace: 'Trendyol',
    externalOrderId: 'EXT-1',
    orderNumber: '11400000001',
    customerName: 'Test',
    customerPhone: '',
    customerEmail: '',
    address: '',
    city: '',
    district: '',
    totalAmount: 0,
    createdAt: '2026-07-18T00:00:00.000Z',
    marketplaceStatus: 'Created',
    operationStatus: 'READY_TO_SHIP',
    source: 'real',
    status: 'Yeni',
    items,
    ...extra,
  })
  const product = (over = {}) => ({
    id: 'p-1',
    marketplace: 'Trendyol',
    productName: 'Tişört',
    sku: 'SKU-1',
    barcode: 'BC-1',
    productMainId: 'MODEL-1',
    stock: 0,
    price: 0,
    source: 'real',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...over,
  })

  // 1) Tek satır: satır desisi aynen birim desi olur (order_line kaynağı).
  const single = calculateOrderDesi(order([line({ desi: 2 })]), [])
  assert.equal(single.calculatedTotalDesi, 2)
  assert.equal(single.finalDesi, 2)
  assert.equal(single.finalDesiSource, 'product_lines')
  assert.equal(single.lines[0].unitDesiSource, 'order_line')
  assert.equal(single.blockedReason, null)

  // 2) Çok ürünlü sipariş: sabit "desi 2" değil, satırların toplamı.
  const multi = calculateOrderDesi(
    order([
      line({ id: 'L1', desi: 1.5 }),
      line({ id: 'L2', sku: 'SKU-2', barcode: 'BC-2', desi: 3 }),
    ]),
    [],
  )
  assert.equal(multi.calculatedTotalDesi, 4.5)

  // 3) Adet çarpanı: 3 × 2 = 6.
  const quantity = calculateOrderDesi(
    order([line({ quantity: 3, desi: 2 })]),
    [],
  )
  assert.equal(quantity.calculatedTotalDesi, 6)
  assert.equal(quantity.lines[0].lineTotalDesi, 6)

  // 4) Satırda desi yok → ürün cache eşleşmesi (barkod = varyant düzeyi).
  const fromCache = calculateOrderDesi(order([line({ quantity: 2 })]), [
    product({ desi: 2.5 }),
  ])
  assert.equal(fromCache.lines[0].unitDesiSource, 'product_variant')
  assert.equal(fromCache.calculatedTotalDesi, 5)

  // 5) Satır + cache desisi yok → satıcı varyant override'ı (merchant_mapping).
  const variantOverride = calculateOrderDesi(
    order([line()]),
    [product()],
    { variantOverrides: { 'BC-1': 4 } },
  )
  assert.equal(variantOverride.lines[0].unitDesiSource, 'merchant_mapping')
  assert.equal(variantOverride.finalDesi, 4)

  // 6) Ürün (sku) override'ı da merchant_mapping olarak çözülür.
  const productOverride = calculateOrderDesi(
    order([line()]),
    [],
    { productOverrides: { 'sku-1': 1.25 } },
  )
  assert.equal(productOverride.lines[0].unitDesiSource, 'merchant_mapping')
  assert.equal(productOverride.finalDesi, 1.25)

  // 7) Kategori varsayılanı: eşleşen ürünün kategorisi üzerinden.
  const category = calculateOrderDesi(
    order([line()]),
    [product({ category: 'Ayakkabı' })],
    { categoryDefaults: { Ayakkabı: 3.5 } },
  )
  assert.equal(category.lines[0].unitDesiSource, 'category_default')
  assert.equal(category.finalDesi, 3.5)

  // 8) Tenant varsayılanı son çare olarak kullanılır.
  const tenantDefault = calculateOrderDesi(order([line({ quantity: 2 })]), [], {
    defaultUnitDesi: 1,
  })
  assert.equal(tenantDefault.lines[0].unitDesiSource, 'tenant_default')
  assert.equal(tenantDefault.finalDesi, 2)

  // 9) Hiçbir kaynak yoksa toplam HESAPLANMAZ ve eksik ürün raporlanır.
  const blocked = calculateOrderDesi(
    order([line({ desi: 2 }), line({ id: 'L2', sku: 'SKU-2', barcode: 'BC-2' })]),
    [],
  )
  assert.equal(blocked.finalDesi, null)
  assert.equal(blocked.calculatedTotalDesi, null)
  assert.equal(blocked.blockedReason, '1 ürünün desi bilgisi eksik.')
  assert.equal(blocked.missingLines.length, 1)
  assert.equal(blocked.missingLines[0].sku, 'SKU-2')

  // 10) Manuel giriş = TOPLAM koli desisi; hesap 6 olsa bile 7 kullanılır
  //     ve quantity ile TEKRAR ÇARPILMAZ. Eski 'manual' kayıtları da geçerli.
  const manual = calculateOrderDesi(
    order([line({ quantity: 3, desi: 2 })], {
      desi: 7,
      desiSource: 'manual_total',
    }),
    [],
  )
  assert.equal(manual.finalDesi, 7)
  assert.equal(manual.finalDesiSource, 'manual_total')
  assert.equal(manual.calculatedTotalDesi, 6)
  const legacyManual = calculateOrderDesi(
    order([line({ desi: 2 })], { desi: 5, desiSource: 'manual' }),
    [],
  )
  assert.equal(legacyManual.finalDesi, 5)
  assert.equal(legacyManual.finalDesiSource, 'manual_total')

  // 11) Tekrarlanan lineId bir kez sayılır; iptal edilen satır toplama girmez.
  const duplicates = calculateOrderDesi(
    order([
      line({ desi: 2 }),
      line({ desi: 2 }),
      line({
        id: 'L3',
        sku: 'SKU-3',
        barcode: 'BC-3',
        desi: 9,
        rawLine: { orderLineItemStatusName: 'Cancelled' },
      }),
      line({ id: 'L4', sku: 'SKU-4', barcode: 'BC-4', desi: 3, quantity: 0 }),
    ]),
    [],
  )
  assert.equal(duplicates.calculatedTotalDesi, 2)
  assert.equal(
    duplicates.lines.filter((item) => item.excludedReason === 'duplicate_line')
      .length,
    1,
  )
  assert.equal(
    duplicates.lines.filter((item) => item.excludedReason === 'cancelled_line')
      .length,
    2,
  )
  // İptal edilen satırın desisi eksik olsa bile hesap bloklanmaz.
  const cancelledMissing = calculateOrderDesi(
    order([
      line({ desi: 2 }),
      line({
        id: 'L9',
        sku: 'SKU-9',
        barcode: 'BC-9',
        rawLine: { orderLineItemStatusName: 'İptal Edildi' },
      }),
    ]),
    [],
  )
  assert.equal(cancelledMissing.finalDesi, 2)

  // 12) Yuvarlama + tek koli sözleşmesi + normalize akış uyumu.
  const rounding = calculateOrderDesi(
    order([line({ quantity: 3, desi: 0.33 })]),
    [],
  )
  assert.equal(rounding.calculatedTotalDesi, 0.99)
  assert.equal(rounding.parcelCount, 1)
  // resolveLineUnitDesi rawLine.dimensionalWeight değerini satır kaynağı sayar.
  const rawLineUnit = resolveLineUnitDesi(
    line({ rawLine: { dimensionalWeight: '1,5' } }),
    [],
    normalizeTenantDesiConfig(null),
  )
  assert.equal(rawLineUnit.unitDesi, 1.5)
  assert.equal(rawLineUnit.unitDesiSource, 'order_line')
  // resolveNormalizedDesi da satır toplamını (ilk ürünün desisini değil)
  // kullanır ve create sonrası 'product_lines' kaynağını aynen taşır.
  const normalizedSum = resolveNormalizedDesi(
    order([
      line({ quantity: 2, desi: 2 }),
      line({ id: 'L2', sku: 'SKU-2', barcode: 'BC-2', desi: 1 }),
    ]),
  )
  assert.equal(normalizedSum.desi, 5)
  assert.equal(normalizedSum.desiSource, 'product_lines')
  const normalizedPartial = resolveNormalizedDesi(
    order([
      line({ desi: 2 }),
      line({ id: 'L2', sku: 'SKU-2', barcode: 'BC-2' }),
    ]),
  )
  assert.equal(normalizedPartial.desi, null)
  const normalizedPersisted = resolveNormalizedDesi(
    order([], { desi: 4.5, desiSource: 'product_lines' }),
  )
  assert.equal(normalizedPersisted.desi, 4.5)
  assert.equal(normalizedPersisted.desiSource, 'product_lines')
})
