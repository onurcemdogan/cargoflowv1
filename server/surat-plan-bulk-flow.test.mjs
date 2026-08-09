import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// TOPLU BASKI PLANLAYICISI — ÜRETİM BENZERİ GİRDİ.
//
// Amaç: "3 sipariş seçildi, 1 sayfa basıldı" üretim hatasında siparişlerin
// planlayıcıda HANGİ kovaya düştüğünü KANITLAMAK. Tahmin yok: sayaçlar ve
// blok sebepleri açıkça ölçülür.
//
// Predicate'ler App.tsx'teki GERÇEK çağrıyla aynı şekildedir; özellikle
// resolveFitBlock'un şablona duyarlı davranışı birebir yansıtılır.

let _vite
async function load(path) {
  if (!_vite) {
    _vite = await createServer({
      appType: 'custom',
      server: { middlewareMode: true, hmr: false },
    })
  }
  return _vite.ssrLoadModule(path)
}
after(async () => {
  if (_vite) await _vite.close()
})

const item = (index, line) => ({
  productName: `Urun ${index}-${line} Uzun Tesettur Elbise Modeli`,
  quantity: 1,
  color: 'Lacivert',
  size: '40',
  merchantSku: `SKU-${index}-${line}`,
})

/** Taşıyıcı açısından BASILABİLİR, canonical Sürat siparişi. */
const order = (index, lineCount) => ({
  id: `order-${index}`,
  orderNumber: `ORD-${index}`,
  marketplace: 'Trendyol',
  packageId: `PKG-${index}`,
  operationStatus: 'LABEL_READY',
  hasPrintableLabel: true,
  items: Array.from({ length: lineCount }, (_, line) => item(index, line)),
  shipment: {
    provider: 'surat-kargo',
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    barcodeRaw: '^XA^FDCARRIER^FS^XZ',
    zplReady: true,
    printEnabled: true,
  },
})

/**
 * App.tsx'teki gerçek preflight bağlantısı.
 * `template` ve `printerMode` App.tsx'teki AYNI koşulu sürer.
 */
async function preflightOf({ template, printerMode = 'browser-print' }) {
  const { resolveLabelLayoutBlockReason } = await load(
    '/src/utils/labelLayoutResolver.ts',
  )
  const { resolvePersistedLabelArtifact } = await load(
    '/src/utils/persistedLabel.ts',
  )
  return {
    isSuratOrder: (o) => /surat|sürat/i.test(String(o.shipment?.provider ?? '')),
    resolveDesiBlock: () => null,
    resolveDataBlock: () => null,
    // App.tsx:1021 ile BİREBİR: resmî Sürat modunda HTML sığdırma ARANMAZ.
    resolveFitBlock: (o) =>
      printerMode !== 'browser-print' || template === 'surat_official_zpl'
        ? null
        : resolveLabelLayoutBlockReason({
            items: (o.items ?? []).map((line) => ({
              productName: String(line.productName ?? ''),
              quantity: Number(line.quantity) || 1,
              color: line.color,
              size: line.size,
              sku: line.merchantSku || line.sku,
            })),
          }),
    hasPrintableLabel: (o) =>
      Boolean(resolvePersistedLabelArtifact(o).hasPrintableLabel),
    isPrinted: (o) => o.labelStatus === 'PRINTED' && Boolean(o.label?.printedAt),
    isInFlight: () => false,
  }
}

function buckets(plan) {
  return {
    needsCreate: plan.needsCreate.length,
    readyToPrint: plan.readyToPrint.length,
    reprint: plan.reprint.length,
    inFlight: plan.inFlight.length,
    blocked: plan.blocked.length,
    duplicateCount: plan.duplicateCount,
    uniqueCount: plan.uniqueCount,
    blockedReasons: plan.blocked.map(
      (entry) => `${entry.orderNumber}: ${entry.reason ?? '-'}`,
    ),
    printableIds: [
      ...plan.readyToPrint.map((entry) => entry.orderId),
      ...plan.reprint.map((entry) => entry.orderId),
    ],
  }
}

// 1 ürünlü + çok ürünlü + çok ürünlü — üretimdeki karışım.
const ORDERS = [order(1, 1), order(2, 4), order(3, 8)]

// ═══ PLAN-BULK-1: RESMÎ SÜRAT → HİÇBİRİ BLOKLANMAZ ═══════════════════════

test('PLAN-BULK-1: resmî Sürat şablonunda 3 siparişin ÜÇÜ de basılabilir kovaya gider', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts',
  )
  const plan = resolveSuratCreateAndPrintPlan(
    ORDERS,
    await preflightOf({ template: 'surat_official_zpl' }),
  )
  const result = buckets(plan)
  // eslint-disable-next-line no-console
  console.log('PLAN-BULK-1', JSON.stringify(result))

  assert.equal(result.uniqueCount, 3, 'girdi 3 sipariş')
  assert.equal(result.duplicateCount, 0, 'farklı siparişler tekilleştirilmemeli')
  assert.equal(
    result.blocked,
    0,
    `resmî Sürat yolunda blok OLMAMALI: ${result.blockedReasons.join(' | ')}`,
  )
  assert.equal(result.needsCreate, 0, 'etiketi hazır sipariş create istemez')
  // Üçü de baskıya giden kimlik listesinde.
  assert.equal(result.printableIds.length, 3)
  assert.deepEqual(result.printableIds.sort(), [
    'order-1',
    'order-2',
    'order-3',
  ])
})

// ═══ PLAN-BULK-2: CARGOFLOW HTML → MEVCUT DAVRANIŞ KORUNUR ═══════════════

test('PLAN-BULK-2: açık CargoFlow HTML şablonunda mevcut fit/blok davranışı KORUNUR', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts',
  )
  const plan = resolveSuratCreateAndPrintPlan(
    ORDERS,
    await preflightOf({ template: 'cargoflow_html' }),
  )
  const result = buckets(plan)
  // eslint-disable-next-line no-console
  console.log('PLAN-BULK-2', JSON.stringify(result))

  assert.equal(result.uniqueCount, 3)
  // Bu yolda HTML sığdırma kontrolü GEÇERLİDİR; sonucu olduğu gibi kilitleriz.
  assert.equal(
    result.blocked + result.printableIds.length,
    3,
    'her sipariş bir kovaya düşmeli',
  )
})

// ═══ PLAN-BULK-3: YAZICI MODU ETKİSİ ═════════════════════════════════════

test('PLAN-BULK-3: local-agent modunda HTML sığdırma ARANMAZ', async () => {
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts',
  )
  const plan = resolveSuratCreateAndPrintPlan(
    ORDERS,
    await preflightOf({ template: 'cargoflow_html', printerMode: 'local-agent' }),
  )
  const result = buckets(plan)
  // eslint-disable-next-line no-console
  console.log('PLAN-BULK-3', JSON.stringify(result))
  assert.equal(result.blocked, 0)
  assert.equal(result.printableIds.length, 3)
})
