// N11 HESAP SAĞLIĞI — saf karar (ağ/DB YOK).
//
// Kaynaklar: hesabın kimliği (VAR MI) + son okuma koşusunun kaydı
// (`integration_sync_state`, hesap kapsamlı). Ham sağlayıcı metni DÖNMEZ.
// Uç nokta resmî olarak kanıtlı olduğu için "uç nokta yapılandırması" durumu
// YOKTUR. "Canlı" İDDİASI YOK: bu modül `liveVerified` ÜRETMEZ.

export const N11_HEALTH_STATES = [
  'NEVER_RUN',
  'OK',
  'AUTH_ERROR',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'RESPONSE_SHAPE_UNVERIFIED',
  'PARTIAL',
] as const
export type N11HealthState = (typeof N11_HEALTH_STATES)[number]

// ═══ KARARLI SEBEP KODLARI (imleç İLERLEMEDİĞİNDE) ═══════════════════════

/** Okuma başarılı, kanonik yazım yayın aşamasınca KAPALI (iç test). Sağlıkta OK okunur. */
export const N11_CANONICAL_WRITE_BLOCKED = 'N11_CANONICAL_WRITE_BLOCKED'
/** Kimliksiz (paket ve sipariş no yok) ya da nesne olmayan ham kayıt. */
export const N11_RECORD_IDENTITY_MISSING = 'N11_RECORD_IDENTITY_MISSING'
/** Kayıt kanonik depoya yazılamaz (paket no null / Created tarihi yok). */
export const N11_RECORD_NOT_PERSISTABLE = 'N11_RECORD_NOT_PERSISTABLE'
/** Yazıcı kaydı atladı. */
export const N11_PERSIST_SKIPPED = 'N11_PERSIST_SKIPPED'
/** Yazım hatası, sonuç yok ya da yazılan sayı beklenenle eşleşmiyor. */
export const N11_PERSIST_INCOMPLETE = 'N11_PERSIST_INCOMPLETE'
/** Bağlı satıcıdan farklı (ya da birden çok) `sellerId` döndü. */
export const N11_SELLER_MISMATCH = 'N11_SELLER_MISMATCH'
/** Aynı satıcı bu kiracıda BAŞKA etkin n11 hesabına bağlı (mükerrer sipariş riski). */
export const N11_SELLER_ALREADY_CONNECTED = 'N11_SELLER_ALREADY_CONNECTED'
/**
 * En kısa bölünebilir aralık bile tek sayfaya sığmadı (aynı zaman diliminde
 * çok kayıt). Güvensiz sayfa yürütmeye düşülmez; imleç o pencereden geçmez.
 */
export const N11_DENSE_WINDOW_UNSPLITTABLE = 'N11_DENSE_WINDOW_UNSPLITTABLE'
/** Koşu başına istek tavanı doldu; imleç son dayanıklı pencerede durur. */
export const N11_REQUEST_BUDGET_EXHAUSTED = 'N11_REQUEST_BUDGET_EXHAUSTED'

export interface N11HealthInput {
  credentialsComplete: boolean
  syncState: {
    lastSyncStatus?: unknown
    lastErrorCode?: unknown
    lastSuccessfulSyncAt?: unknown
    updatedAt?: unknown
  } | null
}

export interface N11Health {
  state: N11HealthState
  reasonCode: string | null
  lastSuccessfulSyncAt: string | null
  lastAttemptAt: string | null
}

const iso = (value: unknown): string | null => {
  if (!value) return null
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function stateForCode(code: string, fallback: N11HealthState): N11HealthState {
  if (/N11_HTTP_40[13]|AUTH|CREDENTIAL/.test(code)) return 'AUTH_ERROR'
  if (/429|RATE/.test(code)) return 'RATE_LIMITED'
  if (/RESPONSE_SHAPE|NOT_JSON/.test(code)) return 'RESPONSE_SHAPE_UNVERIFIED'
  return fallback
}

export function resolveN11Health(input: N11HealthInput): N11Health {
  const state = input.syncState
  const lastSuccessfulSyncAt = iso(state?.lastSuccessfulSyncAt)
  const lastAttemptAt = iso(state?.updatedAt)
  if (!input.credentialsComplete) {
    return { state: 'AUTH_ERROR', reasonCode: 'N11_CREDENTIALS_INCOMPLETE', lastSuccessfulSyncAt, lastAttemptAt }
  }
  const status = String(state?.lastSyncStatus ?? '')
  const code = String(state?.lastErrorCode ?? '')
  if (!state || status === '') return { state: 'NEVER_RUN', reasonCode: null, lastSuccessfulSyncAt, lastAttemptAt }
  if (status === 'success') return { state: 'OK', reasonCode: null, lastSuccessfulSyncAt, lastAttemptAt }
  if (status === 'partial') {
    if (code === N11_CANONICAL_WRITE_BLOCKED) return { state: 'OK', reasonCode: code, lastSuccessfulSyncAt, lastAttemptAt }
    return { state: stateForCode(code, 'PARTIAL'), reasonCode: code || null, lastSuccessfulSyncAt, lastAttemptAt }
  }
  return { state: stateForCode(code, 'PROVIDER_UNAVAILABLE'), reasonCode: code || null, lastSuccessfulSyncAt, lastAttemptAt }
}

export const N11_HEALTH_COPY_TR: Record<N11HealthState, string> = {
  NEVER_RUN: 'Henüz okuma yapılmadı',
  OK: 'Son okuma başarılı',
  AUTH_ERROR: 'API bilgileri reddedildi veya eksik',
  RATE_LIMITED: 'İstek sınırına takıldı',
  PROVIDER_UNAVAILABLE: 'n11 yanıt vermedi',
  RESPONSE_SHAPE_UNVERIFIED: 'Yanıt biçimi sözleşmeyle eşleşmedi',
  PARTIAL: 'Son okuma kısmi kaldı',
}

/** Görünen etiket: iç testte başarılı okuma, yazılmadığını ve imlecin durduğunu AÇIKÇA söyler. */
export function n11HealthLabel(health: Pick<N11Health, 'state' | 'reasonCode'>): string {
  if (health.state === 'OK' && health.reasonCode === N11_CANONICAL_WRITE_BLOCKED) {
    return 'Son okuma başarılı (hesap doğrulanmadı: kayıtlar sisteme yazılmadı, imleç ilerlemedi)'
  }
  if (health.reasonCode === 'N11_EPOCH_SEMANTICS_UNVERIFIED') return 'Siparişler kaydedildi; zaman sınırı doğrulanana kadar imleç ilerlemez'
  return N11_HEALTH_COPY_TR[health.state]
}
