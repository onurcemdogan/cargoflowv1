// WOOCOMMERCE BAĞLANTI SİHİRBAZI — RESMÎ YETKİLENDİRME AKIŞI (PHASE2-F).
//
// Resmî uç: `<mağaza>/wc-auth/v1/authorize` (WooCommerce REST API belgesi,
// "Auth endpoint"; `includes/class-wc-auth.php`):
//   · parametreler: app_name, scope (read | write | read_write), user_id
//     (UYGULAMANIN kendi referansı), return_url, callback_url (HTTPS ŞART)
//   · mağaza, kullanıcı onayından sonra anahtarları callback_url'e JSON
//     POST eder: key_id, user_id, consumer_key, consumer_secret,
//     key_permissions
//   · YALNIZ HTTP 200 başarıdır; başka her yanıtta WooCommerce üretilen
//     anahtarı SİLER ve kullanıcıya "Access denied" gösterir
//   · ardından kullanıcı return_url'e `success=1|0&user_id=…` ile döner
//
// Sihirbaz adımları: mağaza adresi → bağlan → yetkilendirme → geri çağrı →
// izin kontrolü → örnek okuma doğrulaması → sağlık.
//
// GÜVENLİK
//   · Mağaza adresi BAŞLATMADA SSRF politikasından geçer ve sunucuda
//     bağlanır; geri çağrı gövdesi mağazayı DEĞİŞTİREMEZ.
//   · Geri çağrı yalnız tek kullanımlık, süreli belirteçle kabul edilir
//     (düz belirteç SAKLANMAZ; SHA-256 özeti sabit-zamanlı kıyaslanır).
//   · Anahtarlar doğrulamaya kadar AES-256-GCM zarfında bekler; doğrulama
//     bitince SİLİNİR. Hiçbir yanıt sır taşımaz.
//   · Kapsam en az yetkidir: CargoFlow Woo'dan yalnız OKUR → `read`.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { connectorAuthorizations } from '../../db/schema.ts'
import { decryptCredentialPayload, encryptCredentialPayload } from '../../integrations/credentialService.ts'
import { assertStoreUrlAllowed, type DnsResolver } from '../storeUrlPolicy.ts'
import { connectWooStore, WOO_PROVIDER_KEY } from './wooConnectionService.ts'
import { safeMessageFor, type WooClientOptions, type WooErrorClass } from './wooClient.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export const WOO_AUTH_APP_NAME = 'CargoFlow'
/** CargoFlow WooCommerce'te YAZMA yapmaz (istemci yalnız GET kullanır). */
export const WOO_AUTH_SCOPE = 'read'
const ACCEPTED_PERMISSIONS = new Set(['read', 'read_write'])
export const WOO_AUTH_TTL_MS = 15 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WooAuthorizationStatus = 'pending' | 'callback_received' | 'verifying' | 'connected' | 'failed' | 'expired'

/**
 * Geri çağrı ancak HTTPS genel adrese yapılabilir (WooCommerce
 * `callback_url needs to be over SSL` ile reddeder). APP_BASE_URL HTTPS
 * değilse sihirbaz KAPALIDIR; yalnız gelişmiş (elle anahtar) yol kalır.
 */
export function resolveWooAuthBaseUrl(raw: string | undefined): string | null {
  const value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

const hashToken = (token: string) => createHash('sha256').update(`woo-auth-callback-v1:${token}`).digest('hex')

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export type WooAuthorizationStartResult =
  | { ok: true; authorizationId: string; authorizeUrl: string; expiresAt: string }
  | { ok: false; outcome: 'WIZARD_UNAVAILABLE' | 'STORE_URL_REJECTED'; message: string }

export async function startWooAuthorization(
  db: Db,
  input: {
    organizationId: string
    userId: string | null
    storeUrl: string
    appBaseUrl: string | null
    resolver?: DnsResolver
    now?: Date
  },
): Promise<WooAuthorizationStartResult> {
  const organizationId = String(input.organizationId ?? '').trim()
  if (!organizationId) throw new Error('organizationId zorunludur.')
  if (!input.appBaseUrl) {
    return {
      ok: false,
      outcome: 'WIZARD_UNAVAILABLE',
      message: 'Otomatik bağlantı bu ortamda kullanılamıyor (HTTPS uygulama adresi gerekli). Gelişmiş bölümden anahtarla bağlanabilirsiniz.',
    }
  }
  const decision = await assertStoreUrlAllowed(input.storeUrl, input.resolver ? { resolver: input.resolver } : {})
  if (!decision.ok) {
    return { ok: false, outcome: 'STORE_URL_REJECTED', message: `Mağaza adresi kabul edilmedi (${decision.rejection}).` }
  }
  const now = input.now ?? new Date()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + WOO_AUTH_TTL_MS)
  const [row] = await db
    .insert(connectorAuthorizations)
    .values({
      organizationId,
      providerKey: WOO_PROVIDER_KEY,
      storeUrl: decision.normalizedUrl,
      callbackTokenHash: hashToken(token),
      status: 'pending',
      requestedScope: WOO_AUTH_SCOPE,
      createdByUserId: input.userId || null,
      createdAt: now,
      expiresAt,
    })
    .returning({ id: connectorAuthorizations.id })
  const authorizationId = String(row.id)
  const params = new URLSearchParams({
    app_name: WOO_AUTH_APP_NAME,
    scope: WOO_AUTH_SCOPE,
    // Uygulamanın referansıdır (WooCommerce kullanıcı kimliği DEĞİL). Sır
    // değildir: dönüş adresinde görünür; geri çağrıyı belirteç yetkilendirir.
    user_id: authorizationId,
    return_url: `${input.appBaseUrl}/?woo_auth=${authorizationId}`,
    callback_url: `${input.appBaseUrl}/api/webhooks/woocommerce-auth/${authorizationId}/${token}`,
  })
  return {
    ok: true,
    authorizationId,
    authorizeUrl: `${decision.normalizedUrl}/wc-auth/v1/authorize?${params.toString()}`,
    expiresAt: expiresAt.toISOString(),
  }
}

export interface WooCallbackResult {
  httpStatus: number
  body: { ok: boolean; outcome: string }
}

/**
 * MAĞAZADAN GELEN GERİ ÇAĞRI (oturumsuz, belirteçle yetkilendirilir).
 *
 * 200 yalnız anahtarlar şifreli olarak saklandığında döner. Diğer her
 * durumda 2xx DÖNÜLMEZ: WooCommerce üretilen anahtarı siler, böylece
 * kullanılmayacak bir anahtar mağazada ASLA kalmaz.
 */
export async function receiveWooAuthCallback(
  db: Db,
  input: { authorizationId: string; token: string; body: unknown; now?: Date },
): Promise<WooCallbackResult> {
  const now = input.now ?? new Date()
  const authorizationId = String(input.authorizationId ?? '').trim()
  const token = String(input.token ?? '')
  const reject = (httpStatus: number, outcome: string): WooCallbackResult => ({ httpStatus, body: { ok: false, outcome } })
  if (!UUID.test(authorizationId) || token.length < 20) return reject(404, 'NOT_FOUND')

  const rows = await db
    .select()
    .from(connectorAuthorizations)
    .where(and(eq(connectorAuthorizations.id, authorizationId), eq(connectorAuthorizations.providerKey, WOO_PROVIDER_KEY)))
    .limit(1)
  const row = rows[0]
  if (!row || !sameHash(String(row.callbackTokenHash), hashToken(token))) return reject(404, 'NOT_FOUND')
  if (row.status !== 'pending') return reject(409, 'ALREADY_USED')
  if (new Date(row.expiresAt).getTime() <= now.getTime()) {
    await db
      .update(connectorAuthorizations)
      .set({ status: 'expired', errorClass: 'EXPIRED', completedAt: now })
      .where(and(eq(connectorAuthorizations.id, authorizationId), eq(connectorAuthorizations.status, 'pending')))
    return reject(410, 'EXPIRED')
  }

  const body = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>
  const consumerKey = String(body.consumer_key ?? '')
  const consumerSecret = String(body.consumer_secret ?? '')
  const permissions = String(body.key_permissions ?? '')
  const fail = async (errorClass: string, httpStatus: number): Promise<WooCallbackResult> => {
    await db
      .update(connectorAuthorizations)
      .set({ status: 'failed', errorClass, completedAt: now })
      .where(and(eq(connectorAuthorizations.id, authorizationId), eq(connectorAuthorizations.status, 'pending')))
    return reject(httpStatus, errorClass)
  }
  if (String(body.user_id ?? '') !== authorizationId) return fail('CALLBACK_MISMATCH', 400)
  if (!/^ck_[A-Za-z0-9]{8,}$/.test(consumerKey) || !/^cs_[A-Za-z0-9]{8,}$/.test(consumerSecret)) {
    return fail('MALFORMED_CALLBACK', 400)
  }
  // İZİN KONTROLÜ: okuma izni olmayan anahtar (ör. yalnız `write`) kabul
  // EDİLMEZ — 2xx dönmediğimiz için WooCommerce anahtarı siler.
  if (!ACCEPTED_PERMISSIONS.has(permissions)) return fail('PERMISSION', 400)

  const { encryptedPayload } = encryptCredentialPayload({ consumerKey, consumerSecret })
  const claimed = await db
    .update(connectorAuthorizations)
    .set({ status: 'callback_received', grantedScope: permissions, encryptedCredentials: encryptedPayload, callbackReceivedAt: now })
    .where(and(eq(connectorAuthorizations.id, authorizationId), eq(connectorAuthorizations.status, 'pending')))
    .returning({ id: connectorAuthorizations.id })
  if (claimed.length === 0) return reject(409, 'ALREADY_USED')
  return { httpStatus: 200, body: { ok: true, outcome: 'RECEIVED' } }
}

export type WooCompleteOutcome =
  | 'CONNECTED'
  | 'WAITING_FOR_CALLBACK'
  | 'VERIFYING'
  | 'FAILED'
  | 'EXPIRED'
  | 'NOT_FOUND'

export interface WooCompleteResult {
  outcome: WooCompleteOutcome
  step: 'authorization' | 'callback' | 'permission' | 'verification' | 'health'
  errorClass: string | null
  message: string
  marketplaceAccountId: string | null
  grantedScope: string | null
}

const FAILURE_MESSAGES: Record<string, string> = {
  EXPIRED: 'Yetkilendirme süresi doldu. Bağlantıyı yeniden başlatın.',
  DENIED: 'Mağazada erişim onaylanmadı.',
  CALLBACK_MISMATCH: 'Mağazadan gelen yanıt bu bağlantı isteğiyle eşleşmedi.',
  MALFORMED_CALLBACK: 'Mağazadan gelen anahtar biçimi geçersiz.',
  PERMISSION: 'Anahtarın okuma izni yok. Bağlantıyı yeniden başlatın.',
}

function failureMessage(errorClass: string | null): string {
  if (!errorClass) return 'Bağlantı tamamlanamadı.'
  if (FAILURE_MESSAGES[errorClass]) return FAILURE_MESSAGES[errorClass]
  try {
    return safeMessageFor(errorClass as WooErrorClass) ?? 'Bağlantı tamamlanamadı.'
  } catch {
    return 'Bağlantı tamamlanamadı.'
  }
}

function stepFor(errorClass: string | null): WooCompleteResult['step'] {
  if (errorClass === 'PERMISSION') return 'permission'
  if (errorClass === 'EXPIRED' || errorClass === 'DENIED') return 'authorization'
  if (errorClass === 'CALLBACK_MISMATCH' || errorClass === 'MALFORMED_CALLBACK') return 'callback'
  return 'verification'
}

/**
 * KULLANICI DÖNDÜĞÜNDE (oturumlu, kiracı kapsamlı): örnek okuma doğrulaması
 * ve kayıt. Doğrulama `connectWooStore` ile AYNI yoldur (SSRF → gerçek okuma
 * → yalnız başarıda kalıcılaşma). Aynı isteğin eşzamanlı ikinci tamamlanması
 * koşullu talep sayesinde doğrulamayı İKİNCİ KEZ çalıştırmaz.
 */
export async function completeWooAuthorization(
  db: Db,
  input: {
    organizationId: string
    authorizationId: string
    /** Kullanıcı dönüş adresinde `success=0` geldiyse. */
    denied?: boolean
    options: WooClientOptions
    now?: Date
  },
): Promise<WooCompleteResult> {
  const now = input.now ?? new Date()
  const organizationId = String(input.organizationId ?? '').trim()
  const authorizationId = String(input.authorizationId ?? '').trim()
  const result = (
    outcome: WooCompleteOutcome,
    step: WooCompleteResult['step'],
    extra: Partial<WooCompleteResult> = {},
  ): WooCompleteResult => ({
    outcome,
    step,
    errorClass: null,
    message: '',
    marketplaceAccountId: null,
    grantedScope: null,
    ...extra,
  })
  if (!organizationId || !UUID.test(authorizationId)) {
    return result('NOT_FOUND', 'authorization', { message: 'Bağlantı isteği bulunamadı.' })
  }
  const scope = and(
    eq(connectorAuthorizations.id, authorizationId),
    // KİRACI SINIRI: başka çalışma alanının isteği görünmez.
    eq(connectorAuthorizations.organizationId, organizationId),
    eq(connectorAuthorizations.providerKey, WOO_PROVIDER_KEY),
  )
  const rows = await db.select().from(connectorAuthorizations).where(scope).limit(1)
  const row = rows[0]
  if (!row) return result('NOT_FOUND', 'authorization', { message: 'Bağlantı isteği bulunamadı.' })
  const grantedScope = row.grantedScope ? String(row.grantedScope) : null

  if (row.status === 'connected') {
    return result('CONNECTED', 'health', {
      message: 'Mağaza bağlandı ve okuma doğrulandı.',
      marketplaceAccountId: row.marketplaceAccountId ? String(row.marketplaceAccountId) : null,
      grantedScope,
    })
  }
  if (row.status === 'failed' || row.status === 'expired') {
    const errorClass = row.errorClass ? String(row.errorClass) : null
    return result(row.status === 'expired' ? 'EXPIRED' : 'FAILED', stepFor(errorClass), {
      errorClass,
      message: failureMessage(errorClass),
      grantedScope,
    })
  }
  if (row.status === 'verifying') {
    return result('VERIFYING', 'verification', { message: 'Okuma doğrulaması sürüyor.', grantedScope })
  }
  if (row.status === 'pending') {
    const expired = new Date(row.expiresAt).getTime() <= now.getTime()
    if (expired || input.denied) {
      const errorClass = expired ? 'EXPIRED' : 'DENIED'
      await db
        .update(connectorAuthorizations)
        .set({ status: expired ? 'expired' : 'failed', errorClass, completedAt: now })
        .where(and(scope, eq(connectorAuthorizations.status, 'pending')))
      return result(expired ? 'EXPIRED' : 'FAILED', 'authorization', { errorClass, message: failureMessage(errorClass) })
    }
    return result('WAITING_FOR_CALLBACK', 'callback', { message: 'Mağazadan onay bekleniyor.' })
  }

  // callback_received → doğrulamayı TEK çağıran üstlenir.
  const claimed = await db
    .update(connectorAuthorizations)
    .set({ status: 'verifying' })
    .where(and(scope, eq(connectorAuthorizations.status, 'callback_received')))
    .returning({ encryptedCredentials: connectorAuthorizations.encryptedCredentials })
  if (claimed.length === 0) {
    return result('VERIFYING', 'verification', { message: 'Okuma doğrulaması sürüyor.', grantedScope })
  }
  let credentials: { consumerKey: string; consumerSecret: string }
  try {
    const payload = decryptCredentialPayload(String(claimed[0].encryptedCredentials ?? ''))
    credentials = { consumerKey: String(payload.consumerKey ?? ''), consumerSecret: String(payload.consumerSecret ?? '') }
  } catch {
    await db
      .update(connectorAuthorizations)
      .set({ status: 'failed', errorClass: 'MALFORMED_CALLBACK', encryptedCredentials: null, completedAt: now })
      .where(scope)
    return result('FAILED', 'callback', { errorClass: 'MALFORMED_CALLBACK', message: failureMessage('MALFORMED_CALLBACK') })
  }

  let connected: Awaited<ReturnType<typeof connectWooStore>>
  try {
    connected = await connectWooStore(
      db,
      { organizationId, storeUrl: String(row.storeUrl), ...credentials },
      input.options,
    )
  } catch (error) {
    // Beklenmeyen hata: anahtar bekletilmez; kullanıcı yeniden başlatır.
    await db
      .update(connectorAuthorizations)
      .set({ status: 'failed', errorClass: 'PROVIDER', encryptedCredentials: null, completedAt: now })
      .where(scope)
    throw error
  }
  if (connected.outcome !== 'CONNECTED') {
    const errorClass = connected.errorClass ?? 'PROVIDER'
    await db
      .update(connectorAuthorizations)
      .set({ status: 'failed', errorClass, encryptedCredentials: null, completedAt: now })
      .where(scope)
    return result('FAILED', stepFor(errorClass), { errorClass, message: failureMessage(errorClass), grantedScope })
  }
  const marketplaceAccountId = connected.account?.id ? String(connected.account.id) : null
  await db
    .update(connectorAuthorizations)
    .set({ status: 'connected', marketplaceAccountId, encryptedCredentials: null, completedAt: now })
    .where(scope)
  return result('CONNECTED', 'health', {
    message: 'Mağaza bağlandı ve okuma doğrulandı.',
    marketplaceAccountId,
    grantedScope,
  })
}
