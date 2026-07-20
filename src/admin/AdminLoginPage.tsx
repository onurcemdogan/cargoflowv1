// Platform admin giriş ekranı (/admin/login). Normal /login'den AYRI; AppShell
// yeniden kullanılmaz. Hata mesajı geneldir (kullanıcı var/yok sızdırılmaz).
import { useState } from 'react'
import { adminLogin } from './adminApiService'

export function AdminLoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await adminLogin(username.trim(), password)
      if (result.ok) {
        setPassword('')
        onLoggedIn()
        return
      }
      setError(result.message ?? 'Yönetici kullanıcı adı veya şifre hatalı')
    } catch {
      setError('Giriş yapılamadı. Bağlantıyı kontrol edin.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-auth-screen">
      <form className="admin-auth-card" onSubmit={submit}>
        <div className="admin-brand">
          <span className="admin-brand-mark">CF</span>
          <div>
            <h1>Platform Yönetimi</h1>
            <p>Yalnız yetkili platform yöneticileri</p>
          </div>
        </div>
        <label>
          Kullanıcı Adı
          <input
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Şifre
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}
        </button>
      </form>
    </div>
  )
}
