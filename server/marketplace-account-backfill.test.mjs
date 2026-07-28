import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq, isNull } from 'drizzle-orm'

// Explicit legacy marketplace-account backfill (davranissal).
//   - dry-run DB'yi DEGISTIRMEZ; apply yalniz NULL-hesap kayitlarini hedefe cevirir
//   - baska org / NULL-olmayan scope DOKUNULMAZ; idempotent
//   - conflict (order/product/sync-state) apply oncesi tespit + tum islem durur
//   - yanlis onay token'i reddedilir
//   - manifest tabanli rollback yalniz o batch'in degismemiş kayitlarini geri alir

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const backfill = await import('./integrations/marketplaceAccountBackfill.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')
const productService = await import('./products/productPersistenceService.ts')
const repo = await import('./onboarding/onboardingRepository.ts')

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
    marketplace: 'Trendyol', packageId, shipmentPackageId: packageId,
    orderNumber: over.orderNumber ?? `ORD-${seq}`, marketplaceStatus: 'Created',
    operationStatus: over.operationStatus ?? 'NEW', city: 'İstanbul', totalAmount: 100,
    currency: 'TRY', orderDate: '2026-07-24T08:00:00Z', rawOrder: {},
    items: [{ id: `l-${packageId}`, quantity: 1, price: 100, productName: 'X' }],
    ...over,
  }
}
function product(over = {}) {
  seq += 1
  return { marketplace: 'Trendyol', productName: `P${seq}`, barcode: over.barcode ?? `B-${seq}`,
    merchantSku: `S-${seq}`, productMainId: over.productMainId ?? `M-${seq}`, quantity: 1, ...over }
}
function applyOptions(target) {
  return {
    ...target,
    confirmationToken: backfill.computeConfirmationToken(target),
    batchId: randomUUID(),
    appliedAt: new Date().toISOString(),
  }
}
const T = (org) => ({ organizationId: org, marketplace: 'Trendyol', providerAccountId: 'SELLER-OLD' })

// ── 1: dry-run DB'yi degistirmez ────────────────────────────────────────────
test('BKF-1: dry-run DB\'yi DEGISTIRMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-1')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'L1' })], { complete: false })
  const plan = await backfill.planBackfill(db, T(org))
  assert.equal(plan.willModify, false)
  assert.equal(plan.legacyOrdersFound, 1)
  assert.equal(plan.targetAccountExists, false, 'hedef hesap henuz yok')
  // DB hala NULL.
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))
  assert.equal(row.marketplaceAccountId ?? null, null, 'dry-run kayit degistirmedi')
})

// ── 2: apply yalniz NULL-hesap kayitlarini gunceller ────────────────────────
test('BKF-2: apply yalniz NULL kayitlari hedefe cevirir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-2')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'L1' }), order({ packageId: 'L2' })], { complete: false })
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'PB1' })], { complete: false })
  await repo.recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'success', fetchedCount: 2 })
  const manifest = await backfill.applyBackfill(db, applyOptions(T(org)))
  assert.equal(manifest.after.scopedOrders, 2)
  assert.equal(manifest.after.scopedProducts, 1)
  assert.equal(manifest.after.scopedSyncStates, 1)
  const target = manifest.marketplaceAccountId
  const rows = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))
  assert.ok(rows.every((r) => r.marketplaceAccountId === target), 'tum siparisler hedefe baglandi')
})

// ── 3: baska org kayitlarina dokunmaz ───────────────────────────────────────
test('BKF-3: baska org kayitlarina DOKUNMAZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const orgA = await makeOrg(db, 'bkf-3a')
  const orgB = await makeOrg(db, 'bkf-3b')
  await orderService.persistSyncResult(db, orgA, [order({ packageId: 'A1' })], { complete: false })
  await orderService.persistSyncResult(db, orgB, [order({ packageId: 'B1' })], { complete: false })
  await backfill.applyBackfill(db, applyOptions(T(orgA)))
  const [bRow] = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, orgB))
  assert.equal(bRow.marketplaceAccountId ?? null, null, 'orgB kaydi NULL kalir')
})

// ── 4: NULL-olmayan account scope degistirilmez ─────────────────────────────
test('BKF-4: NULL olmayan marketplaceAccountId DEGISTIRILMEZ', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-4')
  const other = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-OTHER')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'SCOPED' })], { complete: false, marketplaceAccountId: other.id })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'LEG' })], { complete: false })
  await backfill.applyBackfill(db, applyOptions(T(org)))
  const scoped = await db.select().from(schema.orders).where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'SCOPED')))
  assert.equal(scoped[0].marketplaceAccountId, other.id, 'zaten hesapli kayit korunur')
})

// ── 5: ikinci apply idempotent ──────────────────────────────────────────────
test('BKF-5: ikinci apply 0 kayit degistirir (idempotent)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-5')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'L1' })], { complete: false })
  await backfill.applyBackfill(db, applyOptions(T(org)))
  const manifest2 = await backfill.applyBackfill(db, applyOptions(T(org)))
  assert.equal(manifest2.after.scopedOrders, 0, 'ikinci apply hicbir sey degistirmez')
})

// ── 6/7/8: conflict tespiti (order/product/sync-state) + apply durur ────────
test('BKF-6/7/8: order/product/sync-state conflict tespit edilir; apply durur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-6')
  const oldAcc = await accounts.ensureAccount(db, org, 'Trendyol', 'SELLER-OLD')
  // Hedef hesapta ZATEN packageId 'DUP', barcode urun 'DUP-P', sync-state orders var.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'DUP' })], { complete: false, marketplaceAccountId: oldAcc.id })
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'DUP-P', productMainId: 'DUP-PM' })], { complete: false, marketplaceAccountId: oldAcc.id })
  await repo.recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'success', marketplaceAccountId: oldAcc.id })
  // Legacy (NULL) ayni anahtarlar.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'DUP' })], { complete: false })
  await productService.persistProductSyncResult(db, org, [product({ barcode: 'DUP-P', productMainId: 'DUP-PM' })], { complete: false })
  await repo.recordSyncState(db, org, { provider: 'trendyol', resource: 'orders', status: 'partial' })
  const plan = await backfill.planBackfill(db, T(org))
  assert.ok(plan.conflictingOrders >= 1, 'order conflict tespit')
  assert.ok(plan.conflictingProducts >= 1, 'product conflict tespit')
  assert.ok(plan.conflictingSyncStates >= 1, 'sync-state conflict tespit')
  // Apply CONFLICT ile durur; hicbir sey degismez.
  await assert.rejects(
    () => backfill.applyBackfill(db, applyOptions(T(org))),
    (e) => e instanceof backfill.BackfillConflictError,
  )
  const legacyStill = await db.select().from(schema.orders).where(and(eq(schema.orders.organizationId, org), isNull(schema.orders.marketplaceAccountId)))
  assert.ok(legacyStill.length >= 1, 'conflict sonrasi legacy kayit NULL kalir (rollback)')
})

// ── 9: transaction hata → tum rollback (conflict testinde kapsandi, ek: kismi yok)
test('BKF-9: conflict aninda kismi guncelleme OLMAZ (atomic)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-9')
  const oldAcc = await accounts.ensureAccount(db, org, 'Trendyol', 'SELLER-OLD')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'DUP' })], { complete: false, marketplaceAccountId: oldAcc.id })
  // Legacy: biri conflict (DUP), digeri temiz (CLEAN). Atomiklik: CLEAN de baglanmaz.
  await orderService.persistSyncResult(db, org, [order({ packageId: 'DUP' }), order({ packageId: 'CLEAN' })], { complete: false })
  await assert.rejects(() => backfill.applyBackfill(db, applyOptions(T(org))))
  const clean = await db.select().from(schema.orders).where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'CLEAN')))
  assert.equal(clean[0].marketplaceAccountId ?? null, null, 'temiz kayit da baglanmaz (atomic rollback)')
})

// ── 10: yanlis onay token'i reddedilir ──────────────────────────────────────
test('BKF-10: yanlis onay token\'i apply\'i reddeder', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-10')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'L1' })], { complete: false })
  await assert.rejects(
    () => backfill.applyBackfill(db, { ...T(org), confirmationToken: 'WRONG', batchId: randomUUID(), appliedAt: new Date().toISOString() }),
    /Onay token/,
  )
  // Yanlis sellerId -> token yine eslesmez (farkli hedef).
  const wrongTarget = { organizationId: org, marketplace: 'Trendyol', providerAccountId: 'SELLER-WRONG' }
  const opts = { ...wrongTarget, confirmationToken: backfill.computeConfirmationToken(T(org)), batchId: randomUUID(), appliedAt: new Date().toISOString() }
  await assert.rejects(() => backfill.applyBackfill(db, opts), /Onay token/)
})

// ── 11/12/13/14: backfill sonrasi gorunurluk + LABEL_PRINTED + capraz 404 ───
test('BKF-11/12/13/14: eski hesap aktifken gorunur; yeni hesap aktifken gizli; etiket korunur; capraz 404', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-11')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'OLD-1', operationStatus: 'LABEL_PRINTED' }), order({ packageId: 'OLD-2' })], { complete: false })
  const manifest = await backfill.applyBackfill(db, applyOptions(T(org)))
  const oldAccId = manifest.marketplaceAccountId
  // Eski hesabi aktif yap → siparisler + LABEL_PRINTED gorunur.
  await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-OLD')
  const listOld = await orderService.listOrders(db, org, {}, oldAccId)
  assert.deepEqual(listOld.orders.map((o) => o.packageId).sort(), ['OLD-1', 'OLD-2'])
  assert.equal(listOld.orders.find((o) => o.packageId === 'OLD-1').operationStatus, 'LABEL_PRINTED', 'LABEL_PRINTED korunur')
  // Yeni hesap aktif → eski hesap verisi gizli.
  const newAcc = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-NEW')
  const listNew = await orderService.listOrders(db, org, {}, newAcc.id)
  assert.equal(listNew.orders.length, 0, 'yeni hesap eski veriyi gormez')
  // Capraz-hesap: yeni hesap eski siparisin etiketini cozemez (404).
  const [oldRow] = await db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.organizationId, org), eq(schema.orders.packageId, 'OLD-1')))
  const label = await orderService.resolvePersistedLabel(db, org, oldRow.id, newAcc.id)
  assert.equal(label.found, false, 'capraz-hesap etiket 404')
})

// ── 15: rollback dry-run degisiklik yapmaz ──────────────────────────────────
test('BKF-15: rollback dry-run DB\'yi degistirmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-15')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'L1' })], { complete: false })
  const manifest = await backfill.applyBackfill(db, applyOptions(T(org)))
  const plan = await backfill.planRollback(db, manifest)
  assert.equal(plan.willModify, false)
  assert.equal(plan.reversibleOrders, 1)
  assert.equal(plan.safe, true)
  // Hala hedefe bagli (rollback dry-run degistirmedi).
  const [row] = await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))
  assert.equal(row.marketplaceAccountId, manifest.marketplaceAccountId)
})

// ── 16: rollback yalniz o batch'i geri alir; degismis kayit → durur ─────────
test('BKF-16: rollback batch kayitlarini NULL yapar; sonradan degismis kayitta DURUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-16')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'L1' }), order({ packageId: 'L2' })], { complete: false })
  const manifest = await backfill.applyBackfill(db, applyOptions(T(org)))
  // Temiz rollback → NULL'a doner.
  const res = await backfill.applyRollback(db, manifest, new Date().toISOString())
  assert.equal(res.revertedOrders, 2)
  const nulls = await db.select().from(schema.orders).where(and(eq(schema.orders.organizationId, org), isNull(schema.orders.marketplaceAccountId)))
  assert.equal(nulls.length, 2, 'batch kayitlari NULL\'a dondu')

  // Yeni senaryo: apply → sonra bir kayit BASKA islemle degistir → rollback DURUR.
  const org2 = await makeOrg(db, 'bkf-16b')
  await orderService.persistSyncResult(db, org2, [order({ packageId: 'X1' })], { complete: false })
  const m2 = await backfill.applyBackfill(db, applyOptions(T(org2)))
  // Kaydi "baska islemle" degistir (updatedAt degisir).
  await db.update(schema.orders).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(schema.orders.organizationId, org2))
  const plan2 = await backfill.planRollback(db, m2)
  assert.equal(plan2.safe, false, 'degismis kayit safe:false')
  await assert.rejects(() => backfill.applyRollback(db, m2, new Date().toISOString()), /degismis|güvenli değil|guvenli degil/i)
})

// ── 17: migration + backfill legacy fixture uzerinde veri kaybetmez ─────────
test('BKF-17: migration + backfill legacy fixture veri kaybetmez', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'bkf-17')
  // Karisik fixture: legacy NULL + zaten-hesapli + baska org.
  const other = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', 'SELLER-KEEP')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'K1' })], { complete: false, marketplaceAccountId: other.id })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'L1' }), order({ packageId: 'L2' }), order({ packageId: 'L3' })], { complete: false })
  const totalBefore = (await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))).length
  await backfill.applyBackfill(db, applyOptions(T(org)))
  const totalAfter = (await db.select().from(schema.orders).where(eq(schema.orders.organizationId, org))).length
  assert.equal(totalAfter, totalBefore, 'hicbir kayit silinmedi (yalniz scope degisti)')
  // 3 legacy → SELLER-OLD; K1 → SELLER-KEEP korunur.
  const oldAcc = await accounts.getAccountByProviderAccountId(db, org, 'Trendyol', 'SELLER-OLD')
  const oldScoped = await orderService.listOrders(db, org, {}, oldAcc.id)
  assert.equal(oldScoped.total, 3)
  const keepScoped = await orderService.listOrders(db, org, {}, other.id)
  assert.deepEqual(keepScoped.orders.map((o) => o.packageId), ['K1'])
})
