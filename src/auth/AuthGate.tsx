// Uygulama kabuğunun önündeki auth guard'ı. Mevcut App/route yapısına
// dokunmaz; yalnız hangi görünümün render edileceğini seçer.
import type { ReactNode } from 'react'
import { LoginPage } from '../pages/LoginPage'
import { BootstrapPage } from '../pages/BootstrapPage'
import { useAuth } from './useAuth'
import { resolveAuthView } from './authView'

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const view = resolveAuthView(auth.status)

  if (view === 'loading') {
    return (
      <div className="auth-loading-screen" role="status" aria-live="polite">
        <img className="auth-brand-logo" src="/favicon.png" alt="" width={32} height={32} />
        <span className="ui-spinner" aria-hidden="true" />
        <span>Oturum kontrol ediliyor…</span>
      </div>
    )
  }
  if (view === 'bootstrap') return <BootstrapPage />
  if (view === 'login') return <LoginPage />
  return <>{children}</>
}
