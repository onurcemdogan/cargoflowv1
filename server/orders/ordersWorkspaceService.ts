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
  /**
   * İSTEMCİ TÜRETMELERİ UYGULANMIŞ liste (bkz. projectClientDerivedOrders).
   *
   * ═══ NEDEN AYRICA ÖNBELLEKLENİR ════════════════════════════════════════
   * Türetme her istekte YENİ nesneler üretiyordu; sınıflandırma/doğrulama
   * hafızaları nesne kimliğine bağlı olduğundan her istekte SIFIRDAN
   * ısınıyordu. ÖLÇÜLDÜ (gerçek Postgres, 2.000 sipariş): sayfa başına
   * ~220 ms saf Node projeksiyonu — ham liste zaten önbellekteyken.
   *
   * Türetme, (ham liste + harici-işlem durumu) ikilisinin SAF fonksiyonudur;
   * ikisi de değişmediyse sonucun değişmesi mümkün DEĞİLDİR. Bu yüzden
   * türetilmiş liste de aynı revizyon altında saklanır ve nesne kimlikleri
   * korunur.
   */
  projected: OrderRecord[]
  /** Türetmenin bağlı olduğu harici-işlem durumunun imzası. */
  externalSignature: string
}

const cache = new Map<string, CacheEntry>()

/** Baslangic sentinel'i: hicbir gercek imza bos dize DEGILDIR. */
const NO_SIGNATURE = ''

/** En fazla kaç organizasyonun tam listesi bellekte tutulur. */
const MAX_CACHED_SCOPES = 8

/**
 * TOPLAM ÖNBELLEK BÜTÇESİ — sipariş SAYISI cinsinden.
 *
 * ═══ NEDEN KAPSAM SAYISI YETMEZ ══════════════════════════════════════════
 * Yalnız kapsam sayısıyla sınırlamak, KAYIT BÜYÜKLÜĞÜNÜ görmezden gelir:
 * 8 küçük kiracı ile 8 tane 25.000 siparişli kiracı aynı sayılırdı.
 *
 * ÖLÇÜLDÜ (gerçek Postgres, 25.000 sipariş, --expose-gc ile canlı heap):
 * ham liste ~67 MB, türetilmiş liste ~50 MB → kapsam başına ~117 MB.
 * Yalnız kapsam sınırıyla en kötü durum ~940 MB TUTULAN heap demekti.
 *
 * Bütçe sipariş sayısına bağlanır: ~60.000 sipariş ≈ 280 MB tutulan heap.
 * Bütçe aşılırsa EN ESKİ kapsamlar düşürülür; yeni yüklenen kapsam HER
 * ZAMAN kalır (aksi halde onu tekrar okumak gerekirdi).
 *
 * Bu bir DOĞRULUK sınırı değildir: düşen kapsam bir sonraki istekte DB'den
 * yeniden okunur. Revizyon damgası hâlâ tek otoritedir; bayat liste dönmez.
 */
const MAX_CACHED_ORDERS = 60_000

/**
 * Etkin bütçe. YALNIZ testler düşürür: tahliyeyi 60.000 gerçek sipariş
 * tohumlamadan kanıtlayabilmek için. Üretimde HİÇBİR yol bunu değiştirmez.
 */
let maxCachedOrders = MAX_CACHED_ORDERS

/** YALNIZ TEST: bütçeyi geçici olarak değiştirir. */
export function setMaxCachedOrdersForTest(value: number): void {
  maxCachedOrders = value > 0 ? value : MAX_CACHED_ORDERS
}

/** Önbellekte tutulan toplam sipariş (ham + türetilmiş AYNI sayıda). */
export function cachedWorkspaceOrderCount(): number {
  let total = 0
  for (const entry of cache.values()) total += entry.orders.length
  return total
}

/**
 * Yeni kapsam eklenmeden ÖNCE yer açar.
 *
 * `cache` bir Map'tir ve ekleme sırasını korur; en eski anahtar ilk sıradadır.
 * Okuma isabetinde kayıt yeniden eklendiği için sıra LRU'ya yakındır.
 */
function evictForIncoming(incomingKey: string, incomingCount: number): void {
  cache.delete(incomingKey)
  while (
    cache.size > 0 &&
    (cache.size >= MAX_CACHED_SCOPES ||
      cachedWorkspaceOrderCount() + incomingCount > maxCachedOrders)
  ) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

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

/** Harici-işlem durumunun ucuz, kararlı imzası. */
function externalProcessingSignature(state: unknown): string {
  const entries = (state as { entries?: Record<string, unknown> })?.entries ?? {}
  const keys = Object.keys(entries).sort()
  return `${keys.length}|${keys.join(',')}`
}

/** Test ve tanı için: cache'i tamamen boşaltır. */
export function resetOrdersWorkspaceCache(): void {
  cache.clear()
  maxCachedOrders = MAX_CACHED_ORDERS
}

export interface OrdersWorkspaceLoad {
  orders: OrderRecord[]
  revision: string
  cacheHit: boolean
  /** Revizyon damgası sorgusu + (gerekirse) tam okuma süresi (ms). */
  dbMs: number
  /** Node'a gerçekten OKUNAN satır sayısı (cache HIT'te 0). */
  rowsReadIntoNode: number
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
  // ÖLÇÜM: DB'de geçen süre ile Node'da geçen projeksiyon süresi AYRI
  // raporlanır. "Yavaş" demek yetmez; darboğazın hangi tarafta olduğunu
  // ölçmeden doğru düzeltme seçilemez.
  const dbStarted = Date.now()
  const revision = await readWorkspaceRevision(db, organizationId)
  const cached = cache.get(key)
  if (cached && cached.revision === revision) {
    // LRU tazeleme: isabet eden kapsam sıranın SONUNA taşınır, böylece
    // etkin kullanılan kiracı, atıl bir kiracı yüzünden düşmez.
    cache.delete(key)
    cache.set(key, cached)
    return {
      orders: cached.orders,
      revision,
      cacheHit: true,
      dbMs: Date.now() - dbStarted,
      rowsReadIntoNode: 0,
    }
  }
  
  const orders = await listOrdersForWorkspace(
    db,
    organizationId,
    marketplaceAccountId,
  )
  // Sınırsız bellek büyümesi YOK: hem kapsam SAYISI hem toplam sipariş
  // HACMİ sınırlıdır (bkz. MAX_CACHED_ORDERS).
  evictForIncoming(key, orders.length)
  cache.set(key, {
    revision,
    orders,
    projected: [],
    // Hicbir GERCEK imzayla eslesemeyecek sentinel: gercek imzalar
    // "<sayi>|..." bicimindedir ve bos dize OLAMAZ. Bu yuzden ilk
    // projectedWorkspaceOrders cagrisi MUTLAKA yeniden turetir.
    externalSignature: NO_SIGNATURE,
  })
  return {
    orders,
    revision,
    cacheHit: false,
    dbMs: Date.now() - dbStarted,
    rowsReadIntoNode: orders.length,
  }
}

/**
 * TÜRETİLMİŞ listeyi revizyon altında yeniden kullanır.
 *
 * Nesne kimlikleri korunduğu için sınıflandırma/doğrulama/kimlik hafızaları
 * istekler arasında SICAK kalır. Ham liste veya harici-işlem durumu
 * değiştiyse yeniden türetilir — bayat sonuç DÖNMEZ.
 */
export function projectedWorkspaceOrders(
  organizationId: string,
  marketplaceAccountId: string | null | undefined,
  load: OrdersWorkspaceLoad,
  externalProcessing: unknown,
): OrderRecord[] {
  const key = scopeKey(organizationId, marketplaceAccountId)
  const signature = externalProcessingSignature(externalProcessing)
  const entry = cache.get(key)
  if (
    entry &&
    entry.revision === load.revision &&
    entry.orders === load.orders &&
    entry.externalSignature === signature &&
    entry.projected.length > 0
  ) {
    return entry.projected
  }
  const projected = projectClientDerivedOrders(load.orders, externalProcessing)
  if (entry && entry.revision === load.revision) {
    entry.projected = projected
    entry.externalSignature = signature
  }
  return projected
}

export interface OrdersWorkspacePage extends OrdersWorkspaceResult {
  revision: string
  cacheHit: boolean
  /** Projeksiyona giren kayıt sayısı — ölçüm/telemetri için. */
  scannedOrders: number
  /** DB'de geçen süre (ms). */
  dbMs: number
  /** Node'da saf projeksiyonda geçen süre (ms). */
  projectionMs: number
  /** Bu istekte DB'den Node'a okunan satır (cache HIT'te 0). */
  rowsReadIntoNode: number
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
  const externalStarted = Date.now()
  const externalProcessing = await getExternalProcessing(db, organizationId)
  const externalMs = Date.now() - externalStarted
  const projectionStarted = Date.now()
  const projected = projectedWorkspaceOrders(
    organizationId,
    marketplaceAccountId,
    load,
    externalProcessing,
  )
  const result = buildOrdersWorkspaceResult(projected as never, query, now)
  const projectionMs = Date.now() - projectionStarted
  return {
    ...result,
    externalProcessing,
    revision: load.revision,
    cacheHit: load.cacheHit,
    scannedOrders: load.orders.length,
    dbMs: load.dbMs + externalMs,
    projectionMs,
    rowsReadIntoNode: load.rowsReadIntoNode,
  }
}
