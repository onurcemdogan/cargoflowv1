// ENTEGRASYON SAĞLIĞI OKUMA KATMANI — MEVCUT KALICILIĞI KULLANIR.
//
// ═══ NEDEN YENİ TABLO YOK ════════════════════════════════════════════════
//
// `integration_sync_state` gereken operasyonel durumun TAMAMINI zaten
// temsil ediyor; ölçüldü:
//
//   lastSucceededAt      → `last_successful_sync_at`
//   lastCheckpoint       → AYNI KOLON (üretimde imleç budur:
//                          index.mjs `priorCheckpointMs` bu alandan okunur)
//   lastAttemptAt        → `updated_at` (her denemede yazılır)
//   lastFailedAt         → `updated_at` + `last_sync_status='failed'`
//   RUNNING              → `last_sync_status='running'` (kilit statüsü)
//                          + `updated_at` tazeliği
//   lastErrorClass       → `last_error_code` saf sınıflandırıcıdan geçer
//
// Bu yüzden MIGRATION EKLENMEDİ. Spekülatif kolon açmak, doldurulmayan ve
// zamanla yalan söyleyen alanlar üretirdi.
//
// ═══ KİRACI KAPSAMI ══════════════════════════════════════════════════════
//
// Depoda Postgres RLS YOKTUR. İzolasyon UYGULAMA KAPSAMIYLA sağlanır:
// buradaki HER sorgu `organization_id` eşitliği taşır ve bu dosyada
// kapsamsız `select` YAZILAMAZ (testle kilitli).
import { and, eq } from 'drizzle-orm'
import { integrationSyncState } from '../db/schema.ts'
import {
  resolveIntegrationHealth,
  type IntegrationHealth,
  type StoredSyncState,
  type WebhookObservation,
} from './integrationHealth.ts'
import {
  buildProviderCatalog,
  resolveRolloutStage,
  HEALTH_SUPPORTED_PROVIDERS,
} from './providerCatalog.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export interface IntegrationHealthQuery {
  organizationId: string
  /** Sağlık hangi kaynağa göre okunur (üretimde 'orders'). */
  resource?: string
  /** Kimlik bilgisi ALAN VARLIĞI — geçerlilik kanıtı DEĞİLDİR. */
  credentialsPresentByProvider?: Record<string, boolean>
  /** Gerçekten gözlenmiş webhook olayları; yoksa uydurulmaz. */
  webhookByProvider?: Record<string, WebhookObservation>
  nowMs: number
  lockStaleMs?: number
}

export class TenantScopeMissingError extends Error {}

/**
 * Kiracının TÜM desteklenen sağlayıcıları için sağlık.
 *
 * Satır YOKSA sağlayıcı listeden DÜŞMEZ: "hiç senkron edilmemiş" de bir
 * operasyonel gerçektir ve `NEVER_RUN` olarak görünür.
 */
export async function loadIntegrationHealth(
  db: Db,
  query: IntegrationHealthQuery,
): Promise<IntegrationHealth[]> {
  const organizationId = String(query.organizationId ?? '').trim()
  if (organizationId === '') {
    // FAIL-CLOSED: kiracı kapsamı olmadan sağlık OKUNMAZ.
    throw new TenantScopeMissingError('organizationId zorunludur; kapsamsız okuma yapılmaz.')
  }
  const resource = query.resource ?? 'orders'

  const rows: Record<string, unknown>[] = await db
    .select({
      provider: integrationSyncState.provider,
      resource: integrationSyncState.resource,
      lastSyncStatus: integrationSyncState.lastSyncStatus,
      lastSuccessfulSyncAt: integrationSyncState.lastSuccessfulSyncAt,
      lastErrorCode: integrationSyncState.lastErrorCode,
      lastFetchedCount: integrationSyncState.lastFetchedCount,
      updatedAt: integrationSyncState.updatedAt,
    })
    .from(integrationSyncState)
    .where(
      and(
        // KİRACI SINIRI — her sorguda, istisnasız.
        eq(integrationSyncState.organizationId, organizationId),
        eq(integrationSyncState.resource, resource),
      ),
    )

  const byProvider = new Map<string, StoredSyncState>()
  for (const row of rows) {
    byProvider.set(String(row.provider).toLowerCase(), {
      lastSyncStatus: (row.lastSyncStatus as string | null) ?? null,
      lastSuccessfulSyncAt: (row.lastSuccessfulSyncAt as Date | null) ?? null,
      lastErrorCode: (row.lastErrorCode as string | null) ?? null,
      lastFetchedCount: (row.lastFetchedCount as number | null) ?? null,
      updatedAt: (row.updatedAt as Date | null) ?? null,
    })
  }

  const catalog = buildProviderCatalog()
  const out: IntegrationHealth[] = []
  for (const providerKey of HEALTH_SUPPORTED_PROVIDERS) {
    const descriptor = catalog.get(providerKey)
    if (!descriptor) continue
    out.push(
      resolveIntegrationHealth({
        descriptor,
        rolloutStage: resolveRolloutStage(providerKey),
        credentialsPresent: Boolean(query.credentialsPresentByProvider?.[providerKey]),
        syncState: byProvider.get(providerKey) ?? null,
        webhook: query.webhookByProvider?.[providerKey] ?? null,
        nowMs: query.nowMs,
        ...(query.lockStaleMs != null ? { lockStaleMs: query.lockStaleMs } : {}),
      }),
    )
  }
  return out
}

/**
 * UI/operatör yüzeyi için güvenli projeksiyon.
 *
 * Ham hata kodu, uç nokta, kimlik bilgisi ve sağlayıcı mesajı TAŞINMAZ;
 * yalnız kararlı sınıf ve sebep kodları geçer.
 */
export interface IntegrationHealthView {
  providerKey: string
  displayName: string
  connection: string
  sync: string
  webhook: string
  reconciliation: string
  rolloutStage: string
  overall: string
  lastSuccessfulSyncAt: string | null
  attentionReasonCodes: string[]
}

export function toHealthView(
  health: IntegrationHealth,
  displayName: string,
): IntegrationHealthView {
  return {
    providerKey: health.providerKey,
    displayName,
    connection: health.connection,
    sync: health.sync,
    webhook: health.webhook,
    reconciliation: health.reconciliation,
    rolloutStage: health.rolloutStage,
    overall: health.overall,
    lastSuccessfulSyncAt: health.lastSuccessfulSyncAt,
    // Sebep KODLARI taşınır; ham sağlayıcı metni ASLA.
    attentionReasonCodes: health.reasons.map((reason) => reason.code),
  }
}
