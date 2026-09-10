import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

// KİRACI VARSAYILAN DESİSİ — ÜRETİMDE GÖZLENEN SAPMA.
//
// ═══ ŞİKÂYET ═════════════════════════════════════════════════════════════
// Ayarlarda "Varsayılan Gönderi Desisi = 2" ve "Ürün adedine göre desiyi
// çarp" KAPALI olmasına rağmen sipariş 1.00 desiden işlem görüyordu.
//
// ═══ KÖK NEDEN ═══════════════════════════════════════════════════════════
// Pazaryeri, satıcı boyut girmediğinde gönderi satırına `dimensionalWeight`
// alanını YER TUTUCU bir değerle (tipik olarak 1) koyar. Satır eşleyicisi
// bunu `item.desi` olarak yazıyor, desi çözücüsü de OTORİTER satır desisi
// (`order_line`) sayıyordu. `order_line`, önceliğin en üstündeki satır
// kaynağıdır ve kiracının kendi ayarını SESSİZCE eziyordu.
//
// Bu paket, kiracı varsayılanının hangi durumlarda geçerli olduğunu ve
// hangi kaynakların onu MEŞRU biçimde ezdiğini kilitler.
//
// SAF: ağ yok, DB yok — yalnız kanonik hesap fonksiyonları.

let _vite
let calculateOrderDesi
let resolveLineUnitDesi
let normalizeTenantDesiConfig
let resolveNormalizedDesi

before(async () => {
  _vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ calculateOrderDesi, resolveLineUnitDesi, normalizeTenantDesiConfig } =
    await _vite.ssrLoadModule('/src/utils/orderDesi.ts'))
  ;({ resolveNormalizedDesi } = await _vite.ssrLoadModule(
    '/src/utils/desi.ts',
  ))
})
after(async () => {
  if (_vite) await _vite.close()
})

/** Kiracı ayarı: varsayılan 2, çarpan KAPALI (şikâyetteki yapılandırma). */
const TENANT = { defaultUnitDesi: 2, multiplyByItemQuantity: false }
const line = (over = {}) => ({
  id: 'L1',
  productName: 'Ürün',
  quantity: 1,
  ...over,
})
const order = (items, over = {}) => ({ id: 'O1', items, ...over })

const finalOf = (items, over = {}, products = [], config = TENANT) =>
  calculateOrderDesi(order(items, over), products, config).finalDesi

// ═══ DESI-DEFAULT-1..3: VARSAYILAN GERÇEKTEN UYGULANIR ═══════════════════

test('DESI-DEFAULT-1: override yok → kiracı varsayılanı (çarpan KAPALI)', () => {
  const calculation = calculateOrderDesi(order([line()]), [], TENANT)
  assert.equal(calculation.finalDesi, 2)
  assert.equal(calculation.lines[0].unitDesiSource, 'tenant_default')
  // Çarpan kapalıyken adet ile ÇARPILMAZ.
  assert.equal(finalOf([line({ quantity: 4 })]), 2)
})

test('DESI-DEFAULT-2: çarpan AÇIK → adet ile çarpılır', () => {
  const config = { defaultUnitDesi: 2, multiplyByItemQuantity: true }
  assert.equal(finalOf([line({ quantity: 3 })], {}, [], config), 6)
  assert.equal(finalOf([line()], {}, [], config), 2)
})

test('DESI-DEFAULT-3: pazaryeri boyutsal ağırlığı varsayılanı EZMEZ', () => {
  // ÜRETİMDE GÖZLENEN DURUM: satırda yalnız yer tutucu `dimensionalWeight`.
  for (const placeholder of [1, '1', '1,0', 0.5, 3]) {
    const resolved = resolveLineUnitDesi(
      line({ rawLine: { dimensionalWeight: placeholder } }),
      [],
      normalizeTenantDesiConfig(TENANT),
    )
    assert.equal(
      resolved.unitDesiSource,
      'tenant_default',
      `dimensionalWeight=${placeholder} satır kaynağı SAYILMAMALI`,
    )
    assert.equal(resolved.unitDesi, 2)
  }
  assert.equal(
    finalOf([line({ rawLine: { dimensionalWeight: 1 } })]),
    2,
    'toplam kiracı varsayılanından gelmeli',
  )
  // `volumetricWeight` de aynı sınıftadır.
  const volumetric = resolveLineUnitDesi(
    line({ rawLine: { volumetricWeight: 1 } }),
    [],
    normalizeTenantDesiConfig(TENANT),
  )
  assert.equal(volumetric.unitDesiSource, 'tenant_default')
})

// ═══ DESI-DEFAULT-4..7: MEŞRU ÖNCELİKLER KORUNUR ════════════════════════

test('DESI-DEFAULT-4: satırın AÇIK desi alanı varsayılanı ezer', () => {
  const calculation = calculateOrderDesi(
    order([line({ desi: 1 })]),
    [],
    TENANT,
  )
  assert.equal(calculation.lines[0].unitDesiSource, 'order_line')
  assert.equal(calculation.finalDesi, 1)
  // Ham satırdaki AÇIK `desi` alanı da geçerlidir.
  assert.equal(finalOf([line({ rawLine: { desi: 1.5 } })]), 1.5)
})

test('DESI-DEFAULT-5: ürün / varyant kataloğu varsayılanı ezer', () => {
  const calculation = calculateOrderDesi(
    order([line({ barcode: 'BC-1' })]),
    [{ barcode: 'BC-1', desi: 3 }],
    TENANT,
  )
  assert.equal(calculation.lines[0].unitDesiSource, 'product_variant')
  assert.equal(calculation.finalDesi, 3)
})

test('DESI-DEFAULT-6: ürün ve kategori geçersiz kılmaları doğru sırada', () => {
  const productOverride = calculateOrderDesi(
    order([line({ merchantSku: 'SKU-1' })]),
    [],
    { ...TENANT, productOverrides: { 'SKU-1': 4 } },
  )
  assert.equal(productOverride.lines[0].unitDesiSource, 'merchant_mapping')
  assert.equal(productOverride.finalDesi, 4)

  const categoryOverride = calculateOrderDesi(
    order([line({ rawLine: { categoryName: 'Abiye' } })]),
    [],
    { ...TENANT, categoryDefaults: { Abiye: 5 } },
  )
  assert.equal(categoryOverride.lines[0].unitDesiSource, 'category_default')
  assert.equal(categoryOverride.finalDesi, 5)
})

test('DESI-DEFAULT-7: MANUEL toplam en üstte kalır (kabul edilmiş kural)', () => {
  const calculation = calculateOrderDesi(
    order([line({ quantity: 3, desi: 2 })], {
      desi: 7,
      desiSource: 'manual_total',
    }),
    [],
    TENANT,
  )
  assert.equal(calculation.finalDesi, 7)
  assert.equal(calculation.finalDesiSource, 'manual_total')
  // Eski 'manual' damgası da geçerlidir.
  const legacy = calculateOrderDesi(
    order([line({ desi: 2 })], { desi: 5, desiSource: 'manual' }),
    [],
    TENANT,
  )
  assert.equal(legacy.finalDesi, 5)
})

// ═══ DESI-DEFAULT-8..9: YANLIŞ TÜRETME YOLLARI KAPALI ═══════════════════

test('DESI-DEFAULT-8: KİLOGRAM desi yerine kullanılmaz', () => {
  // `calculatePackageDesi` eskiden `max(hacim, weightKg)` dönüyordu:
  // 1.00 kg'lık gönderi "1.00 desi" gibi raporlanıyordu.
  const withWeight = resolveNormalizedDesi(order([line()], { weightKg: 1 }))
  assert.notEqual(withWeight.desi, 1, 'kg desi olarak dönmemeli')
  assert.equal(withWeight.desi, null)
  assert.equal(withWeight.weightKg, 1, 'ağırlık AYRI alan olarak korunur')
  // Kiracı varsayılanı yine uygulanır.
  assert.equal(finalOf([line()], { weightKg: 1 }), 2)

  // Hacim GERÇEKTEN biliniyorsa desi hesaplanır (en×boy×yükseklik/3000).
  const withDimensions = resolveNormalizedDesi(
    order([line({ lengthCm: 30, widthCm: 20, heightCm: 10 })]),
  )
  assert.equal(withDimensions.desi, 2)
  assert.equal(withDimensions.desiSource, 'calculated')
})

test('DESI-DEFAULT-9: kaynağı bilinmeyen kalıcı desi "manuel" SAYILMAZ', () => {
  // Kalıcılık katmanı etiketin "Top Ds/Kg" alanından `order.desi` yazabilir.
  // Türetilmiş bu değere "manuel" demek dökümde YANLIŞ köken göstermekti.
  const unsourced = resolveNormalizedDesi(order([line()], { desi: 1 }))
  assert.equal(unsourced.desiSource, null, 'köken UYDURULMAZ')
  assert.equal(unsourced.desi, 1, 'değer gizlenmez, yalnız kaynağı iddia edilmez')
  // Ve kiracı varsayılanını EZMEZ.
  assert.equal(finalOf([line()], { desi: 1 }), 2)
  // AÇIK manuel damgası ise aynen manuel kalır.
  const explicit = resolveNormalizedDesi(
    order([line()], { desi: 1, desiSource: 'manual' }),
  )
  assert.equal(explicit.desiSource, 'manual')
})

// ═══ DESI-DEFAULT-10: TEK OTORİTER SONUÇ ════════════════════════════════

test('DESI-DEFAULT-10: elle yol ile worker AYNI değeri çözer', async () => {
  // Tarayıcı `finalDesi` gönderir; sunucu çözücüsü eskiden
  // `calculatedTotalDesi` okuyordu ve MANUEL override'ı yok sayıyordu —
  // aynı siparişin iki farklı desisi oluşuyordu.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync('server/shipments/resolveShipmentDesi.ts', 'utf8'),
  )
  const body = source
    .split(/\r?\n/)
    .filter((row) => !row.trim().startsWith('//'))
    .join('\n')
  assert.match(
    body,
    /positive\(calculation\?\.finalDesi\)/,
    'sunucu çözücüsü kanonik finalDesi okumalı',
  )
  assert.doesNotMatch(
    body,
    /positive\(calculation\?\.calculatedTotalDesi\)/,
    'manuel override yok sayan okuma geri gelmemeli',
  )

  // Davranışsal karşılık: manuel override'lı siparişte iki değer aynıdır.
  const withManual = calculateOrderDesi(
    order([line({ desi: 2 })], { desi: 5, desiSource: 'manual_total' }),
    [],
    TENANT,
  )
  assert.equal(withManual.finalDesi, 5)
  assert.notEqual(
    withManual.calculatedTotalDesi,
    withManual.finalDesi,
    'iki alan GERÇEKTEN ayrışıyor — bu yüzden doğru olanı okunmalı',
  )
})
