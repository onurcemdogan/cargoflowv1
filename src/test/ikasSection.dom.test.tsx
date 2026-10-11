import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IkasSection } from '../integrations/IkasSection'

// ═══ IKAS-001 — ENTEGRASYONLAR / E-TİCARET SİTELERİ (GERÇEK DOM) ═════════

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown }
let responder: Responder
let calls: Array<{ url: string; method: string; body: string | null }>

const STORE_A = {
  marketplaceAccountId: 'acc-A',
  providerAccountId: 'm-A',
  displayName: 'Mağaza A',
  isActive: true,
  storeName: 'magazaa',
  clientIdMasked: '••••id-A',
  hasClientSecret: true,
}
const STORE_B = { ...STORE_A, marketplaceAccountId: 'acc-B', providerAccountId: 'm-B', displayName: 'Mağaza B', storeName: 'magazab' }

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

test('IKAS-UI-1: iç test rozeti ve dürüst metin; her mağaza bağımsız satır; sır DEĞERİ yok', async () => {
  responder = () => ({ status: 200, body: { ok: true, stores: [STORE_A, STORE_B] } })
  render(<IkasSection />)
  expect(await screen.findByText('Mağaza A')).toBeTruthy()
  expect(screen.getByTestId('ikas-rollout-badge').textContent).toBe('İÇ TEST')
  expect(screen.getByTestId('ikas-section').textContent).toMatch(/canlı sipariş, kargo ve etiket akışına aktarılmaz/)
  expect(document.querySelectorAll('[data-ikas-store]')).toHaveLength(2)
  expect(screen.getAllByText('Client Secret kayıtlı')).toHaveLength(2)
  expect((document.getElementById('ikas-client-secret') as HTMLInputElement).value).toBe('')
})

test('IKAS-UI-2: başarılı bağlantıda sır alanı BOŞALTILIR; başarısızda iyimser satır YOK', async () => {
  let stores = [STORE_A]
  responder = (url, init) => {
    if (init?.method === 'POST' && url.endsWith('/api/integrations/ikas/stores')) {
      const body = JSON.parse(String(init.body))
      if (body.clientSecret === 'yanlis') {
        return { status: 422, body: { ok: false, message: 'Client ID / Client Secret kabul edilmedi.' } }
      }
      stores = [STORE_A, STORE_B]
      return { status: 200, body: { ok: true, message: 'ikas bağlantısı doğrulandı ve kaydedildi.' } }
    }
    return { status: 200, body: { ok: true, stores } }
  }
  render(<IkasSection />)
  await screen.findByText('Mağaza A')
  fireEvent.change(screen.getByLabelText('ikas mağaza adı'), { target: { value: 'magazab' } })
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid-B' } })
  fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: 'yanlis' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Bağlantıyı Test Et ve Bağla' }))
  })
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(document.querySelectorAll('[data-ikas-store]')).toHaveLength(1)

  fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: 'SECRET-B' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Bağlantıyı Test Et ve Bağla' }))
  })
  await waitFor(() => expect(document.querySelectorAll('[data-ikas-store]')).toHaveLength(2))
  expect((screen.getByLabelText('Client Secret') as HTMLInputElement).value).toBe('')
  const post = calls.find((call) => call.method === 'POST')
  expect(JSON.parse(post?.body ?? '{}')).not.toHaveProperty('organizationId')
})

test('IKAS-UI-3: sipariş okuma testi yalnız SAYI gösterir; kaldırma yalnız o mağazayı hedefler', async () => {
  let stores = [STORE_A, STORE_B]
  responder = (url, init) => {
    if (url.endsWith('/orders-read-test')) {
      return { status: 200, body: { ok: true, ordersRead: 3, message: 'Sipariş okuma testi tamamlandı (iç test — canlı iş akışına YAZILMADI).' } }
    }
    if (url.endsWith('/disconnect')) {
      const id = JSON.parse(String(init?.body)).marketplaceAccountId
      stores = stores.filter((store) => store.marketplaceAccountId !== id)
      return { status: 200, body: { ok: true } }
    }
    return { status: 200, body: { ok: true, stores } }
  }
  render(<IkasSection />)
  await screen.findByText('Mağaza A')
  const rowA = document.querySelector('[data-ikas-store="acc-A"]') as HTMLElement
  await act(async () => {
    fireEvent.click(rowA.querySelector('button') as HTMLButtonElement)
  })
  expect(await screen.findByText(/3 sipariş okundu/)).toBeTruthy()
  const readCall = calls.find((call) => call.url.endsWith('/orders-read-test'))
  expect(JSON.parse(readCall?.body ?? '{}')).toEqual({ marketplaceAccountId: 'acc-A' })

  const rowB = document.querySelector('[data-ikas-store="acc-B"]') as HTMLElement
  await act(async () => {
    fireEvent.click([...rowB.querySelectorAll('button')].find((b) => b.textContent === 'Bağlantıyı Kaldır') as HTMLButtonElement)
  })
  await waitFor(() => expect(document.querySelectorAll('[data-ikas-store]')).toHaveLength(1))
  expect(document.querySelector('[data-ikas-store="acc-A"]')).toBeTruthy()
})
