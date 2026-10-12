// AYARLAR — görünüm, çalışma alanı ve gelişmiş araçlar.
//
// Burada YENİ bir ayar sistemi yoktur: tema yalnız bu tarayıcının görünüm
// tercihidir; gönderi varsayılanları ve ödeyen ayarı Entegrasyonlar
// ekranındaki mevcut bölümlerde kalır ve buradan oraya geçilir. Paket /
// abonelik bilgisi UYDURULMAZ.
import { useContext } from 'react'
import { Bug, ChevronRight, Compass, ListChecks, Moon, PenTool, Plug, Sun } from 'lucide-react'
import { AuthContext } from '../auth/AuthProvider'
import { PageHeader } from '../components/PageHeader'
import type { PageKey, PrinterSettings } from '../types/cargoflow'
import { Badge, Card } from '../ui/primitives'
import { useTheme } from '../ui/theme'

/** Ayarlar > Baskı ve Etiket kartının salt okunur özeti. */
export interface PrintSettingsSummary {
  printer: PrinterSettings
  /** Ham (Zebra/yerel ajan) baskı yolu durumu; bilinmiyorsa null. */
  rawPrint: { available: boolean; reason: string | null } | null
  /** Yayındaki özel etiket yerleşiminin adı; kullanılmıyorsa null. */
  activeLayoutName: string | null
}

const PRINT_MODE_LABEL: Record<PrinterSettings['mode'], string> = {
  'browser-print': 'Tarayıcıdan yazdır',
  download: 'Dosya olarak indir',
  'local-agent': 'Yerel yazıcı ajanı',
}

export function SettingsPage({
  onNavigate,
  onStartTour,
  print,
}: {
  onNavigate: (page: PageKey) => void
  onStartTour?: () => void
  print?: PrintSettingsSummary
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

        <Card
          title="Baskı ve Etiket"
          subtitle="Sürat gönderilerinde resmî taşıyıcı etiketi basılır."
          labelledBy="settings-print"
          className="settings-print"
        >
          <dl className="settings-facts">
            <div>
              <dt>Ana format</dt>
              <dd>Resmî Sürat etiketi</dd>
            </div>
            <div>
              <dt>Baskı yöntemi</dt>
              <dd>{print ? PRINT_MODE_LABEL[print.printer.mode] ?? print.printer.mode : '—'}</dd>
            </div>
            <div>
              <dt>Yazıcı bağlantısı</dt>
              <dd>
                {!print || print.rawPrint === null ? (
                  'Kontrol edilmedi'
                ) : print.rawPrint.available ? (
                  <Badge tone="success" dot>Hazır</Badge>
                ) : (
                  <Badge tone="warning" dot>{print.rawPrint.reason ?? 'Kullanılamıyor'}</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt>Etiket ölçüsü</dt>
              <dd>{print ? `${print.printer.labelSize.replace('x', ' × ')} mm` : '—'}</dd>
            </div>
            <div>
              <dt>Varsayılan davranış</dt>
              <dd>Tek tıkla oluştur ve yazdır; hazır etiket yeniden oluşturulmadan basılır.</dd>
            </div>
            <div>
              <dt>Özel yerleşim</dt>
              <dd>{print?.activeLayoutName ? `Kullanılıyor: ${print.activeLayoutName}` : 'Kullanılmıyor'}</dd>
            </div>
          </dl>
          <p className="settings-note">
            Özel yerleşim, resmî taşıyıcı barkodunu, QR kodunu ve takip numarasını değiştiremez.
          </p>
          <ul className="settings-links">
            <li>
              <button type="button" onClick={() => onNavigate('labelTemplates')}>
                <PenTool size={16} aria-hidden="true" />
                <span>
                  <b>Etiket yerleşimini özelleştir</b>
                  <small>Gelişmiş: resmî etiketin üstüne alan ekleme ve önizleme</small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
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
