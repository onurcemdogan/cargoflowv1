import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { createServer } from 'vite'

// ÇOKLU ÜRÜN DESİ ÇARPANI — ORGANIZASYON AYARI (multiplyByItemQuantity).
//
// MEVCUT (değişmeyen) sözleşme:
//   calculatedTotalDesi = Σ round2(satır adedi × satır birim desisi)
//   birim desi önceliği: order_line → product_variant → product_cache →
//   merchant_mapping → category_default → tenant_default
//   nihai öncelik: manuel/kayıtlı toplam desi → satır hesabı → blok
//
// YENİ ayar YALNIZ tenant (organizasyon varsayılanı) kaynaklı katkıyı yönetir:
//   true  (VARSAYILAN, eski kayıtlarda alan yoksa da true) → adetle çarpılır
//   false → varsayılan desi paket başına BİR KEZ sayılır
// Gerçek ürün/satır desisi HER İKİ durumda da adetle çarpılmaya devam eder.
//
// Fixture'lar SENTETİKTİR; gerçek müşteri verisi, adres, telefon veya secret
// İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
const shipmentDefaults = await import(
  './onboarding/shipmentDefaultsRepository.ts'
)

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      optimizeDeps: { noDiscovery: true, include: [] },
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
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  return org.id
}

// ── Fixture'lar ────────────────────────────────────────────────────────────
// Organizasyon varsayılan gönderi desisi = 2.
const DEFAULT_DESI = 2
const ON = { defaultUnitDesi: DEFAULT_DESI }
const OFF = { defaultUnitDesi: DEFAULT_DESI, multiplyByItemQuantity: false }

const line = (over = {}) => ({
  id: 'L1',
  productName: 'Sentetik Ürün',
  sku: 'SKU-1',
  barcode: 'BC-1',
  quantity: 1,
  ...over,
})
const order = (items, extra = {}) => ({
  id: 'order-desi-multiplier',
  marketplace: 'Trendyol',
  externalOrderId: 'EXT-1',
  orderNumber: '7270000000000001',
  customerName: '',
  customerPhone: '',
  customerEmail: '',
  address: '',
  city: '',
  district: '',
  totalAmount: 0,
  createdAt: '2026-07-18T00:00:00.000Z',
  marketplaceStatus: 'Created',
  operationStatus: 'READY_TO_SHIP',
  source: 'real',
  status: 'Yeni',
  items,
  ...extra,
})
// Sipariş A: 1 kalem, adet 1
const ORDER_A = () => order([line({ id: 'A1', quantity: 1 })])
// Sipariş B: 1 kalem, adet 3
const ORDER_B = () => order([line({ id: 'B1', quantity: 3 })])
// Sipariş C: adet 2 + adet 1 (toplam 3 adet, 2 satır)
const ORDER_C = () =>
  order([
    line({ id: 'C1', quantity: 2 }),
    line({ id: 'C2', sku: 'SKU-2', barcode: 'BC-2', quantity: 1 }),
  ])

// ═══ 1-14: SAF HESAP ═══════════════════════════════════════════════════════

test('DM-1..DM-6: A/B/C siparişleri — çarpan AÇIK ve KAPALI sonuçları', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  // DM-1: A açık — 1 adet × 2 = 2
  assert.equal(calculateOrderDesi(ORDER_A(), [], ON).finalDesi, 2)
  // DM-2: A kapalı — tek adet, ayar sonucu DEĞİŞTİRMEZ
  assert.equal(calculateOrderDesi(ORDER_A(), [], OFF).finalDesi, 2)
  // DM-3: B açık — 3 adet × 2 = 6
  assert.equal(calculateOrderDesi(ORDER_B(), [], ON).finalDesi, 6)
  // DM-4: B kapalı — varsayılan paket başına bir kez = 2
  assert.equal(calculateOrderDesi(ORDER_B(), [], OFF).finalDesi, 2)
  // DM-5: C açık — (2+1) adet × 2 = 6
  assert.equal(calculateOrderDesi(ORDER_C(), [], ON).finalDesi, 6)
  // DM-6: C kapalı — iki satır olsa da varsayılan bir kez = 2
  assert.equal(calculateOrderDesi(ORDER_C(), [], OFF).finalDesi, 2)
})

test('DM-7: ayar belirtilmezse AÇIK davranış (geriye dönük uyumluluk)', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const legacy = calculateOrderDesi(ORDER_B(), [], {
    defaultUnitDesi: DEFAULT_DESI,
  })
  assert.equal(legacy.finalDesi, calculateOrderDesi(ORDER_B(), [], ON).finalDesi)
  assert.equal(legacy.finalDesi, 6)
})

test('DM-8: undefined/null desiConfig ile davranış eskisiyle AYNI', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  assert.equal(calculateOrderDesi(ORDER_B(), []).calculatedTotalDesi, null)
  assert.equal(calculateOrderDesi(ORDER_B(), [], null).calculatedTotalDesi, null)
})

test('DM-9: satır (order_line) desisi ayardan BAĞIMSIZ, her zaman adetle çarpılır', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const real = order([line({ id: 'R1', quantity: 3, desi: 5 })])
  assert.equal(calculateOrderDesi(real, [], ON).finalDesi, 15)
  assert.equal(calculateOrderDesi(real, [], OFF).finalDesi, 15)
})

test('DM-10: ürün kataloğu desisi ayardan BAĞIMSIZ, her zaman adetle çarpılır', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const products = [
    {
      id: 'p-1',
      marketplace: 'Trendyol',
      productName: 'Sentetik Ürün',
      sku: 'SKU-1',
      barcode: 'BC-1',
      productMainId: 'MODEL-1',
      stock: 0,
      price: 0,
      source: 'real',
      updatedAt: '2026-07-18T00:00:00.000Z',
      desi: 4,
    },
  ]
  assert.equal(calculateOrderDesi(ORDER_B(), products, ON).finalDesi, 12)
  assert.equal(calculateOrderDesi(ORDER_B(), products, OFF).finalDesi, 12)
})

test('DM-11: karışık sipariş — gerçek desi çarpılır, varsayılan bir kez eklenir', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const mixed = order([
    line({ id: 'M1', quantity: 2, desi: 5 }),
    line({ id: 'M2', sku: 'SKU-2', barcode: 'BC-2', quantity: 3 }),
  ])
  // AÇIK  : 2×5 + 3×2 = 16
  assert.equal(calculateOrderDesi(mixed, [], ON).finalDesi, 16)
  // KAPALI: 2×5 + 2   = 12
  assert.equal(calculateOrderDesi(mixed, [], OFF).finalDesi, 12)
})

test('DM-12: manuel toplam desi HER İKİ ayarda da önceliklidir', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const manual = order([line({ id: 'X1', quantity: 3 })], {
    desi: 7,
    desiSource: 'manual_total',
  })
  for (const config of [ON, OFF]) {
    const result = calculateOrderDesi(manual, [], config)
    assert.equal(result.finalDesi, 7)
    assert.equal(result.finalDesiSource, 'manual_total')
  }
})

test('DM-13: varsayılan tanımsızsa ayar KAPALI olsa da hesap BLOKLANIR', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  const blocked = calculateOrderDesi(ORDER_B(), [], {
    defaultUnitDesi: null,
    multiplyByItemQuantity: false,
  })
  assert.equal(blocked.finalDesi, null)
  assert.match(blocked.blockedReason ?? '', /desi bilgisi eksik/)
})

test('DM-14: iptal/tekrarlı satır ve yuvarlama kuralları ayardan etkilenmez', async () => {
  const { calculateOrderDesi } = await load('/src/utils/orderDesi.ts')
  // İptal satırı sayılmaz: kalan adet 2.
  const cancelled = order([
    line({ id: 'Z1', quantity: 2 }),
    line({
      id: 'Z2',
      sku: 'SKU-2',
      barcode: 'BC-2',
      quantity: 2,
      rawLine: { status: 'Cancelled' },
    }),
  ])
  assert.equal(calculateOrderDesi(cancelled, [], ON).finalDesi, 4)
  assert.equal(calculateOrderDesi(cancelled, [], OFF).finalDesi, 2)
  // Aynı lineId iki kez: ikinci kopya sayılmaz.
  const duplicate = order([
    line({ id: 'D1', quantity: 2 }),
    line({ id: 'D1', quantity: 2 }),
  ])
  assert.equal(calculateOrderDesi(duplicate, [], ON).finalDesi, 4)
  assert.equal(calculateOrderDesi(duplicate, [], OFF).finalDesi, 2)
  // Ondalık varsayılan: 2 ondalığa yuvarlanır, kapalıyken çarpılmaz.
  const fractional = { defaultUnitDesi: 1.33 }
  assert.equal(calculateOrderDesi(ORDER_B(), [], fractional).finalDesi, 3.99)
  assert.equal(
    calculateOrderDesi(ORDER_B(), [], {
      ...fractional,
      multiplyByItemQuantity: false,
    }).finalDesi,
    1.33,
  )
})

// ═══ 15-22: NORMALİZASYON VE KALICILIK ═════════════════════════════════════

test('DM-15: normalizeTenantDesiConfig eksik alanı true kabul eder', async () => {
  const { normalizeTenantDesiConfig, DEFAULT_TENANT_DESI_CONFIG } = await load(
    '/src/utils/orderDesi.ts',
  )
  assert.equal(DEFAULT_TENANT_DESI_CONFIG.multiplyByItemQuantity, true)
  assert.equal(normalizeTenantDesiConfig(null).multiplyByItemQuantity, true)
  assert.equal(normalizeTenantDesiConfig({}).multiplyByItemQuantity, true)
  assert.equal(
    normalizeTenantDesiConfig({ multiplyByItemQuantity: undefined })
      .multiplyByItemQuantity,
    true,
  )
  assert.equal(
    normalizeTenantDesiConfig({ multiplyByItemQuantity: false })
      .multiplyByItemQuantity,
    false,
  )
})

test('DM-16: sunucu normalizasyonu — yalnız açık false kapatır', () => {
  const { normalizeMultiplyByItemQuantity: n } = shipmentDefaults
  assert.equal(n(undefined), true)
  assert.equal(n(null), true)
  assert.equal(n(true), true)
  assert.equal(n(false), false)
  assert.equal(n('false'), false)
  assert.equal(n('0'), false)
  assert.equal(n('true'), true)
  assert.equal(n('saçma'), true)
  assert.equal(n(0), false)
  assert.equal(n(1), true)
})

test('DM-17: EMPTY_SHIPMENT_DEFAULTS varsayılanı true', () => {
  assert.equal(shipmentDefaults.EMPTY_SHIPMENT_DEFAULTS.multiplyByItemQuantity, true)
})

test('DM-18: ayar organization_settings JSONB içinde saklanır (yeni kolon YOK)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dm-18')
  await shipmentDefaults.saveShipmentDefaults(db, org, {
    defaultUnitDesi: 2,
    multiplyByItemQuantity: false,
  })
  const [row] = await db
    .select()
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, org))
  assert.equal(row.settingsJson.shipmentDefaults.multiplyByItemQuantity, false)
  assert.equal(row.settingsJson.shipmentDefaults.defaultUnitDesi, 2)
})

test('DM-19: kaydedilen ayar geri okunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dm-19')
  await shipmentDefaults.saveShipmentDefaults(db, org, {
    defaultUnitDesi: 2,
    multiplyByItemQuantity: false,
  })
  const read = await shipmentDefaults.getShipmentDefaults(db, org)
  assert.equal(read.multiplyByItemQuantity, false)
  await shipmentDefaults.saveShipmentDefaults(db, org, {
    defaultUnitDesi: 2,
    multiplyByItemQuantity: true,
  })
  assert.equal(
    (await shipmentDefaults.getShipmentDefaults(db, org)).multiplyByItemQuantity,
    true,
  )
})

test('DM-20: ESKİ kayıt (alan yok) true olarak okunur — davranış değişmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dm-20')
  await db.insert(schema.organizationSettings).values({
    organizationId: org,
    settingsJson: { shipmentDefaults: { defaultUnitDesi: 2 } },
  })
  const read = await shipmentDefaults.getShipmentDefaults(db, org)
  assert.equal(read.defaultUnitDesi, 2)
  assert.equal(read.multiplyByItemQuantity, true)
})

test('DM-21: ayar org kapsamlıdır — bir org diğerini ETKİLEMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const a = await makeOrg(db, 'dm-21-a')
  const b = await makeOrg(db, 'dm-21-b')
  await shipmentDefaults.saveShipmentDefaults(db, a, {
    defaultUnitDesi: 2,
    multiplyByItemQuantity: false,
  })
  assert.equal(
    (await shipmentDefaults.getShipmentDefaults(db, a)).multiplyByItemQuantity,
    false,
  )
  assert.equal(
    (await shipmentDefaults.getShipmentDefaults(db, b)).multiplyByItemQuantity,
    true,
    'ikinci org varsayılanda (çarpan açık) kalır',
  )
})

test('DM-22: kayıt diğer settings_json alanlarını KORUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'dm-22')
  await db.insert(schema.organizationSettings).values({
    organizationId: org,
    settingsJson: { onboarding: { completed: true }, shipmentDefaults: {} },
  })
  await shipmentDefaults.saveShipmentDefaults(db, org, {
    defaultUnitDesi: 2,
    multiplyByItemQuantity: false,
  })
  const [row] = await db
    .select()
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, org))
  assert.equal(row.settingsJson.onboarding.completed, true)
  assert.equal(row.settingsJson.shipmentDefaults.multiplyByItemQuantity, false)
})

// ═══ 23-26: API SÖZLEŞMESİ VE MIGRATION YOKLUĞU ════════════════════════════

const serverSource = readFileSync(join(here, 'index.mjs'), 'utf8')

test('DM-23: GET ve PUT ayar yanıtları alanı taşır', () => {
  const occurrences = serverSource.match(
    /multiplyByItemQuantity: shipmentDefaults\.multiplyByItemQuantity/g,
  )
  assert.equal(occurrences?.length, 2, 'GET ve PUT yanıtlarında alan var')
})

test('DM-24: PUT alan gönderilmezse MEVCUT değeri korur', () => {
  assert.match(
    serverSource,
    /multiplyByItemQuantity:\s*\n\s*incoming\.desi\.multiplyByItemQuantity \?\?\s*\n\s*shipmentDefaults\.multiplyByItemQuantity/,
  )
})

test('DM-25: bu değişiklik yeni migration EKLEMEZ', () => {
  const files = readdirSync(join(here, '..', 'drizzle')).filter((f) =>
    f.endsWith('.sql'),
  )
  const sql = files
    .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'))
    .join('\n')
  assert.equal(
    /multiply_by_item_quantity|multiplyByItemQuantity/i.test(sql),
    false,
    'ayar JSONB içinde yaşar; kolon/migration yok',
  )
})

test('DM-26: ayar sağlayıcıdan bağımsızdır (anahtar ve metinde taşıyıcı adı YOK)', () => {
  const files = [
    'server/onboarding/shipmentDefaultsRepository.ts',
    'src/utils/orderDesi.ts',
    'src/types/cargoflow.ts',
  ]
  for (const rel of files) {
    const src = readFileSync(join(here, '..', rel), 'utf8')
    const toggleLines = src
      .split('\n')
      .filter((l) => l.includes('multiplyByItemQuantity'))
    assert.ok(toggleLines.length > 0, `alan yok: ${rel}`)
    for (const l of toggleLines) {
      assert.equal(/sürat|surat|zebra/i.test(l), false, `taşıyıcıya bağlı: ${l}`)
    }
  }
})

// ═══ 27-31: AYARLAR EKRANI ═════════════════════════════════════════════════

const settingsSource = readFileSync(
  join(here, '..', 'src', 'pages', 'IntegrationsPage.tsx'),
  'utf8',
)

test('DM-27: Etiket sekmesinde "Ürün adedine göre desiyi çarp" anahtarı var', () => {
  assert.match(settingsSource, /Ürün adedine göre desiyi çarp/)
  assert.match(settingsSource, /role="switch"/)
  assert.match(settingsSource, /id="desi-multiply-by-item-quantity"/)
  assert.match(settingsSource, /htmlFor="desi-multiply-by-item-quantity"/)
})

test('DM-28: anahtar varsayılan olarak AÇIK görünür (alan yoksa da)', () => {
  assert.match(
    settingsSource,
    /checked=\{form\.desi\?\.multiplyByItemQuantity !== false\}/,
  )
})

test('DM-29: kayıt sırasında anahtar devre dışıdır', () => {
  const switchBlock = settingsSource.slice(
    settingsSource.indexOf('id="desi-multiply-by-item-quantity"'),
    settingsSource.indexOf('Ürün adedine göre desiyi çarp'),
  )
  assert.match(switchBlock, /disabled=\{busy\}/)
})

test('DM-30: ekrandaki örnek GERÇEK hesaptan üretilir (elle rakam yok)', async () => {
  const { describeDesiMultiplierExample, calculateOrderDesi } = await load(
    '/src/utils/orderDesi.ts',
  )
  assert.match(settingsSource, /describeDesiMultiplierExample\(/)
  const example = describeDesiMultiplierExample(DEFAULT_DESI)
  assert.equal(example.defaultUnitDesi, 2)
  assert.equal(example.quantity, 2)
  // Örnek değerler doğrudan calculateOrderDesi'den gelmeli.
  const sample = order([line({ id: 'S1', quantity: example.quantity })])
  assert.equal(
    example.enabledDesi,
    calculateOrderDesi(sample, [], { defaultUnitDesi: 2 }).finalDesi,
  )
  assert.equal(
    example.disabledDesi,
    calculateOrderDesi(sample, [], {
      defaultUnitDesi: 2,
      multiplyByItemQuantity: false,
    }).finalDesi,
  )
  assert.equal(example.enabledDesi, 4)
  assert.equal(example.disabledDesi, 2)
})

test('DM-31: varsayılan tanımsızken örnek yine de güvenli üretilir', async () => {
  const { describeDesiMultiplierExample } = await load('/src/utils/orderDesi.ts')
  const example = describeDesiMultiplierExample(null)
  assert.equal(example.defaultUnitDesi, 2)
  assert.equal(example.enabledDesi, 4)
  assert.equal(example.disabledDesi, 2)
})

// ═══ 32-34: YENİ GÖNDERİ vs KAYITLI/REPRINT ════════════════════════════════

test('DM-32: kayıtlı manuel toplam desi ayar KAPALIYKEN de değişmez', async () => {
  const { resolveEffectiveLabelDesi } = await load('/src/utils/labelDesi.ts')
  const persisted = order([line({ id: 'P1', quantity: 3 })], {
    desi: 6,
    desiSource: 'manual_total',
  })
  const result = resolveEffectiveLabelDesi(persisted, undefined, [], OFF)
  assert.equal(result.desi, 6)
  assert.equal(result.desiSource, 'manual_total')
})

test('DM-33: gönderide kayıtlı API desisi ayar KAPALIYKEN de korunur (reprint)', async () => {
  const { resolveEffectiveLabelDesi } = await load('/src/utils/labelDesi.ts')
  const result = resolveEffectiveLabelDesi(
    ORDER_B(),
    { apiRequestDesi: 6 },
    [],
    OFF,
  )
  assert.equal(result.desi, 6)
  assert.equal(result.desiSource, 'api')
})

test('DM-34: kayıtlı desi YOKSA ayar yeni gönderiyi etkiler', async () => {
  const { resolveEffectiveLabelDesi } = await load('/src/utils/labelDesi.ts')
  assert.equal(resolveEffectiveLabelDesi(ORDER_B(), undefined, [], ON).desi, 6)
  assert.equal(resolveEffectiveLabelDesi(ORDER_B(), undefined, [], OFF).desi, 2)
})

// ═══ 35-37: UI KONUMU — SAĞLAYICIDAN BAĞIMSIZ ORTAK BÖLÜM ══════════════════

test('DM-35: anahtar sağlayıcı panelinin DIŞINDA, ortak bileşende tanımlıdır', () => {
  const shared = settingsSource.indexOf('function ShipmentDefaultsSection(')
  const carrier = settingsSource.indexOf('function SuratSettingsPanel(')
  const toggle = settingsSource.indexOf('id="desi-multiply-by-item-quantity"')
  assert.ok(shared > 0, 'ortak bölüm bileşeni var')
  assert.ok(toggle > shared, 'anahtar ortak bileşen içinde')
  // Sürat paneli anahtardan ÖNCE biter: gövdesinde desi alanı kalmamıştır.
  const carrierBody = settingsSource.slice(
    carrier,
    settingsSource.indexOf('interface ShipmentDefaultsSectionProps'),
  )
  assert.equal(
    /multiplyByItemQuantity|Varsayılan Gönderi Desisi/.test(carrierBody),
    false,
    'sağlayıcı panelinde gönderi varsayılanı kalmamalı',
  )
})

test('DM-36: sağlayıcı sekme listesinde artık "Etiket" sekmesi YOK', () => {
  const workspace = readFileSync(
    join(here, '..', 'src', 'utils', 'integrationWorkspace.ts'),
    'utf8',
  )
  assert.equal(/key: 'label'/.test(workspace), false)
  assert.equal(/'label'\s*\n\s*\| 'sync'/.test(workspace), false)
})

test('DM-37: ortak bölüm başlığı ve açıklamasında sağlayıcı adı YOK', () => {
  const start = settingsSource.indexOf('aria-label="Kargo ve Etiket Varsayılanları"')
  assert.ok(start > 0, 'ortak bölüm etiketlenmiş')
  const header = settingsSource.slice(start, start + 400)
  assert.match(header, /title="Kargo ve Etiket Varsayılanları"/)
  assert.equal(/sürat|surat|zebra|yurtiçi|aras|mng/i.test(header), false)
})
