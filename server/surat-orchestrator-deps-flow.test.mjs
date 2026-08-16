import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Orkestratör adaptörleri: gerçek servis dönüşlerini sözleşmeye çevirir.
// BAŞARI SÖZLEŞMESİ GEVŞETİLMEZ. Veriler SENTETİKTİR.

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom', server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => { if (_vite) await _vite.close() })

const deps = () => load('/src/services/suratOrchestratorDeps.ts')
const order = (i, over = {}) => ({
  id: `o-${i}`, orderNumber: `114678700${i}`, packageId: `PKG-${i}`,
  marketplace: 'Trendyol', ...over,
})

test('DEP-1: print başarısı YALNIZ per-job ok alanından gelir', async () => {
  const { resolvePrintedOrderNumbers } = await deps()
  const jobs = {
    ok: true,
    jobs: [
      { orderNumber: 'A', ok: true },
      { orderNumber: 'B', ok: false, error: 'Zebra reddetti.' },
      { orderNumber: 'C', ok: true },
    ],
  }
  assert.deepEqual(resolvePrintedOrderNumbers(jobs, ['A', 'B', 'C']), ['A', 'C'])
  // printResult.ok=true olsa bile ok=false olan iş BAŞARILI SAYILMAZ.
  assert.equal(resolvePrintedOrderNumbers(jobs, ['A', 'B', 'C']).includes('B'), false)
})

test('DEP-2: jobs yoksa mevcut servis kuralı uygulanır', async () => {
  const { resolvePrintedOrderNumbers } = await deps()
  assert.deepEqual(resolvePrintedOrderNumbers({ ok: true }, ['A', 'B']), ['A', 'B'])
  assert.deepEqual(resolvePrintedOrderNumbers({ ok: false }, ['A', 'B']), [])
  // printResult hiç yoksa (iptal) HİÇBİRİ başarılı değildir.
  assert.deepEqual(resolvePrintedOrderNumbers(undefined, ['A', 'B']), [])
})

test('DEP-3: başarısız işlerin sebepleri güvenli biçimde taşınır', async () => {
  const { resolvePrintSkips } = await deps()
  const skips = resolvePrintSkips({
    jobs: [
      { orderNumber: 'A', ok: true },
      { orderNumber: 'B', ok: false, error: 'Zebra endpoint hatası.' },
      // GERÇEK PrintResult job'ı sebebi `errorMessage` alanında taşır.
      { orderNumber: 'C', ok: false, errorMessage: 'Kullanıcı baskıyı doğrulamadı.' },
      { orderNumber: 'D', ok: false },
    ],
  })
  assert.equal(skips.length, 3)
  assert.deepEqual(skips[0], { orderNumber: 'B', reason: 'Zebra endpoint hatası.' })
  assert.deepEqual(skips[1], {
    orderNumber: 'C', reason: 'Kullanıcı baskıyı doğrulamadı.',
  })
  // Sebep hiç yoksa AŞAMAYA ÖZGÜ güvenli metin (generic "doğrulanmadı" değil).
  assert.match(skips[2].reason, /baskı belgesine girmedi/)
})

test('DEP-4: create başarısı SONUÇTAN türetilir, varsayılmaz', async () => {
  const { buildCreateAdapter } = await deps()
  const before = [order(1), order(2)]
  const after = [
    order(1, { shipment: { barcodeRaw: '^XA^XZ' } }), // etiket oluştu
    order(2), // oluşmadı
  ]
  const adapter = buildCreateAdapter({
    callCreate: async () => ({ orders: after }),
    hasPrintableLabel: (o) => Boolean(o.shipment?.barcodeRaw),
  })
  const r = await adapter(before, ['o-1', 'o-2'])
  assert.deepEqual(r.failedIds, ['o-2'], 'etiketi doğrulanamayan BAŞARISIZ')
  assert.match(r.reasons['o-2'], /doğrulanamadı/)
  assert.equal(r.orders, after)
})

test('DEP-5: create çağrısı hata atmasa bile etiket yoksa başarı sayılmaz', async () => {
  const { buildCreateAdapter } = await deps()
  const adapter = buildCreateAdapter({
    callCreate: async (o) => ({ orders: o }), // sessizce hiçbir şey yapmadı
    hasPrintableLabel: () => false,
  })
  const r = await adapter([order(1)], ['o-1'])
  assert.deepEqual(r.failedIds, ['o-1'])
})

test('DEP-6: print adaptörü sipariş numaralarını doğru eşler', async () => {
  const { buildPrintAdapter } = await deps()
  const orders = [order(1), order(2)]
  const adapter = buildPrintAdapter({
    callPrint: async (o) => ({
      orders: o,
      printResult: {
        ok: true,
        jobs: [
          { orderNumber: '1146787001', ok: true },
          { orderNumber: '1146787002', ok: false, error: 'Kağıt bitti.' },
        ],
      },
    }),
  })
  const r = await adapter(orders, ['o-1', 'o-2'])
  assert.deepEqual(r.printedOrderNumbers, ['1146787001'])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].orderNumber, '1146787002')
})

test('DEP-7: baskı iptalinde hiçbir sipariş başarılı sayılmaz', async () => {
  const { buildPrintAdapter } = await deps()
  const adapter = buildPrintAdapter({
    callPrint: async (o) => ({ orders: o, printResult: undefined }),
  })
  const r = await adapter([order(1)], ['o-1'])
  assert.deepEqual(r.printedOrderNumbers, [], 'iptal → PRINTED yok')
  assert.deepEqual(r.skipped, [])
})

test('DEP-8: adaptör çıktısı PII TAŞIMAZ', async () => {
  const { buildPrintAdapter } = await deps()
  const o = order(1, {
    customerName: 'YAGMUR DIKMEN',
    address: 'YENI MAH KASTAMONU CADDESI',
    customerPhone: '5410000000',
  })
  const adapter = buildPrintAdapter({
    callPrint: async (list) => ({
      orders: list,
      printResult: { jobs: [{ orderNumber: o.orderNumber, ok: false, error: 'Hata.' }] },
    }),
  })
  const r = await adapter([o], ['o-1'])
  const serialized = JSON.stringify({
    printedOrderNumbers: r.printedOrderNumbers, skipped: r.skipped,
  })
  for (const pii of ['YAGMUR', 'DIKMEN', 'KASTAMONU', '5410000000']) {
    assert.equal(serialized.includes(pii), false, `PII sızdı: ${pii}`)
  }
})
