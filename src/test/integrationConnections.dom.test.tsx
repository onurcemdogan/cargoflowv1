import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AccountReadStatus } from '../integrations/AccountReadStatus'
import { ArasSection } from '../integrations/ArasSection'
import { HepsiburadaSection } from '../integrations/HepsiburadaSection'
import { N11Section } from '../integrations/N11Section'
import { IkasSection } from '../integrations/IkasSection'
import { WooCommerceSection } from '../integrations/WooCommerceSection'
import { IntegrationsPage } from '../pages/IntegrationsPage'
import { defaultIntegrationConfig } from '../services/integrationConfigService'

const HB = {
  marketplaceAccountId: 'hb-1',
  merchantId: 'merchant-long-safe-123456789',
  displayName: 'HB örnek mağaza',
  isActive: true,
  config: {
    merchantId: 'merchant-long-safe-123456789',
    usernameMasked: '••••abcd',
    hasPassword: true,
    host: 'example-sit.hepsiburada.com',
    environment: 'SIT',
    packagesPath: null,
    ordersPath: null,
    listField: null,
  },
  health: { state: 'NEVER_RUN', reasonCode: null, lastSuccessfulSyncAt: null },
  verificationStatus: 'unverified',
  ordersActive: false,
}
const N11 = {
  marketplaceAccountId: 'n11-1',
  displayName: 'n11 örnek mağaza',
  isActive: true,
  config: { appKeyMasked: '••••abcd', hasAppSecret: true, sellerId: null },
  health: {
    state: 'OK',
    reasonCode: 'N11_EPOCH_SEMANTICS_UNVERIFIED',
    lastSuccessfulSyncAt: null,
  },
  verificationStatus: 'verified',
  ordersActive: true,
}
const WOO = {
  marketplaceAccountId: 'woo-1',
  displayName: 'Woo örnek mağaza',
  providerAccountId: 'example.invalid',
  storeUrl: 'https://example.invalid',
  isActive: true,
  consumerKeyMasked: '••••abcd',
  hasConsumerSecret: true,
  hasWebhookSecret: true,
  verificationStatus: 'unverified',
}
const IKAS = {
  marketplaceAccountId: 'ikas-1',
  displayName: 'ikas örnek mağaza',
  providerAccountId: 'sample',
  storeName: 'sample',
  isActive: true,
  clientIdMasked: '••••abcd',
  hasClientSecret: true,
}
const ARAS = {
  marketplaceAccountId: 'aras-1',
  displayName: 'Aras örnek hesap',
  isActive: true,
  configured: true,
  verificationStatus: 'unverified',
}
const names = {
  trendyol: 'Trendyol',
  surat: 'Sürat Kargo',
  hepsiburada: 'Hepsiburada',
  n11: 'n11',
  woocommerce: 'WooCommerce',
  ikas: 'ikas',
  aras: 'Aras Kargo',
}
const board = Object.entries(names).map(([providerKey, displayName]) => ({
  providerKey,
  displayName,
  kind:
    providerKey === 'surat' || providerKey === 'aras'
      ? 'shipping'
      : providerKey === 'woocommerce' || providerKey === 'ikas'
        ? 'commerce_platform'
        : 'marketplace',
  implementationStage: 'implemented',
  rolloutStage: 'internal_test',
  availability: 'internal_test',
  health: {
    state: 'configured',
    configured: true,
    verified: false,
    lastVerifiedAt: null,
    lastSuccessfulSyncAt: null,
    accountCount: 1,
  },
}))
let calls: Array<{ url: string; method: string; body?: string }>
let respond: (url: string, init?: RequestInit) => Record<string, unknown>

function payload(url: string) {
  if (url === '/api/integrations/catalog') return { ok: true, providers: board }
  if (url.includes('/hepsiburada/accounts')) return { ok: true, accounts: [HB] }
  if (url.includes('/n11/accounts')) return { ok: true, accounts: [N11] }
  if (url.includes('/woocommerce/stores'))
    return { ok: true, stores: [WOO], authorizationAvailable: true }
  if (url.includes('/ikas/stores')) return { ok: true, stores: [IKAS] }
  if (url.includes('/aras/stores')) return { ok: true, stores: [ARAS] }
  if (url === '/api/carrier-accounts')
    return { ok: true, accounts: [], mappings: [], marketplaceAccounts: [] }
  if (url === '/api/shipping/payer') return { ok: true, accounts: [] }
  throw new Error(`Unexpected request: ${url}`)
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  calls = []
  respond = (url) => payload(url)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body as string | undefined,
      })
      return {
        ok: true,
        status: 200,
        json: async () => respond(String(url), init),
      } as Response
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete document.documentElement.dataset.theme
})

test.each([
  ['hepsiburada', HepsiburadaSection],
  ['n11', N11Section],
  ['woocommerce', WooCommerceSection],
  ['ikas', IkasSection],
  ['aras', ArasSection],
] as const)(
  '%s shares connection/account/form presentation and loads persisted metadata only',
  async (provider, Component) => {
    const { container } = render(<Component />)
    await waitFor(() =>
      expect(
        container.querySelector('.integration-connection-account'),
      ).toBeTruthy(),
    )
    const section = container.querySelector(
      `[data-provider-management="${provider}"]`,
    ) as HTMLElement
    expect(section.classList.contains('ui-card')).toBe(true)
    expect(section.querySelector('.integration-connection-header')).toBeTruthy()
    expect(section.querySelector('.integration-account-facts')).toBeTruthy()
    expect(
      section.querySelector('.integration-connection-form .ui-field'),
    ).toBeTruthy()
    expect(
      section.querySelector('.integration-connection-actions .ui-btn'),
    ).toBeTruthy()
    expect(section.getAttribute('style')).toBeNull()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    const secrets = section.querySelectorAll<HTMLInputElement>(
      'input[type="password"]',
    )
    expect(secrets.length).toBeGreaterThan(0)
    expect([...secrets].every((field) => field.value === '')).toBe(true)
    expect(section.textContent).not.toMatch(
      /Canlı bağlantı|üretimde kullanılabilir/i,
    )
  },
)

test('configured credentials never become verified; read activation cannot enable blocked n11 checkpoints', async () => {
  const { container } = render(
    <>
      <HepsiburadaSection />
      <N11Section />
    </>,
  )
  await screen.findByText('HB örnek mağaza')
  const hb = container.querySelector(
    '[data-provider-management="hepsiburada"]',
  ) as HTMLElement
  expect(
    within(hb).getByText('Bilgiler kaydedildi — Hesap doğrulanmadı'),
  ).toBeTruthy()
  expect(within(hb).getByText('Siparişler pasif')).toBeTruthy()
  expect(within(hb).getByText('Paket yolu yok')).toBeTruthy()
  expect(within(hb).getByText('Sipariş yolu yok')).toBeTruthy()
  expect(
    (document.getElementById('hb-packages-path') as HTMLInputElement).value,
  ).toBe('')
  const n11 = container.querySelector(
    '[data-provider-management="n11"]',
  ) as HTMLElement
  expect(within(n11).getByText('Bağlı — Hesap doğrulandı')).toBeTruthy()
  expect(within(n11).getByText('Siparişler aktif')).toBeTruthy()
  expect(within(n11).getByText(/Senkronizasyon imleci engelli/)).toBeTruthy()
  expect(
    within(n11).getByText(/N11_EPOCH_SEMANTICS_UNVERIFIED · BLOCKED_EXTERNAL/),
  ).toBeTruthy()
  expect(within(n11).getByText('Satıcı henüz okunmadı')).toBeTruthy()
})

test.each(['light', 'dark'])(
  'AccountReadStatus keeps evidence gates and shared theme classes in %s theme',
  (theme) => {
    document.documentElement.dataset.theme = theme
    const { rerender } = render(
      <AccountReadStatus
        isActive
        configured
        verificationStatus="unverified"
        ordersActive
      />,
    )
    expect(screen.getByText('Siparişler pasif')).toBeTruthy()
    expect(screen.getByRole('status').className).toContain('tone-warning')
    rerender(
      <AccountReadStatus
        isActive
        configured={false}
        verificationStatus="verified"
        ordersActive
      />,
    )
    expect(screen.getByText('Bağlı değil')).toBeTruthy()
    expect(screen.getByText('Siparişler pasif')).toBeTruthy()
    rerender(
      <AccountReadStatus
        isActive
        configured
        verificationStatus="verified"
        ordersActive
        verifying
      />,
    )
    expect(screen.getByText('Doğrulanıyor…')).toBeTruthy()
    expect(screen.getByText('Siparişler pasif')).toBeTruthy()
    rerender(
      <AccountReadStatus
        isActive
        configured
        verificationStatus="verified"
        ordersActive
      />,
    )
    expect(screen.getByText('Siparişler aktif')).toBeTruthy()
    expect(screen.getByRole('status').className).toContain('tone-success')
  },
)

function pageProps() {
  return {
    config: defaultIntegrationConfig,
    busy: false,
    onSave: vi.fn(),
    onTestTrendyol: vi.fn(),
    onTestSurat: vi.fn(),
    onFetchOrders: vi.fn(),
    onFetchProducts: vi.fn(),
  }
}

test('all seven status-board items focus the actual management surface; navigation cannot test/sync/write', async () => {
  const props = pageProps()
  render(<IntegrationsPage {...props} />)
  const overview = screen.getByRole('region', { name: 'Entegrasyon durumu' })
  await within(overview).findByRole('button', { name: /Hepsiburada/ })
  for (const [provider, name] of Object.entries(names)) {
    fireEvent.click(
      within(overview).getByRole('button', { name: new RegExp(name) }),
    )
    await waitFor(() =>
      expect(
        document.activeElement?.getAttribute('data-provider-management'),
      ).toBe(provider),
    )
  }
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
  for (const action of [
    props.onSave,
    props.onTestTrendyol,
    props.onTestSurat,
    props.onFetchOrders,
    props.onFetchProducts,
  ])
    expect(action).not.toHaveBeenCalled()
  const aras = document.querySelector(
    '[data-provider-management="aras"]',
  ) as HTMLElement
  expect(aras.closest('form')).toBeNull()
  expect(within(aras).getByText('Canlı gönderi kapalı')).toBeTruthy()
})

test('Trendyol/Sürat primary handlers are unchanged and opening their panels performs no operation', async () => {
  const props = pageProps()
  render(<IntegrationsPage {...props} />)
  await screen.findByText('HB örnek mağaza')
  const trendyol = screen
    .getByRole('heading', { name: 'Trendyol' })
    .closest('section') as HTMLElement
  fireEvent.click(within(trendyol).getByRole('button', { name: 'Ayarlar' }))
  expect(props.onSave).not.toHaveBeenCalled()
  expect(props.onTestTrendyol).not.toHaveBeenCalled()
  fireEvent.click(
    within(trendyol).getByRole('button', { name: 'Senkronize Et' }),
  )
  expect(props.onFetchOrders).toHaveBeenCalledTimes(1)
  fireEvent.click(
    screen.getByRole('button', { name: 'Kargo Firmaları' }),
  )
  const surat = screen
    .getByRole('heading', { name: 'Sürat Kargo' })
    .closest('section') as HTMLElement
  fireEvent.click(within(surat).getByRole('button', { name: 'Ayarlar' }))
  expect(props.onTestSurat).not.toHaveBeenCalled()
  fireEvent.click(within(surat).getByRole('button', { name: 'Test Et' }))
  expect(props.onTestSurat).toHaveBeenCalledTimes(1)
  expect(calls.every((call) => call.method === 'GET')).toBe(true)
})

test('Aras has only existing explicit account save, clears password and never offers a live shipment action', async () => {
  respond = (url, init) =>
    init?.method === 'POST'
      ? { ok: true, message: 'Kaydedildi. Aras Kargo iç testtedir.' }
      : payload(url)
  render(<ArasSection />)
  await screen.findByText('Aras örnek hesap')
  expect(screen.getByText('Kayıtlı, doğrulanmadı')).toBeTruthy()
  expect(
    screen.queryByRole('button', { name: /Gönderi|Etiket|Doğrula|Test Et/ }),
  ).toBeNull()
  fireEvent.change(screen.getByLabelText('Kullanıcı adı'), {
    target: { value: 'synthetic-user' },
  })
  fireEvent.change(screen.getByLabelText('Şifre'), {
    target: { value: 'synthetic-secret' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }))
  await screen.findByText('Kaydedildi. Aras Kargo iç testtedir.')
  const writes = calls.filter((call) => call.method !== 'GET')
  expect(writes).toHaveLength(1)
  expect(writes[0].url).toBe('/api/integrations/aras/stores')
  expect(JSON.parse(writes[0].body ?? '{}')).toEqual({
    userName: 'synthetic-user',
    password: 'synthetic-secret',
    displayName: '',
  })
  expect((screen.getByLabelText('Şifre') as HTMLInputElement).value).toBe('')
})
