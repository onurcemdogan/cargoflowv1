import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Ürün meta eşlemesi (renk / beden / SKU) + 1D barkod insan-okunur sayısının
// ayırıcı çizgiyle çakışmaması. Veriler SENTETİKTİR.

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
after(async () => { if (_vite) await _vite.close() })

const meta = () => load('/src/utils/labelProductMetadata.ts')
const fit = () => load('/src/utils/labelProductFit.ts')

async function line(item) {
  const { resolveLabelProductMetadata } = await meta()
  const { buildProductTitleText, buildProductMetaText } = await fit()
  const r = resolveLabelProductMetadata(item)
  const shaped = {
    productName: r.productName,
    quantity: item.quantity ?? 1,
    color: r.color,
    size: r.size,
    sku: r.sku,
  }
  return {
    resolved: r,
    title: buildProductTitleText(shaped),
    meta: buildProductMetaText(shaped),
  }
}

// ── canlı hata senaryoları ────────────────────────────────────────────────

test('PM-1: canlı hata #1 — serbest metin SKU alanına DÜŞMEZ', async () => {
  const out = await line({
    productName: 'Taşlı Simli Tesettür Abiye SECIL-334, 36',
    quantity: 1,
    merchantSku: 'taşlı',
  })
  assert.equal(out.title, '1 x Taşlı Simli Tesettür Abiye', 'başlıktaki ek temizlendi')
  assert.equal(out.resolved.sku, 'SECIL-334')
  assert.equal(out.resolved.size, '36')
  assert.equal(out.meta.includes('[taşlı]'), false, '"[taşlı]" YOK')
  assert.match(out.meta, /\[SECIL-334\]/)
  assert.match(out.meta, /Beden: 36/)
  assert.equal(/SECIL-334, 36/.test(out.title), false, 'ad içinde tekrar yok')
})

test('PM-2: canlı hata #2 — literal "merchantSku" ASLA basılmaz', async () => {
  const out = await line({
    productName: 'Seçil Simli Tesettür Abiye Lacivert SECIL-334, 38',
    quantity: 1,
    merchantSku: 'merchantSku',
  })
  assert.equal(out.meta.includes('[merchantSku]'), false, '"[merchantSku]" YOK')
  assert.equal(out.title, '1 x Seçil Simli Tesettür Abiye')
  assert.equal(out.resolved.color, 'Lacivert')
  assert.equal(out.resolved.size, '38')
  assert.equal(out.resolved.sku, 'SECIL-334')
  assert.equal(out.meta, '(Renk: Lacivert, Beden: 38) [SECIL-334]')
})

// ── kaynak önceliği ───────────────────────────────────────────────────────

test('PM-3: yapısal alanlar önce gelir', async () => {
  const out = await line({
    productName: 'Saten Elbise',
    quantity: 1,
    color: 'Lacivert',
    size: '40',
    merchantSku: 'SECIL-334',
  })
  assert.equal(out.meta, '(Renk: Lacivert, Beden: 40) [SECIL-334]')
  assert.deepEqual(out.resolved.sources, {
    color: 'field',
    size: 'field',
    sku: 'merchantSku',
  })
})

test('PM-4: variantAttributes ikinci öncelik (Renk/Beden/Color/Size)', async () => {
  for (const [c, s] of [['Renk', 'Beden'], ['Color', 'Size'], ['renk', 'numara']]) {
    const out = await line({
      productName: 'Saten Elbise',
      quantity: 1,
      merchantSku: 'SECIL-334',
      variantAttributes: [
        { name: c, value: 'Bordo' },
        { name: s, value: '38' },
      ],
    })
    assert.equal(out.meta, '(Renk: Bordo, Beden: 38) [SECIL-334]', `${c}/${s}`)
    assert.equal(out.resolved.sources.color, 'variantAttribute')
  }
})

test('PM-5: SKU adayları sırayla denenir, kod biçimi doğrulanır', async () => {
  const { looksLikeSkuCode } = await meta()
  assert.equal(looksLikeSkuCode('SECIL-334'), true)
  assert.equal(looksLikeSkuCode('ttzeyna44'), true)
  assert.equal(looksLikeSkuCode('taşlı'), false, 'serbest metin kod değil')
  assert.equal(looksLikeSkuCode('36'), false, 'saf sayı beden, SKU değil')
  assert.equal(looksLikeSkuCode('Kırmızı Elbise'), false, 'boşluklu metin')
  const viaStock = await line({
    productName: 'Ürün',
    quantity: 1,
    merchantSku: 'sku',
    stockCode: 'STK-77',
  })
  assert.equal(viaStock.resolved.sku, 'STK-77')
  assert.equal(viaStock.resolved.sources.sku, 'stockCode')
})

// ── eksik alanlar / placeholder yasağı ────────────────────────────────────

// SÖZLEŞME GÜNCELLENDİ (canlı gözlem): eksik renk/beden ARTIK sessizce
// atılmaz. Bazı etiketlerde "(Beden: 42)", bazılarında "(Renk: X, Beden: Y)"
// çıkması TUTARSIZDI. Yeni kural: renk ve beden HER satırda yazılır; tüm
// güvenilir kaynaklar denendikten sonra bulunamayan alan "Belirtilmemiş"
// olarak GÖSTERİLİR (sahte renk ÜRETİLMEZ). Boş "()" ve boş "[]" hâlâ YASAK.
test('PM-6: eksik alanlarda boş parantez / boş köşeli parantez BASILMAZ', async () => {
  const noSku = await line({ productName: 'Ürün', quantity: 1, color: 'Mavi', size: '36' })
  assert.equal(noSku.meta, '(Renk: Mavi, Beden: 36)')
  const noColor = await line({
    productName: 'Ürün', quantity: 1, size: '36', merchantSku: 'SECIL-334',
  })
  assert.equal(noColor.meta, '(Renk: Belirtilmemiş, Beden: 36) [SECIL-334]')
  const noSize = await line({
    productName: 'Ürün', quantity: 1, color: 'Mavi', merchantSku: 'SECIL-334',
  })
  assert.equal(noSize.meta, '(Renk: Mavi, Beden: Belirtilmemiş) [SECIL-334]')
  const nothing = await line({ productName: 'Ürün', quantity: 1 })
  assert.equal(
    nothing.meta,
    '(Renk: Belirtilmemiş, Beden: Belirtilmemiş)',
    'hiç kaynak yoksa eksiklik AÇIKÇA gösterilir, satır gizlenmez',
  )
  for (const out of [noSku, noColor, noSize, nothing]) {
    assert.equal(/\(\)/.test(out.meta), false)
    assert.equal(/\[\]/.test(out.meta), false)
    assert.equal(/Renk:\s*(,|\)|$)/.test(out.meta), false, 'boş Renk yok')
    assert.equal(/Beden:\s*(,|\)|$)/.test(out.meta), false, 'boş Beden yok')
  }
})

test('PM-7: placeholder ve undefined/null değerler elenir', async () => {
  const { isPlaceholderValue } = await meta()
  const bad = [
    'merchantSku', 'sku', 'stockCode', 'undefined', 'null',
    'N/A', 'na', '-', '', '   ', 'color', 'size', 'renk', 'beden',
  ]
  for (const value of bad) {
    assert.equal(isPlaceholderValue(value), true, `placeholder: "${value}"`)
  }
  assert.equal(isPlaceholderValue('SECIL-334'), false)
  const out = await line({
    productName: 'Ürün',
    quantity: 1,
    color: undefined,
    size: null,
    merchantSku: 'undefined',
    sku: 'N/A',
    stockCode: 'null',
    productCode: '-',
  })
  // Placeholder değerler yine ELENİR; eksiklik "Belirtilmemiş" ile gösterilir
  // ve SKU bulunamadığı için köşeli parantez BASILMAZ.
  assert.equal(out.meta, '(Renk: Belirtilmemiş, Beden: Belirtilmemiş)')
  for (const token of ['undefined', 'null', 'N/A', 'merchantSku', 'sku']) {
    assert.equal(out.meta.includes(token), false, token)
  }
})

// ── ad temizleme güvenliği ────────────────────────────────────────────────

test('PM-8: ürün adının GERÇEK parçası silinmez', async () => {
  const out = await line({
    productName: 'Uzun Abiye Elbise',
    quantity: 1,
    color: 'Mavi',
    merchantSku: 'SECIL-334',
  })
  assert.equal(out.title, '1 x Uzun Abiye Elbise', 'ad dokunulmadan kalır')
  const plain = await line({ productName: 'Saten Elbise 2026 Model', quantity: 1 })
  assert.equal(plain.title, '1 x Saten Elbise 2026 Model')
})

test('PM-9: iki farklı ürün ve uzun ad — her ikisi de tam', async () => {
  const a = await line({
    productName: 'Taşlı Simli Tesettür Abiye SECIL-334, 36',
    quantity: 1, merchantSku: 'taşlı',
  })
  const b = await line({
    productName: 'Seçil Simli Tesettür Abiye Lacivert SECIL-334, 38',
    quantity: 2, merchantSku: 'merchantSku',
  })
  assert.match(a.meta, /\[SECIL-334\]/)
  assert.match(b.meta, /\[SECIL-334\]/)
  assert.equal(b.title.startsWith('2 x '), true, 'adet korunur')
  const long = await line({
    productName:
      'Zara Saten Tesettür Elbise Drapeli Uzun Abiye Şık Özel Gün ttzeyna44, 40',
    quantity: 1,
    color: 'Lacivert',
  })
  assert.equal(long.resolved.sku, 'ttzeyna44')
  assert.equal(long.resolved.size, '40')
  assert.equal(/ttzeyna44, 40/.test(long.title), false)
})

// ── 1D barkod: sayı ile ayırıcı çizgi ─────────────────────────────────────

test('PM-10: barkod sayısı ile ayırıcı çizgi arasında güvenli boşluk', async () => {
  const src = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  assert.match(src, /padding: \.4mm 1mm 2\.3mm;/)
  assert.equal(/padding: \.4mm 1mm 0;/.test(src), false, 'sıfır alt boşluk kalmadı')
  assert.match(src, /textMargin: 8,/)
  assert.equal(/textMargin: 3,/.test(src), false)
  const sec = src.slice(
    src.indexOf('.surat-barcode {'),
    src.indexOf('.surat-address {'),
  )
  assert.equal(/margin:\s*-/.test(sec), false, 'negatif margin yok')
  assert.match(sec, /overflow: visible/)
  const preview = readFileSync(
    join(here, '..', 'src/components/BarcodePreview.tsx'), 'utf8')
  assert.match(preview, /textMargin: 8,/)
  const css = readFileSync(join(here, '..', 'src/index.css'), 'utf8')
  const previewSec = css.slice(
    css.indexOf('.surat-barcode-section'),
    css.indexOf('.surat-main-barcode'),
  )
  assert.match(previewSec, /padding: 2px 6px 6px/)
})

test('PM-11: insan-okunur sayı payload ile BİREBİR aynı; baştaki 0 korunur', async () => {
  const { renderPrintableLabelHtml } = await load('/src/utils/browserLabelPrint.ts')
  const { buildLabelData } = await load('/src/utils/labelData.ts')
  for (const payload of ['01254856686', '0125485', '012548566861234']) {
    const data = buildLabelData(
      { id: 'o', orderNumber: '7270032941525232', packageId: 'P', items: [] },
      undefined,
      { id: 't', widthMm: 100, heightMm: 100, fields: [] },
    )
    const out = renderPrintableLabelHtml({ ...data, barcodeValue: payload })
    assert.ok(out.includes(`data-barcode-value="${payload}"`), payload)
    assert.equal(payload.startsWith('0'), true, 'fixture baştaki 0 taşır')
    // Değer STRING olarak taşınır: Number'a çevrilse baştaki 0 kaybolurdu.
    assert.notEqual(String(Number(payload)), payload, 'sayıya çevirmek 0 kaybettirir')
  }
})

test('PM-12: barkod yatay geometrisi DEĞİŞMEDİ (10X quiet zone korunur)', async () => {
  const { describeQuietZone, CODE128_QUIET_ZONE_MODULES } = await load(
    '/src/utils/barcodeQuietZone.ts')
  assert.equal(CODE128_QUIET_ZONE_MODULES, 10)
  const d = describeQuietZone(90, 112)
  assert.ok(Math.abs(d.quietZoneMm / d.moduleMm - 10) < 1e-9, 'tam 10X')
  assert.ok(d.barsMm > 70, 'çizgi alanı geniş kalır')
  const src = readFileSync(join(here, '..', 'src/utils/barcodeQuietZone.ts'), 'utf8')
  assert.match(src, /preserveAspectRatio', 'none'/)
})
