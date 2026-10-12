// YEREL (DB'SİZ) MOD SIR POLİTİKASI (PHASE2-E).
//
// Yerel modda da sırlar yalnız sunucudaki ŞİFRELİ dosyada durur:
//   · okuma ucu sırları MASKELİ döndürür (gerçek değer ön yüze GİTMEZ)
//   · kaydetmede boş/maskeli sır kayıtlı değeri KORUR
//   · test/senkron/gönderi isteklerine sırları SUNUCU ekler
// Böylece tarayıcı ne sır tutar ne de geri alır.
import { isMaskedPlaceholder } from './credentialService.ts'

/**
 * SIR ALANI TANIMI — ad DESENİNE göre (sabit liste değil): yapılandırmaya yeni
 * bir şifre alanı eklendiğinde (ör. `liveSifre`, `restBasicPassword`) sessizce
 * sızmasın diye. API debug maskelemesiyle aynı kural.
 */
export const SECRET_FIELD_PATTERN = /sifre|password|secret|apikey/i

export function isSecretField(name: string): boolean {
  return SECRET_FIELD_PATTERN.test(name)
}

export const LOCAL_SAVED_SECRET_PLACEHOLDER = '•••••••• (kayıtlı)'

type ProviderConfig = Record<string, unknown>
type LocalConfig = { trendyol?: ProviderConfig; surat?: ProviderConfig } & Record<string, unknown>

function isFresh(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text !== '' && !isMaskedPlaceholder(text)
}

/** Ön yüze dönen görünüm: kayıtlı sır yerine yer tutucu, yoksa boş. */
export function maskLocalSecrets<T extends LocalConfig | null | undefined>(config: T): T {
  if (!config) return config
  const out: LocalConfig = { ...config }
  for (const provider of ['trendyol', 'surat'] as const) {
    const source = { ...(config[provider] ?? {}) }
    for (const field of Object.keys(source).filter(isSecretField)) {
      source[field] = String(source[field] ?? '').trim() ? LOCAL_SAVED_SECRET_PLACEHOLDER : ''
    }
    out[provider] = source
  }
  return out as T
}

/**
 * Gelen yapılandırmayla kayıtlıyı birleştirir: gizli olmayan alanlar gelenden;
 * sır alanı yalnız GERÇEK yeni değer geldiyse değişir (boş/maskeli → kayıtlı).
 */
export function mergeLocalSecrets(incoming: LocalConfig, stored: LocalConfig | null | undefined): LocalConfig {
  const out: LocalConfig = { ...incoming }
  for (const provider of ['trendyol', 'surat'] as const) {
    const next = { ...(incoming[provider] ?? {}) }
    const previous = stored?.[provider] ?? {}
    const fields = new Set([...Object.keys(next), ...Object.keys(previous)].filter(isSecretField))
    for (const field of fields) {
      if (!isFresh(next[field])) next[field] = previous[field] ?? ''
    }
    out[provider] = next
  }
  return out
}
