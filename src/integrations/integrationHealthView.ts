// ENTEGRASYON SAĞLIĞI — SUNUM KATMANI (SAF).
//
// ═══ DÜRÜST KOPYA KURALI ═════════════════════════════════════════════════
//
// "Bağlantı sağlıklı" YALNIZCA kimlik bilgisi girilmiş olduğu için ASLA
// yazılmaz. Bu dosya durum kodlarını kullanıcı metnine çevirir ve şu iki
// yanlışı yapısal olarak İMKÂNSIZ kılar:
//
//   · Hiç senkron edilmemiş bağlantıya "sağlıklı" demek
//   · Sağlayıcının SUNMADIĞI bir özelliği KIRMIZI HATA gibi göstermek
//
// Ham sağlayıcı hata metni buraya GİRMEZ; yalnız kararlı sebep kodları.

export type HealthSeverity = 'ok' | 'info' | 'warning' | 'critical' | 'muted'

export interface IntegrationHealthViewModel {
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

export interface PresentedHealth {
  providerKey: string
  displayName: string
  headline: string
  severity: HealthSeverity
  /** Kullanıcıya gösterilecek satırlar (etiket + değer). */
  facts: { label: string; value: string }[]
  /** Aksiyon gerekiyorsa TEK, anlaşılır cümle; yoksa null. */
  actionText: string | null
  /** Yayın aşaması görünür olmalı: "çalışmıyor" ile "açılmadı" ayrı şeydir. */
  stageText: string
}

const OVERALL_COPY: Record<string, { text: string; severity: HealthSeverity }> = {
  OPERATIONAL: { text: 'Çalışıyor', severity: 'ok' },
  DEGRADED: { text: 'Kısmi çalışıyor', severity: 'warning' },
  ACTION_REQUIRED: { text: 'İşlem gerekli', severity: 'critical' },
  NOT_CONFIGURED: { text: 'Bağlantı kurulmadı', severity: 'muted' },
  DISABLED: { text: 'Henüz açılmadı', severity: 'muted' },
}

const SYNC_COPY: Record<string, string> = {
  HEALTHY: 'Güncel',
  STALE: 'Gecikmiş',
  RUNNING: 'Senkron sürüyor',
  FAILED: 'Başarısız',
  NEVER_RUN: 'Henüz senkron edilmedi',
}

const WEBHOOK_COPY: Record<string, string> = {
  HEALTHY: 'Anlık bildirim çalışıyor',
  DEGRADED: 'Anlık bildirim iletilemiyor',
  DISABLED: 'Anlık bildirim durduruldu',
  NOT_SUPPORTED: 'Periyodik kontrol',
  NOT_CONFIGURED: 'Anlık bildirim kurulmadı',
  UNKNOWN: 'Henüz bildirim alınmadı',
}

const RECONCILIATION_COPY: Record<string, string> = {
  HEALTHY: 'Güncel',
  STALE: 'Gecikmiş',
  FAILED: 'Başarısız',
  NOT_SUPPORTED: 'Kullanılmıyor',
  NOT_CONFIGURED: 'Henüz başlamadı',
}

const STAGE_COPY: Record<string, string> = {
  off: 'Kapalı',
  internal_test: 'İç test',
  shadow: 'Gölge mod',
  pilot: 'Pilot',
  ga: 'Aktif',
}

/**
 * Aksiyon metni — ÖNCELİK SIRALI.
 *
 * Aynı anda birden çok sebep olabilir; kullanıcıya EN ÖNEMLİ OLAN tek cümle
 * gösterilir. Liste hâlinde sebep dökmek operatör yüzeyinin işidir.
 */
const ACTION_PRIORITY: { code: string; text: string }[] = [
  { code: 'CREDENTIALS_REJECTED', text: 'Kimlik doğrulama gerekli — bilgileri güncelleyin.' },
  { code: 'SYNC_FAILED', text: 'Son senkron başarısız oldu; otomatik olarak yeniden denenecek.' },
  { code: 'NOT_CONFIGURED', text: 'Bağlantıyı kurmak için bilgileri girin.' },
  { code: 'SYNC_STALE', text: 'Senkron gecikmiş; kısa süre içinde yeniden denenecek.' },
  { code: 'RECONCILIATION_STALE', text: 'Mutabakat gecikmiş; kısa süre içinde yeniden denenecek.' },
  { code: 'SYNC_LOCK_STALE', text: 'Önceki senkron yarım kaldı; yeni deneme başlatılacak.' },
  { code: 'WEBHOOK_DISABLED_BY_PROVIDER', text: 'Anlık bildirim sağlayıcı tarafından durduruldu; periyodik kontrol sürüyor.' },
  { code: 'WEBHOOK_DELIVERY_FAILING', text: 'Anlık bildirim iletilemiyor; periyodik kontrol sürüyor.' },
  { code: 'AWAITING_FIRST_SYNC', text: 'Bağlandı — ilk senkron bekleniyor.' },
  { code: 'CREDENTIALS_NOT_PROVEN', text: 'Bağlandı — ilk senkron bekleniyor.' },
]

/**
 * DESTEKLENMEYEN ÖZELLİK AKSİYON DEĞİLDİR.
 *
 * Sağlayıcı webhook sunmuyorsa ya da sözleşmesi doğrulanmadıysa kullanıcıdan
 * yapabileceği bir şey YOKTUR; bunlar aksiyon listesine GİRMEZ.
 */
const NON_ACTIONABLE = new Set([
  'WEBHOOK_NOT_OFFERED_BY_PROVIDER',
  'WEBHOOK_CONTRACT_NOT_VERIFIED',
  'WEBHOOK_NO_TRAFFIC_OBSERVED',
  'WEBHOOK_NOT_CONFIGURED',
  'ROLLOUT_OFF',
])

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'Henüz yok'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'Henüz yok'
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

export function presentIntegrationHealth(
  model: IntegrationHealthViewModel,
): PresentedHealth {
  const overall = OVERALL_COPY[model.overall] ?? { text: 'Bilinmiyor', severity: 'muted' as HealthSeverity }

  const action =
    ACTION_PRIORITY.find(
      (entry) =>
        model.attentionReasonCodes.includes(entry.code) && !NON_ACTIONABLE.has(entry.code),
    ) ?? null

  const facts: { label: string; value: string }[] = [
    { label: 'Senkron', value: SYNC_COPY[model.sync] ?? model.sync },
    { label: 'Son başarılı senkron', value: formatSyncTime(model.lastSuccessfulSyncAt) },
    { label: 'Güncelleme yöntemi', value: WEBHOOK_COPY[model.webhook] ?? model.webhook },
    { label: 'Mutabakat', value: RECONCILIATION_COPY[model.reconciliation] ?? model.reconciliation },
  ]

  return {
    providerKey: model.providerKey,
    displayName: model.displayName,
    headline: overall.text,
    severity: overall.severity,
    facts,
    actionText: action ? action.text : null,
    stageText: STAGE_COPY[model.rolloutStage] ?? model.rolloutStage,
  }
}

/** Desteklenmeyen özellik KIRMIZI gösterilmemeli — bileşenler bunu kullanır. */
export function webhookSeverity(webhookState: string): HealthSeverity {
  if (webhookState === 'HEALTHY') return 'ok'
  if (webhookState === 'DEGRADED' || webhookState === 'DISABLED') return 'warning'
  // NOT_SUPPORTED / NOT_CONFIGURED / UNKNOWN → bilgi, hata DEĞİL.
  return 'info'
}
