// SÜRAT TRACE V2 — DEBUG-ONLY KALICILAŞTIRMA.
//
// ═══ NEDEN VAR ═══════════════════════════════════════════════════════════
//
// ÖLÇÜLEN KUSUR (üretimde görüldü): Trace V2 hiçbir yere YAZILMIYORDU.
// Sunucu `traceAttempt` üretip yanıtta döndürüyordu; istemci onu HİÇ
// okumuyordu (`traceAttempt` src/ içinde geçmiyor) ve istemci deposunun
// yazıcısı `appendTrace` HİÇ ÇAĞRILMIYORDU. Bu yüzden gerçek bir create
// denemesinden hemen sonra bile Canlı Debug boştu.
//
// Bu, bu depoda ÜÇÜNCÜ kez görülen aynı kusur ailesidir:
//   P2 — imleç YAZILDI, hiç OKUNMADI
//   P3 — parmak izi YAZILDI, hiç KIYASLANMADI
//   burada — iz ÜRETİLDİ, hiç SAKLANMADI
//
// ═══ NEDEN AYRI TABLO ════════════════════════════════════════════════════
//
// `shipment_operations` OPERASYONEL kayıttır: idempotency, para kanıtı,
// tesellüm. Debug geçmişi KULLANICI TARAFINDAN SİLİNEBİLİR olmalıdır;
// operasyonel kayıt ASLA silinmemelidir. İkisi aynı tabloda olsaydı "debug'ı
// temizle" düğmesi operasyonel veriyi silme riski taşırdı.
//
// ═══ SIR YAZILMAZ ════════════════════════════════════════════════════════
// Aşamalar zaten redacted üretilir; burada AYRICA `redactTraceValue` uygulanır
// (derinlemesine savunma).

import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { suratTraceAttempts } from '../db/schema.ts'
import {
  SURAT_TRACE_SCHEMA_VERSION,
  TRACE_RETENTION_DAYS,
  TRACE_RETENTION_MAX_PER_TENANT,
  redactTraceValue,
} from './suratCreateTrace.ts'

type Db = Record<string, (...args: unknown[]) => unknown>

const str = (value: unknown): string | null => {
  const text = value === null || value === undefined ? '' : String(value).trim()
  return text || null
}

export interface PersistTraceInput {
  traceId: string
  createdAt?: string | Date | null
  stages?: unknown
  summary?: Record<string, unknown> | null
  orderNumber?: unknown
  packageId?: unknown
  marketplace?: unknown
  serviceMode?: unknown
  operation?: unknown
  finalState?: unknown
}

/**
 * Bir create denemesini KALICILAŞTIRIR.
 *
 * DEĞİŞMEZLİK: aynı `(org, traceId)` ikinci kez yazılmaz. Bir deneme tek bir
 * kayıttır; yeniden yazmak geçmişi tahrif etmek olurdu. Çakışma sessizce
 * yok sayılır — ikinci yazım bir hata değil, aynı denemenin tekrarıdır.
 *
 * BEST-EFFORT: debug yazımı create sonucunu ASLA etkilemez. Hata yutulur.
 */
export async function persistTraceAttempt(
  db: Db,
  organizationId: string,
  input: PersistTraceInput,
): Promise<{ persisted: boolean; reason: string }> {
  const traceId = String(input?.traceId ?? '').trim()
  if (!organizationId || !traceId) {
    return { persisted: false, reason: 'MISSING_SCOPE_OR_TRACE_ID' }
  }
  const stages = Array.isArray(input.stages) ? input.stages : []
  const createdAt =
    input.createdAt instanceof Date
      ? input.createdAt
      : input.createdAt
        ? new Date(String(input.createdAt))
        : new Date()

  try {
    await (db as unknown as {
      insert: (table: unknown) => {
        values: (v: Record<string, unknown>) => {
          onConflictDoNothing: (c: unknown) => Promise<unknown>
        }
      }
    })
      .insert(suratTraceAttempts)
      .values({
        organizationId,
        traceId,
        schemaVersion: SURAT_TRACE_SCHEMA_VERSION,
        orderNumber: str(input.orderNumber),
        packageId: str(input.packageId),
        marketplace: str(input.marketplace),
        serviceMode: str(input.serviceMode),
        operation: str(input.operation),
        finalState: str(input.finalState),
        stages: redactTraceValue(stages),
        summary: input.summary ? redactTraceValue(input.summary) : null,
        createdAt: Number.isFinite(createdAt.getTime()) ? createdAt : new Date(),
      })
      .onConflictDoNothing({
        target: [suratTraceAttempts.organizationId, suratTraceAttempts.traceId],
      })
    return { persisted: true, reason: 'OK' }
  } catch {
    // Debug kaydı create sonucunu BOZMAZ.
    return { persisted: false, reason: 'WRITE_FAILED' }
  }
}

/** Kiracının izleri — EN YENİ ÖNCE. Başka kiracının izi ASLA dönmez. */
export async function listTraceAttempts(
  db: Db,
  organizationId: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  if (!organizationId) return []
  const rows = await (db as unknown as {
    select: () => {
      from: (t: unknown) => {
        where: (c: unknown) => {
          orderBy: (o: unknown) => { limit: (n: number) => Promise<unknown[]> }
        }
      }
    }
  })
    .select()
    .from(suratTraceAttempts)
    .where(eq(suratTraceAttempts.organizationId, organizationId))
    .orderBy(desc(suratTraceAttempts.createdAt))
    .limit(Math.min(Math.max(1, limit), TRACE_RETENTION_MAX_PER_TENANT))
  return (rows ?? []) as Record<string, unknown>[]
}

/** "Son Deneme" — tek kayıt. Karışma OLMAZ: tek satır döner. */
export async function readLatestTraceAttempt(
  db: Db,
  organizationId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await listTraceAttempts(db, organizationId, 1)
  return rows[0] ?? null
}

/**
 * SAKLAMA SINIRI: 7 gün VEYA kiracı başına 200 iz — hangisi önce dolarsa.
 *
 * Yalnız DEBUG tablosuna dokunur.
 */
export async function applyTraceRetentionForTenant(
  db: Db,
  organizationId: string,
  now: number = Date.now(),
): Promise<{ deleted: number }> {
  if (!organizationId) return { deleted: 0 }
  const cutoff = new Date(now - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  let deleted = 0
  try {
    await (db as unknown as {
      delete: (t: unknown) => { where: (c: unknown) => Promise<unknown> }
    })
      .delete(suratTraceAttempts)
      .where(
        and(
          eq(suratTraceAttempts.organizationId, organizationId),
          lt(suratTraceAttempts.createdAt, cutoff),
        ),
      )
    const survivors = await listTraceAttempts(
      db, organizationId, TRACE_RETENTION_MAX_PER_TENANT,
    )
    if (survivors.length >= TRACE_RETENTION_MAX_PER_TENANT) {
      const overflow = survivors.slice(TRACE_RETENTION_MAX_PER_TENANT)
      const ids = overflow.map((row) => String(row.id))
      if (ids.length > 0) {
        await (db as unknown as {
          delete: (t: unknown) => { where: (c: unknown) => Promise<unknown> }
        })
          .delete(suratTraceAttempts)
          .where(
            and(
              eq(suratTraceAttempts.organizationId, organizationId),
              inArray(suratTraceAttempts.id, ids),
            ),
          )
        deleted += ids.length
      }
    }
  } catch {
    return { deleted }
  }
  return { deleted }
}

/**
 * TÜM DEBUG GEÇMİŞİNİ SİLER — YALNIZ bu kiracı, YALNIZ bu tablo.
 *
 * Bu fonksiyon `orders`, `shipments`, `shipment_operations`, idempotency
 * kayıtları ve etiket artefaktlarına DOKUNMAZ. Tek tablo adı geçer ve o da
 * debug tablosudur; testler bunu kanıtlar.
 */
export async function clearTraceAttempts(
  db: Db,
  organizationId: string,
): Promise<{ ok: boolean }> {
  if (!organizationId) return { ok: false }
  await (db as unknown as {
    delete: (t: unknown) => { where: (c: unknown) => Promise<unknown> }
  })
    .delete(suratTraceAttempts)
    .where(eq(suratTraceAttempts.organizationId, organizationId))
  return { ok: true }
}
