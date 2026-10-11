// CATALOG-001 — ÜRÜN KATALOĞU TARAYICISI (SUNUCU).
//
// `GET /api/products` ucunun TAM davranışı `productCatalogQuery.ts` içindedir
// (index.mjs yalnız kapsam çözüp devreder); burada GERÇEK Postgres (PGlite)
// + GERÇEK göçler + GERÇEK senkron kalıcılaştırma yoluyla sınanır.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.PRODUCT_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const catalog = await import('./products/productCatalogQuery.ts')
const productService = await import('./products/productPersistenceService.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const credentials = await import('./integrations/credentialService.ts')
const syncRepo = await import('./onboarding/onboardingRepository.ts')

function migrationStatements() {
  const dir = join(root, 'drizzle')
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
async function makeOrg(db) {
  const slug = `cat-${randomBytes(4).toString('hex')}`
  const [org] = await db.insert(schema.organizations).values({ name: slug, slug }).returning()
  return org.id
}
let seq = 0
function product(over = {}) {
  seq += 1
  return {
    marketplace: 'Trendyol',
    productName: over.productName ?? `Ürün ${seq}`,
    barcode: over.barcode ?? `PB-${seq}`,
    merchantSku: over.merchantSku ?? `SKU-${seq}`,
    productMainId: over.productMainId ?? `M-${seq}`,
    stockCode: over.stockCode ?? `S-${seq}`,
    quantity: 1,
    ...over,
  }
}
const list = (db, organizationId, marketplaceAccountId, query = {}) =>
  catalog.handleProductListRequest({ db, organizationId, marketplaceAccountId, query })
const barcodes = (result) => result.body.products.map((p) => p.barcode)

/* ─────────────────────────────────────────────────────────────────────── */

test('CAT-SRV-1/2: kiracı kapsamlı; sorgudaki kapsam alanları YOK SAYILIR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, orgA, 'Trendyol', 'A')
  const b = await accounts.resolveOrCreateActiveAccount(db, orgB, 'Trendyol', 'B')
  await productService.persistProductSyncResult(db, orgA, [product({ barcode: 'A-1' })], { complete: true, marketplaceAccountId: a.id })
  await productService.persistProductSyncResult(db, orgB, [product({ barcode: 'B-1' })], { complete: true, marketplaceAccountId: b.id })

  // İstemci B'nin kiracı ve hesabını SORGUYA koysa bile A'nın kapsamı geçerli.
  const escaped = await list(db, orgA, a.id, {
    organizationId: orgB,
    marketplaceAccountId: b.id,
    search: '',
  })
  assert.equal(escaped.httpStatus, 200)
  assert.deepEqual(barcodes(escaped), ['A-1'])
  assert.equal(JSON.stringify(escaped.body).includes('B-1'), false)
  assert.deepEqual(barcodes(await list(db, orgB, b.id)), ['B-1'])
  // Ayrıştırıcı kapsam alanı ÜRETMEZ.
  const filters = catalog.parseProductListQuery({ organizationId: orgB, marketplaceAccountId: b.id })
  assert.equal('organizationId' in filters, false)
  assert.equal('marketplaceAccountId' in filters, false)
})

test('CAT-SRV-3: arama SUNUCUDA, desteklenen alanlarda (ad/barkod/SKU/stok kodu)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'A')
  await productService.persistProductSyncResult(db, org, [
    product({ productName: 'Kırmızı Ruj', barcode: 'BAR-111', merchantSku: 'SKU-X', stockCode: 'STK-9', productMainId: 'M1' }),
    product({ productName: 'Mavi Far', barcode: 'BAR-222', merchantSku: 'SKU-Y', stockCode: 'STK-8', productMainId: 'M2' }),
  ], { complete: true, marketplaceAccountId: a.id })
  assert.deepEqual(barcodes(await list(db, org, a.id, { search: 'ruj' })), ['BAR-111'], 'ad')
  assert.deepEqual(barcodes(await list(db, org, a.id, { search: 'BAR-222' })), ['BAR-222'], 'barkod')
  assert.deepEqual(barcodes(await list(db, org, a.id, { search: 'SKU-X' })), ['BAR-111'], 'SKU')
  assert.deepEqual(barcodes(await list(db, org, a.id, { search: 'STK-8' })), ['BAR-222'], 'stok kodu')
  const none = await list(db, org, a.id, { search: 'yok-böyle' })
  assert.equal(none.body.total, 0)
})

test('CAT-SRV-4/5: sayfa/sayfa boyutu/toplam doğru; üst sınır 100', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'A')
  const many = Array.from({ length: 130 }, (_, index) =>
    product({ productName: `P ${String(index).padStart(3, '0')}`, productMainId: `MM-${index}` }),
  )
  await productService.persistProductSyncResult(db, org, many, { complete: true, marketplaceAccountId: a.id })

  const second = await list(db, org, a.id, { page: 2, pageSize: 25 })
  assert.equal(second.body.total, 130)
  assert.equal(second.body.page, 2)
  assert.equal(second.body.pageSize, 25)
  assert.equal(second.body.products.length, 25)
  assert.equal(second.body.products[0].productName, 'P 025')

  const last = await list(db, org, a.id, { page: 6, pageSize: 25 })
  assert.equal(last.body.products.length, 5)

  const clamped = await list(db, org, a.id, { pageSize: 5000 })
  assert.equal(clamped.body.pageSize, 100, 'sayfa boyutu kabul edilen üst sınıra kırpılır')
  assert.equal(clamped.body.products.length, 100)

  // Sayfalar kesişmez, birleşimi tamdır (deterministik sıra).
  const seen = new Set()
  for (let pageNo = 1; pageNo <= 6; pageNo += 1) {
    for (const row of (await list(db, org, a.id, { page: pageNo, pageSize: 25 })).body.products) {
      assert.equal(seen.has(row.id), false, 'satır iki sayfada görünmez')
      seen.add(row.id)
    }
  }
  assert.equal(seen.size, 130)
})

test('CAT-SRV-6: arşiv filtresi AÇIK — false/true/all; varsayılan TÜMÜ (operasyonel)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'A')
  await productService.persistProductSyncResult(db, org, [
    product({ barcode: 'KEEP', productMainId: 'K' }),
    product({ barcode: 'GONE', productMainId: 'G' }),
  ], { complete: true, marketplaceAccountId: a.id })
  // TAM senkron GONE'u görmez → arşivlenir (mevcut uzlaştırma).
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'KEEP', productMainId: 'K' })], { complete: true, marketplaceAccountId: a.id })

  assert.deepEqual(barcodes(await list(db, org, a.id, { archived: 'false' })), ['KEEP'])
  assert.deepEqual(barcodes(await list(db, org, a.id, { archived: 'true' })), ['GONE'])
  const all = await list(db, org, a.id, { archived: 'all' })
  assert.deepEqual(barcodes(all).sort(), ['GONE', 'KEEP'])
  assert.equal(all.body.archived, 'all')
  // Parametre YOK → HEPSİ: istemcinin operasyonel tam kataloğu buna dayanır.
  const unspecified = await list(db, org, a.id, {})
  assert.deepEqual(barcodes(unspecified).sort(), ['GONE', 'KEEP'])
  const gone = unspecified.body.products.find((p) => p.barcode === 'GONE')
  assert.equal(gone.archived, true, 'arşiv durumu satırda görünür')
})

test('CAT-SRV-7: sıralama titleAsc/titleDesc/recent DETERMİNİSTİK (eşitlikte kimlik)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'A')
  // Aynı ada sahip ON İKİ ana ürün: eşitlik kırıcı olmadan sıra fiziksel
  // ekleme sırasıdır ve rastgele UUID sırasıyla çakışma olasılığı ~1/12!.
  const tiedRows = Array.from({ length: 12 }, (_, index) =>
    product({ productName: 'Aynı', productMainId: `T${index}`, barcode: `T${index}` }),
  )
  await productService.persistProductSyncResult(db, org, [
    ...tiedRows,
    product({ productName: 'Beta', productMainId: 'TB', barcode: 'TB' }),
  ], { complete: true, marketplaceAccountId: a.id })
  const asc = await list(db, org, a.id, { sort: 'titleAsc' })
  const again = await list(db, org, a.id, { sort: 'titleAsc' })
  assert.deepEqual(asc.body.products.map((p) => p.id), again.body.products.map((p) => p.id))
  assert.equal(asc.body.products.at(-1).productName, 'Beta')
  const tied = asc.body.products.filter((p) => p.productName === 'Aynı').map((p) => p.id)
  assert.deepEqual(tied, [...tied].sort(), 'eşitlikte varyant kimliği artan')
  const desc = await list(db, org, a.id, { sort: 'titleDesc' })
  assert.equal(desc.body.products[0].productName, 'Beta')
  const recent = await list(db, org, a.id, { sort: 'recent' })
  assert.equal(recent.body.products.length, 13)
  assert.deepEqual(
    (await list(db, org, a.id, { sort: 'recent' })).body.products.map((p) => p.id),
    recent.body.products.map((p) => p.id),
  )
  // Tanınmayan sıralama güvenli varsayılana düşer.
  assert.equal(catalog.parseProductListQuery({ sort: 'DROP TABLE' }).sort, 'titleAsc')
})

test('CAT-SRV-8 / CAT-ACC-1/2: aynı dış kimlik iki hesapta İZOLE', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'A')
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'B')
  const shared = { productMainId: 'SAME-MAIN', barcode: 'SAME-BAR', merchantSku: 'SAME-SKU' }
  await productService.persistProductSyncResult(db, org, [product({ ...shared, productName: 'A kopyası' })], { complete: true, marketplaceAccountId: a.id })
  await productService.persistProductSyncResult(db, org, [product({ ...shared, productName: 'B kopyası' })], { complete: true, marketplaceAccountId: b.id })
  const listA = await list(db, org, a.id)
  const listB = await list(db, org, b.id)
  assert.deepEqual(listA.body.products.map((p) => p.productName), ['A kopyası'])
  assert.deepEqual(listB.body.products.map((p) => p.productName), ['B kopyası'])
  assert.notEqual(listA.body.products[0].id, listB.body.products[0].id)
})

test('CAT-ACC-4: hesapsız (eski) kapsam AÇIKÇA ayrı; hesap satırlarını görmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'LEGACY' })], { complete: true, marketplaceAccountId: null })
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'A')
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'ACC' })], { complete: true, marketplaceAccountId: a.id })
  // Aktif hesap yoksa sunucu `null` (eski kapsam) çözer → yalnız eski satırlar.
  assert.deepEqual(barcodes(await list(db, org, null)), ['LEGACY'])
  assert.deepEqual(barcodes(await list(db, org, a.id)), ['ACC'])
})

test('CAT-SRV-9: tekil ürün yanlış kiracı/hesapta 404', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db)
  const orgB = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, orgA, 'Trendyol', 'A')
  const a2 = await accounts.resolveOrCreateActiveAccount(db, orgA, 'Trendyol', 'A2')
  await productService.persistProductSyncResult(db, orgA, [product({ barcode: 'ONE' })], { complete: true, marketplaceAccountId: a.id })
  const [row] = (await list(db, orgA, a.id)).body.products
  assert.ok(await productService.getProduct(db, orgA, row.id, a.id))
  assert.equal(await productService.getProduct(db, orgB, row.id, null), null, 'başka kiracı')
  assert.equal(await productService.getProduct(db, orgA, row.id, a2.id), null, 'başka hesap')
  // Ürün ucu bulunamayan ürüne 404 döner (kaynak).
  const index = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = index.indexOf("app.get('/api/products/:id'")
  const block = index.slice(start, index.indexOf('\n})', start))
  assert.match(block, /context\.marketplaceAccountId/)
  assert.match(block, /status\(404\)/)
})

test('CAT-SRV-SYNC: katalog durumu KALICI senkron gerçeğinden; kaynak yoksa senkron KAPALI', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db)
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'A')
  const empty = await list(db, org, a.id)
  assert.deepEqual(empty.body.catalogSync, {
    lastSyncStatus: null, lastSuccessfulSyncAt: null, lastFetchedCount: null,
  }, 'zaman damgası UYDURULMAZ')
  assert.deepEqual(empty.body.syncSource, { available: false, reason: 'NOT_CONFIGURED' })

  await credentials.saveIntegrationCredential(db, org, 'trendyol', { sellerId: 'A', apiKey: 'k', apiSecret: 's' })
  const at = new Date('2026-09-20T10:00:00.000Z')
  await syncRepo.recordSyncState(db, org, {
    provider: 'trendyol', resource: 'products', status: 'success', fetchedCount: 42,
    marketplaceAccountId: a.id, successfulSyncAt: at,
  })
  const synced = await list(db, org, a.id)
  assert.deepEqual(synced.body.catalogSync, {
    lastSyncStatus: 'success', lastSuccessfulSyncAt: at.toISOString(), lastFetchedCount: 42,
  })
  assert.deepEqual(synced.body.syncSource, { available: true, reason: null })
  // Başka hesabın senkron gerçeği bu hesaba KARIŞMAZ.
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'B')
  assert.equal((await list(db, org, b.id)).body.catalogSync.lastSuccessfulSyncAt, null)
  // Durum okuması senkron BAŞLATMAZ ve sır dönmez.
  assert.equal(JSON.stringify(synced.body).includes('"k"'), false)
})
