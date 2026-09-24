import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider'
import { OnboardingGate } from '../onboarding/OnboardingGate'
import { OnboardingPage } from '../pages/OnboardingPage'
import { integrationConfigService, workflowService } from '../services/appServices'
import {
  normalizeOnboardingStatus,
  type OnboardingStatus,
} from '../services/onboardingService'

// ═══ ONBOARDING-001 — GERÇEK DOM KABULÜ ══════════════════════════════════
//
// Sunucu yanıtı `fetch` ile taklit edilir; sayfa GERÇEK servisleri kullanır
// (yalnız ağa çıkan metotlar izlenir). Kaynak taraması DEĞİL: tıklama,
// gezinme ve görünen metin doğrulanır.

const AUTH = {
  user: { username: 'ada' },
  devBypass: false,
  signOut: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => {}),
} as unknown as AuthContextValue

function withAuth(children: ReactNode) {
  return <AuthContext.Provider value={AUTH}>{children}</AuthContext.Provider>
}

const TRENDYOL = {
  providerKey: 'trendyol',
  displayName: 'Trendyol',
  rolloutStage: 'ga',
  bootstrapResources: ['orders', 'products'],
  configured: false,
  credentialsRejected: false,
  bootstrapReady: false,
  accounts: [],
}

function statusOf(overrides: {
  marketplace?: Partial<typeof TRENDYOL>
  carrierConfigured?: boolean
  completed?: boolean
}): OnboardingStatus {
  const marketplace = { ...TRENDYOL, ...(overrides.marketplace ?? {}) }
  const carrierConfigured = overrides.carrierConfigured ?? false
  const steps = [
    { key: 'WELCOME', required: false, done: true },
    { key: 'MARKETPLACE', required: true, done: marketplace.configured },
    { key: 'CARRIER', required: true, done: carrierConfigured },
    { key: 'FIRST_SYNC', required: true, done: marketplace.bootstrapReady },
    { key: 'READY', required: false, done: Boolean(overrides.completed) },
  ]
  const blockers: string[] = []
  if (!marketplace.configured) blockers.push('MARKETPLACE_NOT_CONFIGURED')
  else if (!marketplace.bootstrapReady) {
    blockers.push(marketplace.credentialsRejected ? 'MARKETPLACE_NOT_VERIFIED' : 'FIRST_SYNC_REQUIRED')
  }
  if (!carrierConfigured) blockers.push('CARRIER_NOT_CONFIGURED')
  const required = steps.filter((step) => step.required)
  const first = required.find((step) => !step.done)
  return normalizeOnboardingStatus({
    completed: Boolean(overrides.completed),
    completedAt: null,
    eligibleToComplete: blockers.length === 0,
    blockers,
    resumeStep: !first ? 'READY' : required.every((step) => !step.done) ? 'WELCOME' : first.key,
    steps,
    marketplaces: [marketplace],
    carrier: {
      providerKey: 'surat',
      displayName: 'Sürat Kargo',
      configured: carrierConfigured,
      verification: carrierConfigured ? 'VERIFICATION_NOT_PERSISTED' : 'NOT_CONFIGURED',
    },
    counts: { products: 0, orders: 0 },
  })
}

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown }
let responder: Responder
const calls: Array<{ url: string; method: string; body: unknown }> = []

beforeEach(() => {
  calls.length = 0
  vi.spyOn(integrationConfigService, 'hydrateIntegrationConfig').mockResolvedValue(
    integrationConfigService.loadIntegrationConfig(),
  )
  vi.spyOn(integrationConfigService, 'persistIntegrationConfig').mockResolvedValue(true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body })
      const { status, body } = responder(url, init)
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
})

const heading = () => screen.getByRole('heading', { level: 2 }).textContent
const button = (name: RegExp) => screen.getByRole('button', { name })

function renderPage(status: OnboardingStatus, onCompleted = vi.fn()) {
  render(withAuth(<OnboardingPage initialStatus={status} onCompleted={onCompleted} />))
  return { onCompleted }
}

/* ─────────────────────────────────────────────────────────────────────── */

test('ONB-UI-RESUME: kısmi kurulum İLK EKSİK zorunlu adımdan açılır', () => {
  responder = () => ({ status: 200, body: {} })
  renderPage(statusOf({ marketplace: { configured: true } }))
  expect(heading()).toBe('Sürat Kargo Bağlantısı')
  // İlerleme GERÇEK durumdan: tamamlanan pazaryeri adımı işaretli.
  const marketplaceStep = document.querySelector('[data-step="MARKETPLACE"]')
  expect(marketplaceStep?.className).toBe('is-done')
  expect(document.querySelector('[data-step="CARRIER"]')?.getAttribute('aria-current')).toBe('step')
  // Adıma gelmek ağ işlemi BAŞLATMAZ (senkron/test/taşıyıcı yok).
  expect(calls).toEqual([])
})

test('ONB-UI-NAV: ileri/geri gezinme', () => {
  responder = () => ({ status: 200, body: {} })
  renderPage(statusOf({}))
  expect(heading()).toBe('Hoş Geldiniz')
  expect(button(/Geri/).hasAttribute('disabled')).toBe(true)
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Trendyol Bağlantısı')
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Sürat Kargo Bağlantısı')
  fireEvent.click(button(/Geri/))
  expect(heading()).toBe('Trendyol Bağlantısı')
  expect(calls).toEqual([])
})

test('ONB-UI-TRUTH: kayıtlı ≠ doğrulandı (pazaryeri ve taşıyıcı)', () => {
  responder = () => ({ status: 200, body: {} })
  renderPage(statusOf({ marketplace: { configured: true }, carrierConfigured: true }))
  // FIRST_SYNC'e sürdü; pazaryeri adımına geri dön.
  fireEvent.click(button(/Geri/))
  fireEvent.click(button(/Geri/))
  expect(heading()).toBe('Trendyol Bağlantısı')
  expect(screen.getByText('Kayıtlı')).toBeTruthy()
  expect(screen.getByText('Henüz doğrulanmadı')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Bağlantı doğrulandı/)

  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Sürat Kargo Bağlantısı')
  expect(screen.getByText('Kalıcı doğrulama kaydı yok')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Doğrulandı|Bağlantı doğrulandı/)
})

test('ONB-UI-VERIFIED: gerçek başarılı senkron kaydı varsa "Bağlantı doğrulandı"', () => {
  responder = () => ({ status: 200, body: {} })
  renderPage(statusOf({ marketplace: { configured: true, bootstrapReady: true } }))
  fireEvent.click(button(/Geri/)) // CARRIER'den MARKETPLACE'e
  expect(heading()).toBe('Trendyol Bağlantısı')
  expect(screen.getByText('Bağlantı doğrulandı')).toBeTruthy()
})

test('ONB-UI-TEST: başarısız / başarılı oturum testi kopyası', async () => {
  responder = () => ({ status: 200, body: {} })
  const surat = vi
    .spyOn(workflowService, 'testSuratConnection')
    .mockResolvedValueOnce({ ok: false, message: 'Kimlik reddedildi.' } as never)
    .mockResolvedValueOnce({ ok: true, message: '' } as never)
  renderPage(statusOf({ marketplace: { configured: true }, carrierConfigured: false }))
  expect(heading()).toBe('Sürat Kargo Bağlantısı')

  await act(async () => {
    fireEvent.click(button(/Bağlantıyı Test Et/))
  })
  expect(await screen.findByText(/Bağlantı testi başarısız\./)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/bu oturumda başarılı/)

  await act(async () => {
    fireEvent.click(button(/Bağlantıyı Test Et/))
  })
  expect(await screen.findByText(/Bağlantı testi sonucu bu oturumda başarılı\./)).toBeTruthy()
  expect(surat).toHaveBeenCalledTimes(2)
  // Oturum testi KALICI doğrulama sayılmaz: kayıt çipi değişmez.
  expect(screen.getByText('Kayıt yok')).toBeTruthy()
})

test('ONB-UI-SYNC: ilk senkron başarısı sunucu durumundan gösterilir', async () => {
  const configured = statusOf({ marketplace: { configured: true }, carrierConfigured: true })
  const synced = statusOf({
    marketplace: { configured: true, bootstrapReady: true },
    carrierConfigured: true,
  })
  responder = (url) =>
    url.includes('/api/onboarding/status')
      ? { status: 200, body: { ok: true, ...synced } }
      : { status: 404, body: {} }
  const orders = vi
    .spyOn(workflowService, 'fetchOrders')
    .mockResolvedValue({ orders: [], result: { ok: true, message: '0 sipariş alındı.' } } as never)
  renderPage(configured)
  expect(heading()).toBe('İlk Senkronizasyon')
  expect(screen.getByText(/henüz başarılı bir ilk senkron yok/)).toBeTruthy()
  // Yalnız canlı bootstrap kaynakları için buton var.
  expect(button(/Siparişleri Senkronize Et/)).toBeTruthy()
  expect(button(/Ürünleri Senkronize Et/)).toBeTruthy()

  await act(async () => {
    fireEvent.click(button(/Siparişleri Senkronize Et/))
  })
  await waitFor(() => expect(screen.getByText(/ilk senkron başarılı/)).toBeTruthy())
  expect(screen.getByText('0 sipariş alındı.')).toBeTruthy()
  expect(orders).toHaveBeenCalledTimes(1)
})

test('ONB-UI-SINGLEFLIGHT: çift tıklama tek senkron başlatır', async () => {
  const configured = statusOf({ marketplace: { configured: true }, carrierConfigured: true })
  responder = () => ({ status: 200, body: { ok: true, ...configured } })
  let release: () => void = () => {}
  const orders = vi.spyOn(workflowService, 'fetchOrders').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ orders: [], result: { ok: true, message: 'ok' } } as never)
      }),
  )
  renderPage(configured)
  const syncButton = button(/Siparişleri Senkronize Et/)
  fireEvent.click(syncButton)
  fireEvent.click(syncButton)
  expect(orders).toHaveBeenCalledTimes(1)
  expect(button(/Siparişler senkronize ediliyor/).hasAttribute('disabled')).toBe(true)
  await act(async () => {
    release()
  })
})

test('ONB-UI-READY: tamamlama butonu yalnız sunucu uygun derse açılır', () => {
  responder = () => ({ status: 200, body: {} })
  const notReady = statusOf({ marketplace: { configured: true }, carrierConfigured: true })
  renderPage(notReady)
  // FIRST_SYNC'ten Hazır adımına ilerle.
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Hazır')
  expect(button(/Kurulumu Tamamla/).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('En az bir başarılı ilk senkron gerekli')).toBeTruthy()
  const checklist = screen.getByRole('list', { name: 'Kurulum kontrol listesi' })
  const items = [...checklist.querySelectorAll('li')].map((li) => li.getAttribute('data-done'))
  expect(items).toEqual(['true', 'true', 'false'])
})

test('ONB-UI-HANDOFF: tamamla → uygulamaya geçiş (Gate) ve gövdesiz istek', async () => {
  const ready = statusOf({
    marketplace: { configured: true, bootstrapReady: true },
    carrierConfigured: true,
  })
  const done = { ...ready, completed: true }
  responder = (url, init) => {
    if (url.includes('/api/onboarding/complete')) {
      return { status: 200, body: { ok: true, ...done } }
    }
    return { status: 200, body: { ok: true, ...(init?.method === 'POST' ? done : ready) } }
  }
  render(withAuth(<OnboardingGate><div>UYGULAMA PANELİ</div></OnboardingGate>))
  // Hepsi tamam ama completed=false → Hazır adımı açılır.
  expect(await screen.findByRole('heading', { level: 2, name: 'Hazır' })).toBeTruthy()
  const complete = button(/Kurulumu Tamamla/)
  expect(complete.hasAttribute('disabled')).toBe(false)
  await act(async () => {
    fireEvent.click(complete)
  })
  expect(await screen.findByText('UYGULAMA PANELİ')).toBeTruthy()
  const post = calls.find((call) => call.url.includes('/api/onboarding/complete'))
  expect(post?.method).toBe('POST')
  // İstemci "tamamlandı" İDDİA EDEMEZ: istek gövdesi YOK.
  expect(post?.body).toBeUndefined()
})

test('ONB-UI-REFRESH: yenileme kısmi kurulumdan sürer; tamamlanmış kurulum açılmaz', async () => {
  const partial = statusOf({ marketplace: { configured: true }, carrierConfigured: true })
  responder = () => ({ status: 200, body: { ok: true, ...partial } })
  const first = render(withAuth(<OnboardingGate><div>UYGULAMA PANELİ</div></OnboardingGate>))
  expect(await screen.findByRole('heading', { level: 2, name: 'İlk Senkronizasyon' })).toBeTruthy()
  first.unmount()

  // Tamamlanmış organizasyon: güncel engeller olsa BİLE onboarding açılmaz.
  const completedButBroken = {
    ...statusOf({ marketplace: { configured: false }, carrierConfigured: false }),
    completed: true,
  }
  responder = () => ({ status: 200, body: { ok: true, ...completedButBroken } })
  render(withAuth(<OnboardingGate><div>UYGULAMA PANELİ</div></OnboardingGate>))
  expect(await screen.findByText('UYGULAMA PANELİ')).toBeTruthy()
  expect(screen.queryByText('CargoFlow Kurulumu')).toBeNull()
})

test('ONB-UI-PROVIDER: sağlayıcı adı ve listesi SUNUCUDAN gelir', () => {
  responder = () => ({ status: 200, body: {} })
  const status = statusOf({ marketplace: { displayName: 'Trendyol Pazaryeri' } })
  renderPage(status)
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Trendyol Pazaryeri Bağlantısı')
  expect(document.querySelectorAll('[data-provider]').length).toBe(1)
  expect(document.body.textContent).not.toMatch(/WooCommerce|ikas|Ticimax|Yakında/i)
})
