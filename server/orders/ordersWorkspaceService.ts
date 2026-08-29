// SİPARİŞ ÇALIŞMA ALANI SERVİSİ — sunucu tarafı projeksiyon + revizyon cache.
//
// ═══ NEDEN SUNUCUDA ══════════════════════════════════════════════════════
// Siparişler ekranının görünür listesi SQL ile ifade EDİLEMEZ: sekme
// sınıflandırıcıları (barkod bekliyor / doğrulama bekliyor / etiket hazır),
// Sürat ZPL doğrulaması, ürün-ailesi gruplaması ve tr-TR (numeric)
// karşılaştırma saf TypeScript kurallarıdır. Bunları SQL'e çevirmek
// CEVAPLARI DEĞİŞTİRİRDİ.
//
// Bu yüzden AYNI saf projeksiyon (`buildOrdersWorkspaceResult`) DB'nin
// yanında çalıştırılır ve tarayıcıya YALNIZ istenen sayfa + sayaçlar iner.
// Parite inşa gereği sağlanır: tek fonksiyon, tek davranış.
//
// ═══ NEDEN REVİZYON CACHE (TTL DEĞİL) ════════════════════════════════════
// Sayfa/sekme/filtre değişiminde tüm tabloyu yeniden okumak israftır. Ama
// süre tabanlı bir TTL, başka bir süreçte (PM2 cluster) yapılan bir create
// sonrası BAYAT liste gösterebilirdi. Bunun yerine cache anahtarı DB'den
// türetilir: ilgili tabloların satır sayısı + en son updated_at damgası.
// Ucuz bir aggregate sorgu değişiklik olup olmadığını KESİN söyler; hiçbir
// yazım kaçırılmaz ve süreçler arası bayatlama OLMAZ.

import { sql } from 'drizzle-orm'
import {
  buildOrdersWorkspaceResult,
  type OrdersWorkspaceQuery,
  type OrdersWorkspaceResult,
} from '../../src/utils/ordersWorkspaceQuery.ts'
import { withDerivedOperationStatus } from '../../src/utils/orderStatus.ts'
import { applyExternalProcessingState } from '../../src/utils/externalProcessing.ts'
import { dedupeOrdersByPackageIdentity } from '../../src/utils/orderCounts.ts'
import { getExternalProcessing } from './externalProcessingRepository.ts'
import { listOrdersForWorkspace } from './orderPersistenceService.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

type OrderRecord = Record<string, unknown>

interface CacheEntry {
  revision: string
  orders: OrderRecord[]
}

const cache = new Map<string, CacheEntry>()

/** En fazla kaç organizasyonun tam listesi bellekte tutulur. */
const MAX_CACHED_SCOPES = 8

function scopeKey(
  organizationId: string,
  marketplaceAccountId: string | null | undefined,
): string {
  return `${organizationId}|${marketplaceAccountId ?? 'legacy-null'}`
}

/**
 * DB'den türetilen revizyon damgası.
 *
 * Görünür listeyi ETKİLEYEN her tablo dahildir: siparişler, sipariş
 * satırları, gönderiler ve gönderi operasyonları. Biri değişirse damga
 * değişir ve tam liste yeniden okunur.
 */
export async function readWorkspaceRevision(
  db: Db,
  organizationId: string,
): Promise<string> {
  const rows = await db.execute(sql`
    select
      (select count(*) from orders where organization_id = ${organizationId}) as order_count,
      (select max(updated_at) from orders where organization_id = ${organizationId}) as order_max,
      (select count(*) from order_lines where organization_id = ${organizationId}) as line_count,
      (select max(updated_at) from order_lines where organization_id = ${organizationId}) as line_max,
      (select count(*) from shipments where organization_id = ${organizationId}) as shipment_count,
      (select max(updated_at) from shipments where organization_id = ${organizationId}) as shipment_max,
      (select count(*) from shipment_operations where organization_id = ${organizationId}) as operation_count,
      (select max(updated_at) from shipment_operations where organization_id = ${organizationId}) as operation_max
  `)
  const row = (Array.isArray(rows) ? rows[0] : rows?.rows?.[0]) ?? {}
  return [
    row.order_count, row.order_max,
    row.line_count, row.line_max,
    row.shipment_count, row.shipment_max,
    row.operation_count, row.operation_max,
  ]
    .map((value) => (value instanceof Date ? value.toISOString() : String(value ?? '')))
    .join('|')
}

/** Test ve tanı için: cache'i tamamen boşaltır. */
export function resetOrdersWorkspaceCache(): void {
  cache.clear()
}

export interface OrdersWorkspaceLoad {
  orders: OrderRecord[]
  revision: string
  cacheHit: boolean
}

/**
 * Hesap-kapsamlı TAM listeyi (view-model) getirir; revizyon değişmediyse
 * bellekten döner. Bu liste ASLA istemciye gönderilmez — yalnız sunucu
 * içinde projeksiyona girer.
 */
export async function loadWorkspaceOrders(
  db: Db,
  organizationId: string,
  marketplaceAccountId?: string | null,
): Promise<OrdersWorkspaceLoad> {
  const key = scopeKey(organizationId, marketplaceAccountId)
  const revision = await readWorkspaceRevision(db, organizationId)
  const cached = cache.get(key)
  if (cached && cached.revision === revision) {
    return { orders: cached.orders, revision, cacheHit: true }
  }
  const orders = await listOrdersForWorkspace(
    db,
    organizationId,
    marketplaceAccountId,
  )
  if (cache.size >= MAX_CACHED_SCOPES && !cache.has(key)) {
    // En eski kapsamı düşür — sınırsız bellek büyümesi YOK.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { revision, orders })
  return { orders, revision, cacheHit: false }
}

export interface OrdersWorkspacePage extends OrdersWorkspaceResult {
  revision: string
  cacheHit: boolean
  /** Projeksiyona giren kayıt sayısı — ölçüm/telemetri için. */
  scannedOrders: number
}

/**
 * İSTEMCİ TÜRETMELERİNİN AYNISI — parite için ZORUNLU.
 *
 * Tarayıcı `/api/orders` yanıtını ham kullanmıyordu: her siparişe
 * `withDerivedOperationStatus` uygular, yerel harici-işlem arşiv bayrağını
 * damgalar ve paket kimliğine göre tekilleştirirdi. Sekme sınıflandırıcıları
 * TAM OLARAK bu türetilmiş alanları okur.
 *
 * Sunucu bu üç adımı atlasaydı aynı sipariş iki tarafta FARKLI sekmede
 * görünürdü. Bu yüzden adımlar burada, projeksiyondan ÖNCE, aynı saf
 * fonksiyonlarla uygulanır.
 */
export function projectClientDerivedOrders(
  orders: OrderRecord[],
  externalProcessing: unknown,
): OrderRecord[] {
  const derived = (orders as never[]).map((order) =>
    withDerivedOperationStatus(order),
  )
  const stamped = applyExternalProcessingState(
    derived,
    externalProcessing as never,
  )
  return dedupeOrdersByPackageIdentity(stamped) as unknown as OrderRecord[]
}

export async function buildOrdersWorkspacePage(
  db: Db,
  organizationId: string,
  query: OrdersWorkspaceQuery,
  marketplaceAccountId?: string | null,
  now: Date = new Date(),
): Promise<OrdersWorkspacePage & { externalProcessing: unknown }> {
  const load = await loadWorkspaceOrders(db, organizationId, marketplaceAccountId)
  const externalProcessing = await getExternalProcessing(db, organizationId)
  const projected = projectClientDerivedOrders(load.orders, externalProcessing)
  const result = buildOrdersWorkspaceResult(projected as never, query, now)
  return {
    ...result,
    externalProcessing,
    revision: load.revision,
    cacheHit: load.cacheHit,
    scannedOrders: load.orders.length,
  }
}
