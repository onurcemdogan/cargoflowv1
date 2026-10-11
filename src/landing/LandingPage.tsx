// HERKESE AÇIK TANITIM SAYFASI (/).
//
// AuthProvider DIŞINDADIR: açılışı `/api/auth/me`, onboarding, entegrasyon
// veya sağlayıcı çağrısı YAPMAZ; kimlik arka ucu erişilemezken de çalışır.
// Ürün sahneleri TEMSİLİDİR: tüm sipariş, kişi ve adresler örnek veridir.
//
// Tasarım sistemi: siyah zemin + açık geçiş bölümleri, iki tonlu büyük
// başlıklar, hap butonlar, beyaz ürün kartları, tek easing ile reveal ve
// durum değiştiren ürün sahneleri (bkz. `landingMotion.ts`).
import { useEffect, useRef, useState, type ComponentType } from 'react'
import {
  Activity,
  BarChart3,
  Boxes,
  ChevronRight,
  ClipboardList,
  Compass,
  Menu,
  Plug,
  Plus,
  Printer,
  Route,
  ScanBarcode,
  Store,
  Tag,
  Truck,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react'
import { APP_ENTRY_PATH, LANDING_TITLE } from '../entryRoute'
import {
  INTEGRATION_STATUS_HELP,
  INTEGRATION_STATUS_LABEL,
  LANDING_CAPABILITIES,
  LANDING_FAQ,
  LANDING_FEATURES,
  LANDING_GUARD,
  LANDING_HERO,
  LANDING_HIGHLIGHTS,
  LANDING_INTEGRATIONS,
  LANDING_STATEMENT,
  LANDING_WORKFLOW,
  type IntegrationStatus,
} from './landingContent'
import { useRevealRoot, useScrollWords } from './landingMotion'
import { FeatureScene, GuardScene, HeroScene, IntegrationHub } from './landingScenes'
import './landing.css'

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>

const ICONS: Record<string, IconComponent> = {
  orders: ClipboardList,
  truck: Truck,
  barcode: ScanBarcode,
  template: Tag,
  route: Route,
  health: Activity,
  plug: Plug,
  chart: BarChart3,
  catalog: Boxes,
  wizard: WandSparkles,
  tour: Compass,
  auto: Zap,
  printer: Printer,
  stores: Store,
}

function FeatureIcon({ name }: { name: string }) {
  const Icon = ICONS[name] ?? Boxes
  return (
    <span className="landing-icon" aria-hidden="true">
      <Icon size={20} strokeWidth={1.7} aria-hidden />
    </span>
  )
}

const NAV_LINKS = [
  { href: '#urun', label: 'Ürün' },
  { href: '#nasil-calisir', label: 'Nasıl Çalışır' },
  { href: '#entegrasyonlar', label: 'Entegrasyonlar' },
  { href: '#guvenilirlik', label: 'Güvenilirlik' },
] as const

/** Modül kartlarının GERÇEK hedefleri (sayfa içi bölüm ya da panel). */
const CAPABILITY_TARGETS: Record<string, string> = {
  Siparişler: '#siparisler',
  'Kargo İşlemleri': '#kargo',
  'Etiket Oluşturma': '#etiket',
  'Etiket Şablonları': '#sablonlar',
  'Gönderi Takibi': '#takip',
  'Bağlantı Sağlığı': '#saglik',
  Entegrasyonlar: '#entegrasyonlar',
  Dashboard: APP_ENTRY_PATH,
  Katalog: APP_ENTRY_PATH,
}

const FOOTER_COLUMNS = [
  {
    title: 'Ürün',
    links: [
      { href: '#siparisler', label: 'Siparişler' },
      { href: '#kargo', label: 'Kargo İşlemleri' },
      { href: '#etiket', label: 'Barkod ve Etiket' },
      { href: '#sablonlar', label: 'Etiket Şablonları' },
      { href: '#takip', label: 'Takip' },
      { href: '#saglik', label: 'Bağlantı Sağlığı' },
    ],
  },
  {
    title: 'Platform',
    links: [
      { href: '#nasil-calisir', label: 'Nasıl Çalışır' },
      { href: '#entegrasyonlar', label: 'Entegrasyonlar' },
      { href: '#guvenilirlik', label: 'Güvenilirlik' },
      { href: '#sorular', label: 'Sorular ve cevaplar' },
    ],
  },
  {
    title: 'Hesap',
    links: [
      { href: APP_ENTRY_PATH, label: 'Panele Gir' },
      { href: APP_ENTRY_PATH, label: 'Giriş Yap' },
    ],
  },
] as const

const STATUS_TONE: Record<IntegrationStatus, string> = {
  live: 'success',
  internal_test: 'warning',
  in_development: 'neutral',
}
const STATUS_ORDER: readonly IntegrationStatus[] = ['live', 'internal_test', 'in_development']

function TwoTone({ strong, soft }: { strong: string; soft: string }) {
  return (
    <>
      {strong} <span className="landing-soft">{soft}</span>
    </>
  )
}

function Statement() {
  const words = LANDING_STATEMENT.split(' ')
  const [ref, lit] = useScrollWords<HTMLParagraphElement>(words.length)
  return (
    <p className="landing-statement" ref={ref}>
      {words.map((word, index) => (
        <span key={`${word}-${index}`} className={index < lit ? 'is-lit' : undefined}>
          {word}{' '}
        </span>
      ))}
    </p>
  )
}

function FaqItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(index === 0)
  const id = `landing-faq-${index}`
  return (
    <div className={open ? 'landing-faq-item is-open' : 'landing-faq-item'}>
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
          {q}
          <Plus size={20} strokeWidth={1.8} aria-hidden />
        </button>
      </h3>
      <div className="landing-faq-answer" id={id} role="region" aria-hidden={!open}>
        <div>
          <p>{a}</p>
        </div>
      </div>
    </div>
  )
}

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useRevealRoot(rootRef)

  useEffect(() => {
    document.title = LANDING_TITLE
    // Yalnız bu sayfaya ait gövde sınıfı; uygulama sayfalarına sızmaz.
    document.body.classList.add('landing-body')
    return () => document.body.classList.remove('landing-body')
  }, [])

  const year = new Date().getFullYear()

  return (
    <div className="landing-root" ref={rootRef}>
      <header className="landing-header">
        <div className="landing-container landing-header-inner">
          <a className="landing-brand" href="/" aria-label="CargoFlow ana sayfa">
            <img src="/favicon.png" alt="" width={26} height={26} />
            <span>CargoFlow</span>
          </a>
          <button
            type="button"
            className="landing-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="landing-nav"
            aria-label={menuOpen ? 'Menüyü kapat' : 'Menü'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={22} strokeWidth={1.8} aria-hidden /> : <Menu size={22} strokeWidth={1.8} aria-hidden />}
          </button>
          <nav
            id="landing-nav"
            className={menuOpen ? 'landing-nav is-open' : 'landing-nav'}
            aria-label="Sayfa bölümleri"
          >
            <div className="landing-nav-links">
              {NAV_LINKS.map((link) => (
                <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
                  {link.label}
                </a>
              ))}
            </div>
            <div className="landing-nav-actions">
              <a className="landing-nav-login" href={APP_ENTRY_PATH}>
                Giriş Yap
              </a>
              <a className="landing-btn landing-btn-blue landing-btn-sm" href={APP_ENTRY_PATH} data-cta="primary-nav">
                Panele Gir
              </a>
            </div>
          </nav>
        </div>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-container landing-hero-copy">
            <p className="landing-eyebrow landing-reveal">{LANDING_HERO.eyebrow}</p>
            <h1 id="landing-title" className="landing-display landing-reveal">
              <TwoTone strong={LANDING_HERO.headlineStrong} soft={LANDING_HERO.headlineSoft} />
            </h1>
            <p className="landing-lead landing-reveal d1">{LANDING_HERO.body}</p>
            <div className="landing-actions landing-reveal d2">
              <a className="landing-btn landing-btn-blue" href={APP_ENTRY_PATH} data-cta="primary">
                Panele Gir
              </a>
              <a className="landing-btn landing-btn-ghost" href="#urun" data-cta="secondary">
                Ürünü Keşfet
              </a>
            </div>
            <p className="landing-note landing-reveal d2">{LANDING_HERO.note}</p>
          </div>
          <div className="landing-container landing-hero-stage">
            <HeroScene />
          </div>
        </section>

        <section id="nasil-calisir" className="landing-section landing-how" aria-labelledby="workflow-title">
          <div className="landing-container">
            <h2 id="workflow-title" className="landing-eyebrow landing-reveal">
              Nasıl çalışır?
            </h2>
            <Statement />
            <ol className="landing-steps">
              {LANDING_WORKFLOW.map((step, index) => (
                <li key={step.stage} className="landing-reveal" style={{ transitionDelay: `${index * 90}ms` }}>
                  <span className="landing-step-num">{String(index + 1).padStart(2, '0')}</span>
                  <b>{step.stage}</b>
                  <span>{step.title}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="urun" className="landing-product" aria-labelledby="product-title">
          <h2 id="product-title" className="landing-sr-only">
            Ürün
          </h2>
          {LANDING_FEATURES.map((feature, index) => (
            <article
              key={feature.id}
              id={feature.id}
              className={index % 2 === 1 ? 'landing-feature is-flip' : 'landing-feature'}
              aria-labelledby={`${feature.id}-title`}
            >
              <div className="landing-container landing-feature-grid">
                <div className="landing-feature-copy">
                  <p className="landing-eyebrow landing-reveal">{feature.eyebrow}</p>
                  <h3 id={`${feature.id}-title`} className="landing-h2 landing-reveal">
                    <TwoTone strong={feature.strong} soft={feature.soft} />
                  </h3>
                  <p className="landing-lead landing-reveal d1">{feature.body}</p>
                  <ul className="landing-chips landing-reveal d1">
                    {feature.chips.map((chip) => (
                      <li key={chip}>{chip}</li>
                    ))}
                  </ul>
                  <a className="landing-more landing-reveal d2" href={APP_ENTRY_PATH}>
                    Panelde görün
                    <ChevronRight size={18} strokeWidth={2} aria-hidden />
                  </a>
                </div>
                <FeatureScene scene={feature.scene} />
              </div>
            </article>
          ))}
        </section>

        <section id="guvenilirlik" className="landing-feature landing-guard-section" aria-labelledby="control-title">
          <div className="landing-container landing-feature-grid">
            <div className="landing-feature-copy">
              <p className="landing-eyebrow landing-reveal">{LANDING_GUARD.eyebrow}</p>
              <h2 id="control-title" className="landing-h2 landing-reveal">
                <TwoTone strong={LANDING_GUARD.strong} soft={LANDING_GUARD.soft} />
              </h2>
              <p className="landing-lead landing-reveal d1">{LANDING_GUARD.body}</p>
              <ul className="landing-chips landing-reveal d1">
                {LANDING_GUARD.chips.map((chip) => (
                  <li key={chip}>{chip}</li>
                ))}
              </ul>
            </div>
            <GuardScene />
          </div>
        </section>

        <section className="landing-section landing-highlights" aria-labelledby="highlights-title">
          <div className="landing-container">
            <div className="landing-center-head">
              <p className="landing-eyebrow landing-reveal">Panelde</p>
              <h2 id="highlights-title" className="landing-h2 landing-reveal">
                <TwoTone strong="Küçük ayrıntılar." soft="Her gün işinizde." />
              </h2>
            </div>
            <ul className="landing-dark-cards">
              {LANDING_HIGHLIGHTS.map((item, index) => (
                <li key={item.title} className="landing-reveal" style={{ transitionDelay: `${(index % 3) * 80}ms` }}>
                  <FeatureIcon name={item.icon} />
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-section landing-light" aria-labelledby="modules-title">
          <div className="landing-container">
            <div className="landing-center-head">
              <h2 id="modules-title" className="landing-h2 landing-reveal">
                <TwoTone strong="Dört adım." soft="Tek ürün." />
              </h2>
              <p className="landing-lead landing-reveal d1">
                Her modül aynı organizasyon verisiyle çalışır; aynı siparişi her ekranda aynı bilgiyle görürsünüz.
              </p>
            </div>
            <ul className="landing-capabilities">
              {LANDING_CAPABILITIES.map((capability, index) => (
                <li
                  key={capability.title}
                  data-capability={capability.title}
                  className="landing-reveal"
                  style={{ transitionDelay: `${(index % 3) * 80}ms` }}
                >
                  <a href={CAPABILITY_TARGETS[capability.title] ?? APP_ENTRY_PATH}>
                    <FeatureIcon name={capability.icon} />
                    <ChevronRight className="landing-card-arrow" size={18} strokeWidth={1.8} aria-hidden />
                    <h3>{capability.title}</h3>
                    <p>{capability.body}</p>
                  </a>
                </li>
              ))}
            </ul>
            <p className="landing-upcoming">
              <span>Geliştiriliyor:</span>
              {LANDING_INTEGRATIONS.filter((item) => item.status === 'in_development').map((item) => (
                <i key={item.name} data-integration={item.name} data-status={item.status}>
                  {item.name}
                </i>
              ))}
            </p>
          </div>
        </section>

        <section
          id="entegrasyonlar"
          className="landing-section landing-integrations-section"
          aria-labelledby="integrations-title"
        >
          <div className="landing-container">
            <div className="landing-center-head">
              <p className="landing-eyebrow landing-reveal">Entegrasyonlar</p>
              <h2 id="integrations-title" className="landing-h2 landing-reveal">
                <TwoTone strong="Bağlantılar." soft="Gerçek durumlarıyla." />
              </h2>
              <p className="landing-lead landing-reveal d1">
                Desteklenen ve geliştirilmekte olan entegrasyon altyapısı. Bir entegrasyon, canlı sipariş ve gönderi
                akışına ancak doğrulandıktan sonra açılır.
              </p>
            </div>
            <div className="landing-integrations" data-testid="landing-integrations">
              <IntegrationHub />
              <div className="landing-status-columns">
                {STATUS_ORDER.map((status) => (
                  <div key={status} className="landing-status-column landing-reveal">
                    <h3>
                      <span className={`landing-status tone-${STATUS_TONE[status]}`}>
                        {INTEGRATION_STATUS_LABEL[status]}
                      </span>
                    </h3>
                    <p>{INTEGRATION_STATUS_HELP[status]}</p>
                    <ul>
                      {LANDING_INTEGRATIONS.filter((item) => item.status === status).map((integration) => (
                        <li key={integration.name} data-integration={integration.name} data-status={integration.status}>
                          <span className="landing-source-mark is-small" aria-hidden="true">
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
                ))}
              </div>
            </div>
            <p className="landing-fineprint">
              Markalar ilgili sahiplerine aittir; listelenmeleri bir iş birliği anlamına gelmez.
            </p>
          </div>
        </section>

        <section id="sorular" className="landing-section landing-light landing-faq" aria-labelledby="faq-title">
          <div className="landing-container">
            <h2 id="faq-title" className="landing-h2 landing-center-title landing-reveal">
              Sorular ve cevaplar.
            </h2>
            <div className="landing-faq-list">
              {LANDING_FAQ.map((item, index) => (
                <FaqItem key={item.q} q={item.q} a={item.a} index={index} />
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section landing-final" aria-labelledby="final-title">
          <div className="landing-container landing-center-head">
            <h2 id="final-title" className="landing-final-title landing-reveal">
              <TwoTone strong="Kargo operasyonunuzu" soft="tek akışta yönetin." />
            </h2>
            <div className="landing-actions landing-reveal d1">
              <a className="landing-btn landing-btn-blue" href={APP_ENTRY_PATH} data-cta="primary-final">
                Panele Gir
              </a>
              <a className="landing-btn landing-btn-ghost" href="#nasil-calisir">
                Nasıl Çalışır?
              </a>
            </div>
            <p className="landing-note landing-reveal d2">{LANDING_HERO.note}</p>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-grid">
          <div className="landing-footer-brand">
            <a className="landing-brand" href="/" aria-label="CargoFlow ana sayfa">
              <img src="/favicon.png" alt="" width={26} height={26} />
              <span>CargoFlow</span>
            </a>
            <p>E-ticaret sipariş, kargo, barkod ve etiket operasyonu için tek panel.</p>
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <nav key={column.title} className="landing-footer-col" aria-label={column.title}>
              <h3>{column.title}</h3>
              {column.links.map((link) => (
                <a key={link.label} href={link.href}>
                  {link.label}
                </a>
              ))}
            </nav>
          ))}
        </div>
        <div className="landing-container landing-footer-bottom">
          <span>© {year} CargoFlow · ONRSOFT</span>
          <span className="landing-footer-status">
            <i />
            Trendyol ve Sürat Kargo canlı
          </span>
        </div>
      </footer>
    </div>
  )
}
