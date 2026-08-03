import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { expect, test } from 'vitest'
import {
  SuratCreatePrintControls,
  type SuratCreatePrintProgress,
  type SuratCreatePrintResult,
} from '../components/SuratCreatePrintControls'
import type { CargoOrder } from '../types/cargoflow'
import { buildOrderCountSummary } from '../utils/orderCounts'
import { runSuratCreateAndPrint } from '../services/suratCreateAndPrintOrchestrator'
import { buildPrintAdapter } from '../services/suratOrchestratorDeps'
import { resolveSelectionAfterBatch } from '../utils/selectedOrderSnapshot'

// GERÇEK DOM + GERÇEK KULLANICI TIKLAMASI doğrulaması (jsdom + user-event).
// Tüm sipariş verileri SENTETİKTİR: gerçek müşteri adı/adres/telefon YOKTUR.

function makeOrder(index: number, overrides: Partial<CargoOrder> = {}): CargoOrder {
  return {
    id: `o-${index}`,
    orderNumber: `TESTORD-${index}`,
    marketplace: 'Trendyol',
    packageId: `PKG-${index}`,
    items: [
      { id: `l-${index}-a`, productName: 'Test Ürün A', quantity: 2 },
      { id: `l-${index}-b`, productName: 'Test Ürün B', quantity: 1 },
    ],
    ...overrides,
  } as unknown as CargoOrder
}

const EMPTY_COUNTS = buildOrderCountSummary([])

type Props = Parameters<typeof SuratCreatePrintControls>[0]

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    orders: [],
    visibleOrders: [],
    selectedIds: [],
    listedCounts: EMPTY_COUNTS,
    activeTabLabel: 'Yeni Siparişler',
    busy: false,
    suratCreatePrintRunning: false,
    onSuratCreateAndPrint: () => {},
    onMarkPrinted: () => {},
    onCreateShipments: () => {},
    onTrackShipments: () => {},
    onDownloadZpl: () => {},
    onMarkHandedToCargo: () => {},
    hasPrintableSelection: true,
    hasShipmentCreatableSelection: true,
    hasZplDownloadableSelection: true,
    hasHandedToCargoSelection: true,
    ...overrides,
  }
}

const mainButton = () =>
  screen.getByRole('button', { name: /Sürat Etiketi Oluştur ve Yazdır/ })

// ---------------------------------------------------------------- 1
test('DOM-1: seçim yokken ana buton DOM\'da var ve DISABLED', () => {
  render(<SuratCreatePrintControls {...baseProps()} />)
  const button = mainButton()
  expect(button).toBeTruthy()
  expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(button.getAttribute('title')).toBe('Önce en az bir sipariş seçin.')
})

// ---------------------------------------------------------------- 2
test('DOM-2: seçim varken ana buton AKTİF', () => {
  const orders = [makeOrder(1), makeOrder(2)]
  render(
    <SuratCreatePrintControls
      {...baseProps({ orders, visibleOrders: orders, selectedIds: ['o-1', 'o-2'] })}
    />,
  )
  expect((mainButton() as HTMLButtonElement).disabled).toBe(false)
})

// ---------------------------------------------------------------- 3
test('DOM-3: gerçek tıklama handler\'ı TAM BİR KEZ çağırır, selectedIds doğru gider', async () => {
  const user = userEvent.setup()
  const calls: string[][] = []
  const orders = [makeOrder(1), makeOrder(2), makeOrder(3)]
  const selectedIds = ['o-1', 'o-3']
  render(
    <SuratCreatePrintControls
      {...baseProps({
        orders,
        visibleOrders: orders,
        selectedIds,
        // App.tsx'teki bağlantı ile aynı desen.
        onSuratCreateAndPrint: () => calls.push([...selectedIds]),
      })}
    />,
  )
  await user.click(mainButton())
  expect(calls.length).toBe(1)
  expect(calls[0]).toEqual(['o-1', 'o-3'])
})

// App.tsx'teki koruma deseninin aynısı: ref guard + running state.
function DoubleClickHarness({ onRun }: { onRun: (ids: string[]) => void }) {
  const [running, setRunning] = useState(false)
  const active = useRef(false)
  const orders = [makeOrder(1), makeOrder(2)]
  const selectedIds = ['o-1', 'o-2']
  return (
    <SuratCreatePrintControls
      {...baseProps({ orders, visibleOrders: orders, selectedIds })}
      suratCreatePrintRunning={running}
      onSuratCreateAndPrint={() => {
        if (active.current) return
        active.current = true
        setRunning(true)
        onRun([...selectedIds])
      }}
    />
  )
}

// ---------------------------------------------------------------- 4
test('DOM-4: hızlı ÇİFT tıklama ikinci run\'ı başlatmaz', async () => {
  const user = userEvent.setup()
  const runs: string[][] = []
  render(<DoubleClickHarness onRun={(ids) => runs.push(ids)} />)
  const button = mainButton()
  await user.dblClick(button)
  expect(runs.length).toBe(1)
  // İlk tıklamadan sonra buton gerçekten DISABLED olur.
  expect(
    (screen.getByRole('button', { name: /Ön kontrol yapılıyor…/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})

const CONFLICTING = [
  'Barkod Bas',
  'Ortak Barkod Oluştur / Tamamla',
  'ZPL İndir',
  'Kargoya Verildi Yap',
]

// ---------------------------------------------------------------- 5
test('DOM-5: run sırasında ana buton ve ÇAKIŞAN aksiyonlar disabled; bitince aktif', () => {
  const orders = [makeOrder(1)]
  const props = baseProps({
    orders,
    visibleOrders: orders,
    selectedIds: ['o-1'],
  })
  const view = render(
    <SuratCreatePrintControls {...props} suratCreatePrintRunning={true} />,
  )
  for (const label of CONFLICTING) {
    const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
    expect(button.disabled, `${label} run sırasında disabled olmalı`).toBe(true)
  }
  expect(
    (screen.getByRole('button', { name: /Ön kontrol yapılıyor…/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)

  // İşlem bitti: eski davranışa döner.
  view.rerender(
    <SuratCreatePrintControls {...props} suratCreatePrintRunning={false} />,
  )
  for (const label of CONFLICTING) {
    const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
    expect(button.disabled, `${label} bitince aktif olmalı`).toBe(false)
  }
  expect((mainButton() as HTMLButtonElement).disabled).toBe(false)
})

// ---------------------------------------------------------------- 6
test('DOM-6: aşama metinleri GERÇEK DOM\'da görünür', () => {
  const orders = [makeOrder(1)]
  const props = baseProps({
    orders,
    visibleOrders: orders,
    selectedIds: ['o-1'],
    suratCreatePrintRunning: true,
  })
  const cases: Array<[SuratCreatePrintProgress | undefined, string]> = [
    [undefined, 'Ön kontrol yapılıyor…'],
    [{ phase: 'preflight', completed: 0, total: 40 }, 'Ön kontrol yapılıyor…'],
    [
      { phase: 'create', completed: 12, total: 40 },
      'Sürat etiketleri oluşturuluyor: 12/40',
    ],
    [
      { phase: 'prepare', completed: 39, total: 40 },
      'Etiketler hazırlanıyor: 39/40',
    ],
    [{ phase: 'print', completed: 0, total: 40 }, 'Yazdırma bekleniyor…'],
  ]
  for (const [progress, expected] of cases) {
    const view = render(
      <SuratCreatePrintControls {...props} suratCreatePrintProgress={progress} />,
    )
    expect(
      screen.getByRole('button', { name: expected }),
      `${expected} DOM'da olmalı`,
    ).toBeTruthy()
    view.unmount()
  }
})

// ---------------------------------------------------------------- 7
test('DOM-7: GÖRÜNÜR liste BOŞken bile seçim özeti 0/0/0 OLMAZ', () => {
  const orders = Array.from({ length: 20 }, (_, index) => makeOrder(index + 1))
  const selectedIds = orders.map((order) => String(order.id))
  render(
    <SuratCreatePrintControls
      {...baseProps({
        orders,
        // Sekme değişti: görünür liste BOŞ.
        visibleOrders: [],
        selectedIds,
        activeTabLabel: 'Etiket Hazır',
      })}
    />,
  )
  expect(screen.getByText('20 sipariş seçildi')).toBeTruthy()
  // 20 paket, 40 kalem (2 satır × 20), 60 ürün (3 adet × 20).
  expect(screen.getByText('20 paket')).toBeTruthy()
  expect(screen.getByText('40 kalem')).toBeTruthy()
  expect(screen.getByText('60 ürün')).toBeTruthy()
  expect(screen.queryByText('0 paket')).toBe(null)
  expect(screen.queryByText('0 kalem')).toBe(null)
  expect(screen.queryByText('0 ürün')).toBe(null)
})

// ---------------------------------------------------------------- 8
test('DOM-8: başka sekme bilgi mesajı DOM\'da görünür', () => {
  const orders = Array.from({ length: 20 }, (_, index) => makeOrder(index + 1))
  render(
    <SuratCreatePrintControls
      {...baseProps({
        orders,
        visibleOrders: [],
        selectedIds: orders.map((order) => String(order.id)),
        activeTabLabel: 'Etiket Hazır',
      })}
    />,
  )
  expect(
    screen.getByText(
      "20 seçili siparişten 20'si artık Etiket Hazır sekmesinde.",
    ),
  ).toBeTruthy()
})

const PARTIAL: SuratCreatePrintResult = {
  selectedCount: 40,
  created: 38,
  existingReady: 0,
  reprinted: 0,
  printed: 38,
  skipped: [{ orderNumber: 'TESTORD-39', reason: 'Ürün bilgileri tek etikete sığmıyor.' }],
  failed: [{ orderNumber: 'TESTORD-40', reason: 'Baskı doğrulanmadı; durum değiştirilmedi.' }],
}

// ---------------------------------------------------------------- 9
test('DOM-9: kısmi başarı paneli gerçek sayılarla render edilir', () => {
  render(
    <SuratCreatePrintControls
      {...baseProps({ suratCreatePrintResult: PARTIAL })}
    />,
  )
  expect(screen.getByText('Kısmi başarı')).toBeTruthy()
  expect(screen.getByText('Yazdırılan: 38')).toBeTruthy()
  expect(screen.getByText('Atlanan: 1')).toBeTruthy()
  expect(screen.getByText('Başarısız: 1')).toBeTruthy()
  expect(screen.getByText('Seçilen: 40')).toBeTruthy()
})

// ---------------------------------------------------------------- 10
test('DOM-10: detay paneli sipariş no + aşama + güvenli sebep gösterir', async () => {
  const user = userEvent.setup()
  render(
    <SuratCreatePrintControls
      {...baseProps({ suratCreatePrintResult: PARTIAL })}
    />,
  )
  await user.click(screen.getByText('Detaylar'))
  const items = screen.getAllByRole('listitem').map((node) => node.textContent ?? '')
  expect(items.length).toBe(2)
  expect(items.some((text) => text.includes('TESTORD-39') && text.includes('Atlandı')))
    .toBe(true)
  expect(items.some((text) => text.includes('TESTORD-40') && text.includes('Başarısız')))
    .toBe(true)
  expect(items.join(' ')).toContain('Ürün bilgileri tek etikete sığmıyor.')
  expect(items.join(' ')).toContain('Baskı doğrulanmadı; durum değiştirilmedi.')
})

// ---------------------------------------------------------------- 11
test('DOM-11: render edilen DOM\'da PII YOKTUR', () => {
  const orders = [
    makeOrder(1, {
      customerName: 'SENTETIK ALICI',
      address: 'Sentetik Mah. Sentetik Cad. No:1',
      customerPhone: '5000000000',
    } as Partial<CargoOrder>),
  ]
  const { container } = render(
    <SuratCreatePrintControls
      {...baseProps({
        orders,
        visibleOrders: orders,
        selectedIds: ['o-1'],
        suratCreatePrintResult: PARTIAL,
      })}
    />,
  )
  const html = container.innerHTML
  for (const leak of [
    'SENTETIK ALICI',
    'Sentetik Mah.',
    '5000000000',
    '^XA',
    'technicalZpl',
    'BarcodeRaw',
  ]) {
    expect(html.includes(leak), `PII/ham veri sızdı: ${leak}`).toBe(false)
  }
})

// Gerçek orkestratör + gerçek print adaptörü ile tam döngü harness'i.
function FullLoopHarness({
  printResult,
  onSelectionResolved,
}: {
  printResult?: { ok?: boolean; jobs?: Array<{ orderNumber: string; ok: boolean; error?: string }> }
  onSelectionResolved: (ids: string[]) => void
}) {
  const orders = [makeOrder(1), makeOrder(2)]
  const selectedIds = ['o-1', 'o-2']
  const [result, setResult] = useState<SuratCreatePrintResult | undefined>()
  const [running, setRunning] = useState(false)
  return (
    <SuratCreatePrintControls
      {...baseProps({
        orders,
        visibleOrders: orders,
        selectedIds,
        suratCreatePrintRunning: running,
        suratCreatePrintResult: result,
        onSuratCreateAndPrint: () => {
          setRunning(true)
          void runSuratCreateAndPrint(orders, orders, {
            preflight: {
              isSuratOrder: () => true,
              resolveDesiBlock: () => null,
              resolveFitBlock: () => null,
              resolveDataBlock: () => null,
              hasPrintableLabel: () => true,
              isPrinted: () => false,
              isInFlight: () => false,
            },
            createShipments: async (list) => ({ orders: list }),
            printLabels: buildPrintAdapter({
              callPrint: async (list) => ({ orders: list, printResult }),
            }),
          }).then((outcome) => {
            setResult(outcome)
            setRunning(false)
            onSelectionResolved(
              resolveSelectionAfterBatch(selectedIds, outcome.printedOrderIds),
            )
          })
        },
      })}
    />
  )
}

// ---------------------------------------------------------------- 12
test('DOM-12: printResult YOKSA hiçbir sipariş seçimden çıkarılmaz', async () => {
  const user = userEvent.setup()
  let remaining: string[] | undefined
  render(
    <FullLoopHarness
      printResult={undefined}
      onSelectionResolved={(ids) => { remaining = ids }}
    />,
  )
  await user.click(mainButton())
  await screen.findByText('İşlem tamamlanamadı')
  expect(remaining).toEqual(['o-1', 'o-2'])
  expect(screen.getByText('Yazdırılan: 0')).toBeTruthy()
})

// ---------------------------------------------------------------- 13
test('DOM-13: YALNIZ per-job ok=true olanlar seçimden çıkar', async () => {
  const user = userEvent.setup()
  let remaining: string[] | undefined
  render(
    <FullLoopHarness
      printResult={{
        ok: true,
        jobs: [
          { orderNumber: 'TESTORD-1', ok: true },
          { orderNumber: 'TESTORD-2', ok: false, error: 'Yazıcı yanıt vermedi.' },
        ],
      }}
      onSelectionResolved={(ids) => { remaining = ids }}
    />,
  )
  await user.click(mainButton())
  await screen.findByText('Kısmi başarı')
  // Global ok=true olmasına RAĞMEN yalnız job ok=true olan çıkar.
  expect(remaining).toEqual(['o-2'])
  expect(screen.getByText('Yazdırılan: 1')).toBeTruthy()
  // job hatası GÜVENLİ sebebiyle "atlanan" olarak raporlanır; aynı sipariş
  // ikinci kez "başarısız" sayılmaz (çift sayım YOK).
  expect(screen.getByText('Atlanan: 1')).toBeTruthy()
  expect(screen.getByText('Başarısız: 0')).toBeTruthy()
})

// ---------------------------------------------------------------- 14
test('DOM-14: hata sonrası running kapanır ve buton yeniden kullanılabilir', async () => {
  const user = userEvent.setup()
  const attempts: number[] = []

  function ErrorHarness() {
    const [running, setRunning] = useState(false)
    const orders = [makeOrder(1)]
    return (
      <SuratCreatePrintControls
        {...baseProps({
          orders,
          visibleOrders: orders,
          selectedIds: ['o-1'],
          suratCreatePrintRunning: running,
          onSuratCreateAndPrint: () => {
            attempts.push(attempts.length + 1)
            setRunning(true)
            // App.tsx'teki finally ile aynı: hata olsa da durum kapanır.
            void Promise.reject(new Error('Sürat çağrısı başarısız.'))
              .catch(() => {})
              .finally(() => setRunning(false))
          },
        })}
      />
    )
  }

  render(<ErrorHarness />)
  await user.click(mainButton())
  const button = await screen.findByRole('button', {
    name: /Sürat Etiketi Oluştur ve Yazdır/,
  })
  expect((button as HTMLButtonElement).disabled).toBe(false)
  await user.click(button)
  expect(attempts.length).toBe(2)
})
