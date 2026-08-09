import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

// ORKESTRATÖR KARDİNALİTESİ — "3 seçildi, 1 basıldı" hatasının ölçümü.
//
// TEK SORU: runSuratCreateAndPrint içinde 3 sipariş HANGİ noktada düşüyor?
//
// CHECKPOINT A  plan.readyToPrint.length
// CHECKPOINT B  printableIds.length          (deps.printLabels'a giden id'ler)
// CHECKPOINT C  workingOrders içinde bu id'lere karşılık gelen GERÇEK sipariş
//
// Fixture kimlikleri sentetiktir; müşteri verisi YOKTUR.

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

/** Üretim senaryosu: 1 ürünlü, taşıyıcısı hazır, Sürat gönderisi. */
const order = (index) => ({
  id: `order-${index}`,
  orderNumber: `ORD-${index}`,
  marketplace: 'Trendyol',
  packageId: `PKG-${index}`,
  operationStatus: 'LABEL_READY',
  hasPrintableLabel: true,
  address: 'Sentetik Mahalle 1',
  customerName: 'SENTETIK ALICI',
  items: [
    {
      productName: `Urun ${index}`,
      quantity: 1,
      color: 'Lacivert',
      size: '40',
      merchantSku: `SKU-${index}`,
    },
  ],
  shipment: {
    provider: 'surat-kargo',
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    barcodeRaw: '^XA^FDCARRIER^FS^XZ',
    zplReady: true,
    printEnabled: true,
  },
})

/** App.tsx'teki gerçek preflight bağlantısı (şablona duyarlı fit kuralı). */
async function preflightOf(template) {
  const { resolveLabelLayoutBlockReason } = await load(
    '/src/utils/labelLayoutResolver.ts',
  )
  const { resolvePersistedLabelArtifact } = await load(
    '/src/utils/persistedLabel.ts',
  )
  return {
    isSuratOrder: (o) =>
      !o.cargoProviderName || /surat|sürat/i.test(String(o.cargoProviderName)),
    resolveDataBlock: (o) =>
      String(o.address ?? '').trim() && String(o.customerName ?? '').trim()
        ? null
        : 'Alıcı adı veya açık adres eksik.',
    resolveDesiBlock: () => null,
    resolveFitBlock: (o) =>
      template === 'surat_official_zpl'
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

/** Orkestratörü GERÇEK fonksiyonuyla koşar ve üç checkpoint'i toplar. */
async function measure(template, orders) {
  const { runSuratCreateAndPrint } = await load(
    '/src/services/suratCreateAndPrintOrchestrator.ts',
  )
  const { resolveSuratCreateAndPrintPlan } = await load(
    '/src/utils/suratCreatePrintPlan.ts',
  )
  const preflight = await preflightOf(template)

  // CHECKPOINT A — orkestratörün kullandığı AYNI planlayıcı, AYNI girdi.
  const plan = resolveSuratCreateAndPrintPlan(orders, preflight)

  const captured = { ids: [], orders: [], matched: [] }
  await runSuratCreateAndPrint(orders, orders, {
    preflight,
    createShipments: async () => {
      throw new Error('hazır siparişte create ÇAĞRILMAMALI')
    },
    // CHECKPOINT B + C — baskı servisine GERÇEKTE ne gidiyor?
    printLabels: async (workingOrders, ids) => {
      captured.ids = [...ids]
      captured.orders = workingOrders.map((entry) => String(entry.id))
      captured.matched = ids.filter((id) =>
        workingOrders.some((entry) => String(entry.id) === String(id)),
      )
      return {
        orders: workingOrders,
        printedOrderNumbers: ids.map(
          (id) =>
            workingOrders.find((entry) => String(entry.id) === String(id))
              ?.orderNumber ?? '',
        ),
        skipped: [],
      }
    },
  })

  return {
    template,
    input: orders.length,
    A_readyToPrint: plan.readyToPrint.length,
    A_reprint: plan.reprint.length,
    A_blocked: plan.blocked.length,
    A_blockedReasons: plan.blocked.map(
      (entry) => `${entry.orderNumber}: ${entry.reason ?? '-'}`,
    ),
    B_printableIds: captured.ids.length,
    B_ids: captured.ids,
    C_matchedOrders: captured.matched.length,
    C_workingOrders: captured.orders.length,
  }
}

const ORDERS = [order(1), order(2), order(3)]

test('ORCHESTRATOR-CARDINALITY-1: resmî Sürat, 3 tek-ürünlü sipariş → A=B=C=3', async () => {
  const result = await measure('surat_official_zpl', ORDERS)
  // eslint-disable-next-line no-console
  console.log('CARDINALITY-OFFICIAL', JSON.stringify(result))

  assert.equal(result.input, 3)
  // A
  assert.equal(
    result.A_readyToPrint + result.A_reprint,
    3,
    `CHECKPOINT A düştü: blocked=${result.A_blockedReasons.join(' | ')}`,
  )
  assert.equal(result.A_blocked, 0)
  // B
  assert.equal(result.B_printableIds, 3, 'CHECKPOINT B düştü (printableIds)')
  assert.deepEqual([...result.B_ids].sort(), ['order-1', 'order-2', 'order-3'])
  // C
  assert.equal(
    result.C_matchedOrders,
    3,
    'CHECKPOINT C düştü (workingOrders eşleşmesi)',
  )
})

test('ORCHESTRATOR-CARDINALITY-2: CargoFlow HTML AYNI girdide aynı kardinaliteyi verir', async () => {
  const result = await measure('cargoflow_html', ORDERS)
  // eslint-disable-next-line no-console
  console.log('CARDINALITY-HTML', JSON.stringify(result))
  // Tek ürünlü siparişlerde HTML sığdırma da bloklamaz → iki yol EŞİT.
  assert.equal(result.A_readyToPrint + result.A_reprint, 3)
  assert.equal(result.B_printableIds, 3)
  assert.equal(result.C_matchedOrders, 3)
})

test('ORCHESTRATOR-CARDINALITY-3: şablon seçimi sipariş SAYISINI değiştiremez', async () => {
  const official = await measure('surat_official_zpl', ORDERS)
  const html = await measure('cargoflow_html', ORDERS)
  // İLK AYRIŞMA ARANIYOR: üç checkpoint'te de sayılar EŞİT olmalı.
  assert.deepEqual(
    {
      A: official.A_readyToPrint + official.A_reprint,
      B: official.B_printableIds,
      C: official.C_matchedOrders,
    },
    {
      A: html.A_readyToPrint + html.A_reprint,
      B: html.B_printableIds,
      C: html.C_matchedOrders,
    },
    'şablon yolu kardinaliteyi DEĞİŞTİRMEMELİ',
  )
})
