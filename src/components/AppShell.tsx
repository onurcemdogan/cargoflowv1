import {
  Bug,
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  LogOut,
  PackageSearch,
  Plug,
  ScrollText,
  Tag,
  Truck,
} from 'lucide-react'
import { useContext } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { AuthContext } from '../auth/AuthProvider'
import type { PageKey } from '../types/cargoflow'

interface AppShellProps {
  activePage: PageKey
  onNavigate: (page: PageKey) => void
  children: ReactNode
}

const navItems: Array<{
  key: PageKey
  label: string
  icon: ComponentType<{ size?: number }>
}> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'orders', label: 'Siparişler', icon: ClipboardList },
  { key: 'products', label: 'Ürünler', icon: PackageSearch },
  { key: 'cargo', label: 'Kargo İşlemleri', icon: Truck },
  { key: 'labelTemplates', label: 'Etiket Şablonları', icon: Tag },
  { key: 'integrations', label: 'Entegrasyonlar / Ayarlar', icon: Plug },
  { key: 'debug', label: 'Entegrasyonlar / Debug Merkezi', icon: Bug },
  { key: 'logs', label: 'İşlem Logları', icon: ListChecks },
]

export function AppShell({
  activePage,
  onNavigate,
  children,
}: AppShellProps) {
  // AuthGate içinde context her zaman mevcuttur; testlerde/izole render'da
  // yoksa kullanıcı bloğu sessizce gizlenir (throw yok).
  const auth = useContext(AuthContext)
  const sessionUser = auth?.user ?? null
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CF</div>
          <div>
            <strong>CargoFlow</strong>
            <span>Operasyon Paneli</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Ana navigasyon">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = activePage === item.key
            return (
              <button
                key={item.key}
                type="button"
                className={active ? 'nav-item active' : 'nav-item'}
                onClick={() => onNavigate(item.key)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        {sessionUser ? (
          <div className="sidebar-session" aria-label="Oturum bilgisi">
            <div className="sidebar-session-identity">
              <strong>{sessionUser.organization.name}</strong>
              <span>{sessionUser.username}</span>
            </div>
            <button
              type="button"
              className="sidebar-signout"
              onClick={() => void auth?.signOut()}
            >
              <LogOut size={15} />
              Çıkış Yap
            </button>
          </div>
        ) : null}

        <div className="sidebar-note">
          <ScrollText size={16} />
          <span>Canlı pazaryeri ve kargo operasyon akışı.</span>
        </div>
      </aside>
      <main className="main-panel">{children}</main>
    </div>
  )
}
