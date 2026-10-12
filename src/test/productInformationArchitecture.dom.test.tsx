import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import appSource from '../App.tsx?raw'
import { AppShell } from '../components/AppShell'
import {
  buildDashboardViewModel,
  extractDashboardOperationalSnapshot,
  type DashboardPeriodSelection,
} from '../dashboard/dashboardViewModel'
import { resolveReportingRange } from '../dashboard/reportingRange'
import { CargoOperationsPage } from '../pages/CargoOperationsPage'
import { DashboardPage } from '../pages/DashboardPage'
import { HomePage } from '../pages/HomePage'
import { SettingsPage } from '../pages/SettingsPage'
import { ShipmentsPage } from '../pages/ShipmentsPage'
import { defaultIntegrationConfig, defaultPrinterSettings } from '../services/integrationConfigService'
import type {
  ShipmentLedgerQuery,
  ShipmentLedgerResult,
  ShippingPipeline,
} from '../services/shippingOverviewClient'
import type { CargoOrder, PageKey } from '../types/cargoflow'

// ÜRÜN BİLGİ MİMARİSİ + DASHBOARD ONARIMI — REGRESYON KİLİDİ.
//
// Siparişler = ne satıldı / ne hazırlanacak (gönderi oluşturmanın kaynağı).
// Kargo Operasyonları = kargo hattında ŞU ANDA ne oluyor.
// Gönderiler = kargoya çıktıktan sonra ne oldu.
// Etiket yerleşimi düzenleyicisi = Ayarlar > Baskı ve Etiket.
//
// Hiçbir yeni ekran gönderi OLUŞTURMAZ; satır aksiyonları mevcut baskı /
// takip / sipariş akışlarına gider.

const dashboardService = vi.hoisted(() => ({
  fail: false,
  orders: [] as CargoOrder[],
  calls: [] as string[],
}))

vi.mock('../services/dashboardAnalyticsService', () => ({
  fetchDashboardOperationalSnapshot: vi.fn(async (period: DashboardPeriodSelection) => {
    dashboardService.calls.push(period.key)
    if (dashboardService.fail) throw new Error('Sunucu yanıt vermedi.')
    const viewModel = buildDashboardViewModel({ orders: dashboardService.orders, selectedPeriod: period })
    return {
      viewModel,
      snapshot: extractDashboardOperationalSnapshot(viewModel),
      providerCounts: null,
    }
  }),
  fetchDashboardAnalyticsOrders: vi.fn(async () => ({ orders: [] })),
  fetchDashboardAnalyticsClaims: vi.fn(async () => ({ claims: [], source: 'unavailable' })),
}))

vi.mock('../services/integrationHealthClient', () => ({
  fetchIntegrationHealth: vi.fn(async () => []),
}))

beforeEach(() => {
  dashboardService.fail = false
  dashboardService.orders = []
  dashboardService.calls = []
})

function order(id: string, orderDate: Date, amount: number, overrides: Partial<CargoOrder> = {}): CargoOrder {
  return {
    id,
    orderNumber: `TY-${id}`,
    packageId: `PKG-${id}`,
    marketplace: 'Trendyol',
    customerName: 'Ayşe Yılmaz',
    city: 'İstanbul',
    status: 'Yeni',
    marketplaceStatus: 'Created',
    orderDate: orderDate.toISOString(),
    createdAt: orderDate.toISOString(),
    totalAmount: amount,
    items: [{ id: `${id}-1`, productName: 'Ürün', quantity: 1, price: amount, barcode: `B-${id}` }],
    ...overrides,
  } as unknown as CargoOrder
}

/* ─── SIDEBAR ───────────────────────────────────────────────────────── */

test('IA-NAV-1: sidebar sırası ürün akışını izler; Etiket Şablonları ana menüde YOK', () => {
  const onNavigate = vi.fn<(page: PageKey) => void>()
  render(
    <AppShell activePage="dashboard" onNavigate={onNavigate}>
      <div />
    </AppShell>,
  )
  const main = screen.getByRole('navigation', { name: 'Ana navigasyon' })
  expect(within(main).getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Ana Sayfa',
    'Siparişler',
    'Kargo Operasyonları',
    'Gönderiler',
    'Ürünler',
    'Entegrasyonlar',
  ])
  const footer = screen.getByRole('navigation', { name: 'Yönetim' })
  expect(within(footer).getAllByRole('button').map((button) => button.textContent)).toEqual(['Ayarlar'])
  expect(screen.queryByText('Etiket Şablonları')).toBeNull()
})

test('IA-NAV-2: Gönderiler gerçek shipments sayfasına gider; Siparişler AYRI bir sayfadır', () => {
  const onNavigate = vi.fn<(page: PageKey) => void>()
  const { rerender } = render(
    <AppShell activePage="dashboard" onNavigate={onNavigate}>
      <div />
    </AppShell>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Gönderiler' }))
  expect(onNavigate).toHaveBeenLastCalledWith('shipments')
  fireEvent.click(screen.getByRole('button', { name: 'Siparişler' }))
  expect(onNavigate).toHaveBeenLastCalledWith('orders')
  rerender(
    <AppShell activePage="shipments" onNavigate={onNavigate}>
      <div />
    </AppShell>,
  )
  expect(screen.getByRole('button', { name: 'Gönderiler' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('button', { name: 'Siparişler' }).getAttribute('aria-current')).toBeNull()
  // Düzenleyici açıkken Ayarlar seçili görünür (Ayarlar > Baskı ve Etiket).
  rerender(
    <AppShell activePage="labelTemplates" onNavigate={onNavigate}>
      <div />
    </AppShell>,
  )
  expect(screen.getByRole('button', { name: 'Ayarlar' }).getAttribute('aria-current')).toBe('page')
})

test('IA-NAV-3: App shipments rotası ShipmentsPage çizer; Orders handedToCargo yönlendirmesi YOK', () => {
  expect(appSource).toMatch(/activePage === 'shipments' \? \([\s\S]{0,120}<ShipmentsPage/)
  expect(appSource).not.toMatch(/setShipmentsView|shipmentsActive|onOpenShipments=\{\(\) => \{[^}]*handedToCargo/)
  // Gönderiler'den yeniden yazdırma MEVCUT baskı akışına gider; create YOK.
  const effect = appSource.slice(appSource.indexOf('async function requestOrderAction'))
  const block = effect.slice(0, effect.indexOf('function refreshLogs'))
  expect(block).toMatch(/kind === 'print' \? handlePrintLabelsForIds\(\[orderId\]\) : handleTrackShipmentForOrder\(orderId\)/)
  expect(block).not.toMatch(/Create|create\(|createShipment|CreateAndPrint/)
  const printer = appSource.slice(appSource.indexOf('async function handlePrintLabelsForIds'))
  const printBody = printer.slice(0, printer.indexOf('\n  }\n'))
  expect(printBody).not.toMatch(/handleCreate|SuratCreateAndPrint|createShipments\(/)
})

/* ─── AYARLAR > BASKI VE ETİKET ─────────────────────────────────────── */

test('IA-SET-1: Ayarlar > Baskı ve Etiket düzenleyiciye götürür; resmî alan koruması yazılı', () => {
  const onNavigate = vi.fn<(page: PageKey) => void>()
  render(
    <SettingsPage
      onNavigate={onNavigate}
      print={{
        printer: defaultPrinterSettings,
        rawPrint: { available: false, reason: 'Yerel ajan bulunamadı' },
        activeLayoutName: null,
      }}
    />,
  )
  const card = screen.getByRole('region', { name: 'Baskı ve Etiket' })
  expect(within(card).getByText('Resmî Sürat etiketi')).toBeTruthy()
  expect(within(card).getByText(/resmî taşıyıcı barkodunu, QR kodunu ve takip numarasını değiştiremez/)).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: /Etiket yerleşimini özelleştir/ }))
  expect(onNavigate).toHaveBeenCalledWith('labelTemplates')
})

/* ─── KARGO OPERASYONLARI ───────────────────────────────────────────── */

function pipeline(overrides: Partial<ShippingPipeline> = {}): ShippingPipeline {
  return {
    summary: { queued: 4, preparing: 2, labelReady: 7, needsAttention: 3, createdToday: 11, handedToday: 5 },
    worker: {
      backgroundEnabled: true,
      workspaceEnabled: true,
      counts: { QUEUED: 3, PREPARING: 2, READY: 7, BLOCKED: 1, UNKNOWN_AFTER_NETWORK: 1, FAILED_SAFE_TO_RETRY: 1 },
      lastPreparedAt: '2026-10-12T08:00:00.000Z',
      averagePrepSeconds: 42,
      sampleSize: 9,
    },
    attention: [
      {
        kind: 'UNKNOWN_AFTER_NETWORK',
        orderId: 'o-unknown',
        orderNumber: 'TY-4238186037',
        packageId: '4238186037',
        marketplace: 'Trendyol',
        reason: 'Taşıyıcıya istek gitti, yanıt alınamadı. Mutabakat gerekli; yeni gönderi açılmaz.',
        updatedAt: '2026-10-12T08:10:00.000Z',
      },
      {
        kind: 'BLOCKED',
        orderId: 'o-blocked',
        orderNumber: 'TY-2',
        packageId: 'P-2',
        marketplace: 'Trendyol',
        reason: 'Desi bilgisi eksik.',
        updatedAt: null,
      },
    ],
    recent: [
      {
        orderId: 'o-ready',
        orderNumber: 'TY-READY',
        packageId: 'P-READY',
        marketplace: 'Trendyol',
        carrier: 'Sürat Kargo',
        stage: 'Gönderi oluşturuldu',
        stageTone: 'success',
        labelState: 'ready',
        trackingNumber: '11419469827',
        updatedAt: '2026-10-12T08:20:00.000Z',
        canReprint: true,
      },
      {
        orderId: 'o-pending',
        orderNumber: 'TY-PENDING',
        packageId: 'P-PENDING',
        marketplace: 'Trendyol',
        carrier: 'Sürat Kargo',
        stage: 'Sonuç kesinleşmedi',
        stageTone: 'danger',
        labelState: 'none',
        trackingNumber: null,
        updatedAt: '2026-10-12T08:21:00.000Z',
        canReprint: false,
      },
    ],
    ...overrides,
  }
}

const noopOrders = () => undefined
// Gönderi açan aksiyon adları ("Bugün oluşturulan" gibi sayaç etiketleri HARİÇ).
const CREATE_ACTION = /gönderi oluştur|etiket oluştur|oluştur ve yazdır|yeniden oluştur|kargoya gönder/i

test('IA-CARGO-1: Kargo Operasyonları gerçek kuyruk sayılarını gösterir; belirsiz işlemde create YOK', async () => {
  const data = pipeline()
  const load = vi.fn(async () => data)
  const onOpenOrder = vi.fn()
  const onPrintLabel = vi.fn()
  render(
    <CargoOperationsPage
      onOpenOrder={onOpenOrder}
      onPrintLabel={onPrintLabel}
      onOpenShipments={vi.fn()}
      onNavigateOrders={noopOrders}
      load={load}
    />,
  )
  const kpis = await screen.findByRole('region', { name: 'Kargo hattı özeti' })
  await waitFor(() => expect(within(kpis).getByText('11')).toBeTruthy())
  const value = (key: string) => kpis.querySelector(`[data-kpi="${key}"] strong`)?.textContent
  expect([value('queued'), value('preparing'), value('ready'), value('attention'), value('created'), value('handed')]).toEqual([
    '4', '2', '7', '3', '11', '5',
  ])
  const attention = screen.getByRole('region', { name: 'Kontrol gereken işlemler' })
  const unknown = attention.querySelector('[data-kind="UNKNOWN_AFTER_NETWORK"]') as HTMLElement
  expect(unknown.textContent).toMatch(/Mutabakat gerekli/)
  expect(within(unknown).getAllByRole('button').map((button) => button.textContent?.trim())).toEqual(['Siparişi aç'])
  expect(screen.queryByRole('button', { name: CREATE_ACTION })).toBeNull()
  // Hazır etiket: yeniden yazdırma mevcut baskı akışına gider.
  fireEvent.click(screen.getByRole('button', { name: 'TY-READY hazır etiketi yazdır' }))
  expect(onPrintLabel).toHaveBeenCalledWith('o-ready')
  // Sonucu belirsiz kayıt için yazdırma da sunulmaz.
  expect(screen.queryByRole('button', { name: 'TY-PENDING hazır etiketi yazdır' })).toBeNull()
  expect(load).toHaveBeenCalledTimes(1)
})

test('IA-CARGO-2: özet alınamazsa hata açıkça yazılır; sahte 0 gösterilmez', async () => {
  const load = vi.fn(async () => {
    throw new Error('Kargo operasyon özeti yüklenemedi.')
  })
  render(
    <CargoOperationsPage onOpenOrder={vi.fn()} onPrintLabel={vi.fn()} onOpenShipments={vi.fn()} onNavigateOrders={noopOrders} load={load} />,
  )
  expect((await screen.findByRole('alert')).textContent).toMatch(/Kargo operasyon özeti alınamadı/)
  const kpis = screen.getByRole('region', { name: 'Kargo hattı özeti' })
  expect(Array.from(kpis.querySelectorAll('strong')).map((node) => node.textContent)).toEqual(['—', '—', '—', '—', '—', '—'])
})

/* ─── GÖNDERİLER ────────────────────────────────────────────────────── */

function ledger(): ShipmentLedgerResult {
  const base = {
    marketplace: 'Trendyol',
    carrier: 'Sürat Kargo',
    payer: 'Pazaryeri öder',
    carrierAccount: 'Sürat · Ana hesap',
    createdAt: '2026-10-12T08:00:00.000Z',
    lastActivityAt: '2026-10-12T09:00:00.000Z',
  }
  return {
    rows: [
      {
        ...base,
        shipmentId: 's-ready',
        orderId: 'o-ready',
        orderNumber: 'TY-READY',
        packageId: 'P-READY',
        trackingNumber: '11419469827',
        lifecycle: 'label_ready',
        lifecycleLabel: 'Etiketi hazır',
        labelState: 'ready',
        canReprint: true,
      },
      {
        ...base,
        shipmentId: 's-unknown',
        orderId: 'o-unknown',
        orderNumber: 'TY-UNKNOWN',
        packageId: '4238186037',
        trackingNumber: null,
        lifecycle: 'attention',
        lifecycleLabel: 'Kontrol gerekli',
        labelState: 'none',
        canReprint: false,
      },
    ],
    total: 2,
    counts: { all: 2, label_ready: 1, in_transit: 0, delivered: 0, attention: 1 },
    page: 1,
    pageSize: 25,
  }
}

test('IA-SHIP-1: Gönderiler READY satırında yeniden yazdırma yalnız baskı akışını çağırır (ikinci create YOK)', async () => {
  const load = vi.fn(async (query: ShipmentLedgerQuery) => {
    void query
    return ledger()
  })
  const onPrintLabel = vi.fn()
  const onTrackShipment = vi.fn()
  const onOpenOrder = vi.fn()
  render(<ShipmentsPage onOpenOrder={onOpenOrder} onPrintLabel={onPrintLabel} onTrackShipment={onTrackShipment} load={load} />)
  expect(screen.getByRole('heading', { name: 'Gönderiler ve Takip' })).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: 'TY-READY etiketini tekrar yazdır' }))
  expect(onPrintLabel).toHaveBeenCalledTimes(1)
  expect(onPrintLabel).toHaveBeenCalledWith('o-ready')
  fireEvent.click(screen.getByRole('button', { name: 'TY-READY takibini sorgula' }))
  expect(onTrackShipment).toHaveBeenCalledWith('o-ready')
  // Bu ekranda hiçbir koşulda gönderi oluşturma aksiyonu yoktur.
  expect(screen.queryByRole('button', { name: CREATE_ACTION })).toBeNull()
})

test('IA-SHIP-2: UNKNOWN_AFTER_NETWORK (kontrol gerekli) satırında create / yazdır / takip aksiyonu YOK', async () => {
  render(<ShipmentsPage onOpenOrder={vi.fn()} onPrintLabel={vi.fn()} onTrackShipment={vi.fn()} load={async () => ledger()} />)
  const row = (await screen.findByText('TY-UNKNOWN')).closest('tr') as HTMLElement
  expect(row.getAttribute('data-lifecycle')).toBe('attention')
  expect(within(row).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
    'TY-UNKNOWN sipariş detayını aç',
  ])
})

test('IA-SHIP-3: sekme ve filtreler sunucu sorgusunu değiştirir; hata sahte boş liste olarak gösterilmez', async () => {
  const load = vi.fn(async (query: ShipmentLedgerQuery) => {
    void query
    return ledger()
  })
  render(<ShipmentsPage onOpenOrder={vi.fn()} onPrintLabel={vi.fn()} onTrackShipment={vi.fn()} load={load} initialSearch="TY-READY" />)
  await screen.findByText('TY-UNKNOWN')
  expect(load.mock.calls[0][0]).toMatchObject({ tab: 'all', search: 'TY-READY', page: 1 })
  fireEvent.click(screen.getByRole('button', { name: /Kontrol Gerekli/ }))
  await waitFor(() => expect(load.mock.calls.at(-1)?.[0]).toMatchObject({ tab: 'attention' }))
  fireEvent.change(screen.getByLabelText('Kargo firması'), { target: { value: 'surat' } })
  await waitFor(() => expect(load.mock.calls.at(-1)?.[0]).toMatchObject({ tab: 'attention', provider: 'surat' }))

  const failing = vi.fn(async () => {
    throw new Error('Gönderiler yüklenemedi.')
  })
  render(<ShipmentsPage onOpenOrder={vi.fn()} onPrintLabel={vi.fn()} onTrackShipment={vi.fn()} load={failing} />)
  expect((await screen.findByText('Gönderiler alınamadı')).closest('[role="alert"]')).toBeTruthy()
  expect(screen.queryByText('Bu filtrelerle gönderi yok')).toBeNull()
})

/* ─── ANA SAYFA + İSTATİSTİK ────────────────────────────────────────── */

function dashboardProps() {
  return {
    orders: [] as CargoOrder[],
    useServerOperationalSnapshot: true,
    dataSourceResolved: true,
    integrationConfig: defaultIntegrationConfig,
    printerSettings: defaultPrinterSettings,
    apiDebugLogs: [],
    loading: false,
    onRefresh: vi.fn(),
    onNavigatePage: vi.fn(),
    onNavigateOrders: vi.fn(),
    onDownloadOrder: vi.fn(),
    onPrintOrder: vi.fn(),
    onCreateShipment: vi.fn(),
    onTrackShipment: vi.fn(),
    onDesiChange: vi.fn(),
  }
}

test('IA-DASH-1: dönem düğmesi sunucu modelini yeniden ister ve seçili dönem özeti DEĞİŞİR', async () => {
  const now = new Date()
  const todayStart = resolveReportingRange('today', now, 'UTC').start.getTime()
  const weekStart = resolveReportingRange('last7Days', now, 'UTC').start.getTime()
  dashboardService.orders = [
    order('t1', new Date(todayStart + 60_000), 100),
    order('w1', new Date(weekStart + 60_000), 250),
    order('w2', new Date(weekStart + 120_000), 400, { marketplaceStatus: 'Cancelled' }),
  ]
  render(<DashboardPage {...dashboardProps()} />)
  const summary = await screen.findByTestId('dashboard-period-summary')
  const item = (label: string) =>
    within(summary).getByText(label).parentElement?.querySelector('strong')?.textContent
  expect(item('Satış adedi')).toBe('1')
  expect(item('İptal')).toBe('0 paket')
  fireEvent.click(screen.getByRole('button', { name: '7 Gün' }))
  await waitFor(() => expect(item('Satış adedi')).toBe('2'))
  expect(item('İptal')).toBe('1 paket')
  expect(dashboardService.calls).toContain('today')
  expect(dashboardService.calls).toContain('last7')
  expect(item('Net satış')).toMatch(/350/)
  expect(item('Brüt satış')).toMatch(/750/)
})

test('IA-DASH-2: sunucu istatistiği alınamazsa hata yazılır; kısmi havuzdan sayı ÜRETİLMEZ', async () => {
  dashboardService.fail = true
  const props = dashboardProps()
  // Kısmi istemci havuzunda satış VAR — yine de gösterilmemeli.
  props.orders = [order('local', new Date(), 999)]
  render(<DashboardPage {...props} />)
  expect(await screen.findByText('İstatistikler yüklenemedi.')).toBeTruthy()
  expect(screen.queryByTestId('dashboard-period-summary')).toBeNull()
  expect(screen.queryByText(/999/)).toBeNull()
})

test('IA-HOME-1: Ana Sayfa altı operasyon göstergesi; sunucu hatasında "—" ve açık hata', async () => {
  dashboardService.fail = true
  const onNavigateOrders = vi.fn()
  render(
    <HomePage
      orders={[order('local', new Date(), 999, { operationStatus: 'LABEL_READY' } as Partial<CargoOrder>)]}
      useServerOperationalSnapshot
      dataSourceResolved
      loading={false}
      onRefresh={vi.fn()}
      onNavigatePage={vi.fn()}
      onNavigateOrders={onNavigateOrders}
    />,
  )
  const ops = screen.getByRole('region', { name: 'Operasyon durumu' })
  expect(Array.from(ops.querySelectorAll('.home-op-label')).map((node) => node.textContent)).toEqual([
    'Bugün gelen',
    'Barkod bekliyor',
    'Etiket hazır',
    'Kontrol gereken',
    'Kargoya verildi',
    'Teslim edildi',
  ])
  expect((await screen.findByRole('alert')).textContent).toMatch(/Operasyon özeti alınamadı/)
  expect(Array.from(ops.querySelectorAll('strong')).map((node) => node.textContent)).toEqual(['—', '—', '—', '—', '—', '—'])
  fireEvent.click(within(ops).getByText('Teslim edildi'))
  expect(onNavigateOrders).toHaveBeenCalledWith('delivered')
})
