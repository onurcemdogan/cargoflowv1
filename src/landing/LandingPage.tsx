// HERKESE AÇIK TANITIM SAYFASI (/).
//
// AuthProvider DIŞINDADIR: açılışı `/api/auth/me`, onboarding, entegrasyon
// veya sağlayıcı çağrısı YAPMAZ; kimlik arka ucu erişilemezken de çalışır.
// Ürün sahneleri TEMSİLİDİR: gerçek müşteri/sipariş/telefon/adres içermez.
// Sahnelerin görsel dili uygulama panelinden türetilir (`src/index.css`:
// kenar çubuğu #182026, `data-table`, `status-badge` tonları, 8px yarıçap).
import { useEffect, useState, type ComponentType } from 'react'
import {
  Activity,
  ArrowRight,
  Boxes,
  Building2,
  Check,
  CircleAlert,
  CircleStop,
  ClipboardList,
  KeyRound,
  LayoutDashboard,
  MousePointerClick,
  PackageSearch,
  Plug,
  Printer,
  RefreshCw,
  Route,
  Tag,
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
  LANDING_WORKFLOW,
  type IntegrationStatus,
  type LandingIntegration,
} from './landingContent'
import './landing.css'

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>

const ICONS: Record<string, IconComponent> = {
  orders: ClipboardList,
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
  { href: '#guvenilirlik', label: 'Güvenilirlik' },
] as const

/* ═══ ÜRÜN SAHNESİ — uygulamadaki Siparişler ekranının minyatürü ═════════ */

type Tone = 'success' | 'info' | 'warning' | 'label' | 'error' | 'neutral'

const SCENE_NAV = [
  { icon: LayoutDashboard, label: 'Dashboard' },
  { icon: ClipboardList, label: 'Siparişler', active: true },
  { icon: PackageSearch, label: 'Ürünler' },
  { icon: Truck, label: 'Kargo İşlemleri' },
  { icon: Tag, label: 'Etiket Şablonları' },
  { icon: Plug, label: 'Entegrasyonlar' },
] as const

const SCENE_TABS = [
  { label: 'Tümü', count: 24, active: true },
  { label: 'Barkod Bekliyor', count: 3 },
  { label: 'Etiket Hazır', count: 6 },
  { label: 'Etiket Basıldı', count: 9, hideSm: true },
] as const

const SCENE_ROWS: ReadonlyArray<{
  label: string
  ref: string
  carrier: string | null
  desi: string
  status: string
  tone: Tone
  selected?: boolean
}> = [
  { label: 'Örnek sipariş A', ref: '#1042', carrier: 'Sürat Kargo', desi: '2', status: 'Etiket Hazır', tone: 'label', selected: true },
  { label: 'Örnek sipariş B', ref: '#1041', carrier: 'Sürat Kargo', desi: '1', status: 'Etiket Basıldı', tone: 'info' },
  { label: 'Örnek sipariş C', ref: '#1039', carrier: 'Sürat Kargo', desi: '3', status: 'Kargoya Verildi', tone: 'success' },
  { label: 'Örnek sipariş D', ref: '#1037', carrier: null, desi: '2', status: 'Kontrol Gerekli', tone: 'error' },
  { label: 'Örnek sipariş E', ref: '#1036', carrier: 'Sürat Kargo', desi: '1', status: 'Barkod Bekliyor', tone: 'warning' },
]

function SceneBadge({ tone, children }: { tone: Tone; children: string }) {
  return <i className={`landing-pill tone-${tone}`}>{children}</i>
}

function MiniLabel({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'landing-mini-label is-compact' : 'landing-mini-label'}>
      <div className="landing-mini-label-head">
        <b>SÜRAT KARGO</b>
        <span>100×100</span>
      </div>
      <div className="landing-scene-barcode" />
      <dl>
        <div>
          <dt>Alıcı</dt>
          <dd>Örnek alıcı</dd>
        </div>
        <div>
          <dt>Desi</dt>
          <dd>2</dd>
        </div>
      </dl>
    </div>
  )
}

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
        <div className="landing-scene-app">
          <div className="landing-scene-sidebar">
            <div className="landing-scene-brand">
              <img src="/favicon.png" alt="" width={22} height={22} />
              <span>
                <b>CargoFlow</b>
                <small>Operasyon paneli</small>
              </span>
            </div>
            <div className="landing-scene-nav">
              {SCENE_NAV.map((item) => (
                <div key={item.label} className={'active' in item ? 'is-active' : undefined}>
                  <item.icon size={13} strokeWidth={2} aria-hidden />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="landing-scene-main">
            <div className="landing-scene-header">
              <div>
                <b>Siparişler</b>
                <small>Pazaryeri siparişleri ve gönderi durumu</small>
              </div>
              <span className="landing-scene-actions">
                <i className="landing-scene-btn">
                  <RefreshCw size={11} strokeWidth={2.2} aria-hidden />
                  Senkronize Et
                </i>
                <i className="landing-scene-btn is-primary">
                  <Printer size={11} strokeWidth={2.2} aria-hidden />
                  Etiket Oluştur
                </i>
              </span>
            </div>
            <div className="landing-scene-tabs">
              {SCENE_TABS.map((tab) => (
                <span
                  key={tab.label}
                  className={'active' in tab ? 'is-active' : 'hideSm' in tab ? 'landing-hide-sm' : undefined}
                >
                  {tab.label}
                  <em>{tab.count}</em>
                </span>
              ))}
            </div>
            <div className="landing-scene-table">
              <div className="landing-scene-head">
                <span className="landing-hide-sm" />
                <span>Sipariş</span>
                <span className="landing-hide-sm">Kanal</span>
                <span>Kargo</span>
                <span className="landing-hide-sm">Desi</span>
                <span>Durum</span>
              </div>
              {SCENE_ROWS.map((row) => (
                <div key={row.label} className={row.selected ? 'landing-scene-row is-selected' : 'landing-scene-row'}>
                  <span
                    className={
                      row.selected ? 'landing-scene-check is-on landing-hide-sm' : 'landing-scene-check landing-hide-sm'
                    }
                  />
                  <span className="landing-scene-order">
                    <b>{row.label}</b>
                    <small>{row.ref}</small>
                  </span>
                  <span className="landing-hide-sm">
                    <i className="landing-badge landing-badge-market">Trendyol</i>
                  </span>
                  <span>
                    {row.carrier ? (
                      <i className="landing-badge landing-badge-carrier">{row.carrier}</i>
                    ) : (
                      <i className="landing-badge landing-badge-empty">Atanmadı</i>
                    )}
                  </span>
                  <span className="landing-scene-num landing-hide-sm">{row.desi}</span>
                  <span>
                    <SceneBadge tone={row.tone}>{row.status}</SceneBadge>
                  </span>
                </div>
              ))}
            </div>
            <div className="landing-scene-foot">24 siparişten 5'i gösteriliyor</div>
          </div>
        </div>
        <div className="landing-scene-float landing-scene-health">
          <small className="landing-caps">Bağlantı sağlığı</small>
          <p>
            <i className="landing-dot">Trendyol</i>
            <em>Senkron 2 dk önce</em>
          </p>
          <p>
            <i className="landing-dot">Sürat Kargo</i>
            <em>Bağlı</em>
          </p>
        </div>
        <div className="landing-scene-float landing-scene-label">
          <small className="landing-caps">Etiket önizleme</small>
          <MiniLabel compact />
        </div>
      </div>
      <figcaption>Temsili ekran · örnek veriler</figcaption>
    </figure>
  )
}

/* ═══ AKIŞ — her aşama kendi küçük arayüz parçasıyla ═══════════════════ */

function WorkflowVisual({ stage }: { stage: number }) {
  if (stage === 0) {
    return (
      <div className="landing-flow-visual" aria-hidden="true">
        <div className="landing-flow-row">
          <i className="landing-badge landing-badge-market">Trendyol</i>
          <span>Örnek sipariş A</span>
          <SceneBadge tone="info">Sipariş Oluştu</SceneBadge>
        </div>
        <div className="landing-flow-row">
          <i className="landing-badge landing-badge-market">Trendyol</i>
          <span>Örnek sipariş B</span>
          <SceneBadge tone="warning">Hazırlanıyor</SceneBadge>
        </div>
      </div>
    )
  }
  if (stage === 1) {
    return (
      <ul className="landing-flow-visual landing-flow-checks" aria-hidden="true">
        <li>
          <Check size={13} strokeWidth={2.6} aria-hidden />
          Kargo ataması <b>Sürat Kargo</b>
        </li>
        <li>
          <Check size={13} strokeWidth={2.6} aria-hidden />
          Desi <b>2</b>
        </li>
        <li>
          <Check size={13} strokeWidth={2.6} aria-hidden />
          Alıcı bilgisi <b>Tamam</b>
        </li>
      </ul>
    )
  }
  if (stage === 2) {
    return (
      <div className="landing-flow-visual landing-flow-label" aria-hidden="true">
        <MiniLabel compact />
        <SceneBadge tone="label">Etiket Hazır</SceneBadge>
      </div>
    )
  }
  return (
    <div className="landing-flow-visual" aria-hidden="true">
      <div className="landing-flow-row">
        <i className="landing-dot">Trendyol hesabı</i>
        <em>Sağlıklı</em>
      </div>
      <div className="landing-flow-row">
        <i className="landing-dot">Sürat Kargo</i>
        <em>Bağlı</em>
      </div>
    </div>
  )
}

/* ═══ ÜRÜN VİTRİNİ — gerçek ekranlardan türetilmiş iki panel ═══════════ */

function LabelEditorShowcase() {
  return (
    <div className="landing-showcase-ui landing-editor" aria-hidden="true">
      <div className="landing-editor-canvas">
        <MiniLabel />
      </div>
      <div className="landing-editor-panel">
        <small className="landing-caps">Seçili alan</small>
        <p>
          <span>Alan</span>
          <b>Alıcı adı</b>
        </p>
        <p>
          <span>Yazı boyutu</span>
          <b>12 pt</b>
        </p>
        <p>
          <span>Barkod</span>
          <b>Code 128</b>
        </p>
        <i className="landing-scene-btn is-primary">
          <Printer size={11} strokeWidth={2.2} aria-hidden />
          Tekrar Yazdır
        </i>
      </div>
    </div>
  )
}

function HealthShowcase() {
  const rows: ReadonlyArray<{ name: string; detail: string; status: string; tone: Tone }> = [
    { name: 'Trendyol · Mağaza 1', detail: 'Son senkron 2 dk önce', status: 'Sağlıklı', tone: 'success' },
    { name: 'Trendyol · Mağaza 2', detail: 'Bağlantı bilgisi eksik', status: 'Kontrol Gerekli', tone: 'warning' },
    { name: 'Sürat Kargo', detail: 'Gönderi ve etiket', status: 'Bağlı', tone: 'success' },
  ]
  return (
    <div className="landing-showcase-ui landing-health" aria-hidden="true">
      <div className="landing-health-head landing-caps">
        <span>Hesap</span>
        <span>Durum</span>
      </div>
      {rows.map((row) => (
        <div key={row.name} className="landing-health-row">
          <span>
            <b>{row.name}</b>
            <small>{row.detail}</small>
          </span>
          <SceneBadge tone={row.tone}>{row.status}</SceneBadge>
        </div>
      ))}
    </div>
  )
}

/* ═══ ENTEGRASYONLAR ═══════════════════════════════════════════════════ */

function IntegrationGroup({ title, items }: { title: string; items: readonly LandingIntegration[] }) {
  return (
    <div className="landing-integration-group">
      <h3 className="landing-caps">{title}</h3>
      <ul>
        {items.map((integration) => (
          <li key={integration.name} data-integration={integration.name} data-status={integration.status}>
            <span className="landing-monogram" aria-hidden="true">
              {integration.name.charAt(0).toUpperCase()}
            </span>
            <span className="landing-integration-name">
              <strong>{integration.name}</strong>
              <small>{integration.kind}</small>
            </span>
            <span className={`landing-status tone-${STATUS_TONE[integration.status]}`}>
              {INTEGRATION_STATUS_LABEL[integration.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const STATUS_ORDER: readonly IntegrationStatus[] = ['live', 'internal_test', 'in_development']

/** Durum rozeti uygulamadaki `status-badge` tonlarını kullanır. */
const STATUS_TONE: Record<IntegrationStatus, Tone> = {
  live: 'success',
  internal_test: 'warning',
  in_development: 'neutral',
}

/* ═══ SAYFA ════════════════════════════════════════════════════════════ */

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    document.title = LANDING_TITLE
    // Yalnız bu sayfaya ait gövde sınıfı; uygulama sayfalarına sızmaz.
    document.body.classList.add('landing-body')
    return () => document.body.classList.remove('landing-body')
  }, [])

  const year = new Date().getFullYear()
  const lastLine = LANDING_HERO.headlineLines.length - 1

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
              <h1 id="landing-title">
                {LANDING_HERO.headlineLines.map((line, index) => (
                  <span key={line}>{index < lastLine ? `${line} ` : line}</span>
                ))}
              </h1>
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
              <p className="landing-hero-note">Hesaplar organizasyon yöneticisi tarafından oluşturulur.</p>
            </div>
            <ProductScene />
          </div>
        </section>

        <section id="nasil-calisir" className="landing-section" aria-labelledby="workflow-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="landing-kicker">Akış</p>
              <h2 id="workflow-title">Nasıl çalışır?</h2>
              <p className="landing-section-lead">
                Sipariş, kargo, etiket ve takip aynı akışın parçaları. Her adım bir öncekinin
                doğrulanmış verisiyle başlar.
              </p>
            </div>
            <ol className="landing-workflow">
              {LANDING_WORKFLOW.map((step, index) => (
                <li key={step.stage}>
                  <span className="landing-step-index">
                    <b aria-hidden="true">{String(index + 1).padStart(2, '0')}</b>
                    {step.stage}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  <WorkflowVisual stage={index} />
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="urun" className="landing-section landing-section-muted" aria-labelledby="product-title">
          <div className="landing-container">
            <div className="landing-section-head is-wide">
              <p className="landing-kicker">Ürün</p>
              <h2 id="product-title">
                Operasyonu tek panelden yönetin.{' '}
                <span className="landing-h2-muted">Her ekran aynı organizasyon verisiyle çalışır.</span>
              </h2>
            </div>
            <div className="landing-showcase">
              <article className="landing-showcase-card">
                <div className="landing-showcase-copy">
                  <h3>Etiket şablonu ve baskı</h3>
                  <p>
                    Etiket yerleşimini gerçek sipariş verisiyle düzenleyin. Oluşan etiket saklanır;
                    tekrar yazdırmak için gönderi yeniden oluşturulmaz.
                  </p>
                </div>
                <LabelEditorShowcase />
              </article>
              <article className="landing-showcase-card">
                <div className="landing-showcase-copy">
                  <h3>Hesap bazında bağlantı sağlığı</h3>
                  <p>
                    Her mağaza ve kargo hesabının son senkronu ve bağlantı bilgisi ayrı izlenir.
                  </p>
                </div>
                <HealthShowcase />
              </article>
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

        <section id="entegrasyonlar" className="landing-section" aria-labelledby="integrations-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="landing-kicker">Entegrasyonlar</p>
              <h2 id="integrations-title">Desteklenen ve geliştirilmekte olan entegrasyon altyapısı</h2>
              <p className="landing-section-lead">
                Canlı bağlantılar ile test ve geliştirme aşamasındaki bağlantılar ayrı gösterilir. Bir
                entegrasyon, canlı sipariş ve gönderi akışına ancak doğrulandıktan sonra açılır.
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
                    <span className={`landing-status tone-${STATUS_TONE[status]}`}>{INTEGRATION_STATUS_LABEL[status]}</span>
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

        <section id="guvenilirlik" className="landing-section landing-section-dark" aria-labelledby="control-title">
          <div className="landing-container landing-trust">
            <div className="landing-trust-intro">
              <p className="landing-kicker">Güvenilirlik</p>
              <h2 id="control-title">Operasyon kontrolü sizde</h2>
              <p className="landing-section-lead">
                CargoFlow emin olmadığı bir işlemi yapmak yerine durur ve sebebini gösterir.
              </p>
              <div className="landing-guard" aria-hidden="true">
                <div className="landing-guard-head">
                  <CircleAlert size={15} strokeWidth={2.2} aria-hidden />
                  <b>Gönderi oluşturulmadı</b>
                  <SceneBadge tone="error">Kontrol Gerekli</SceneBadge>
                </div>
                <p>Örnek sipariş D için kargo ataması belirsiz. Atama netleştiğinde gönderiyi yeniden başlatın.</p>
              </div>
            </div>
            <ul className="landing-control">
              {LANDING_CONTROL_POINTS.map((point) => (
                <li key={point.title}>
                  <FeatureIcon name={point.icon} />
                  <div>
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="final-title">
          <div className="landing-container">
            <div className="landing-final-panel">
              <div>
                <h2 id="final-title">E-ticaret operasyonunuzu tek panelde yönetin.</h2>
                <p>Hesabınız organizasyon yöneticiniz tarafından oluşturulur. Giriş bilgilerinizle panele geçin.</p>
              </div>
              <a className="landing-cta" href={APP_ENTRY_PATH} data-cta="primary-final">
                Panele Gir
                <ArrowRight size={17} strokeWidth={2} aria-hidden />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <div className="landing-footer-brand">
            <span>
              <img src="/favicon.png" alt="" width={24} height={24} />
              CargoFlow
            </span>
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
