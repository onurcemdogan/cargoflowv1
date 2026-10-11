// Frontend auth servisi. Session HttpOnly cookie ile taşınır: frontend token
// SAKLAMAZ (localStorage/sessionStorage yazımı yok), organizationId/tenantId
// GÖNDERMEZ. Tüm istekler credentials:'include' kullanır.
import {
  isPasswordLongEnough,
  PASSWORD_TOO_SHORT_MESSAGE,
} from './passwordPolicy'

export interface AuthUser {
  /** Gösterim adı: kullanıcı adı, yoksa e-posta. */
  username: string
  email?: string | null
  /** null → kullanıcının henüz çalışma alanı yok. */
  organization: {
    id: string
    name: string
    slug: string
  } | null
}

// Standart hata modeli.
export interface AuthError {
  status: number
  message: string
  code?: string
}

export type CurrentUserResult =
  | { kind: 'authenticated'; user: AuthUser }
  | { kind: 'workspace_required'; user: AuthUser }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable'; message: string }

const AUTH_UNAVAILABLE_MESSAGE =
  'Kimlik doğrulama için PostgreSQL yapılandırılmamış.'

function toAuthError(status: number, payload: unknown): AuthError {
  const message = String(
    (payload as { message?: unknown } | null)?.message ??
      'İşlem tamamlanamadı.',
  )
  const code = (payload as { code?: unknown } | null)?.code
  return typeof code === 'string' ? { status, message, code } : { status, message }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function getCurrentUser(): Promise<CurrentUserResult> {
  const response = await fetch('/api/auth/me', { credentials: 'include' })
  if (response.status === 401) return { kind: 'unauthenticated' }
  if (response.status === 503) {
    return { kind: 'unavailable', message: AUTH_UNAVAILABLE_MESSAGE }
  }
  if (!response.ok) {
    const payload = await parseJson(response)
    throw toAuthError(response.status, payload)
  }
  const payload = (await parseJson(response)) as {
    user?: AuthUser
    needsWorkspace?: boolean
  } | null
  if (!payload?.user) throw toAuthError(500, null)
  if (payload.needsWorkspace === true || payload.user.organization == null) {
    return { kind: 'workspace_required', user: { ...payload.user, organization: null } }
  }
  return { kind: 'authenticated', user: payload.user }
}

export async function login(
  username: string,
  password: string,
): Promise<void> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: String(username ?? '').trim().toLowerCase(),
      password,
    }),
  })
  if (!response.ok) {
    if (response.status === 503) {
      throw { status: 503, message: AUTH_UNAVAILABLE_MESSAGE } as AuthError
    }
    throw toAuthError(response.status, await parseJson(response))
  }
}

export async function bootstrap(
  organizationName: string,
  username: string,
  password: string,
): Promise<void> {
  // UX doğrulaması; esas doğrulama backend'dedir (aynı ortak sabit).
  if (!isPasswordLongEnough(password)) {
    throw { status: 400, message: PASSWORD_TOO_SHORT_MESSAGE } as AuthError
  }
  const response = await fetch('/api/auth/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationName: String(organizationName ?? '').trim(),
      username: String(username ?? '').trim().toLowerCase(),
      password,
    }),
  })
  if (!response.ok) {
    if (response.status === 503) {
      throw { status: 503, message: AUTH_UNAVAILABLE_MESSAGE } as AuthError
    }
    throw toAuthError(response.status, await parseJson(response))
  }
}

// Logout idempotenttir; iş verileri (orders/products localStorage, IndexedDB,
// shipment/idempotency) BU KATMANDA TEMİZLENMEZ.
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  }).catch(() => undefined)
}

// ─── SELF-SERVICE (kayıt, doğrulama, şifre sıfırlama) ─────────────────────
// Ham doğrulama/sıfırlama bağlantısı yalnız bu çağrıların gövdesinde sunucuya
// gider; tarayıcı depolamasına YAZILMAZ.

export interface AuthPublicConfig {
  signupEnabled: boolean
  passwordResetEnabled: boolean
  /** Herkese açık Turnstile site anahtarı (gizli değil); null → widget yok. */
  turnstileSiteKey: string | null
}

export async function getAuthConfig(): Promise<AuthPublicConfig> {
  try {
    const response = await fetch('/api/auth/config', { credentials: 'include' })
    if (!response.ok) throw new Error('config')
    const payload = (await parseJson(response)) as Partial<AuthPublicConfig> | null
    return {
      signupEnabled: payload?.signupEnabled === true,
      passwordResetEnabled: payload?.passwordResetEnabled === true,
      turnstileSiteKey: typeof payload?.turnstileSiteKey === 'string' ? payload.turnstileSiteKey : null,
    }
  } catch {
    return { signupEnabled: false, passwordResetEnabled: false, turnstileSiteKey: null }
  }
}

async function postAuth(path: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await parseJson(response)
  if (!response.ok) throw toAuthError(response.status, payload)
  return String((payload as { message?: unknown } | null)?.message ?? '')
}

export function signup(email: string, password: string, turnstileToken: string): Promise<string> {
  return postAuth('/api/auth/signup', { email: String(email ?? '').trim(), password, turnstileToken })
}

export function verifyEmail(linkToken: string): Promise<string> {
  return postAuth('/api/auth/verify-email', { token: linkToken })
}

export function resendVerification(email: string, turnstileToken: string): Promise<string> {
  return postAuth('/api/auth/resend-verification', { email: String(email ?? '').trim(), turnstileToken })
}

export function forgotPassword(email: string, turnstileToken: string): Promise<string> {
  return postAuth('/api/auth/forgot-password', { email: String(email ?? '').trim(), turnstileToken })
}

export function resetPassword(linkToken: string, password: string): Promise<string> {
  return postAuth('/api/auth/reset-password', { token: linkToken, password })
}

/** İlk giriş: doğrulanmış kullanıcının çalışma alanını (firma) oluşturur. */
export function createWorkspace(name: string): Promise<string> {
  return postAuth('/api/auth/workspace', { name: String(name ?? '').trim() })
}
