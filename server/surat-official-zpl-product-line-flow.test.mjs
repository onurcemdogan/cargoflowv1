import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// RESMÎ SÜRAT ZPL'İNE ÜRÜN SATIRI EKLEME.
//
// DuruSoft canlı çıktısında resmî Sürat etiketi AYNEN korunuyor; tek eklenen
// alan en alttaki ürün satırıdır:
//   "1 x Önü Drapeli Loş Tesettür Takım (Renk: Krem, Beden: 40) [6496]"
//
// SÖZLEŞME: technicalZpl kutsal kaynaktır (byte-for-byte korunur); türetilmiş
// printZpl kaynağın komutları + ürün satırı + orijinal ^PQ + orijinal ^XZ
// olur. Yerleşim kaynak ZPL'in KENDİ ölçümünden gelir (tahmin yok).
//
// Fixture'ların tamamı SENTETİKTİR: gerçek müşteri adı, adresi, telefonu,
// gerçek takip numarası veya gerçek provider ZPL'i İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

// ── SENTETİK resmî Sürat şablonu (DuruSoft görselindeki bölüm iskeleti) ────
function officialZpl(over = {}) {
  const route = over.route ?? 'KARACADAG/04'
  const transfer = over.transfer ?? 'DIYARBAKIR AKTARMA'
  const address = over.address ?? 'MAHALLE SOKAK NO ILCE IL'
  return [
    '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
    '^FO60,20^A0N,28,28^FDSube: FERAH^FS',
    '^FO470,20^A0N,26,26^FDT.No: 21012920014311^FS',
    '^FO60,58^A0N,26,26^FDGONDERICI AD^FS',
    '^FO60,90^A0N,20,20^FDMUST.IRS.NO^FS',
    '^FO520,120^A0N,20,20^FDTEL: 055*******^FS',
    '^FO60,150^BY3^BCN,150,Y,N,N^FD01254596670^FS',
    '^FO60,345^A0N,24,24^FDALICI AD^FS',
    `^FO60,375^A0N,18,18^FB700,3,0,L,0^FD${address}^FS`,
    '^FO60,445^A0N,18,18^FDTEL: 535*******^FS',
    '^FO560,445^A0N,20,20^FDIL / ILCE^FS',
    '^FO60,480^A0N,20,20^FDOdemeTipi  Birim   Top Ds/Kg^FS',
    '^FO60,510^A0N,30,30^FDPOCH   KOLI     2,00^FS',
    '^FO60,560^BXN,6,200^FD7270035184060553^FS',
    '^FO240,560^A0N,20,20^FDParca Adedi^FS',
    '^FO240,590^A0N,30,30^FD1 / 1   Adrese Teslim^FS',
    `^FO240,630^A0N,34,34^FD${route}^FS`,
    `^FO240,672^A0N,38,38^FD${transfer}^FS`,
    '^FO660,560^BQN,2,6^FDLA,01254596670^FS',
    '^FWB', '^FO24,340^A0N,18,18^FDSiparis No: 7270035184060553^FS', '^FWN',
    '^PQ1,0,1,Y',
    '^XZ',
  ].join('\n')
}

const DURUSOFT_ITEM = {
  productName: 'Önü Drapeli Loş Tesettür Takım',
  quantity: 1,
  color: 'Krem',
  size: '40',
  sku: '6496',
}

async function derive(items, zpl = officialZpl()) {
  const { deriveAugmentedSuratZplWithHashes } = await load(
    '/src/utils/augmentedSuratZpl.ts',
  )
  return deriveAugmentedSuratZplWithHashes(zpl, items)
}

function productLines(printZpl) {
  return printZpl
    .split('\n')
    .filter((line) => /\^FD\d+ x /.test(line))
}

// ═══ 1-9: kaynak korunur, ekleme doğru yere yapılır ════════════════════════

test('OZP-1..OZP-4: technicalZpl byte-for-byte korunur, komut sırası bozulmaz', async () => {
  const source = officialZpl()
  const result = await derive([DURUSOFT_ITEM], source)
  // 1) Kaynak metin nesne olarak DEĞİŞMEDEN taşınır.
  assert.equal(result.sourceZpl, source)
  // 2) Kaynak SHA'sı kaynağın kendi SHA'sıdır.
  const { sha256Hex } = await load('/src/utils/augmentedSuratZpl.ts')
  assert.equal(result.printZplSourceSha256, sha256Hex(source))
  // 3) print SHA source SHA'dan FARKLIDIR (ürün satırı eklendi).
  assert.notEqual(result.printZplSha256, result.printZplSourceSha256)
  // 4) Kaynak komutlar AYNI SIRADA korunur: ^PQ öncesi gövde birebir aynı.
  const head = source.slice(0, source.lastIndexOf('^PQ'))
  assert.ok(result.printZpl.startsWith(head), 'kaynak gövde aynen başta')
})

test('OZP-5..OZP-9: ürün komutları final ^PQ öncesine eklenir; ^PQ/^XZ ve tek sayfa korunur', async () => {
  const result = await derive([DURUSOFT_ITEM])
  const lines = result.printZpl.trim().split('\n')
  // 5) ürün satırı ^PQ'den ÖNCE
  const productIndex = lines.findIndex((line) => line.includes('Drapeli'))
  const pqIndex = lines.findIndex((line) => line.startsWith('^PQ'))
  assert.ok(productIndex > 0, 'ürün satırı eklendi')
  assert.ok(productIndex < pqIndex, 'ürün satırı ^PQ öncesinde')
  // 6) final ^PQ aynen
  assert.equal(lines[pqIndex], '^PQ1,0,1,Y')
  // 7) final ^XZ aynen
  assert.equal(lines[lines.length - 1], '^XZ')
  // 8/9) tek ^XA ve tek ^XZ
  assert.equal((result.printZpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((result.printZpl.match(/\^XZ/g) ?? []).length, 1)
})

test('OZP-10..OZP-16: resmî alanlar (PW/LL/BC/BX/T.No/sipariş/desi) DEĞİŞMEZ', async () => {
  const source = officialZpl()
  const result = await derive([DURUSOFT_ITEM], source)
  for (const invariant of [
    '^PW799',
    '^LL0799',
    '^FO60,150^BY3^BCN,150,Y,N,N^FD01254596670^FS',
    '^FO60,560^BXN,6,200^FD7270035184060553^FS',
    '^FO660,560^BQN,2,6^FDLA,01254596670^FS',
    'T.No: 21012920014311',
    'Siparis No: 7270035184060553',
    'POCH   KOLI     2,00',
  ]) {
    assert.equal(
      (result.printZpl.match(new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length,
      (source.match(new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length,
      `resmî alan değişti: ${invariant}`,
    )
  }
})

// ═══ 17-24: DuruSoft biçimi ════════════════════════════════════════════════

test('OZP-17: tek ürün DuruSoft biçiminde TEK SATIR olur', async () => {
  const result = await derive([DURUSOFT_ITEM])
  const lines = productLines(result.printZpl)
  assert.equal(lines.length, 1, 'tek satır')
  assert.match(result.printZplFooterProfile ?? '', /^single-line-/)
  assert.ok(
    lines[0].includes(
      '1 x Önü Drapeli Loş Tesettür Takım (Renk: Krem, Beden: 40) [6496]',
    ),
    `beklenen DuruSoft biçimi yok: ${lines[0]}`,
  )
})

test('OZP-18: çok uzun ürün adı güvenli profile düşer, KESİLMEZ', async () => {
  const longItem = {
    ...DURUSOFT_ITEM,
    productName:
      'Önü Drapeli Loş Tesettür Takım Uzun Model Ekstra Detaylı Kışlık Koleksiyon Serisi Premium',
  }
  const result = await derive([longItem])
  assert.equal(result.augmented, true)
  const text = result.printZpl
  // Tam ad, renk, beden ve SKU KORUNUR (ellipsis/substring yok).
  assert.ok(text.includes(longItem.productName), 'tam ürün adı korunur')
  assert.ok(text.includes('Renk: Krem'))
  assert.ok(text.includes('Beden: 40'))
  assert.ok(text.includes('[6496]'))
  assert.equal(text.includes('…'), false, 'ellipsis yok')
})

test('OZP-19..OZP-24: iki ürün, adet, tam ad, renk, beden, SKU görünür', async () => {
  const result = await derive([
    { productName: 'Ürün A', quantity: 2, color: 'Lacivert', size: '40', sku: 'SKU-A' },
    { productName: 'Ürün B', quantity: 1, color: 'Siyah', size: '42', sku: 'SKU-B' },
  ])
  assert.equal(result.augmented, true)
  const text = result.printZpl
  assert.ok(text.includes('2 x Ürün A'), 'adet görünür')
  assert.ok(text.includes('1 x Ürün B'), 'ikinci ürün görünür')
  assert.ok(text.includes('Renk: Lacivert') && text.includes('Renk: Siyah'))
  assert.ok(text.includes('Beden: 40') && text.includes('Beden: 42'))
  assert.ok(text.includes('[SKU-A]') && text.includes('[SKU-B]'))
  // "+1 ürün" / özetleme YOK.
  assert.equal(/\+\d+\s*ürün/i.test(text), false)
})

test('OZP-25..OZP-28: eksik renk/beden "Belirtilmemiş", SKU yoksa [] yok, metadata bir kez', async () => {
  const { buildProductLineText } = await load('/src/utils/suratZplProductLine.ts')
  assert.equal(
    buildProductLineText({ productName: 'X', quantity: 1, size: '40', sku: 'S1' }),
    '1 x X (Renk: Belirtilmemiş, Beden: 40) [S1]',
  )
  assert.equal(
    buildProductLineText({ productName: 'X', quantity: 1, color: 'Krem', sku: 'S1' }),
    '1 x X (Renk: Krem, Beden: Belirtilmemiş) [S1]',
  )
  const noSku = buildProductLineText({ productName: 'X', quantity: 1, color: 'Krem', size: '40' })
  assert.equal(noSku, '1 x X (Renk: Krem, Beden: 40)')
  assert.equal(noSku.includes('[]'), false)
  assert.equal(noSku.includes('()'), false)
  assert.equal(/,\s*\)/.test(noSku), false)
  assert.equal(/\s{2,}/.test(noSku), false, 'çift boşluk yok')
  // 28) metadata TAM OLARAK BİR KEZ
  const full = buildProductLineText(DURUSOFT_ITEM)
  assert.equal((full.match(/Renk:/g) ?? []).length, 1)
  assert.equal((full.match(/Beden:/g) ?? []).length, 1)
  assert.equal((full.match(/\[/g) ?? []).length, 1)
})

// ═══ 29-31: geometri — çakışma ve taşma yok ════════════════════════════════

test('OZP-29..OZP-31: ürün satırı resmî içerikle çakışmaz, ^LL dışına taşmaz, tek sayfa', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const source = officialZpl()
  const geometry = parseSuratZplGeometry(source)
  const result = await derive([DURUSOFT_ITEM], source)
  const metrics = result.metrics
  assert.ok(metrics, 'ölçüm raporlanır')
  // 29) resmî içeriğin ALTINDA başlar
  assert.ok(
    metrics.footerTop > geometry.contentBottom,
    `footerTop(${metrics.footerTop}) resmî içerik altında olmalı (${geometry.contentBottom})`,
  )
  // Sol rayın SAĞINDA başlar
  assert.ok(metrics.footerLeft > geometry.leftRailRight)
  // 30) ^LL sınırı içinde biter
  assert.ok(
    metrics.footerBottom <= geometry.labelLength,
    `footerBottom(${metrics.footerBottom}) <= ${geometry.labelLength}`,
  )
  // 31) tek sayfa
  assert.equal((result.printZpl.match(/\^XA/g) ?? []).length, 1)
})

// ═══ 32-35: imkânsız içerik, bilinmeyen şablon, fallback ═══════════════════

test('OZP-32/OZP-33: sığmayan içerik güvenli uyarı verir, kaynak bozulmaz', async () => {
  const impossible = Array.from({ length: 40 }, (_, index) => ({
    productName: `Çok Uzun Ürün Adı Numara ${index} Ekstra Detay Serisi Premium Koleksiyon`,
    quantity: 1,
    color: 'Krem',
    size: '40',
    sku: `SKU-${index}`,
  }))
  const source = officialZpl()
  const result = await derive(impossible, source)
  assert.equal(result.augmented, false)
  assert.equal(result.fallbackReason, 'footer_overflow')
  // SÖZLEŞME GÜNCELLENDİ (canlı regresyon): sığmama artık BASKIYI ENGELLEYEN
  // bir hata değil, ek özelliğin atlandığını bildiren GÜVENLİ bir uyarıdır.
  assert.equal(result.augmentationStatus, 'overflow')
  assert.equal(
    result.fallbackMessage,
    'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.',
  )
  // 33) Kaynak AYNEN kullanılır → bu sipariş batch'i durdurmaz.
  assert.equal(result.printZpl, source)
  assert.equal(result.printZplSha256, result.printZplSourceSha256)
})

test('OZP-34/OZP-35: bilinmeyen şablon BOZULMAZ, fallback sebebi kaydedilir', async () => {
  const foreign = ['^XA', '^PW600', '^LL400', '^FO10,10^A0N,20,20^FDBaska^FS', '^XZ'].join('\n')
  const result = await derive([DURUSOFT_ITEM], foreign)
  assert.equal(result.augmented, false)
  assert.equal(result.fallbackReason, 'unsupported_template')
  assert.equal(result.printZpl, foreign, 'kaynak aynen korunur')
  assert.match(result.fallbackMessage ?? '', /Bilinmeyen etiket şablonu/)
  // Sebep müşteri verisi TAŞIMAZ.
  assert.equal(/\d{11,}/.test(result.fallbackMessage ?? ''), false)
})

// ═══ 36-42: determinizm, reprint ve yüzey eşitliği ═════════════════════════

test('OZP-36/OZP-38/OZP-39: türetme DETERMINISTIK; katalog değişimi etkilemez', async () => {
  const first = await derive([DURUSOFT_ITEM])
  const second = await derive([{ ...DURUSOFT_ITEM }])
  assert.equal(first.printZplSha256, second.printZplSha256)
  assert.equal(first.printZpl, second.printZpl)
  // Ürün satırı SİPARİŞ SATIRINDAN üretilir; ürün kataloğu girdi DEĞİLDİR.
  const moduleSource = readFileSync(
    join(here, '..', 'src', 'utils', 'augmentedSuratZpl.ts'),
    'utf8',
  )
  assert.equal(/CargoProduct|products/.test(moduleSource), false)
})

test('OZP-40/OZP-42: indirme ve önizleme AYNI printZpl hash\'ini kullanır', async () => {
  const { buildSuratPrintPageModel, buildSuratZplDownload } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const order = printableOrder()
  const { model } = buildSuratPrintPageModel(order)
  assert.ok(model, 'model üretildi')
  assert.ok(model.zpl.includes('Drapeli'), 'model ZPL ürün satırı taşır')
  const download = buildSuratZplDownload([order])
  assert.ok(download)
  assert.equal(download.content, model.zpl, 'indirme printZpl döndürür')
  assert.equal(download.models[0].printZplSha256, model.printZplSha256)
  // Kaynak ZPL audit için taşınır ama indirilen içerik DEĞİLDİR.
  assert.notEqual(download.content, model.sourceZpl)
})

test('OZP-41: native/raw yolu printZpl gönderir (technicalZpl DEĞİL)', async () => {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const order = printableOrder()
  const label = await new ZebraZplLabelProvider().generateSingle({
    order,
    shipment: order.shipment,
    template: { id: 'tpl' },
    mappingConfig: {},
    desiConfig: { defaultUnitDesi: 2 },
  })
  assert.ok(label.zplContent.includes('Drapeli'), 'native ZPL ürün satırı taşır')
  assert.equal(label.sourceZplContent, order.shipment.barcodeRaw)
  assert.notEqual(label.zplContent, label.sourceZplContent)
  const { sha256Hex } = await load('/src/utils/augmentedSuratZpl.ts')
  assert.equal(label.printZplSha256, sha256Hex(label.zplContent))
  // Aynı sipariş için model ve label AYNI artefaktı verir.
  const { buildSuratPrintPageModel } = await load('/src/utils/browserLabelPrint.ts')
  assert.equal(buildSuratPrintPageModel(order).model.printZplSha256, label.printZplSha256)
})

function printableOrder(over = {}) {
  const zpl = officialZpl()
  return {
    id: 'o-1',
    marketplace: 'Trendyol',
    orderNumber: '7270035184060553',
    packageId: 'PKG-1',
    customerName: 'TEST ALICI',
    customerPhone: '5350000000',
    address: 'TEST MAH 1',
    city: 'DIYARBAKIR',
    district: 'KAYAPINAR',
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    hasPrintableLabel: true,
    desi: 2,
    desiSource: 'manual_total',
    items: [
      {
        id: 'l-1',
        productName: 'Önü Drapeli Loş Tesettür Takım',
        quantity: 1,
        color: 'Krem',
        size: '40',
        merchantSku: '6496',
        barcode: 'BC-1',
      },
    ],
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: '21012920014311',
      tNo: '21012920014311',
      barcode: '01254596670',
      barkodNo: '01254596670',
      barcodeValue: '01254596670',
      ozelKargoTakipNo: '7270035184060553',
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true,
      printEnabled: true,
      barcodeRaw: zpl,
      desi: 2,
    },
    ...over,
  }
}

// ═══ 45-52: güvenlik, gizlilik ve migration ════════════════════════════════

test('OZP-45: harici render/Labelary çağrısı YOK', () => {
  for (const rel of [
    'src/utils/augmentedSuratZpl.ts',
    'src/utils/suratZplProductLine.ts',
    'src/utils/suratZplGeometry.ts',
  ]) {
    const src = readFileSync(join(here, '..', rel), 'utf8')
    assert.equal(/labelary|fetch\(|https?:\/\//i.test(src), false, rel)
  }
})

test('OZP-46/OZP-47: ham ZPL ve PII loglanmaz', () => {
  for (const rel of [
    'src/utils/augmentedSuratZpl.ts',
    'src/utils/suratZplProductLine.ts',
    'src/utils/suratZplGeometry.ts',
  ]) {
    const src = readFileSync(join(here, '..', rel), 'utf8')
    assert.equal(/console\.(log|info|warn|error)/.test(src), false, rel)
    for (const field of ['customerName', 'customerPhone', 'address', 'apiKey', 'sifre']) {
      assert.equal(src.includes(field), false, `${rel} → ${field}`)
    }
  }
})

test('OZP-52: migration eklenmez', () => {
  const files = readdirSync(join(here, '..', 'drizzle')).filter((f) => f.endsWith('.sql'))
  const sql = files
    .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'))
    .join('\n')
  assert.equal(/print_zpl|printZpl/i.test(sql), false)
})

test('OZP-TR: Türkçe karakter kararı deterministiktir', async () => {
  const { transliterateTurkish } = await load('/src/utils/suratZplProductLine.ts')
  // ^CI28 (UTF-8) kaynakta Türkçe AYNEN korunur.
  const utf8Result = await derive([DURUSOFT_ITEM], officialZpl())
  assert.ok(utf8Result.printZpl.includes('Önü Drapeli Loş Tesettür Takım'))
  // ^CI28 yoksa deterministik transliterasyon (bozuk karakter YOK).
  assert.equal(transliterateTurkish('Şğıİç Öü'), 'Sgi Ic Ou'.replace('Sgi Ic', 'SgiIc'))
})

// ═══ ENTEGRASYON: ortak metadata resolver + sessiz kayıp yasağı ════════════
//
// Bu bölüm iki feature dalının BİRLİKTE çalıştığını sabitler: ZPL ürün satırı
// artık HTML etiketiyle AYNI çözümleyici zincirini kullanır (yapısal alan →
// variantAttributes → kesin katalog eşleşmesi → çapalı başlık → Belirtilmemiş)
// ve desteklenen şablonda footer üretilemiyorsa sipariş SESSİZCE ham ZPL ile
// basılmaz.

function catalogProduct(over = {}) {
  return {
    id: 'p-1',
    marketplace: 'Trendyol',
    productName: 'Sentetik Ürün',
    sku: '',
    barcode: '',
    productMainId: 'MODEL-1',
    stock: 0,
    price: 0,
    source: 'real',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...over,
  }
}

test('INT-1: ZPL ürün satırı KATALOG varyantından renk tamamlar (ortak resolver)', async () => {
  const { buildSuratPrintPageModel } = await load('/src/utils/browserLabelPrint.ts')
  // Sipariş satırında YALNIZ beden var (canlı vaka: order_lines'ta color yok).
  const order = printableOrder({
    items: [
      {
        id: 'l-1',
        productName: 'Önü Drapeli Loş Tesettür Takım',
        quantity: 1,
        barcode: 'BC-77',
        merchantSku: '6496',
        variantAttributes: [{ name: 'Beden', value: '40' }],
      },
    ],
  })
  // Katalogsuz: renk bulunamaz → Belirtilmemiş (TAHMİN YOK).
  const withoutCatalog = buildSuratPrintPageModel(order).model
  assert.ok(withoutCatalog.zpl.includes('Renk: Belirtilmemiş, Beden: 40'))
  // Katalogla: kesin barkod eşleşmesinden renk gelir.
  const withCatalog = buildSuratPrintPageModel(order, [
    catalogProduct({ barcode: 'BC-77', color: 'Krem', size: '40' }),
  ]).model
  assert.ok(
    withCatalog.zpl.includes('(Renk: Krem, Beden: 40) [6496]'),
    'katalog enrichment ZPL footer\'ına ulaşmalı',
  )
  // Katalog eklendiği için artefakt DEĞİŞİR (farklı SHA) — ama kaynak aynıdır.
  assert.notEqual(withCatalog.printZplSha256, withoutCatalog.printZplSha256)
  assert.equal(withCatalog.printZplSourceSha256, withoutCatalog.printZplSourceSha256)
})

test('INT-2: ZPL footer AYRI tahmin algoritması kullanmaz (tek giriş noktası)', () => {
  const src = readFileSync(
    join(here, '..', 'src', 'utils', 'suratProductLineItems.ts'),
    'utf8',
  )
  assert.match(src, /resolveLabelProductMetadata/)
  assert.match(src, /resolveCatalogVariantMetadata/)
  // Provider ve print model AYNI helper'ı çağırır.
  for (const rel of [
    'src/utils/browserLabelPrint.ts',
    'src/providers/labels/ZebraZplLabelProvider.ts',
  ]) {
    const consumer = readFileSync(join(here, '..', rel), 'utf8')
    assert.match(consumer, /resolveSuratProductLineItems/, rel)
  }
})

test('INT-3: "Taşlı" ZPL footer\'ında da renk sayılmaz', async () => {
  const { buildSuratPrintPageModel } = await load('/src/utils/browserLabelPrint.ts')
  const order = printableOrder({
    items: [
      {
        id: 'l-1',
        productName: 'Taşlı Simli Tesettür Abiye',
        quantity: 1,
        merchantSku: 'SECIL-334',
      },
    ],
  })
  const model = buildSuratPrintPageModel(order).model
  assert.ok(model.zpl.includes('Taşlı Simli Tesettür Abiye'))
  assert.ok(model.zpl.includes('Renk: Belirtilmemiş'))
})

test('INT-4: footer sığmasa bile baskı BLOKLANMAZ (uyarıyla devam)', async () => {
  const { buildSuratPrintPageModel, resolveSuratPrintableSelection } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  const impossible = Array.from({ length: 40 }, (_, index) => ({
    id: `l-${index}`,
    productName: `Çok Uzun Ürün Adı Numara ${index} Ekstra Detay Serisi Premium Koleksiyon`,
    quantity: 1,
    merchantSku: `SKU-${index}`,
    variantAttributes: [
      { name: 'Renk', value: 'Krem' },
      { name: 'Beden', value: '40' },
    ],
  }))
  const blocked = printableOrder({ id: 'o-blocked', items: impossible })
  const { model, reason } = buildSuratPrintPageModel(blocked)
  // SÖZLEŞME GÜNCELLENDİ (canlı regresyon): footer sığmasa BİLE baskı
  // ENGELLENMEZ. Resmî kaynak ZPL basılır; durum sessiz değil, açık uyarıyla
  // raporlanır. Eski davranış (siparişi atlamak) TÜM baskıları durdurmuştu.
  assert.ok(model, 'model üretilir; baskı bloklanmaz')
  assert.equal(reason, undefined)
  assert.equal(model.zpl, model.sourceZpl, 'resmî kaynak ZPL kullanılır')
  assert.equal(model.augmentationStatus, 'overflow')
  assert.equal(
    model.augmentationWarning,
    'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.',
  )

  // KISMİ BATCH: hiçbir sipariş düşmez.
  const healthy = printableOrder({ id: 'o-ok' })
  const selection = resolveSuratPrintableSelection([blocked, healthy])
  assert.equal(selection.printable.length, 2)
  assert.equal(selection.skipped.length, 0)
})

test('INT-5: provider augmentation hatasında etiketi GEÇERSİZ KILMAZ', async () => {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const order = printableOrder({
    items: Array.from({ length: 40 }, (_, index) => ({
      id: `l-${index}`,
      productName: `Çok Uzun Ürün Adı Numara ${index} Ekstra Detay Serisi Premium`,
      quantity: 1,
      merchantSku: `SKU-${index}`,
      variantAttributes: [{ name: 'Renk', value: 'Krem' }, { name: 'Beden', value: '40' }],
    })),
  })
  // SÖZLEŞME GÜNCELLENDİ: provider augmentation başarısızlığında HATA ATMAZ;
  // resmî etiket geçerli kalır ve durum raporlanır.
  const label = await new ZebraZplLabelProvider().generateSingle({
    order,
    shipment: order.shipment,
    template: { id: 'tpl' },
    mappingConfig: {},
    desiConfig: { defaultUnitDesi: 2 },
  })
  assert.equal(label.zplContent, order.shipment.barcodeRaw)
  assert.equal(label.augmentationStatus, 'overflow')
})

test('INT-6: external-processing davranışları ZPL çalışmasından ETKİLENMEZ', async () => {
  const { isExternallyProcessed, applyExternalProcessingState, externalProcessingKey } =
    await load('/src/utils/externalProcessing.ts')
  const order = printableOrder()
  assert.equal(isExternallyProcessed(order), false)
  const key = externalProcessingKey(order)
  const [marked] = applyExternalProcessingState([order], {
    entries: { [key]: { processedAt: '2026-08-05T09:00:00.000Z', source: 'manual' } },
  })
  assert.equal(isExternallyProcessed(marked), true)
  // Etiket/kargo alanları DEĞİŞMEZ.
  assert.equal(marked.shipment.barcodeRaw, order.shipment.barcodeRaw)
  assert.equal(marked.shipment.trackingNumber, order.shipment.trackingNumber)
  assert.equal(marked.labelStatus, order.labelStatus)
})

// ═══ CANLI REGRESYON: AUGMENTATION BASKIYI BLOKLAMAMALI ════════════════════
//
// Canlı belirti: provider 200 döndü (tracking + barkod + ZPL + LABEL_READY),
// buna rağmen UI "Ürün bilgileri resmî kargo etiketinin alt alanına sığmıyor."
// veriyordu ve ESKİ READY/PRINTED etiketler de yazdırılamıyordu.
//
// Kök neden: gerçek Sürat şablonunda bölümleri saran DIŞ ÇERÇEVE (^GB)
// içerik sayılıyor, footer alanı 0 kalıyor ve her sipariş footer_overflow
// oluyordu; önceki sürüm bunu "baskı yapılamaz" hatasına çeviriyordu.
//
// Yeni sözleşme: augmentation EK ÖZELLİKTİR; başarısızlığı provider sonucunu,
// shipment lifecycle'ını veya baskıyı GEÇERSİZ KILMAZ.

// Dış çerçeveli (gerçekçi) resmî şablon.
function framedOfficialZpl() {
  return [
    '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
    '^FO20,15^GB760,770,3^FS',
    '^FO60,20^A0N,28,28^FDSube: FERAH^FS',
    '^FO470,20^A0N,26,26^FDT.No: 21012920014311^FS',
    '^FO60,150^BY3^BCN,150,Y,N,N^FD01254596670^FS',
    '^FO60,345^A0N,24,24^FDALICI AD^FS',
    '^FO60,560^BXN,6,200^FD7270035184060553^FS',
    '^FO240,672^A0N,38,38^FDDIYARBAKIR AKTARMA^FS',
    '^FO660,560^BQN,2,6^FDLA,01254596670^FS',
    '^FWB', '^FO24,340^A0N,18,18^FDSiparis No: 7270035184060553^FS', '^FWN',
    '^PQ1,0,1,Y',
    '^XZ',
  ].join('\n')
}

// Footer'a ASLA sığmayacak içerik (overflow'u zorlar).
const IMPOSSIBLE_ITEMS = Array.from({ length: 40 }, (_, index) => ({
  id: `l-${index}`,
  productName: `Cok Uzun Urun Adi Numara ${index} Ekstra Detay Serisi Premium Koleksiyon`,
  quantity: 1,
  merchantSku: `SKU-${index}`,
  variantAttributes: [
    { name: 'Renk', value: 'Krem' },
    { name: 'Beden', value: '40' },
  ],
}))

test('HF-1: dış çerçeve içerik sayılmaz — normal siparişte footer alanı KALIR', async () => {
  const { parseSuratZplGeometry } = await load('/src/utils/suratZplGeometry.ts')
  const geometry = parseSuratZplGeometry(framedOfficialZpl())
  // Çerçeve yok sayılmazsa contentBottom ~785 olur ve alan 0 kalırdı.
  assert.ok(
    geometry.contentBottom < geometry.labelLength - 40,
    `contentBottom(${geometry.contentBottom}) çerçeve yüzünden şişmemeli`,
  )
  const { resolveFooterArea } = await load('/src/utils/suratZplProductLine.ts')
  const area = resolveFooterArea(geometry)
  assert.ok(area.height > 0, `footer yüksekliği kalmalı (${area.height})`)
})

test('HF-2: footer sığmasa bile print modeli ÜRETİLİR (baskı bloklanmaz)', async () => {
  const { buildSuratPrintPageModel } = await load('/src/utils/browserLabelPrint.ts')
  const order = printableOrder({ items: IMPOSSIBLE_ITEMS })
  const { model, reason } = buildSuratPrintPageModel(order)
  assert.ok(model, `model üretilmeli, reason=${reason ?? '-'}`)
  assert.equal(reason, undefined)
  // Resmî kaynak ZPL basılabilir durumda.
  assert.ok(model.zpl.includes('^XA') && model.zpl.includes('^XZ'))
  assert.equal(model.zpl, model.sourceZpl, 'fallback: resmî kaynak kullanılır')
  // SESSİZ DEĞİL: durum ve güvenli uyarı taşınır.
  assert.equal(model.augmentationStatus, 'overflow')
  assert.equal(
    model.augmentationWarning,
    'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.',
  )
  // Uyarı ham ZPL veya müşteri verisi TAŞIMAZ.
  assert.equal(model.augmentationWarning.includes('^XA'), false)
})

test('HF-3: provider augmentation başarısızlığında HATA ATMAZ, etiket geçerli kalır', async () => {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const order = printableOrder({ items: IMPOSSIBLE_ITEMS })
  const label = await new ZebraZplLabelProvider().generateSingle({
    order,
    shipment: order.shipment,
    template: { id: 'tpl' },
    mappingConfig: {},
    desiConfig: { defaultUnitDesi: 2 },
  })
  assert.ok(label.zplContent, 'etiket üretilir')
  assert.equal(label.zplContent, order.shipment.barcodeRaw, 'resmî ZPL korunur')
  assert.equal(label.augmentationStatus, 'overflow')
  assert.equal(
    label.augmentationWarning,
    'Ürün satırı eklenemedi; resmî kargo etiketi kullanıldı.',
  )
})

test('HF-4: ESKİ READY/PRINTED etiket ürün satırı olmadan da yazdırılabilir', async () => {
  const { buildSuratPrintPageModel, resolveSuratPrintableSelection } = await load(
    '/src/utils/browserLabelPrint.ts',
  )
  // Ürün satırı HİÇ YOK (eski kayıt) → augmentation yapılamaz.
  const legacy = printableOrder({
    id: 'o-legacy',
    items: [],
    operationStatus: 'LABEL_PRINTED',
    labelStatus: 'PRINTED',
  })
  const { model } = buildSuratPrintPageModel(legacy)
  assert.ok(model, 'eski etiket yazdırılabilir')
  assert.equal(model.zpl, legacy.shipment.barcodeRaw)
  // Batch: overflow'lu sipariş DİĞERLERİNİ durdurmaz ve kendisi de atlanmaz.
  const blocked = printableOrder({ id: 'o-blocked', items: IMPOSSIBLE_ITEMS })
  const healthy = printableOrder({ id: 'o-ok' })
  const selection = resolveSuratPrintableSelection([blocked, healthy, legacy])
  assert.equal(selection.printable.length, 3, 'hiçbir sipariş düşmez')
  assert.equal(selection.skipped.length, 0)
})

test('HF-5: unsupported template de baskıyı bloklamaz', async () => {
  const { buildSuratPrintPageModel } = await load('/src/utils/browserLabelPrint.ts')
  const foreign = ['^XA', '^PW600', '^LL400', '^FO10,10^A0N,20,20^FDBaska^FS', '^XZ'].join('\n')
  const order = printableOrder({
    id: 'o-foreign',
    shipment: { ...printableOrder().shipment, barcodeRaw: foreign },
  })
  const { model, reason } = buildSuratPrintPageModel(order)
  assert.ok(model, `model üretilmeli, reason=${reason ?? '-'}`)
  assert.equal(model.zpl, foreign, 'kaynak aynen kullanılır')
  assert.equal(model.augmentationStatus, 'unsupported_template')
})

test('HF-6: augmentation başarılıysa ürün satırı KORUNUR (özellik kaybolmadı)', async () => {
  const { buildSuratPrintPageModel } = await load('/src/utils/browserLabelPrint.ts')
  const order = printableOrder({
    shipment: { ...printableOrder().shipment, barcodeRaw: framedOfficialZpl() },
  })
  const { model } = buildSuratPrintPageModel(order)
  assert.ok(model)
  assert.equal(model.augmentationStatus, 'success')
  assert.ok(
    model.zpl.includes('(Renk: Krem, Beden: 40) [6496]'),
    'DuruSoft biçimli ürün satırı eklenir',
  )
  // Kaynak korunur ve tek sayfa kalır.
  assert.equal((model.zpl.match(/\^XA/g) ?? []).length, 1)
  assert.equal((model.zpl.match(/\^XZ/g) ?? []).length, 1)
  assert.ok(model.zpl.includes('T.No: 21012920014311'))
  assert.notEqual(model.printZplSha256, model.printZplSourceSha256)
})
