// Organization onboarding durumu repository'si. TÜM fonksiyonlarda
// organizationId ZORUNLU ilk parametredir. onboarding_completed kaynak-of-truth
// PostgreSQL'dedir; frontend'te SAKLANMAZ. Secret/credential DÖNMEZ.
import { and, eq } from 'drizzle-orm'
import { integrationSyncState, organizationSettings } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type SyncResource = 'products' | 'orders'
export type SyncStatus = 'success' | 'partial' | 'failed'

// Settings kaydını garanti eder (yoksa oluşturur). Bootstrap'ta veya ilk
// status/complete çağrısında tembel oluşturma; yarış güvenli (onConflictDoNothing).
export async function ensureSettings(
  db: Db,
  organizationId: string,
): Promise<Record<string, unknown>> {
  await db
    .insert(organizationSettings)
    .values({ organizationId, onboardingCompleted: false })
    .onConflictDoNothing({ target: organizationSettings.organizationId })
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  return rows[0] ?? { organizationId, onboardingCompleted: false }
}

export async function getSettings(
  db: Db,
  organizationId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1)
  return rows[0] ?? null
}

export async function setOnboardingCompleted(
  db: Db,
  organizationId: string,
): Promise<void> {
  await ensureSettings(db, organizationId)
  await db
    .update(organizationSettings)
    .set({
      onboardingCompleted: true,
      onboardingCompletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(organizationSettings.organizationId, organizationId))
}

// Başarılı/kısmi/başarısız sync metadata'sı (org+provider+resource unique).
// Dashboard analytics sync'leri BURAYA YAZILMAZ.
export async function recordSyncState(
  db: Db,
  organizationId: string,
  entry: {
    provider: string
    resource: SyncResource
    status: SyncStatus
    fetchedCount?: number
    errorCode?: string | null
  },
): Promise<void> {
  const now = new Date()
  const values = {
    organizationId,
    provider: entry.provider,
    resource: entry.resource,
    lastSuccessfulSyncAt: entry.status === 'success' ? now : null,
    lastSyncStatus: entry.status,
    lastFetchedCount: Number.isFinite(Number(entry.fetchedCount))
      ? Math.trunc(Number(entry.fetchedCount))
      : null,
    lastErrorCode: entry.errorCode ?? null,
  }
  await db
    .insert(integrationSyncState)
    .values(values)
    .onConflictDoUpdate({
      target: [
        integrationSyncState.organizationId,
        integrationSyncState.provider,
        integrationSyncState.resource,
      ],
      set: {
        // Başarısız sync son BAŞARILI zamanı EZMEZ (yalnız başarıda güncellenir).
        ...(entry.status === 'success'
          ? { lastSuccessfulSyncAt: now }
          : {}),
        lastSyncStatus: values.lastSyncStatus,
        lastFetchedCount: values.lastFetchedCount,
        lastErrorCode: values.lastErrorCode,
        updatedAt: now,
      },
    })
}

export async function getSyncStates(
  db: Db,
  organizationId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const rows = await db
    .select()
    .from(integrationSyncState)
    .where(eq(integrationSyncState.organizationId, organizationId))
  const byResource: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    byResource[String(row.resource)] = row
  }
  return byResource
}

export async function getSyncState(
  db: Db,
  organizationId: string,
  resource: SyncResource,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(integrationSyncState)
    .where(
      and(
        eq(integrationSyncState.organizationId, organizationId),
        eq(integrationSyncState.resource, resource),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}
