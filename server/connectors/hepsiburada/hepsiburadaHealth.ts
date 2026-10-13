// HEPSIBURADA HESAP SAĞLIĞI — saf karar (ağ/DB YOK).
//
// Kaynaklar: hesabın yapılandırması (yol/kimlik VAR MI) + son okuma koşusunun
// kaydı (`integration_sync_state`, hesap kapsamlı). Ham sağlayıcı metni
// DÖNMEZ; yalnız kararlı durum + sebep kodu.
//
// "Canlı" İDDİASI YOK: durum OK olsa bile `liveVerified` ancak ayrı canlı
// doğrulama kapısından sonra true olabilir; bu modül onu ÜRETMEZ.

export const HEPSIBURADA_HEALTH_STATES = [
  'NEVER_RUN',
  'OK',
  'AUTH_ERROR',
  'RATE_LIMITED',
  'ENDPOINT_CONFIG_REQUIRED',
  'PROVIDER_UNAVAILABLE',
  'PARTIAL',
] as const
export type HepsiburadaHealthState = (typeof HEPSIBURADA_HEALTH_STATES)[number]

/**
 * Okuma başarılı, kanonik yazım yayın aşamasınca KAPALI (iç test). Koşu
 * `partial` kaydedilir (imleç İLERLEMEZ) ama okuma sağlığı OK'dir.
 */
export const HB_CANONICAL_WRITE_BLOCKED = 'HB_CANONICAL_WRITE_BLOCKED'
/** Okuma başarılı, kanonik yazım eksik kaldı — imleç durur, aralık yeniden okunur. */
export const HB_PERSIST_INCOMPLETE = 'HB_PERSIST_INCOMPLETE'

export interface HepsiburadaHealthInput {
  hasEndpointPath: boolean
  credentialsComplete: boolean
  syncState: {
    lastSyncStatus?: unknown
    lastErrorCode?: unknown
    lastSuccessfulSyncAt?: unknown
    updatedAt?: unknown
  } | null
}

export interface HepsiburadaHealth {
  state: HepsiburadaHealthState
  reasonCode: string | null
  lastSuccessfulSyncAt: string | null
  lastAttemptAt: string | null
}

const iso = (value: unknown): string | null => {
  if (!value) return null
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** Hata koduna göre durum (kararlı sözlük; eşleşmeyen → sağlayıcıya erişilemiyor). */
function stateForErrorCode(code: string): HepsiburadaHealthState {
  if (/HB_HTTP_40[13]|AUTH|CREDENTIAL/.test(code)) return 'AUTH_ERROR'
  if (/429|RATE/.test(code)) return 'RATE_LIMITED'
  if (/ENDPOINT|RESPONSE_SHAPE|NOT_JSON|HB_HTTP_4\d\d|REDIRECT|HOST/.test(code)) return 'ENDPOINT_CONFIG_REQUIRED'
  return 'PROVIDER_UNAVAILABLE'
}

export function resolveHepsiburadaHealth(input: HepsiburadaHealthInput): HepsiburadaHealth {
  const state = input.syncState
  const lastSuccessfulSyncAt = iso(state?.lastSuccessfulSyncAt)
  const lastAttemptAt = iso(state?.updatedAt)
  if (!input.credentialsComplete) {
    return { state: 'AUTH_ERROR', reasonCode: 'HB_CREDENTIALS_INCOMPLETE', lastSuccessfulSyncAt, lastAttemptAt }
  }
  if (!input.hasEndpointPath) {
    return { state: 'ENDPOINT_CONFIG_REQUIRED', reasonCode: 'HB_ENDPOINT_PATH_UNVERIFIED', lastSuccessfulSyncAt, lastAttemptAt }
  }
  const status = String(state?.lastSyncStatus ?? '')
  const code = String(state?.lastErrorCode ?? '')
  if (!state || status === '') {
    return { state: 'NEVER_RUN', reasonCode: null, lastSuccessfulSyncAt, lastAttemptAt }
  }
  if (status === 'success') return { state: 'OK', reasonCode: null, lastSuccessfulSyncAt, lastAttemptAt }
  if (status === 'partial' && code === HB_CANONICAL_WRITE_BLOCKED) {
    return { state: 'OK', reasonCode: code, lastSuccessfulSyncAt, lastAttemptAt }
  }
  if (status === 'partial') {
    return {
      state: /429|RATE/.test(code) ? 'RATE_LIMITED' : 'PARTIAL',
      reasonCode: code || null,
      lastSuccessfulSyncAt,
      lastAttemptAt,
    }
  }
  return { state: stateForErrorCode(code), reasonCode: code || null, lastSuccessfulSyncAt, lastAttemptAt }
}

/** Görünen etiket: iç testte başarılı okuma, yazılmadığını AÇIKÇA söyler. */
export function hepsiburadaHealthLabel(health: Pick<HepsiburadaHealth, 'state' | 'reasonCode'>): string {
  if (health.state === 'OK' && health.reasonCode === HB_CANONICAL_WRITE_BLOCKED) {
    return 'Son okuma başarılı (iç test: kayıtlar sisteme yazılmadı)'
  }
  return HEPSIBURADA_HEALTH_COPY_TR[health.state]
}

export const HEPSIBURADA_HEALTH_COPY_TR: Record<HepsiburadaHealthState, string> = {
  NEVER_RUN: 'Henüz okuma yapılmadı',
  OK: 'Son okuma başarılı',
  AUTH_ERROR: 'Kimlik bilgileri reddedildi veya eksik',
  RATE_LIMITED: 'İstek sınırına takıldı',
  ENDPOINT_CONFIG_REQUIRED: 'Uç nokta yapılandırması gerekli',
  PROVIDER_UNAVAILABLE: 'Hepsiburada yanıt vermedi',
  PARTIAL: 'Son okuma kısmi kaldı',
}
