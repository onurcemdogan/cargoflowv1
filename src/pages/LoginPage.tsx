// Giriş ekranı. Şifre tarayıcı storage'ına yazılmaz (yalnız controlled
// input state'i); session HttpOnly cookie ile backend'de tutulur.
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import type { AuthError } from '../auth/authService'

export function LoginPage() {
  const auth = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string>()
  const bannerMessage = auth.unavailableMessage ?? auth.error

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setFormError(undefined)
    try {
      await auth.signIn(username.trim().toLowerCase(), password)
    } catch (error) {
      setFormError(
        String((error as AuthError)?.message ?? 'Giriş yapılamadı.'),
      )
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
          <div className="auth-brand-mark">CF</div>
          <div>
            <strong>CargoFlow</strong>
            <span>Operasyon Paneli</span>
          </div>
        </div>
        <h1>Giriş Yap</h1>

        {bannerMessage ? (
          <p className="auth-banner" role="alert">
            {bannerMessage}
          </p>
        ) : null}

        <label htmlFor="login-username">
          <span>Kullanıcı adı</span>
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
          </p>
        ) : null}

        <button
          type="submit"
          className="auth-submit"
          disabled={submitting || !username.trim() || !password}
        >
          {submitting ? 'Giriş yapılıyor…' : 'Giriş Yap'}
        </button>
        {/* Public "İlk kurulumu yap" bağlantısı kaldırıldı: organization
            hesapları platform yöneticisi tarafından oluşturulur. Backend
            ALLOW_PUBLIC_BOOTSTRAP=false koruması ayrıca geçerlidir. */}
      </form>
    </div>
  )
}
