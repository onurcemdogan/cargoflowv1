import type { AuthStatus } from './AuthProvider'

export type AuthView = 'loading' | 'login' | 'bootstrap' | 'workspace' | 'app'

// Saf görünüm seçici (test edilebilir): kullanıcı giriş yapmadan uygulama
// asla görünmez.
export function resolveAuthView(status: AuthStatus): AuthView {
  if (status === 'authenticated') return 'app'
  if (status === 'setup_required') return 'bootstrap'
  if (status === 'workspace_required') return 'workspace'
  if (status === 'unauthenticated') return 'login'
  return 'loading'
}

/** Oturumdan bağımsız açılan auth sayfaları (`/app/<yol>`). */
export type PublicAuthRoute = 'signup' | 'verify-email' | 'forgot-password' | 'reset-password'

export function resolvePublicAuthRoute(pathname: string): PublicAuthRoute | null {
  const path = String(pathname ?? '').replace(/\/+$/, '')
  for (const route of ['signup', 'verify-email', 'forgot-password', 'reset-password'] as const) {
    if (path === `/app/${route}`) return route
  }
  return null
}
