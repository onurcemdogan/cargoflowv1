import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
// App kaynağı Vite `?raw` ile okunur (tarayıcı tsconfig'inde node tipi yoktur).
import appSource from '../App.tsx?raw'
import { ProductsPage } from '../pages/ProductsPage'
import { workflowService } from '../services/appServices'
import {
  serverCatalogSource,
  type CatalogPage,
  type CatalogQuery,
  type ProductCatalogSource,
} from '../services/productCatalogService'
import type { CargoOrder, CargoProduct } from '../types/cargoflow'

// ═══ CATALOG-001 — ÜRÜNLER EKRANI GERÇEK DOM KABULÜ ══════════════════════
//
// Ekran bir `ProductCatalogSource` ile konuşur; sunucu kaynağı ayrıca
// `fetch` taklidiyle sınanır (URL sözleşmesi). Kaynak taraması DEĞİL:
// render edilen satır sayısı, gönderilen sorgu ve görünen metin ölçülür.

function productRow(index: number, over: Partial<CargoProduct> = {}): CargoProduct {
  return {
    id: `v-${index}`,
    marketplace: 'Trendyol',
    productName: `Ürün ${index}`,
    sku: `SKU-${index}`,
    barcode: `BAR-${index}`,
    stock: 1,
    price: 10,
    images: [],
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...over,
  } as CargoProduct
}

function pageFor(query: CatalogQuery, total: number, over: Partial<CatalogPage> = {}): CatalogPage {
  const start = (query.page - 1) * query.pageSize
  // Sahte kaynak bir yanıtta en çok 1000 satır üretir: ekran tam kataloğu
  // isterse (sayfa boyutu 25 yerine) bu, bellek taşması yerine NET bir
  // satır sayısı hatası olarak görünür.
  const count = Math.max(0, Math.min(query.pageSize, total - start, 1000))
  return {
    products: Array.from({ length: count }, (_, offset) =>
      productRow(start + offset + 1, { productName: `${query.search || 'Ürün'} ${start + offset + 1}` }),
    ),
    total,
    page: query.page,
    pageSize: query.pageSize,
    catalogSync: { lastSyncStatus: 'success', lastSuccessfulSyncAt: '2026-09-20T09:00:00.000Z', lastFetchedCount: total },
    syncSource: { available: true, reason: null },
    ...over,
  }
}

function sourceWith(total: number | ((query: CatalogQuery) => CatalogPage)) {
  const queries: CatalogQuery[] = []
  const source: ProductCatalogSource = vi.fn(async (query: CatalogQuery) => {
    queries.push(query)
    return typeof total === 'function' ? total(query) : pageFor(query, total)
  })
  return { source, queries }
}

function renderPage(
  source: ProductCatalogSource,
  over: Partial<Parameters<typeof ProductsPage>[0]> = {},
) {
  const onSyncProducts = over.onSyncProducts ?? vi.fn(async () => {})
  const utils = render(
    <ProductsPage
      catalogSource={source}
      scopeKey={over.scopeKey ?? 1}
      orders={over.orders ?? []}
      syncBusy={over.syncBusy ?? false}
      onSyncProducts={onSyncProducts}
    />,
  )
  return { ...utils, onSyncProducts }
}

const rows = () => document.querySelectorAll('[data-product-row]')
const typeSearch = (value: string) =>
  fireEvent.change(screen.getByLabelText(/Ürün ara/), { target: { value } })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* ─────────────────────────────────────────────────────────────────────── */

test('CAT-UI-1/2/9: 50.000 toplam + 25 dönen → TAM 25 satır; aralık dürüst', async () => {
  const { source, queries } = sourceWith(50_000)
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(25))
  expect(queries).toHaveLength(1)
  expect(queries[0]).toMatchObject({ page: 1, pageSize: 25, search: '', archive: 'ACTIVE' })
  expect(screen.getByTestId('catalog-range').textContent).toBe('1–25 / 50.000')
  expect(screen.getByTestId('catalog-total').textContent).toBe('50.000')
  expect(screen.getByTestId('catalog-page').textContent).toBe('Sayfa 1 / 2.000')
})

test('CAT-UI-3: sunucu kaynağı aramayı ve arşivi URL ile SUNUCUYA gönderir; kapsam GÖNDERMEZ', async () => {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, products: [], total: 0, page: 1, pageSize: 25 }),
      } as unknown as Response
    }),
  )
  await serverCatalogSource(
    { page: 3, pageSize: 50, search: ' abc ', archive: 'ACTIVE', sort: 'recent' },
    new AbortController().signal,
  )
  const url = new URL(urls[0], 'http://x')
  expect(url.pathname).toBe('/api/products')
  expect(url.searchParams.get('search')).toBe('abc')
  expect(url.searchParams.get('archived')).toBe('false')
  expect(url.searchParams.get('page')).toBe('3')
  expect(url.searchParams.get('pageSize')).toBe('50')
  expect(url.searchParams.get('sort')).toBe('recent')
  expect(url.searchParams.has('organizationId')).toBe(false)
  expect(url.searchParams.has('marketplaceAccountId')).toBe(false)
})

test('CAT-UI-4: arama DEBOUNCE — hızlı yazım tek istek', async () => {
  const { source, queries } = sourceWith(40)
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(25))
  typeSearch('a')
  typeSearch('ab')
  typeSearch('abc')
  await waitFor(() => expect(queries.at(-1)?.search).toBe('abc'))
  // İlk yükleme + YALNIZ bir arama isteği.
  expect(queries.map((query) => query.search)).toEqual(['', 'abc'])
})

test('CAT-UI-5: yavaş ESKİ yanıt ("abc") yeni aramanın ("abcd") sonucunu EZEMEZ', async () => {
  let releaseAbc: () => void = () => {}
  const queries: CatalogQuery[] = []
  const source: ProductCatalogSource = vi.fn((query: CatalogQuery) => {
    queries.push(query)
    if (query.search === 'abc') {
      return new Promise<CatalogPage>((resolve) => {
        releaseAbc = () => resolve(pageFor(query, 3))
      })
    }
    return Promise.resolve(pageFor(query, 2))
  })
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(2))
  typeSearch('abc')
  await waitFor(() => expect(queries.at(-1)?.search).toBe('abc'))
  typeSearch('abcd')
  await waitFor(() => expect(screen.getByText('abcd 1')).toBeTruthy())
  await act(async () => {
    releaseAbc()
  })
  expect(rows()).toHaveLength(2)
  expect(screen.queryByText('abc 1')).toBeNull()
  expect(screen.getByText('abcd 1')).toBeTruthy()
})

test('CAT-UI-6/7/8: sayfalama sunucu sayfası; filtre ve sıralama sayfa 1e döner', async () => {
  const { source, queries } = sourceWith(60)
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(25))
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }))
  await waitFor(() => expect(screen.getByTestId('catalog-range').textContent).toBe('26–50 / 60'))
  expect(queries.at(-1)?.page).toBe(2)
  fireEvent.click(screen.getByRole('button', { name: 'Önceki sayfa' }))
  await waitFor(() => expect(queries.at(-1)?.page).toBe(1))

  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }))
  await waitFor(() => expect(queries.at(-1)?.page).toBe(2))
  fireEvent.change(screen.getByLabelText('Arşiv durumu'), { target: { value: 'ALL' } })
  await waitFor(() => expect(queries.at(-1)).toMatchObject({ archive: 'ALL', page: 1 }))

  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }))
  await waitFor(() => expect(queries.at(-1)?.page).toBe(2))
  fireEvent.change(screen.getByLabelText('Sıralama'), { target: { value: 'recent' } })
  await waitFor(() => expect(queries.at(-1)).toMatchObject({ sort: 'recent', page: 1 }))

  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }))
  await waitFor(() => expect(queries.at(-1)?.page).toBe(2))
  fireEvent.change(screen.getByLabelText('Sayfa boyutu'), { target: { value: '50' } })
  await waitFor(() => expect(queries.at(-1)).toMatchObject({ pageSize: 50, page: 1 }))
})

test('CAT-UI-10: etkin / arşivlenmiş ayrımı', async () => {
  const { source, queries } = sourceWith((query) =>
    query.archive === 'ARCHIVED'
      ? pageFor(query, 1, { products: [productRow(9, { archived: true } as never)] })
      : pageFor(query, 1),
  )
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(1))
  expect(queries[0].archive).toBe('ACTIVE')
  fireEvent.change(screen.getByLabelText('Arşiv durumu'), { target: { value: 'ARCHIVED' } })
  await waitFor(() => expect(queries.at(-1)?.archive).toBe('ARCHIVED'))
  await waitFor(() => expect(screen.getByText('Arşivlenmiş', { selector: 'td' })).toBeTruthy())
})

test('CAT-UI-11: boş katalog ile boş arama sonucu FARKLI metin', async () => {
  const { source } = sourceWith((query) =>
    pageFor(query, 0, {
      catalogSync: { lastSyncStatus: null, lastSuccessfulSyncAt: null, lastFetchedCount: null },
    }),
  )
  renderPage(source)
  await waitFor(() =>
    expect(screen.getByTestId('catalog-empty').textContent).toBe('Henüz ürün senkronize edilmedi.'),
  )
  typeSearch('yok')
  await waitFor(() =>
    expect(screen.getByTestId('catalog-empty').textContent).toBe('Bu filtrelerle eşleşen ürün yok.'),
  )
  expect(document.body.textContent).not.toMatch(/Veri bulunamadı/)
})

test('CAT-UI-12: hata durumu Tekrar Dene sunar ve yeniden yükler', async () => {
  let fail = true
  const source: ProductCatalogSource = vi.fn(async (query: CatalogQuery) => {
    if (fail) throw new Error('500')
    return pageFor(query, 3)
  })
  renderPage(source)
  expect(await screen.findByText('Ürünler yüklenemedi.')).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Tekrar Dene' }))
  await waitFor(() => expect(rows()).toHaveLength(3))
})

test('CAT-UI-13: satır (tıklama ve klavye) mevcut ürün detayını açar; ilgili sipariş EN İYİ ÇABA', async () => {
  const { source } = sourceWith(3)
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(3))
  fireEvent.click(rows()[0])
  const drawer = screen.getByRole('complementary', { name: 'Ürün detayı' })
  expect(drawer.textContent).toContain('Ürün 1')
  fireEvent.click(screen.getByRole('button', { name: 'Etiket Önizleme' }))
  // Yüklü sipariş yok: "eşleşen sipariş YOK" iddiası YAPILMAZ.
  expect(screen.getByTestId('related-order-best-effort').textContent).toMatch(/tam bir sipariş araması değildir/)
  fireEvent.click(drawer.querySelector('.icon-button') as HTMLElement)
  fireEvent.keyDown(rows()[1], { key: 'Enter' })
  expect(screen.getByRole('complementary', { name: 'Ürün detayı' }).textContent).toContain('Ürün 2')
})

test('CAT-UI-14/15: ana yüzey mühendislik telemetrisi ve sağlayıcıya bağlı tanım İÇERMEZ', async () => {
  const { source } = sourceWith(3)
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(3))
  const details = screen.getByTestId('catalog-technical-details') as HTMLDetailsElement
  expect(details.open).toBe(false)
  // Telemetri YALNIZ kapalı "Teknik detaylar" içinde.
  const main = [...document.body.querySelectorAll('section, header, p')]
    .filter((node) => !details.contains(node))
    .map((node) => node.textContent)
    .join(' ')
  for (const telemetry of ['API kayıtları', 'Normalize', 'Varyant tekilleştirme', 'Products store', 'ProductsPageCount', 'Frontend / API']) {
    expect(main).not.toContain(telemetry)
  }
  expect(document.body.textContent).not.toMatch(/Trendyol ürün kataloğu/)
  expect(screen.getByText('Bağlı satış kanalındaki ürün ve varyantları yönetin.')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Ürünleri Senkronize Et/ })).toBeTruthy()
})

test('CAT-UI-16: açık senkron başarısı GÖRÜNEN sorguyu filtreleri koruyarak yeniler', async () => {
  const { source, queries } = sourceWith(40)
  const onSyncProducts = vi.fn(async () => {})
  renderPage(source, { onSyncProducts })
  await waitFor(() => expect(rows()).toHaveLength(25))
  typeSearch('ruj')
  await waitFor(() => expect(queries.at(-1)?.search).toBe('ruj'))
  const before = queries.length
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Ürünleri Senkronize Et/ }))
  })
  await waitFor(() => expect(queries.length).toBe(before + 1))
  expect(onSyncProducts).toHaveBeenCalledTimes(1)
  expect(queries.at(-1)?.search).toBe('ruj')
})

test('CAT-UI-17: sayfa açılışı senkron ÇAĞIRMAZ (yalnız yerel DB okuması)', async () => {
  const urls: Array<{ url: string; method: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push({ url: String(url), method: init?.method ?? 'GET' })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, products: [productRow(1)], total: 1, page: 1, pageSize: 25 }),
      } as unknown as Response
    }),
  )
  const { onSyncProducts } = renderPage(serverCatalogSource)
  await waitFor(() => expect(rows()).toHaveLength(1))
  expect(onSyncProducts).not.toHaveBeenCalled()
  expect(urls.every((call) => call.method === 'GET' && !call.url.includes('/sync'))).toBe(true)
  expect(urls).toHaveLength(1)
})

test('CAT-UI-18: meşgul senkron çift tıklamada TEK istek', async () => {
  const { source } = sourceWith(3)
  let release: () => void = () => {}
  const onSyncProducts = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
  renderPage(source, { onSyncProducts })
  await waitFor(() => expect(rows()).toHaveLength(3))
  const button = screen.getByRole('button', { name: /Ürünleri Senkronize Et/ })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(onSyncProducts).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: /Senkronize ediliyor/ }).hasAttribute('disabled')).toBe(true)
  await act(async () => {
    release()
  })
})

test('CAT-UI-SYNC-OFF: canlı/kayıtlı ürün kaynağı yoksa senkron DÜRÜSTÇE kapalı', async () => {
  const { source } = sourceWith((query) =>
    pageFor(query, 0, { syncSource: { available: false, reason: 'NOT_CONFIGURED' } }),
  )
  const { onSyncProducts } = renderPage(source)
  await waitFor(() => expect(screen.getByRole('note').textContent).toMatch(/satış kanalı bağlantısını/))
  const button = screen.getByRole('button', { name: /Ürünleri Senkronize Et/ })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(onSyncProducts).not.toHaveBeenCalled()
})

test('CAT-UI-CLAMP: sonuç küçülürse geçersiz sayfa GEÇERLİ son sayfaya iner', async () => {
  let total = 60
  const { source, queries } = sourceWith((query) => pageFor(query, total))
  renderPage(source)
  await waitFor(() => expect(rows()).toHaveLength(25))
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }))
  await waitFor(() => expect(screen.getByTestId('catalog-range').textContent).toBe('51–60 / 60'))
  total = 30 // senkron sonrası katalog küçüldü
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Ürünleri Senkronize Et/ }))
  })
  await waitFor(() => expect(screen.getByTestId('catalog-range').textContent).toBe('26–30 / 30'))
  expect(queries.at(-1)?.page).toBe(2)
})

test('CAT-ACC-3: hesap A → B geçişinde A satırları B verisi gibi GÖRÜNMEZ', async () => {
  let releaseB: () => void = () => {}
  const source: ProductCatalogSource = vi.fn((query: CatalogQuery) => {
    if (currentScope === 'B') {
      return new Promise<CatalogPage>((resolve) => {
        releaseB = () =>
          resolve({ ...pageFor(query, 1), products: [productRow(1, { productName: 'B ürünü' })] })
      })
    }
    return Promise.resolve({ ...pageFor(query, 1), products: [productRow(1, { productName: 'A ürünü' })] })
  })
  let currentScope = 'A'
  const { rerender } = renderPage(source, { scopeKey: 'A' })
  await waitFor(() => expect(screen.getByText('A ürünü')).toBeTruthy())
  fireEvent.click(rows()[0]) // A'nın detayı açık
  currentScope = 'B'
  rerender(
    <ProductsPage
      catalogSource={source}
      scopeKey="B"
      orders={[]}
      syncBusy={false}
      onSyncProducts={vi.fn()}
    />,
  )
  // B yanıtı gelmeden: A satırı ve A detayı GÖRÜNMEZ.
  expect(screen.queryByText('A ürünü')).toBeNull()
  expect(screen.queryByRole('complementary', { name: 'Ürün detayı' })).toBeNull()
  expect(screen.getByText('Ürünler yükleniyor…')).toBeTruthy()
  await act(async () => {
    releaseB()
  })
  expect(screen.getByText('B ürünü')).toBeTruthy()
})

test('CAT-OPS-1: operasyonel TAM katalog yükleyicisi değişmedi (tüm sayfalar, arşiv dahil)', async () => {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url))
      const params = new URL(String(url), 'http://x').searchParams
      const page = Number(params.get('page'))
      const pageSize = Number(params.get('pageSize'))
      const start = (page - 1) * pageSize
      const count = Math.max(0, Math.min(pageSize, 130 - start))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          products: Array.from({ length: count }, (_, i) => productRow(start + i + 1)),
          total: 130,
          page,
          pageSize,
        }),
      } as unknown as Response
    }),
  )
  const all = await workflowService.loadProductsFromServer()
  expect(all).toHaveLength(130)
  // Arşiv filtresi GÖNDERİLMEZ: sunucu varsayılanı (hepsi) korunur.
  expect(urls.every((url) => !url.includes('archived'))).toBe(true)
  expect(urls.every((url) => !url.includes('/sync'))).toBe(true)
})

test('CAT-OPS-2: görsel eşleşmesi GÖRÜNEN sayfaya KISITLANMAZ; ekran tam kataloğu almaz', () => {
  const fullCatalog = Array.from({ length: 130 }, (_, i) =>
    productRow(i + 1, { imageUrl: `https://img.example/${i + 1}.jpg` } as never),
  )
  const order = {
    id: 'o1',
    items: [{ barcode: 'BAR-120', quantity: 1 }],
  } as unknown as CargoOrder
  // Ekranın 1. sayfası (25) BAR-120'yi İÇERMEZ; operasyonel katalog içerir.
  const [enriched] = workflowService.enrichOrderImages([order], fullCatalog)
  expect(JSON.stringify(enriched)).toContain('https://img.example/120.jpg')

  const app = appSource
  const start = app.indexOf('<ProductsPage')
  const block = app.slice(start, app.indexOf('/>', start))
  expect(block).not.toMatch(/\bproducts=/)
  expect(block).toMatch(/catalogSource=\{catalogSource\}/)
  // Operasyonel katalog, tarayıcı sayfasıyla DEĞİŞTİRİLMEZ.
  expect(app).toMatch(/serverCatalogSource/)
  expect(app).not.toMatch(/setProductsState\([^)]*catalogPage/)
})
