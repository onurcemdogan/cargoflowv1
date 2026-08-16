import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

// Üç canlı UI düzeltmesi regresyonu:
//  1) Sürat etiketindeki "Siparis No" → 727... Trendyol referansı (packageId 403...
//     DEĞİL). Canonical orderNumber 114... ve T.No/barkod DEĞİŞMEZ.
//  2) Persist edilmiş yazdırılabilir etiket VARKEN tekrar yazdırmada desi İSTENMEZ.
//  3) İlk login'de kayıtlı+aktif ama test yok → YANLIŞ "bağlantı kontrol edilmeli"
//     uyarısı YOK (needs_check nötr); kalıcı başarılı sync → connected; 'failed' → error.

const template = { id: 'tpl-1' }
const suratConfig = {
  kullaniciAdi: 'cari', sifre: 'x', webPassword: '', firmaId: '1',
  createShipmentPath: '', serviceType: '',
}
function baseOrder(over = {}) {
  return {
    id: 'o1', marketplace: 'Trendyol', externalOrderId: 'EXT',
    orderNumber: '1149999999', packageId: '4032045047',
    cargoTrackingNumber: '7270039999999',
    marketplaceStatus: 'Created', operationStatus: 'LABEL_READY', labelStatus: 'READY',
    customerName: 'Ada Lovelace', customerPhone: '5551112233',
    address: 'Kadıköy açık adres 1', city: 'İstanbul', district: 'Kadıköy',
    totalAmount: 100, items: [{ id: 'l1', quantity: 1, price: 100, productName: 'Ürün', barcode: 'B1' }],
    ...over,
  }
}
function printableShipment(over = {}) {
  return {
    id: 's', provider: 'surat-kargo', trackingNumber: '11820824092123',
    trackingUrl: '', shipmentCode: '', barcodeValue: '01252765588',
    barcode: '01252765588', barkodNo: '01252765588', tNo: '11820824092123',
    ozelKargoTakipNo: '7270039999999', barcodeRaw: '^XA^FD01252765588^FS^XZ',
    printEnabled: true, zplReady: true, verifiedShipment: false,
    dispatchRegistrationConfirmed: false,
    lifecycleStatus: 'LABEL_READY_AWAITING_ACCEPTANCE',
    candidateVerificationStatus: 'PREASSIGNED_AWAITING_ACCEPTANCE',
    ...over,
  }
}

test('Faz 1: etiket "Siparis No" 727 gösterir; 114/T.No/barkod korunur', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, })
  t.after(() => vite.close())
  const { buildSuratLabelData } = await vite.ssrLoadModule('/src/utils/labelData.ts')

  const order = baseOrder({ shipment: printableShipment() })
  const data = buildSuratLabelData(order, order.shipment, template, {})
  // Etikette görünen sol referans (leftVerticalReference → "Siparis No") = 727.
  assert.equal(data.leftVerticalReference, '7270039999999')
  assert.equal(data.leftVerticalReferenceSource, 'trendyol.cargoTrackingNumber')
  // Canonical orderNumber (114) DEĞİŞMEZ.
  assert.equal(data.orderNumber, '1149999999')
  // Sürat T.No canonical (727 T.No YERİNE geçmez; leftVerticalReference ayrı alan).
  assert.equal(data.tNo, '11820824092123')

  // 727 yoksa packageId (403) fallback gösterilir.
  const noRef = baseOrder({ cargoTrackingNumber: '', shipment: printableShipment({ ozelKargoTakipNo: '' }) })
  const noRefData = buildSuratLabelData(noRef, noRef.shipment, template, {})
  assert.equal(noRefData.leftVerticalReference, '4032045047')
})

test('Faz 2: persist ZPL varken desi tekrar İSTENMEZ; ZPL yoksa istenir', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, })
  t.after(() => vite.close())
  const { validateLabelData } = await vite.ssrLoadModule('/src/utils/labelData.ts')
  const hasDesiError = (v) => v.errors.some((e) => e.includes('Desi bilgisi eksik'))

  // (a) carrier ZPL (barcodeRaw) + desi null → desi HATASI YOK (tekrar yazdırma).
  const withZpl = baseOrder({ desi: null, shipment: printableShipment() })
  assert.equal(hasDesiError(validateLabelData(withZpl, withZpl.shipment, template, {})), false)

  // (b) hasPrintableLabel=true (ham ZPL response'ta yok) + desi null → desi HATASI YOK.
  const flagged = baseOrder({
    desi: null, hasPrintableLabel: true,
    shipment: printableShipment({ barcodeRaw: '' }),
  })
  assert.equal(hasDesiError(validateLabelData(flagged, flagged.shipment, template, {})), false)

  // (c) persist etiket YOK + desi null → desi HATASI VAR (ilk oluşturma).
  const noLabel = baseOrder({
    desi: null, hasPrintableLabel: false,
    shipment: { id: 's', provider: 'surat-kargo', trackingNumber: '', barcode: '', barcodeValue: '' },
  })
  assert.equal(hasDesiError(validateLabelData(noLabel, noLabel.shipment, template, {})), true)
})

test('Faz 3: provider health login/hydrate — needs_check nötr, connected/error kalıcıdan', async (t) => {
  const vite = await createServer({ appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, })
  t.after(() => vite.close())
  const { buildDashboardProviderHealth } = await vite.ssrLoadModule('/src/dashboard/dashboardSummary.ts')

  const config = {
    trendyol: { sellerId: 'S1', apiKey: 'K', apiSecret: 'X', environment: 'prod' },
    surat: suratConfig,
  }
  const trendyolOf = (h) => h.marketplaceIntegrations.find((p) => p.providerKey === 'trendyol')
  const args = (trendyolMasked) => ({
    config,
    maskedStatus: { mode: 'auth', configured: true, trendyol: trendyolMasked, surat: { configured: true } },
    apiDebugLogs: [],
    orders: [],
    lastSyncedAt: undefined,
  })

  // (a) configured + KALICI başarılı sync → connected (ilk login, client log yok).
  const connected = trendyolOf(buildDashboardProviderHealth(args({
    configured: true, sellerId: 'S1', hasApiKey: true, hasApiSecret: true, apiKeyMasked: 'K***',
    lastSuccessfulSyncAt: '2026-07-01T00:00:00Z', lastSyncStatus: 'success',
  })))
  assert.equal(connected.status, 'connected')
  assert.equal(connected.connected, true)

  // (b) configured + hiç test/sync yok → needs_check (nötr, YANLIŞ uyarı üretmez).
  const untested = trendyolOf(buildDashboardProviderHealth(args({
    configured: true, sellerId: 'S1', hasApiKey: true, hasApiSecret: true, apiKeyMasked: 'K***',
  })))
  assert.equal(untested.status, 'needs_check')
  // DashboardPage uyarısı YALNIZ status==='error' iken çıkar → needs_check uyarısız.
  assert.notEqual(untested.status, 'error')

  // (c) configured + KALICI 'failed' sync → error (gerçek uyarı).
  const failed = trendyolOf(buildDashboardProviderHealth(args({
    configured: true, sellerId: 'S1', hasApiKey: true, hasApiSecret: true, apiKeyMasked: 'K***',
    lastSuccessfulSyncAt: null, lastSyncStatus: 'failed',
  })))
  assert.equal(failed.status, 'error')

  // (d) credential eksik → not_configured (uyarı: bağlantı bulunamadı).
  const notConfigured = trendyolOf(buildDashboardProviderHealth({
    config: { trendyol: { sellerId: '', apiKey: '', apiSecret: '' }, surat: suratConfig },
    maskedStatus: { mode: 'auth', configured: false, trendyol: { configured: false }, surat: { configured: false } },
    apiDebugLogs: [], orders: [], lastSyncedAt: undefined,
  }))
  assert.equal(notConfigured.status, 'not_configured')
})
