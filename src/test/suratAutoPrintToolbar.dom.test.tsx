import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { SuratCreatePrintControls } from '../components/SuratCreatePrintControls'
import type { CargoOrder } from '../types/cargoflow'
import { buildOrderCountSummary } from '../utils/orderCounts'
import {
  BrowserDownloadPrintProvider,
  hasPrintedDocument,
  resolveBrowserPrintJobs,
} from '../providers/printing/BrowserDownloadPrintProvider'
import { resolveSelectionAfterBatch } from '../utils/selectedOrderSnapshot'
import { NOT_IN_PRINT_DOCUMENT_MESSAGE } from '../utils/suratPrintFailureReasons'
// Kaynak sözleşmesi kontrolü için ham içerik (Vite ?raw).
import providerSource from '../providers/printing/BrowserDownloadPrintProvider.ts?raw'

// Baskı doğrulaması KALDIRILDI: baskı penceresi açıldıktan sonra akış
// kendiliğinden tamamlanır. Veriler SENTETİKTİR.

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

const ADVANCED = [
  'Barkod Bas',
  'Ortak Barkod Oluştur / Tamamla',
  'Seçilenleri Yenile / Doğrula',
  'ZPL İndir',
  'Yazdır / Tekrar Yazdır',
  'Kargoya Verildi Yap',
]

const debugOf = (
  rendered: string[],
  skipped: Array<{ orderNumber: string; reason: string }> = [],
  printCalled = true,
) => ({ printCalled, printedOrderNumbers: rendered, skipped })

// ---------------------------------------------------------------- 1..3
test('AUTO-1/2/3: doğrulama metinleri ve butonları DOM\'da YOK', () => {
  render(
    <SuratCreatePrintControls
      {...baseProps()}
      suratPrintNotice="1 etiket yazdırmaya gönderildi."
      suratCreatePrintResult={{
        selectedCount: 1, created: 1, existingReady: 0, reprinted: 0,
        printed: 1, skipped: [], failed: [],
      }}
    />,
  )
  expect(screen.queryByText('Baskı sonucu bekleniyor')).toBe(null)
  expect(screen.queryByText(/Etiketler yazıcıdan doğru şekilde çıktı mı/)).toBe(null)
  expect(screen.queryByRole('button', { name: 'Evet, çıktı' })).toBe(null)
  expect(screen.queryByRole('button', { name: 'Hayır, çıkmadı' })).toBe(null)
  expect(screen.queryByTestId('print-confirmation')).toBe(null)
})

// ---------------------------------------------------------------- 4 + 5
test('AUTO-4/5: window.confirm ve window.alert ÇAĞRILMAZ', async () => {
  const user = userEvent.setup()
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  let runs = 0
  render(
    <SuratCreatePrintControls
      {...baseProps({ onSuratCreateAndPrint: () => { runs += 1 } })}
    />,
  )
  await user.click(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  )
  expect(runs).toBe(1)
  expect(confirmSpy).not.toHaveBeenCalled()
  expect(alertSpy).not.toHaveBeenCalled()
  confirmSpy.mockRestore()
  alertSpy.mockRestore()
})

// ---------------------------------------------------------------- 6 + 7
test('AUTO-6/7: baskı sonrası run kendiliğinden biter, toolbar açılır', async () => {
  const user = userEvent.setup()

  function Harness() {
    const [running, setRunning] = useState(false)
    const [notice, setNotice] = useState<string | undefined>()
    return (
      <SuratCreatePrintControls
        {...baseProps()}
        suratCreatePrintRunning={running}
        suratPrintNotice={notice}
        onSuratCreateAndPrint={() => {
          setRunning(true)
          // Baskı yoluna verildi: CEVAP BEKLENMEZ, akış kapanır.
          void Promise.resolve().then(() => {
            setRunning(false)
            setNotice('1 etiket yazdırmaya gönderildi.')
          })
        }}
      />
    )
  }

  render(<Harness />)
  await user.click(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  )
  // Kullanıcı hiçbir şeye basmadan run tamamlanır.
  const main = await screen.findByRole('button', {
    name: 'Kargo Etiketi Oluştur ve Yazdır',
  })
  expect((main as HTMLButtonElement).disabled).toBe(false)
  expect(
    (screen.getByRole('button', { name: 'Gelişmiş İşlemler' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false)
  // Kısa, geçici bilgi satırı; müdahale istemez.
  const notice = screen.getByTestId('print-notice')
  expect(notice.textContent).toBe('1 etiket yazdırmaya gönderildi.')
  expect(notice.querySelector('button')).toBe(null)
})

// ---------------------------------------------------------------- 8
test('AUTO-8: belgeye giren siparişler per-job ok=true olur', () => {
  const decision = resolveBrowserPrintJobs(
    debugOf(['TESTORD-1', 'TESTORD-2']),
    ['TESTORD-1', 'TESTORD-2'],
  )
  expect(decision.printed).toBe(true)
  expect(decision.jobs.every((job) => job.ok)).toBe(true)
  expect(decision.jobs[0].printJobId).toBeTruthy()
})

// ---------------------------------------------------------------- 9 + 10
test('AUTO-9/10: product-fit atlanan başarılı SAYILMAZ, batch devam eder', () => {
  const rendered = Array.from({ length: 39 }, (_, i) => `TESTORD-${i + 1}`)
  const all = [...rendered, 'TESTORD-40']
  const decision = resolveBrowserPrintJobs(
    debugOf(rendered, [
      { orderNumber: 'TESTORD-40', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
    ]),
    all,
  )
  const ok = decision.jobs.filter((job) => job.ok)
  const notOk = decision.jobs.filter((job) => !job.ok)
  expect(ok.length).toBe(39)
  expect(notOk.length).toBe(1)
  expect(notOk[0].orderNumber).toBe('TESTORD-40')
  expect(notOk[0].errorMessage).toMatch(/sığmıyor/)
  // Atlanan sipariş seçimde KALIR.
  expect(
    resolveSelectionAfterBatch(['o-39', 'o-40'], ['o-39']),
  ).toEqual(['o-40'])
})

// ---------------------------------------------------------------- 11 + 12
test('AUTO-11/12: print host ve render hatasında BAŞARI YOK', async () => {
  // print çağrılmadı (host/print hatası): hiçbir iş başarılı değil.
  const noPrint = resolveBrowserPrintJobs(
    debugOf(['TESTORD-1'], [], false),
    ['TESTORD-1'],
  )
  expect(noPrint.printed).toBe(false)
  expect(noPrint.jobs[0].ok).toBe(false)

  // render başarısız: sipariş belgeye hiç girmedi.
  const noRender = resolveBrowserPrintJobs(debugOf([]), ['TESTORD-1'])
  expect(noRender.printed).toBe(false)
  expect(noRender.jobs[0].ok).toBe(false)
  expect(noRender.jobs[0].errorMessage).toBe(NOT_IN_PRINT_DOCUMENT_MESSAGE)
  expect(hasPrintedDocument(debugOf([]), ['TESTORD-1'])).toBe(false)

  // Provider teknik hata fırlatırsa da hiçbir iş başarılı olmaz.
  const provider = new BrowserDownloadPrintProvider()
  const result = await provider.print({
    orders: [{ orderNumber: 'TESTORD-1', label: { zplContent: 'X' } }],
    printerSettings: { mode: 'browser-print', printerName: 'test' },
    action: 'print',
  } as never)
  expect(result.ok).toBe(false)
  expect(result.jobs?.every((job) => job.ok === false)).toBe(true)
})

// ---------------------------------------------------------------- 13
test('AUTO-13: Zebra/native yolu browser-print değişikliğinden ETKİLENMEZ', () => {
  const src = providerSource
  // browser-print dalı yalnız kendi bloğunda karar verir.
  const browserBranch = src.slice(
    src.indexOf("if (input.printerSettings.mode === 'browser-print')"),
    src.indexOf("if (input.printerSettings.mode === 'download')"),
  )
  expect(browserBranch).toContain('resolveBrowserPrintJobs')
  // Zebra dalı endpoint jobs[] sonucunu OLDUĞU GİBİ taşır.
  const zebraBranch = src.slice(src.indexOf("'/api/printing/zebra/raw'"))
  expect(zebraBranch).toContain('jobs: data.jobs')
  expect(zebraBranch).not.toContain('resolveBrowserPrintJobs')
})

// ---------------------------------------------------------------- 15 + 16
test('AUTO-15/16: eski altı işlem ve provider-bağımsız buton metni korunur', async () => {
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
  expect(
    screen.getByRole('button', { name: 'Kargo Etiketi Oluştur ve Yazdır' }),
  ).toBeTruthy()
  expect(screen.queryByText(/Sürat Etiketi/)).toBe(null)
  await user.click(screen.getByRole('button', { name: 'Gelişmiş İşlemler' }))
  for (const label of ADVANCED) {
    expect(screen.getByRole('menuitem', { name: label }), label).toBeTruthy()
  }
  for (const label of [
    'Barkod Bas', 'Ortak Barkod Oluştur / Tamamla', 'ZPL İndir',
    'Kargoya Verildi Yap', 'Seçilenleri Yenile / Doğrula',
  ]) {
    await user.click(screen.getByRole('menuitem', { name: label }))
  }
  expect(calls).toEqual([
    'onMarkPrinted', 'onCreateShipments', 'onDownloadZpl',
    'onMarkHandedToCargo', 'onTrackShipments',
  ])
})

// ---------------------------------------------------------------- 17
test('AUTO-17: sonuç ve bilgi metinlerinde PII/ZPL YOK', () => {
  const { container } = render(
    <SuratCreatePrintControls
      {...baseProps()}
      suratPrintNotice="39 etiket yazdırmaya gönderildi."
      suratCreatePrintResult={{
        selectedCount: 40, created: 39, existingReady: 0, reprinted: 0,
        printed: 39,
        skipped: [
          { orderNumber: 'TESTORD-40', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
        ],
        failed: [],
      }}
    />,
  )
  const html = container.innerHTML
  for (const leak of [
    'customerName', 'address', 'customerPhone', '^XA', 'technicalZpl',
    'barcodeRaw', 'zplContent',
  ]) {
    expect(html.includes(leak), leak).toBe(false)
  }
  // Kısmi batch: kalıcı sonuç alanı sebebi gösterir.
  expect(screen.getByText('Kargo etiketi işlemi kısmen tamamlandı')).toBeTruthy()
  expect(screen.getByText('Yazdırılan: 39')).toBeTruthy()
  expect(screen.getByText('Atlanan: 1')).toBeTruthy()
})

// Toolbar kilidi YALNIZ run süresince.
test('AUTO-18: kilit yalnız run süresince; doğrulama beklenmez', () => {
  const props = baseProps()
  const view = render(
    <SuratCreatePrintControls {...props} suratCreatePrintRunning={true} />,
  )
  expect(
    (screen.getByRole('button', { name: 'Gelişmiş İşlemler' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  view.rerender(
    <SuratCreatePrintControls {...props} suratCreatePrintRunning={false} />,
  )
  expect(
    (screen.getByRole('button', { name: 'Gelişmiş İşlemler' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false)
})
