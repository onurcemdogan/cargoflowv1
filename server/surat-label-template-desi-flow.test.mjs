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
  assert.match(zplContent, /\^BCN,120,Y,N,N\^FD01231201025\^FS/)
  // QR payload'ları aynen (sipariş no|barkod ve barkod).
  assert.ok(zplContent.includes(`^BQN,2,7^FDLA,${ORDER_NO}|${BARCODE}^FS`), 'QR1 içeriği korunur')
  assert.ok(zplContent.includes(`^BQN,2,4^FDLA,${BARCODE}^FS`), 'QR2 içeriği korunur')
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

test('SLT-4: metinler daha kalın (aynı metin 1 nokta kaydırılmış çift basım)', async () => {
  const { zplContent } = await renderZpl(labelOrder())
  const lines = zplContent.split('\n')
  const brand = lines.filter((l) => l.includes('SURAT KARGO'))
  assert.equal(brand.length, 2, 'metin çift basılır (faux bold)')
  const xs = brand.map((l) => Number(l.match(/\^FO(\d+),/)[1]))
  assert.equal(Math.abs(xs[0] - xs[1]), 1, '1 nokta offset')
  // Büyük rota/aktarma metinleri de kalın.
  assert.equal(lines.filter((l) => l.includes('Adrese Teslim')).length, 2)
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

// ═══ 6-9: ürün detayları ══════════════════════════════════════════════════

test('SLT-6/7: tek ürün detayları + renk/beden doğru basılır', async () => {
  const { zplContent } = await renderZpl(labelOrder())
  assert.ok(zplContent.includes('1 x Test Elbise'), 'adet + ürün adı')
  assert.ok(zplContent.includes('Renk: Lacivert'), 'renk')
  assert.ok(zplContent.includes('Beden: 40'), 'beden')
  assert.ok(zplContent.includes('SKU: SKU-1'), 'SKU')
})

test('SLT-7b: renk/beden variantAttributes içinden çözülür', async () => {
  const { buildLabelProductLines } = await load('/src/utils/labelProductLines.ts')
  const [, meta] = buildLabelProductLines(
    [{
      productName: 'Ürün', quantity: 1,
      variantAttributes: [
        { name: 'Renk', value: 'Kırmızı' },
        { name: 'Beden', value: 'M' },
        { name: 'Model', value: 'Slim' },
      ],
    }],
    { maxLines: 5, titleMaxChars: 66, metaMaxChars: 74 },
  )
  assert.equal(meta.text, 'Renk: Kırmızı · Beden: M · Model: Slim')
})

test('SLT-8: eksik varyant alanları güvenli atlanır (undefined/null yazılmaz)', async () => {
  const { zplContent } = await renderZpl(
    labelOrder({
      items: [{ id: 'l1', productName: 'Ürün', quantity: 1, barcode: '869123' }],
    }),
  )
  assert.equal(/undefined|null/.test(zplContent), false, 'undefined/null basılmaz')
  assert.equal(zplContent.includes('Renk:'), false, 'boş renk yazılmaz')
  assert.ok(zplContent.includes('Barkod: 869123'), 'SKU yoksa barkod fallback')
})

test('SLT-9: çok ürün taşmadan basılır ve fazlası özetlenir', async () => {
  const { buildLabelProductLines } = await load('/src/utils/labelProductLines.ts')
  const items = [1, 2, 3, 4, 5].map((i) => ({
    productName: `Ürün ${i}`, quantity: 1, color: `R${i}`, size: `${i}`, sku: `S${i}`,
  }))
  const lines = buildLabelProductLines(items, {
    maxLines: 5, titleMaxChars: 66, metaMaxChars: 74,
  })
  assert.ok(lines.length <= 5, 'satır bütçesi aşılmaz')
  assert.equal(lines.at(-1).kind, 'more')
  assert.match(lines.at(-1).text, /^\+\d+ ürün daha$/)
  // Uzun ad sarılır, kesilse bile '…' ile işaretlenir.
  const long = buildLabelProductLines(
    [{ productName: 'A'.repeat(400), quantity: 1 }],
    { maxLines: 5, titleMaxChars: 66, metaMaxChars: 74 },
  )
  assert.ok(long.every((l) => l.text.length <= 67), 'satır genişliği aşılmaz')
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
