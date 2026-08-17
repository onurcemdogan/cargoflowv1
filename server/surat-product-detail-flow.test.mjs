import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ÜRÜN DETAYI EK ETİKETİ — KARAR, SAYFALAMA VE SAYFA ÜRETİMİ.
//
// Bu paket ÇEKİRDEĞİ kilitler: hangi siparişin ek etiket gerektirdiği,
// sayfaların geometriye göre nasıl bölündüğü ve her ürünün TAM OLARAK BİR KEZ
// basıldığı. Persistence/serving/UI AYRI turlarda bağlanacak.
//
// KRİTİK SÖZLEŞMELER
//  - Karar ham adet veya ham satır sayısıyla DEĞİL, TOPLANMIŞ görüntü
//    satırlarıyla verilir.
//  - Ek sayfa İKİNCİ BİR KARGO ETİKETİ DEĞİLDİR: Sürat T.No, Code128,
//    DataMatrix ve 727 QR burada TEKRAR EDİLMEZ.
//  - Kırpma, kısaltma ve sessiz düşürme YOKTUR.

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

const mod = () => load('/src/utils/suratProductDetailLabel.ts')

const CONTEXT = {
  orderNumber: '1141234567890',
  packageId: '4057121401',
  recipient: 'ARIFE BOLSAGAR',
}

const item = (overrides = {}) => ({
  productName: 'Scuba Secil Detayli Tesettur Elbise',
  quantity: 1,
  color: 'Lacivert',
  size: '40',
  sku: 'SCUBA-SEC01',
  ...overrides,
})

/** n adet BİRBİRİNDEN FARKLI ürün üretir. */
const distinct = (n, extra = {}) =>
  Array.from({ length: n }, (_, index) =>
    item({
      productName: `Urun ${index + 1}`,
      sku: `SKU-${index + 1}`,
      ...extra,
    }),
  )

async function planOf(items) {
  const { planProductDetailPages } = await mod()
  return planProductDetailPages(items)
}

async function labelsOf(items) {
  const { planProductDetailPages, buildProductDetailLabels } = await mod()
  const plan = planProductDetailPages(items)
  return { plan, labels: buildProductDetailLabels(plan, CONTEXT) }
}

// ═══ PRODUCT-1..3: EŞİK ALTINDA — MEVCUT DAVRANIŞ ════════════════════════

test('PRODUCT-1: tek ürün → yalnız taşıyıcı etiketi', async () => {
  const plan = await planOf([item()])
  assert.equal(plan.required, false)
  assert.equal(plan.aggregated.length, 1)
  assert.equal(plan.pages.length, 0)
  assert.equal(plan.quantityTotal, 1)
})

test('PRODUCT-2: iki FARKLI ürün → yalnız taşıyıcı etiketi', async () => {
  const plan = await planOf(distinct(2))
  assert.equal(plan.required, false)
  assert.equal(plan.aggregated.length, 2)
  assert.equal(plan.pages.length, 0)
})

test('PRODUCT-3: aynı varyanttan 8 adet → TEK görüntü satırı, ek etiket YOK', async () => {
  // Ham adet 8, ham satır 8; ama TOPLANMIŞ satır 1 olduğu için eşik aşılmaz.
  const plan = await planOf(Array.from({ length: 8 }, () => item()))
  assert.equal(plan.aggregated.length, 1, 'katı toplama tek satıra indirir')
  assert.equal(plan.aggregated[0].quantity, 8, 'adetler toplanır')
  assert.equal(plan.required, false, 'ek etiket GEREKMEZ')
  assert.equal(plan.quantityTotal, 8)
})

// ═══ PRODUCT-4..5: EŞİK ÜSTÜ ═════════════════════════════════════════════

test('PRODUCT-4: üç FARKLI ürün → taşıyıcı + ek etiket', async () => {
  const { plan, labels } = await labelsOf(distinct(3))
  assert.equal(plan.required, true)
  assert.equal(plan.aggregated.length, 3)
  assert.ok(plan.pages.length >= 1)
  assert.ok(labels.length >= 1)
  assert.equal(labels[0].kind, 'product_detail')
})

test('PRODUCT-5: sekiz FARKLI ürün → taşıyıcı + N ek sayfa, hepsi eksiksiz', async () => {
  const { plan, labels } = await labelsOf(distinct(8))
  assert.equal(plan.required, true)
  assert.equal(plan.aggregated.length, 8)
  assert.ok(labels.length >= 1, 'en az bir ek sayfa')
  // Her sayfa TAM sayfa sözleşmesine uyar.
  for (const label of labels) {
    assert.equal((label.zpl.match(/\^XA/g) ?? []).length, 1)
    assert.equal((label.zpl.match(/\^XZ/g) ?? []).length, 1)
    assert.ok(label.zpl.includes('^PW799'))
    assert.ok(label.zpl.includes('^LL0799'))
    assert.equal(label.totalPages, labels.length)
  }
})

// ═══ PRODUCT-6..9: TOPLAMA KURALLARI ═════════════════════════════════════

test('PRODUCT-6: karışık adetler doğru toplanır', async () => {
  const plan = await planOf([
    item({ quantity: 2 }),
    item({ quantity: 3 }),
    item({ productName: 'Baska Urun', sku: 'SKU-B', quantity: 4 }),
  ])
  assert.equal(plan.aggregated.length, 2, 'iki farklı ürün')
  assert.equal(plan.aggregated[0].quantity, 5, '2 + 3')
  assert.equal(plan.aggregated[1].quantity, 4)
  assert.equal(plan.quantityTotal, 9)
  assert.equal(plan.required, false, 'iki satır eşiği aşmaz')
})

test('PRODUCT-7: farklı BEDEN birleşmez', async () => {
  const plan = await planOf([
    item({ size: '38' }),
    item({ size: '40' }),
    item({ size: '42' }),
  ])
  assert.equal(plan.aggregated.length, 3)
  assert.equal(plan.required, true)
})

test('PRODUCT-8: farklı RENK birleşmez', async () => {
  const plan = await planOf([
    item({ color: 'Siyah' }),
    item({ color: 'Beyaz' }),
    item({ color: 'Lacivert' }),
  ])
  assert.equal(plan.aggregated.length, 3)
  assert.equal(plan.required, true)
})

test('PRODUCT-9: farklı SKU birleşmez', async () => {
  const plan = await planOf([
    item({ sku: 'A-1' }),
    item({ sku: 'A-2' }),
    item({ sku: 'A-3' }),
  ])
  assert.equal(plan.aggregated.length, 3)
  assert.equal(plan.required, true)
})

// ═══ PRODUCT-10: UZUN ADLAR ══════════════════════════════════════════════

test('PRODUCT-10: uzun ürün adları GÜVENLE sayfalanır, kırpılmaz', async () => {
  const longName =
    'Scuba Kumas Secil Detayli Uzun Kollu Tesettur Abiye Elbise Ozel Dikim Koleksiyon'
  const items = Array.from({ length: 8 }, (_, index) =>
    item({
      productName: `${longName} Model ${index + 1}`,
      sku: `LONG-SKU-${index + 1}`,
      color: 'Koyu Lacivert Metalik',
      size: 'XXL / 46',
    }),
  )
  const { plan, labels } = await labelsOf(items)
  assert.equal(plan.reason, null, plan.reason ?? '')
  assert.equal(plan.aggregated.length, 8)
  assert.ok(labels.length >= 2, 'uzun adlar birden çok sayfa gerektirir')

  // KIRPMA/KISALTMA YOK: her ürün adının TAMAMI bir sayfada bulunmalı.
  const allZpl = labels.map((label) => label.zpl).join('\n')
  assert.equal(allZpl.includes('...'), false, 'ellipsis YOK')
  for (const entry of plan.aggregated) {
    for (const word of entry.productName.split(' ')) {
      assert.ok(allZpl.includes(word), `kelime kayboldu: ${word}`)
    }
  }
})

// ═══ PRODUCT-14..15: EKSİKSİZLİK VE SIRA ═════════════════════════════════

test('PRODUCT-14: her toplanmış ürün TAM OLARAK BİR KEZ basılır', async () => {
  for (const count of [3, 4, 5, 8, 12, 20]) {
    const { plan, labels } = await labelsOf(distinct(count))
    assert.equal(plan.reason, null, `${count}: ${plan.reason ?? ''}`)
    const blockTotal = plan.pages.reduce(
      (total, page) => total + page.blocks.length,
      0,
    )
    assert.equal(
      blockTotal,
      plan.aggregated.length,
      `${count} ürün: blok sayısı toplanmış satır sayısına EŞİT olmalı`,
    )
    // Her SKU tam bir kez geçer. SAYIM KÖŞELİ PARANTEZLİ TAM BİÇİMLE
    // yapılır: düz alt dize araması "SKU-1"i "SKU-10" içinde de sayardı.
    const allZpl = labels.map((label) => label.zpl).join('\n')
    for (const entry of plan.aggregated) {
      const token = `[${entry.sku}]`
      const occurrences = allZpl.split(token).length - 1
      assert.equal(occurrences, 1, `${token} tam bir kez geçmeli`)
    }
    // Plan düzeyinde de her ürün TEK blokta bulunur.
    const blockSkus = plan.pages.flatMap((page) =>
      page.blocks.map((block) => block.item.sku),
    )
    assert.equal(new Set(blockSkus).size, blockSkus.length, 'tekrar YOK')
  }
})

test('PRODUCT-15: sayfa sırası DETERMINISTIK ve tekrarlanabilir', async () => {
  const items = distinct(9)
  const first = await labelsOf(items)
  const second = await labelsOf(items)
  assert.equal(first.labels.length, second.labels.length)
  for (const [index, label] of first.labels.entries()) {
    assert.equal(label.page, index + 1, 'sayfa numaraları sıralı')
    assert.equal(label.zpl, second.labels[index].zpl, 'aynı girdi → aynı ZPL')
  }
  // Ürünler sayfalara GİRİŞ SIRASINDA dağıtılır.
  const flattened = first.plan.pages.flatMap((page) =>
    page.blocks.map((block) => block.item.sku),
  )
  assert.deepEqual(
    flattened,
    first.plan.aggregated.map((entry) => entry.sku),
  )
})

// ═══ EK SAYFA TAŞIYICI ETİKETİ DEĞİLDİR ══════════════════════════════════

test('PRODUCT-16: ek sayfa taşıyıcı kimliklerini TEKRAR ETMEZ', async () => {
  const { labels } = await labelsOf(distinct(5))
  const allZpl = labels.map((label) => label.zpl).join('\n')
  // Taşıyıcıya ait makine-okunur alanlar BURADA OLMAMALI.
  assert.equal((allZpl.match(/\^BX/g) ?? []).length, 0, 'DataMatrix YOK')
  assert.equal((allZpl.match(/\^BQ/g) ?? []).length, 0, 'QR YOK')
  assert.equal(allZpl.includes('>:'), false, 'Sürat Code128 subset-C YOK')
  // Dahili paket barkodu VAR ve açıkça etiketlenmiş.
  assert.ok(allZpl.includes(`^FD${CONTEXT.packageId}^FS`), 'paket barkodu')
  assert.ok(allZpl.includes('PAKET'), 'PAKET etiketi')
  // Başlık ve bağlam bilgisi.
  assert.ok(allZpl.includes('ÜRÜN DETAYI'))
  assert.ok(allZpl.includes(`Sipariş: ${CONTEXT.orderNumber}`))
  assert.ok(allZpl.includes(`Alıcı: ${CONTEXT.recipient}`))
})

test('PRODUCT-17: sayfa numaraları ve kalem sayısı başlıkta doğru', async () => {
  const { plan, labels } = await labelsOf(distinct(8))
  for (const label of labels) {
    assert.ok(
      label.zpl.includes(`Sayfa: ${label.page} / ${label.totalPages}`),
      'sayfa göstergesi',
    )
    assert.ok(
      label.zpl.includes(`Kalem: ${plan.aggregated.length}`),
      'kalem sayısı',
    )
    assert.ok(
      label.zpl.includes(`Toplam Adet: ${plan.quantityTotal}`),
      'toplam adet',
    )
  }
})

test('PRODUCT-18: boş/geçersiz ürün adları karara GİRMEZ', async () => {
  const plan = await planOf([
    item(),
    item({ productName: '   ', sku: 'BOS-1' }),
    item({ productName: '', sku: 'BOS-2' }),
  ])
  assert.equal(plan.aggregated.length, 1, 'yalnız geçerli ürün sayılır')
  assert.equal(plan.required, false)
})
