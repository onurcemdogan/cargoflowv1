import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// İSTEMCİ BASILABİLİRLİK ÖNCELİĞİ — AŞAMA 3A / ADIM 3.
//
// SÖZLEŞME
//   İstemci basılacak ZPL'i SEÇMEZ. `shipment.barcodeRaw`,
//   `shipment.technicalZpl`, `suratCreateLog.BarcodeRaw` taşıyıcı KAYNAKTIR;
//   basılabilir ÇIKTI değildir. Karar sunucunundur:
//     kalıcı tam paket > hydration > doğrulanmış taşıyıcı fallback > BLOCK
//
//   FAIL-OPEN: ürün detay sayfası üretilemediyse ana kargo etiketi YİNE
//   basılır. FAIL-CLOSED: sunucu "basılamaz" dediyse istemci kaynağa DÜŞMEZ.

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

const mod = () => load('/src/utils/persistedLabel.ts')

const CARRIER_NEW = '^XA^FDSUNUCU-TASIYICI^FS^XZ'
const SOURCE_OLD = '^XA^FDESKI-KAYNAK^FS^XZ'
const detail = (page, totalPages) => ({
  page,
  totalPages,
  zpl: `^XA^FDDETAY-${page}^FS^XZ`,
})

/** Kaynak alanların HEPSİ dolu bir sipariş — istemcinin cazip yolu. */
const orderWithSources = (overrides = {}) => ({
  id: 'order-1',
  orderNumber: 'ORD-1',
  operationStatus: 'LABEL_READY',
  hasPrintableLabel: true,
  shipment: {
    barcodeRaw: SOURCE_OLD,
    technicalZpl: SOURCE_OLD,
    suratCreateLog: { BarcodeRaw: SOURCE_OLD, technicalZpl: SOURCE_OLD },
    suratCreateResponseParsed: { BarcodeRaw: SOURCE_OLD },
    zplReady: true,
    printEnabled: true,
  },
  ...overrides,
})

const contract = (overrides = {}) => ({
  carrierPrintReady: true,
  printArtifactStatus: 'ready',
  productDetailStatus: 'none',
  zpl: CARRIER_NEW,
  desi: 2,
  supplementalLabels: [],
  ...overrides,
})

/** Sipariş nesnesinde HERHANGİ bir yerde kaynak ZPL kaldı mı? */
function containsSource(order) {
  return JSON.stringify(order ?? {}).includes('ESKI-KAYNAK')
}

// ═══ TEMEL SÖZLEŞME: İSTEMCİ SEÇMEZ ══════════════════════════════════════

test('CLIENT-0: resolvePersistedLabelArtifact ASLA kaynaktan ZPL seçmez', async () => {
  const { resolvePersistedLabelArtifact } = await mod()
  const artifact = resolvePersistedLabelArtifact(orderWithSources())
  assert.equal(artifact.zpl, null, 'basılabilir çıktı istemciden SEÇİLMEZ')
  // Etiketin VARLIĞI hâlâ bilinir (fetch kararı bozulmaz).
  assert.equal(artifact.hasPrintableLabel, true)
  assert.equal(artifact.source, 'pending-fetch')

  // Kaynak alanı hiç olmayan ve bayrağı da olmayan sipariş: etiket yok.
  const empty = resolvePersistedLabelArtifact({
    id: 'x',
    orderNumber: 'X',
    hasPrintableLabel: false,
    shipment: {},
  })
  assert.equal(empty.hasPrintableLabel, false)
  assert.equal(empty.source, 'none')
})

// ═══ CLIENT-1: KALICI PAKET KAYNAĞI YENER ════════════════════════════════

test('CLIENT-1: kalıcı paket + technicalZpl → KALICI PAKET kazanır', async () => {
  const { applyServerPrintContract } = await mod()
  const applied = applyServerPrintContract(
    orderWithSources(),
    contract({
      productDetailStatus: 'ready',
      supplementalLabels: [detail(1, 2), detail(2, 2)],
    }),
  )
  assert.equal(applied.shipment.barcodeRaw, CARRIER_NEW, 'sunucu baytları')
  assert.notEqual(applied.shipment.barcodeRaw, SOURCE_OLD)
  assert.equal(applied.shipment.printBundle.labelPageCount, 3)
  assert.equal(applied.shipment.printBundle.productDetailPageCount, 2)
  assert.equal(applied.shipment.printBundle.productDetailStatus, 'ready')
})

// ═══ CLIENT-2: SUNUCU FALLBACK'İ KULLANILIR ══════════════════════════════

test('CLIENT-2: sunucu carrier_fallback + technicalZpl → SUNUCU fallback kullanılır', async () => {
  const { applyServerPrintContract } = await mod()
  const applied = applyServerPrintContract(
    orderWithSources(),
    contract({
      printArtifactStatus: 'fallback_carrier',
      productDetailStatus: 'failed',
      productDetailFailureReason: 'supplemental_geometry_failure',
    }),
  )
  assert.equal(applied.shipment.barcodeRaw, CARRIER_NEW)
  assert.equal(applied.shipment.printBundle.printArtifactStatus, 'fallback_carrier')
  assert.equal(applied.shipment.printBundle.labelPageCount, 1)
})

// ═══ CLIENT-3: BASILAMAZ → KAYNAĞA DÜŞÜLMEZ ══════════════════════════════

test('CLIENT-3: sunucu basılamaz dediyse istemci technicalZpl’e DÜŞMEZ', async () => {
  const { applyServerPrintContract, stripClientPrintSources } = await mod()
  const { resolveSuratPrintEligibility } = await load(
    '/src/utils/suratPrintEligibility.ts',
  )

  for (const blocking of [
    null,
    contract({ carrierPrintReady: false, printArtifactStatus: 'failed' }),
    contract({ carrierPrintReady: false, zpl: null }),
    // Taşıyıcı "hazır" ama bayt YOK: yine basılamaz.
    contract({ zpl: null }),
    contract({ zpl: '   ' }),
  ]) {
    const applied = applyServerPrintContract(orderWithSources(), blocking)
    assert.equal(
      containsSource(applied),
      false,
      'kaynak ZPL etkin kopyadan TEMİZLENMELİ',
    )
    assert.equal(applied.shipment.barcodeRaw, undefined)
    assert.equal(applied.shipment.technicalZpl, undefined)
    assert.equal(applied.shipment.suratCreateLog.BarcodeRaw, undefined)
    assert.equal(applied.shipment.printEnabled, false)
    assert.equal(applied.shipment.zplReady, false)
    // Aşağı akıştaki baskı kapısı da ZPL BULAMAZ.
    const eligibility = resolveSuratPrintEligibility(applied)
    assert.ok(
      !eligibility.barcodeRaw || eligibility.barcodeRaw.trim() === '',
      'baskı kapısı kaynağı BULMAMALI',
    )
  }

  // Doğrudan temizleyici de aynı garantiyi verir.
  assert.equal(containsSource(stripClientPrintSources(orderWithSources())), false)
})

// SÖZLEŞME AYNI, KONUM DEĞİŞTİ: hidrasyon App.tsx closure'ından test
// edilebilir bir modüle çıkarıldı (services/persistedLabelHydration.ts).
// İddialar GEVŞETİLMEDİ; kodun YENİ yerinde doğrulanıyor. Ayrıca App.tsx'in
// gerçekten o modülü çağırdığı da kilitleniyor.
test('CLIENT-3b: hidrasyon bilinmeyen hatada kaynağa DÜŞMEZ', async () => {
  const body = readFileSync(
    join(here, '..', 'src', 'services', 'persistedLabelHydration.ts'),
    'utf8',
  )
  // Sunucu yetkisi kullanılır.
  assert.ok(body.includes('applyServerPrintContract'))
  assert.ok(body.includes('stripClientPrintSources'))
  // ESKİ KAPI YOK: "ham ZPL bellekte yok" koşuluna göre karar VERİLMEZ.
  assert.equal(/const needsZpl\s*=\s*!artifact\.zpl/.test(body), false)
  // İstemci kaynaktan basılabilir bayt OKUMAZ.
  assert.equal(/shipment\?\.barcodeRaw/.test(body), false)
  // catch bloğu kaynağa düşmez, engeller.
  const tail = body.slice(body.indexOf('} catch'))
  assert.ok(tail.includes('blocked.add'))
  // KARDİNALİTE KORUNUR: sipariş listesi filtrelenmez, map edilir.
  assert.ok(body.includes('baseOrders.map('))
  assert.equal(/effectiveOrders\s*=\s*baseOrders\.filter/.test(body), false)

  // App.tsx bu modülü GERÇEKTEN kullanır (kopya mantık kalmadı).
  const app = readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8')
  assert.ok(app.includes('persistedLabelHydration'))
  assert.ok(app.includes('hydratePersistedLabelsFor'))
})

// ═══ CLIENT-4: ESKİ TEK SAYFA ════════════════════════════════════════════

test('CLIENT-4: eski tek sayfa artefakt → mevcut reprint davranışı', async () => {
  const { applyServerPrintContract } = await mod()
  const applied = applyServerPrintContract(orderWithSources(), contract())
  assert.equal(applied.shipment.barcodeRaw, CARRIER_NEW)
  assert.equal(applied.shipment.printBundle.labelPageCount, 1)
  assert.equal(applied.shipment.printBundle.productDetailPageCount, 0)
  assert.equal(applied.shipment.printBundle.productDetailStatus, 'none')
  assert.equal(applied.shipment.zplReady, true)
  assert.equal(applied.shipment.printEnabled, true)
  // Kalıcı desi yansıtılır (reprint "Top Ds/Kg" kaybolmasın).
  assert.equal(applied.desi, 2)
})

// ═══ CLIENT-5: EK SAYFA ÇÖKTÜ AMA TAŞIYICI HAZIR ═════════════════════════

test('CLIENT-5: ürün detay FAILED + taşıyıcı HAZIR → ana etiket basılabilir', async () => {
  const { applyServerPrintContract } = await mod()
  const applied = applyServerPrintContract(
    orderWithSources(),
    contract({
      printArtifactStatus: 'fallback_carrier',
      productDetailStatus: 'failed',
      productDetailFailureReason: 'supplemental_geometry_failure',
    }),
  )
  // FAIL-OPEN: ürün detayı eksik diye ANA baskı engellenmez.
  assert.equal(applied.shipment.printEnabled, true)
  assert.equal(applied.shipment.barcodeRaw, CARRIER_NEW)
  // UYARI KAYBOLMAZ.
  assert.equal(applied.shipment.printBundle.productDetailStatus, 'failed')
  assert.equal(
    applied.shipment.printBundle.productDetailFailureReason,
    'supplemental_geometry_failure',
  )
})

// ═══ CLIENT-6: HYDRATION ÜRETİM YAPMAZ ═══════════════════════════════════

test('CLIENT-6: istemci ürün toplama / composer ÇALIŞTIRMAZ', async () => {
  const forbidden =
    /aggregateProductLineItems|planProductDetailPages|buildProductDetailLabels|composeSuratDurusoftLabel|deriveAugmentedSuratZpl/
  const persisted = readFileSync(
    join(here, '..', 'src', 'utils', 'persistedLabel.ts'),
    'utf8',
  )
  assert.equal(forbidden.test(persisted), false, 'persistedLabel ÜRETİM yapmamalı')

  const app = readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8')
  const start = app.indexOf('async function hydratePersistedLabels')
  const body = app.slice(start, app.indexOf('\n  // ── BASKI ŞABLONU', start))
  assert.equal(forbidden.test(body), false, 'hydration ÜRETİM yapmamalı')
  // Sayfalar TEK canonical kurucudan geçer; istemci kendi birleştirmesini
  // YAZMAZ.
  assert.ok(persisted.includes('buildPrintableJob'))
})

// ═══ CLIENT-7: SAYFA SIRASI KORUNUR ══════════════════════════════════════

test('CLIENT-7: sunucunun sayfa sırası KAYBOLMAZ', async () => {
  const { applyServerPrintContract } = await mod()
  const applied = applyServerPrintContract(
    orderWithSources(),
    contract({
      productDetailStatus: 'ready',
      supplementalLabels: [detail(1, 3), detail(2, 3), detail(3, 3)],
    }),
  )
  const pages = applied.shipment.printBundle.pages
  assert.deepEqual(
    pages.map((page) => page.kind),
    ['carrier', 'product_detail', 'product_detail', 'product_detail'],
  )
  assert.deepEqual(pages.slice(1).map((page) => page.page), [1, 2, 3])
  assert.equal(pages[0].zpl, CARRIER_NEW, 'taşıyıcı HER ZAMAN ilk')

  // Sıra bozuk gelirse iş ÜRETİLMEZ ve baskı açılmaz (kısmi baskı YOK).
  const broken = applyServerPrintContract(
    orderWithSources(),
    contract({ supplementalLabels: [detail(2, 2), detail(1, 2)] }),
  )
  assert.equal(broken.shipment.printEnabled, false)
  assert.equal(containsSource(broken), false)
})

// ═══ CLIENT-8: GELİŞMİŞ ŞABLON REGRESYONU ════════════════════════════════

test('CLIENT-8: şablon yönlendirmesi bozulmadı (ana buton / gelişmiş)', async () => {
  const routing = await load('/src/utils/labelPrintTemplateRouting.ts')
  const { resolveLabelPrintTemplateDecision, DEFAULT_LABEL_PRINT_TEMPLATE } = routing
  // ANA BUTON: organizasyon ayarı ne olursa olsun Sürat.
  assert.equal(
    resolveLabelPrintTemplateDecision({
      intent: 'primary',
      orders: [],
      organizationTemplate: 'cargoflow_html',
    }).template,
    DEFAULT_LABEL_PRINT_TEMPLATE,
  )
  // GELİŞMİŞ: organizasyon ayarı geçerli kalır.
  assert.equal(
    resolveLabelPrintTemplateDecision({
      intent: 'advanced',
      orders: [],
      organizationTemplate: 'cargoflow_html',
    }).template,
    'cargoflow_html',
  )
  // GELİŞMİŞ + açık geçersiz kılma.
  assert.equal(
    resolveLabelPrintTemplateDecision({
      intent: 'advanced',
      orders: [],
      organizationTemplate: 'surat_official_zpl',
      templateOverride: 'cargoflow_html',
    }).template,
    'cargoflow_html',
  )
})

// ═══ SERVİS SÖZLEŞMESİ ═══════════════════════════════════════════════════

test('CLIENT-9: servis sunucu özetini KAPALI SÖZLÜKLE normalize eder', async () => {
  const source = readFileSync(
    join(here, '..', 'src', 'services', 'orderWorkflowService.ts'),
    'utf8',
  )
  const start = source.indexOf('function normalizeServerPrintContract')
  assert.ok(start > 0)
  // Fonksiyonun KENDİ gövdesi: ilk sütundaki kapanış süslü parantezine kadar.
  const closing = source.indexOf(`${String.fromCharCode(10)}}`, start)
  assert.ok(closing > start)
  const body = source.slice(start, closing)
  // Bilinmeyen durum GÜVENLİ tarafa düşer.
  assert.ok(body.includes(": 'failed'"))
  // Taşıyıcı kapısı SUNUCUNUN bayrağıdır; istemci türetmez.
  assert.ok(body.includes('carrierPrintReady'))
  assert.equal(/technicalZpl|barcodeRaw/.test(body), false)
})
