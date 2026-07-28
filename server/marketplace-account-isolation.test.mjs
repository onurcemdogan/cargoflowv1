import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, isNull } from 'drizzle-orm'

// FAZ 0 — pazaryeri hesabi izolasyonu (davranissal). organizationId +
// marketplace + marketplaceAccountId kapsamiyla:
//   - okuma yalniz aktif hesabi gosterir (siparis/urun/etiket)
//   - yazma + reconcile yalniz kendi hesabini etkiler (baska hesabi arsivlemez)
//   - legacy (hesapsiz) kayitlar aktif hesaba OTOMATIK atanmaz, aktif UI'da yok
//   - hesaba geri donunce eski kayitlar + LABEL_READY/PRINTED korunur
//   - sync metadata / lastSuccessfulSyncAt hesap bazli
//   - org (tenant) izolasyonu + hesap izolasyonu birlikte
//   - guvenlik: displayName ham secret icermez
// NOT: COMPLETE/PARTIAL/207/retry (spec 16) status-sync-contract-flow ile;
// Dashboard Yenile sync atmaz (spec 17) orders-sync-ondemand/sync-resilience ile
// zaten kapsanir.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')
const productService = await import('./products/productPersistenceService.ts')
const repo = await import('./onboarding/onboardingRepository.ts')
const shipmentService = await import('./shipments/shipmentPersistenceService.ts')

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
let seq = 0
function order(over = {}) {
  seq += 1
  const packageId = over.packageId ?? `PKG-${seq}`
  return {
    marketplace: 'Trendyol',
    packageId,
    shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`,
    marketplaceStatus: 'Created',
    operationStatus: 'NEW',
    customerFirstName: 'Ada',
    customerLastName: 'L',
    city: 'İstanbul',
    totalAmount: 100,
    currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-24T08:00:00Z',
    rawOrder: { secret: 'RAW' },
    items: [{ id: `l-${packageId}`, barcode: 'B1', quantity: 1, price: 100, productName: 'X' }],
    ...over,
  }
}
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
async function twoAccounts(db, org) {
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-B')
  return { a, b }
}

// ── spec 1: aktif hesap → yalniz o hesabin siparisleri ─────────────────────
test('ISO-1: aktif hesap yalniz kendi siparislerini gosterir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-1')
  const { a, b } = await twoAccounts(db, org)
  await orderService.persistSyncResult(db, org, [order({ packageId: 'A-1' })], { complete: false, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'B-1' })], { complete: false, marketplaceAccountId: b.id })
  const listA = await orderService.listOrders(db, org, {}, a.id)
  assert.deepEqual(listA.orders.map((o) => o.packageId), ['A-1'], 'A yalniz A-1 gorur')
  const listB = await orderService.listOrders(db, org, {}, b.id)
  assert.deepEqual(listB.orders.map((o) => o.packageId), ['B-1'], 'B yalniz B-1 gorur')
})

// ── spec 2 + 6: A'nin etiketli siparisi B aktifken gorunmez/erisilemez ─────
test('ISO-2/6: A LABEL_READY/PRINTED B aktifken gizli; capraz-hesap erisim 404', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-2')
  const { a, b } = await twoAccounts(db, org)
  await orderService.persistSyncResult(
    db,
    org,
    [order({ packageId: 'A-READY', operationStatus: 'LABEL_PRINTED' })],
    { complete: false, marketplaceAccountId: a.id },
  )
  const [aRow] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'A-READY')))
  // B aktif: A-READY listede yok.
  const listB = await orderService.listOrders(db, org, {}, b.id)
  assert.equal(listB.orders.length, 0, 'B, A kaydini gormez')
  // B, A order id'sini bilse bile: getOrder(B) 404, label(B) not-found, print yasak.
  assert.equal(await orderService.getOrder(db, org, aRow.id, b.id), null, 'getOrder(B) capraz-hesap 404')
  const label = await orderService.resolvePersistedLabel(db, org, aRow.id, b.id)
  assert.equal(label.found, false, 'label(B) capraz-hesap cozulemez')
  const printed = await orderService.markLabelPrinted(db, org, aRow.id, b.id)
  assert.equal(printed.found, false, 'markLabelPrinted(B) capraz-hesap yasak')
  // A aktif: kendi kaydini normal gorur/cozulur.
  assert.ok(await orderService.getOrder(db, org, aRow.id, a.id), 'A kendi siparisini gorur')
})

// ── spec 3 + 10 + 13: B sync yalniz B'yi reconcile eder; A'ya dokunmaz ─────
test('ISO-3/10/13: B COMPLETE sync A kayitlarini arsivlemez; PARTIAL de dokunmaz', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-3')
  const { a, b } = await twoAccounts(db, org)
  await orderService.persistSyncResult(db, org, [order({ packageId: 'A-STALE' })], { complete: true, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'B-1' })], { complete: true, marketplaceAccountId: b.id })
  // B TAM sync: farkli aktif set (B-2). A-STALE B'nin kapsaminda DEGIL → dokunulmaz.
  const res = await orderService.persistSyncResult(db, org, [order({ packageId: 'B-2' })], { complete: true, marketplaceAccountId: b.id })
  const aArch = await db
    .select({ archivedAt: schema.orders.archivedAt })
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'A-STALE')))
  assert.equal(aArch[0].archivedAt ?? null, null, 'A-STALE B sync ile arsivlenmez')
  // B kendi bayat kaydini (B-1) arsivler (kendi kapsaminda).
  const b1 = await db
    .select({ archivedAt: schema.orders.archivedAt })
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'B-1')))
  assert.ok(b1[0].archivedAt, 'B kendi bayat kaydini arsivler')
  assert.equal(res.archivedCount, 1, 'yalniz B kapsaminda 1 arsiv')
  // PARTIAL (complete=false) hicbir hesaba dokunmaz.
  const partial = await orderService.persistSyncResult(db, org, [order({ packageId: 'B-9' })], { complete: false, marketplaceAccountId: b.id })
  assert.equal(partial.archivedCount, 0)
})

// ── spec 4 + 15: hesaba geri donunce eski kayitlar + guclu statuler doner ──
test('ISO-4/15: A\'ya geri donunce A siparisleri ve LABEL_PRINTED korunur; B gizli', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-4')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  await orderService.persistSyncResult(
    db, org,
    [order({ packageId: 'A-1', operationStatus: 'LABEL_PRINTED' }), order({ packageId: 'A-2' })],
    { complete: true, marketplaceAccountId: a.id },
  )
  // B'ye gec, B'de sync.
  const b = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-B')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'B-1' })], { complete: true, marketplaceAccountId: b.id })
  // A'ya geri don (ayni providerAccountId → ayni hesap, yeni oluşmaz).
  const aAgain = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  assert.equal(aAgain.id, a.id, 'ayni hesaba geri donulur')
  const listA = await orderService.listOrders(db, org, {}, aAgain.id)
  assert.deepEqual(listA.orders.map((o) => o.packageId).sort(), ['A-1', 'A-2'], 'A kayitlari geri gorunur')
  const printed = listA.orders.find((o) => o.packageId === 'A-1')
  assert.equal(printed.operationStatus, 'LABEL_PRINTED', 'LABEL_PRINTED korunur')
  assert.equal(listA.orders.some((o) => o.packageId === 'B-1'), false, 'B kaydi A\'da gorunmez')
})

// ── spec 5: ayni packageId iki hesapta cakismaz ────────────────────────────
test('ISO-5: ayni packageId iki hesapta ayri kayit (idempotency conflict yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-5')
  const { a, b } = await twoAccounts(db, org)
  const resA = await orderService.persistSyncResult(db, org, [order({ packageId: 'DUP' })], { complete: false, marketplaceAccountId: a.id })
  const resB = await orderService.persistSyncResult(db, org, [order({ packageId: 'DUP' })], { complete: false, marketplaceAccountId: b.id })
  // Her iki sipariş de KENDİ hesabına yazıldı (unique çakışması olmadan) — iki
  // ayrı kayıt; her hesap kendi DUP'ını görür.
  assert.equal(resA.insertedCount, 1, 'A DUP eklendi')
  assert.equal(resB.insertedCount, 1, 'B DUP çakışmadan eklendi (ayrı hesap)')
  const rows = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'DUP')))
  assert.equal(rows.length, 2, 'iki ayrı kayıt')
  const listA = await orderService.listOrders(db, org, {}, a.id)
  const listB = await orderService.listOrders(db, org, {}, b.id)
  assert.deepEqual(listA.orders.map((o) => o.packageId), ['DUP'])
  assert.deepEqual(listB.orders.map((o) => o.packageId), ['DUP'])
})

// ── spec 7 + 9: sync metadata / lastSuccessfulSyncAt hesap bazli ───────────
test('ISO-7/9: sync state ve lastSuccessfulSyncAt hesap bazli izole', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-7')
  const { a, b } = await twoAccounts(db, org)
  await repo.recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'success', fetchedCount: 5, marketplaceAccountId: a.id })
  await repo.recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'failed', errorCode: '429', marketplaceAccountId: b.id })
  const stateA = await repo.getSyncState(db, org, 'orders', a.id)
  const stateB = await repo.getSyncState(db, org, 'orders', b.id)
  assert.equal(stateA.lastSyncStatus, 'success')
  assert.ok(stateA.lastSuccessfulSyncAt, 'A basarili zamani var')
  assert.equal(stateB.lastSyncStatus, 'failed')
  assert.equal(stateB.lastSuccessfulSyncAt ?? null, null, 'B basarili zamani yok (izole)')
  // Hesap tablosu metadata'si da bagimsiz.
  await accounts.updateAccountSyncMeta(db, org, a.id, { status: 'success' })
  await accounts.updateAccountSyncMeta(db, org, b.id, { status: 'failed' })
  assert.ok((await accounts.getAccountById(db, org, a.id)).lastSuccessfulSyncAt)
  assert.equal((await accounts.getAccountById(db, org, b.id)).lastSuccessfulSyncAt ?? null, null)
})

// ── spec 8: urunler yalniz aktif hesap ─────────────────────────────────────
test('ISO-8: urunler yalniz aktif hesabi gosterir; B sync A urununu arsivlemez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-8')
  const { a, b } = await twoAccounts(db, org)
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'A-BAR', productMainId: 'A-M' })], { complete: true, marketplaceAccountId: a.id })
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'B-BAR', productMainId: 'B-M' })], { complete: true, marketplaceAccountId: b.id })
  const listA = await productService.listProducts(db, org, {}, a.id)
  assert.equal(listA.products.length, 1)
  assert.equal(listA.products[0].barcode, 'A-BAR', 'A yalniz kendi urununu gorur')
  // B TAM sync yeni urunle: A urunu B kapsaminda degil → arsivlenmez.
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'B-BAR2', productMainId: 'B-M2' })], { complete: true, marketplaceAccountId: b.id })
  const listAAfter = await productService.listProducts(db, org, { archived: false }, a.id)
  assert.equal(listAAfter.products.length, 1, 'A urunu B sync ile arsivlenmez')
})

// ── spec 11: A sync sonucu B'ye yazilamaz (hesap sync basinda sabit) ───────
test('ISO-11: A context ile persist B aktif olsa da A\'ya yazar', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-11')
  const { a, b } = await twoAccounts(db, org)
  // B su an aktif; ama A context'iyle baslamis bir sync A'ya yazmali.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'FROM-A' })], { complete: false, marketplaceAccountId: a.id })
  const inA = await orderService.listOrders(db, org, {}, a.id)
  const inB = await orderService.listOrders(db, org, {}, b.id)
  assert.deepEqual(inA.orders.map((o) => o.packageId), ['FROM-A'], 'A context yazisi A\'da')
  assert.equal(inB.orders.length, 0, 'aktif hesap B olsa da A yazisi B\'ye sizmaz')
})

// ── spec 12: legacy (hesapsiz) kayit aktif hesaba otomatik atanmaz ─────────
test('ISO-12: legacy NULL-hesap kayit aktif hesapta gorunmez (otomatik atama yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-12')
  // Once legacy (hesapsiz) kayit.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'LEG-1' })], { complete: false })
  // Sonra hesap baglanir/aktif olur.
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  const listA = await orderService.listOrders(db, org, {}, a.id)
  assert.equal(listA.orders.length, 0, 'legacy kayit aktif hesaba otomatik atanmaz')
  // Legacy kayit DB'de duruyor (silinmedi), yalniz hesapsiz kapsamda.
  const legacy = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), isNull(schema.orders.marketplaceAccountId)))
  assert.equal(legacy.length, 1, 'legacy kayit korunur (silinmez)')
})

// ── spec 14: tenant izolasyonu + hesap izolasyonu birlikte ─────────────────
test('ISO-14: iki tenant + her tenant icinde hesap izolasyonu', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'iso-14a')
  const orgB = await makeOrg(db, 'iso-14b')
  const a = await accounts.resolveOrCreateActiveAccount(db, orgA, 'Trendyol', 'SELLER-X')
  const b = await accounts.resolveOrCreateActiveAccount(db, orgB, 'Trendyol', 'SELLER-X')
  await orderService.persistSyncResult(db, orgA, [order({ packageId: 'OA' })], { complete: true, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, orgB, [order({ packageId: 'OB' })], { complete: true, marketplaceAccountId: b.id })
  // Ayni providerAccountId ('SELLER-X') iki org'da FARKLI hesaptir.
  assert.notEqual(a.id, b.id, 'ayni sellerId farkli org\'da ayri hesap')
  const listA = await orderService.listOrders(db, orgA, {}, a.id)
  assert.deepEqual(listA.orders.map((o) => o.packageId), ['OA'], 'tenant A yalniz kendi')
  // orgB'nin aktif hesabi orgA icin cross-tenant erisim vermez.
  assert.equal(await accounts.getAccountById(db, orgA, b.id), null, 'cross-tenant hesap gorunmez')
})

// ── spec 18: guvenlik — displayName ham secret icermez ─────────────────────
test('ISO-18: hesap displayName/providerAccountId ham secret icermez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'iso-18')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  assert.doesNotMatch(String(a.displayName ?? ''), /apiKey|apiSecret|SECRET|password/i)
  assert.equal(a.providerAccountId, 'SELLER-A', 'kimlik = sellerId (secret degil)')
  // resolveProviderAccountId secret'i asla kimlik yapmaz.
  assert.equal(accounts.resolveProviderAccountId('Trendyol', { apiKey: 'K', apiSecret: 'S' }), null)
})

// ── Migration: iki hesap ayni packageId, ayni hesapta duplicate engellenir ─
test('MIG-1: shipment guclu kanit hesap kapsaminda korunur (reconcile)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'mig-1')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-A')
  const o = order({ packageId: 'SHIP-A' })
  await orderService.persistSyncResult(db, org, [o], { complete: true, marketplaceAccountId: a.id })
  await shipmentService.writeOperationRecord(db, org, {
    idempotencyKey: `SURAT:org_${org}:${o.orderNumber}:CREATE`,
    organizationId: org, marketplace: 'Trendyol', packageId: 'SHIP-A',
    orderNumber: o.orderNumber, orderId: o.orderNumber, provider: 'surat',
    operation: 'OrtakBarkodOlustur', status: 'SUCCESS', createCallCount: 1,
    technicalZpl: '^XA^FD01^FS^XZ',
  })
  // A TAM sync yeni set: SHIP-A gorunmese de shipment guclu kanit → korunur.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'A-NEW' })], { complete: true, marketplaceAccountId: a.id })
  const row = await db
    .select({ archivedAt: schema.orders.archivedAt })
    .from(schema.orders)
    .where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'SHIP-A')))
  assert.equal(row[0].archivedAt ?? null, null, 'shipmentli kayit korunur')
})
