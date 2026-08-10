import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import {
  orderLines,
  orders,
  shipmentOperations,
  shipments,
} from '../db/schema.ts'

type Db = {
  select: (...args: unknown[]) => never
} & Record<string, unknown>

// ═══ OPERASYON KAYDI YAŞAM DÖNGÜSÜ: ACTIVE → ARCHIVED → PURGED ════════════
//
// TEK GERÇEK KAYNAK. Dry-run CLI ve otomatik housekeeping AYNI predicate'leri
// kullanır; iki ayrı iş kuralı implementasyonu YOKTUR.
//
// RETENTION SAATİ: orders.last_operational_activity_at
//   · YALNIZ gerçek CargoFlow operasyon geçişleri yazar (LABEL_READY /
//     LABEL_PRINTED — bkz. markOrderLabelReady / markOrderLabelPrinted).
//   · Rutin Trendyol sync (marketplaceUpdateSet) DOKUNMAZ.
//   · NULL → güvenilir aktivite bilgisi YOK → OTOMATİK ARŞİV ADAYI DEĞİL.
//     (Geçmiş kayıtlar için kör "orderDate/updatedAt eskimiş" çıkarımı YAPILMAZ.)
//
// `updatedAt`, `orderDate`, `createdAt` retention saati DEĞİLDİR:
// marketplaceUpdateSet her re-sync'te updatedAt'i tazeler.

export const DEFAULT_ARCHIVE_AFTER_DAYS = 4
export const DEFAULT_PURGE_AFTER_DAYS = 90
export const DEFAULT_ARCHIVE_BATCH_SIZE = 200
export const DEFAULT_PURGE_BATCH_SIZE = 200
/** 6 saat: 4 günlük SLA için fazlasıyla yeterli, DB'yi yormaz. */
export const DEFAULT_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * OTOMATİK ARŞİV YALNIZ BU CANONICAL DURUMLARDA.
 * Çözülmemiş kayıtlar (NEW / BARCODE_WAITING) SESSİZCE gömülmez: 5 gündür
 * barkod bekleyen sipariş bir PROBLEM sinyalidir, arşiv adayı değildir.
 * İleri/terminal durumlar (SHIPPED, HANDED_TO_CARGO, DELIVERED, RETURNING…)
 * da bu kurala GİRMEZ — pazaryeri sınıflandırması üstündür.
 */
export const AUTO_ARCHIVE_OPERATION_STATUSES = [
  'LABEL_READY',
  'LABEL_PRINTED',
] as const

/**
 * Pazaryeri statüsü ileri/terminal ise otomatik arşiv UYGULANMAZ.
 * (Trendyol Shipped → handedToCargo; kanonik sınıflandırma korunur.)
 */
export const MARKETPLACE_FORWARD_STATUSES = [
  'Shipped',
  'AtCollectionPoint',
  'Delivered',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
] as const

export interface RetentionPolicy {
  archiveAfterDays: number
  purgeAfterDays: number
  archiveBatchSize: number
  purgeBatchSize: number
  intervalMs: number
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

export function resolveRetentionPolicy(
  env: Record<string, string | undefined> = process.env,
): RetentionPolicy {
  return {
    archiveAfterDays: positiveInt(
      env.ORDER_AUTO_ARCHIVE_DAYS,
      DEFAULT_ARCHIVE_AFTER_DAYS,
    ),
    purgeAfterDays: positiveInt(
      env.ORDER_ARCHIVE_RETENTION_DAYS,
      DEFAULT_PURGE_AFTER_DAYS,
    ),
    archiveBatchSize: positiveInt(
      env.ORDER_ARCHIVE_BATCH_SIZE,
      DEFAULT_ARCHIVE_BATCH_SIZE,
    ),
    purgeBatchSize: positiveInt(
      env.ORDER_PURGE_BATCH_SIZE,
      DEFAULT_PURGE_BATCH_SIZE,
    ),
    intervalMs: Math.max(
      60_000,
      positiveInt(
        env.ORDER_HOUSEKEEPING_INTERVAL_MS,
        DEFAULT_HOUSEKEEPING_INTERVAL_MS,
      ),
    ),
  }
}

export function cutoffDate(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

// ═══ ARŞİV UYGUNLUĞU ══════════════════════════════════════════════════════
//
//   archived_at IS NULL
//   AND last_operational_activity_at IS NOT NULL
//   AND last_operational_activity_at <= now - archiveAfterDays
//   AND operation_status IN (LABEL_READY, LABEL_PRINTED)
//   AND (marketplace_status IS NULL OR marketplace_status NOT IN forward)
function archiveEligibilityWhere(cutoff: Date) {
  return and(
    isNull(orders.archivedAt),
    isNotNull(orders.lastOperationalActivityAt),
    lte(orders.lastOperationalActivityAt, cutoff),
    inArray(orders.operationStatus, [...AUTO_ARCHIVE_OPERATION_STATUSES]),
    sql`(${orders.marketplaceStatus} is null or ${orders.marketplaceStatus} not in ${MARKETPLACE_FORWARD_STATUSES})`,
  )
}

// ═══ PURGE UYGUNLUĞU ══════════════════════════════════════════════════════
//
//   archived_at IS NOT NULL  (arşivlenmemiş kayıt ASLA purge edilmez)
//   AND archived_at <= now - purgeAfterDays
function purgeEligibilityWhere(cutoff: Date) {
  return and(isNotNull(orders.archivedAt), lte(orders.archivedAt, cutoff))
}

export interface RetentionCounts {
  scanned: number
  archiveEligible: number
  purgeEligible: number
  nullActivityBacklog: number
  oldestArchiveCandidateAgeDays: number | null
  oldestPurgeCandidateAgeDays: number | null
}

function ageDays(from: Date | null, now: Date): number | null {
  if (!from) return null
  return Math.floor((now.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
}

/** SALT OKUNUR sayım. Hiçbir yazma yapmaz. PII döndürmez. */
export async function inspectRetention(
  db: Db,
  policy: RetentionPolicy,
  now: Date = new Date(),
): Promise<RetentionCounts> {
  const archiveCutoff = cutoffDate(now, policy.archiveAfterDays)
  const purgeCutoff = cutoffDate(now, policy.purgeAfterDays)
  const database = db as unknown as {
    select: (fields?: unknown) => {
      from: (table: unknown) => {
        where: (clause: unknown) => Promise<Record<string, unknown>[]>
      } & Promise<Record<string, unknown>[]>
    }
  }

  const countOf = async (clause: unknown): Promise<number> => {
    const rows = await database
      .select({ value: sql<number>`count(*)::int` })
      .from(orders)
      .where(clause)
    return Number(rows[0]?.value ?? 0)
  }
  const oldestOf = async (
    clause: unknown,
    column: unknown,
  ): Promise<Date | null> => {
    const rows = await database
      .select({ value: sql<Date | null>`min(${column})` })
      .from(orders)
      .where(clause)
    const value = rows[0]?.value
    return value ? new Date(String(value)) : null
  }

  const [
    scanned,
    archiveEligible,
    purgeEligible,
    nullActivityBacklog,
    oldestArchive,
    oldestPurge,
  ] = await Promise.all([
    countOf(sql`true`),
    countOf(archiveEligibilityWhere(archiveCutoff)),
    countOf(purgeEligibilityWhere(purgeCutoff)),
    // Aktivite damgası OLMAYAN etiket-aşamalı eski kayıtlar: otomatik arşive
    // GİRMEZLER; operatörün görmesi için ayrıca raporlanır.
    countOf(
      and(
        isNull(orders.archivedAt),
        isNull(orders.lastOperationalActivityAt),
        inArray(orders.operationStatus, [...AUTO_ARCHIVE_OPERATION_STATUSES]),
      ),
    ),
    oldestOf(
      archiveEligibilityWhere(archiveCutoff),
      orders.lastOperationalActivityAt,
    ),
    oldestOf(purgeEligibilityWhere(purgeCutoff), orders.archivedAt),
  ])

  return {
    scanned,
    archiveEligible,
    purgeEligible,
    nullActivityBacklog,
    oldestArchiveCandidateAgeDays: ageDays(oldestArchive, now),
    oldestPurgeCandidateAgeDays: ageDays(oldestPurge, now),
  }
}

/**
 * SINIRLI arşiv turu. Deterministik keyset (orders.id ASC) ile ilerler.
 *
 * STARVATION YOK: her tur bir sonraki turda aynı ilk 200'e takılmaz, çünkü
 * arşivlenen kayıt `archived_at IS NULL` koşulundan DÜŞER; ayrıca cursor
 * son işlenen id'den devam eder. 1000 uygun kayıt / 200 batch → 5 turda biter.
 *
 * IDEMPOTENT: UPDATE yalnız `archived_at IS NULL` iken yazar.
 */
export async function archiveEligibleOrders(
  db: Db,
  policy: RetentionPolicy,
  now: Date = new Date(),
  cursor?: string,
): Promise<{ archived: number; scanned: number; nextCursor?: string }> {
  const cutoff = cutoffDate(now, policy.archiveAfterDays)
  const database = db as unknown as {
    select: (fields?: unknown) => {
      from: (table: unknown) => {
        where: (clause: unknown) => {
          orderBy: (order: unknown) => {
            limit: (n: number) => Promise<{ id: string }[]>
          }
        }
      }
    }
    update: (table: unknown) => {
      set: (values: unknown) => {
        where: (clause: unknown) => {
          returning: (fields: unknown) => Promise<{ id: string }[]>
        }
      }
    }
  }
  const base = archiveEligibilityWhere(cutoff)
  const candidates = await database
    .select({ id: orders.id })
    .from(orders)
    .where(cursor ? and(base, gt(orders.id, cursor)) : base)
    .orderBy(asc(orders.id))
    .limit(policy.archiveBatchSize)

  if (candidates.length === 0) return { archived: 0, scanned: 0 }

  const ids = candidates.map((row) => row.id)
  const updated = await database
    .update(orders)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(inArray(orders.id, ids), isNull(orders.archivedAt)))
    .returning({ id: orders.id })

  return {
    archived: updated.length,
    scanned: candidates.length,
    nextCursor:
      candidates.length === policy.archiveBatchSize
        ? ids[ids.length - 1]
        : undefined,
  }
}

export interface PurgeCandidate {
  id: string
  organizationId: string
  marketplace: string
  packageId: string
}

/** Purge adaylarını SALT OKUNUR listeler (arşivlenmiş + retention dolmuş). */
export async function findPurgeCandidates(
  db: Db,
  policy: RetentionPolicy,
  now: Date = new Date(),
  cursor?: string,
): Promise<PurgeCandidate[]> {
  const cutoff = cutoffDate(now, policy.purgeAfterDays)
  const base = purgeEligibilityWhere(cutoff)
  const database = db as unknown as {
    select: (fields?: unknown) => {
      from: (table: unknown) => {
        where: (clause: unknown) => {
          orderBy: (order: unknown) => {
            limit: (n: number) => Promise<PurgeCandidate[]>
          }
        }
      }
    }
  }
  return database
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      marketplace: orders.marketplace,
      packageId: orders.packageId,
    })
    .from(orders)
    .where(cursor ? and(base, gt(orders.id, cursor)) : base)
    .orderBy(asc(orders.id))
    .limit(policy.purgeBatchSize)
}

/**
 * TEK SİPARİŞİN YEREL OPERASYON KAYITLARINI ATOMİK SİLER.
 *
 * İLİŞKİ AUDIT'İ (kanıtlanmış):
 *   order_lines        → orders.id FK, ON DELETE CASCADE            (otomatik)
 *   shipments          → orders'a FK YOK; doğal anahtar
 *                        (organization_id, marketplace, package_id) (explicit)
 *   shipment_operations→ orders'a FK YOK; aynı doğal anahtar        (explicit)
 * Değişmez etiket/carrier artifact'ları shipments.carrier_payload_encrypted ve
 * shipment_operations.response_payload_encrypted içindedir; ikisi de bu
 * silmeyle birlikte gider → ORPHAN = 0.
 *
 * SIRA: önce çocuklar (operations → shipments), sonra order (order_lines
 * cascade ile düşer). Tamamı TEK transaction: bir çocuk silme başarısız
 * olursa sipariş SİLİNMEZ.
 *
 * PAZARYERİNE / TAŞIYICIYA HİÇBİR DELETE ÇAĞRISI YAPILMAZ — yalnız yerel DB.
 */
export async function purgeOrderRecord(
  db: Db,
  candidate: PurgeCandidate,
  now: Date = new Date(),
): Promise<{ purged: boolean }> {
  const database = db as unknown as {
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>
  }
  return database.transaction(async (tx) => {
    const trx = tx as unknown as {
      select: (fields?: unknown) => {
        from: (table: unknown) => {
          where: (clause: unknown) => Promise<{ id: string }[]>
        }
      }
      delete: (table: unknown) => {
        where: (clause: unknown) => Promise<unknown>
      }
    }
    // SON GÜVENLİK KONTROLÜ: kayıt hâlâ arşivli mi? (aktif hale dönmüşse DUR)
    const cutoff = cutoffDate(now, DEFAULT_PURGE_AFTER_DAYS)
    const still = await trx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.id, candidate.id),
          isNotNull(orders.archivedAt),
          lte(orders.archivedAt, cutoff),
        ),
      )
    if (still.length === 0) return { purged: false }

    const naturalKey = and(
      eq(shipmentOperations.organizationId, candidate.organizationId),
      eq(shipmentOperations.marketplace, candidate.marketplace),
      eq(shipmentOperations.packageId, candidate.packageId),
    )
    await trx.delete(shipmentOperations).where(naturalKey)
    await trx.delete(shipments).where(
      and(
        eq(shipments.organizationId, candidate.organizationId),
        eq(shipments.marketplace, candidate.marketplace),
        eq(shipments.packageId, candidate.packageId),
      ),
    )
    // order_lines FK cascade ile düşer; yine de açık silme idempotent ve
    // cascade davranışından bağımsız güvence sağlar.
    await trx.delete(orderLines).where(eq(orderLines.orderId, candidate.id))
    await trx.delete(orders).where(eq(orders.id, candidate.id))
    return { purged: true }
  })
}

export interface HousekeepingReport {
  scanned: number
  archiveEligible: number
  archived: number
  purgeEligible: number
  purged: number
  failed: number
  durationMs: number
}

/**
 * SINIRLI bir housekeeping turu. Full-table scan YOK, hot-loop YOK.
 * PM2 restart sonrası state DB'den yeniden keşfedilir (bellekte kuyruk YOK).
 */
export async function runRetentionCycle(
  db: Db,
  policy: RetentionPolicy,
  now: Date = new Date(),
  clock: () => number = () => 0,
): Promise<HousekeepingReport> {
  const startedAt = clock()
  const counts = await inspectRetention(db, policy, now)
  let archived = 0
  let purged = 0
  let failed = 0

  const archiveResult = await archiveEligibleOrders(db, policy, now)
  archived += archiveResult.archived

  const candidates = await findPurgeCandidates(db, policy, now)
  for (const candidate of candidates) {
    try {
      const result = await purgeOrderRecord(db, candidate, now)
      if (result.purged) purged += 1
    } catch {
      // Bir kaydın silinmesi başarısız olursa tur DEVAM eder; o kayıt bir
      // sonraki turda yeniden denenir (idempotent).
      failed += 1
    }
  }

  return {
    scanned: counts.scanned,
    archiveEligible: counts.archiveEligible,
    archived,
    purgeEligible: counts.purgeEligible,
    purged,
    failed,
    durationMs: Math.max(0, clock() - startedAt),
  }
}
