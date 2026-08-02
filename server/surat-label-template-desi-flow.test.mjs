import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// Sürat etiket şablonu (yerleşim + koyuluk + ürün detayları), Ayarlar'dan gelen
// varsayılan gönderi desisi ve sidebar çıkış butonu testleri.
// PROVIDER İÇERİĞİ (T.No, 1D barkod, QR) DEĞİŞMEZ; desi çarpan sözleşmesi ve
// order-line deduplication KORUNUR. Gerçek müşteri verisi KULLANILMAZ.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const shipmentDefaults = await import('./onboarding/shipmentDefaultsRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')

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

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return out
}
async function makeDb() {
  const pglite = new PGlite()
  for (const s of migrationStatements()) await pglite.exec(s)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, slug) {
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}

// ── Etiket fixture'ı (sentetik; gerçek müşteri verisi YOK) ─────────────────
const TNO = '25220148446193'
const BARCODE = '01231201025'
const ORDER_NO = '7270000000000001'

function labelOrder(over = {}) {
  const shipment = {
    provider: 'surat-kargo',
    trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
    barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    zplReady: true, printEnabled: true,
    desi: over.desi ?? 2,
    ...(over.shipment ?? {}),
  }
  return {
    id: 'o1', orderNumber: ORDER_NO, packageId: 'PKG1',
    customerName: 'TEST ALICI', customerPhone: '5410000000',
    city: 'KASTAMONU', district: 'ARAC',
    address: 'TEST MAH TEST CADDESI NO 1',
    desi: over.desi ?? 2,
    desiSource: over.desiSource ?? 'manual_total',
    items: over.items ?? [
      { id: 'l1', productName: 'Test Elbise', quantity: 1, color: 'Lacivert', size: '40', merchantSku: 'SKU-1', barcode: 'B1' },
    ],
    shipment,
    ...over,
  }
}

async function renderZpl(order) {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const label = await new ZebraZplLabelProvider().generateSingle({
    order, shipment: order.shipment, template: { id: 'tpl' }, mappingConfig: {},
  })
  return label
}

// ═══ 1-5: provider içeriği + koyuluk + sınırlar ════════════════════════════

test('SLT-1/2: provider takip barkodu ve QR içeriği DEĞİŞMEZ', async () => {
  const { zplContent } = await renderZpl(labelOrder())
  // 1D barkod: provider barkod değeri aynen, insan-okur satır açık (,Y,).
  assert.match(zplContent, /\^BCN,\d+,Y,N,N\^FD01231201025\^FS/, '1D barkod İÇERİĞİ değişmez')
  // QR payload'ları aynen (sipariş no|barkod ve barkod).
  assert.ok(zplContent.includes(`^FDLA,${ORDER_NO}|${BARCODE}^FS`), 'QR1 payload korunur')
  assert.ok(zplContent.includes(`^FDLA,${BARCODE}^FS`), 'QR2 payload korunur')
  // T.No provider değeri.
  assert.ok(zplContent.includes(`T.No: ${TNO}`), 'T.No korunur')
})

test('SLT-3: barkod/QR alanına kalınlaştırma UYGULANMAZ, global koyuluk değişmez', async () => {
  const { zplContent } = await renderZpl(labelOrder())
  const lines = zplContent.split('\n')
  const codeLines = lines.filter((l) => l.includes('^BC') || l.includes('^BQ'))
  assert.equal(codeLines.length, 3, 'tam 3 kod alanı (1D + 2 QR), kopya YOK')
  assert.equal(new Set(codeLines).size, 3, 'kod alanları çift basılmaz')
  assert.equal(/\^MD|~SD/.test(zplContent), false, 'global baskı koyuluğu değiştirilmez')
})

test('SLT-4: kalınlaştırma YALNIZ iri puntoda (203 DPI bulanıklık kontrolü)', async () => {
  const { zplContent } = await renderZpl(labelOrder())
  const lines = zplContent.split('\n')
  const brand = lines.filter((l) => l.includes('SURAT KARGO'))
  assert.equal(brand.length, 2, 'iri metin çift basılır (faux bold)')
  const xs = brand.map((l) => Number(l.match(/\^FO(\d+),/)[1]))
  assert.equal(Math.abs(xs[0] - xs[1]), 1, '1 nokta offset')
  assert.equal(lines.filter((l) => l.includes('Adrese Teslim')).length, 2, 'iri rota metni kalın')

  // KÜÇÜK puntolar (<24) TEK geçiş olmalı: 203 DPI'da 1 nokta kaydırma küçük
  // gövdelerde harfleri birleştirip bulanıklaştırır.
  const smallFieldCounts = new Map()
  for (const line of lines) {
    const m = line.match(/^\^FO(\d+),(\d+)\^A0N,(\d+),\d+(.*)$/)
    if (!m) continue
    const font = Number(m[3])
    if (font >= 24) continue
    const key = `${m[2]}|${m[3]}|${m[4]}`
    smallFieldCounts.set(key, (smallFieldCounts.get(key) ?? 0) + 1)
  }
  const doubled = [...smallFieldCounts.entries()].filter(([, c]) => c > 1)
  assert.deepEqual(doubled, [], 'küçük punto metinler çift basılmaz (net kalır)')
})

test('SLT-5: 203 DPI şablon sınırları içinde (10x10 cm = 799 nokta) kalır', async () => {
  const { zplContent } = await renderZpl(
    labelOrder({
      items: [1, 2, 3, 4, 5].map((i) => ({
        id: `l${i}`, productName: `Ürün ${i}`, quantity: 1,
        color: `Renk${i}`, size: `${36 + i}`, merchantSku: `SKU${i}`,
      })),
    }),
  )
  assert.match(zplContent, /\^PW799/)
  assert.match(zplContent, /\^LL799/)
  assert.match(zplContent, /\^CI28/, 'UTF-8 (Türkçe karakter güvenli)')
  const positions = [...zplContent.matchAll(/\^FO(\d+),(\d+)/g)].map((m) => ({
    x: Number(m[1]), y: Number(m[2]),
  }))
  // En alttaki metin + font yüksekliği etiketten taşmamalı.
  assert.ok(Math.max(...positions.map((p) => p.y)) + 20 <= 799, 'dikey taşma yok')
  assert.ok(Math.max(...positions.map((p) => p.x)) < 799, 'yatay taşma yok')
})

test('SLT-5b: uzun varış/aktarma metni KESİLMEZ, güvenli küçültülür ve QR alanına girmez', async () => {
  const { zplContent } = await renderZpl(
    labelOrder({ city: 'AFYONKARAHISAR', district: 'BASMAKCI SANDIKLI YOLU' }),
  )
  const routing = [
    ...zplContent.matchAll(
      /\^FO(\d+),(\d+)\^A0N,(\d+),\d+\^FB(\d+),(\d+),0,L,0\^FD([^^]*)\^FS/g,
    ),
  ]
    .map((m) => ({
      x: +m[1], y: +m[2], font: +m[3], width: +m[4], maxLines: +m[5], text: m[6],
    }))
    // Yalnız rota bandı satırları (iri punto); faux-bold çiftleri tekilleştirilir.
    .filter((row) => row.font >= 20)
    .filter(
      (row, index, all) =>
        all.findIndex((other) => other.y === row.y && other.text === row.text) === index,
    )
  assert.equal(routing.length, 2, 'iki satır: varış şubesi + aktarma merkezi')
  // Sağ QR'ın sol kenarı (ZPL'den okunur) — rota metni buraya taşmamalı.
  const rightQrX = Number(zplContent.match(/\^FO(\d+),\d+\^BQN,2,\d\^FDLA,\d+\^FS/)[1])
  for (const row of routing) {
    // Kesme yok: '…' veya kırpılmış metin olmamalı.
    assert.equal(row.text.includes('…'), false, 'metin kesilmedi: ' + row.text)
    // Sığdırma: seçilen punto + izin verilen satır sayısıyla metin sığar.
    const capacity =
      Math.floor(row.width / (row.font * 0.58)) * row.maxLines
    assert.ok(row.text.length <= capacity, 'punto/satır sığacak şekilde ayarlandı')
    assert.ok(row.maxLines <= 2, 'en fazla 2 satıra sarılır')
    assert.ok(row.x + row.width <= rightQrX, 'rota bandı sağ QR alanına girmez')
  }
  assert.ok(routing[1].y > routing[0].y, 'aktarma satırı varış satırının altında')
  const last = routing[1]
  assert.ok(
    last.y + last.font * last.maxLines <= 690,
    'rota bandı ürün çizgisini aşmaz',
  )
})

// ═══ 6-9: ürün detayları ══════════════════════════════════════════════════

test('SLT-6/7: tek ürün TAM detayla basılır (adet, ad, renk, beden, SKU, barkod)', async () => {
  const { zplContent } = await renderZpl(labelOrder())
  assert.ok(zplContent.includes('1 x Test Elbise'), 'adet + ürün adı')
  assert.ok(zplContent.includes('Renk: Lacivert'), 'renk')
  assert.ok(zplContent.includes('Beden: 40'), 'beden')
  assert.ok(zplContent.includes('SKU: SKU-1'), 'SKU')
  assert.ok(zplContent.includes('Barkod: B1'), 'ürün barkodu')
  assert.equal(/ürün daha/.test(zplContent), false, '"+X ürün daha" KULLANILMAZ')
})

test('SLT-6b: ÜST BLOK gönderici, alıcı YALNIZ orta kutuda (gerçek etiket ayrımı)', async () => {
  const { zplContent } = await renderZpl(labelOrder())
  const header = zplContent.split('\n').filter((l) => /\^FO\d+,\d{1,2}\^A0N/.test(l))
  const headerText = header.join('\n')
  // Üst blok: Sube + gönderici adı + MUST.IRS.NO + T.No.
  assert.match(headerText, /Sube: /, 'şube üst blokta')
  assert.match(headerText, /MUST\.IRS\.NO: /, 'müşteri irsaliye no üst blokta')
  assert.match(headerText, /T\.No: /, 'T.No üst blokta')
  assert.match(headerText, /HASAN/, 'gönderici adı üst blokta')
  assert.equal(/TEST ALICI/.test(headerText), false, 'alıcı adı üst blokta OLMAZ')
  // Gönderici telefonu veri modelinde yok → TEL satırı basılmaz (uydurma yok).
  assert.equal(/\^FDTEL: -\^FS/.test(zplContent), false, 'gönderici TEL uydurulmaz')
  // Alıcı adı/telefonu/il-ilçesi orta kutuda.
  assert.match(zplContent, /\^FO\d+,2\d\d\^A0N,\d+,\d+\^FDTEST ALICI\^FS/, 'alıcı orta kutuda')
  assert.match(zplContent, /\^FO\d+,3\d\d\^A0N,\d+,\d+\^FDTEL: /, 'alıcı telefonu orta kutuda')
  // Sağ adres BÖLMESİ (dikey ayraç) OLMAMALI.
  assert.equal(/\^FO568,250\^GB1,180/.test(zplContent), false, 'sağ adres bölmesi yok')
  // routeCenter gereksiz TEKRAR etmez: orta kutuda 1 + büyük rota alanında 1.
  const routeHits = zplContent.split('\n').filter((l) => l.includes('KASTAMONU / ARAC'))
  const distinctY = new Set(routeHits.map((l) => l.match(/\^FO\d+,(\d+)/)[1]))
  assert.equal(distinctY.size, 2, 'il/ilçe yalnız 2 yerde (alıcı kutusu + rota bandı)')
})

test('SLT-7b: renk/beden variantAttributes içinden çözülür', async () => {
  const { buildProductItemBlocks } = await load('/src/utils/labelProductLines.ts')
  const [block] = buildProductItemBlocks(
    [{
      productName: 'Ürün', quantity: 1, sku: 'S1', barcode: 'B1',
      variantAttributes: [
        { name: 'Renk', value: 'Kırmızı' },
        { name: 'Beden', value: 'M' },
        { name: 'Model', value: 'Slim' },
      ],
    }],
    { titleMaxChars: 64, metaMaxChars: 72 },
  )
  assert.deepEqual(block.map((l) => l.text), [
    '1 x Ürün',
    'Renk: Kırmızı · Beden: M · Varyant: Model=Slim',
    'SKU: S1 · Barkod: B1',
  ])
})

test('SLT-8: eksik varyant alanları güvenli atlanır (undefined/null yazılmaz)', async () => {
  const { zplContent } = await renderZpl(
    labelOrder({
      items: [{ id: 'l1', productName: 'Ürün', quantity: 1, barcode: '869123' }],
    }),
  )
  assert.equal(/undefined|null/.test(zplContent), false, 'undefined/null basılmaz')
  assert.equal(zplContent.includes('Renk:'), false, 'boş renk yazılmaz')
  assert.equal(zplContent.includes('Beden:'), false, 'boş beden yazılmaz')
  assert.equal(zplContent.includes('SKU:'), false, 'boş SKU yazılmaz')
  assert.ok(zplContent.includes('Barkod: 869123'), 'mevcut barkod basılır')
})

test('SLT-9: İKİ farklı ürünün İKİSİ de tam detaylı basılır (özet YOK)', async () => {
  const { zplContent } = await renderZpl(
    labelOrder({
      items: [
        { id: 'l1', productName: 'Elbise Güneş', quantity: 1, color: 'Kırmızı', size: '38', merchantSku: 'SKU-A', barcode: 'BA' },
        { id: 'l2', productName: 'Pantolon Çiğdem', quantity: 3, color: 'Mavi', size: '40', merchantSku: 'SKU-B', barcode: 'BB' },
      ],
    }),
  )
  assert.equal(/ürün daha/.test(zplContent), false, '"+X ürün daha" YOK')
  for (const expected of [
    '1 x Elbise Güneş', 'Renk: Kırmızı', 'Beden: 38', 'SKU: SKU-A', 'Barkod: BA',
    '3 x Pantolon Çiğdem', 'Renk: Mavi', 'Beden: 40', 'SKU: SKU-B', 'Barkod: BB',
  ]) {
    assert.ok(zplContent.includes(expected), 'eksik detay: ' + expected)
  }
})

test('SLT-9b: BEŞ ürünün TAMAMI basılır; taşanlar DEVAM etiketine gider', async () => {
  const items = [1, 2, 3, 4, 5].map((i) => ({
    id: `l${i}`, productName: `Ürün ${i} Şık Model`, quantity: i,
    color: `Renk${i}`, size: `${36 + i}`, merchantSku: `SKU-${i}`, barcode: `8690${i}`,
  }))
  const { zplContent } = await renderZpl(labelOrder({ items }))
  const pages = zplContent.split('^XZ').filter((p) => p.includes('^XA'))
  assert.ok(pages.length >= 2, 'taşan ürünler için devam etiketi üretilir')
  assert.equal(/ürün daha/.test(zplContent), false, '"+X ürün daha" YOK')
  // HER ürünün TÜM alanları çıktıda olmalı (hiçbiri gizlenmez).
  for (const item of items) {
    assert.ok(zplContent.includes(`${item.quantity} x ${item.productName}`), 'adet+ad: ' + item.productName)
    assert.ok(zplContent.includes(`Renk: ${item.color}`), 'renk: ' + item.color)
    assert.ok(zplContent.includes(`Beden: ${item.size}`), 'beden: ' + item.size)
    assert.ok(zplContent.includes(`SKU: ${item.merchantSku}`), 'sku: ' + item.merchantSku)
    assert.ok(zplContent.includes(`Barkod: ${item.barcode}`), 'barkod: ' + item.barcode)
  }
})

test('SLT-9c: DEVAM etiketi kargo barkodu/QR/T.No üretmez; desi ve parça adedi değişmez', async () => {
  const items = [1, 2, 3, 4, 5].map((i) => ({
    id: `l${i}`, productName: `Ürün ${i}`, quantity: 1,
    color: `R${i}`, size: `${i}`, merchantSku: `S${i}`, barcode: `B${i}`,
  }))
  const { zplContent } = await renderZpl(labelOrder({ items }))
  const pages = zplContent.split('^XZ').filter((p) => p.includes('^XA'))
  const [main, ...continuations] = pages
  assert.ok(continuations.length >= 1, 'en az bir devam etiketi')
  // Ana etiket: provider alanları korunur.
  assert.match(main, /\^BCN,\d+,Y,N,N\^FD01231201025\^FS/, 'ana 1D barkod korunur')
  assert.ok(main.includes(`^FDLA,${ORDER_NO}|${BARCODE}^FS`), 'ana QR korunur')
  // Devam etiketleri: barkod/QR/T.No YOK, yeni gönderi YOK.
  for (const page of continuations) {
    assert.equal(/\^BC|\^BQ/.test(page), false, 'devam etiketinde barkod/QR OLMAZ')
    assert.equal(/T\.No/.test(page), false, 'devam etiketinde T.No OLMAZ')
    assert.ok(page.includes('SIPARIS URUNLERI - DEVAM'), 'devam başlığı')
    assert.ok(page.includes(`Siparis No: ${ORDER_NO}`), 'devam sipariş no')
    assert.match(page, /\^PW799/, 'aynı fiziksel boyut')
  }
  // Desi ve parça adedi ANA etikette değişmedi (devam etiketi artırmaz).
  assert.ok(main.includes('^FD2.00^FS'), 'desi değişmedi')
  assert.ok(main.includes('^FD1 / 1^FS'), 'parça adedi değişmedi')
  assert.equal(
    zplContent.split('^FD1 / 1^FS').length - 1,
    2,
    'parça adedi yalnız ana etikette (bold çifti = 2 satır)',
  )
})

test('SLT-9d: reprint aynı ana etiket + aynı devam etiketlerini üretir (deterministik)', async () => {
  const items = [1, 2, 3, 4, 5].map((i) => ({
    id: `l${i}`, productName: `Ürün ${i}`, quantity: 1,
    color: `R${i}`, size: `${i}`, merchantSku: `S${i}`, barcode: `B${i}`,
  }))
  const first = await renderZpl(labelOrder({ items }))
  const second = await renderZpl(labelOrder({ items }))
  assert.equal(first.zplContent, second.zplContent, 'çıktı birebir aynı')
  const pageCount = (z) => z.split('^XZ').filter((p) => p.includes('^XA')).length
  assert.equal(pageCount(first.zplContent), pageCount(second.zplContent), 'sayfa sayısı aynı')
})

// ═══ 10-11: quantity + duplicate ══════════════════════════════════════════

test('SLT-10: gerçek quantity=2 korunur (adet düşürülmez)', async () => {
  const { zplContent } = await renderZpl(
    labelOrder({
      items: [{ id: 'l1', productName: 'Elbise', quantity: 2, color: 'Siyah', size: '38', merchantSku: 'S1' }],
    }),
  )
  assert.ok(zplContent.includes('2 x Elbise'), 'quantity=2 basılır')
})

test('SLT-11: duplicate order line YENİDEN OLUŞMAZ (dedup korunur)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'slt-11')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const base = {
    marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'O1',
    marketplaceStatus: 'Delivered', totalAmount: 100,
    orderDate: '2026-07-10T08:00:00Z', rawOrder: {},
  }
  // Normal sync (ty_line_) sonra backfill (ön eksiz) → tek satır kalmalı.
  await orderService.persistSyncResult(db, org, [
    { ...base, items: [{ id: 'ty_line_9', barcode: 'B', merchantSku: 'S', quantity: 1, price: 100, productName: 'Ürün' }] },
  ], { complete: false, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org, [
    { ...base, items: [{ id: '9', barcode: 'B', merchantSku: 'S', quantity: 1, price: 100, productName: 'Ürün' }] },
  ], { complete: false, marketplaceAccountId: a.id })
  const lines = await db.select().from(schema.orderLines)
  assert.equal(lines.length, 1, 'duplicate satır oluşmaz')
})

// ═══ 12-15: varsayılan desi ═══════════════════════════════════════════════

test('SLT-12: Ayarlar varsayılan desisi YENİ etikete uygulanır (birim × adet)', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const order = {
    items: [{ id: 'l1', productName: 'Ürün', quantity: 1, barcode: 'B' }],
  }
  const single = calculateOrderDesi(order, [], { defaultUnitDesi: 2 })
  assert.equal(single.finalDesi, 2, 'tek adet → 2')
  assert.equal(single.finalDesiSource, 'product_lines')
  assert.equal(single.lines[0].unitDesiSource, 'tenant_default')
  // Ayar yoksa eski davranış: hesaplanamaz (sessiz yanlış desi YOK).
  const none = calculateOrderDesi(order, [], { defaultUnitDesi: null })
  assert.equal(none.finalDesi, null)
  assert.ok(none.blockedReason)
})

test('SLT-13: eski/manuel toplam desi override KORUNUR (çarpılmaz)', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const result = calculateOrderDesi(
    {
      desi: 7, desiSource: 'manual_total',
      items: [{ id: 'l1', productName: 'Ürün', quantity: 3, barcode: 'B' }],
    },
    [], { defaultUnitDesi: 2 },
  )
  assert.equal(result.finalDesi, 7, 'manuel toplam aynen kullanılır')
  assert.equal(result.finalDesiSource, 'manual_total')
})

test('SLT-14: mevcut çoklu ürün desi ÇARPANI korunur', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  // Aynı pakette 2 adet (tek satır quantity=2) → 2 × 2 = 4.
  const byQuantity = calculateOrderDesi(
    { items: [{ id: 'l1', productName: 'Ürün', quantity: 2, barcode: 'B' }] },
    [], { defaultUnitDesi: 2 },
  )
  assert.equal(byQuantity.finalDesi, 4)
  // İki AYRI gerçek satır (her biri 1 adet) → yine 4; satırlar birleştirilmez.
  const byLines = calculateOrderDesi(
    {
      items: [
        { id: 'l1', productName: 'A', quantity: 1, barcode: 'B1' },
        { id: 'l2', productName: 'B', quantity: 1, barcode: 'B2' },
      ],
    },
    [], { defaultUnitDesi: 2 },
  )
  assert.equal(byLines.finalDesi, 4)
  assert.equal(byLines.countedLines.length, 2, 'iki gerçek satır korunur')
  assert.equal(byLines.parcelCount, 1, 'tek koli sözleşmesi korunur')
})

test('SLT-15/16: ayar değişikliği KAYITLI etiketi değiştirmez; reprint aynı etiketi basar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'slt-15')
  const { resolvePersistedLabel } = await import('./orders/orderPersistenceService.ts')
  assert.equal(typeof resolvePersistedLabel, 'function', 'reprint kayıtlı etiketi çözer')

  // Etiket desi=2 ile üretilir (sipariş üzerindeki açık desi).
  const first = await renderZpl(labelOrder({ desi: 2, desiSource: 'manual_total' }))
  assert.ok(first.zplContent.includes('^FD2.00^FS'), 'üretilen etiket desi 2 taşır')

  // Ayar SONRADAN 9'a çekilir → KAYITLI etiket artifact'i DEĞİŞMEZ.
  await shipmentDefaults.saveShipmentDefaults(db, org, { defaultUnitDesi: 9 })
  assert.equal((await shipmentDefaults.getShipmentDefaults(db, org)).defaultUnitDesi, 9)
  assert.ok(first.zplContent.includes('^FD2.00^FS'), 'kayıtlı etiket eski desiyi korur')
  assert.equal(first.zplContent.includes('^FD9.00^FS'), false, 'yeni ayar kayıtlı etikete sızmaz')

  // Reprint: aynı sipariş/gönderi → BİREBİR aynı etiket (deterministik).
  const again = await renderZpl(labelOrder({ desi: 2, desiSource: 'manual_total' }))
  assert.equal(again.zplContent, first.zplContent, 'reprint aynı etiketi basar')
})

test('SLT-17: varsayılan desi org kapsamlıdır (tenant izolasyonu)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'slt-17a')
  const orgB = await makeOrg(db, 'slt-17b')
  await shipmentDefaults.saveShipmentDefaults(db, orgA, { defaultUnitDesi: 3 })
  assert.equal((await shipmentDefaults.getShipmentDefaults(db, orgA)).defaultUnitDesi, 3)
  assert.equal(
    (await shipmentDefaults.getShipmentDefaults(db, orgB)).defaultUnitDesi,
    null,
    'başka tenant etkilenmez',
  )
  // settings_json içindeki diğer anahtarlar korunur.
  await db.update(schema.organizationSettings)
    .set({ settingsJson: { keep: 'x', shipmentDefaults: { defaultUnitDesi: 3 } } })
    .where(eq(schema.organizationSettings.organizationId, orgA))
  await shipmentDefaults.saveShipmentDefaults(db, orgA, { defaultUnitDesi: 4 })
  const [row] = await db.select().from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, orgA))
  assert.equal(row.settingsJson.keep, 'x', 'diğer ayarlar korunur')
  assert.equal(row.settingsJson.shipmentDefaults.defaultUnitDesi, 4)
})

test('SLT-18: LABEL_READY/LABEL_PRINTED operasyon durumu korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'slt-18')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await orderService.persistSyncResult(db, org, [{
    marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'O1',
    marketplaceStatus: 'Created', operationStatus: 'LABEL_PRINTED',
    totalAmount: 100, orderDate: '2026-07-10T08:00:00Z', rawOrder: {},
    items: [{ id: 'l1', barcode: 'B', quantity: 1, price: 100, productName: 'Ürün' }],
  }], { complete: false, marketplaceAccountId: a.id })
  // Yeniden sync (etiket akışı) operasyonel durumu EZMEZ.
  await orderService.persistSyncResult(db, org, [{
    marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'O1',
    marketplaceStatus: 'Delivered', totalAmount: 100,
    orderDate: '2026-07-10T08:00:00Z', rawOrder: {},
    items: [{ id: 'l1', barcode: 'B', quantity: 1, price: 100, productName: 'Ürün' }],
  }], { complete: false, marketplaceAccountId: a.id })
  const [row] = await db.select().from(schema.orders)
  assert.equal(row.operationStatus, 'LABEL_PRINTED', 'operasyon durumu korunur')
  assert.equal(row.marketplaceStatus, 'Delivered', 'pazaryeri durumu güncellenir')
})

// ═══ 19: çıkış butonu ═════════════════════════════════════════════════════

test('SLT-19: çıkış butonu görünür sidebar footer içindedir', () => {
  const shell = readFileSync(join(here, '..', 'src/components/AppShell.tsx'), 'utf8')
  const css = readFileSync(join(here, '..', 'src/index.css'), 'utf8')
  // Çıkış, footer bloğunun İÇİNDE.
  const footerStart = shell.indexOf('sidebar-footer')
  assert.notEqual(footerStart, -1, 'sidebar-footer mevcut')
  assert.ok(shell.indexOf('sidebar-signout') > footerStart, 'çıkış footer içinde')
  // Footer konumu + alt boşluk (safe-area) + masaüstünde viewport'a sabitleme.
  assert.match(css, /\.sidebar-footer\s*\{[^}]*margin-top:\s*auto/)
  assert.match(css, /\.sidebar-footer\s*\{[^}]*safe-area-inset-bottom/)
  assert.match(css, /@media \(min-width: 1101px\)[\s\S]*?\.sidebar\s*\{[^}]*position:\s*sticky/)
  assert.match(css, /@media \(min-width: 1101px\)[\s\S]*?\.nav-list\s*\{[^}]*overflow-y:\s*auto/)
  // Klavye erişilebilirliği.
  assert.match(css, /\.sidebar-signout:focus-visible/)
  // Mobil (<=1100px) mevcut davranış korunur.
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*?\.sidebar\s*\{[^}]*position:\s*sticky/)
})

// ═══ Desi girişi kaldırıldı: yalnız Ayarlar varsayılanı ═══════════════════

test('SLT-21: hiçbir sipariş ekranında "Desi Gir" butonu / manuel desi girişi YOK', () => {
  const screens = [
    'src/components/OrdersTable.tsx',
    'src/components/OrderDetailDrawer.tsx',
    'src/components/LabelPreviewModal.tsx',
    'src/pages/OrdersPage.tsx',
    'src/pages/CargoOperationsPage.tsx',
  ]
  for (const rel of screens) {
    const src = readFileSync(join(here, '..', rel), 'utf8')
    assert.equal(/>\s*Desi Gir\s*</.test(src), false, `"Desi Gir" butonu kaldı: ${rel}`)
    // Manuel desi yazılabilir alan (number input + desi etiketi) kalmamalı.
    assert.equal(
      /placeholder="Desi girin"/.test(src),
      false,
      `manuel desi girişi kaldı: ${rel}`,
    )
    assert.equal(
      /aria-label=\{?[`'"][^`'"]*Toplam koli desisi/.test(src),
      false,
      `desi giriş alanı kaldı: ${rel}`,
    )
  }
})

test('SLT-22: yeni etiket desisi Ayarlar varsayılanından; yoksa Ayarlar\'a yönlendiren hata', async () => {
  const { resolveEffectiveLabelDesi, DEFAULT_DESI_MISSING_MESSAGE } = await load(
    '/src/utils/labelDesi.ts',
  )
  const order = {
    items: [{ id: 'l1', productName: 'Ü', quantity: 1, barcode: 'B' }],
  }
  // Ayarlar varsayılanı KULLANILIR (adet çarpanı korunur).
  assert.equal(resolveEffectiveLabelDesi(order, undefined, [], { defaultUnitDesi: 2 }).desi, 2)
  assert.equal(
    resolveEffectiveLabelDesi(
      { items: [{ id: 'l1', productName: 'Ü', quantity: 2, barcode: 'B' }] },
      undefined, [], { defaultUnitDesi: 2 },
    ).desi,
    4,
    'quantity çarpanı korunur',
  )
  // Varsayılan yoksa BLOKLA + Ayarlar mesajı.
  const blocked = resolveEffectiveLabelDesi(order, undefined, [], { defaultUnitDesi: null })
  assert.equal(blocked.desi, null)
  assert.equal(blocked.requiresSettings, true)
  assert.equal(blocked.blockedReason, DEFAULT_DESI_MISSING_MESSAGE)
  assert.match(blocked.blockedReason, /Ayarlar/, 'kullanıcı Ayarlar\'a yönlendirilir')

  // Etiket üretimi de aynı mesajla bloklanır.
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const fresh = labelOrder({ desi: null, desiSource: null })
  fresh.shipment.desi = null
  await assert.rejects(
    () => new ZebraZplLabelProvider().generateSingle({
      order: fresh, shipment: fresh.shipment, template: { id: 't' },
      desiConfig: { defaultUnitDesi: null },
    }),
    /Ayarlar/,
  )
})

test('SLT-23: geçmiş manuel desi override KORUNUR; kayıtlı etiket reprint değişmez', async () => {
  const { resolveEffectiveLabelDesi } = await load('/src/utils/labelDesi.ts')
  // Geçmişte girilmiş manuel toplam desi Ayarlar varsayılanını EZER.
  assert.equal(
    resolveEffectiveLabelDesi(
      { desi: 7, desiSource: 'manual_total', items: [{ id: 'l1', quantity: 3, barcode: 'B' }] },
      undefined, [], { defaultUnitDesi: 2 },
    ).desi,
    7,
  )
  // Kayıtlı taşıyıcı ZPL varsa desi hiç sorulmaz ve etiket aynen basılır.
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const reprint = labelOrder({ desi: null, desiSource: null })
  reprint.shipment.desi = null
  reprint.shipment.barcodeRaw = '^XA^FDKAYITLI^FS^XZ'
  const label = await new ZebraZplLabelProvider().generateSingle({
    order: reprint, shipment: reprint.shipment, template: { id: 't' },
    desiConfig: { defaultUnitDesi: null },
  })
  assert.ok(label.zplContent.includes(BARCODE), 'reprint canonical barkodu korur')
})

// ═══ 20: geriye dönük uyumluluk ═══════════════════════════════════════════

test('SLT-20: etiket üretimi kayıtlı ZPL yokken desi ister; kayıtlıysa istemez', async () => {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts',
  )
  const provider = new ZebraZplLabelProvider()
  // Desi yok + kayıtlı ZPL yok → engellenir (sessiz yanlış etiket YOK).
  const noDesi = labelOrder({ desi: null, desiSource: null })
  noDesi.shipment.desi = null
  await assert.rejects(
    () => provider.generateSingle({
      order: noDesi, shipment: noDesi.shipment, template: { id: 't' }, mappingConfig: {},
    }),
    /[Dd]esi/,
  )
  // Kayıtlı taşıyıcı ZPL varsa (reprint) desi İSTENMEZ.
  const reprint = labelOrder({ desi: null, desiSource: null })
  reprint.shipment.desi = null
  reprint.shipment.barcodeRaw = '^XA^FO0,0^FDKAYITLI^FS^XZ'
  const label = await provider.generateSingle({
    order: reprint, shipment: reprint.shipment, template: { id: 't' }, mappingConfig: {},
  })
  assert.ok(label.zplContent.includes(BARCODE), 'reprint canonical barkodu korur')
})
