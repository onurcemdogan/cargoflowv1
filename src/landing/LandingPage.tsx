// HERKESE AÇIK TANITIM SAYFASI (/).
//
// AuthProvider DIŞINDADIR: açılışı `/api/auth/me`, onboarding, entegrasyon
// veya sağlayıcı çağrısı YAPMAZ; kimlik arka ucu erişilemezken de çalışır.
// Ürün sahnesi TEMSİLİDİR: gerçek müşteri/sipariş/telefon/adres içermez.
import { useEffect, useState, type ComponentType } from 'react'
import {
  Activity,
  ArrowRight,
  Boxes,
  Building2,
  Check,
  CircleStop,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  MousePointerClick,
  Package,
  Plug,
  Printer,
  Route,
  Search,
  Truck,
} from 'lucide-react'
import { APP_ENTRY_PATH, LANDING_TITLE } from '../entryRoute'
import {
  INTEGRATION_STATUS_HELP,
  INTEGRATION_STATUS_LABEL,
  LANDING_CAPABILITIES,
  LANDING_CONTROL_POINTS,
  LANDING_HERO,
  LANDING_INTEGRATIONS,
  LANDING_VALUES,
  LANDING_WORKFLOW,
  type IntegrationStatus,
  type LandingIntegration,
} from './landingContent'
import './landing.css'

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>

const ICONS: Record<string, IconComponent> = {
  orders: ListChecks,
  route: Route,
  label: Printer,
  health: Activity,
  catalog: Boxes,
  organization: Building2,
  key: KeyRound,
  hand: MousePointerClick,
  stop: CircleStop,
}

function FeatureIcon({ name }: { name: string }) {
  const Icon = ICONS[name] ?? Check
  return (
    <span className="landing-icon" aria-hidden="true">
      <Icon size={18} strokeWidth={1.8} aria-hidden />
    </span>
  )
}

const NAV_LINKS = [
  { href: '#urun', label: 'Ürün' },
  { href: '#entegrasyonlar', label: 'Entegrasyonlar' },
  { href: '#nasil-calisir', label: 'Nasıl Çalışır?' },
  { href: '#guvenilirlik', label: 'Güvenilirlik' },
] as const

const FOOTER_LINKS = [
  { href: '#urun', label: 'Ürün' },
  { href: '#entegrasyonlar', label: 'Entegrasyonlar' },
  { href: '#nasil-calisir', label: 'Nasıl Çalışır' },
] as const

/** Temsili sahne — açıkça örnek veriler (gerçek kayıt DEĞİL). */
const SCENE_ROWS = [
  { label: 'Örnek sipariş A', ref: '#1042', carrier: 'Sürat Kargo', labelState: 'Hazır', labelTone: 'ok', shipment: 'Oluşturuldu', shipmentTone: 'info' },
  { label: 'Örnek sipariş B', ref: '#1041', carrier: 'Sürat Kargo', labelState: 'Yazdırıldı', labelTone: 'muted', shipment: 'Kargoda', shipmentTone: 'ok' },
  { label: 'Örnek sipariş C', ref: '#1039', carrier: 'Sürat Kargo', labelState: 'Bekliyor', labelTone: 'muted', shipment: 'Hazırlanıyor', shipmentTone: 'muted' },
  { label: 'Örnek sipariş D', ref: '#1037', carrier: 'Atanmadı', labelState: '—', labelTone: 'muted', shipment: 'Kargo ataması bekleniyor', shipmentTone: 'warn' },
] as const

const SCENE_NAV = [
  { icon: LayoutDashboard, label: 'Dashboard' },
  { icon: ListChecks, label: 'Siparişler', active: true },
  { icon: Package, label: 'Ürünler' },
  { icon: Truck, label: 'Kargo' },
  { icon: Printer, label: 'Etiketler' },
  { icon: Plug, label: 'Entegrasyonlar' },
] as const

function ProductScene() {
  return (
    <figure className="landing-scene">
      <div className="landing-scene-window" aria-hidden="true">
        <div className="landing-scene-chrome">
          <span />
          <span />
          <span />
          <b>CargoFlow · Siparişler</b>
        </div>
        <div className="landing-scene-body">
          <div className="landing-scene-nav">
            {SCENE_NAV.map((item) => (
              <div key={item.label} className={'active' in item ? 'is-active' : undefined}>
                <item.icon size={14} strokeWidth={2} aria-hidden />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="landing-scene-main">
            <div className="landing-scene-toolbar">
              <span className="landing-scene-search">
                <Search size={12} strokeWidth={2} aria-hidden />
                Sipariş ara
              </span>
              <span className="landing-scene-filter is-on">Bugün</span>
              <span className="landing-scene-filter">Etiket bekleyen</span>
            </div>
            <div className="landing-scene-kpis">
              <div>
                <small>Bekleyen</small>
                <strong>18</strong>
              </div>
              <div>
                <small>Etiket hazır</small>
                <strong>42</strong>
              </div>
              <div>
                <small>Kargoda</small>
                <strong>127</strong>
              </div>
            </div>
            <div className="landing-scene-table">
              <div className="landing-scene-head">
                <span>Sipariş</span>
                <span>Kanal</span>
                <span>Kargo</span>
                <span>Etiket</span>
                <span>Gönderi</span>
              </div>
              {SCENE_ROWS.map((row) => (
                <div key={row.label} className="landing-scene-row">
                  <span className="landing-scene-order">
                    <b>{row.label}</b>
                    <small>{row.ref}</small>
                  </span>
                  <span>
                    <i className="landing-badge landing-badge-market">Trendyol</i>
                  </span>
                  <span>
                    <i className={row.carrier === 'Atanmadı' ? 'landing-badge landing-badge-empty' : 'landing-badge landing-badge-carrier'}>
                      {row.carrier}
                    </i>
                  </span>
                  <span>
                    <i className={`landing-dot tone-${row.labelTone}`}>{row.labelState}</i>
                  </span>
                  <span>
                    <i className={`landing-dot tone-${row.shipmentTone}`}>{row.shipment}</i>
                  </span>
                </div>
              ))}
            </div>
            <div className="landing-scene-side">
              <div className="landing-scene-card">
                <small>Bağlantı sağlığı</small>
                <p>
                  <i className="landing-dot tone-ok">Trendyol</i>
                  <em>Senkron 2 dk önce</em>
                </p>
                <p>
                  <i className="landing-dot tone-ok">Sürat Kargo</i>
                  <em>Bağlı</em>
                </p>
              </div>
              <div className="landing-scene-card">
                <small>Etiket önizleme</small>
                <div className="landing-scene-barcode" />
                <em>100×100 · Sürat Kargo</em>
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption>Temsili ekran · örnek veriler</figcaption>
    </figure>
  )
}

function IntegrationGroup({ title, items }: { title: string; items: readonly LandingIntegration[] }) {
  return (
    <div className="landing-integration-group">
      <h3>{title}</h3>
      <ul>
        {items.map((integration) => (
          <li key={integration.name} data-integration={integration.name} data-status={integration.status}>
            <span className="landing-integration-name">
              <strong>{integration.name}</strong>
              <small>{integration.kind}</small>
            </span>
            <span className={`landing-status status-${integration.status}`}>
              {INTEGRATION_STATUS_LABEL[integration.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const STATUS_ORDER: readonly IntegrationStatus[] = ['live', 'internal_test', 'in_development']

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    document.title = LANDING_TITLE
    // Yalnız bu sayfaya ait gövde sınıfı; uygulama sayfalarına sızmaz.
    document.body.classList.add('landing-body')
    return () => document.body.classList.remove('landing-body')
  }, [])

  const year = new Date().getFullYear()

  return (
    <div className="landing-root">
      <header className="landing-header">
        <div className="landing-container landing-header-inner">
          <a className="landing-brand" href="/" aria-label="CargoFlow ana sayfa">
            <img src="/favicon.png" alt="" width={30} height={30} />
            <span>CargoFlow</span>
          </a>
          <button
            type="button"
            className="landing-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="landing-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? 'Menüyü kapat' : 'Menü'}
          </button>
          <nav
            id="landing-nav"
            className={menuOpen ? 'landing-nav is-open' : 'landing-nav'}
            aria-label="Sayfa bölümleri"
          >
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
                {link.label}
              </a>
            ))}
            <a className="landing-cta landing-cta-small" href={APP_ENTRY_PATH} data-cta="primary-nav">
              Panele Gir
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-container landing-hero-grid">
            <div className="landing-hero-copy">
              <p className="landing-eyebrow">{LANDING_HERO.eyebrow}</p>
              <h1 id="landing-title">{LANDING_HERO.headline}</h1>
              <p className="landing-lead">{LANDING_HERO.body}</p>
              <div className="landing-hero-actions">
                <a className="landing-cta" href={APP_ENTRY_PATH} data-cta="primary">
                  Panele Gir
                  <ArrowRight size={17} strokeWidth={2} aria-hidden />
                </a>
                <a className="landing-cta-secondary" href="#nasil-calisir" data-cta="secondary">
                  Nasıl Çalışır?
                </a>
              </div>
              <ul className="landing-assurances">
                {LANDING_HERO.assurances.map((item) => (
                  <li key={item}>
                    <Check size={15} strokeWidth={2.4} aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="landing-hero-note">
                Hesaplar organizasyon yöneticisi tarafından oluşturulur.
              </p>
            </div>
            <ProductScene />
          </div>
        </section>

        <section id="entegrasyonlar" className="landing-section" aria-labelledby="integrations-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="landing-kicker">Entegrasyonlar</p>
              <h2 id="integrations-title">Desteklenen ve geliştirilmekte olan entegrasyon altyapısı</h2>
              <p className="landing-section-lead">
                Canlı kullanımdaki bağlantılar ile test ve geliştirme aşamasındaki bağlantılar ayrı
                gösterilir. Bir entegrasyon, canlı sipariş ve gönderi akışına ancak doğrulandıktan
                sonra açılır.
              </p>
            </div>
            <div className="landing-integrations" data-testid="landing-integrations">
              <IntegrationGroup
                title="Pazaryeri ve e-ticaret"
                items={LANDING_INTEGRATIONS.filter((item) => item.group === 'commerce')}
              />
              <IntegrationGroup
                title="Kargo"
                items={LANDING_INTEGRATIONS.filter((item) => item.group === 'carrier')}
              />
            </div>
            <dl className="landing-status-legend">
              {STATUS_ORDER.map((status) => (
                <div key={status}>
                  <dt>
                    <span className={`landing-status status-${status}`}>{INTEGRATION_STATUS_LABEL[status]}</span>
                  </dt>
                  <dd>{INTEGRATION_STATUS_HELP[status]}</dd>
                </div>
              ))}
            </dl>
            <p className="landing-fineprint">
              Markalar ilgili sahiplerine aittir; listelenmeleri bir iş birliği anlamına gelmez.
            </p>
          </div>
        </section>

        <section id="faydalar" className="landing-section landing-section-muted" aria-labelledby="values-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="landing-kicker">Neden CargoFlow</p>
              <h2 id="values-title">Günlük operasyonun yükünü tek akışa toplayın</h2>
            </div>
            <ul className="landing-values">
              {LANDING_VALUES.map((value) => (
                <li key={value.title}>
                  <FeatureIcon name={value.icon} />
                  <h3>{value.title}</h3>
                  <p>{value.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="nasil-calisir" className="landing-section" aria-labelledby="workflow-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="landing-kicker">Akış</p>
              <h2 id="workflow-title">Nasıl çalışır?</h2>
            </div>
            <ol className="landing-workflow">
              {LANDING_WORKFLOW.map((step, index) => (
                <li key={step.title}>
                  <span className="landing-step-index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="urun" className="landing-section landing-section-muted" aria-labelledby="product-title">
          <div className="landing-container landing-product">
            <div className="landing-section-head">
              <p className="landing-kicker">Ürün</p>
              <h2 id="product-title">Operasyonu tek panelden yönetin</h2>
              <p className="landing-section-lead">
                Siparişten etikete, katalogdan bağlantı sağlığına kadar günlük operasyonun her
                ekranı aynı panelde, aynı organizasyon verisiyle çalışır.
              </p>
            </div>
            <ul className="landing-capabilities">
              {LANDING_CAPABILITIES.map((capability) => (
                <li key={capability.title} data-capability={capability.title}>
                  <FeatureIcon name={capability.icon} />
                  <div>
                    <h3>{capability.title}</h3>
                    <p>{capability.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="guvenilirlik" className="landing-section landing-section-dark" aria-labelledby="control-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="landing-kicker">Güvenilirlik</p>
              <h2 id="control-title">Operasyon kontrolü sizde</h2>
              <p className="landing-section-lead">
                CargoFlow emin olmadığı bir işlemi yapmak yerine durur ve sizi bilgilendirir.
              </p>
            </div>
            <ul className="landing-control">
              {LANDING_CONTROL_POINTS.map((point) => (
                <li key={point.title}>
                  <FeatureIcon name={point.icon} />
                  <h3>{point.title}</h3>
                  <p>{point.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="final-title">
          <div className="landing-container landing-final-inner">
            <h2 id="final-title">E-ticaret operasyonunuzu tek panelde yönetin.</h2>
            <p>Hesabınız organizasyon yöneticiniz tarafından oluşturulur. Giriş bilgilerinizle panele geçin.</p>
            <a className="landing-cta" href={APP_ENTRY_PATH} data-cta="primary-final">
              Panele Gir
              <ArrowRight size={17} strokeWidth={2} aria-hidden />
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <div className="landing-footer-brand">
            <span>CargoFlow</span>
            <p>E-ticaret sipariş, kargo ve etiket operasyonu için tek panel.</p>
          </div>
          <nav className="landing-footer-nav" aria-label="Alt bağlantılar">
            {FOOTER_LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
            <a href={APP_ENTRY_PATH}>Panele Gir</a>
          </nav>
        </div>
        <div className="landing-container landing-footer-bottom">
          <span>© {year} CargoFlow · ONRSOFT</span>
        </div>
      </footer>
    </div>
  )
}
