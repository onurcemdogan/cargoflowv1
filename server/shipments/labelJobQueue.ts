// ETİKET İŞ KUYRUĞU — POSTGRES DESTEKLİ, ATOMİK TALEP.
//
// ═══ NEDEN REDIS/KAFKA YOK ═══════════════════════════════════════════════
//
// Bu kuyruğun tek gereksinimi "aynı paket için asla iki iş" ve "aynı işi
// asla iki worker". İkisi de Postgres'in ZATEN verdiği garantiler:
// benzersiz indeks + `FOR UPDATE SKIP LOCKED`. Yeni bir altyapı bileşeni
// eklemek, işletme yükünü artırır ve HİÇBİR güvence kazandırmaz.
//
// ═══ NEDEN VERİTABANI KISITI ═════════════════════════════════════════════
//
// Taşıyıcı etiketi GERİ ALINAMAZ. "Uygulama zaten kontrol ediyor" yeterli
// değildir: iki süreç, yeniden başlatma ya da webhook+stream aynı paketi
// aynı anda bulabilir. Tekillik VERİTABANINDA durur.
import { and, eq, lte, or, sql } from 'drizzle-orm'
import { labelJobs } from '../db/schema.ts'

// Drizzle'ın akıcı sorgu kurucusu (`.from().where().limit()`) her adımda
// farklı bir jenerik tip döndürür ve burada elle yazılamaz. Depo kodunun
// geri kalanındaki (printZplItems, tenantBlockLoader) sözleşmeyle aynı
// biçimde, YALNIZ bu yerel `Db` şekli için kural gevşetilir.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = {
  execute: (query: unknown) => Promise<unknown>
  insert: (table: unknown) => any
  update: (table: unknown) => any
  select: (fields?: unknown) => any
}

export const LABEL_JOB_TYPE = 'LABEL_PREPARE'

/** Terminal durumlar — worker bunlara DOKUNMAZ. */
export const TERMINAL_JOB_STATUSES = [
  'READY', 'BLOCKED', 'UNKNOWN_AFTER_NETWORK',
] as const

export interface LabelJobRow {
  id: string
  organizationId: string
  marketplace: string
  carrier: string
  packageId: string
  status: string
  attemptCount: number
}

export interface EnqueueResult {
  enqueued: boolean
  reason: 'INSERTED' | 'ALREADY_QUEUED'
}

/**
 * İşi sıraya alır. AYNI paket için ikinci satır OLUŞMAZ.
 *
 * `onConflictDoNothing` benzersiz indekse dayanır: yarış durumunda
 * kaybeden taraf sessizce hiçbir şey yapmaz — hata fırlatmaz, çünkü
 * "zaten sırada" bir hata değildir.
 */
export async function enqueueLabelJob(
  db: Db,
  params: {
    organizationId: string
    marketplace: string
    carrier: string
    packageId: string
  },
): Promise<EnqueueResult> {
  const inserted = await db
    .insert(labelJobs)
    .values({
      organizationId: params.organizationId,
      marketplace: params.marketplace,
      carrier: params.carrier,
      packageId: params.packageId,
      jobType: LABEL_JOB_TYPE,
      status: 'QUEUED',
    })
    .onConflictDoNothing({
      target: [
        labelJobs.organizationId, labelJobs.marketplace,
        labelJobs.carrier, labelJobs.packageId, labelJobs.jobType,
      ],
    })
    .returning({ id: labelJobs.id })
  const rows = (inserted ?? []) as { id: string }[]
  return {
    enqueued: rows.length > 0,
    reason: rows.length > 0 ? 'INSERTED' : 'ALREADY_QUEUED',
  }
}

/**
 * ATOMİK TALEP — `FOR UPDATE SKIP LOCKED`.
 *
 * İki worker aynı anda çalışsa bile aynı satırı ALAMAZ: kilitli satırlar
 * atlanır, beklenmez. Bu, "iki worker aynı paket için iki gönderi yarattı"
 * senaryosunu YAPISAL OLARAK imkânsız kılar.
 */
export async function claimLabelJobs(
  db: Db,
  params: { workerId: string; limit: number; nowMs?: number },
): Promise<LabelJobRow[]> {
  const limit = Math.max(1, Math.min(Number(params.limit) || 1, 50))
  const claimed = await db.execute(sql`
    UPDATE ${labelJobs} AS j
       SET status = 'PREPARING',
           locked_at = now(),
           locked_by = ${params.workerId},
           attempt_count = j.attempt_count + 1,
           updated_at = now()
     WHERE j.id IN (
       SELECT c.id FROM ${labelJobs} AS c
        WHERE c.status IN ('QUEUED', 'FAILED_SAFE_TO_RETRY')
          AND c.available_at <= now()
        ORDER BY c.available_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING j.id, j.organization_id, j.marketplace, j.carrier,
              j.package_id, j.status, j.attempt_count
  `)
  const rows = (Array.isArray(claimed)
    ? claimed
    : (claimed as { rows?: unknown[] })?.rows ?? []) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    marketplace: String(row.marketplace),
    carrier: String(row.carrier),
    packageId: String(row.package_id),
    status: String(row.status),
    attemptCount: Number(row.attempt_count ?? 0),
  }))
}

/** Sonucu yazar. Terminal durumlar bir daha TALEP EDİLMEZ. */
export async function completeLabelJob(
  db: Db,
  params: {
    id: string
    status: string
    errorCode?: string | null
    errorSummary?: string | null
    retryDelayMs?: number
  },
): Promise<void> {
  const retryable = params.status === 'FAILED_SAFE_TO_RETRY'
  await db
    .update(labelJobs)
    .set({
      status: params.status,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: params.errorCode ?? null,
      lastErrorSummary: params.errorSummary ?? null,
      updatedAt: new Date(),
      // Yalnız GÜVENLE tekrarlanabilir işler ileri tarihlenir.
      ...(retryable
        ? {
            availableAt: new Date(
              Date.now() + Math.max(0, Number(params.retryDelayMs ?? 60_000)),
            ),
          }
        : {}),
    })
    .where(eq(labelJobs.id, params.id))
}

/** Süresi geçmiş kilitleri serbest bırakır — worker çöktüyse iş kaybolmaz. */
export async function releaseStaleLocks(
  db: Db, params: { olderThanMs: number },
): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(1_000, params.olderThanMs))
  const released = await db
    .update(labelJobs)
    .set({ status: 'QUEUED', lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(
      eq(labelJobs.status, 'PREPARING'),
      or(lte(labelJobs.lockedAt, cutoff), sql`${labelJobs.lockedAt} IS NULL`),
    ))
    .returning({ id: labelJobs.id })
  return ((released ?? []) as unknown[]).length
}

/** Operasyonel sayaçlar — PII/sır YOK. */
export async function labelJobStats(
  db: Db, organizationId?: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: labelJobs.status, total: sql<number>`count(*)::int` })
    .from(labelJobs)
    .where(organizationId ? eq(labelJobs.organizationId, organizationId) : sql`true`)
    .groupBy(labelJobs.status)
  const stats: Record<string, number> = {}
  for (const row of (rows ?? []) as { status: string; total: number }[]) {
    stats[row.status] = Number(row.total ?? 0)
  }
  return stats
}
