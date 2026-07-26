// Organization onboarding durumu repository'si. TÜM fonksiyonlarda
// organizationId ZORUNLU ilk parametredir. onboarding_completed kaynak-of-truth
// PostgreSQL'dedir; frontend'te SAKLANMAZ. Secret/credential DÖNMEZ.
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm'
import { integrationSyncState, organizationSettings } from '../db/schema.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type SyncResource = 'products' | 'orders'
export type SyncStatus = 'success' | 'partial' | 'failed'

// Aynı organization+resource için aynı anda tek sync garanti eden kilit statüsü.
// Terminal statülerden (success/partial/failed) ayrıdır; recordSyncState terminal
// statü yazınca kilit serbest kalır.
const SYNC_LOCK_STATUS = 'running'
// Bir 'running' kaydı bu süreden eskiyse (process çökmüş olabilir) ölü sayılır ve
// kilit devralınır. Sync tipik olarak saniyeler sürer; 2 dk güvenli üst sınırdır.
const SYNC_LOCK_STALE_MS = 120_000

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

// Org+resource bazlı sync kilidini ATOMİK olarak almaya çalışır. Tek satır
// üzerinde INSERT ... ON CONFLICT DO UPDATE ... WHERE ile çalışır; bu yüzden
// birden çok PM2 instance'ı arasında güvenlidir (process-local mutex DEĞİL) ve
// ek migration gerektirmez. Kilit yalnızca kayıt yoksa, terminal statüdeyse
// (running değil) veya 'running' kaydı bayatladıysa (staleMs) alınır. true
// dönerse arayan sync'i yürütür ve bitince recordSyncState (terminal statü) veya
// releaseSyncLock ile kilidi SERBEST bırakmalıdır. false dönerse başka bir sync
// zaten çalışıyordur. Kilit organization+resource bazındadır; farklı tenant'lar
// ayrı satırlara yazdığı için birbirini bloklamaz.
export async function acquireSyncLock(
  db: Db,
  organizationId: string,
  resource: SyncResource,
  options?: { provider?: string; staleMs?: number },
): Promise<boolean> {
  const provider = options?.provider ?? 'trendyol'
  const staleMs = Number.isFinite(Number(options?.staleMs))
    ? Number(options?.staleMs)
    : SYNC_LOCK_STALE_MS
  const now = new Date()
  const staleBefore = new Date(now.getTime() - staleMs)
  const rows = await db
    .insert(integrationSyncState)
    .values({
      organizationId,
      provider,
      resource,
      lastSyncStatus: SYNC_LOCK_STATUS,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationSyncState.organizationId,
        integrationSyncState.provider,
        integrationSyncState.resource,
      ],
      set: { lastSyncStatus: SYNC_LOCK_STATUS, updatedAt: now },
      // Yalnızca kilit boşsa devral: statü running değil, NULL veya bayat.
      setWhere: or(
        isNull(integrationSyncState.lastSyncStatus),
        ne(integrationSyncState.lastSyncStatus, SYNC_LOCK_STATUS),
        lt(integrationSyncState.updatedAt, staleBefore),
      ),
    })
    .returning({ id: integrationSyncState.id })
  return rows.length > 0
}

// Kilidi beklenmedik hata yolunda (sync terminal statü YAZMADAN düştüğünde)
// serbest bırakır. Normal akışta recordSyncState terminal statü yazarak kilidi
// zaten bırakır; bu fonksiyon yalnız yakalanan istisna sonrası çağrılır ve
// yalnızca hâlâ 'running' olan kaydı 'failed'e çevirir (başka statüyü ezmez).
export async function releaseSyncLock(
  db: Db,
  organizationId: string,
  resource: SyncResource,
  options?: { provider?: string; errorCode?: string | null },
): Promise<void> {
  const provider = options?.provider ?? 'trendyol'
  await db
    .update(integrationSyncState)
    .set({
      lastSyncStatus: 'failed',
      lastErrorCode: options?.errorCode ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationSyncState.organizationId, organizationId),
        eq(integrationSyncState.provider, provider),
        eq(integrationSyncState.resource, resource),
        eq(integrationSyncState.lastSyncStatus, SYNC_LOCK_STATUS),
      ),
    )
}
