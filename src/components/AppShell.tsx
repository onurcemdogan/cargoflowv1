import {
  ClipboardList,
  ChartNoAxesCombined,
  ListChecks,
  Compass,
  House,
  LogOut,
  Menu,
  Moon,
  PackageSearch,
  Plug,
  Route,
  Settings,
  Sun,
  Truck,
  X,
} from 'lucide-react'
import { useContext, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { AuthContext } from '../auth/AuthProvider'
import type { PageKey } from '../types/cargoflow'
import { useTheme } from '../ui/theme'

interface AppShellProps {
  activePage: PageKey
  onNavigate: (page: PageKey) => void
  children: ReactNode
  /** Ürün turunu elle (yeniden) başlatır; verilmezse düğme gösterilmez. */
  onStartTour?: () => void
  /** Tur başlatılamadıysa DÜRÜST sebep. */
  tourNotice?: string | null
  /**
   * Tur açıkken arka plan ETKİLEŞİMİ KİLİTLİDİR: vurgulanan bir operasyon
   * düğmesi yanlışlıkla tetiklenemez. Tur kendi navigasyonunu programatik
   * olarak yapar.
   */
  interactionLocked?: boolean
}

/** Arka plan olayını tur açıkken durdurur (yakalama aşamasında). */
function blockWhileLocked(event: { preventDefault: () => void; stopPropagation: () => void }) {
  event.preventDefault()
  event.stopPropagation()
}

type NavIcon = ComponentType<{ size?: number; strokeWidth?: number }>

const navItems: Array<{
  key: PageKey
  label: string
  icon: NavIcon
}> = [
  // Ürün akışı: ne satıldı → ne toplanacak → kargo hattında ne oluyor → kargoya çıktıktan
  // sonra ne oldu → katalog → bağlantılar.
  { key: 'dashboard', label: 'Ana Sayfa', icon: House },
  { key: 'orders', label: 'Siparişler', icon: ClipboardList },
  { key: 'picking', label: 'Toplanacak Ürünler', icon: ListChecks },
  { key: 'cargo', label: 'Kargo Operasyonları', icon: Truck },
  { key: 'shipments', label: 'Gönderiler', icon: Route },
  { key: 'reports', label: 'Raporlar', icon: ChartNoAxesCombined },
  { key: 'products', label: 'Ürünler', icon: PackageSearch },
  { key: 'integrations', label: 'Entegrasyonlar', icon: Plug },
]

/**
 * Alt grup: yönetim. Debug, İşlem Logları ve etiket yerleşimi düzenleyicisi
 * (Ayarlar > Baskı ve Etiket) Ayarlar içinden açılır.
 */
const footerItems: Array<{ key: PageKey; label: string; icon: NavIcon; also: PageKey[] }> = [
  { key: 'settings', label: 'Ayarlar', icon: Settings, also: ['debug', 'logs', 'labelTemplates'] },
]

export function AppShell({
  activePage,
  onNavigate,
  children,
  onStartTour,
  tourNotice,
  interactionLocked = false,
}: AppShellProps) {
  // AuthGate içinde context her zaman mevcuttur; testlerde/izole render'da
  // yoksa kullanıcı bloğu sessizce gizlenir (throw yok).
  const auth = useContext(AuthContext)
  const sessionUser = auth?.user ?? null
  const [theme, setTheme] = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)

  const go = (page: PageKey) => {
    setMenuOpen(false)
    onNavigate(page)
  }

  return (
    <div
      className="app-shell"
      inert={interactionLocked || undefined}
      aria-hidden={interactionLocked || undefined}
      onClickCapture={interactionLocked ? blockWhileLocked : undefined}
      onPointerDownCapture={interactionLocked ? blockWhileLocked : undefined}
      onKeyDownCapture={interactionLocked ? blockWhileLocked : undefined}
      onSubmitCapture={interactionLocked ? blockWhileLocked : undefined}
    >
      <aside className={menuOpen ? 'sidebar is-open' : 'sidebar'}>
        <div className="brand">
          {/*
            Marka simgesi TARAYICI FAVICON'UYLA AYNI dosyadır (/favicon.png).
            İkinci bir logo dosyası üretilmez; tek kanonik kaynak korunur.
          */}
          <img className="brand-mark" src="/favicon.png" alt="CargoFlow" />
          <div>
            <strong>CargoFlow</strong>
            <span>{sessionUser?.organization?.name ?? 'Operasyon Paneli'}</span>
          </div>
          <button
            type="button"
            className="sidebar-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="app-sidebar-menu"
            aria-label={menuOpen ? 'Menüyü kapat' : 'Menüyü aç'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <div className="sidebar-menu" id="app-sidebar-menu">
          <nav className="nav-list" aria-label="Ana navigasyon">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = activePage === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  className={active ? 'nav-item active' : 'nav-item'}
                  // Tur çapası TEK navigasyon tanımından türetilir (ikinci liste yok).
                  data-tour={`nav-${item.key}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => go(item.key)}
                >
                  <Icon size={16} strokeWidth={1.9} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>

          {/* Sabit alt blok: menü listesi kaysa bile oturum/çıkış GÖRÜNÜR kalır ve
              sayfanın en altına düşmez (sidebar viewport yüksekliğinde sabitlenir). */}
          <div className="sidebar-footer">
            <nav className="nav-list nav-list-footer" aria-label="Yönetim">
              {footerItems.map((item) => {
                const Icon = item.icon
                const active = activePage === item.key || item.also.includes(activePage)
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={active ? 'nav-item active' : 'nav-item'}
                    aria-current={active ? 'page' : undefined}
                    data-tour={`nav-${item.key}`}
                    onClick={() => go(item.key)}
                  >
                    <Icon size={16} strokeWidth={1.9} />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </nav>

            <div className="sidebar-prefs">
              <button
                type="button"
                className="sidebar-theme"
                aria-pressed={theme === 'light'}
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
                {theme === 'dark' ? 'Koyu tema' : 'Açık tema'}
              </button>
              <span className="sidebar-lang" title="Panel dili">
                TR
              </span>
            </div>

            {onStartTour ? (
              <div className="sidebar-tour-block">
                <button
                  type="button"
                  className="sidebar-tour"
                  data-tour-replay
                  onClick={onStartTour}
                >
                  <Compass size={14} />
                  Ürün Turunu Başlat
                </button>
                {tourNotice ? (
                  <p className="sidebar-tour-notice" role="status">
                    {tourNotice}
                  </p>
                ) : null}
              </div>
            ) : null}

            {sessionUser ? (
              <div className="sidebar-session" aria-label="Oturum bilgisi">
                <span className="sidebar-avatar" aria-hidden="true">
                  {sessionUser.username.charAt(0).toUpperCase()}
                </span>
                <div className="sidebar-session-identity">
                  <strong>{sessionUser.organization?.name ?? ''}</strong>
                  <span>{sessionUser.username}</span>
                </div>
                <button
                  type="button"
                  className="sidebar-signout"
                  onClick={() => void auth?.signOut()}
                >
                  <LogOut size={14} />
                  Çıkış Yap
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
      <main className="main-panel">{children}</main>
    </div>
  )
}
