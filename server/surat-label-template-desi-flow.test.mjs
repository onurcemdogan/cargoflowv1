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

// SÜRAT ETİKETİ = PROVIDER'IN RESMÎ ZPL'İ (tek kaynak doğrusu).
// CargoFlow Sürat için şablon ÜRETMEZ, geometri çizmez, devam etiketi basmaz.
// Bu dosya o sözleşmeyi ve Ayarlar-tabanlı desi akışını sabitler.
// Fixture'lar SENTETİKTİR; gerçek müşteri verisi veya secret İÇERMEZ.

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
    _vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false } })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(...readFileSync(join(dir, file), 'utf8')
      .split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean))
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

const TNO = '25220148446193'
const BARCODE = '01231201025'
const ORDER_NO = '7270000000000001'

// SENTETİK "Sürat resmî ZPL" — provider çıktısını temsil eder (PII yok).
const OFFICIAL_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL799',
  '^FO40,20^A0N,28,28^FDSube: FERAH^FS',
  `^FO500,20^A0N,26,26^FDT.No: ${TNO}^FS`,
  `^FO60,120^BY3^BCN,140,Y,N,N^FD${BARCODE}^FS`,
  `^FO60,560^BQN,2,6^FDLA,${BARCODE}^FS`,
  '^FO60,700^A0N,20,20^FDAdrese Teslim^FS',
  '^XZ',
].join('\n')

function shipmentFixture(over = {}) {
  return {
    provider: 'surat-kargo',
    trackingNumber: TNO, tNo: TNO, kargoTakipNo: TNO,
    barcode: BARCODE, barkodNo: BARCODE, barcodeValue: BARCODE,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    zplReady: true, printEnabled: true,
    barcodeRaw: OFFICIAL_ZPL,
    desi: 2,
    ...over,
  }
}
function labelOrder(over = {}) {
  const shipment = shipmentFixture(over.shipment ?? {})
  return {
    id: 'o1', orderNumber: ORDER_NO, packageId: 'PKG1',
    customerName: 'TEST ALICI', customerPhone: '5410000000',
    city: 'KASTAMONU', district: 'ARAC', address: 'TEST MAH 1',
    desi: over.desi === undefined ? 2 : over.desi,
    desiSource: over.desiSource === undefined ? 'manual_total' : over.desiSource,
    items: over.items ?? [
      { id: 'l1', productName: 'Test Elbise', quantity: 1, color: 'Lacivert', size: '40', merchantSku: 'SKU-1', barcode: 'B1' },
    ],
    shipment,
  }
}
async function renderLabel(order, desiConfig = { defaultUnitDesi: 2 }) {
  const { ZebraZplLabelProvider } = await load('/src/providers/labels/ZebraZplLabelProvider.ts')
  return new ZebraZplLabelProvider().generateSingle({
    order, shipment: order.shipment, template: { id: 'tpl' }, mappingConfig: {}, desiConfig,
  })
}

// ═══ 1-6: resmî ZPL aynen kullanılır ══════════════════════════════════════

test('OZ-1/2: Sürat resmî ZPL AYNEN kullanılır; buildZpl\'den GEÇİRİLMEZ', async () => {
  const label = await renderLabel(labelOrder())
  assert.equal(label.zplContent, OFFICIAL_ZPL, 'provider ZPL byte-for-byte korunur')
  assert.equal(label.zplSource, 'surat.ortakBarkod.BarcodeRaw', 'kaynak provider')
  // CargoFlow şablonuna ait hiçbir iz olmamalı.
  assert.equal(/SURAT KARGO\^FS/.test(label.zplContent), false, 'generated şablon izi yok')
  assert.equal(/MUST\.IRS\.NO/.test(label.zplContent), false, 'generated başlık yok')
})

test('OZ-3: provider ^PW/^LL/^FO koordinatları DEĞİŞMEZ', async () => {
  const label = await renderLabel(labelOrder())
  const fos = (z) => [...z.matchAll(/\^FO(\d+),(\d+)/g)].map((m) => `${m[1]},${m[2]}`).join('|')
  assert.equal(label.zplContent.match(/\^PW\d+/)[0], OFFICIAL_ZPL.match(/\^PW\d+/)[0])
  assert.equal(label.zplContent.match(/\^LL\d+/)[0], OFFICIAL_ZPL.match(/\^LL\d+/)[0])
  assert.equal(fos(label.zplContent), fos(OFFICIAL_ZPL), 'tüm ^FO koordinatları aynı')
})

test('OZ-4/5/6: T.No, 1D barkod ve QR payload DEĞİŞMEZ', async () => {
  const label = await renderLabel(labelOrder())
  assert.ok(label.zplContent.includes(`T.No: ${TNO}`), 'T.No korunur')
  assert.ok(label.zplContent.includes(`^BCN,140,Y,N,N^FD${BARCODE}^FS`), '1D payload korunur')
  assert.ok(label.zplContent.includes(`^BQN,2,6^FDLA,${BARCODE}^FS`), 'QR payload korunur')
})

test('OZ-7/8: çıktı TEK fiziksel etikettir; devam/ikinci sayfa ÜRETİLMEZ', async () => {
  const many = labelOrder({
    items: [1, 2, 3, 4, 5].map((i) => ({
      id: `l${i}`, productName: `Ürün ${i}`, quantity: i,
      color: 'Renk', size: `${36 + i}`, merchantSku: `SKU-${i}`, barcode: `869${i}`,
    })),
  })
  const label = await renderLabel(many)
  assert.equal((label.zplContent.match(/\^XA/g) ?? []).length, 1, 'tek ^XA')
  assert.equal((label.zplContent.match(/\^XZ/g) ?? []).length, 1, 'tek ^XZ')
  assert.equal(/SIPARIS URUNLERI/.test(label.zplContent), false, 'DEVAM etiketi YOK')
  assert.equal(/ürün daha/.test(label.zplContent), false, '"+X ürün daha" YOK')
  assert.equal(label.zplContent, OFFICIAL_ZPL, 'ürün sayısı ZPL\'i değiştirmez')
})

test('OZ-9: reprint persist edilmiş AYNI provider ZPL\'i basar', async () => {
  const order = labelOrder()
  const first = await renderLabel(order)
  const second = await renderLabel(order, { defaultUnitDesi: null })
  assert.equal(first.zplContent, OFFICIAL_ZPL)
  assert.equal(second.zplContent, OFFICIAL_ZPL, 'reprint aynı ZPL, desi istemez')
  assert.equal(first.zplContent, second.zplContent, 'deterministik')
})

// ═══ 10-11: hata yolunda sahte etiket YOK ═════════════════════════════════

test('OZ-10/11: resmî ZPL yoksa/geçersizse generated fallback ÜRETİLMEZ', async () => {
  const { ZebraZplLabelProvider } = await load('/src/providers/labels/ZebraZplLabelProvider.ts')
  const provider = new ZebraZplLabelProvider()
  const cases = [
    ['bos', ''],
    ['HTML hata govdesi', '<html><body>error</body></html>'],
    ['JSON hata govdesi', '{"isError":true}'],
    ['ZPL degil', 'PLAIN TEXT LABEL'],
  ]
  for (const [name, raw] of cases) {
    const order = labelOrder({ shipment: { barcodeRaw: raw } })
    await assert.rejects(
      () => provider.generateSingle({
        order, shipment: order.shipment, template: { id: 't' }, desiConfig: { defaultUnitDesi: 2 },
      }),
      /Sürat resmî etiketi alınamadı/,
      `fallback üretilmemeli: ${name}`,
    )
  }
})

test('OZ-11b: Web-only ve çok sayfalı provider ZPL sessizce kabul EDİLMEZ', async () => {
  const { validateOfficialSuratZpl } = await load('/src/utils/officialSuratLabel.ts')
  const webOnly = `^XA^PW799^LL799^FO60,120^BCN,140,Y,N,N^FDWeb1234567^FS^FO60,700^A0N,20,20^FDX^FS^XZ`
  const web = validateOfficialSuratZpl(webOnly, { trackingNumber: TNO, barcode: BARCODE })
  assert.equal(web.ok, false)
  assert.equal(web.rejection, 'web_barcode_only', 'dahilî Web kodu operasyonel sayılmaz')

  // Başka bir gönderinin ZPL'i: canonical T.No/barkod taşımıyor → basılmaz.
  const foreign = OFFICIAL_ZPL.replaceAll(BARCODE, '09999999999').replaceAll(TNO, '99999999999999')
  const foreignResult = validateOfficialSuratZpl(foreign, { trackingNumber: TNO, barcode: BARCODE })
  assert.equal(foreignResult.ok, false)
  assert.equal(foreignResult.rejection, 'barcode_mismatch')

  const multi = validateOfficialSuratZpl(OFFICIAL_ZPL + OFFICIAL_ZPL, { trackingNumber: TNO, barcode: BARCODE })
  assert.equal(multi.ok, false)
  assert.equal(multi.rejection, 'multi_page')
  assert.equal(multi.pageCount, 2, 'sayfa sayısı raporlanır (sessizce değiştirilmez)')
})

// ═══ 12-13: desi akışı ════════════════════════════════════════════════════

test('OZ-12: varsayılan desi Ayarlar\'dan gelir; çarpan korunur; yoksa bloklanır', async () => {
  const { resolveEffectiveLabelDesi, DEFAULT_DESI_MISSING_MESSAGE } = await load('/src/utils/labelDesi.ts')
  const one = { items: [{ id: 'l1', productName: 'Ü', quantity: 1, barcode: 'B' }] }
  const two = { items: [{ id: 'l1', productName: 'Ü', quantity: 2, barcode: 'B' }] }
  const lines = { items: [{ id: 'l1', quantity: 1, barcode: 'B1' }, { id: 'l2', quantity: 1, barcode: 'B2' }] }
  assert.equal(resolveEffectiveLabelDesi(one, undefined, [], { defaultUnitDesi: 2 }).desi, 2)
  assert.equal(resolveEffectiveLabelDesi(two, undefined, [], { defaultUnitDesi: 2 }).desi, 4)
  assert.equal(resolveEffectiveLabelDesi(lines, undefined, [], { defaultUnitDesi: 2 }).desi, 4)
  // Geçmiş manuel override korunur.
  assert.equal(
    resolveEffectiveLabelDesi({ desi: 7, desiSource: 'manual_total', ...two }, undefined, [], { defaultUnitDesi: 2 }).desi,
    7,
  )
  const blocked = resolveEffectiveLabelDesi(one, undefined, [], { defaultUnitDesi: null })
  assert.equal(blocked.desi, null)
  assert.equal(blocked.requiresSettings, true)
  assert.equal(blocked.blockedReason, DEFAULT_DESI_MISSING_MESSAGE)
  assert.match(blocked.blockedReason, /Ayarlar/)
})

test('OZ-12b: etikette görünen Top Ds/Kg provider ZPL\'inden gelir, CargoFlow yeniden biçimlendirmez', async () => {
  const withDesiZpl = OFFICIAL_ZPL.replace(
    '^FO60,700^A0N,20,20^FDAdrese Teslim^FS',
    '^FO60,660^A0N,18,18^FDTop Ds/Kg^FS\n^FO60,700^A0N,30,30^FD2,00^FS',
  )
  const order = labelOrder({ shipment: { barcodeRaw: withDesiZpl } })
  const label = await renderLabel(order)
  assert.equal(label.zplContent, withDesiZpl, 'provider desi metni aynen korunur')
  assert.ok(label.zplContent.includes('^FD2,00^FS'), 'provider biçimi (virgül) korunur')
})

test('OZ-13: "Desi Gir" / düzenlenebilir desi hiçbir ekranda YOK', () => {
  const screens = [
    'src/components/OrdersTable.tsx',
    'src/components/OrderDetailDrawer.tsx',
    'src/components/LabelPreviewModal.tsx',
    'src/pages/OrdersPage.tsx',
    'src/pages/CargoOperationsPage.tsx',
  ]
  for (const rel of screens) {
    const src = readFileSync(join(here, '..', rel), 'utf8')
    assert.equal(/>\s*Desi Gir\s*</.test(src), false, `"Desi Gir" kaldı: ${rel}`)
    assert.equal(/placeholder="Desi girin"/.test(src), false, `manuel desi girişi kaldı: ${rel}`)
  }
})

// ═══ 14-16: izolasyon / operasyon durumu / dedup ══════════════════════════

test('OZ-14: varsayılan desi org kapsamlıdır (tenant izolasyonu)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const a = await makeOrg(db, 'oz-14-a')
  const b = await makeOrg(db, 'oz-14-b')
  await shipmentDefaults.saveShipmentDefaults(db, a, { defaultUnitDesi: 3 })
  assert.equal((await shipmentDefaults.getShipmentDefaults(db, a)).defaultUnitDesi, 3)
  assert.equal((await shipmentDefaults.getShipmentDefaults(db, b)).defaultUnitDesi, null)
  await db.update(schema.organizationSettings)
    .set({ settingsJson: { keep: 'x', shipmentDefaults: { defaultUnitDesi: 3 } } })
    .where(eq(schema.organizationSettings.organizationId, a))
  await shipmentDefaults.saveShipmentDefaults(db, a, { defaultUnitDesi: 4 })
  const [row] = await db.select().from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, a))
  assert.equal(row.settingsJson.keep, 'x', 'diğer ayarlar korunur')
})

test('OZ-15: LABEL_READY/LABEL_PRINTED re-sync\'te korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'oz-15')
  const acc = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const base = {
    marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'O1',
    totalAmount: 100, orderDate: '2026-07-10T08:00:00Z', rawOrder: {},
    items: [{ id: 'l1', barcode: 'B', quantity: 1, price: 100, productName: 'Ürün' }],
  }
  await orderService.persistSyncResult(db, org,
    [{ ...base, marketplaceStatus: 'Created', operationStatus: 'LABEL_PRINTED' }],
    { complete: false, marketplaceAccountId: acc.id })
  await orderService.persistSyncResult(db, org,
    [{ ...base, marketplaceStatus: 'Delivered' }],
    { complete: false, marketplaceAccountId: acc.id })
  const [row] = await db.select().from(schema.orders)
  assert.equal(row.operationStatus, 'LABEL_PRINTED', 'operasyon durumu korunur')
  assert.equal(row.marketplaceStatus, 'Delivered')
})

test('OZ-16: order-line deduplication korunur (cross-path tek satır)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'oz-16')
  const acc = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const base = {
    marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'O1',
    marketplaceStatus: 'Delivered', totalAmount: 100,
    orderDate: '2026-07-10T08:00:00Z', rawOrder: {},
  }
  await orderService.persistSyncResult(db, org, [{ ...base,
    items: [{ id: 'ty_line_9', barcode: 'B', merchantSku: 'S', quantity: 1, price: 100, productName: 'Ürün' }] }],
    { complete: false, marketplaceAccountId: acc.id })
  await orderService.persistSyncResult(db, org, [{ ...base,
    items: [{ id: '9', barcode: 'B', merchantSku: 'S', quantity: 1, price: 100, productName: 'Ürün' }] }],
    { complete: false, marketplaceAccountId: acc.id })
  assert.equal((await db.select().from(schema.orderLines)).length, 1, 'duplicate satır oluşmaz')
})

// ═══ 17: çıkış butonu (önceki tur korunuyor) ══════════════════════════════

test('OZ-17: çıkış butonu görünür sidebar footer içindedir', () => {
  const shell = readFileSync(join(here, '..', 'src/components/AppShell.tsx'), 'utf8')
  const css = readFileSync(join(here, '..', 'src/index.css'), 'utf8')
  const footerStart = shell.indexOf('sidebar-footer')
  assert.notEqual(footerStart, -1)
  assert.ok(shell.indexOf('sidebar-signout') > footerStart)
  assert.match(css, /\.sidebar-footer\s*\{[^}]*margin-top:\s*auto/)
  assert.match(css, /\.sidebar-signout:focus-visible/)
})
