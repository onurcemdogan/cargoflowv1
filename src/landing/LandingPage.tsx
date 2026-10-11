// HERKESE AÇIK TANITIM SAYFASI (/).
//
// AuthProvider DIŞINDADIR: açılışı `/api/auth/me`, onboarding, entegrasyon
// veya sağlayıcı çağrısı YAPMAZ; kimlik arka ucu erişilemezken de çalışır.
// Ürün sahnesi TEMSİLİDİR: gerçek müşteri/sipariş/telefon/adres içermez.
import { useEffect, useState } from 'react'
import { APP_ENTRY_PATH, LANDING_TITLE } from '../entryRoute'
import {
  LANDING_CAPABILITIES,
  LANDING_CONTROL_POINTS,
  LANDING_HERO,
  LANDING_INTEGRATIONS,
  LANDING_WORKFLOW,
} from './landingContent'
import './landing.css'

const NAV_LINKS = [
  { href: '#nasil-calisir', label: 'Nasıl Çalışır?' },
  { href: '#ozellikler', label: 'Özellikler' },
  { href: '#entegrasyonlar', label: 'Entegrasyonlar' },
] as const

/** Temsili sahne — açıkça örnek veriler (gerçek kayıt DEĞİL). */
const SCENE_ROWS = [
  { label: 'Örnek sipariş A', status: 'Etiket hazır', tone: 'ok' },
  { label: 'Örnek sipariş B', status: 'Gönderi oluşturuldu', tone: 'info' },
  { label: 'Örnek sipariş C', status: 'Hazırlanıyor', tone: 'warn' },
  { label: 'Örnek sipariş D', status: 'Kargoda', tone: 'muted' },
] as const

function ProductScene() {
  return (
    <figure className="landing-scene">
      <div className="landing-scene-window" aria-hidden="true">
        <div className="landing-scene-chrome">
          <span />
          <span />
          <span />
          <b>CargoFlow · Operasyon Paneli</b>
        </div>
        <div className="landing-scene-body">
          <div className="landing-scene-nav">
            <i className="is-active" />
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="landing-scene-main">
            <div className="landing-scene-kpis">
              <div>
                <small>Bekleyen</small>
                <strong>—</strong>
              </div>
              <div>
                <small>Etiket hazır</small>
                <strong>—</strong>
              </div>
              <div>
                <small>Kargoda</small>
                <strong>—</strong>
              </div>
            </div>
            <ul className="landing-scene-rows">
              {SCENE_ROWS.map((row) => (
                <li key={row.label}>
                  <span className="landing-scene-check" />
                  <span className="landing-scene-name">{row.label}</span>
                  <span className={`landing-scene-chip tone-${row.tone}`}>{row.status}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="landing-scene-label">
            <small>Örnek etiket</small>
            <div className="landing-scene-barcode" />
            <span>Önizleme · 100×100</span>
          </div>
        </div>
      </div>
      <figcaption>Temsili ekran · örnek veriler</figcaption>
    </figure>
  )
}

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
            <img src="/favicon.png" alt="" width={32} height={32} />
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
                </a>
                <a className="landing-cta-secondary" href="#nasil-calisir">
                  Nasıl çalışır?
                </a>
              </div>
              <p className="landing-hero-note">
                Hesaplar organizasyon yöneticisi tarafından oluşturulur.
              </p>
            </div>
            <ProductScene />
          </div>
        </section>

        <section id="nasil-calisir" className="landing-section" aria-labelledby="workflow-title">
          <div className="landing-container">
            <p className="landing-kicker">Akış</p>
            <h2 id="workflow-title">Nasıl çalışır?</h2>
            <ol className="landing-workflow">
              {LANDING_WORKFLOW.map((step, index) => (
                <li key={step.title}>
                  <span className="landing-step-index" aria-hidden="true">
                    {index + 1}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="ozellikler"
          className="landing-section landing-section-muted"
          aria-labelledby="capabilities-title"
        >
          <div className="landing-container">
            <p className="landing-kicker">Özellikler</p>
            <h2 id="capabilities-title">Operasyonun her adımı tek panelde</h2>
            <ul className="landing-capabilities">
              {LANDING_CAPABILITIES.map((capability) => (
                <li key={capability.title} data-capability={capability.title}>
                  <h3>{capability.title}</h3>
                  <p>{capability.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="entegrasyonlar" className="landing-section" aria-labelledby="integrations-title">
          <div className="landing-container">
            <p className="landing-kicker">Entegrasyonlar</p>
            <h2 id="integrations-title">Şu anda desteklenen entegrasyonlar</h2>
            <ul className="landing-integrations" data-testid="landing-integrations">
              {LANDING_INTEGRATIONS.map((integration) => (
                <li key={integration.name}>
                  <strong>{integration.name}</strong>
                  <span>{integration.kind}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-section landing-section-dark" aria-labelledby="control-title">
          <div className="landing-container">
            <p className="landing-kicker">Kontrol</p>
            <h2 id="control-title">Operasyon kontrolü sizde</h2>
            <ul className="landing-control">
              {LANDING_CONTROL_POINTS.map((point) => (
                <li key={point.title}>
                  <h3>{point.title}</h3>
                  <p>{point.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="final-title">
          <div className="landing-container landing-final-inner">
            <h2 id="final-title">Operasyon panelinize geçin</h2>
            <p>Siparişleriniz, gönderileriniz ve etiketleriniz sizi panelde bekliyor.</p>
            <a className="landing-cta" href={APP_ENTRY_PATH} data-cta="primary-final">
              Panele Gir
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <span>© {year} CargoFlow · ONRSOFT</span>
          <a href={APP_ENTRY_PATH}>Panele Gir</a>
        </div>
      </footer>
    </div>
  )
}
