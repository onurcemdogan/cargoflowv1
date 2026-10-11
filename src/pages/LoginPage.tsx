// Giriş ekranı. Şifre tarayıcı storage'ına yazılmaz (yalnız controlled
// input state'i); session HttpOnly cookie ile backend'de tutulur.
import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { getAuthConfig, type AuthError, type AuthPublicConfig } from '../auth/authService'

export function LoginPage() {
  const auth = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string>()
  const [formErrorCode, setFormErrorCode] = useState<string>()
  const [config, setConfig] = useState<AuthPublicConfig | null>(null)
  const bannerMessage = auth.unavailableMessage ?? auth.error

  // Kayıt / şifremi unuttum bağlantıları YALNIZ sunucu açık bildirirse görünür.
  useEffect(() => {
    let active = true
    getAuthConfig().then((value) => {
      if (active) setConfig(value)
    })
    return () => {
      active = false
    }
  }, [])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setFormError(undefined)
    setFormErrorCode(undefined)
    try {
      await auth.signIn(username.trim().toLowerCase(), password)
    } catch (error) {
      setFormError(
        String((error as AuthError)?.message ?? 'Giriş yapılamadı.'),
      )
      setFormErrorCode((error as AuthError)?.code)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={handleSubmit}
        aria-busy={submitting}
      >
        <div className="auth-brand">
          <img className="auth-brand-logo" src="/favicon.png" alt="" width={32} height={32} />
          <div>
            <strong>CargoFlow</strong>
            <span>Operasyon Paneli</span>
          </div>
        </div>
        <h1>Giriş Yap</h1>
        <p className="auth-lead">E-posta adresiniz veya kullanıcı adınızla panele girin.</p>

        {bannerMessage ? (
          <p className="auth-banner" role="alert">
            {bannerMessage}
          </p>
        ) : null}

        <label htmlFor="login-username">
          <span>E-posta veya kullanıcı adı</span>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={submitting}
            required
          />
        </label>

        <label htmlFor="login-password">
          <span>Şifre</span>
          <div className="auth-password-row">
            <input
              id="login-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />
            <button
              type="button"
              className="auth-password-toggle"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
            >
              {showPassword ? 'Gizle' : 'Göster'}
            </button>
          </div>
        </label>

        {formError ? (
          <p className="auth-error" role="alert">
            {formError}
            {formErrorCode === 'EMAIL_NOT_VERIFIED' && config?.signupEnabled ? (
              <>
                {' '}
                <a href="/app/signup">Yeni doğrulama bağlantısı isteyin.</a>
              </>
            ) : null}
          </p>
        ) : null}

        <button
          type="submit"
          className="auth-submit"
          disabled={submitting || !username.trim() || !password}
        >
          {submitting ? 'Giriş yapılıyor…' : 'Giriş Yap'}
        </button>
        {config?.passwordResetEnabled ? (
          <a className="auth-inline-link" href="/app/forgot-password">
            Şifremi unuttum
          </a>
        ) : null}
        {/* "İlk kurulumu yap" (bootstrap) bağlantısı YOKTUR; bootstrap
            production'da kapalıdır. Herkese açık kayıt AYRI bir akıştır ve
            yalnız sunucu açık bildirirse görünür. */}
        {config?.signupEnabled ? (
          <p className="auth-footnote">
            Hesabınız yok mu? <a href="/app/signup">Kayıt olun</a>
          </p>
        ) : (
          <p className="auth-footnote">
            Hesaplar organizasyon yöneticisi tarafından oluşturulur.
          </p>
        )}
      </form>
      <a className="auth-back" href="/">
        CargoFlow ana sayfası
      </a>
    </div>
  )
}
