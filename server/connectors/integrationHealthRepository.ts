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
// ═══ SAĞLIK BAĞLANTI KAPSAMLIDIR (001A DÜZELTMESİ) ═══════════════════════
//
// ÖLÇÜLEN KUSUR: bu katman satırları `Map<providerKey, …>` ile topluyordu.
// `integration_sync_state` kimliği ise (org, provider, resource, ACCOUNT)
// dörtlüsüdür. Sonuç: aynı sağlayıcının İKİ mağazası TEK sonuca çöküyor ve
// `Map.set()`i en son kazanan satır görünüyordu — yani SAĞLIKLI bir mağaza,
// KİMLİK HATASI olan diğerinin arkasında GÖRÜNMEZ oluyordu.
//
// Yeniden üretildi (yamadan önce): 2 satır → 1 sonuç, hesap kimliği yok.
//
// Artık her SATIR kendi sağlık kaydını üretir. Gruplama anahtarı
// `provider::account`tır (`connectionKey`) ve hesap kimliği ASLA uydurulmaz.
//
// ═══ KİRACI KAPSAMI ══════════════════════════════════════════════════════
//
// Depoda Postgres RLS YOKTUR. İzolasyon UYGULAMA KAPSAMIYLA sağlanır:
// buradaki HER sorgu `organization_id` eşitliği taşır ve bu dosyada
// kapsamsız `select` YAZILAMAZ (testle kilitli).
import { and, eq } from 'drizzle-orm'
import { integrationSyncState } from '../db/schema.ts'
import {
  connectionKey,
  resolveIntegrationHealth,
  type ConnectionScope,
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
  /**
   * BAĞLANTI kapsamlı kimlik varlığı. Anahtar `connectionKey()` çıktısıdır
   * (`provider::account`). Çok hesaplı sağlayıcıda DOĞRU olan budur.
   */
  credentialsPresentByConnection?: Record<string, boolean>
  /**
   * ESKİ, sağlayıcı geneli girdi. GERİ UYUMLULUK için korunur ve YALNIZ
   * bağlantıya özel bir değer YOKKEN kullanılır — hesap gerçeğini EZEMEZ.
   */
  credentialsPresentByProvider?: Record<string, boolean>
  /** Bağlantı kapsamlı webhook gözlemi (`connectionKey` anahtarlı). */
  webhookByConnection?: Record<string, WebhookObservation>
  /** ESKİ, sağlayıcı geneli gözlem. Bağlantıya özel değer ONU EZER. */
  webhookByProvider?: Record<string, WebhookObservation>
  nowMs: number
  lockStaleMs?: number
}

export class TenantScopeMissingError extends Error {}

interface ConnectionRow {
  providerKey: string
  marketplaceAccountId: string | null
  scope: ConnectionScope
  syncState: StoredSyncState
}

/**
 * Kiracının TÜM bağlantıları için sağlık.
 *
 * Her `integration_sync_state` satırı KENDİ sonucunu üretir; iki mağaza
 * BİRLEŞTİRİLMEZ. Hiç satırı olmayan desteklenen sağlayıcılar da listede
 * kalır ama `connectionScope: 'none'` ile — sahte hesap kimliği ÜRETİLMEZ.
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
      // 001A: HESAP KİMLİĞİ ARTIK OKUNUYOR — kimliğin parçasıdır.
      marketplaceAccountId: integrationSyncState.marketplaceAccountId,
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

  // SATIR BAŞINA bir bağlantı. `provider::account` anahtarı ile deterministik.
  const connections = new Map<string, ConnectionRow>()
  for (const row of rows) {
    const providerKey = String(row.provider ?? '').toLowerCase()
    const accountId = row.marketplaceAccountId ? String(row.marketplaceAccountId) : null
    connections.set(connectionKey(providerKey, accountId), {
      providerKey,
      marketplaceAccountId: accountId,
      // Hesap kimliği olmayan satır ESKİ bağlantıdır; id UYDURULMAZ.
      scope: accountId ? 'account' : 'legacy',
      syncState: {
        lastSyncStatus: (row.lastSyncStatus as string | null) ?? null,
        lastSuccessfulSyncAt: (row.lastSuccessfulSyncAt as Date | null) ?? null,
        lastErrorCode: (row.lastErrorCode as string | null) ?? null,
        lastFetchedCount: (row.lastFetchedCount as number | null) ?? null,
        updatedAt: (row.updatedAt as Date | null) ?? null,
      },
    })
  }

  const catalog = buildProviderCatalog()

  /** Bağlantıya özel değer ÖNCE; yoksa eski sağlayıcı geneli girdi. */
  const credentialsFor = (providerKey: string, accountId: string | null): boolean => {
    const key = connectionKey(providerKey, accountId)
    const scoped = query.credentialsPresentByConnection?.[key]
    if (typeof scoped === 'boolean') return scoped
    return Boolean(query.credentialsPresentByProvider?.[providerKey])
  }
  const webhookFor = (
    providerKey: string,
    accountId: string | null,
  ): WebhookObservation | null => {
    const key = connectionKey(providerKey, accountId)
    return (
      query.webhookByConnection?.[key] ??
      query.webhookByProvider?.[providerKey] ??
      null
    )
  }

  const out: IntegrationHealth[] = []

  // 1) GERÇEK bağlantılar — her biri AYRI kayıt.
  //    Sıralama giriş sırasından BAĞIMSIZ olsun diye anahtara göre sabitlenir.
  for (const key of [...connections.keys()].sort()) {
    const connection = connections.get(key)!
    const descriptor = catalog.get(connection.providerKey)
    if (!descriptor) continue
    out.push(
      resolveIntegrationHealth({
        descriptor,
        // YAYIN AŞAMASI SAĞLAYICI GENELİDİR (çekirdek kararı, 001A'da
        // DEĞİŞTİRİLMEDİ): `ROLLOUT_STAGE_POLICY` hesap bazlı değildir.
        rolloutStage: resolveRolloutStage(connection.providerKey),
        marketplaceAccountId: connection.marketplaceAccountId,
        connectionScope: connection.scope,
        credentialsPresent: credentialsFor(
          connection.providerKey,
          connection.marketplaceAccountId,
        ),
        syncState: connection.syncState,
        webhook: webhookFor(connection.providerKey, connection.marketplaceAccountId),
        nowMs: query.nowMs,
        ...(query.lockStaleMs != null ? { lockStaleMs: query.lockStaleMs } : {}),
      }),
    )
  }

  // 2) Desteklenen ama HİÇ bağlantısı olmayan sağlayıcılar.
  //    SAHTE hesap kimliği ÜRETİLMEZ: `scope: 'none'`, id `null`.
  for (const providerKey of HEALTH_SUPPORTED_PROVIDERS) {
    const hasConnection = [...connections.values()].some(
      (connection) => connection.providerKey === providerKey,
    )
    if (hasConnection) continue
    const descriptor = catalog.get(providerKey)
    if (!descriptor) continue
    out.push(
      resolveIntegrationHealth({
        descriptor,
        rolloutStage: resolveRolloutStage(providerKey),
        marketplaceAccountId: null,
        connectionScope: 'none',
        credentialsPresent: credentialsFor(providerKey, null),
        syncState: null,
        webhook: webhookFor(providerKey, null),
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
  /** Kanonik bağlantı kimliği — DEĞİŞKEN görünen ad DEĞİL. */
  marketplaceAccountId: string | null
  connectionScope: ConnectionScope
  connectionKey: string
  /** Operatörün iki mağazayı ayırt etmesi için GÜVENLİ etiket. */
  connectionLabel: string
  connection: string
  sync: string
  webhook: string
  reconciliation: string
  rolloutStage: string
  overall: string
  lastSuccessfulSyncAt: string | null
  attentionReasonCodes: string[]
}

/**
 * Bağlantı etiketi — KİMLİK DEĞİL, yalnız GÖSTERİM.
 *
 * Kanonik kimlik her zaman `marketplaceAccountId`tır. Etiket, operatörün iki
 * mağazayı ayırt edebilmesi için üretilir ve GİZLİ VERİ TAŞIMAZ: hesap
 * kimliğinin yalnız ilk 8 karakteri gösterilir (uuid öneki sır değildir,
 * kimlik bilgisi hiç değildir).
 */
export function connectionLabelOf(
  displayName: string,
  marketplaceAccountId: string | null,
  scope: ConnectionScope,
): string {
  if (scope === 'none') return displayName
  if (!marketplaceAccountId) return `${displayName} (eski bağlantı)`
  return `${displayName} · ${marketplaceAccountId.slice(0, 8)}`
}

export function toHealthView(
  health: IntegrationHealth,
  displayName: string,
): IntegrationHealthView {
  return {
    providerKey: health.providerKey,
    displayName,
    marketplaceAccountId: health.marketplaceAccountId,
    connectionScope: health.connectionScope,
    connectionKey: health.connectionKey,
    connectionLabel: connectionLabelOf(
      displayName,
      health.marketplaceAccountId,
      health.connectionScope,
    ),
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
