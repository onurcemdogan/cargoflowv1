// Kayıtlı Sürat gönderisine tek seferlik label (OrtakBarkodOlustur) aşaması.
// Yeni shipment create çağrılmaz; /api/shipments/surat/label rotası kullanılır.
// Varsayılan dry-run'dır; canlı çağrı için --execute-label-once gerekir.
const apiBaseUrl = process.env.CARGOFLOW_API_URL || 'http://127.0.0.1:8787'
const orderNumber = String(process.argv[2] || '').trim()
const manualDesi = Number(process.argv[3] || 0)
const executeToken = String(process.argv[4] || '').trim()

if (!orderNumber || manualDesi <= 0) {
  console.error(
    'Kullanim: node server/surat-live-label-registered.mjs <orderNumber> <manualDesi> [--execute-label-once]',
  )
  process.exit(2)
}

const configResponse = await fetch(`${apiBaseUrl}/api/local-config/integration`)
const configPayload = await configResponse.json()
const integration = configPayload?.config
if (!configResponse.ok || !integration?.trendyol || !integration?.surat) {
  console.error('Yerel sifreli entegrasyon ayarlari okunamadi.')
  process.exit(2)
}

const endDate = Date.now()
const startDate = endDate - 30 * 24 * 60 * 60 * 1000
const ordersResponse = await fetch(
  `${apiBaseUrl}/api/integrations/trendyol/orders`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credentials: integration.trendyol,
      query: {
        orderNumber,
        statuses: ['Created', 'Picking', 'Invoiced', 'Shipped'],
        startDate,
        endDate,
        size: 200,
        maxPages: 10,
      },
    }),
  },
)
const ordersPayload = await ordersResponse.json()
const order = (ordersPayload.orders || []).find(
  (item) => String(item.orderNumber || '') === orderNumber,
)
if (!ordersResponse.ok || !ordersPayload.ok || !order) {
  console.error('Trendyol siparisi okunamadi; label cagrilmadi.')
  process.exit(1)
}

const preflight = {
  orderNumber,
  orderId: String(order.id || ''),
  packageId: String(order.packageId || order.shipmentPackageId || ''),
  ozelKargoTakipNo: String(order.cargoTrackingNumber || ''),
  labelOperation: 'OrtakBarkodOlustur',
  route: '/api/shipments/surat/label',
}

if (executeToken !== '--execute-label-once') {
  console.log(
    JSON.stringify(
      { executed: false, reason: 'Dry-run: --execute-label-once gerekli.', preflight },
      null,
      2,
    ),
  )
  process.exit(0)
}

const labelConfig = {
  ...integration,
  surat: {
    ...integration.surat,
    serviceMode: 'ORTAK_BARKOD_SOAP',
    serviceType: 'OrtakBarkodOlusturSoap',
    createShipmentPath: '/api/OrtakBarkodOlustur',
    trackingServiceType: 'KargoTakipHareketDetayiSoap',
  },
}
const labelResponse = await fetch(`${apiBaseUrl}/api/shipments/surat/label`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    config: labelConfig,
    order: {
      ...order,
      desi: manualDesi,
      desiSource: 'MANUAL_USER_CONFIRMED',
    },
  }),
})
const result = await labelResponse.json()
const shipment = result?.shipment || {}
const zpl = String(shipment.barcodeRaw || '')

console.log(
  JSON.stringify(
    {
      executed: true,
      executedAt: new Date().toISOString(),
      preflight,
      localResponseStatus: labelResponse.status,
      ok: Boolean(result?.ok),
      errorCode: String(result?.errorCode || ''),
      message: String(result?.message || '').slice(0, 400),
      verifiedShipment: Boolean(shipment.verifiedShipment),
      printEnabled: Boolean(shipment.printEnabled),
      lifecycleStage: String(
        shipment.lifecycleStage || shipment.lifecycleStatus || '',
      ),
      canonicalTNo: String(shipment.tNo || shipment.kargoTakipNo || ''),
      canonicalBarkodNo: String(shipment.barkodNo || shipment.barcode || ''),
      registeredTakipNo: String(
        result?.registration?.KargoTakipNo ||
          result?.registration?.TakipNo ||
          '',
      ),
      zplLength: zpl.length,
      zplContainsCanonicalTNo: Boolean(
        shipment.tNo && zpl.includes(String(shipment.tNo)),
      ),
      zplContainsCanonicalBarkod: Boolean(
        shipment.barkodNo && zpl.includes(String(shipment.barkodNo)),
      ),
      zplContainsOzelKargoTakipNo: Boolean(
        preflight.ozelKargoTakipNo && zpl.includes(preflight.ozelKargoTakipNo),
      ),
      labelIdempotency: result?.labelIdempotency || {},
      trackingVerification: {
        gonderilerLength: Number(
          result?.trackingVerification?.gonderilerLength ||
            shipment?.trackingVerification?.gonderilerLength ||
            0,
        ),
        KargoTakipNo: String(
          result?.trackingVerification?.KargoTakipNo ||
            shipment?.trackingVerification?.KargoTakipNo ||
            '',
        ),
      },
    },
    null,
    2,
  ),
)
