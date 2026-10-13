// HEPSIBURADA BAĞLAYICI YAPILANDIRMASI — doğrulama + güvenli görünüm (saf; ağ/DB YOK).
//
// ═══ NE YAPILANDIRMADAN GELİR, NE UYDURULMAZ ═════════════════════════════
//
// Resmî sözleşme (2026-08-19, `marketplaces/hepsiburada/hepsiburadaContract.ts`)
// Basic auth, `-sit` host kuralı, offset/limit + begindate/enddate, 429 +
// X-RateLimit-* başlıkları ve paket modelini KANITLAR. Uç nokta YOLLARINI ve
// liste yanıtının ZARFINI kanıtlamaz. Bu yüzden:
//
//   · yol (sipariş / paket) YAPILANDIRMADAN gelir; yoksa istek KURULMAZ,
//   · host YALNIZ doğrulanmış Hepsiburada alan adı olabilir,
//   · yanıt dizi değilse liste alanının ADI yapılandırmadan gelir; tahmin
//     edilmez (`HB_RESPONSE_SHAPE_UNVERIFIED`).
//
// SIR: parola hiçbir görünüme, yanıta veya log'a girmez.
import {
  resolveHepsiburadaHost,
  type HepsiburadaEnvironment,
} from '../../marketplaces/hepsiburada/hepsiburadaContract.ts'

/** Bağlayıcı/kimlik/sağlık anahtarı (`connector_credentials.provider_key`). */
export const HEPSIBURADA_PROVIDER_KEY = 'hepsiburada'
/**
 * `marketplace_accounts.marketplace` — WooCommerce/ikas emsali: hesap
 * sağlayıcı ANAHTARIYLA tutulur (sağlık servisi hesapları bu anahtarla bulur).
 */
export const HEPSIBURADA_ACCOUNT_MARKETPLACE = 'hepsiburada'
/** `orders.marketplace` — normalizasyonun yazdığı GÖRÜNEN ad. */
export const HEPSIBURADA_ORDER_MARKETPLACE = 'Hepsiburada'

export interface HepsiburadaConnectorConfig {
  merchantId: string
  username: string
  password: string
  host: string
  environment: HepsiburadaEnvironment
  /** Ödemesi alınmış sipariş listesi yolu (sözleşme yolu kanıtlamaz). */
  ordersPath: string | null
  /** Paket listesi yolu (pencere ≤ 24 saat). */
  packagesPath: string | null
  /** Yanıt nesne ise liste alanının adı; dizi yanıtta gerekmez. */
  listField: string | null
}

export type HepsiburadaConfigError =
  | 'HB_MERCHANT_ID_INVALID'
  | 'HB_USERNAME_MISSING'
  | 'HB_PASSWORD_MISSING'
  | 'HB_HOST_EMPTY'
  | 'HB_HOST_NOT_VERIFIED'
  | 'HB_PRODUCTION_HOST_NOT_DERIVABLE'
  | 'HB_ENDPOINT_PATH_INVALID'
  | 'HB_LIST_FIELD_INVALID'

export interface HepsiburadaConfigInput {
  merchantId?: unknown
  username?: unknown
  password?: unknown
  host?: unknown
  ordersPath?: unknown
  packagesPath?: unknown
  listField?: unknown
}

const MERCHANT_ID = /^[A-Za-z0-9-]{1,64}$/
/** Yol: göreli, kök `/` ile başlar; şema/host/sorgu/`..` İÇEREMEZ. */
const ENDPOINT_PATH = /^\/[A-Za-z0-9._~\-/{}]{0,299}$/
const LIST_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** Yol şablonunda izin verilen TEK yer tutucu. */
export const MERCHANT_ID_PLACEHOLDER = '{merchantId}'

function optionalPath(value: unknown): { ok: boolean; path: string | null } {
  const path = String(value ?? '').trim()
  if (path === '') return { ok: true, path: null }
  if (!ENDPOINT_PATH.test(path) || path.includes('..') || path.includes('//')) {
    return { ok: false, path: null }
  }
  // Yalnız `{merchantId}` yer tutucusuna izin verilir; başka süslü ifade YOK.
  const braces = path.match(/\{[^}]*\}/g) ?? []
  if (braces.some((token) => token !== MERCHANT_ID_PLACEHOLDER)) return { ok: false, path: null }
  if (path.replace(/\{merchantId\}/g, '').match(/[{}]/)) return { ok: false, path: null }
  return { ok: true, path }
}

/**
 * Girdi yapılandırmasını doğrular.
 *
 * `password` / `username` boş bırakılabilir YALNIZ aynı hesabın kayıtlı
 * değeri sürdürülecekse (arayüz bunları geri GÖSTERMEZ); aksi halde eksik.
 */
export function validateHepsiburadaConfig(
  input: HepsiburadaConfigInput,
  options: { storedPassword?: string | null; storedUsername?: string | null } = {},
): { ok: true; config: HepsiburadaConnectorConfig } | { ok: false; errors: HepsiburadaConfigError[] } {
  const errors: HepsiburadaConfigError[] = []
  const merchantId = String(input.merchantId ?? '').trim()
  if (!MERCHANT_ID.test(merchantId)) errors.push('HB_MERCHANT_ID_INVALID')
  const typedUsername = String(input.username ?? '').trim()
  const username = typedUsername !== '' ? typedUsername : String(options.storedUsername ?? '').trim()
  if (username === '') errors.push('HB_USERNAME_MISSING')
  const typedPassword = String(input.password ?? '')
  const password = typedPassword !== '' ? typedPassword : String(options.storedPassword ?? '')
  if (password === '') errors.push('HB_PASSWORD_MISSING')

  const host = resolveHepsiburadaHost({ host: String(input.host ?? '') })
  if (!host.ok) errors.push(host.errorCode ?? 'HB_HOST_NOT_VERIFIED')

  const ordersPath = optionalPath(input.ordersPath)
  const packagesPath = optionalPath(input.packagesPath)
  if (!ordersPath.ok || !packagesPath.ok) errors.push('HB_ENDPOINT_PATH_INVALID')

  const listFieldRaw = String(input.listField ?? '').trim()
  if (listFieldRaw !== '' && !LIST_FIELD.test(listFieldRaw)) errors.push('HB_LIST_FIELD_INVALID')

  if (errors.length > 0 || !host.ok || !host.host || !host.environment) {
    return { ok: false, errors: errors.length > 0 ? errors : ['HB_HOST_NOT_VERIFIED'] }
  }
  return {
    ok: true,
    config: {
      merchantId,
      username,
      password,
      host: host.host,
      environment: host.environment,
      ordersPath: ordersPath.path,
      packagesPath: packagesPath.path,
      listField: listFieldRaw === '' ? null : listFieldRaw,
    },
  }
}

/** Kayıtlı şifreli yükten yapılandırma (bozuk/eksikse null). */
export function configFromStoredPayload(payload: Record<string, unknown> | null | undefined): HepsiburadaConnectorConfig | null {
  if (!payload) return null
  const result = validateHepsiburadaConfig({
    merchantId: payload.merchantId,
    username: payload.username,
    password: payload.password,
    host: payload.host,
    ordersPath: payload.ordersPath,
    packagesPath: payload.packagesPath,
    listField: payload.listField,
  })
  return result.ok ? result.config : null
}

/** Şifreli depoya yazılacak yük — ortam host'tan türetildiği için yazılmaz. */
export function configToStoredPayload(config: HepsiburadaConnectorConfig): Record<string, unknown> {
  return {
    merchantId: config.merchantId,
    username: config.username,
    password: config.password,
    host: config.host,
    ordersPath: config.ordersPath,
    packagesPath: config.packagesPath,
    listField: config.listField,
  }
}

export type HepsiburadaFamily = 'ORDERS' | 'PACKAGES'

/**
 * Bu hesabın okuma ailesi: paket yolu varsa PAKET (kanonik kimlik
 * `packageNumber` ondan gelir), yoksa sipariş yolu, ikisi de yoksa null
 * (→ ENDPOINT_CONFIG_REQUIRED, ağ çağrısı YOK).
 */
export function resolveReadFamily(config: Pick<HepsiburadaConnectorConfig, 'ordersPath' | 'packagesPath'>): HepsiburadaFamily | null {
  if (config.packagesPath) return 'PACKAGES'
  if (config.ordersPath) return 'ORDERS'
  return null
}

/** Aile yolunu `{merchantId}` yer tutucusu doldurulmuş olarak verir. */
export function resolveEndpointPath(config: HepsiburadaConnectorConfig, family: HepsiburadaFamily): string | null {
  const template = family === 'PACKAGES' ? config.packagesPath : config.ordersPath
  if (!template) return null
  return template.split(MERCHANT_ID_PLACEHOLDER).join(encodeURIComponent(config.merchantId))
}

const maskTail = (value: string, keep = 3): string =>
  value === '' ? '' : value.length <= keep ? '•••' : `•••${value.slice(-keep)}`

export interface HepsiburadaConfigView {
  merchantId: string
  usernameMasked: string
  /** SIR DEĞERİ DEĞİL — yalnız varlığı. */
  hasPassword: boolean
  host: string
  environment: HepsiburadaEnvironment
  ordersPath: string | null
  packagesPath: string | null
  listField: string | null
}

/** Arayüze/yanıta giden görünüm — parola ASLA yok. */
export function toConfigView(config: HepsiburadaConnectorConfig): HepsiburadaConfigView {
  return {
    merchantId: config.merchantId,
    usernameMasked: maskTail(config.username),
    hasPassword: config.password !== '',
    host: config.host,
    environment: config.environment,
    ordersPath: config.ordersPath,
    packagesPath: config.packagesPath,
    listField: config.listField,
  }
}

export const HEPSIBURADA_CONFIG_ERROR_COPY_TR: Record<HepsiburadaConfigError, string> = {
  HB_MERCHANT_ID_INVALID: 'Merchant ID geçersiz (harf, rakam ve tire).',
  HB_USERNAME_MISSING: 'API kullanıcı adı zorunludur.',
  HB_PASSWORD_MISSING: 'API parolası zorunludur.',
  HB_HOST_EMPTY: 'Hepsiburada API host bilgisi zorunludur.',
  HB_HOST_NOT_VERIFIED: 'Host doğrulanmış bir Hepsiburada alan adı değil.',
  HB_PRODUCTION_HOST_NOT_DERIVABLE: 'Host bilgisinden üretim adresi türetilemedi.',
  HB_ENDPOINT_PATH_INVALID:
    'Uç nokta yolu "/" ile başlamalı; şema, host, sorgu veya ".." içeremez. Yalnız {merchantId} yer tutucusu kullanılabilir.',
  HB_LIST_FIELD_INVALID: 'Liste alanı adı geçersiz.',
}
