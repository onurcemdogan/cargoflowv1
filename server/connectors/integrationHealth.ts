// KANONİK ENTEGRASYON SAĞLIĞI (INTEGRATION-HEALTH-001) — SAF ÇÖZÜMLEYİCİ.
//
// ═══ NEDEN SAF VE NEDEN `now` DIŞARIDAN ══════════════════════════════════
//
// Sağlık, SAKLANMIŞ durumdan TÜRETİLİR; hiçbir yerde `Date.now()` çağrılmaz.
// Zaman girdi olduğu için "bayat mı" sorusu DETERMİNİSTİK biçimde test
// edilebilir (IH-13). DB/ağ erişimi bu dosyada YOKTUR.
//
// ═══ ÇÖKERTİLMEYEN KAVRAMLAR ═════════════════════════════════════════════
//
// Bağlı olmak ≠ kimlik geçerli ≠ senkron taze ≠ webhook sağlıklı ≠ yetenek
// destekli ≠ yayına açık. Bunlar AYRI alanlardır ve tek bir boolean'a
// indirgenmezler. En sık yapılan hata "kimlik bilgisi var → sağlıklı"
// demektir; bu model bunu YAPAMAZ: kimlik geçerliliği ancak KİMLİK
// DOĞRULANMIŞ BİR OKUMA başardığında VALID olur.
//
// ═══ DESTEKLENMEYEN ≠ BOZUK ══════════════════════════════════════════════
//
// ikas webhook imzası resmî dokümanda YOK, Ticimax webhook SUNMUYOR. Bu
// durumlar KIRMIZI HATA DEĞİLDİR; kasıtlı yetenek durumudur. Sözleşme
// paketindeki `contractVerified` bayrağı bu ayrımın tek kaynağıdır.
import {
  findCapability,
  stageAffectsLiveBehavior,
  type CapabilityStage,
  type ConnectorDescriptor,
} from './connectorKernel.ts'

export const CONNECTION_STATES = ['CONNECTED', 'DISCONNECTED', 'NOT_CONFIGURED'] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]

export const CREDENTIAL_STATES = ['VALID', 'INVALID', 'UNKNOWN', 'NOT_REQUIRED'] as const
export type CredentialState = (typeof CREDENTIAL_STATES)[number]

/**
 * KİMLİK BİLGİSİNİN ŞU ANKİ VARLIĞI — ÜÇ DURUMLU, BOOLEAN DEĞİL.
 *
 * Tek bir boolean "açıkça YOK" ile "BİLMİYORUZ"u ayıramaz ve bu ayrım
 * kritiktir: GEÇMİŞTE başarılı bir kimlik doğrulanmış okuma, o kimliğin
 * O ZAMAN geçerli olduğunu kanıtlar — BUGÜN HÂLÂ DURDUĞUNU DEĞİL.
 *
 * Ölçülen kusur: kimlik bilgisi SİLİNMİŞ bir bağlantı, eski bir başarılı
 * senkron sayesinde CONNECTED/VALID görünüyordu.
 */
export const CREDENTIAL_PRESENCE = ['PRESENT', 'ABSENT', 'UNKNOWN'] as const
export type CredentialPresence = (typeof CREDENTIAL_PRESENCE)[number]

export const SYNC_STATES = ['HEALTHY', 'STALE', 'RUNNING', 'FAILED', 'NEVER_RUN'] as const
export type SyncState = (typeof SYNC_STATES)[number]

export const RECONCILIATION_STATES = [
  'HEALTHY', 'STALE', 'FAILED', 'NOT_SUPPORTED', 'NOT_CONFIGURED',
] as const
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number]

export const WEBHOOK_STATES = [
  'HEALTHY', 'DEGRADED', 'DISABLED', 'NOT_SUPPORTED', 'NOT_CONFIGURED', 'UNKNOWN',
] as const
export type WebhookState = (typeof WEBHOOK_STATES)[number]

export const OVERALL_STATES = [
  'OPERATIONAL', 'DEGRADED', 'ACTION_REQUIRED', 'NOT_CONFIGURED', 'DISABLED',
] as const
export type OverallState = (typeof OVERALL_STATES)[number]

/** KARARLI hata sınıfları — ham sağlayıcı metni UI'a ÇIKMAZ. */
export const ERROR_CLASSES = [
  'AUTH', 'RATE_LIMIT', 'PROVIDER_5XX', 'NETWORK', 'MALFORMED_RESPONSE',
  'CONTRACT_MISMATCH', 'CHECKPOINT_ERROR', 'UNKNOWN',
] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

/**
 * Ham hata kodu → kararlı sınıf.
 *
 * Kod SÖZLÜĞE göre eşlenir; eşleşmeyen `UNKNOWN` olur. Ham metin DÖNDÜRÜLMEZ:
 * sağlayıcı hata gövdeleri kimlik/uç nokta/kimlik bilgisi parçası taşıyabilir.
 */
export function classifyErrorCode(code: unknown): ErrorClass {
  const text = String(code ?? '').trim().toUpperCase()
  if (text === '') return 'UNKNOWN'
  if (/(^|_)(401|403)(_|$)|UNAUTHORIZED|FORBIDDEN|AUTH|TOKEN|CREDENTIAL|SIGNATURE/.test(text)) {
    return 'AUTH'
  }
  if (/429|RATE_?LIMIT|TOO_?MANY/.test(text)) return 'RATE_LIMIT'
  if (/(^|_)(5\d\d)(_|$)|SERVER_?ERROR|BAD_?GATEWAY|UNAVAILABLE|GATEWAY_?TIMEOUT/.test(text)) {
    return 'PROVIDER_5XX'
  }
  if (/NETWORK|ECONN|ETIMEDOUT|ENOTFOUND|DNS|SOCKET|TIMEOUT/.test(text)) return 'NETWORK'
  if (/MALFORMED|PARSE|INVALID_?JSON|INVALID_?XML|DECODE/.test(text)) return 'MALFORMED_RESPONSE'
  if (/CONTRACT|SCHEMA_?MISMATCH|UNEXPECTED_?FIELD|VERSION_?MISMATCH/.test(text)) {
    return 'CONTRACT_MISMATCH'
  }
  if (/CHECKPOINT|CURSOR|WATERMARK/.test(text)) return 'CHECKPOINT_ERROR'
  return 'UNKNOWN'
}

/**
 * TAZELİK POLİTİKASI — sağlayıcı/yetenek güdümlü, TEK GLOBAL EŞİK YOK.
 *
 * Gerekçe: gerçek zamanlı olay taşıyan bir bağlantıda yoklama SİGORTADIR ve
 * seyrek olabilir. Yoklamanın TEK doğruluk yolu olduğu bir bağlantıda ise
 * aynı gecikme çok daha erken "bayat"tır. Eşiği sağlayıcıya değil YETENEĞE
 * bağlamak, yeni sağlayıcı eklendiğinde bu dosyanın değişmesini önler.
 */
export const FRESHNESS_MODES = [
  'webhook_plus_reconciliation', 'polling_only', 'manual',
] as const
export type FreshnessMode = (typeof FRESHNESS_MODES)[number]

export interface FreshnessPolicy {
  mode: FreshnessMode
  syncStaleAfterMs: number
  reconciliationStaleAfterMs: number | null
}

const HOUR = 3_600_000

export function resolveFreshnessPolicy(descriptor: ConnectorDescriptor): FreshnessPolicy {
  const orders = findCapability(descriptor, 'orders.read')
  if (!orders || !orders.supported || !orders.contractVerified) {
    return { mode: 'manual', syncStaleAfterMs: Number.POSITIVE_INFINITY, reconciliationStaleAfterMs: null }
  }
  const webhook = findCapability(descriptor, 'orders.webhook')
  const webhookUsable = Boolean(webhook && webhook.supported && webhook.contractVerified)
  if (webhookUsable) {
    // Olay akışı taze tutar; mutabakat SİGORTADIR → 24 saat.
    return { mode: 'webhook_plus_reconciliation', syncStaleAfterMs: 24 * HOUR, reconciliationStaleAfterMs: 24 * HOUR }
  }
  // Yoklama TEK doğruluk yolu → çok daha sıkı eşik.
  return { mode: 'polling_only', syncStaleAfterMs: 2 * HOUR, reconciliationStaleAfterMs: 2 * HOUR }
}

/** `integration_sync_state` satırının sağlık için okunan ALT KÜMESİ. */
export interface StoredSyncState {
  lastSyncStatus: string | null
  /** Hem son başarı hem ARTIMLI İMLEÇ — üretimde aynı kolondur. */
  lastSuccessfulSyncAt: Date | string | null
  lastErrorCode: string | null
  lastFetchedCount: number | null
  /** Son DENEME anı (başarı/başarısızlık fark etmeksizin). */
  updatedAt: Date | string | null
}

/** YALNIZ GERÇEKTEN GÖZLENMİŞ webhook olayları. Sayaç UYDURULMAZ. */
export interface WebhookObservation {
  lastReceivedAt?: Date | string | null
  lastVerifiedAt?: Date | string | null
  consecutiveDeliveryFailures?: number | null
  /** Yalnız SAĞLAYICI durumu kanıtlıyorsa doldurulur. */
  disabledAt?: Date | string | null
  /** Operatör webhook'u kurdu mu (abonelik kaydı var mı). */
  configured?: boolean
}

/**
 * BAĞLANTI KAPSAMI — sağlığın kimliği SAĞLAYICI DEĞİL, BAĞLANTIDIR.
 *
 *   'account' → gerçek bir mağaza/hesap satırı (marketplaceAccountId dolu)
 *   'legacy'  → hesap kimliği OLMAYAN eski bağlantı (id UYDURULMAZ)
 *   'none'    → bağlantı hiç kurulmamış; yalnız "destekleniyor" bilgisi
 *
 * `legacy` ile `none` AYNI ŞEY DEĞİLDİR: ilkinde gerçek bir senkron geçmişi
 * vardır, ikincisinde hiç bağlantı yoktur.
 */
export const CONNECTION_SCOPES = ['account', 'legacy', 'none'] as const
export type ConnectionScope = (typeof CONNECTION_SCOPES)[number]

/** Bağlantının deterministik bileşik anahtarı. Hesap yoksa `legacy`. */
export function connectionKey(
  providerKey: string,
  marketplaceAccountId: string | null | undefined,
): string {
  const provider = String(providerKey ?? '').trim().toLowerCase()
  const account = String(marketplaceAccountId ?? '').trim() || 'legacy'
  return `${provider}::${account}`
}

export interface IntegrationHealthInput {
  descriptor: ConnectorDescriptor
  rolloutStage: CapabilityStage
  /** Bağlantı kimliği. UYDURULMAZ: yoksa null kalır. */
  marketplaceAccountId?: string | null
  connectionScope?: ConnectionScope
  /**
   * Kimlik bilgisinin ŞU ANKİ varlığı. Tercih edilen alan budur.
   * `ABSENT`, `UNKNOWN`DAN DAHA GÜÇLÜ kanıttır ve geçmiş başarıyı EZER.
   */
  credentialsPresence?: CredentialPresence
  /**
   * ESKİ boolean girdi (geri uyumluluk). `true` → PRESENT, `false` → ABSENT.
   * "Bilmiyorum" ifade EDEMEDİĞİ için yeni çağıranlar `credentialsPresence`
   * kullanmalıdır.
   */
  credentialsPresent?: boolean
  credentialsRequired?: boolean
  syncState: StoredSyncState | null
  webhook?: WebhookObservation | null
  nowMs: number
  /** Kilidin bayat sayılacağı süre (üretim: 120_000). */
  lockStaleMs?: number
}

export interface IntegrationHealthReason {
  code: string
  component: 'connection' | 'credentials' | 'sync' | 'reconciliation' | 'webhook' | 'rollout'
  errorClass?: ErrorClass
}

export interface IntegrationHealth {
  providerKey: string
  /** Bağlantı kimliği — aynı sağlayıcının iki mağazası AYRI kayıttır. */
  marketplaceAccountId: string | null
  connectionScope: ConnectionScope
  /** Deterministik bileşik anahtar (`provider::account`). */
  connectionKey: string
  connection: ConnectionState
  credentials: CredentialState
  sync: SyncState
  reconciliation: ReconciliationState
  webhook: WebhookState
  rolloutStage: CapabilityStage
  overall: OverallState
  freshness: FreshnessPolicy
  lastSuccessfulSyncAt: string | null
  lastAttemptAt: string | null
  lastErrorClass: ErrorClass | null
  reasons: IntegrationHealthReason[]
  checkedAt: string
}

const SYNC_LOCK_STATUS = 'running'
const DEFAULT_LOCK_STALE_MS = 120_000

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

function toIso(value: Date | string | null | undefined): string | null {
  const ms = toMs(value)
  return ms === null ? null : new Date(ms).toISOString()
}

/**
 * KANONİK SAĞLIK TÜRETİMİ.
 *
 * Bileşenler ÖNCE bağımsız çözülür, genel durum SONRA ve MUHAFAZAKÂR biçimde
 * onlardan türetilir. Genel durum asla bir bileşeni "iyileştirmez".
 */
export function resolveIntegrationHealth(input: IntegrationHealthInput): IntegrationHealth {
  const reasons: IntegrationHealthReason[] = []
  const policy = resolveFreshnessPolicy(input.descriptor)
  const lockStaleMs = input.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
  const credentialsRequired = input.credentialsRequired ?? true

  const state = input.syncState
  const lastSuccessMs = toMs(state?.lastSuccessfulSyncAt)
  const lastAttemptMs = toMs(state?.updatedAt)
  const status = String(state?.lastSyncStatus ?? '').trim().toLowerCase()
  const errorClass = state?.lastErrorCode ? classifyErrorCode(state.lastErrorCode) : null

  // ── KİMLİK ──────────────────────────────────────────────────────────────
  //
  // İKİ AYRI OLGU KARIŞTIRILMAZ:
  //   · GEÇMİŞ kanıt  : başarılı kimlik doğrulanmış okuma OLDU MU
  //   · ŞU ANKİ varlık: kimlik bilgisi HÂLÂ DURUYOR MU
  //
  // Açık YOKLUK, geçmiş başarıyı EZER: silinmiş bir kimlik eski bir senkronla
  // DİRİLTİLEMEZ. `UNKNOWN` ise geçmiş kanıtın kullanılmasına izin verir.
  const presence: CredentialPresence =
    input.credentialsPresence ??
    (typeof input.credentialsPresent === 'boolean'
      ? input.credentialsPresent
        ? 'PRESENT'
        : 'ABSENT'
      : 'UNKNOWN')

  let credentials: CredentialState
  if (!credentialsRequired) {
    credentials = 'NOT_REQUIRED'
  } else if (presence === 'ABSENT') {
    // GEÇMİŞ BAŞARI BURADA KULLANILMAZ — kimlik artık YOK.
    credentials = 'UNKNOWN'
    reasons.push({ code: 'CREDENTIALS_ABSENT', component: 'credentials' })
  } else if (errorClass === 'AUTH') {
    credentials = 'INVALID'
    reasons.push({ code: 'CREDENTIALS_REJECTED', component: 'credentials', errorClass: 'AUTH' })
  } else if (lastSuccessMs !== null) {
    credentials = 'VALID'
  } else {
    credentials = 'UNKNOWN'
    if (presence === 'PRESENT') {
      reasons.push({ code: 'CREDENTIALS_NOT_PROVEN', component: 'credentials' })
    }
  }

  // ── BAĞLANTI ────────────────────────────────────────────────────────────
  //
  // BAŞARILI SENKRON, YAPILANDIRMANIN KANITIDIR. Çağıran `credentialsPresent`
  // bildirmese bile, kimlik doğrulanmış bir okuma BAŞARMIŞ bir bağlantıya
  // "kurulmadı" demek KENDİ İÇİNDE ÇELİŞKİLİDİR — elimizde o bağlantının
  // çalıştığına dair kayıt vardır. Bu, çok hesaplı testte ortaya çıktı:
  // çağıran kimlik varlığını hesap bazında bildirmediğinde, gerçekten
  // senkron etmiş bir mağaza "kurulmadı" görünüyordu.
  let connection: ConnectionState
  if (credentialsRequired && presence === 'ABSENT') {
    // AÇIK YOKLUK KAZANIR; geçmiş başarı bunu değiştirmez.
    connection = 'NOT_CONFIGURED'
    reasons.push({ code: 'NOT_CONFIGURED', component: 'connection' })
  } else if (credentials === 'INVALID') {
    connection = 'DISCONNECTED'
  } else if (!credentialsRequired || presence === 'PRESENT') {
    connection = 'CONNECTED'
  } else if (lastSuccessMs !== null) {
    // BİLİNMİYOR + geçmiş kimlik doğrulanmış okuma → kanıt KULLANILABİLİR.
    connection = 'CONNECTED'
  } else {
    // Ne şimdiki varlık bilgisi ne geçmiş kanıt var.
    connection = 'NOT_CONFIGURED'
    reasons.push({ code: 'NOT_CONFIGURED', component: 'connection' })
  }

  // ── SENKRON ─────────────────────────────────────────────────────────────
  let sync: SyncState
  if (connection === 'NOT_CONFIGURED') {
    sync = 'NEVER_RUN'
  } else if (
    status === SYNC_LOCK_STATUS &&
    lastAttemptMs !== null &&
    input.nowMs - lastAttemptMs <= lockStaleMs
  ) {
    sync = 'RUNNING'
  } else if (status === 'failed') {
    sync = 'FAILED'
    reasons.push({
      code: 'SYNC_FAILED',
      component: 'sync',
      ...(errorClass ? { errorClass } : {}),
    })
  } else if (lastSuccessMs === null) {
    // HİÇ ÇALIŞMADI ile BAŞARISIZ AYRI durumlardır (IH-15).
    sync = 'NEVER_RUN'
    reasons.push({ code: 'SYNC_NEVER_RUN', component: 'sync' })
  } else if (input.nowMs - lastSuccessMs > policy.syncStaleAfterMs) {
    sync = 'STALE'
    reasons.push({ code: 'SYNC_STALE', component: 'sync' })
  } else {
    sync = 'HEALTHY'
  }
  // Bayat kilit: "running" görünüyor ama kimse ilerletmiyor.
  if (
    status === SYNC_LOCK_STATUS &&
    sync !== 'RUNNING' &&
    lastAttemptMs !== null &&
    input.nowMs - lastAttemptMs > lockStaleMs
  ) {
    reasons.push({ code: 'SYNC_LOCK_STALE', component: 'sync' })
  }

  // ── WEBHOOK ─────────────────────────────────────────────────────────────
  // DESTEKLENMEYEN ≠ BOZUK. Sözleşme doğrulanmamışsa kırmızı gösterilmez.
  const webhookCap = findCapability(input.descriptor, 'orders.webhook')
  const observation = input.webhook ?? null
  let webhook: WebhookState
  if (!webhookCap || !webhookCap.supported) {
    webhook = 'NOT_SUPPORTED'
    reasons.push({
      code: webhookCap && !webhookCap.contractVerified
        ? 'WEBHOOK_CONTRACT_NOT_VERIFIED'
        : 'WEBHOOK_NOT_OFFERED_BY_PROVIDER',
      component: 'webhook',
    })
  } else if (!webhookCap.contractVerified) {
    webhook = 'NOT_SUPPORTED'
    reasons.push({ code: 'WEBHOOK_CONTRACT_NOT_VERIFIED', component: 'webhook' })
  } else if (toMs(observation?.disabledAt) !== null) {
    // YALNIZ sağlayıcı durumu kanıtladıysa.
    webhook = 'DISABLED'
    reasons.push({ code: 'WEBHOOK_DISABLED_BY_PROVIDER', component: 'webhook' })
  } else if (!observation || observation.configured === false) {
    webhook = 'NOT_CONFIGURED'
    reasons.push({ code: 'WEBHOOK_NOT_CONFIGURED', component: 'webhook' })
  } else if (Number(observation.consecutiveDeliveryFailures ?? 0) > 0) {
    webhook = 'DEGRADED'
    reasons.push({ code: 'WEBHOOK_DELIVERY_FAILING', component: 'webhook' })
  } else if (toMs(observation.lastReceivedAt) !== null) {
    webhook = 'HEALTHY'
  } else {
    // TRAFİK YOKLUĞU BAŞARISIZLIK DEĞİLDİR: hiç olay beklenmemiş olabilir.
    webhook = 'UNKNOWN'
    reasons.push({ code: 'WEBHOOK_NO_TRAFFIC_OBSERVED', component: 'webhook' })
  }

  // ── MUTABAKAT ───────────────────────────────────────────────────────────
  // Mutabakat, yoklama tabanlı doğruluk sigortasıdır ve webhook'tan BAĞIMSIZ
  // görünür kalır: webhook çökse bile mutabakat sağlıklıysa sistem çalışır.
  let reconciliation: ReconciliationState
  const ordersCap = findCapability(input.descriptor, 'orders.read')
  if (!ordersCap || !ordersCap.supported || !ordersCap.contractVerified) {
    reconciliation = 'NOT_SUPPORTED'
  } else if (connection === 'NOT_CONFIGURED') {
    reconciliation = 'NOT_CONFIGURED'
  } else if (sync === 'FAILED') {
    reconciliation = 'FAILED'
  } else if (lastSuccessMs === null) {
    reconciliation = 'NOT_CONFIGURED'
  } else if (
    policy.reconciliationStaleAfterMs !== null &&
    input.nowMs - lastSuccessMs > policy.reconciliationStaleAfterMs
  ) {
    reconciliation = 'STALE'
    reasons.push({ code: 'RECONCILIATION_STALE', component: 'reconciliation' })
  } else {
    reconciliation = 'HEALTHY'
  }

  // ── GENEL DURUM — MUHAFAZAKÂR ───────────────────────────────────────────
  // SAĞLIK AŞAMAYI İLERLETMEZ: `rolloutStage` politika/konfigürasyondur ve
  // burada YALNIZ OKUNUR. Yeşil sağlık `off`u `pilot` yapmaz.
  let overall: OverallState
  if (input.rolloutStage === 'off') {
    overall = 'DISABLED'
    reasons.push({ code: 'ROLLOUT_OFF', component: 'rollout' })
  } else if (connection === 'NOT_CONFIGURED') {
    overall = 'NOT_CONFIGURED'
  } else if (credentials === 'INVALID' || sync === 'FAILED') {
    overall = 'ACTION_REQUIRED'
  } else if (sync === 'NEVER_RUN') {
    // Bağlandı ama ilk senkron beklenir — hata DEĞİL.
    overall = 'DEGRADED'
    reasons.push({ code: 'AWAITING_FIRST_SYNC', component: 'sync' })
  } else if (sync === 'STALE' || reconciliation === 'STALE' || webhook === 'DEGRADED' || webhook === 'DISABLED') {
    overall = 'DEGRADED'
  } else {
    overall = 'OPERATIONAL'
  }

  const marketplaceAccountId = input.marketplaceAccountId ?? null
  const connectionScope: ConnectionScope =
    input.connectionScope ?? (marketplaceAccountId ? 'account' : 'legacy')

  return {
    providerKey: input.descriptor.providerKey,
    marketplaceAccountId,
    connectionScope,
    connectionKey: connectionKey(input.descriptor.providerKey, marketplaceAccountId),
    connection,
    credentials,
    sync,
    reconciliation,
    webhook,
    rolloutStage: input.rolloutStage,
    overall,
    freshness: policy,
    lastSuccessfulSyncAt: toIso(state?.lastSuccessfulSyncAt),
    lastAttemptAt: toIso(state?.updatedAt),
    lastErrorClass: errorClass,
    reasons,
    checkedAt: new Date(input.nowMs).toISOString(),
  }
}

/**
 * Sağlık bir yeteneği CANLI kullanmaya yetkilendirir mi?
 *
 * Yetki İKİ koşulu birden ister: aşama canlı OLMALI **ve** sağlık eylem
 * gerektirmemeli. Sağlık tek başına aşamayı açmaz (IH-9/IH-10).
 */
export function healthPermitsLiveMutation(health: IntegrationHealth): boolean {
  return (
    stageAffectsLiveBehavior(health.rolloutStage) &&
    (health.overall === 'OPERATIONAL' || health.overall === 'DEGRADED')
  )
}

/** Operatör/tüccar kopyası — ham sağlayıcı metni ASLA taşınmaz. */
export const HEALTH_REASON_COPY_TR: Record<string, string> = {
  NOT_CONFIGURED: 'Bağlantı kurulmadı',
  CREDENTIALS_ABSENT: 'Kimlik bilgisi kaldırılmış — yeniden bağlayın',
  CREDENTIALS_NOT_PROVEN: 'Bağlandı — ilk senkron bekleniyor',
  CREDENTIALS_REJECTED: 'Kimlik doğrulama gerekli',
  SYNC_NEVER_RUN: 'Bağlandı — ilk senkron bekleniyor',
  AWAITING_FIRST_SYNC: 'Bağlandı — ilk senkron bekleniyor',
  SYNC_STALE: 'Senkron gecikmiş',
  SYNC_FAILED: 'Senkron başarısız — yeniden denenecek',
  SYNC_LOCK_STALE: 'Önceki senkron yarım kaldı',
  RECONCILIATION_STALE: 'Mutabakat gecikmiş',
  WEBHOOK_NOT_OFFERED_BY_PROVIDER: 'Bu sağlayıcı anlık bildirim sunmuyor — periyodik kontrol kullanılıyor',
  WEBHOOK_CONTRACT_NOT_VERIFIED: 'Anlık bildirim doğrulanamadığı için kapalı — periyodik kontrol kullanılıyor',
  WEBHOOK_NOT_CONFIGURED: 'Anlık bildirim kurulmadı',
  WEBHOOK_DELIVERY_FAILING: 'Anlık bildirim iletilemiyor — periyodik kontrol sürüyor',
  WEBHOOK_DISABLED_BY_PROVIDER: 'Anlık bildirim sağlayıcı tarafından durduruldu',
  WEBHOOK_NO_TRAFFIC_OBSERVED: 'Henüz bildirim alınmadı',
  ROLLOUT_OFF: 'Bu entegrasyon henüz açılmadı',
}
