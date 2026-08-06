import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// KANONİK SAĞLAYICI ANAHTARI — RENDER UCU REGRESYONU.
//
// CANLI HATA (master ef97574): DB'de provider='surat', payload'da hem
// technicalZpl hem printZplArtifact varken uç şu hatayı döndürüyordu:
// "Bu gönderi için kayıtlı resmî kargo etiketi (ZPL) bulunamadı."
//
// KÖK NEDEN: printZplRepository.loadRow provider'ı EXACT eq ile sorgular.
// suratLabelRenderService ise anahtar olarak GÖRÜNEN değeri geçiriyordu:
//   shipment.provider ?? order.cargoProviderName ?? 'surat-kargo'
// orderPersistenceService.buildShipmentViewFromPayload sipariş görünümünde
// `provider`i SABİT 'surat-kargo' olarak üretir; cargoProviderName ise
// pazaryerinden 'Sürat Kargo Marketplace' gibi serbest metin gelebilir.
// Bu yüzden eq(provider,'surat-kargo') ile provider='surat' satırı ASLA
// bulunamıyordu.
//
// Testler GERÇEK PGlite + GERÇEK zebrash motoru kullanır. Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
process.env.SHIPMENT_ENCRYPTION_KEY ??= 'a'.repeat(64)
process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'b'.repeat(64)

const schema = await import('./db/schema.ts')
const encryption = await import('./shipments/shipmentEncryption.ts')
const renderService = await import('./labels/suratLabelRenderService.ts')
const { SURAT_PERSISTENCE_PROVIDER } = await import('./shipments/suratProvider.ts')
const { deriveAugmentedSuratZplWithHashes, sha256Hex } = await import(
  '../src/utils/augmentedSuratZpl.ts'
)

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

const pools = []
async function makeDb() {
  const pglite = new PGlite()
  pools.push(pglite)
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return drizzle(pglite, { schema })
}
after(async () => {
  for (const pool of pools) await pool.close()
})

// Sentetik resmî Sürat ZPL'i (gerçek müşteri verisi YOK).
const TECHNICAL_ZPL = [
  '^XA', '^CI28', '^PW799', '^LL0799', '^LS0',
  '^FO60,20^GB700,90,2^FS',
  '^FT80,50^A0N,24,24^FDSube: ORNEK^FS',
  '^FT470,50^A0N,26,26^FDT.No: 10000000000001^FS',
  '^FO90,130^BY3^BCN,130,Y,N,N^FD01200000001^FS',
  '^FO60,300^GB700,140,2^FS',
  '^FT80,330^A0N,24,24^FDSENTETIK ALICI^FS',
  '^FO90,565^BXN,5,200^FD1000000000000001^FS',
  '^FT300,650^A0N,34,34^FDORNEKSEHIR/01^FS',
  '^PQ1,0,1,Y', '^XZ',
].join('\n')

const PACKAGE_ID = '4056494300'
// Hydration ÇALIŞIRSA bu ad üretilen printZpl'e girerdi — girmemeli.
const HYDRATION_TRIPWIRE = 'HYDRATIONTRIPWIRE'

/** Canlı kayıtla AYNI şekil: technicalZpl + printZplArtifact birlikte. */
function buildPersistedPayload() {
  const derived = deriveAugmentedSuratZplWithHashes(TECHNICAL_ZPL, [])
  return {
    payload: {
      technicalZpl: TECHNICAL_ZPL,
      printZplArtifact: {
        printZpl: derived.printZpl,
        printZplLength: derived.printZpl.length,
        printZplSha256: derived.printZplSha256,
        printZplSourceSha256: sha256Hex(TECHNICAL_ZPL),
        printZplVersion: derived.printZplVersion,
        printZplFooterProfile: derived.printZplFooterProfile ?? null,
        templateFingerprint: derived.templateFingerprint,
        printZplCreatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    printZpl: derived.printZpl,
    printZplSha256: derived.printZplSha256,
  }
}

/**
 * DB satırı: provider KANONİK ('surat') — canlıdaki değer.
 * Sipariş görünümü ise ALIAS taşır.
 */
async function seed(db, over = {}) {
  const slug = over.slug ?? `org-${pools.length}-${Math.trunc(performance.now())}`
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: slug, slug })
    .returning()
  const persisted = buildPersistedPayload()
  await db.insert(schema.orders).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: PACKAGE_ID,
    orderNumber: '1000000000000001',
    orderDate: new Date('2026-01-01T00:00:00.000Z'),
    rawPayloadEncrypted: encryption.encryptShipmentPayload({
      customerName: 'SENTETIK ALICI',
    }),
    operationStatus: 'LABEL_READY',
  })
  await db.insert(schema.shipments).values({
    organizationId: org.id,
    marketplace: 'Trendyol',
    packageId: PACKAGE_ID,
    // KANONİK DB DEĞERİ — canlı kayıtla aynı.
    provider: over.dbProvider ?? SURAT_PERSISTENCE_PROVIDER,
    source: 'local_create',
    status: 'VERIFIED',
    carrierPayloadEncrypted: encryption.encryptShipmentPayload(persisted.payload),
  })
  return { organizationId: org.id, persisted }
}

/** Sipariş görünümü: provider alanı GÖRÜNEN alias'ı taşır. */
function makeGetOrder(seeded, view = {}) {
  return async (_db, organizationId, orderId) => {
    if (organizationId !== seeded.organizationId) return null
    if (orderId !== 'order-1') return null
    return {
      id: 'order-1',
      marketplace: 'Trendyol',
      packageId: PACKAGE_ID,
      ...(view.cargoProviderName !== undefined
        ? { cargoProviderName: view.cargoProviderName }
        : {}),
      shipment:
        view.shipmentProvider === null
          ? {}
          : { provider: view.shipmentProvider ?? 'surat-kargo' },
    }
  }
}

async function render(db, seeded, view = {}) {
  return renderService.renderSuratLabel({
    db,
    organizationId: seeded.organizationId,
    marketplaceAccountId: null,
    orderId: 'order-1',
    getOrder: makeGetOrder(seeded, view),
  })
}

async function readShipmentRow(db, organizationId) {
  const rows = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.organizationId, organizationId))
  return rows[0]
}

// ═══ CP-1: CANLI ŞEKİL — DB 'surat', görünüm alias ═══════════════════════

test('CP-1: DB provider=surat + görünüm alias → kayıtlı etiket BULUNUR', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const dto = await render(db, seeded, {
    cargoProviderName: 'Sürat Kargo Marketplace',
    shipmentProvider: 'surat-kargo',
  })
  assert.equal(dto.mimeType, 'image/png')
  assert.equal(dto.widthPx, 799)
  assert.equal(dto.heightPx, 799)
  const png = Buffer.from(dto.imageBase64, 'base64')
  assert.equal(png.readUInt32BE(16), 799)
  assert.equal(png.readUInt32BE(20), 799)
})

test('CP-2: printZplSha256 KALICI değerle AYNI (yeniden üretim YOK)', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const dto = await render(db, seeded, { cargoProviderName: 'Sürat Kargo' })
  assert.equal(dto.printZplSha256, seeded.persisted.printZplSha256)
})

test('CP-3: renderSha256 DETERMİNİSTİK (aynı artefakt, aynı çıktı)', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const first = await render(db, seeded, { cargoProviderName: 'Sürat' })
  const second = await render(db, seeded, { cargoProviderName: 'surat-kargo' })
  assert.equal(first.renderSha256, second.renderSha256)
  assert.equal(first.printZplSha256, second.printZplSha256)
  assert.equal(first.imageBase64, second.imageBase64)
})

test('CP-4: DB write YOK, legacy hydration ÇALIŞMAZ', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const before = await readShipmentRow(db, seeded.organizationId)
  const dto = await render(db, seeded, {
    cargoProviderName: 'Sürat Kargo Marketplace',
  })
  const after = await readShipmentRow(db, seeded.organizationId)
  // Şifreli payload BAYT BAYT aynı: ne hydration ne compare-and-set yazdı.
  assert.equal(after.carrierPayloadEncrypted, before.carrierPayloadEncrypted)
  assert.equal(
    new Date(after.updatedAt).getTime(),
    new Date(before.updatedAt).getTime(),
  )
  // technicalZpl DEĞİŞMEDİ.
  const payload = encryption.decryptShipmentPayload(after.carrierPayloadEncrypted)
  assert.equal(payload.technicalZpl, TECHNICAL_ZPL)
  assert.equal(
    payload.printZplArtifact.printZpl,
    seeded.persisted.printZpl,
    'kalıcı printZpl AYNEN korunur',
  )
  assert.equal(dto.printZplSha256, payload.printZplArtifact.printZplSha256)
})

test('CP-5: katalog/sipariş satırı OKUNMAZ (tripwire ürün adı çıktıya girmez)', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  // Kalıcı artefakt VARKEN bu satır okunursa printZpl'e ürün adı eklenir ve
  // hem sha hem içerik DEĞİŞİRDİ.
  const [orderRow] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.organizationId, seeded.organizationId))
  await db.insert(schema.orderLines).values({
    organizationId: seeded.organizationId,
    orderId: orderRow.id,
    externalLineId: 'line-1',
    productName: HYDRATION_TRIPWIRE,
    quantity: 1,
  })
  const dto = await render(db, seeded, { cargoProviderName: 'Sürat Kargo' })
  assert.equal(dto.printZplSha256, seeded.persisted.printZplSha256)
  assert.equal(
    seeded.persisted.printZpl.includes(HYDRATION_TRIPWIRE),
    false,
    'kalıcı artefakt tripwire İÇERMEZ',
  )
})

// ═══ CP-6: ALIAS REGRESYON TABLOSU ═══════════════════════════════════════

test('CP-6: TÜM görünen alias değerleri AYNI kanonik satırı bulur', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  const aliases = [
    'Sürat',
    'Sürat Kargo',
    'Sürat Kargo Marketplace',
    'surat-kargo',
    'surat',
  ]
  const shas = new Set()
  for (const alias of aliases) {
    // Hem shipment.provider hem cargoProviderName yolundan.
    const viaShipment = await render(db, seeded, { shipmentProvider: alias })
    const viaOrder = await render(db, seeded, {
      shipmentProvider: null,
      cargoProviderName: alias,
    })
    assert.equal(viaShipment.printZplSha256, seeded.persisted.printZplSha256, alias)
    assert.equal(viaOrder.printZplSha256, seeded.persisted.printZplSha256, alias)
    shas.add(viaShipment.renderSha256)
    shas.add(viaOrder.renderSha256)
  }
  assert.equal(shas.size, 1, 'alias ne olursa olsun AYNI artefakt')
  // Sağlayıcı hiç belirtilmemişse de (tek sağlayıcılı kurulum) çalışır.
  const none = await render(db, seeded, { shipmentProvider: null })
  assert.equal(none.printZplSha256, seeded.persisted.printZplSha256)
})

test('CP-7: kanonik anahtar TEK sabitten gelir ve görünüm değeri DEĞİLDİR', () => {
  assert.equal(SURAT_PERSISTENCE_PROVIDER, 'surat')
  const service = readFileSync(
    join(here, 'labels/suratLabelRenderService.ts'), 'utf8')
  // Repository anahtarı SABİT.
  assert.match(service, /provider: SURAT_PERSISTENCE_PROVIDER,/)
  // Görünen değer anahtar olarak GEÇİRİLMEZ.
  assert.equal(
    /provider: provider \|\| 'surat-kargo'/.test(service), false,
    'görünüm değeri repository anahtarı OLAMAZ',
  )
  // Aynı sabit persistence zincirinde de kullanılır.
  for (const file of [
    'orders/orderPersistenceService.ts',
    'shipments/shipmentPersistenceService.ts',
  ]) {
    assert.match(
      readFileSync(join(here, file), 'utf8'),
      /SURAT_PERSISTENCE_PROVIDER/,
      `kanonik sabit kullanılmalı: ${file}`,
    )
  }
  // Repository sorgusu EXACT kalır: fuzzy/LIKE/ILIKE veya provider filtresinin
  // kaldırılması YASAK.
  const repo = readFileSync(join(here, 'shipments/printZplRepository.ts'), 'utf8')
  assert.match(repo, /eq\(shipments\.provider, key\.provider\)/)
  assert.equal(/ilike|like\(|sql`.*LIKE/i.test(repo), false, 'fuzzy sorgu YOK')
  assert.match(repo, /eq\(shipments\.organizationId, key\.organizationId\)/)
  assert.match(repo, /eq\(shipments\.marketplace, key\.marketplace\)/)
  assert.match(repo, /eq\(shipments\.packageId, key\.packageId\)/)
})

// ═══ CP-8..CP-9: SÜRAT OLMAYAN SAĞLAYICI ═════════════════════════════════

test('CP-8: Sürat OLMAYAN sağlayıcı 409 not_surat_shipment', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  for (const foreign of ['Aras', 'Yurtiçi', 'MNG', 'Aras Kargo']) {
    await assert.rejects(
      () => render(db, seeded, { shipmentProvider: foreign }),
      (error) =>
        error.status === 409 &&
        error.code === 'not_surat_shipment' &&
        error.message ===
          'Resmî Sürat şablonu yalnız Sürat Kargo gönderilerinde kullanılabilir.',
      foreign,
    )
  }
})

test('CP-9: Sürat OLMAYAN sağlayıcıda repository lookup HİÇ yapılmaz', async () => {
  const db = await makeDb()
  const seeded = await seed(db)
  // Kayıt SİLİNİR: lookup yapılsaydı label_not_ready dönerdi. Yine de
  // not_surat_shipment dönmesi, sağlayıcı reddinin lookup'tan ÖNCE
  // olduğunu kanıtlar.
  await db
    .delete(schema.shipments)
    .where(eq(schema.shipments.organizationId, seeded.organizationId))
  await assert.rejects(
    () => render(db, seeded, { shipmentProvider: 'Aras' }),
    (error) => error.code === 'not_surat_shipment',
  )
})

// ═══ CP-10: ORG İZOLASYONU EXACT KALIR ═══════════════════════════════════

test('CP-10: organization/marketplace/packageId izolasyonu EXACT', async () => {
  const db = await makeDb()
  const alfa = await seed(db, { slug: 'alfa-org' })
  const beta = await seed(db, { slug: 'beta-org' })
  // Beta'nın kaydı Alfa'nın kimliğiyle OKUNAMAZ.
  await assert.rejects(
    () =>
      renderService.renderSuratLabel({
        db,
        organizationId: 'yok-org',
        marketplaceAccountId: null,
        orderId: 'order-1',
        getOrder: makeGetOrder(alfa),
      }),
    (error) => error.status === 404 && error.code === 'order_not_found',
  )
  // Her org KENDİ satırını bulur.
  const a = await render(db, alfa, { cargoProviderName: 'Sürat Kargo' })
  const b = await render(db, beta, { cargoProviderName: 'Sürat Kargo' })
  assert.equal(a.printZplSha256, alfa.persisted.printZplSha256)
  assert.equal(b.printZplSha256, beta.persisted.printZplSha256)
})
