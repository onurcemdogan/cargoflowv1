import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import appSource from '../App.tsx?raw'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { AppShell } from '../components/AppShell'
import { PageHeader } from '../components/PageHeader'
import { OnboardingGate } from '../onboarding/OnboardingGate'
import { integrationConfigService } from '../services/appServices'
import { normalizeOnboardingStatus } from '../services/onboardingService'
import { ProductTour } from '../tour/ProductTour'
import {
  PRODUCT_TOUR_V1,
  PRODUCT_TOUR_VERSION,
  tourTargetSelector,
} from '../tour/productTourDefinition'
import { placeTourCard, TOUR_MARGIN } from '../tour/productTourGeometry'
import {
  productTourStorageKey,
  readProductTourMarker,
  resetProductTourSessionMarkers,
  writeProductTourMarker,
  type ProductTourScope,
} from '../tour/productTourStorage'
import { useProductTourController } from '../tour/useProductTourController'
import type { PageKey } from '../types/cargoflow'

// ═══ PRODUCT-TOUR-001 — GERÇEK DOM KABULÜ ════════════════════════════════
//
// Test düzeneği App'in tur bağlantısını BİREBİR kurar: GERÇEK AppShell,
// GERÇEK PageHeader (`tourId`), GERÇEK denetleyici ve katman. Sayfalar
// sahte ama OPERASYON düğmeleri casuslarla ölçülür — tur hiçbirini
// tetiklememelidir. App'in aynı parçaları kullandığı kaynakla kilitlenir.

const SCOPE: ProductTourScope = { organizationId: 'org-1', username: 'ada' }
const KEY = productTourStorageKey(SCOPE)

const PAGE_TOUR_IDS: Partial<Record<PageKey, string>> = {
  dashboard: 'dashboard-overview',
  orders: 'orders-workspace',
  products: 'products-catalog',
  cargo: 'cargo-operations',
  labelTemplates: 'label-templates',
  integrations: 'integrations-settings',
}

type ActionSpy = ReturnType<typeof vi.fn<() => void>>

interface Spies {
  sync: ActionSpy
  createShipment: ActionSpy
  print: ActionSpy
  saveTest: ActionSpy
  navigate: ReturnType<typeof vi.fn<(page: PageKey) => void>>
}

function makeSpies(): Spies {
  return {
    sync: vi.fn<() => void>(),
    createShipment: vi.fn<() => void>(),
    print: vi.fn<() => void>(),
    saveTest: vi.fn<() => void>(),
    navigate: vi.fn<(page: PageKey) => void>(),
  }
}

/** Tembel sayfa: hedef `delay` ms sonra bağlanır; `missing` ise HİÇ bağlanmaz. */
function FakePage({
  page,
  spies,
  delay,
  missing,
}: {
  page: PageKey
  spies: Spies
  delay: number
  missing: PageKey[]
}) {
  const [mounted, setMounted] = useState(delay === 0)
  useEffect(() => {
    if (delay === 0) return
    const timer = setTimeout(() => setMounted(true), delay)
    return () => clearTimeout(timer)
  }, [delay])
  if (!mounted) return <p>Yükleniyor…</p>
  return (
    <div data-page={page}>
      <PageHeader
        tourId={missing.includes(page) ? undefined : PAGE_TOUR_IDS[page]}
        title={`Sayfa ${page}`}
        description="açıklama"
        actions={
          <>
            <button type="button" onClick={() => spies.sync()}>Ürünleri Senkronize Et</button>
            <button type="button" onClick={() => spies.createShipment()}>Gönderi Oluştur</button>
            <button type="button" onClick={() => spies.print()}>Yazdır</button>
            <button type="button" onClick={() => spies.saveTest()}>Kaydet ve Test Et</button>
          </>
        }
      />
    </div>
  )
}

function Harness({
  scope,
  spies,
  delay = 0,
  missing = [],
  initialPage = 'dashboard',
}: {
  scope: ProductTourScope | null
  spies: Spies
  delay?: number
  missing?: PageKey[]
  initialPage?: PageKey
}) {
  const [page, setPage] = useState<PageKey>(initialPage)
  const navigate = (next: PageKey) => {
    spies.navigate(next)
    setPage(next)
  }
  const tour = useProductTourController({ scope, currentPage: page, navigate })
  return (
    <>
      <AppShell
        activePage={page}
        onNavigate={navigate}
        onStartTour={() => void tour.start()}
        tourNotice={tour.notice}
        interactionLocked={tour.active}
      >
        <FakePage key={page} page={page} spies={spies} delay={delay} missing={missing} />
      </AppShell>
      {tour.active ? (
        <ProductTour
          key={tour.runId}
          steps={PRODUCT_TOUR_V1}
          onNavigate={navigate}
          onComplete={tour.complete}
          onDismiss={tour.dismiss}
          targetTimeoutMs={400}
        />
      ) : null}
    </>
  )
}

const card = () => screen.queryByTestId('product-tour-card')
const next = () => fireEvent.click(screen.getByRole('button', { name: 'İleri' }))
const activeNav = () => document.querySelector('.nav-item.active')?.getAttribute('data-tour')

async function stepTo(stepId: string) {
  await waitFor(() => expect(card()?.getAttribute('data-step')).toBe(stepId))
}

beforeEach(() => {
  resetProductTourSessionMarkers()
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* ─── OTOMATİK BAŞLATMA / TEKRAR ─────────────────────────────────────── */

test('TOUR-1: kapsamlı kullanıcı, v1 işareti yok → tur BİR KEZ otomatik açılır', async () => {
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  expect(screen.getAllByTestId('product-tour-card')).toHaveLength(1)
  expect(card()?.textContent).toContain("CargoFlow'a hoş geldiniz")
  expect(card()?.textContent).toContain('1 / 7')
})

test('TOUR-2/3: tamamlanmış veya kapatılmış işaret → otomatik AÇILMAZ', () => {
  for (const status of ['completed', 'dismissed'] as const) {
    resetProductTourSessionMarkers()
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: PRODUCT_TOUR_VERSION, status, at: '2026-09-01T00:00:00.000Z' }),
    )
    const view = render(<Harness scope={SCOPE} spies={makeSpies()} />)
    expect(card()).toBeNull()
    view.unmount()
  }
})

test('TOUR-4: "Ürün Turunu Başlat" tamamlanmış/kapatılmış olsa da 1. adımdan başlar', async () => {
  writeProductTourMarker(SCOPE, 'completed')
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  expect(card()).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Ürün Turunu Başlat/ }))
  await stepTo('welcome')
  expect(card()?.textContent).toContain('1 / 7')
})

test('TOUR-5/6: anahtar organizasyon + kullanıcı kapsamlı; başkasının işareti bastırmaz', () => {
  expect(KEY).toBe('cargoflow.productTour.v1::org-1::ada')
  expect(productTourStorageKey({ organizationId: 'org-2', username: 'ada' })).not.toBe(KEY)
  expect(productTourStorageKey({ organizationId: 'org-1', username: 'bora' })).not.toBe(KEY)
  writeProductTourMarker({ organizationId: 'org-2', username: 'ada' }, 'completed')
  writeProductTourMarker({ organizationId: 'org-1', username: 'bora' }, 'dismissed')
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  expect(card()).not.toBeNull()
})

test('TOUR-7: Bitir → tamamlandı işareti', async () => {
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  for (const step of PRODUCT_TOUR_V1.slice(1)) {
    next()
    await stepTo(step.id)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Bitir' }))
  expect(card()).toBeNull()
  expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}').status).toBe('completed')
})

test('TOUR-8/20: Turu Atla ve Escape → kapatıldı işareti', async () => {
  const view = render(<Harness scope={SCOPE} spies={makeSpies()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Turu Atla' }))
  expect(card()).toBeNull()
  expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}').status).toBe('dismissed')
  view.unmount()

  resetProductTourSessionMarkers()
  window.localStorage.clear()
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  expect(card()).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(card()).toBeNull()
  expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}').status).toBe('dismissed')
})

test('TOUR-9: kimlik kapsamı yok (geliştirme atlatması / legacy) → otomatik AÇILMAZ', () => {
  render(<Harness scope={null} spies={makeSpies()} />)
  expect(card()).toBeNull()
  expect(window.localStorage.length).toBe(0)
})

/* ─── SAYFALAR ARASI / HEDEF ─────────────────────────────────────────── */

test('TOUR-10/11: İleri mevcut PageKey ile gezer; Geri önceki sayfanın hedefini çözer', async () => {
  const spies = makeSpies()
  render(<Harness scope={SCOPE} spies={spies} />)
  next()
  await stepTo('dashboard')
  next()
  await stepTo('orders')
  expect(spies.navigate).toHaveBeenLastCalledWith('orders')
  expect(activeNav()).toBe('nav-orders')
  await waitFor(() => expect(card()?.getAttribute('data-target-status')).toBe('found'))
  next()
  await stepTo('products')
  expect(activeNav()).toBe('nav-products')
  fireEvent.click(screen.getByRole('button', { name: 'Geri' }))
  await stepTo('orders')
  expect(activeNav()).toBe('nav-orders')
  await waitFor(() => expect(card()?.getAttribute('data-target-status')).toBe('found'))
})

test('TOUR-12: tembel hedef SINIRLI bekleme ile GERÇEK hedefe çözülür', async () => {
  render(<Harness scope={SCOPE} spies={makeSpies()} delay={150} />)
  next()
  await stepTo('dashboard')
  expect(card()?.getAttribute('data-target-status')).not.toBe('missing')
  await waitFor(() => expect(card()?.getAttribute('data-target-status')).toBe('found'))
})

test('TOUR-13: hedef yoksa yumuşak başarısızlık; İleri ve Atla çalışır', async () => {
  render(<Harness scope={SCOPE} spies={makeSpies()} missing={['orders']} />)
  next()
  await stepTo('dashboard')
  next()
  await stepTo('orders')
  await waitFor(() => expect(card()?.getAttribute('data-target-status')).toBe('missing'))
  expect(screen.getByRole('note').textContent).toMatch(/görüntülenemiyor/)
  expect(card()?.getAttribute('data-placement')).toBe('center')
  next()
  await stepTo('products')
  fireEvent.click(screen.getByRole('button', { name: 'Turu Atla' }))
  expect(card()).toBeNull()
})

/* ─── YAN ETKİ YOK / ARKA PLAN KİLİDİ ────────────────────────────────── */

test('TOUR-14..17: tüm tur boyunca senkron, gönderi, baskı, kaydet/test ÇAĞRILMAZ', async () => {
  const spies = makeSpies()
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  render(<Harness scope={SCOPE} spies={spies} />)
  for (const step of PRODUCT_TOUR_V1.slice(1)) {
    next()
    await stepTo(step.id)
    await waitFor(() => expect(card()?.getAttribute('data-target-status')).toBe('found'))
  }
  fireEvent.click(screen.getByRole('button', { name: 'Bitir' }))
  expect(spies.sync).not.toHaveBeenCalled()
  expect(spies.createShipment).not.toHaveBeenCalled()
  expect(spies.print).not.toHaveBeenCalled()
  expect(spies.saveTest).not.toHaveBeenCalled()
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('TOUR-22: tur açıkken arka plandaki operasyon düğmesi TETİKLENEMEZ', async () => {
  const spies = makeSpies()
  render(<Harness scope={SCOPE} spies={spies} />)
  next()
  await stepTo('dashboard')
  const shell = document.querySelector('.app-shell') as HTMLElement
  expect(shell.hasAttribute('inert')).toBe(true)
  const syncButton = screen.getByText('Ürünleri Senkronize Et')
  fireEvent.click(syncButton)
  fireEvent.keyDown(syncButton, { key: 'Enter' })
  fireEvent.click(screen.getByText('Gönderi Oluştur'))
  expect(spies.sync).not.toHaveBeenCalled()
  expect(spies.createShipment).not.toHaveBeenCalled()
  // Arka plan navigasyonu da kilitli; sayfayı YALNIZ tur değiştirir.
  fireEvent.click(document.querySelector('[data-tour="nav-logs"]') as HTMLElement)
  expect(activeNav()).toBe('nav-dashboard')
})

test('TOUR-24: tur kapalıyken mevcut navigasyon ve düğmeler normal çalışır', () => {
  writeProductTourMarker(SCOPE, 'dismissed')
  const spies = makeSpies()
  render(<Harness scope={SCOPE} spies={spies} />)
  fireEvent.click(document.querySelector('[data-tour="nav-orders"]') as HTMLElement)
  expect(activeNav()).toBe('nav-orders')
  fireEvent.click(screen.getByText('Ürünleri Senkronize Et'))
  expect(spies.sync).toHaveBeenCalledTimes(1)
  expect((document.querySelector('.app-shell') as HTMLElement).hasAttribute('inert')).toBe(false)
})

/* ─── ODAK / KLAVYE ──────────────────────────────────────────────────── */

test('TOUR-21: odak tura girer, Tab içeride kalır, kapanışta geri döner', async () => {
  writeProductTourMarker(SCOPE, 'completed')
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  const replay = screen.getByRole('button', { name: /Ürün Turunu Başlat/ })
  replay.focus()
  fireEvent.click(replay)
  await stepTo('welcome')
  const dialog = screen.getByRole('dialog')
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
    "CargoFlow'a hoş geldiniz",
  )
  expect(document.activeElement?.textContent).toBe('İleri')
  // Tab son düğmeden BAŞA döner (tuzak).
  fireEvent.keyDown(document, { key: 'Tab' })
  expect(dialog.contains(document.activeElement)).toBe(true)
  fireEvent.keyDown(document, { key: 'ArrowRight' })
  await stepTo('dashboard')
  fireEvent.keyDown(document, { key: 'ArrowLeft' })
  await stepTo('welcome')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(card()).toBeNull()
  expect(document.activeElement).toBe(replay)
})

test('TOUR-23: elle tekrar köken sayfayı hatırlar; bitiş ve kapatmada oraya döner', async () => {
  writeProductTourMarker(SCOPE, 'completed')
  render(<Harness scope={SCOPE} spies={makeSpies()} initialPage="products" />)
  fireEvent.click(screen.getByRole('button', { name: /Ürün Turunu Başlat/ }))
  await stepTo('welcome')
  expect(activeNav()).toBe('nav-dashboard')
  next()
  await stepTo('dashboard')
  fireEvent.click(screen.getByRole('button', { name: 'Turu Atla' }))
  expect(activeNav()).toBe('nav-products')

  fireEvent.click(screen.getByRole('button', { name: /Ürün Turunu Başlat/ }))
  for (const step of PRODUCT_TOUR_V1.slice(1)) {
    next()
    await stepTo(step.id)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Bitir' }))
  expect(activeNav()).toBe('nav-products')
})

test('TOUR-MODAL: açık pencere/kaydedilmemiş düzenleyici varken tur BAŞLAMAZ (sessiz kapatma yok)', () => {
  writeProductTourMarker(SCOPE, 'completed')
  render(
    <>
      <Harness scope={SCOPE} spies={makeSpies()} />
      <div role="dialog" aria-modal="true">Kaydedilmemiş düzenleyici</div>
    </>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Ürün Turunu Başlat/ }))
  expect(card()).toBeNull()
  expect(screen.getByText(/Tur, bunlar kapatıldıktan sonra başlatılabilir/)).toBeTruthy()
  // Açık pencere DOKUNULMADAN yerinde.
  expect(screen.getByText('Kaydedilmemiş düzenleyici')).toBeTruthy()
})

/* ─── GEOMETRİ ───────────────────────────────────────────────────────── */

test('TOUR-18: vurgu yeniden boyutlandırmada GERÇEK hedef geometrisine göre yeniden hesaplanır', async () => {
  let rect = { top: 100, left: 300, width: 400, height: 60 }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('data-tour') === 'dashboard-overview') {
      return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) } as DOMRect
    }
    return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  next()
  await stepTo('dashboard')
  await waitFor(() =>
    expect(screen.getByTestId('product-tour-highlight').style.top).toBe('94px'),
  )
  expect(card()?.getAttribute('data-placement')).toBe('below')
  rect = { top: 300, left: 120, width: 500, height: 80 }
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
  })
  await waitFor(() =>
    expect(screen.getByTestId('product-tour-highlight').style.top).toBe('294px'),
  )
  expect(screen.getByTestId('product-tour-highlight').style.width).toBe('512px')
})

test('TOUR-19: kart her konumda görünüm alanı İÇİNDE kalır', () => {
  const card = { width: 360, height: 230 }
  const viewports = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 375, height: 667 },
  ]
  const targets = [
    null,
    { top: 5, left: 5, width: 200, height: 40 }, // üst-sol
    { top: 600, left: 1200, width: 200, height: 40 }, // alt-sağ
    { top: 400, left: -50, width: 100, height: 30 }, // sola taşan
    { top: 10, left: 10, width: 1400, height: 850 }, // dev hedef → orta
  ]
  for (const viewport of viewports) {
    for (const target of targets) {
      const placed = placeTourCard(target, card, viewport)
      expect(placed.left).toBeGreaterThanOrEqual(TOUR_MARGIN)
      expect(placed.top).toBeGreaterThanOrEqual(TOUR_MARGIN)
      expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width - TOUR_MARGIN)
      expect(placed.top + Math.min(card.height, viewport.height)).toBeLessThanOrEqual(
        viewport.height,
      )
    }
  }
  // Alta sığmayan hedef → üste.
  expect(placeTourCard({ top: 700, left: 20, width: 100, height: 40 }, card, { width: 1440, height: 900 }).placement).toBe('above')
  // Hedef yok / görünmüyor → orta.
  expect(placeTourCard({ top: 0, left: 0, width: 0, height: 0 }, card, { width: 1024, height: 768 }).placement).toBe('center')
})

/* ─── ONBOARDING UYUMU ───────────────────────────────────────────────── */

const AUTH = {
  user: { username: 'ada', organization: { id: 'org-1', name: 'Org', slug: 'org' } },
  devBypass: false,
  signOut: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => {}),
} as unknown as AuthContextValue

function withAuth(children: ReactNode) {
  return <AuthContext.Provider value={AUTH}>{children}</AuthContext.Provider>
}

function onboardingStatus(completed: boolean) {
  return normalizeOnboardingStatus({
    completed,
    completedAt: completed ? '2026-09-01T00:00:00.000Z' : null,
    eligibleToComplete: false,
    blockers: completed ? [] : ['MARKETPLACE_NOT_CONFIGURED'],
    resumeStep: 'WELCOME',
    steps: [],
    marketplaces: [],
    carrier: { providerKey: 'surat', displayName: 'Sürat Kargo', configured: false, verification: 'NOT_CONFIGURED' },
    counts: { products: 0, orders: 0 },
  })
}

test('TOUR-ONB-1/2/3: onboarding sürerken tur YOK; tamamlanınca açılır; onboarding yazılmaz', async () => {
  vi.spyOn(integrationConfigService, 'hydrateIntegrationConfig').mockResolvedValue(
    integrationConfigService.loadIntegrationConfig(),
  )
  const calls: Array<{ url: string; method: string }> = []
  let completed = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ...onboardingStatus(completed) }),
      } as unknown as Response
    }),
  )
  const incomplete = render(
    withAuth(
      <OnboardingGate>
        <Harness scope={SCOPE} spies={makeSpies()} />
      </OnboardingGate>,
    ),
  )
  expect(await screen.findByText('CargoFlow Kurulumu')).toBeTruthy()
  expect(card()).toBeNull()
  incomplete.unmount()

  completed = true
  render(
    withAuth(
      <OnboardingGate>
        <Harness scope={SCOPE} spies={makeSpies()} />
      </OnboardingGate>,
    ),
  )
  await waitFor(() => expect(card()).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Turu Atla' }))
  // Tur onboarding'i TAMAMLAMAZ ve onboarding uçlarına YAZMAZ.
  expect(calls.some((call) => call.url.includes('/api/onboarding/complete'))).toBe(false)
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
})

/* ─── HEDEF SÖZLEŞMESİ ───────────────────────────────────────────────── */

const SOURCES = import.meta.glob(['../**/*.tsx', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

test('TOUR-TARGET-1: v1 hedef kimlikleri tekil ve her biri üründe TAM BİR KEZ tanımlı', () => {
  const targets = PRODUCT_TOUR_V1.map((step) => step.target).filter(Boolean) as string[]
  expect(new Set(targets).size).toBe(targets.length)
  const productSources = Object.entries(SOURCES).filter(([path]) => !path.includes('/tour/'))
  for (const target of targets) {
    const pattern = new RegExp(`(?:tourId|data-tour)="${target}"`, 'g')
    const count = productSources.reduce(
      (sum, [, source]) => sum + (source.match(pattern)?.length ?? 0),
      0,
    )
    expect(count, `${target} tanımı`).toBe(1)
  }
  // Navigasyon çapaları TEK navigasyon tanımından türetilir.
  const shell = SOURCES['../components/AppShell.tsx']
  expect(shell).toMatch(/data-tour=\{`nav-\$\{item\.key\}`\}/)
})

test('TOUR-TARGET-2: hedefler yalnız [data-tour]; nth-child / metin eşleşmesi YOK', () => {
  for (const step of PRODUCT_TOUR_V1) {
    if (!step.target) continue
    expect(tourTargetSelector(step.target)).toMatch(/^\[data-tour="[a-z0-9-]+"\]$/)
  }
  expect(() => tourTargetSelector('x:nth-child(2)')).toThrow()
  expect(() => tourTargetSelector('.page-header > div')).toThrow()
  const tourSources = Object.entries(SOURCES)
    .filter(([path]) => path.includes('/tour/'))
    .map(([, source]) => source)
    .join('\n')
  expect(tourSources).not.toMatch(/nth-child|nth-of-type|textContent|innerText|:contains/)
})

test('TOUR-TARGET-3/4: Debug/Log yok; yayınlanmamış sağlayıcı ve abartı İDDİASI yok', () => {
  const pages = PRODUCT_TOUR_V1.map((step) => step.page)
  expect(pages).not.toContain('debug')
  expect(pages).not.toContain('logs')
  expect(pages).not.toContain('printers')
  expect(PRODUCT_TOUR_V1.length).toBeLessThanOrEqual(7)
  const copy = PRODUCT_TOUR_V1.map((step) => `${step.title} ${step.body}`).join(' ')
  expect(copy).not.toMatch(/WooCommerce|ikas|Ticimax|Aras|yapay zeka|\bAI\b|tam otomatik/i)
})

test('TOUR-APP: App aynı parçaları kullanır; tur kabuğun KARDEŞİDİR ve tıklama benzetimi yok', () => {
  expect(appSource).toMatch(/useProductTourController\(/)
  expect(appSource).toMatch(/interactionLocked=\{productTour\.active\}/)
  expect(appSource).toMatch(/onStartTour=/)
  const shellEnd = appSource.indexOf('</AppShell>')
  const tourAt = appSource.indexOf('<ProductTour')
  expect(tourAt).toBeGreaterThan(shellEnd)
  expect(appSource).toMatch(/onNavigate=\{handleNavigate\}\s*\n\s*onComplete=\{productTour\.complete\}/)
  const tourSources = Object.entries(SOURCES)
    .filter(([path]) => path.includes('/tour/'))
    .map(([, source]) => source)
    .join('\n')
  expect(tourSources).not.toMatch(/\.click\(\)|dispatchEvent\(/)
  expect(tourSources).not.toMatch(/fetch\(|onboarding\/complete/)
})

/* ─── DEPOLAMA ───────────────────────────────────────────────────────── */

test('TOUR-STORAGE-1/2: işaret YALNIZ tur UX meta verisi taşır', () => {
  writeProductTourMarker(SCOPE, 'completed', window.localStorage, () => new Date('2026-09-24T10:00:00.000Z'))
  const raw = window.localStorage.getItem(KEY) ?? ''
  expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['at', 'status', 'version'])
  expect(JSON.parse(raw)).toEqual({ version: 'v1', status: 'completed', at: '2026-09-24T10:00:00.000Z' })
  expect(raw).not.toMatch(/token|secret|password|order|customer|sellerId|apiKey/i)
  expect(window.localStorage.length).toBe(1)
})

test('TOUR-STORAGE-3: depolama yazımı başarısız olsa da tur ÇÖKMEZ ve oturumda tekrar açılmaz', async () => {
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
  expect(writeProductTourMarker(SCOPE, 'dismissed', broken)).toBe(false)
  expect(readProductTourMarker(SCOPE, broken)?.status).toBe('dismissed')

  resetProductTourSessionMarkers()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError')
  })
  const view = render(<Harness scope={SCOPE} spies={makeSpies()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Turu Atla' }))
  expect(card()).toBeNull()
  view.unmount()
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  expect(card()).toBeNull()
})

test('TOUR-STORAGE-4: bozuk JSON işaret güvenle yok sayılır; uygulama çökmez', () => {
  window.localStorage.setItem(KEY, '{bozuk json')
  expect(readProductTourMarker(SCOPE)).toBeNull()
  window.localStorage.setItem(KEY, JSON.stringify({ version: 'v0', status: 'completed', at: 'x' }))
  expect(readProductTourMarker(SCOPE)).toBeNull()
  render(<Harness scope={SCOPE} spies={makeSpies()} />)
  expect(card()).not.toBeNull()
})
