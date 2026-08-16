import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Canlı sipariş 7270035237446594 sınıfı: iki kalem, Etiket Hazır, T.No ve
// barkod mevcut, browser-print yolu.
//
// KÖK NEDEN: ön kontrol (App.tsx resolveFitBlock) resolveProductFit'i SABİT
// availableHeightMm: 9.4 ile çağırıyordu — yalnız 'standard' profilin ürün
// alanı. Adaptif profiller SADECE renderer'da deneniyordu, ama ön kontrol
// siparişi önce atladığı için renderer HİÇ ÇALIŞMIYORDU.
//
// Müşteri verisi SENTETİKTİR; yalnız sipariş numarası canlı referanstır.

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

const LIVE_ORDER_NO = '7270035237446594'
const TNO = '25220148446193'
const BARCODE = '01231201025'

// Canlı sınıfa benzeyen iki kalem: 85–90 karakter tam ürün adı + renk +
// beden + SKU + adet. (Ölçülen eşik: 85 karakterden itibaren eski sabit
// 9.4mm ön kontrolü BLOKLUYORDU.)
const LIVE_ITEMS = [
  {
    id: 'l1', quantity: 1,
    productName:
      'Saten Tesettur Abiye Elbise Drapeli Uzun Kollu Dik Yaka Ozel Gun Davet Modeli Uzun',
    color: 'Lacivert', size: '40', sku: 'ttzeyna44',
  },
  {
    id: 'l2', quantity: 1,
    productName:
      'Kumas Pantolon Yuksek Bel Bol Paca Ofis Modeli Dort Mevsim Rahat Kesim Klasik Urun',
    color: 'Siyah', size: '42', sku: 'ttpant10',
  },
]

const liveOrder = (items = LIVE_ITEMS) => ({
  id: 'o-live', orderNumber: LIVE_ORDER_NO, packageId: 'PKG-LIVE',
  operationStatus: 'LABEL_READY', labelStatus: 'READY',
  customerName: 'SENTETIK ALICI', customerPhone: '5410000000',
  city: 'KASTAMONU', district: 'ARAC',
  address: 'YENI MAHALLE SENTETIK CADDESI NO 113/B DAIRE 4',
  desi: 4, desiSource: 'manual_total',
  items,
  shipment: {
    provider: 'surat-kargo',
    trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
    barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
    ozelKargoTakipNo: LIVE_ORDER_NO,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    zplReady: true, printEnabled: true,
    barcodeRaw:
      `^XA^PW799^LL799^FO60,120^BCN,140,Y,N,N^FD${BARCODE}^FS^XZ`,
  },
})
const TEMPLATE = {
  id: 't', widthMm: 100, heightMm: 100,
  widthDots: 799, heightDots: 799, fields: [],
}
const layoutInput = (items = LIVE_ITEMS) => ({
  items: items.map((line) => ({
    productName: line.productName, quantity: line.quantity,
    color: line.color, size: line.size, sku: line.sku,
  })),
  destination: 'KASTAMONU / ARAC',
  transfer: 'GEREDE AKTARMA',
})

// ── kök neden ────────────────────────────────────────────────────────────

test('LIVE-1: iki uzun kalem standard profile SIĞMAZ', async () => {
  const { resolveProductFit } = await load('/src/utils/labelProductFit.ts')
  const { LABEL_LAYOUT_PROFILES, resolveProductAreaHeightMm } = await load(
    '/src/utils/labelLayoutProfile.ts')
  const standard = LABEL_LAYOUT_PROFILES[0]
  assert.equal(standard.key, 'standard')
  const fit = resolveProductFit({
    items: layoutInput().items,
    availableWidthMm: 89,
    availableHeightMm: resolveProductAreaHeightMm(standard),
  })
  assert.equal(fit.fits, false, 'canlı hata sınıfı standard\'a sığmaz')
})

test('LIVE-2: aynı sipariş compact/dense profile SIĞAR', async () => {
  const { resolveLabelLayout } = await load('/src/utils/labelLayoutResolver.ts')
  const layout = resolveLabelLayout(layoutInput())
  assert.equal(layout.ok, true)
  assert.ok(
    ['compact-multi', 'dense-multi'].includes(layout.profile.key),
    `beklenmeyen profil: ${layout.profile.key}`,
  )
})

test('LIVE-3: ön kontrol siparişi ERKENDEN bloklamaz', async () => {
  const { resolveLabelLayoutBlockReason } = await load(
    '/src/utils/labelLayoutResolver.ts')
  assert.equal(resolveLabelLayoutBlockReason(layoutInput()), null)
  // App ön kontrolü ARTIK sabit 9.4mm kullanmaz.
  const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
  assert.equal(/availableHeightMm: 9\.4/.test(app), false)
  assert.match(app, /resolveLabelLayoutBlockReason\(\{/)
})

test('LIVE-4/5/6: ön kontrol, önizleme ve renderer AYNI profili seçer', async () => {
  const { resolveLabelLayout } = await load('/src/utils/labelLayoutResolver.ts')
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const expected = resolveLabelLayout(layoutInput()).profile.key
  const doc = buildCleanLabelDocument([liveOrder()], TEMPLATE, {})
  assert.match(doc.html, new RegExp(`data-layout-profile="${expected}"`))

  // Tek kaynak: uc katman da AYNI cozumleyiciyi cagirir.
  const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
  const preview = readFileSync(
    join(here, '..', 'src/components/LabelHtmlPreview.tsx'), 'utf8')
  const printer = readFileSync(
    join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  assert.match(app, /resolveLabelLayoutBlockReason/)
  assert.match(preview, /resolveLabelLayout\(/)
  assert.match(printer, /resolveLabelLayout\(/)
  // Profil secimi baska yerde YENIDEN hesaplanmaz.
  assert.equal(/LABEL_LAYOUT_PROFILES/.test(printer), false)
  assert.equal(/LABEL_LAYOUT_PROFILES/.test(app), false)
  assert.equal(/LABEL_LAYOUT_PROFILES/.test(preview), false)

  // DETERMINISTIK: ayni girdi -> ayni cikti.
  const again = buildCleanLabelDocument([liveOrder()], TEMPLATE, {})
  assert.equal(again.html, doc.html)
})

// ── içerik bütünlüğü ─────────────────────────────────────────────────────

test('LIVE-7/8/9/10: tam ad, renk, beden, SKU ve adet KORUNUR', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const doc = buildCleanLabelDocument([liveOrder()], TEMPLATE, {})
  assert.equal(doc.skipped.length, 0, 'sipariş ATLANMAZ')
  assert.equal(doc.printable.length, 1)
  for (const item of LIVE_ITEMS) {
    assert.ok(doc.html.includes(item.productName), 'tam ürün adı korunur')
    assert.ok(doc.html.includes(`[${item.sku}]`), 'SKU korunur')
  }
  assert.ok(doc.html.includes('Renk: Lacivert') && doc.html.includes('Beden: 40'))
  assert.ok(doc.html.includes('Renk: Siyah') && doc.html.includes('Beden: 42'))
  assert.ok(doc.html.includes('1 x '), 'adet korunur')
  // Metadata İKİ KEZ yazılmaz: her satırda tek "(Renk:" bloğu.
  assert.equal((doc.html.match(/\(Renk: Lacivert/g) ?? []).length, 1)
  assert.equal((doc.html.match(/\(Renk: Siyah/g) ?? []).length, 1)
})

test('LIVE-11..16: tek sayfa, kırpma/özet yok, barkod ve QR korunur', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const doc = buildCleanLabelDocument([liveOrder()], TEMPLATE, {})
  assert.equal((doc.html.match(/class="label-page"/g) ?? []).length, 1)
  assert.equal(/\+\d+ ürün/.test(doc.html), false, '"+X ürün" özeti YOK')
  const style = doc.html.slice(doc.html.indexOf('<style>'), doc.html.indexOf('</style>'))
  assert.equal(/-webkit-line-clamp/.test(style), false)
  assert.equal(/text-overflow: ellipsis/.test(
    style.slice(style.indexOf('.surat-product'), style.indexOf('@media')),
  ), false)
  // Barkod ve QR gorunur; barkod satiri her profilde SABIT.
  assert.ok(doc.html.includes('surat-qr-large') && doc.html.includes('surat-qr-small'))
  assert.match(doc.html, /data-barcode-value="01231201025"/)
  assert.match(style, /12mm 20\.5mm var\(--layout-address-row/)
  assert.match(style, /height: 17\.2mm/)
  const quiet = readFileSync(join(here, '..', 'src/utils/barcodeQuietZone.ts'), 'utf8')
  assert.match(quiet, /CODE128_QUIET_ZONE_MODULES = 10/)
})

// ── akış korumaları ──────────────────────────────────────────────────────

test('LIVE-17/18: READY siparişte create YOK, Chrome print çağrılır', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const plan = resolveSuratCreateAndPrintPlan([liveOrder()], {
    isSuratOrder: () => true,
    resolveDesiBlock: () => null,
    resolveFitBlock: () => null,
    resolveDataBlock: () => null,
    hasPrintableLabel: () => true,
    isPrinted: () => false,
    isInFlight: () => false,
  })
  assert.equal(plan.needsCreate.length, 0, 'READY -> create YOK')
  assert.equal(plan.readyToPrint.length, 1)
  // Chrome print yolu: kalıcı gizli iframe + window.print, popup YOK.
  const printer = readFileSync(
    join(here, '..', 'src/utils/browserLabelPrint.ts'), 'utf8')
  assert.match(printer, /frameWindow\.print\(\)/)
  assert.match(printer, /ensurePersistentPrintFrame/)
  assert.equal(/window\.open\(/.test(printer), false)
})

test('LIVE-19/20: imkânsız içerik AÇIK hata verir, batch\'i durdurmaz', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const { PRODUCT_OVERFLOW_MESSAGE } = await load('/src/utils/labelProductFit.ts')
  const impossible = {
    ...liveOrder(Array.from({ length: 12 }, (_, i) => ({
      id: `x${i}`, quantity: 1, productName: 'Z'.repeat(160),
      color: 'Lacivert', size: '40', sku: `sku${i}`,
    }))),
    id: 'o-impossible', orderNumber: '7270035237446595',
  }
  const mixed = buildCleanLabelDocument([liveOrder(), impossible], TEMPLATE, {})
  assert.equal(mixed.printable.length, 1, 'canlı sipariş basılır')
  assert.equal(mixed.printable[0].model.orderNumber, LIVE_ORDER_NO)
  assert.equal(mixed.skipped.length, 1)
  assert.equal(mixed.skipped[0].reason, PRODUCT_OVERFLOW_MESSAGE)
})

test('LIVE-21/22: native/Zebra yoluna HTML fit SIZMAZ, resmî ZPL değişmez', () => {
  const provider = readFileSync(
    join(here, '..', 'src/providers/printing/BrowserDownloadPrintProvider.ts'),
    'utf8')
  const zebra = provider.slice(provider.indexOf("'/api/printing/zebra/raw'"))
  for (const leak of [
    'buildCleanLabelDocument', 'printCleanLabelDocument', 'resolveProductFit',
    'resolveLabelLayout', 'resolveRouteFit',
  ]) {
    assert.equal(zebra.includes(leak), false, `Zebra dalına sızdı: ${leak}`)
  }
  assert.match(zebra, /jobs: data\.jobs/)
  // RESMÎ SÜRAT PNG DALI da HTML-OLMAYAN bir yoldur: HTML belge üreticisi veya
  // ürün-sığdırma çözümleyicisi bu dala SIZMAMALIDIR.
  const officialStart = provider.indexOf('(await printOfficialSuratLabels(')
  const officialEnd = provider.indexOf('await printCleanLabelDocument(')
  assert.ok(officialStart > 0 && officialEnd > officialStart, 'iki dal da var')
  const officialBranch = provider.slice(officialStart, officialEnd)
  for (const leak of [
    'buildCleanLabelDocument', 'resolveProductFit',
    'resolveLabelLayout', 'resolveRouteFit',
  ]) {
    assert.equal(
      officialBranch.includes(leak),
      false,
      `Resmî Sürat dalına sızdı: ${leak}`,
    )
  }
  const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
  // SÖZLEŞME GENİŞLETİLDİ (fix/official-surat-print-skip) — GEVŞETİLMEDİ:
  // ürün-sığdırma kapısı artık HEM Zebra/native HEM resmî Sürat PNG yolunda
  // devre dışıdır. İddia tek koşul yerine İKİ koşulu birden arar.
  assert.match(
    app,
    /printerSettings\.mode !== 'browser-print' \|\|\s*\n?\s*templateDecision\.template === 'surat_official_zpl'\s*\n?\s*\? null/,
  )
})

test('LIVE-23/24/25: ortak handler, popup yok, PII loglanmaz', () => {
  const app = readFileSync(join(here, '..', 'src/App.tsx'), 'utf8')
  assert.match(app, /handleCreateAndPrintCarrierLabelsForIds/)
  assert.match(app, /handleCreateAndPrintCarrierLabelForOrder/)
  for (const file of ['src/App.tsx', 'src/utils/browserLabelPrint.ts',
    'src/components/LabelHtmlPreview.tsx', 'src/utils/labelLayoutResolver.ts']) {
    const src = readFileSync(join(here, '..', file), 'utf8')
    assert.equal(/window\.confirm\(|window\.alert\(/.test(src), false, file)
    assert.equal(/Baskı sonucu bekleniyor|Evet, çıktı/.test(src), false, file)
  }
  // Cozumleyici PII TASIMAZ: yalniz urun/rota metni ve olculer.
  const resolver = readFileSync(
    join(here, '..', 'src/utils/labelLayoutResolver.ts'), 'utf8')
  // NOT: 'addressRowMm' bir YERLESIM olcusudur, PII degildir; bu yuzden
  // alan adlari tam eslesme ile aranir.
  for (const pii of [
    'customerName', 'customerPhone', 'order.address', 'barcodeRaw',
    'recipientName', 'zplContent',
  ]) {
    assert.equal(resolver.includes(pii), false, `resolver PII: ${pii}`)
  }
})
