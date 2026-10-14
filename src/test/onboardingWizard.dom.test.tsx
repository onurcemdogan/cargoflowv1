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
  marketplace?: Partial<typeof TRENDYOL> & { verified?: boolean }
  carrierConfigured?: boolean
  /** Kargo bağlantısı kalıcı olarak doğrulandı mı (varsayılan: kayıtlıysa evet). */
  carrierVerified?: boolean
  completed?: boolean
  businessDone?: boolean
}): OnboardingStatus {
  const base = { ...TRENDYOL, ...(overrides.marketplace ?? {}) }
  // Fikstür kolaylığı: "kayıtlı" pazaryeri aksi belirtilmedikçe doğrulanmış sayılır;
  // kayıtlı ≠ doğrulandı ayrımını sınayan testler `verified: false` verir.
  const marketplace = {
    ...base,
    verified: base.configured && (overrides.marketplace?.verified ?? true) && !base.credentialsRejected,
  }
  const carrierConfigured = overrides.carrierConfigured ?? false
  const carrierVerified = carrierConfigured && (overrides.carrierVerified ?? true)
  const operationsResolved = marketplace.verified && carrierVerified
  const steps = [
    { key: 'WELCOME', required: false, done: true },
    { key: 'BUSINESS', required: true, done: overrides.businessDone ?? true },
    { key: 'MARKETPLACE', required: true, done: marketplace.verified },
    { key: 'CARRIER', required: true, done: carrierVerified },
    { key: 'OPERATIONS', required: true, done: operationsResolved },
    { key: 'FIRST_SYNC', required: true, done: marketplace.bootstrapReady },
    { key: 'READY', required: false, done: Boolean(overrides.completed) },
  ]
  const blockers: string[] = []
  if (overrides.businessDone === false) blockers.push('BUSINESS_PROFILE_INCOMPLETE')
  if (!marketplace.configured) blockers.push('MARKETPLACE_NOT_CONFIGURED')
  else if (!marketplace.verified) {
    blockers.push(marketplace.credentialsRejected ? 'MARKETPLACE_NOT_VERIFIED' : 'MARKETPLACE_VERIFICATION_REQUIRED')
  }
  if (!carrierConfigured) blockers.push('CARRIER_NOT_CONFIGURED')
  else if (!carrierVerified) blockers.push('CARRIER_NOT_VERIFIED')
  if (marketplace.configured && carrierConfigured && !operationsResolved) blockers.push('OPERATIONS_UNRESOLVED')
  if (marketplace.configured && !marketplace.bootstrapReady) blockers.push('FIRST_SYNC_REQUIRED')
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
      verification: !carrierConfigured ? 'NOT_CONFIGURED' : carrierVerified ? 'VERIFIED' : 'UNVERIFIED',
      lastVerifiedAt: carrierVerified ? '2026-10-12T09:00:00.000Z' : null,
    },
    operations: {
      resolved: operationsResolved,
      accounts: marketplace.configured && carrierConfigured
        ? [{
            marketplaceAccountId: 'm1',
            providerKey: 'trendyol',
            displayName: 'Trendyol',
            carrier: { ok: true, carrierAccountId: 'c1', carrierName: 'Sürat Kargo', source: 'ONLY_ACCOUNT_FOR_PROVIDER' },
            payer: { ok: true, source: 'ORDER_CONTRACT' },
          }]
        : [],
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

test('ONB-UI-ACCOUNT-READ: first sync targets the verified HB account; unverified sibling cannot start sync', async () => {
  const status = statusOf({ marketplace: { configured: true, verified: true }, carrierConfigured: true })
  status.resumeStep = 'FIRST_SYNC'
  status.marketplaces = [{
    providerKey: 'hepsiburada', displayName: 'Hepsiburada', rolloutStage: 'internal_test', bootstrapResources: ['orders'],
    configured: true, verified: true, credentialsRejected: false, bootstrapReady: false, requiresAccountVerification: true,
    accounts: [true, false].map((verified, index) => ({ marketplaceAccountId: `hb-${index}`, displayName: `HB hesap ${index}`, isActive: true, credentials: 'PRESENT', connection: 'CONNECTED', credentialsRejected: false, sync: [], bootstrapReady: false, verified })),
  }]
  let posted: unknown
  responder = (url, init) => {
    if (url.endsWith('/hepsiburada/accounts/sync')) {
      posted = JSON.parse(String(init?.body))
      return { status: 200, body: { ok: true, message: 'HB hesabının ilk senkronu tamamlandı.' } }
    }
    return { status: 200, body: status }
  }
  renderPage(status)
  expect(screen.getByRole('button', { name: 'HB hesap 1: Siparişleri Senkronize Et' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'HB hesap 0: Siparişleri Senkronize Et' }))
  await screen.findByText('HB hesabının ilk senkronu tamamlandı.')
  expect(posted).toEqual({ marketplaceAccountId: 'hb-0' })
  responder = (url) => url.endsWith('/hepsiburada/accounts/sync')
    ? { status: 503, body: { ok: false } } : { status: 200, body: status }
  await waitFor(() => expect(screen.getByRole('button', { name: 'HB hesap 0: Siparişleri Senkronize Et' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'HB hesap 0: Siparişleri Senkronize Et' }))
  await screen.findByText('İşlem tamamlanamadı.')
})

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
  renderPage(statusOf({ businessDone: false }))
  expect(heading()).toBe('Hoş Geldiniz')
  expect(button(/Geri/).hasAttribute('disabled')).toBe(true)
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('İşletme Bilgileri')
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Trendyol Bağlantısı')
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Sürat Kargo Bağlantısı')
  fireEvent.click(button(/Geri/))
  expect(heading()).toBe('Trendyol Bağlantısı')
  // Adıma gitmek senkron/test/yazma BAŞLATMAZ; yalnız işletme bilgisi OKUNUR.
  expect(calls.every((call) => call.method === 'GET' && call.url === '/api/organization/profile')).toBe(true)
})

test('ONB-UI-TRUTH: kayıtlı ≠ doğrulandı (pazaryeri ve taşıyıcı)', () => {
  responder = () => ({ status: 200, body: {} })
  renderPage(statusOf({ marketplace: { configured: true, verified: false }, carrierConfigured: true, carrierVerified: false }))
  // Kayıtlı ama doğrulanmamış pazaryeri: kurulum PAZARYERİ adımından sürer.
  expect(heading()).toBe('Trendyol Bağlantısı')
  expect(screen.getByText('Kayıtlı')).toBeTruthy()
  expect(screen.getByText('Henüz doğrulanmadı')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Bağlantı doğrulandı/)

  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Sürat Kargo Bağlantısı')
  // PHASE2-C: doğrulama KALICIDIR; kayıt yalnızsa "Henüz doğrulanmadı".
  expect(screen.getByText('Kayıtlı')).toBeTruthy()
  expect(screen.getByText('Henüz doğrulanmadı')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Bağlantı doğrulandı/)
})

test('ONB-UI-VERIFIED: gerçek başarılı senkron kaydı varsa "Bağlantı doğrulandı"', () => {
  responder = () => ({ status: 200, body: {} })
  renderPage(statusOf({ marketplace: { configured: true, bootstrapReady: true } }))
  fireEvent.click(button(/Geri/)) // CARRIER'den MARKETPLACE'e
  expect(heading()).toBe('Trendyol Bağlantısı')
  expect(document.querySelector('.onboarding-chip.is-on:last-child')?.textContent).toBe('Bağlantı doğrulandı')
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
  // İşletme · pazaryeri · taşıyıcı · operasyon tamam; ilk senkron eksik.
  expect(items).toEqual(['true', 'true', 'true', 'true', 'false'])
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
  const status = statusOf({ marketplace: { displayName: 'Trendyol Pazaryeri' }, businessDone: false })
  renderPage(status)
  fireEvent.click(button(/İleri/))
  fireEvent.click(button(/İleri/))
  expect(heading()).toBe('Trendyol Pazaryeri Bağlantısı')
  expect(document.querySelectorAll('[data-provider]').length).toBe(1)
  expect(document.body.textContent).not.toMatch(/WooCommerce|ikas|Ticimax|Yakında/i)
})

test('ONB-UI-BUSINESS: işletme adımı sunucu durumundan; kaydetme PUT eder ve durumu yeniler', async () => {
  responder = (url, init) => {
    if (url === '/api/organization/profile' && (init?.method ?? 'GET') === 'GET') {
      return { status: 200, body: { ok: true, complete: false, profile: { name: 'Ada Moda', contactPhone: null, addressLine: null, city: null, district: null } } }
    }
    if (url === '/api/organization/profile') {
      const body = JSON.parse(String(init?.body))
      return { status: 200, body: { ok: true, complete: true, profile: body } }
    }
    return { status: 200, body: { ok: true, ...statusOf({}) } }
  }
  renderPage({ ...statusOf({ businessDone: false }), resumeStep: 'BUSINESS' })
  expect(heading()).toBe('İşletme Bilgileri')
  expect(document.querySelector('[data-step="BUSINESS"]')?.getAttribute('aria-current')).toBe('step')
  const name = await screen.findByDisplayValue('Ada Moda')
  expect(name).toBeTruthy()
  fireEvent.change(screen.getByLabelText('İletişim telefonu'), { target: { value: '0212 555 00 00' } })
  fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Örnek Cad. 1' } })
  fireEvent.change(screen.getByLabelText('İl'), { target: { value: 'İstanbul' } })
  fireEvent.change(screen.getByLabelText('İlçe'), { target: { value: 'Kadıköy' } })
  fireEvent.click(button(/İşletme Bilgilerini Kaydet/))
  expect(await screen.findByText('İşletme bilgileri kaydedildi.')).toBeTruthy()
  const put = calls.find((call) => call.method === 'PUT')
  expect(put?.url).toBe('/api/organization/profile')
  expect(JSON.parse(String(put?.body))).toEqual({ name: 'Ada Moda', contactPhone: '0212 555 00 00', addressLine: 'Örnek Cad. 1', city: 'İstanbul', district: 'Kadıköy' })
  await waitFor(() => expect(calls.some((call) => call.url === '/api/onboarding/status')).toBe(true))
})
