import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { N11Section } from '../integrations/N11Section'
import { IntegrationStatusBoard } from '../integrations/IntegrationStatusBoard'
import type { IntegrationStatusEntry } from '../services/integrationStatusClient'

// ═══ N11-LIVE-001 — ENTEGRASYONLAR / PAZARYERLERİ (GERÇEK DOM) ═══

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown }
let responder: Responder
let calls: Array<{ url: string; method: string; body: string | null }>

const ACCOUNT = {
  marketplaceAccountId: 'acc-n11',
  displayName: 'n11 • Satıcı 9876543',
  isActive: true,
  config: { appKeyMasked: '•••123', hasAppSecret: true, sellerId: '9876543' },
  health: { state: 'OK', reasonCode: 'N11_CANONICAL_WRITE_BLOCKED', lastSuccessfulSyncAt: null, lastAttemptAt: '2026-10-13T12:00:00.000Z' },
  healthLabel: 'Son okuma başarılı (iç test: kayıtlar sisteme yazılmadı, imleç ilerlemedi)',
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

test('N11-UI-1: iç test rozeti; dürüst metin (canlı doğrulama yok, yazma kapalı); sır DEĞERİ hiçbir yerde yok', async () => {
  responder = () => ({ status: 200, body: { ok: true, accounts: [ACCOUNT] } })
  render(<N11Section expanded />)
  expect(await screen.findByText('n11 • Satıcı 9876543')).toBeTruthy()
  expect(screen.getByTestId('n11-rollout-badge').textContent).toBe('SİPARİŞ OKUMA')
  const section = screen.getByTestId('n11-section').textContent ?? ''
  expect(section).toMatch(/hesabınız güvenli bir okuma isteğiyle doğrulanır/)
  expect(section).toMatch(/Hesap doğrulanmadı/)
  expect(section).toMatch(/Siparişler pasif/)
  expect(section).toMatch(/Pazaryeri yazmaları .* kapalıdır/)
  expect(section).not.toMatch(/Canlı bağlantı|canlıda|etiket alın|etiket indir/i)
  expect(screen.getByText('API şifresi kayıtlı')).toBeTruthy()
  expect(screen.getByText('API anahtarı: •••123')).toBeTruthy()
  expect(screen.getByText(/iç test: kayıtlar sisteme yazılmadı, imleç ilerlemedi/)).toBeTruthy()
  expect((document.getElementById('n11-app-secret') as HTMLInputElement).value).toBe('')
  expect((document.getElementById('n11-app-key') as HTMLInputElement).value).toBe('')
  // Yalnız gerçekten gereken alanlar: host / yol / liste alanı İSTENMEZ.
  expect(document.querySelectorAll('[data-testid="n11-section"] input').length).toBe(2)
})

test('N11-UI-2: Düzenle appKey/appSecret GERİ DOLDURMAZ; hesap kimliğiyle kaydeder; kayıt sonrası alanlar boşalır', async () => {
  responder = (url, init) => {
    if (init?.method === 'POST' && url.endsWith('/api/integrations/n11/accounts')) {
      return { status: 200, body: { ok: true, message: 'n11 API bilgileri kaydedildi.' } }
    }
    return { status: 200, body: { ok: true, accounts: [ACCOUNT] } }
  }
  render(<N11Section expanded />)
  await screen.findByText('n11 • Satıcı 9876543')
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }))
  expect((document.getElementById('n11-app-key') as HTMLInputElement).value).toBe('')
  expect((document.getElementById('n11-app-secret') as HTMLInputElement).value).toBe('')
  fireEvent.change(document.getElementById('n11-app-secret') as HTMLInputElement, { target: { value: 'yeni-sir' } })
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri Kaydet' }))
  await screen.findByText('n11 API bilgileri kaydedildi.')
  const post = calls.find((call) => call.method === 'POST')
  expect(JSON.parse(String(post?.body))).toEqual({ appKey: '', appSecret: 'yeni-sir', marketplaceAccountId: 'acc-n11' })
  expect((document.getElementById('n11-app-secret') as HTMLInputElement).value).toBe('')
})

test('N11-UI-3: Test Et / Senkronize Et hesap kimliğiyle çağrılır; iç test notu ve hata dürüstçe gösterilir', async () => {
  let syncResponse: { status: number; body: unknown } = {
    status: 200,
    body: { ok: true, outcome: 'SUCCESS', fetched: 4, message: 'İç test aşaması: okunan siparişler canlı sipariş, kargo ve etiket akışına aktarılmadı; imleç ilerlemedi.' },
  }
  responder = (url) => {
    if (url.endsWith('/accounts/sync')) return syncResponse
    if (url.endsWith('/accounts/test')) return { status: 200, body: { ok: true, recordsRead: 1, message: 'Bu iç test aşamasıdır.' } }
    return { status: 200, body: { ok: true, accounts: [ACCOUNT] } }
  }
  render(<N11Section expanded />)
  await screen.findByText('n11 • Satıcı 9876543')
  fireEvent.click(screen.getByRole('button', { name: /Siparişleri Senkronize Et|Senkronize Et/ }))
  expect(await screen.findByText(/4 kayıt okundu\. İç test aşaması/)).toBeTruthy()
  expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/accounts/sync'))?.body))).toEqual({ marketplaceAccountId: 'acc-n11' })

  syncResponse = { status: 200, body: { ok: false, code: 'N11_AUTH_ERROR', message: 'n11 API bilgileri reddedildi.' } }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Senkronize Et' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Senkronize Et' }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/reddedildi/)

  fireEvent.click(screen.getByRole('button', { name: 'Test Et' }))
  expect(await screen.findByText(/Okuma isteği yanıt verdi \(1 kayıt\)/)).toBeTruthy()
})

test('N11-UI-4: durum panosu n11\'i "İç test"te gösterir (Canlı DEĞİL) ve tıklanınca n11 açılır', async () => {
  const entry: IntegrationStatusEntry = {
    providerKey: 'n11', displayName: 'n11', kind: 'marketplace', implementationStage: 'implemented',
    rolloutStage: 'internal_test', availability: 'internal_test',
    health: { state: 'configured', configured: true, verified: false, lastVerifiedAt: null, lastSuccessfulSyncAt: null, accountCount: 1 },
  }
  const onOpen = vi.fn()
  render(<IntegrationStatusBoard onOpen={onOpen} load={async () => [entry]} />)
  const button = await screen.findByRole('button', { name: /n11/ })
  const internalGroup = screen.getByText('İç test').closest('.integration-board-group') as HTMLElement
  expect(within(internalGroup).getByText('n11')).toBeTruthy()
  expect(screen.queryByText('Canlı')?.closest('.integration-board-group')?.textContent ?? '').not.toMatch(/n11/)
  fireEvent.click(button)
  expect(onOpen).toHaveBeenCalledWith('n11')
})

test('N11-UI-VERIFICATION: Test Et reloads persisted evidence; credential save invalidates old verification and keeps retry available', async () => {
  let account = { ...ACCOUNT, verificationStatus: 'unverified', ordersActive: false }
  responder = (url, init) => {
    if (url.endsWith('/accounts/test')) {
      account = { ...account, verificationStatus: 'verified', ordersActive: true }
      return { status: 200, body: { ok: true, message: 'Hesap doğrulandı.', recordsRead: 0 } }
    }
    if (url.endsWith('/accounts') && init?.method === 'POST') {
      account = { ...account, verificationStatus: 'provider_unavailable', ordersActive: false }
      return { status: 200, body: { ok: true, credentialsSaved: true, message: 'Bilgiler kaydedildi; sağlayıcı geçici olarak kullanılamıyor.' } }
    }
    return { status: 200, body: { ok: true, accounts: [account] } }
  }
  render(<N11Section expanded />)
  await screen.findByText('Siparişler pasif')
  expect(screen.queryByText('Bağlı — Hesap doğrulandı')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Test Et' }))
  await screen.findByText('Siparişler aktif')
  expect(screen.getByText('Bağlı — Hesap doğrulandı')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }))
  fireEvent.change(document.getElementById('n11-app-secret') as HTMLInputElement, { target: { value: 'rotated-fixture' } })
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri Kaydet' }))
  await screen.findByText('Bilgiler kaydedildi — Sağlayıcı geçici olarak kullanılamıyor')
  expect(screen.queryByText('Siparişler aktif')).toBeNull()
  expect(screen.getByText('Siparişler pasif')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Test Et' }).hasAttribute('disabled')).toBe(false)
  expect((document.getElementById('n11-app-secret') as HTMLInputElement).value).toBe('')
})
