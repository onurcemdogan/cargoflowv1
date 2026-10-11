// İLK GİRİŞ — çalışma alanı (firma) oluşturma.
//
// E-postasını doğrulamış ama henüz çalışma alanı olmayan kullanıcı burada
// firmasını oluşturur ve owner olur. Kiracı uçları bu oturumu
// `WORKSPACE_REQUIRED` ile reddettiği için uygulama kabuğu açılmaz; firma
// oluşunca oturum yenilenir ve kurulum (onboarding) başlar.
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth'
import { createWorkspace, type AuthError } from '../auth/authService'

export function WorkspaceSetupPage() {
  const auth = useAuth()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await createWorkspace(name)
      await auth.refreshSession()
    } catch (failure) {
      setError(String((failure as AuthError)?.message ?? 'Çalışma alanı oluşturulamadı.'))
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit} aria-busy={busy}>
        <div className="auth-brand">
          <img className="auth-brand-logo" src="/favicon.png" alt="" width={32} height={32} />
          <div>
            <strong>CargoFlow</strong>
            <span>{auth.user?.email ?? auth.user?.username ?? ''}</span>
          </div>
        </div>
        <h1>Çalışma alanınızı oluşturun</h1>
        <p className="auth-lead">
          Firmanızın adını girin. Siparişleriniz, entegrasyonlarınız ve kargo hesaplarınız bu
          çalışma alanına bağlanır.
        </p>
        <label htmlFor="workspace-name">
          <span>Firma adı</span>
          <input
            id="workspace-name"
            autoComplete="organization"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            required
          />
        </label>
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="auth-submit" disabled={busy || name.trim().length < 2}>
          {busy ? 'Oluşturuluyor…' : 'Çalışma alanını oluştur'}
        </button>
        <button type="button" className="auth-secondary" onClick={() => void auth.signOut()} disabled={busy}>
          Çıkış Yap
        </button>
      </form>
    </div>
  )
}
