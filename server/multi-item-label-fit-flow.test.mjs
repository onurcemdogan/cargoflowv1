import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// İki kalemli siparişte etiket sığdırma + baskı yolu ayrımı.
//
// KÖK NEDEN 1 (canlı): tek-tuş akışı printLabels'a modu SABİT 'browser-print'
// veriyordu. Zebra/native seçili olsa bile resmî persisted ZPL yerine HTML
// render yoluna giriliyor, ürün footer'ı sığmayınca READY sipariş
// bloklanıyordu.
// KÖK NEDEN 2: ürün footer'ı SABİT ~9.9mm idi; iki uzun kalem sığmıyordu.
//
// Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
const workflow = readFileSync(
  join(here, '..', 'src/services/orderWorkflowService.ts'), 'utf8')
const provider = readFileSync(
  join(here, '..', 'src/providers/printing/BrowserDownloadPrintProvider.ts'),
  'utf8')

// ── baskı yolu ayrımı ────────────────────────────────────────────────────

test('MIF-1: tek-tuş akışı GERÇEK yazıcı modunu kullanır (hardcode YOK)', () => {
  assert.equal(
    /mode: 'browser-print' as const/.test(app), false,
    'sabit browser-print kalmadı',
  )
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  assert.match(handler, /workflowService\.printLabels\(\s*effectiveOrders,\s*printIds,\s*printerSettings,/)
})

test('MIF-2/3: product-fit YALNIZ browser-print modunda uygulanır', () => {
  const handler = app.slice(
    app.indexOf('async function handleSuratCreateAndPrintForIds'),
    app.indexOf('async function handlePrintLabelsForIds'),
  )
  // SÖZLEŞME GENİŞLETİLDİ (fix/official-surat-print-skip) — GEVŞETİLMEDİ.
  // HTML ürün-sığdırma kuralı CargoFlow HTML BELGESİNE aittir. Artık İKİ
  // durumda uygulanmaz:
  //   (1) tarayıcı baskısı değilse (Zebra/native: resmî ZPL byte-for-byte),
  //   (2) resmî Sürat şablonu seçiliyse (içerik sunucudaki kayıtlı printZpl'den
  //       PNG olarak gelir; HTML belgesi hiç üretilmez).
  // Eskiden TEK koşul aranıyordu; bu iddia artık İKİSİNİ birden arar.
  assert.match(
    handler,
    /resolveFitBlock: \(order\) =>\s*\n?\s*printerSettings\.mode !== 'browser-print' \|\|\s*\n?\s*templateDecision\.template === 'surat_official_zpl'\s*\n?\s*\? null/,
  )
})

test('MIF-4: sağlayıcı seçimi TEK yerde ve moda göredir', () => {
  assert.match(provider, /if \(input\.printerSettings\.mode === 'browser-print'\)/)
  const zebra = provider.slice(provider.indexOf("'/api/printing/zebra/raw'"))
  // Zebra dalı HTML render veya product-fit ÇAĞIRMAZ.
  for (const leak of [
    'buildCleanLabelDocument', 'printCleanLabelDocument', 'resolveProductFit',
    'resolveRouteFit', 'resolveBrowserPrintJobs',
  ]) {
    assert.equal(zebra.includes(leak), false, `Zebra dalına sızdı: ${leak}`)
  }
  assert.match(zebra, /jobs: data\.jobs/)
})

test('MIF-5/6: hata metni PROVIDER-BAĞIMSIZ, tanı kaydı gerçek yola göre', () => {
  assert.equal(
    /Etiket Zebra yazıcıya gönderilemedi/.test(workflow), false,
    'provider-spesifik metin kaldırıldı',
  )
  assert.match(workflow, /'Etiket yazdırılamadı\.'/)
  assert.match(workflow, /Etiket yazdırılamadı\. Etiket durumu değiştirilmedi\./)
  // Tanı kaydı: tarayıcı yolunda sahte Zebra endpoint'i yazılmaz.
  assert.match(workflow, /const isZebraPath = printerSettings\.mode === 'local-agent'/)
  assert.match(workflow, /isZebraPath \? 'Zebra Yazdır' : 'Tarayıcı Baskısı'/)
  assert.match(workflow, /browser-print \(HTTP çağrısı yok\)/)
})

// ── layout profilleri ────────────────────────────────────────────────────

test('MIF-7: profiller SIRALI, DETERMINISTIK ve güvenli sınırlar içinde', async () => {
  const { LABEL_LAYOUT_PROFILES, resolveProductAreaHeightMm } = await load(
    '/src/utils/labelLayoutProfile.ts')
  assert.deepEqual(
    LABEL_LAYOUT_PROFILES.map((p) => p.key),
    ['standard', 'compact-multi', 'dense-multi'],
  )
  let previousArea = 0
  for (const profile of LABEL_LAYOUT_PROFILES) {
    const area = resolveProductAreaHeightMm(profile)
    assert.ok(area > previousArea, 'ürün alanı kademeli BÜYÜR')
    previousArea = area
    // QR'lar okunabilir minimumun ALTINA inmez.
    assert.ok(profile.largeQrMm >= 15, 'büyük QR >= 15mm')
    assert.ok(profile.smallQrMm >= 9, 'küçük QR >= 9mm')
    // Barkod satırı ve header HER profilde sabittir (hesaba dahil).
    const fixed = 12 + 20.5 + profile.addressRowMm + 10 + profile.deliveryRowMm
    assert.ok(fixed + area + profile.productPaddingMm * 2 <= 99.35)
  }
  // Deterministik: ayni cagri ayni sonucu verir.
  assert.equal(
    resolveProductAreaHeightMm(LABEL_LAYOUT_PROFILES[1]),
    resolveProductAreaHeightMm(LABEL_LAYOUT_PROFILES[1]),
  )
})

test('MIF-8: iki uzun kalem standard\'a SIĞMAZ, compact-multi\'ye SIĞAR', async () => {
  const { resolveProductFit } = await load('/src/utils/labelProductFit.ts')
  const { LABEL_LAYOUT_PROFILES, resolveProductAreaHeightMm } = await load(
    '/src/utils/labelLayoutProfile.ts')
  const items = Array.from({ length: 2 }, (_, index) => ({
    productName: 'U'.repeat(100),
    quantity: 1, color: 'Lacivert', size: '40', sku: `sku${index}`,
  }))
  const at = (key) => {
    const profile = LABEL_LAYOUT_PROFILES.find((p) => p.key === key)
    return resolveProductFit({
      items, availableWidthMm: 89,
      availableHeightMm: resolveProductAreaHeightMm(profile),
    })
  }
  assert.equal(at('standard').fits, false, 'canlı hata sınıfı')
  assert.equal(at('compact-multi').fits, true, 'profil yükseltmesi çözer')
  assert.equal(at('dense-multi').fits, true)
})

test('MIF-9: render İLK sığan profili seçer ve DOM\'da işaretler', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const TNO = '25220148446193'
  const BARCODE = '01231201025'
  const order = (items) => ({
    id: 'o1', orderNumber: '7270032941525232', packageId: 'PKG1',
    operationStatus: 'LABEL_READY', labelStatus: 'READY',
    customerName: 'SENTETIK ALICI', customerPhone: '5410000000',
    city: 'KASTAMONU', district: 'ARAC',
    address: 'YENI MAH SENTETIK CADDESI NO 113/B',
    desi: 2, items,
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
      barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true, printEnabled: true,
      barcodeRaw: `^XA^FD${BARCODE}^FS^XZ`,
    },
  })
  const template = {
    id: 't', widthMm: 100, heightMm: 100,
    widthDots: 799, heightDots: 799, fields: [],
  }
  const short = buildCleanLabelDocument(
    [order([{ id: 'l1', quantity: 1, productName: 'Basic Tisort', color: 'Mavi', size: '40', sku: 's1' }])],
    template, {})
  assert.match(short.html, /data-layout-profile="standard"/)

  const longItems = [
    { id: 'l1', quantity: 1, productName: 'U'.repeat(100), color: 'Lacivert', size: '40', sku: 'ttzeyna11' },
    { id: 'l2', quantity: 1, productName: 'V'.repeat(100), color: 'Siyah', size: '38', sku: 'ttpant10' },
  ]
  const heavy = buildCleanLabelDocument([order(longItems)], template, {})
  assert.equal(heavy.skipped.length, 0, 'artık ATLANMIYOR')
  assert.equal(heavy.printable.length, 1)
  assert.match(heavy.html, /data-layout-profile="compact-multi"/)
  // TEK etiket, TEK sayfa; ikinci devam etiketi YOK.
  assert.equal((heavy.html.match(/class="label-page"/g) ?? []).length, 1)
  // Ürün bilgisi EKSİKSİZ: iki satır da metadata ile birlikte var.
  assert.ok(heavy.html.includes('Renk: Lacivert'))
  assert.ok(heavy.html.includes('Renk: Siyah'))
  assert.ok(
    heavy.html.includes('[ttzeyna11]') && heavy.html.includes('[ttpant10]'),
    'her iki SKU da gösterilir',
  )
  // Sessiz kırpma yok.
  assert.equal(/\+\d+ ürün|…|&hellip;/.test(heavy.html), false)
  // Profil DETERMINISTIK: aynı girdi -> aynı çıktı.
  const again = buildCleanLabelDocument([order(longItems)], template, {})
  assert.equal(again.html, heavy.html)
})

test('MIF-10: hiçbir profil sığdıramazsa AÇIK hata + sipariş izolasyonu', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const { PRODUCT_OVERFLOW_MESSAGE } = await load('/src/utils/labelProductFit.ts')
  const TNO = '25220148446193'
  const BARCODE = '01231201025'
  const mk = (id, items) => ({
    id, orderNumber: `727003294152523${id}`, packageId: `PKG${id}`,
    operationStatus: 'LABEL_READY', labelStatus: 'READY',
    customerName: 'SENTETIK ALICI', customerPhone: '5410000000',
    city: 'KASTAMONU', district: 'ARAC',
    address: 'YENI MAH SENTETIK CADDESI NO 113/B',
    desi: 2, items,
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
      barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true, printEnabled: true,
      barcodeRaw: `^XA^FD${BARCODE}^FS^XZ`,
    },
  })
  const template = {
    id: 't', widthMm: 100, heightMm: 100,
    widthDots: 799, heightDots: 799, fields: [],
  }
  const healthy = mk('1', [{ id: 'l1', quantity: 1, productName: 'Basic Tisort' }])
  const impossible = mk('2', Array.from({ length: 12 }, (_, i) => ({
    id: `x${i}`, quantity: 1, productName: 'Z'.repeat(160),
    color: 'Lacivert', size: '40', sku: `sku${i}`,
  })))
  const mixed = buildCleanLabelDocument([healthy, impossible], template, {})
  assert.equal(mixed.printable.length, 1, 'sağlam sipariş basılır')
  assert.equal(mixed.skipped.length, 1)
  assert.equal(mixed.skipped[0].reason, PRODUCT_OVERFLOW_MESSAGE)
})

test('MIF-11: barkod ve resmî ZPL yolu DEĞİŞMEDİ', () => {
  const src = readFileSync(join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  // Barkod satırı HER profilde sabit 20.5mm; profil değişkeni YOK.
  assert.match(src, /grid-template-rows:\s*\n?\s*12mm 20\.5mm var\(--layout-address-row/)
  assert.match(src, /\.surat-barcode svg \{ width: 100%; height: 17\.2mm/)
  assert.match(src, /applyScalableQuietZone\(svg, BARCODE_MODULE_WIDTH\)/)
  const quiet = readFileSync(join(here, '..', 'src/utils/barcodeQuietZone.ts'), 'utf8')
  assert.match(quiet, /CODE128_QUIET_ZONE_MODULES = 10/)
})
