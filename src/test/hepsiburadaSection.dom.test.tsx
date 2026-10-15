import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HepsiburadaSection } from '../integrations/HepsiburadaSection'

// ═══ HEPSIBURADA-LIVE-001 — ENTEGRASYONLAR / PAZARYERLERİ (GERÇEK DOM) ═══

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown }
let responder: Responder
let calls: Array<{ url: string; method: string; body: string | null }>

const ACCOUNT = {
  marketplaceAccountId: 'acc-1',
  merchantId: 'm-1001',
  displayName: 'Hepsiburada • m-1001',
  isActive: true,
  config: {
    merchantId: 'm-1001',
    usernameMasked: '•••ser',
    hasPassword: true,
    host: 'oms-external-sit.hepsiburada.com',
    environment: 'SIT',
    ordersPath: null,
    packagesPath: '/packages/merchantid/{merchantId}',
    listField: null,
  },
  health: { state: 'NEVER_RUN', reasonCode: null, lastSuccessfulSyncAt: null },
  healthLabel: 'Henüz okuma yapılmadı',
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: (init?.body as string) ?? null })
      const { status, body } = responder(String(url), init)
      return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('HB-UI-1: iç test rozeti, dürüst metin ("canlı" iddiası yok); parola DEĞERİ hiçbir yerde yok', async () => {
  responder = () => ({ status: 200, body: { ok: true, accounts: [ACCOUNT] } })
  render(<HepsiburadaSection expanded />)
  expect(await screen.findByText('Hepsiburada • m-1001')).toBeTruthy()
  expect(screen.getByTestId('hepsiburada-rollout-badge').textContent).toBe('SİPARİŞ OKUMA')
  const section = screen.getByTestId('hepsiburada-section').textContent ?? ''
  expect(section).toMatch(/hesabınız güvenli bir okuma isteğiyle doğrulanır/)
  expect(section).toMatch(/Hesap doğrulanmadı/)
  expect(section).toMatch(/Siparişler pasif/)
  expect(section).toMatch(/yol girilmezse istek gönderilmez/)
  expect(section).not.toMatch(/Canlı bağlantı|canlıda/)
  expect(screen.getByText('Parola kayıtlı')).toBeTruthy()
  expect(screen.getByText('Henüz okuma yapılmadı')).toBeTruthy()
  expect((document.getElementById('hb-password') as HTMLInputElement).value).toBe('')
})

test('HB-UI-2: Düzenle parolayı/kullanıcı adını GERİ DOLDURMAZ; kayıt sonrası parola alanı boşalır', async () => {
  responder = (url, init) => {
    if (init?.method === 'POST' && url.endsWith('/api/integrations/hepsiburada/accounts')) {
      return { status: 200, body: { ok: true, message: 'Hepsiburada yapılandırması kaydedildi.' } }
    }
    return { status: 200, body: { ok: true, accounts: [ACCOUNT] } }
  }
  render(<HepsiburadaSection expanded />)
  await screen.findByText('Hepsiburada • m-1001')
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }))
  expect((document.getElementById('hb-merchant-id') as HTMLInputElement).value).toBe('m-1001')
  expect((document.getElementById('hb-host') as HTMLInputElement).value).toBe('oms-external-sit.hepsiburada.com')
  expect((document.getElementById('hb-packages-path') as HTMLInputElement).value).toBe('/packages/merchantid/{merchantId}')
  expect((document.getElementById('hb-username') as HTMLInputElement).value).toBe('')
  expect((document.getElementById('hb-password') as HTMLInputElement).value).toBe('')
  fireEvent.change(document.getElementById('hb-password') as HTMLInputElement, { target: { value: 'yeni-parola' } })
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri Kaydet' }))
  await screen.findByText('Hepsiburada yapılandırması kaydedildi.')
  const post = calls.find((call) => call.method === 'POST')
  expect(JSON.parse(String(post?.body))).toMatchObject({ merchantId: 'm-1001', password: 'yeni-parola', username: '' })
  expect((document.getElementById('hb-password') as HTMLInputElement).value).toBe('')
})

test('HB-UI-3: Test Et / Senkronize Et hesap kimliğiyle çağrılır; iç test notu ve yapılandırma hatası dürüstçe gösterilir', async () => {
  let syncResponse = { status: 200, body: { ok: true, outcome: 'SUCCESS', fetched: 3, note: 'İç test aşaması: okunan siparişler canlı sipariş, kargo ve etiket akışına aktarılmadı.' } }
  responder = (url) => {
    if (url.endsWith('/accounts/sync')) return syncResponse
    if (url.endsWith('/accounts/test')) return { status: 200, body: { ok: true, recordsRead: 1, message: 'Bu iç test aşamasıdır.' } }
    return { status: 200, body: { ok: true, accounts: [ACCOUNT] } }
  }
  render(<HepsiburadaSection expanded />)
  await screen.findByText('Hepsiburada • m-1001')
  fireEvent.click(screen.getByRole('button', { name: /Siparişleri Senkronize Et|Senkronize Et/ }))
  expect(await screen.findByText(/3 kayıt okundu\. İç test aşaması/)).toBeTruthy()
  const syncCall = calls.find((call) => call.url.endsWith('/accounts/sync'))
  expect(JSON.parse(String(syncCall?.body))).toEqual({ marketplaceAccountId: 'acc-1' })

  syncResponse = { status: 409, body: { ok: false, code: 'HB_ENDPOINT_CONFIG_REQUIRED', message: 'Hepsiburada uç nokta yolu yapılandırılmadı veya doğrulanamadı.' } } as never
  await waitFor(() => expect(screen.getByRole('button', { name: 'Senkronize Et' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Senkronize Et' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toMatch(/uç nokta yolu yapılandırılmadı/)

  fireEvent.click(screen.getByRole('button', { name: 'Test Et' }))
  expect(await screen.findByText(/Okuma isteği yanıt verdi \(1 kayıt\)/)).toBeTruthy()
})

test('HB-UI-VERIFICATION: saved credentials remain inactive until exact account is verified; auth failure offers retry', async () => {
  let account = { ...ACCOUNT, verificationStatus: 'unverified', ordersActive: false }
  responder = (url) => {
    if (url.endsWith('/accounts/test')) {
      account = { ...account, verificationStatus: 'auth_failed', ordersActive: false }
      return { status: 200, body: { ok: false, message: 'Kimlik bilgileri reddedildi.' } }
    }
    return { status: 200, body: { ok: true, accounts: [account] } }
  }
  render(<HepsiburadaSection expanded />)
  await screen.findByText('Siparişler pasif')
  expect(screen.queryByText('Bağlı — Hesap doğrulandı')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Test Et' }))
  await screen.findByText('Doğrulama başarısız')
  expect(screen.getByText('Siparişler pasif')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Test Et' }).hasAttribute('disabled')).toBe(false)
})
