import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// DASHBOARD OPERASYON PROJEKSIYONU — DIFFERENTIAL DOGRULAMA.
//
// AMAC: Dashboard operasyon panellerinin ham 15k/50k siparis dizisine olan
// bagimliligini kaldirabilmek icin sunucunun urettigi asama sayaclarinin,
// ESKI istemci-tarafi tam-dizi hesabiyla BIREBIR ayni oldugunu kanitlamak.
//
// Sunucu IKINCI bir kural seti yazmaz: istemcinin kullandigi kanonik
// classifyOrderForTabs + resolveDashboardOperationStage AYNEN kullanilir.
// Bu paket ikisinin ayni fixture uzerinde ayni sonucu verdigini dogrular.

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const schema = await import('./db/schema.ts')
const service = await import('./orders/orderPersistenceService.ts')
const projection = await import('./orders/orderTabProjection.ts')
const classification = await import('../src/utils/orderClassification.ts')

const nl = (value) => value.split('\r\n').join('\n')
const ENTRY_SOURCE = nl(readFileSync('server/index.mjs', 'utf8'))
const PROJECTION_SOURCE = nl(
  readFileSync('server/orders/orderTabProjection.ts', 'utf8'),
)

const MARKETPLACE = 'Trendyol'
const PROVIDER = 'surat'
// §12'nin istedigi TUM statu varyasyonlari.
const MARKETPLACE_STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
]
const OPERATION_STATUSES = [
  'NEW',
  'LABEL_READY',
  'LABEL_PRINTED',
  'SHIPPED',
  'DELIVERED',
  'ERROR',
  'RETURNING',
]

function migrationStatements() {
  const dir = join(here, '..', 'drizzle')
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push(
      ...readFileSync(join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
  }
  return out
}

/** Statu x operasyon x gonderi x arsiv carpimini kapsayan fixture. */
async function makeMatrixCtx() {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const { encryptShipmentPayload } = await import(
    './shipments/shipmentEncryption.ts'
  )
  const carrierCipher = encryptShipmentPayload({
    labelStatus: 'READY',
    shipmentStatus: 'CREATED',
    dispatchRegistrationConfirmed: true,
    ozelKargoTakipNo: '7270000000000',
  })
  const orgRows = await db.execute(
    sql.raw(
      `insert into organizations (name, slug) values ('Ops','ops-${randomBytes(4).toString('hex')}') returning id`,
    ),
  )
  const organizationId = String(
    (Array.isArray(orgRows) ? orgRows[0] : orgRows.rows[0]).id,
  )
  const accountRows = await db.execute(
    sql.raw(
      `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
       values ('${organizationId}','${MARKETPLACE}','277221',true) returning id`,
    ),
  )
  const marketplaceAccountId = String(
    (Array.isArray(accountRows) ? accountRows[0] : accountRows.rows[0]).id,
  )

  const orderValues = []
  const shipmentValues = []
  const operationValues = []
  let seq = 0
  for (const marketplaceStatus of MARKETPLACE_STATUSES) {
    for (const operationStatus of OPERATION_STATUSES) {
      for (const withShipment of [false, true]) {
        for (const archived of [false, true]) {
          const packageId = `PKG${1_000_000 + seq}`
          const orderDate = new Date(
            Date.UTC(2026, 0, 1, 9, 0, 0) + seq * 60_000,
          ).toISOString()
          orderValues.push(
            `('${randomUUID()}','${organizationId}','${marketplaceAccountId}','${MARKETPLACE}',` +
              `'${packageId}','114${1_000_000 + seq}','${marketplaceStatus}','${operationStatus}',` +
              `'${orderDate}',${archived ? `'${orderDate}'` : 'null'})`,
          )
          if (withShipment) {
            shipmentValues.push(
              `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
                `'${PROVIDER}','local_create','created','727000${seq}','${carrierCipher}')`,
            )
            operationValues.push(
              `('${randomUUID()}','${organizationId}','${MARKETPLACE}','${packageId}',` +
                `'${PROVIDER}','create','idem-${seq}','succeeded','${carrierCipher}')`,
            )
          }
          seq += 1
        }
      }
    }
  }
  await db.execute(
    sql.raw(
      `insert into orders (id, organization_id, marketplace_account_id, marketplace,
         package_id, order_number, marketplace_status, operation_status, order_date, archived_at)
       values ${orderValues.join(',')}`,
    ),
  )
  await db.execute(
    sql.raw(
      `insert into shipments (id, organization_id, marketplace, package_id,
         provider, source, status, tracking_number, carrier_payload_encrypted)
       values ${shipmentValues.join(',')}`,
    ),
  )
  await db.execute(
    sql.raw(
      `insert into shipment_operations (id, organization_id, marketplace,
         package_id, provider, operation_type, idempotency_key, status,
         response_payload_encrypted)
       values ${operationValues.join(',')}`,
    ),
  )
  return { pglite, db, organizationId, marketplaceAccountId, total: seq }
}

/** ESKI YOL: tum siparisleri view-model olarak alip istemci gibi say. */
async function clientSideStageCounts(ctx) {
  const collected = []
  for (let page = 1; ; page += 1) {
    const result = await service.listOrders(
      ctx.db,
      ctx.organizationId,
      { page, pageSize: 100, sort: 'orderDateDesc' },
      ctx.marketplaceAccountId,
    )
    collected.push(...result.orders)
    if (collected.length >= result.total) break
  }
  const counts = {
    open: 0,
    barcodeWaiting: 0,
    labelReady: 0,
    labelPrinted: 0,
    handedToCargo: 0,
    delivered: 0,
    canceledOrReturned: 0,
    archived: 0,
    error: 0,
    unknown: 0,
  }
  const pickingIds = []
  for (const order of collected) {
    const state = classification.classifyOrderForTabs(order)
    counts[classification.resolveDashboardOperationStage(state)] += 1
    if (classification.isPickingEligible(order)) pickingIds.push(String(order.id))
  }
  return { counts, pickingIds, orders: collected }
}

// ═══ DIFFERENTIAL ═════════════════════════════════════════════════════════

test('OPS-DIFF-1: sunucu asama sayaclari ESKI istemci hesabiyla BIREBIR ayni', async () => {
  const ctx = await makeMatrixCtx()
  const server = await projection.loadOperationalProjection(
    ctx.db,
    ctx.organizationId,
    ctx.marketplaceAccountId,
  )
  const client = await clientSideStageCounts(ctx)
  assert.deepEqual(server.stageCounts, client.counts)
  // Fixture anlamli olmali: birden fazla asama dolu.
  const nonZero = Object.values(client.counts).filter((value) => value > 0)
  assert.ok(nonZero.length >= 4, `dolu asama sayisi: ${nonZero.length}`)
  assert.equal(server.totalOrderCount, ctx.total)
  await ctx.pglite.close()
})

test('OPS-DIFF-2: toplama (picking) adaylari BIREBIR ayni kume', async () => {
  const ctx = await makeMatrixCtx()
  const server = await projection.loadTabProjection(
    ctx.db,
    ctx.organizationId,
    {},
    ctx.marketplaceAccountId,
  )
  const client = await clientSideStageCounts(ctx)
  assert.deepEqual(
    [...server.pickingEligibleIds].sort(),
    [...client.pickingIds].sort(),
  )
  await ctx.pglite.close()
})

test('OPS-DIFF-3: arsivli/arsivsiz ayrimi mevcut semantikle korunur', async () => {
  const ctx = await makeMatrixCtx()
  const server = await projection.loadOperationalProjection(
    ctx.db,
    ctx.organizationId,
    ctx.marketplaceAccountId,
  )
  // Fixture'in yarisi arsivli. Arsiv asamasi kanonik siniflandiriciya gore
  // dolmali; liste sorgusu arsivlileri DISLAMAZ (mevcut urun davranisi).
  assert.ok(server.stageCounts.archived > 0, 'arsiv asamasi dolu')
  assert.equal(server.totalOrderCount, ctx.total, 'arsivliler de sayilir')
  await ctx.pglite.close()
})

// ═══ SINIRLILIK (BOUNDEDNESS) ═════════════════════════════════════════════

test('OPS-BOUND-1: yanit SINIRLIDIR — ham tum siparis listesi DONMEZ', async () => {
  const ctx = await makeMatrixCtx()
  const server = await projection.loadOperationalProjection(
    ctx.db,
    ctx.organizationId,
    ctx.marketplaceAccountId,
    null,
    { pickingLimit: 10, recentWindow: 10 },
  )
  assert.ok(
    server.orders.length <= 20,
    `sinirli kume: ${server.orders.length} (tenant toplami ${ctx.total})`,
  )
  assert.ok(server.orders.length < ctx.total, 'tam liste DONMEZ')
  // Sayaclar SINIRDAN ETKILENMEZ (tum kume uzerinden hesaplanir).
  const full = await projection.loadOperationalProjection(
    ctx.db,
    ctx.organizationId,
    ctx.marketplaceAccountId,
  )
  assert.deepEqual(server.stageCounts, full.stageCounts)
  assert.equal(server.totalOrderCount, full.totalOrderCount)
  // Kirpma DURUSTCE bildirilir.
  assert.equal(typeof server.truncated, 'boolean')
  await ctx.pglite.close()
})

test('OPS-BOUND-2: sinirli kume tam view-model tasir (paneller calisir)', async () => {
  const ctx = await makeMatrixCtx()
  const server = await projection.loadOperationalProjection(
    ctx.db,
    ctx.organizationId,
    ctx.marketplaceAccountId,
    null,
    { pickingLimit: 5, recentWindow: 5 },
  )
  assert.ok(server.orders.length > 0)
  for (const order of server.orders) {
    assert.ok(order.id)
    assert.ok(order.orderNumber)
    assert.ok(Array.isArray(order.items))
    // Ham ZPL ISTEMCIYE DONMEZ (mevcut sozlesme).
    assert.equal('technicalZpl' in order, false)
  }
  await ctx.pglite.close()
})

// ═══ IZOLASYON + SOZLESME ═════════════════════════════════════════════════

test('OPS-SCOPE-1: hesap kapsami ve tenant izolasyonu KORUNUR', async () => {
  const ctx = await makeMatrixCtx()
  const otherAccount = await ctx.db.execute(
    sql.raw(
      `insert into marketplace_accounts (organization_id, marketplace, provider_account_id, is_active)
       values ('${ctx.organizationId}','${MARKETPLACE}','999999',false) returning id`,
    ),
  )
  const otherId = String(
    (Array.isArray(otherAccount) ? otherAccount[0] : otherAccount.rows[0]).id,
  )
  await ctx.db.execute(
    sql.raw(
      `insert into orders (organization_id, marketplace_account_id, marketplace,
         package_id, order_number, marketplace_status, order_date)
       values ('${ctx.organizationId}','${otherId}','${MARKETPLACE}','OTHER-1','114999','Created','2026-01-01T09:00:00Z')`,
    ),
  )
  const scoped = await projection.loadOperationalProjection(
    ctx.db,
    ctx.organizationId,
    ctx.marketplaceAccountId,
  )
  assert.equal(scoped.totalOrderCount, ctx.total, 'baska hesap SIZMAZ')
  await ctx.pglite.close()
})

test('OPS-CONTRACT: uc salt okunur ve KANONIK siniflandiriciyi kullanir', () => {
  assert.ok(ENTRY_SOURCE.includes("app.get('/api/dashboard/operational'"))
  const block = ENTRY_SOURCE.slice(
    ENTRY_SOURCE.indexOf("app.get('/api/dashboard/operational'"),
    ENTRY_SOURCE.indexOf("app.post('/api/orders/external-processing'"),
  )
  // Aktif hesap kapsami zorunlu.
  assert.ok(block.includes('context.marketplaceAccountId'))
  // Yazma/provider cagrisi YOK.
  for (const forbidden of ['.insert(', '.update(', '.delete(', 'callTrendyol']) {
    assert.equal(block.includes(forbidden), false, forbidden)
  }
  // Sunucu kanonik siniflandiriciyi AYNEN kullanir; kural kopyalamaz.
  assert.ok(
    PROJECTION_SOURCE.includes('resolveDashboardOperationStage('),
  )
  assert.ok(PROJECTION_SOURCE.includes('isPickingEligible('))
  assert.equal(PROJECTION_SOURCE.includes('stageCounts.delivered ='), false)
})
