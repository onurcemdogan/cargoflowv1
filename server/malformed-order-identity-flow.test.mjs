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

test('MALFORMED-5: on-filtre paket kimligi olmayan kaydi ELER', () => {
  // Gecerli `id` varsa kayit gecerlidir (orderNumber=0 olmasi ONEMLI DEGIL:
  // paket kimligi ayri bir alandir).
  const partial = {
    id: 12345,
    orderNumber: 0,
    customerFirstName: 'X',
    lines: [],
  }
  assert.equal(audit.passesTrendyolPackagePredicate(partial), true)
  // URETIM VAKASI: paket kimliginin UCU DE yer tutucu → ELENIR.
  assert.equal(
    audit.passesTrendyolPackagePredicate({ ...partial, id: 0 }),
    false,
  )
  assert.equal(
    audit.passesTrendyolPackagePredicate({ ...partial, id: undefined, packageId: 0 }),
    false,
  )
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
  assert.ok(ENTRY_SOURCE.includes('resolveActiveMarketplaceAccountId('))
  assert.ok(ENTRY_SOURCE.includes('incomingIsNewer'))
  assert.ok(ENTRY_SOURCE.includes('startStaleOpenReconcileOnBoot'))
  // upsert zinciri hala TEK yazar.
  assert.ok(typeof repo.upsertMarketplaceOrders === 'function')
  // Guard YALNIZ normalize on-filtresine eklendi; temizlik/DB mutasyonu YOK.
  assert.ok(ENTRY_SOURCE.includes('function resolveTrendyolPackageIdentity'))
  for (const forbidden of ['delete(orders)', 'PACKAGE_CLEANUP', 'repairPackageId']) {
    assert.equal(ENTRY_SOURCE.includes(forbidden), false, forbidden)
  }
})

// ═══ MINIMUM PAKET KIMLIGI SOZLESMESI ═════════════════════════════════════
//
// URETIM VAKASI (PII YOK): packageId "0" · orderNumber 11496311967
//   marketplaceStatus "Unknown" · operationStatus "NEW" (INSERT imzasi)
//
// KOK NEDEN: kimlik `String(item.packageId ?? item.shipmentPackageId ??
// item.id ?? '')` ile cozulur; `??` YALNIZ null/undefined'a duser, sayisal 0
// GECERLI kimlik sayilip '0' olur. Gecerli bir orderNumber bu boslugu
// KAPATAMAZ — orderNumber SIPARIS kimligidir, PAKET kimligi degildir.
//
// GUARD: kanonik paket kimligi yer tutucu olan item normalize on-filtresinde
// ELENIR → persist edilmez, mevcut kaydi de EZEMEZ (upsert'e hic ulasmaz).

/** `isTrendyolOrderPackage` + yardimcilarini index.mjs'ten izole calistirir. */
function loadNormalizePredicate() {
  const lines = ENTRY_SOURCE.split(/\r?\n/)
  const names = [
    'const PLACEHOLDER_PACKAGE_IDENTITIES',
    'function isPlaceholderPackageIdentity',
    'function resolveTrendyolPackageIdentity',
    'function isTrendyolOrderPackage',
  ]
  const blocks = names.map((needle) => {
    const start = lines.findIndex((line) => line.startsWith(needle))
    assert.ok(start >= 0, `bulunamadi: ${needle}`)
    const closer = needle.startsWith('const') ? '])' : '}'
    const end = lines.findIndex((line, index) => index > start && line === closer)
    return lines.slice(start, end + 1).join('\n')
  })
  return new Function(
    `${blocks.join('\n\n')}\nreturn { isTrendyolOrderPackage, resolveTrendyolPackageIdentity }`,
  )()
}

const { isTrendyolOrderPackage, resolveTrendyolPackageIdentity } =
  loadNormalizePredicate()

const VALID_ORDER_NUMBER = '11496311967'
const pkg = (overrides = {}) => ({
  orderNumber: VALID_ORDER_NUMBER,
  customerFirstName: 'T',
  customerLastName: 'M',
  shipmentAddress: { city: 'Istanbul' },
  lines: [],
  ...overrides,
})

test('MALFORMED-PACKAGE-1: raw packageId=0 → persist YOK', () => {
  assert.equal(isTrendyolOrderPackage(pkg({ packageId: 0 })), false)
  assert.equal(isTrendyolOrderPackage(pkg({ packageId: '0' })), false)
})

test('MALFORMED-PACKAGE-2: raw shipmentPackageId=0 → persist YOK', () => {
  assert.equal(isTrendyolOrderPackage(pkg({ shipmentPackageId: 0 })), false)
  assert.equal(
    isTrendyolOrderPackage(pkg({ packageId: null, shipmentPackageId: '0' })),
    false,
  )
})

test('MALFORMED-PACKAGE-3: raw id=0 ve baska kimlik yok → persist YOK', () => {
  assert.equal(isTrendyolOrderPackage(pkg({ id: 0 })), false)
  assert.equal(
    isTrendyolOrderPackage(
      pkg({ packageId: '', shipmentPackageId: null, id: 0 }),
    ),
    false,
  )
  // Hicbir kimlik alani yoksa da elenir.
  assert.equal(isTrendyolOrderPackage(pkg()), false)
})

test('MALFORMED-PACKAGE-4: gecerli orderNumber paket kimligi YERINE GECMEZ', () => {
  // URETIM VAKASI: orderNumber gecerli, packageId 0.
  const item = pkg({ packageId: 0, status: undefined })
  assert.equal(resolveTrendyolPackageIdentity(item), '')
  assert.equal(isTrendyolOrderPackage(item), false, 'orderNumber KURTARMAZ')
})

test('MALFORMED-PACKAGE-5: gecerli packageId + orderNumber → normal persist', () => {
  assert.equal(isTrendyolOrderPackage(pkg({ packageId: 4065907241 })), true)
  assert.equal(isTrendyolOrderPackage(pkg({ packageId: '4065907241' })), true)
  assert.equal(
    resolveTrendyolPackageIdentity(pkg({ packageId: 4065907241 })),
    '4065907241',
  )
  // Yalniz shipmentPackageId varsa da gecerlidir.
  assert.equal(
    isTrendyolOrderPackage(pkg({ shipmentPackageId: '4065907241' })),
    true,
  )
  // Yalniz id varsa da gecerlidir (kanonik cozum sirasi).
  assert.equal(isTrendyolOrderPackage(pkg({ id: 4065907241 })), true)
})

test('MALFORMED-PACKAGE-6: parcali yuk mevcut kaydi EZEMEZ', async () => {
  const { db, organizationId, accountId } = await makeDb()
  await db.insert(orders).values({
    organizationId,
    marketplaceAccountId: accountId,
    marketplace: 'Trendyol',
    packageId: '4065907241',
    orderNumber: VALID_ORDER_NUMBER,
    marketplaceStatus: 'Shipped',
    operationStatus: 'LABEL_PRINTED',
    orderDate: new Date('2026-08-01T09:00:00.000Z'),
  })
  // Kimliksiz item on-filtrede elendigi icin upsert'e HIC ulasmaz.
  const incoming = [pkg({ packageId: 0, status: undefined })].filter(
    isTrendyolOrderPackage,
  )
  assert.equal(incoming.length, 0)
  const result = await repo.upsertMarketplaceOrders(
    db,
    organizationId,
    incoming,
    accountId,
  )
  assert.equal(result.persisted, 0)

  const rows = await db
    .select({
      packageId: orders.packageId,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
    })
    .from(orders)
  assert.equal(rows.length, 1, 'yeni satir OLUSMAZ')
  assert.equal(rows[0].packageId, '4065907241')
  assert.equal(rows[0].marketplaceStatus, 'Shipped', 'Unknown ile EZILMEZ')
  assert.equal(rows[0].operationStatus, 'LABEL_PRINTED')
})

test('MALFORMED-PACKAGE-7: mevcut kanonik akislar KORUNUR', () => {
  // Musteri/adres sarti ve satir kurali DEGISMEDI.
  assert.equal(
    isTrendyolOrderPackage({ packageId: '4065907241', barcode: 'b' }),
    false,
    'musteri/adres yoksa siparis DEGIL',
  )
  // Arka plan senkronu, stale mutabakat ve freshness fix yerinde.
  assert.ok(ENTRY_SOURCE.includes('resolveActiveMarketplaceAccountId('))
  assert.ok(ENTRY_SOURCE.includes('startStaleOpenReconcileOnBoot'))
  assert.ok(ENTRY_SOURCE.includes('incomingIsNewer'))
  // Statu esleme zinciri DEGISMEDI.
  assert.ok(
    ENTRY_SOURCE.includes('const marketplaceStatus = normalizeStatus(item.status)'),
  )
})

// ═══ SIFRE COZME TANISI ═══════════════════════════════════════════════════

test('MALFORMED-DECRYPT-1: anahtar KAYNAGI adiyla raporlanir (deger YOK)', () => {
  const key = randomBytes(32).toString('hex')
  assert.equal(
    audit.resolveOrderKeySource({ ORDER_DATA_ENCRYPTION_KEY: key }),
    'ORDER_DATA_ENCRYPTION_KEY',
  )
  assert.equal(
    audit.resolveOrderKeySource({ CREDENTIAL_ENCRYPTION_KEY: key }),
    'CREDENTIAL_ENCRYPTION_KEY',
  )
  // ORDER_DATA tercih edilir.
  assert.equal(
    audit.resolveOrderKeySource({
      ORDER_DATA_ENCRYPTION_KEY: key,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    }),
    'ORDER_DATA_ENCRYPTION_KEY',
  )
  assert.equal(audit.resolveOrderKeySource({}), 'none')
  // Gecersiz uzunluk anahtar SAYILMAZ.
  assert.equal(
    audit.resolveOrderKeySource({ ORDER_DATA_ENCRYPTION_KEY: 'kisa' }),
    'none',
  )
})

test('MALFORMED-DECRYPT-2: YANLIS anahtar auth_tag_mismatch verir', async () => {
  const encryption = await import('./orders/orderEncryption.ts')
  const original = process.env.ORDER_DATA_ENCRYPTION_KEY
  const previousCredential = process.env.CREDENTIAL_ENCRYPTION_KEY
  try {
    process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    const payload = encryption.encryptOrderPayload({ packageId: 0, id: 7 })
    // Kayit A anahtariyla yazildi; simdi B anahtariyla cozulmeye calisiliyor.
    process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
    let reason = null
    try {
      encryption.decryptOrderPayload(payload)
    } catch (error) {
      reason = audit.classifyDecryptError(error)
    }
    assert.equal(reason, 'auth_tag_mismatch')

    // Anahtar HIC yoksa ayri kategori.
    delete process.env.ORDER_DATA_ENCRYPTION_KEY
    delete process.env.CREDENTIAL_ENCRYPTION_KEY
    try {
      encryption.decryptOrderPayload(payload)
      assert.fail('anahtarsiz cozme basarili OLMAMALI')
    } catch (error) {
      assert.equal(audit.classifyDecryptError(error), 'missing_key')
    }
  } finally {
    process.env.ORDER_DATA_ENCRYPTION_KEY = original
    if (previousCredential) {
      process.env.CREDENTIAL_ENCRYPTION_KEY = previousCredential
    }
  }
})

test('MALFORMED-DECRYPT-3: CLI KANONIK cozucuyu kullanir', () => {
  const cli = readFileSync('server/orders/malformedOrderAuditCli.ts', 'utf8')
  assert.ok(cli.includes("from './orderEncryption.ts'"))
  assert.ok(cli.includes('decryptOrderPayload(row.rawPayloadEncrypted)'))
  // CLI'ye OZEL sifre cozme uygulamasi YOK.
  for (const forbidden of ['createDecipheriv', 'aes-256-gcm', 'setAuthTag']) {
    assert.equal(cli.includes(forbidden), false, forbidden)
  }
})
