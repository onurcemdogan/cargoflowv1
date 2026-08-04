import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { expect, test, vi } from 'vitest'
import { SuratCreatePrintControls } from '../components/SuratCreatePrintControls'
import type { CargoOrder } from '../types/cargoflow'
import { buildOrderCountSummary } from '../utils/orderCounts'
import {
  buildPendingPrintConfirmation,
  partitionPrintOutcome,
  type PendingPrintConfirmation,
} from '../utils/printConfirmationModel'
import {
  BrowserDownloadPrintProvider,
  resolveBrowserPrintJobs,
  shouldRequestPrintConfirmation,
} from '../providers/printing/BrowserDownloadPrintProvider'
import { resolveSelectionAfterBatch } from '../utils/selectedOrderSnapshot'
import { PRINT_NOT_CONFIRMED_MESSAGE } from '../utils/suratPrintFailureReasons'

// Popup KALDIRILDI: baskı doğrulaması artık sonuç alanındaki BLOKLAMAYAN
// inline panelden alınır. Toolbar sadeleşti: tek ana buton + Gelişmiş İşlemler.
// Veriler SENTETİKTİR.

function makeOrder(index: number): CargoOrder {
  return {
    id: `o-${index}`,
    orderNumber: `TESTORD-${index}`,
    marketplace: 'Trendyol',
    packageId: `PKG-${index}`,
    items: [{ id: `l-${index}`, productName: 'Test Ürün', quantity: 1 }],
  } as unknown as CargoOrder
}

const EMPTY = buildOrderCountSummary([])
type Props = Parameters<typeof SuratCreatePrintControls>[0]

function baseProps(overrides: Partial<Props> = {}): Props {
  const orders = [makeOrder(1)]
  return {
    orders,
    visibleOrders: orders,
    selectedIds: ['o-1'],
    listedCounts: EMPTY,
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

const pending = (over: Partial<PendingPrintConfirmation> = {}): PendingPrintConfirmation => ({
  provider: 'browser-print',
  orderIdentities: ['trendyol:package:pkg-1'],
  orderNumbers: ['TESTORD-1'],
  documentOrderIdentities: ['trendyol:package:pkg-1'],
  documentOrderNumbers: ['TESTORD-1'],
  createdCount: 1,
  reprintCount: 0,
  skipped: [],
  ...over,
})

const ADVANCED = [
  'Barkod Bas',
  'Ortak Barkod Oluştur / Tamamla',
  'Seçilenleri Yenile / Doğrula',
  'ZPL İndir',
  'Yazdır / Tekrar Yazdır',
  'Kargoya Verildi Yap',
]

// ---------------------------------------------------------------- 1 + 2
test('CONF-1/2: window.confirm ve window.alert ÇAĞRILMAZ', async () => {
  const user = userEvent.setup()
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  render(
    <SuratCreatePrintControls
      {...baseProps()}
      pendingPrintConfirmation={pending()}
      onAnswerPrintConfirmation={() => {}}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Evet, çıktı' }))
  expect(confirmSpy).not.toHaveBeenCalled()
  expect(alertSpy).not.toHaveBeenCalled()
  // Kaynakta da bloklayan dialog kalmadı.
  confirmSpy.mockRestore()
  alertSpy.mockRestore()
})

// ---------------------------------------------------------------- 3 + 4
test('CONF-3/4: inline panel görünür, MODAL/overlay YOK', () => {
  const { container } = render(
    <SuratCreatePrintControls
      {...baseProps()}
      pendingPrintConfirmation={pending()}
      onAnswerPrintConfirmation={() => {}}
    />,
  )
  const panel = screen.getByTestId('print-confirmation')
  expect(panel).toBeTruthy()
  expect(panel.textContent).toContain('Baskı sonucu bekleniyor')
  expect(panel.textContent).toContain('Etiketler yazıcıdan doğru şekilde çıktı mı?')
  expect(panel.textContent).toContain('1 etiket yazdırma penceresine gönderildi.')
  // Sayfayı karartan / kilitleyen bir katman YOK.
  expect(container.querySelector('[role="dialog"]')).toBe(null)
  expect(container.querySelector('.modal, .overlay, .backdrop')).toBe(null)
  expect(document.body.style.overflow).not.toBe('hidden')
  // Panel sonuç alanının içindedir, sayfanın geri kalanı erişilebilir kalır.
  expect(screen.getByRole('button', { name: 'Gelişmiş İşlemler' })).toBeTruthy()
})

// ---------------------------------------------------------------- 5..7
test('CONF-5/6/7: "Evet, çıktı" → yalnız belgedeki işler başarılı ve seçimden çıkar', async () => {
  const user = userEvent.setup()
  const answers: boolean[] = []
  render(
    <SuratCreatePrintControls
      {...baseProps()}
      pendingPrintConfirmation={pending({
        orderNumbers: ['TESTORD-1', 'TESTORD-2'],
        documentOrderNumbers: ['TESTORD-1'],
        skipped: [
          { orderNumber: 'TESTORD-2', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
        ],
      })}
      onAnswerPrintConfirmation={(ok) => answers.push(ok)}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Evet, çıktı' }))
  expect(answers).toEqual([true])

  // Cevap iş sonucuna GERÇEK sözleşmeyle uygulanır.
  const decision = resolveBrowserPrintJobs(
    {
      printCalled: true,
      printedOrderNumbers: ['TESTORD-1'],
      skipped: [
        { orderNumber: 'TESTORD-2', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
      ],
    },
    ['TESTORD-1', 'TESTORD-2'],
    answers[0],
  )
  expect(decision.jobs[0].ok).toBe(true)
  expect(decision.jobs[1].ok).toBe(false)
  expect(resolveSelectionAfterBatch(['o-1', 'o-2'], ['o-1'])).toEqual(['o-2'])
})

// ---------------------------------------------------------------- 8..10
test('CONF-8/9/10: "Hayır, çıkmadı" → READY, seçim ve printCount korunur', async () => {
  const user = userEvent.setup()
  const answers: boolean[] = []
  render(
    <SuratCreatePrintControls
      {...baseProps()}
      pendingPrintConfirmation={pending()}
      onAnswerPrintConfirmation={(ok) => answers.push(ok)}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Hayır, çıkmadı' }))
  expect(answers).toEqual([false])

  const decision = resolveBrowserPrintJobs(
    { printCalled: true, printedOrderNumbers: ['TESTORD-1'] },
    ['TESTORD-1'],
    answers[0],
  )
  expect(decision.confirmed).toBe(false)
  expect(decision.jobs[0].ok).toBe(false)
  expect(decision.jobs[0].errorMessage).toBe(PRINT_NOT_CONFIRMED_MESSAGE)
  // printJobId üretilmez -> printCount artmaz; sipariş seçimde kalır.
  expect(decision.jobs[0].printJobId).toBeUndefined()
  expect(resolveSelectionAfterBatch(['o-1'], [])).toEqual(['o-1'])
})

// ---------------------------------------------------------------- 11
test('CONF-11: cevap verilmeden yeni run BAŞLAMAZ', async () => {
  const user = userEvent.setup()
  let runs = 0
  render(
    <SuratCreatePrintControls
      {...baseProps({ onSuratCreateAndPrint: () => { runs += 1 } })}
      pendingPrintConfirmation={pending()}
      onAnswerPrintConfirmation={() => {}}
    />,
  )
  const main = screen.getByRole('button', {
    name: 'Baskı doğrulaması bekleniyor',
  }) as HTMLButtonElement
  expect(main.disabled).toBe(true)
  await user.click(main)
  expect(runs).toBe(0)
  // Gelişmiş İşlemler de kilitli (ikinci baskı/mutasyon açılamaz).
  expect(
    (screen.getByRole('button', { name: 'Gelişmiş İşlemler' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})

// ---------------------------------------------------------------- 12 + 13
test('CONF-12/13: normalde yalnız iki buton görünür, eski altı işlem gizli', () => {
  render(<SuratCreatePrintControls {...baseProps()} />)
  expect(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Gelişmiş İşlemler' })).toBeTruthy()
  for (const label of ADVANCED) {
    expect(screen.queryByRole('menuitem', { name: label }), label).toBe(null)
    expect(screen.queryByRole('button', { name: label }), label).toBe(null)
  }
  // Provider adı kullanıcı metinlerinde YOK.
  expect(screen.queryByText(/Sürat/)).toBe(null)
})

// ---------------------------------------------------------------- 14 + 15
test('CONF-14/15: menü açılır ve her işlem ESKİ handler\'ını çağırır', async () => {
  const user = userEvent.setup()
  const calls: string[] = []
  render(
    <SuratCreatePrintControls
      {...baseProps({
        onMarkPrinted: () => calls.push('onMarkPrinted'),
        onCreateShipments: () => calls.push('onCreateShipments'),
        onTrackShipments: () => calls.push('onTrackShipments'),
        onDownloadZpl: () => calls.push('onDownloadZpl'),
        onMarkHandedToCargo: () => calls.push('onMarkHandedToCargo'),
      })}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  for (const label of ADVANCED) {
    expect(screen.getByRole('menuitem', { name: label }), label).toBeTruthy()
  }
  // Menü açık kalır; her öğe KENDİ eski handler'ını çağırır.
  for (const label of [
    'Barkod Bas',
    'Ortak Barkod Oluştur / Tamamla',
    'ZPL İndir',
    'Kargoya Verildi Yap',
    'Seçilenleri Yenile / Doğrula',
  ]) {
    await user.click(screen.getByRole('menuitem', { name: label }))
  }
  expect(calls).toEqual([
    'onMarkPrinted',
    'onCreateShipments',
    'onDownloadZpl',
    'onMarkHandedToCargo',
    'onTrackShipments',
  ])
})

// ---------------------------------------------------------------- 16
test('CONF-16: dışarı tıklayınca menü kapanır', async () => {
  const user = userEvent.setup()
  render(
    <div>
      <button type="button">dışarısı</button>
      <SuratCreatePrintControls {...baseProps()} />
    </div>,
  )
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  expect(screen.getByRole('menuitem', { name: 'Barkod Bas' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'dışarısı' }))
  expect(screen.queryByRole('menuitem', { name: 'Barkod Bas' })).toBe(null)
})

// ---------------------------------------------------------------- 17
test('CONF-17: Escape menüyü kapatır ve klavye erişilebilirdir', async () => {
  const user = userEvent.setup()
  let runs = 0
  render(
    <SuratCreatePrintControls
      {...baseProps({ onSuratCreateAndPrint: () => { runs += 1 } })}
    />,
  )
  // Klavye ile odaklanıp Enter ile açılır.
  await user.tab()
  await user.tab()
  expect(document.activeElement?.textContent).toContain('Gelişmiş İşlemler')
  await user.keyboard('{Enter}')
  expect(screen.getByRole('menuitem', { name: 'Barkod Bas' })).toBeTruthy()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menuitem', { name: 'Barkod Bas' })).toBe(null)
  // Menü açılması İŞLEM BAŞLATMAZ.
  expect(runs).toBe(0)
})

// ---------------------------------------------------------------- 18 + 19
test('CONF-18/19: run sırasında menü disabled, bitince tekrar aktif', async () => {
  const user = userEvent.setup()
  const props = baseProps()
  const view = render(
    <SuratCreatePrintControls {...props} suratCreatePrintRunning={true} />,
  )
  const toggle = () =>
    screen.getByRole('button', { name: 'Gelişmiş İşlemler' }) as HTMLButtonElement
  expect(toggle().disabled).toBe(true)
  view.rerender(
    <SuratCreatePrintControls {...props} suratCreatePrintRunning={false} />,
  )
  expect(toggle().disabled).toBe(false)
  await user.click(toggle())
  expect(screen.getByRole('menuitem', { name: 'Barkod Bas' })).toBeTruthy()
})

// ---------------------------------------------------------------- 20
test('CONF-20: seçim yokken ilgili işlemler disabled kalır', async () => {
  const user = userEvent.setup()
  render(<SuratCreatePrintControls {...baseProps({ selectedIds: [] })} />)
  expect(
    (screen.getByRole('button', {
      name: 'Kargo Etiketi Oluştur ve Yazdır',
    }) as HTMLButtonElement).disabled,
  ).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  for (const label of ADVANCED) {
    expect(
      (screen.getByRole('menuitem', { name: label }) as HTMLButtonElement).disabled,
      label,
    ).toBe(true)
  }
})

// ---------------------------------------------------------------- 21 + 22
test('CONF-21/22: inline doğrulama YALNIZ browser-print modunda istenir', async () => {
  const provider = new BrowserDownloadPrintProvider()
  let asked = 0
  // Zebra/native: browser doğrulaması İSTENMEZ (endpoint jobs[] kaynak doğrusu).
  await provider
    .print({
      orders: [{ orderNumber: 'TESTORD-1', label: { zplContent: 'X' } }],
      printerSettings: { mode: 'local-agent', printerName: 'zebra' },
      action: 'print',
      confirmBrowserPrint: async () => { asked += 1; return true },
    } as never)
    .catch(() => undefined)
  expect(asked).toBe(0)
  // browser-print: belgeye giren iş varsa SORULUR.
  expect(
    shouldRequestPrintConfirmation(
      { printCalled: true, printedOrderNumbers: ['TESTORD-1'] },
      ['TESTORD-1'],
    ),
  ).toBe(true)
})

// ---------------------------------------------------------------- 23
test('CONF-23: kısmi batch\'te YALNIZ belgeye giren işler doğrulanır', () => {
  const request = {
    provider: 'browser-print' as const,
    orderNumbers: Array.from({ length: 39 }, (_, i) => `TESTORD-${i + 1}`),
    documentOrderNumbers: Array.from({ length: 38 }, (_, i) => `TESTORD-${i + 1}`),
    skipped: [
      { orderNumber: 'TESTORD-39', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
    ],
  }
  const model = buildPendingPrintConfirmation(request, {
    identityByOrderNumber: new Map(
      request.orderNumbers.map((n) => [n, `trendyol:package:${n.toLowerCase()}`]),
    ),
    createdCount: 38,
    reprintCount: 0,
  })
  expect(model.documentOrderNumbers.length).toBe(38)
  expect(model.documentOrderNumbers).not.toContain('TESTORD-39')
  expect(model.skipped.length).toBe(1)

  render(
    <SuratCreatePrintControls
      {...baseProps()}
      pendingPrintConfirmation={model}
      onAnswerPrintConfirmation={() => {}}
    />,
  )
  const panel = screen.getByTestId('print-confirmation')
  expect(panel.textContent).toContain('38 etiket yazdırma penceresine gönderildi.')
  expect(panel.textContent).toContain('sığmıyor')
})

// ---------------------------------------------------------------- 24
test('CONF-24: pending modelinde PII YOK', () => {
  const model = buildPendingPrintConfirmation(
    {
      provider: 'browser-print',
      orderNumbers: ['TESTORD-1'],
      documentOrderNumbers: ['TESTORD-1'],
      skipped: [],
    },
    {
      identityByOrderNumber: new Map([['TESTORD-1', 'trendyol:package:pkg-1']]),
      createdCount: 1,
      reprintCount: 0,
    },
  )
  const serialized = JSON.stringify(model)
  for (const leak of [
    'customerName', 'address', 'customerPhone', 'zplContent', 'technicalZpl',
    'barcodeRaw', '^XA', 'apiKey',
  ]) {
    expect(serialized.includes(leak), leak).toBe(false)
  }
  expect(Object.keys(model).sort()).toEqual([
    'createdCount', 'documentOrderIdentities', 'documentOrderNumbers',
    'orderIdentities', 'orderNumbers', 'provider', 'reprintCount', 'skipped',
  ])
})

// ---------------------------------------------------------------- 25
test('CONF-25: sonuç paneli "doğrulanmadı" ile GERÇEK hatayı ayırır', () => {
  const parts = partitionPrintOutcome({
    skipped: [
      { orderNumber: 'A', reason: PRINT_NOT_CONFIRMED_MESSAGE },
      { orderNumber: 'B', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
    ],
    failed: [{ orderNumber: 'C', reason: 'Sürat gönderisi oluşturulamadı.' }],
  })
  expect(parts.notConfirmed.map((i) => i.orderNumber)).toEqual(['A'])
  expect(parts.skipped.map((i) => i.orderNumber)).toEqual(['B'])
  expect(parts.failed.map((i) => i.orderNumber)).toEqual(['C'])

  render(
    <SuratCreatePrintControls
      {...baseProps()}
      suratCreatePrintResult={{
        selectedCount: 1,
        created: 1,
        existingReady: 0,
        reprinted: 0,
        printed: 0,
        skipped: [{ orderNumber: 'A', reason: PRINT_NOT_CONFIRMED_MESSAGE }],
        failed: [],
      }}
    />,
  )
  expect(screen.getByText('Baskı doğrulanmadı')).toBeTruthy()
  expect(screen.getByText('Yeniden yazdırılabilir: 1')).toBeTruthy()
  expect(screen.getByText('Başarısız: 0')).toBeTruthy()
})

// Bekleyen doğrulama varken sonuç paneli TEKRARLI gösterilmez.
test('CONF-26: doğrulama beklerken sonuç paneli aynı anda gösterilmez', () => {
  render(
    <SuratCreatePrintControls
      {...baseProps()}
      pendingPrintConfirmation={pending()}
      onAnswerPrintConfirmation={() => {}}
      suratCreatePrintResult={{
        selectedCount: 1, created: 1, existingReady: 0, reprinted: 0,
        printed: 0, skipped: [], failed: [],
      }}
    />,
  )
  expect(screen.getByTestId('print-confirmation')).toBeTruthy()
  expect(screen.queryByText('Kargo etiketi işlemi tamamlandı')).toBe(null)
})

// Panel içindeki cevap butonları yalnız cevabı iletir, run başlatmaz.
test('CONF-27: panel cevabı yeni create/print başlatmaz', async () => {
  const user = userEvent.setup()
  let runs = 0

  function Harness() {
    const [answered, setAnswered] = useState<boolean | undefined>()
    const runsRef = useRef(0)
    return (
      <>
        <p data-testid="answer">{String(answered)}</p>
        <SuratCreatePrintControls
          {...baseProps()}
          onSuratCreateAndPrint={() => {
            runsRef.current += 1
            runs = runsRef.current
          }}
          pendingPrintConfirmation={answered === undefined ? pending() : undefined}
          onAnswerPrintConfirmation={(ok) => setAnswered(ok)}
        />
      </>
    )
  }

  render(<Harness />)
  await user.click(screen.getByRole('button', { name: 'Hayır, çıkmadı' }))
  expect(screen.getByTestId('answer').textContent).toBe('false')
  expect(runs).toBe(0)
  // Cevap sonrası ana buton yeniden kullanılabilir (yeniden create DEĞİL, print).
  expect(
    (screen.getByRole('button', {
      name: 'Kargo Etiketi Oluştur ve Yazdır',
    }) as HTMLButtonElement).disabled,
  ).toBe(false)
})
