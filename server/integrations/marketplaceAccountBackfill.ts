// Legacy (marketplaceAccountId IS NULL) kayıtları OPERATÖRÜN AÇIKÇA verdiği bir
// pazaryeri hesabına (organizationId + marketplace + providerAccountId/sellerId)
// bağlayan güvenli backfill çekirdeği. HİÇBİR hesabı TAHMİN ETMEZ: aktif hesap,
// orderNumber, packageId, 727 referansı, tarih, müşteri veya kargo firması ile
// otomatik eşleştirme YAPILMAZ. Yalnız NULL kayıtları hedefe çevirir; NULL
// OLMAYAN hiçbir kaydı değiştirmez; başka tenant'a dokunmaz; conflict varsa
// durur; tek transaction'da uygular (hata → tüm ROLLBACK). Idempotent.
import { createHash } from 'node:crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  integrationSyncState,
  orders,
  products,
} from '../db/schema.ts'
import {
  ensureAccount,
  getAccountByProviderAccountId,
  type MarketplaceAccount,
} from './marketplaceAccountRepository.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

const SYNC_PROVIDER = 'trendyol'

export interface BackfillTarget {
  organizationId: string
  marketplace: string
  providerAccountId: string
}

export interface BackfillPlan {
  organizationId: string
  marketplace: string
  targetProviderAccountId: string
  targetMarketplaceAccountId: string | null
  targetAccountIsActive: boolean | null
  targetAccountExists: boolean
  legacyOrdersFound: number
  legacyProductsFound: number
  legacySyncStatesFound: number
  alreadyScopedOrders: number
  alreadyScopedProducts: number
  conflictingOrders: number
  conflictingProducts: number
  conflictingSyncStates: number
  eligibleOrders: number
  eligibleProducts: number
  eligibleSyncStates: number
  confirmationToken: string
  willModify: false
}

// Onay token'ı: hedefin (org|marketplace|providerAccountId) SHA-256 türevi. Gizli
// veya PII İÇERMEZ (sellerId gizli değildir); yanlış argümanla apply'ı engeller.
export function computeConfirmationToken(target: BackfillTarget): string {
  return createHash('sha256')
    .update(`${target.organizationId}|${target.marketplace}|${target.providerAccountId}`)
    .digest('hex')
    .slice(0, 16)
}

function checksumOf(ids: string[]): string {
  return createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 16)
}

// Legacy NULL sipariş/ürün/sync-state kayıtlarını (org + kapsam) okur.
async function legacyOrderRows(db: Db, org: string, marketplace: string) {
  return db
    .select({ id: orders.id, packageId: orders.packageId })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, org),
        eq(orders.marketplace, marketplace),
        isNull(orders.marketplaceAccountId),
      ),
    )
}
async function legacyProductRows(db: Db, org: string, marketplace: string) {
  return db
    .select({ id: products.id, externalProductId: products.externalProductId })
    .from(products)
    .where(
      and(
        eq(products.organizationId, org),
        eq(products.marketplace, marketplace),
        isNull(products.marketplaceAccountId),
      ),
    )
}
async function legacySyncStateRows(db: Db, org: string) {
  return db
    .select({
      id: integrationSyncState.id,
      provider: integrationSyncState.provider,
      resource: integrationSyncState.resource,
    })
    .from(integrationSyncState)
    .where(
      and(
        eq(integrationSyncState.organizationId, org),
        eq(integrationSyncState.provider, SYNC_PROVIDER),
        isNull(integrationSyncState.marketplaceAccountId),
      ),
    )
}

// Hedef hesap altında ZATEN var olan (org, account, marketplace, packageId /
// externalProductId) ve (org, account, provider, resource) anahtarlarını çıkarır;
// legacy NULL kaydın bu anahtarı taşıması APPLY'da unique ihlali (conflict) olur.
async function targetOrderKeys(db: Db, org: string, marketplace: string, accountId: string) {
  const rows = await db
    .select({ packageId: orders.packageId })
    .from(orders)
    .where(
      and(
        eq(orders.organizationId, org),
        eq(orders.marketplace, marketplace),
        eq(orders.marketplaceAccountId, accountId),
      ),
    )
  return new Set(rows.map((r: { packageId: string }) => String(r.packageId)))
}
async function targetProductKeys(db: Db, org: string, marketplace: string, accountId: string) {
  const rows = await db
    .select({ externalProductId: products.externalProductId })
    .from(products)
    .where(
      and(
        eq(products.organizationId, org),
        eq(products.marketplace, marketplace),
        eq(products.marketplaceAccountId, accountId),
      ),
    )
  return new Set(rows.map((r: { externalProductId: string }) => String(r.externalProductId)))
}
async function targetSyncStateKeys(db: Db, org: string, accountId: string) {
  const rows = await db
    .select({ provider: integrationSyncState.provider, resource: integrationSyncState.resource })
    .from(integrationSyncState)
    .where(
      and(
        eq(integrationSyncState.organizationId, org),
        eq(integrationSyncState.marketplaceAccountId, accountId),
      ),
    )
  return new Set(rows.map((r: { provider: string; resource: string }) => `${r.provider}|${r.resource}`))
}

// DRY-RUN: DB'yi DEĞİŞTİRMEZ (yalnız okur). Hedef hesap yoksa targetAccountExists
// false döner; bu durumda conflict olamaz (o account id ile kayıt yok).
export async function planBackfill(db: Db, target: BackfillTarget): Promise<BackfillPlan> {
  const account = await getAccountByProviderAccountId(
    db,
    target.organizationId,
    target.marketplace,
    target.providerAccountId,
  )
  const [legacyOrders, legacyProducts, legacySync] = await Promise.all([
    legacyOrderRows(db, target.organizationId, target.marketplace),
    legacyProductRows(db, target.organizationId, target.marketplace),
    legacySyncStateRows(db, target.organizationId),
  ])

  let conflictingOrders = 0
  let conflictingProducts = 0
  let conflictingSyncStates = 0
  let alreadyScopedOrders = 0
  let alreadyScopedProducts = 0
  if (account) {
    const [oKeys, pKeys, sKeys] = await Promise.all([
      targetOrderKeys(db, target.organizationId, target.marketplace, account.id),
      targetProductKeys(db, target.organizationId, target.marketplace, account.id),
      targetSyncStateKeys(db, target.organizationId, account.id),
    ])
    alreadyScopedOrders = oKeys.size
    alreadyScopedProducts = pKeys.size
    conflictingOrders = legacyOrders.filter((r: { packageId: string }) =>
      oKeys.has(String(r.packageId)),
    ).length
    conflictingProducts = legacyProducts.filter((r: { externalProductId: string }) =>
      pKeys.has(String(r.externalProductId)),
    ).length
    conflictingSyncStates = legacySync.filter((r: { provider: string; resource: string }) =>
      sKeys.has(`${r.provider}|${r.resource}`),
    ).length
  }

  return {
    organizationId: target.organizationId,
    marketplace: target.marketplace,
    targetProviderAccountId: target.providerAccountId,
    targetMarketplaceAccountId: account ? account.id : null,
    targetAccountIsActive: account ? account.isActive : null,
    targetAccountExists: Boolean(account),
    legacyOrdersFound: legacyOrders.length,
    legacyProductsFound: legacyProducts.length,
    legacySyncStatesFound: legacySync.length,
    alreadyScopedOrders,
    alreadyScopedProducts,
    conflictingOrders,
    conflictingProducts,
    conflictingSyncStates,
    eligibleOrders: legacyOrders.length - conflictingOrders,
    eligibleProducts: legacyProducts.length - conflictingProducts,
    eligibleSyncStates: legacySync.length - conflictingSyncStates,
    confirmationToken: computeConfirmationToken(target),
    willModify: false,
  }
}

export interface BackfillManifestSection {
  count: number
  checksum: string
  items: { id: string; updatedAt: string }[]
}
export interface BackfillManifest {
  batchId: string
  organizationId: string
  marketplace: string
  providerAccountId: string
  marketplaceAccountId: string
  appliedAt: string
  orders: BackfillManifestSection
  products: BackfillManifestSection
  syncStates: BackfillManifestSection
  before: { legacyOrders: number; legacyProducts: number; legacySyncStates: number }
  after: { scopedOrders: number; scopedProducts: number; scopedSyncStates: number }
}

export class BackfillConflictError extends Error {
  conflicts: { orders: number; products: number; syncStates: number }
  constructor(
    message: string,
    conflicts: { orders: number; products: number; syncStates: number },
  ) {
    super(message)
    this.name = 'BackfillConflictError'
    this.conflicts = conflicts
  }
}

export interface ApplyOptions extends BackfillTarget {
  confirmationToken: string
  batchId: string
  appliedAt: string
}

// APPLY: tek transaction. Onay token'ı doğrulanır; hedef hesap garanti edilir
// (yoksa PASİF oluşturulur — aktif hesabı değiştirmez); conflict varsa TÜM işlem
// durur (rollback). Yalnız NULL kayıtlar hedefe çevrilir. Manifest döner.
export async function applyBackfill(db: Db, options: ApplyOptions): Promise<BackfillManifest> {
  const expected = computeConfirmationToken(options)
  if (options.confirmationToken !== expected) {
    throw new Error(
      'Onay token\'ı hedefle (org|marketplace|providerAccountId) eşleşmiyor; apply reddedildi.',
    )
  }
  const appliedAtDate = new Date(options.appliedAt)

  return db.transaction(async (tx: Db) => {
    const account = await ensureAccount(
      tx,
      options.organizationId,
      options.marketplace,
      options.providerAccountId,
    )
    // Conflict kontrolü transaction İÇİNDE tekrar yapılır (yarış güvenli).
    const [legacyOrders, legacyProducts, legacySync] = await Promise.all([
      legacyOrderRows(tx, options.organizationId, options.marketplace),
      legacyProductRows(tx, options.organizationId, options.marketplace),
      legacySyncStateRows(tx, options.organizationId),
    ])
    const [oKeys, pKeys, sKeys] = await Promise.all([
      targetOrderKeys(tx, options.organizationId, options.marketplace, account.id),
      targetProductKeys(tx, options.organizationId, options.marketplace, account.id),
      targetSyncStateKeys(tx, options.organizationId, account.id),
    ])
    const conflictOrders = legacyOrders.filter((r: { packageId: string }) =>
      oKeys.has(String(r.packageId)),
    ).length
    const conflictProducts = legacyProducts.filter((r: { externalProductId: string }) =>
      pKeys.has(String(r.externalProductId)),
    ).length
    const conflictSync = legacySync.filter((r: { provider: string; resource: string }) =>
      sKeys.has(`${r.provider}|${r.resource}`),
    ).length
    if (conflictOrders > 0 || conflictProducts > 0 || conflictSync > 0) {
      throw new BackfillConflictError(
        'Account-scoped unique conflict tespit edildi; otomatik merge/delete YOK. İşlem durduruldu.',
        { orders: conflictOrders, products: conflictProducts, syncStates: conflictSync },
      )
    }

    // Yalnız NULL kayıtları hedefe çevir; her tabloda RETURNING ile id+updatedAt.
    const updatedOrders =
      legacyOrders.length > 0
        ? await tx
            .update(orders)
            .set({ marketplaceAccountId: account.id, updatedAt: appliedAtDate })
            .where(
              and(
                eq(orders.organizationId, options.organizationId),
                eq(orders.marketplace, options.marketplace),
                isNull(orders.marketplaceAccountId),
              ),
            )
            .returning({ id: orders.id, updatedAt: orders.updatedAt })
        : []
    const updatedProducts =
      legacyProducts.length > 0
        ? await tx
            .update(products)
            .set({ marketplaceAccountId: account.id, updatedAt: appliedAtDate })
            .where(
              and(
                eq(products.organizationId, options.organizationId),
                eq(products.marketplace, options.marketplace),
                isNull(products.marketplaceAccountId),
              ),
            )
            .returning({ id: products.id, updatedAt: products.updatedAt })
        : []
    const updatedSync =
      legacySync.length > 0
        ? await tx
            .update(integrationSyncState)
            .set({ marketplaceAccountId: account.id, updatedAt: appliedAtDate })
            .where(
              and(
                eq(integrationSyncState.organizationId, options.organizationId),
                eq(integrationSyncState.provider, SYNC_PROVIDER),
                isNull(integrationSyncState.marketplaceAccountId),
              ),
            )
            .returning({ id: integrationSyncState.id, updatedAt: integrationSyncState.updatedAt })
        : []

    const section = (rows: { id: string; updatedAt: Date | string }[]): BackfillManifestSection => {
      const items = rows.map((r) => ({
        id: String(r.id),
        updatedAt: (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString(),
      }))
      return { count: items.length, checksum: checksumOf(items.map((i) => i.id)), items }
    }
    return {
      batchId: options.batchId,
      organizationId: options.organizationId,
      marketplace: options.marketplace,
      providerAccountId: options.providerAccountId,
      marketplaceAccountId: account.id,
      appliedAt: options.appliedAt,
      orders: section(updatedOrders),
      products: section(updatedProducts),
      syncStates: section(updatedSync),
      before: {
        legacyOrders: legacyOrders.length,
        legacyProducts: legacyProducts.length,
        legacySyncStates: legacySync.length,
      },
      after: {
        scopedOrders: updatedOrders.length,
        scopedProducts: updatedProducts.length,
        scopedSyncStates: updatedSync.length,
      },
    }
  })
}

export interface RollbackPlan {
  batchId: string
  marketplaceAccountId: string
  reversibleOrders: number
  reversibleProducts: number
  reversibleSyncStates: number
  modifiedSinceOrders: number
  modifiedSinceProducts: number
  modifiedSinceSyncStates: number
  safe: boolean
  willModify: false
}

// Bir kaydın backfill'den beri DEĞİŞMEDEN kaldığını doğrular: hâlâ hedef hesapta
// VE updatedAt manifest'teki değerle aynı. Sonradan başka işlemle değişmişse
// (re-sync, elle) rollback o kaydı geri alamaz.
async function classifyRollback(
  db: Db,
  manifest: BackfillManifest,
): Promise<{
  orders: { reversible: string[]; modified: string[] }
  products: { reversible: string[]; modified: string[] }
  syncStates: { reversible: string[]; modified: string[] }
}> {
  const target = manifest.marketplaceAccountId
  const classify = async (
    table: any,
    section: BackfillManifestSection,
  ): Promise<{ reversible: string[]; modified: string[] }> => {
    const reversible: string[] = []
    const modified: string[] = []
    if (section.items.length === 0) return { reversible, modified }
    const byId = new Map(section.items.map((i) => [i.id, i.updatedAt]))
    const rows = await db
      .select({ id: table.id, accountId: table.marketplaceAccountId, updatedAt: table.updatedAt })
      .from(table)
      .where(inArray(table.id, [...byId.keys()]))
    const seen = new Set<string>()
    for (const row of rows) {
      const id = String(row.id)
      seen.add(id)
      const recorded = byId.get(id)
      const currentUpdated = (row.updatedAt instanceof Date
        ? row.updatedAt
        : new Date(row.updatedAt)
      ).toISOString()
      if (String(row.accountId ?? '') === target && currentUpdated === recorded) {
        reversible.push(id)
      } else {
        modified.push(id)
      }
    }
    // Manifest'te olup DB'de bulunmayan (silinmiş) kayıtlar da "değişmiş" sayılır.
    for (const id of byId.keys()) if (!seen.has(id)) modified.push(id)
    return { reversible, modified }
  }
  return {
    orders: await classify(orders, manifest.orders),
    products: await classify(products, manifest.products),
    syncStates: await classify(integrationSyncState, manifest.syncStates),
  }
}

export async function planRollback(db: Db, manifest: BackfillManifest): Promise<RollbackPlan> {
  const c = await classifyRollback(db, manifest)
  const modified =
    c.orders.modified.length + c.products.modified.length + c.syncStates.modified.length
  return {
    batchId: manifest.batchId,
    marketplaceAccountId: manifest.marketplaceAccountId,
    reversibleOrders: c.orders.reversible.length,
    reversibleProducts: c.products.reversible.length,
    reversibleSyncStates: c.syncStates.reversible.length,
    modifiedSinceOrders: c.orders.modified.length,
    modifiedSinceProducts: c.products.modified.length,
    modifiedSinceSyncStates: c.syncStates.modified.length,
    safe: modified === 0,
    willModify: false,
  }
}

export interface RollbackResult {
  batchId: string
  revertedOrders: number
  revertedProducts: number
  revertedSyncStates: number
}

// APPLY ROLLBACK: yalnız bu batch'in NULL→target çevirdiği ve O ZAMANDAN BERİ
// DEĞİŞMEMİŞ kayıtları tekrar NULL yapar (tek transaction). Sonradan değişmiş
// (başka işlem) kayıt varsa TÜM işlem durur (rollback) ve raporlanır.
export async function applyRollback(
  db: Db,
  manifest: BackfillManifest,
  now: string,
): Promise<RollbackResult> {
  return db.transaction(async (tx: Db) => {
    const c = await classifyRollback(tx, manifest)
    const modified =
      c.orders.modified.length + c.products.modified.length + c.syncStates.modified.length
    if (modified > 0) {
      throw new Error(
        `Rollback durduruldu: ${modified} kayıt backfill'den beri başka işlemle değişmiş; ` +
          'otomatik geri alma güvenli değil.',
      )
    }
    const nowDate = new Date(now)
    const revert = async (table: any, ids: string[]): Promise<number> => {
      if (ids.length === 0) return 0
      const reverted = await tx
        .update(table)
        .set({ marketplaceAccountId: null, updatedAt: nowDate })
        .where(
          and(
            inArray(table.id, ids),
            eq(table.marketplaceAccountId, manifest.marketplaceAccountId),
          ),
        )
        .returning({ id: table.id })
      return reverted.length
    }
    const revertedOrders = await revert(orders, c.orders.reversible)
    const revertedProducts = await revert(products, c.products.reversible)
    const revertedSyncStates = await revert(integrationSyncState, c.syncStates.reversible)
    return {
      batchId: manifest.batchId,
      revertedOrders,
      revertedProducts,
      revertedSyncStates,
    }
  })
}

export type { MarketplaceAccount }
