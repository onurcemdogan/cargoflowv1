import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { SuratCreatePrintControls } from '../components/SuratCreatePrintControls'
import type { CargoOrder } from '../types/cargoflow'
import { buildOrderCountSummary } from '../utils/orderCounts'
import {
  runSuratCreateAndPrint,
  SURAT_CREATE_CONCURRENCY,
  type OrchestratorDeps,
} from '../services/suratCreateAndPrintOrchestrator'
import { buildCreateAdapter } from '../services/suratOrchestratorDeps'
import { hasCarrierShipmentEvidence, resolveOrderLifecycle } from '../utils/orderLifecycle'
import {
  CLOSED_ORDER_MESSAGE,
  POST_CREATE_NO_LABEL_MESSAGE,
} from '../utils/suratCreatePrintPlan'
import { formatSuratBulkRunSummary } from '../utils/suratBulkRunLog'

// ═══ HOTFIX-LABEL-PERF — TOPLU "KARGO ETİKETİ OLUŞTUR VE YAZDIR" ═══════════
//
// Üretim kanıtı: 25 seçim → Yeni 0 / Hazır 0 / Tekrar 0 / Yazdırılan 0 /
// Atlanan 0 / Başarısız 25; seçimin çoğu "Kargoya Verildi". Kök neden:
//   • planlayıcıda terminal kontrolü yoktu → kargoya verilmiş sipariş
//     create'e düşüyordu,
//   • create servisi onu AĞA ÇIKMADAN gerekçesiyle atlıyordu ama adaptör
//     gerekçeyi atıp generic "etiket doğrulanamadı" ile BAŞARISIZ sayıyordu,
//   • eşzamanlı create'ler paylaşılan `workingOrders`'ı birbirinin üzerine
//     yazıyordu.

type Mutable = Record<string, unknown>

function order(index: number, overrides: Mutable = {}): CargoOrder {
  return {
    id: `o-${index}`,
    orderNumber: `ON-${index}`,
    marketplace: 'Trendyol',
    packageId: `PKG-${index}`,
    marketplaceStatus: 'Picking',
    operationStatus: 'NEW',
    status: 'Yeni',
    cargoProviderName: 'Sürat Kargo Marketplace',
    cargoTrackingNumber: `7330${String(index).padStart(6, '0')}`,
    customerName: 'Test Alıcı',
    address: 'Örnek Sok. 1',
    city: 'İstanbul',
    items: [{ id: `l-${index}`, productName: 'Ürün', quantity: 1 }],
    ...overrides,
  } as unknown as CargoOrder
}

const ready = (index: number, overrides: Mutable = {}) => order(index, { hasPrintableLabel: true, operationStatus: 'LABEL_READY', ...overrides })
const printedBefore = (index: number, overrides: Mutable = {}) =>
  ready(index, { labelStatus: 'PRINTED', label: { printedAt: '2026-10-11T10:00:00.000Z' }, operationStatus: 'LABEL_PRINTED', ...overrides })
const shipped = (index: number, overrides: Mutable = {}) => order(index, { marketplaceStatus: 'Shipped', ...overrides })

interface Harness {
  deps: OrchestratorDeps
  createCalls: string[]
  lookupCalls: string[][]
  printCalls: string[][]
  maxConcurrentCreates: () => number
}

function harness(options: {
  createImpl?: (orders: CargoOrder[], id: string) => Promise<{ orders: CargoOrder[]; failedIds?: string[]; skippedIds?: string[]; unverifiedIds?: string[]; reasons?: Record<string, string> }>
  lookupFinds?: Set<string>
  printOk?: (id: string) => boolean
} = {}): Harness {
  const createCalls: string[] = []
  const lookupCalls: string[][] = []
  const printCalls: string[][] = []
  let active = 0
  let maxActive = 0
  const deps: OrchestratorDeps = {
    preflight: {
      isSuratOrder: (o) => /surat|sürat/i.test(String(o.cargoProviderName ?? '')),
      resolveDataBlock: (o) => (String(o.address ?? '').trim() ? null : 'Alıcı adı veya açık adres eksik.'),
      resolveDesiBlock: () => null,
      resolveFitBlock: () => null,
      hasPrintableLabel: (o) => o.hasPrintableLabel === true,
      isPrinted: (o) => o.labelStatus === 'PRINTED' && Boolean(o.label?.printedAt),
      isInFlight: (o) => ['SHIPMENT_PENDING', 'CREATE_IN_PROGRESS'].includes(String(o.operationStatus)),
      resolveLifecycle: resolveOrderLifecycle,
      hasCarrierEvidence: hasCarrierShipmentEvidence,
    },
    createShipments: async (orders, ids) => {
      const id = ids[0]
      createCalls.push(id)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        if (options.createImpl) return await options.createImpl(orders, id)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          orders: orders.map((o) => (o.id === id ? { ...o, hasPrintableLabel: true, operationStatus: 'LABEL_READY' } as CargoOrder : o)),
        }
      } finally {
        active -= 1
      }
    },
    lookupLabels: async (orders, ids) => {
      lookupCalls.push([...ids])
      return orders.map((o) => (ids.includes(o.id) && options.lookupFinds?.has(o.id) ? { ...o, hasPrintableLabel: true } as CargoOrder : o))
    },
    printLabels: async (orders, ids) => {
      printCalls.push([...ids])
      const printable = ids
        .map((id) => orders.find((o) => o.id === id))
        .filter((o): o is CargoOrder => Boolean(o && o.hasPrintableLabel === true))
        .filter((o) => (options.printOk ? options.printOk(o.id) : true))
      return { orders, printedOrderNumbers: printable.map((o) => o.orderNumber) }
    },
  }
  return { deps, createCalls, lookupCalls, printCalls, maxConcurrentCreates: () => maxActive }
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i)

test('HF-UI-1: worker READY hazırlamış tek sipariş → tıklamada Sürat create 0, doğrudan baskı', async () => {
  const orders = [ready(1)]
  const h = harness()
  const result = await runSuratCreateAndPrint(orders, orders, h.deps)
  expect(h.createCalls).toEqual([])
  expect(h.printCalls).toEqual([['o-1']])
  expect(result).toMatchObject({ created: 0, existingReady: 1, printed: 1 })
})

test('HF-UI-2: 25 READY → create 0, 25 sipariş TEK baskı çağrısında', async () => {
  const orders = range(1, 25).map((i) => ready(i))
  const h = harness()
  const result = await runSuratCreateAndPrint(orders, orders, h.deps)
  expect(h.createCalls).toHaveLength(0)
  expect(h.lookupCalls).toHaveLength(0)
  expect(h.printCalls).toHaveLength(1)
  expect(h.printCalls[0]).toHaveLength(25)
  expect(result).toMatchObject({ selectedCount: 25, created: 0, existingReady: 25, printed: 25 })
  expect(result.failed).toEqual([])
})

test('HF-UI-3: 25 yeni uygun sipariş → eşzamanlı create ≤ 2, sonuçlar bağımsız (biri düşse de diğerleri basılır)', async () => {
  const orders = range(1, 25).map((i) => order(i))
  const h = harness({
    createImpl: async (list, id) => {
      await new Promise((resolve) => setTimeout(resolve, 3))
      if (id === 'o-7') throw new Error('Sürat zaman aşımı')
      return { orders: list.map((o) => (o.id === id ? { ...o, hasPrintableLabel: true } as CargoOrder : o)) }
    },
  })
  const result = await runSuratCreateAndPrint(orders, orders, h.deps)
  expect(h.maxConcurrentCreates()).toBeLessThanOrEqual(SURAT_CREATE_CONCURRENCY)
  expect(h.createCalls).toHaveLength(25)
  expect(new Set(h.createCalls).size).toBe(25)
  expect(result.created).toBe(24)
  expect(result.printed).toBe(24)
  expect(result.failed).toEqual([{ orderNumber: 'ON-7', reason: 'Sürat zaman aşımı' }])
  expect(result.summary.createCalls).toBe(25)
})

test('HF-UI-4: karışık 25 (5 READY · 5 reprint · 5 yeni · 5 kargoda+artefakt · 5 geçersiz) → sayaçlar doğru, gruplar birbirini etkilemez', async () => {
  const orders = [
    ...range(1, 5).map((i) => ready(i)),
    ...range(6, 5).map((i) => printedBefore(i)),
    ...range(11, 5).map((i) => order(i)),
    ...range(16, 5).map((i) => shipped(i, { shipment: { trackingNumber: `T-${i}`, barcode: `B-${i}` } })),
    ...range(21, 5).map((i) => order(i, { address: '' })),
  ]
  const terminalIds = new Set(range(16, 5).map((i) => `o-${i}`))
  const h = harness({ lookupFinds: terminalIds })
  const result = await runSuratCreateAndPrint(orders, orders, h.deps)
  expect(h.createCalls.sort()).toEqual(range(11, 5).map((i) => `o-${i}`).sort())
  expect(h.lookupCalls).toEqual([range(16, 5).map((i) => `o-${i}`)])
  expect(result).toMatchObject({ selectedCount: 25, created: 5, existingReady: 10, reprinted: 5, printed: 20 })
  expect(result.skipped).toHaveLength(5)
  expect(result.skipped.every((s) => s.reason === 'Alıcı adı veya açık adres eksik.')).toBe(true)
  expect(result.failed).toEqual([])

  // Yeni-create grubu TAMAMEN düşse bile diğer gruplar basılır.
  const broken = harness({ lookupFinds: terminalIds, createImpl: async () => { throw new Error('Sürat erişilemedi') } })
  const partial = await runSuratCreateAndPrint(orders, orders, broken.deps)
  expect(partial).toMatchObject({ created: 0, existingReady: 10, reprinted: 5, printed: 15 })
  expect(partial.failed).toHaveLength(5)
  expect(partial.failed.every((f) => f.reason === 'Sürat erişilemedi')).toBe(true)
})

test('HF-UI-5: eşzamanlı create\'lerde güncelleme KAYBOLMAZ (eski workingOrders yarışı)', async () => {
  const orders = range(1, 6).map((i) => order(i))
  // Her create GİRDİ listesinden yalnız kendi siparişini günceller; ters
  // sırada biter. Paylaşılan liste üzerine yazılsaydı önce bitenin etiketi
  // sonra bitenin eski kopyasıyla EZİLİRDİ.
  const delays: Record<string, number> = { 'o-1': 30, 'o-2': 5, 'o-3': 25, 'o-4': 2, 'o-5': 15, 'o-6': 1 }
  const h = harness({
    createImpl: async (list, id) => {
      await new Promise((resolve) => setTimeout(resolve, delays[id]))
      return { orders: list.map((o) => (o.id === id ? { ...o, hasPrintableLabel: true } as CargoOrder : o)) }
    },
  })
  const updates: CargoOrder[][] = []
  const result = await runSuratCreateAndPrint(orders, orders, { ...h.deps, onOrdersUpdated: (list) => updates.push(list) })
  expect(result.created).toBe(6)
  expect(result.printed).toBe(6)
  expect(result.orders.filter((o) => o.hasPrintableLabel === true)).toHaveLength(6)
  expect(updates).toHaveLength(1)
  expect(updates[0].filter((o) => o.hasPrintableLabel === true)).toHaveLength(6)
})

test('HF-UI-6: Kargoya Verildi + kayıtlı etiket → create 0, reprint', async () => {
  const orders = [printedBefore(1, { marketplaceStatus: 'Shipped' })]
  const h = harness()
  const result = await runSuratCreateAndPrint(orders, orders, h.deps)
  expect(h.createCalls).toEqual([])
  expect(result).toMatchObject({ created: 0, reprinted: 1, printed: 1 })
})

test('HF-UI-7: Kargoya Verildi + taşıyıcı artefaktı var ama UI hidrate değil → kayıtlı etiket bulunur, İKİNCİ gönderi YOK', async () => {
  const orders = [shipped(1, { shipment: { trackingNumber: 'T-1', barcode: 'B-1' } })]
  const h = harness({ lookupFinds: new Set(['o-1']) })
  const result = await runSuratCreateAndPrint(orders, orders, h.deps)
  expect(h.createCalls).toEqual([])
  expect(h.lookupCalls).toEqual([['o-1']])
  expect(result).toMatchObject({ created: 0, existingReady: 1, printed: 1 })
})

test('HF-UI-8: Kargoya Verildi + hiçbir kanıt yok → AÇIK sebeple atlanır, generic başarısız DEĞİL', async () => {
  const orders = [shipped(1), order(2, { marketplaceStatus: 'Cancelled' })]
  const h = harness()
  const result = await runSuratCreateAndPrint(orders, orders, h.deps)
  expect(h.createCalls).toEqual([])
  expect(h.printCalls).toEqual([])
  expect(result.failed).toEqual([])
  expect(result.skipped).toEqual([
    { orderNumber: 'ON-2', reason: CLOSED_ORDER_MESSAGE },
    { orderNumber: 'ON-1', reason: POST_CREATE_NO_LABEL_MESSAGE },
  ])
})

test('HF-UI-9: UNKNOWN_AFTER_NETWORK / süren işlem → ikinci create 0; servis reddi gerekçesiyle taşınır', async () => {
  const pending = [order(1, { operationStatus: 'SHIPMENT_PENDING' })]
  const h = harness()
  const result = await runSuratCreateAndPrint(pending, pending, h.deps)
  expect(h.createCalls).toEqual([])
  expect(result.skipped[0].orderNumber).toBe('ON-1')

  // Sunucu belirsiz önceki create'i bloke etti: create adaptörü servis
  // gerekçesini KORUR (generic "doğrulanamadı" YOK) ve aynı çalışmada
  // yeniden denenmez.
  const unknownMessage = 'Önceki Sürat create çağrısının taşıyıcı sonucu kesinleşmedi. Yeni gönderi oluşturulmadı.'
  let serviceCalls = 0
  const adapter = buildCreateAdapter({
    callCreate: async (list, ids) => {
      serviceCalls += 1
      return {
        orders: list.map((o) => (ids.includes(o.id) ? { ...o, status: 'Hata', errorMessage: unknownMessage } as CargoOrder : o)),
        result: { bulkActionDebug: { failedOrderNumbers: ['ON-2'], skippedOrderNumbers: [], skippedReasons: [] } },
      }
    },
    hasPrintableLabel: (o) => o.hasPrintableLabel === true,
    deferVerification: true,
  })
  const orders = [order(2)]
  const h2 = harness()
  const outcome = await runSuratCreateAndPrint(orders, orders, { ...h2.deps, createShipments: adapter })
  expect(serviceCalls).toBe(1)
  expect(outcome.failed).toEqual([{ orderNumber: 'ON-2', reason: unknownMessage }])
  expect(outcome.created).toBe(0)
})

test('HF-UI-9b: servis siparişi ağa çıkmadan atladıysa "Atlanan" + servis gerekçesi (eski: generic Başarısız)', async () => {
  const adapter = buildCreateAdapter({
    callCreate: async (list) => ({
      orders: list,
      result: {
        bulkActionDebug: {
          failedOrderNumbers: [],
          skippedOrderNumbers: ['ON-3'],
          skippedReasons: ['ON-3: Pazaryeri statüsü create için uygun değil.'],
        },
      },
    }),
    hasPrintableLabel: (o) => o.hasPrintableLabel === true,
    deferVerification: true,
  })
  const orders = [order(3)]
  const h = harness()
  const outcome = await runSuratCreateAndPrint(orders, orders, { ...h.deps, createShipments: adapter })
  expect(outcome.failed).toEqual([])
  expect(outcome.skipped).toEqual([{ orderNumber: 'ON-3', reason: 'Pazaryeri statüsü create için uygun değil.' }])
})

test('HF-UI-10: 25 seçimde ekrandaki sayaçlar orkestratör sonucuyla BİREBİR; güvenli özet PII taşımaz', async () => {
  const orders = [
    ...range(1, 4).map((i) => ready(i)),
    ...range(5, 3).map((i) => printedBefore(i)),
    ...range(8, 6).map((i) => order(i)),
    ...range(14, 7).map((i) => shipped(i)),
    ...range(21, 5).map((i) => order(i, { address: '' })),
  ]
  const h = harness({ lookupFinds: new Set(['o-14', 'o-15']), printOk: (id) => id !== 'o-2' })
  const summaries: string[] = []
  const result = await runSuratCreateAndPrint(orders, orders, {
    ...h.deps,
    onRunSummary: (summary) => summaries.push(formatSuratBulkRunSummary(summary)),
  })
  render(
    <SuratCreatePrintControls
      orders={orders}
      visibleOrders={orders}
      selectedIds={orders.map((o) => o.id)}
      listedCounts={buildOrderCountSummary(orders)}
      activeTabLabel="Kargoya Verildi"
      busy={false}
      suratCreatePrintRunning={false}
      suratCreatePrintResult={result}
      onSuratCreateAndPrint={() => {}}
      onMarkPrinted={() => {}}
      onCreateShipments={() => {}}
      onTrackShipments={() => {}}
      onDownloadZpl={() => {}}
      onMarkHandedToCargo={() => {}}
      hasPrintableSelection
      hasShipmentCreatableSelection
      hasZplDownloadableSelection
      hasHandedToCargoSelection
    />,
  )
  expect(screen.getByText(`Seçilen: ${result.selectedCount}`)).toBeTruthy()
  expect(screen.getByText(`Yeni oluşturulan: ${result.created}`)).toBeTruthy()
  expect(screen.getByText(`Hazır etiket: ${result.existingReady}`)).toBeTruthy()
  expect(screen.getByText(`Tekrar baskı: ${result.reprinted}`)).toBeTruthy()
  expect(screen.getByText(`Yazdırılan: ${result.printed}`)).toBeTruthy()
  expect(screen.getByText(`Atlanan: ${result.skipped.length}`)).toBeTruthy()
  expect(screen.getByText(`Başarısız: ${result.failed.length}`)).toBeTruthy()
  // Beklenen sayılar (planlanan girdiden): 25 = 6 yeni + 6 hazır (4+2 bulunan)
  // + 3 reprint + 10 atlanan (5 eksik adres + 5 kargoda kanıtsız); 1 baskı reddi.
  expect(result).toMatchObject({ selectedCount: 25, created: 6, existingReady: 6, reprinted: 3, printed: 14 })
  expect(result.skipped).toHaveLength(10)
  expect(result.failed).toEqual([{ orderNumber: 'ON-2', reason: 'Baskı doğrulanmadı; durum değiştirilmedi.' }])
  expect(result.created + result.existingReady + result.reprinted + result.skipped.length).toBe(25)

  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toMatch(/^selected=25 blocked=5 inFlight=0 labelLookup=7 needsCreate=6 ready=6 reprint=3 createSuccess=6 createFail=0 createSkipped=0 createCalls=6 printSuccess=14 printFail=1 durationMs=\d+ preflightMs=\d+ lookupMs=\d+ createMs=\d+ hydrateMs=\d+ printMs=\d+$/)
  expect(summaries[0]).not.toMatch(/ON-|Test Alıcı|Örnek|7330/)
})
