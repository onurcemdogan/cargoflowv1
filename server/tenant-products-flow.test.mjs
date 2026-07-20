import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'

// Ürün kataloğu tenant persistence (faz 6) hermetik testleri A-V.
// Gerçek PostgreSQL motoru (pglite) + gerçek unique/index. Trendyol normalize,
// görsel resolver semantiği ve 4293 varyant korumasına DOKUNMAZ; yalnız
// organization bazlı persistence + okuma + org-scoped eşlemeyi sınar.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const service = await import('./products/productPersistenceService.ts')
const { importLegacyProducts, extractLegacyProducts } = await import(
  './products/importLegacyProducts.ts'
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
async function makeDb() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  return { pglite, db: drizzle(pglite, { schema }) }
}
async function makeOrg(db, name, slug) {
  const [org] = await db.insert(schema.organizations).values({ name, slug }).returning()
  return org.id
}

let seq = 0
// normalizeTrendyolProducts çıktısına benzer düz CargoProduct.
function makeProduct(over = {}) {
  seq += 1
  const ext = over.externalProductId ?? `EXT-${seq}`
  const variant = over.externalVariantId ?? `VAR-${seq}`
  return {
    id: `prd_real_${variant}_${seq}`,
    marketplace: 'Trendyol',
    externalProductId: ext,
    externalVariantId: variant,
    productContentId: over.productContentId ?? `CID-${seq}`,
    productMainId: over.productMainId ?? `MAIN-${seq}`,
    productCode: over.productCode ?? `CODE-${seq}`,
    productName: over.productName ?? 'Kablosuz Kulaklık',
    sku: over.sku ?? `SKU-${seq}`,
    stockCode: over.stockCode ?? `STK-${seq}`,
    barcode: over.barcode ?? `BRC-${seq}`,
    category: 'Elektronik',
    brand: 'Marka',
    color: over.color ?? 'Siyah',
    size: over.size ?? 'STD',
    variantAttributes: [{ name: 'Renk', value: over.color ?? 'Siyah' }],
    images: over.images ?? ['https://img.example/1.jpg'],
    imageUrl: over.imageUrl ?? 'https://img.example/1.jpg',
    productImageUrl: over.imageUrl ?? 'https://img.example/1.jpg',
    stock: over.stock ?? 5,
    price: over.price ?? 199.9,
    productStatus: 'approved',
    source: 'real',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
    ...over,
  }
}

test('ürün persistence A-V: izolasyon, sayfalama, varyant koruma, şifreleme', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'Org A', 'prd-a')
  const orgB = await makeOrg(db, 'Org B', 'prd-b')

  // E) Yeni organization boş katalogla başlar.
  assert.equal((await service.listProducts(db, orgA, {})).total, 0)
  assert.equal(await service.countProducts(db, orgA), 0)

  // A) Org A sync yalnız A'ya yazar.
  const pA = makeProduct({ externalProductId: 'PX-1', externalVariantId: 'VX-1', barcode: 'BC-A', sku: 'SKU-A' })
  const r1 = await service.persistProductSyncResult(db, orgA, [pA], { complete: true })
  assert.equal(r1.insertedProducts, 1)
  assert.equal(r1.insertedVariants, 1)
  assert.equal((await service.listProducts(db, orgA, {})).total, 1)

  // B) Org B, Org A ürünlerini göremez.
  assert.equal((await service.listProducts(db, orgB, {})).total, 0)

  // C) Aynı externalProductId farklı orglarda bağımsız.
  await service.persistProductSyncResult(db, orgB, [makeProduct({ externalProductId: 'PX-1', externalVariantId: 'VX-1', barcode: 'BC-B', sku: 'SKU-B' })], { complete: true })
  assert.equal((await service.listProducts(db, orgB, {})).total, 1)
  assert.equal((await service.listProducts(db, orgA, {})).total, 1)

  // D) Aynı barcode farklı orglarda bağımsız.
  const aByBarcode = await service.resolveVariantByBarcode(db, orgA, 'BC-A')
  assert.ok(aByBarcode)
  assert.equal(await service.resolveVariantByBarcode(db, orgB, 'BC-A'), null, 'Org B, Org A barkodunu görmez')

  // K) Aynı ürünü tekrar sync → varyant duplicate oluşmaz (update).
  const r2 = await service.persistProductSyncResult(db, orgA, [pA], { complete: false })
  assert.equal(r2.insertedVariants, 0)
  assert.equal(r2.updatedVariants, 1)
  const variantRows = await db.select().from(schema.productVariants).where(eq(schema.productVariants.organizationId, orgA))
  assert.equal(variantRows.length, 1, 'varyant duplicate olmaz')

  // J) Full sync fresh alanları günceller (fiyat/stok/başlık).
  await service.persistProductSyncResult(db, orgA, [makeProduct({ externalProductId: 'PX-1', externalVariantId: 'VX-1', barcode: 'BC-A', sku: 'SKU-A', price: 249.5, stock: 12, productName: 'Yeni Başlık' })], { complete: true })
  const updated = (await service.listProducts(db, orgA, {})).products[0]
  assert.equal(updated.price, 249.5)
  assert.equal(updated.stock, 12)
  assert.equal(updated.productName, 'Yeni Başlık')

  // O) Görsel resolver fallback alanları BİRE BİR korunur (sabit değerli ayrı
  // ürün; raw'dan reconstruct: productContentId/productCode/productMainId/images).
  const orgO = await makeOrg(db, 'Org O', 'prd-o')
  const pO = makeProduct({
    externalProductId: 'PO-1', externalVariantId: 'VO-1',
    productContentId: 'CID-OO-SECRET', productCode: 'CODE-OO', productMainId: 'MAIN-OO',
    barcode: 'BC-OO', sku: 'SKU-OO', imageUrl: 'https://img.example/oo.jpg',
    images: ['https://img.example/oo.jpg', 'https://img.example/oo-2.jpg'],
  })
  await service.persistProductSyncResult(db, orgO, [pO], { complete: true })
  const detail = (await service.listProducts(db, orgO, {})).products[0]
  assert.equal(detail.productContentId, 'CID-OO-SECRET', 'productContentId raw\'dan korunur')
  assert.equal(detail.productCode, 'CODE-OO')
  assert.equal(detail.productMainId, 'MAIN-OO')
  assert.deepEqual(detail.images, pO.images)
  assert.equal(detail.imageUrl, 'https://img.example/oo.jpg')
  assert.equal(detail.barcode, 'BC-OO')
  assert.equal(detail.sku, 'SKU-OO')

  // S) Raw payload DB'de düz metin DEĞİL: kolonu olmayan alan (productContentId)
  // dump'ta düz metin GÖRÜNMEZ; rawPayloadEncrypted versioned envelope'tur.
  const rawProducts = await db.select().from(schema.products).where(eq(schema.products.organizationId, orgO))
  const rawVariants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.organizationId, orgO))
  const dump = JSON.stringify([...rawProducts, ...rawVariants])
  assert.ok(!dump.includes('CID-OO-SECRET'), 'kolonu olmayan raw alanı şifreli (düz metin değil)')
  for (const row of rawVariants) {
    assert.ok(String(row.rawPayloadEncrypted).startsWith('{"v":1'))
  }

  // M) barcode/SKU lookup org scoped.
  assert.ok(await service.resolveVariantByMerchantSku(db, orgA, 'SKU-A'))
  assert.equal(await service.resolveVariantByMerchantSku(db, orgB, 'SKU-A'), null)

  // R) detail çapraz org 404 (null).
  const own = detail.id
  assert.ok(await service.getProduct(db, orgO, own))
  assert.equal(await service.getProduct(db, orgB, own), null, 'çapraz org null')

  // F/G) Restart sonrası katalog korunur; okuma yalnız DB satırlarından reconstruct.
  const db2 = drizzle(pglite, { schema })
  assert.equal((await service.listProducts(db2, orgA, {})).total, 1, 'restart sonrası korunur')

  // L) 4293 varyant koruması: N düz varyant yaz → N düz varyant oku.
  const orgL = await makeOrg(db, 'Org L', 'prd-l')
  const many = Array.from({ length: 60 }, (_, i) =>
    makeProduct({ externalProductId: `MP-${i % 10}`, externalVariantId: `MV-${i}`, barcode: `MB-${i}`, sku: `MS-${i}` }))
  const rL = await service.persistProductSyncResult(db, orgL, many, { complete: true })
  assert.equal(rL.insertedVariants, 60, 'tüm varyantlar yazılır')
  assert.equal(rL.insertedProducts, 10, '10 ana ürün altında gruplanır')
  assert.equal(await service.countProducts(db, orgL), 60, 'düz varyant sayısı korunur (4293 koruması)')

  // P) Server-side pagination.
  const page1 = await service.listProducts(db, orgL, {})
  assert.equal(page1.pageSize, 25)
  assert.equal(page1.products.length, 25)
  assert.equal(page1.total, 60)
  const page3 = await service.listProducts(db, orgL, { page: 3 })
  assert.equal(page3.products.length, 10)

  // Q) pageSize max 100.
  const clamped = await service.listProducts(db, orgL, { pageSize: 500 })
  assert.equal(clamped.pageSize, 100)

  // I) Partial sync ürün SİLMEZ/ARŞİVLEMEZ.
  const orgI = await makeOrg(db, 'Org I', 'prd-i')
  await service.persistProductSyncResult(db, orgI, [makeProduct({ externalProductId: 'I-1', externalVariantId: 'IV-1' }), makeProduct({ externalProductId: 'I-2', externalVariantId: 'IV-2' })], { complete: true })
  const partial = await service.persistProductSyncResult(db, orgI, [makeProduct({ externalProductId: 'I-1', externalVariantId: 'IV-1' })], { complete: false })
  assert.equal(partial.archivedCount, 0, 'partial sync arşivlemez')
  const iRows = await db.select().from(schema.products).where(eq(schema.products.organizationId, orgI))
  assert.equal(iRows.filter((p) => p.archived === false).length, 2, 'partial sync ürün silmez/arşivlemez')

  // Tam sync reconcile: eksik ürün arşivlenir (SİLİNMEZ), varyant da arşivlenir.
  const full = await service.persistProductSyncResult(db, orgI, [makeProduct({ externalProductId: 'I-1', externalVariantId: 'IV-1' })], { complete: true })
  assert.equal(full.archivedCount, 1)
  const iAll = await db.select().from(schema.products).where(eq(schema.products.organizationId, orgI))
  assert.equal(iAll.length, 2, 'arşivlenen kayıt SİLİNMEZ')
  const archivedProduct = iAll.find((p) => p.externalProductId === 'I-2')
  assert.equal(archivedProduct.archived, true)

  // N) Sipariş satırı başka org ürününe eşleşmez (org-scoped lookup).
  // Org A'nın BC-A barkodu Org B için asla çözülmez (yukarıda D'de kanıtlandı);
  // ek olarak var olmayan org lookup boş döner.
  assert.equal(await service.resolveVariantByBarcode(db, orgB, 'MB-1'), null)

  // V) Ürün persistence Sürat create ÇAĞIRMAZ: shipment_operations tablosu boş.
  assert.equal((await db.select().from(schema.shipmentOperations)).length, 0, 'ürün akışı Sürat create tetiklemez')
})

// H) Legacy import: dry-run/commit/duplicate/format çözümleme (localStorage/
// IndexedDB davranışı frontend'de aynen kalır; burada açık import sınanır).
test('legacy ürün import: dry-run/commit/duplicate/format', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'Import Org', 'prd-import')
  const dir = mkdtempSync(join(tmpdir(), 'cargoflow-products-import-'))
  const storePath = join(dir, 'catalog-export.json')
  const legacy = makeProduct({ externalProductId: 'LEG-1', externalVariantId: 'LEGV-1', barcode: 'LEGBC', sku: 'LEGSKU' })
  const original = JSON.stringify({ '123456': { products: [legacy] } }, null, 2)
  writeFileSync(storePath, original)

  // Format çözümleme: üç biçim de.
  assert.equal(extractLegacyProducts([legacy]).length, 1)
  assert.equal(extractLegacyProducts({ products: [legacy] }).length, 1)
  assert.equal(extractLegacyProducts({ '123456': { products: [legacy] } }).length, 1)
  assert.equal(extractLegacyProducts({ '123456': { products: [legacy] } }, '999').length, 0)

  // dry-run: yazmaz, dosya değişmez.
  const dry = await importLegacyProducts(db, org, { dryRun: true, storePath })
  assert.equal(dry.read, 1)
  assert.equal(dry.dryRun, true)
  assert.equal((await db.select().from(schema.products)).length, 0, 'dry-run kayıt yazmaz')
  assert.equal(readFileSync(storePath, 'utf8'), original, 'export dosyası değişmez')

  // commit: ürün + varyant yazar.
  const committed = await importLegacyProducts(db, org, { dryRun: false, storePath })
  assert.equal(committed.insertedProducts, 1)
  assert.equal(committed.insertedVariants, 1)

  // tekrar commit: duplicate güvenli (upsert, yeni kayıt yok).
  const again = await importLegacyProducts(db, org, { dryRun: false, storePath })
  assert.equal(again.insertedProducts, 0)
  assert.equal(again.updatedProducts, 1)
  assert.equal((await db.select().from(schema.productVariants)).length, 1, 'duplicate varyant oluşmaz')
  assert.equal(readFileSync(storePath, 'utf8'), original)
})
