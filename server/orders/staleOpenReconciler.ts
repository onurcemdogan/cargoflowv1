// ═══ ESKİ AÇIK KAYIT MUTABAKATI (BOUNDED STALE-OPEN RECONCILE) ════════════
//
// ÜRETİM BULGUSU (CASE OLD-B). Arka plan Trendyol turu tarih parametresi
// GÖNDERMEZ; `callTrendyolOrders` varsayılanı SON 7 GÜNDÜR. Manuel "Şimdi
// Yenile" ise 30 günlük pencere gönderir. Bu yüzden 7 günden eski, hâlâ
// operasyonel olarak AÇIK (LABEL_READY / LABEL_PRINTED) kayıtlar arka plan
// turunun kapsamına HİÇ girmez: pazaryeri statüleri Delivered olsa bile DB'de
// `Picking` kalır ve sipariş süresiz açık görünür.
//
// ÇÖZÜM: tüm geçmişi her turda çekmek DEĞİL. DB'den YALNIZ açık ve eskimiş
// adaylar SINIRLI bir batch hâlinde seçilir; her aday, KANITLI salt-okunur
// `orderNumber` sorgu sözleşmesiyle doğrulanır ve sonuç KANONİK zincire
// (normalizeTrendyolOrders → persistSyncResult) verilir.
//
// BU MODÜLDE İŞ KURALI YOKTUR:
//   · yeni statü eşlemesi YOK · yeni persistence YOK · yeni kolon YOK
//   · Sürat/SSP YOK · etiket/print YOK · retention politikası DEĞİŞMEZ
// Sorgu ve kalıcılaştırma DIŞARIDAN enjekte edilir.
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { orders } from '../db/schema.ts'
import { MARKETPLACE_FORWARD_STATUSES } from './orderRetention.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/**
 * OPERASYONEL OLARAK AÇIK sayılan canonical durumlar. Bunlar CargoFlow'un
 * "iş bitmedi" dediği kayıtlardır; pazaryeri statüsü terminal hâle geldiğinde
 * ilerlemeleri gerekir. Daha erken aşamalar (henüz etiket üretilmemiş) zaten
 * aktif pencerededir ve ana tur onları kapsar.
 */
export const OPEN_OPERATION_STATUSES = ['LABEL_READY', 'LABEL_PRINTED'] as const

export interface StaleReconcilePolicy {
  enabled: boolean
  /** Bir turda doğrulanacak EN FAZLA aday sayısı. */
  batchSize: number
  /** Aynı anda kaç aday sorgulanır. */
  concurrency: number
  /** Bu yaştan ESKİ kayıtlar aday olur (ana turun penceresi dışı). */
  staleAfterMs: number
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

/**
 * Bu geçiş ZATEN kapılı olan arka plan turunun İÇİNDE çalışır
 * (TRENDYOL_STATUS_SYNC_ENABLED). Ayrıca açık bir kapatma anahtarı vardır:
 * TRENDYOL_STALE_RECONCILE_ENABLED=false|0 → geçiş HİÇ çalışmaz.
 */
export function resolveStaleReconcilePolicy(
  env: Record<string, string | undefined> = process.env,
): StaleReconcilePolicy {
  const raw = String(env.TRENDYOL_STALE_RECONCILE_ENABLED ?? '')
    .trim()
    .toLowerCase()
  return {
    enabled: raw !== 'false' && raw !== '0',
    // Tavan SERT: tur başına istek sayısı öngörülebilir kalmalı.
    batchSize: Math.min(50, positiveInt(env.TRENDYOL_STALE_RECONCILE_BATCH, 20)),
    concurrency: Math.min(
      4,
      positiveInt(env.TRENDYOL_STALE_RECONCILE_CONCURRENCY, 2),
    ),
    // Ana tur son 7 günü kapsar; 6 gün eşiği 1 günlük GÜVENLİ örtüşme bırakır
    // (pencere sınırında kayıt kaçmasın).
    staleAfterMs: Math.max(
      24 * 60 * 60 * 1000,
      positiveInt(
        env.TRENDYOL_STALE_RECONCILE_AFTER_MS,
        6 * 24 * 60 * 60 * 1000,
      ),
    ),
  }
}

export interface StaleOpenCandidate {
  id: string
  orderNumber: string
  packageId: string
  orderDate: Date
  marketplaceStatus: string | null
  operationStatus: string | null
}

/** Keyset (cursor) konumu: aynı adaylar her turda tekrar seçilmesin diye. */
export interface StaleCursor {
  orderDate: Date
  id: string
}

/**
 * ADAY YÜKLEMİ (SALT OKUMA):
 *   arşivlenmemiş
 *   AND operation_status ∈ {LABEL_READY, LABEL_PRINTED}
 *   AND (marketplace_status IS NULL OR ileri/terminal statülerden DEĞİL)
 *   AND order_date < staleBefore          (ana turun penceresi dışında)
 *   AND (order_date, id) > cursor         (keyset ilerleme)
 * Hesap kapsamı ana turla AYNIDIR; başka hesabın kaydı ASLA seçilmez.
 */
export async function findStaleOpenCandidates(
  db: Db,
  input: {
    organizationId: string
    marketplaceAccountId: string | null
    limit: number
    staleBefore: Date
    cursor?: StaleCursor | null
  },
): Promise<StaleOpenCandidate[]> {
  const accountScope =
    input.marketplaceAccountId == null
      ? isNull(orders.marketplaceAccountId)
      : eq(orders.marketplaceAccountId, input.marketplaceAccountId)
  const clauses = [
    eq(orders.organizationId, input.organizationId),
    accountScope,
    isNull(orders.archivedAt),
    sql`${orders.operationStatus} in ${OPEN_OPERATION_STATUSES}`,
    sql`(${orders.marketplaceStatus} is null or ${orders.marketplaceStatus} not in ${MARKETPLACE_FORWARD_STATUSES})`,
    lt(orders.orderDate, input.staleBefore),
  ]
  if (input.cursor) {
    clauses.push(
      or(
        gt(orders.orderDate, input.cursor.orderDate),
        and(
          eq(orders.orderDate, input.cursor.orderDate),
          gt(orders.id, input.cursor.id),
        ),
      )!,
    )
  }
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      packageId: orders.packageId,
      orderDate: orders.orderDate,
      marketplaceStatus: orders.marketplaceStatus,
      operationStatus: orders.operationStatus,
    })
    .from(orders)
    .where(and(...clauses))
    .orderBy(asc(orders.orderDate), asc(orders.id))
    .limit(Math.max(1, input.limit))
  return rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    orderNumber: String(row.orderNumber ?? ''),
    packageId: String(row.packageId ?? ''),
    orderDate: row.orderDate as Date,
    marketplaceStatus: (row.marketplaceStatus as string | null) ?? null,
    operationStatus: (row.operationStatus as string | null) ?? null,
  }))
}

/**
 * Bir sonraki turun başlangıç konumu. Batch dolmadıysa (liste bitti) cursor
 * SIFIRLANIR → sıradaki tur baştan başlar. Böylece Trendyol hâlâ `Picking`
 * diyen bir aday kuyruğun başında TAKILI KALIP diğerlerini AÇ BIRAKMAZ.
 */
export function advanceCursor(
  candidates: readonly StaleOpenCandidate[],
  batchSize: number,
): StaleCursor | null {
  if (candidates.length === 0 || candidates.length < batchSize) return null
  const last = candidates[candidates.length - 1]
  return { orderDate: last.orderDate, id: last.id }
}

export interface StaleReconcileReport {
  scanned: number
  queried: number
  persisted: number
  failed: number
  skipped: number
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const current = index
      index += 1
      if (current >= items.length) return
      results[current] = await worker(items[current])
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * SINIRLI bir mutabakat turu.
 *
 * `queryCandidate` KANONİK salt-okunur Trendyol `orderNumber` sorgusudur ve
 * HAM paket kayıtlarını döner. `persistPackages` KANONİK zincirdir
 * (normalizeTrendyolOrders → persistSyncResult, aktif hesap kapsamıyla).
 * Bu modül İKİSİNİ DE UYGULAMAZ — yalnız sırayı ve sınırı yönetir.
 *
 * FAIL-OPEN: bir adayın sorgusu/kalıcılaştırması başarısız olursa O KAYIT
 * DEĞİŞMEZ ve tur diğer adaylarla DEVAM eder.
 */
export async function reconcileStaleOpenOrders(
  policy: StaleReconcilePolicy,
  candidates: readonly StaleOpenCandidate[],
  queryCandidate: (candidate: StaleOpenCandidate) => Promise<unknown[]>,
  persistPackages: (packages: unknown[]) => Promise<void>,
): Promise<StaleReconcileReport> {
  if (!policy.enabled || candidates.length === 0) {
    return { scanned: 0, queried: 0, persisted: 0, failed: 0, skipped: 0 }
  }
  const usable = candidates.filter((candidate) => candidate.orderNumber)
  const outcomes = await mapWithConcurrency(
    usable,
    policy.concurrency,
    async (candidate) => {
      try {
        const packages = await queryCandidate(candidate)
        if (!Array.isArray(packages) || packages.length === 0) return 'skipped'
        await persistPackages(packages)
        return 'persisted'
      } catch {
        return 'failed'
      }
    },
  )
  return {
    scanned: candidates.length,
    queried: usable.length,
    persisted: outcomes.filter((value) => value === 'persisted').length,
    failed: outcomes.filter((value) => value === 'failed').length,
    // orderNumber taşımayan aday sorgulanamaz; sessizce atlanır.
    skipped:
      outcomes.filter((value) => value === 'skipped').length +
      (candidates.length - usable.length),
  }
}
