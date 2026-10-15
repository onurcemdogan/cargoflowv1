import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CarrierAccountsSection } from '../integrations/CarrierAccountsSection'

// ═══ PHASE2-C — KARGO HESAPLARI + EŞLEME (GERÇEK DOM) ════════════════════

let calls: Array<{ url: string; method: string; body: string | null }>
let payload: unknown

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: (init?.body as string) ?? null })
      if (init?.method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response
      return { ok: true, status: 200, json: async () => payload } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SURAT = { id: 'c1', provider: 'surat', displayName: 'Sürat Kargo', externalAccountRef: '123456789', verificationStatus: 'verified', lastVerifiedAt: '2026-10-12T09:00:00.000Z', enabled: true }
const ARAS = { id: 'c2', provider: 'aras', displayName: 'Aras Depo', externalAccountRef: null, verificationStatus: 'unverified', lastVerifiedAt: null, enabled: true }

test('CA-UI-1: hesaplar doğrulama durumuyla; müşteri kodu maskeli; belirsiz eşleme açıkça söylenir', async () => {
  payload = {
    ok: true,
    accounts: [SURAT, ARAS],
    mappings: [],
    marketplaceAccounts: [{ id: 'm1', marketplace: 'Trendyol', displayName: 'Ana Mağaza', isActive: true, resolution: { ok: false, code: 'CARRIER_ACCOUNT_AMBIGUOUS' } }],
  }
  render(<CarrierAccountsSection />)
  expect(await screen.findByText('Doğrulandı')).toBeTruthy()
  expect(screen.getByText('Doğrulanmadı')).toBeTruthy()
  expect(screen.getByText('Müşteri kodu ••••6789')).toBeTruthy()
  expect(document.body.textContent).not.toContain('123456789')
  expect(screen.getByText('Birden çok hesap var — bir hesap seçin')).toBeTruthy()
})

test('CA-UI-2: eşleme seçimi PUT eder ve durumu yeniden okur; organizationId GÖNDERİLMEZ', async () => {
  payload = {
    ok: true,
    accounts: [SURAT],
    mappings: [],
    marketplaceAccounts: [{ id: 'm1', marketplace: 'Trendyol', displayName: 'Ana Mağaza', isActive: true, resolution: { ok: true, account: SURAT, source: 'ONLY_ACCOUNT_FOR_PROVIDER' } }],
  }
  render(<CarrierAccountsSection />)
  const select = await screen.findByLabelText(/Ana Mağaza siparişleri/)
  expect(screen.getByText('Gönderiler Sürat Kargo hesabıyla oluşturulur.')).toBeTruthy()
  fireEvent.change(select, { target: { value: 'c1' } })
  await waitFor(() => expect(calls.filter((call) => call.url === '/api/carrier-accounts').length).toBe(2))
  const put = calls.find((call) => call.method === 'PUT')
  expect(put?.url).toBe('/api/carrier-accounts/mappings')
  expect(JSON.parse(String(put?.body))).toEqual({ marketplaceAccountId: 'm1', carrierAccountId: 'c1' })
})

test('CA-UI-3: legacy modda (uç yok) bölüm gösterilmez', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response))
  const { container } = render(<CarrierAccountsSection />)
  await waitFor(() => expect(container.textContent).toBe(''))
})

test('SMA-E/F: old Trendyol is not a mapping choice even in a mixed response; viewing does not write', async () => {
  const resolution = { ok: true, account: SURAT, source: 'ONLY_ACCOUNT_FOR_PROVIDER' }
  payload = {
    ok: true, accounts: [SURAT], mappings: [{ marketplaceAccountId: 'retired', carrierAccountId: SURAT.id }],
    marketplaceAccounts: [
      { id: 'retired', marketplace: 'Trendyol', displayName: 'Trendyol • 111', isActive: false, resolution },
      { id: 'current', marketplace: 'Trendyol', displayName: 'Trendyol • 222', isActive: true, resolution },
      { id: 'other', marketplace: 'n11', displayName: 'n11 Mağaza', isActive: false, resolution },
    ],
  }
  render(<CarrierAccountsSection />)
  expect(await screen.findByRole('combobox', { name: /^Trendyol · 222 siparişleri/ })).toBeTruthy()
  expect(screen.queryByText(/111 siparişleri/)).toBeNull()
  expect(screen.getByRole('combobox', { name: /^n11 Mağaza siparişleri/ })).toBeTruthy()
  expect(screen.getAllByRole('combobox')).toHaveLength(2)
  expect(calls).toEqual([{ url: '/api/carrier-accounts', method: 'GET', body: null }])
})
