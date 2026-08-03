import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Seçim anlık görüntüsü: sekme/statü değişince seçim ve özeti KAYBOLMAZ.
// Veriler SENTETİKTİR.

const here = dirname(fileURLToPath(import.meta.url))
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

const snap = () => load('/src/utils/selectedOrderSnapshot.ts')

function order(i, over = {}) {
  return {
    id: `o-${i}`,
    orderNumber: `1146787${String(i).padStart(4, '0')}`,
    packageId: `PKG-${i}`,
    marketplace: 'Trendyol',
    operationStatus: 'NEW',
    labelStatus: 'READY',
    items: [
      { id: `l-${i}a`, quantity: 1, productName: 'Ürün A', barcode: `B${i}a` },
    ],
    ...over,
  }
}

test('SEL-1: seçim özeti GÖRÜNÜR listeden değil, tüm siparişlerden hesaplanır', async () => {
  const { buildSelectedOrderSnapshot } = await snap()
  const all = Array.from({ length: 20 }, (_, i) => order(i))
  const selectedIds = all.map((o) => o.id)
  // Create sonrası siparişler Etiket Hazır'a geçti; kullanıcı hâlâ
  // "Yeni Siparişler" sekmesinde → görünür liste BOŞ.
  const s = buildSelectedOrderSnapshot(all, selectedIds, [])
  assert.equal(s.selectedCount, 20, 'seçim korunur')
  assert.equal(s.packageCount, 20, '0 paket DEĞİL')
  assert.equal(s.lineCount, 20, '0 kalem DEĞİL')
  assert.equal(s.quantityTotal, 20, '0 ürün DEĞİL')
  assert.equal(s.outsideCurrentViewCount, 20)
})

test('SEL-2: paket / kalem / adet ayrı ayrı doğru toplanır', async () => {
  const { buildSelectedOrderSnapshot } = await snap()
  const multi = order(1, {
    items: [
      { id: 'l1', quantity: 2, productName: 'A', barcode: 'B1' },
      { id: 'l2', quantity: 3, productName: 'B', barcode: 'B2' },
    ],
  })
  const s = buildSelectedOrderSnapshot([multi, order(2)], ['o-1', 'o-2'], [])
  assert.equal(s.packageCount, 2)
  assert.equal(s.lineCount, 3, '2 + 1 kalem')
  assert.equal(s.quantityTotal, 6, '2 + 3 + 1 adet')
})

test('SEL-3: seçili olmayan sipariş özete girmez; sıra korunur', async () => {
  const { buildSelectedOrderSnapshot } = await snap()
  const all = [order(1), order(2), order(3)]
  const s = buildSelectedOrderSnapshot(all, ['o-3', 'o-1'], all)
  assert.equal(s.selectedCount, 2)
  // Sıra allOrders sırasına göre deterministiktir.
  assert.deepEqual(s.entries.map((e) => e.orderId), ['o-1', 'o-3'])
  assert.deepEqual(s.entries.map((e) => e.order), [0, 1])
  assert.equal(s.outsideCurrentViewCount, 0)
})

test('SEL-4: aynı paket kimliği iki kayıtla gelirse TEK sayılır', async () => {
  const { buildSelectedOrderSnapshot } = await snap()
  const a = order(1)
  const dup = { ...order(1), id: 'o-1-dup' }
  const s = buildSelectedOrderSnapshot([a, dup], ['o-1', 'o-1-dup'], [])
  assert.equal(s.selectedCount, 1, 'canonical kimlikle tekilleşir')
  assert.equal(s.packageCount, 1)
})

test('SEL-5: bilgi metni yalnız gerçekten görünmeyen seçim varken çıkar', async () => {
  const { buildSelectedOrderSnapshot, describeSelectionOutsideView } = await snap()
  const all = Array.from({ length: 20 }, (_, i) => order(i))
  const ids = all.map((o) => o.id)
  const hidden = buildSelectedOrderSnapshot(all, ids, [])
  assert.equal(
    describeSelectionOutsideView(hidden, 'Etiket Hazır'),
    "20 seçili siparişten 20'si artık Etiket Hazır sekmesinde.",
  )
  // Hepsi görünürse gereksiz uyarı YOK.
  const visible = buildSelectedOrderSnapshot(all, ids, all)
  assert.equal(describeSelectionOutsideView(visible, 'Etiket Hazır'), '')
  // Seçim yoksa metin yok.
  assert.equal(
    describeSelectionOutsideView(
      buildSelectedOrderSnapshot(all, [], []), 'Etiket Hazır'), '')
})

test('SEL-6: işlem sonrası yalnız BAŞARILILAR seçimden çıkar', async () => {
  const { resolveSelectionAfterBatch } = await snap()
  const selected = ['o-1', 'o-2', 'o-3', 'o-4']
  // o-2 ve o-3 başarıyla yazdırıldı; o-1 blocked, o-4 failed.
  const next = resolveSelectionAfterBatch(selected, ['o-2', 'o-3'])
  assert.deepEqual(next, ['o-1', 'o-4'], 'başarısızlar seçili kalır')
  // Hiçbiri basılmadıysa (iptal) seçim AYNEN kalır.
  assert.deepEqual(resolveSelectionAfterBatch(selected, []), selected)
})

test('SEL-7: snapshot PII TAŞIMAZ', async () => {
  const { buildSelectedOrderSnapshot } = await snap()
  const o = order(1, {
    customerName: 'YAGMUR DIKMEN',
    address: 'YENI MAH KASTAMONU CADDESI NO 113/B',
    customerPhone: '5410000000',
  })
  const s = buildSelectedOrderSnapshot([o], ['o-1'], [])
  const serialized = JSON.stringify(s)
  for (const pii of ['YAGMUR', 'DIKMEN', 'KASTAMONU CADDESI', '5410000000']) {
    assert.equal(serialized.includes(pii), false, `PII sızdı: ${pii}`)
  }
  assert.match(serialized, /1146787/, 'sipariş numarası taşınır')
})

test('SEL-8: OrdersPage seçim özetini SEÇİMDEN alır (regresyon kilidi)', () => {
  const src = readFileSync(join(here, '..', 'src/pages/OrdersPage.tsx'), 'utf8')
  // Toolbar artık listedCounts değil selectionCounts kullanır.
  assert.match(src, /selectionCounts\.packageCount/)
  assert.match(src, /selectionCounts\.lineCount/)
  assert.match(src, /selectionCounts\.quantityTotal/)
  const toolbar = src.slice(src.indexOf('{selectionText}'), src.indexOf('toolbar-actions'))
  assert.equal(
    /listedCounts\.(packageCount|lineCount|quantityTotal)/.test(toolbar), false,
    'seçim satırında görünür-liste sayacı kalmadı',
  )
  assert.match(src, /buildSelectedOrderSnapshot\(orders, selectedIds/)
  assert.match(src, /describeSelectionOutsideView/)
})

test('SEL-9: mevcut toplu işlem butonları KALDIRILMADI', () => {
  const src = readFileSync(join(here, '..', 'src/pages/OrdersPage.tsx'), 'utf8')
  for (const handler of [
    'onMarkPrinted', 'onCreateShipments', 'onDownloadZpl', 'onMarkHandedToCargo',
  ]) {
    assert.ok(src.includes(handler), `${handler} korunmalı`)
  }
})
