// İlk kurulum ekranı: sistem boşken organization + ilk kullanıcıyı oluşturur.
// Frontend doğrulaması yalnız UX içindir; esas doğrulama backend'dedir ve
// İKİSİ DE aynı ortak parola sabitini kullanır.
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import type { AuthError } from '../auth/authService'
import {
  isPasswordLongEnough,
  PASSWORD_TOO_SHORT_MESSAGE,
} from '../auth/passwordPolicy'

export function BootstrapPage() {
  const auth = useAuth()
  const [organizationName, setOrganizationName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordRepeat, setPasswordRepeat] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string>()

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    // J) Kısa parola: istek ATILMAZ.
    if (!isPasswordLongEnough(password)) {
      setFormError(PASSWORD_TOO_SHORT_MESSAGE)
      return
    }
    if (password !== passwordRepeat) {
      setFormError('Parolalar eşleşmiyor.')
      return
    }
    setSubmitting(true)
    setFormError(undefined)
    try {
      await auth.initializeOrganization(
        organizationName.trim(),
        username.trim().toLowerCase(),
        password,
      )
    } catch (error) {
      const authError = error as AuthError
      if (authError?.status !== 409) {
        setFormError(String(authError?.message ?? 'Kurulum tamamlanamadı.'))
      }
      // 409: AuthProvider login ekranına geçirir ve mesajı orada gösterir.
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
            <span>İlk Kurulum</span>
          </div>
        </div>
        <h1>Sistemi Kur</h1>
        <p className="auth-helper">
          Şirketinizi ve ilk kullanıcıyı oluşturun. Bu işlem yalnız bir kez
          yapılır.
        </p>

        <label htmlFor="bootstrap-organization">
          <span>Şirket adı</span>
          <input
            id="bootstrap-organization"
            name="organizationName"
            type="text"
            autoComplete="organization"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            disabled={submitting}
            required
          />
        </label>

        <label htmlFor="bootstrap-username">
          <span>Kullanıcı adı</span>
          <input
            id="bootstrap-username"
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

        <label htmlFor="bootstrap-password">
          <span>Şifre</span>
          <input
            id="bootstrap-password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            required
          />
        </label>

        <label htmlFor="bootstrap-password-repeat">
          <span>Şifre tekrarı</span>
          <input
            id="bootstrap-password-repeat"
            name="passwordRepeat"
            type="password"
            autoComplete="new-password"
            value={passwordRepeat}
            onChange={(event) => setPasswordRepeat(event.target.value)}
            disabled={submitting}
            required
          />
        </label>

        {formError ? (
          <p className="auth-error" role="alert">
            {formError}
          </p>
        ) : null}

        <button
          type="submit"
          className="auth-submit"
          disabled={
            submitting ||
            !organizationName.trim() ||
            !username.trim() ||
            !password ||
            !passwordRepeat
          }
        >
          {submitting ? 'Kuruluyor…' : 'Kurulumu Tamamla'}
        </button>

        <button type="button" className="auth-link" onClick={auth.cancelSetup}>
          Girişe dön
        </button>
      </form>
    </div>
  )
}
