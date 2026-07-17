const apiBaseUrl = process.env.CARGOFLOW_API_URL || 'http://127.0.0.1:8787'
const orderNumber = String(process.argv[2] || '').trim()
const manualDesi = Number(process.argv[3] || 0)
const executeToken = String(process.argv[4] || '').trim()

if (!orderNumber || manualDesi <= 0) {
  console.error(
    'Kullanim: node server/surat-live-experiment.mjs <orderNumber> <manualDesi> [--execute-live-once]',
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
        statuses: ['Created', 'Picking', 'Invoiced'],
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
  console.error('Aktif Trendyol siparisi yeniden okunamadi; create yapilmadi.')
  process.exit(1)
}

const status = String(
  order.marketplaceStatus || order.packageStatus || order.rawStatus || '',
)
const carrier = String(order.cargoProviderName || order.cargoCompany || '')
const cargoTrackingNumber = String(order.cargoTrackingNumber || '').trim()
const packageId = String(order.packageId || order.shipmentPackageId || '')
const address = order.shipmentAddress || order.rawOrder?.shipmentAddress || {}
const addressComplete = Boolean(
  String(address.fullAddress || address.address1 || order.address || '').trim() &&
    String(address.city || order.city || '').trim() &&
    String(address.district || order.district || '').trim(),
)
const safePreflight = {
  orderNumber,
  packageId,
  cargoTrackingNumber,
  status,
  carrier,
  addressComplete,
  desi: manualDesi,
  desiSource: 'MANUAL_USER_CONFIRMED',
  operation: 'GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
}

if (
  !['Picking', 'Invoiced'].includes(status) ||
  !/s[uü]rat/i.test(carrier) ||
  !cargoTrackingNumber ||
  !addressComplete
) {
  console.log(
    JSON.stringify(
      {
        executed: false,
        reason: 'Canli create guvenlik kapilarindan biri gecmedi.',
        preflight: safePreflight,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

if (executeToken !== '--execute-live-once') {
  console.log(
    JSON.stringify(
      {
        executed: false,
        reason: 'Dry-run: canli create icin --execute-live-once gerekli.',
        preflight: safePreflight,
      },
      null,
      2,
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  process.exit(0)
}

const liveConfig = {
  ...integration,
  surat: {
    ...integration.surat,
    serviceMode: 'ORTAK_BARKOD_SOAP',
    serviceType:
      'GonderiyiKargoyaGonderYeniSiparisBarkodOlusturSoap',
    createShipmentPath:
      '/api/GonderiyiKargoyaGonderYeniSiparisBarkodOlustur',
    trackingServiceType: 'KargoTakipHareketDetayiSoap',
  },
}
const createResponse = await fetch(`${apiBaseUrl}/api/shipments/surat/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    config: liveConfig,
    order: {
      ...order,
      desi: manualDesi,
      desiSource: 'MANUAL_USER_CONFIRMED',
    },
  }),
})
const result = await createResponse.json()
const shipment = result?.shipment || {}
const createLog = shipment?.suratCreateLog || result?.suratCreateLog || {}
const parsed = createLog?.parsedResponse || result?.parsedResponse || {}
const tracking = result?.trackingVerification || shipment?.trackingVerification || {}

console.log(
  JSON.stringify(
    {
      executed: true,
      executedAt: new Date().toISOString(),
      preflight: safePreflight,
      localResponseStatus: createResponse.status,
      ok: Boolean(result?.ok),
      operationName: String(result?.operationName || createLog.operationName || ''),
      serviceType: String(result?.serviceType || createLog.serviceType || ''),
      carrierResponseStatus: Number(createLog.responseStatus || result?.statusCode || 0),
      businessCode: String(createLog.businessCode || parsed.ResponseId || parsed.Code || ''),
      businessMessage: String(
        createLog.responseMessage || parsed.Message || result?.message || '',
      ).slice(0, 600),
      createAccepted: Boolean(
        shipment?.createAccepted || createLog?.createAccepted || result?.createAccepted,
      ),
      lifecycleStatus: String(
        shipment.lifecycleStatus || shipment.verificationStage || '',
      ),
      candidateTNo: String(
        shipment.unverifiedTrackingNumber ||
          shipment.candidateTrackingNumber ||
          shipment.codeMapping?.tNoValue ||
          parsed.KargoTakipNo ||
          parsed.TNo ||
          '',
      ),
      candidateBarcodeNo: String(
        shipment.unverifiedBarcode ||
          shipment.candidateBarcodeNumber ||
          shipment.codeMapping?.barcodeValue ||
          parsed.BarkodNo ||
          parsed.BarcodeNo ||
          '',
      ),
      zplAvailable: Boolean(
        shipment.barcodeRaw || parsed.BarcodeRaw || parsed.Zpl || parsed.ZPL,
      ),
      shipmentRegistered: Boolean(
        shipment.dispatchRegistrationConfirmed || tracking.shipmentRegistered,
      ),
      trackingGonderiler: Number(tracking.gonderilerLength || 0),
      canonicalTNo: shipment.verifiedShipment
        ? String(
            shipment.kargoTakipNo || shipment.tNo || tracking.KargoTakipNo || '',
          )
        : '',
      canonicalBarcodeNo: shipment.verifiedShipment
        ? String(
            shipment.barkodNo || shipment.barcode || tracking.BarkodNo || '',
          )
        : '',
      verifiedShipment: Boolean(shipment.verifiedShipment),
      operationalBarcodeVerified: Boolean(shipment.operationalBarcodeVerified),
      printEnabled: Boolean(shipment.printEnabled),
      idempotency: {
        operation: String(result?.idempotency?.operation || ''),
        createCallCount: Number(result?.idempotency?.createCallCount || 0),
        persistentStatus: String(result?.idempotency?.persistentStatus || ''),
        carrierCreateCalled: Boolean(result?.idempotency?.carrierCreateCalled),
      },
    },
    null,
    2,
  ),
)
