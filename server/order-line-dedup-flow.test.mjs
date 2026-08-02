import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { and, eq } from 'drizzle-orm'

// order_line DUPLICATION kök neden + düzeltme testleri. Kök neden: normal sync
// externalLineId'yi `ty_line_<id>`, historical backfill `<id>` üretir → AYNI
// provider satırı iki farklı anahtara düşer ve persistence yalnız upsert yapıp
// stale satırı SİLMEZ → duplicate. Düzeltme: canonical yol-bağımsız
// externalLineId + reconcile-delete + account-scoped repair CLI.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const schema = await import('./db/schema.ts')
const accounts = await import('./integrations/marketplaceAccountRepository.ts')
const orderService = await import('./orders/orderPersistenceService.ts')
const mapper = await import('./orders/orderMapper.ts')
const repair = await import('./orders/orderLineRepair.ts')
const fetchMod = await import('./trendyol/historicalOrderFetch.ts')
const recon = await import('./analytics/orderReconciliation.ts')
const integrity = await import('../src/utils/orderLineIntegrity.ts')

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
    orderNumber: over.orderNumber ?? `ORD-${seq}`,
    marketplaceStatus: over.marketplaceStatus ?? 'Delivered',
    operationStatus: over.operationStatus,
    totalAmount: over.totalAmount ?? 1889, currency: 'TRY',
    orderDate: over.orderDate ?? '2026-07-10T08:00:00Z', rawOrder: {},
    items: over.items,
    ...over,
  }
}
async function linesOf(db, org) {
  return db.select().from(schema.orderLines).where(eq(schema.orderLines.organizationId, org))
}
const secilLine = (id) => ({ id, barcode: 'BX', merchantSku: 'SECIL-3346', quantity: 1, price: 1889, productName: 'Ürün' })

// ── Persistence idempotency ─────────────────────────────────────────────────

test('OLD-1: aynı sync İKİ KEZ → duplicate YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-1')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const o = order({ packageId: 'P1', items: [secilLine('ty_line_999')] })
  await orderService.persistSyncResult(db, org, [o], { complete: false, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org, [o], { complete: false, marketplaceAccountId: a.id })
  assert.equal((await linesOf(db, org)).length, 1, 'tek satır')
})

test('OLD-2: aynı historical backfill İKİ KEZ → duplicate YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-2')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const normalized = fetchMod.normalizeHistoricalPackage({
    shipmentPackageId: 'P1', orderNumber: 'O1', status: 'Delivered', grossAmount: 1889,
    orderDate: '2026-07-10T08:00:00Z',
    lines: [{ id: 999, barcode: 'BX', merchantSku: 'SECIL-3346', quantity: 1, price: 1889, productName: 'Ürün' }],
  })
  await orderService.persistSyncResult(db, org, [normalized], { complete: false, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org, [normalized], { complete: false, marketplaceAccountId: a.id })
  assert.equal((await linesOf(db, org)).length, 1, 'tek satır')
})

test('OLD-3: cross-path (normal ty_line_X sonra backfill X) → AYNI canonical anahtar, duplicate YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-3')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  // Normal sync: ty_line_999
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', items: [secilLine('ty_line_999')] })], { complete: false, marketplaceAccountId: a.id })
  // Backfill: 999 (aynı provider satırı, ön eksiz)
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', items: [secilLine('999')] })], { complete: false, marketplaceAccountId: a.id })
  const lines = await linesOf(db, org)
  assert.equal(lines.length, 1, 'cross-path tek satır')
  assert.equal(lines[0].externalLineId, '999', 'canonical anahtar (ty_line_ soyulmuş)')
})

test('OLD-4: id-siz satır deterministik içerik anahtarı → cross-persist duplicate YOK', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-4')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const noId = { id: '', barcode: 'BX', merchantSku: 'SECIL-3346', quantity: 1, price: 1889, productName: 'Ürün' }
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', items: [{ ...noId }] })], { complete: false, marketplaceAccountId: a.id })
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', items: [{ ...noId }] })], { complete: false, marketplaceAccountId: a.id })
  const lines = await linesOf(db, org)
  assert.equal(lines.length, 1, 'içerik hash anahtarı stabil')
  assert.match(String(lines[0].externalLineId), /^ck_/, 'content-hash anahtarı')
})

test('OLD-5: gerçek quantity=2 KORUNUR (birleştirme yok)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-5')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', totalAmount: 3778, items: [{ id: 'ty_line_5', barcode: 'BX', merchantSku: 'SECIL-3346', quantity: 2, price: 1889, productName: 'Ürün' }] })], { complete: false, marketplaceAccountId: a.id })
  const lines = await linesOf(db, org)
  assert.equal(lines.length, 1)
  assert.equal(Number(lines[0].quantity), 2, 'quantity=2 korunur')
})

test('OLD-6: aynı üründen İKİ GERÇEK provider satırı (farklı line id) KORUNUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-6')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', totalAmount: 3778, items: [secilLine('ty_line_1'), secilLine('ty_line_2')] })], { complete: false, marketplaceAccountId: a.id })
  const lines = await linesOf(db, org)
  assert.equal(lines.length, 2, 'iki gerçek satır korunur (barcode-only dedupe YOK)')
})

test('OLD-7: provider satırı kaldırılırsa reconcile-delete eski satırı temizler', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-7')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', items: [secilLine('ty_line_1'), secilLine('ty_line_2')] })], { complete: false, marketplaceAccountId: a.id })
  // Sonraki sync tek satır → diğer satır stale, silinmeli
  await orderService.persistSyncResult(db, org, [order({ packageId: 'P1', items: [secilLine('ty_line_1')] })], { complete: false, marketplaceAccountId: a.id })
  assert.equal((await linesOf(db, org)).length, 1, 'stale satır temizlendi')
})

// ── Repair CLI ──────────────────────────────────────────────────────────────

async function seedLegacyDuplicate(db, org, accountId, over = {}) {
  const [o] = await db.insert(schema.orders).values({
    organizationId: org, marketplaceAccountId: accountId, marketplace: 'Trendyol',
    packageId: over.packageId ?? 'PDUP', orderNumber: over.orderNumber ?? 'ODUP',
    totalAmount: '1889', operationStatus: over.operationStatus ?? null,
    orderDate: new Date('2026-07-10'),
  }).returning()
  await db.insert(schema.orderLines).values([
    { organizationId: org, orderId: o.id, externalLineId: 'ty_line_999', merchantSku: 'SECIL-3346', barcode: 'BX', productName: 'Ürün', quantity: 1, unitPrice: '1889', lineTotal: '1889' },
    { organizationId: org, orderId: o.id, externalLineId: '999', merchantSku: 'SECIL-3346', barcode: 'BX', productName: 'Ürün', quantity: 1, unitPrice: '1889', lineTotal: '1889' },
  ])
  return o
}

test('OLD-8: repair — kanıtlanmış duplicate 2→1 (dry-run + apply); gerçek satır korunur', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-8')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const o1 = await seedLegacyDuplicate(db, org, a.id, { packageId: 'P1', orderNumber: 'O1' })
  // Gerçek iki satır (farklı provider id) — dokunulmamalı
  const [o2] = await db.insert(schema.orders).values({ organizationId: org, marketplaceAccountId: a.id, marketplace: 'Trendyol', packageId: 'P2', orderNumber: 'O2', totalAmount: '200', orderDate: new Date('2026-07-11') }).returning()
  await db.insert(schema.orderLines).values([
    { organizationId: org, orderId: o2.id, externalLineId: 'ty_line_1', merchantSku: 'A', barcode: 'B', productName: 'Ürün', quantity: 1, unitPrice: '100', lineTotal: '100' },
    { organizationId: org, orderId: o2.id, externalLineId: 'ty_line_2', merchantSku: 'A', barcode: 'B', productName: 'Ürün', quantity: 1, unitPrice: '100', lineTotal: '100' },
  ])
  const { plan } = await repair.planOrderLineRepair(db, { organizationId: org, marketplaceAccountId: a.id })
  assert.equal(plan.affectedOrderCount, 1)
  assert.equal(plan.duplicateLineCount, 1)
  assert.equal(plan.conflictCount, 0)
  assert.equal(plan.amountBefore, 3978, 'tüm satır lineTotal toplamı (3778 dup + 200 gerçek)')
  assert.equal(plan.amountAfter, 2089, 'duplicate lineTotal (1889) düşülür')
  assert.equal(plan.willModify, false)
  const manifest = await repair.applyOrderLineRepair(db, { organizationId: org, marketplaceAccountId: a.id }, { confirmationToken: plan.confirmationToken, batchId: 'b', appliedAt: '2026-07-29T00:00:00Z' })
  assert.equal(manifest.deletedLineCount, 1)
  const dupLines = await db.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, o1.id))
  assert.equal(dupLines.length, 1, 'duplicate 2→1')
  assert.equal(dupLines[0].externalLineId, '999', 'canonical satır korunur')
  const genuineLines = await db.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, o2.id))
  assert.equal(genuineLines.length, 2, 'gerçek iki satır korunur')
})

test('OLD-9: repair — içerik farklı aynı-anahtar grubu CONFLICT (silinmez)', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-9')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  const [o] = await db.insert(schema.orders).values({ organizationId: org, marketplaceAccountId: a.id, marketplace: 'Trendyol', packageId: 'P1', orderNumber: 'O1', totalAmount: '300', orderDate: new Date('2026-07-10') }).returning()
  // Aynı canonical anahtar (ty_line_7 vs 7) ama FARKLI içerik (sku/price)
  await db.insert(schema.orderLines).values([
    { organizationId: org, orderId: o.id, externalLineId: 'ty_line_7', merchantSku: 'A', barcode: 'B', productName: 'Ürün', quantity: 1, unitPrice: '100', lineTotal: '100' },
    { organizationId: org, orderId: o.id, externalLineId: '7', merchantSku: 'DIFFERENT', barcode: 'C', productName: 'Ürün', quantity: 1, unitPrice: '200', lineTotal: '200' },
  ])
  const { plan } = await repair.planOrderLineRepair(db, { organizationId: org, marketplaceAccountId: a.id })
  assert.equal(plan.duplicateLineCount, 0, 'içerik farkı → silinmez')
  assert.equal(plan.conflictCount, 1, 'conflict raporlanır')
})

test('OLD-10: repair — yanlış token reddedilir', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-10')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await seedLegacyDuplicate(db, org, a.id)
  await assert.rejects(
    () => repair.applyOrderLineRepair(db, { organizationId: org, marketplaceAccountId: a.id }, { confirmationToken: 'WRONG', batchId: 'b', appliedAt: 'x' }),
    /token/i,
  )
  assert.equal((await linesOf(db, org)).length, 2, 'reddedilince satırlar korunur')
})

test('OLD-11: repair — account + tenant isolation; totalAmount/operationStatus/LABEL KORUNUR', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org1 = await makeOrg(db, 'old-11a')
  const org2 = await makeOrg(db, 'old-11b')
  const a = await accounts.resolveOrCreateActiveAccount(db, org1, 'Trendyol', '277221')
  const b = await accounts.resolveOrCreateActiveAccount(db, org1, 'Trendyol', 'OTHER')
  const c = await accounts.resolveOrCreateActiveAccount(db, org2, 'Trendyol', '277221')
  const target = await seedLegacyDuplicate(db, org1, a.id, { packageId: 'PA', orderNumber: 'OA', operationStatus: 'LABEL_PRINTED' })
  await seedLegacyDuplicate(db, org1, b.id, { packageId: 'PB', orderNumber: 'OB' }) // başka account
  await seedLegacyDuplicate(db, org2, c.id, { packageId: 'PC', orderNumber: 'OC' }) // başka tenant
  const { plan } = await repair.planOrderLineRepair(db, { organizationId: org1, marketplaceAccountId: a.id })
  assert.equal(plan.affectedOrderCount, 1, 'yalnız hedef account')
  await repair.applyOrderLineRepair(db, { organizationId: org1, marketplaceAccountId: a.id }, { confirmationToken: plan.confirmationToken, batchId: 'b', appliedAt: 'x' })
  // Hedef: 1 satır; totalAmount + operationStatus KORUNUR
  const [targetRow] = await db.select().from(schema.orders).where(eq(schema.orders.id, target.id))
  assert.equal(Number(targetRow.totalAmount), 1889, 'totalAmount değişmez')
  assert.equal(targetRow.operationStatus, 'LABEL_PRINTED', 'operationStatus/LABEL korunur')
  // Başka account/tenant DOKUNULMAZ (hâlâ 2 satır)
  assert.equal((await db.select().from(schema.orderLines).where(and(eq(schema.orderLines.organizationId, org1), eq(schema.orderLines.orderId, (await db.select().from(schema.orders).where(and(eq(schema.orders.organizationId, org1), eq(schema.orders.marketplaceAccountId, b.id))))[0].id)))).length, 2, 'başka account korunur')
  assert.equal((await db.select().from(schema.orderLines).where(eq(schema.orderLines.organizationId, org2))).length, 2, 'başka tenant korunur')
})

test('OLD-12: repair sonrası Dashboard line/quantity metriği DOĞRU', async (t) => {
  const { pglite, db } = await makeDb()
  t.after(() => pglite.close())
  const org = await makeOrg(db, 'old-12')
  const a = await accounts.resolveOrCreateActiveAccount(db, org, 'Trendyol', '277221')
  await seedLegacyDuplicate(db, org, a.id)
  const july = { startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Date.parse('2026-07-31T23:59:59Z') }
  const before = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, ...july })
  assert.equal(before.orderLineCount, 2, 'repair öncesi 2 (duplicate)')
  const { plan } = await repair.planOrderLineRepair(db, { organizationId: org, marketplaceAccountId: a.id })
  await repair.applyOrderLineRepair(db, { organizationId: org, marketplaceAccountId: a.id }, { confirmationToken: plan.confirmationToken, batchId: 'b', appliedAt: 'x' })
  const after = await recon.reconcileLocalOrders(db, { organizationId: org, marketplaceAccountId: a.id, ...july })
  assert.equal(after.orderLineCount, 1, 'repair sonrası 1 kalem')
  assert.equal(after.lineQuantityTotal, 1, 'adet 1')
})

// ── canonical key + UI diagnostic ───────────────────────────────────────────

test('OLD-13: canonicalLineKey yol-bağımsız (ty_line_X == X); id-siz içerik hash', () => {
  assert.equal(mapper.canonicalLineKey({ id: 'ty_line_999' }, 0), '999')
  assert.equal(mapper.canonicalLineKey({ id: '999' }, 0), '999', 'iki yol AYNI anahtar')
  const k1 = mapper.canonicalLineKey({ id: '', merchantSku: 'S', barcode: 'B', price: 10 }, 0)
  const k2 = mapper.canonicalLineKey({ id: '', merchantSku: 'S', barcode: 'B', price: 10 }, 0)
  assert.equal(k1, k2, 'içerik hash deterministik')
  assert.match(k1, /^ck_/)
})

test('OLD-14: UI diagnostic — duplicate + aşırı lineTotal → suspectedDuplicate; sağlıklı sipariş temiz', () => {
  const dup = integrity.detectOrderLineDuplication({
    totalAmount: 1889,
    items: [
      { id: 'ty_line_999', merchantSku: 'SECIL-3346', barcode: 'BX', price: 1889, quantity: 1 },
      { id: '999', merchantSku: 'SECIL-3346', barcode: 'BX', price: 1889, quantity: 1 },
    ],
  })
  assert.equal(dup.suspectedDuplicate, true)
  assert.equal(dup.duplicateKeyCount, 1)
  assert.equal(dup.lineTotalSum, 3778)
  const healthy = integrity.detectOrderLineDuplication({
    totalAmount: 3778,
    items: [
      { id: 'ty_line_1', merchantSku: 'A', barcode: 'B', price: 1889, quantity: 1 },
      { id: 'ty_line_2', merchantSku: 'A', barcode: 'B', price: 1889, quantity: 1 },
    ],
  })
  assert.equal(healthy.suspectedDuplicate, false, 'gerçek iki satır şüpheli değil')
})
