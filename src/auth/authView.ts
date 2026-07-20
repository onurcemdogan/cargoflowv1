import type { AuthStatus } from './AuthProvider'

export type AuthView = 'loading' | 'login' | 'bootstrap' | 'app'

// Saf görünüm seçici (test edilebilir): kullanıcı giriş yapmadan uygulama
// asla görünmez.
export function resolveAuthView(status: AuthStatus): AuthView {
  if (status === 'authenticated') return 'app'
  if (status === 'setup_required') return 'bootstrap'
  if (status === 'unauthenticated') return 'login'
  return 'loading'
}
