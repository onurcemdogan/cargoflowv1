import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ShippingPayerSection } from '../integrations/ShippingPayerSection'

// ═══ BILLING-PARTY-CLOSEOUT-002 — GERÇEK UI GİDİŞ-DÖNÜŞÜ ═══════════════
//
// Bu dosya sunum yardımcısını DEĞİL, gerçek bileşeni sürer: yükleme →
// seçim → POST → SUNUCUDAN yeniden okuma → kalıcı değerin render'ı.
//
// En tehlikeli UI hatası, seçimi İYİMSER gösterip sunucu reddettiğinde
// ekranda "kaydedilmiş" gibi bırakmaktır; o yüzden değer ancak sunucudan
// GERİ OKUNDUĞUNDA görünür.

const TRENDYOL_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const N11_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

function accounts(n11Payer: string) {
  return [
    {
      marketplaceAccountId: TRENDYOL_ID,
      marketplace: 'trendyol',
      displayName: 'Ana Mağaza',
      isActive: true,
      evidenceClass: 'CAN_DERIVE_FROM_ORDER',
      configurable: false,
      payer: 'UNKNOWN',
    },
    {
      marketplaceAccountId: N11_ID,
      marketplace: 'n11',
      displayName: 'n11 Mağaza',
      isActive: true,
      evidenceClass: 'ACCOUNT_CONFIG_REQUIRED',
      configurable: true,
      payer: n11Payer,
    },
  ]
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.unstubAllGlobals()
})

test('PAYER-UI-1: hesaplar yuklenir; Trendyol DUZENLENEMEZ, n11 SECILEBILIR', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true, accounts: accounts('UNKNOWN') }))
  vi.stubGlobal('fetch', fetchMock)

  render(<ShippingPayerSection />)

  expect(await screen.findByText(/n11 · n11 Mağaza/)).toBeTruthy()
  // Trendyol: alan YOK, gerekce GORUNUR.
  expect(screen.getByText(/Sipariş verisinden okunuyor/)).toBeTruthy()
  const selects = screen.getAllByLabelText('Kargo ücretini kim ödüyor?')
  expect(selects).toHaveLength(1)

  // Uc secenek, HICBIRI otomatik secili degil → UNKNOWN.
  const select = selects[0] as HTMLSelectElement
  expect(select.value).toBe('UNKNOWN')
  expect(
    within(select).getAllByRole('option').map((option) => (option as HTMLOptionElement).value),
  ).toEqual(['MARKETPLACE_PAYS', 'SELLER_PAYS', 'UNKNOWN'])

  expect(fetchMock).toHaveBeenCalledWith('/api/shipping/payer', expect.anything())
})

test('PAYER-UI-2: secim → POST → yeniden okuma → KALICI deger render edilir', async () => {
  let saved = 'UNKNOWN'
  const fetchMock = vi.fn(async (_path: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      saved = JSON.parse(String(options.body)).payer
      return jsonResponse({ ok: true })
    }
    return jsonResponse({ ok: true, accounts: accounts(saved) })
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<ShippingPayerSection />)
  const select = (await screen.findByLabelText(
    'Kargo ücretini kim ödüyor?',
  )) as HTMLSelectElement
  expect(select.value).toBe('UNKNOWN')

  await userEvent.selectOptions(select, 'SELLER_PAYS')

  // POST GERCEKTEN atildi ve hesap kimligi tasindi.
  const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
  expect(post).toBeTruthy()
  expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
    marketplaceAccountId: N11_ID,
    payer: 'SELLER_PAYS',
  })

  // Kaydedildi durumu + SUNUCUDAN geri okunan deger.
  expect(await screen.findByText('Kaydedildi')).toBeTruthy()
  await waitFor(() => {
    expect(
      (screen.getByLabelText('Kargo ücretini kim ödüyor?') as HTMLSelectElement).value,
    ).toBe('SELLER_PAYS')
  })
  // En az iki GET: ilk yukleme + kayit sonrasi yeniden okuma.
  const gets = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method !== 'POST')
  expect(gets.length).toBeGreaterThanOrEqual(2)
})

test('PAYER-UI-3: sunucu REDDEDERSE deger DEGISMIS gibi gosterilmez', async () => {
  const fetchMock = vi.fn(async (_path: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      // Sunucu reddetti (or. Trendyol yapilandirilamaz / gecersiz deger).
      return jsonResponse({ ok: false, message: 'reddedildi' }, false)
    }
    return jsonResponse({ ok: true, accounts: accounts('UNKNOWN') })
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<ShippingPayerSection />)
  const select = (await screen.findByLabelText(
    'Kargo ücretini kim ödüyor?',
  )) as HTMLSelectElement
  await userEvent.selectOptions(select, 'MARKETPLACE_PAYS')

  expect(await screen.findByText('Kaydedilemedi')).toBeTruthy()
  // IYIMSER YAZMA YOK: deger hala sunucunun soyledigi.
  await waitFor(() => {
    expect(
      (screen.getByLabelText('Kargo ücretini kim ödüyor?') as HTMLSelectElement).value,
    ).toBe('UNKNOWN')
  })
})

test('PAYER-UI-4: yukleme hatasi ACIKCA gosterilir, sahte veri URETILMEZ', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: false }, false))
  vi.stubGlobal('fetch', fetchMock)

  render(<ShippingPayerSection />)
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Ödeyen ayarları okunamadı.',
  )
  expect(screen.queryByLabelText('Kargo ücretini kim ödüyor?')).toBeNull()
})

test('PAYER-UI-5: UI SIR TASIMAZ ve otomatik tasiyici secimi YAPMAZ', async () => {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true, accounts: accounts('UNKNOWN') }))
  vi.stubGlobal('fetch', fetchMock)

  const { container } = render(<ShippingPayerSection />)
  await screen.findByText(/n11 · n11 Mağaza/)
  const html = container.innerHTML
  for (const secret of ['apiKey', 'apiSecret', 'password', 'token', 'consumer_secret']) {
    expect(html).not.toContain(secret)
  }
  // Tasiyici adina gore ON SECIM yok.
  for (const carrier of ['Aras', 'Sürat', 'Surat']) {
    expect(html).not.toContain(carrier)
  }
  expect(
    (screen.getByLabelText('Kargo ücretini kim ödüyor?') as HTMLSelectElement).value,
  ).toBe('UNKNOWN')
})
