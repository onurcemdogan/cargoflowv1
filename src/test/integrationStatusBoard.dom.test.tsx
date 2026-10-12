import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { IntegrationStatusBoard } from '../integrations/IntegrationStatusBoard'
import type { IntegrationStatusEntry } from '../services/integrationStatusClient'

// ═══ PHASE2-E — DURUM PANOSU SUNUCU KATALOĞUNDAN BESLENİR (GERÇEK DOM) ═══

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const health = (state: IntegrationStatusEntry['health']['state'], over: Partial<IntegrationStatusEntry['health']> = {}) => ({
  state,
  configured: state !== 'not_configured' && state !== 'not_available',
  verified: state === 'verified',
  lastVerifiedAt: null,
  lastSuccessfulSyncAt: null,
  accountCount: 0,
  ...over,
})

const entry = (over: Partial<IntegrationStatusEntry>): IntegrationStatusEntry => ({
  providerKey: 'x',
  displayName: 'X',
  kind: 'marketplace',
  implementationStage: 'implemented',
  rolloutStage: 'internal_test',
  availability: 'internal_test',
  health: health('not_configured'),
  ...over,
})

const BOARD: IntegrationStatusEntry[] = [
  entry({ providerKey: 'trendyol', displayName: 'Trendyol', implementationStage: 'production', rolloutStage: 'ga', availability: 'live', health: health('verified', { lastSuccessfulSyncAt: '2026-10-11T09:00:00.000Z' }) }),
  entry({ providerKey: 'surat', displayName: 'Sürat Kargo', kind: 'shipping', implementationStage: 'production', rolloutStage: 'ga', availability: 'live', health: health('auth_error') }),
  // Bağlantısı doğrulanmış olsa bile iç testteki sağlayıcı "Canlı" grubuna GİRMEZ.
  entry({ providerKey: 'woocommerce', displayName: 'WooCommerce', kind: 'commerce_platform', health: health('verified') }),
  entry({ providerKey: 'aras', displayName: 'Aras Kargo', kind: 'shipping', health: health('configured') }),
  entry({ providerKey: 'n11', displayName: 'n11', implementationStage: 'in_development', rolloutStage: 'off', availability: 'in_development', health: health('not_available') }),
  entry({ providerKey: 'gizli', displayName: 'Gizli Sağlayıcı', rolloutStage: 'off', availability: 'hidden' }),
]

const group = (title: string) => {
  const head = screen.getByText(title, { selector: '.integration-board-group-title' })
  return head.closest('.integration-board-group') as HTMLElement
}

test('ISB-1: grup sunucunun availability alanından, rozet bağlantı sağlığından gelir', async () => {
  render(<IntegrationStatusBoard onOpen={() => {}} load={async () => BOARD} />)
  await screen.findByText('Trendyol')

  const live = group('Canlı')
  expect(within(live).getByText('Trendyol')).toBeTruthy()
  expect(within(live).getByText('Sürat Kargo')).toBeTruthy()
  expect(within(live).queryByText('WooCommerce')).toBeNull()
  expect(within(live).getByText('Bağlantı doğrulandı')).toBeTruthy()
  expect(within(live).getByText('Giriş bilgileri reddedildi')).toBeTruthy()
  expect(within(live).getByText(/Son senkron 11\.10\.2026/)).toBeTruthy()

  const internal = group('İç test')
  expect(within(internal).getByText('WooCommerce')).toBeTruthy()
  expect(within(internal).getByText('Kayıtlı, doğrulanmadı')).toBeTruthy()

  const development = group('Geliştiriliyor')
  expect(within(development).getByText('n11')).toBeTruthy()
  expect(within(development).getByText('Bağlantı açılmaz')).toBeTruthy()

  // Yayın aşaması kapalı (hidden) sağlayıcı hiç listelenmez.
  expect(screen.queryByText('Gizli Sağlayıcı')).toBeNull()
})

test('ISB-2: yalnız bağlanabilir sağlayıcılar açılır; geliştirilen sağlayıcı tıklanamaz', async () => {
  const onOpen = vi.fn()
  render(<IntegrationStatusBoard onOpen={onOpen} load={async () => BOARD} />)
  fireEvent.click(await screen.findByRole('button', { name: /WooCommerce/ }))
  expect(onOpen).toHaveBeenCalledWith('woocommerce')
  expect(screen.queryByRole('button', { name: /n11/ })).toBeNull()
})

test('ISB-3: uç okunamazsa sabit durum UYDURULMAZ — yalnız bilgi notu', async () => {
  render(<IntegrationStatusBoard onOpen={() => {}} load={async () => Promise.reject(new Error('down'))} />)
  expect(await screen.findByText(/Bağlantı durumu şu an okunamıyor/)).toBeTruthy()
  expect(screen.queryByText('Canlı')).toBeNull()
  expect(screen.queryByText('Trendyol')).toBeNull()
})

test('ISB-4: varsayılan yükleyici kiracı oturumuyla /api/integrations/catalog okur', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, providers: BOARD }) }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  render(<IntegrationStatusBoard onOpen={() => {}} />)
  await screen.findByText('Trendyol')
  expect(fetchMock).toHaveBeenCalledWith('/api/integrations/catalog', { credentials: 'include' })
})

test('ISB-5: refreshKey değişince durum yeniden okunur', async () => {
  const load = vi.fn(async () => BOARD)
  const { rerender } = render(<IntegrationStatusBoard onOpen={() => {}} load={load} refreshKey="a" />)
  await screen.findByText('Trendyol')
  rerender(<IntegrationStatusBoard onOpen={() => {}} load={load} refreshKey="b" />)
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
})
