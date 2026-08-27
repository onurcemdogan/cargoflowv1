import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// ═══ KODSUZ ETİKET DÜZENLEYİCİSİ — UÇTAN UCA GERÇEKLİK TESTİ ════════════
//
// KÖK NEDEN (bu paketin var olma sebebi): şablon alanları YAZILIYOR ama HİÇ
// OKUNMUYORDU. `template.fields` ne baskı ZPL'ine ne de önizlemeye
// giriyordu ve şablon yalnız tarayıcı localStorage'ında duruyordu; yani
// sunucudaki baskı yolu onu göremiyordu. Editör bu hâliyle DEKORATİFTİ.
//
// Bu dosya "düzenleyici gerçekten çalışıyor mu?" sorusunu ÇIKTI ÜZERİNDEN
// yanıtlar: blok açıldığında baskı ZPL'inde komut var mı, kimlik blokları
// yazılamıyor mu, ayarlar kalıcı mı, taşıyıcı komutları bozuluyor mu.
//
// TAŞIYICI ÇAĞRISI YOKTUR: her şey yerel fixture ve PGlite üzerindedir.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')

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

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}

// Gerçek üretim etiketinin maskelenmiş kopyası (PII yok).
const REAL_ZPL = readFileSync(
  join(here, 'fixtures', 'surat-real-success-11415535074.zpl'),
  'utf8',
)

const ITEMS = [{ productName: 'Ürün A', quantity: 2, color: 'Siyah', size: 'M' }]

const ORDER = {
  orderNumber: '11543590246',
  packageId: '4108176742',
  marketplace: 'Trendyol',
  customerFirstName: 'Alici',
  customerLastName: 'Adsoyad',
  // Yerel biçim: saat çıktısı çalıştıran makinenin saat diliminden bağımsız.
  orderDate: '2026-08-26T09:15:00',
  createdAt: '2026-08-26T09:15:00',
}

const DATA = {
  items: [{ productName: 'Ürün A', quantity: 2, sku: 'SKU-1', color: 'Siyah', size: 'M' }],
  totalQuantity: 2,
  packageId: '4108176742',
  marketplaceName: 'Trendyol',
}

function field(key, patch = {}) {
  return { key, label: key, visible: true, order: 1, ...patch }
}

test('TB-1: acilan blok baski ZPL\'ine GERCEKTEN yazilir', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')

  const values = blocks.resolveTenantBlockValues(ORDER, DATA)
  assert.equal(values.orderTime, '09:15')
  assert.equal(values.buyerName, 'Alici Adsoyad')
  assert.equal(values.variant, 'Siyah / M')

  const off = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS)
  const resolved = blocks.resolveTenantBlocks(
    { fields: [field('orderTime')] },
    values,
  )
  assert.equal(resolved.length, 1)
  const on = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS, {
    tenantBlocks: resolved,
  })

  // Blok KAPALIYKEN çıktı eskisiyle BİREBİR aynıdır (regresyon yok).
  assert.equal(off.tenantBlocksPrinted, 0)
  assert.ok(!off.printZpl.includes('09:15'))
  // AÇILDIĞINDA gerçekten basılır.
  assert.equal(on.tenantBlocksPrinted, 1)
  assert.ok(on.printZpl.includes('09:15'))
  assert.deepEqual([...on.tenantBlocksDropped], [])
})

test('TB-2: punto ve kalinlik ZPL komutuna YANSIR', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')
  const values = blocks.resolveTenantBlockValues(ORDER, DATA)

  const plain = blocks.resolveTenantBlocks(
    { fields: [field('buyerName', { fontSize: 20 })] },
    values,
  )
  const large = blocks.resolveTenantBlocks(
    { fields: [field('buyerName', { fontSize: 44, bold: true })] },
    values,
  )
  const plainZpl = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS, {
    tenantBlocks: plain,
  }).printZpl
  assert.ok(plainZpl.includes('^A0N,20,17'))
  assert.equal(plainZpl.split('Alici Adsoyad').length - 1, 1)

  // BÜYÜK + KALIN: emitter doğrudan sürülür (gerçek etiketin bandı 41 dot
  // olduğu için 44 dot'luk blok o etikete SIĞMAZ — bu ayrı ve DOĞRU bir
  // davranıştır, TB-4'te kanıtlanır).
  const area = { x: 16, top: 700, bottom: 790, width: 700 }
  const largeZpl = blocks
    .buildTenantBlockZplCommands(blocks.planTenantBlocks(large, area), {
      utf8: true,
    })
    .join(String.fromCharCode(10))
  assert.ok(largeZpl.includes('^A0N,44,37'))
  // KALIN = aynı metnin +1 dot kaydırılmış İKİNCİ vuruşu (composer'ın bold
  // adres tekniğiyle aynı); yeni font indirilmez.
  assert.equal(largeZpl.split('Alici Adsoyad').length - 1, 2)
})

test('TB-2b: gercek etikette 44 dot blok SIGMAZ ve bunu ACIKCA soyler', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')
  const resolved = blocks.resolveTenantBlocks(
    { fields: [field('buyerName', { fontSize: 44 })] },
    blocks.resolveTenantBlockValues(ORDER, DATA),
  )
  const derived = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS, {
    tenantBlocks: resolved,
  })
  // SESSİZ KIRPMA YOK: blok basılmaz ve hangi blok olduğu raporlanır.
  assert.equal(derived.tenantBlocksPrinted, 0)
  assert.deepEqual([...derived.tenantBlocksDropped], ['buyerName'])
  assert.ok(!derived.printZpl.includes('Alici Adsoyad'))
  // Ölçülen nominal kapasite bu kararla TUTARLI olmalıdır.
  assert.ok(
    blocks.tenantBlocksHeight(resolved) > blocks.TENANT_BAND_NOMINAL_HEIGHT,
  )
})

test('TB-3: alt yerlesim bandin ALTINDAN yukari dizilir', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const values = blocks.resolveTenantBlockValues(ORDER, DATA)
  const resolved = blocks.resolveTenantBlocks(
    {
      fields: [
        field('orderTime', { order: 1, placement: 'top', fontSize: 18 }),
        field('buyerName', { order: 2, placement: 'bottom', fontSize: 18 }),
      ],
    },
    values,
  )
  const plan = blocks.planTenantBlocks(resolved, {
    x: 16,
    top: 700,
    bottom: 790,
    width: 700,
  })
  const byKey = Object.fromEntries(plan.blocks.map((block) => [block.key, block]))
  assert.equal(byKey.orderTime.y, 700)
  // Alt blok bandın TABANINA yaslanır, üsttekinin hemen altına DEĞİL.
  assert.ok(byKey.buyerName.y > byKey.orderTime.y + byKey.orderTime.height)
  assert.equal(byKey.buyerName.y + byKey.buyerName.height, 790)
})

test('TB-4: bant dolunca blok SESSIZCE dusmez, ACIKCA raporlanir', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const values = blocks.resolveTenantBlockValues(ORDER, DATA)
  const resolved = blocks.resolveTenantBlocks(
    {
      fields: [
        field('orderTime', { order: 1, fontSize: 40 }),
        field('buyerName', { order: 2, fontSize: 40 }),
        field('orderNumber', { order: 3, fontSize: 40 }),
      ],
    },
    values,
  )
  const plan = blocks.planTenantBlocks(resolved, {
    x: 16,
    top: 700,
    bottom: 760,
    width: 700,
  })
  assert.equal(plan.blocks.length, 1)
  assert.equal(plan.dropped.length, 2)
  // Basılan blok KIRPILMAZ veya KÜÇÜLTÜLMEZ: istenen punto aynen korunur.
  assert.equal(plan.blocks[0].fontHeight, 40)
})

test('TB-5: KIMLIK BLOKLARI bu katmandan tek komut YAZAMAZ', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')

  for (const key of ['shipmentCode', 'trackingNumber', 'shippingProvider']) {
    assert.equal(blocks.isTenantRenderableBlock(key), false)
  }
  // Operatör barkodun DEĞERİNİ packageId/orderNumber/rastgele bir jetona
  // çevirmeye çalışsa bile hiçbir şey basılmaz.
  const resolved = blocks.resolveTenantBlocks(
    {
      fields: [
        field('shipmentCode', { fontSize: 40 }),
        field('trackingNumber'),
        field('shippingProvider'),
      ],
    },
    {
      shipmentCode: 'SAHTE-BARKOD',
      trackingNumber: '4108176742',
      shippingProvider: 'RASTGELE-JETON',
    },
  )
  assert.deepEqual(resolved, [])
  const derived = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS, {
    tenantBlocks: resolved,
  })
  assert.equal(derived.tenantBlocksPrinted, 0)
  assert.ok(!derived.printZpl.includes('SAHTE-BARKOD'))
  assert.ok(!derived.printZpl.includes('RASTGELE-JETON'))
})

test('TB-6: kiracı blokları TASIYICI komutlarini bozmaz', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')
  const values = blocks.resolveTenantBlockValues(ORDER, DATA)
  const resolved = blocks.resolveTenantBlocks(
    { fields: [field('orderTime'), field('buyerName', { order: 2 })] },
    values,
  )
  const base = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS)
  const withBlocks = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS, {
    tenantBlocks: resolved,
  })

  // Kaynak ZPL BAYT ÖNEKİ olarak durur; hiçbir taşıyıcı komutu silinmez.
  const carrierCommands = (zpl) =>
    (zpl.match(/\^(BC|BX|BQ|FT|FO|GB)[^\\^]*/g) ?? []).length
  assert.ok(carrierCommands(withBlocks.printZpl) >= carrierCommands(base.printZpl))
  for (const command of ['^BC', '^BX', '^PW799', '^LL0799']) {
    assert.ok(withBlocks.printZpl.includes(command), command)
  }
  // Ürün satırı katmanı da AYNEN durur.
  assert.equal(withBlocks.augmented, base.augmented)
  assert.equal(withBlocks.printZplFooterProfile, base.printZplFooterProfile)
})

test('TB-7: sablon KALICI ve kimlik bloklari depoda REDDEDILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const repo = await load('/server/labels/labelTemplateRepository.ts')

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Kiracı A', slug: 'kiraci-a' })
    .returning()

  assert.equal(await repo.loadLabelTemplate(db, org.id), null)

  const saved = await repo.saveLabelTemplate(
    db,
    org.id,
    [
      { key: 'orderTime', label: 'Sipariş Saati', visible: true, order: 1 },
      {
        key: 'buyerName', label: 'Satın Alan Adı', visible: true, order: 2,
        fontSize: 44, bold: true, placement: 'bottom',
      },
      // Kimlik bloğu: DEĞER yazma girişimi.
      { key: 'shipmentCode', label: 'Barkod', visible: true, order: 3, fontSize: 60 },
    ],
    '2026-08-27T10:00:00.000Z',
  )
  assert.deepEqual(saved.rejected, ['shipmentCode'])
  assert.equal(saved.template.version, 1)

  const loaded = await repo.loadLabelTemplate(db, org.id)
  assert.equal(loaded.fields.length, 2)
  const buyer = loaded.fields.find((entry) => entry.key === 'buyerName')
  assert.equal(buyer.fontSize, 44)
  assert.equal(buyer.bold, true)
  assert.equal(buyer.placement, 'bottom')
  assert.ok(!loaded.fields.some((entry) => entry.key === 'shipmentCode'))

  // İkinci yazım SÜRÜMÜ artırır — eşzamanlı düzenleme görünür olur.
  const second = await repo.saveLabelTemplate(
    db, org.id, [{ key: 'orderTime', label: 'x', visible: false, order: 1 }],
    '2026-08-27T11:00:00.000Z',
  )
  assert.equal(second.template.version, 2)
})

test('TB-8: sablon yazimi DIGER org ayarlarini SILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const repo = await load('/server/labels/labelTemplateRepository.ts')
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Kiracı B', slug: 'kiraci-b' })
    .returning()
  await db.insert(schema.organizationSettings).values({
    organizationId: org.id,
    settingsJson: { shipmentDefaults: { desi: 3 }, externalProcessing: { entries: {} } },
  })

  await repo.saveLabelTemplate(
    db, org.id, [{ key: 'orderTime', label: 'x', visible: true, order: 1 }],
    '2026-08-27T10:00:00.000Z',
  )
  const rows = await db.select().from(schema.organizationSettings)
  assert.equal(rows[0].settingsJson.shipmentDefaults.desi, 3)
  assert.ok(rows[0].settingsJson.externalProcessing)
  assert.ok(rows[0].settingsJson.labelTemplate)
})

test('TB-10: urun satiri parcalari BASKI ZPL ciktisinda acilip kapanir', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')
  const items = [
    { productName: 'Ürün A', quantity: 2, color: 'Siyah', size: 'M', sku: 'SKU-1' },
  ]

  // VARSAYILAN: bugünkü çıktı BİREBİR korunur (ayar verilmemiş kiracı).
  const base = augment.deriveAugmentedSuratZpl(REAL_ZPL, items)
  assert.ok(base.printZpl.includes('2 x Urun A'))
  assert.ok(base.printZpl.includes('(Renk: Siyah, Beden: M)'))
  assert.ok(base.printZpl.includes('[SKU-1]'))

  // Operatör SKU'yu kapatır → SKU basılmaz, sarkan "[]" oluşmaz.
  const parts = blocks.resolveProductLineParts({
    fields: [
      field('quantity', { visible: true }),
      field('variant', { visible: true }),
      field('sku', { visible: false }),
    ],
  })
  assert.deepEqual(parts, { quantity: true, variant: true, sku: false })
  const noSku = augment.deriveAugmentedSuratZpl(REAL_ZPL, items, {
    productLineParts: parts,
  })
  assert.ok(!noSku.printZpl.includes('SKU-1'))
  assert.ok(!noSku.printZpl.includes('[]'))
  assert.ok(noSku.printZpl.includes('(Renk: Siyah, Beden: M)'))
  assert.ok(noSku.printZpl.includes('2 x Urun A'))
  // Ürün satırı hâlâ basılır (katman kaybolmaz).
  assert.equal(noSku.augmented, true)
})

test('TB-11: sablonu OLMAYAN kiraci icin cikti DEGISMEZ', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')
  // Şablon yoksa parçalar varsayılan kalır ve blok basılmaz.
  assert.deepEqual(blocks.resolveProductLineParts(undefined), {
    quantity: true, variant: true, sku: true,
  })
  assert.deepEqual(blocks.resolveTenantBlocks(undefined, {}), [])
  const before = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS)
  const after = augment.deriveAugmentedSuratZpl(REAL_ZPL, ITEMS, {
    tenantBlocks: [],
    productLineParts: blocks.resolveProductLineParts(undefined),
  })
  assert.equal(after.printZpl, before.printZpl)
  assert.equal(after.printZplSourceSha256, before.printZplSourceSha256)
})

test('TB-12: urun satiri YOKKEN blok basilir ama "eklendi" DENMEZ', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')
  const resolved = blocks.resolveTenantBlocks(
    { fields: [field('orderTime')] },
    blocks.resolveTenantBlockValues(ORDER, DATA),
  )
  const derived = augment.deriveAugmentedSuratZpl(REAL_ZPL, [], {
    tenantBlocks: resolved,
  })
  // Blok GERÇEKTEN basılır…
  assert.equal(derived.tenantBlocksPrinted, 1)
  assert.ok(derived.printZpl.includes('09:15'))
  // …ama ürün satırı yoktur ve bu DÜRÜSTÇE raporlanır: mevcut çağıranlar
  // `augmented` bayrağını "ürün satırı eklendi" olarak okur.
  assert.equal(derived.augmented, false)
  assert.equal(derived.augmentationStatus, 'unavailable')
  assert.equal(derived.fallbackReason, 'no_items')
})

// Taşıyıcı içeriği etiketin DİBİNE inen dar bir şablon: composer bandı
// pratikte YOKTUR. Şekil, canlı 4057121401 vakasıyla aynıdır; veriler
// sentetiktir.
const TIGHT_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO60,20^GB700,90,2^FS',
  '^FT80,50^A0N,24,24^FDSube: FERAH^FS',
  '^FT470,50^A0N,26,26^FDT.No: 10715069128642^FS',
  '^FO90,130^BY3^BCN,130,Y,N,N^FD01256423147^FS',
  '^FO60,300^GB700,140,2^FS',
  '^FT80,330^A0N,24,24^FDSENTETIK ALICI^FS',
  '^FO90,600^BXN,5,200^FD7270035470417450^FS',
  '^FT380,700^A0N,40,40^FDKIRIKHAN/05^FS',
  '^FT380,780^A0N,44,44^FDADANA AKTARMA^FS',
  '^FWB', '^FT40,700^A0B,18,18^FDSiparis No: 7270035470417450^FS', '^FWN',
  '^PQ1,0,1,Y', '^XZ',
].join(String.fromCharCode(10))

test('TB-13: bant YOKKEN dusen bloklar erken donuste de RAPORLANIR', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')
  const resolved = blocks.resolveTenantBlocks(
    {
      fields: [
        field('orderTime', { order: 1, fontSize: 30 }),
        field('buyerName', { order: 2, fontSize: 30 }),
      ],
    },
    blocks.resolveTenantBlockValues(ORDER, DATA),
  )
  assert.equal(resolved.length, 2)

  // Ürün satırı YOK ve bant da yok → hiçbir blok basılamaz. Bu erken
  // dönüşte bile operatör HANGİ bloğun düştüğünü öğrenmelidir; aksi hâlde
  // hatayı boş yere şablonda arar.
  const derived = augment.deriveAugmentedSuratZpl(TIGHT_ZPL, [], {
    tenantBlocks: resolved,
  })
  assert.equal(derived.tenantBlocksPrinted, 0)
  assert.deepEqual([...derived.tenantBlocksDropped].sort(), [
    'buyerName', 'orderTime',
  ])
  assert.equal(derived.fallbackReason, 'no_items')
  // Kaynak ZPL AYNEN korunur.
  assert.equal(derived.printZpl, TIGHT_ZPL)
})

test('TB-14: SUNUCU yukleyicisi sablonu GERCEK siparise uygular', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const repo = await load('/server/labels/labelTemplateRepository.ts')
  const loader = await load('/server/labels/tenantBlockLoader.ts')
  const augment = await load('/src/utils/augmentedSuratZpl.ts')

  const [org] = await db
    .insert(schema.organizations)
    .values({ name: 'Kiraci C', slug: 'kiraci-c' })
    .returning()
  const [order] = await db
    .insert(schema.orders)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      packageId: '4108176742',
      orderNumber: '11543590246',
      orderDate: new Date('2026-08-26T09:15:00.000Z'),
      customerFirstName: 'Alici',
      customerLastName: 'Adsoyad',
      operationStatus: 'NEW',
    })
    .returning()
  await db.insert(schema.orderLines).values({
    organizationId: org.id,
    orderId: order.id,
    externalLineId: 'L-0',
    productName: 'Urun A',
    merchantSku: 'SKU-1',
    quantity: 2,
    // GERCEK sekil: {name, value}. Yukleyici bir zamanlar
    // {attributeName, attributeValue} ariyordu ve varyant HER ZAMAN bostu;
    // artik urun satirinin KANONIK cozucusu kullanilir.
    variantAttributes: [
      { name: 'Renk', value: 'Siyah' },
      { name: 'Beden', value: 'M' },
    ],
  })

  // Operator: SKU'yu KAPAT, varyant ve adet ACIK; ayrica satin alan adi ve
  // paket no AYRI blok olarak basilsin.
  const saved = await repo.saveLabelTemplate(
    db, org.id,
    [
      { key: 'quantity', label: 'Adet', visible: true, order: 1 },
      { key: 'variant', label: 'Varyant', visible: true, order: 2 },
      { key: 'sku', label: 'SKU', visible: false, order: 3 },
      { key: 'buyerName', label: 'Satın Alan Adı', visible: true, order: 4 },
      { key: 'packageId', label: 'Paket No', visible: true, order: 5 },
    ],
    '2026-08-27T10:00:00.000Z',
  )
  // URUN SATIRI PARCALARI da KALICI olmali: bunlar reddedilseydi
  // "SKU'yu gizle" ayari sunucuya HIC ulasmaz, sessizce varsayilana donerdi.
  assert.deepEqual(saved.rejected, [])

  const config = await loader.loadTenantLabelBlocks(
    db, org.id, 'Trendyol', '4108176742',
  )
  const byKey = Object.fromEntries(config.blocks.map((b) => [b.key, b.text]))
  assert.equal(byKey.buyerName, 'Alici Adsoyad')
  assert.equal(byKey.packageId, '4108176742')
  // Varyant AYRI blok DEGILDIR: urun satirinin parcasidir (cift baski yok).
  assert.equal(byKey.variant, undefined)
  assert.deepEqual(config.productLineParts, {
    quantity: true, variant: true, sku: false,
  })

  // UCTAN UCA: baski ZPL'i SKU'yu BASMAZ, varyanti BASAR, bloklari EKLER.
  const items = [
    { productName: 'Urun A', quantity: 2, color: 'Siyah', size: 'M', sku: 'SKU-1' },
  ]
  const derived = augment.deriveAugmentedSuratZpl(REAL_ZPL, items, {
    tenantBlocks: config.blocks,
    productLineParts: config.productLineParts,
  })
  assert.ok(!derived.printZpl.includes('SKU-1'))
  assert.ok(!derived.printZpl.includes('[]'))
  assert.ok(derived.printZpl.includes('(Renk: Siyah, Beden: M)'))
  assert.ok(derived.printZpl.includes('2 x Urun A'))
  assert.ok(derived.tenantBlocksPrinted >= 1)
})

test('TB-15: EK URUN SAYFALARI da kiraci ayarini izler', async () => {
  const detail = await load('/src/utils/suratProductDetailLabel.ts')
  // Esik ustunde farkli varyant → ek sayfa gerekir.
  const items = Array.from({ length: 5 }, (_, index) => ({
    productName: `Urun ${index}`,
    quantity: 1,
    color: 'Siyah',
    size: 'M',
    sku: `SKU-${index}`,
  }))

  const withSku = detail.planProductDetailPages(items)
  assert.equal(withSku.required, true)
  const withSkuText = withSku.pages
    .flatMap((page) => page.blocks.map((block) => `${block.title} ${block.meta}`))
    .join(' ')
  assert.match(withSkuText, /SKU-0/)

  // SKU kapatilinca ek sayfada da BASILMAZ. Aksi halde operator, tasiyici
  // etiketinde gizledigi SKU'yu ek sayfada basilmis bulurdu.
  const withoutSku = detail.planProductDetailPages(items, {
    quantity: true, variant: true, sku: false,
  })
  const withoutSkuText = withoutSku.pages
    .flatMap((page) => page.blocks.map((block) => `${block.title} ${block.meta}`))
    .join(' ')
  assert.ok(!withoutSkuText.includes('SKU-0'))
  assert.ok(!withoutSkuText.includes('[]'))
  assert.match(withoutSkuText, /\(Renk: Siyah, Beden: M\)/)
  // Sayfa sozlesmesi KORUNUR: her urun TAM OLARAK bir kez.
  assert.equal(
    withoutSku.pages.reduce((total, page) => total + page.blocks.length, 0),
    items.length,
  )
})

test('TB-9: ONIZLEME ile BASKI ayni cozumleyiciden beslenir', async () => {
  const blocks = await load('/src/utils/labelTenantBlocks.ts')
  const preview = readFileSync(
    join(here, '..', 'src', 'components', 'LabelHtmlPreview.tsx'),
    'utf8',
  )
  // Önizleme kendi metnini ÜRETMEZ; ZPL yolunun kullandığı saf fonksiyonu
  // çağırır. Kopya bir formatlayıcı ikisini sessizce ayrıştırırdı.
  assert.ok(preview.includes('resolveTenantBlocks'))
  assert.ok(preview.includes('resolveTenantBlockValues'))
  assert.ok(preview.includes("from '../utils/labelTenantBlocks'"))
  // Önizleme fetch/XHR YAPMAZ: taşıyıcı ve pazaryeri çağrısı = 0.
  assert.ok(!/\bfetch\(/.test(preview))
  assert.ok(!/XMLHttpRequest/.test(preview))
  assert.equal(typeof blocks.resolveTenantBlocks, 'function')
})
