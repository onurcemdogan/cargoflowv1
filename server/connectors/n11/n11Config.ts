// N11 BAĞLAYICI YAPILANDIRMASI — kimlik doğrulama + güvenli görünüm (saf; ağ/DB YOK).
//
// ═══ NE YAPILANDIRMADAN GELİR, NE GELMEZ ═════════════════════════════════
//
// Uç nokta (`/rest/delivery/v1/shipmentPackages`), host (`api.n11.com`) ve
// yanıt zarfı (`content`) RESMÎ OLARAK KANITLIDIR; kullanıcıdan yol/host
// İSTENMEZ. Kullanıcı yalnız `appKey` + `appSecret` girer.
//
// ═══ HESAP KİMLİĞİ ══════════════════════════════════════════════════════
//
// `appSecret` ASLA kimlik değildir. Bağlanmadan önce kanıtlanabilen tek kararlı
// tanımlayıcı `appKey`tir; düz metin `provider_account_id` kolonuna YAZILMAZ —
// alan-ayrımlı SHA-256 parmak izi kullanılır (geri döndürülemez, şifreleme
// anahtarı dönse bile değişmez). Satıcı kimliği (`sellerId`) yalnız okumadan
// ÖĞRENİLİR ve şifreli yükte `boundSellerId` olarak saklanır (bkz. senkron).
import { createHash } from 'node:crypto'

/** Bağlayıcı/kimlik/sağlık anahtarı (`connector_credentials.provider_key`). */
export const N11_PROVIDER_KEY = 'n11'
/** `marketplace_accounts.marketplace` — WooCommerce/ikas/Hepsiburada emsali. */
export const N11_ACCOUNT_MARKETPLACE = 'n11'
/** `orders.marketplace` — normalizasyonun yazdığı GÖRÜNEN ad. */
export const N11_ORDER_MARKETPLACE = 'N11'

export interface N11ConnectorConfig {
  appKey: string
  appSecret: string
  /** İlk okumada öğrenilen satıcı kimliği; henüz yoksa null. */
  boundSellerId: string | null
}

export type N11ConfigError = 'N11_APP_KEY_MISSING' | 'N11_APP_SECRET_MISSING' | 'N11_CREDENTIAL_INVALID'

export interface N11ConfigInput {
  appKey?: unknown
  appSecret?: unknown
}

/** Biçim resmî olarak tanımlı değil: yalnız boşluksuz, kontrol karakteri içermeyen, sınırlı uzunluk. */
const CREDENTIAL_SHAPE = /^[\x21-\x7E]{1,256}$/

/**
 * Girdi kimliğini doğrular. `appSecret` boş bırakılabilir YALNIZ aynı hesabın
 * kayıtlı değeri sürdürülecekse (arayüz sırrı geri GÖSTERMEZ).
 */
export function validateN11Credentials(
  input: N11ConfigInput,
  stored: { appKey?: string | null; appSecret?: string | null; boundSellerId?: string | null } = {},
): { ok: true; config: N11ConnectorConfig } | { ok: false; errors: N11ConfigError[] } {
  const errors: N11ConfigError[] = []
  const typedKey = String(input.appKey ?? '').trim()
  const appKey = typedKey !== '' ? typedKey : String(stored.appKey ?? '').trim()
  const typedSecret = String(input.appSecret ?? '').trim()
  const appSecret = typedSecret !== '' ? typedSecret : String(stored.appSecret ?? '').trim()
  if (appKey === '') errors.push('N11_APP_KEY_MISSING')
  if (appSecret === '') errors.push('N11_APP_SECRET_MISSING')
  if ((appKey !== '' && !CREDENTIAL_SHAPE.test(appKey)) || (appSecret !== '' && !CREDENTIAL_SHAPE.test(appSecret))) {
    errors.push('N11_CREDENTIAL_INVALID')
  }
  if (errors.length > 0) return { ok: false, errors }
  const boundSellerId = String(stored.boundSellerId ?? '').trim()
  return { ok: true, config: { appKey, appSecret, boundSellerId: boundSellerId === '' ? null : boundSellerId } }
}

/** `marketplace_accounts.provider_account_id` — appKey'in geri döndürülemez parmak izi. */
export function n11AccountFingerprint(appKey: string): string {
  const digest = createHash('sha256').update(`cargoflow:n11:appkey:${String(appKey).trim()}`).digest('hex')
  return `ak_${digest.slice(0, 32)}`
}

/** Kayıtlı şifreli yükten yapılandırma (bozuk/eksikse null). */
export function configFromStoredPayload(payload: Record<string, unknown> | null | undefined): N11ConnectorConfig | null {
  if (!payload) return null
  const result = validateN11Credentials(
    { appKey: payload.appKey, appSecret: payload.appSecret },
    { boundSellerId: typeof payload.boundSellerId === 'string' ? payload.boundSellerId : null },
  )
  return result.ok ? result.config : null
}

/** Şifreli depoya yazılacak yük. */
export function configToStoredPayload(config: N11ConnectorConfig): Record<string, unknown> {
  return { appKey: config.appKey, appSecret: config.appSecret, boundSellerId: config.boundSellerId }
}

const maskTail = (value: string): string => (value.length <= 3 ? '•••' : `•••${value.slice(-3)}`)

export interface N11ConfigView {
  /** Yalnız son 3 karakter; tam appKey yanıtlara girmez. */
  appKeyMasked: string
  /** SIR DEĞERİ DEĞİL — yalnız varlığı. */
  hasAppSecret: boolean
  /** Okumadan öğrenilen satıcı kimliği (sır değildir). */
  sellerId: string | null
}

/** Arayüze/yanıta giden görünüm — appSecret ve tam appKey ASLA yok. */
export function toConfigView(config: N11ConnectorConfig): N11ConfigView {
  return {
    appKeyMasked: maskTail(config.appKey),
    hasAppSecret: config.appSecret !== '',
    sellerId: config.boundSellerId,
  }
}

export const N11_CONFIG_ERROR_COPY_TR: Record<N11ConfigError | 'N11_APP_KEY_CHANGED', string> = {
  N11_APP_KEY_MISSING: 'n11 API anahtarı (appKey) zorunludur.',
  N11_APP_SECRET_MISSING: 'n11 API şifresi (appSecret) zorunludur.',
  N11_CREDENTIAL_INVALID: 'n11 API bilgileri boşluk veya kontrol karakteri içeremez (en fazla 256 karakter).',
  N11_APP_KEY_CHANGED:
    'Farklı bir appKey farklı bir n11 API hesabıdır; mevcut bağlantıyı düzenlemek yerine yeni hesap olarak bağlayın.',
}
