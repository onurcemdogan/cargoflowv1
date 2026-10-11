// AYARLAR — görünüm, çalışma alanı ve gelişmiş araçlar.
//
// Burada YENİ bir ayar sistemi yoktur: tema yalnız bu tarayıcının görünüm
// tercihidir; gönderi varsayılanları ve ödeyen ayarı Entegrasyonlar
// ekranındaki mevcut bölümlerde kalır ve buradan oraya geçilir. Paket /
// abonelik bilgisi UYDURULMAZ.
import { useContext } from 'react'
import { Bug, ChevronRight, Compass, ListChecks, Moon, Plug, Sun } from 'lucide-react'
import { AuthContext } from '../auth/AuthProvider'
import { PageHeader } from '../components/PageHeader'
import type { PageKey } from '../types/cargoflow'
import { Card } from '../ui/primitives'
import { useTheme } from '../ui/theme'

export function SettingsPage({
  onNavigate,
  onStartTour,
}: {
  onNavigate: (page: PageKey) => void
  onStartTour?: () => void
}) {
  const auth = useContext(AuthContext)
  const user = auth?.user ?? null
  const [theme, setTheme] = useTheme()

  return (
    <div className="settings">
      <PageHeader title="Ayarlar" description="Görünüm, çalışma alanı ve gelişmiş araçlar." />

      <div className="settings-grid">
        <Card title="Görünüm" subtitle="Tercih yalnız bu tarayıcıda saklanır." labelledBy="settings-appearance">
          <div className="settings-theme" role="radiogroup" aria-label="Tema">
            {(
              [
                { key: 'dark', label: 'Koyu', icon: Moon },
                { key: 'light', label: 'Açık', icon: Sun },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={theme === option.key}
                className={theme === option.key ? 'settings-theme-option is-active' : 'settings-theme-option'}
                onClick={() => setTheme(option.key)}
              >
                <span className={`settings-theme-swatch is-${option.key}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  <option.icon size={14} aria-hidden="true" />
                  {option.label}
                </span>
              </button>
            ))}
          </div>
          <dl className="settings-facts">
            <div>
              <dt>Panel dili</dt>
              <dd>Türkçe</dd>
            </div>
          </dl>
        </Card>

        <Card title="Çalışma alanı" labelledBy="settings-workspace">
          <dl className="settings-facts">
            <div>
              <dt>Organizasyon</dt>
              <dd>{user?.organization?.name ?? 'Yerel çalışma modu'}</dd>
            </div>
            <div>
              <dt>Kullanıcı</dt>
              <dd>{user?.username ?? '—'}</dd>
            </div>
            <div>
              <dt>Hesap yönetimi</dt>
              <dd>Kullanıcılar organizasyon yöneticisi tarafından oluşturulur.</dd>
            </div>
          </dl>
        </Card>

        <Card title="Entegrasyon ayarları" labelledBy="settings-integrations">
          <ul className="settings-links">
            <li>
              <button type="button" onClick={() => onNavigate('integrations')}>
                <Plug size={16} aria-hidden="true" />
                <span>
                  <b>Bağlantılar ve gönderi varsayılanları</b>
                  <small>Pazaryeri ve kargo hesapları, desi ve ödeyen ayarları</small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
            {onStartTour ? (
              <li>
                <button type="button" onClick={onStartTour}>
                  <Compass size={16} aria-hidden="true" />
                  <span>
                    <b>Ürün turu</b>
                    <small>Panelin ana ekranlarını yeniden tanıyın</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            ) : null}
          </ul>
        </Card>

        <Card title="Gelişmiş" subtitle="Destek ve sorun giderme araçları." labelledBy="settings-advanced">
          <ul className="settings-links">
            <li>
              <button type="button" onClick={() => onNavigate('debug')}>
                <Bug size={16} aria-hidden="true" />
                <span>
                  <b>Debug Merkezi</b>
                  <small>Entegrasyon istek ve yanıt kayıtları</small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
            <li>
              <button type="button" onClick={() => onNavigate('logs')}>
                <ListChecks size={16} aria-hidden="true" />
                <span>
                  <b>İşlem Logları</b>
                  <small>Bu tarayıcıda yapılan işlemlerin kaydı</small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  )
}
