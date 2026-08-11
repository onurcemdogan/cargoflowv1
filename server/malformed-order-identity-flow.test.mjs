import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

// BOZUK SIPARIS KIMLIGI — SALT OKUNUR TANI.
//
// URETIM BULGUSU: "Yeni Siparisler" ekraninda siparis no `0`, pazaryeri
// statusu bos ("Bilinmeyen Durum") kayitlar goruldu (9 adet).
//
// Bu paket YALNIZ taniyi kilitler. Uretim davranisi DEGISMEDI: hicbir
// fail-closed engel, temizlik veya yeni statu karari EKLENMEDI — kok neden
// uretim verisiyle kanitlanmadan uretim kodu degistirilmez.
//
// Surat/SSP, ZPL/etiket, retention, stage resolver KAPSAM DISIDIR.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const audit = await import('./orders/malformedOrderAudit.ts')
const mapper = await import('./orders/orderMapper.ts')
const repo = await import('./orders/orderRepository.ts')

const { orders, organizations, marketplaceAccounts } = schema
const ENTRY_SOURCE = readFileSync('server/index.mjs', 'utf8')

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
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Test Org', slug: `org-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  const [account] = await db
    .insert(marketplaceAccounts)
    .values({
      organizationId: org.id,
      marketplace: 'Trendyol',
      providerAccountId: '277221',
      isActive: true,
    })
    .returning({ id: marketplaceAccounts.id })
  return { db, organizationId: org.id, accountId: account.id }
}

// ═══ KIMLIK YUKLEMI ═══════════════════════════════════════════════════════

test('MALFORMED-1: sayisal 0 ve bos deger KIMLIK SAYILMAZ', () => {
  for (const value of [0, '0', '', '   ', null, undefined, 'null', 'NaN']) {
    assert.equal(audit.isRealIdentity(value), false, String(value))
  }
  for (const value of ['11493372619', 4065907241, '4065907241']) {
    assert.equal(audit.isRealIdentity(value), true, String(value))
  }
})

test('MALFORMED-2: uretimdeki satir sekli BOZUK olarak siniflanir', () => {
  const row = {
    marketplace: 'Trendyol',
    packageId: '0',
    orderNumber: '0',
    marketplaceStatus: null,
    marketplaceAccountId: null,
  }
  assert.equal(audit.isMalformedIdentity(row), true)
  assert.deepEqual(audit.findIdentityDefects(row), [
    'placeholder_order_number',
    'placeholder_package_id',
    'missing_marketplace',
    'missing_marketplace_status',
    'unscoped_marketplace_account',
  ].filter((defect) => defect !== 'missing_marketplace'))
})

test('MALFORMED-3: gecerli kimlik BOZUK sayilmaz', () => {
  const row = {
    marketplace: 'Trendyol',
    packageId: '4065907241',
    orderNumber: '11493372619',
    marketplaceStatus: 'Shipped',
    marketplaceAccountId: 'acc-1',
  }
  assert.equal(audit.isMalformedIdentity(row), false)
  assert.deepEqual(audit.findIdentityDefects(row), [])
  // Statusu bos ama kimligi saglam kayit KIMLIK hatasi DEGILDIR.
  assert.equal(
    audit.isMalformedIdentity({ ...row, marketplaceStatus: '' }),
    false,
  )
  assert.deepEqual(
    audit.findIdentityDefects({ ...row, marketplaceStatus: '' }),
    ['missing_marketplace_status'],
  )
})

// ═══ KOK NEDEN KIRILGANLIGI (KANIT) ═══════════════════════════════════════

test('MALFORMED-4: `??` zinciri sayisal 0 kimligini GECIRIR', () => {
  // KANIT — kaynak satiri: normalize kimligi `??` ile cozer ve `??` YALNIZ
  // null/undefined'a duser; sayisal 0 GECERLI kabul edilip '0' olur.
  assert.ok(
    ENTRY_SOURCE.includes(
      "const packageId = String(item.packageId ?? item.shipmentPackageId ?? item.id ?? '')",
    ),
  )
  assert.ok(
    ENTRY_SOURCE.includes(
      'orderNumber: String(item.orderNumber ?? item.id ?? `TY-ORDER-${index + 1}`)',
    ),
  )
  // Davranis: 0 -> '0'
  assert.equal(String(0 ?? 'fallback'), '0')
  assert.equal(audit.isRealIdentity(String(0 ?? 'fallback')), false)

  // Mapper de bu '0' degerini oldugu gibi yazar (fallback URETMEZ).
  const insertValues = mapper.toOrderInsertValues(
    '11111111-1111-1111-1111-111111111111',
    {
      marketplace: 'Trendyol',
      packageId: '0',
      orderNumber: '0',
      marketplaceStatus: '',
      orderDate: '2026-08-11T00:00:00.000Z',
    },
    null,
  )
  assert.equal(insertValues.orderNumber, '0')
  assert.equal(insertValues.packageId, '0')
  assert.equal(insertValues.marketplaceStatus, null)
})

test('MALFORMED-5: normalize on-filtresi 0 kimlikli parcali kaydi GECIRIR', () => {
  // `isTrendyolOrderPackage` kimlik icin HERHANGI BIR alanin truthy olmasini
  // yeterli sayar; musteri/adres varsa kayit gecer. orderNumber=0 olan bir
  // parcali paket bu yuzden elenmez.
  const partial = {
    id: 12345,
    orderNumber: 0,
    customerFirstName: 'X',
    lines: [],
  }
  assert.equal(audit.passesTrendyolPackagePredicate(partial), true)
  // Kimlik alani HIC yoksa elenir.
  assert.equal(
    audit.passesTrendyolPackagePredicate({ customerFirstName: 'X' }),
    false,
  )
  // Musteri/adres yoksa elenir (urun listeleri bu yuzden siparis olamaz).
  assert.equal(audit.passesTrendyolPackagePredicate({ id: 1, barcode: 'b' }), false)

  // Yuklem kaynakla AYNI olmali (kopya degil, sozlesme).
  const lines = ENTRY_SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('function isTrendyolOrderPackage'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('item.orderNumber || item.packageId'))
  assert.ok(body.includes('item.customerFirstName ||'))
})

// ═══ HAM YUK SEKLI (PII YOK) ══════════════════════════════════════════════

test('MALFORMED-6: ham yuk raporu DEGER SIZDIRMAZ', () => {
  const shape = audit.describeRawIdentityShape({
    id: 12345,
    orderNumber: 0,
    packageId: null,
    status: '',
    lines: [{ productName: 'Zara Elbise', price: 199.9 }],
    customerFirstName: 'Zeynep',
    shipmentAddress: { city: 'Istanbul', address1: 'gizli' },
  })
  assert.deepEqual(shape.orderNumber, {
    present: true,
    type: 'number',
    isZero: true,
  })
  assert.deepEqual(shape.packageId, { present: false, type: 'null' })
  assert.deepEqual(shape.status, { present: true, type: 'string', empty: true })
  assert.deepEqual(shape.lines, { present: true, type: 'array', length: 1 })
  assert.deepEqual(shape.customerFirstName, { present: true, type: 'string', empty: false })

  const serialized = JSON.stringify(shape)
  for (const leak of ['Zeynep', 'Istanbul', 'gizli', 'Zara', '199.9', '12345']) {
    assert.equal(serialized.includes(leak), false, leak)
  }
  assert.equal(audit.describeRawIdentityShape(null), null)
})

// ═══ YAZAR ATIFI ══════════════════════════════════════════════════════════

test('MALFORMED-7: yazar imzasi hesap kapsamindan turetilir', () => {
  assert.equal(
    audit.attributeWriter({ marketplaceAccountId: 'acc-1', rawPayloadPresent: true }),
    'marketplace_sync_scoped',
  )
  assert.equal(
    audit.attributeWriter({ marketplaceAccountId: null, rawPayloadPresent: true }),
    'marketplace_sync_unscoped_legacy',
  )
  assert.equal(
    audit.attributeWriter({ marketplaceAccountId: 'acc-1', rawPayloadPresent: false }),
    'non_sync_or_unknown',
  )
})

test('MALFORMED-8: stale reconciler YENI placeholder kayit URETEMEZ', () => {
  const module = readFileSync('server/orders/staleOpenReconciler.ts', 'utf8')
  // Yorumlar ayiklanir: sozlesme KODA bakar, aciklamaya degil.
  const code = module
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  // Aday yuklemi YALNIZ mevcut acik kayitlari OKUR; insert/upsert YOKTUR.
  assert.ok(code.includes('.select('))
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'persistSyncResult']) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
  // Bagli oldugu boot yolu KAPALI varsayilanla gelir.
  assert.ok(module.includes("raw === 'true' || raw === '1'"))

  // index.mjs tarafinda stale gecisi YALNIZ aday orderNumber'lari icin sorgu
  // yapar; aday listesi DB'den gelir, dolayisiyla YENI siparis KESFETMEZ.
  const lines = ENTRY_SOURCE.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    line.startsWith('async function reconcileStaleOpenForOrganization'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('findStaleOpenCandidates('))
  assert.ok(body.includes('orderNumber: candidate.orderNumber'))
})

// ═══ TANI SALT OKUNUR ═════════════════════════════════════════════════════

test('MALFORMED-9: tani CLI hicbir yazma yapmaz', () => {
  const cli = readFileSync('server/orders/malformedOrderAuditCli.ts', 'utf8')
  const code = cli
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  for (const forbidden of [
    '.update(',
    '.insert(',
    '.delete(',
    'persistSyncResult',
    'callTrendyol',
    'surat',
    'zpl',
  ]) {
    assert.equal(
      code.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      forbidden,
    )
  }
  assert.ok(code.includes('.select('))
  // PII alanlari raporlanmaz.
  for (const forbidden of [
    'customerFirstName:',
    'shippingAddressEncrypted',
    'customerPhone',
  ]) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
})

test('MALFORMED-10: tani gercek DB satirlarini dogru ayirir', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await db.insert(orders).values([
    {
      organizationId,
      marketplaceAccountId: accountId,
      marketplace: 'Trendyol',
      packageId: '0',
      orderNumber: '0',
      marketplaceStatus: null,
      operationStatus: null,
      orderDate: new Date('2026-08-11T09:00:00.000Z'),
    },
    {
      organizationId,
      marketplaceAccountId: accountId,
      marketplace: 'Trendyol',
      packageId: '4065907241',
      orderNumber: '11493372619',
      marketplaceStatus: 'Shipped',
      operationStatus: 'LABEL_PRINTED',
      orderDate: new Date('2026-08-01T09:00:00.000Z'),
    },
  ])
  const rows = await db
    .select({
      packageId: orders.packageId,
      orderNumber: orders.orderNumber,
      marketplace: orders.marketplace,
      marketplaceStatus: orders.marketplaceStatus,
      marketplaceAccountId: orders.marketplaceAccountId,
    })
    .from(orders)
  const malformed = rows.filter((row) => audit.isMalformedIdentity(row))
  assert.equal(malformed.length, 1)
  assert.equal(malformed[0].orderNumber, '0')
})

test('MALFORMED-11: mevcut kanonik akislar DEGISMEDI', () => {
  // Bu tur URETIM DAVRANISI DEGISTIRMEDI: engel/temizlik EKLENMEDI.
  assert.ok(ENTRY_SOURCE.includes('resolveActiveMarketplaceAccountId('))
  assert.ok(ENTRY_SOURCE.includes('incomingIsNewer'))
  assert.ok(ENTRY_SOURCE.includes('startStaleOpenReconcileOnBoot'))
  // upsert zinciri hala TEK yazar.
  assert.ok(typeof repo.upsertMarketplaceOrders === 'function')
  // Normalize on-filtresi HENUZ degistirilmedi (fail-closed kural YOK).
  assert.ok(ENTRY_SOURCE.includes('function isTrendyolOrderPackage'))
  assert.equal(ENTRY_SOURCE.includes('isRealIdentity'), false)
})
