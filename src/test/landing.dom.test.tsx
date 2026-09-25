import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import indexHtml from '../../index.html?raw'
import organizationAppSource from '../entries/OrganizationApp.tsx?raw'
import appSource from '../App.tsx?raw'
import { EntryRoot } from '../EntryRoot'
import { APP_ENTRY_PATH, APP_TITLE, LANDING_TITLE, resolveEntryRoute } from '../entryRoute'
import { LandingPage } from '../landing/LandingPage'
import { LANDING_CAPABILITIES, LANDING_INTEGRATIONS } from '../landing/landingContent'
import { integrationConfigService } from '../services/appServices'

// ═══ LANDING-001 — GERÇEK DOM KABULÜ ═════════════════════════════════════
//
// Giriş kökü (`EntryRoot`) GERÇEK dallarla sınanır: `/` tanıtım, `/app`
// organizasyon uygulaması (AuthProvider → AuthGate → OnboardingGate → App),
// `/admin*` yönetici kabuğu. Ağ çağrıları `fetch` casusuyla SAYILIR.

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown }
let responder: Responder
let calls: Array<{ url: string; method: string }>

beforeEach(() => {
  calls = []
  responder = () => ({ status: 404, body: {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      const { status, body } = responder(String(url), init)
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.classList.remove('landing-body')
})

const visibleText = () => document.body.textContent ?? ''

/* ─── YOL AYRIMI ─────────────────────────────────────────────────────── */

test('LAND-ROUTE-1/4: yol tablosu — / tanıtım, /app uygulama, /admin* yönetici, diğer uygulama', () => {
  expect(resolveEntryRoute('/')).toBe('landing')
  expect(resolveEntryRoute('')).toBe('landing')
  expect(resolveEntryRoute('/index.html')).toBe('landing')
  expect(resolveEntryRoute('/app')).toBe('app')
  expect(resolveEntryRoute('/app/siparisler')).toBe('app')
  expect(resolveEntryRoute('/admin')).toBe('admin')
  expect(resolveEntryRoute('/admin/login')).toBe('admin')
  // Eskiden `/admin` dışındaki HER yol uygulamaydı — bilinmeyen yol bozulmaz.
  expect(resolveEntryRoute('/login')).toBe('app')
  expect(resolveEntryRoute('/herhangi')).toBe('app')
})

test('LAND-ROUTE-1/2 + LAND-UI-10: / tanıtımı açar; kimlik/işlem çağrısı SIFIR', async () => {
  render(<EntryRoot pathname="/" />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Siparişten kargo etiketine tek operasyon akışı.',
  )
  // AuthProvider bağlanmadı: oturum ekranı/çağrısı YOK.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  expect(calls).toEqual([])
  expect(visibleText()).not.toMatch(/Oturum kontrol ediliyor|Giriş Yap\b(?! )/)
  expect(document.title).toBe(LANDING_TITLE)
})

test('LAND-ROUTE-3 / LAND-UI-2: tüm "Panele Gir" bağlantıları /app', () => {
  render(<LandingPage />)
  const ctas = screen.getAllByRole('link', { name: 'Panele Gir' })
  expect(ctas.length).toBeGreaterThanOrEqual(3)
  for (const cta of ctas) expect(cta.getAttribute('href')).toBe(APP_ENTRY_PATH)
  expect(APP_ENTRY_PATH).toBe('/app')
  expect(document.querySelector('[data-cta="primary"]')?.getAttribute('href')).toBe('/app')
})

/* ─── /app — KİMLİK AKIŞI DEĞİŞMEDİ ──────────────────────────────────── */

const USER = { username: 'ada', organization: { id: 'org-1', name: 'Org', slug: 'org' } }

function onboarding(completed: boolean) {
  return {
    ok: true,
    completed,
    completedAt: null,
    eligibleToComplete: false,
    blockers: ['MARKETPLACE_NOT_CONFIGURED'],
    resumeStep: 'WELCOME',
    steps: [],
    marketplaces: [],
    carrier: { providerKey: 'surat', displayName: 'Sürat Kargo', configured: false, verification: 'NOT_CONFIGURED' },
    counts: { products: 0, orders: 0 },
  }
}

test('LAND-AUTH-1: /app oturumsuz → mevcut giriş ekranı', { timeout: 30_000 }, async () => {
  responder = (url) => (url.includes('/api/auth/me') ? { status: 401, body: {} } : { status: 404, body: {} })
  render(<EntryRoot pathname="/app" />)
  expect(await screen.findByRole('heading', { name: 'Giriş Yap' }, { timeout: 20_000 })).toBeTruthy()
  expect(calls.some((call) => call.url === '/api/auth/me')).toBe(true)
  await waitFor(() => expect(document.title).toBe(APP_TITLE))
})

test('LAND-AUTH-3/5: /app oturumlu + onboarding eksik → kurulum; çıkış → giriş ekranı', { timeout: 30_000 }, async () => {
  vi.spyOn(integrationConfigService, 'hydrateIntegrationConfig').mockResolvedValue(
    integrationConfigService.loadIntegrationConfig(),
  )
  let authenticated = true
  responder = (url) => {
    if (url.includes('/api/auth/me')) {
      return authenticated ? { status: 200, body: { ok: true, user: USER } } : { status: 401, body: {} }
    }
    if (url.includes('/api/auth/logout')) {
      authenticated = false
      return { status: 200, body: { ok: true } }
    }
    if (url.includes('/api/onboarding/status')) return { status: 200, body: onboarding(false) }
    return { status: 404, body: {} }
  }
  render(<EntryRoot pathname="/app" />)
  expect(await screen.findByText('CargoFlow Kurulumu', {}, { timeout: 20_000 })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }))
  expect(await screen.findByRole('heading', { name: 'Giriş Yap' }, { timeout: 20_000 })).toBeTruthy()
})

test('LAND-AUTH-2/4: /app ağacı DEĞİŞMEDİ (AuthProvider → AuthGate → OnboardingGate → App; tur App içinde)', () => {
  const tree = organizationAppSource.replace(/\s+/g, ' ')
  expect(tree).toMatch(
    /<AuthProvider> <AuthGate> <OnboardingGate> <App \/> <\/OnboardingGate> <\/AuthGate> <\/AuthProvider>/,
  )
  // Ürün turu hâlâ App içinde, onboarding SONRASI bağlanır.
  expect(appSource).toMatch(/useProductTourController\(/)
})

/* ─── /admin — DEĞİŞMEDİ ─────────────────────────────────────────────── */

test('LAND-ADMIN-1/2: /admin ve alt yolları yönetici kabuğu; organizasyon kimliği ÇAĞRILMAZ', { timeout: 30_000 }, async () => {
  for (const path of ['/admin', '/admin/login']) {
    calls = []
    responder = (url) =>
      url.includes('/api/platform-admin/me') ? { status: 401, body: {} } : { status: 404, body: {} }
    const view = render(<EntryRoot pathname={path} />)
    expect(await screen.findByRole('heading', { name: 'Platform Yönetimi' }, { timeout: 20_000 })).toBeTruthy()
    expect(calls.some((call) => call.url.includes('/api/platform-admin/me'))).toBe(true)
    expect(calls.some((call) => call.url === '/api/auth/me')).toBe(false)
    expect(screen.queryByText('Siparişten kargo etiketine tek operasyon akışı.')).toBeNull()
    view.unmount()
  }
})

/* ─── İÇERİK DOĞRULUĞU ───────────────────────────────────────────────── */

test('LAND-TRUTH-1..8: yalnız canlı entegrasyonlar; kayıt/fiyat/uydurma metrik/sertifika YOK', () => {
  render(<LandingPage />)
  const text = visibleText()
  const all = `${text}\n${indexHtml}`
  expect(text).toContain('Trendyol')
  expect(text).toContain('Sürat Kargo')
  expect(all).not.toMatch(/WooCommerce|\bikas\b|Ticimax|\bAras\b/i)
  expect(all).not.toMatch(/kayıt ol|ücretsiz başla|hesap oluştur|deneme|free trial|sign ?up/i)
  expect(all).not.toMatch(/₺|\bTL\b|fiyat|pricing|aylık|yıllık/i)
  expect(all).not.toMatch(/müşterimiz|referans|%\s?\d|\d+\s?%|\d{1,3}(\.\d{3})+\s?(müşteri|sipariş|kullanıcı)|yıldız|puan/i)
  expect(all).not.toMatch(/ISO\s?27001|SOC\s?2|KVKK|PCI|banka düzeyinde|bank-grade/i)
  expect(all).not.toMatch(/tam otomatik|hatasız|tüm pazaryeri|tüm kargo|her yazıcı|yapay zeka|\bAI\b/i)
  // Kayıt/deneme BAĞLANTISI da yok: tek hedef panel girişi ve sayfa içi çapalar.
  const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  for (const href of hrefs) expect(href).toMatch(/^(\/app|\/|#[a-z-]+)$/)
})

test('LAND-UI-5: entegrasyon bölümü YALNIZ kabul edilmiş kamu entegrasyonları', () => {
  render(<LandingPage />)
  const items = [...screen.getByTestId('landing-integrations').querySelectorAll('li strong')].map(
    (node) => node.textContent,
  )
  expect(items).toEqual(['Trendyol', 'Sürat Kargo'])
  expect(LANDING_INTEGRATIONS.map((item) => item.name)).toEqual(['Trendyol', 'Sürat Kargo'])
})

/* ─── ERİŞİLEBİLİRLİK / YAPI ─────────────────────────────────────────── */

test('LAND-UI-1/3/4: tek h1; "Nasıl çalışır?" çapası akışa ulaşır; yetenekler render edilir', () => {
  render(<LandingPage />)
  expect(document.querySelectorAll('h1')).toHaveLength(1)
  expect(document.querySelectorAll('header, nav, main, footer').length).toBeGreaterThanOrEqual(4)
  const how = screen.getByRole('link', { name: 'Nasıl çalışır?' })
  const target = document.querySelector(how.getAttribute('href') ?? '')
  expect(target?.tagName).toBe('SECTION')
  expect(target?.querySelector('h2')?.textContent).toBe('Nasıl çalışır?')
  expect(target?.querySelectorAll('ol > li')).toHaveLength(4)
  const capabilities = [...document.querySelectorAll('[data-capability]')].map((node) =>
    node.getAttribute('data-capability'),
  )
  expect(capabilities).toEqual(LANDING_CAPABILITIES.map((capability) => capability.title))
  for (const section of ['nasil-calisir', 'ozellikler', 'entegrasyonlar']) {
    const element = document.getElementById(section)
    expect(element?.getAttribute('aria-labelledby')).toBeTruthy()
  }
})

test('LAND-UI-6: mobil menü kullanılabilir (aria-expanded, bağlantı seçince kapanır)', () => {
  render(<LandingPage />)
  const toggle = screen.getByRole('button', { name: 'Menü' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.getAttribute('aria-controls')).toBe('landing-nav')
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'Menüyü kapat' }).getAttribute('aria-expanded')).toBe('true')
  const nav = document.getElementById('landing-nav')
  expect(nav?.className).toContain('is-open')
  fireEvent.click(screen.getByRole('link', { name: 'Özellikler' }))
  expect(nav?.className).not.toContain('is-open')
})

test('LAND-UI-8: temsili ürün sahnesi süs olarak işaretli ve kişisel veri İÇERMEZ', () => {
  render(<LandingPage />)
  const window = document.querySelector('.landing-scene-window') as HTMLElement
  expect(window.getAttribute('aria-hidden')).toBe('true')
  expect(document.querySelector('.landing-scene figcaption')?.textContent).toMatch(/Temsili ekran · örnek veriler/)
  const scene = document.querySelector('.landing-scene')?.textContent ?? ''
  expect(scene).not.toMatch(/\d{5,}|@|\+90|\bMah\.|\bSok\.|\bCad\.|\bTel\b/)
  expect(scene).toMatch(/Örnek sipariş A/)
})

// LAND-UI-7 / LAND-UI-9 (CSS sözleşmeleri) Node testindedir:
// `server/landing-contract-flow.test.mjs` — Vitest CSS hattı `?raw` içeriğini boşaltır.

test('LAND-META: belge meta verisi doğru; olmayan OG görseli / uydurma yapılandırılmış veri YOK', () => {
  expect(indexHtml).toMatch(/<html lang="tr">/)
  expect(indexHtml).toContain(`<title>${LANDING_TITLE}</title>`)
  expect(indexHtml).toMatch(/<meta\s+name="description"/)
  expect(indexHtml).toMatch(/property="og:title"/)
  expect(indexHtml).toMatch(/name="theme-color"/)
  expect(indexHtml).not.toMatch(/og:image|application\/ld\+json|fonts\.googleapis|cdn\./i)
})
