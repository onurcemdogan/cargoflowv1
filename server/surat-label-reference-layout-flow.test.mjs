import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Referans Sürat etiketine göre HTML etiket yerleşimi.
//
// KAPSAM: bu dosya CargoFlow'un KENDİ HTML etiketini (önizleme + tarayıcı
// baskısı) doğrular. Sürat'in RESMÎ ZPL'i bu yoldan GEÇMEZ ve DEĞİŞTİRİLMEZ;
// ZPL sözleşmesi surat-label-template-desi-flow.test.mjs'de kilitlidir.
//
// Veriler SENTETİKTİR; gerçek müşteri bilgisi YOKTUR.

const here = dirname(fileURLToPath(import.meta.url))
let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const TNO = '25220148446193'
const BARCODE = '01231201025'
const ORDER_NO = '7270032941525232'

function shipment() {
  return {
    provider: 'surat-kargo',
    trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
    barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
    ozelKargoTakipNo: ORDER_NO,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    zplReady: true, printEnabled: true,
    barcodeRaw:
      `^XA^PW799^LL799^FO60,120^BCN,140,Y,N,N^FD${BARCODE}^FS` +
      `^FO500,20^A0N,26,26^FDT.No: ${TNO}^FS^XZ`,
  }
}
function order(items) {
  return {
    id: 'o1', orderNumber: ORDER_NO, packageId: 'PKG1',
    cargoTrackingNumber: ORDER_NO,
    operationStatus: 'LABEL_READY', labelStatus: 'READY',
    customerName: 'YAGMUR DIKMEN', customerPhone: '5410000000',
    city: 'KASTAMONU', district: 'ARAC',
    address: 'YENI MAH KASTAMONU CADDESI NO 113/B',
    desi: 2, desiSource: 'manual_total',
    items, shipment: shipment(),
  }
}
const TEMPLATE = {
  id: 't', widthMm: 100, heightMm: 100,
  widthDots: 799, heightDots: 799, fields: [],
}
const SINGLE = [{
  id: 'l1', quantity: 1,
  productName: 'Zara Saten Tesettür Elbise Drapeli Uzun Abiye Elbise Şık Özel Gün',
  color: 'Lacivert', size: '40', sku: 'ttzeyna44',
}]
const MULTI = [
  ...SINGLE,
  { id: 'l2', quantity: 2, productName: 'Pantolon Modeli', color: 'Mavi', size: '42', sku: 'pnt77' },
]

async function html(items) {
  const { buildCleanLabelHtml } = await load('/src/utils/browserLabelPrint.ts')
  return buildCleanLabelHtml([order(items)], TEMPLATE)
}

// ── 1D barkod geometrisi (referansın en kritik farkı) ─────────────────────

test('REF-1: 1D barkod yatayda sağa/sola yayılır (dar sıkışık kalmaz)', async () => {
  const out = await html(SINGLE)
  // Kapsayıcı yan boşluğu yalnız fiziksel kenar payıdır; ISO 10X sessiz alan
  // SVG viewBox'ının İÇİNDE taşınır (bkz. REF-16).
  assert.match(out, /\.surat-barcode \{[^}]*padding: \.4mm 1mm 0/)
  assert.equal(/padding: \.5mm 6mm 0/.test(out), false, 'eski dar yerleşim kalmadı')
  // SVG kutusu tam genişlik.
  assert.match(out, /\.surat-barcode svg \{ width: 100%/)
})

test('REF-2: barkod SVG esnek ölçeklenir (viewBox + preserveAspectRatio=none)', async () => {
  const { renderPrintableLabelHtml } = await load('/src/utils/browserLabelPrint.ts')
  const { buildLabelData } = await load('/src/utils/labelData.ts')
  const data = buildLabelData(order(SINGLE), shipment(), TEMPLATE)
  const out = renderPrintableLabelHtml({ ...data, barcodeValue: BARCODE })
  // DOM yokken stub üretilir; sözleşme (esnek ölçekleme) yine de görünür olmalı.
  assert.match(out, /preserveAspectRatio="none"/)
  // Esnek ölçekleme + sessiz alan ORTAK yardımcıda tanımlıdır.
  const src = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  assert.match(src, /applyScalableQuietZone\(svg, BARCODE_MODULE_WIDTH\)/)
  const helper = readFileSync(join(here, '..', 'src/utils/barcodeQuietZone.ts'), 'utf8')
  assert.match(helper, /svg\.setAttribute\('viewBox', viewBox\)/)
  assert.match(helper, /svg\.removeAttribute\('width'\)/)
  assert.match(helper, /svg\.setAttribute\('preserveAspectRatio', 'none'\)/)
  // Number() birimli "247px" değerinde NaN verir — parseFloat ZORUNLU.
  assert.match(helper, /Number\.parseFloat/)
})

test('REF-3: barkod/QR/T.No payload DEĞİŞMEZ (yalnız geometri değişti)', async () => {
  const out = await html(SINGLE)
  assert.ok(out.includes(`data-barcode-value="${BARCODE}"`), '1D payload aynı')
  assert.ok(out.includes(`T.No: <strong>${TNO}</strong>`), 'T.No aynı')
  assert.ok(out.includes(ORDER_NO), 'QR payload (ozelKargoTakipNo) aynı')
})

// ── blok düzeni ───────────────────────────────────────────────────────────

test('REF-4: sol dikey kolon dar ve kompakt', async () => {
  const out = await html(SINGLE)
  assert.match(out, /grid-template-columns: 7mm minmax\(0, 1fr\)/)
  assert.match(out, /<strong>SURAT KARGO<\/strong>/)
  assert.match(out, /Siparis No: 7270032941525232/)
})

test('REF-5: üst blok — solda Şube/gönderici/MUST.IRS.NO, sağda T.No/TEL', async () => {
  const out = await html(SINGLE)
  const header = out.slice(out.indexOf('surat-header"'), out.indexOf('surat-barcode"'))
  assert.match(header, /Şube:/)
  assert.match(header, /MUST\.IRS\.NO/)
  assert.match(header, /T\.No:/)
  assert.match(header, /TEL:/)
  // Alıcı üst blokta TEKRAR ETMEZ (yalnız adres kutusunda).
  assert.equal(/YAGMUR DIKMEN/.test(header), false, 'alıcı üst blokta yok')
})

test('REF-6: adres kutusunda gereksiz sağ bölme YOK; alt satır TEL | il/ilçe', async () => {
  const out = await html(SINGLE)
  assert.equal(/surat-route/.test(out), false, 'sağdaki anlamsız kutu kaldırıldı')
  assert.match(out, /\.surat-address \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/)
  const addr = out.slice(out.indexOf('surat-address '), out.indexOf('surat-cargo"'))
  assert.match(addr, /YAGMUR DIKMEN/, 'alıcı adı')
  assert.match(addr, /surat-address-footer/)
  const footer = addr.slice(addr.indexOf('surat-address-footer'))
  // Solda telefon, sağda il/ilçe.
  assert.ok(
    footer.indexOf('surat-address-phone') < footer.indexOf('surat-address-region'),
    'telefon solda, il/ilçe sağda',
  )
  assert.match(footer, /KASTAMONU \/ ARAC/)
})

test('REF-7: ödeme/birim/desi satırı sade ve bölmesiz', async () => {
  const out = await html(SINGLE)
  assert.match(out, /<span>OdemeTipi<\/span>/)
  assert.match(out, /<span>Birim<\/span>/)
  assert.match(out, /<span>Top Ds\/Kg<\/span>/)
  assert.equal(
    /\.surat-cargo div \{[^}]*border-right/.test(out), false,
    'hücreler arası dikey ayraç kaldırıldı',
  )
  assert.match(out, />2,00</, 'referanstaki gibi virgüllü desi gösterimi')
})

test('REF-8: rota alanı — büyük QR, Parça Adedi, 1/1, Adrese Teslim, rota, aktarma, ikinci QR', async () => {
  const out = await html(SINGLE)
  // NOT: sınırlar tırnakla aranır; tırnaksız arama <head> içindeki CSS
  // bloğuna denk gelip boş dilim döndürür.
  const zone = out.slice(out.indexOf('surat-delivery"'), out.indexOf('surat-product"'))
  assert.ok(zone.length > 0, 'rota bölgesi bulundu')
  assert.match(zone, /surat-qr-large/)
  assert.match(zone, /Parca Adedi/)
  assert.match(zone, /1 \/ 1/)
  assert.match(zone, /Adrese Teslim/)
  assert.match(zone, /surat-transfer/)
  assert.match(zone, /surat-qr-small/)
  assert.ok(
    zone.indexOf('surat-qr-large') < zone.indexOf('surat-qr-small'),
    'büyük QR solda, küçük QR sağda',
  )
})

// ── alt ürün alanı (referansın ikinci kritik farkı) ───────────────────────

test('REF-9: ürün satırı referans biçiminde — "(Renk: X, Beden: Y) [SKU]"', async () => {
  const out = await html(SINGLE)
  assert.match(out, /1 x Zara Saten Tesett/, '1. satır: {adet} x {tam ad}')
  assert.ok(
    out.includes('(Renk: Lacivert, Beden: 40) [ttzeyna44]'),
    '2. satır referans biçimi',
  )
  assert.equal(/Renk: Lacivert \| Beden/.test(out), false, 'eski "|" biçimi kalmadı')
  assert.equal(/SKU: ttzeyna44/.test(out), false, 'eski "SKU:" öneki kalmadı')
})

test('REF-10: eksik alanlarda boş parantez/köşeli parantez BASILMAZ', async () => {
  const out = await html([{ id: 'l1', quantity: 1, productName: 'Sade Ürün' }])
  assert.match(out, /1 x Sade Ürün/)
  assert.equal(/\(\)/.test(out), false, 'boş parantez yok')
  assert.equal(/\[\]/.test(out), false, 'boş köşeli parantez yok')
})

test('REF-11: çoklu üründe ÖZET DEĞİL tam detay; "+X ürün daha" YOK', async () => {
  const out = await html(MULTI)
  assert.equal(/ürün daha/.test(out), false, '"+X ürün daha" üretilmez')
  assert.ok(out.includes('(Renk: Lacivert, Beden: 40) [ttzeyna44]'), '1. ürün tam')
  assert.ok(out.includes('(Renk: Mavi, Beden: 42) [pnt77]'), '2. ürün tam (SKU dahil)')
  assert.match(out, /2 x Pantolon Modeli/)
})

test('REF-12: tek ürün de çoklu ürün de TEK etiket üretir (devam sayfası yok)', async () => {
  for (const [name, items] of [['tek', SINGLE], ['çoklu', MULTI]]) {
    const out = await html(items)
    assert.equal(
      (out.match(/class="label-page"/g) ?? []).length, 1,
      `${name} ürün senaryosunda tek sayfa`,
    )
    assert.equal(/SIPARIS URUNLERI/.test(out), false, `${name}: devam etiketi yok`)
  }
})

// ── önizleme ile baskı aynı sözleşmede ────────────────────────────────────

test('REF-13: ekran önizlemesi ile baskı aynı ürün-meta ve adres sözleşmesini kullanır', () => {
  const preview = readFileSync(
    join(here, '..', 'src/components/LabelHtmlPreview.tsx'), 'utf8',
  )
  // Aynı referans biçimi.
  assert.match(preview, /\(\$\{attrs\.join\(', '\)\}\)/)
  assert.match(preview, /\[\$\{item\.sku\}\]/)
  // Aynı adres düzeni: sağ bölme yok, alt satır TEL | il/ilçe.
  assert.equal(/surat-address-route/.test(preview), false)
  assert.match(preview, /surat-address-footer/)
  assert.match(preview, /surat-address-region/)
  const css = readFileSync(join(here, '..', 'src/index.css'), 'utf8')
  assert.equal(/^\.surat-address-route \{/m.test(css), false, 'ölü kural kalmadı')
  assert.match(css, /\.surat-address-footer/)
})

test('REF-14: "Desi Gir" butonu geri gelmedi', () => {
  for (const rel of [
    'src/components/OrdersTable.tsx',
    'src/components/OrderDetailDrawer.tsx',
    'src/components/LabelPreviewModal.tsx',
    'src/pages/OrdersPage.tsx',
  ]) {
    const src = readFileSync(join(here, '..', rel), 'utf8')
    assert.equal(/>\s*Desi Gir\s*</.test(src), false, `"Desi Gir" geri geldi: ${rel}`)
  }
})

test('REF-15: Sürat resmî ZPL yolu bu değişiklikten ETKİLENMEZ', async () => {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const ord = order(SINGLE)
  const label = await new ZebraZplLabelProvider().generateSingle({
    order: ord, shipment: ord.shipment, template: { id: 't' },
    desiConfig: { defaultUnitDesi: null },
  })
  // ZPL hâlâ provider'ın kendi çıktısı, byte-for-byte.
  assert.equal(label.zplContent, ord.shipment.barcodeRaw)
  assert.equal(label.zplSource, 'surat.ortakBarkod.BarcodeRaw')
  assert.equal((label.zplContent.match(/\^XA/g) ?? []).length, 1)
  // HTML tarafındaki referans biçimi ZPL'e SIZMAZ.
  assert.equal(/Renk:/.test(label.zplContent), false)
})

// ── sessiz alan (quiet zone) — ISO/IEC 15417 Code128 ──────────────────────

test('REF-16: sessiz alan viewBox\'a gömülür ve 10X oranı ölçekten BAĞIMSIZ korunur', async () => {
  const { applyScalableQuietZone, CODE128_QUIET_ZONE_MODULES, describeQuietZone } =
    await load('/src/utils/barcodeQuietZone.ts')
  assert.equal(CODE128_QUIET_ZONE_MODULES, 10)

  // JsBarcode'un GERÇEK davranışı: width/height BİRİMLİ ("247px") yazılır ve
  // kendi viewBox'ı da bulunur. Number() bunu NaN yapar → parseFloat şart.
  const attrs = new Map([['width', '247px'], ['height', '91px'], ['viewBox', '0 0 247 91']])
  const svg = {
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
  }
  const res = applyScalableQuietZone(svg, 2.2)
  assert.equal(res.applied, true, 'birimli width ile de uygulanmalı')
  assert.equal(res.quietZoneUnits, 22, '10 modül x 2.2 birim')
  assert.equal(attrs.get('viewBox'), '-22 0 291 91')
  assert.equal(attrs.get('preserveAspectRatio'), 'none')
  assert.equal(attrs.has('width'), false, 'sabit width kaldırılmalı')
  assert.equal(attrs.has('height'), false)

  // Birimsiz width + viewBox yokken de çalışmalı.
  const bare = new Map([['width', '247'], ['height', '91']])
  const svg2 = {
    getAttribute: (k) => (bare.has(k) ? bare.get(k) : null),
    setAttribute: (k, v) => bare.set(k, String(v)),
    removeAttribute: (k) => bare.delete(k),
  }
  assert.equal(applyScalableQuietZone(svg2, 2.2).applied, true)
  assert.equal(bare.get('viewBox'), '-22 0 291 91')

  // Ölçüm: 90mm kapsayıcıda 112 modül → 10X sessiz alan.
  const d = describeQuietZone(90, 112)
  assert.ok(Math.abs(d.quietZoneMm - 10 * d.moduleMm) < 1e-9, 'tam 10X')
  assert.ok(d.moduleDots > 4 && d.moduleDots < 7, `X=${d.moduleDots} nokta makul`)
  // Sessiz alan barkod uzunluğundan bağımsız olarak 10X kalır.
  for (const modules of [90, 112, 134]) {
    const x = describeQuietZone(90, modules)
    assert.ok(Math.abs(x.quietZoneMm / x.moduleMm - 10) < 1e-9, `${modules} modül`)
  }
})

test('REF-17: sabit mm yan boşluk 10X sessiz alanı SAĞLAMAZ (regresyon kilidi)', async () => {
  const { describeQuietZone } = await load('/src/utils/barcodeQuietZone.ts')
  // Gövde 93mm. Sabit 1.5mm boşlukla çubuk alanı 90mm → 112 modülde X=0.804mm,
  // gereken sessiz alan 8.04mm. 1.5mm yalnız 1.9X eder → YETERSİZ.
  const barsOnlyX = 90 / 112
  assert.ok(1.5 / barsOnlyX < 2, 'sabit 1.5mm ~1.9X kalır')
  // viewBox'a gömülü modelde aynı 90mm kapsayıcıda oran tam 10X'tir.
  const d = describeQuietZone(90, 112)
  assert.ok(d.quietZoneMm > 6 && d.quietZoneMm < 8, `${d.quietZoneMm.toFixed(2)}mm`)
  assert.ok(d.barsMm > 70, 'çubuklar yine de geniş alana yayılır')
})

test('REF-18: önizleme ve baskı AYNI sessiz alan yardımcısını kullanır', () => {
  const print = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  const preview = readFileSync(join(here, '..', 'src/components/BarcodePreview.tsx'), 'utf8')
  for (const [name, src] of [['baskı', print], ['önizleme', preview]]) {
    assert.match(src, /applyScalableQuietZone/, `${name} ortak yardımcıyı kullanmalı`)
    assert.match(src, /margin: 0|margin = 0/, `${name}: JsBarcode margin'i devre dışı`)
  }
})
