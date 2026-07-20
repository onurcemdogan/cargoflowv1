// Frontend auth servisi. Session HttpOnly cookie ile taşınır: frontend token
// SAKLAMAZ (localStorage/sessionStorage yazımı yok), organizationId/tenantId
// GÖNDERMEZ. Tüm istekler credentials:'include' kullanır.
import {
  isPasswordLongEnough,
  PASSWORD_TOO_SHORT_MESSAGE,
} from './passwordPolicy'

export interface AuthUser {
  username: string
  organization: {
    id: string
    name: string
    slug: string
  }
}

// Standart hata modeli.
export interface AuthError {
  status: number
  message: string
}

export type CurrentUserResult =
  | { kind: 'authenticated'; user: AuthUser }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable'; message: string }

const AUTH_UNAVAILABLE_MESSAGE =
  'Kimlik doğrulama için PostgreSQL yapılandırılmamış.'

function toAuthError(status: number, payload: unknown): AuthError {
  const message = String(
    (payload as { message?: unknown } | null)?.message ??
      'İşlem tamamlanamadı.',
  )
  return { status, message }
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
  } | null
  if (!payload?.user) throw toAuthError(500, null)
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
