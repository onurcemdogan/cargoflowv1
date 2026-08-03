import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Tek-buton orkestratörü: plan → create (concurrency 2) → print (mevcut
// per-job onay sözleşmesi). Veriler SENTETİKTİR.

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const orch = () => load('/src/services/suratCreateAndPrintOrchestrator.ts')

const order = (i) => ({
  id: `o-${i}`,
  orderNumber: `1146787${String(i).padStart(4, '0')}`,
  packageId: `PKG-${i}`,
  marketplace: 'Trendyol',
  items: [{ id: `l-${i}`, quantity: 1, productName: 'Ürün', barcode: `B${i}` }],
})

function deps(over = {}) {
  return {
    preflight: {
      isSuratOrder: () => true,
      resolveDesiBlock: () => null,
      resolveFitBlock: () => null,
      resolveDataBlock: () => null,
      hasPrintableLabel: () => true,
      isPrinted: () => false,
      isInFlight: () => false,
      ...(over.preflight ?? {}),
    },
    createShipments: over.createShipments
      ?? (async (orders) => ({ orders })),
    printLabels: over.printLabels
      ?? (async (orders, ids) => ({
        orders,
        printedOrderNumbers: ids.map((id) => `1146787${id.slice(2).padStart(4, '0')}`),
        skipped: [],
      })),
    onProgress: over.onProgress,
  }
}

test('ORCH-1: hepsi READY → create YOK, hepsi basılır', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 5 }, (_, i) => order(i))
  let createCalls = 0
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    createShipments: async (o) => { createCalls += 1; return { orders: o } },
  }))
  assert.equal(createCalls, 0, 'create çağrılmadı')
  assert.equal(r.existingReady, 5)
  assert.equal(r.printed, 5)
  assert.equal(r.printedOrderIds.length, 5)
  assert.equal(r.failed.length, 0)
})

test('ORCH-2: hepsi create gerekli → create sonra basılır', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 4 }, (_, i) => order(i))
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    preflight: { hasPrintableLabel: () => false },
  }))
  assert.equal(r.created, 4)
  assert.equal(r.printed, 4)
})

test('ORCH-3: create concurrency hiçbir an 2\'yi AŞMAZ', async () => {
  const { runSuratCreateAndPrint, SURAT_CREATE_CONCURRENCY } = await orch()
  assert.equal(SURAT_CREATE_CONCURRENCY, 2)
  const orders = Array.from({ length: 10 }, (_, i) => order(i))
  let inFlight = 0
  let peak = 0
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    preflight: { hasPrintableLabel: () => false },
    createShipments: async (o) => {
      inFlight += 1; peak = Math.max(peak, inFlight)
      await new Promise((res) => setTimeout(res, 10))
      inFlight -= 1
      return { orders: o }
    },
  }))
  assert.ok(peak <= 2, `create eşzamanlılık zirvesi ${peak}`)
  assert.ok(peak > 1, 'yine de paralel')
  assert.equal(r.created, 10)
})

test('ORCH-4: bir create başarısız, DİĞERLERİ devam eder', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 20 }, (_, i) => order(i))
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    preflight: { hasPrintableLabel: () => false },
    createShipments: async (o, ids) => {
      if (ids[0] === 'o-3' || ids[0] === 'o-7') {
        return { orders: o, failedIds: ids, reasons: { [ids[0]]: 'Sürat 014 hatası.' } }
      }
      return { orders: o }
    },
  }))
  assert.equal(r.created, 18, '18 başarılı')
  assert.equal(r.failed.length, 2)
  assert.equal(r.printed, 18, '18 başarılı etikete baskı devam eder')
  assert.match(r.failed[0].reason, /014/)
})

test('ORCH-5: create fırlatırsa da batch durmaz', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 4 }, (_, i) => order(i))
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    preflight: { hasPrintableLabel: () => false },
    createShipments: async (o, ids) => {
      if (ids[0] === 'o-1') throw new Error('Ağ hatası.')
      return { orders: o }
    },
  }))
  assert.equal(r.created, 3)
  assert.equal(r.failed.length, 1)
  assert.equal(r.printed, 3)
})

test('ORCH-6: blocked sipariş için create ÇAĞRILMAZ', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 3 }, (_, i) => order(i))
  const createdIds = []
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    preflight: {
      hasPrintableLabel: () => false,
      resolveFitBlock: (o) =>
        o.id === 'o-1' ? 'Ürün bilgileri tek etikete sığmıyor.' : null,
    },
    createShipments: async (o, ids) => { createdIds.push(...ids); return { orders: o } },
  }))
  assert.equal(createdIds.includes('o-1'), false, 'blocked için mutasyon YOK')
  assert.equal(r.created, 2)
  assert.equal(r.skipped.length, 1)
  assert.match(r.skipped[0].reason, /tek etikete sığmıyor/)
})

test('ORCH-7: in-flight sipariş ikinci kez create EDİLMEZ', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = [order(1)]
  const createdIds = []
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    preflight: { hasPrintableLabel: () => false, isInFlight: () => true },
    createShipments: async (o, ids) => { createdIds.push(...ids); return { orders: o } },
  }))
  assert.deepEqual(createdIds, [])
  assert.equal(r.created, 0)
  assert.equal(r.skipped.length, 1)
})

test('ORCH-8: PRINTED sipariş reprint grubuna gider, create YOK', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = [order(1)]
  const createdIds = []
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    preflight: { isPrinted: () => true },
    createShipments: async (o, ids) => { createdIds.push(...ids); return { orders: o } },
  }))
  assert.deepEqual(createdIds, [])
  assert.equal(r.reprinted, 1)
  assert.equal(r.printed, 1)
})

test('ORCH-9: baskı onaylanmazsa (iptal) HİÇBİR sipariş PRINTED sayılmaz', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 5 }, (_, i) => order(i))
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    // Kullanıcı iptal etti / Zebra fail: per-job onay YOK.
    printLabels: async (o) => ({ orders: o, printedOrderNumbers: [], skipped: [] }),
  }))
  assert.equal(r.printed, 0, 'printCalled başarı sayılmaz')
  assert.deepEqual(r.printedOrderIds, [], 'seçimden çıkarma YOK')
  assert.equal(r.failed.length, 5)
  for (const item of r.results) {
    if (item.stage === 'PRINTED') assert.fail('iptal sonrası PRINTED olmamalı')
  }
})

test('ORCH-10: kısmi baskı — yalnız onaylananlar PRINTED', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 40 }, (_, i) => order(i))
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    printLabels: async (o, ids) => {
      const ok = ids.filter((id) => id !== 'o-17')
      return {
        orders: o,
        printedOrderNumbers: ok.map((id) => `1146787${id.slice(2).padStart(4, '0')}`),
        skipped: [{ orderNumber: '11467870017', reason: 'Ürün bilgileri tek etikete sığmıyor.' }],
      }
    },
  }))
  assert.equal(r.printed, 39)
  assert.equal(r.printedOrderIds.length, 39)
  assert.equal(r.printedOrderIds.includes('o-17'), false)
  assert.ok(r.skipped.some((s) => s.orderNumber === '11467870017'))
})

test('ORCH-11: hiç printable yoksa baskı servisi ÇAĞRILMAZ', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = [order(1)]
  let printCalls = 0
  const r = await runSuratCreateAndPrint(orders, orders, deps({
    // Etiketi YOK + desi YOK → create'e girmez, basılabilir küme boş kalır.
    preflight: {
      hasPrintableLabel: () => false,
      resolveDesiBlock: () => 'Varsayılan Gönderi Desisi tanımlı değil.',
    },
    printLabels: async (o) => { printCalls += 1; return { orders: o } },
  }))
  assert.equal(printCalls, 0, 'print dialog açılmaz')
  assert.equal(r.printed, 0)
  assert.equal(r.skipped.length, 1)
})

test('ORCH-12: duplicate seçim tek create + tek baskı üretir', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const a = order(1)
  const createdIds = []
  const printedIds = []
  const r = await runSuratCreateAndPrint([a, { ...a }], [a], deps({
    preflight: { hasPrintableLabel: () => false },
    createShipments: async (o, ids) => { createdIds.push(...ids); return { orders: o } },
    printLabels: async (o, ids) => {
      printedIds.push(...ids)
      return { orders: o, printedOrderNumbers: [a.orderNumber], skipped: [] }
    },
  }))
  assert.equal(createdIds.length, 1, 'tek create')
  assert.equal(printedIds.length, 1, 'tek fiziksel etiket')
  assert.equal(r.selectedCount, 1)
})

test('ORCH-13: aşama bazlı ilerleme raporlanır', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 3 }, (_, i) => order(i))
  const phases = []
  await runSuratCreateAndPrint(orders, orders, deps({
    preflight: { hasPrintableLabel: () => false },
    onProgress: (p) => phases.push(p.phase),
  }))
  for (const phase of ['preflight', 'create', 'prepare', 'print', 'done']) {
    assert.ok(phases.includes(phase), `${phase} raporlanmalı`)
  }
})

test('ORCH-14: sonuç PII TAŞIMAZ, doğru aggregate üretir', async () => {
  const { runSuratCreateAndPrint } = await orch()
  const orders = Array.from({ length: 3 }, (_, i) => {
    const o = order(i)
    o.customerName = 'YAGMUR DIKMEN'
    o.address = 'YENI MAH KASTAMONU CADDESI'
    o.customerPhone = '5410000000'
    return o
  })
  const r = await runSuratCreateAndPrint(orders, orders, deps())
  const serialized = JSON.stringify({
    selectedCount: r.selectedCount, created: r.created,
    existingReady: r.existingReady, reprinted: r.reprinted,
    printed: r.printed, skipped: r.skipped, failed: r.failed,
    results: r.results, printedOrderIds: r.printedOrderIds,
  })
  for (const pii of ['YAGMUR', 'DIKMEN', 'KASTAMONU CADDESI', '5410000000']) {
    assert.equal(serialized.includes(pii), false, `PII sızdı: ${pii}`)
  }
  assert.equal(r.selectedCount, 3)
  assert.equal(r.printed, 3)
  assert.equal(r.results.length, 3)
})
