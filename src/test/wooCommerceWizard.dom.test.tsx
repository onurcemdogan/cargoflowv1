import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// ═══ PHASE2-F — WOOCOMMERCE BAĞLANTI SİHİRBAZI (GERÇEK DOM) ═════════════

const redirect = vi.hoisted(() => vi.fn())
vi.mock('../integrations/wooAuthReturn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/wooAuthReturn')>()),
  redirectToStore: redirect,
}))

const { WooCommerceSection } = await import('../integrations/WooCommerceSection')

const AUTH_ID = '3f2b9c1e-8a4d-4e6f-9b1a-2c3d4e5f6a7b'
let calls: Array<{ url: string; method: string; body: string | null }>
let storesPayload: Record<string, unknown>
let completePayload: Record<string, unknown>

beforeEach(() => {
  calls = []
  redirect.mockReset()
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  window.sessionStorage.clear()
  storesPayload = { ok: true, stores: [], authorizationAvailable: true }
  completePayload = { ok: true, outcome: 'CONNECTED', step: 'health', message: 'Mağaza bağlandı ve okuma doğrulandı.' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url: String(url), method, body: (init?.body as string) ?? null })
      const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response
      if (url === '/api/integrations/woocommerce/authorizations') {
        return json({ ok: true, authorizationId: AUTH_ID, authorizeUrl: 'https://shop.example.com/wc-auth/v1/authorize?app_name=CargoFlow' })
      }
      if (String(url).endsWith('/complete')) return json(completePayload)
      if (url === '/api/integrations/woocommerce/stores' && method === 'POST') return json({ ok: true })
      return json(storesPayload)
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('WW-1: önerilen yol — mağaza adresi → bağlan → WooCommerce onay ekranı', async () => {
  render(<WooCommerceSection />)
  const input = await screen.findByLabelText('Mağaza adresi')
  fireEvent.change(input, { target: { value: 'https://shop.example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Mağazaya bağlan' }))
  await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://shop.example.com/wc-auth/v1/authorize?app_name=CargoFlow'))
  const start = calls.find((call) => call.url === '/api/integrations/woocommerce/authorizations')
  expect(JSON.parse(start?.body ?? '{}')).toEqual({ storeUrl: 'https://shop.example.com' })
  expect(screen.getByText('İç test')).toBeTruthy()
  expect(screen.getByRole('list', { name: 'Bağlantı adımları' }).textContent).toContain('Okuma doğrulaması')
})

test('WW-2: HTTPS uygulama adresi yoksa sihirbaz kapalıdır; elle anahtar yalnız gelişmiş bölümdedir', async () => {
  storesPayload = { ok: true, stores: [], authorizationAvailable: false }
  render(<WooCommerceSection />)
  expect(await screen.findByText(/Otomatik bağlantı bu ortamda kapalı/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Mağazaya bağlan' })).toBeNull()
  const advanced = screen.getByText('Gelişmiş: REST anahtarıyla bağlan').closest('details') as HTMLDetailsElement
  expect(advanced.open).toBe(false)
  expect(advanced.querySelector('#woo-consumer-secret')).toBeTruthy()
})

test('WW-3: onaydan dönüş — doğrulama tamamlanır, adımlar biter, adres temizlenir', async () => {
  window.history.replaceState(null, '', `/?woo_auth=${AUTH_ID}&success=1&user_id=${AUTH_ID}`)
  storesPayload = {
    ok: true,
    authorizationAvailable: true,
    stores: [{
      marketplaceAccountId: 'm1', providerAccountId: 'shop.example.com', displayName: 'shop.example.com', isActive: true,
      storeUrl: 'https://shop.example.com', consumerKeyMasked: '••••4567', hasConsumerSecret: true, hasWebhookSecret: false,
      verificationStatus: 'verified', lastVerifiedAt: '2026-10-12T10:00:00.000Z',
    }],
  }
  render(<WooCommerceSection />)
  expect(await screen.findByText('Mağaza bağlandı ve okuma doğrulandı.')).toBeTruthy()
  const complete = calls.find((call) => call.url.endsWith(`/authorizations/${AUTH_ID}/complete`))
  expect(JSON.parse(complete?.body ?? '{}')).toEqual({ denied: false })
  expect(window.location.search).toBe('')
  const steps = screen.getByRole('list', { name: 'Bağlantı adımları' }).querySelectorAll('li')
  expect([...steps].every((step) => step.classList.contains('is-done'))).toBe(true)
  expect(await screen.findByText(/Okuma doğrulandı · 12\.10\.2026/)).toBeTruthy()
})

test('WW-4: onay reddedildiyse hata yetkilendirme adımında açıkça gösterilir', async () => {
  window.history.replaceState(null, '', `/?woo_auth=${AUTH_ID}&success=0&user_id=${AUTH_ID}`)
  completePayload = { ok: false, outcome: 'FAILED', step: 'authorization', errorClass: 'DENIED', message: 'Mağazada erişim onaylanmadı.' }
  render(<WooCommerceSection />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Mağazada erişim onaylanmadı.')
  const complete = calls.find((call) => call.url.endsWith('/complete'))
  expect(JSON.parse(complete?.body ?? '{}')).toEqual({ denied: true })
  const failed = screen.getByRole('list', { name: 'Bağlantı adımları' }).querySelector('li.is-failed')
  expect(failed?.textContent).toContain('Yetkilendirme')
})

test('WW-5: elle anahtar kaydı tarayıcıda sır bırakmaz', async () => {
  render(<WooCommerceSection />)
  await screen.findByLabelText('Mağaza adresi')
  fireEvent.change(screen.getByLabelText('Consumer Secret'), { target: { value: 'cs_GIZLI' } })
  fireEvent.click(screen.getByRole('button', { name: 'Bağlantıyı Test Et ve Kaydet' }))
  expect(await screen.findByText('Bağlantı doğrulandı ve kaydedildi.')).toBeTruthy()
  expect((screen.getByLabelText('Consumer Secret') as HTMLInputElement).value).toBe('')
  const dump = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage })
  expect(dump).not.toContain('cs_GIZLI')
})
