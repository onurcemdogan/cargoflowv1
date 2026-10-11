// İLK GİRİŞ — çalışma alanı (firma) gerekli.
//
// E-postasını doğrulamış ama henüz çalışma alanı olmayan kullanıcı burada
// karşılanır. Kiracı uçları bu oturumu `WORKSPACE_REQUIRED` ile reddeder;
// uygulama kabuğu açılmaz.
import { useAuth } from '../auth/useAuth'

export function WorkspaceSetupPage() {
  const auth = useAuth()
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="auth-brand-logo" src="/favicon.png" alt="" width={32} height={32} />
          <div>
            <strong>CargoFlow</strong>
            <span>{auth.user?.email ?? auth.user?.username ?? ''}</span>
          </div>
        </div>
        <h1>Çalışma alanınızı oluşturun</h1>
        <p className="auth-lead">Devam etmek için firmanızın çalışma alanı gerekli.</p>
        <button type="button" className="auth-secondary" onClick={() => void auth.signOut()}>
          Çıkış Yap
        </button>
      </div>
    </div>
  )
}
