import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// Toplu baskıda SİPARİŞ BAZINDA izolasyon + tek-buton planlayıcı.
//
// CANLI HATA: 40 seçili siparişten 1'inin ürün metni sığmayınca
// buildCleanLabelHtml içindeki korumasız .map() hatayı dışarı fırlatıyor,
// BÜTÜN batch iptal oluyordu (printCalled=false, 40/40 basılmamış).
//
// Veriler SENTETİKTİR; gerçek müşteri bilgisi yoktur.

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

const TNO = '25220148446193'
const TEMPLATE = { id: 't', widthMm: 100, heightMm: 100, fields: [] }
const LONG =
  'Çok Uzun Ürün Adı ' +
  'Saten Detaylı Şifon Astarlı Tesettür Abiye '.repeat(6)

function order(i, items) {
  const tno = String(11467870000 + i)
  const barcode = String(1230000000 + i)
  return {
    id: `o-${i}`,
    orderNumber: `1146787${String(i).padStart(4, '0')}`,
    packageId: `PKG-${i}`,
    marketplace: 'Trendyol',
    cargoTrackingNumber: `72700329415252${i}`,
    operationStatus: 'LABEL_READY',
    labelStatus: 'READY',
    desi: 2,
    desiSource: 'manual_total',
    items,
    shipment: {
      provider: 'surat-kargo',
      trackingNumber: tno, tNo: tno, kargoTakipNo: tno,
      barcode, barkodNo: barcode, barcodeValue: barcode,
      ozelKargoTakipNo: `72700329415252${i}`,
      lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
      candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
      zplReady: true, printEnabled: true,
      barcodeRaw:
        `^XA^PW799^LL799^FO60,120^BCN,140,Y,N,N^FD${barcode}^FS` +
        `^FO500,20^A0N,26,26^FDT.No: ${TNO}^FS^XZ`,
    },
  }
}
const okItems = (i) => [{
  id: `l-${i}`, quantity: 1, productName: `Saten Elbise ${i}`,
  color: 'Lacivert', size: '40', merchantSku: `SECIL-${300 + i}`,
}]
const overflowItems = (i) => [
  { id: `l-${i}a`, quantity: 1, productName: LONG, color: 'Siyah', size: '38', merchantSku: 'SKU-L1' },
  { id: `l-${i}b`, quantity: 1, productName: `${LONG} B`, color: 'Bordo', size: '40', merchantSku: 'SKU-L2' },
]

// ── kök neden: tek sipariş bütün batch'i durdurmaz ────────────────────────

test('BP-1: 40 sipariş, hepsi printable → 40 sayfa, atlanan yok', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const orders = Array.from({ length: 40 }, (_, i) => order(i, okItems(i)))
  const doc = buildCleanLabelDocument(orders, TEMPLATE)
  assert.equal(doc.printable.length, 40)
  assert.equal(doc.skipped.length, 0)
  assert.equal((doc.html.match(/class="label-page"/g) ?? []).length, 40)
})

test('BP-2: 40 sipariş, 1 ürün taşması → 39 basılır, YALNIZ 1 atlanır', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const orders = Array.from({ length: 40 }, (_, i) =>
    order(i, i === 17 ? overflowItems(i) : okItems(i)))
  const doc = buildCleanLabelDocument(orders, TEMPLATE)
  assert.equal(doc.printable.length, 39, 'batch TAMAMEN iptal olmaz')
  assert.equal(doc.skipped.length, 1)
  assert.equal((doc.html.match(/class="label-page"/g) ?? []).length, 39)
  // Hangi siparişin neden atlandığı KAYBOLMAZ.
  assert.equal(doc.skipped[0].orderNumber, orders[17].orderNumber)
  assert.match(doc.skipped[0].reason, /tek etikete sığmıyor/)
  // Atlanan sipariş belgeye GİRMEZ.
  assert.equal(doc.printable.some((p) => p.model.orderNumber === orders[17].orderNumber), false)
})

test('BP-3: eski davranış (buildCleanLabelHtml) geriye dönük uyumlu', async () => {
  const { buildCleanLabelHtml } = await load('/src/utils/browserLabelPrint.ts')
  const orders = Array.from({ length: 3 }, (_, i) =>
    order(i, i === 1 ? overflowItems(i) : okItems(i)))
  // Artık FIRLATMAZ: sığanlar basılır.
  const html = buildCleanLabelHtml(orders, TEMPLATE)
  assert.equal((html.match(/class="label-page"/g) ?? []).length, 2)
  // Hiçbiri sığmazsa yine açık hata verir.
  assert.throws(
    () => buildCleanLabelHtml([order(9, overflowItems(9))], TEMPLATE),
    /tek etikete sığmıyor/,
  )
})

test('BP-4: taşan siparişin durumu ve printCount DEĞİŞMEZ', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const bad = order(1, overflowItems(1))
  const good = order(2, okItems(2))
  const before = { status: bad.labelStatus, op: bad.operationStatus }
  const doc = buildCleanLabelDocument([good, bad], TEMPLATE)
  assert.equal(doc.printable.length, 1)
  assert.equal(doc.printable[0].model.orderNumber, good.orderNumber)
  // Render sipariş nesnesini MUTATE etmez.
  assert.equal(bad.labelStatus, before.status)
  assert.equal(bad.operationStatus, before.op)
  assert.equal(bad.label?.printCount ?? 0, 0, 'printCount artmaz')
})

test('BP-5: aynı sipariş iki kez seçilirse TEK fiziksel etiket', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const o = order(5, okItems(5))
  const doc = buildCleanLabelDocument([o, { ...o }], TEMPLATE)
  assert.equal((doc.html.match(/class="label-page"/g) ?? []).length, 1)
})

test('BP-6: atlanan sipariş sebebi PII TAŞIMAZ', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const bad = order(1, overflowItems(1))
  bad.customerName = 'YAGMUR DIKMEN'
  bad.address = 'YENI MAH KASTAMONU CADDESI NO 113/B'
  bad.customerPhone = '5410000000'
  const doc = buildCleanLabelDocument([order(2, okItems(2)), bad], TEMPLATE)
  const serialized = JSON.stringify(doc.skipped)
  for (const pii of ['YAGMUR', 'DIKMEN', 'KASTAMONU CADDESI', '5410000000']) {
    assert.equal(serialized.includes(pii), false, `PII sızdı: ${pii}`)
  }
  assert.match(serialized, /1146787/, 'sipariş numarası raporlanır')
})

// ── tek-buton planlayıcı ──────────────────────────────────────────────────

function planInput(over = {}) {
  return {
    isSuratOrder: () => true,
    resolveDesiBlock: () => null,
    resolveFitBlock: () => null,
    resolveDataBlock: () => null,
    hasPrintableLabel: () => true,
    isPrinted: () => false,
    isInFlight: () => false,
    ...over,
  }
}

test('BP-7: planlayıcı — create / hazır / reprint / in-flight / blocked ayrımı', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const a = order(1, okItems(1)) // etiketi yok → create
  const b = order(2, okItems(2)) // hazır
  const c = order(3, okItems(3)) // basılmış → reprint
  const d = order(4, okItems(4)) // in-flight
  const e = order(5, okItems(5)) // blocked (desi)
  const plan = resolveSuratCreateAndPrintPlan([a, b, c, d, e], planInput({
    hasPrintableLabel: (o) => o.id !== 'o-1' && o.id !== 'o-5',
    isPrinted: (o) => o.id === 'o-3',
    isInFlight: (o) => o.id === 'o-4',
    resolveDesiBlock: (o) =>
      o.id === 'o-5' ? 'Varsayılan Gönderi Desisi tanımlı değil.' : null,
  }))
  assert.deepEqual(plan.needsCreate.map((x) => x.orderId), ['o-1'])
  assert.deepEqual(plan.readyToPrint.map((x) => x.orderId), ['o-2'])
  assert.deepEqual(plan.reprint.map((x) => x.orderId), ['o-3'])
  assert.deepEqual(plan.inFlight.map((x) => x.orderId), ['o-4'])
  assert.deepEqual(plan.blocked.map((x) => x.orderId), ['o-5'])
  assert.match(plan.blocked[0].reason, /Varsayılan Gönderi Desisi/)
  assert.equal(plan.uniqueCount, 5)
})

test('BP-8: basılmış sipariş için create ASLA çağrılmaz', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const plan = resolveSuratCreateAndPrintPlan(
    [order(1, okItems(1))],
    planInput({ isPrinted: () => true }),
  )
  assert.equal(plan.needsCreate.length, 0, 'create yok')
  assert.equal(plan.reprint.length, 1)
})

test('BP-9: in-flight sipariş ikinci kez create edilmez', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const plan = resolveSuratCreateAndPrintPlan(
    [order(1, okItems(1))],
    planInput({ hasPrintableLabel: () => false, isInFlight: () => true }),
  )
  assert.equal(plan.needsCreate.length, 0)
  assert.equal(plan.inFlight.length, 1)
  assert.equal(plan.inFlight[0].stage, 'CREATE_IN_PROGRESS')
})

test('BP-10: desi ve fit kontrolü MUTASYONDAN ÖNCE bloklar', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  // Desi yok + etiket yok → create'e GİRMEZ.
  const noDesi = resolveSuratCreateAndPrintPlan(
    [order(1, okItems(1))],
    planInput({
      hasPrintableLabel: () => false,
      resolveDesiBlock: () => 'Varsayılan Gönderi Desisi tanımlı değil.',
    }),
  )
  assert.equal(noDesi.needsCreate.length, 0, 'create YAPILMAZ')
  assert.equal(noDesi.blocked.length, 1)
  // Fit hatası, etiketi HAZIR olsa bile bloklar (bozuk etiket basılmaz).
  const noFit = resolveSuratCreateAndPrintPlan(
    [order(2, overflowItems(2))],
    planInput({ resolveFitBlock: () => 'Ürün bilgileri tek etikete sığmıyor.' }),
  )
  assert.equal(noFit.readyToPrint.length, 0)
  assert.equal(noFit.blocked.length, 1)
  assert.match(noFit.blocked[0].reason, /tek etikete sığmıyor/)
})

test('BP-11: duplicate seçim tekilleştirilir, sıra korunur', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const a = order(1, okItems(1))
  const b = order(2, okItems(2))
  const plan = resolveSuratCreateAndPrintPlan([a, b, { ...a }, b], planInput())
  assert.equal(plan.duplicateCount, 2)
  assert.equal(plan.uniqueCount, 2)
  assert.deepEqual(plan.readyToPrint.map((x) => x.orderId), ['o-1', 'o-2'])
})

test('BP-12: desteklenmeyen kargo firması açık sebeple bloklanır', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts')
  const plan = resolveSuratCreateAndPrintPlan(
    [order(1, okItems(1))],
    planInput({ isSuratOrder: () => false }),
  )
  assert.equal(plan.blocked.length, 1)
  // Mesaj PROVIDER-BAĞIMSIZ: ileride yeni adaptör eklenince aynı metin kalır.
  assert.match(plan.blocked[0].reason, /tek adımda etiket oluşturma henüz desteklenmiyor/)
  assert.equal(/Sürat/.test(plan.blocked[0].reason), false, 'kullanıcı metninde provider adı YOK')
})

test('BP-13: sonuç özeti atlananları İSİMLE gösterir', async () => {
  const { summarizeBatchOutcome } = await load('/src/utils/suratCreatePrintPlan.ts')
  const text = summarizeBatchOutcome({
    processed: 40, created: 18, reusedExisting: 20, reprinted: 1,
    printed: 38,
    skipped: [
      { orderNumber: '11467870043', reason: 'Ürün bilgileri tek etikete sığmıyor.' },
      { orderNumber: '11467870044', reason: 'Varsayılan Gönderi Desisi tanımlı değil.' },
    ],
  })
  assert.match(text, /40 sipariş işlendi/)
  assert.match(text, /18 yeni Sürat etiketi oluşturuldu/)
  assert.match(text, /38 yazdırıldı/)
  assert.match(text, /2 atlandı/)
  assert.match(text, /11467870043 — Ürün bilgileri tek etikete sığmıyor\./)
  assert.match(text, /11467870044 — Varsayılan Gönderi Desisi tanımlı değil\./)
})

// ── korunan davranışlar ───────────────────────────────────────────────────

test('BP-14: persisted ZPL ve payload byte-for-byte KORUNUR', async () => {
  const { ZebraZplLabelProvider } = await load(
    '/src/providers/labels/ZebraZplLabelProvider.ts')
  const o = order(1, okItems(1))
  const label = await new ZebraZplLabelProvider().generateSingle({
    order: o, shipment: o.shipment, template: { id: 't' },
    desiConfig: { defaultUnitDesi: null },
  })
  assert.equal(label.zplContent, o.shipment.barcodeRaw, 'byte-for-byte')
  assert.equal(label.zplSource, 'surat.ortakBarkod.BarcodeRaw')
})

test('BP-15: HTML belgesinde barkod/QR/T.No payload DEĞİŞMEZ', async () => {
  const { buildCleanLabelDocument } = await load('/src/utils/browserLabelPrint.ts')
  const o = order(7, okItems(7))
  const doc = buildCleanLabelDocument([o], TEMPLATE)
  assert.ok(doc.html.includes(`data-barcode-value="${o.shipment.barcode}"`))
  assert.ok(doc.html.includes(o.shipment.ozelKargoTakipNo), 'QR payload')
  assert.ok(doc.html.includes(`T.No: <strong>${o.shipment.trackingNumber}</strong>`))
  assert.match(doc.html, />2,00</, 'desi gösterimi korunur')
})
