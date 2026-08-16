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

// KALICI AUGMENTED BASKI ZPL'İ (printZpl).
//
// Sözleşme:
//  - technicalZpl kutsal kaynaktır; üzerine YAZILMAZ.
//  - printZpl mevcut ŞİFRELİ shipments.carrier_payload_encrypted içinde
//    saklanır (yeni kolon / migration YOK).
//  - Kalıcı kayıt varsa metadata resolver ÇALIŞMAZ, katalog OKUNMAZ.
//  - Legacy kayıt compare-and-set ile YALNIZ BİR KEZ hydrate edilir.
//  - Kaynak SHA uyuşmazlığında sessiz kullanım/üzerine yazma YOK.
//
// Fixture'lar SENTETİKTİR: gerçek müşteri verisi, adres, telefon veya gerçek
// provider ZPL'i İÇERMEZ.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const repo = await import('./shipments/printZplRepository.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')

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

// SENTETİK resmî Sürat şablonu.
const OFFICIAL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO60,20^A0N,28,28^FDSube: FERAH^FS',
  '^FO470,20^A0N,26,26^FDT.No: 21012920014311^FS',
  '^FO60,150^BY3^BCN,150,Y,N,N^FD01254596670^FS',
  '^FO60,345^A0N,24,24^FDALICI AD^FS',
  '^FO60,375^A0N,18,18^FB700,3,0,L,0^FDMAHALLE SOKAK NO ILCE IL^FS',
  '^FO60,480^A0N,20,20^FDOdemeTipi  Birim   Top Ds/Kg^FS',
  '^FO60,510^A0N,30,30^FDPOCH   KOLI     2,00^FS',
  '^FO60,560^BXN,6,200^FD7270035184060553^FS',
  '^FO240,630^A0N,34,34^FDKARACADAG/04^FS',
  '^FO240,672^A0N,38,38^FDDIYARBAKIR AKTARMA^FS',
  '^FO660,560^BQN,2,6^FDLA,01254596670^FS',
  '^FWB', '^FO24,340^A0N,18,18^FDSiparis No: 7270035184060553^FS', '^FWN',
  '^PQ1,0,1,Y',
  '^XZ',
].join('\n')

const KEY = (organizationId) => ({
  organizationId,
  marketplace: 'Trendyol',
  packageId: 'PKG-1',
  provider: 'surat-kargo',
})

const ITEMS = [
  {
    productName: 'Önü Drapeli Loş Tesettür Takım',
    quantity: 1,
    color: 'Krem',
    size: '40',
    sku: '6496',
  },
]
const NOW = '2026-08-05T10:00:00.000Z'

async function seedShipment(db, organizationId, payload) {
  await db.insert(schema.shipments).values({
    organizationId,
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: '7270035184060553',
    provider: 'surat-kargo',
    source: 'local_create',
    status: 'created',
    trackingNumber: '21012920014311',
    barcode: '01254596670',
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(payload),
  })
}

async function readPayload(db, organizationId) {
  const [row] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  return encryption.decryptShipmentPayload(row.carrierPayloadEncrypted)
}

// ═══ YENİ SHIPMENT / ARTIFACT ══════════════════════════════════════════════

test('PZ-1..PZ-7: artifact üretimi — alanlar, SHA ve uzunluk doğru', async () => {
  const { sha256Hex } = await load('/src/utils/augmentedSuratZpl.ts')
  const { artifact, augmentationStatus } = repo.buildPrintZplArtifact(
    OFFICIAL,
    ITEMS,
    NOW,
  )
  assert.equal(augmentationStatus, 'augmented')
  assert.equal(artifact.printZplVersion, 'surat-product-line-v1')
  assert.equal(artifact.printZplCreatedAt, NOW)
  assert.ok(artifact.printZplFooterProfile)
  assert.ok(artifact.templateFingerprint)
  // 5) source SHA kaynağın SHA'sı
  assert.equal(artifact.printZplSourceSha256, sha256Hex(OFFICIAL))
  // 6) print SHA doğru
  assert.equal(artifact.printZplSha256, sha256Hex(artifact.printZpl))
  // 7) uzunluk doğru
  assert.equal(artifact.printZplLength, artifact.printZpl.length)
  // Ürün satırı gerçekten var.
  assert.ok(artifact.printZpl.includes('(Renk: Krem, Beden: 40) [6496]'))
})

test('PZ-2/PZ-3/PZ-8/PZ-9: create payload\'ında printZpl saklanır, technicalZpl DEĞİŞMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'pz-2')
  const { sha256Hex } = await load('/src/utils/augmentedSuratZpl.ts')
  const carrierPayload = {
    technicalZpl: OFFICIAL,
    technicalZplSha256: sha256Hex(OFFICIAL),
    technicalZplLength: OFFICIAL.length,
    shipment: { lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE' },
  }
  const withArtifact = repo.attachPrintZplArtifact(carrierPayload, ITEMS, NOW)
  await seedShipment(db, org, withArtifact)

  const stored = await readPayload(db, org)
  // 3) şifreli payload içinde saklanır
  assert.ok(stored.printZplArtifact, 'printZplArtifact payload içinde')
  // 4) createdAt yazılır
  assert.equal(stored.printZplArtifact.printZplCreatedAt, NOW)
  // 8/9) technicalZpl ve SHA'sı DEĞİŞMEZ
  assert.equal(stored.technicalZpl, OFFICIAL)
  assert.equal(stored.technicalZplSha256, sha256Hex(OFFICIAL))
  assert.equal(stored.technicalZplLength, OFFICIAL.length)
  // Kaynak, türetilmiş çıktıyla EZİLMEMİŞ.
  assert.notEqual(stored.technicalZpl, stored.printZplArtifact.printZpl)
})

// ═══ LEGACY HYDRATION + CONCURRENCY ════════════════════════════════════════

test('LG-1/LG-2: legacy kayıt ilk kullanımda hydrate edilir, provider çağrısı YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'lg-1')
  await seedShipment(db, org, { technicalZpl: OFFICIAL })

  const model = await repo.resolvePersistedPrintableLabel(db, KEY(org), {
    items: ITEMS,
    now: NOW,
  })
  assert.equal(model.hydrated, true)
  assert.equal(model.augmentationStatus, 'augmented')
  assert.ok(model.printZpl.includes('[6496]'))
  // Kalıcı hale geldi.
  const stored = await readPayload(db, org)
  assert.equal(stored.printZplArtifact.printZplSha256, model.printZplSha256)
  // Kaynak korunur.
  assert.equal(stored.technicalZpl, OFFICIAL)
  // Repository provider/HTTP çağrısı İÇERMEZ.
  const src = readFileSync(join(here, 'shipments', 'printZplRepository.ts'), 'utf8')
  assert.equal(/fetch\(|https?:\/\/|soap/i.test(src), false)
})

test('LG-5/LG-6/LG-7: eşzamanlı hydration TEK kalıcı sonuç üretir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'lg-5')
  await seedShipment(db, org, { technicalZpl: OFFICIAL })

  const [a, b, c] = await Promise.all([
    repo.resolvePersistedPrintableLabel(db, KEY(org), { items: ITEMS, now: NOW }),
    repo.resolvePersistedPrintableLabel(db, KEY(org), { items: ITEMS, now: NOW }),
    repo.resolvePersistedPrintableLabel(db, KEY(org), { items: ITEMS, now: NOW }),
  ])
  // Hepsi AYNI kalıcı sonucu döner.
  assert.equal(a.printZplSha256, b.printZplSha256)
  assert.equal(b.printZplSha256, c.printZplSha256)
  assert.equal(a.printZpl, c.printZpl)
  // Yalnız BİRİ yazmış olmalı.
  assert.equal([a, b, c].filter((m) => m.hydrated).length, 1)
  const stored = await readPayload(db, org)
  assert.equal(stored.printZplArtifact.printZplSha256, a.printZplSha256)
  // Tekrar çağrı idempotent: artık hiç hydrate etmez.
  const again = await repo.resolvePersistedPrintableLabel(db, KEY(org), {
    items: ITEMS,
    now: '2027-01-01T00:00:00.000Z',
  })
  assert.equal(again.hydrated, false)
  assert.equal(again.printZplSha256, a.printZplSha256)
  assert.equal(again.printZplCreatedAt, NOW, 'createdAt değişmez')
})

test('LG-3/LG-4: hydration tenant-scoped; başka organizasyon erişemez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const a = await makeOrg(db, 'lg-3-a')
  const b = await makeOrg(db, 'lg-3-b')
  await seedShipment(db, a, { technicalZpl: OFFICIAL })
  const mine = await repo.resolvePersistedPrintableLabel(db, KEY(a), {
    items: ITEMS,
    now: NOW,
  })
  assert.ok(mine.printZpl)
  await assert.rejects(
    () => repo.resolvePersistedPrintableLabel(db, KEY(b), { items: ITEMS, now: NOW }),
    /kayıtlı resmî kargo etiketi/,
  )
  // B'nin çağrısı A'nın kaydını DEĞİŞTİRMEZ.
  const stored = await readPayload(db, a)
  assert.equal(stored.printZplArtifact.printZplSha256, mine.printZplSha256)
})

test('LG-8/LG-9: eksik payload ve technicalZpl yokluğunda AÇIK hata', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'lg-8')
  await seedShipment(db, org, { shipment: { lifecycleStatus: 'X' } })
  await assert.rejects(
    () => repo.resolvePersistedPrintableLabel(db, KEY(org), { items: ITEMS, now: NOW }),
    /kayıtlı resmî kargo etiketi/,
  )
})

test('LG-10 / PZ-SHA: kaynak SHA uyuşmazlığında AÇIK hata, sessiz kullanım YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'lg-10')
  const { artifact } = repo.buildPrintZplArtifact(OFFICIAL, ITEMS, NOW)
  // Kaynak DEĞİŞMİŞ (farklı T.No) ama eski artifact duruyor.
  const drifted = OFFICIAL.replace('21012920014311', '21012920099999')
  await seedShipment(db, org, {
    technicalZpl: drifted,
    printZplArtifact: artifact,
  })
  await assert.rejects(
    () => repo.resolvePersistedPrintableLabel(db, KEY(org), { items: ITEMS, now: NOW }),
    /kayıtlı kaynak ZPL ile eşleşmiyor/,
  )
  // Otomatik ÜZERİNE YAZMA yok: eski artifact aynen duruyor.
  const stored = await readPayload(db, org)
  assert.equal(stored.printZplArtifact.printZplSha256, artifact.printZplSha256)
  assert.equal(stored.technicalZpl, drifted, 'kaynak da değiştirilmedi')

  // Bozuk hash / uzunluk da reddedilir.
  const { sha256Hex } = await load('/src/utils/augmentedSuratZpl.ts')
  const good = sha256Hex(OFFICIAL)
  assert.equal(
    repo.verifyPersistedPrintZpl({ ...artifact, printZplSha256: 'bozuk' }, good).ok,
    false,
  )
  assert.equal(
    repo.verifyPersistedPrintZpl({ ...artifact, printZplLength: 1 }, good).ok,
    false,
  )
  assert.equal(repo.verifyPersistedPrintZpl(artifact, good).ok, true)
})

// ═══ REPRINT IMMUTABILITY ══════════════════════════════════════════════════

test('RP-1..RP-8: kalıcı kayıt varken katalog/satır değişimi çıktıyı DEĞİŞTİRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rp-1')
  await seedShipment(db, org, { technicalZpl: OFFICIAL })

  const first = await repo.resolvePersistedPrintableLabel(db, KEY(org), {
    items: ITEMS,
    now: NOW,
  })
  assert.equal(first.hydrated, true)

  // Sonradan HER ŞEY değişse bile (renk, beden, SKU, ürün adı) reprint AYNI.
  const mutated = [
    {
      productName: 'TAMAMEN FARKLI ÜRÜN',
      quantity: 9,
      color: 'Siyah',
      size: '99',
      sku: 'YENI-SKU',
    },
  ]
  const reprint = await repo.resolvePersistedPrintableLabel(db, KEY(org), {
    items: mutated,
    now: '2027-05-05T00:00:00.000Z',
  })
  assert.equal(reprint.hydrated, false, 'yeniden üretim YOK')
  assert.equal(reprint.printZpl, first.printZpl, 'byte-for-byte aynı')
  assert.equal(reprint.printZplSha256, first.printZplSha256)
  assert.equal(reprint.printZplCreatedAt, first.printZplCreatedAt)
  assert.ok(reprint.printZpl.includes('[6496]'), 'eski metadata korunur')
  assert.equal(reprint.printZpl.includes('YENI-SKU'), false)
  // Kaynak ve T.No/barkod dokunulmamış.
  assert.equal(reprint.sourceZpl, OFFICIAL)
  assert.ok(reprint.sourceZpl.includes('T.No: 21012920014311'))
  assert.ok(reprint.sourceZpl.includes('01254596670'))
})

test('RP-9..RP-11: preview/download/native AYNI persisted SHA\'yı kullanır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'rp-9')
  await seedShipment(db, org, { technicalZpl: OFFICIAL })
  const hydrate = await repo.resolvePersistedPrintableLabel(db, KEY(org), {
    items: ITEMS,
    now: NOW,
  })
  // Dört ayrı "yüzey" çağrısı — hepsi TEK resolver'dan geçer.
  const surfaces = await Promise.all(
    ['preview', 'download', 'native', 'reprint'].map(() =>
      repo.resolvePersistedPrintableLabel(db, KEY(org), { items: ITEMS, now: NOW }),
    ),
  )
  for (const surface of surfaces) {
    assert.equal(surface.printZplSha256, hydrate.printZplSha256)
    assert.equal(surface.printZpl, hydrate.printZpl)
    assert.equal(surface.renderMode, 'raw-zpl')
  }
})

// ═══ GÜVENLİK / MIGRATION ══════════════════════════════════════════════════

test('PZ-14: migration veya yeni kolon EKLENMEZ', () => {
  const files = readdirSync(join(here, '..', 'drizzle')).filter((f) =>
    f.endsWith('.sql'),
  )
  const sql = files
    .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'))
    .join('\n')
  assert.equal(/print_zpl|printZpl/i.test(sql), false)
})

test('PZ-LOG: raw ZPL ve PII loglanmaz', () => {
  const src = readFileSync(join(here, 'shipments', 'printZplRepository.ts'), 'utf8')
  assert.equal(/console\.(log|info|warn|error)/.test(src), false)
  for (const field of ['customerName', 'customerPhone', 'address', 'apiKey', 'sifre']) {
    assert.equal(src.includes(field), false, field)
  }
  // Hata mesajları ham ZPL taşımaz.
  assert.equal(repo.PRINT_ZPL_SOURCE_MISMATCH_MESSAGE.includes('^XA'), false)
  assert.equal(repo.PRINT_ZPL_SOURCE_MISSING_MESSAGE.includes('^XA'), false)
})

// ═══ GERÇEK AKIŞ BAĞLANTISI ════════════════════════════════════════════════
//
// Bu bölüm persistence katmanının GERÇEK create ve okuma yollarına bağlı
// olduğunu davranışsal olarak doğrular (yalnız kaynak-string testi değil).

const orderService = await import('./orders/orderPersistenceService.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')

async function seedOrderWithLines(db, organizationId, lines) {
  const [order] = await db
    .insert(schema.orders)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      packageId: 'PKG-1',
      orderNumber: '7270035184060553',
      operationStatus: 'LABEL_READY',
      orderDate: new Date('2026-08-01T00:00:00.000Z'),
    })
    .returning()
  for (const [index, line] of lines.entries()) {
    await db.insert(schema.orderLines).values({
      organizationId,
      orderId: order.id,
      externalLineId: `L-${index}`,
      productName: line.productName,
      barcode: line.barcode ?? null,
      merchantSku: line.merchantSku ?? null,
      quantity: line.quantity ?? 1,
      variantAttributes: line.variantAttributes ?? [],
    })
  }
  return order
}

async function seedCatalogVariant(db, organizationId, variant) {
  const [product] = await db
    .insert(schema.products)
    .values({
      organizationId,
      marketplace: 'Trendyol',
      externalProductId: `EP-${variant.barcode}`,
      title: 'Sentetik Ürün',
    })
    .returning()
  await db.insert(schema.productVariants).values({
    organizationId,
    productId: product.id,
    externalVariantId: `EV-${variant.barcode}`,
    barcode: variant.barcode ?? null,
    merchantSku: variant.merchantSku ?? null,
    stockCode: variant.stockCode ?? null,
    color: variant.color ?? null,
    size: variant.size ?? null,
  })
}

test('WIRE-1: create zinciri printZplArtifact’i AYNI yazımda persist eder', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wire-1')
  await seedOrderWithLines(db, org, [
    {
      productName: 'Önü Drapeli Loş Tesettür Takım',
      barcode: 'BC-77',
      merchantSku: '6496',
      quantity: 1,
      variantAttributes: [{ name: 'Beden', value: '40' }],
    },
  ])
  // Katalogda renk var (sipariş satırında YOK) → footer'a gelmeli.
  await seedCatalogVariant(db, org, { barcode: 'BC-77', color: 'Krem', size: '40' })

  await shipmentService.writeOperationRecord(db, org, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: '7270035184060553',
    provider: 'surat-kargo',
    status: 'succeeded',
    technicalZpl: OFFICIAL,
    carrierTrackingNumber: '21012920014311',
    carrierBarcodeNumber: '01254596670',
    shipment: {
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      barkodNo: '01254596670',
    },
  })

  const stored = await readPayload(db, org)
  assert.ok(stored.printZplArtifact, 'artifact create sırasında persist edildi')
  // technicalZpl AYNEN korunur
  assert.equal(stored.technicalZpl, OFFICIAL)
  // katalog rengi footer'a ulaştı
  assert.ok(
    stored.printZplArtifact.printZpl.includes('(Renk: Krem, Beden: 40) [6496]'),
    'katalog zenginleştirmesi create sırasında uygulandı',
  )
  assert.equal(stored.printZplArtifact.printZplVersion, 'surat-product-line-v1')
  assert.ok(stored.printZplArtifact.printZplCreatedAt)
})

test('WIRE-2: create tekrarı ikinci provider çağrısı yapmaz, aynı SHA kalır', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wire-2')
  await seedOrderWithLines(db, org, [
    { productName: 'Ürün', barcode: 'BC-1', merchantSku: '6496', quantity: 1 },
  ])
  const record = {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: '7270035184060553',
    provider: 'surat-kargo',
    status: 'succeeded',
    technicalZpl: OFFICIAL,
    shipment: { lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE' },
  }
  await shipmentService.writeOperationRecord(db, org, record)
  const first = (await readPayload(db, org)).printZplArtifact.printZplSha256
  await shipmentService.writeOperationRecord(db, org, record)
  const second = (await readPayload(db, org)).printZplArtifact.printZplSha256
  assert.equal(second, first, 'idempotent: aynı SHA')
  // Persistence servisi provider çağrısı içermez.
  const src = readFileSync(
    join(here, 'shipments', 'shipmentPersistenceService.ts'),
    'utf8',
  )
  assert.equal(/fetch\(|SOAPAction/i.test(src), false)
})

test('WIRE-3: create satır/katalog okunamazsa akış BOZULMAZ (legacy yola düşer)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wire-3')
  // Sipariş satırı YOK → artifact üretilmez ama shipment yazılır.
  await shipmentService.writeOperationRecord(db, org, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: '7270035184060553',
    provider: 'surat-kargo',
    status: 'succeeded',
    technicalZpl: OFFICIAL,
    shipment: { lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE' },
  })
  const stored = await readPayload(db, org)
  assert.equal(stored.printZplArtifact, undefined, 'artifact yok')
  assert.equal(stored.technicalZpl, OFFICIAL, 'kaynak korunur')
})

test('WIRE-4: label servisi persisted printZpl döndürür (katalog zenginleştirmeli)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wire-4')
  const order = await seedOrderWithLines(db, org, [
    {
      productName: 'Önü Drapeli Loş Tesettür Takım',
      barcode: 'BC-77',
      merchantSku: '6496',
      quantity: 1,
      variantAttributes: [{ name: 'Beden', value: '40' }],
    },
  ])
  await seedCatalogVariant(db, org, { barcode: 'BC-77', color: 'Krem', size: '40' })
  // GERÇEK create yolu: artifact aynı yazımda persist edilir.
  await shipmentService.writeOperationRecord(db, org, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: '7270035184060553',
    provider: 'surat-kargo',
    status: 'succeeded',
    technicalZpl: OFFICIAL,
    carrierTrackingNumber: '21012920014311',
    carrierBarcodeNumber: '01254596670',
    shipment: {
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      barcodeRaw: OFFICIAL,
      barkodNo: '01254596670',
    },
  })

  const result = await orderService.resolvePersistedLabel(db, org, order.id)
  assert.equal(result.found, true)
  // Dönen ZPL ürün satırı TAŞIR ve katalog rengi uygulanmış.
  assert.ok(result.zpl.includes('(Renk: Krem, Beden: 40) [6496]'))
  assert.equal(result.source, 'shipment.printZplArtifact')
  // Güvenli DTO özeti döner (ham payload YOK).
  assert.equal(result.print.printZplVersion, 'surat-product-line-v1')
  assert.equal(result.print.renderMode, 'raw-zpl')
  assert.equal(result.print.augmentationStatus, 'augmented')
  // Kalıcı hale geldi.
  const stored = await readPayload(db, org)
  assert.equal(stored.printZplArtifact.printZplSha256, result.print.printZplSha256)
  assert.equal(stored.technicalZpl, OFFICIAL, 'kaynak korunur')
})

test('WIRE-5: reprint katalog/satır değişiminden ETKİLENMEZ (persisted byte)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wire-5')
  const order = await seedOrderWithLines(db, org, [
    { productName: 'İlk Ürün', barcode: 'BC-77', merchantSku: '6496', quantity: 1 },
  ])
  await seedCatalogVariant(db, org, { barcode: 'BC-77', color: 'Krem', size: '40' })
  await shipmentService.writeOperationRecord(db, org, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: '7270035184060553',
    provider: 'surat-kargo',
    status: 'succeeded',
    technicalZpl: OFFICIAL,
    carrierTrackingNumber: '21012920014311',
    carrierBarcodeNumber: '01254596670',
    shipment: {
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      barcodeRaw: OFFICIAL,
      barkodNo: '01254596670',
    },
  })

  const first = await orderService.resolvePersistedLabel(db, org, order.id)
  const firstSha = first.print.printZplSha256

  // Sonradan katalog VE sipariş satırı değişir.
  await db
    .update(schema.productVariants)
    .set({ color: 'Siyah', size: '99' })
    .where(eq(schema.productVariants.organizationId, org))
  await db
    .update(schema.orderLines)
    .set({ productName: 'TAMAMEN FARKLI', merchantSku: 'YENI-SKU' })
    .where(eq(schema.orderLines.organizationId, org))

  const reprint = await orderService.resolvePersistedLabel(db, org, order.id)
  assert.equal(reprint.print.printZplSha256, firstSha, 'SHA değişmez')
  assert.equal(reprint.zpl, first.zpl, 'byte-for-byte aynı')
  assert.ok(reprint.zpl.includes('İlk Ürün'), 'eski metadata korunur')
  assert.equal(reprint.zpl.includes('YENI-SKU'), false)
  assert.equal(reprint.zpl.includes('Siyah'), false)
})

test('WIRE-6: preview/download/native AYNI persisted SHA — tek okuma servisi', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'wire-6')
  const order = await seedOrderWithLines(db, org, [
    { productName: 'Ürün', barcode: 'BC-77', merchantSku: '6496', quantity: 1 },
  ])
  await shipmentService.writeOperationRecord(db, org, {
    organizationId: org,
    marketplace: 'Trendyol',
    packageId: 'PKG-1',
    orderNumber: '7270035184060553',
    provider: 'surat-kargo',
    status: 'succeeded',
    technicalZpl: OFFICIAL,
    carrierTrackingNumber: '21012920014311',
    carrierBarcodeNumber: '01254596670',
    shipment: {
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      barcodeRaw: OFFICIAL,
      barkodNo: '01254596670',
    },
  })
  const surfaces = await Promise.all([
    orderService.resolvePersistedLabel(db, org, order.id),
    orderService.resolvePersistedLabel(db, org, order.id),
    orderService.resolvePersistedLabel(db, org, order.id),
  ])
  const sha = surfaces[0].print.printZplSha256
  for (const surface of surfaces) {
    assert.equal(surface.print.printZplSha256, sha)
    assert.equal(surface.zpl, surfaces[0].zpl)
  }
  // Kalıcı kayıt TEK.
  const stored = await readPayload(db, org)
  assert.equal(stored.printZplArtifact.printZplSha256, sha)
})
