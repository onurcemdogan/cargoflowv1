import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

// Üç UI/akış düzeltmesi regresyonu:
//  1) Kullanıcıya görünen "Sipariş No" 727... Trendyol referansını gösterir;
//     canonical orderNumber (114...) korunur ve iki değerle de arama çalışır.
//  2) Dashboard "Yenile" marketplace sync (/api/orders/sync) ÇAĞIRMAZ; yalnız
//     yerel DB reload + analytics local refresh yapar.
//  3) "Son Operasyonlar" aksiyon yetkileri kalıcı (canonical operationStatus +
//     persisted metadata) kaynaktan türetilir; sayfa yenilemesinde korunur ve
//     Dashboard projection'ında raw ZPL/PII bulunmaz.

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function makeOrder(over = {}) {
  return {
    id: over.id ?? 'A',
    marketplace: 'Trendyol',
    externalOrderId: over.externalOrderId ?? 'EXT-A',
    orderNumber: over.orderNumber ?? '1149999999',
    packageId: over.packageId ?? 'PKG-A',
    shipmentPackageId: over.packageId ?? 'PKG-A',
    cargoTrackingNumber: over.cargoTrackingNumber ?? '7270039999999',
    marketplaceStatus: over.marketplaceStatus ?? 'Created',
    operationStatus: over.operationStatus ?? 'LABEL_READY',
    labelStatus: over.labelStatus ?? 'READY',
    source: 'real',
    status: 'Etiket Hazır',
    customerName: 'Ada L',
    customerPhone: '5550001122',
    customerEmail: 'ada@example.com',
    address: 'Açık adres 1',
    city: 'İstanbul',
    district: 'Kadıköy',
    totalAmount: 100,
    createdAt: '2026-07-26T08:00:00Z',
    orderDate: '2026-07-26T08:00:00Z',
    items: [{ id: 'l1', quantity: 1, price: 100, productName: 'Ürün' }],
    shipment: over.shipment,
    ...over,
  }
}
const printableShipment = (over = {}) => ({
  id: 's', provider: 'surat-kargo', trackingNumber: '11820824092123',
  trackingUrl: '', shipmentCode: '', barcodeValue: '01252765588',
  barcode: '01252765588', barkodNo: '01252765588', tNo: '11820824092123',
  ozelKargoTakipNo: '7270039999999',
  barcodeRaw: '^XA^FD01252765588^FS^XZ', printEnabled: true, zplReady: true,
  verifiedShipment: false, dispatchRegistrationConfirmed: false,
  lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
  candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
  ...over,
})

test('Faz 1+3: display no, arama, capability, projection güvenliği', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, })
  t.after(() => vite.close())
  const { displayOrderNumber, sourceOrderNumber } = await vite.ssrLoadModule('/src/utils/orderDisplay.ts')
  const { resolveOrderActionCapabilities } = await vite.ssrLoadModule('/src/utils/orderActionCapabilities.ts')
  const { buildVisibleOrders } = await vite.ssrLoadModule('/src/utils/orderClassification.ts')
  const { buildDashboardViewModel } = await vite.ssrLoadModule('/src/dashboard/dashboardViewModel.ts')

  // (Faz 1) 727... mevcutsa gösterilir; 114... kaynak olarak kalır.
  const order = makeOrder({ shipment: printableShipment() })
  assert.equal(displayOrderNumber(order), '7270039999999')
  assert.equal(sourceOrderNumber(order), '1149999999')
  // 727 yoksa canonical orderNumber gösterilir.
  const noRef = makeOrder({ id: 'B', cargoTrackingNumber: '', shipment: undefined })
  assert.equal(displayOrderNumber(noRef), '1149999999')
  assert.equal(sourceOrderNumber(noRef), '')

  // (Faz 1) Arama hem 727... hem 114... ile bulur.
  const base = {
    persistentOrders: [order], selectedTab: 'all', marketplaceFilter: 'all',
    operationStatusFilter: 'all', cargoFilter: 'all',
    dateFilter: { preset: 'all' }, searchQuery: '',
    now: new Date('2026-07-27T00:00:00Z'),
  }
  assert.equal(buildVisibleOrders({ ...base, searchQuery: '7270039999999' }).visibleOrders.length, 1, '727 ile bulunur')
  assert.equal(buildVisibleOrders({ ...base, searchQuery: '1149999999' }).visibleOrders.length, 1, '114 ile bulunur')

  // (Faz 3) LABEL_READY + persisted etiket → print/download aktif.
  const capReady = resolveOrderActionCapabilities(order)
  assert.equal(capReady.canPrintLabel, true)
  assert.equal(capReady.canDownloadLabel, true)
  assert.equal(capReady.canViewDetails, true)
  assert.equal(capReady.hasPrintableLabel, true)

  // (Faz 3) Sayfa yenileme robustluğu: ince-taneli alanlar eksik olsa bile
  // canonical LABEL_READY + persisted barcodeRaw → aktif kalır.
  const reloaded = makeOrder({
    id: 'R',
    shipment: { id: 's', provider: 'surat-kargo', trackingNumber: '', barcode: '',
      barcodeValue: '', barcodeRaw: '^XA^FD01252765588^FS^XZ', printEnabled: true },
  })
  const capReload = resolveOrderActionCapabilities(reloaded)
  assert.equal(capReload.canPrintLabel, true, 'yenilemede print aktif kalır')
  assert.equal(capReload.canDownloadLabel, true, 'yenilemede download aktif kalır')

  // (Faz 3) LABEL_PRINTED → reprint/download aktif kalır.
  const printed = makeOrder({ id: 'P', operationStatus: 'LABEL_PRINTED', labelStatus: 'PRINTED', shipment: printableShipment() })
  const capPrinted = resolveOrderActionCapabilities(printed)
  assert.equal(capPrinted.canPrintLabel, true, 'LABEL_PRINTED reprint aktif')
  assert.equal(capPrinted.canDownloadLabel, true)

  // (Faz 3) BARCODE_WAITING + etiket yok → print/download pasif.
  const waiting = makeOrder({ id: 'W', packageId: 'PKG-W', operationStatus: 'NEW', labelStatus: undefined, cargoTrackingNumber: '7270030000001', shipment: undefined })
  const capWaiting = resolveOrderActionCapabilities(waiting)
  assert.equal(capWaiting.canPrintLabel, false)
  assert.equal(capWaiting.canDownloadLabel, false)
  assert.equal(capWaiting.canViewDetails, true, 'detay her zaman aktif')

  // (Faz 1+3) Dashboard projection: displayOrderNumber + capability + GÜVENLİK.
  const vm = buildDashboardViewModel({
    orders: [order, waiting], products: [],
    selectedPeriod: { key: 'last30' },
    now: new Date('2026-07-27T00:00:00Z'),
  })
  const opReady = vm.recentOperations.find((op) => op.id === 'A')
  assert.ok(opReady)
  assert.equal(opReady.displayOrderNumber, '7270039999999', 'projection 727 gösterir')
  assert.equal(opReady.orderNumber, '1149999999', 'canonical 114 korunur')
  assert.equal(opReady.canPrint, true)
  assert.equal(opReady.canDownloadZpl, true)
  assert.equal(opReady.hasPrintableLabel, true)
  const opWaiting = vm.recentOperations.find((op) => op.id === 'W')
  assert.equal(opWaiting.canPrint, false)
  // GÜVENLİK: projection'da raw ZPL / SOAP / adres / telefon / e-posta yok.
  const projectionText = JSON.stringify(vm.recentOperations)
  for (const leak of ['^XA', '01252765588', 'Açık adres 1', '5550001122', 'ada@example.com', 'Sifre']) {
    assert.equal(projectionText.includes(leak), false, `projection ${leak} sızdırmaz`)
  }
})

// (Faz 2) Dashboard Yenile marketplace sync ÇAĞIRMAZ — wiring guard.
test('Faz 2: Dashboard Yenile /api/orders/sync çağırmaz; Siparişler Şimdi Yenile çağırır', () => {
  const appSrc = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  // Dashboard onRefresh yerel DB reload'a bağlı (marketplace sync değil).
  assert.match(appSrc, /onRefresh=\{handleReloadOrders\}/, 'Dashboard onRefresh = handleReloadOrders (DB reload)')

  // handleReloadOrders yalnız DB'den okur (loadOrdersFromServer), sync yapmaz.
  const reloadIdx = appSrc.indexOf('async function handleReloadOrders')
  assert.ok(reloadIdx >= 0, 'handleReloadOrders tanımı bulunur')
  const reloadWindow = appSrc.slice(reloadIdx, reloadIdx + 1500)
  assert.match(reloadWindow, /loadOrdersFromServer/, 'handleReloadOrders DB reload kullanır')
  assert.equal(/orders\/sync/.test(reloadWindow), false, 'handleReloadOrders sync ÇAĞIRMAZ')

  // Siparişler "Şimdi Yenile" (onFetchOrders) hâlâ handleFetchOrders (sync) kullanır.
  assert.match(appSrc, /onFetchOrders=\{\(options\) => handleFetchOrders/, 'Orders Şimdi Yenile = handleFetchOrders')

  // workflow servisi: loadOrdersFromServer GET /api/orders; sync yalnız fetchOrders'ta.
  const wfSrc = readFileSync(join(root, 'src/services/orderWorkflowService.ts'), 'utf8')
  const loadIdx = wfSrc.indexOf('async loadOrdersFromServer')
  const loadWindow = wfSrc.slice(loadIdx, loadIdx + 1500)
  assert.match(loadWindow, /\/api\/orders/, 'loadOrdersFromServer GET /api/orders')
  assert.equal(/orders\/sync/.test(loadWindow), false, 'loadOrdersFromServer sync yolunu çağırmaz')
  // Senkron artık KABUL EDEN uca gider (sağlayıcı beklenmez); yalnız
  // "Şimdi Yenile" yolunda tetiklenir.
  assert.match(
    wfSrc, /fetch\('\/api\/orders\/sync\/request'/,
    'sync yalnız fetchOrders (Şimdi Yenile) yolunda, kabul eden uçla',
  )
})
