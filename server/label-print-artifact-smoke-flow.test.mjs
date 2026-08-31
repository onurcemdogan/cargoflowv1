import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ═══ GERÇEK ARTEFAKT BASKI DUMANI — TAŞIYICI ÇAĞRISI YOK ═════════════════
//
// ═══ NEYİ KAPATIR ════════════════════════════════════════════════════════
// Düzenleyici testleri belgeyi ve tuvali kanıtlar; parite testleri listeyi
// kanıtlar. Kanıtlanmamış tek şey KALDI: KAYITLI GERÇEK bir Sürat
// artefaktından yola çıkıp UYGULAMANIN KENDİ yolundan geçerek basılabilir
// HTML üretmek ve o çıktının kimlik değerlerini artefaktla karşılaştırmak.
//
// Zincir (kısayol YOK, her adım üretim kodu):
//   kayıtlı artefakt (şifreli carrier payload)
//     → listOrdersForWorkspace + projectClientDerivedOrders   (sunucu okuma)
//     → buildSuratPrintPageModel                              (kanonik kimlik)
//     → buildLabelData                                        (semantik veri)
//     → YAYINLANMIŞ kiracı belgesi                            (yerleşim)
//     → renderLabelDocument                                   (ilkeller)
//     → primitivesToPrintHtml                                 (baskı HTML'i)
//
// ═══ SÜRAT'A ÇAĞRI YAPILMAZ ══════════════════════════════════════════════
// Artefakt repodaki MASKELENMİŞ gerçek fixture'dan gelir
// (server/fixtures/surat-real-success-11415535074.zpl). Bu paket koşarken
// global `fetch` ve node:http/https istekleri TUZAKLANIR; bir tanesi bile
// çalışırsa test DÜŞER. CARRIER_CREATE_CALLS=0, SURAT_NETWORK_CALLS=0.
//
// ═══ NEDEN "ÖNİZLEME ÇALIŞIYOR" YETMEZ ═══════════════════════════════════
// En sinsi hata, tuvalde doğru görünen bir etiketin baskıda sessizce
// ayrışmasıdır. PRINT-11 baskı HTML'ini GERİ ÇÖZER ve tuvalin kullandığı
// ilkellerle birebir karşılaştırır; PRINT-14 yapısal anlık görüntüyü kilitler.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.SHIPMENT_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY ??= randomBytes(32).toString('hex')

/* ═══ AĞ TUZAĞI — HERHANGİ BİR ÇIKIŞ TESTİ DÜŞÜRÜR ═══════════════════ */

const networkCalls = []
const realFetch = globalThis.fetch
globalThis.fetch = (...args) => {
  networkCalls.push(String(args[0]?.url ?? args[0] ?? ''))
  throw new Error('AĞ ÇAĞRISI YASAK: baskı yolu taşıyıcıya ÇIKMAZ.')
}
const http = await import('node:http')
const https = await import('node:https')
for (const [name, module] of [['http', http], ['https', https]]) {
  const original = module.default.request
  module.default.request = (...args) => {
    networkCalls.push(`${name}:${String(args[0]?.host ?? args[0] ?? '')}`)
    throw new Error('AĞ ÇAĞRISI YASAK: baskı yolu taşıyıcıya ÇIKMAZ.')
  }
  void original
}
after(() => {
  globalThis.fetch = realFetch
})

function migrationStatements() {
  const dir = join(root, 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

/** Depodaki MASKELENMİŞ gerçek Sürat başarı artefaktı. */
const REAL_ZPL = readFileSync(
  join(root, 'server', 'fixtures', 'surat-real-success-11415535074.zpl'),
  'utf8',
)
/** Fixture dosya adındaki gerçek (maskelenmemiş) T.No. */
const REAL_TRACKING = '11415535074'

const LONG_ADDRESS =
  'Cumhuriyet Mahallesi, Şehit Piyade Onbaşı Mehmet Akif Ersoy Caddesi ' +
  'No: 274/B, Gülbahçe Konakları A5 Blok, Kat: 12 Daire: 47, ' +
  'Kapı kodu 4821, Zil: Çağatayoğlu, tarif: eczanenin arkası'
const NORMAL_ADDRESS = 'Örnek Mahallesi Örnek Caddesi No: 12/3 Daire 7'

const ITEMS = [
  {
    productName: 'Oversize Pamuklu Sweatshirt',
    quantity: 2,
    color: 'Lacivert',
    size: 'M',
    sku: 'SKU-SWEAT-1',
  },
  {
    productName: 'Yüksek Bel Kot Pantolon',
    quantity: 1,
    color: 'Siyah',
    size: '40',
    sku: 'SKU-JEAN-2',
  },
]

/**
 * KAYITLI GERÇEK ARTEFAKT tohumlar.
 *
 * Barkod kimliği ELLE YAZILMAZ: ham ZPL, üretimdeki AYNI çözümleyiciden
 * (`analyzeSuratZpl`) geçirilir ve kabul edilen barkod kalıcı gönderi
 * görünümüne oradan yazılır. Böylece testin beklentisi de artefakttan
 * türetilmiş olur; sabit bir dizeyi kendine doğrulatmaz.
 */
async function seedArtifactOrder(db, schema, organizationId, options) {
  const { analyzeSuratZpl } = await load('/src/utils/suratZplAnalysis.ts')
  const printRepo = await load('/server/shipments/printZplRepository.ts')
  const encryption = await load('/server/shipments/shipmentEncryption.ts')
  const orderEncryption = await load('/server/orders/orderEncryption.ts')

  const analysis = analyzeSuratZpl(REAL_ZPL)
  const barcode = analysis.acceptedFinalBarcode
  assert.ok(barcode, 'fixture artefaktı kanonik barkod TAŞIMALI')

  const payload = printRepo.attachPrintZplArtifact(
    {
      technicalZpl: REAL_ZPL,
      carrierTrackingNumber: options.trackingNumber,
      carrierBarcodeNumber: barcode,
      ozelKargoTakipNo: barcode,
      labelStatus: 'READY',
      dispatchRegistrationConfirmed: true,
      shipment: {
        tNo: options.trackingNumber,
        kargoTakipNo: options.trackingNumber,
        barkodNo: barcode,
        ozelKargoTakipNo: barcode,
        barcodeRaw: REAL_ZPL,
        labelStatus: 'READY',
        printEnabled: true,
        zplReady: true,
        lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
        candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
        desi: 2,
      },
    },
    ITEMS,
    '2026-08-27T00:00:00.000Z',
  )

  await db.insert(schema.orders).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: options.packageId,
    orderNumber: options.orderNumber,
    customerFirstName: 'Şükrü',
    customerLastName: 'Öztürkoğlu',
    customerPhone: '05380000000',
    shippingCity: 'İstanbul',
    shippingDistrict: 'Kadıköy',
    shippingAddressEncrypted: orderEncryption.encryptOrderPayload({
      fullAddress: options.address,
    }),
    marketplaceStatus: 'Created',
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    operationStatus: 'LABEL_READY',
  })
  const rows = await db.select().from(schema.orders)
  const row = rows.find((item) => item.packageId === options.packageId)
  await db.insert(schema.orderLines).values(
    ITEMS.map((item, index) => ({
      organizationId,
      orderId: row.id,
      externalLineId: `${options.packageId}-L-${index}`,
      productName: item.productName,
      merchantSku: item.sku,
      quantity: item.quantity,
      variantAttributes: [
        { key: 'Renk', value: item.color },
        { key: 'Beden', value: item.size },
      ],
    })),
  )
  await db.insert(schema.shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: options.packageId,
    orderNumber: options.orderNumber,
    provider: 'surat',
    source: 'local_create',
    status: 'created',
    trackingNumber: options.trackingNumber,
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
  })
  return { barcode, analysis }
}

async function makeDb() {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await load('/server/db/schema.ts')
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'print', slug: `print-${randomBytes(4).toString('hex')}` })
    .returning()
  return { pglite, db, schema, organizationId: org.id }
}

const TEMPLATE = {
  id: 'tpl-smoke',
  name: 'Sürat 10x10',
  widthMm: 100,
  heightMm: 100,
}

/**
 * TAM ZİNCİR. Tek yerde toplanır ki her test AYNI üretim yolundan geçsin.
 *
 * `documentMutator` verilirse YAYINLANAN belge değiştirilir — muhafız
 * testleri bozuk yerleşimi buradan enjekte eder.
 */
async function runPrintChain(options = {}) {
  const { pglite, db, schema, organizationId } = await makeDb()
  const seeded = await seedArtifactOrder(db, schema, organizationId, {
    packageId: 'PKG-ART-1',
    orderNumber: 'ORD-ART-1',
    trackingNumber: REAL_TRACKING,
    address: options.address ?? NORMAL_ADDRESS,
  })
  if (options.secondOrder) {
    await seedArtifactOrder(db, schema, organizationId, {
      packageId: 'PKG-ART-2',
      orderNumber: 'ORD-ART-2',
      trackingNumber: '11415535075',
      address: NORMAL_ADDRESS,
    })
  }

  const shipmentsBefore = await db.select().from(schema.shipments)

  // ── Sunucu okuma yolu (istemci türetmeleri DAHİL) ──────────────────
  const persistence = await load('/server/orders/orderPersistenceService.ts')
  const workspace = await load('/server/orders/ordersWorkspaceService.ts')
  const raw = await persistence.listOrdersForWorkspace(db, organizationId, undefined)
  const orders = workspace.projectClientDerivedOrders(raw, { entries: {} })

  // ── Kiracı belgesi: sistem şablonundan taslak → YAYINLA ────────────
  const repo = await load('/server/labels/labelDocumentRepository.ts')
  const now = '2026-08-27T00:00:00.000Z'
  const created = await repo.createLabelDocumentFromSystem(
    db, organizationId, 'surat-classic-100x100', 'Baskı Dumanı', now, 'tpl_smoke',
  )
  const document = options.documentMutator
    ? options.documentMutator(structuredClone(created.draft))
    : created.draft
  const saved = await repo.saveLabelDocumentDraft(
    db, organizationId, 'tpl_smoke', document, created.version, now,
  )
  await repo.activateLabelDocument(db, organizationId, 'tpl_smoke', saved.version, now)
  const active = await repo.resolveActiveLabelDocument(db, organizationId)
  assert.ok(active, 'YAYINLANMIŞ belge okunabilmeli')

  // ── Baskı: uygulamanın GERÇEK giriş noktası ────────────────────────
  const print = await load('/src/utils/browserLabelPrint.ts')
  const result = print.buildCleanLabelDocument(
    orders, TEMPLATE, {}, [], active,
  )

  // ── Önizleme: düzenleyicinin kullandığı AYNI kaynak ────────────────
  const previewSource = await load('/src/labels/labelPreviewSource.ts')
  const renderer = await load('/src/labels/labelDocumentRenderer.ts')
  const preview = previewSource.buildEditorPreviewSource(orders, [])
  const rendered = renderer.renderLabelDocument(active, preview.source)

  const shipmentsAfter = await db.select().from(schema.shipments)
  return {
    pglite, db, schema, organizationId, orders, seeded, preview, rendered,
    result, document: active, shipmentsBefore, shipmentsAfter,
    printModel: result.printable[0]?.model,
  }
}

/** Baskı HTML'ini GERİ ÇÖZER: yerleşim/kimlik iddiaları HTML'den okunur. */
function parsePrintHtml(html) {
  const out = []
  const pattern = /<div class="lp ([^"]+)"([^>]*)style="([^"]*)"[^>]*>/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[2]
    const style = match[3]
    const number = (name) => {
      const found = style.match(new RegExp(`${name}:(-?[\\d.]+)mm`))
      return found ? Number(found[1]) : null
    }
    const attribute = (name) => {
      const found = attributes.match(new RegExp(`${name}="([^"]*)"`))
      return found ? found[1] : null
    }
    out.push({
      className: match[1].trim(),
      elementId: attribute('data-element-id'),
      barcodeValue: attribute('data-barcode-value'),
      qrValue: attribute('data-qr-value'),
      rect: {
        x: number('left'), y: number('top'),
        width: number('width'), height: number('height'),
      },
    })
  }
  return out
}

/* ═══ PRINT-01..02 — GERÇEK ARTEFAKT VE FİZİKSEL GEOMETRİ ══════════ */

test('PRINT-01: kayıtlı GERÇEK artefakt baskı yoluna ulaşır (taşıyıcı çağrısı YOK)', async () => {
  const ctx = await runPrintChain()
  try {
    assert.equal(ctx.orders.length, 1)
    assert.equal(ctx.result.printable.length, 1, 'sipariş yazdırılabilir olmalı')
    assert.deepEqual(ctx.result.skipped, [])
    assert.equal(ctx.preview.isDemo, false, 'önizleme DEMO değil, GERÇEK sipariş')

    // Ham artefakt DB'den GERİ okunduğunda fixture ile BAYT BAYT aynıdır.
    assert.equal(
      ctx.orders[0].shipment.barcodeRaw,
      REAL_ZPL,
      'kayıtlı ham ZPL fixture ile AYNI olmalı',
    )
    assert.equal(networkCalls.length, 0, `SURAT_NETWORK_CALLS=0 (${networkCalls})`)
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-02: fiziksel geometri 10×10 cm — sayfa VE her öğe sınır içinde', async () => {
  const ctx = await runPrintChain()
  try {
    const geometry = await load('/src/labels/labelGeometry.ts')
    assert.match(ctx.result.html, /@page \{ size: 100mm 100mm; margin: 0; \}/)
    assert.match(ctx.result.html, /width: 100mm;/)

    // Her sayfa KENDİ 100×100 mm kutusunda konumlanır. Konteyner olmasaydı
    // mutlak konumlu öğeler gövdeye göre yerleşir ve çok etiketli baskıda
    // ÜST ÜSTE binerdi (önizlemede görülmeyen bir ayrışma).
    const pages = ctx.result.html.match(/class="lp-page"/g) ?? []
    assert.equal(pages.length, 1, 'tek sipariş → tek sayfa konteyneri')
    assert.match(
      ctx.result.html,
      /\.lp-page \{[^}]*position: relative;/,
      'sayfa konteyneri konumlandırma bağlamı OLUŞTURMALI',
    )

    for (const primitive of ctx.rendered.primitives) {
      const { x, y, width, height } = primitive.rect
      assert.ok(x >= 0 && y >= 0, `${primitive.elementId} negatif konumda`)
      assert.ok(
        x + width <= geometry.LABEL_CANVAS_WIDTH_MM + 0.001 &&
          y + height <= geometry.LABEL_CANVAS_HEIGHT_MM + 0.001,
        `${primitive.elementId} 100×100 mm dışına taşıyor`,
      )
    }
    assert.equal(networkCalls.length, 0)
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-02b: ÇOK etiketli baskı sayfaları ÜST ÜSTE binmez', async () => {
  const ctx = await runPrintChain({ secondOrder: true })
  try {
    assert.equal(ctx.result.printable.length, 2)
    const pages = ctx.result.html.match(/class="lp-page"/g) ?? []
    assert.equal(pages.length, 2, 'iki sipariş → iki sayfa konteyneri')
    assert.match(
      ctx.result.html,
      /\.lp-page \{[^}]*page-break-after: always;/,
      'sayfalar arasında baskı sayfa sonu OLMALI',
    )
  } finally {
    await ctx.pglite.close()
  }
})

/* ═══ PRINT-03..05 — KİMLİK DEĞERLERİ ARTEFAKTTAN GELİR ════════════ */

test('PRINT-03: TAKİP metni artefakt kaydındaki T.No ile AYNI', async () => {
  const ctx = await runPrintChain()
  try {
    assert.equal(ctx.printModel.trackingNumber, REAL_TRACKING)
    const tracking = ctx.rendered.primitives.find(
      (item) => item.type === 'trackingText',
    )
    assert.ok(tracking, 'takip metni öğesi bulunmalı')
    assert.deepEqual(tracking.lines, [REAL_TRACKING])
    assert.ok(
      ctx.result.html.includes(REAL_TRACKING),
      'baskı HTML\'i takip numarasını TAŞIMALI',
    )
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-04: BARKOD yükü artefaktın CODE128 yüküyle BİREBİR aynı', async () => {
  const ctx = await runPrintChain()
  try {
    // Beklenti artefakttan YENİDEN türetilir (sabit dize değil).
    const { analyzeSuratZpl } = await load('/src/utils/suratZplAnalysis.ts')
    const fromDb = analyzeSuratZpl(ctx.orders[0].shipment.barcodeRaw)
    const expected = fromDb.acceptedFinalBarcode
    assert.ok(expected)
    assert.equal(ctx.printModel.barcodeNumber, expected)

    const barcode = ctx.rendered.primitives.find((item) => item.kind === 'barcode')
    assert.ok(barcode, 'barkod ilkeli bulunmalı')
    assert.equal(barcode.value, expected, 'barkod yükü DEĞİŞMEMELİ')
    // ZPL alt küme öneki (`>:`) yüke SIZMAZ.
    assert.ok(!barcode.value.startsWith('>'), 'ZPL öneki yüke sızmamalı')

    const parsed = parsePrintHtml(ctx.result.html)
    const printed = parsed.find((item) => item.className.includes('lp-barcode'))
    assert.equal(printed.barcodeValue, expected, 'baskı HTML barkodu AYNI olmalı')
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-05: QR yükü kanonik müşteri referansıyla AYNI, şablon YAZAMAZ', async () => {
  const ctx = await runPrintChain()
  try {
    const expected = ctx.printModel.ozelKargoTakipNo
    assert.ok(expected, 'kanonik QR yükü boş olamaz')
    const qr = ctx.rendered.primitives.find((item) => item.kind === 'qr')
    assert.ok(qr, 'QR ilkeli bulunmalı')
    assert.equal(qr.value, expected)
    const parsed = parsePrintHtml(ctx.result.html)
    const printed = parsed.find((item) => item.className.includes('lp-qr'))
    assert.equal(printed.qrValue, expected)
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-05b: şablon KİMLİK değerlerini EZEMEZ (yerleşim değişse bile)', async () => {
  // Belgeye başka bir numara yazan statik metin eklenir ve kimlik öğeleri
  // taşınır. Yerleşim değişir; barkod/QR YÜKÜ DEĞİŞMEZ.
  const ctx = await runPrintChain({
    documentMutator: (draft) => {
      draft.elements.push({
        id: 'static-fake',
        type: 'staticText',
        text: '99999999999',
        x: 2, y: 92, width: 40, height: 5, z: 99, visible: true, fontSize: 6,
      })
      for (const element of draft.elements) {
        if (element.type === 'barcode') element.y = Math.max(0, element.y - 1)
      }
      return draft
    },
  })
  try {
    const { analyzeSuratZpl } = await load('/src/utils/suratZplAnalysis.ts')
    const expected = analyzeSuratZpl(ctx.orders[0].shipment.barcodeRaw)
      .acceptedFinalBarcode
    const barcode = ctx.rendered.primitives.find((item) => item.kind === 'barcode')
    assert.equal(barcode.value, expected)
    assert.notEqual(barcode.value, '99999999999')
    assert.ok(
      ctx.rendered.primitives.some(
        (item) => item.kind === 'text' && item.lines.includes('99999999999'),
      ),
      'statik metin yerleşime GİRMELİ (ama kimliği ezmemeli)',
    )
  } finally {
    await ctx.pglite.close()
  }
})

/* ═══ PRINT-06..07 — ADRES VE ÜRÜN SATIRLARI ══════════════════════ */

test('PRINT-06: ADRES gerçek siparişten basılır ve içerik KAYBOLMAZ', async () => {
  const ctx = await runPrintChain()
  try {
    const address = ctx.rendered.primitives.find((item) => item.type === 'address')
    assert.ok(address, 'adres öğesi bulunmalı')
    const joined = address.lines.join(' ').replace(/\s+/g, ' ').trim()
    assert.ok(joined.length > 0, 'adres boş basılamaz')
    // Sarma boşlukları değiştirir; KELİMELER kaybolamaz.
    for (const word of ['Örnek', 'Mahallesi', 'Caddesi', '12/3']) {
      assert.ok(joined.includes(word), `adres "${word}" içermeli`)
    }
    assert.equal(address.truncated, false, 'normal adres KIRPILMAMALI')

    const cityDistrict = ctx.rendered.primitives.find(
      (item) => item.type === 'cityDistrict',
    )
    assert.deepEqual(cityDistrict?.lines, ['Kadıköy / İstanbul'])
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-07: ÜRÜN satırları adet/varyant/SKU ile basılır', async () => {
  const ctx = await runPrintChain()
  try {
    const list = ctx.rendered.primitives.find((item) => item.type === 'productList')
    assert.ok(list, 'ürün listesi öğesi bulunmalı')
    const text = list.lines.join(' | ')
    assert.match(text, /2 x Oversize Pamuklu Sweatshirt/)
    assert.match(text, /\[SKU-SWEAT-1\]/)
    assert.ok(
      ctx.result.html.includes('Oversize Pamuklu Sweatshirt'),
      'baskı HTML ürün adını taşımalı',
    )
  } finally {
    await ctx.pglite.close()
  }
})

/* ═══ PRINT-08..10 — MUHAFIZLAR ═══════════════════════════════════ */

test('PRINT-08: UZUN adres — sığarsa İÇERİK TAM, sığmazsa AÇIK muhafız', async () => {
  // (a) YAYINLANMIŞ yerleşimle: uzun adres SIĞMALI ya da açıkça bildirilmeli;
  //     hiçbir durumda SESSİZCE kaybolmamalı.
  const fits = await runPrintChain({ address: LONG_ADDRESS })
  try {
    const address = fits.rendered.primitives.find((item) => item.type === 'address')
    assert.ok(address, 'adres öğesi bulunmalı')
    if (!address.truncated) {
      const joined = address.lines.join(' ').replace(/\s+/g, ' ')
      for (const word of ['Cumhuriyet', 'Gülbahçe', 'Çağatayoğlu']) {
        assert.ok(joined.includes(word), `kırpılmadıysa "${word}" görünmeli`)
      }
    } else {
      assert.ok(
        fits.rendered.violations.some(
          (item) => item.code === 'LONG_ADDRESS_OVERFLOW_GUARD',
        ),
        'kırpıldıysa muhafız BİLDİRMELİ',
      )
    }
    assert.equal(fits.result.printable.length, 1, 'etiket yine de BASILIR')
    assert.ok(address.rect.y + address.rect.height <= 100.001)
  } finally {
    await fits.pglite.close()
  }

  // (b) Adres kutusu KÜÇÜLTÜLDÜĞÜNDE muhafız KESİNLİKLE tetiklenir ve
  //     yayınlamayı ENGELLEMEZ (veri kaynaklı taşma, yerleşim hatası değil).
  const tight = await runPrintChain({
    address: LONG_ADDRESS,
    documentMutator: (draft) => {
      const address = draft.elements.find((item) => item.type === 'address')
      address.height = 6
      address.maxLines = 1
      return draft
    },
  })
  try {
    const address = tight.rendered.primitives.find((item) => item.type === 'address')
    assert.equal(address.truncated, true, 'taşma BİLDİRİLMELİ')
    const violation = tight.rendered.violations.find(
      (item) => item.code === 'LONG_ADDRESS_OVERFLOW_GUARD',
    )
    assert.ok(violation, 'uzun adres muhafızı tetiklenmeli')
    assert.equal(violation.blocking, false, 'veri kaynaklı taşma YAYINI ENGELLEMEZ')
    assert.equal(tight.result.printable.length, 1, 'etiket yine de BASILIR')
  } finally {
    await tight.pglite.close()
  }
})

test('PRINT-09: BARKOD üzerine binen öğe ENGELLEYİCİ muhafız üretir', async () => {
  const ctx = await runPrintChain({
    documentMutator: (draft) => {
      const barcode = draft.elements.find((item) => item.type === 'barcode')
      const text = draft.elements.find((item) => item.type === 'recipientName')
      text.x = barcode.x
      text.y = barcode.y
      text.width = barcode.width
      text.height = barcode.height
      return draft
    },
  })
  try {
    const violation = ctx.rendered.violations.find(
      (item) => item.code === 'BARCODE_OVERLAP_GUARD',
    )
    assert.ok(violation, 'barkod binme muhafızı tetiklenmeli')
    assert.equal(violation.blocking, true)
    assert.equal(ctx.rendered.hasBlockingViolation, true)
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-10: QR üzerine binen öğe ENGELLEYİCİ muhafız üretir', async () => {
  const ctx = await runPrintChain({
    documentMutator: (draft) => {
      const qr = draft.elements.find((item) => item.type === 'qr')
      const text = draft.elements.find((item) => item.type === 'recipientName')
      text.x = qr.x
      text.y = qr.y
      text.width = qr.width
      text.height = qr.height
      return draft
    },
  })
  try {
    const violation = ctx.rendered.violations.find(
      (item) => item.code === 'QR_OVERLAP_GUARD',
    )
    assert.ok(violation, 'QR binme muhafızı tetiklenmeli')
    assert.equal(violation.blocking, true)
  } finally {
    await ctx.pglite.close()
  }
})

/* ═══ PRINT-11 — ÖNİZLEME ↔ BASKI BİREBİR ═════════════════════════ */

test('PRINT-11: baskı HTML yerleşimi ÖNİZLEME ilkelleriyle BİREBİR aynı', async () => {
  const ctx = await runPrintChain()
  try {
    const parsed = parsePrintHtml(ctx.result.html)
    assert.equal(
      parsed.length,
      ctx.rendered.primitives.length,
      'baskı ve önizleme AYNI sayıda öğe üretmeli',
    )
    for (const [index, primitive] of ctx.rendered.primitives.entries()) {
      const printed = parsed[index]
      assert.equal(printed.elementId, primitive.elementId, 'öğe sırası AYNI')
      assert.deepEqual(
        printed.rect,
        {
          x: primitive.rect.x, y: primitive.rect.y,
          width: primitive.rect.width, height: primitive.rect.height,
        },
        `${primitive.elementId} yerleşimi AYRIŞMIŞ`,
      )
      if (primitive.kind === 'barcode') {
        assert.equal(printed.barcodeValue, primitive.value)
      }
      if (primitive.kind === 'qr') {
        assert.equal(printed.qrValue, primitive.value)
      }
    }
  } finally {
    await ctx.pglite.close()
  }
})

/* ═══ PRINT-12..13 — TAŞIYICIYA DOKUNULMAZ ════════════════════════ */

test('PRINT-12: CARRIER_CREATE_CALLS=0 — baskı yolunda create/ağ kodu YOK', async () => {
  const ctx = await runPrintChain()
  try {
    assert.equal(networkCalls.length, 0, `ağ çağrısı: ${networkCalls.join(',')}`)
    // Kaynak taraması: baskı zincirindeki modüller ağ/ create çağrısı
    // İÇERMEZ. Çalışma zamanı tuzağı yalnız ÇALIŞAN yolu görür; tarama
    // ölü dalları da kapatır.
    const files = [
      'src/labels/labelDocumentRenderer.ts',
      'src/labels/labelPrintHtml.ts',
      'src/labels/labelPreviewSource.ts',
      'src/labels/labelDocument.ts',
    ]
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8')
      for (const forbidden of ['fetch(', 'axios', 'OrtabBarkod', 'OrtakBarkodOlustur']) {
        assert.ok(
          !source.includes(forbidden),
          `${file} içinde YASAK çağrı: ${forbidden}`,
        )
      }
    }
  } finally {
    await ctx.pglite.close()
  }
})

test('PRINT-13: RAW_CARRIER_ARTIFACT_MUTATED=NO — artefakt baskı sonrası AYNI', async () => {
  const ctx = await runPrintChain()
  try {
    assert.equal(ctx.shipmentsAfter.length, ctx.shipmentsBefore.length)
    for (const [index, before] of ctx.shipmentsBefore.entries()) {
      const after = ctx.shipmentsAfter[index]
      assert.equal(after.trackingNumber, before.trackingNumber)
      assert.equal(
        after.carrierPayloadEncrypted,
        before.carrierPayloadEncrypted,
        'şifreli taşıyıcı yükü DEĞİŞMEMELİ',
      )
      assert.equal(after.status, before.status)
    }
    // Basılan etiket ham ZPL'i DEĞİŞTİRMEZ.
    assert.equal(ctx.orders[0].shipment.barcodeRaw, REAL_ZPL)
  } finally {
    await ctx.pglite.close()
  }
})

/* ═══ PRINT-14 — YAPISAL ANLIK GÖRÜNTÜ ════════════════════════════ */

test('PRINT-14: baskı çıktısının YAPISI kilitlidir (sessiz ayrışma imkânsız)', async () => {
  const ctx = await runPrintChain()
  try {
    // Anlık görüntü DEĞERLERİ değil YAPIYI kilitler: öğe kimliği, türü,
    // kutu geometrisi ve kimlik yüklerinin KAYNAĞI. Bir gün baskı yolu
    // ilkelleri atlayıp kendi yerleşimini kurarsa bu karşılaştırma DÜŞER.
    // JSON gidiş-dönüşü: `undefined` alanlar dosyada YOKTUR, bellekte VARDIR.
    // Karşılaştırma dosyadaki biçimle yapılmalı ki fark GERÇEK bir yapı
    // değişikliğini göstersin, serileştirme ayrıntısını değil.
    const shape = JSON.parse(JSON.stringify(ctx.rendered.primitives.map((primitive) => ({
      id: primitive.elementId,
      kind: primitive.kind,
      type: primitive.type,
      rect: primitive.rect,
      lines: primitive.kind === 'text' ? primitive.lines.length : undefined,
      hasValue: primitive.kind === 'text' ? undefined : primitive.value.length > 0,
    }))))
    const snapshotPath = join(here, 'fixtures', 'surat-render', 'print-document-shape.json')
    // ANLIK GÖRÜNTÜ KENDİLİĞİNDEN GÜNCELLENMEZ. Kasıtlı bir değişiklikte
    // `PRINT_SNAPSHOT_UPDATE=1` ile yeniden yazılır ve fark GÖZDEN GEÇİRİLİR;
    // aksi halde eksik/farklı görüntü testi DÜŞÜRÜR.
    if (process.env.PRINT_SNAPSHOT_UPDATE === '1') {
      writeFileSync(snapshotPath, `${JSON.stringify(shape, null, 2)}
`, 'utf8')
    }
    let expected
    try {
      expected = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    } catch {
      assert.fail(
        `Anlık görüntü YOK: ${snapshotPath}. Kasıtlı bir değişiklikse ` +
          'PRINT_SNAPSHOT_UPDATE=1 ile üretip farkı gözden geçirin.',
      )
    }
    assert.deepEqual(shape, expected, 'baskı çıktısının YAPISI değişti')

    // Baskı HTML'i ilkellerden üretilir: HTML'de ilkel dışında konumlandırma
    // yapan başka bir mutlak kutu OLMAMALI.
    const absolute = ctx.result.html.match(/position:absolute/g) ?? []
    assert.equal(
      absolute.length,
      ctx.rendered.primitives.length,
      'HTML mutlak kutuları YALNIZ ilkellerden gelmeli',
    )
  } finally {
    await ctx.pglite.close()
  }
})

/* ═══ PRINT-15 — PAKET KAYDI ══════════════════════════════════════ */

test('PRINT-15: bu duman paketi KAPILARA bağlı (sessizce düşürülemez)', () => {
  // Bir regresyon testi ancak KOŞUYORSA korur. Bu kontrol, paketin
  // kabul komutundan ve Sürat paket listesinden çıkarılmasını engeller.
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.match(
    pkg.scripts['test:label-editor:acceptance'],
    /label-print-artifact-smoke-flow\.test\.mjs/,
    'kabul komutu bu paketi çalıştırmalı',
  )
  const files = JSON.parse(
    readFileSync(join(here, 'testing', 'suratSuiteFiles.json'), 'utf8'),
  )
  const list = Array.isArray(files) ? files : files.files
  assert.ok(
    list.includes('server/label-print-artifact-smoke-flow.test.mjs'),
    'Sürat paket listesinde KAYITLI olmalı',
  )
  // Anlık görüntü dosyası da depoda OLMALI (yoksa PRINT-14 anlamsızlaşır).
  const snapshot = join(here, 'fixtures', 'surat-render', 'print-document-shape.json')
  assert.ok(JSON.parse(readFileSync(snapshot, 'utf8')).length > 0)
})
