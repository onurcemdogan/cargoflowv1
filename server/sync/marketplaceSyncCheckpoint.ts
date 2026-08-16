// ARTIMLI SENKRON DEFTERİ — KALICI CHECKPOINT.
//
// Mevcut `integration_sync_state` satırı KULLANILIR; ikinci bir durum tablosu
// AÇILMAZ. Yalnız iki additive kolon eklendi (0009): `last_attempted_at` ve
// `sync_watermark_at`.
//
// EN KRİTİK DEĞİŞMEZ — WATERMARK NE ZAMAN İLERLER:
//   Sağlayıcıdan çekim BAŞARILI olduğunda DEĞİL,
//   o pencereye ait KALICILAŞTIRMA başarıyla tamamlandığında.
// Aksi hâlde "çektim ama yazamadım" durumunda pencere atlanır ve sipariş
// KALICI OLARAK KAYBOLURDU.
//
// İKİNCİ DEĞİŞMEZ — MONOTONLUK:
//   `lastSuccessfulAt` ve `syncWatermarkAt` GERİYE GİTMEZ. Bayat bir tur
//   (ör. askıda kalıp geç tamamlanan süreç) daha yeni bir checkpoint'i EZEMEZ.
import { and, eq, isNull, sql } from 'drizzle-orm'
import { integrationSyncState } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const SYNC_PROVIDER = 'trendyol'
export const SYNC_RESOURCE = 'orders'

/**
 * GÜVENLİ ÖRTÜŞME — saat sınırı yüzünden sipariş kaçırmamak için.
 *
 * Pazaryeri tarafındaki yazma anı ile bizim gördüğümüz an arasında saniyeler
 * olabilir. Pencereyi tam `watermark`tan başlatmak sınırdaki kayıtları
 * kaçırabilirdi. Örtüşme BİLİNÇLİDİR ve güvenlidir: kalıcılaştırma idempotent
 * (aynı paket için upsert), dolayısıyla tekrar gelen kayıt yeni satır ÜRETMEZ.
 */
export const SAFE_OVERLAP_MS = 5 * 60 * 1000

export interface SyncCheckpoint {
  organizationId: string
  marketplaceAccountId: string | null
  lastAttemptedAt: Date | null
  lastSuccessfulAt: Date | null
  syncWatermarkAt: Date | null
  lastStatus: string | null
  lastErrorCode: string | null
}

export interface IncrementalWindow {
  /** Pencerenin başlangıcı; `null` → ilk tur (tam tarama sözleşmesi). */
  startTime: Date | null
  endTime: Date
  /** İlk tur mu (watermark yoksa) — çağıran full/bounded karar verir. */
  initial: boolean
  overlapMs: number
}

const scopeClause = (
  organizationId: string,
  marketplaceAccountId: string | null,
) =>
  and(
    eq(integrationSyncState.organizationId, organizationId),
    eq(integrationSyncState.provider, SYNC_PROVIDER),
    eq(integrationSyncState.resource, SYNC_RESOURCE),
    marketplaceAccountId === null
      ? isNull(integrationSyncState.marketplaceAccountId)
      : eq(integrationSyncState.marketplaceAccountId, marketplaceAccountId),
  )

const toDate = (value: unknown): Date | null => {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Checkpoint okuma — satır yoksa boş sözleşme döner (hata DEĞİL). */
export async function readSyncCheckpoint(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string | null,
): Promise<SyncCheckpoint> {
  const rows = (await db
    .select()
    .from(integrationSyncState)
    .where(scopeClause(organizationId, marketplaceAccountId))
    .limit(1)) as Record<string, unknown>[]
  const row = rows[0]
  return {
    organizationId,
    marketplaceAccountId,
    lastAttemptedAt: toDate(row?.lastAttemptedAt),
    lastSuccessfulAt: toDate(row?.lastSuccessfulSyncAt),
    syncWatermarkAt: toDate(row?.syncWatermarkAt),
    lastStatus: row?.lastSyncStatus ? String(row.lastSyncStatus) : null,
    lastErrorCode: row?.lastErrorCode ? String(row.lastErrorCode) : null,
  }
}

/**
 * ARTIMLI PENCERE — watermark'tan güvenli örtüşme çıkarılarak kurulur.
 *
 * Watermark yoksa `initial: true` döner ve `startTime` NULL kalır: uydurma
 * bir başlangıç tarihi ÜRETİLMEZ, kararı çağıran (mevcut Trendyol sözleşmesi)
 * verir.
 */
export function buildIncrementalWindow(
  checkpoint: SyncCheckpoint,
  now: Date = new Date(),
  overlapMs: number = SAFE_OVERLAP_MS,
): IncrementalWindow {
  const watermark = checkpoint.syncWatermarkAt
  if (!watermark) {
    return { startTime: null, endTime: now, initial: true, overlapMs }
  }
  const start = new Date(Math.max(0, watermark.getTime() - overlapMs))
  return { startTime: start, endTime: now, initial: false, overlapMs }
}

/** Deneme damgası — başarı ŞART DEĞİL; watermark'a DOKUNMAZ. */
export async function recordSyncAttempt(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string | null,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(integrationSyncState)
    .values({
      organizationId,
      marketplaceAccountId,
      provider: SYNC_PROVIDER,
      resource: SYNC_RESOURCE,
      lastAttemptedAt: now,
      lastSyncStatus: 'running',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationSyncState.organizationId,
        integrationSyncState.provider,
        integrationSyncState.resource,
        integrationSyncState.marketplaceAccountId,
      ],
      set: {
        lastAttemptedAt: now,
        lastSyncStatus: 'running',
        updatedAt: now,
      },
    })
}

/**
 * BAŞARILI KALICILAŞTIRMA SONRASI ilerleme.
 *
 * `windowEnd` yalnız o pencereye ait siparişler GERÇEKTEN yazıldıktan sonra
 * verilmelidir. Monotonluk SQL tarafında `greatest(...)` ile korunur: bayat
 * bir tur daha yeni bir konumu EZEMEZ.
 */
export async function commitSyncWatermark(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string | null,
  windowEnd: Date,
  options: { fetchedCount?: number; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date()
  await db
    .insert(integrationSyncState)
    .values({
      organizationId,
      marketplaceAccountId,
      provider: SYNC_PROVIDER,
      resource: SYNC_RESOURCE,
      lastAttemptedAt: now,
      lastSuccessfulSyncAt: windowEnd,
      syncWatermarkAt: windowEnd,
      lastSyncStatus: 'success',
      lastErrorCode: null,
      lastFetchedCount: options.fetchedCount ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationSyncState.organizationId,
        integrationSyncState.provider,
        integrationSyncState.resource,
        integrationSyncState.marketplaceAccountId,
      ],
      set: {
        // MONOTONLUK: geriye gitmez.
        lastSuccessfulSyncAt: sql`greatest(
          coalesce(${integrationSyncState.lastSuccessfulSyncAt}, to_timestamp(0)),
          excluded.last_successful_sync_at
        )`,
        syncWatermarkAt: sql`greatest(
          coalesce(${integrationSyncState.syncWatermarkAt}, to_timestamp(0)),
          excluded.sync_watermark_at
        )`,
        lastSyncStatus: sql`excluded.last_sync_status`,
        lastErrorCode: sql`excluded.last_error_code`,
        lastFetchedCount: sql`excluded.last_fetched_count`,
        lastAttemptedAt: sql`excluded.last_attempted_at`,
        updatedAt: now,
      },
    })
}

/**
 * BAŞARISIZLIK — watermark ve son başarı damgası KORUNUR.
 *
 * Sağlayıcı hatası, yetki hatası, sözleşme hatası ve KALICILAŞTIRMA hatası
 * için AYNI kural: konum ilerlemez, önceki başarı silinmez.
 */
export async function recordSyncFailure(
  db: Db,
  organizationId: string,
  marketplaceAccountId: string | null,
  errorCode: string | null,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(integrationSyncState)
    .values({
      organizationId,
      marketplaceAccountId,
      provider: SYNC_PROVIDER,
      resource: SYNC_RESOURCE,
      lastAttemptedAt: now,
      lastSyncStatus: 'failed',
      lastErrorCode: errorCode,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationSyncState.organizationId,
        integrationSyncState.provider,
        integrationSyncState.resource,
        integrationSyncState.marketplaceAccountId,
      ],
      // `lastSuccessfulSyncAt` ve `syncWatermarkAt` SET EDİLMEZ → KORUNUR.
      set: {
        lastAttemptedAt: now,
        lastSyncStatus: 'failed',
        lastErrorCode: errorCode,
        updatedAt: now,
      },
    })
}

/**
 * BAYAT `running` KURTARMA — süreç çökmesi kalıcı kilide dönüşmesin.
 *
 * YALNIZ durum alanına dokunur: watermark ve son başarı damgası DEĞİŞMEZ,
 * dolayısıyla kurtarma bir "ilerleme" sayılmaz.
 */
export async function recoverStaleSyncState(
  db: Db,
  maxAgeMs: number,
  now: Date = new Date(),
): Promise<{ recovered: number }> {
  const cutoff = new Date(now.getTime() - maxAgeMs)
  const rows = (await db
    .update(integrationSyncState)
    .set({ lastSyncStatus: 'stale_recovered', updatedAt: now })
    .where(
      and(
        eq(integrationSyncState.provider, SYNC_PROVIDER),
        eq(integrationSyncState.resource, SYNC_RESOURCE),
        eq(integrationSyncState.lastSyncStatus, 'running'),
        sql`${integrationSyncState.lastAttemptedAt} < ${cutoff}`,
      ),
    )
    .returning({ id: integrationSyncState.id })) as { id: string }[]
  return { recovered: rows.length }
}
