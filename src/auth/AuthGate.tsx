// Uygulama kabuğunun önündeki auth guard'ı. Mevcut App/route yapısına
// dokunmaz; yalnız hangi görünümün render edileceğini seçer.
//
// Oturumdan bağımsız sayfalar (`/app/verify-email`, `/app/reset-password`)
// her durumda açılır: bağlantı başka bir oturum açıkken de çalışmalıdır.
// Kayıt ve şifremi unuttum yalnız oturum yokken gösterilir.
import type { ReactNode } from 'react'
import { LoginPage } from '../pages/LoginPage'
import { BootstrapPage } from '../pages/BootstrapPage'
import { WorkspaceSetupPage } from '../pages/WorkspaceSetupPage'
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  SignupPage,
  VerifyEmailPage,
} from '../pages/auth/SelfServicePages'
import { useAuth } from './useAuth'
import { resolveAuthView, resolvePublicAuthRoute } from './authView'

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const view = resolveAuthView(auth.status)
  const publicRoute = resolvePublicAuthRoute(window.location.pathname)

  if (publicRoute === 'verify-email') return <VerifyEmailPage />
  if (publicRoute === 'reset-password') return <ResetPasswordPage />

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
  if (view === 'login') {
    if (publicRoute === 'signup') return <SignupPage />
    if (publicRoute === 'forgot-password') return <ForgotPasswordPage />
    return <LoginPage />
  }
  if (view === 'workspace') return <WorkspaceSetupPage />
  return <>{children}</>
}
