import { expect, test } from 'vitest'
import type { CargoOrder } from '../types/cargoflow'
import { runSuratCreateAndPrint } from '../services/suratCreateAndPrintOrchestrator'
import {
  buildCreateAdapter,
  buildPrintAdapter,
  resolvePrintedOrderNumbers,
} from '../services/suratOrchestratorDeps'
import {
  hasPendingServerOperation,
  isOperationInFlight,
  resetOperationRegistry,
  runExclusiveOperation,
} from '../services/suratOperationRegistry'
import { orderPackageIdentity } from '../utils/orderCounts'
import { resolveSelectionAfterBatch } from '../utils/selectedOrderSnapshot'

// App handler'ının bağımlılık zinciri — GERÇEK modüller, sahte (mock)
// bağımlılıklar. Sürat'a veya production endpoint'ine ÇAĞRI YOKTUR.
// Sipariş verileri SENTETİKTİR.

function makeOrder(index: number, overrides: Record<string, unknown> = {}): CargoOrder {
  return {
    id: `o-${index}`,
    orderNumber: `TESTORD-${index}`,
    marketplace: 'Trendyol',
    packageId: `PKG-${index}`,
    items: [{ id: `l-${index}`, productName: 'Test Ürün', quantity: 1 }],
    ...overrides,
  } as unknown as CargoOrder
}

interface RunOptions {
  orders: CargoOrder[]
  hasLabel?: (order: CargoOrder) => boolean
  isPrinted?: (order: CargoOrder) => boolean
  printResult?: {
    ok?: boolean
    jobs?: Array<{ orderNumber: string; ok: boolean; error?: string }>
  }
  onCreate?: (ids: string[]) => void
}

// App.tsx handler'ının bağımlılık kurulumunun aynısı (sahte servislerle).
async function runFlow(options: RunOptions) {
  const createdIds: string[] = []
  const labelled = new Set<string>()
  const hasLabel = (order: CargoOrder) =>
    labelled.has(String(order.id)) || Boolean(options.hasLabel?.(order))

  const outcome = await runSuratCreateAndPrint(options.orders, options.orders, {
    preflight: {
      isSuratOrder: () => true,
      resolveDesiBlock: () => null,
      resolveFitBlock: () => null,
      resolveDataBlock: () => null,
      hasPrintableLabel: hasLabel,
      isPrinted: (order) => Boolean(options.isPrinted?.(order)),
      // GERÇEK in-flight kaynağı: canonical sunucu sinyali + istemci kaydı.
      isInFlight: (order) =>
        hasPendingServerOperation(order) ||
        isOperationInFlight(orderPackageIdentity(order)),
    },
    createShipments: buildCreateAdapter({
      callCreate: async (list, ids) => {
        createdIds.push(...ids)
        options.onCreate?.(ids)
        ids.forEach((id) => labelled.add(String(id)))
        return { orders: list }
      },
      hasPrintableLabel: hasLabel,
    }),
    printLabels: buildPrintAdapter({
      callPrint: async (list) => ({ orders: list, printResult: options.printResult }),
    }),
  })
  return { outcome, createdIds }
}

const allJobsOk = (orders: CargoOrder[]) => ({
  ok: true,
  jobs: orders.map((order) => ({ orderNumber: String(order.orderNumber), ok: true })),
})

// ---------------------------------------------------------------- 1
test('HND-1: create YALNIZ needsCreate siparişlere gider', async () => {
  const orders = [makeOrder(1), makeOrder(2), makeOrder(3)]
  const { createdIds } = await runFlow({
    orders,
    // o-2 zaten hazır; create BEKLENMEZ.
    hasLabel: (order) => String(order.id) === 'o-2',
    printResult: allJobsOk(orders),
  })
  expect(createdIds.sort()).toEqual(['o-1', 'o-3'])
})

// ---------------------------------------------------------------- 2
test('HND-2: hazır (READY) sipariş create EDİLMEZ, doğrudan basılır', async () => {
  const orders = [makeOrder(1)]
  const { outcome, createdIds } = await runFlow({
    orders,
    hasLabel: () => true,
    printResult: allJobsOk(orders),
  })
  expect(createdIds).toEqual([])
  expect(outcome.created).toBe(0)
  expect(outcome.existingReady).toBe(1)
  expect(outcome.printed).toBe(1)
})

// ---------------------------------------------------------------- 3
test('HND-3: canonical sunucu sinyali in-flight ise create EDİLMEZ', async () => {
  const orders = [makeOrder(1, { operationStatus: 'SHIPMENT_PENDING' }), makeOrder(2)]
  const { outcome, createdIds } = await runFlow({
    orders,
    printResult: allJobsOk([orders[1]]),
  })
  expect(createdIds).toEqual(['o-2'])
  expect(outcome.results.some((r) => r.stage === 'CREATE_IN_PROGRESS')).toBe(true)
  expect(
    outcome.skipped.some((s) => s.orderNumber === 'TESTORD-1'),
  ).toBe(true)
})

// ---------------------------------------------------------------- 4
test('HND-4: istemci kaydında aktif işlem varsa create EDİLMEZ', async () => {
  resetOperationRegistry()
  const orders = [makeOrder(1), makeOrder(2)]
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  // o-1 için başka bir yerde başlamış işlem.
  const busy = runExclusiveOperation(orderPackageIdentity(orders[0]), async () => {
    await gate
  })

  const { createdIds } = await runFlow({
    orders,
    printResult: allJobsOk([orders[1]]),
  })
  expect(createdIds).toEqual(['o-2'])
  release()
  await busy
  resetOperationRegistry()
})

// ---------------------------------------------------------------- 5
test('HND-5: per-job ok=true olanlar BAŞARILI sayılır', async () => {
  const orders = [makeOrder(1), makeOrder(2)]
  const { outcome } = await runFlow({
    orders,
    printResult: {
      jobs: [
        { orderNumber: 'TESTORD-1', ok: true },
        { orderNumber: 'TESTORD-2', ok: true },
      ],
    },
  })
  expect(outcome.printed).toBe(2)
  expect(outcome.printedOrderIds.sort()).toEqual(['o-1', 'o-2'])
})

// ---------------------------------------------------------------- 6
test('HND-6: jobs[].ok=false olan sipariş SEÇİMDE KALIR', async () => {
  const orders = [makeOrder(1), makeOrder(2)]
  const { outcome } = await runFlow({
    orders,
    printResult: {
      jobs: [
        { orderNumber: 'TESTORD-1', ok: true },
        { orderNumber: 'TESTORD-2', ok: false, error: 'Yazıcı yanıt vermedi.' },
      ],
    },
  })
  const remaining = resolveSelectionAfterBatch(['o-1', 'o-2'], outcome.printedOrderIds)
  expect(remaining).toEqual(['o-2'])
})

// ---------------------------------------------------------------- 7
test('HND-7: printResult YOKSA kimse başarılı sayılmaz', async () => {
  const orders = [makeOrder(1), makeOrder(2)]
  const { outcome } = await runFlow({ orders, printResult: undefined })
  expect(outcome.printed).toBe(0)
  expect(outcome.printedOrderIds).toEqual([])
  expect(resolveSelectionAfterBatch(['o-1', 'o-2'], outcome.printedOrderIds))
    .toEqual(['o-1', 'o-2'])
})

// ---------------------------------------------------------------- 8
test('HND-8: global printResult.ok TEK BAŞINA başarı sayılmaz', async () => {
  const orders = [makeOrder(1), makeOrder(2)]
  const { outcome } = await runFlow({
    orders,
    // Global ok=true, ama HİÇBİR job onaylanmadı.
    printResult: {
      ok: true,
      jobs: [
        { orderNumber: 'TESTORD-1', ok: false, error: 'Baskı doğrulanmadı.' },
        { orderNumber: 'TESTORD-2', ok: false, error: 'Baskı doğrulanmadı.' },
      ],
    },
  })
  expect(outcome.printed).toBe(0)
  expect(outcome.printedOrderIds).toEqual([])
  // jobs VARSA global ok yok sayılır.
  expect(resolvePrintedOrderNumbers(
    { ok: true, jobs: [{ orderNumber: 'TESTORD-1', ok: false }] },
    ['TESTORD-1'],
  )).toEqual([])
  // jobs YOKSA mevcut servisin kendi kuralı korunur (yeni kural yok).
  expect(resolvePrintedOrderNumbers({ ok: true }, ['TESTORD-1']))
    .toEqual(['TESTORD-1'])
  expect(resolvePrintedOrderNumbers({ ok: false }, ['TESTORD-1'])).toEqual([])
})

// ---------------------------------------------------------------- 9
test('HND-9: registry aynı package için Promise\'i YENİDEN KULLANIR', async () => {
  resetOperationRegistry()
  const order = makeOrder(1)
  const identity = orderPackageIdentity(order)
  // Canonical kimlik normalize edilir (küçük harf); PII taşımaz.
  expect(identity).toBe('trendyol:package:pkg-1')

  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const task = async () => { calls += 1; await gate; return 'ok' }

  const first = runExclusiveOperation(identity, task)
  const second = runExclusiveOperation(identity, task)
  expect(calls).toBe(1)
  expect(first).toBe(second)
  expect(isOperationInFlight(identity)).toBe(true)

  release()
  expect(await first).toBe('ok')
  // Terminal olunca temizlenir; retry ancak BUNDAN SONRA mümkün.
  expect(isOperationInFlight(identity)).toBe(false)
  await runExclusiveOperation(identity, task)
  expect(calls).toBe(2)
  resetOperationRegistry()
})

// ---------------------------------------------------------------- 10
test('HND-10: create başarısı SONUÇTAN türetilir, "hata atmadı"dan değil', async () => {
  const orders = [makeOrder(1)]
  // callCreate hata atmaz ama basılabilir etiket OLUŞMAZ.
  const { outcome } = await runSuratCreateAndPrint(orders, orders, {
    preflight: {
      isSuratOrder: () => true,
      resolveDesiBlock: () => null,
      resolveFitBlock: () => null,
      resolveDataBlock: () => null,
      hasPrintableLabel: () => false,
      isPrinted: () => false,
      isInFlight: () => false,
    },
    createShipments: buildCreateAdapter({
      callCreate: async (list) => ({ orders: list }),
      hasPrintableLabel: () => false,
    }),
    printLabels: buildPrintAdapter({
      callPrint: async (list) => ({ orders: list, printResult: { ok: true } }),
    }),
  }).then((result) => ({ outcome: result }))

  expect(outcome.created).toBe(0)
  expect(outcome.printed).toBe(0)
  expect(outcome.failed.length).toBe(1)
})
