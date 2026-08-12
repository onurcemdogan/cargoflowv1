import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { isNull } from 'drizzle-orm'

// TRENDYOL ÇALIŞMA ZAMANI: NULL HESAP KAPSAMLI YAZMA ÖNLEME.
//
// KOK NEDEN (kanitlandi): resolveActiveMarketplaceAccountId (a) aktif hesap
// yoksa ve (b) HERHANGI bir hatada (`catch { return null }`) null donuyordu;
// bu deger persistSyncResult -> upsertMarketplaceOrders(..., null) zincirine
// ulasip NULL kapsamli golge satirlar uretiyordu.
//
// ULASILABILIR NULL YAZARLAR (once): manual_sync · background_sync ·
// stale_open_reconcile.
//
// Mevcut 334 NULL satira DOKUNULMAZ; bu paket YALNIZ yeni NULL satir
// olusmasini engelleyen sozlesmeyi kilitler.

const here = dirname(fileURLToPath(import.meta.url))
const schema = await import('./db/schema.ts')
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')
process.env.SHIPMENT_ENCRYPTION_KEY = randomBytes(32).toString('hex')
const service = await import('./orders/orderPersistenceService.ts')

const { orders, organizations, marketplaceAccounts } = schema
const ENTRY_SOURCE = readFileSync('server/index.mjs', 'utf8').split('\r\n').join('\n')

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

async function makeCtx({ withActiveAccount = true } = {}) {
  const pglite = new PGlite()
  for (const statement of migrationStatements()) await pglite.exec(statement)
  const db = drizzle(pglite, { schema })
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Org', slug: `org-${randomBytes(4).toString('hex')}` })
    .returning({ id: organizations.id })
  let accountId = null
  if (withActiveAccount) {
    const [account] = await db
      .insert(marketplaceAccounts)
      .values({
        organizationId: org.id,
        marketplace: 'Trendyol',
        providerAccountId: '277221',
        isActive: true,
      })
      .returning({ id: marketplaceAccounts.id })
    accountId = account.id
  }
  return { db, organizationId: org.id, accountId }
}

const incoming = () => [
  {
    marketplace: 'Trendyol',
    packageId: '4028055254',
    shipmentPackageId: '4028055254',
    externalOrderId: '4028055254',
    orderNumber: '11448183224',
    marketplaceStatus: 'Delivered',
    orderDate: '2026-07-26T10:00:00.000Z',
    customerFirstName: 'T',
    items: [],
  },
]

const countNullRows = async (db) => {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(isNull(orders.marketplaceAccountId))
  return rows.length
}

/**
 * Çalışma zamanı yazma yolunun ÖZÜ: hesap kapsamı çözülür, `ok` değilse
 * persist ÇAĞRILMAZ. `index.mjs`teki üç yol da bu deseni uygular
 * (aşağıda kaynak sözleşmesiyle doğrulanır).
 */
async function runtimeSync(ctx, resolveScope) {
  const scope = await resolveScope()
  if (scope.status !== 'ok') {
    return { persisted: false, reason: scope.status }
  }
  await service.persistSyncResult(ctx.db, ctx.organizationId, incoming(), {
    complete: false,
    fetchedCount: 1,
    marketplaceAccountId: scope.accountId,
    requireMarketplaceAccount: true,
  })
  return { persisted: true, reason: null }
}

const okScope = (ctx) => async () => ({ status: 'ok', accountId: ctx.accountId })
const noAccountScope = () => async () => ({
  status: 'no_active_account',
  accountId: null,
})
const errorScope = () => async () => ({
  status: 'account_resolution_error',
  accountId: null,
})

// ═══ MANUEL SYNC ══════════════════════════════════════════════════════════

test('NULL-WRITE-1: aktif hesap varsa kapsamli persistence CALISIR', async () => {
  const ctx = await makeCtx()
  const result = await runtimeSync(ctx, okScope(ctx))
  assert.equal(result.persisted, true)
  const [row] = await ctx.db
    .select({ marketplaceAccountId: orders.marketplaceAccountId })
    .from(orders)
  assert.equal(row.marketplaceAccountId, ctx.accountId)
  assert.equal(await countNullRows(ctx.db), 0)
})

test('NULL-WRITE-2: aktif hesap YOKSA yazma YOK (4xx sozlesmesi)', async () => {
  const ctx = await makeCtx({ withActiveAccount: false })
  const result = await runtimeSync(ctx, noAccountScope())
  assert.equal(result.persisted, false)
  assert.equal(result.reason, 'no_active_account')
  assert.equal(await countNullRows(ctx.db), 0)
  // Manuel uc: aktif hesap yoksa 409, cozumleme hatasinda 503.
  assert.ok(ENTRY_SOURCE.includes("code: accountScope.status"))
  assert.ok(ENTRY_SOURCE.includes('response.status(resolutionError ? 503 : 409)'))
})

test('NULL-WRITE-3: resolver HATA verirse yazma YOK (5xx sozlesmesi)', async () => {
  const ctx = await makeCtx()
  const result = await runtimeSync(ctx, errorScope())
  assert.equal(result.persisted, false)
  assert.equal(result.reason, 'account_resolution_error')
  assert.equal(await countNullRows(ctx.db), 0)
})

// ═══ ARKA PLAN + STALE ════════════════════════════════════════════════════

test('NULL-WRITE-4/5/6: arka plan turu kapsam yoksa ATLAR, dusmez', () => {
  const lines = ENTRY_SOURCE.split('\n')
  const start = lines.findIndex((line) =>
    line.startsWith('async function syncTrendyolOrdersForOrganization'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('resolveActiveMarketplaceAccountScope('))
  assert.ok(body.includes("if (accountScope.status !== 'ok')"))
  assert.ok(body.includes('return { synced: false, skipped: accountScope.status }'))
  assert.ok(body.includes('requireMarketplaceAccount: true'))
  // Tur hatasi zamanlayiciyi dusurmez (mevcut fail-open korunur).
  assert.ok(ENTRY_SOURCE.includes('FAIL-OPEN: bir organizasyon hata verirse'))
})

test('NULL-WRITE-7/8: stale mutabakati kapsam yoksa persist ETMEZ', () => {
  const lines = ENTRY_SOURCE.split('\n')
  const start = lines.findIndex((line) =>
    line.startsWith('async function reconcileStaleOpenForOrganization'),
  )
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  assert.ok(body.includes('resolveActiveMarketplaceAccountScope('))
  assert.ok(body.includes("if (accountScope.status !== 'ok')"))
  assert.ok(body.includes('return empty'))
  assert.ok(body.includes('requireMarketplaceAccount: true'))
})

// ═══ DERINLEMESINE SAVUNMA ════════════════════════════════════════════════

test('NULL-WRITE-9: persist guard NULL hesabi REDDEDER (DB yazmasi YOK)', async () => {
  const ctx = await makeCtx()
  await assert.rejects(
    () =>
      service.persistSyncResult(ctx.db, ctx.organizationId, incoming(), {
        complete: false,
        fetchedCount: 1,
        marketplaceAccountId: null,
        requireMarketplaceAccount: true,
      }),
    /marketplace_account_required/,
  )
  assert.equal(await countNullRows(ctx.db), 0, 'hicbir satir yazilmadi')
  const all = await ctx.db.select({ id: orders.id }).from(orders)
  assert.equal(all.length, 0)
})

test('NULL-WRITE-10: cevrimdisi/legacy araclar ETKILENMEDI', async () => {
  const ctx = await makeCtx()
  // Bayrak VERILMEZSE legacy (hesapsiz) kapsama yazma hala mumkun.
  const result = await service.persistSyncResult(
    ctx.db,
    ctx.organizationId,
    incoming(),
    { complete: false, fetchedCount: 1, marketplaceAccountId: null },
  )
  assert.equal(result.persistedCount, 1)
  assert.equal(await countNullRows(ctx.db), 1, 'legacy yol korunur')

  // Tarihsel backfill ve legacy import bayragi KULLANMAZ.
  const backfill = readFileSync('server/orders/historicalOrderBackfill.ts', 'utf8')
  assert.equal(backfill.includes('requireMarketplaceAccount'), false)
  const legacyImport = readFileSync('server/orders/importLegacyOrders.ts', 'utf8')
  assert.equal(legacyImport.includes('requireMarketplaceAccount'), false)
})

// ═══ SOZLESME ═════════════════════════════════════════════════════════════

test('NULL-WRITE-11: basarili senkron hala AKTIF hesap kimligini kullanir', async () => {
  const ctx = await makeCtx()
  await runtimeSync(ctx, okScope(ctx))
  const rows = await ctx.db
    .select({ marketplaceAccountId: orders.marketplaceAccountId })
    .from(orders)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].marketplaceAccountId, ctx.accountId)
})

test('NULL-WRITE-12: hicbir hata yolu NULL kapsamli siparis URETMEZ', async () => {
  const ctx = await makeCtx()
  for (const scope of [noAccountScope(), errorScope()]) {
    const result = await runtimeSync(ctx, scope)
    assert.equal(result.persisted, false)
  }
  assert.equal(await countNullRows(ctx.db), 0)
})

test('NULL-WRITE-RESOLVER: hata SESSIZCE null a cevrilmez', () => {
  const lines = ENTRY_SOURCE.split('\n')
  const start = lines.findIndex((line) =>
    line.startsWith('async function resolveActiveMarketplaceAccountScope'),
  )
  assert.ok(start >= 0, 'ayirt edilebilir cozumleyici bulunmali')
  const end = lines.findIndex((line, index) => index > start && line === '}')
  const body = lines.slice(start, end).join('\n')
  // Iki durum AYRISTIRILIR.
  assert.ok(body.includes("status: 'ok'"))
  assert.ok(body.includes("status: 'no_active_account'"))
  assert.ok(body.includes("status: 'account_resolution_error'"))
  // Gozlemlenebilir: sebep loglanir, secret YOK.
  assert.ok(body.includes('[account-scope]'))
  for (const forbidden of ['apiKey', 'apiSecret', 'credential', 'customer']) {
    assert.equal(body.includes(forbidden), false, forbidden)
  }
  // OKUMA yolu icin legacy yardimci KORUNUR (null donebilir).
  assert.ok(
    ENTRY_SOURCE.includes('async function resolveActiveMarketplaceAccountId'),
  )
})

test('NULL-WRITE-SCOPE: mevcut sozlesmeler KORUNUR', () => {
  // Tek-ucus, retry, complete:false ve statu esleme DEGISMEDI.
  assert.ok(ENTRY_SOURCE.includes('waitForSyncFlight('))
  assert.ok(ENTRY_SOURCE.includes('beginSyncFlight(flightKey)'))
  assert.ok(ENTRY_SOURCE.includes('async function retryTrendyolStatusPass'))
  assert.ok(ENTRY_SOURCE.includes('complete: false'))
  assert.ok(
    ENTRY_SOURCE.includes('const marketplaceStatus = normalizeStatus(item.status)'),
  )
  // Mevcut NULL satirlar icin silme/arsivleme EKLENMEDI.
  for (const forbidden of ['delete(orders)', 'NULL_SHADOW_CLEANUP']) {
    assert.equal(ENTRY_SOURCE.includes(forbidden), false, forbidden)
  }
})
