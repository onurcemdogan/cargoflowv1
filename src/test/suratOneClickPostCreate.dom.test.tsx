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
import {
  buildCreateAdapter,
  buildPrintAdapter,
} from '../services/suratOrchestratorDeps'
import { resolveBrowserPrintJobs } from '../providers/printing/BrowserDownloadPrintProvider'
import { resolveSelectionAfterBatch } from '../utils/selectedOrderSnapshot'

// GERÇEK DOM: kullanıcı tek butona basar; host senkron hazırlanır, create
// çözülür, aşamalar ilerler, baskı çağrılır ve onay olumsuzsa durum/seçim
// KORUNUR. Veriler SENTETİKTİR; gerçek Sürat veya yazıcı çağrısı YOKTUR.

interface Trace {
  hostPreparedBeforeAwait: boolean
  hostCalls: number
  createCalls: string[][]
  printCalls: Array<Array<string | undefined>>
  phases: string[]
  released: number
  remainingSelection?: string[]
}

function makeOrder(index: number, extra: Record<string, unknown> = {}): CargoOrder {
  return {
    id: `o-${index}`,
    orderNumber: `TESTORD-${index}`,
    marketplace: 'Trendyol',
    packageId: `PKG-${index}`,
    items: [{ id: `l-${index}`, productName: 'Test Ürün', quantity: 1 }],
    ...extra,
  } as unknown as CargoOrder
}
const withLabel = (index: number) => makeOrder(index, { labelReady: true })
const hasLabel = (order: CargoOrder) =>
  Boolean((order as unknown as { labelReady?: boolean }).labelReady)

const EMPTY = buildOrderCountSummary([])

function Harness({
  trace,
  confirmPrint,
  hostReady = true,
  createGate,
}: {
  trace: Trace
  confirmPrint: () => boolean
  hostReady?: boolean
  createGate?: Promise<void>
}) {
  const orders = [makeOrder(1)]
  const selectedIds = ['o-1']
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SuratCreatePrintProgress | undefined>()
  const [result, setResult] = useState<SuratCreatePrintResult | undefined>()
  const [message, setMessage] = useState('')
  const [current, setCurrent] = useState<CargoOrder[]>(orders)
  const active = useRef(false)
  // Lint: prop nesnesi render sonrasi DOGRUDAN mutate edilemez; izler
  // mutable ref uzerinden toplanir (yalniz event handler icinde).
  const traceRef = useRef(trace)

  return (
    <>
      {message ? <p data-testid="orders-message">{message}</p> : null}
      <p data-testid="row-state">
        {hasLabel(current[0]) ? 'Etiket Hazır' : 'Barkod Bekliyor'}
      </p>
      <SuratCreatePrintControls
        orders={current}
        visibleOrders={current}
        selectedIds={selectedIds}
        listedCounts={EMPTY}
        activeTabLabel="Yeni Siparişler"
        busy={false}
        suratCreatePrintRunning={running}
        suratCreatePrintProgress={progress}
        suratCreatePrintResult={result}
        onMarkPrinted={() => {}}
        onCreateShipments={() => {}}
        onTrackShipments={() => {}}
        onDownloadZpl={() => {}}
        onMarkHandedToCargo={() => {}}
        hasPrintableSelection
        hasShipmentCreatableSelection
        hasZplDownloadableSelection
        hasHandedToCargoSelection
        onSuratCreateAndPrint={() => {
          if (active.current) return
          // 1) İLK AWAIT'TEN ÖNCE, senkron: print host.
          traceRef.current.hostCalls += 1
          traceRef.current.hostPreparedBeforeAwait =
            traceRef.current.createCalls.length === 0 && traceRef.current.printCalls.length === 0
          if (!hostReady) {
            setMessage('Yazdırma penceresi açılamadı.')
            return
          }
          active.current = true
          setRunning(true)
          void runSuratCreateAndPrint(orders, orders, {
            preflight: {
              isSuratOrder: () => true,
              resolveDesiBlock: () => null,
              resolveFitBlock: () => null,
              resolveDataBlock: () => null,
              hasPrintableLabel: hasLabel,
              isPrinted: () => false,
              isInFlight: () => false,
            },
            createShipments: buildCreateAdapter({
              callCreate: async (list, ids) => {
                traceRef.current.createCalls.push([...ids])
                if (createGate) await createGate
                return {
                  orders: list.map((item) =>
                    ids.includes(String(item.id)) ? withLabel(1) : item,
                  ),
                }
              },
              hasPrintableLabel: hasLabel,
            }),
            printLabels: buildPrintAdapter({
              callPrint: async (list, ids) => {
                // Baskıya GELEN sipariş güncel mi?
                traceRef.current.printCalls.push(
                  ids.map((id) => {
                    const found = list.find(
                      (item) => String(item.id) === String(id),
                    )
                    return found && hasLabel(found) ? 'READY' : 'STALE'
                  }),
                )
                const decision = resolveBrowserPrintJobs(
                  { printCalled: true, printedOrderNumbers: ['TESTORD-1'] },
                  ['TESTORD-1'],
                  confirmPrint(),
                )
                return {
                  orders: list,
                  printResult: { ok: decision.confirmed, jobs: decision.jobs },
                }
              },
            }),
            onProgress: (p) => {
              traceRef.current.phases.push(p.phase)
              setProgress(p)
            },
            onOrdersUpdated: (updated) => setCurrent(updated),
          }).then((outcome) => {
            if (outcome.printed === 0) traceRef.current.released += 1
            setResult(outcome)
            traceRef.current.remainingSelection = resolveSelectionAfterBatch(
              selectedIds,
              outcome.printedOrderIds,
            )
            setRunning(false)
            active.current = false
          })
        }}
      />
    </>
  )
}

const newTrace = (): Trace => ({
  hostPreparedBeforeAwait: false,
  hostCalls: 0,
  createCalls: [],
  printCalls: [],
  phases: [],
  released: 0,
})

const mainButton = () =>
  screen.getByRole('button', { name: /Kargo Etiketi Oluştur ve Yazdır/ })

test('PCPDOM-1: tıklama → host senkron, create, aşamalar, baskı (onay VAR)', async () => {
  const user = userEvent.setup()
  const trace = newTrace()
  render(<Harness trace={trace} confirmPrint={() => true} />)

  expect(screen.getByTestId('row-state').textContent).toBe('Barkod Bekliyor')
  await user.click(mainButton())
  await screen.findByText('Kargo etiketi işlemi tamamlandı')

  // Host ilk await'ten ÖNCE, tek kez.
  expect(trace.hostPreparedBeforeAwait).toBe(true)
  expect(trace.hostCalls).toBe(1)
  // Create → print aynı click içinde.
  expect(trace.createCalls).toEqual([['o-1']])
  expect(trace.printCalls).toEqual([['READY']])
  // Aşamalar gerçek sırayla.
  expect(trace.phases).toEqual([
    'preflight', 'create', 'create', 'prepare', 'print', 'done',
  ])
  // Create sonrası satır canonical duruma geçti (manuel yenileme YOK).
  expect(screen.getByTestId('row-state').textContent).toBe('Etiket Hazır')
  expect(screen.getByText('Yazdırılan: 1')).toBeTruthy()
  expect(trace.remainingSelection).toEqual([])
})

test('PCPDOM-2: onay OLUMSUZ → başarı yok, seçim ve sonuç paneli korunur', async () => {
  const user = userEvent.setup()
  const trace = newTrace()
  render(<Harness trace={trace} confirmPrint={() => false} />)

  await user.click(mainButton())
  await screen.findByText('Baskı doğrulanmadı')

  expect(trace.printCalls).toEqual([['READY']])
  expect(screen.getByText('Yazdırılan: 0')).toBeTruthy()
  expect(screen.getByText('Yeni oluşturulan: 1')).toBeTruthy()
  // Sipariş READY kalır ve seçimden ÇIKMAZ; host serbest bırakılır.
  expect(screen.getByTestId('row-state').textContent).toBe('Etiket Hazır')
  expect(trace.remainingSelection).toEqual(['o-1'])
  expect(trace.released).toBe(1)
  // İkinci create planlanmaz.
  expect(trace.createCalls.length).toBe(1)
})

test('PCPDOM-3: host hazır değilse create HİÇ çağrılmaz, açık mesaj görünür', async () => {
  const user = userEvent.setup()
  const trace = newTrace()
  render(<Harness trace={trace} confirmPrint={() => true} hostReady={false} />)

  await user.click(mainButton())

  expect(trace.hostCalls).toBe(1)
  expect(trace.createCalls).toEqual([])
  expect(trace.printCalls).toEqual([])
  expect(screen.getByTestId('orders-message').textContent).toMatch(
    /Yazdırma penceresi/,
  )
  // Statü değişmedi.
  expect(screen.getByTestId('row-state').textContent).toBe('Barkod Bekliyor')
  expect(screen.queryByText('Kargo etiketi işlemi tamamlandı')).toBe(null)
})

test('PCPDOM-4: run SÜRERKEN ikinci tıklama → tek host, tek run', async () => {
  const user = userEvent.setup()
  const trace = newTrace()
  // Create ASKIDA tutulur: ikinci tıklama run devam ederken düşer.
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  render(
    <Harness trace={trace} confirmPrint={() => true} createGate={gate} />,
  )

  await user.click(mainButton())
  // Run sürüyor: ana buton gerçekten disabled ve ikinci tıklama iş açmıyor.
  const busy = screen.getByRole('button', { name: /oluşturuluyor|Ön kontrol/ })
  expect((busy as HTMLButtonElement).disabled).toBe(true)
  await user.click(busy)

  expect(trace.hostCalls).toBe(1)
  expect(trace.createCalls).toEqual([['o-1']])

  release()
  await screen.findByText('Kargo etiketi işlemi tamamlandı')
  expect(trace.createCalls).toEqual([['o-1']])
  expect(trace.printCalls.length).toBe(1)
})
